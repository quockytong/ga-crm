import { sql, type SQL } from "drizzle-orm";
import { sqlBatch, type Db } from "../../db/client";
import { importMessage } from "../../i18n/vi";
import { SHEETS, type ImportSheetCounts, type SheetName } from "../../shared/import/template";
import { agentInScope, can, clientInScope, policyInScope, type Scope } from "../scope";
import { planPolicyLinks } from "./policy-links";
import { leadRowTime } from "./leads";
import { field, sameTarget } from "./sql";

/** Loads the agent tree for the whole tenant: creates agents and sets managers. */
export const loadsWholeTree = (scope: Scope) => can(scope, "imports.agent_tree");

/** Writes Success rows (02-05) for any agent of the tenant, not only their own downline. */
export const writesWholeTenant = (scope: Scope) => scope.reach === "TENANT" || can(scope, "imports.tenant_wide");

/** Which sheets a user may upload at all. */
export function canUploadSheet(scope: Scope, sheet: SheetName) {
  if (sheet === "13_Leads") return can(scope, "leads.import");
  if (sheet === "01_Agents") return loadsWholeTree(scope) || scope.reach !== "NONE";
  return writesWholeTenant(scope) || scope.reach !== "NONE";
}

const raw = sql.raw;

/**
 * Cross-row and database checks on the staged rows, as set-based SQL:
 * duplicates inside the file, the upload scope rule, and links between sheets.
 * Rejected rows stay staged with status REJECTED and get a row in import_errors.
 */
