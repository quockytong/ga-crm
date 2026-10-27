import { and, asc, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { products, rolePermissions, tenants, users } from "../../db/schema";
import { defaultGrantRows } from "../../shared/permissions";
import { createTenantSchema, pageQuerySchema, productCatalogSchema } from "../../shared/schemas";
import { auditBy, auditStmt, clientIp } from "../audit";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { batchOf, chunks, contains, valid } from "../http";
import { inviteStmts, inviteUrl } from "../invites";
import { requireRole } from "../middleware";
import { crossTenantScope, inTenant } from "../scope";
import { createInvitedUser, listUsers } from "./users";

/** DLVN Innovation only. Every look into a tenant's data goes through crossTenantScope() and is audited. */
export const platformRoutes = new Hono<AppEnv>()
  .use(requireRole("PLATFORM_ADMIN"))

  .get("/tenants", valid("query", pageQuerySchema), async (c) => {
    const db = c.get("db");
    const { page, pageSize, q } = c.req.valid("query");
    const where = q ? contains(q, tenants.name, tenants.gaCode) : undefined;
    const [items, total] = await db.batch([
      db
        .select()
        .from(tenants)
        .where(where)
        .orderBy(asc(tenants.gaCode))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(tenants).where(where),
    ]);
    return c.json({ items, page, pageSize, total: total[0]?.n ?? 0 });
  })

  // F1.1: create a tenant together with its first GA Head.
  .post("/tenants", valid("json", createTenantSchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const input = c.req.valid("json");

    const clash = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.gaCode, input.gaCode)).get();
    if (clash) throw new ApiError(409, "ga_code_taken");

    const tenantId = crypto.randomUUID();
    const head = await createInvitedUser(db, c.env, {
      tenantId,
      email: input.head.email,
      name: input.head.name,
      roles: ["GA_HEAD"],
      agentCode: input.head.agentCode ?? null,
      createdBy: actor.userId,
    });
    const tenant = {
      id: tenantId,
      gaCode: input.gaCode,
      name: input.name,
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    await db.batch(
      batchOf([
        db.insert(tenants).values(tenant),
        db.insert(rolePermissions).values(defaultGrantRows(tenantId)),
        ...head.stmts,
        auditStmt(db, {
          ...auditBy(c, tenantId),
          action: "CREATE",
          entity: "tenant",
          entityId: tenantId,
          meta: { gaCode: input.gaCode, name: input.name },
        }),
        auditStmt(db, {
          ...auditBy(c, tenantId),
          action: "CREATE",
          entity: "user",
          entityId: head.id,
          meta: { email: input.head.email, roles: ["GA_HEAD"] },
        }),
      ]),
    );
    return c.json(
      {
        tenant,
        head: { id: head.id, email: input.head.email, name: input.head.name },
        inviteUrl: head.inviteUrl,
        inviteExpiresAt: head.inviteExpiresAt,
      },
      201,
    );
  })

  // Support view: a tenant and its users. Audited as CROSS_TENANT_READ.
  .get("/tenants/:id", valid("query", pageQuerySchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const scope = await crossTenantScope(db, c.get("actor"), id, {
      entity: "tenant",
      entityId: id,
      ip: clientIp(c),
    });
    const tenant = await db.select().from(tenants).where(eq(tenants.id, scope.tenantId)).get();
    return c.json({ tenant, users: await listUsers(db, scope, c.req.valid("query")) });
  })

  // DLVN product catalog (11_Products): shared by every GA, used for coverage groups.
  .get("/products", async (c) => {
    const items = await c.get("db").select().from(products).orderBy(asc(products.productCode));
    return c.json({ items });
  })

  .post("/products", valid("json", productCatalogSchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const { rows } = c.req.valid("json");
    const now = new Date().toISOString();
    const unique = [...new Map(rows.map((r) => [r.productCode, r])).values()];
    const excluded = (col: string) => sql.raw(`excluded.${col}`);
    // 15 columns: 6 rows per statement stay under D1's 100 bound parameters.
    await db.batch(
      batchOf([
        ...chunks(unique, 6).map((part) =>
          db
            .insert(products)
            .values(part.map((r) => ({ ...r, updatedBy: actor.userId, updatedAt: now })))
            .onConflictDoUpdate({
              target: products.productCode,
              set: Object.fromEntries(
                Object.entries({
                  productName: "product_name",
                  productRole: "product_role",
                  category: "category",
                  minEntryAge: "min_entry_age",
                  maxEntryAge: "max_entry_age",
                  maxCoverAge: "max_cover_age",
                  gender: "gender",
                  waitingPeriod: "waiting_period",
                  keyBenefits: "key_benefits",
                  fitRule: "fit_rule",
                  triggerEvent: "trigger_event",
                  ruleStatus: "rule_status",
                  updatedBy: "updated_by",
                  updatedAt: "updated_at",
                }).map(([k, col]) => [k, excluded(col)]),
              ),
            }),
        ),
        auditStmt(db, { ...auditBy(c, null), action: "IMPORT", entity: "products", meta: { rows: unique.length } }),
      ]),
    );
    return c.json({ saved: unique.length });
  })

  // New invite link for a user of the tenant who has not accepted yet (e.g. the first GA Head).
  .post("/tenants/:id/users/:userId/invite", async (c) => {
    const db = c.get("db");
    const userId = c.req.param("userId");
    const scope = await crossTenantScope(db, c.get("actor"), c.req.param("id"), {
      entity: "user",
      entityId: userId,
      ip: clientIp(c),
    });
    const target = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(and(inTenant(scope, users), eq(users.id, userId)))
      .get();
    if (!target) throw notFound();
    if (target.status !== "INVITED") throw new ApiError(409, "not_invited");

    const invite = await inviteStmts(db, { tenantId: scope.tenantId, userId, createdBy: scope.userId });
    await db.batch([
      ...invite.stmts,
      auditStmt(db, {
        ...auditBy(c, scope.tenantId),
        action: "UPDATE",
        entity: "user",
        entityId: userId,
        meta: { event: "invite_renewed" },
      }),
    ]);
    return c.json({ inviteUrl: inviteUrl(c.env, invite.token), inviteExpiresAt: invite.expiresAt });
  });
