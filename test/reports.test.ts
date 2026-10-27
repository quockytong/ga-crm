import { beforeAll, describe, expect, it } from "vitest";
import { successActivities } from "../src/db/schema";
import { as, db, json, seedDb } from "./helpers";
import { activity, book, lead, run } from "./import-helpers";

// "Hoạt động đại lý": CRM contact logs + Success activity tracking (07_Activities).
// A call or meeting with the same customer on the same day counts once.

let leadId = "";
const report = async (email: string, q = "?from=2026-10-01&to=2026-10-31") => json(await (await as(email))(`/api/reports/activities${q}`));

beforeAll(async () => {
  await seedDb();
  await run(await as("marketing@ga1.test"), book({ "13_Leads": [lead({ "SỐ ĐIỆN THOẠI": "0900000001", "Mã đại lý": "9000001" })] }));
  leadId = (await json(await (await as("fc1@ga1.test"))("/api/leads"))).items[0].id;
  const fc1 = await as("fc1@ga1.test");
  await fc1(`/api/leads/${leadId}/activities`, { json: { type: "CALL", note: "Gọi lần 1", occurredAt: "2026-10-05T08:00:00+07:00" } });
  await fc1(`/api/leads/${leadId}/activities`, { json: { type: "MEETING", note: "Gặp tại nhà", occurredAt: "2026-10-06T15:00:00+07:00" } });
  await fc1(`/api/leads/${leadId}/activities`, { json: { type: "NOTE", note: "Ghi chú không phải hoạt động", occurredAt: "2026-10-06T16:00:00+07:00" } });
});

describe("importing 07_Activities", () => {
  it("stores the day in Vietnam time and a masked phone key", async () => {
    const { errors } = await run(
      await as("fc1@ga1.test"),
      book({
        "07_Activities": [
          // Same call as in the CRM (same day, same phone): counted once.
          activity({ activity_id: "act-1", customer_phone: "0900000001" }),
          activity({ activity_id: "act-2", started_at: "2026-10-07T23:30:00+07:00", customer_phone: "0900000001" }),
          // Same meeting, with Success' masked phone.
          activity({ activity_id: "act-3", activity_type_id: "4 Meeting with Customer", started_at: "2026-10-06T10:00:00+07:00", call_phone_hash: "0900***001" }),
          activity({ activity_id: "act-4", call_type: "zalo", customer_phone: "0900000001" }),
          activity({ activity_id: "act-5", activity_type_id: 7, customer_id: "KH-1" }),
          activity({ activity_id: "act-6", status: "rejected" }),
          activity({ activity_id: "act-7", status: "draft" }),
          activity({ activity_id: "act-8", agent_code: "9000003" }), // another FC's
          activity({ activity_id: "act-9", started_at: "hôm qua" }),
        ],
      }),
    );
    expect(errors.map((e) => `${e.row}:${e.code}`)).toEqual(["9:out_of_scope", "10:invalid_datetime"]);
    const stored = await db.select().from(successActivities);
    expect(stored.find((s) => s.activityId === "act-2")).toMatchObject({ activityDate: "2026-10-07", phoneKey: "0900***001", startedAt: "2026-10-07T16:30:00.000Z" });
    expect(stored.find((s) => s.activityId === "act-3")).toMatchObject({ activityType: "MEETING", phoneKey: "0900***001" });
    expect(stored.find((s) => s.activityId === "act-5")).toMatchObject({ activityType: "PROPOSAL", phoneKey: null });
  });
});

describe("the report", () => {
  it("counts each action once across both sources", async () => {
    const { items } = await report("fc1@ga1.test");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      agentCode: "9000001",
      counts: { CALL: 2, ZALO: 1, MEETING: 1, PROPOSAL: 1, SEMINAR: 0, CHECKIN: 0 },
      total: 5,
      fromCrm: 2,
      fromSuccess: 5,
    });
  });

  it("shows leads closed in the period next to the actions", async () => {
    await (await as("fc1@ga1.test"))(`/api/leads/${leadId}`, { method: "PATCH", json: { interest: "LIFE", careStatus: "WON", applicationNo: "EA09000099" } });
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const { items } = await report("fc1@ga1.test", `?from=${today.slice(0, 7)}-01&to=${today}`);
    expect(items.find((i: any) => i.agentCode === "9000001").won).toBe(1);
  });

  it("follows the line: a manager sees their FCs, lead managers everyone, a peer nothing", async () => {
    expect((await report("um1@ga1.test")).items.map((i: any) => i.agentCode)).toEqual(["9000001"]);
    expect((await report("marketing@ga1.test")).items.map((i: any) => i.agentCode)).toEqual(["9000001"]);
    expect((await report("um2@ga1.test")).items).toEqual([]);
    expect((await report("fc3@ga1.test")).items).toEqual([]);
    expect((await report("head@ga2.test")).items).toEqual([]);
  });

  it("filters by period", async () => {
    expect((await report("fc1@ga1.test", "?from=2026-10-07&to=2026-10-07")).items[0].counts).toMatchObject({ CALL: 1, MEETING: 0 });
    expect((await report("fc1@ga1.test", "?from=2026-11-01&to=2026-11-30")).items.filter((i: any) => i.total > 0)).toEqual([]);
  });
});
