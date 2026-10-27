import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog, campaigns, crmActivities, leadHistory, leads, users } from "../src/db/schema";
import { GA1, GA2, userId } from "../src/db/seed";
import { as, db, json, seedDb } from "./helpers";
import { book, lead, run } from "./import-helpers";

// Leads: import from the GA's sheet, management and assignment by Marketing / Admin,
// follow-up by agents, and the results report.

beforeAll(seedDb);

const byPhone = async (phone: string, tenantId = GA1.id) =>
  (await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), eq(leads.phone, phone))))[0]!;
const historyOf = async (leadId: string) =>
  (await db.select().from(leadHistory).where(eq(leadHistory.leadId, leadId))).map((h) => `${h.field}: ${h.oldValue} -> ${h.newValue}`).sort();
const listPhones = async (email: string, query = "") =>
  (await json(await (await as(email))(`/api/leads?pageSize=50${query}`))).items.map((l: any) => l.phone).sort();

describe("lead import (13_Leads)", () => {
  it("creates leads, campaigns, assignment history and notes; reports bad rows", async () => {
    const { imp, errors } = await run(
      await as("marketing@ga1.test"),
      book({
        "13_Leads": [
          lead({ "SỐ ĐIỆN THOẠI": 900000001, "Tình Trạng TVV": "Quan Tâm Thẻ Rời", "Trạng Thái Hiện Tại TVV": "Đang chăm sóc", "TIẾN ĐỘ TƯ VẤN TVV": "01/10: gọi lần 1, hẹn gửi bảng giá" }),
          lead({ "SỐ ĐIỆN THOẠI": "0900 000 002", "Mã đại lý": "9000003", "Chiến Dịch": "Package3", "Trạng Thái Hiện Tại TVV": "Chốt xịt", "LÝ DO CHỐT XỊT/ DỪNG TÌM HIỂU": "Đã mua bên khác" }),
          lead({ "SỐ ĐIỆN THOẠI": "+84900000003", "Mã đại lý": null, "Nguồn": "Web" }),
          lead({ "SỐ ĐIỆN THOẠI": "12345" }),
          lead({ "SỐ ĐIỆN THOẠI": "0900000001", "TÊN KHÁCH HÀNG": "Trùng Số" }),
          lead({ "SỐ ĐIỆN THOẠI": "0900000006", "Mã đại lý": "9100001" }), // an agent of GA-2
          lead({ "SỐ ĐIỆN THOẠI": "0900000007", "Tình Trạng TVV": "Rất thích" }),
        ],
      }),
    );
    expect(errors.map((e) => `${e.row}:${e.code}`)).toEqual(["5:invalid_phone", "6:duplicate_key", "7:agent_not_found", "8:invalid_list"]);
    expect(imp.sheets["13_Leads"]).toMatchObject({ found: 7, inserted: 3, rejected: 4 });

    const a = await byPhone("0900000001");
    expect(a).toMatchObject({
      fullName: "Khách Thử Nghiệm",
      nameNorm: "KHACH THU NGHIEM",
      source: "Page BHN",
      phoneSource: "Xin số",
      region: "Hà Nội",
      leadDate: "2026-10-01",
      interest: "HEALTH_CARD",
      careStatus: "CARING",
      stage: "CONTACTED",
      assignedAgentCode: "9000001",
      assignedBy: userId("marketing@ga1.test"),
      consentMarketing: false,
    });
    expect(await byPhone("0900000002")).toMatchObject({ careStatus: "DROPPED", stage: "LOST", lostReason: "Đã mua bên khác", assignedAgentCode: "9000003" });
    expect(await byPhone("0900000003")).toMatchObject({ assignedAgentCode: null, stage: "NEW" });
    expect((await db.select().from(campaigns)).map((c) => c.name).sort()).toEqual(["HC2", "Package3"]);
    expect(await historyOf(a.id)).toEqual(["assignee: null -> 9000001"]);
    expect(await db.select().from(crmActivities).where(eq(crmActivities.leadId, a.id))).toMatchObject([
      { type: "NOTE", source: "IMPORT", note: "01/10: gọi lần 1, hẹn gửi bảng giá", agentCode: "9000001" },
    ]);
  });

  it("importing the sheet again updates by phone, keeps what an empty cell would wipe, and logs changes", async () => {
    const before = await byPhone("0900000001");
    const { errors } = await run(
      await as("marketing@ga1.test"),
      book({
        "13_Leads": [
          lead({
            "SỐ ĐIỆN THOẠI": "0900000001",
            "NGÀY CẬP NHẬT LEAD": "06/10/2026",
            "Tình Trạng TVV": null,
            "Trạng Thái Hiện Tại TVV": "Đã chốt",
            "TIẾN ĐỘ TƯ VẤN TVV": "01/10: gọi lần 1\n05/10: chốt thẻ rời",
            "Mã đại lý": "9000002",
          }),
        ],
      }),
    );
    expect(errors).toMatchObject([{ code: "lead_exists", severity: "warning" }]);
    const after = await byPhone("0900000001");
    expect(after).toMatchObject({ id: before.id, interest: "HEALTH_CARD", careStatus: "WON", stage: "SUBMITTED", assignedAgentCode: "9000002", assigneeSeenAt: null });
    expect(await historyOf(after.id)).toEqual([
      "assignee: 9000001 -> 9000002",
      "assignee: null -> 9000001",
      "care_status: CARING -> WON",
      "stage: CONTACTED -> SUBMITTED",
    ]);
    expect((await db.select().from(crmActivities).where(eq(crmActivities.leadId, after.id))).length).toBe(2);
    // The lead's history carries the update date from the file (06/10 at 00:00 Vietnam time), not the import time.
    const changed = (await db.select().from(leadHistory).where(eq(leadHistory.leadId, after.id))).find((h) => h.field === "care_status")!;
    expect(changed.changedAt).toBe("2026-10-05T17:00:00.000Z");
    expect(after.leadDate).toBe("2026-10-01");
  });

  it("the later record wins: a row not newer than the CRM's data is kept aside", async () => {
    const mkt = await as("marketing@ga1.test");
    const same = await run(mkt, book({ "13_Leads": [lead({ "SỐ ĐIỆN THOẠI": "0900000001", "NGÀY CẬP NHẬT LEAD": "06/10/2026", "Trạng Thái Hiện Tại TVV": "Chốt xịt" })] }));
    expect(same.errors).toMatchObject([{ code: "lead_not_newer", severity: "warning", recordKey: "0900000001" }]);
    expect(same.imp.sheets["13_Leads"]).toMatchObject({ found: 1, inserted: 0, updated: 0, skipped: 1, rejected: 0 });
    expect((await byPhone("0900000001")).careStatus).toBe("WON");

    // A change made in the CRM is stamped with its exact time; an older sheet does not undo it.
    const id = (await byPhone("0900000002")).id;
    await mkt(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "CARING" } });
    const older = await run(mkt, book({ "13_Leads": [lead({ "SỐ ĐIỆN THOẠI": "0900000002", "NGÀY CẬP NHẬT LEAD": "02/10/2026", "Trạng Thái Hiện Tại TVV": "Chốt xịt", "Mã đại lý": "9000003" })] }));
    expect(older.errors.map((e) => e.code)).toEqual(["lead_not_newer"]);
    expect((await byPhone("0900000002")).careStatus).toBe("CARING");
    // A row without a date cannot prove it is newer: kept aside for an existing lead, created when new.
    const undated = await run(mkt, book({ "13_Leads": [lead({ "SỐ ĐIỆN THOẠI": "0900000002", "NGÀY CẬP NHẬT LEAD": null }), lead({ "SỐ ĐIỆN THOẠI": "0900000009", "NGÀY CẬP NHẬT LEAD": null })] }));
    expect(undated.imp.sheets["13_Leads"]).toMatchObject({ inserted: 1, skipped: 1 });
    // A later sheet wins over the CRM change.
    const later = await run(mkt, book({ "13_Leads": [lead({ "SỐ ĐIỆN THOẠI": "0900000002", "NGÀY CẬP NHẬT LEAD": "01/01/2099", "Trạng Thái Hiện Tại TVV": "Chốt xịt", "Mã đại lý": "9000003", "Chiến Dịch": "Package3" })] }));
    expect(later.errors.map((e) => e.code)).toEqual(["lead_exists"]);
    expect((await byPhone("0900000002")).careStatus).toBe("DROPPED");
    await db.delete(leads).where(eq(leads.phone, "0900000009"));
  });

  it("health notes may come in from lead files; ID and bank columns may not", async () => {
    const { bannedColumns } = await import("../src/shared/import/lead-sheet");
    expect(bannedColumns(["TÊN KHÁCH HÀNG", "Tiền sử bệnh", "Tình trạng sức khỏe", "Số CCCD", "Số tài khoản"])).toEqual(["Số CCCD", "Số tài khoản"]);
    const { planSheet, SHEETS } = await import("../src/shared/import/template");
    expect(planSheet(SHEETS["02_Clients"], ["Mã Khách Hàng", "Tiền sử bệnh"]).banned).toEqual(["Tiền sử bệnh"]);
  });

  it("needs leads.import: an FC cannot upload leads", async () => {
    const created = await json(
      await (await as("fc1@ga1.test"))("/api/imports", { json: { fileName: "l.xlsx", snapshotDate: "2026-10-13", sheets: [{ name: "13_Leads", headers: ["TÊN KHÁCH HÀNG", "SỐ ĐIỆN THOẠI", "Nguồn"] }] } }),
    );
    expect(created.sheets["13_Leads"].status).toBe("BLOCKED");
  });
});

