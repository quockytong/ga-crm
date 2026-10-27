import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";

/**
 * Agents of a policy from 03_Policies rows.
 *
 * - An FC's own Success export has one row per policy: their agent code and their share.
 *   Such a row only adds or updates that agent's link; the other agents keep theirs.
 * - A GA export may list every agent of a policy (one row each). When the shares of a
 *   policy's rows add up to 100%, the rows are the complete picture: links not in the
 *   file are ended (a transfer). A single row with 100% (or no share) is complete too.
 * - With `imports.tenant_wide` (GA data) every policy must be complete, or its rows are
 *   rejected. For anyone, a policy whose shares would exceed 100% is rejected.
 * - Servicing agent: the largest share; on a tie the current servicing agent, then file order.
 */

type Row = { rowNo: number; policyNo: string; agent: string; split: number | null };
type Link = { agent: string; split: number | null; isServicing: boolean };

export type PolicyPlan = {
  /** Links to write per policy (current after the import). */
  links: Map<string, Link[]>;
  /** Links to end per policy. */
  ended: Map<string, string[]>;
  servicing: Map<string, string>;
  /** Existing policies whose servicing agent changes: [policy, old, new]. */
  servicingChanges: [string, string, string][];
  /** Agent sets before and after, for existing policies whose set changes: "agent:share;...". */
  setChanges: [string, string, string][];
  /** Row numbers to reject because the shares do not add up. */
  badRows: number[];
};

const total = (links: { split: number | null }[]) => links.reduce((n, l) => n + (l.split ?? 0), 0);
const describe = (links: { agent: string; split: number | null }[]) =>
  [...links].sort((a, b) => a.agent.localeCompare(b.agent)).map((l) => `${l.agent}:${l.split ?? ""}`).join(";");

export async function planPolicyLinks(
  db: Db,
  tenantId: string,
  importId: string,
  opts: { mustBeComplete: boolean; withSplit: boolean },
): Promise<PolicyPlan> {
  const rows = (
    await db.all<{ rowNo: number; policyNo: string; agent: string; split: number | null }>(sql`
      select row_no as rowNo, json_extract(data, '$.policy_no') as policyNo, owner as agent,
             json_extract(data, '$.split_percent') as split
      from import_rows where import_id = ${importId} and sheet = '03_Policies' and status = 'OK'
      order by row_no`)
  ).map((r) => ({ ...r, split: opts.withSplit ? r.split : null }));

  const byPolicy = new Map<string, Row[]>();
  for (const r of rows) byPolicy.set(r.policyNo, [...(byPolicy.get(r.policyNo) ?? []), r]);
  const policyNos = JSON.stringify([...byPolicy.keys()]);

  const [current, servicingNow] = await Promise.all([
    db.all<{ policyNo: string; agent: string; split: number | null }>(sql`
      select policy_no as policyNo, agent_code as agent, split_percent as split from policy_agents
      where tenant_id = ${tenantId} and ended_at is null and policy_no in (select value from json_each(${policyNos}))`),
    db.all<{ policyNo: string; agent: string }>(sql`
      select policy_no as policyNo, servicing_agent_code as agent from policies
      where tenant_id = ${tenantId} and policy_no in (select value from json_each(${policyNos}))`),
  ]);

  const plan: PolicyPlan = { links: new Map(), ended: new Map(), servicing: new Map(), servicingChanges: [], setChanges: [], badRows: [] };
  for (const [policyNo, fileRows] of byPolicy) {
    const before = current.filter((c) => c.policyNo === policyNo);
    const single = fileRows.length === 1 && (fileRows[0]!.split === null || fileRows[0]!.split === 100);
    const complete = single || (fileRows.every((r) => r.split !== null) && total(fileRows) === 100);

    let after: { agent: string; split: number | null; order: number }[];
    if (complete) {
      after = fileRows.map((r, i) => ({ agent: r.agent, split: single ? (r.split ?? 100) : r.split, order: i }));
    } else {
      const merged = new Map(before.map((b, i) => [b.agent, { agent: b.agent, split: b.split, order: 1000 + i }]));
      fileRows.forEach((r, i) => merged.set(r.agent, { agent: r.agent, split: r.split ?? merged.get(r.agent)?.split ?? null, order: i }));
      after = [...merged.values()];
    }
    if ((opts.mustBeComplete && !complete) || total(after) > 100) {
      plan.badRows.push(...fileRows.map((r) => r.rowNo));
      continue;
    }

    const oldServicing = servicingNow.find((s) => s.policyNo === policyNo)?.agent;
    const best = Math.max(...after.map((a) => a.split ?? 0));
    const tied = after.filter((a) => (a.split ?? 0) === best).sort((a, b) => a.order - b.order);
    const servicing = (tied.find((a) => a.agent === oldServicing) ?? tied[0]!).agent;

    plan.servicing.set(policyNo, servicing);
    plan.links.set(policyNo, after.map((a) => ({ agent: a.agent, split: a.split, isServicing: a.agent === servicing })));
    plan.ended.set(policyNo, before.filter((b) => !after.some((a) => a.agent === b.agent)).map((b) => b.agent));
    if (oldServicing && oldServicing !== servicing) plan.servicingChanges.push([policyNo, oldServicing, servicing]);
    if (oldServicing && describe(before) !== describe(after)) plan.setChanges.push([policyNo, describe(before), describe(after)]);
  }
  return plan;
}

