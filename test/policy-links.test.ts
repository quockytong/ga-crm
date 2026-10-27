import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { agents, clients, policies, policyAgents, policyClients, recordChanges, users, userRoles } from "../src/db/schema";
import { GA1, userId } from "../src/db/seed";
import type { Actor } from "../src/server/env";
import { clientInScope, policyInScope, scopeOf } from "../src/server/scope";
import { as, db, json, seedDb } from "./helpers";
import { agent, book, client, policy, preview, product, run } from "./import-helpers";

// Policies linked to all their agents (servicing + shares) and to their clients (PO, LI, BEN),
// with a field-level history of every change an import makes.
//
// GA-1: 9000100 (UM1) > 9000001, 9000002 ; 9000200 (UM2) > 9000003 ; 9000300 (UM3) > 9000004

beforeAll(seedDb);

async function actor(email: string): Promise<Actor> {
  const u = (await db.select().from(users)).find((x) => x.email === email)!;
  const roles = (await db.select().from(userRoles)).filter((r) => r.userId === u.id).map((r) => r.role);
  return { userId: u.id, tenantId: u.tenantId, email, name: u.name, agentCode: u.agentCode, roles, permissions: [] };
}
const visiblePolicies = async (email: string) =>
  (await db.select({ no: policies.policyNo }).from(policies).where(and(eq(policies.tenantId, GA1.id), policyInScope(scopeOf(await actor(email)), policies.policyNo)))).map((p) => p.no).sort();
const visibleClients = async (email: string) =>
  (await db.select({ code: clients.clientCode }).from(clients).where(and(eq(clients.tenantId, GA1.id), clientInScope(scopeOf(await actor(email)), clients.clientCode)))).map((c) => c.code).sort();
const linksOf = async (policyNo: string) =>
  (await db.select().from(policyAgents).where(eq(policyAgents.policyNo, policyNo)).orderBy(asc(policyAgents.agentCode))).map(
    (l) => `${l.agentCode}:${l.splitPercent}:${l.isServicing ? "S" : "-"}:${l.endedAt ? "ended" : "active"}`,
  );
const history = async (key: string) =>
  (await db.select().from(recordChanges).where(eq(recordChanges.entityKey, key)).orderBy(asc(recordChanges.changedAt), asc(recordChanges.field))).map(
    (r) => `${r.field}: ${r.oldValue} -> ${r.newValue}`,
  );

const P = { "Số HĐBH": "009000200", "Mã KH BMBH": "0000000200", "Mã NĐBH chính": "0000000201" };

