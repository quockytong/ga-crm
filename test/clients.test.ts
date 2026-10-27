import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "../src/db/schema";
import { addDays, vnToday } from "../src/shared/coverage";
import { as, db, json, seedDb } from "./helpers";
import { book, client, policy, product, run } from "./import-helpers";

// F8: client 360. Policies, coverage per person, family, care signals, scope.

const today = vnToday();
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const thisMonth = `15/${today.slice(5, 7)}`;
const otherMonth = `15/${String((Number(today.slice(5, 7)) % 12) + 1).padStart(2, "0")}`;

beforeAll(async () => {
  await seedDb();
  // fc1 (9000001): A holds P1 on herself and P2 for her child B; C (her husband) holds P3.
  await run(
    await as("fc1@ga1.test"),
    book({
      "02_Clients": [
        client({ "Mã Khách Hàng": "0000000001", "Bên Mua BH": "Lê Thị An", birth_day_month: thisMonth, "Sử dụng D-Connect": "Chưa" }),
        client({ "Mã Khách Hàng": "0000000002", "Bên Mua BH": "Trần Bảo Bình", birth_day_month: otherMonth, age_band: "<18" }),
        client({ "Mã Khách Hàng": "0000000003", "Bên Mua BH": "Trần Văn Cường", birth_day_month: otherMonth, "Giới Tính": "Nam" }),
      ],
      "03_Policies": [
        policy({ "Số HĐBH": "009000001", "Ngày đến hạn đóng phí": ddmmyyyy(addDays(today, 10)) }),
        policy({
          "Số HĐBH": "009000002",
          "Mã NĐBH chính": "0000000002",
          "NĐBH chính": "Trần Bảo Bình",
          "Ngày đến hạn đóng phí": ddmmyyyy(addDays(today, 90)),
          "Phí cơ bản các kỳ trước chưa đóng": 2000000,
        }),
        policy({
          "Số HĐBH": "009000003",
          "Mã KH BMBH": "0000000003",
          "Mã NĐBH chính": "0000000003",
          "Bên mua BH": "TRẦN VĂN CƯỜNG",
          "NĐBH chính": "Trần Văn Cường",
          "Ngày đến hạn đóng phí": ddmmyyyy(addDays(today, 200)),
        }),
      ],
      "04_Policy_Products": [
        product(),
        product({ product_code: "TMP_CSUT247", "Tên sản phẩm": "Chăm Sóc Điều Trị Bệnh Ung Thư 24/7", product_role: "Bổ trợ", "Số tiền bảo hiểm": 300000000, "Phí năm": 2000000 }),
        product({ "Số HĐBH": "009000002", "Mã NĐBH": "0000000002", "Số tiền bảo hiểm": 500000000 }),
      ],
    }),
  );
  // fc3 (9000003, another team): D.
  await run(
    await as("fc3@ga1.test"),
    book({
      "02_Clients": [client({ "Mã Khách Hàng": "0000000004", "Bên Mua BH": "Phạm Thị Dung", birth_day_month: otherMonth })],
      "03_Policies": [
        policy({ "Số HĐBH": "009000004", "Mã KH BMBH": "0000000004", "Mã NĐBH chính": "0000000004", "Mã đại lý": "9000003", "Ngày đến hạn đóng phí": ddmmyyyy(addDays(today, 200)) }),
      ],
    }),
  );
});

const codes = async (email: string, query = "") => (await json(await (await as(email))(`/api/clients?pageSize=50${query}`))).items.map((c: any) => c.clientCode);

