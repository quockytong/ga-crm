import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { tenants } from "../../db/schema";
import type { AppEnv } from "../env";
import { reachOf } from "../scope";

export const meRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const actor = c.get("actor");
  const tenant = actor.tenantId
    ? await c
        .get("db")
        .select({ id: tenants.id, gaCode: tenants.gaCode, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, actor.tenantId))
        .get()
    : null;
  return c.json({
    user: { id: actor.userId, email: actor.email, name: actor.name, agentCode: actor.agentCode },
    tenant: tenant ?? null,
    roles: actor.roles,
    permissions: actor.permissions,
    reach: actor.tenantId ? reachOf(actor.roles, actor.agentCode) : "NONE",
  });
});
