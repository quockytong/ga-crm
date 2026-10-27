import { asc } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { agents, userRoles, users } from "../src/db/schema";
import { GA1, GA1_AGENTS, userId } from "../src/db/seed";
import type { Actor } from "../src/server/env";
import { ownedBy, reachOf, scopeOf } from "../src/server/scope";
import type { Role } from "../src/shared/enums";
import { as, db, json, seedDb } from "./helpers";

// CLAUDE.md rule 2 and SPEC F1 AC: a UM sees data of FCs below them and not of a peer UM.
//
// GA-1 tree:                9000900 (GAD)
//                    9000500 (BM)        9000600 (BM)
//             9000100 (UM)  9000200 (UM)   9000300 (UM)
//          9000001 9000002    9000003        9000004      (FC)

const ALL = GA1_AGENTS.map((a) => a.code).sort();

/** Agent-owned data each user may see, by owning agent code. */
const OWNED: Record<string, string[]> = {
  "fc1@ga1.test": ["9000001"],
  "fc3@ga1.test": ["9000003"],
  "um1@ga1.test": ["9000001", "9000002", "9000100"],
  "um2@ga1.test": ["9000003", "9000200"],
  "um3@ga1.test": ["9000004", "9000300"],
  "bm1@ga1.test": ["9000001", "9000002", "9000003", "9000100", "9000200", "9000500"],
  "bm2@ga1.test": ["9000004", "9000300", "9000600"],
  "gad@ga1.test": ALL,
  "head@ga1.test": ALL,
  "marketing@ga1.test": [],
  "admin@ga1.test": [],
};

/** The agent directory is wider for Marketing (assignee picker) and Admin (user linking). */
const DIRECTORY: Record<string, string[]> = { ...OWNED, "marketing@ga1.test": ALL, "admin@ga1.test": ALL };

async function actor(email: string): Promise<Actor> {
  const u = (await db.select().from(users)).find((x) => x.email === email)!;
  const roles = (await db.select().from(userRoles)).filter((r) => r.userId === u.id).map((r) => r.role);
  return { userId: u.id, tenantId: u.tenantId, email, name: u.name, agentCode: u.agentCode, roles, permissions: [] };
}

/** Codes of agents selected through the scope layer, standing in for any agent-owned table. */
async function ownedCodes(email: string) {
  const rows = await db
    .select({ code: agents.agentCode })
    .from(agents)
    .where(ownedBy(scopeOf(await actor(email)), agents, agents.agentCode))
    .orderBy(asc(agents.agentCode));
  return rows.map((r) => r.code);
}

async function treeCodes(email: string) {
  const body = await json(await (await as(email))("/api/agents/tree"));
  return body.items.map((a: any) => a.agentCode).sort();
}

beforeAll(seedDb);

describe("reachOf", () => {
  it.each<[Role[], string | null, string]>([
    [["FC"], "1", "OWN"],
    [["UM"], "1", "DOWNLINE"],
    [["BM"], "1", "DOWNLINE"],
    [["GAD", "BM"], "1", "DOWNLINE"],
    [["FC", "UM"], "1", "DOWNLINE"],
    [["GA_HEAD"], null, "TENANT"],
    [["GA_HEAD", "FC"], "1", "TENANT"],
    [["MARKETING"], null, "NONE"],
    [["ADMIN"], null, "NONE"],
    [["MARKETING", "FC"], "1", "OWN"],
    [["UM"], null, "NONE"],
    [[], "1", "NONE"],
  ])("%j with agent code %j reaches %s", (roles, code, reach) => {
    expect(reachOf(roles, code)).toBe(reach);
  });
});

describe("ownedBy (scope layer)", () => {
  it.each(Object.entries(OWNED))("%s sees agent-owned rows of %j", async (email, expected) => {
    expect(await ownedCodes(email)).toEqual(expected);
  });

  it("a UM sees the FCs below them and not a peer UM or the peer's FCs", async () => {
    const um1 = await ownedCodes("um1@ga1.test");
    expect(um1).toEqual(expect.arrayContaining(["9000001", "9000002"]));
    for (const peer of ["9000200", "9000003", "9000300", "9000004"]) expect(um1).not.toContain(peer);
    // ... and nothing above them either.
    for (const upline of ["9000500", "9000900"]) expect(um1).not.toContain(upline);
  });

  it("a manager whose agent code is not in the tree yet still sees only their own rows", async () => {
    const ghost: Actor = { ...(await actor("um1@ga1.test")), agentCode: "5555555" };
    const rows = await db.select().from(agents).where(ownedBy(scopeOf(ghost), agents, agents.agentCode));
    expect(rows).toEqual([]);
  });

  it("does not treat an agent code as a pattern", async () => {
    // "90001" is a substring of several paths but is not a path segment.
    for (const code of ["90001", "%", "_______", "900010", "/"]) {
      const odd: Actor = { ...(await actor("um1@ga1.test")), agentCode: code };
      const rows = await db.select().from(agents).where(ownedBy(scopeOf(odd), agents, agents.agentCode));
      expect(rows, code).toEqual([]);
    }
  });

  it("a user without a tenant has no scope at all", async () => {
    expect(() => scopeOf({ ...({} as Actor), tenantId: null, roles: ["PLATFORM_ADMIN"] })).toThrow();
  });
});

