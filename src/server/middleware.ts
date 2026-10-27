import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createDb } from "../db/client";
import { rolePermissions, tenants, userRoles, users } from "../db/schema";
import type { Role } from "../shared/enums";
import { permissionsOf, type Permission } from "../shared/permissions";
import { createAuth } from "./auth";
import type { AppEnv } from "./env";
import { ApiError, forbidden } from "./errors";

export const withDb = createMiddleware<AppEnv>(async (c, next) => {
  const db = createDb(c.env.DB);
  c.set("db", db);
  c.set("auth", createAuth(c.env, db));
  await next();
});

/**
 * Resolves the session to an Actor. Tenant, roles and agent code are read from
 * the database on every request, so a role change or a disabled user takes
 * effect immediately.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, "unauthenticated");

  // Not db.batch(): D1 batch results are keyed by column name, so the two
  // `status` columns of this join would collide.
  const [user, roles] = await Promise.all([
    db
      .select({
        id: users.id,
        tenantId: users.tenantId,
        email: users.email,
        name: users.name,
        agentCode: users.agentCode,
        status: users.status,
        tenantStatus: tenants.status,
      })
      .from(users)
      .leftJoin(tenants, eq(tenants.id, users.tenantId))
      .where(eq(users.id, session.user.id)),
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, session.user.id)),
  ]);
  const u = user[0];
  if (!u || u.status !== "ACTIVE" || u.tenantStatus === "suspended") {
    throw new ApiError(401, "unauthenticated");
  }
  const roleList = roles.map((r) => r.role);
  const grants = u.tenantId
    ? await db
        .select({ role: rolePermissions.role, permission: rolePermissions.permission })
        .from(rolePermissions)
        .where(eq(rolePermissions.tenantId, u.tenantId))
    : [];
  c.set("actor", {
    userId: u.id,
    tenantId: u.tenantId,
    email: u.email,
    name: u.name,
    agentCode: u.agentCode,
    roles: roleList,
    permissions: u.tenantId ? permissionsOf(roleList, grants) : [],
  });
  await next();
});

export const requireRole = (...allowed: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!allowed.some((r) => c.get("actor").roles.includes(r))) throw forbidden();
    await next();
  });

/** RBAC: the function must be granted to one of the user's roles in their tenant. */
export const requirePermission = (permission: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("actor").permissions.includes(permission)) throw forbidden();
    await next();
  });
