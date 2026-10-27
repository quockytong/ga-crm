import { sql } from "drizzle-orm";
import { sqlBatch, type Db } from "../../db/client";
import { importMessage } from "../../i18n/vi";
import { parseRow, rawRecordKey, type Cell } from "../../shared/import/parse-row";
import type { SheetDef } from "../../shared/import/template";

/**
 * Validates a chunk of rows cell by cell and stages the good ones.
 * Rows with an error are not staged; every problem goes to import_errors.
 * Checks that need other rows or the database (duplicates, upload scope) run in validate.ts.
 */
export async function stageRows(
  db: Db,
  imp: { id: string; tenantId: string },
  def: SheetDef,
  present: readonly boolean[],
  rows: readonly { r: number; c: readonly Cell[] }[],
) {
  const ok: { r: number; k: string; o: string | null; d: Record<string, unknown> }[] = [];
  const problems: { id: string; r: number; col: string; code: string; msg: string; sev: string; key: string | null }[] = [];

  for (const row of rows) {
    const parsed = parseRow(def, present, row.c);
    const key = parsed.issues.length ? rawRecordKey(def, present, row.c) : null;
    for (const issue of parsed.issues) {
      problems.push({
        id: crypto.randomUUID(),
        r: row.r,
        col: issue.column,
        code: issue.code,
        msg: importMessage(issue.code, issue.value),
        sev: issue.severity,
        key,
      });
    }
    if (!parsed.issues.some((i) => i.severity === "error")) {
      ok.push({ r: row.r, k: parsed.key, o: parsed.owner, d: parsed.data });
    }
  }

  // One statement per table, whatever the chunk size: the rows travel as a single JSON
  // parameter, which keeps well clear of D1's 100 bound parameters per statement.
  await sqlBatch(db, [
    sql`
      insert into import_rows (import_id, tenant_id, sheet, row_no, "key", owner, data, status)
      select ${imp.id}, ${imp.tenantId}, ${def.name},
             json_extract(value, '$.r'), json_extract(value, '$.k'), json_extract(value, '$.o'),
             json_extract(value, '$.d'), 'OK'
      from json_each(${JSON.stringify(ok)})`,
    sql`
      insert into import_errors (id, import_id, tenant_id, sheet, "row", "column", code, record_key, message_vi, severity)
      select json_extract(value, '$.id'), ${imp.id}, ${imp.tenantId}, ${def.name},
             json_extract(value, '$.r'), json_extract(value, '$.col'), json_extract(value, '$.code'),
             json_extract(value, '$.key'), json_extract(value, '$.msg'), json_extract(value, '$.sev')
      from json_each(${JSON.stringify(problems)})`,
  ]);
  return { staged: ok.length, rejected: rows.length - ok.length };
}