describe("who sees which lead", () => {
  it("lead managers see every lead (also unassigned); agents see their scope", async () => {
    const all = ["0900000001", "0900000002", "0900000003"];
    for (const email of ["marketing@ga1.test", "admin@ga1.test", "head@ga1.test"]) expect(await listPhones(email), email).toEqual(all);
    expect(await listPhones("fc2@ga1.test")).toEqual(["0900000001"]);
    expect(await listPhones("fc1@ga1.test")).toEqual([]);
    // Managers of the line see their FCs' leads with the phone masked.
    expect(await listPhones("um1@ga1.test")).toEqual(["0900***001"]);
    expect(await listPhones("um2@ga1.test")).toEqual(["0900***002"]);
    expect(await listPhones("bm1@ga1.test")).toEqual(["0900***001", "0900***002"]);
    expect(await listPhones("marketing@ga2.test")).toEqual([]);

    const id = (await byPhone("0900000002")).id;
    expect((await (await as("fc2@ga1.test"))(`/api/leads/${id}`)).status).toBe(404);
    expect((await (await as("head@ga2.test"))(`/api/leads/${id}`)).status).toBe(404);
  });

  it("filters: unassigned, care status, source, campaign", async () => {
    expect(await listPhones("marketing@ga1.test", "&assignee=NONE")).toEqual(["0900000003"]);
    expect(await listPhones("marketing@ga1.test", "&care=DROPPED")).toEqual(["0900000002"]);
    expect(await listPhones("marketing@ga1.test", "&source=Web")).toEqual(["0900000003"]);
    const camp = (await db.select().from(campaigns).where(eq(campaigns.name, "Package3")))[0]!;
    expect(await listPhones("marketing@ga1.test", `&campaignId=${camp.id}`)).toEqual(["0900000002"]);
    expect(await listPhones("marketing@ga1.test", "&q=0900000003")).toEqual(["0900000003"]);
  });
});

