import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { agents } from "../../db/schema";
import { ACTION_KINDS, type ActionKind } from "../../shared/enums";
import { leadReportSchema } from "../../shared/schemas";
import type { AppEnv } from "../env";
import { valid } from "../http";
import { agentInScope, can, scopeOf, visibleAgents, type Scope } from "../scope";

const manager = alias(agents, "manager");

/** Calls and meetings with the same customer on the same day, in the CRM and in Success, count once. */
const DEDUP: ActionKind[] = ["CALL", "ZALO", "MEETING"];

type Row = { agent: string; kind: ActionKind; n: number; crm: number; success: number };

export const reportRoutes = new Hono<AppEnv>()
  /**
   * "Hoạt động đại lý": what agents did over a period (Vietnam days), a leading signal for
   * conversion. Sources: contacts logged on leads in the CRM, and 07_Activities imported from
   * the Success activity tracking module (draft and rejected records are not counted).
   * Lead managers see every agent, managers their line, an FC their own row.
   */
  .get("/activities", valid("query", leadReportSchema), async (c) => {
    const db = c.get("db");
    const actor = scopeOf(c.get("actor"));
    const scope: Scope = can(actor, "leads.manage") ? { ...actor, reach: "TENANT" } : actor;
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const { from = `${today.slice(0, 7)}-01`, to = today } = c.req.valid("query");
    const dedup = sql.raw(DEDUP.map((k) => `'${k}'`).join(", "));

    const rows = await db.all<Row>(sql`
      with u as (
        select a.agent_code as agent, a.type as kind, date(a.occurred_at, '+7 hours') as day,
               case when l.phone is not null then substr(l.phone, 1, 4) || '***' || substr(l.phone, -3) end as pk, 'CRM' as src
        from crm_activities a left join leads l on l.id = a.lead_id and l.tenant_id = a.tenant_id
        where a.tenant_id = ${scope.tenantId} and a.agent_code is not null and a.type in ('CALL', 'ZALO', 'MEETING', 'SEMINAR')
          and date(a.occurred_at, '+7 hours') between ${from} and ${to}
        union all
        select s.agent_code, case when s.activity_type = 'CALL' and lower(coalesce(s.call_type, '')) = 'zalo' then 'ZALO' else s.activity_type end,
               s.activity_date, s.phone_key, 'SUCCESS'
        from success_activities s
        where s.tenant_id = ${scope.tenantId} and s.status not in ('draft', 'rejected') and s.activity_date between ${from} and ${to}
      )
      select agent, kind,
        count(distinct case when pk is not null and kind in (${dedup}) then day || '|' || pk end)
          + sum(case when pk is null or kind not in (${dedup}) then 1 else 0 end) as n,
        sum(case when src = 'CRM' then 1 else 0 end) as crm,
        sum(case when src = 'SUCCESS' then 1 else 0 end) as success
      from u where ${agentInScope(scope, sql.raw("u.agent"))}
      group by agent, kind`);

    // Lagging signal next to it: leads marked "Đã chốt" in the period, by their current agent.
    const won = await db.all<{ agent: string; n: number }>(sql`
      select l.assigned_agent_code as agent, count(distinct h.lead_id) as n
      from lead_history h join leads l on l.id = h.lead_id
      where h.tenant_id = ${scope.tenantId} and h.field = 'care_status' and h.new_value = 'WON'
        and date(h.changed_at, '+7 hours') between ${from} and ${to} and l.assigned_agent_code is not null
        and ${agentInScope(scope, sql.raw("l.assigned_agent_code"))}
      group by l.assigned_agent_code`);

    const codes = new Set([...rows.map((r) => r.agent), ...won.map((w) => w.agent)]);
    const directory = await db
      .select({ agentCode: agents.agentCode, name: agents.name, managerName: manager.name })
      .from(agents)
      .leftJoin(manager, and(eq(manager.tenantId, agents.tenantId), eq(manager.agentCode, agents.managerCode)))
      .where(visibleAgents(scope))
      .orderBy(asc(agents.name));

    const items = directory
      .filter((a) => codes.has(a.agentCode))
      .map((a) => {
        const mine = rows.filter((r) => r.agent === a.agentCode);
        const counts = Object.fromEntries(ACTION_KINDS.map((k) => [k, mine.find((r) => r.kind === k)?.n ?? 0])) as Record<ActionKind, number>;
        return {
          ...a,
          counts,
          total: Object.values(counts).reduce((n, v) => n + v, 0),
          fromCrm: mine.reduce((n, r) => n + r.crm, 0),
          fromSuccess: mine.reduce((n, r) => n + r.success, 0),
          won: won.find((w) => w.agent === a.agentCode)?.n ?? 0,
        };
      });
    return c.json({ from, to, items });
  });
