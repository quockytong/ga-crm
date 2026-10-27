import { eq, sql, type SQL } from "drizzle-orm";
import { sqlBatch, type Db } from "../../db/client";
import { importRows, imports } from "../../db/schema";
import { SHEETS, type ImportSheetCounts, type SheetDef, type SheetName } from "../../shared/import/template";
import { rebuildAgentPaths } from "../agent-tree";
import { auditStmt, type AuditEntry } from "../audit";
import type { Scope } from "../scope";
import { leadStatements } from "./leads";
import { applyPolicyPlan, planPolicyLinks } from "./policy-links";
import { field, firstPolicyRow, sameTarget, targetKey } from "./sql";
import { loadsWholeTree, writesWholeTenant } from "./validate";

const raw = sql.raw;

/** How one sheet is written to its table. All expressions are over the staged row `r`. */
type Plan = {
  def: SheetDef;
  entity: string;
  /** Target column -> value. Only columns present in the file, so missing ones are never wiped. */
  values: Record<string, string>;
  /** Extra filter on staged rows. */
  where?: string;
  /** Columns set on insert only. */
  insertOnly?: Record<string, string>;
  /** Bookkeeping columns, set on insert and update, never logged. */
  stamp: Record<string, string>;
  /** Column -> value actually written on update, over the existing row `t` (default: the new value). */
  effective?: Record<string, string>;
};

/** Template columns present in the file, as target column -> JSON path over `r`. */
function fileValues(def: SheetDef, present: readonly number[], skip: readonly string[] = []) {
  const cols = present.flatMap((i) => {
    const c = def.columns[i]!;
    const own = c.type.t === "agentRef" ? [c.type.code, c.type.name, c.type.rank] : [c.db];
    return c.norm ? [...own, c.norm] : own;
  });
  return Object.fromEntries(cols.filter((c) => !skip.includes(c)).map((c) => [c, field("r", c)]));
}

/** `INSERT ... SELECT ... ON CONFLICT DO UPDATE` for every OK staged row of the plan's sheet. */
function upsertSql(plan: Plan, importId: string): SQL {
  const { def } = plan;
  const cols = Object.keys(plan.values);
  const extra = { ...plan.insertOnly, ...plan.stamp };
  const insertCols = ["tenant_id", ...cols, ...Object.keys(extra)];
  const selects = ["r.tenant_id", ...Object.values(plan.values), ...Object.values(extra)];
  const updates = [...cols.filter((c) => !def.key.includes(c)), ...Object.keys(plan.stamp)].map((c) => {
    // In DO UPDATE the existing row is the table itself, the new one `excluded`.
    const eff = plan.effective?.[c]?.replaceAll("t.", `${def.table}.`).replaceAll("NEW", `excluded.${c}`);
    return `${c} = ${eff ?? `excluded.${c}`}`;
  });
  return sql`${raw(`insert into ${def.table} (${insertCols.join(", ")}) select ${selects.join(", ")} from import_rows r`)}
    where r.import_id = ${importId} and r.sheet = ${def.name} and r.status = 'OK' ${raw(plan.where ? `and ${plan.where}` : "")}
    ${raw(`on conflict (tenant_id, ${def.key.join(", ")}) do update set ${updates.join(", ")}`)}`;
}

/**
 * Field-level history: one record_changes row per existing record and changed column.
 * Runs before the upsert, while the old values are still there.
 */
function changesSql(plan: Plan, importId: string, userId: string, now: string): SQL[] {
  const { def } = plan;
  const cols = Object.keys(plan.values).filter((c) => !def.key.includes(c));
  // One statement per column: D1 allows very few terms in a compound SELECT.
  return cols.map((c) => {
    const next = (plan.effective?.[c] ?? "NEW").replaceAll("NEW", plan.values[c]!);
    return sql`insert into record_changes (id, tenant_id, entity, entity_key, field, old_value, new_value, import_id, changed_by, changed_at)
      ${raw(`select lower(hex(randomblob(16))), t.tenant_id, '${plan.entity}', ${targetKey(def, "t")}, '${c}',
        cast(t.${c} as text), cast(${next} as text)`)}, ${importId}, ${userId}, ${now}
      ${raw(`from import_rows r join ${def.table} t on ${sameTarget(def, "t", "r")}`)}
      where r.import_id = ${importId} and r.sheet = ${def.name} and r.status = 'OK'
      ${raw(`${plan.where ? `and ${plan.where}` : ""} and t.${c} is not ${next}`)}`;
  });
}

