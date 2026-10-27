export const ROLES = [
  "FC",
  "UM",
  "BM",
  "GAD",
  "GA_HEAD",
  "MARKETING",
  "ADMIN",
  "PLATFORM_ADMIN",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles a tenant user can hold. PLATFORM_ADMIN is never assignable inside a tenant. */
export const TENANT_ROLES = ["FC", "UM", "BM", "GAD", "GA_HEAD", "MARKETING", "ADMIN"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** Roles that are agents and therefore need an agent code. */
export const AGENT_ROLES = ["FC", "UM", "BM", "GAD"] as const satisfies readonly Role[];
/** Agent roles that also see their downline. */
export const MANAGER_ROLES = ["UM", "BM", "GAD"] as const satisfies readonly Role[];
/** Roles that manage users of their tenant. */
export const USER_ADMIN_ROLES = ["GA_HEAD", "ADMIN"] as const satisfies readonly Role[];

export const AGENT_RANKS = ["SUM", "BM", "UM", "SA", "FC"] as const;
export type AgentRank = (typeof AGENT_RANKS)[number];

export const USER_STATUSES = ["INVITED", "ACTIVE", "DISABLED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const TENANT_STATUSES = ["active", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const AUDIT_ACTIONS = [
  "LOGIN",
  "CREATE",
  "UPDATE",
  "DELETE",
  "ASSIGN",
  "LINK",
  "UNLINK",
  "IMPORT",
  "EXPORT",
  "VIEW_CLIENT",
  "CROSS_TENANT_READ",
  "AI_READ",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** How far a user's hierarchy scope reaches inside their tenant. */
export type Reach = "TENANT" | "DOWNLINE" | "OWN" | "NONE";

export const IMPORT_STATUSES = ["PARSING", "VALIDATED", "COMMITTED", "FAILED"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

// Lists from sheet 12_Lookups of the import template v1.1.
export const LOOKUPS = {
  agentStatus: ["Đang hoạt động", "Ngưng hoạt động"],
  clientTier: ["Thân thiết", "Bạc", "Vàng", "Kim Cương"],
  maritalStatus: ["Độc thân", "Đã kết hôn", "Ly hôn"],
  premiumFrequency: ["Năm", "Nửa năm", "Quý", "Tháng"],
  applicationStatus: [
    "Đã phát hành hợp đồng",
    "Đã hủy Hồ sơ YCBH",
    "Đang chờ phát hành hợp đồng",
    "Đang chờ NB hủy hồ sơ YCBH",
    "Đang chờ NB xử lý",
    "Đang chờ Thư thỏa thuận/Bổ sung thông tin",
  ],
  ageBand: ["<18", "18-29", "30-39", "40-49", "50-59", "60+"],
  productRole: ["Chính", "Bổ trợ"],
} as const;
export const YES = "Có";
export const NO = "Chưa";

/* ---------- Leads ---------- */

/** Pipeline stage (DATA-MODEL section 3). */
export const LEAD_STAGES = ["NEW", "CONTACTED", "APPOINTMENT", "MET", "PROPOSAL", "SUBMITTED", "ISSUED", "LOST"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/**
 * "Tình trạng": interest found at the first successful contact. Once it is LIFE,
 * HEALTH_CARD or NOT_INTERESTED it no longer changes (only a lead manager can correct it).
 * A lead interested in both life and health card is LIFE.
 */
export const LEAD_INTERESTS = ["NOT_REACHED", "UNDETERMINED", "NOT_INTERESTED", "LIFE", "HEALTH_CARD"] as const;
export type LeadInterest = (typeof LEAD_INTERESTS)[number];
export const FINAL_INTERESTS: readonly LeadInterest[] = ["NOT_INTERESTED", "LIFE", "HEALTH_CARD"];

/** "Trạng thái hiện tại": where the follow-up stands now. */
export const LEAD_CARE_STATUSES = ["CARING", "WON", "DROPPED", "NOT_INTERESTED"] as const;
export type LeadCareStatus = (typeof LEAD_CARE_STATUSES)[number];

export const ACTIVITY_TYPES = ["CALL", "ZALO", "MEETING", "SEMINAR", "NOTE", "TASK"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Stage implied by a care status (the pipeline view in F5 refines it). */
export function stageFor(care: LeadCareStatus | null, interest: LeadInterest | null, current: LeadStage): LeadStage {
  if (care === "WON") return current === "ISSUED" ? "ISSUED" : "SUBMITTED";
  if (care === "DROPPED" || care === "NOT_INTERESTED") return "LOST";
  if (current === "LOST" || current === "NEW") return interest || care ? "CONTACTED" : current;
  return current;
}

/* ---------- Agent activities ---------- */

/** activity_type_id of the Success activity tracking module (07_Activities). */
export const SUCCESS_ACTIVITY_TYPES = ["CHECKIN", "CALL", "SOCIAL_POST", "MEETING", "COACHING", "OTHER", "PROPOSAL"] as const;
export type SuccessActivityType = (typeof SUCCESS_ACTIVITY_TYPES)[number];
export const SUCCESS_ACTIVITY_STATUSES = ["draft", "submitted", "approved", "returned", "rejected", "locked"] as const;

/** Columns of the agent activity report. */
export const ACTION_KINDS = ["CALL", "ZALO", "MEETING", "SEMINAR", "PROPOSAL", "SOCIAL_POST", "CHECKIN", "COACHING", "OTHER"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Relationship of a family member, from the client's side (client_family.relation). */
export const FAMILY_RELATIONS = ["SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"] as const;
export type FamilyRelation = (typeof FAMILY_RELATIONS)[number];
/** The same link seen from the other person. */
export const INVERSE_RELATION: Record<FamilyRelation, FamilyRelation> = { SPOUSE: "SPOUSE", CHILD: "PARENT", PARENT: "CHILD", SIBLING: "SIBLING", OTHER: "OTHER" };