describe("client list", () => {
  it("follows the agent tree; Marketing and other GAs see nobody", async () => {
    expect(await codes("fc1@ga1.test")).toEqual(["0000000001", "0000000002", "0000000003"]);
    expect(await codes("fc3@ga1.test")).toEqual(["0000000004"]);
    expect(await codes("um1@ga1.test")).toEqual(["0000000001", "0000000002", "0000000003"]);
    expect(await codes("head@ga1.test")).toHaveLength(4);
    expect(await codes("marketing@ga1.test")).toEqual([]);
    expect(await codes("head@ga2.test")).toEqual([]);
  });

  it("'Khách hàng của': a manager sees their own clients or chosen agents' clients, never outside their scope", async () => {
    // um1 (9000100) has no clients of their own; fc1 (9000001) is in their team, fc3 (9000003) is not.
    expect(await codes("um1@ga1.test", "&agents=9000100")).toEqual([]);
    expect(await codes("um1@ga1.test", "&agents=9000100,9000001")).toEqual(["0000000001", "0000000002", "0000000003"]);
    expect(await codes("um1@ga1.test", "&agents=9000003")).toEqual([]);
    expect(await codes("head@ga1.test", "&agents=9000003")).toEqual(["0000000004"]);
    expect(await json(await (await as("um1@ga1.test"))("/api/clients/counts?agents=9000100"))).toMatchObject({ all: 0 });
    expect((await (await as("um1@ga1.test"))("/api/clients?agents=bad;code")).status).toBe(400);
  });

  it("filters by care signal, with counts for the tabs", async () => {
    expect(await codes("fc1@ga1.test", "&signal=due")).toEqual(["0000000001"]);
    expect(await codes("fc1@ga1.test", "&signal=debt")).toEqual(["0000000001"]);
    expect(await codes("fc1@ga1.test", "&signal=birthday")).toEqual(["0000000001"]);
    expect(await codes("fc1@ga1.test", "&q=cuong")).toEqual(["0000000003"]);
    expect(await json(await (await as("fc1@ga1.test"))("/api/clients/counts"))).toMatchObject({ all: 3, due: 1, debt: 1, birthday: 1, maturity: 0, lapsed: 0 });
    const a = (await json(await (await as("fc1@ga1.test"))("/api/clients?q=0000000001"))).items[0];
    expect(a).toMatchObject({ activePolicies: 2, nextDue: addDays(today, 10), agentNames: "Nguyễn Thị Demo", due: true, debt: true, birthday: true });
  });
});

describe("client 360", () => {
  it("shows policies, coverage per person, people linked by policies and care signals; the visit is audited", async () => {
    const d = await json(await (await as("fc1@ga1.test"))("/api/clients/0000000001"));
    expect(d.policies.map((p: any) => [p.policyNo, p.roles.sort().join("+")])).toEqual([
      ["009000001", "LI+PO"],
      ["009000002", "PO"],
    ]);
    expect(d.policies[0].products.map((p: any) => p.group)).toEqual(["LIFE", "CI"]);
    expect(d.coverage).toMatchObject({ hasDetail: true, groups: { LIFE: 1000000000, CI: 300000000 }, gaps: ["HEALTH", "ACCIDENT"] });
    const b = d.family.find((m: any) => m.clientCode === "0000000002");
    expect(b).toMatchObject({ kind: "CLIENT", label: null, sharedPolicies: [{ policyNo: "009000002", myRoles: ["PO"], theirRoles: ["LI"] }] });
    expect(b.coverage).toMatchObject({ covered: true, groups: { LIFE: 500000000 } });
    expect(d.family.some((m: any) => m.clientCode === "0000000003")).toBe(false);
    expect(d.signals.map((s: any) => s.kind).sort()).toEqual(["BIRTHDAY", "GAP", "GAP", "NO_DCONNECT", "PREMIUM_DUE", "UNPAID"]);
    expect(d.canEdit).toBe(true);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "VIEW_CLIENT"), eq(auditLog.entityId, "0000000001")));
    expect(audits).toHaveLength(1);
  });

  it("managers of the line read it; only the client's own agents change it; others get 404", async () => {
    const um = await as("um1@ga1.test");
    expect((await json(await um("/api/clients/0000000001"))).canEdit).toBe(false);
    expect((await um("/api/clients/0000000001/family", { json: { relation: "OTHER", fullName: "X" } })).status).toBe(403);
    expect((await (await as("fc3@ga1.test"))("/api/clients/0000000001")).status).toBe(404);
    expect((await (await as("fc3@ga1.test"))("/api/clients/0000000001/family", { json: { relation: "OTHER", fullName: "X" } })).status).toBe(404);
    expect((await (await as("marketing@ga1.test"))("/api/clients/0000000001")).status).toBe(404);
    expect((await (await as("head@ga2.test"))("/api/clients/0000000001")).status).toBe(404);
  });
});

