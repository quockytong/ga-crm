import type { Cell } from "../src/shared/import/parse-row";
import { planSheet, SHEETS, type SheetName } from "../src/shared/import/template";
import type { Workbook } from "../src/shared/import/workbook";
import { json, type Client } from "./helpers";

type Row = Record<string, Cell>;

/** A workbook as the browser would hand it over, built from rows keyed by header. */
export function book(sheets: Partial<Record<SheetName, Row[] | { headers: string[]; rows: Row[] }>>): Workbook {
  return {
    later: [],
    sheets: Object.entries(sheets).map(([name, value]) => {
      const def = SHEETS[name as SheetName];
      const rows = Array.isArray(value) ? value : value.rows;
      const headers = Array.isArray(value) ? def.columns.map((c) => c.header) : value.headers;
      const plan = planSheet(def, headers);
      return {
        name: name as SheetName,
        headers,
        plan,
        rows: rows.map((row, i) => ({
          r: i + 2,
          c: plan.positions.map((p) => (p < 0 ? null : (row[headers[p]!] ?? null))),
        })),
      };
    }),
  };
}

/** Announce, send rows in chunks and validate: everything up to the preview. */
export async function preview(client: Client, wb: Workbook, fileName = "export.xlsx") {
  const created = await client("/api/imports", {
    json: { fileName, snapshotDate: "2026-10-13", sheets: wb.sheets.map((s) => ({ name: s.name, headers: s.headers })) },
  });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${await created.text()}`);
  const imp = await json(created);
  for (const sheet of wb.sheets) {
    if (imp.sheets[sheet.name]?.status !== "READY") continue;
    for (let i = 0; i < sheet.rows.length; i += 500) {
      const res = await client(`/api/imports/${imp.id}/rows`, { json: { sheet: sheet.name, rows: sheet.rows.slice(i, i + 500) } });
      if (!res.ok) throw new Error(`rows failed: ${res.status} ${await res.text()}`);
    }
  }
  const validated = await client(`/api/imports/${imp.id}/validate`, { method: "POST" });
  if (!validated.ok) throw new Error(`validate failed: ${validated.status} ${await validated.text()}`);
  const errors = (await json(await client(`/api/imports/${imp.id}/errors?pageSize=500`))).items as {
    sheet: string;
    row: number;
    column: string | null;
    code: string;
    recordKey: string | null;
    message: string;
    severity: string;
  }[];
  return { imp: await json(validated), errors };
}

export async function commit(client: Client, id: string) {
  const res = await client(`/api/imports/${id}/commit`, { method: "POST" });
  if (!res.ok) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
  return json(res);
}

/** Preview and confirm. */
export async function run(client: Client, wb: Workbook) {
  const { imp, errors } = await preview(client, wb);
  return { imp: await commit(client, imp.id), errors };
}

export const policy = (over: Row = {}): Row => ({
  "Số HĐBH": "009000001",
  "Mã KH BMBH": "0000000001",
  "Mã NĐBH chính": "0000000001",
  "Mã đại lý": "9000001",
  "Bên mua BH": "LÊ THỊ KHÁCH DEMO",
  "NĐBH chính": "Lê Thị Khách Demo",
  "Tình trạng": "Đang hiệu lực",
  "Ngày hiệu lực": "21/09/2025",
  "Ngày đáo hạn": "21/09/2040",
  "Tỉ lệ chia": "100%",
  "Định kỳ đóng phí": "Năm",
  "Ngày đến hạn đóng phí": "21/09/2026",
  "Phí dự tính định kỳ": 13000000,
  "Phí định kỳ/cơ bản định kỳ": 13000000,
  "Phí cơ bản các kỳ trước chưa đóng": 0,
  "Nợ APL(Vay đóng phí + Lãi)": 0,
  "Đã có người thụ hưởng": "Có",
  ...over,
});

export const client = (over: Row = {}): Row => ({
  "Mã Khách Hàng": "0000000001",
  "Bên Mua BH": "Lê Thị Khách Demo",
  "Nhóm Khách Hàng": "Bạc",
  "Giới Tính": "Nữ",
  "age_band": "30-39",
  ...over,
});

export const product = (over: Row = {}): Row => ({
  "Số HĐBH": "009000001",
  "product_code": "TMP_ASHTV",
  "Tên sản phẩm": "An Tâm Song Hành Thịnh Vượng",
  "product_role": "Chính",
  "Mã NĐBH": "0000000001",
  "Số tiền bảo hiểm": 1000000000,
  "Phí năm": 13000000,
  ...over,
});

export const application = (over: Row = {}): Row => ({
  "Số HSYCBH": "EA09000001",
  "Số HĐBH": "009000002",
  "Mã đại lý": "9000001",
  "Mã KH": "0000000002",
  "Bên mua BH": "PHẠM VĂN DEMO",
  "Ngày tạo hồ sơ": "23/09/2026",
  "Tình trạng": "Đang chờ phát hành hợp đồng",
  "Phí dự kiến (APE)": 20000000,
  ...over,
});

export const agent = (code: string, name: string, rank: string, manager: string | null, over: Row = {}): Row => ({
  "Quản lý": manager,
  "Tư vấn tài chính": `${rank}: ${code}-${name}`,
  "Trạng thái": "Đang hoạt động",
  "Ngày bắt đầu hoạt động": "09/06/2026",
  ...over,
});

/** A row of the 13_Leads sheet as the lead import screen sends it (fake people). */
export const lead = (over: Row = {}): Row => ({
  "Mã đại lý": "9000001",
  "NGÀY CẬP NHẬT LEAD": "01/10/2026",
  "TÊN KHÁCH HÀNG": "Khách Thử Nghiệm",
  "SỐ ĐIỆN THOẠI": "0900000001",
  "NGUỒN SĐT": "Xin số",
  "KHU VỰC KHÁCH HÀNG": "Hà Nội",
  "Nguồn": "Page BHN",
  "Chiến Dịch": "HC2",
  ...over,
});

/** A row of 07_Activities as exported from the Success activity tracking module. */
export const activity = (over: Row = {}): Row => ({
  activity_id: crypto.randomUUID(),
  agent_code: "9000001",
  activity_type_id: 2,
  started_at: "2026-10-05T09:15:00+07:00",
  status: "approved",
  ...over,
});
