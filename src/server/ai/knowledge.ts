import { and, eq, inArray, sql } from "drizzle-orm";
import { sqlBatch, type Db } from "../../db/client";
import { aiChunks, aiDocuments, aiKnowledgeBases } from "../../db/schema";
import type { KbCategory } from "../../shared/ai";
import { chunks as inGroups } from "../http";
import { inTenant, type Scope } from "../scope";

/**
 * Knowledge bases: documents are split into chunks of about 1,200 characters, kept with
 * the heading they sit under, and searched with SQLite FTS5 (BM25, diacritics folded).
 * No embeddings: cheap, local, and good enough for terms, procedures and product names.
 */

const CHUNK = 1200;
const OVERLAP = 150;

const isHeading = (line: string) =>
  line.length <= 120 &&
  (/^#{1,6}\s/.test(line) || /^(chương|mục|điều|phần|section|article)\s+[\divxlc]+/i.test(line) || /^[\dIVX]+(\.\d+)*[.)]\s+\S/.test(line));

/** Splits text into chunks under their nearest heading. */
export function splitText(text: string): { heading: string | null; body: string }[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: { heading: string | null; body: string }[] = [];
  let heading: string | null = null;
  let buf = "";
  const flush = () => {
    const body = buf.trim();
    if (body) out.push({ heading, body });
    buf = "";
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (isHeading(line)) {
      flush();
      heading = line.replace(/^#+\s*/, "");
      continue;
    }
    if (buf.length + line.length + 1 > CHUNK && buf.length > 0) {
      const tail = buf.slice(-OVERLAP);
      flush();
      buf = tail.slice(tail.indexOf(" ") + 1);
    }
    // A very long line (PDF text without breaks) is cut on its own.
    if (line.length > CHUNK) {
      for (let i = 0; i < line.length; i += CHUNK - OVERLAP) {
        buf += line.slice(i, i + CHUNK);
        flush();
      }
      continue;
    }
    buf += (buf ? "\n" : "") + line;
  }
  flush();
  return out;
}

/** Stores a document and its chunks. */
export async function addDocument(
  db: Db,
  scope: Scope,
  kbId: string,
  doc: { title: string; productCode?: string | null; sourceName?: string | null; text: string },
) {
  const parts = splitText(doc.text);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = parts.map((p, seq) => ({ id: crypto.randomUUID(), tenantId: scope.tenantId, kbId, documentId: id, seq, heading: p.heading, body: p.body }));
  const docRow = {
    id,
    tenantId: scope.tenantId,
    kbId,
    title: doc.title,
    productCode: doc.productCode ?? null,
    sourceName: doc.sourceName ?? null,
    chars: doc.text.length,
    chunks: rows.length,
    createdBy: scope.userId,
    createdAt: now,
  };
  // 7 columns per chunk: 12 chunks per statement stays under D1's 100 bound parameters.
  await sqlBatch(db, [db.insert(aiDocuments).values(docRow), ...inGroups(rows, 12).map((g) => db.insert(aiChunks).values(g))]);
  return docRow;
}

export async function deleteDocuments(db: Db, scope: Scope, documentIds: string[]) {
  if (!documentIds.length) return;
  await sqlBatch(db, [
    db.delete(aiChunks).where(and(inTenant(scope, aiChunks), inArray(aiChunks.documentId, documentIds))),
    db.delete(aiDocuments).where(and(inTenant(scope, aiDocuments), inArray(aiDocuments.id, documentIds))),
  ]);
}

export type Passage = { id: string; title: string; kb: string; category: KbCategory; heading: string | null; body: string; productCode: string | null };

/** FTS5 query from free text: words OR-ed, each quoted so user input can't inject syntax. */
export function ftsQuery(text: string): string | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2),
    ),
  ].slice(0, 24);
  return words.length ? words.map((w) => `"${w}"`).join(" OR ") : null;
}

/** Best passages in the given knowledge bases (enabled ones of the caller's tenant only). */
export async function searchKnowledge(
  db: Db,
  scope: Scope,
  opts: { kbIds: string[]; query: string; categories?: KbCategory[]; productCodes?: string[]; limit?: number },
): Promise<Passage[]> {
  const match = ftsQuery([opts.query, ...(opts.productCodes ?? [])].join(" "));
  if (!match || opts.kbIds.length === 0) return [];
  const kbList = sql.join(
    opts.kbIds.slice(0, 50).map((id) => sql`${id}`),
    sql`, `,
  );
  const cats = opts.categories?.length
    ? sql`and kb.category in (${sql.join(
        opts.categories.map((c) => sql`${c}`),
        sql`, `,
      )})`
    : sql``;
  // Documents about the products in question rank first.
  const boost = opts.productCodes?.length
    ? sql`case when d.product_code in (${sql.join(
        opts.productCodes.slice(0, 20).map((c) => sql`${c}`),
        sql`, `,
      )}) then -5 else 0 end`
    : sql`0`;
  const rows = await db.all<{
    id: string;
    title: string;
    kb: string;
    category: KbCategory;
    heading: string | null;
    body: string;
    product_code: string | null;
  }>(sql`
    select c.id, d.title, kb.name as kb, kb.category, c.heading, c.body, d.product_code
    from ai_chunks_fts f
    join ai_chunks c on c.rowid = f.rowid
    join ai_documents d on d.id = c.document_id and d.tenant_id = c.tenant_id
    join ai_knowledge_bases kb on kb.id = c.kb_id and kb.tenant_id = c.tenant_id
    where ai_chunks_fts match ${match}
      and c.tenant_id = ${scope.tenantId} and kb.enabled = 1 and c.kb_id in (${kbList}) ${cats}
    order by bm25(ai_chunks_fts) + ${boost}
    limit ${opts.limit ?? 6}`);
  return rows.map((r) => ({ id: r.id, title: r.title, kb: r.kb, category: r.category, heading: r.heading, body: r.body, productCode: r.product_code }));
}

/** Knowledge bases an agent may read (linked and enabled). */
export async function enabledKbIds(db: Db, scope: Scope, linked: string[]) {
  if (!linked.length) return [];
  const rows = await db
    .select({ id: aiKnowledgeBases.id })
    .from(aiKnowledgeBases)
    .where(and(inTenant(scope, aiKnowledgeBases), inArray(aiKnowledgeBases.id, linked), eq(aiKnowledgeBases.enabled, true)));
  return rows.map((r) => r.id);
}
