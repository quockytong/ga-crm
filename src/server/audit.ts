import type { Context } from "hono";
import type { Db } from "../db/client";
import { auditLog } from "../db/schema";
import type { AuditAction } from "../shared/enums";
import type { AppEnv } from "./env";

export type AuditEntry = {
  tenantId: string | null;
  userId: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  meta?: unknown;
  ip?: string | null;
};

/** Insert statement for an audit row. Put it in the same `db.batch()` as the change it records. */
export function auditStmt(db: Db, e: AuditEntry) {
  return db.insert(auditLog).values({
    id: crypto.randomUUID(),
    tenantId: e.tenantId,
    userId: e.userId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    meta: e.meta === undefined ? null : JSON.stringify(e.meta),
    ip: e.ip ?? null,
    at: new Date().toISOString(),
  });
}

export const clientIp = (c: Context<AppEnv>) => c.req.header("cf-connecting-ip") ?? null;

/** Who and where, for an audit row written on behalf of the signed-in user. */
export function auditBy(c: Context<AppEnv>, tenantId?: string | null) {
  const actor = c.get("actor");
  return {
    tenantId: tenantId === undefined ? actor.tenantId : tenantId,
    userId: actor.userId,
    ip: clientIp(c),
  };
}