describe("agents API", () => {
  it.each(Object.entries(DIRECTORY))("%s sees %j in the tree", async (email, expected) => {
    expect(await treeCodes(email)).toEqual(expected);
  });

  it.each(Object.entries(DIRECTORY))("%s gets 200 inside and 404 outside the scope, by code", async (email, expected) => {
    const client = await as(email);
    for (const code of ALL) {
      expect((await client(`/api/agents/${code}`)).status, code).toBe(expected.includes(code) ? 200 : 404);
    }
  });

  it("the paginated list is scoped and counted the same way", async () => {
    for (const [email, expected] of Object.entries(DIRECTORY)) {
      const body = await json(await (await as(email))("/api/agents?pageSize=50"));
      expect(body.total, email).toBe(expected.length);
      expect(body.items.map((a: any) => a.agentCode).sort(), email).toEqual(expected);
    }
  });

  it("scope cannot be widened from the client", async () => {
    const um1 = await as("um1@ga1.test");
    const body = await json(
      await um1("/api/agents?agentCode=9000900&reach=TENANT&roles=GA_HEAD&q=", {
        headers: { "x-agent-code": "9000900", "x-roles": "GA_HEAD" },
      }),
    );
    expect(body.items.map((a: any) => a.agentCode).sort()).toEqual(DIRECTORY["um1@ga1.test"]);
  });

  it("without agents.edit_tree (by default everyone but GA Head and Admin) a manager link cannot be changed", async () => {
    for (const email of Object.keys(DIRECTORY).filter((e) => e !== "head@ga1.test" && e !== "admin@ga1.test")) {
      const res = await (await as(email))("/api/agents/9000001/manager", {
        method: "PATCH",
        json: { managerCode: "9000200" },
      });
      expect(res.status, email).toBe(403);
    }
  });
});

// These change the seeded tree and roles; keep them last.
describe("scope follows the tree and the roles in the database", () => {
  it("moving an FC to another UM moves who can see it", async () => {
    const head = await as("head@ga1.test");
    const res = await head("/api/agents/9000003/manager", { method: "PATCH", json: { managerCode: "9000100" } });
    expect(res.status).toBe(200);

    expect(await ownedCodes("um1@ga1.test")).toEqual(["9000001", "9000002", "9000003", "9000100"]);
    expect(await ownedCodes("um2@ga1.test")).toEqual(["9000200"]);
    expect(await treeCodes("um2@ga1.test")).toEqual(["9000200"]);
    expect((await (await as("um2@ga1.test"))("/api/agents/9000003")).status).toBe(404);
    // Still below the same BM.
    expect(await ownedCodes("bm1@ga1.test")).toEqual(OWNED["bm1@ga1.test"]);
  });

  it("moving a whole unit to another BM moves its FCs too", async () => {
    const head = await as("head@ga1.test");
    await head("/api/agents/9000100/manager", { method: "PATCH", json: { managerCode: "9000600" } });
    expect(await ownedCodes("bm1@ga1.test")).toEqual(["9000200", "9000500"]);
    expect(await ownedCodes("bm2@ga1.test")).toEqual(
      ["9000001", "9000002", "9000003", "9000004", "9000100", "9000300", "9000600"],
    );
  });

  it("a role change applies on the very next request", async () => {
    const um1 = await as("um1@ga1.test");
    expect((await json(await um1("/api/me"))).reach).toBe("DOWNLINE");

    const head = await as("head@ga1.test");
    const res = await head(`/api/users/${userId("um1@ga1.test")}`, { method: "PATCH", json: { roles: ["FC"] } });
    expect(res.status).toBe(200);

    expect((await json(await um1("/api/me"))).reach).toBe("OWN");
    expect(await treeCodes("um1@ga1.test")).toEqual(["9000100"]);
    expect((await um1("/api/agents/9000001")).status).toBe(404);
  });

  it("rows of the tenant are untouched for the other tenant's tree", async () => {
    const rows = await db.select().from(agents);
    expect(rows.filter((a) => a.tenantId !== GA1.id).every((a) => a.path.startsWith("/9100900/"))).toBe(true);
  });
});
