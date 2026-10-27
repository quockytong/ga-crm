import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { invitations } from "../db/schema";

const INVITE_TTL_DAYS = 7;

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Statements that replace any pending invitation of the user with a fresh one.
 * The CRM does not send email in Phase 1: the inviter copies the returned link
 * and passes it on (Zalo, email, ...).
 */
export async function inviteStmts(
  db: Db,
  args: { tenantId: string; userId: string; createdBy: string },
) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const now = Date.now();
  const expiresAt = new Date(now + INVITE_TTL_DAYS * 86_400_000).toISOString();
  const stmts = [
    db
      .delete(invitations)
      .where(and(eq(invitations.userId, args.userId), isNull(invitations.acceptedAt))),
    db.insert(invitations).values({
      id: crypto.randomUUID(),
      tenantId: args.tenantId,
      userId: args.userId,
      tokenHash: await hashInviteToken(token),
      expiresAt,
      createdBy: args.createdBy,
      createdAt: new Date(now).toISOString(),
    }),
  ] as const;
  return { stmts, token, expiresAt };
}

export const inviteUrl = (env: Env, token: string) => `${env.APP_URL}/invite/${token}`;