describe("a policy split between agents", () => {
  it("each FC's own export adds their link and share; the others keep theirs", async () => {
    const first = await run(
      await as("fc1@ga1.test"),
      book({
        "02_Clients": [client({ "Mã Khách Hàng": "0000000200", "Bên Mua BH": "Khách Chia" })],
        "03_Policies": [policy({ ...P, "Mã đại lý": "9000001", "Tỉ lệ chia": "60%" })],
      }),
    );
    expect(first.errors).toEqual([]);
    expect(await linksOf("009000200")).toEqual(["9000001:60:S:active"]);

    const second = await run(await as("fc3@ga1.test"), book({ "03_Policies": [policy({ ...P, "Mã đại lý": "9000003", "Tỉ lệ chia": "40%" })] }));
    expect(second.errors).toEqual([]);
    expect(await linksOf("009000200")).toEqual(["9000001:60:S:active", "9000003:40:-:active"]);
    expect(await db.select().from(policies).where(eq(policies.policyNo, "009000200"))).toMatchObject([{ servicingAgentCode: "9000001" }]);
    expect(await history("009000200")).toEqual(["agents: 9000001:60 -> 9000001:60;9000003:40"]);
  });

  it("is visible to both agents (each sees both shares) and their managers, not to others", async () => {
    for (const email of ["fc1@ga1.test", "fc3@ga1.test", "um1@ga1.test", "um2@ga1.test", "bm1@ga1.test", "head@ga1.test"]) {
      expect(await visiblePolicies(email), email).toContain("009000200");
    }
    for (const email of ["fc2@ga1.test", "fc4@ga1.test", "um3@ga1.test", "marketing@ga1.test"]) {
      expect(await visiblePolicies(email), email).not.toContain("009000200");
    }
  });

  it("its clients are visible through the policy, whatever their role", async () => {
    const roles = (await db.select().from(policyClients).where(eq(policyClients.policyNo, "009000200"))).map((l) => `${l.clientCode}:${l.role}`).sort();
    expect(roles).toEqual(["0000000200:PO", "0000000201:LI"]);
    await db.insert(clients).values({ tenantId: GA1.id, clientCode: "0000000201", name: "Người Được Bảo Hiểm", nameNorm: "NGUOI DUOC BAO HIEM" });
    // The LI is visible to the sharing agent fc3 although fc3 never uploaded that client.
    expect(await visibleClients("fc3@ga1.test")).toEqual(expect.arrayContaining(["0000000200", "0000000201"]));
    expect(await visibleClients("fc4@ga1.test")).not.toContain("0000000201");
  });

  it("an FC cannot write another agent's share, nor push the total over 100%", async () => {
    const outside = await run(await as("fc1@ga1.test"), book({ "03_Policies": [policy({ ...P, "Mã đại lý": "9000004", "Tỉ lệ chia": "10%" })] }));
    expect(outside.errors.map((e) => e.code)).toEqual(["out_of_scope"]);
    const over = await run(await as("fc4@ga1.test"), book({ "03_Policies": [policy({ ...P, "Mã đại lý": "9000004", "Tỉ lệ chia": "30%" })] }));
    expect(over.errors.map((e) => `${e.code}:${e.severity}`)).toEqual(["split_total:error"]);
    expect(await linksOf("009000200")).toEqual(["9000001:60:S:active", "9000003:40:-:active"]);
  });

  it("GA data must list every agent of a policy with shares adding up to 100%", async () => {
    const mkt = await as("marketing@ga1.test");
    const bad = await run(
      mkt,
      book({
        "03_Policies": [
          policy({ "Số HĐBH": "009000220", "Mã đại lý": "9000001", "Tỉ lệ chia": "60%" }),
          policy({ "Số HĐBH": "009000220", "Mã đại lý": "9000002", "Tỉ lệ chia": "30%" }),
          policy({ "Số HĐBH": "009000221", "Mã đại lý": "9000002", "Tỉ lệ chia": "70%" }),
          policy({ "Số HĐBH": "009000222", "Mã đại lý": "9000004", "Tỉ lệ chia": "100%" }),
          policy({ "Số HĐBH": "009000223", "Mã đại lý": "9000004" }),
        ],
      }),
    );
    expect(bad.errors.map((e) => `${e.row}:${e.code}`)).toEqual(["2:split_total", "3:split_total", "4:split_total"]);
    expect(bad.imp.sheets["03_Policies"]).toMatchObject({ found: 5, inserted: 2, rejected: 3 });
    expect(await linksOf("009000222")).toEqual(["9000004:100:S:active"]);
    expect(await linksOf("009000223")).toEqual(["9000004:100:S:active"]);
  });

  it("the same agent twice for one policy is rejected", async () => {
    const { errors } = await run(
      await as("um1@ga1.test"),
      book({
        "03_Policies": [
          policy({ "Số HĐBH": "009000230", "Mã đại lý": "9000001", "Tỉ lệ chia": "60%" }),
          policy({ "Số HĐBH": "009000230", "Mã đại lý": "9000002", "Tỉ lệ chia": "30%" }),
          policy({ "Số HĐBH": "009000230", "Mã đại lý": "9000002", "Tỉ lệ chia": "10%" }),
        ],
      }),
    );
    expect(errors.map((e) => `${e.row}:${e.code}`)).toEqual(["4:duplicate_key"]);
  });
});

