import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import * as schema from "../src/db/schema";

// CLAUDE.md rule 1: every business table has tenant_id.
// A new table fails this test until it either carries a NOT NULL tenant_id or
// is added here on purpose, with the reason.
const NOT_TENANT_SCOPED: Record<string, string> = {
  tenants: "the tenant itself",
  users: "tenant_id is nullable: null for Platform Admin only",
  user_roles: "child of users, reached through a scoped user",
  sessions: "Better Auth, child of users",
  accounts: "Better Auth, child of users",
  verifications: "Better Auth, not business data",
  audit_log: "tenant_id is nullable: null for platform-level events",
  products: "DLVN-wide product catalog (11_Products), loaded by the Platform Admin",
};

it("every table carries a NOT NULL tenant_id unless explicitly exempted", () => {
  const tables = (Object.values(schema) as unknown[]).filter((t): t is SQLiteTable => t instanceof SQLiteTable);
  expect(tables.length).toBeGreaterThan(5);
  const seen = new Set<string>();
  for (const table of tables) {
    const { name, columns } = getTableConfig(table);
    seen.add(name);
    if (name in NOT_TENANT_SCOPED) continue;
    const tenantId = columns.find((c) => c.name === "tenant_id");
    expect(tenantId, `${name} has no tenant_id`).toBeDefined();
    expect(tenantId!.notNull, `${name}.tenant_id must be NOT NULL`).toBe(true);
  }
  // No stale exemptions.
  for (const name of Object.keys(NOT_TENANT_SCOPED)) expect(seen.has(name), name).toBe(true);
});
