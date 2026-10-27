import { and, asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { agents, recordChanges } from "../../db/schema";
import { pageQuerySchema, setManagerSchema } from "../../shared/schemas";
import { pathUpdates } from "../agent-tree";
import { auditBy, auditStmt } from "../audit";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { batchOf, contains, valid } from "../http";
import { requirePermission } from "../middleware";
import { inTenant, scopeOf, visibleAgents } from "../scope";

// Directory fields only. Personal fields (dob, phone) are not exposed here.
const agentColumns = {
  agentCode: agents.agentCode,
  name: agents.name,
  rank: agents.rank,
  managerCode: agents.managerCode,
  path: agents.path,
  status: agents.status,
  officeCode: agents.officeCode,
};

export const agentRoutes = new Hono<AppEnv>()
  .get("/", valid("query", pageQuerySchema), async (c) => {
    const db = c.get("db");
    const { page, pageSize, q } = c.req.valid("query");
    const where = and(
      visibleAgents(scopeOf(c.get("actor"))),
      q ? contains(q, agents.name, agents.agentCode) : undefined,
    );
    const [items, total] = await db.batch([
      db
        .select(agentColumns)
        .from(agents)
        .where(where)
        .orderBy(asc(agents.path))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(agents).where(where),
    ]);
    return c.json({ items, page, pageSize, total: total[0]?.n ?? 0 });
  })

  // The whole visible (sub)tree in one response, ordered so parents come before children.
  .get("/tree", async (c) => {
    const items = await c
      .get("db")
      .select(agentColumns)
      .from(agents)
      .where(visibleAgents(scopeOf(c.get("actor"))))
      .orderBy(asc(agents.path));
    return c.json({ items });
  })

  .get("/:code", async (c) => {
    const agent = await c
      .get("db")
      .select(agentColumns)
      .from(agents)
      .where(and(visibleAgents(scopeOf(c.get("actor"))), eq(agents.agentCode, c.req.param("code"))))
      .get();
    if (!agent) throw notFound();
    return c.json(agent);
  })

  // F1.3: fix a manager link by hand (GA Head, and Admin by default), including agents
  // that an FC's own upload created. Audited and kept in the record history.
  .patch("/:code/manager", requirePermission("agents.edit_tree"), valid("json", setManagerSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const code = c.req.param("code");
    const { managerCode } = c.req.valid("json");

    const rows = await db
      .select({ agentCode: agents.agentCode, managerCode: agents.managerCode, path: agents.path })
      .from(agents)
      .where(inTenant(scope, agents));
    const agent = rows.find((r) => r.agentCode === code);
    if (!agent) throw notFound();
    if (agent.managerCode === managerCode) return c.json({ agentCode: code, managerCode, updated: 0 });

    if (managerCode !== null) {
      const manager = rows.find((r) => r.agentCode === managerCode);
      if (!manager) throw new ApiError(400, "manager_not_found");
      // The new manager must not be the agent or someone below the agent.
      if (manager.path.includes(`/${code}/`)) throw new ApiError(400, "manager_cycle");
    }

    const next = rows.map((r) => (r.agentCode === code ? { ...r, managerCode } : r));
    const { stmts } = pathUpdates(db, scope.tenantId, next);
    await db.batch(
      batchOf([
        db
          .update(agents)
          .set({ managerCode, managerFixed: true })
          .where(and(inTenant(scope, agents), eq(agents.agentCode, code))),
        ...stmts,
        db.insert(recordChanges).values({
          id: crypto.randomUUID(),
          tenantId: scope.tenantId,
          entity: "agent",
          entityKey: code,
          field: "manager_code",
          oldValue: agent.managerCode,
          newValue: managerCode,
          changedBy: scope.userId,
          changedAt: new Date().toISOString(),
        }),
        auditStmt(db, {
          ...auditBy(c),
          action: "UPDATE",
          entity: "agent",
          entityId: code,
          meta: { field: "managerCode", before: agent.managerCode, after: managerCode },
        }),
      ]),
    );
    return c.json({ agentCode: code, managerCode, updated: stmts.length });
  });
