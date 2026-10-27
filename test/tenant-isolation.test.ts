import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { agents, auditLog, users } from "../src/db/schema";
import { GA1, GA1_AGENTS, GA1_USERS, GA2, GA2_AGENTS, GA2_USERS, userId } from "../src/db/seed";
import { anon, as, db, json, seedDb } from "./helpers";

// CLAUDE.md rule 1 and SPEC F1 AC: a GA-1 user gets 404 on any GA-2 record ID.

const GA1_EMAILS = GA1_USERS.map((u) => u.email);
const GA1_USER_ADMINS = ["head@ga1.test", "admin@ga1.test"];
const GA1_OTHERS = GA1_EMAILS.filter((e) => !GA1_USER_ADMINS.includes(e));
const GA2_USER_IDS = GA2_USERS.map((u) => userId(u.email));
const GA2_CODES = GA2_AGENTS.map((a) => a.code);
const SHARED_CODE = "9000001"; // exists in both tenants after beforeAll

beforeAll(async () => {
  await seedDb();
  // Natural keys are unique per tenant only: give GA-2 an agent with a GA-1 code.
  await db.insert(agents).values({
    tenantId: GA2.id,
    agentCode: SHARED_CODE,
    name: "Trùng Mã GA2",
    rank: "FC",
    managerCode: "9100100",
    path: `/9100900/9100500/9100100/${SHARED_CODE}/`,
  });
});

/** Every page of a list endpoint. */
async function all(client: Awaited<ReturnType<typeof as>>, path: string) {
  const items: any[] = [];
  for (let page = 1; ; page++) {
    const body = await json(await client(`${path}?page=${page}&pageSize=50`));
    items.push(...body.items);
    if (items.length >= body.total) return items;
  }
}

describe("GA-1 user addressing GA-2 records by ID", () => {
  it.each(GA1_USER_ADMINS)("%s gets 404 on every GA-2 user ID, for every verb", async (email) => {
    const client = await as(email);
    for (const id of GA2_USER_IDS) {
      const before = await db.select().from(users).where(eq(users.id, id)).get();
      expect((await client(`/api/users/${id}`)).status, `GET ${id}`).toBe(404);
      expect(
        (await client(`/api/users/${id}`, { method: "PATCH", json: { name: "Hacked", status: "DISABLED" } })).status,
        `PATCH ${id}`,
      ).toBe(404);
      expect((await client(`/api/users/${id}/invite`, { method: "POST" })).status, `POST invite ${id}`).toBe(404);
      expect((await client(`/api/users/${id}`, { method: "DELETE" })).status, `DELETE ${id}`).toBe(404);
      expect(await db.select().from(users).where(eq(users.id, id)).get()).toEqual(before);
    }
  });

  it.each(GA1_OTHERS)("%s cannot tell a GA-2 user ID from one that does not exist", async (email) => {
    const client = await as(email);
    const missing = await client("/api/users/no-such-user");
    expect(missing.status).toBe(403);
    for (const id of GA2_USER_IDS) {
      const res = await client(`/api/users/${id}`);
      expect(res.status).toBe(missing.status);
      expect(await res.text()).toBe(await missing.clone().text());
    }
  });

  it.each(GA1_EMAILS)("%s gets 404 on every GA-2 agent code", async (email) => {
    const client = await as(email);
    for (const code of GA2_CODES) {
      expect((await client(`/api/agents/${code}`)).status, code).toBe(404);
    }
  });

  it("GA-1 Head gets 404 changing the manager of a GA-2 agent", async () => {
    const head = await as("head@ga1.test");
    for (const code of GA2_CODES) {
      const res = await head(`/api/agents/${code}/manager`, { method: "PATCH", json: { managerCode: null } });
      expect(res.status).toBe(404);
    }
    const ga2 = await db.select().from(agents).where(eq(agents.tenantId, GA2.id));
    expect(ga2.filter((a) => a.managerCode === null).map((a) => a.agentCode)).toEqual(["9100900"]);
  });

  it("a GA-2 agent cannot be used as manager of a GA-1 agent", async () => {
    const head = await as("head@ga1.test");
    const res = await head("/api/agents/9000002/manager", { method: "PATCH", json: { managerCode: "9100100" } });
    const unknown = await head("/api/agents/9000002/manager", { method: "PATCH", json: { managerCode: "7777777" } });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual(await json(unknown));
    expect((await json(await head("/api/agents/9000002"))).managerCode).toBe("9000100");
  });

  it("works the same in the other direction (GA-2 user, GA-1 IDs)", async () => {
    const head2 = await as("head@ga2.test");
    for (const u of GA1_USERS) expect((await head2(`/api/users/${userId(u.email)}`)).status).toBe(404);
    for (const a of GA1_AGENTS.filter((a) => a.code !== SHARED_CODE)) {
      expect((await head2(`/api/agents/${a.code}`)).status).toBe(404);
    }
  });
});

