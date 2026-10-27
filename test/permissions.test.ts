import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog, rolePermissions } from "../src/db/schema";
import { GA1, GA2, userId } from "../src/db/seed";
import { DEFAULT_GRANTS, PERMISSIONS } from "../src/shared/permissions";
import { as, db, json, seedDb } from "./helpers";

// RBAC: GA Head sets which functions each role has in the GA.

beforeAll(seedDb);

const matrix = async () => json(await (await as("head@ga1.test"))("/api/permissions"));
const save = async (grants: Record<string, readonly string[]>, email = "head@ga1.test") =>
  (await as(email))("/api/permissions", { method: "PUT", json: { grants } });

describe("defaults", () => {
  it("a tenant starts with the default grants; /api/me lists the user's permissions", async () => {
    const { grants, roles, permissions } = await matrix();
    expect(roles).toEqual(["ADMIN", "MARKETING", "GAD", "BM", "UM", "FC"]);
    expect(permissions).toEqual([...PERMISSIONS]);
    expect(grants).toEqual(Object.fromEntries(Object.entries(DEFAULT_GRANTS).map(([r, p]) => [r, PERMISSIONS.filter((x) => p.includes(x))])));

    expect((await json(await (await as("head@ga1.test"))("/api/me"))).permissions).toEqual([...PERMISSIONS]);
    expect((await json(await (await as("marketing@ga1.test"))("/api/me"))).permissions).toEqual([
      "agents.view_all",
      "imports.upload",
      "imports.tenant_wide",
      "leads.manage",
      "leads.import",
    ]);
    expect((await json(await (await as("fc1@ga1.test"))("/api/me"))).permissions).toEqual(["imports.upload", "ai.use"]);
    // Several roles: the union.
    expect((await json(await (await as("gad@ga1.test"))("/api/me"))).permissions).toEqual(["imports.upload", "ai.use"]);
  });

  it("a tenant created by the Platform Admin gets the defaults too", async () => {
    const platform = await as("platform@dlvn.test");
    const { tenant } = await json(
      await platform("/api/platform/tenants", { json: { gaCode: "GA-RB-001", name: "GA RBAC", head: { email: "head@rb.test", name: "Chủ" } } }),
    );
    const rows = await db.select().from(rolePermissions).where(eq(rolePermissions.tenantId, tenant.id));
    expect(rows.length).toBe(Object.values(DEFAULT_GRANTS).flat().length);
  });
});

describe("managing the matrix", () => {
  it("only a GA Head can read or change it", async () => {
    for (const email of ["admin@ga1.test", "marketing@ga1.test", "gad@ga1.test", "fc1@ga1.test", "platform@dlvn.test"]) {
      const client = await as(email);
      expect((await client("/api/permissions")).status, email).toBe(403);
      expect((await save({ ...DEFAULT_GRANTS, FC: [...PERMISSIONS] }, email)).status, email).toBe(403);
    }
  });

  it("rejects unknown permissions and roles that are not configurable", async () => {
    expect((await save({ ...DEFAULT_GRANTS, FC: ["root.everything"] })).status).toBe(400);
    expect((await save({ ...DEFAULT_GRANTS, GA_HEAD: [] } as never)).status).toBe(200); // ignored: GA Head is fixed
    expect((await json(await (await as("head@ga1.test"))("/api/me"))).permissions).toEqual([...PERMISSIONS]);
  });

  it("a change applies on the next request, is audited, and stays inside the GA", async () => {
    const fc = await as("fc1@ga1.test");
    const mkt = await as("marketing@ga1.test");
    expect((await fc("/api/imports")).status).toBe(200);
    expect((await mkt("/api/users")).status).toBe(403);

    const res = await save({ ...DEFAULT_GRANTS, FC: [], MARKETING: [...DEFAULT_GRANTS.MARKETING, "users.manage"] });
    expect(res.status).toBe(200);

    expect((await fc("/api/imports")).status).toBe(403);
    expect((await mkt("/api/users")).status).toBe(200);
    // Granting a function never widens the data scope: Marketing still cannot hand out GA Head.
    const promote = await mkt(`/api/users/${userId("marketing@ga1.test")}`, { method: "PATCH", json: { roles: ["MARKETING", "GA_HEAD"] } });
    expect(promote.status).toBe(403);

    const audit = (await db.select().from(auditLog).where(eq(auditLog.entity, "permissions")))[0]!;
    expect(audit).toMatchObject({ tenantId: GA1.id, userId: userId("head@ga1.test"), action: "UPDATE" });
    expect(JSON.parse(audit.meta!)).toEqual({
      MARKETING: { before: DEFAULT_GRANTS.MARKETING, after: ["users.manage", "agents.view_all", "imports.upload", "imports.tenant_wide", "leads.manage", "leads.import"] },
      FC: { before: ["imports.upload", "ai.use"], after: [] },
    });

    // GA-2 keeps its own matrix.
    expect((await (await as("fc1@ga2.test"))("/api/imports")).status).toBe(200);
    expect((await db.select().from(rolePermissions).where(eq(rolePermissions.tenantId, GA2.id))).length).toBe(Object.values(DEFAULT_GRANTS).flat().length);
  });

  it("agents.edit_tree: Admin by default, and revocable", async () => {
    const admin = await as("admin@ga1.test");
    expect((await admin("/api/agents/9000004/manager", { method: "PATCH", json: { managerCode: "9000100" } })).status).toBe(200);
    await save({ ...DEFAULT_GRANTS, ADMIN: DEFAULT_GRANTS.ADMIN.filter((p) => p !== "agents.edit_tree") });
    expect((await admin("/api/agents/9000004/manager", { method: "PATCH", json: { managerCode: "9000300" } })).status).toBe(403);
  });
});
