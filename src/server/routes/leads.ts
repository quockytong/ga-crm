import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { agents, auditLog, campaigns, crmActivities, leadComments, leadHistory, leads, leadTasks, users } from "../../db/schema";
import { FINAL_INTERESTS, stageFor, type LeadCareStatus, type LeadInterest } from "../../shared/enums";
import { maskPhone, normalizeName, normalizePhone } from "../../shared/normalize";
import {
  assignLeadsSchema,
  createLeadSchema,
  leadActivitySchema,
  leadCommentSchema,
  createTaskSchema,
  leadListSchema,
  leadNoteSchema,
  leadReportSchema,
  updateLeadSchema,
  updateTaskSchema,
} from "../../shared/schemas";
import { auditBy, auditStmt } from "../audit";
import type { AppEnv } from "../env";
import { ApiError, forbidden, notFound } from "../errors";
import { batchOf, chunks, contains, valid } from "../http";
import { assignmentTasks, contactDoneTask, nextActionTasks } from "../lead-tasks";
import { requirePermission } from "../middleware";
import { can, inTenant, scopeOf, visibleAgents, visibleLeads, type Scope } from "../scope";

const HOURS_48 = 48 * 3600 * 1000;

/**
 * Contacted: a contact was logged in the CRM, or the lead already has a status (e.g. from
 * the GA's sheet, where the contact time is unknown).
 */
const contactedSql = sql`(${leads.firstContactAt} is not null or ${leads.interest} is not null or ${leads.careStatus} is not null)`;

/** Assigned more than 48 h ago and never contacted ("⚠️ QUÁ 48 GIỜ"). */
const overdueSql = (now: string) =>
  sql<boolean>`(${leads.assignedAgentCode} is not null and not ${contactedSql}
    and ${leads.assignedAt} < ${new Date(Date.parse(now) - HOURS_48).toISOString()})`.mapWith(Boolean);

const manager = alias(agents, "manager");
/**
 * Who sees a lead's phone in full: lead managers and the agent it is assigned to. Managers
 * of the line see everything else, with the phone masked (0912***678), to coach the FC.
 */
const seesPhone = (scope: Scope, assignee: string | null) => can(scope, "leads.manage") || (!!scope.agentCode && assignee === scope.agentCode);
const phoneSql = (scope: Scope) =>
  can(scope, "leads.manage")
    ? sql<string>`${leads.phone}`
    : sql<string>`case when ${leads.assignedAgentCode} = ${scope.agentCode ?? ""} then ${leads.phone}
        else substr(${leads.phone}, 1, 4) || '***' || substr(${leads.phone}, -3) end`;

/** The assignee has a comment from someone else that they have not read yet. */
const newCommentSql = (scope: Scope) =>
  sql<boolean>`(${leads.assignedAgentCode} = ${scope.agentCode ?? ""} and ${leads.lastCommentAt} is not null
    and ${leads.lastCommentBy} <> ${scope.userId} and ${leads.lastCommentAt} > coalesce(${leads.assigneeViewedAt}, ''))`.mapWith(Boolean);

/** Only the assignee (and lead managers) work the lead; managers of the line comment. */
function assertWorks(scope: Scope, lead: { assignedAgentCode: string | null }) {
  if (!seesPhone(scope, lead.assignedAgentCode)) throw new ApiError(403, "lead_not_yours");
}

const listColumns = (now: string, scope: Scope) => ({
  id: leads.id,
  fullName: leads.fullName,
  phone: phoneSql(scope),
  source: leads.source,
  phoneSource: leads.phoneSource,
  region: leads.region,
  leadDate: leads.leadDate,
  stage: leads.stage,
  interest: leads.interest,
  careStatus: leads.careStatus,
  assignedAgentCode: leads.assignedAgentCode,
  agentName: agents.name,
  campaignId: leads.campaignId,
  campaignName: campaigns.name,
  assignedAt: leads.assignedAt,
  firstContactAt: leads.firstContactAt,
  lastContactAt: leads.lastContactAt,
  nextActionAt: leads.nextActionAt,
  consentMarketing: leads.consentMarketing,
  isNew: sql<boolean>`(${leads.assignedAgentCode} is not null and ${leads.assigneeSeenAt} is null)`.mapWith(Boolean),
  origin: leads.origin,
  newComment: newCommentSql(scope),
  overdue: overdueSql(now),
});