describe("a change of servicing agent (transfer)", () => {
  it("one agent with 100% is the complete picture: accepted, warned in the preview, and logged", async () => {
    const fc3 = await as("fc3@ga1.test");
    const { imp, errors } = await preview(fc3, book({ "03_Policies": [policy({ ...P, "Mã đại lý": "9000003", "Tỉ lệ chia": "100%" })] }));
    expect(errors).toMatchObject([{ row: 2, code: "servicing_changed", severity: "warning" }]);
    expect(imp.sheets["03_Policies"]).toMatchObject({ updated: 1, rejected: 0, warnings: 1 });
    await fc3(`/api/imports/${imp.id}/commit`, { method: "POST" });

    expect(await db.select().from(policies).where(eq(policies.policyNo, "009000200"))).toMatchObject([{ servicingAgentCode: "9000003" }]);
    expect(await linksOf("009000200")).toEqual(["9000001:60:-:ended", "9000003:100:S:active"]);
    expect((await history("009000200")).slice(1)).toEqual([
      "agents: 9000001:60;9000003:40 -> 9000003:100",
      "servicing_agent_code: 9000001 -> 9000003",
    ]);
    const logged = (await db.select().from(recordChanges).where(and(eq(recordChanges.entityKey, "009000200"), eq(recordChanges.importId, imp.id))))[0]!;
    expect(logged).toMatchObject({ entity: "policy", changedBy: userId("fc3@ga1.test") });

    // The former agent and their UM lose the policy; the new one keeps it.
    expect(await visiblePolicies("fc1@ga1.test")).not.toContain("009000200");
    expect(await visiblePolicies("um1@ga1.test")).not.toContain("009000200");
    expect(await visiblePolicies("fc3@ga1.test")).toContain("009000200");
  });

  it("GA data brings an ended link back; on a tie the current servicing agent stays", async () => {
    await run(
      await as("marketing@ga1.test"),
      book({
        "03_Policies": [
          policy({ ...P, "Mã đại lý": "9000001", "Tỉ lệ chia": "50%" }),
          policy({ ...P, "Mã đại lý": "9000003", "Tỉ lệ chia": "50%" }),
        ],
      }),
    );
    expect(await linksOf("009000200")).toEqual(["9000001:50:-:active", "9000003:50:S:active"]);
    expect(await visiblePolicies("fc1@ga1.test")).toContain("009000200");
  });
});

describe("history of other records", () => {
  it("logs each changed column of a client, product and holder, not unchanged ones", async () => {
    const fc1 = await as("fc1@ga1.test");
    await run(fc1, book({
      "02_Clients": [client({ "Mã Khách Hàng": "0000000200", "Bên Mua BH": "Khách Chia", "Nhóm Khách Hàng": "Vàng" })],
      "04_Policy_Products": [product({ "Số HĐBH": "009000200", "Mã NĐBH": "0000000201", "Phí năm": 15000000 })],
    }));
    await run(fc1, book({
      "02_Clients": [client({ "Mã Khách Hàng": "0000000200", "Bên Mua BH": "Khách Chia", "Nhóm Khách Hàng": "Kim Cương" })],
      "04_Policy_Products": [product({ "Số HĐBH": "009000200", "Mã NĐBH": "0000000201", "Phí năm": 16000000 })],
    }));
    expect(await history("0000000200")).toEqual(["tier: Bạc -> Vàng", "tier: Vàng -> Kim Cương"]);
    expect(await history("009000200|TMP_ASHTV|0000000201")).toEqual(["annual_premium_vnd: 15000000 -> 16000000"]);
  });

  it("a new policyholder ends the old PO link and is logged", async () => {
    await run(await as("fc3@ga1.test"), book({ "03_Policies": [policy({ ...P, "Mã KH BMBH": "0000000202", "Mã đại lý": "9000003", "Tỉ lệ chia": "50%" })] }));
    const links = (await db.select().from(policyClients).where(eq(policyClients.policyNo, "009000200"))).map((l) => `${l.clientCode}:${l.role}:${l.endedAt ? "ended" : "active"}`).sort();
    expect(links).toEqual(["0000000200:PO:ended", "0000000201:LI:active", "0000000202:PO:active"]);
    expect(await history("009000200")).toContain("holder_client_code: 0000000200 -> 0000000202");
  });

  it("a manual manager fix is in the agent's history", async () => {
    await (await as("head@ga1.test"))("/api/agents/9000002/manager", { method: "PATCH", json: { managerCode: "9000200" } });
    expect(await history("9000002")).toEqual(["manager_code: 9000100 -> 9000200"]);
  });
});

