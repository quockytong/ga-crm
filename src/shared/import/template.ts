import { LOOKUPS, SUCCESS_ACTIVITY_STATUSES, type LeadCareStatus, type LeadInterest, type SuccessActivityType } from "../enums";
import { normalizeName } from "../normalize";

// Import template v1.1 (samples/DLVN_BDM_CRM_Import_Template_v1.1.xlsx), sheets 01-05.
// Column names, required flags and formats follow the data dictionary in sheet 00_README.

export type KeyKind = "client" | "policy" | "application" | "agent" | "product";

export type ColumnType =
  | { t: "text"; max?: number }
  | { t: "phone" }
  /** A fixed code, written in the file as any of its Vietnamese labels. */
  | { t: "code"; values: Readonly<Record<string, readonly string[]>> }
  | { t: "key"; kind: KeyKind }
  /** "RANK: code-Name". Fills `<prefix>code`, `<prefix>name`, `<prefix>rank`. */
  | { t: "agentRef"; code: string; name: string; rank: string }
  | { t: "date" }
  | { t: "datetime" }
  /** ISO timestamp with offset (2026-09-24T09:15:00+07:00) or dd/mm/yyyy hh:mm in Vietnam time. */
  | { t: "timestamp" }
  | { t: "dayMonth" }
  | { t: "int" }
  | { t: "percent" }
  | { t: "list"; values: readonly string[] }
  | { t: "yesNo" };

export type ColumnDef = {
  header: string;
  aliases?: readonly string[];
  /** Target column (snake_case) in the staged row and in the table. */
  db: string;
  type: ColumnType;
  /** Required = Y in the data dictionary: the column must exist and the cell must be filled. */
  required?: boolean;
  /** Required column whose cell may still be empty (a top-level agent has no manager). */
  blankOk?: boolean;
  /** Value stored for an empty cell, when the column is part of the key. */
  blankAs?: string;
  /** Also store the normalized name in this column. */
  norm?: string;
};

export type SheetDef = {
  name: SheetName;
  table: string;
  /** Unique key per tenant, as target columns. */
  key: readonly string[];
  /**
   * What makes a row unique in the file, when it differs from `key`. A policy shared by
   * several agents comes as one row per agent: same Số HĐBH, own Mã đại lý and Tỉ lệ chia.
   */
  rowKey?: readonly string[];
  /** Target column holding the owning agent code, for the upload scope rule. */
  owner?: string;
  columns: readonly ColumnDef[];
};

export const SHEET_NAMES = ["01_Agents", "02_Clients", "03_Policies", "04_Policy_Products", "05_Applications", "07_Activities", "13_Leads"] as const;
export type SheetName = (typeof SHEET_NAMES)[number];

/** In the template but not imported yet (P1). */
export const LATER_SHEETS = [
  "06_Production_Monthly",
  "08_Activity_Movement",
  "09_Activity_Targets",
  "10_Agent_Monthly",
] as const;

const text = { t: "text" } as const;
const date = { t: "date" } as const;
const int = { t: "int" } as const;
const yesNo = { t: "yesNo" } as const;
const key = (kind: KeyKind) => ({ t: "key", kind }) as const;
const list = (values: readonly string[]) => ({ t: "list", values }) as const;

// Labels used by GAs in their lead sheets ("Chia Lead"), first one is the label we show.
export const INTEREST_LABELS: Record<LeadInterest, readonly string[]> = {
  NOT_REACHED: ["Chưa nghe máy", "Không nghe máy", "Knm"],
  UNDETERMINED: ["Chưa xác định"],
  NOT_INTERESTED: ["Không quan tâm", "Không có nhu cầu", "Không còn nhu cầu", "Kcnc"],
  LIFE: ["Quan tâm nhân thọ", "Nhân thọ", "Quan tâm nhân thọ net"],
  HEALTH_CARD: ["Quan tâm thẻ rời", "Thẻ rời", "Thẻ rời nội trú", "Thẻ rời nội+ngoại", "Rời nội trú", "Rời nội ngoại trú"],
};
export const CARE_LABELS: Record<LeadCareStatus, readonly string[]> = {
  CARING: ["Đang chăm sóc", "Chăm sóc thêm", "Hẹn gọi lại", "Quan tâm"],
  WON: ["Đã chốt"],
  DROPPED: ["Chốt xịt", "Dừng chăm sóc", "Đã mua bên khác"],
  NOT_INTERESTED: ["Không quan tâm", "Không còn nhu cầu", "Kcnc"],
};