async function getLead(db: Db, scope: Scope, id: string) {
  const lead = await db
    .select()
    .from(leads)
    .where(and(visibleLeads(scope), eq(leads.id, id)))
    .get();
  if (!lead) throw notFound();
  return lead;
}

async function agentExists(db: Db, scope: Scope, code: string) {
  const a = await db
    .select({ code: agents.agentCode })
    .from(agents)
    .where(and(inTenant(scope, agents), eq(agents.agentCode, code)))
    .get();
  if (!a) throw new ApiError(400, "agent_not_found");
}

const historyRow = (scope: Scope, leadId: string, field: string, oldValue: string | null, newValue: string | null, now: string, note?: string | null) => ({
  id: crypto.randomUUID(),
  tenantId: scope.tenantId,
  leadId,
  field,
  oldValue,
  newValue,
  note: note ?? null,
  changedBy: scope.userId,
  changedAt: now,
});

function listWhere(scope: Scope, f: ReturnType<typeof leadListSchema.parse>, now: string): SQL {
  return and(
    visibleLeads(scope),
    // Searching by phone could reveal masked numbers: lead managers only.
    f.q ? (can(scope, "leads.manage") ? contains(f.q, leads.fullName, leads.phone) : contains(f.q, leads.fullName)) : undefined,
    f.interest ? (f.interest === "NONE" ? isNull(leads.interest) : eq(leads.interest, f.interest)) : undefined,
    f.care ? (f.care === "NONE" ? isNull(leads.careStatus) : eq(leads.careStatus, f.care)) : undefined,
    f.source ? eq(leads.source, f.source) : undefined,
    f.campaignId ? eq(leads.campaignId, f.campaignId) : undefined,
    f.assignee ? (f.assignee === "NONE" ? isNull(leads.assignedAgentCode) : eq(leads.assignedAgentCode, f.assignee)) : undefined,
    f.from ? gte(leads.leadDate, f.from) : undefined,
    f.to ? lte(leads.leadDate, f.to) : undefined,
    f.overdue ? overdueSql(now) : undefined,
    f.isNew ? sql`${leads.assignedAgentCode} is not null and ${leads.assigneeSeenAt} is null` : undefined,
    f.newComment ? newCommentSql(scope) : undefined,
  )!;
}

