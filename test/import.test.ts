import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applications,
  auditLog,
  clientAgents,
  clients,
  importRows,
  imports,
  policies,
  policyAgents,
  policyClients,
  policyProducts,
  recordChanges,
} from "../src/db/schema";
import { GA1, GA2, userId } from "../src/db/seed";
import { parseRow } from "../src/shared/import/parse-row";
import { planSheet, SHEETS } from "../src/shared/import/template";
import { readWorkbook } from "../src/shared/import/workbook";
import { as, db, json, seedDb } from "./helpers";
import { agent, application, book, client, commit, policy, preview, product, run } from "./import-helpers";

// SPEC F2: Success data import, sheets 01-05.

const sample = () => readWorkbook(Uint8Array.from(atob(env.SAMPLE_XLSX_BASE64), (ch) => ch.charCodeAt(0)).buffer);
const ga1 = <T extends { tenantId: string }>(rows: T[]) => rows.filter((r) => r.tenantId === GA1.id);
const codes = (errors: { code: string }[]) => errors.map((e) => e.code).sort();

beforeAll(seedDb);

describe("the sample template", () => {
  it("is read with every template column found and nothing banned", () => {
    const wb = sample();
    expect(wb.sheets.map((s) => [s.name, s.rows.length])).toEqual([
      ["01_Agents", 1],
      ["02_Clients", 1],
      ["03_Policies", 1],
      ["04_Policy_Products", 1],
      ["05_Applications", 1],
      ["07_Activities", 1],
    ]);
    for (const s of wb.sheets) {
      expect(s.plan.missingRequired, s.name).toEqual([]);
      expect(s.plan.banned, s.name).toEqual([]);
      // customer_phone is a new optional column the v1.1 sample does not have yet.
      const missing = SHEETS[s.name].columns.filter((_, i) => s.plan.positions[i]! < 0).map((c) => c.header);
      expect(missing, s.name).toEqual(s.name === "07_Activities" ? ["customer_phone"] : []);
    }
    expect(wb.later).toHaveLength(4);
  });

  it("imports with 0 errors when its own FC uploads it, and leading zeros survive", async () => {
    const fc = await as("fc1@ga1.test");
    const { imp, errors } = await preview(fc, sample(), "DLVN_BDM_CRM_Import_Template_v1.1.xlsx");
    expect(errors).toEqual([]);
    expect(imp.status).toBe("VALIDATED");
    for (const name of ["02_Clients", "03_Policies", "04_Policy_Products", "05_Applications"]) {
      expect(imp.sheets[name], name).toMatchObject({ status: "READY", found: 1, inserted: 1, updated: 0, rejected: 0 });
    }
    // The FC's own agent row already exists from the seed.
    expect(imp.sheets["01_Agents"]).toMatchObject({ found: 1, inserted: 0, updated: 1, rejected: 0 });

    // Nothing is written before the uploader confirms.
    expect(await db.select().from(policies)).toEqual([]);
    expect((await commit(fc, imp.id)).status).toBe("COMMITTED");

    const [c] = await db.select().from(clients);
    expect(c).toMatchObject({
      tenantId: GA1.id,
      clientCode: "0000000001",
      name: "Lê Thị Khách Demo",
      nameNorm: "LE THI KHACH DEMO",
      tier: "Bạc",
      activePolicies: 1,
      usesDconnect: true,
      ekycRegistered: false,
      dconnectLastLoginAt: "2026-08-17T06:54:00.000Z", // 13:54 in Vietnam
      birthDayMonth: "15/03",
      ageBand: "30-39",
      lastImportId: imp.id,
    });
    const [p] = await db.select().from(policies);
    expect(p).toMatchObject({
      policyNo: "009000001",
      holderClientCode: "0000000001",
      servicingAgentCode: "9000001",
      holderNameNorm: "LE THI KHACH DEMO",
      effectiveDate: "2025-09-21",
      maturityDate: "2040-09-21",
      premiumFrequency: "Năm",
      basePremiumVnd: 13000000,
      hasBeneficiary: true,
    });
    const [pp] = await db.select().from(policyProducts);
    expect(pp).toMatchObject({ policyNo: "009000001", productCode: "TMP_ASHTV", insuredCode: "0000000001", sumAssuredVnd: 1000000000 });
    const [a] = await db.select().from(applications);
    expect(a).toMatchObject({ applicationNo: "EA09000001", policyNo: "009000002", clientCode: "0000000002", createdDate: "2026-09-23", apeVnd: 20000000 });

    expect(await db.select().from(policyAgents)).toMatchObject([
      { policyNo: "009000001", agentCode: "9000001", splitPercent: 100, isServicing: true, endedAt: null },
    ]);
    // The holder is also the main insured, and the insured of the product.
    const roles = (await db.select().from(policyClients)).map((l) => `${l.clientCode}:${l.role}:${l.source}`).sort();
    expect(roles).toEqual(["0000000001:LI:POLICY", "0000000001:PO:POLICY"]);
    const links = await db.select().from(clientAgents);
    expect(links.map((l) => `${l.clientCode}>${l.agentCode}`)).toEqual(["0000000001>9000001"]);
    const me = (await db.select().from(agents)).find((x) => x.tenantId === GA1.id && x.agentCode === "9000001")!;
    expect(me).toMatchObject({ dob: "1995-03-15", gender: "Nữ", startDate: "2026-06-09", officeCode: "GA-HCM-TSN", managerCode: "9000100" });
  });

  it("imported again, it updates instead of duplicating", async () => {
    const { imp, errors } = await run(await as("fc1@ga1.test"), sample());
    expect(errors).toEqual([]);
    for (const name of Object.keys(SHEETS).filter((n) => n !== "13_Leads")) expect(imp.sheets[name], name).toMatchObject({ inserted: 0, updated: 1 });
    expect(await db.select().from(policies)).toHaveLength(1);
    expect(await db.select().from(policyAgents)).toHaveLength(1);
    expect((await db.select().from(policies))[0]!.lastImportId).toBe(imp.id);
    // The first import filled in the seeded agent's details; the second changes nothing, so logs nothing.
    const logged = await db.select().from(recordChanges);
    expect(logged.map((r) => `${r.entity}:${r.field}`).sort()).toEqual(["agent:dob", "agent:gender", "agent:office_code", "agent:start_date"]);
    expect(logged.filter((r) => r.importId === imp.id)).toEqual([]);
  });

  it("writes one IMPORT audit row per confirmed import and empties the staging table", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "IMPORT"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenantId: GA1.id, userId: userId("fc1@ga1.test"), entity: "import" });
    expect(JSON.parse(rows[0]!.meta!).sheets["03_Policies"]).toEqual({ inserted: 1, updated: 0, rejected: 0 });
    expect(await db.select().from(importRows)).toEqual([]);
  });
});