/**
 * 13_Leads: the GA's own lead list. Headers follow the GA sheet "Chia Lead"; the lead
 * import screen maps any other sheet onto these columns, including agent names to codes.
 */
const LEADS: SheetDef = {
  name: "13_Leads",
  table: "leads",
  key: ["phone"],
  owner: "assigned_agent_code",
  columns: [
    { header: "LEAD ID", db: "external_id", type: text },
    { header: "Mã đại lý", db: "assigned_agent_code", type: key("agent") },
    { header: "NGÀY CẬP NHẬT LEAD", db: "lead_date", type: date },
    { header: "TÊN KHÁCH HÀNG", db: "full_name", required: true, type: text, norm: "name_norm" },
    { header: "SỐ ĐIỆN THOẠI", db: "phone", required: true, type: { t: "phone" } },
    { header: "NGUỒN SĐT", db: "phone_source", type: text },
    { header: "KHU VỰC KHÁCH HÀNG", db: "region", type: text },
    { header: "Nguồn", db: "source", required: true, type: text },
    { header: "Tình Trạng TVV", db: "interest", type: { t: "code", values: INTEREST_LABELS } },
    { header: "Trạng Thái Hiện Tại TVV", db: "care_status", type: { t: "code", values: CARE_LABELS } },
    { header: "Chiến Dịch", db: "campaign_name", type: text },
    { header: "TIẾN ĐỘ TƯ VẤN TVV", db: "progress_note", type: { t: "text", max: 4000 } },
    { header: "LÝ DO CHỐT XỊT/ DỪNG TÌM HIỂU", db: "lost_reason", type: text },
    { header: "TRẠNG THÁI GỬI TIN NHẮN", db: "message_status", type: text },
    { header: "NGÀY ĐĂNG KÝ", db: "registered_at", type: date },
    { header: "GIỚI TÍNH", db: "gender", type: text },
    { header: "EMAIL", db: "email", type: text },
    { header: "TUỔI", db: "age", type: int },
    { header: "TỈNH/TP", db: "province", type: text },
    { header: "GIÁ TRỊ", db: "value_vnd", type: int },
    { header: "THÔNG TIN THÊM", db: "extra_info", type: { t: "text", max: 2000 } },
    { header: "LINK THAM KHẢO", db: "ref_link", type: text },
    { header: "SẢN PHẨM", db: "product_interest", type: text },
    { header: "SẢN PHẨM PHỤ", db: "product_secondary", type: text },
    { header: "ĐỒNG Ý LIÊN HỆ", db: "consent_marketing", type: yesNo },
  ],
};

/** Other headers GA lead sheets use for the same columns, for the automatic mapping. */
export const LEAD_HEADER_ALIASES: Record<string, readonly string[]> = {
  external_id: ["LEAD ID"],
  assigned_agent_code: ["TƯ VẤN TÀI CHÍNH", "TƯ VẤN", "TÊN TVV", "FC", "Mã đại lý", "Mã TVV"],
  lead_date: ["NGÀY CẬP NHẬT LEAD", "Ngày", "Ngày nhận lead"],
  full_name: ["TÊN KHÁCH HÀNG", "TÊN KH", "Họ tên"],
  phone: ["SỐ ĐIỆN THOẠI", "Sđt", "Điện thoại"],
  phone_source: ["NGUỒN SĐT"],
  region: ["KHU VỰC KHÁCH HÀNG", "KHU VỰC"],
  source: ["Nguồn", "Kênh"],
  interest: ["Tình Trạng TVV", "Tình Trạng", "Tình Trang"],
  care_status: ["Trạng Thái Hiện Tại TVV", "Trạng Thái Hiện Tại", "Trạng thái mới"],
  campaign_name: ["Chiến Dịch"],
  progress_note: ["TIẾN ĐỘ TƯ VẤN TVV", "TIẾN ĐỘ TƯ VẤN", "Note mới"],
  lost_reason: ["LÝ DO CHỐT XỊT/ DỪNG TÌM HIỂU", "LÝ DO DỪNG TƯ VẤN"],
};