export const leadRoutes = new Hono<AppEnv>()
  // F3.4: list with filters. Lead managers see every lead, agents the leads of their scope.
  .get("/", valid("query", leadListSchema), async (c) => {
    const db = c.get("db");
    const f = c.req.valid("query");
    const now = new Date().toISOString();
    const scope = scopeOf(c.get("actor"));
    const where = listWhere(scope, f, now);
    // Not db.batch(): joined tables share column names.
    const [items, total] = await Promise.all([
      db
        .select(listColumns(now, scope))
        .from(leads)
        .leftJoin(agents, and(eq(agents.tenantId, leads.tenantId), eq(agents.agentCode, leads.assignedAgentCode)))
        .leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
        .where(where)
        .orderBy(desc(leads.leadDate), desc(leads.createdAt), asc(leads.id))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize),
      db.select({ n: count() }).from(leads).where(where),
    ]);
    return c.json({
      items,
      page: f.page,
      pageSize: f.pageSize,
      total: total[0]?.n ?? 0,
    });
  })

  // Values for the filters, from the leads the caller can see.
  .get("/facets", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const where = visibleLeads(scope);
    const [sources, campaignRows, assignees] = await Promise.all([
      db.selectDistinct({ source: leads.source }).from(leads).where(where).orderBy(asc(leads.source)),
      db
        .selectDistinct({ id: campaigns.id, name: campaigns.name })
        .from(leads)
        .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
        .where(where)
        .orderBy(asc(campaigns.name)),
      db
        .selectDistinct({ agentCode: agents.agentCode, name: agents.name })
        .from(leads)
        .innerJoin(agents, and(eq(agents.tenantId, leads.tenantId), eq(agents.agentCode, leads.assignedAgentCode)))
        .where(where)
        .orderBy(asc(agents.name)),
    ]);
    return c.json({
      sources: sources.map((s) => s.source),
      campaigns: campaignRows,
      assignees,
    });
  })

  // F4.2: assignee picker: agent name, team (manager) and open leads.
  .get("/assignees", requirePermission("leads.manage"), async (c) => {
    const scope = scopeOf(c.get("actor"));
    const open = sql<number>`(select count(*) from ${leads} where ${leads.tenantId} = ${scope.tenantId}
      and ${leads.assignedAgentCode} = ${agents.agentCode}
      and coalesce(${leads.careStatus}, '') not in ('WON', 'DROPPED', 'NOT_INTERESTED'))`;
    const items = await c
      .get("db")
      .select({
        agentCode: agents.agentCode,
        name: agents.name,
        rank: agents.rank,
        managerName: manager.name,
        openLeads: open,
      })
      .from(agents)
      .leftJoin(manager, and(eq(manager.tenantId, agents.tenantId), eq(manager.agentCode, agents.managerCode)))
      .where(visibleAgents(scope))
      .orderBy(asc(agents.name));
    return c.json({ items });
  })

  // Results per agent over a period of lead dates ("Báo cáo chuyển đổi").
  .get("/report", valid("query", leadReportSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { from, to } = c.req.valid("query");
    const now = new Date().toISOString();
    const where = and(visibleLeads(scope), from ? gte(leads.leadDate, from) : undefined, to ? lte(leads.leadDate, to) : undefined);
    const n = (cond: SQL) => sql<number>`sum(case when ${cond} then 1 else 0 end)`.mapWith(Number);
    const rows = await db
      .select({
        agentCode: leads.assignedAgentCode,
        agentName: agents.name,
        managerName: manager.name,
        total: count(),
        contacted: n(contactedSql),
        // Only contacts logged in the CRM have a time.
        timedContacts: n(sql`${leads.firstContactAt} is not null and ${leads.assignedAt} is not null`),
        contactedIn24h: n(sql`${leads.firstContactAt} is not null and ${leads.assignedAt} is not null
          and julianday(${leads.firstContactAt}) - julianday(${leads.assignedAt}) <= 1`),
        overdue: n(overdueSql(now)),
        notReached: n(sql`${leads.interest} = 'NOT_REACHED'`),
        undetermined: n(sql`${leads.interest} = 'UNDETERMINED'`),
        notInterested: n(sql`${leads.interest} = 'NOT_INTERESTED'`),
        life: n(sql`${leads.interest} = 'LIFE'`),
        healthCard: n(sql`${leads.interest} = 'HEALTH_CARD'`),
        caring: n(sql`${leads.careStatus} = 'CARING'`),
        won: n(sql`${leads.careStatus} = 'WON'`),
        dropped: n(sql`${leads.careStatus} = 'DROPPED'`),
      })
      .from(leads)
      .leftJoin(agents, and(eq(agents.tenantId, leads.tenantId), eq(agents.agentCode, leads.assignedAgentCode)))
      .leftJoin(manager, and(eq(manager.tenantId, agents.tenantId), eq(manager.agentCode, agents.managerCode)))
      .where(where)
      .groupBy(leads.assignedAgentCode, agents.name, manager.name)
      .orderBy(asc(agents.name));
    return c.json({ items: rows });
  })

  // Counts for the view tabs, so each user sees their pool and what to act on.
  .get("/counts", async (c) => {
    const scope = scopeOf(c.get("actor"));
    const now = new Date().toISOString();
    const n = (cond: SQL) => sql<number>`coalesce(sum(case when ${cond} then 1 else 0 end), 0)`.mapWith(Number);
    const row = await c
      .get("db")
      .select({
        all: count(),
        mine: n(sql`${leads.assignedAgentCode} = ${scope.agentCode ?? ""}`),
        unassigned: n(sql`${leads.assignedAgentCode} is null`),
        overdue: n(overdueSql(now)),
        isNew: n(sql`${leads.assignedAgentCode} is not null and ${leads.assigneeSeenAt} is null`),
        newComment: n(newCommentSql(scope)),
      })
      .from(leads)
      .where(visibleLeads(scope))
      .get();
    return c.json(row);
  })

  // F3.1: create a lead by hand. An FC creates their own prospects (origin FC_OWN), assigned to themselves.
  .post("/", valid("json", createLeadSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const input = c.req.valid("json");
    const manages = can(scope, "leads.manage");
    if (!manages && !scope.agentCode) throw forbidden();
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError(400, "invalid_phone");
    const existing = await db
      .select({ id: leads.id, assignee: leads.assignedAgentCode })
      .from(leads)
      .where(and(inTenant(scope, leads), eq(leads.phone, phone)))
      .get();
    // F3.2: duplicates by phone are reported, with the lead when the user may open it.
    if (existing) {
      const visible = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(visibleLeads(scope), eq(leads.id, existing.id)))
        .get();
      return c.json({ error: "phone_exists", ...(visible ? { leadId: existing.id } : {}) }, 409);
    }
    const assignee = manages ? (input.assignedAgentCode ?? null) : scope.agentCode;
    if (manages && assignee) await agentExists(db, scope, assignee);
    if (manages && input.campaignId) {
      const camp = await db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(inTenant(scope, campaigns), eq(campaigns.id, input.campaignId)))
        .get();
      if (!camp) throw new ApiError(400, "campaign_not_found");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.batch([
      db.insert(leads).values({
        id,
        tenantId: scope.tenantId,
        fullName: input.fullName,
        nameNorm: normalizeName(input.fullName),
        phone,
        email: input.email,
        region: input.region,
        province: input.province,
        gender: input.gender,
        dob: input.dob ?? null,
        source: input.source,
        campaignId: manages ? input.campaignId : null,
        leadDate: now.slice(0, 10),
        progressNote: input.note,
        origin: manages ? "GA" : "FC_OWN",
        consentMarketing: input.consent,
        consentAt: input.consent ? now : null,
        consentSource: input.consent ? "CRM_FORM" : null,
        assignedAgentCode: assignee,
        assignedBy: assignee ? scope.userId : null,
        assignedAt: assignee ? now : null,
        // An FC's own lead is not "new" to them.
        assigneeSeenAt: manages ? null : now,
        createdBy: scope.userId,
        createdAt: now,
        updatedAt: now,
      }),
      // The note written at creation is the lead's first note.
      ...(input.note
        ? [
            db.insert(crmActivities).values({
              id: crypto.randomUUID(),
              tenantId: scope.tenantId,
              agentCode: assignee,
              leadId: id,
              type: "NOTE" as const,
              note: input.note,
              occurredAt: now,
              createdBy: scope.userId,
              createdAt: now,
            }),
          ]
        : []),
      ...(assignee
        ? [
            db.insert(leadHistory).values(historyRow(scope, id, "assignee", null, assignee, now)),
            ...(manages ? assignmentTasks(db, scope, [id], assignee, now) : []),
          ]
        : []),
      auditStmt(db, {
        ...auditBy(c),
        action: "CREATE",
        entity: "lead",
        entityId: id,
        meta: {
          source: input.source,
          assignee,
          origin: manages ? "GA" : "FC_OWN",
        },
      }),
    ]);
    return c.json({ id }, 201);
  })

  // F4.1: assign one or many leads (up to 200) to an agent, or unassign.
  .post("/assign", requirePermission("leads.manage"), valid("json", assignLeadsSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { leadIds, agentCode } = c.req.valid("json");
    if (agentCode) await agentExists(db, scope, agentCode);
    const owner = alias(agents, "owner_agent");
    const unique = [...new Set(leadIds)];
    const targets = (
      await Promise.all(
        chunks(unique, 90).map((part) =>
          db
            .select({
              id: leads.id,
              assignee: leads.assignedAgentCode,
              origin: leads.origin,
              creatorCode: users.agentCode,
              creatorStatus: users.status,
              creatorAgentStatus: owner.status,
              creatorEndDate: owner.endDate,
            })
            .from(leads)
            .leftJoin(users, eq(users.id, leads.createdBy))
            .leftJoin(owner, and(eq(owner.tenantId, leads.tenantId), eq(owner.agentCode, users.agentCode)))
            .where(and(inTenant(scope, leads), inArray(leads.id, part))),
        ),
      )
    ).flat();
    if (targets.length !== unique.length) throw notFound();
    // An FC's own lead stays theirs while they still work for the GA.
    const locked = targets.some(
      (t) =>
        t.origin === "FC_OWN" && t.creatorStatus === "ACTIVE" && !t.creatorEndDate && t.creatorAgentStatus !== "Ngưng hoạt động" && t.creatorCode !== agentCode,
    );
    if (locked) throw new ApiError(409, "own_lead_locked");
    const changed = targets.filter((t) => t.assignee !== agentCode);
    if (changed.length === 0) return c.json({ assigned: 0 });

    const now = new Date().toISOString();
    // Groups of 8 leads keep every multi-row insert under D1's 100 bound parameters; one batch = one transaction.
    await db.batch(
      batchOf(
        chunks(changed, 8).flatMap((group) => {
          const ids = group.map((t) => t.id);
          return [
            db
              .update(leads)
              .set({
                assignedAgentCode: agentCode,
                assignedBy: scope.userId,
                assignedAt: now,
                assigneeSeenAt: null,
                updatedAt: now,
              })
              .where(and(inTenant(scope, leads), inArray(leads.id, ids))),
            db.insert(leadHistory).values(group.map((t) => historyRow(scope, t.id, "assignee", t.assignee, agentCode, now))),
            ...assignmentTasks(db, scope, ids, agentCode, now),
            db.insert(auditLog).values(
              group.map((t) => ({
                id: crypto.randomUUID(),
                ...auditBy(c),
                action: "ASSIGN" as const,
                entity: "lead",
                entityId: t.id,
                meta: JSON.stringify({ from: t.assignee, to: agentCode }),
                at: now,
              })),
            ),
          ];
        }),
      ),
    );
    return c.json({ assigned: changed.length });
  })

  // F3.5: lead detail: info, notes, tasks, comments and history.
  .get("/:id", async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const scope = scopeOf(actor);
    const lead = await getLead(db, scope, c.req.param("id"));
    const [assignee, campaign, history, activities, comments, tasks] = await Promise.all([
      lead.assignedAgentCode
        ? db
            .select({ agentCode: agents.agentCode, name: agents.name })
            .from(agents)
            .where(and(inTenant(scope, agents), eq(agents.agentCode, lead.assignedAgentCode)))
            .get()
        : null,
      lead.campaignId
        ? db
            .select({ id: campaigns.id, name: campaigns.name })
            .from(campaigns)
            .where(and(inTenant(scope, campaigns), eq(campaigns.id, lead.campaignId)))
            .get()
        : null,
      db
        .select()
        .from(leadHistory)
        .where(and(inTenant(scope, leadHistory), eq(leadHistory.leadId, lead.id)))
        .orderBy(desc(leadHistory.changedAt)),
      db
        .select()
        .from(crmActivities)
        .where(and(inTenant(scope, crmActivities), eq(crmActivities.leadId, lead.id)))
        .orderBy(desc(crmActivities.occurredAt)),
      db
        .select()
        .from(leadComments)
        .where(and(inTenant(scope, leadComments), eq(leadComments.leadId, lead.id)))
        .orderBy(asc(leadComments.createdAt)),
      db
        .select()
        .from(leadTasks)
        .where(and(inTenant(scope, leadTasks), eq(leadTasks.leadId, lead.id)))
        .orderBy(asc(leadTasks.dueAt)),
    ]);
    // Who made each change, wrote each note and comment.
    const userIds = [
      ...new Set([
        ...history.map((h) => h.changedBy),
        ...activities.map((a) => a.createdBy),
        ...comments.map((m) => m.authorUserId),
        ...tasks.map((t) => t.createdBy),
      ]),
    ];
    const userNames = userIds.length
      ? Object.fromEntries((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.name]))
      : {};
    const codes = [
      ...new Set(
        history
          .filter((h) => h.field === "assignee")
          .flatMap((h) => [h.oldValue, h.newValue])
          .filter((v): v is string => !!v),
      ),
    ];
    const agentNames = codes.length
      ? Object.fromEntries(
          (
            await db
              .select({ code: agents.agentCode, name: agents.name })
              .from(agents)
              .where(and(inTenant(scope, agents), inArray(agents.agentCode, codes)))
          ).map((a) => [a.code, a.name]),
        )
      : {};
    // F4.3: the lead is no longer "new" once its assignee has opened it; comments count as read.
    if (lead.assignedAgentCode && lead.assignedAgentCode === actor.agentCode) {
      const now = new Date().toISOString();
      await db
        .update(leads)
        .set({
          assigneeSeenAt: lead.assigneeSeenAt ?? now,
          assigneeViewedAt: now,
        })
        .where(eq(leads.id, lead.id));
    }
    const works = seesPhone(scope, lead.assignedAgentCode);
    // Notes and comments oldest first, like the client page.
    const notes = activities
      .filter((a) => a.type === "NOTE")
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt));
    return c.json({
      lead: works ? lead : { ...lead, phone: maskPhone(lead.phone) ?? "" },
      assignee: assignee ?? null,
      campaign: campaign ?? null,
      notes,
      contacts: activities.filter((a) => a.type !== "NOTE"),
      tasks,
      comments,
      history: works
        ? history
        : history.map((h) =>
            h.field === "phone"
              ? {
                  ...h,
                  oldValue: maskPhone(h.oldValue),
                  newValue: maskPhone(h.newValue),
                }
              : h,
          ),
      userNames,
      agentNames,
      canWork: works,
      canManage: can(scope, "leads.manage"),
      interestLocked: !!lead.interest && FINAL_INTERESTS.includes(lead.interest) && !can(scope, "leads.manage"),
    });
  })

  // The assigned FC updates "Thông tin" and the status; lead managers may also change source and campaign.
  .patch("/:id", valid("json", updateLeadSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const input = c.req.valid("json");
    const lead = await getLead(db, scope, c.req.param("id"));
    assertWorks(scope, lead);
    const manages = can(scope, "leads.manage");
    if (!manages && (input.source !== undefined || input.campaignId !== undefined)) throw forbidden();

    const pick = <K extends keyof typeof input, V>(k: K, current: V): V => (input[k] === undefined ? current : (input[k] as V));
    const interest: LeadInterest | null = pick("interest", lead.interest);
    const care: LeadCareStatus | null = pick("careStatus", lead.careStatus);
    // "Nhu cầu" is final once classified (definition in the GA's lead sheet).
    if (interest !== lead.interest && lead.interest && FINAL_INTERESTS.includes(lead.interest) && !manages) {
      throw new ApiError(409, "interest_locked");
    }
    const lostReason = pick("lostReason", lead.lostReason);
    if (care === "DROPPED" && care !== lead.careStatus && !lostReason) throw new ApiError(400, "lost_reason_required");
    const applicationNo = pick("applicationNo", lead.applicationNo);
    const policyNo = pick("policyNo", lead.policyNo);
    // "Đã chốt" = application submitted: the FC gives the application or the policy number.
    if (care === "WON" && (care !== lead.careStatus || input.applicationNo !== undefined || input.policyNo !== undefined) && !applicationNo && !policyNo) {
      throw new ApiError(400, "won_needs_numbers");
    }
    let phone = lead.phone;
    if (input.phone !== undefined) {
      const normalized = normalizePhone(input.phone);
      if (!normalized) throw new ApiError(400, "invalid_phone");
      if (normalized !== lead.phone) {
        const taken = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(inTenant(scope, leads), eq(leads.phone, normalized)))
          .get();
        if (taken) throw new ApiError(409, "phone_exists");
      }
      phone = normalized;
    }
    if (input.campaignId) {
      const camp = await db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(inTenant(scope, campaigns), eq(campaigns.id, input.campaignId)))
        .get();
      if (!camp) throw new ApiError(400, "campaign_not_found");
    }

    const now = new Date().toISOString();
    const fullName = input.fullName ?? lead.fullName;
    const consent = input.consent ?? lead.consentMarketing;
    const nextActionAt = input.nextActionAt === undefined ? lead.nextActionAt : input.nextActionAt && new Date(input.nextActionAt).toISOString();
    const stage = stageFor(care, interest, lead.stage);
    const next = {
      full_name: fullName,
      phone,
      dob: pick("dob", lead.dob),
      region: pick("region", lead.region),
      province: pick("province", lead.province),
      email: pick("email", lead.email),
      consent_marketing: consent ? "1" : "0",
      interest,
      care_status: care,
      stage,
      application_no: applicationNo,
      policy_no: policyNo,
      source: input.source ?? lead.source,
    };
    const before = {
      full_name: lead.fullName,
      phone: lead.phone,
      dob: lead.dob,
      region: lead.region,
      province: lead.province,
      email: lead.email,
      consent_marketing: lead.consentMarketing ? "1" : "0",
      interest: lead.interest,
      care_status: lead.careStatus,
      stage: lead.stage,
      application_no: lead.applicationNo,
      policy_no: lead.policyNo,
      source: lead.source,
    };
    const changes = (Object.keys(next) as (keyof typeof next)[])
      .filter((k) => (before[k] ?? null) !== (next[k] ?? null))
      .map((k) => [k, before[k] ?? null, next[k] ?? null] as const);

    await db.batch(
      batchOf([
        db
          .update(leads)
          .set({
            fullName,
            nameNorm: normalizeName(fullName),
            phone,
            dob: next.dob,
            region: next.region,
            province: next.province,
            email: next.email,
            consentMarketing: consent,
            consentAt: consent ? (lead.consentAt ?? now) : null,
            consentSource: consent ? (lead.consentSource ?? "CRM_FORM") : null,
            interest,
            careStatus: care,
            stage,
            lostReason,
            nextActionAt,
            applicationNo,
            policyNo,
            firstContactAt: lead.firstContactAt ?? (interest || care ? now : null),
            ...(manages
              ? {
                  source: next.source,
                  campaignId: input.campaignId === undefined ? lead.campaignId : input.campaignId,
                }
              : {}),
            updatedAt: now,
          })
          .where(and(inTenant(scope, leads), eq(leads.id, lead.id))),
        ...(changes.length
          ? [db.insert(leadHistory).values(changes.map(([f, a, b]) => historyRow(scope, lead.id, f, a, b, now, f === "care_status" ? lostReason : null)))]
          : []),
        ...(nextActionAt !== lead.nextActionAt ? nextActionTasks(db, scope, lead.id, lead.assignedAgentCode, nextActionAt ?? null, now) : []),
        auditStmt(db, {
          ...auditBy(c),
          action: "UPDATE",
          entity: "lead",
          entityId: lead.id,
          meta: { fields: changes.map(([f]) => f) },
        }),
      ]),
    );
    return c.json({ id: lead.id, stage, interest, careStatus: care });
  })

  // F6.1: log a contact (call, Zalo, meeting) against the lead.
  .post("/:id/activities", valid("json", leadActivitySchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const scope = scopeOf(actor);
    const input = c.req.valid("json");
    const lead = await getLead(db, scope, c.req.param("id"));
    assertWorks(scope, lead);
    const now = new Date().toISOString();
    const at = input.occurredAt ? new Date(input.occurredAt).toISOString() : now;
    const stage = lead.stage === "NEW" ? "CONTACTED" : lead.stage;
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(crmActivities).values({
        id,
        tenantId: scope.tenantId,
        agentCode: actor.agentCode ?? lead.assignedAgentCode,
        leadId: lead.id,
        type: input.type,
        outcome: input.outcome,
        note: input.note,
        occurredAt: at,
        createdBy: scope.userId,
        createdAt: now,
      }),
      db
        .update(leads)
        .set({
          firstContactAt: lead.firstContactAt && lead.firstContactAt < at ? lead.firstContactAt : at,
          lastContactAt: lead.lastContactAt && lead.lastContactAt > at ? lead.lastContactAt : at,
          stage,
          updatedAt: now,
        })
        .where(and(inTenant(scope, leads), eq(leads.id, lead.id))),
      contactDoneTask(db, scope, lead.id, now),
      ...(stage !== lead.stage ? [db.insert(leadHistory).values(historyRow(scope, lead.id, "stage", lead.stage, stage, now))] : []),
      auditStmt(db, {
        ...auditBy(c),
        action: "CREATE",
        entity: "activity",
        entityId: id,
        meta: { leadId: lead.id, type: input.type },
      }),
    ]);
    return c.json({ id }, 201);
  })

  // Notes: findings over time, part of "Thông tin". Several per lead.
  .post("/:id/notes", valid("json", leadNoteSchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const scope = scopeOf(actor);
    const lead = await getLead(db, scope, c.req.param("id"));
    assertWorks(scope, lead);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(crmActivities).values({
        id,
        tenantId: scope.tenantId,
        agentCode: actor.agentCode ?? lead.assignedAgentCode,
        leadId: lead.id,
        type: "NOTE",
        note: c.req.valid("json").body,
        occurredAt: now,
        createdBy: scope.userId,
        createdAt: now,
      }),
      db
        .update(leads)
        .set({ updatedAt: now })
        .where(and(inTenant(scope, leads), eq(leads.id, lead.id))),
      auditStmt(db, {
        ...auditBy(c),
        action: "CREATE",
        entity: "lead_note",
        entityId: id,
        meta: { leadId: lead.id },
      }),
    ]);
    return c.json({ id }, 201);
  })

  // Tasks ("Việc cần làm"), each with a due date and time.
  .post("/:id/tasks", valid("json", createTaskSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const lead = await getLead(db, scope, c.req.param("id"));
    assertWorks(scope, lead);
    const input = c.req.valid("json");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(leadTasks).values({
      id,
      tenantId: scope.tenantId,
      leadId: lead.id,
      agentCode: lead.assignedAgentCode,
      title: input.title,
      dueAt: new Date(input.dueAt).toISOString(),
      createdBy: scope.userId,
      createdAt: now,
    });
    return c.json({ id }, 201);
  })

  .patch("/:id/tasks/:taskId", valid("json", updateTaskSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const lead = await getLead(db, scope, c.req.param("id"));
    assertWorks(scope, lead);
    const input = c.req.valid("json");
    const where = and(inTenant(scope, leadTasks), eq(leadTasks.leadId, lead.id), eq(leadTasks.id, c.req.param("taskId")));
    const task = await db.select().from(leadTasks).where(where).get();
    if (!task) throw notFound();
    const now = new Date().toISOString();
    await db
      .update(leadTasks)
      .set({
        title: input.title ?? task.title,
        dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : task.dueAt,
        ...(input.done === undefined
          ? {}
          : input.done
            ? { status: "DONE", doneAt: now, doneBy: scope.userId }
            : { status: "OPEN", doneAt: null, doneBy: null }),
      })
      .where(where);
    return c.json({ id: task.id });
  })

  // Comments, e.g. a manager of the line coaching the FC. Anyone who sees the lead can comment.
  .post("/:id/comments", valid("json", leadCommentSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const lead = await getLead(db, scope, c.req.param("id"));
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.batch([
      db.insert(leadComments).values({
        id,
        tenantId: scope.tenantId,
        leadId: lead.id,
        authorUserId: scope.userId,
        body: c.req.valid("json").body,
        createdAt: now,
      }),
      // Not updated_at: a comment is not a change of the lead's data (see the lead import rule).
      db
        .update(leads)
        .set({ lastCommentAt: now, lastCommentBy: scope.userId })
        .where(and(inTenant(scope, leads), eq(leads.id, lead.id))),
      auditStmt(db, {
        ...auditBy(c),
        action: "CREATE",
        entity: "lead_comment",
        entityId: id,
        meta: { leadId: lead.id },
      }),
    ]);
    return c.json({ id }, 201);
  });
