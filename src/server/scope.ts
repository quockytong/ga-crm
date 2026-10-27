import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/client";
import { agents, applications, clientAgents, imports, leads, policyAgents, policyClients, tenants } from "../db/schema";
import { MANAGER_ROLES, type Reach, type Role } from "../shared/enums";
import { PERMISSIONS, type Permission } from "../shared/permissions";
import { auditStmt } from "./audit";
import type { Actor } from "./env";
import { forbidden, notFound } from "./errors";

/**
 * The only door to tenant data.
 *
 * Every query on a table that carries `tenant_id` must take its WHERE clause
 * from this file: `inTenant()` for tenant-wide resources, `ownedBy()` for
 * records owned by an agent. A Scope is built only from the session user and
 * the database, never from anything the client sent.
 */
export type Scope = {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
  readonly agentCode: string | null;
  readonly reach: Reach;
  /** Functions granted by RBAC. Never widens the data scope. */
  readonly permissions: readonly Permission[];
  /** True when a Platform Admin is looking into a tenant (always audited). */
  readonly crossTenant: boolean;
};

type TenantTable = { tenantId: AnySQLiteColumn };

/** FC: own. UM / BM / GAD: own + downline. GA Head: whole tenant. Others: no agent-owned data. */
export function reachOf(roles: readonly Role[], agentCode: string | null): Reach {
  if (roles.includes("GA_HEAD")) return "TENANT";
  if (!agentCode) return "NONE";
  if (roles.some((r) => (MANAGER_ROLES as readonly Role[]).includes(r))) return "DOWNLINE";
  if (roles.includes("FC")) return "OWN";
  return "NONE";
}

/** Scope of a tenant user. Platform Admin has no tenant and must use `crossTenantScope()`. */
export function scopeOf(actor: Actor): Scope {
  if (!actor.tenantId) throw forbidden();
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    roles: actor.roles,
    agentCode: actor.agentCode,
    reach: reachOf(actor.roles, actor.agentCode),
    permissions: actor.permissions,
    crossTenant: false,
  };
}

/** Platform Admin entering a tenant. Writes the CROSS_TENANT_READ audit row before returning. */
export async function crossTenantScope(
  db: Db,
  actor: Actor,
  tenantId: string,
  audit: { entity: string; entityId?: string | null; ip?: string | null },
): Promise<Scope> {
  if (!actor.roles.includes("PLATFORM_ADMIN")) throw forbidden();
  const tenant = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).get();
  if (!tenant) throw notFound();
  await auditStmt(db, {
    tenantId,
    userId: actor.userId,
    action: "CROSS_TENANT_READ",
    entity: audit.entity,
    entityId: audit.entityId,
    ip: audit.ip,
  });
  return {
    userId: actor.userId,
    tenantId,
    roles: actor.roles,
    agentCode: null,
    reach: "TENANT",
    permissions: [...PERMISSIONS],
    crossTenant: true,
  };
}

export const hasRole = (s: { roles: readonly Role[] }, ...roles: Role[]) => roles.some((r) => s.roles.includes(r));

export const can = (s: { permissions: readonly Permission[] }, permission: Permission) => s.permissions.includes(permission);

/** Rows of the caller's tenant. */
export function inTenant(scope: Scope, table: TenantTable): SQL {
  return eq(table.tenantId, scope.tenantId);
}

/**
 * Whether the agent code in `agentCode` (a column or SQL expression) is within the
 * caller's hierarchy scope. Downline = agents whose `path` contains `/<code>/`.
 * Always combine with a tenant filter; `ownedBy()` does that for you.
 */
export function agentInScope(scope: Scope, agentCode: SQLWrapper): SQL {
  const code = scope.agentCode;
  if (scope.reach === "TENANT") return sql`1`;
  if (scope.reach === "NONE" || !code) return sql`0`;
  if (scope.reach === "OWN") return sql`${agentCode} = ${code}`;
  const tree = alias(agents, "scope_tree");
  // Own rows stay visible even before the agent tree has been imported.
  return sql`(${agentCode} = ${code} or ${agentCode} in (select ${tree.agentCode} from ${agents} as ${sql.identifier("scope_tree")} where ${tree.tenantId} = ${scope.tenantId} and instr(${tree.path}, ${`/${code}/`}) > 0))`;
}

/** Rows of the caller's tenant whose owning agent (`ownerCode` column) is within the caller's hierarchy scope. */
export function ownedBy(scope: Scope, table: TenantTable, ownerCode: AnySQLiteColumn): SQL {
  return and(inTenant(scope, table), agentInScope(scope, ownerCode))!;
}

/**
 * Agents the caller may see: the whole tenant with `agents.view_all` (by default GA Head,
 * Marketing for the assignee picker, Admin for linking users); otherwise their own subtree.
 */