/** Statements that apply a plan. The staged rows get the servicing agent before the policies are upserted. */
export function applyPolicyPlan(plan: PolicyPlan, tenantId: string, importId: string, userId: string, now: string) {
  const servicing = JSON.stringify([...plan.servicing].map(([p, s]) => ({ p, s })));
  const ended = JSON.stringify([...plan.ended].flatMap(([p, agents]) => agents.map((a) => ({ p, a }))));
  const links = JSON.stringify([...plan.links].flatMap(([p, ls]) => ls.map((l) => ({ p, a: l.agent, s: l.split, v: l.isServicing ? 1 : 0 }))));
  const history = JSON.stringify(plan.setChanges.map(([p, o, n]) => ({ p, o, n })));

  const beforeUpsert: SQL[] = [
    sql`update import_rows set data = json_set(data, '$.servicing_agent_code',
          (select json_extract(value, '$.s') from json_each(${servicing}) where json_extract(value, '$.p') = json_extract(import_rows.data, '$.policy_no')))
        where import_id = ${importId} and sheet = '03_Policies' and status = 'OK'`,
    sql`insert into record_changes (id, tenant_id, entity, entity_key, field, old_value, new_value, import_id, changed_by, changed_at)
        select lower(hex(randomblob(16))), ${tenantId}, 'policy', json_extract(value, '$.p'), 'agents',
               json_extract(value, '$.o'), json_extract(value, '$.n'), ${importId}, ${userId}, ${now}
        from json_each(${history})`,
  ];
  const afterUpsert: SQL[] = [
    sql`update policy_agents set ended_at = ${now}, is_servicing = 0, last_import_id = ${importId}
        where tenant_id = ${tenantId} and ended_at is null
          and exists (select 1 from json_each(${ended}) where json_extract(value, '$.p') = policy_agents.policy_no
                      and json_extract(value, '$.a') = policy_agents.agent_code)`,
    sql`insert into policy_agents (tenant_id, policy_no, agent_code, split_percent, is_servicing, started_at, last_import_id, last_seen_at)
        select ${tenantId}, json_extract(value, '$.p'), json_extract(value, '$.a'), json_extract(value, '$.s'),
               json_extract(value, '$.v'), ${now}, ${importId}, ${now}
        from json_each(${links}) where true
        on conflict (tenant_id, policy_no, agent_code) do update set
          split_percent = excluded.split_percent, is_servicing = excluded.is_servicing,
          started_at = case when policy_agents.ended_at is null then policy_agents.started_at else excluded.started_at end,
          ended_at = null, last_import_id = excluded.last_import_id, last_seen_at = excluded.last_seen_at`,
  ];
  return { beforeUpsert, afterUpsert };
}