describe("upload scope rule", () => {
  it("a policy of an agent outside the scope rejects only that row", async () => {
    const fc = await as("fc1@ga1.test");
    const { imp, errors } = await run(
      fc,
      book({
        "03_Policies": [
          policy({ "Số HĐBH": "009000010" }),
          policy({ "Số HĐBH": "009000011", "Mã đại lý": "9000003" }), // another FC, under another UM
          policy({ "Số HĐBH": "009000012" }),
        ],
      }),
    );
    expect(imp.sheets["03_Policies"]).toMatchObject({ found: 3, inserted: 2, rejected: 1 });
    expect(errors).toMatchObject([{ sheet: "03_Policies", row: 3, column: "Mã đại lý", code: "out_of_scope", severity: "error" }]);
    expect(errors[0]!.message).toMatch(/không thuộc phạm vi/);
    const stored = (await db.select().from(policies)).map((p) => p.policyNo);
    expect(stored).toEqual(expect.arrayContaining(["009000010", "009000012"]));
    expect(stored).not.toContain("009000011");
  });

  it("a UM uploads for the FCs below them, not for a peer's FC or for the BM above", async () => {
    const { imp, errors } = await run(
      await as("um1@ga1.test"),
      book({
        "03_Policies": [
          policy({ "Số HĐBH": "009000020", "Mã đại lý": "9000100" }), // self
          policy({ "Số HĐBH": "009000021", "Mã đại lý": "9000002" }), // own FC
          policy({ "Số HĐBH": "009000022", "Mã đại lý": "9000003" }), // peer UM's FC
          policy({ "Số HĐBH": "009000023", "Mã đại lý": "9000500" }), // upline
          policy({ "Số HĐBH": "009000024", "Mã đại lý": "9100001" }), // an agent of GA-2
        ],
        "05_Applications": [
          application({ "Số HSYCBH": "EA09000020", "Mã đại lý": "9000002" }),
          application({ "Số HSYCBH": "EA09000021", "Mã đại lý": "9000200" }),
        ],
      }),
    );
    expect(imp.sheets["03_Policies"]).toMatchObject({ inserted: 2, rejected: 3 });
    expect(imp.sheets["05_Applications"]).toMatchObject({ inserted: 1, rejected: 1 });
    expect(errors.map((e) => `${e.sheet}:${e.row}:${e.code}`)).toEqual([
      "03_Policies:4:out_of_scope",
      "03_Policies:5:out_of_scope",
      "03_Policies:6:out_of_scope",
      "05_Applications:3:out_of_scope",
    ]);
  });

  it("an application that belongs to an agent outside the scope cannot be taken over", async () => {
    await run(await as("fc3@ga1.test"), book({ "05_Applications": [application({ "Số HSYCBH": "EA09000030", "Mã đại lý": "9000003" })] }));
    const { errors } = await run(await as("fc1@ga1.test"), book({ "05_Applications": [application({ "Số HSYCBH": "EA09000030", "Mã đại lý": "9000001" })] }));
    expect(codes(errors)).toEqual(["owned_by_other"]);
    expect((await db.select().from(applications)).find((a) => a.applicationNo === "EA09000030")!.agentCode).toBe("9000003");
  });

  it("policy products follow their policy", async () => {
    const { imp, errors } = await run(
      await as("fc2@ga1.test"),
      book({
        "03_Policies": [policy({ "Số HĐBH": "009000040", "Mã đại lý": "9000002" })],
        "04_Policy_Products": [
          product({ "Số HĐBH": "009000040" }), // policy in this file
          product({ "Số HĐBH": "009000021" }), // own policy, imported earlier by the UM
          product({ "Số HĐBH": "009000010" }), // another FC's policy
          product({ "Số HĐBH": "009999999" }), // unknown policy
        ],
      }),
    );
    expect(imp.sheets["04_Policy_Products"]).toMatchObject({ inserted: 2, rejected: 2 });
    expect(errors.map((e) => `${e.row}:${e.code}`)).toEqual(["4:policy_not_found", "5:policy_not_found"]);
  });

  it("a client of another agent is accepted only together with an own policy or application", async () => {
    const fc3 = await as("fc3@ga1.test");
    await run(fc3, book({ "02_Clients": [client({ "Mã Khách Hàng": "0000000050", "Bên Mua BH": "Khách Của FC3", "Nhóm Khách Hàng": "Vàng" })] }));

    const alone = await run(await as("fc4@ga1.test"), book({ "02_Clients": [client({ "Mã Khách Hàng": "0000000050", "Bên Mua BH": "X" })] }));
    expect(codes(alone.errors)).toEqual(["client_out_of_scope"]);
    expect((await db.select().from(clients)).find((c) => c.clientCode === "0000000050")!.name).toBe("Khách Của FC3");

    const withPolicy = await run(
      await as("fc4@ga1.test"),
      book({
        "02_Clients": [client({ "Mã Khách Hàng": "0000000050", "Bên Mua BH": "Khách Của FC3" })],
        "03_Policies": [policy({ "Số HĐBH": "009000050", "Mã KH BMBH": "0000000050", "Mã đại lý": "9000004" })],
      }),
    );
    expect(withPolicy.errors).toEqual([]);
    const links = (await db.select().from(clientAgents)).filter((l) => l.clientCode === "0000000050");
    expect(links.map((l) => `${l.agentCode}:${l.source}`).sort()).toEqual(["9000003:CLIENTS_SHEET", "9000004:CLIENTS_SHEET"]);
  });

  it("by default Marketing imports 02-05 for the whole GA but not the tree; Admin only the tree", async () => {
    const mkt = await preview(
      await as("marketing@ga1.test"),
      book({
        "01_Agents": [agent("9000001", "Nguyễn Thị Demo", "FC", "UM: 9000100-Trần Văn Quản Lý")],
        "03_Policies": [policy({ "Số HĐBH": "009000035", "Mã đại lý": "9000003" }), policy({ "Số HĐBH": "009000036", "Mã đại lý": "9000004" })],
      }),
    );
    expect(mkt.imp.sheets["01_Agents"].status).toBe("BLOCKED");
    expect(mkt.imp.sheets["03_Policies"]).toMatchObject({ status: "READY", inserted: 2, rejected: 0 });
    expect(mkt.errors).toMatchObject([{ sheet: "01_Agents", row: 1, code: "sheet_not_allowed" }]);

    const { imp, errors } = await preview(
      await as("admin@ga1.test"),
      book({ "01_Agents": [agent("9000001", "Nguyễn Thị Demo", "FC", "UM: 9000100-Trần Văn Quản Lý")], "03_Policies": [policy()] }),
    );
    expect(imp.sheets["01_Agents"].status).toBe("READY");
    expect(imp.sheets["03_Policies"].status).toBe("BLOCKED");
    expect(errors).toMatchObject([{ sheet: "03_Policies", row: 1, code: "sheet_not_allowed" }]);
  });
});