describe("assignment", () => {
  it("Marketing assigns many leads at once; history and audit per lead; the agent sees them as new", async () => {
    const mkt = await as("marketing@ga1.test");
    const ids = [(await byPhone("0900000002")).id, (await byPhone("0900000003")).id];
    const res = await mkt("/api/leads/assign", { json: { leadIds: ids, agentCode: "9000004" } });
    expect(await json(res)).toEqual({ assigned: 2 });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "ASSIGN"))).map((a) => a.entityId).sort()).toEqual([...ids].sort());

    const fc4 = await as("fc4@ga1.test");
    const mine = (await json(await fc4("/api/leads?isNew=1"))).items;
    expect(mine.map((l: any) => l.phone).sort()).toEqual(["0900000002", "0900000003"]);
    await fc4(`/api/leads/${ids[1]}`);
    expect((await json(await fc4("/api/leads?isNew=1"))).items.map((l: any) => l.phone)).toEqual(["0900000002"]);
    expect(await historyOf(ids[1]!)).toEqual(["assignee: null -> 9000004"]);
  });

  it("only lead managers assign, and only to agents of their GA", async () => {
    const id = (await byPhone("0900000003")).id;
    expect((await (await as("fc4@ga1.test"))("/api/leads/assign", { json: { leadIds: [id], agentCode: "9000004" } })).status).toBe(403);
    expect((await (await as("um3@ga1.test"))("/api/leads/assign", { json: { leadIds: [id], agentCode: "9000004" } })).status).toBe(403);
    const mkt = await as("marketing@ga1.test");
    expect(await json(await mkt("/api/leads/assign", { json: { leadIds: [id], agentCode: "9100001" } }))).toEqual({ error: "agent_not_found" });
    // A lead of another GA is not found.
    const ga2Lead = crypto.randomUUID();
    await db.insert(leads).values({ id: ga2Lead, tenantId: GA2.id, fullName: "B", nameNorm: "B", phone: "0900000003", source: "Web", leadDate: "2026-10-01", createdBy: "x", createdAt: "2026-10-01", updatedAt: "2026-10-01" });
    expect((await mkt("/api/leads/assign", { json: { leadIds: [id, ga2Lead], agentCode: "9000004" } })).status).toBe(404);
  });

  it("the assignee picker shows team and open leads", async () => {
    const { items } = await json(await (await as("marketing@ga1.test"))("/api/leads/assignees"));
    expect(items.find((a: any) => a.agentCode === "9000004")).toMatchObject({ name: "Đặng Văn Tư Vấn", managerName: "Hồ Văn Quản Lý", openLeads: 1 });
    expect((await (await as("fc1@ga1.test"))("/api/leads/assignees")).status).toBe(403);
  });
});