/** Writes every staged row of a validated import, with history, in one transaction. */
export async function commitImport(
  db: Db,
  scope: Scope,
  imp: { id: string; tenantId: string; fileName: string },
  counts: ImportSheetCounts,
  audit: Pick<AuditEntry, "tenantId" | "userId" | "ip">,
) {
  const now = new Date().toISOString();
  const ready = (sheet: SheetName) => counts[sheet]?.status === "READY";
  const hasColumn = (sheet: SheetName, col: string) => counts[sheet]!.present.some((i) => SHEETS[sheet].columns[i]!.db === col);
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const stamp = { last_import_id: q(imp.id), last_seen_at: q(now) };

  const plans: Plan[] = [];
  if (ready("01_Agents")) {
    const wholeTree = loadsWholeTree(scope);
    plans.push({
      def: SHEETS["01_Agents"],
      entity: "agent",
      values: fileValues(SHEETS["01_Agents"], counts["01_Agents"]!.present, ["manager_name", "manager_rank"]),
      insertOnly: { path: `'/' || ${field("r", "agent_code")} || '/'` },
      stamp: { updated_by_import_id: q(imp.id) },
      // The tree is loaded with `imports.agent_tree` only, and never over a link fixed by hand.
      effective: hasColumn("01_Agents", "manager_code")
        ? { manager_code: wholeTree ? "case when t.manager_fixed = 1 then t.manager_code else NEW end" : "t.manager_code" }
        : undefined,
    });
  }
  if (ready("02_Clients")) {
    plans.push({ def: SHEETS["02_Clients"], entity: "client", values: fileValues(SHEETS["02_Clients"], counts["02_Clients"]!.present), stamp });
  }
  if (ready("03_Policies")) {
    // Agent and share go to policy_agents; the first row of each policy carries the policy.
    plans.push({
      def: SHEETS["03_Policies"],
      entity: "policy",
      values: {
        ...fileValues(SHEETS["03_Policies"], counts["03_Policies"]!.present, ["agent_code", "split_percent"]),
        // Set on the staged rows by applyPolicyPlan() just before the upsert.
        servicing_agent_code: field("r", "servicing_agent_code"),
      },
      where: firstPolicyRow("r"),
      stamp,
    });
  }
  if (ready("04_Policy_Products")) {
    plans.push({
      def: SHEETS["04_Policy_Products"],
      entity: "policy_product",
      values: fileValues(SHEETS["04_Policy_Products"], counts["04_Policy_Products"]!.present),
      stamp,
    });
  }
  if (ready("07_Activities")) {
    plans.push({
      def: SHEETS["07_Activities"],
      entity: "success_activity",
      values: {
        ...fileValues(SHEETS["07_Activities"], counts["07_Activities"]!.present),
        activity_date: field("r", "activity_date"),
        phone_key: field("r", "phone_key"),
      },
      stamp,
    });
  }
  if (ready("05_Applications")) {
    plans.push({
      def: SHEETS["05_Applications"],
      entity: "application",
      values: fileValues(SHEETS["05_Applications"], counts["05_Applications"]!.present),
      stamp,
    });
  }

  const links = ready("03_Policies")
    ? applyPolicyPlan(
        await planPolicyLinks(db, imp.tenantId, imp.id, {
          mustBeComplete: writesWholeTenant(scope),
          withSplit: hasColumn("03_Policies", "split_percent"),
        }),
        imp.tenantId,
        imp.id,
        scope.userId,
        now,
      )
    : { beforeUpsert: [], afterUpsert: [] };

  const stmts: SQL[] = [...links.beforeUpsert];
  // History first, while the old values are still in place.
  for (const plan of plans) stmts.push(...changesSql(plan, imp.id, scope.userId, now));
  for (const plan of plans) stmts.push(upsertSql(plan, imp.id));
  stmts.push(...links.afterUpsert);

  if (ready("01_Agents") && loadsWholeTree(scope) && hasColumn("01_Agents", "manager_code")) {
    // A manager named in "Quản lý" who has no row of their own yet.
    stmts.push(sql`
      insert into agents (tenant_id, agent_code, name, rank, path, updated_by_import_id)
      select r.tenant_id, ${raw(field("r", "manager_code"))}, ${raw(field("r", "manager_name"))},
             ${raw(field("r", "manager_rank"))}, '/' || ${raw(field("r", "manager_code"))} || '/', ${imp.id}
      from import_rows r where r.import_id = ${imp.id} and r.sheet = '01_Agents' and r.status = 'OK'
        and ${raw(field("r", "manager_code"))} is not null
      on conflict (tenant_id, agent_code) do nothing`);
  }
  if (ready("03_Policies")) stmts.push(...policyClientLinks(imp.id, now, hasColumn("03_Policies", "insured_client_code")));
  if (ready("04_Policy_Products") && hasColumn("04_Policy_Products", "insured_code")) {
    stmts.push(sql`
      insert into policy_clients (tenant_id, policy_no, client_code, role, source, last_import_id, last_seen_at)
      select r.tenant_id, ${raw(field("r", "policy_no"))}, ${raw(field("r", "insured_code"))}, 'LI', 'PRODUCT', ${imp.id}, ${now}
      from import_rows r where r.import_id = ${imp.id} and r.sheet = '04_Policy_Products' and r.status = 'OK'
        and ${raw(field("r", "insured_code"))} <> ''
      on conflict (tenant_id, policy_no, client_code, role) do update
        set ended_at = null, last_import_id = excluded.last_import_id, last_seen_at = excluded.last_seen_at`);
  }
  if (ready("13_Leads")) {
    const leads = leadStatements(imp.id, counts["13_Leads"]!.present, scope.userId, now);
    stmts.push(...leads.before, leads.upsert, ...leads.after);
  }
  if (ready("02_Clients") && scope.agentCode) {
    // The uploader of a client row sees that client (DATA-MODEL section 4).
    stmts.push(sql`
      insert into client_agents (tenant_id, client_code, agent_code, source)
      select r.tenant_id, r."key", ${scope.agentCode}, 'CLIENTS_SHEET'
      from import_rows r where r.import_id = ${imp.id} and r.sheet = '02_Clients' and r.status = 'OK'
      on conflict do nothing`);
  }

  await sqlBatch(db, [
    db.update(imports).set({ status: "COMMITTED", committedAt: now }).where(eq(imports.id, imp.id)),
    ...stmts,
    db.delete(importRows).where(eq(importRows.importId, imp.id)),
    auditStmt(db, {
      ...audit,
      action: "IMPORT",
      entity: "import",
      entityId: imp.id,
      meta: {
        fileName: imp.fileName,
        sheets: Object.fromEntries(
          Object.entries(counts)
            .filter(([, c]) => c.status === "READY")
            .map(([name, c]) => [name, { inserted: c.inserted, updated: c.updated, rejected: c.rejected }]),
        ),
      },
    }),
  ]);

  if (ready("01_Agents")) await rebuildAgentPaths(db, imp.tenantId);
  return now;
}

