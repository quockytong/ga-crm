import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog, tenants, users } from "../src/db/schema";
import { GA1, userId } from "../src/db/seed";
import { anon, as, db, json, seedDb } from "./helpers";

// SPEC F1.1: Platform Admin creates a tenant (GA code, name) and the first GA Head user.

const tokenOf = (inviteUrl: string) => inviteUrl.split("/invite/")[1]!;
const NEW = { gaCode: "ga-dn-003", name: "GA Đà Nẵng", head: { email: "Head@GA3.test", name: "Chủ GA Ba" } };

beforeAll(seedDb);

describe("create tenant", () => {
  it("creates the tenant and its first GA Head, who can then run the tenant", async () => {
    const platform = await as("platform@dlvn.test");
    const res = await platform("/api/platform/tenants", { json: NEW });
    expect(res.status).toBe(201);
    const { tenant, head, inviteUrl } = await json(res);
    expect(tenant).toMatchObject({ gaCode: "GA-DN-003", name: "GA Đà Nẵng", status: "active" });
    expect(head.email).toBe("head@ga3.test");

    const audit = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenant.id));
    expect(audit.map((r) => `${r.action} ${r.entity}`).sort()).toEqual(["CREATE tenant", "CREATE user"]);
    expect(audit.every((r) => r.userId === userId("platform@dlvn.test"))).toBe(true);

    await anon("/api/invites/accept", { json: { token: tokenOf(inviteUrl), password: "ga3-head-password" } });
    const ga3 = await as("head@ga3.test", "ga3-head-password");
    expect(await json(await ga3("/api/me"))).toMatchObject({
      tenant: { id: tenant.id, gaCode: "GA-DN-003" },
      roles: ["GA_HEAD"],
      reach: "TENANT",
    });

    // A new tenant starts empty and sees nothing of the others.
    expect((await json(await ga3("/api/users"))).items.map((u: any) => u.email)).toEqual(["head@ga3.test"]);
    expect((await json(await ga3("/api/agents/tree"))).items).toEqual([]);
    expect((await ga3(`/api/users/${userId("head@ga1.test")}`)).status).toBe(404);

    // And the GA Head can invite their own people into it.
    const invited = await ga3("/api/users/invite", { json: { email: "admin@ga3.test", name: "Admin Ba", roles: ["ADMIN"] } });
    expect(invited.status).toBe(201);
    const row = await db.select().from(users).where(eq(users.email, "admin@ga3.test")).get();
    expect(row?.tenantId).toBe(tenant.id);
  });

  it("rejects a duplicate GA code or head email without leaving anything behind", async () => {
    const platform = await as("platform@dlvn.test");
    const before = (await db.select().from(tenants)).length;
    const dupCode = await platform("/api/platform/tenants", { json: { ...NEW, head: { email: "other@ga3.test", name: "X" } } });
    expect(await json(dupCode)).toEqual({ error: "ga_code_taken" });
    const dupEmail = await platform("/api/platform/tenants", { json: { ...NEW, gaCode: "GA-DN-004" } });
    expect(await json(dupEmail)).toEqual({ error: "email_taken" });
    expect((await platform("/api/platform/tenants", { json: { ...NEW, gaCode: "bad code!" } })).status).toBe(400);
    expect((await db.select().from(tenants)).length).toBe(before);
    expect(await db.select().from(users).where(eq(users.email, "other@ga3.test"))).toEqual([]);
  });

  it("lists tenants with paging and search", async () => {
    const platform = await as("platform@dlvn.test");
    const all = await json(await platform("/api/platform/tenants"));
    expect(all.items.map((t: any) => t.gaCode)).toEqual(["GA-DN-003", "GA-HCM-012", "GA-HN-007"]);
    const page = await json(await platform("/api/platform/tenants?pageSize=1&page=2"));
    expect(page).toMatchObject({ total: 3, page: 2, items: [{ gaCode: "GA-HCM-012" }] });
    expect((await json(await platform("/api/platform/tenants?q=Hà Nội"))).total).toBe(1);
  });
});

describe("support access", () => {
  it("can renew the first GA Head's invite; every such access is audited", async () => {
    const platform = await as("platform@dlvn.test");
    const created = await json(
      await platform("/api/platform/tenants", {
        json: { gaCode: "GA-CT-009", name: "GA Cần Thơ", head: { email: "head@ga4.test", name: "Chủ GA Bốn", agentCode: "0400001" } },
      }),
    );
    const path = `/api/platform/tenants/${created.tenant.id}/users/${created.head.id}/invite`;
    const renewed = await json(await platform(path, { method: "POST" }));
    expect((await anon(`/api/invites/${tokenOf(created.inviteUrl)}`)).status).toBe(404);
    expect((await anon(`/api/invites/${tokenOf(renewed.inviteUrl)}`)).status).toBe(200);

    // A user ID of another tenant under this tenant's URL is not found.
    const wrong = `/api/platform/tenants/${created.tenant.id}/users/${userId("head@ga1.test")}/invite`;
    expect((await platform(wrong, { method: "POST" })).status).toBe(404);
    expect((await platform("/api/platform/tenants/nope")).status).toBe(404);

    const reads = await db.select().from(auditLog).where(eq(auditLog.action, "CROSS_TENANT_READ"));
    expect(reads.map((r) => r.tenantId)).toEqual([created.tenant.id, created.tenant.id]);
  });

  it("shows a tenant's users only", async () => {
    const platform = await as("platform@dlvn.test");
    const body = await json(await platform(`/api/platform/tenants/${GA1.id}?pageSize=50`));
    expect(body.tenant.gaCode).toBe("GA-HCM-012");
    expect(body.users.total).toBe(13);
    expect(body.users.items.every((u: any) => u.email.endsWith("@ga1.test"))).toBe(true);
  });
});
