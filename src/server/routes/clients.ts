import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import {
  agents,
  applications,
  clientFamily,
  clients,
  crmActivities,
  leads,
  policies,
  policyAgents,
  policyClients,
  policyProducts,
  products,
  recordChanges,
  users,
} from "../../db/schema";
import { ACTIVE_STATUS, addDays, coverageGroup, GAP_GROUPS, MATURITY_DAYS, PREMIUM_DUE_DAYS, vnToday, type CoverageGroup } from "../../shared/coverage";
import { INVERSE_RELATION, type FamilyRelation } from "../../shared/enums";
import { normalizeName, titleCase } from "../../shared/normalize";
import {
  clientActivitySchema,
  clientCountsSchema,
  clientListSchema,
  clientNoteSchema,
  createFamilySchema,
  linkFamilyLeadSchema,
  updateFamilySchema,
  type ClientSignal,
} from "../../shared/schemas";
import { auditBy, auditStmt } from "../audit";
import type { AppEnv } from "../env";
import { ApiError, forbidden, notFound } from "../errors";
import { chunks, contains, valid } from "../http";
import { agentInScope, agentsInScope, clientInScope, clientOfAgents, inTenant, policyInScope, scopeOf, visibleLeads, type Scope } from "../scope";

/**
 * F8: client 360. Who sees a client follows the agent tree (clientInScope): the FC their own
 * clients, managers their line, the GA Head everyone. Marketing and Admin have no agent
 * scope and see no client here (their masked views are separate). Only the policies in the
 * caller's scope are shown. The family and the care log are kept by the client's own agents.
 */

/** A condition on the client's policies in scope (`sp` = policies, `spc` = policy_clients). */
function onPolicies(scope: Scope, client: SQLWrapper, cond: string, roles?: readonly ("PO" | "LI")[]): SQL {
  return sql`exists (select 1 from policy_clients spc join policies sp on sp.tenant_id = spc.tenant_id and sp.policy_no = spc.policy_no
    where spc.tenant_id = ${scope.tenantId} and spc.client_code = ${client} and spc.ended_at is null
    ${roles ? sql.raw(`and spc.role in (${roles.map((r) => `'${r}'`).join(", ")})`) : sql``}
    and ${sql.raw(cond)} and ${policyInScope(scope, sql.raw("sp.policy_no"))})`;
}

export function signalSql(scope: Scope, signal: ClientSignal, today: string): SQL {
  const q = (v: string) => `'${v}'`;
  const active = `sp.status = ${q(ACTIVE_STATUS)}`;
  switch (signal) {
    case "due":
      return onPolicies(scope, clients.clientCode, `${active} and sp.premium_due_date between ${q(today)} and ${q(addDays(today, PREMIUM_DUE_DAYS))}`, ["PO"]);
    case "debt":
      return onPolicies(scope, clients.clientCode, `(coalesce(sp.unpaid_premium_vnd, 0) > 0 or coalesce(sp.apl_debt_vnd, 0) > 0)`, ["PO"]);
    case "maturity":
      return onPolicies(scope, clients.clientCode, `${active} and sp.maturity_date between ${q(today)} and ${q(addDays(today, MATURITY_DAYS))}`, ["PO", "LI"]);
    case "birthday":
      return sql`substr(${clients.birthDayMonth}, 4, 2) = ${today.slice(5, 7)}`;
    case "lapsed":
      return sql`(coalesce(${clients.lapsedPolicies}, 0) > 0 or ${onPolicies(scope, clients.clientCode, `sp.status like '%mất hiệu lực%'`)})`;
  }
}

export const SIGNALS: readonly ClientSignal[] = ["due", "debt", "maturity", "birthday", "lapsed"];

async function getClient(db: Db, scope: Scope, code: string) {
  const client = await db
    .select()
    .from(clients)
    .where(and(inTenant(scope, clients), eq(clients.clientCode, code), clientInScope(scope, clients.clientCode)))
    .get();
  if (!client) throw notFound();
  return client;
}