describe("follow-up by the agent", () => {
  it("logging a call marks the first contact and moves a new lead to CONTACTED", async () => {
    const fc4 = await as("fc4@ga1.test");
    const id = (await byPhone("0900000003")).id;
    const res = await fc4(`/api/leads/${id}/activities`, { json: { type: "CALL", outcome: "Không nghe máy", note: "Gọi 2 lần" } });
    expect(res.status).toBe(201);
    const l = await byPhone("0900000003");
    expect(l.stage).toBe("CONTACTED");
    expect(l.firstContactAt).toBeTruthy();
    const detail = await json(await fc4(`/api/leads/${id}`));
    expect(detail.contacts[0]).toMatchObject({ type: "CALL", outcome: "Không nghe máy", agentCode: "9000004" });
    // The "contact within 48 h" task given at assignment is done.
    expect(detail.tasks.find((t: any) => t.source === "AUTO_ASSIGN")).toMatchObject({ status: "DONE", agentCode: "9000004" });
  });

  it("'Tình trạng' is final once classified; only a lead manager corrects it", async () => {
    const fc4 = await as("fc4@ga1.test");
    const id = (await byPhone("0900000003")).id;
    expect((await fc4(`/api/leads/${id}`, { method: "PATCH", json: { interest: "NOT_REACHED" } })).status).toBe(200);
    expect((await fc4(`/api/leads/${id}`, { method: "PATCH", json: { interest: "LIFE", careStatus: "CARING" } })).status).toBe(200);
    expect(await json(await fc4(`/api/leads/${id}`, { method: "PATCH", json: { interest: "HEALTH_CARD" } }))).toEqual({ error: "interest_locked" });
    expect((await (await as("marketing@ga1.test"))(`/api/leads/${id}`, { method: "PATCH", json: { interest: "HEALTH_CARD" } })).status).toBe(200);
    // Agents cannot edit the lead's details.
    expect((await fc4(`/api/leads/${id}`, { method: "PATCH", json: { source: "Khác" } })).status).toBe(403);
  });

  it("'Chốt xịt' needs a reason", async () => {
    const fc4 = await as("fc4@ga1.test");
    const id = (await byPhone("0900000003")).id;
    expect(await json(await fc4(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "DROPPED" } }))).toEqual({ error: "lost_reason_required" });
    expect((await fc4(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "DROPPED", lostReason: "Không đủ ngân sách" } })).status).toBe(200);
    expect(await byPhone("0900000003")).toMatchObject({ stage: "LOST", lostReason: "Không đủ ngân sách" });
  });

  it("an agent cannot touch a lead outside their scope", async () => {
    const id = (await byPhone("0900000001")).id;
    const fc4 = await as("fc4@ga1.test");
    expect((await fc4(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "CARING" } })).status).toBe(404);
    expect((await fc4(`/api/leads/${id}/activities`, { json: { type: "CALL", note: "x" } })).status).toBe(404);
  });
});

