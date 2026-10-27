import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { leadTasks } from "../db/schema";
import { vi } from "../i18n/vi";
import type { Scope } from "./scope";

/** An assigned lead must be contacted within 48 hours. */
export const CONTACT_WITHIN_MS = 48 * 3600_000;

/**
 * On (re)assignment: open auto contact tasks of the previous agent are cancelled, and the new
 * agent gets "contact within 48 h".
 */
export function assignmentTasks(db: Db, scope: Scope, leadIds: string[], agentCode: string | null, now: string) {
  const stmts = [
    db
      .update(leadTasks)
      .set({ status: "CANCELLED" })
      .where(and(eq(leadTasks.tenantId, scope.tenantId), inArray(leadTasks.leadId, leadIds), eq(leadTasks.source, "AUTO_ASSIGN"), eq(leadTasks.status, "OPEN"))),
  ];
  if (!agentCode) return stmts;
  return [
    ...stmts,
    db.insert(leadTasks).values(
      leadIds.map((leadId) => ({
        id: crypto.randomUUID(),
        tenantId: scope.tenantId,
        leadId,
        agentCode,
        title: vi.leads.autoTasks.contact,
        dueAt: new Date(Date.parse(now) + CONTACT_WITHIN_MS).toISOString(),
        source: "AUTO_ASSIGN",
        createdBy: scope.userId,
        createdAt: now,
      })),
    ),
  ];
}

/** A logged contact completes the "contact within 48 h" task. */
export const contactDoneTask = (db: Db, scope: Scope, leadId: string, now: string) =>
  db
    .update(leadTasks)
    .set({ status: "DONE", doneAt: now, doneBy: scope.userId })
    .where(and(eq(leadTasks.tenantId, scope.tenantId), eq(leadTasks.leadId, leadId), eq(leadTasks.source, "AUTO_ASSIGN"), eq(leadTasks.status, "OPEN")));

/** "Hẹn liên hệ tiếp" becomes a task due at that time; clearing it cancels the task. */
export function nextActionTasks(db: Db, scope: Scope, leadId: string, agentCode: string | null, nextActionAt: string | null, now: string) {
  const cancel = db
    .update(leadTasks)
    .set({ status: "CANCELLED" })
    .where(and(eq(leadTasks.tenantId, scope.tenantId), eq(leadTasks.leadId, leadId), eq(leadTasks.source, "NEXT_ACTION"), eq(leadTasks.status, "OPEN")));
  if (!nextActionAt) return [cancel];
  return [
    cancel,
    db.insert(leadTasks).values({
      id: crypto.randomUUID(),
      tenantId: scope.tenantId,
      leadId,
      agentCode,
      title: vi.leads.autoTasks.followUp,
      dueAt: nextActionAt,
      source: "NEXT_ACTION",
      createdBy: scope.userId,
      createdAt: now,
    }),
  ];
}
