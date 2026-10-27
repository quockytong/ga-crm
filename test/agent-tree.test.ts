import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { agents, auditLog } from "../src/db/schema";
import { GA1, GA2, userId } from "../src/db/seed";
import { computePaths, rebuildAgentPaths } from "../src/server/agent-tree";
import { as, db, json, seedDb } from "./helpers";

// SPEC F1.3: the agent tree, and the GA Head fixing a manager link by hand (audited).

const n = (agentCode: string, managerCode: string | null) => ({ agentCode, managerCode });
const pathsOf = (nodes: ReturnType<typeof n>[]) => Object.fromEntries(computePaths(nodes).paths);

describe("computePaths", () => {
  it("builds /root/.../self/ regardless of input order", () => {
    expect(pathsOf([n("3", "2"), n("1", null), n("2", "1"), n("4", "1")])).toEqual({
      "1": "/1/",
      "2": "/1/2/",
      "3": "/1/2/3/",
      "4": "/1/4/",
    });
  });

  it("keeps leading zeros", () => {
    expect(pathsOf([n("0000007", "0000001"), n("0000001", null)])).toEqual({
      "0000001": "/0000001/",
      "0000007": "/0000001/0000007/",
    });
  });

  it("treats an agent whose manager is not loaded as a root", () => {
    expect(pathsOf([n("2", "1"), n("3", "2")])).toEqual({ "2": "/2/", "3": "/2/3/" });
  });

  it("cuts cycles loose and reports them", () => {
    const { paths, cycles } = computePaths([n("1", "3"), n("2", "1"), n("3", "2"), n("4", "3"), n("5", "5"), n("6", null)]);
    expect([...cycles].sort()).toEqual(["1", "2", "3", "5"]);
    expect(Object.fromEntries(paths)).toEqual({
      "1": "/1/",
      "2": "/2/",
      "3": "/3/",
      "4": "/3/4/",
      "5": "/5/",
      "6": "/6/",
    });
  });

  it("handles a deep chain", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => n(String(i), i === 0 ? null : String(i - 1)));
    expect(computePaths(nodes.reverse()).paths.get("4999")!.split("/").length).toBe(5002);
  });
});

describe("with seeded tenants", () => {
  beforeAll(seedDb);

  const agent = async (tenantId: string, code: string) =>
    (await db.select().from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.agentCode, code))).get())!;

  it("rebuildAgentPaths repairs stale paths of one tenant only", async () => {
    await db.update(agents).set({ path: "/stale/" });
    expect(await rebuildAgentPaths(db, GA1.id)).toEqual({ updated: 10, cycles: [] });
    expect((await agent(GA1.id, "9000001")).path).toBe("/9000900/9000500/9000100/9000001/");
    expect((await agent(GA2.id, "9100001")).path).toBe("/stale/");
    expect((await rebuildAgentPaths(db, GA2.id)).updated).toBe(5);
    expect((await rebuildAgentPaths(db, GA1.id)).updated).toBe(0);
  });

  it("GA Head moves a unit: paths of the whole subtree follow, and the change is audited", async () => {
    const head = await as("head@ga1.test");
    const res = await head("/api/agents/9000100/manager", { method: "PATCH", json: { managerCode: "9000600" } });
    expect(await json(res)).toEqual({ agentCode: "9000100", managerCode: "9000600", updated: 3 });

    expect((await agent(GA1.id, "9000100")).path).toBe("/9000900/9000600/9000100/");
    expect((await agent(GA1.id, "9000001")).path).toBe("/9000900/9000600/9000100/9000001/");
    expect((await agent(GA1.id, "9000002")).path).toBe("/9000900/9000600/9000100/9000002/");
    expect((await agent(GA1.id, "9000003")).path).toBe("/9000900/9000500/9000200/9000003/");

    const rows = await db.select().from(auditLog).where(eq(auditLog.entity, "agent"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "UPDATE",
      tenantId: GA1.id,
      userId: userId("head@ga1.test"),
      entityId: "9000100",
    });
    expect(JSON.parse(rows[0]!.meta!)).toEqual({ field: "managerCode", before: "9000500", after: "9000600" });
  });

  it("refuses a manager that is the agent itself or someone below it", async () => {
    const head = await as("head@ga1.test");
    for (const managerCode of ["9000600", "9000300", "9000004", "9000100", "9000001"]) {
      const res = await head("/api/agents/9000600/manager", { method: "PATCH", json: { managerCode } });
      expect(await json(res), managerCode).toEqual({ error: "manager_cycle" });
    }
    expect((await agent(GA1.id, "9000600")).managerCode).toBe("9000900");
    expect(await db.select().from(auditLog).where(eq(auditLog.entity, "agent"))).toHaveLength(1);
  });

  it("refuses an unknown manager and an unknown agent", async () => {
    const head = await as("head@ga1.test");
    expect(await json(await head("/api/agents/9000001/manager", { method: "PATCH", json: { managerCode: "1234567" } }))).toEqual({ error: "manager_not_found" });
    expect((await head("/api/agents/1234567/manager", { method: "PATCH", json: { managerCode: null } })).status).toBe(404);
    expect((await head("/api/agents/9000001/manager", { method: "PATCH", json: { managerCode: 9000200 } })).status).toBe(400);
  });

  it("an agent can be made a root; setting the same manager again changes and audits nothing", async () => {
    const head = await as("head@ga1.test");
    const res = await head("/api/agents/9000200/manager", { method: "PATCH", json: { managerCode: null } });
    expect(res.status).toBe(200);
    expect((await agent(GA1.id, "9000200")).path).toBe("/9000200/");
    expect((await agent(GA1.id, "9000003")).path).toBe("/9000200/9000003/");

    const again = await head("/api/agents/9000200/manager", { method: "PATCH", json: { managerCode: null } });
    expect((await json(again)).updated).toBe(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.entity, "agent"))).toHaveLength(2);
  });

  it("the tree response lists parents before children and hides personal fields", async () => {
    await db.update(agents).set({ phone: "0900000000", dob: "1990-01-01" }).where(eq(agents.tenantId, GA1.id));
    const { items } = await json(await (await as("head@ga1.test"))("/api/agents/tree"));
    const seen = new Set<string>();
    for (const a of items) {
      if (a.managerCode) expect(seen.has(a.managerCode), `${a.managerCode} before ${a.agentCode}`).toBe(true);
      seen.add(a.agentCode);
      expect(a).not.toHaveProperty("phone");
      expect(a).not.toHaveProperty("dob");
    }
    expect(items).toHaveLength(10);
  });
});