describe("managers of the line coach the FC", () => {
  it("see every detail but the phone, and cannot search by phone", async () => {
    const id = (await byPhone("0900000001")).id;
    const um1 = await as("um1@ga1.test");
    const detail = await json(await um1(`/api/leads/${id}`));
    expect(detail.lead.phone).toBe("0900***001");
    expect(detail.lead.fullName).toBe("Khách Thử Nghiệm");
    expect(detail.canWork).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("0900000001");
    expect(await listPhones("um1@ga1.test", "&q=0900000001")).toEqual([]);
    expect(await listPhones("um1@ga1.test", "&q=Thử")).toEqual(["0900***001"]);
    // The assignee and lead managers see it in full.
    expect((await json(await (await as("fc2@ga1.test"))(`/api/leads/${id}`))).lead.phone).toBe("0900000001");
    expect((await json(await (await as("marketing@ga1.test"))(`/api/leads/${id}`))).lead.phone).toBe("0900000001");
  });

  it("do not update the lead or log contacts for the FC", async () => {
    const id = (await byPhone("0900000001")).id;
    const um1 = await as("um1@ga1.test");
    expect(await json(await um1(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "CARING" } }))).toEqual({ error: "lead_not_yours" });
    expect((await um1(`/api/leads/${id}/activities`, { json: { type: "CALL", note: "x" } })).status).toBe(403);
  });

  it("leave comments the FC sees, flagged until read, with who wrote them", async () => {
    const id = (await byPhone("0900000001")).id;
    const um1 = await as("um1@ga1.test");
    const fc2 = await as("fc2@ga1.test");
    await fc2(`/api/leads/${id}`); // FC has the lead open before the comment
    const res = await um1(`/api/leads/${id}/comments`, { json: { body: "Gửi thêm minh họa quyền lợi thẻ rời cho bé, hẹn gặp cuối tuần." } });
    expect(res.status).toBe(201);
    expect((await json(await fc2("/api/leads?newComment=1"))).items.map((l: any) => l.id)).toEqual([id]);

    const detail = await json(await fc2(`/api/leads/${id}`));
    expect(detail.comments).toMatchObject([{ body: "Gửi thêm minh họa quyền lợi thẻ rời cho bé, hẹn gặp cuối tuần.", authorUserId: userId("um1@ga1.test") }]);
    expect(detail.userNames[userId("um1@ga1.test")]).toBe("Trần Văn Quản Lý");
    // Read now.
    expect((await json(await fc2("/api/leads?newComment=1"))).items).toEqual([]);
    // Comments oldest first.
    await new Promise((r) => setTimeout(r, 5));
    await um1(`/api/leads/${id}/comments`, { json: { body: "Nhớ hỏi về khoản vay mua nhà." } });
    expect((await json(await fc2(`/api/leads/${id}`))).comments.map((m: any) => m.body)).toEqual([
      "Gửi thêm minh họa quyền lợi thẻ rời cho bé, hẹn gặp cuối tuần.",
      "Nhớ hỏi về khoản vay mua nhà.",
    ]);
    // A peer UM cannot see the lead, so cannot comment.
    expect((await (await as("um3@ga1.test"))(`/api/leads/${id}/comments`, { json: { body: "x" } })).status).toBe(404);
    // A comment does not count as a data change for the lead import rule.
    expect((await byPhone("0900000001")).updatedAt).not.toBe((await byPhone("0900000001")).lastCommentAt);
  });

  it("the log names who made each change", async () => {
    const id = (await byPhone("0900000001")).id;
    const detail = await json(await (await as("marketing@ga1.test"))(`/api/leads/${id}`));
    for (const h of detail.history) expect(detail.userNames[h.changedBy], h.field).toBe("Phan Thị Marketing");
  });
});

