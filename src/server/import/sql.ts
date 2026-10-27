import { sql, type SQL } from "drizzle-orm";
import type { SheetDef } from "../../shared/import/template";

// Raw SQL fragments over staged rows. Identifiers come from the template definition,
// never from the upload; values are always bound parameters or JSON paths.

/** A field of a staged row, by target column name. */
export const field = (row: string, name: string) => `json_extract(${row}.data, '$.${name}')`;

/** Target row `t` (by alias) that a staged row `row` would write to. */
export const sameTarget = (def: SheetDef, t: string, row: string) =>
  [`${t}.tenant_id = ${row}.tenant_id`, ...def.key.map((k) => `${t}.${k} = ${field(row, k)}`)].join(" and ");

/** Key of a target row as one text, as stored in record_changes.entity_key. */
export const targetKey = (def: SheetDef, t: string) => def.key.map((k) => `${t}.${k}`).join(` || '|' || `);

/** Other OK staged rows of the same policy (03_Policies), as alias `s`. */
export const samePolicyRows = (row: string, s = "s") =>
  `${s}.import_id = ${row}.import_id and ${s}.sheet = '03_Policies' and ${s}.status = 'OK' and ${field(s, "policy_no")} = ${field(row, "policy_no")}`;

/** Only the first OK row of each policy carries the policy itself. */
export const firstPolicyRow = (row: string) =>
  `${row}.row_no = (select min(fp.row_no) from import_rows fp where ${samePolicyRows(row, "fp")})`;

export const staged = (importId: string, sheet: string, row = "r") =>
  sql`${sql.raw(`${row}.import_id`)} = ${importId} and ${sql.raw(`${row}.sheet`)} = ${sheet} and ${sql.raw(`${row}.status`)} = 'OK'`;

export type RawSql = SQL;