const ACTIVITY_TYPE_LABELS: Record<SuccessActivityType, readonly string[]> = {
  CHECKIN: ["1", "1 Checkin", "Checkin"],
  CALL: ["2", "2 Calls", "Calls"],
  SOCIAL_POST: ["3", "3 Social Media Posts", "Social Media Posts"],
  MEETING: ["4", "4 Meeting with Customer", "Meeting with Customer"],
  COACHING: ["5", "5 Coaching/Review", "Coaching/Review"],
  OTHER: ["6", "6 Others", "Others"],
  PROPOSAL: ["7", "7 Proposal", "Proposal"],
};

/**
 * 07_Activities: the FC's actions from the Success activity tracking module, a leading
 * signal for conversion. `customer_phone` is a new optional column (request from IT/Success)
 * so a call or meeting can be matched with the same contact logged in the CRM.
 */
const ACTIVITIES: SheetDef = {
  name: "07_Activities",
  table: "success_activities",
  key: ["activity_id"],
  owner: "agent_code",
  columns: [
    { header: "activity_id", db: "activity_id", required: true, type: { t: "text", max: 64 } },
    { header: "agent_code", db: "agent_code", required: true, type: key("agent") },
    { header: "leader_code", db: "leader_code", type: key("agent") },
    { header: "office_code", db: "office_code", type: text },
    { header: "program_code", db: "program_code", type: text },
    { header: "program_month", db: "program_month", type: int },
    { header: "activity_type_id", db: "activity_type", required: true, type: { t: "code", values: ACTIVITY_TYPE_LABELS } },
    { header: "sub_activity_title", db: "sub_activity_title", type: text },
    { header: "record_mode", db: "record_mode", type: text },
    { header: "started_at", db: "started_at", required: true, type: { t: "timestamp" } },
    { header: "ended_at", db: "ended_at", type: { t: "timestamp" } },
    { header: "duration_seconds", db: "duration_seconds", type: int },
    { header: "status", db: "status", required: true, type: list(SUCCESS_ACTIVITY_STATUSES) },
    { header: "customer_id", db: "customer_id", type: text },
    { header: "customer_name", db: "customer_name", type: text },
    { header: "customer_phone", db: "customer_phone", type: { t: "phone" } },
    { header: "activity_method", db: "activity_method", type: text },
    { header: "call_type", db: "call_type", type: text },
    { header: "call_outcome", db: "call_outcome", type: text },
    { header: "call_phone_hash", db: "call_phone_hash", type: text },
    { header: "content_note", db: "content_note", type: { t: "text", max: 4000 } },
    { header: "location_name", db: "location_name", type: text },
  ],
};