export function visibleAgents(scope: Scope): SQL {
  if (scope.crossTenant || can(scope, "agents.view_all")) return inTenant(scope, agents);
  return ownedBy(scope, agents, agents.agentCode);
}

/** Imports the caller may see: their own, or every import of the tenant with `imports.view_all`. */
export function visibleImports(scope: Scope): SQL {
  if (scope.crossTenant || can(scope, "imports.view_all")) return inTenant(scope, imports);
  return and(inTenant(scope, imports), eq(imports.userId, scope.userId))!;
}

/** Imports the caller may change: only the ones they started. */
export function ownImports(scope: Scope): SQL {
  return and(inTenant(scope, imports), eq(imports.userId, scope.userId))!;
}

/**
 * A policy is in scope when one of its current agents (servicing or sharing) is.
 * `policyNo` must belong to a row of the caller's tenant.
 */
export function policyInScope(scope: Scope, policyNo: SQLWrapper): SQL {
  if (scope.reach === "TENANT") return sql`1`;
  const pa = alias(policyAgents, "scope_pa");
  return sql`exists (select 1 from ${policyAgents} as ${sql.identifier("scope_pa")} where ${pa.tenantId} = ${scope.tenantId}
    and ${pa.policyNo} = ${policyNo} and ${pa.endedAt} is null and ${agentInScope(scope, pa.agentCode)})`;
}

/**
 * A client is in scope when an agent in scope serves or shares one of the client's
 * policies (any role: PO, LI, BEN), submitted an application for them, or uploaded
 * them in a 02_Clients sheet (DATA-MODEL section 4).
 */
export function clientInScope(scope: Scope, clientCode: SQLWrapper): SQL {
  if (scope.reach === "TENANT") return sql`1`;
  const pc = alias(policyClients, "scope_pc");
  const ap = alias(applications, "scope_ap");
  const ca = alias(clientAgents, "scope_ca");
  return sql`(exists (select 1 from ${policyClients} as ${sql.identifier("scope_pc")} where ${pc.tenantId} = ${scope.tenantId}
      and ${pc.clientCode} = ${clientCode} and ${pc.endedAt} is null and ${policyInScope(scope, pc.policyNo)})
    or exists (select 1 from ${applications} as ${sql.identifier("scope_ap")} where ${ap.tenantId} = ${scope.tenantId}
      and ${ap.clientCode} = ${clientCode} and ${agentInScope(scope, ap.agentCode)})
    or exists (select 1 from ${clientAgents} as ${sql.identifier("scope_ca")} where ${ca.tenantId} = ${scope.tenantId}
      and ${ca.clientCode} = ${clientCode} and ${agentInScope(scope, ca.agentCode)}))`;
}

/**
 * Leads the caller may see: every lead of the tenant with `leads.manage` (Marketing and
 * Admin by default, who also see unassigned leads); otherwise leads assigned to an agent
 * in their hierarchy scope.
 */
export function visibleLeads(scope: Scope): SQL {
  if (scope.crossTenant || can(scope, "leads.manage")) return inTenant(scope, leads);
  return ownedBy(scope, leads, leads.assignedAgentCode);
}

/**
 * Clients of the given agents themselves (no downline), as `clientInScope` counts them for an FC.
 * The caller must have checked that every code is in their own scope (`agentsInScope`).
 */
export function clientOfAgents(scope: Scope, clientCode: SQLWrapper, codes: readonly string[]): SQL {
  if (codes.length === 0) return sql`0`;
  const list = sql.join(
    codes.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`(exists (select 1 from policy_clients coa_pc join policy_agents coa_pa on coa_pa.tenant_id = coa_pc.tenant_id and coa_pa.policy_no = coa_pc.policy_no
      where coa_pc.tenant_id = ${scope.tenantId} and coa_pc.client_code = ${clientCode} and coa_pc.ended_at is null and coa_pa.ended_at is null and coa_pa.agent_code in (${list}))
    or exists (select 1 from applications coa_ap where coa_ap.tenant_id = ${scope.tenantId} and coa_ap.client_code = ${clientCode} and coa_ap.agent_code in (${list}))
    or exists (select 1 from client_agents coa_ca where coa_ca.tenant_id = ${scope.tenantId} and coa_ca.client_code = ${clientCode} and coa_ca.agent_code in (${list})))`;
}

/** The codes among `codes` that are agents of the caller's tenant within their hierarchy scope. */
export async function agentsInScope(db: Db, scope: Scope, codes: readonly string[]): Promise<string[]> {
  if (codes.length === 0) return [];
  const rows = await db
    .select({ code: agents.agentCode })
    .from(agents)
    .where(and(ownedBy(scope, agents, agents.agentCode), inArray(agents.agentCode, [...codes])));
  const found = new Set(rows.map((r) => r.code));
  // An agent's own code counts even before the tree is imported.
  if (scope.agentCode && codes.includes(scope.agentCode)) found.add(scope.agentCode);
  return codes.filter((c) => found.has(c));
}