describe("validation", () => {
  it("a missing required column blocks its own sheet only", async () => {
    const def = SHEETS["03_Policies"];
    const { imp, errors } = await run(
      await as("fc1@ga1.test"),
      book({
        "02_Clients": [client({ "Mã Khách Hàng": "0000000060" })],
        "03_Policies": { headers: def.columns.map((c) => c.header).filter((h) => h !== "Mã đại lý"), rows: [policy({ "Số HĐBH": "009000060" })] },
      }),
    );
    expect(imp.sheets["03_Policies"]).toMatchObject({ status: "BLOCKED", found: 0 });
    expect(imp.sheets["02_Clients"]).toMatchObject({ status: "READY", inserted: 1 });
    expect(errors).toMatchObject([{ sheet: "03_Policies", row: 1, column: "Mã đại lý", code: "missing_required_column" }]);
    expect((await db.select().from(policies)).some((p) => p.policyNo === "009000060")).toBe(false);
  });

  it("a missing optional column is accepted and does not wipe what is already stored", async () => {
    const fc = await as("fc1@ga1.test");
    const before = (await db.select().from(policies)).find((p) => p.policyNo === "009000001")!;
    expect(before.premiumDueDate).toBe("2026-09-21");
    const headers = SHEETS["03_Policies"].columns.map((c) => c.header).filter((h) => !["Ngày đến hạn đóng phí", "Tỉ lệ chia"].includes(h));
    const { errors } = await run(fc, book({ "03_Policies": { headers, rows: [policy({ "Tình trạng": "Mất hiệu lực" })] } }));
    expect(errors).toEqual([]);
    const after = (await db.select().from(policies)).find((p) => p.policyNo === "009000001")!;
    expect(after).toMatchObject({ status: "Mất hiệu lực", premiumDueDate: "2026-09-21" });
    expect((await db.select().from(policyAgents)).find((l) => l.policyNo === "009000001")!.splitPercent).toBe(100);
    // The change is in the policy's history, with who and which import.
    const history = (await db.select().from(recordChanges)).filter((r) => r.entityKey === "009000001");
    expect(history).toMatchObject([{ entity: "policy", field: "status", oldValue: "Đang hiệu lực", newValue: "Mất hiệu lực", changedBy: userId("fc1@ga1.test") }]);
  });

  it("accepts the dictionary header 'Mã KH' for the policyholder column", () => {
    const headers = SHEETS["03_Policies"].columns.map((c) => (c.header === "Mã KH BMBH" ? "  mã kh " : c.header));
    expect(planSheet(SHEETS["03_Policies"], headers).missingRequired).toEqual([]);
  });

  it("rejects PDP-banned columns, keeps the rows, and does not keep the workbook", async () => {
    const fc = await as("fc1@ga1.test");
    const def = SHEETS["02_Clients"];
    const headers = [...def.columns.map((c) => c.header), "Số CCCD", "Số tài khoản ngân hàng", "Tiền sử bệnh", "Ghi chú"];
    const wb = book({ "02_Clients": { headers, rows: [{ ...client({ "Mã Khách Hàng": "0000000070" }), "Số CCCD": "079000000001" }] } });
    // The reader never puts a banned or unknown column into the rows it sends.
    expect(JSON.stringify(wb.sheets[0]!.rows)).not.toContain("079000000001");

    const { imp, errors } = await preview(fc, wb);
    expect(errors.map((e) => `${e.row}:${e.column}:${e.code}`).sort()).toEqual([
      "1:Số CCCD:banned_column",
      "1:Số tài khoản ngân hàng:banned_column",
      "1:Tiền sử bệnh:banned_column",
    ]);
    expect(imp.sheets["02_Clients"]).toMatchObject({ status: "READY", inserted: 1, rejected: 0 });
    // "Đã cập nhật Căn cước" is a template column (a yes/no flag), not a banned one.
    expect(planSheet(def, def.columns.map((c) => c.header)).banned).toEqual([]);

    const put = await fc(`/api/imports/${imp.id}/file`, { method: "PUT", headers: { "content-type": "application/octet-stream" } });
    expect(put.status).toBe(409);
    expect((await env.UPLOADS.list()).objects).toEqual([]);
    expect((await commit(fc, imp.id)).fileKept).toBe(false);
  });

  it("checks formats cell by cell and reports row, column and a Vietnamese message", async () => {
    const { imp, errors } = await run(
      await as("fc1@ga1.test"),
      book({
        "03_Policies": [
          policy({ "Số HĐBH": "009000080", "Ngày hiệu lực": "31/02/2025" }),
          policy({ "Số HĐBH": "009000081", "Định kỳ đóng phí": "Hàng tuần" }),
          policy({ "Số HĐBH": "9000082" }), // text key that lost its zeros
          policy({ "Số HĐBH": "009000083", "Phí định kỳ/cơ bản định kỳ": "mười ba triệu", "Tỉ lệ chia": "150%" }),
          policy({ "Số HĐBH": "009000084", "Bên mua BH": null }),
          policy({ "Số HĐBH": "009000085", "Ngày đáo hạn": "2040-09-21" }),
          policy({ "Số HĐBH": "009000086", "Đã có người thụ hưởng": "Yes" }),
          policy({ "Số HĐBH": "009000087", "Phí định kỳ/cơ bản định kỳ": "13.000.000", "Tỉ lệ chia": 0.5, "Định kỳ đóng phí": "nửa NĂM" }),
        ],
        "01_Agents": [agent("9000001", "Nguyễn Thị Demo", "FC", "9000100 Trần Văn Quản Lý"), agent("9000001", "X", "CEO", null)],
      }),
    );
    expect(errors.filter((e) => e.sheet === "03_Policies" && e.severity === "error").map((e) => `${e.row}:${e.column}:${e.code}`)).toEqual([
      "2:Ngày hiệu lực:invalid_date",
      "3:Định kỳ đóng phí:invalid_list",
      "4:Số HĐBH:invalid_key_policy",
      "5:Phí định kỳ/cơ bản định kỳ:invalid_number",
      "5:Tỉ lệ chia:invalid_percent",
      "6:Bên mua BH:required",
      "7:Ngày đáo hạn:invalid_date",
      "8:Đã có người thụ hưởng:invalid_yes_no",
    ]);
    expect(codes(errors.filter((e) => e.sheet === "01_Agents"))).toEqual(["invalid_agent_ref", "invalid_agent_ref"]);
    expect(errors.every((e) => /[àáạảãăâđêôơưếệộớ]/i.test(e.message))).toBe(true);
    // 50% from an FC's own export is that FC's share: imported without a warning.
    expect(errors.filter((e) => e.severity === "warning")).toEqual([]);
    expect(imp.sheets["03_Policies"]).toMatchObject({ found: 8, inserted: 1, rejected: 7 });
    const good = (await db.select().from(policies)).find((p) => p.policyNo === "009000087")!;
    expect(good).toMatchObject({ basePremiumVnd: 13000000, premiumFrequency: "Nửa năm" });
    expect((await db.select().from(policyAgents)).find((l) => l.policyNo === "009000087")!.splitPercent).toBe(50);
  });

  it("left-pads keys that Excel turned into numbers, with a warning", async () => {
    const { imp, errors } = await run(
      await as("fc1@ga1.test"),
      book({
        "02_Clients": [client({ "Mã Khách Hàng": 90 })],
        "03_Policies": [policy({ "Số HĐBH": 9000090, "Mã KH BMBH": 90, "Mã NĐBH chính": null, "Mã đại lý": 9000001 })],
      }),
    );
    expect(errors.map((e) => `${e.sheet}:${e.column}:${e.code}:${e.severity}`)).toEqual([
      "02_Clients:Mã Khách Hàng:padded_key:warning",
      "03_Policies:Mã KH BMBH:padded_key:warning",
      "03_Policies:Số HĐBH:padded_key:warning",
    ]);
    expect(imp.sheets["03_Policies"]).toMatchObject({ inserted: 1, rejected: 0, warnings: 2 });
    expect((await db.select().from(policies)).find((p) => p.policyNo === "009000090")).toMatchObject({ holderClientCode: "0000000090", servicingAgentCode: "9000001" });
    expect((await db.select().from(clients)).some((c) => c.clientCode === "0000000090")).toBe(true);
  });

  it("keeps the first of two rows with the same key", async () => {
    const { imp, errors } = await run(
      await as("fc1@ga1.test"),
      book({ "02_Clients": [client({ "Mã Khách Hàng": "0000000095", "Bên Mua BH": "Đầu Tiên" }), client({ "Mã Khách Hàng": "0000000095", "Bên Mua BH": "Thứ Hai" })] }),
    );
    expect(errors).toMatchObject([{ row: 3, code: "duplicate_key" }]);
    expect(imp.sheets["02_Clients"]).toMatchObject({ inserted: 1, rejected: 1 });
    expect((await db.select().from(clients)).find((c) => c.clientCode === "0000000095")!.name).toBe("Đầu Tiên");
  });

  it("parseRow: dates, times and impossible values", () => {
    const def = SHEETS["02_Clients"];
    const all = def.columns.map(() => true);
    const cells = (over: Record<string, unknown>) => def.columns.map((c) => (over[c.header] ?? null) as string | number | null);
    const base = { "Mã Khách Hàng": "0000000001", "Bên Mua BH": "  Đỗ   Thị  Đào " };
    const good = parseRow(def, all, cells({ ...base, "Ngày Sinh": "29/02/2000", "Thời gian đăng ký eKYC": "01/01/2026 00:30", birth_day_month: "29/02" }));
    expect(good.issues).toEqual([]);
    expect(good.data).toMatchObject({ name: "Đỗ   Thị  Đào", name_norm: "DO THI DAO", dob: "2000-02-29", ekyc_registered_at: "2025-12-31T17:30:00.000Z" });
    for (const [header, value] of [["Ngày Sinh", "29/02/2001"], ["Ngày Sinh", "12/13/2020"], ["Ngày Sinh", 45000], ["Thời gian đăng ký eKYC", "01/01/2026 25:00"], ["birth_day_month", "31/04"], ["Điểm Thưởng", -1], ["Điểm Thưởng", 1.5]] as const) {
      expect(parseRow(def, all, cells({ ...base, [header]: value })).issues, `${header}=${value}`).toHaveLength(1);
    }
  });
});