describe("agent tree edits by GA Head and Admin", () => {
  it("an agent created by an FC's own upload can be moved by the Admin", async () => {
    // A brand-new FC whose agent row does not exist yet uploads their own row.
    await db.insert(users).values({ id: "user-new-fc", tenantId: GA1.id, email: "newfc@ga1.test", name: "FC Mới", agentCode: "9000555", status: "ACTIVE", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(userRoles).values({ userId: "user-new-fc", role: "FC" });
    const { accounts } = await import("../src/db/schema");
    const seeded = (await db.select().from(accounts))[0]!;
    await db.insert(accounts).values({ ...seeded, id: "acc-new-fc", userId: "user-new-fc", accountId: "user-new-fc" });

    const { errors } = await run(await as("newfc@ga1.test"), book({ "01_Agents": [agent("9000555", "FC Mới", "FC", "UM: 9000300-Hồ Văn Quản Lý")] }));
    expect(errors).toEqual([]);
    expect((await db.select().from(agents).where(eq(agents.agentCode, "9000555")))[0]).toMatchObject({ managerCode: "9000300", path: "/9000900/9000600/9000300/9000555/" });

    const res = await (await as("admin@ga1.test"))("/api/agents/9000555/manager", { method: "PATCH", json: { managerCode: "9000100" } });
    expect(await json(res)).toMatchObject({ agentCode: "9000555", managerCode: "9000100" });
    expect((await db.select().from(agents).where(eq(agents.agentCode, "9000555")))[0]).toMatchObject({ managerFixed: true, path: "/9000900/9000500/9000100/9000555/" });
  });
});

describe("records to fix and import again", () => {
  it("lists each rejected row once, with its record key and reasons", async () => {
    const { imp } = await run(
      await as("fc1@ga1.test"),
      book({
        "02_Clients": [client({ "Mã Khách Hàng": "123" }), client({ "Mã Khách Hàng": "0000000300", "Nhóm Khách Hàng": "Bạch Kim" })],
        "03_Policies": [
          policy({ "Số HĐBH": "009000300", "Mã đại lý": "9000004", "Ngày hiệu lực": "31/02/2025" }),
          policy({ "Số HĐBH": "009000301" }),
        ],
      }),
    );
    const res = await json(await (await as("fc1@ga1.test"))(`/api/imports/${imp.id}/rejected`));
    expect(res.total).toBe(3);
    expect(res.items).toEqual([
      { sheet: "02_Clients", row: 2, recordKey: "123", codes: ["invalid_key_client"] },
      { sheet: "02_Clients", row: 3, recordKey: "0000000300", codes: ["invalid_list"] },
      { sheet: "03_Policies", row: 2, recordKey: "009000300|9000004", codes: ["invalid_date"] },
    ]);
    expect(res.bySheet).toEqual([
      { sheet: "02_Clients", code: "invalid_key_client", rows: 1 },
      { sheet: "02_Clients", code: "invalid_list", rows: 1 },
      { sheet: "03_Policies", code: "invalid_date", rows: 1 },
    ]);
    // The GA Head can see it; another FC cannot.
    expect((await (await as("head@ga1.test"))(`/api/imports/${imp.id}/rejected`)).status).toBe(200);
    expect((await (await as("fc2@ga1.test"))(`/api/imports/${imp.id}/rejected`)).status).toBe(404);
  });
});
