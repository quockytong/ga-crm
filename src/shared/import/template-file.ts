import { vi } from "../../i18n/vi";
import { AGENT_RANKS, NO, YES } from "../enums";
import { SHEETS, type ColumnDef, type SheetName } from "./template";

// Excel templates built from the same column definitions the importer reads, so a file
// filled from a template always maps column for column.

const t = vi.templates;
const TEXT_ROWS = 1000;

/** Example values, for columns where the type alone does not say enough. */
const EXAMPLES: Record<string, string | number> = {
  name: "Lê Thị Khách Demo",
  full_name: "Nguyễn Văn A",
  holder_name: "LÊ THỊ KHÁCH DEMO",
  insured_name: "Lê Thị Khách Demo",
  gender: "Nữ",
  status: "Đang hiệu lực",
  phone: "0912345678",
  office_code: "GA-HCM-TSN",
  product_name: "An Tâm Song Hành Thịnh Vượng",
  plan: "Thịnh Vượng",
  source: "Page BHN",
  phone_source: "Xin số",
  region: "Hà Nội",
  province: "Hà Nội",
  campaign_name: "HC2",
  progress_note: "01/10: gọi lần 1, hẹn gửi báo giá",
  email: "khachhang@example.com",
  external_id: "1",
  active_policies: 1,
  lapsed_policies: 0,
  loyalty_points: 0,
  age: 35,
  manager_code: "UM: 9000100-Trần Văn Quản Lý",
  activity_id: "a7f3c1e2-9b4d-4f21-8c66-1d2e3f4a5b6c",
  leader_code: "9000100",
  program_code: "DAIICHI_RISE",
  program_month: 2,
  record_mode: "live",
  duration_seconds: 4020,
  customer_id: "KH-889201",
  customer_name: "Anh Demo",
  customer_phone: "0912345678",
  activity_method: "Offline",
  call_type: "phone",
  call_outcome: "reached",
  location_name: "Phú Nhuận, TP.HCM",
  agent_code: "9000001",
};

function example(c: ColumnDef): string | number {
  if (c.db in EXAMPLES && !(c.db === "agent_code" && c.type.t === "agentRef")) return EXAMPLES[c.db]!;
  switch (c.type.t) {
    case "key":
      return { client: "0000000001", policy: "009000001", agent: "9000001", application: "EA09000001", product: "TMP_ASHTV" }[c.type.kind];
    case "agentRef":
      return "FC: 9000001-Nguyễn Thị Demo";
    case "date":
      return "21/09/2025";
    case "datetime":
      return "17/08/2026 13:54";
    case "timestamp":
      return "2026-09-24T09:15:00+07:00";
    case "dayMonth":
      return "15/03";
    case "int":
      return 13000000;
    case "percent":
      return "100%";
    case "list":
      return c.type.values.includes("approved") ? "approved" : c.type.values[0]!;
    case "code":
      return Object.values(c.type.values)[0]![0]!;
    case "yesNo":
      return YES;
    case "phone":
      return "0912345678";
    default:
      return "";
  }
}

function format(c: ColumnDef): string {
  const f = t.formats;
  switch (c.type.t) {
    case "key":
      return f[c.type.kind];
    case "text":
      return c.type.max ? f.longText(c.type.max) : f.text;
    case "code":
    case "list":
      return f.list;
    default:
      return f[c.type.t];
  }
}

/** Values allowed in list columns, one column per list. */
function lists(sheets: SheetName[]): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const name of sheets) {
    for (const c of SHEETS[name].columns) {
      const label = `${name} · ${c.header}`;
      if (c.type.t === "list") out.push([label, [...c.type.values]]);
      else if (c.type.t === "code") out.push([label, Object.values(c.type.values).map((labels) => labels[0]!)]);
      else if (c.type.t === "yesNo") out.push([label, [YES, NO]]);
      else if (c.type.t === "agentRef") out.push([`${label} (RANK)`, [...AGENT_RANKS]]);
    }
  }
  return out;
}

/** Keys and phone numbers keep their leading zeros: format those columns as Text. */
const isTextKey = (c: ColumnDef) => c.type.t === "key" || c.type.t === "phone";

/** The template workbook as .xlsx bytes. */
export async function templateBytes(title: string, sheets: SheetName[]): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();

  const readme = XLSX.utils.aoa_to_sheet([
    [t.readmeTitle(title)],
    ...t.readmeIntro.map((line) => [line]),
    [],
    [t.colSheet, t.colColumn, t.colRequired, t.colFormat, t.colExample],
    ...sheets.flatMap((name) => SHEETS[name].columns.map((c) => [name, c.header, c.required ? t.yes : t.no, format(c), example(c)])),
  ]);
  readme["!cols"] = [{ wch: 20 }, { wch: 40 }, { wch: 10 }, { wch: 48 }, { wch: 36 }];
  XLSX.utils.book_append_sheet(book, readme, t.readmeSheet);

  for (const name of sheets) {
    const cols = SHEETS[name].columns;
    const ws = XLSX.utils.aoa_to_sheet([cols.map((c) => c.header)]);
    cols.forEach((c, i) => {
      if (!isTextKey(c)) return;
      for (let r = 1; r <= TEXT_ROWS; r++) ws[XLSX.utils.encode_cell({ r, c: i })] = { t: "s", v: "", z: "@" };
    });
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: TEXT_ROWS, c: cols.length - 1 } });
    ws["!cols"] = cols.map((c) => ({ wch: Math.max(14, Math.min(40, c.header.length + 4)) }));
    XLSX.utils.book_append_sheet(book, ws, name);
  }

  const allowed = lists(sheets);
  const height = Math.max(0, ...allowed.map(([, v]) => v.length));
  const listSheet = XLSX.utils.aoa_to_sheet([
    allowed.map(([label]) => label),
    ...Array.from({ length: height }, (_, i) => allowed.map(([, v]) => v[i] ?? "")),
  ]);
  listSheet["!cols"] = allowed.map(() => ({ wch: 34 }));
  XLSX.utils.book_append_sheet(book, listSheet, t.listsSheet);

  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

export const SUCCESS_TEMPLATE_SHEETS: SheetName[] = ["01_Agents", "02_Clients", "03_Policies", "04_Policy_Products", "05_Applications", "07_Activities"];
