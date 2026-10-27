import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { rolePermissions } from "../../db/schema";
import { CONFIGURABLE_ROLES, PERMISSIONS, type ConfigurableRole, type Permission } from "../../shared/permissions";
import { setPermissionsSchema } from "../../shared/schemas";
import { auditBy, auditStmt } from "../audit";
import type { AppEnv } from "../env";
import { valid } from "../http";
import { requireRole } from "../middleware";
import { inTenant, scopeOf } from "../scope";

type Grants = Record<ConfigurableRole, Permission[]>;

/** RBAC matrix of the tenant. Managed by GA Heads only, which is not itself configurable. */
export const permissionRoutes = new Hono<AppEnv>()
  .use(requireRole("GA_HEAD"))

  .get("/", async (c) => {
    const scope = scopeOf(c.get("actor"));
    const rows = await c.get("db").select().from(rolePermissions).where(inTenant(scope, rolePermissions));
    return c.json({ permissions: PERMISSIONS, roles: CONFIGURABLE_ROLES, grants: toGrants(rows) });
  })

  .put("/", valid("json", setPermissionsSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const before = toGrants(await db.select().from(rolePermissions).where(inTenant(scope, rolePermissions)));
    const after = Object.fromEntries(
      CONFIGURABLE_ROLES.map((r) => [r, PERMISSIONS.filter((p) => c.req.valid("json").grants[r].includes(p))]),
    ) as Grants;

    const changed = CONFIGURABLE_ROLES.filter((r) => before[r].join() !== after[r].join());
    if (changed.length === 0) return c.json({ grants: after });

    const rows = CONFIGURABLE_ROLES.flatMap((role) => after[role].map((permission) => ({ tenantId: scope.tenantId, role, permission })));
    await db.batch([
      db.delete(rolePermissions).where(eq(rolePermissions.tenantId, scope.tenantId)),
      ...(rows.length ? [db.insert(rolePermissions).values(rows)] : []),
      auditStmt(db, {
        ...auditBy(c),
        action: "UPDATE",
        entity: "permissions",
        entityId: scope.tenantId,
        meta: Object.fromEntries(changed.map((r) => [r, { before: before[r], after: after[r] }])),
      }),
    ]);
    return c.json({ grants: after });
  });

function toGrants(rows: { role: string; permission: string }[]): Grants {
  return Object.fromEntries(
    CONFIGURABLE_ROLES.map((r) => [r, PERMISSIONS.filter((p) => rows.some((x) => x.role === r && x.permission === p))]),
  ) as Grants;
}