describe("family", () => {
  it("the FC labels people; the other side sees the inverse relation", async () => {
    const fc1 = await as("fc1@ga1.test");
    expect((await fc1("/api/clients/0000000001/family", { json: { relation: "SPOUSE", relatedClientCode: "0000000003" } })).status).toBe(201);
    expect((await fc1("/api/clients/0000000001/family", { json: { relation: "CHILD", relatedClientCode: "0000000002" } })).status).toBe(201);
    // Not in fc1's scope.
    expect((await fc1("/api/clients/0000000001/family", { json: { relation: "SIBLING", relatedClientCode: "0000000004" } })).status).toBe(404);

    const a = await json(await fc1("/api/clients/0000000001"));
    expect(a.family.filter((m: any) => m.kind === "CLIENT").map((m: any) => [m.clientCode, m.label?.relation])).toEqual([
      ["0000000002", "CHILD"],
      ["0000000003", "SPOUSE"],
    ]);
    const b = await json(await fc1("/api/clients/0000000002"));
    expect(b.family.map((m: any) => [m.clientCode, m.label?.relation])).toEqual([["0000000001", "PARENT"]]);
    const c = await json(await fc1("/api/clients/0000000003"));
    expect(c.family.map((m: any) => [m.clientCode, m.label?.relation])).toEqual([["0000000001", "SPOUSE"]]);

    // Changed from the child's page: stored from the mother's side.
    const row = b.family[0].label.id;
    expect((await fc1(`/api/clients/0000000002/family/${row}`, { method: "PATCH", json: { relation: "OTHER", note: "Con nuôi" } })).status).toBe(200);
    expect((await json(await fc1("/api/clients/0000000001"))).family.find((m: any) => m.clientCode === "0000000002").label).toMatchObject({ relation: "OTHER", note: "Con nuôi" });
  });

  it("adds a member who is not a client yet, shown as uncovered, who can become the FC's own lead", async () => {
    const fc1 = await as("fc1@ga1.test");
    const { id } = await json(
      await fc1("/api/clients/0000000001/family", { json: { relation: "CHILD", fullName: "Trần Bảo Châu", birthDay: 12, birthMonth: 5, birthYear: 2020, gender: "Nữ" } }),
    );
    expect((await fc1("/api/clients/0000000001/family", { json: { relation: "CHILD", fullName: "X", birthMonth: 13 } })).status).toBe(400);
    const d = await json(await fc1("/api/clients/0000000001"));
    expect(d.family.find((m: any) => m.kind === "MEMBER")).toMatchObject({ id, name: "Trần Bảo Châu", birthDay: 12, birthMonth: 5, birthYear: 2020, relation: "CHILD", leadId: null });
    expect(d.signals.filter((s: any) => s.kind === "FAMILY_UNCOVERED").map((s: any) => s.name)).toEqual(["Trần Bảo Châu"]);

    const lead = await json(await fc1("/api/leads", { json: { fullName: "Trần Bảo Châu", phone: "0912000111", source: "Người thân khách hàng", consent: true } }));
    expect((await fc1(`/api/clients/0000000001/family/${id}/lead`, { json: { leadId: lead.id } })).status).toBe(200);
    expect((await json(await fc1("/api/clients/0000000001"))).family.find((m: any) => m.id === id).leadId).toBe(lead.id);

    expect((await fc1(`/api/clients/0000000001/family/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await json(await fc1("/api/clients/0000000001"))).family.some((m: any) => m.id === id)).toBe(false);
  });
});

describe("care log and catalog", () => {
  it("the FC logs calls and notes with the client", async () => {
    const fc1 = await as("fc1@ga1.test");
    expect((await fc1("/api/clients/0000000001/activities", { json: { type: "CALL", note: "Nhắc đóng phí" } })).status).toBe(201);
    const d = await json(await fc1("/api/clients/0000000001"));
    expect(d.activities).toMatchObject([{ type: "CALL", note: "Nhắc đóng phí", agentCode: "9000001" }]);
    expect(d.userNames[d.activities[0].createdBy]).toBe("Nguyễn Thị Demo");
    expect((await (await as("um1@ga1.test"))("/api/clients/0000000001/activities", { json: { type: "CALL", note: "x" } })).status).toBe(403);
    // Notes are not part of the care log.
    expect((await fc1("/api/clients/0000000001/activities", { json: { type: "NOTE", note: "x" } })).status).toBe(400);
  });

  it("notes in Tổng quan: the client's own agents add them, shown oldest first", async () => {
    const fc1 = await as("fc1@ga1.test");
    for (const body of ["Thích du lịch", "Sắp mua nhà", "Con vào lớp 1 năm sau"]) {
      expect((await fc1("/api/clients/0000000001/notes", { json: { body } })).status).toBe(201);
    }
    const d = await json(await fc1("/api/clients/0000000001"));
    expect(d.notes.map((n: any) => n.note)).toEqual(["Thích du lịch", "Sắp mua nhà", "Con vào lớp 1 năm sau"]);
    expect(d.activities.map((a: any) => a.type)).toEqual(["CALL"]);
    expect((await (await as("um1@ga1.test"))("/api/clients/0000000001/notes", { json: { body: "x" } })).status).toBe(403);
  });

  it("the Platform Admin loads the product catalog; its category decides the coverage group", async () => {
    const rows = [{ productCode: "TMP_ASHTV", productName: "An Tâm Song Hành Thịnh Vượng", productRole: "Chính", category: "Accident (Tai nạn)", ruleStatus: "DRAFT" }];
    expect((await (await as("head@ga1.test"))("/api/platform/products", { json: { rows } })).status).toBe(403);
    const platform = await as("platform@dlvn.test");
    expect(await json(await platform("/api/platform/products", { json: { rows } }))).toEqual({ saved: 1 });
    expect((await json(await platform("/api/platform/products"))).items).toMatchObject([{ productCode: "TMP_ASHTV", category: "Accident (Tai nạn)" }]);
    const d = await json(await (await as("fc1@ga1.test"))("/api/clients/0000000001"));
    expect(d.coverage.gaps).toEqual(["HEALTH"]);
  });
});

describe("people known only from a policy", () => {
  it("an insured child missing from 02_Clients shows in the family, with coverage, and can be labelled", async () => {
    const fc1 = await as("fc1@ga1.test");
    await run(
      fc1,
      book({
        "03_Policies": [
          policy({ "Số HĐBH": "009000005", "Mã NĐBH chính": "0000000005", "NĐBH chính": "TRẦN BẢO ĐAN", "Ngày đến hạn đóng phí": ddmmyyyy(addDays(today, 120)) }),
        ],
      }),
    );
    const d = await json(await fc1("/api/clients/0000000001"));
    const e = d.family.find((m: any) => m.clientCode === "0000000005");
    expect(e).toMatchObject({ kind: "CLIENT", isClient: false, name: "Trần Bảo Đan", label: null, coverage: { covered: true, hasDetail: false, gaps: null } });
    expect((await fc1("/api/clients/0000000001/family", { json: { relation: "CHILD", relatedClientCode: "0000000005" } })).status).toBe(201);
    expect((await json(await fc1("/api/clients/0000000001"))).family.find((m: any) => m.clientCode === "0000000005").label.relation).toBe("CHILD");
    // No client page for them, and fc3 cannot label them.
    expect((await fc1("/api/clients/0000000005")).status).toBe(404);
    expect((await (await as("fc3@ga1.test"))("/api/clients/0000000004/family", { json: { relation: "CHILD", relatedClientCode: "0000000005" } })).status).toBe(404);
  });
});