describe("manual leads, overdue and the report", () => {
  it("creates a lead with consent; the same phone is reported with the existing lead", async () => {
    const mkt = await as("marketing@ga1.test");
    const res = await mkt("/api/leads", { json: { fullName: "Khách Mới", phone: "0900 000 010", source: "Hội thảo", consent: true, assignedAgentCode: "9000001" } });
    expect(res.status).toBe(201);
    expect(await byPhone("0900000010")).toMatchObject({ consentMarketing: true, consentSource: "CRM_FORM", assignedAgentCode: "9000001" });
    const dup = await mkt("/api/leads", { json: { fullName: "X", phone: "84900000010", source: "Web", consent: false } });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toEqual({ error: "phone_exists", leadId: (await byPhone("0900000010")).id });
    // Admin without an agent code and lead permissions removed cannot; an FC can (their own lead, tested below).
    expect((await (await as("admin@ga2.test"))("/api/leads", { json: { fullName: "X", phone: "0900000011", source: "Web", consent: false } })).status).toBe(201);
  });

  it("a lead assigned more than 48 hours ago and never contacted is overdue", async () => {
    await db.update(leads).set({ assignedAt: new Date(Date.now() - 49 * 3600 * 1000).toISOString() }).where(eq(leads.phone, "0900000010"));
    expect(await listPhones("marketing@ga1.test", "&overdue=1")).toEqual(["0900000010"]);
    expect(await listPhones("fc1@ga1.test", "&overdue=1")).toEqual(["0900000010"]);
  });

  it("the report counts each agent's results; a manager sees their team only", async () => {
    const report = await json(await (await as("marketing@ga1.test"))("/api/leads/report"));
    const row = (code: string | null) => report.items.find((r: any) => r.agentCode === code);
    // Imported with a status: contacted, but not timed. Logged in the CRM: timed.
    expect(row("9000002")).toMatchObject({ total: 1, contacted: 1, timedContacts: 0, healthCard: 1, won: 1 });
    // 0900000002 got a status in the CRM (timed) before it was reassigned to 9000004.
    expect(row("9000004")).toMatchObject({ total: 2, contacted: 2, timedContacts: 2, contactedIn24h: 2, dropped: 2, healthCard: 1 });
    expect(row("9000001")).toMatchObject({ total: 1, contacted: 0, overdue: 1 });

    const um1 = await json(await (await as("um1@ga1.test"))("/api/leads/report"));
    expect(um1.items.map((r: any) => r.agentCode).sort()).toEqual(["9000001", "9000002"]);
    const dated = await json(await (await as("marketing@ga1.test"))("/api/leads/report?from=2026-11-01"));
    expect(dated.items).toEqual([]);
  });
});

