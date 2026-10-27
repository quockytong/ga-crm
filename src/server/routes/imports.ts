import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { sqlBatch, type Db } from "../../db/client";
import { importErrors, importRows, imports, users } from "../../db/schema";
import { importMessage } from "../../i18n/vi";
import {
  isSheetName,
  LATER_SHEETS,
  planSheet,
  SHEETS,
  type ImportSheetCounts,
  type SheetCount,
} from "../../shared/import/template";
import { createImportSchema, importErrorsQuerySchema, importRowsSchema, pageQuerySchema } from "../../shared/schemas";
import { auditBy } from "../audit";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { valid } from "../http";
import { commitImport } from "../import/commit";
import { stageRows } from "../import/stage";
import { canUploadSheet, validateImport } from "../import/validate";
import { requirePermission } from "../middleware";
import { ownImports, scopeOf, visibleImports, type Scope } from "../scope";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

const importColumns = {
  id: imports.id,
  userId: imports.userId,
  fileName: imports.fileName,
  snapshotDate: imports.snapshotDate,
  status: imports.status,
  sheets: imports.sheetCounts,
  fileKept: sql<boolean>`${imports.r2Key} is not null`.mapWith(Boolean),
  createdAt: imports.createdAt,
  committedAt: imports.committedAt,
};

/** An import the caller started. Anyone else's, in any tenant, is simply not found. */
async function ownImport(db: Db, scope: Scope, id: string) {
  const imp = await db
    .select({ ...importColumns, tenantId: imports.tenantId })
    .from(imports)
    .where(and(ownImports(scope), eq(imports.id, id)))
    .get();
  if (!imp) throw notFound();
  return imp;
}

const emptyCount = (status: SheetCount["status"], present: number[] = []): SheetCount => ({
  status,
  present,
  found: 0,
  inserted: 0,
  updated: 0,
  rejected: 0,
  warnings: 0,
});