describe("agent tree from 01_Agents", () => {
  it("an FC cannot add agents or rewire the tree", async () => {
    const before = ga1(await db.select().from(agents)).length;
    const { errors } = await run(
      await as("fc1@ga1.test"),
      book({
        "01_Agents": [
          agent("9000001", "Nguyễn Thị Demo Mới", "FC", "BM: 9000900-Lý Minh Giám Đốc"), // own row, other manager
          agent("9000777", "Người Lạ", "FC", "FC: 9000001-Nguyễn Thị Demo"), // a new agent placed below themselves
          agent("9000002", "Lê Văn Tư Vấn", "FC", "FC: 9000001-Nguyễn Thị Demo"), // a peer
        ],
      }),
    );
    expect(errors.map((e) => `${e.row}:${e.code}`)).toEqual(["3:out_of_scope", "4:out_of_scope"]);
    const rows = ga1(await db.select().from(agents));
    expect(rows).toHaveLength(before);
    // Own details are updated; the manager link is not theirs to change.
    expect(rows.find((a) => a.agentCode === "9000001")).toMatchObject({ name: "Nguyễn Thị Demo Mới", managerCode: "9000100", path: "/9000900/9000500/9000100/9000001/" });
    expect(rows.find((a) => a.agentCode === "9000002")!.managerCode).toBe("9000100");
  });

  it("the GA Head's upload builds the tree, creating managers that have no row of their own", async () => {
    const head = await as("head@ga2.test");
    const { imp, errors } = await run(
      head,
      book({
        "01_Agents": [
          agent("9100003", "Tân Binh", "FC", "UM: 9100200-Quản Lý Mới"),
          agent("9100200", "Quản Lý Mới", "UM", "BM: 9100500-Dương Thị Trưởng Ban"),
          agent("9100004", "Tân Binh Hai", "FC", "UM: 9100300-Chưa Có Dòng Riêng"),
          agent("9100002", "Cao Văn Tư Vấn", "FC", "UM: 9100200-Quản Lý Mới"), // moved to the new UM
          agent("9100900", "Ngô Văn Giám Đốc", "BM", null),
        ],
      }),
    );
    expect(errors).toEqual([]);
    expect(imp.sheets["01_Agents"]).toMatchObject({ found: 5, inserted: 3, updated: 2 });
    const tree = Object.fromEntries((await db.select().from(agents)).filter((a) => a.tenantId === GA2.id).map((a) => [a.agentCode, a.path]));
    expect(tree).toMatchObject({
      "9100900": "/9100900/",
      "9100200": "/9100900/9100500/9100200/",
      "9100003": "/9100900/9100500/9100200/9100003/",
      "9100002": "/9100900/9100500/9100200/9100002/",
      "9100300": "/9100300/",
      "9100004": "/9100300/9100004/",
      "9100001": "/9100900/9100500/9100100/9100001/",
    });
    const stub = (await db.select().from(agents)).find((a) => a.agentCode === "9100300")!;
    expect(stub).toMatchObject({ name: "Chưa Có Dòng Riêng", rank: "UM", managerCode: null });
    // GA-1 is untouched.
    expect(ga1(await db.select().from(agents)).some((a) => a.agentCode.startsWith("91"))).toBe(false);
  });

  it("a manager link fixed by hand survives the next import, with a warning", async () => {
    const head = await as("head@ga2.test");
    await head("/api/agents/9100001/manager", { method: "PATCH", json: { managerCode: "9100200" } });
    const { imp, errors } = await run(head, book({ "01_Agents": [agent("9100001", "Mai Thị Tư Vấn", "FC", "UM: 9100100-Đinh Văn Quản Lý", { "Giới tính": "Nữ" })] }));
    expect(errors).toMatchObject([{ row: 2, column: "Quản lý", code: "manager_fixed_kept", severity: "warning" }]);
    expect(imp.sheets["01_Agents"]).toMatchObject({ updated: 1, rejected: 0, warnings: 1 });
    const row = (await db.select().from(agents)).find((a) => a.agentCode === "9100001")!;
    expect(row).toMatchObject({ managerCode: "9100200", gender: "Nữ", path: "/9100900/9100500/9100200/9100001/" });
  });
});