const POLICY_ROWS = (importId: string) => sql`r.import_id = ${importId} and r.sheet = '03_Policies' and r.status = 'OK'`;

/** PO and LI of each imported policy, from 03_Policies. Links that no longer match are ended. */
function policyClientLinks(importId: string, now: string, withInsured: boolean): SQL[] {
  const holder = field("r", "holder_client_code");
  const insured = field("r", "insured_client_code");
  const roles = withInsured ? "('PO', 'LI')" : "('PO')";
  return [
    sql`
      update policy_clients set ended_at = ${now}, last_import_id = ${importId}
      where ended_at is null and source = 'POLICY' and role in ${raw(roles)}
        and exists (select 1 from import_rows r where ${POLICY_ROWS(importId)} and ${raw(firstPolicyRow("r"))}
                    and r.tenant_id = policy_clients.tenant_id and ${raw(field("r", "policy_no"))} = policy_clients.policy_no
                    and not ((policy_clients.role = 'PO' and policy_clients.client_code = ${raw(holder)})
                          ${raw(withInsured ? `or (policy_clients.role = 'LI' and policy_clients.client_code is ${insured})` : "")}))`,
    sql`
      insert into policy_clients (tenant_id, policy_no, client_code, role, source, last_import_id, last_seen_at)
      select r.tenant_id, ${raw(field("r", "policy_no"))}, ${raw(holder)}, 'PO', 'POLICY', ${importId}, ${now}
      from import_rows r where ${POLICY_ROWS(importId)} and ${raw(firstPolicyRow("r"))}
      on conflict (tenant_id, policy_no, client_code, role) do update
        set ended_at = null, last_import_id = excluded.last_import_id, last_seen_at = excluded.last_seen_at`,
    ...(withInsured
      ? [
          sql`
      insert into policy_clients (tenant_id, policy_no, client_code, role, source, last_import_id, last_seen_at)
      select r.tenant_id, ${raw(field("r", "policy_no"))}, ${raw(insured)}, 'LI', 'POLICY', ${importId}, ${now}
      from import_rows r where ${POLICY_ROWS(importId)} and ${raw(firstPolicyRow("r"))} and ${raw(insured)} is not null
      on conflict (tenant_id, policy_no, client_code, role) do update
        set ended_at = null, last_import_id = excluded.last_import_id, last_seen_at = excluded.last_seen_at`,
        ]
      : []),
  ];
}