/** The client's own agents (serving or sharing a policy, an application, their 02_Clients upload) keep the family and the care log. */
async function isOwnClient(db: Db, scope: Scope, code: string) {
  if (!scope.agentCode) return false;
  const own = await db
    .select({ code: clients.clientCode })
    .from(clients)
    .where(and(inTenant(scope, clients), eq(clients.clientCode, code), clientInScope({ ...scope, reach: "OWN" }, clients.clientCode)))
    .get();
  return !!own;
}

async function assertOwnClient(db: Db, scope: Scope, code: string) {
  await getClient(db, scope, code);
  if (!(await isOwnClient(db, scope, code))) throw new ApiError(403, "client_not_yours");
}

/** "Khách hàng của": only the clients of the chosen agents, each of them within the caller's scope. */
async function agentFilter(db: Db, scope: Scope, codes: string[] | undefined): Promise<SQL | undefined> {
  if (!codes) return undefined;
  return clientOfAgents(scope, clients.clientCode, await agentsInScope(db, scope, codes));
}

type PolicyRow = typeof policies.$inferSelect;
type ProductRow = typeof policyProducts.$inferSelect;

export const clientRoutes = new Hono<AppEnv>()
  // F8.2: client list with care signals.
  .get("/", valid("query", clientListSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const f = c.req.valid("query");
    const today = vnToday();
    const where = and(
      inTenant(scope, clients),
      clientInScope(scope, clients.clientCode),
      await agentFilter(db, scope, f.agents),
      f.q ? or(contains(normalizeName(f.q), clients.nameNorm), contains(f.q, clients.clientCode)) : undefined,
      f.tier ? eq(clients.tier, f.tier) : undefined,
      f.signal ? signalSql(scope, f.signal, today) : undefined,
    );
    const flag = (s: ClientSignal) => sql<boolean>`${signalSql(scope, s, today)}`.mapWith(Boolean);
    const inScope = (cond: string, roles: readonly ("PO" | "LI")[]) =>
      sql.raw(`spc.client_code = "clients"."client_code" and spc.ended_at is null and spc.role in (${roles.map((r) => `'${r}'`).join(", ")}) and ${cond}`);
    const fromPolicies = (what: string, cond: string, roles: readonly ("PO" | "LI")[]) =>
      sql`(select ${sql.raw(what)} from policy_clients spc join policies sp on sp.tenant_id = spc.tenant_id and sp.policy_no = spc.policy_no
        where spc.tenant_id = ${scope.tenantId} and ${inScope(cond, roles)} and ${policyInScope(scope, sql.raw("sp.policy_no"))})`;
    const [items, total] = await Promise.all([
      db
        .select({
          clientCode: clients.clientCode,
          name: clients.name,
          tier: clients.tier,
          ageBand: clients.ageBand,
          gender: clients.gender,
          birthDayMonth: clients.birthDayMonth,
          activePolicies: sql<number>`${fromPolicies("count(distinct sp.policy_no)", `sp.status = '${ACTIVE_STATUS}'`, ["PO", "LI"])}`.mapWith(Number),
          nextDue: sql<
            string | null
          >`${fromPolicies("min(sp.premium_due_date)", `sp.status = '${ACTIVE_STATUS}' and sp.premium_due_date >= '${today}'`, ["PO"])}`,
          agentNames: sql<
            string | null
          >`(select group_concat(distinct a.name) from policy_clients spc join policies sp on sp.tenant_id = spc.tenant_id and sp.policy_no = spc.policy_no
            join agents a on a.tenant_id = sp.tenant_id and a.agent_code = sp.servicing_agent_code
            where spc.tenant_id = ${scope.tenantId} and ${inScope("1", ["PO", "LI"])} and ${policyInScope(scope, sql.raw("sp.policy_no"))})`,
          due: flag("due"),
          debt: flag("debt"),
          maturity: flag("maturity"),
          birthday: flag("birthday"),
          lapsed: flag("lapsed"),
        })
        .from(clients)
        .where(where)
        .orderBy(asc(clients.nameNorm), asc(clients.clientCode))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize),
      db.select({ n: count() }).from(clients).where(where),
    ]);
    return c.json({ items, page: f.page, pageSize: f.pageSize, total: total[0]?.n ?? 0 });
  })

  // Counts for the signal tabs.
  .get("/counts", valid("query", clientCountsSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const only = await agentFilter(db, scope, c.req.valid("query").agents);
    const today = vnToday();
    const n = (cond: SQL) => sql<number>`sum(case when ${cond} then 1 else 0 end)`.mapWith(Number);
    const row = await db
      .select({
        all: count(),
        due: n(signalSql(scope, "due", today)),
        debt: n(signalSql(scope, "debt", today)),
        maturity: n(signalSql(scope, "maturity", today)),
        birthday: n(signalSql(scope, "birthday", today)),
        lapsed: n(signalSql(scope, "lapsed", today)),
      })
      .from(clients)
      .where(and(inTenant(scope, clients), clientInScope(scope, clients.clientCode), only))
      .get();
    return c.json(row ?? { all: 0, due: 0, debt: 0, maturity: 0, birthday: 0, lapsed: 0 });
  })

  // Clients in scope to pick as a family member.
  .get("/search", valid("query", clientListSchema.pick({ q: true })), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { q } = c.req.valid("query");
    if (!q || q.length < 2) return c.json({ items: [] });
    const items = await db
      .select({ clientCode: clients.clientCode, name: clients.name, ageBand: clients.ageBand, gender: clients.gender })
      .from(clients)
      .where(
        and(
          inTenant(scope, clients),
          clientInScope(scope, clients.clientCode),
          or(contains(normalizeName(q), clients.nameNorm), contains(q, clients.clientCode)),
        ),
      )
      .orderBy(asc(clients.nameNorm))
      .limit(10);
    return c.json({ items });
  })

  // F8.1: client 360: profile, policies and products, coverage per person, family, signals, care log, history.
  .get("/:code", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const code = c.req.param("code");
    const detail = await loadClient360(db, scope, code);
    await auditStmt(db, { ...auditBy(c), action: "VIEW_CLIENT", entity: "client", entityId: code });
    return c.json(detail);
  })

  // Family: label another client or add a member who is not a client yet.
  .post("/:code/family", valid("json", createFamilySchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const code = c.req.param("code");
    await assertOwnClient(db, scope, code);
    const input = c.req.valid("json");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    if ("relatedClientCode" in input) {
      if (input.relatedClientCode === code) throw new ApiError(400, "same_client");
      // Another client in scope, or a person on one of this client's policies in scope.
      const mine = alias(policyClients, "mine");
      const linked = await db
        .select({ policyNo: policyClients.policyNo })
        .from(policyClients)
        .innerJoin(
          mine,
          and(eq(mine.tenantId, policyClients.tenantId), eq(mine.policyNo, policyClients.policyNo), eq(mine.clientCode, code), isNull(mine.endedAt)),
        )
        .where(
          and(
            inTenant(scope, policyClients),
            eq(policyClients.clientCode, input.relatedClientCode),
            isNull(policyClients.endedAt),
            policyInScope(scope, policyClients.policyNo),
          ),
        )
        .get();
      if (!linked) await getClient(db, scope, input.relatedClientCode);
      // One row per pair: a label set from the other side is replaced by this one.
      await db.batch([
        db
          .delete(clientFamily)
          .where(and(inTenant(scope, clientFamily), eq(clientFamily.clientCode, input.relatedClientCode), eq(clientFamily.relatedClientCode, code))),
        db
          .insert(clientFamily)
          .values({
            id,
            tenantId: scope.tenantId,
            clientCode: code,
            relatedClientCode: input.relatedClientCode,
            relation: input.relation,
            note: input.note ?? null,
            createdBy: scope.userId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [clientFamily.tenantId, clientFamily.clientCode, clientFamily.relatedClientCode],
            set: { relation: input.relation, note: input.note ?? null, updatedAt: now },
          }),
        auditStmt(db, {
          ...auditBy(c),
          action: "UPDATE",
          entity: "client_family",
          entityId: code,
          meta: { related: input.relatedClientCode, relation: input.relation },
        }),
      ]);
      return c.json({ ok: true }, 201);
    }
    await db.batch([
      db.insert(clientFamily).values({
        id,
        tenantId: scope.tenantId,
        clientCode: code,
        fullName: input.fullName,
        birthDay: input.birthDay ?? null,
        birthMonth: input.birthMonth ?? null,
        birthYear: input.birthYear ?? null,
        gender: input.gender ?? null,
        relation: input.relation,
        note: input.note ?? null,
        createdBy: scope.userId,
        createdAt: now,
        updatedAt: now,
      }),
      auditStmt(db, { ...auditBy(c), action: "CREATE", entity: "client_family", entityId: id, meta: { client: code, relation: input.relation } }),
    ]);
    return c.json({ id }, 201);
  })

  .patch("/:code/family/:id", valid("json", updateFamilySchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const code = c.req.param("code");
    await assertOwnClient(db, scope, code);
    const row = await familyRow(db, scope, code, c.req.param("id"));
    const input = c.req.valid("json");
    // A label set from the other client's side is stored from that side.
    const relation = input.relation && row.clientCode !== code ? INVERSE_RELATION[input.relation] : input.relation;
    const member = !row.relatedClientCode;
    await db.batch([
      db
        .update(clientFamily)
        .set({
          relation,
          note: input.note,
          ...(member
            ? { fullName: input.fullName, birthDay: input.birthDay, birthMonth: input.birthMonth, birthYear: input.birthYear, gender: input.gender }
            : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(inTenant(scope, clientFamily), eq(clientFamily.id, row.id))),
      auditStmt(db, { ...auditBy(c), action: "UPDATE", entity: "client_family", entityId: row.id, meta: { client: code } }),
    ]);
    return c.json({ ok: true });
  })

  .delete("/:code/family/:id", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const code = c.req.param("code");
    await assertOwnClient(db, scope, code);
    const row = await familyRow(db, scope, code, c.req.param("id"));
    await db.batch([
      db.delete(clientFamily).where(and(inTenant(scope, clientFamily), eq(clientFamily.id, row.id))),
      auditStmt(db, {
        ...auditBy(c),
        action: "DELETE",
        entity: "client_family",
        entityId: row.id,
        meta: { client: code, related: row.relatedClientCode, name: row.fullName },
      }),
    ]);
    return c.json({ ok: true });
  })

  // A family member became the FC's own lead (created through POST /api/leads).
  .post("/:code/family/:id/lead", valid("json", linkFamilyLeadSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const code = c.req.param("code");
    await assertOwnClient(db, scope, code);
    const row = await familyRow(db, scope, code, c.req.param("id"));
    if (row.relatedClientCode) throw new ApiError(400, "already_client");
    const { leadId } = c.req.valid("json");
    const lead = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(visibleLeads(scope), eq(leads.id, leadId)))
      .get();
    if (!lead) throw notFound();
    await db.batch([
      db
        .update(clientFamily)
        .set({ leadId, updatedAt: new Date().toISOString() })
        .where(and(inTenant(scope, clientFamily), eq(clientFamily.id, row.id))),
      auditStmt(db, { ...auditBy(c), action: "LINK", entity: "client_family", entityId: row.id, meta: { client: code, leadId } }),
    ]);
    return c.json({ ok: true });
  })

  // "Ghi chú" in Tổng quan: what the FC learns about the client, kept in one place.
  .post("/:code/notes", valid("json", clientNoteSchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const scope = scopeOf(actor);
    const code = c.req.param("code");
    await assertOwnClient(db, scope, code);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(crmActivities).values({
        id,
        tenantId: scope.tenantId,
        agentCode: actor.agentCode,
        clientCode: code,
        type: "NOTE",
        note: c.req.valid("json").body,
        occurredAt: now,
        createdBy: scope.userId,
        createdAt: now,
      }),
      auditStmt(db, { ...auditBy(c), action: "CREATE", entity: "note", entityId: id, meta: { clientCode: code } }),
    ]);
    return c.json({ id }, 201);
  })

  // Care log: calls, Zalo and meetings with the client.
  .post("/:code/activities", valid("json", clientActivitySchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const scope = scopeOf(actor);
    const code = c.req.param("code");
    await assertOwnClient(db, scope, code);
    if (!actor.agentCode) throw forbidden();
    const input = c.req.valid("json");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(crmActivities).values({
        id,
        tenantId: scope.tenantId,
        agentCode: actor.agentCode,
        clientCode: code,
        type: input.type,
        outcome: input.outcome,
        note: input.note,
        occurredAt: input.occurredAt ? new Date(input.occurredAt).toISOString() : now,
        createdBy: scope.userId,
        createdAt: now,
      }),
      auditStmt(db, { ...auditBy(c), action: "CREATE", entity: "activity", entityId: id, meta: { clientCode: code, type: input.type } }),
    ]);
    return c.json({ id }, 201);
  });

