import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { agents, invitations, sessions, userRoles, users } from "../../db/schema";
import { AGENT_ROLES, type Role, type TenantRole } from "../../shared/enums";
import { inviteUserSchema, pageQuerySchema, updateUserSchema } from "../../shared/schemas";
import { auditBy, auditStmt } from "../audit";
import type { AppEnv } from "../env";
import { ApiError, forbidden, notFound } from "../errors";
import { batchOf, contains, valid } from "../http";
import { inviteStmts, inviteUrl } from "../invites";
import { requirePermission } from "../middleware";
import { hasRole, inTenant, scopeOf, type Scope } from "../scope";

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  agentCode: users.agentCode,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
};

/** Users of the scope's tenant, with their roles and whether the agent code is in the agent tree. */
export async function listUsers(db: Db, scope: Scope, opts: { page: number; pageSize: number; q?: string }) {
  const where = and(
    inTenant(scope, users),
    opts.q ? contains(opts.q, users.name, users.email, users.agentCode) : undefined,
  );
  // Not db.batch(): the join has two `name` columns (see middleware.ts).
  const [rows, total] = await Promise.all([
    db
      .select({ ...userColumns, agentName: agents.name })
      .from(users)
      .leftJoin(agents, and(eq(agents.tenantId, users.tenantId), eq(agents.agentCode, users.agentCode)))
      .where(where)
      .orderBy(asc(users.name), asc(users.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ n: count() }).from(users).where(where),
  ]);
  const roles = rows.length
    ? await db
        .select()
        .from(userRoles)
        .where(inArray(userRoles.userId, rows.map((r) => r.id)))
    : [];
  return {
    items: rows.map((r) => ({
      ...r,
      roles: roles.filter((x) => x.userId === r.id).map((x) => x.role),
    })),
    page: opts.page,
    pageSize: opts.pageSize,
    total: total[0]?.n ?? 0,
  };
}

async function getUser(db: Db, scope: Scope, id: string) {
  const user = await db
    .select({ ...userColumns, agentName: agents.name })
    .from(users)
    .leftJoin(agents, and(eq(agents.tenantId, users.tenantId), eq(agents.agentCode, users.agentCode)))
    .where(and(inTenant(scope, users), eq(users.id, id)))
    .get();
  if (!user) throw notFound();
  const roles = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, id));
  return { ...user, roles: roles.map((r) => r.role) };
}

const needsAgentCode = (roles: readonly Role[]) =>
  roles.some((r) => (AGENT_ROLES as readonly Role[]).includes(r));

async function assertAgentCodeFree(db: Db, scope: Scope, agentCode: string, exceptUserId?: string) {
  const taken = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inTenant(scope, users),
        eq(users.agentCode, agentCode),
        exceptUserId ? ne(users.id, exceptUserId) : undefined,
      ),
    )
    .get();
  if (taken) throw new ApiError(409, "agent_code_taken");
}

