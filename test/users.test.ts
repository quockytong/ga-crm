import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog, invitations, sessions, tenants, userRoles, users } from "../src/db/schema";
import { GA1, GA2, userId } from "../src/db/seed";
import { anon, as, db, json, seedDb, signIn } from "./helpers";

// SPEC F1.2: GA Head / Admin invites users by email, sets roles, links agent code.

const tokenOf = (inviteUrl: string) => inviteUrl.split("/invite/")[1]!;
const audit = (entityId: string) => db.select().from(auditLog).where(eq(auditLog.entityId, entityId));

async function invite(by: string, body: Record<string, unknown>) {
  return (await as(by))("/api/users/invite", { json: body });
}

beforeAll(seedDb);

describe("sign-in", () => {
  it("resolves tenant, roles and reach from the database", async () => {
    const me = await json(await (await as("gad@ga1.test"))("/api/me"));
    expect(me).toMatchObject({
      user: { email: "gad@ga1.test", agentCode: "9000900" },
      tenant: { id: GA1.id, gaCode: "GA-HCM-012" },
      reach: "DOWNLINE",
    });
    expect([...me.roles].sort()).toEqual(["BM", "GAD"]);
  });

  it("writes a LOGIN audit row and last_login_at", async () => {
    await as("fc2@ga1.test");
    const rows = await audit(userId("fc2@ga1.test"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "LOGIN", tenantId: GA1.id, userId: userId("fc2@ga1.test") });
    const user = await db.select().from(users).where(eq(users.id, userId("fc2@ga1.test"))).get();
    expect(user?.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("rejects a wrong password and has no self sign-up", async () => {
    expect((await signIn("fc1@ga1.test", "wrong-password")).ok).toBe(false);
    const res = await anon("/api/auth/sign-up/email", {
      json: { email: "intruder@x.test", password: "long-enough-password", name: "Intruder" },
    });
    expect(res.ok).toBe(false);
    expect(await db.select().from(users).where(eq(users.email, "intruder@x.test"))).toEqual([]);
  });

  it("a user cannot change their own tenant, agent code or status through the auth API", async () => {
    const fc = await as("fc4@ga1.test");
    await fc("/api/auth/update-user", { json: { tenantId: GA2.id, agentCode: "9000900", status: "ACTIVE", name: "Mới" } });
    const row = await db.select().from(users).where(eq(users.id, userId("fc4@ga1.test"))).get();
    expect(row).toMatchObject({ tenantId: GA1.id, agentCode: "9000004" });
  });
});

describe("invite", () => {
  it("creates an invited user who signs in after setting a password", async () => {
    const res = await invite("admin@ga1.test", {
      email: "  New.FC@GA1.test ",
      name: "Tư Vấn Mới",
      roles: ["FC"],
      agentCode: "0012345",
    });
    expect(res.status).toBe(201);
    const { user, inviteUrl } = await json(res);
    // Email is normalized; the agent code keeps its leading zeros.
    expect(user).toMatchObject({ email: "new.fc@ga1.test", status: "INVITED", roles: ["FC"], agentCode: "0012345" });
    expect(inviteUrl).toMatch(/^http:\/\/localhost\/invite\/[0-9a-f]{64}$/);

    // No password yet: cannot sign in.
    expect((await signIn("new.fc@ga1.test", "anything-at-all")).ok).toBe(false);

    const token = tokenOf(inviteUrl);
    expect(await json(await anon(`/api/invites/${token}`))).toEqual({
      email: "new.fc@ga1.test",
      name: "Tư Vấn Mới",
      tenantName: GA1.name,
    });
    expect((await anon("/api/invites/accept", { json: { token, password: "short" } })).status).toBe(400);
    expect((await anon("/api/invites/accept", { json: { token, password: "a-good-password-1" } })).status).toBe(200);

    const me = await json(await (await as("new.fc@ga1.test", "a-good-password-1"))("/api/me"));
    expect(me).toMatchObject({ tenant: { id: GA1.id }, roles: ["FC"], reach: "OWN", user: { agentCode: "0012345" } });

    // The link works once.
    expect((await anon(`/api/invites/${token}`)).status).toBe(404);
    expect((await anon("/api/invites/accept", { json: { token, password: "another-password-2" } })).status).toBe(404);
    expect((await signIn("new.fc@ga1.test", "another-password-2")).ok).toBe(false);

    const actions = (await audit(user.id)).map((r) => `${r.action}:${JSON.parse(r.meta ?? "{}").event ?? ""}`);
    expect(actions).toEqual(["CREATE:", "UPDATE:invite_accepted", "LOGIN:"]);
  });

  it("stores only a hash of the token", async () => {
    const { user, inviteUrl } = await json(
      await invite("head@ga1.test", { email: "hash@ga1.test", name: "Hash", roles: ["MARKETING"] }),
    );
    const rows = await db.select().from(invitations).where(eq(invitations.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(tokenOf(inviteUrl));
    expect(JSON.stringify(await audit(user.id))).not.toContain(tokenOf(inviteUrl));
  });

  it("rejects unknown, expired and malformed tokens alike", async () => {
    const { user, inviteUrl } = await json(
      await invite("head@ga1.test", { email: "late@ga1.test", name: "Trễ", roles: ["ADMIN"] }),
    );
    await db.update(invitations).set({ expiresAt: "2020-01-01T00:00:00.000Z" }).where(eq(invitations.userId, user.id));
    for (const token of [tokenOf(inviteUrl), "f".repeat(64), "x"]) {
      expect((await anon(`/api/invites/${token}`)).status).toBe(404);
    }
    const res = await anon("/api/invites/accept", { json: { token: tokenOf(inviteUrl), password: "a-good-password-1" } });
    expect(res.status).toBe(404);
  });

  it("a renewed link replaces the old one", async () => {
    const head = await as("head@ga1.test");
    const first = await json(await invite("head@ga1.test", { email: "renew@ga1.test", name: "Gia Hạn", roles: ["ADMIN"] }));
    const second = await json(await head(`/api/users/${first.user.id}/invite`, { method: "POST" }));
    expect((await anon(`/api/invites/${tokenOf(first.inviteUrl)}`)).status).toBe(404);
    expect((await anon(`/api/invites/${tokenOf(second.inviteUrl)}`)).status).toBe(200);
    // Not for users who already accepted.
    expect((await head(`/api/users/${userId("fc1@ga1.test")}/invite`, { method: "POST" })).status).toBe(409);
  });

  it("an invitation can be withdrawn, an active user cannot be deleted", async () => {
    const head = await as("head@ga1.test");
    const { user, inviteUrl } = await json(
      await invite("head@ga1.test", { email: "typo@ga1.test", name: "Sai Email", roles: ["FC"], agentCode: "0012399" }),
    );
    expect((await head(`/api/users/${user.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await head(`/api/users/${user.id}`)).status).toBe(404);
    expect((await anon(`/api/invites/${tokenOf(inviteUrl)}`)).status).toBe(404);
    expect((await audit(user.id)).map((r) => r.action)).toEqual(["CREATE", "DELETE"]);
    expect((await head(`/api/users/${userId("fc1@ga1.test")}`, { method: "DELETE" })).status).toBe(409);
  });

  it.each([
    ["agent role without agent code", { email: "a@ga1.test", name: "A", roles: ["UM"] }, 400],
    ["no roles", { email: "a@ga1.test", name: "A", roles: [] }, 400],
    ["platform role", { email: "a@ga1.test", name: "A", roles: ["PLATFORM_ADMIN"] }, 400],
    ["unknown role", { email: "a@ga1.test", name: "A", roles: ["ROOT"] }, 400],
    ["bad email", { email: "not-an-email", name: "A", roles: ["ADMIN"] }, 400],
    ["non-numeric agent code", { email: "a@ga1.test", name: "A", roles: ["FC"], agentCode: "9000/01" }, 400],
    ["email already used", { email: "fc1@ga1.test", name: "A", roles: ["ADMIN"] }, 409],
    ["agent code already linked", { email: "a@ga1.test", name: "A", roles: ["FC"], agentCode: "9000001" }, 409],
  ])("rejects %s", async (_label, body, status) => {
    expect((await invite("head@ga1.test", body)).status).toBe(status);
    expect(await db.select().from(users).where(eq(users.email, "a@ga1.test"))).toEqual([]);
  });

  it.each(["marketing@ga1.test", "gad@ga1.test", "bm1@ga1.test", "um1@ga1.test", "fc1@ga1.test"])(
    "%s cannot manage users",
    async (email) => {
      const client = await as(email);
      expect((await client("/api/users")).status).toBe(403);
      expect((await client("/api/users/invite", { json: { email: "a@ga1.test", name: "A", roles: ["ADMIN"] } })).status).toBe(403);
      expect((await client(`/api/users/${userId(email)}`, { method: "PATCH", json: { roles: ["GA_HEAD"] } })).status).toBe(403);
    },
  );
});

describe("roles", () => {
  it("a user can hold several roles; the agent code is linked to the tree", async () => {
    const head = await as("head@ga1.test");
    const id = userId("bm2@ga1.test");
    const res = await head(`/api/users/${id}`, { method: "PATCH", json: { roles: ["BM", "MARKETING", "BM"] } });
    expect(res.status).toBe(200);
    const user = await json(res);
    expect([...user.roles].sort()).toEqual(["BM", "MARKETING"]);
    expect(user).toMatchObject({ agentCode: "9000600", agentName: "Đỗ Văn Trưởng Ban" });

    const last = (await audit(id)).at(-1)!;
    expect(last.action).toBe("UPDATE");
    expect(JSON.parse(last.meta!)).toEqual({ before: { roles: ["BM"] }, after: { roles: ["BM", "MARKETING"] } });
  });

  it("an agent code that is not in the tree yet can be linked, and shows as unlinked", async () => {
    const head = await as("head@ga1.test");
    const user = await json(
      await head(`/api/users/${userId("marketing@ga1.test")}`, { method: "PATCH", json: { agentCode: "0000042" } }),
    );
    expect(user).toMatchObject({ agentCode: "0000042", agentName: null });
  });

  it("agent roles need an agent code; a code can be linked to one user only", async () => {
    const head = await as("head@ga1.test");
    const admin = userId("admin@ga1.test");
    expect((await head(`/api/users/${admin}`, { method: "PATCH", json: { roles: ["FC"] } })).status).toBe(400);
    expect((await head(`/api/users/${admin}`, { method: "PATCH", json: { agentCode: "9000001" } })).status).toBe(409);
    expect((await head(`/api/users/${userId("fc1@ga1.test")}`, { method: "PATCH", json: { agentCode: null } })).status).toBe(400);
  });

  it("an Admin cannot create, promote, edit or disable a GA Head", async () => {
    const admin = await as("admin@ga1.test");
    const head = userId("head@ga1.test");
    expect((await invite("admin@ga1.test", { email: "a@ga1.test", name: "A", roles: ["GA_HEAD"] })).status).toBe(403);
    expect((await admin(`/api/users/${userId("admin@ga1.test")}`, { method: "PATCH", json: { roles: ["ADMIN", "GA_HEAD"] } })).status).toBe(403);
    expect((await admin(`/api/users/${head}`, { method: "PATCH", json: { status: "DISABLED" } })).status).toBe(403);
    expect((await admin(`/api/users/${head}`, { method: "PATCH", json: { roles: ["ADMIN"] } })).status).toBe(403);
    const roles = await db.select().from(userRoles).where(eq(userRoles.role, "GA_HEAD"));
    expect(roles.map((r) => r.userId).sort()).toEqual([head, userId("head@ga2.test")].sort());
  });

  it("the last active GA Head cannot be removed, and nobody disables themselves", async () => {
    const head = await as("head@ga1.test");
    const id = userId("head@ga1.test");
    expect(await json(await head(`/api/users/${id}`, { method: "PATCH", json: { roles: ["ADMIN"] } }))).toEqual({ error: "last_ga_head" });
    expect(await json(await head(`/api/users/${id}`, { method: "PATCH", json: { status: "DISABLED" } }))).toEqual({ error: "cannot_disable_self" });

    // With a second GA Head, the first can step down.
    expect((await head(`/api/users/${userId("gad@ga1.test")}`, { method: "PATCH", json: { roles: ["GAD", "BM", "GA_HEAD"] } })).status).toBe(200);
    expect((await head(`/api/users/${id}`, { method: "PATCH", json: { roles: ["ADMIN"] } })).status).toBe(200);
    // ... and from then on is no longer allowed to touch GA Heads.
    expect((await head(`/api/users/${userId("gad@ga1.test")}`, { method: "PATCH", json: { roles: ["GAD", "BM"] } })).status).toBe(403);
  });
});

describe("disabling", () => {
  it("signs the user out everywhere and blocks sign-in until re-enabled", async () => {
    const boss = await as("gad@ga1.test"); // GA Head since the previous test
    const fc = await as("fc3@ga1.test");
    const id = userId("fc3@ga1.test");
    expect((await fc("/api/me")).status).toBe(200);

    expect((await boss(`/api/users/${id}`, { method: "PATCH", json: { status: "DISABLED" } })).status).toBe(200);
    expect((await fc("/api/me")).status).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toEqual([]);
    expect((await signIn("fc3@ga1.test")).ok).toBe(false);
    expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toEqual([]);

    expect((await boss(`/api/users/${id}`, { method: "PATCH", json: { status: "ACTIVE" } })).status).toBe(200);
    expect((await signIn("fc3@ga1.test")).ok).toBe(true);
  });

  it("an invited user cannot be activated without accepting the invite", async () => {
    const boss = await as("gad@ga1.test");
    const { user } = await json(await invite("gad@ga1.test", { email: "pending@ga1.test", name: "Chờ", roles: ["ADMIN"] }));
    expect((await boss(`/api/users/${user.id}`, { method: "PATCH", json: { status: "ACTIVE" } })).status).toBe(409);
  });

  it("users of a suspended tenant are locked out", async () => {
    const fc = await as("fc1@ga2.test");
    expect((await fc("/api/me")).status).toBe(200);
    await db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, GA2.id));
    expect((await fc("/api/me")).status).toBe(401);
    expect((await signIn("fc2@ga2.test")).ok).toBe(false);
    // GA-1 is not affected.
    expect((await (await as("fc1@ga1.test"))("/api/me")).status).toBe(200);
  });
});

describe("audit log", () => {
  it("is append-only", async () => {
    const row = (await db.select().from(auditLog).limit(1))[0]!;
    await expect(db.update(auditLog).set({ action: "DELETE" }).where(eq(auditLog.id, row.id))).rejects.toThrow();
    await expect(db.delete(auditLog).where(eq(auditLog.id, row.id))).rejects.toThrow();
    expect(await db.select().from(auditLog).where(and(eq(auditLog.id, row.id), eq(auditLog.action, row.action)))).toHaveLength(1);
  });

  it("every row of a tenant user carries that user's tenant", async () => {
    const rows = await db.select().from(auditLog);
    const all = await db.select().from(users);
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(r.tenantId).toBe(all.find((u) => u.id === r.userId)?.tenantId ?? null);
  });
});
