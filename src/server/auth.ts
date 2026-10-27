import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { auditStmt } from "./audit";

/**
 * Email + password sign-in with sessions in D1. There is no self sign-up:
 * accounts are created by invitation only (see invites.ts).
 */
export function createAuth(env: Env, db: Db) {
  return betterAuth({
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, { provider: "sqlite", usePlural: true, schema }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    user: {
      additionalFields: {
        tenantId: { type: "string", required: false, input: false },
        agentCode: { type: "string", required: false, input: false },
        status: { type: "string", required: false, input: false, defaultValue: "INVITED" },
        lastLoginAt: { type: "string", required: false, input: false },
      },
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    databaseHooks: {
      session: {
        create: {
          // Only active users of active tenants can sign in.
          before: async (session) => {
            const row = await db
              .select({ status: schema.users.status, tenantStatus: schema.tenants.status })
              .from(schema.users)
              .leftJoin(schema.tenants, eq(schema.tenants.id, schema.users.tenantId))
              .where(eq(schema.users.id, session.userId))
              .get();
            if (!row || row.status !== "ACTIVE" || row.tenantStatus === "suspended") return false;
          },
          after: async (session) => {
            const user = await db
              .select({ tenantId: schema.users.tenantId })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId))
              .get();
            await db.batch([
              db
                .update(schema.users)
                .set({ lastLoginAt: new Date().toISOString() })
                .where(eq(schema.users.id, session.userId)),
              auditStmt(db, {
                tenantId: user?.tenantId ?? null,
                userId: session.userId,
                action: "LOGIN",
                entity: "user",
                entityId: session.userId,
                ip: session.ipAddress || null,
              }),
            ]);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