async function familyRow(db: Db, scope: Scope, code: string, id: string) {
  const row = await db
    .select()
    .from(clientFamily)
    .where(and(inTenant(scope, clientFamily), eq(clientFamily.id, id), or(eq(clientFamily.clientCode, code), eq(clientFamily.relatedClientCode, code))))
    .get();
  if (!row) throw notFound();
  return row;
}

/** Client 360 as the caller may see it (also the AI assistant's client context). The caller writes the audit row. */
export async function loadClient360(db: Db, scope: Scope, code: string) {
  const client = await getClient(db, scope, code);
  const today = vnToday();

  // Family rows from both sides of each pair.
  const familyRows = await db
    .select()
    .from(clientFamily)
    .where(and(inTenant(scope, clientFamily), or(eq(clientFamily.clientCode, code), eq(clientFamily.relatedClientCode, code))));

  // Policies in scope of the client and of the people linked to them.
  const myLinks = await db
    .select({ policyNo: policyClients.policyNo })
    .from(policyClients)
    .where(
      and(
        inTenant(scope, policyClients),
        eq(policyClients.clientCode, code),
        sql`${policyClients.endedAt} is null`,
        policyInScope(scope, policyClients.policyNo),
      ),
    );
  const myPolicyNos = [...new Set(myLinks.map((l) => l.policyNo))];
  const linksOfMine = myPolicyNos.length
    ? (
        await Promise.all(
          chunks(myPolicyNos, 90).map((part) =>
            db
              .select({ policyNo: policyClients.policyNo, clientCode: policyClients.clientCode, role: policyClients.role })
              .from(policyClients)
              .where(and(inTenant(scope, policyClients), inArray(policyClients.policyNo, part), sql`${policyClients.endedAt} is null`)),
          ),
        )
      ).flat()
    : [];
  const labelled = familyRows.map((f) => (f.clientCode === code ? f.relatedClientCode : f.clientCode)).filter((v): v is string => !!v && v !== code);
  const linkedCodes = [...new Set([...linksOfMine.map((l) => l.clientCode), ...labelled].filter((v) => v !== code))];
  // Only people the caller may see: clients in scope, and people on the client's policies in scope.
  const rows = linkedCodes.length
    ? (
        await Promise.all(
          chunks(linkedCodes, 90).map((part) =>
            db
              .select()
              .from(clients)
              .where(and(inTenant(scope, clients), inArray(clients.clientCode, part), clientInScope(scope, clients.clientCode))),
          ),
        )
      ).flat()
    : [];
  // Success lists only policy holders in 02_Clients: an insured child or spouse is known from the policy only.
  const rowCodes = new Set(rows.map((r) => r.clientCode));
  const policyOnly = [...new Set(linksOfMine.map((l) => l.clientCode))].filter((v) => v !== code && !rowCodes.has(v));
  const people: { clientCode: string; row: (typeof rows)[number] | null }[] = [
    ...rows.map((row) => ({ clientCode: row.clientCode, row })),
    ...policyOnly.map((clientCode) => ({ clientCode, row: null })),
  ];
  const personCodes = [code, ...people.map((p) => p.clientCode)];
  const personLinks = (
    await Promise.all(
      chunks(personCodes, 90).map((part) =>
        db
          .select({ policyNo: policyClients.policyNo, clientCode: policyClients.clientCode, role: policyClients.role })
          .from(policyClients)
          .where(
            and(
              inTenant(scope, policyClients),
              inArray(policyClients.clientCode, part),
              sql`${policyClients.endedAt} is null`,
              policyInScope(scope, policyClients.policyNo),
            ),
          ),
      ),
    )
  ).flat();
  const policyNos = [...new Set([...myPolicyNos, ...personLinks.map((l) => l.policyNo)])];
  const byPolicies = <T>(fn: (part: string[]) => Promise<T[]>) =>
    policyNos.length ? Promise.all(chunks(policyNos, 90).map(fn)).then((r) => r.flat()) : Promise.resolve([] as T[]);
  const [policyRows, productRows, agentRows, apps, activities, history] = await Promise.all([
    byPolicies((part) =>
      db
        .select()
        .from(policies)
        .where(and(inTenant(scope, policies), inArray(policies.policyNo, part))),
    ),
    byPolicies((part) =>
      db
        .select()
        .from(policyProducts)
        .where(and(inTenant(scope, policyProducts), inArray(policyProducts.policyNo, part))),
    ),
    byPolicies((part) =>
      db
        .select({
          policyNo: policyAgents.policyNo,
          agentCode: policyAgents.agentCode,
          splitPercent: policyAgents.splitPercent,
          isServicing: policyAgents.isServicing,
          name: agents.name,
        })
        .from(policyAgents)
        .leftJoin(agents, and(eq(agents.tenantId, policyAgents.tenantId), eq(agents.agentCode, policyAgents.agentCode)))
        .where(and(inTenant(scope, policyAgents), inArray(policyAgents.policyNo, part), sql`${policyAgents.endedAt} is null`)),
    ),
    db
      .select()
      .from(applications)
      .where(and(inTenant(scope, applications), eq(applications.clientCode, code), agentInScope(scope, applications.agentCode)))
      .orderBy(desc(applications.createdDate)),
    db
      .select()
      .from(crmActivities)
      .where(and(inTenant(scope, crmActivities), eq(crmActivities.clientCode, code)))
      .orderBy(desc(crmActivities.occurredAt)),
    db
      .select()
      .from(recordChanges)
      .where(
        and(
          inTenant(scope, recordChanges),
          or(
            and(eq(recordChanges.entity, "client"), eq(recordChanges.entityKey, code)),
            myPolicyNos.length
              ? sql`(${recordChanges.entity} in ('policy', 'policy_product') and substr(${recordChanges.entityKey} || '|', 1, instr(${recordChanges.entityKey} || '|', '|') - 1) in ${myPolicyNos.slice(0, 80)})`
              : undefined,
          ),
        ),
      )
      .orderBy(desc(recordChanges.changedAt))
      .limit(200),
  ]);
  const catalog = productRows.length
    ? Object.fromEntries(
        (
          await db
            .select()
            .from(products)
            .where(inArray(products.productCode, [...new Set(productRows.map((p) => p.productCode))].slice(0, 90)))
        ).map((p) => [p.productCode, p]),
      )
    : {};

  // Coverage per person: products they are insured by on policies in force.
  const policyMap = new Map(policyRows.map((p) => [p.policyNo, p]));
  const isActive = (p: PolicyRow | undefined) => p?.status === ACTIVE_STATUS;
  const coverageOf = (person: string) => {
    const insuredOn = personLinks.filter((l) => l.clientCode === person && l.role === "LI").map((l) => l.policyNo);
    const activePolicies = [...new Set(insuredOn)].filter((no) => isActive(policyMap.get(no)));
    const mine = (pp: ProductRow) => pp.insuredCode === person || (pp.insuredCode === "" && policyMap.get(pp.policyNo)?.insuredClientCode === person);
    const items = productRows
      .filter((pp) => mine(pp) && isActive(policyMap.get(pp.policyNo)) && (!pp.status || pp.status === ACTIVE_STATUS))
      .map((pp) => {
        const cat = catalog[pp.productCode];
        return {
          policyNo: pp.policyNo,
          productCode: pp.productCode,
          productName: pp.productName ?? cat?.productName ?? pp.productCode,
          productRole: pp.productRole,
          category: cat?.category ?? null,
          group: coverageGroup({ category: cat?.category, name: pp.productName ?? cat?.productName, role: pp.productRole }),
          sumAssuredVnd: pp.sumAssuredVnd,
          annualPremiumVnd: pp.annualPremiumVnd,
        };
      });
    const groups: Partial<Record<CoverageGroup, number>> = {};
    for (const i of items) groups[i.group] = (groups[i.group] ?? 0) + (i.sumAssuredVnd ?? 0);
    // Without product details (04_Policy_Products) gaps are unknown.
    const hasDetail = items.length > 0;
    return {
      activePolicies,
      covered: activePolicies.length > 0 || items.length > 0,
      hasDetail,
      items,
      groups,
      gaps: hasDetail ? GAP_GROUPS.filter((g) => !(g in groups)) : null,
    };
  };

  // Family: people linked through policies, labelled ones, and members who are not clients yet.
  const relationOf = (other: string): { id: string; relation: FamilyRelation; note: string | null } | null => {
    const mine = familyRows.find((f) => f.clientCode === code && f.relatedClientCode === other);
    if (mine) return { id: mine.id, relation: mine.relation, note: mine.note };
    const theirs = familyRows.find((f) => f.clientCode === other && f.relatedClientCode === code);
    return theirs ? { id: theirs.id, relation: INVERSE_RELATION[theirs.relation], note: theirs.note } : null;
  };
  const sharedPolicies = (other: string) =>
    myPolicyNos
      .filter((no) => linksOfMine.some((l) => l.policyNo === no && l.clientCode === other))
      .map((no) => ({
        policyNo: no,
        myRoles: [...new Set(linksOfMine.filter((l) => l.policyNo === no && l.clientCode === code).map((l) => l.role))],
        theirRoles: [...new Set(linksOfMine.filter((l) => l.policyNo === no && l.clientCode === other).map((l) => l.role))],
      }));
  const nameOf = (person: string) => {
    const row = people.find((p) => p.clientCode === person)?.row;
    if (row) return row.name;
    const p = policyRows.find((x) => x.insuredClientCode === person) ?? policyRows.find((x) => x.holderClientCode === person);
    if (p) return titleCase(p.insuredClientCode === person ? p.insuredName : p.holderName);
    return person;
  };
  const family = [
    ...people.map((p) => ({
      kind: "CLIENT" as const,
      clientCode: p.clientCode,
      isClient: !!p.row,
      name: nameOf(p.clientCode),
      ageBand: p.row?.ageBand ?? null,
      dob: p.row?.dob ?? null,
      gender: p.row?.gender ?? null,
      tier: p.row?.tier ?? null,
      label: relationOf(p.clientCode),
      sharedPolicies: sharedPolicies(p.clientCode),
      coverage: coverageOf(p.clientCode),
    })),
    ...familyRows
      .filter((f) => f.clientCode === code && !f.relatedClientCode)
      .map((f) => ({
        kind: "MEMBER" as const,
        id: f.id,
        name: f.fullName ?? "",
        birthDay: f.birthDay,
        birthMonth: f.birthMonth,
        birthYear: f.birthYear,
        gender: f.gender,
        relation: f.relation,
        note: f.note,
        leadId: f.leadId,
      })),
  ];

  // Care signals: facts from the data only (no product advice until the fit rules are approved).
  const own = myPolicyNos.map((no) => policyMap.get(no)!).filter(Boolean);
  const holderOf = (p: PolicyRow) => linksOfMine.some((l) => l.policyNo === p.policyNo && l.clientCode === code && l.role === "PO");
  const signals: { kind: string; policyNo?: string; date?: string | null; amount?: number | null; name?: string; groups?: string[] }[] = [];
  for (const p of own) {
    if (holderOf(p) && isActive(p) && p.premiumDueDate && p.premiumDueDate >= today && p.premiumDueDate <= addDays(today, PREMIUM_DUE_DAYS))
      signals.push({ kind: "PREMIUM_DUE", policyNo: p.policyNo, date: p.premiumDueDate, amount: p.plannedPremiumVnd });
    if (holderOf(p) && (p.unpaidPremiumVnd ?? 0) > 0) signals.push({ kind: "UNPAID", policyNo: p.policyNo, amount: p.unpaidPremiumVnd });
    if (holderOf(p) && (p.aplDebtVnd ?? 0) > 0) signals.push({ kind: "APL", policyNo: p.policyNo, amount: p.aplDebtVnd });
    if (isActive(p) && p.maturityDate >= today && p.maturityDate <= addDays(today, MATURITY_DAYS))
      signals.push({ kind: "MATURITY", policyNo: p.policyNo, date: p.maturityDate });
    if (!isActive(p)) signals.push({ kind: "NOT_ACTIVE", policyNo: p.policyNo, name: p.status });
  }
  if ((client.lapsedPolicies ?? 0) > 0 && !signals.some((s) => s.kind === "NOT_ACTIVE")) signals.push({ kind: "LAPSED", amount: client.lapsedPolicies });
  if (client.birthDayMonth && client.birthDayMonth.slice(3, 5) === today.slice(5, 7)) signals.push({ kind: "BIRTHDAY", date: client.birthDayMonth });
  const myCoverage = coverageOf(code);
  if (myCoverage.gaps?.length) signals.push({ kind: "GAP", name: client.name, groups: myCoverage.gaps });
  for (const m of family) {
    if (m.kind === "MEMBER") signals.push({ kind: "FAMILY_UNCOVERED", name: m.name });
    else if (!m.coverage.covered) signals.push({ kind: "FAMILY_UNCOVERED", name: m.name });
    else if (m.coverage.gaps?.length) signals.push({ kind: "GAP", name: m.name, groups: m.coverage.gaps });
  }
  if (client.usesDconnect === false) signals.push({ kind: "NO_DCONNECT" });

  const userIds = [...new Set([...activities.map((a) => a.createdBy), ...history.map((h) => h.changedBy)])];
  const userNames = userIds.length
    ? Object.fromEntries(
        (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, userIds.slice(0, 90)))
        ).map((u) => [u.id, u.name]),
      )
    : {};
  const canEdit = await isOwnClient(db, scope, code);
  return {
    client,
    policies: own
      .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.effectiveDate.localeCompare(a.effectiveDate) || a.policyNo.localeCompare(b.policyNo))
      .map((p) => ({
        ...p,
        roles: [...new Set(linksOfMine.filter((l) => l.policyNo === p.policyNo && l.clientCode === code).map((l) => l.role))],
        agents: agentRows.filter((a) => a.policyNo === p.policyNo),
        products: productRows
          .filter((pp) => pp.policyNo === p.policyNo)
          .map((pp) => ({
            ...pp,
            category: catalog[pp.productCode]?.category ?? null,
            group: coverageGroup({
              category: catalog[pp.productCode]?.category,
              name: pp.productName ?? catalog[pp.productCode]?.productName,
              role: pp.productRole,
            }),
          })),
      })),
    coverage: myCoverage,
    family,
    applications: apps,
    // Notes oldest first (the client's story in order); contacts newest first.
    notes: activities.filter((a) => a.type === "NOTE").sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt)),
    activities: activities.filter((a) => a.type !== "NOTE"),
    history,
    signals,
    userNames,
    clientNames: Object.fromEntries([[code, client.name], ...people.map((p) => [p.clientCode, nameOf(p.clientCode)])]),
    canEdit,
  };
}