describe("history, access and state", () => {
  it("keeps the original workbook in R2 under the tenant", async () => {
    const fc = await as("fc2@ga1.test");
    const { imp } = await preview(fc, book({ "02_Clients": [client({ "Mã Khách Hàng": "0000000100" })] }), "tuần 41.xlsx");
    const put = await fc(`/api/imports/${imp.id}/file`, { method: "PUT", headers: { "content-type": "application/octet-stream" } });
    expect(put.status).toBe(400); // empty body
    const res = await (await import("../src/server/app")).app.request(
      `/api/imports/${imp.id}/file`,
      { method: "PUT", body: new Uint8Array([80, 75, 3, 4]), headers: { cookie: await cookieOf("fc2@ga1.test"), origin: env.APP_URL } },
      env,
    );
    expect(res.status).toBe(204);
    const object = await env.UPLOADS.get(`imports/${GA1.id}/${imp.id}.xlsx`);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
    expect((await commit(fc, imp.id)).fileKept).toBe(true);
  });

  it("a user sees their own imports; GA Head and Admin see all of the tenant", async () => {
    const mine = await json(await (await as("fc3@ga1.test"))("/api/imports"));
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((i: any) => i.userId === userId("fc3@ga1.test"))).toBe(true);

    const all = (await db.select().from(imports)).filter((i) => i.tenantId === GA1.id).length;
    for (const email of ["head@ga1.test", "admin@ga1.test"]) {
      const list = await json(await (await as(email))("/api/imports?pageSize=50"));
      expect(list.total, email).toBe(all);
      expect(list.items[0]).toHaveProperty("userName");
    }
    // A UM does not see the imports of their FCs (history is per user).
    const um = await json(await (await as("um1@ga1.test"))("/api/imports?pageSize=50"));
    expect(um.items.every((i: any) => i.userId === userId("um1@ga1.test"))).toBe(true);
  });

  it("an import of another user or tenant is not found, and only its owner can change it", async () => {
    const fc = await as("fc1@ga1.test");
    const { imp } = await preview(fc, book({ "02_Clients": [client({ "Mã Khách Hàng": "0000000110" })] }));

    for (const email of ["fc2@ga1.test", "um1@ga1.test", "head@ga2.test", "admin@ga2.test"]) {
      const other = await as(email);
      expect((await other(`/api/imports/${imp.id}`)).status, email).toBe(404);
      expect((await other(`/api/imports/${imp.id}/errors`).then(json)).total, email).toBe(0);
      expect((await other(`/api/imports/${imp.id}/commit`, { method: "POST" })).status, email).toBe(404);
    }
    // The GA Head may look, not confirm on the uploader's behalf.
    const head = await as("head@ga1.test");
    expect((await head(`/api/imports/${imp.id}`)).status).toBe(200);
    expect((await head(`/api/imports/${imp.id}/commit`, { method: "POST" })).status).toBe(404);
    expect((await head(`/api/imports/${imp.id}/rows`, { json: { sheet: "02_Clients", rows: [{ r: 2, c: [] }] } })).status).toBe(404);
    expect((await db.select().from(clients)).some((c) => c.clientCode === "0000000110")).toBe(false);
    await commit(fc, imp.id);
  });

  it("follows PARSING -> VALIDATED -> COMMITTED and abandons an unconfirmed import when a new one starts", async () => {
    const fc = await as("fc1@ga1.test");
    const created = await json(await fc("/api/imports", { json: { fileName: "a.xlsx", snapshotDate: "2026-10-13", sheets: [{ name: "02_Clients", headers: SHEETS["02_Clients"].columns.map((c) => c.header) }] } }));
    expect((await fc(`/api/imports/${created.id}/commit`, { method: "POST" })).status).toBe(409);

    const first = await preview(fc, book({ "02_Clients": [client({ "Mã Khách Hàng": "0000000120" })] }));
    expect((await json(await fc(`/api/imports/${created.id}`))).status).toBe("FAILED");
    expect((await fc(`/api/imports/${first.imp.id}/validate`, { method: "POST" })).status).toBe(409);
    expect((await fc(`/api/imports/${first.imp.id}/rows`, { json: { sheet: "02_Clients", rows: [{ r: 9, c: [] }] } })).status).toBe(409);

    const second = await preview(fc, book({ "02_Clients": [client({ "Mã Khách Hàng": "0000000121" })] }));
    expect((await fc(`/api/imports/${first.imp.id}/commit`, { method: "POST" })).status).toBe(409);
    await commit(fc, second.imp.id);
    expect((await fc(`/api/imports/${second.imp.id}/commit`, { method: "POST" })).status).toBe(409);

    const stored = (await db.select().from(clients)).map((c) => c.clientCode);
    expect(stored).toContain("0000000121");
    expect(stored).not.toContain("0000000120");
    const mine = (await db.select().from(imports)).filter((i) => i.userId === userId("fc1@ga1.test")).map((i) => i.id);
    expect((await db.select().from(importRows)).filter((r) => mine.includes(r.importId))).toEqual([]);
  });

  it("imported data stays inside the tenant", async () => {
    expect((await db.select().from(policies)).every((p) => p.tenantId === GA1.id)).toBe(true);
    // The same policy number can exist in GA-2 without touching GA-1's.
    const { errors } = await run(await as("head@ga2.test"), book({ "03_Policies": [policy({ "Mã đại lý": "9100001", "Bên mua BH": "Của GA2" })] }));
    expect(errors).toEqual([]);
    const both = await db.select().from(policies).where(eq(policies.policyNo, "009000001"));
    expect(both.map((p) => `${p.tenantId}:${p.servicingAgentCode}`).sort()).toEqual([`${GA1.id}:9000001`, `${GA2.id}:9100001`]);
    expect(await db.select().from(policyAgents).where(and(eq(policyAgents.tenantId, GA2.id), eq(policyAgents.agentCode, "9000001")))).toEqual([]);
  });
});

