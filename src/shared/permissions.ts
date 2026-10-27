import type { Role } from "./enums";

/**
 * Functions a GA can grant per role (RBAC). Data scope is separate and not configurable:
 * it always comes from the agent tree (CLAUDE.md rule 2).
 * GA Head always holds every permission, so a GA can never lock itself out.
 */
export const PERMISSIONS = [
  "users.manage",
  "agents.view_all",
  "agents.edit_tree",
  "imports.upload",
  "imports.agent_tree",
  "imports.tenant_wide",
  "imports.view_all",
  "leads.manage",
  "leads.import",
  "ai.use",
  "ai.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Roles whose permissions a GA Head configures. */
export const CONFIGURABLE_ROLES = ["ADMIN", "MARKETING", "GAD", "BM", "UM", "FC"] as const satisfies readonly Role[];
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

/** Grants of a new tenant. */
export const DEFAULT_GRANTS: Record<ConfigurableRole, readonly Permission[]> = {
  ADMIN: ["users.manage", "agents.view_all", "agents.edit_tree", "imports.upload", "imports.agent_tree", "imports.view_all", "leads.manage", "leads.import"],
  MARKETING: ["agents.view_all", "imports.upload", "imports.tenant_wide", "leads.manage", "leads.import"],
  GAD: ["imports.upload", "ai.use"],
  BM: ["imports.upload", "ai.use"],
  UM: ["imports.upload", "ai.use"],
  FC: ["imports.upload", "ai.use"],
};

export const isConfigurableRole = (r: string): r is ConfigurableRole => (CONFIGURABLE_ROLES as readonly string[]).includes(r);

/** Permissions of a user: the union over their roles. */
export function permissionsOf(roles: readonly Role[], grants: readonly { role: string; permission: string }[]): Permission[] {
  if (roles.includes("GA_HEAD")) return [...PERMISSIONS];
  const mine = new Set(grants.filter((g) => roles.includes(g.role as Role)).map((g) => g.permission));
  return PERMISSIONS.filter((p) => mine.has(p));
}

export const defaultGrantRows = (tenantId: string) =>
  CONFIGURABLE_ROLES.flatMap((role) => DEFAULT_GRANTS[role].map((permission) => ({ tenantId, role, permission })));