describe("an FC's own leads", () => {
  it("are assigned to the FC, flagged, and cannot be given to someone else while the FC works", async () => {
    const fc1 = await as("fc1@ga1.test");
    const res = await fc1("/api/leads", { json: { fullName: "Khách Tự Khai Thác", phone: "0900000020", source: "Tự khai thác", consent: true, note: "Gặp ở hội thảo trường học", assignedAgentCode: "9000004" } });
    expect(res.status).toBe(201);
    const own = await byPhone("0900000020");
    expect(own).toMatchObject({ origin: "FC_OWN", assignedAgentCode: "9000001", consentMarketing: true });
    const list = (await json(await (await as("head@ga1.test"))("/api/leads?q=Tự Khai"))).items;
    expect(list[0]).toMatchObject({ origin: "FC_OWN" });

    const mkt = await as("marketing@ga1.test");
    expect(await json(await mkt("/api/leads/assign", { json: { leadIds: [own.id], agentCode: "9000002" } }))).toEqual({ error: "own_lead_locked" });
    const viaFile = await run(mkt, book({ "13_Leads": [lead({ "SỐ ĐIỆN THOẠI": "0900000020", "NGÀY CẬP NHẬT LEAD": "01/01/2099", "Mã đại lý": "9000002" })] }));
    expect(viaFile.errors.map((e) => e.code)).toEqual(["own_lead_locked"]);

    // Once the FC has left, the lead can be handed over.
    await db.update(users).set({ status: "DISABLED" }).where(eq(users.id, userId("fc1@ga1.test")));
    expect(await json(await mkt("/api/leads/assign", { json: { leadIds: [own.id], agentCode: "9000002" } }))).toEqual({ assigned: 1 });
    await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, userId("fc1@ga1.test")));
  });
});