/** Other active GA Heads of the tenant. A tenant must always keep at least one. */
async function otherActiveHeads(db: Db, scope: Scope, exceptUserId: string) {
  const row = await db
    .select({ n: count() })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(
      and(
        inTenant(scope, users),
        eq(userRoles.role, "GA_HEAD"),
        eq(users.status, "ACTIVE"),
        ne(users.id, exceptUserId),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** Creates an INVITED user with roles and an invitation. Shared with the platform routes. */
export async function createInvitedUser(
  db: Db,
  env: Env,
  args: {
    tenantId: string;
    email: string;
    name: string;
    roles: readonly TenantRole[];
    agentCode: string | null;
    createdBy: string;
  },
) {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, args.email)).get();
  if (existing) throw new ApiError(409, "email_taken");

  const id = crypto.randomUUID();
  const now = new Date();
  const invite = await inviteStmts(db, { tenantId: args.tenantId, userId: id, createdBy: args.createdBy });
  const stmts = [
    db.insert(users).values({
      id,
      tenantId: args.tenantId,
      email: args.email,
      name: args.name,
      agentCode: args.agentCode,
      status: "INVITED",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(userRoles).values(args.roles.map((role) => ({ userId: id, role }))),
    ...invite.stmts,
  ];
  return { id, stmts, inviteUrl: inviteUrl(env, invite.token), inviteExpiresAt: invite.expiresAt };
}

export const userRoutes = new Hono<AppEnv>()
  .use(requirePermission("users.manage"))

  .get("/", valid("query", pageQuerySchema), async (c) => {
    return c.json(await listUsers(c.get("db"), scopeOf(c.get("actor")), c.req.valid("query")));
  })

  .get("/:id", async (c) => {
    return c.json(await getUser(c.get("db"), scopeOf(c.get("actor")), c.req.param("id")));
  })

  .post("/invite", valid("json", inviteUserSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const input = c.req.valid("json");
    const agentCode = input.agentCode ?? null;

    // Only a GA Head can create another GA Head.
    if (input.roles.includes("GA_HEAD") && !hasRole(scope, "GA_HEAD")) throw forbidden();
    if (agentCode) await assertAgentCodeFree(db, scope, agentCode);

    // The tenant always comes from the session, never from the request body.
    const created = await createInvitedUser(db, c.env, {
      tenantId: scope.tenantId,
      email: input.email,
      name: input.name,
      roles: input.roles,
      agentCode,
      createdBy: scope.userId,
    });
    await db.batch(
      batchOf([
        ...created.stmts,
        auditStmt(db, {
          ...auditBy(c),
          action: "CREATE",
          entity: "user",
          entityId: created.id,
          meta: { email: input.email, roles: input.roles, agentCode },
        }),
      ]),
    );
    return c.json(
      {
        user: await getUser(db, scope, created.id),
        inviteUrl: created.inviteUrl,
        inviteExpiresAt: created.inviteExpiresAt,
      },
      201,
    );
  })

  // New invite link for a user who has not accepted yet (lost or expired link).
  .post("/:id/invite", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const target = await getUser(db, scope, c.req.param("id"));
    if (target.status !== "INVITED") throw new ApiError(409, "not_invited");
    if (target.roles.includes("GA_HEAD") && !hasRole(scope, "GA_HEAD")) throw forbidden();

    const invite = await inviteStmts(db, { tenantId: scope.tenantId, userId: target.id, createdBy: scope.userId });
    await db.batch([
      ...invite.stmts,
      auditStmt(db, {
        ...auditBy(c),
        action: "UPDATE",
        entity: "user",
        entityId: target.id,
        meta: { event: "invite_renewed" },
      }),
    ]);
    return c.json({ inviteUrl: inviteUrl(c.env, invite.token), inviteExpiresAt: invite.expiresAt });
  })

  .patch("/:id", valid("json", updateUserSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const input = c.req.valid("json");
    const target = await getUser(db, scope, c.req.param("id"));

    const nextRoles: readonly Role[] = input.roles ?? target.roles;
    const nextAgentCode = input.agentCode === undefined ? target.agentCode : input.agentCode;
    const nextStatus = input.status ?? target.status;

    // GA Head accounts, and the GA Head role itself, are managed by GA Heads only.
    const touchesHead = target.roles.includes("GA_HEAD") || nextRoles.includes("GA_HEAD");
    if (touchesHead && !hasRole(scope, "GA_HEAD")) throw forbidden();

    if (needsAgentCode(nextRoles) && !nextAgentCode) throw new ApiError(400, "agent_code_required");
    if (nextAgentCode && nextAgentCode !== target.agentCode) {
      await assertAgentCodeFree(db, scope, nextAgentCode, target.id);
    }
    if (input.status && input.status !== target.status) {
      if (target.status === "INVITED") throw new ApiError(409, "invite_pending");
      if (target.id === scope.userId) throw new ApiError(409, "cannot_disable_self");
    }
    const losesHead =
      target.roles.includes("GA_HEAD") &&
      target.status === "ACTIVE" &&
      (!nextRoles.includes("GA_HEAD") || nextStatus !== "ACTIVE");
    if (losesHead && (await otherActiveHeads(db, scope, target.id)) === 0) {
      throw new ApiError(409, "last_ga_head");
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (key: string, from: unknown, to: unknown) => {
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        before[key] = from;
        after[key] = to;
      }
    };
    track("name", target.name, input.name ?? target.name);
    track("agentCode", target.agentCode, nextAgentCode);
    track("status", target.status, nextStatus);
    track("roles", [...target.roles].sort(), [...nextRoles].sort());
    if (Object.keys(after).length === 0) return c.json(target);

    const mine = and(inTenant(scope, users), eq(users.id, target.id));
    await db.batch(
      batchOf([
        db
          .update(users)
          .set({
            name: input.name ?? target.name,
            agentCode: nextAgentCode,
            status: nextStatus,
            updatedAt: new Date(),
          })
          .where(mine),
        ...("roles" in after
          ? [
              db.delete(userRoles).where(eq(userRoles.userId, target.id)),
              db.insert(userRoles).values(nextRoles.map((role) => ({ userId: target.id, role }))),
            ]
          : []),
        // A disabled user is signed out everywhere.
        ...(nextStatus === "DISABLED" ? [db.delete(sessions).where(eq(sessions.userId, target.id))] : []),
        auditStmt(db, {
          ...auditBy(c),
          action: "UPDATE",
          entity: "user",
          entityId: target.id,
          meta: { before, after },
        }),
      ]),
    );
    return c.json(await getUser(db, scope, target.id));
  })

  // Withdraw an invitation that was never accepted (e.g. wrong email).
  .delete("/:id", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const target = await getUser(db, scope, c.req.param("id"));
    if (target.status !== "INVITED") throw new ApiError(409, "not_invited");
    if (target.roles.includes("GA_HEAD") && !hasRole(scope, "GA_HEAD")) throw forbidden();

    await db.batch([
      db.delete(invitations).where(eq(invitations.userId, target.id)),
      db.delete(userRoles).where(eq(userRoles.userId, target.id)),
      db.delete(users).where(and(inTenant(scope, users), eq(users.id, target.id), sql`${users.status} = 'INVITED'`)),
      auditStmt(db, {
        ...auditBy(c),
        action: "DELETE",
        entity: "user",
        entityId: target.id,
        meta: { email: target.email, event: "invite_withdrawn" },
      }),
    ]);
    return c.body(null, 204);
  });