export const SHEETS: Record<SheetName, SheetDef> = {
  "01_Agents": {
    name: "01_Agents",
    table: "agents",
    key: ["agent_code"],
    owner: "agent_code",
    columns: [
      { header: "Quản lý", db: "manager_code", required: true, blankOk: true, type: { t: "agentRef", code: "manager_code", name: "manager_name", rank: "manager_rank" } },
      { header: "Tư vấn tài chính", db: "agent_code", required: true, type: { t: "agentRef", code: "agent_code", name: "name", rank: "rank" } },
      { header: "Giới tính", db: "gender", type: text },
      { header: "Ngày sinh", db: "dob", type: date },
      { header: "Trạng thái", db: "status", required: true, type: list(LOOKUPS.agentStatus) },
      { header: "Điện thoại", db: "phone", type: text },
      { header: "Ngày bắt đầu hoạt động", db: "start_date", required: true, type: date },
      { header: "Ngày chấm dứt hoạt động", db: "end_date", type: date },
      { header: "office_code", db: "office_code", type: text },
    ],
  },
  "02_Clients": {
    name: "02_Clients",
    table: "clients",
    key: ["client_code"],
    columns: [
      { header: "Mã Khách Hàng", db: "client_code", required: true, type: key("client") },
      { header: "Bên Mua BH", db: "name", required: true, type: text, norm: "name_norm" },
      { header: "Nhóm Khách Hàng", db: "tier", type: list(LOOKUPS.clientTier) },
      { header: "Tổng HĐ còn hiệu lực", db: "active_policies", type: int },
      { header: "Tổng HĐ mất hiệu lực", db: "lapsed_policies", type: int },
      { header: "Ngày Sinh", db: "dob", type: date },
      { header: "Giới Tính", db: "gender", type: text },
      { header: "Tình Trạng Hôn Nhân", db: "marital_status", type: list(LOOKUPS.maritalStatus) },
      { header: "Điểm Thưởng", db: "loyalty_points", type: int },
      { header: "Sử dụng D-Connect", db: "uses_dconnect", type: yesNo },
      { header: "Thời gian đăng nhập D-Connect gần nhất", db: "dconnect_last_login_at", type: { t: "datetime" } },
      { header: "Đã cập nhật Căn cước", db: "id_updated", type: yesNo },
      { header: "Đăng ký eKYC", db: "ekyc_registered", type: yesNo },
      { header: "Thời gian đăng ký eKYC", db: "ekyc_registered_at", type: { t: "datetime" } },
      { header: "birth_day_month", db: "birth_day_month", type: { t: "dayMonth" } },
      { header: "age_band", db: "age_band", type: list(LOOKUPS.ageBand) },
    ],
  },
  "03_Policies": {
    name: "03_Policies",
    table: "policies",
    key: ["policy_no"],
    rowKey: ["policy_no", "agent_code"],
    owner: "agent_code",
    columns: [
      { header: "Số HĐBH", db: "policy_no", required: true, type: key("policy") },
      { header: "Mã KH BMBH", aliases: ["Mã KH"], db: "holder_client_code", required: true, type: key("client") },
      { header: "Mã NĐBH chính", db: "insured_client_code", type: key("client") },
      { header: "Mã đại lý", db: "agent_code", required: true, type: key("agent") },
      { header: "Bên mua BH", db: "holder_name", required: true, type: text, norm: "holder_name_norm" },
      { header: "NĐBH chính", db: "insured_name", required: true, type: text, norm: "insured_name_norm" },
      { header: "Tình trạng", db: "status", required: true, type: text },
      { header: "Ngày hiệu lực", db: "effective_date", required: true, type: date },
      { header: "Ngày đáo hạn", db: "maturity_date", required: true, type: date },
      { header: "Tỉ lệ chia", db: "split_percent", type: { t: "percent" } },
      { header: "Định kỳ đóng phí", db: "premium_frequency", required: true, type: list(LOOKUPS.premiumFrequency) },
      { header: "Ngày đến hạn đóng phí", db: "premium_due_date", type: date },
      { header: "Phí dự tính định kỳ", db: "planned_premium_vnd", type: int },
      { header: "Phí định kỳ/cơ bản định kỳ", db: "base_premium_vnd", required: true, type: int },
      { header: "Phí cơ bản các kỳ trước chưa đóng", db: "unpaid_premium_vnd", type: int },
      { header: "Nợ APL(Vay đóng phí + Lãi)", db: "apl_debt_vnd", type: int },
      { header: "Đã có người thụ hưởng", db: "has_beneficiary", type: yesNo },
    ],
  },
  "04_Policy_Products": {
    name: "04_Policy_Products",
    table: "policy_products",
    key: ["policy_no", "product_code", "insured_code"],
    columns: [
      { header: "Số HĐBH", db: "policy_no", required: true, type: key("policy") },
      { header: "product_code", db: "product_code", required: true, type: key("product") },
      { header: "Tên sản phẩm", db: "product_name", type: text },
      { header: "product_role", db: "product_role", required: true, type: list(LOOKUPS.productRole) },
      { header: "Mã NĐBH", db: "insured_code", type: key("client"), blankAs: "" },
      { header: "Số tiền bảo hiểm", db: "sum_assured_vnd", type: int },
      { header: "Phí năm", db: "annual_premium_vnd", type: int },
      { header: "Chương trình", db: "plan", type: text },
      { header: "Ngày bắt đầu", db: "start_date", type: date },
      { header: "Tình trạng", db: "status", type: text },
    ],
  },
  "07_Activities": ACTIVITIES,
  "13_Leads": LEADS,
  "05_Applications": {
    name: "05_Applications",
    table: "applications",
    key: ["application_no"],
    owner: "agent_code",
    columns: [
      { header: "Số HSYCBH", db: "application_no", required: true, type: key("application") },
      { header: "Số HĐBH", db: "policy_no", type: key("policy") },
      { header: "Mã đại lý", db: "agent_code", required: true, type: key("agent") },
      { header: "Mã KH", db: "client_code", type: key("client") },
      { header: "Bên mua BH", db: "holder_name", required: true, type: text, norm: "holder_name_norm" },
      { header: "Ngày tạo hồ sơ", db: "created_date", required: true, type: date },
      { header: "Ngày nhận HSYCBH", db: "received_date", type: date },
      { header: "Tình trạng", db: "status", required: true, type: list(LOOKUPS.applicationStatus) },
      { header: "Ngày phát hành", db: "issued_date", type: date },
      { header: "product_code", db: "product_code", type: key("product") },
      { header: "Phí dự kiến (APE)", db: "ape_vnd", type: int },
    ],
  },
};