describe("volume", () => {
  it("2,000 rows across sheets are previewed and committed in well under 30 seconds", async () => {
    const head = await as("head@ga1.test");
    const n = (i: number, len: number) => String(i).padStart(len, "0");
    const fcs = ["9000001", "9000002", "9000003", "9000004"];
    const wb = book({
      "01_Agents": Array.from({ length: 40 }, (_, i) => agent(`95${n(i, 5)}`, `Đại Lý ${i}`, "FC", "UM: 9000300-Hồ Văn Quản Lý")),
      "02_Clients": Array.from({ length: 500 }, (_, i) => client({ "Mã Khách Hàng": n(500000 + i, 10), "Bên Mua BH": `Khách Hàng ${i}` })),
      "03_Policies": Array.from({ length: 700 }, (_, i) => policy({ "Số HĐBH": n(500000 + i, 9), "Mã KH BMBH": n(500000 + (i % 500), 10), "Mã NĐBH chính": null, "Mã đại lý": fcs[i % 4]! })),
      "04_Policy_Products": Array.from({ length: 500 }, (_, i) => product({ "Số HĐBH": n(500000 + i, 9), "Mã NĐBH": n(500000 + (i % 500), 10) })),
      "05_Applications": Array.from({ length: 260 }, (_, i) => application({ "Số HSYCBH": `EB${n(i, 8)}`, "Số HĐBH": null, "Mã KH": n(500000 + i, 10), "Mã đại lý": fcs[i % 4]! })),
    });
    expect(wb.sheets.reduce((sum, s) => sum + s.rows.length, 0)).toBe(2000);

    const started = Date.now();
    const { imp, errors } = await preview(head, wb);
    const previewed = Date.now();
    const done = await commit(head, imp.id);
    const committed = Date.now();

    expect(errors).toEqual([]);
    expect(Object.values(done.sheets as Record<string, { inserted: number }>).reduce((sum, s) => sum + s.inserted, 0)).toBe(2000);
    expect((await db.select().from(policies)).filter((p) => p.policyNo.startsWith("0005")).length).toBe(700);
    expect(ga1(await db.select().from(agents)).filter((a) => a.path.startsWith("/9000900/9000600/9000300/95")).length).toBe(40);
    console.log(`2,000 rows: preview ${previewed - started} ms, commit ${committed - previewed} ms`);
    expect(committed - previewed).toBeLessThan(30_000);
    expect(committed - started).toBeLessThan(30_000);
  });
});

async function cookieOf(email: string) {
  const { signIn } = await import("./helpers");
  const res = await signIn(email);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