export async function validateImport(db: Db, scope: Scope, importId: string, counts: ImportSheetCounts) {
  const ready = (sheet: SheetName) => counts[sheet]?.status === "READY";
  const present = (sheet: SheetName, db: string) =>
    counts[sheet]!.present.some((i) => SHEETS[sheet].columns[i]!.db === db);
  // Data scope for sheets 02-05: the whole tenant with `imports.tenant_wide`.
  const w: Scope = writesWholeTenant(scope) ? { ...scope, reach: "TENANT" } : scope;
  const stagedOk = (sheet: SheetName, where: string) =>
    raw(`exists (select 1 from import_rows s where s.import_id = import_rows.import_id and s.sheet = '${sheet}' and s.status = 'OK' and ${where})`);

  const stmts: SQL[] = [];
  const flag = (sheet: SheetName, column: string, code: string, severity: "error" | "warning", predicate: SQL) => {
    const where = sql`import_id = ${importId} and sheet = ${sheet} and status = 'OK' and (${predicate})`;
    stmts.push(sql`
      insert into import_errors (id, import_id, tenant_id, sheet, "row", "column", code, record_key, message_vi, severity)
      select lower(hex(randomblob(16))), import_id, tenant_id, sheet, row_no, ${column}, ${code}, "key", ${importMessage(code)}, ${severity}
      from import_rows where ${where}`);
    if (severity === "error") stmts.push(sql`update import_rows set status = 'REJECTED' where ${where}`);
  };
  const reject = (sheet: SheetName, column: string, code: string, predicate: SQL) => flag(sheet, column, code, "error", predicate);
  const warn = (sheet: SheetName, column: string, code: string, predicate: SQL) => flag(sheet, column, code, "warning", predicate);

  // 1. The same record twice in one sheet: the first row wins.
  for (const def of Object.values(SHEETS)) {
    if (!ready(def.name)) continue;
    reject(
      def.name,
      def.columns.find((c) => (def.rowKey ?? def.key).includes(c.db))!.header,
      "duplicate_key",
      raw(`exists (select 1 from import_rows d where d.import_id = import_rows.import_id and d.sheet = import_rows.sheet
                  and d."key" = import_rows."key" and d.status = 'OK' and d.row_no < import_rows.row_no)`),
    );
  }

  // 2. Agents. Without `imports.agent_tree`, only the uploader's own row and their downline,
  //    and the manager link is left alone (commit.ts).
  if (ready("01_Agents")) {
    if (!loadsWholeTree(scope)) {
      reject("01_Agents", "Tư vấn tài chính", "out_of_scope", sql`not ${agentInScope(scope, raw("import_rows.owner"))}`);
    } else if (present("01_Agents", "manager_code")) {
      warn(
        "01_Agents",
        "Quản lý",
        "manager_fixed_kept",
        raw(`exists (select 1 from agents a where ${sameTarget(SHEETS["01_Agents"], "a", "import_rows")} and a.manager_fixed = 1
                     and coalesce(a.manager_code, '') <> coalesce(${field("import_rows", "manager_code")}, ''))`),
      );
    }
  }

  // 3. Policies: each row is one agent's link and share; that agent must be in scope.
  //    Shares and transfers are checked after this batch (policy-links.ts).
  if (ready("03_Policies") && w.reach !== "TENANT") {
    reject("03_Policies", "Mã đại lý", "out_of_scope", sql`not ${agentInScope(w, raw("import_rows.owner"))}`);
  }

  // 4. Applications and activities keep their agent: it must be in scope and cannot be taken over.
  for (const sheet of ["05_Applications", "07_Activities"] as const) {
    if (!ready(sheet) || w.reach === "TENANT") continue;
    const def = SHEETS[sheet];
    const agentColumn = def.columns.find((c) => c.db === "agent_code")!.header;
    reject(sheet, agentColumn, "out_of_scope", sql`not ${agentInScope(w, raw("import_rows.owner"))}`);
    reject(
      sheet,
      def.columns[0]!.header,
      "owned_by_other",
      sql`exists (select 1 from ${raw(def.table)} t where ${raw(sameTarget(def, "t", "import_rows"))}
                  and not ${agentInScope(w, raw("t.agent_code"))})`,
    );
  }

  // 5. Policy products follow their policy: in this file, or already imported and in scope.
  if (ready("04_Policy_Products")) {
    reject(
      "04_Policy_Products",
      "Số HĐBH",
      "policy_not_found",
      sql`not (${stagedOk("03_Policies", `${field("s", "policy_no")} = ${field("import_rows", "policy_no")}`)}
            or exists (select 1 from policies p where p.tenant_id = import_rows.tenant_id and p.policy_no = ${raw(field("import_rows", "policy_no"))}
                       and ${policyInScope(w, raw("p.policy_no"))}))`,
    );
  }

  // 6. Clients: a client already in the GA and outside the scope is accepted only when this
  //    file also carries a policy or application of the uploader for them.
  if (ready("02_Clients") && w.reach !== "TENANT") {
    reject(
      "02_Clients",
      "Mã Khách Hàng",
      "client_out_of_scope",
      sql`exists (select 1 from clients c where ${raw(sameTarget(SHEETS["02_Clients"], "c", "import_rows"))})
          and not ${clientInScope(w, raw(`import_rows."key"`))}
          and not ${stagedOk("03_Policies", `import_rows."key" in (${field("s", "holder_client_code")}, ${field("s", "insured_client_code")})`)}
          and not ${stagedOk("05_Applications", `import_rows."key" = ${field("s", "client_code")}`)}`,
    );
  }

  // 7. Leads: the assignee must be an agent of the GA. A phone already known updates that lead.
  if (ready("13_Leads")) {
    reject(
      "13_Leads",
      "Mã đại lý",
      "agent_not_found",
      raw(`import_rows.owner is not null and not exists (select 1 from agents a where a.tenant_id = import_rows.tenant_id and a.agent_code = import_rows.owner)`),
    );
    // The later record wins: a row is applied to an existing lead only when its update date
    // (NGÀY CẬP NHẬT LEAD) is after the lead's last update in the CRM. Same day: the CRM wins.
    const older = sql`import_id = ${importId} and sheet = '13_Leads' and status = 'OK' and exists (select 1 from leads t
      where ${raw(sameTarget(SHEETS["13_Leads"], "t", "import_rows"))}
        and (${raw(leadRowTime("import_rows"))} is null or ${raw(leadRowTime("import_rows"))} <= t.updated_at))`;
    stmts.push(
      sql`insert into import_errors (id, import_id, tenant_id, sheet, "row", "column", code, record_key, message_vi, severity)
          select lower(hex(randomblob(16))), import_id, tenant_id, sheet, row_no, 'NGÀY CẬP NHẬT LEAD', 'lead_not_newer', "key",
                 ${importMessage("lead_not_newer")}, 'warning'
          from import_rows where ${older}`,
      sql`update import_rows set status = 'SKIPPED' where ${older}`,
    );
    // An FC's own lead stays theirs while they still work for the GA.
    reject(
      "13_Leads",
      "Mã đại lý",
      "own_lead_locked",
      raw(`import_rows.owner is not null and exists (select 1 from leads t join users u on u.id = t.created_by
             left join agents a on a.tenant_id = t.tenant_id and a.agent_code = u.agent_code
             where ${sameTarget(SHEETS["13_Leads"], "t", "import_rows")} and t.origin = 'FC_OWN' and u.status = 'ACTIVE'
               and a.end_date is null and coalesce(a.status, '') <> 'Ngưng hoạt động' and import_rows.owner is not u.agent_code)`),
    );
    warn("13_Leads", "SỐ ĐIỆN THOẠI", "lead_exists", raw(`exists (select 1 from leads t where ${sameTarget(SHEETS["13_Leads"], "t", "import_rows")})`));
  }

  await sqlBatch(db, stmts);

  // 8. Shares of split policies, and changes of servicing agent (policy-links.ts).
  if (ready("03_Policies")) {
    const plan = await planPolicyLinks(db, scope.tenantId, importId, {
      mustBeComplete: w.reach === "TENANT",
      withSplit: present("03_Policies", "split_percent"),
    });
    const bad = JSON.stringify(plan.badRows);
    const changed = JSON.stringify(plan.servicingChanges.map(([p]) => p));
    const rowsWhere = (list: string, by: "row" | "policy") =>
      by === "row"
        ? sql`import_id = ${importId} and sheet = '03_Policies' and status = 'OK' and row_no in (select value from json_each(${list}))`
        : sql`import_id = ${importId} and sheet = '03_Policies' and status = 'OK' and json_extract(data, '$.policy_no') in (select value from json_each(${list}))
              and row_no = (select min(f.row_no) from import_rows f where f.import_id = import_rows.import_id and f.sheet = import_rows.sheet
                            and f.status = 'OK' and json_extract(f.data, '$.policy_no') = json_extract(import_rows.data, '$.policy_no'))`;
    const note = (where: SQL, column: string, code: string, severity: string) => sql`
      insert into import_errors (id, import_id, tenant_id, sheet, "row", "column", code, record_key, message_vi, severity)
      select lower(hex(randomblob(16))), import_id, tenant_id, sheet, row_no, ${column}, ${code}, "key", ${importMessage(code)}, ${severity}
      from import_rows where ${where}`;
    await sqlBatch(db, [
      note(rowsWhere(changed, "policy"), "Mã đại lý", "servicing_changed", "warning"),
      note(rowsWhere(bad, "row"), "Tỉ lệ chia", "split_total", "error"),
      sql`update import_rows set status = 'REJECTED' where ${rowsWhere(bad, "row")}`,
    ]);
  }

  // Counts for the preview, in rows.
  const next: ImportSheetCounts = structuredClone(counts);
  for (const def of Object.values(SHEETS)) {
    if (!ready(def.name)) continue;
    const mine = sql`import_id = ${importId} and sheet = ${def.name}`;
    const [row] = await db.all<{ ok: number; updated: number; rejected: number; skipped: number; warnings: number }>(sql`
      select
        (select count(*) from import_rows where ${mine} and status = 'OK') as ok,
        (select count(*) from import_rows where ${mine} and status = 'OK'
           and exists (select 1 from ${raw(def.table)} t where ${raw(sameTarget(def, "t", "import_rows"))})) as updated,
        (select count(distinct "row") from import_errors where ${mine} and severity = 'error' and "row" > 1) as rejected,
        (select count(*) from import_rows where ${mine} and status = 'SKIPPED') as skipped,
        (select count(*) from import_errors where ${mine} and severity = 'warning') as warnings`);
    const c = next[def.name]!;
    c.updated = row!.updated;
    c.inserted = row!.ok - row!.updated;
    c.rejected = row!.rejected;
    c.warnings = row!.warnings;
    c.skipped = row!.skipped;
    c.found = row!.ok + row!.rejected + row!.skipped;
  }
  return next;
}