const headerForm = (h: string) => h.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

export const isSheetName = (name: string): name is SheetName => (SHEET_NAMES as readonly string[]).includes(name);

// CLAUDE.md rule 6: ID card numbers and bank details are never stored; health data neither,
// except in lead files, where FCs keep it to prepare their approach (product owner, Oct 2026).
const BANNED_ID_BANK = ["CCCD", "CMND", "CAN CUOC", "CHUNG MINH", "HO CHIEU", "PASSPORT", "TAI KHOAN", "NGAN HANG", "BANK"];
const BANNED_HEALTH = ["BENH", "SUC KHOE", "HEALTH"];

export type SheetPlan = {
  /** For every template column, its position in the uploaded sheet, or -1 when missing. */
  positions: number[];
  missingRequired: string[];
  /** Headers that are not in the template and look like PDP-banned data. Never read, never sent. */
  banned: string[];
};

/** Matches the headers of an uploaded sheet against the template. */
export function planSheet(def: SheetDef, headers: readonly string[]): SheetPlan {
  const found = headers.map(headerForm);
  const positions = def.columns.map((col) => {
    const names = [col.header, ...(col.aliases ?? [])].map(headerForm);
    return found.findIndex((h) => names.includes(h));
  });
  const known = new Set(positions.filter((p) => p >= 0));
  return {
    positions,
    missingRequired: def.columns.filter((c, i) => c.required && positions[i]! < 0).map((c) => c.header),
    banned: headers.filter((h, i) => !known.has(i) && isBannedHeader(h)),
  };
}

/** A header that looks like PDP-banned data (ID number, bank account, and health unless allowed). */
export function isBannedHeader(h: string, opts: { allowHealth?: boolean } = {}) {
  if (!h.trim()) return false;
  const form = normalizeName(h);
  return [...BANNED_ID_BANK, ...(opts.allowHealth ? [] : BANNED_HEALTH)].some((word) => form.includes(word));
}

export type SheetStatus = "READY" | "BLOCKED" | "LATER";
export type SheetCount = {
  status: SheetStatus;
  /** Indexes of the template columns present in the file. */
  present: number[];
  found: number;
  inserted: number;
  updated: number;
  rejected: number;
  /** Rows not applied because the CRM has newer data (lead imports). */
  skipped?: number;
  warnings: number;
};
export type ImportSheetCounts = Record<string, SheetCount>;
