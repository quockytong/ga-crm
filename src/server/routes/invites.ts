import { hashPassword } from "better-auth/crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { accounts, invitations, tenants, users } from "../../db/schema";
import { acceptInviteSchema } from "../../shared/schemas";
import { auditStmt, clientIp } from "../audit";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { valid } from "../http";
import { hashInviteToken } from "../invites";

/** A pending, unexpired invitation for a user who has not set a password yet. */
async function findInvite(db: Db, token: string) {
  return db
    .select({
      id: invitations.id,
      userId: users.id,
      tenantId: invitations.tenantId,
      email: users.email,
      name: users.name,
      tenantName: tenants.name,
    })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
    .where(
      and(
        eq(invitations.tokenHash, await hashInviteToken(token)),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date().toISOString()),
        eq(users.status, "INVITED"),
        eq(tenants.status, "active"),
      ),
    )
    .get();
}

/** Public: the invite token is the credential. */
export const inviteRoutes = new Hono<AppEnv>()
  .get("/:token", async (c) => {
    const invite = await findInvite(c.get("db"), c.req.param("token"));
    if (!invite) throw new ApiError(404, "invite_invalid");
    return c.json({ email: invite.email, name: invite.name, tenantName: invite.tenantName });
  })

  .post("/accept", valid("json", acceptInviteSchema), async (c) => {
    const db = c.get("db");
    const { token, password } = c.req.valid("json");
    const invite = await findInvite(db, token);
    if (!invite) throw new ApiError(404, "invite_invalid");

    const now = new Date();
    await db.batch([
      db.insert(accounts).values({
        id: crypto.randomUUID(),
        userId: invite.userId,
        accountId: invite.userId,
        providerId: "credential",
        password: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      }),
      db
        .update(users)
        .set({ status: "ACTIVE", emailVerified: true, updatedAt: now })
        .where(eq(users.id, invite.userId)),
      db.update(invitations).set({ acceptedAt: now.toISOString() }).where(eq(invitations.id, invite.id)),
      auditStmt(db, {
        tenantId: invite.tenantId,
        userId: invite.userId,
        action: "UPDATE",
        entity: "user",
        entityId: invite.userId,
        meta: { event: "invite_accepted" },
        ip: clientIp(c),
      }),
    ]);
    return c.json({ email: invite.email });
  });