describe("working a lead", () => {
  it("the FC edits Thông tin, with history; the phone stays unique", async () => {
    const fc2 = await as("fc2@ga1.test");
    const id = (await byPhone("0900000020")).id;
    const res = await fc2(`/api/leads/${id}`, { method: "PATCH", json: { fullName: "Khách Đổi Tên", phone: "0900 000 021", dob: "1990-05-01", region: "Hà Nội", province: "Hà Nội", email: "kh@example.com", consent: false, interest: "LIFE" } });
    expect(res.status).toBe(200);
    expect(await byPhone("0900000021")).toMatchObject({ fullName: "Khách Đổi Tên", dob: "1990-05-01", email: "kh@example.com", consentMarketing: false, interest: "LIFE" });
    const fields = (await db.select().from(leadHistory).where(eq(leadHistory.leadId, id))).map((h) => h.field);
    expect(fields).toEqual(expect.arrayContaining(["full_name", "phone", "dob", "email", "consent_marketing", "interest"]));
    expect(await json(await fc2(`/api/leads/${id}`, { method: "PATCH", json: { phone: "0900000002" } }))).toEqual({ error: "phone_exists" });
    // Managers of the line see a phone change masked in the history.
    const um1 = await json(await (await as("um1@ga1.test"))(`/api/leads/${id}`));
    const phoneChange = um1.history.find((h: any) => h.field === "phone");
    expect([phoneChange.oldValue, phoneChange.newValue]).toEqual(["0900***020", "0900***021"]);
  });

  it("'Đã chốt' needs the application or the policy number", async () => {
    const fc2 = await as("fc2@ga1.test");
    const id = (await byPhone("0900000021")).id;
    expect(await json(await fc2(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "WON" } }))).toEqual({ error: "won_needs_numbers" });
    expect((await fc2(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "WON", policyNo: "12345" } })).status).toBe(400);
    expect((await fc2(`/api/leads/${id}`, { method: "PATCH", json: { careStatus: "WON", policyNo: "009000777" } })).status).toBe(200);
    expect(await byPhone("0900000021")).toMatchObject({ careStatus: "WON", stage: "SUBMITTED", policyNo: "009000777" });
  });

  it("notes: oldest first, the original note on top", async () => {
    const fc2 = await as("fc2@ga1.test");
    const id = (await byPhone("0900000021")).id;
    await fc2(`/api/leads/${id}/notes`, { json: { body: "Khách muốn so sánh với gói tiết kiệm" } });
    await new Promise((r) => setTimeout(r, 5));
    await fc2(`/api/leads/${id}/notes`, { json: { body: "Vợ khách quyết định, hẹn gặp cả hai" } });
    const { notes } = await json(await fc2(`/api/leads/${id}`));
    expect(notes.map((n: any) => n.note)).toEqual(["Gặp ở hội thảo trường học", "Khách muốn so sánh với gói tiết kiệm", "Vợ khách quyết định, hẹn gặp cả hai"]);
    // Contacts are calls, Zalo and meetings only.
    expect((await fc2(`/api/leads/${id}/activities`, { json: { type: "NOTE", note: "x" } })).status).toBe(400);
  });

  it("tasks: auto 48 h task on assignment, follow-up task from 'Hẹn liên hệ tiếp', own tasks", async () => {
    const fc2 = await as("fc2@ga1.test");
    const id = (await byPhone("0900000021")).id;
    let { tasks } = await json(await fc2(`/api/leads/${id}`));
    const auto = tasks.find((t: any) => t.source === "AUTO_ASSIGN" && t.status === "OPEN");
    expect(auto.agentCode).toBe("9000002");
    expect(Date.parse(auto.dueAt) - Date.parse((await byPhone("0900000021")).assignedAt!)).toBe(48 * 3600_000);

    await fc2(`/api/leads/${id}`, { method: "PATCH", json: { nextActionAt: "2099-11-02T09:00:00+07:00" } });
    await fc2(`/api/leads/${id}`, { method: "PATCH", json: { nextActionAt: "2099-11-03T09:00:00+07:00" } });
    const created = await json(await fc2(`/api/leads/${id}/tasks`, { json: { title: "Gửi bảng minh họa", dueAt: "2099-11-01T17:00:00+07:00" } }));
    ({ tasks } = await json(await fc2(`/api/leads/${id}`)));
    // Ordered by due time.
    expect(tasks.filter((t: any) => t.status === "OPEN").map((t: any) => `${t.source}:${t.dueAt}`)).toEqual([
      expect.stringMatching(/^AUTO_ASSIGN:/),
      "APP:2099-11-01T10:00:00.000Z",
      "NEXT_ACTION:2099-11-03T02:00:00.000Z",
    ]);
    expect(tasks.filter((t: any) => t.source === "NEXT_ACTION" && t.status === "CANCELLED")).toHaveLength(1);

    expect((await fc2(`/api/leads/${id}/tasks/${created.id}`, { method: "PATCH", json: { done: true } })).status).toBe(200);
    ({ tasks } = await json(await fc2(`/api/leads/${id}`)));
    expect(tasks.find((t: any) => t.id === created.id)).toMatchObject({ status: "DONE", doneBy: userId("fc2@ga1.test") });
    // A manager of the line cannot work the tasks.
    expect((await (await as("um1@ga1.test"))(`/api/leads/${id}/tasks`, { json: { title: "x", dueAt: "2026-11-01T17:00:00+07:00" } })).status).toBe(403);
  });

  it("counts for every view tab", async () => {
    const counts = await json(await (await as("fc2@ga1.test"))("/api/leads/counts"));
    expect(counts).toMatchObject({ all: 2, mine: 2 });
    const mkt = await json(await (await as("marketing@ga1.test"))("/api/leads/counts"));
    expect(mkt.all).toBeGreaterThan(3);
    expect(Object.keys(mkt).sort()).toEqual(["all", "isNew", "mine", "newComment", "overdue", "unassigned"]);
  });
});

describe("bulk assignment", () => {
  it("assigns a whole page (more leads than fit in one D1 statement); the detail names the assignee", async () => {
    const mkt = await as("marketing@ga1.test");
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push((await json(await mkt("/api/leads", { json: { fullName: `Khách ${i}`, phone: `09111111${String(i).padStart(2, "0")}`, source: "Web", consent: true } }))).id);
    }
    expect(await json(await mkt("/api/leads/assign", { json: { leadIds: ids, agentCode: "9000004" } }))).toEqual({ assigned: 30 });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "ASSIGN"))).filter((a) => ids.includes(a.entityId!))).toHaveLength(30);
    expect(await historyOf(ids[29]!)).toEqual(["assignee: null -> 9000004"]);
    expect((await json(await mkt(`/api/leads/${ids[0]}`))).assignee).toEqual({ agentCode: "9000004", name: "Đặng Văn Tư Vấn" });
    expect(await json(await mkt("/api/leads/assign", { json: { leadIds: ids, agentCode: null } }))).toEqual({ assigned: 30 });
    expect((await json(await mkt(`/api/leads/${ids[0]}`))).assignee).toBeNull();
  });
});