export const importRoutes = new Hono<AppEnv>()
  .use(requirePermission("imports.upload"))

  // F2.5: own imports; GA Head and Admin see every import of the tenant.
  .get("/", valid("query", pageQuerySchema), async (c) => {
    const db = c.get("db");
    const { page, pageSize } = c.req.valid("query");
    const where = visibleImports(scopeOf(c.get("actor")));
    const [items, total] = await Promise.all([
      db
        .select({ ...importColumns, userName: users.name })
        .from(imports)
        .innerJoin(users, eq(users.id, imports.userId))
        .where(where)
        .orderBy(desc(imports.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(imports).where(where),
    ]);
    return c.json({ items, page, pageSize, total: total[0]?.n ?? 0 });
  })

  // Step 1: announce the workbook. Decides, per sheet, whether it can be imported.
  .post("/", valid("json", createImportSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const input = c.req.valid("json");
    const id = crypto.randomUUID();

    const counts: ImportSheetCounts = {};
    const problems: { sheet: string; column: string; code: string }[] = [];
    for (const sheet of input.sheets) {
      if ((LATER_SHEETS as readonly string[]).includes(sheet.name)) counts[sheet.name] = emptyCount("LATER");
      if (!isSheetName(sheet.name) || counts[sheet.name]) continue;

      const plan = planSheet(SHEETS[sheet.name], sheet.headers);
      const present = plan.positions.flatMap((p, i) => (p >= 0 ? [i] : []));
      for (const column of plan.banned) problems.push({ sheet: sheet.name, column, code: "banned_column" });
      if (!canUploadSheet(scope, sheet.name)) {
        problems.push({ sheet: sheet.name, column: "", code: "sheet_not_allowed" });
        counts[sheet.name] = emptyCount("BLOCKED", present);
      } else if (plan.missingRequired.length) {
        // A missing required column blocks its own sheet only.
        for (const column of plan.missingRequired) problems.push({ sheet: sheet.name, column, code: "missing_required_column" });
        counts[sheet.name] = emptyCount("BLOCKED", present);
      } else {
        counts[sheet.name] = emptyCount("READY", present);
      }
    }

    // One open import per user: an earlier one that was never confirmed is abandoned.
    const stale = db
      .select({ id: imports.id })
      .from(imports)
      .where(and(ownImports(scope), inArray(imports.status, ["PARSING", "VALIDATED"])));
    await sqlBatch(db, [
      db.delete(importRows).where(inArray(importRows.importId, stale)),
      db
        .update(imports)
        .set({ status: "FAILED" })
        .where(and(ownImports(scope), inArray(imports.status, ["PARSING", "VALIDATED"]))),
      db.insert(imports).values({
        id,
        tenantId: scope.tenantId,
        userId: scope.userId,
        agentCode: scope.agentCode,
        fileName: input.fileName,
        snapshotDate: input.snapshotDate,
        status: "PARSING",
        sheetCounts: counts,
        createdAt: new Date().toISOString(),
      }),
      sql`
        insert into import_errors (id, import_id, tenant_id, sheet, "row", "column", code, message_vi, severity)
        select lower(hex(randomblob(16))), ${id}, ${scope.tenantId}, json_extract(value, '$.sheet'), 1,
               nullif(json_extract(value, '$.column'), ''), json_extract(value, '$.code'), json_extract(value, '$.msg'), 'error'
        from json_each(${JSON.stringify(problems.map((p) => ({ ...p, msg: importMessage(p.code, p.column) })))})`,
    ]);
    return c.json(await ownImport(db, scope, id), 201);
  })

  // Step 2: the rows, in chunks. Cells are aligned to the template columns of the sheet.
  .post("/:id/rows", valid("json", importRowsSchema), async (c) => {
    const db = c.get("db");
    const imp = await ownImport(db, scopeOf(c.get("actor")), c.req.param("id"));
    const { sheet, rows } = c.req.valid("json");
    if (imp.status !== "PARSING") throw new ApiError(409, "import_not_open");
    const plan = imp.sheets[sheet];
    if (plan?.status !== "READY") throw new ApiError(409, "sheet_not_ready");

    const def = SHEETS[sheet];
    const present = def.columns.map((_, i) => plan.present.includes(i));
    return c.json(await stageRows(db, imp, def, present, rows));
  })

  // Keeps the original workbook in R2, unless it carries columns that must not be stored.
  .put("/:id/file", async (c) => {
    const db = c.get("db");
    const imp = await ownImport(db, scopeOf(c.get("actor")), c.req.param("id"));
    if (imp.status !== "PARSING" && imp.status !== "VALIDATED") throw new ApiError(409, "import_not_open");
    const banned = await db
      .select({ n: count() })
      .from(importErrors)
      .where(and(eq(importErrors.importId, imp.id), eq(importErrors.code, "banned_column")))
      .get();
    if (banned?.n) throw new ApiError(409, "file_not_kept");

    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_FILE_BYTES) throw new ApiError(400, "invalid_input");
    const key = `imports/${imp.tenantId}/${imp.id}.xlsx`;
    await c.env.UPLOADS.put(key, body, { customMetadata: { fileName: encodeURIComponent(imp.fileName) } });
    await db.update(imports).set({ r2Key: key }).where(eq(imports.id, imp.id));
    return c.body(null, 204);
  })

  // Step 3: checks across rows and against the database; produces the preview (F2.2).
  .post("/:id/validate", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const imp = await ownImport(db, scope, c.req.param("id"));
    if (imp.status !== "PARSING") throw new ApiError(409, "import_not_open");
    const counts = await validateImport(db, scope, imp.id, imp.sheets);
    await db.update(imports).set({ status: "VALIDATED", sheetCounts: counts }).where(eq(imports.id, imp.id));
    return c.json(await ownImport(db, scope, imp.id));
  })

  // Step 4: the uploader confirms.
  .post("/:id/commit", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const imp = await ownImport(db, scope, c.req.param("id"));
    if (imp.status !== "VALIDATED") throw new ApiError(409, "import_not_validated");
    await commitImport(db, scope, imp, imp.sheets, auditBy(c));
    return c.json(await ownImport(db, scope, imp.id));
  })

  .get("/:id", async (c) => {
    const imp = await c
      .get("db")
      .select({ ...importColumns, userName: users.name })
      .from(imports)
      .innerJoin(users, eq(users.id, imports.userId))
      .where(and(visibleImports(scopeOf(c.get("actor"))), eq(imports.id, c.req.param("id"))))
      .get();
    if (!imp) throw notFound();
    return c.json(imp);
  })

  // Records to fix and import again: one line per rejected row, with its key and reasons.
  .get("/:id/rejected", valid("query", importErrorsQuerySchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { page, pageSize, sheet } = c.req.valid("query");
    const imp = await db
      .select({ id: imports.id })
      .from(imports)
      .where(and(visibleImports(scope), eq(imports.id, c.req.param("id"))))
      .get();
    if (!imp) throw notFound();

    const where = sql`tenant_id = ${scope.tenantId} and import_id = ${imp.id} and severity = 'error' and "row" > 1
      ${sheet ? sql`and sheet = ${sheet}` : sql``}`;
    const [items, total, bySheet] = await Promise.all([
      db.all<{ sheet: string; row: number; recordKey: string | null; codes: string }>(sql`
        select sheet, "row", max(record_key) as recordKey, group_concat(distinct code) as codes
        from import_errors where ${where} group by sheet, "row" order by sheet, "row"
        limit ${pageSize} offset ${(page - 1) * pageSize}`),
      db.all<{ n: number }>(sql`select count(*) as n from (select 1 from import_errors where ${where} group by sheet, "row")`),
      db.all<{ sheet: string; code: string; rows: number }>(sql`
        select sheet, code, count(distinct "row") as rows from import_errors where ${where}
        group by sheet, code order by sheet, rows desc, code`),
    ]);
    return c.json({
      items: items.map((r) => ({ ...r, codes: r.codes.split(",") })),
      bySheet,
      page,
      pageSize,
      total: total[0]?.n ?? 0,
    });
  })

  // F2.4: rows of the error report.
  .get("/:id/errors", valid("query", importErrorsQuerySchema), async (c) => {
    const db = c.get("db");
    const { page, pageSize, sheet } = c.req.valid("query");
    // The join carries the scope: errors are only reachable through a visible import.
    const where = and(
      visibleImports(scopeOf(c.get("actor"))),
      eq(importErrors.importId, c.req.param("id")),
      sheet ? eq(importErrors.sheet, sheet) : undefined,
    );
    const [items, total] = await Promise.all([
      db
        .select({
          sheet: importErrors.sheet,
          row: importErrors.row,
          column: importErrors.column,
          code: importErrors.code,
          recordKey: importErrors.recordKey,
          message: importErrors.messageVi,
          severity: importErrors.severity,
        })
        .from(importErrors)
        .innerJoin(imports, eq(imports.id, importErrors.importId))
        .where(where)
        .orderBy(asc(importErrors.sheet), asc(importErrors.row), asc(importErrors.column), asc(importErrors.code))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db
        .select({ n: count() })
        .from(importErrors)
        .innerJoin(imports, eq(imports.id, importErrors.importId))
        .where(where),
    ]);
    return c.json({ items, page, pageSize, total: total[0]?.n ?? 0 });
  });