describe("lists never contain rows of another tenant", () => {
  it.each(GA1_USER_ADMINS)("user list of %s", async (email) => {
    const items = await all(await as(email), "/api/users");
    expect(items.map((u) => u.email).sort()).toEqual([...GA1_EMAILS].sort());
  });

  it.each(GA1_EMAILS)("agent list and tree of %s", async (email) => {
    const client = await as(email);
    const ga1Codes = GA1_AGENTS.map((a) => a.code);
    const tree = (await json(await client("/api/agents/tree"))).items;
    const list = await all(client, "/api/agents");
    for (const a of [...tree, ...list]) {
      expect(ga1Codes).toContain(a.agentCode);
      expect(a.name).not.toBe("Trùng Mã GA2");
    }
  });

  it("search does not reach into another tenant", async () => {
    const head = await as("head@ga1.test");
    expect((await json(await head("/api/users?q=ga2.test"))).total).toBe(0);
    expect((await json(await head("/api/agents?q=Mai"))).total).toBe(0);
    expect((await json(await head("/api/agents?q=9100"))).total).toBe(0);
  });
});

describe("the same natural key in two tenants", () => {
  it("resolves to the caller's own tenant", async () => {
    const ga1 = await json(await (await as("head@ga1.test"))(`/api/agents/${SHARED_CODE}`));
    const ga2 = await json(await (await as("head@ga2.test"))(`/api/agents/${SHARED_CODE}`));
    expect(ga1).toMatchObject({ name: "Nguyễn Thị Demo", managerCode: "9000100" });
    expect(ga2).toMatchObject({ name: "Trùng Mã GA2", managerCode: "9100100" });
  });

  it("changing it in one tenant leaves the other untouched", async () => {
    const head2 = await as("head@ga2.test");
    const res = await head2(`/api/agents/${SHARED_CODE}/manager`, { method: "PATCH", json: { managerCode: "9100500" } });
    expect(res.status).toBe(200);
    const ga1 = await json(await (await as("head@ga1.test"))(`/api/agents/${SHARED_CODE}`));
    expect(ga1).toMatchObject({ managerCode: "9000100", path: "/9000900/9000500/9000100/9000001/" });
  });

  it("an agent code linked to a GA-2 user is still free in GA-1", async () => {
    const head = await as("head@ga1.test");
    const res = await head("/api/users/invite", {
      json: { email: "same-code@ga1.test", name: "Cùng Mã", roles: ["FC"], agentCode: "9100001" },
    });
    expect(res.status).toBe(201);
  });
});

describe("the tenant comes from the session, never from the request", () => {
  it("ignores a tenant id sent in the body, query or headers", async () => {
    const admin = await as("admin@ga1.test");
    const res = await admin(`/api/users/invite?tenantId=${GA2.id}&tenant_id=${GA2.id}`, {
      json: { email: "new@ga1.test", name: "Người Mới", roles: ["MARKETING"], tenantId: GA2.id, tenant_id: GA2.id },
      headers: { "x-tenant-id": GA2.id },
    });
    expect(res.status).toBe(201);
    const row = await db.select().from(users).where(eq(users.email, "new@ga1.test")).get();
    expect(row?.tenantId).toBe(GA1.id);
    expect((await json(await (await as("head@ga2.test"))("/api/users?q=new@ga1.test"))).total).toBe(0);
  });

  it("requires a session", async () => {
    for (const path of ["/api/me", "/api/users", "/api/agents", "/api/agents/tree", "/api/platform/tenants"]) {
      expect((await anon(path)).status, path).toBe(401);
    }
  });
});

describe("Platform Admin", () => {
  it("has no tenant: tenant endpoints refuse", async () => {
    const platform = await as("platform@dlvn.test");
    for (const path of ["/api/users", "/api/agents", "/api/agents/tree", `/api/users/${GA2_USER_IDS[0]}`]) {
      expect((await platform(path)).status, path).toBe(403);
    }
  });

  it("every look into a tenant writes CROSS_TENANT_READ", async () => {
    const platform = await as("platform@dlvn.test");
    const res = await platform(`/api/platform/tenants/${GA2.id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.users.items.every((u: any) => u.email.endsWith("@ga2.test"))).toBe(true);
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "CROSS_TENANT_READ"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: GA2.id, userId: userId("platform@dlvn.test"), entity: "tenant" });
  });

  it.each(GA1_EMAILS)("%s cannot use platform endpoints", async (email) => {
    const client = await as(email);
    expect((await client("/api/platform/tenants")).status).toBe(403);
    expect((await client(`/api/platform/tenants/${GA2.id}`)).status).toBe(403);
    expect(
      (await client("/api/platform/tenants", { json: { gaCode: "GA-X-1", name: "X", head: { email: "x@x.test", name: "X" } } })).status,
    ).toBe(403);
  });
});
