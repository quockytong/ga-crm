import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  ActivityType,
  AgentRank,
  AuditAction,
  FamilyRelation,
  ImportStatus,
  LeadCareStatus,
  LeadInterest,
  LeadStage,
  Role,
  TenantStatus,
  UserStatus,
} from "../shared/enums";
import type { AgentConfig, AgentKind, AiContext, AiModelChoice, AiProvider, AiTier, CoachSetup, CoachScore, KbCategory, TaskClass } from "../shared/ai";
import type { ImportSheetCounts } from "../shared/import/template";
import type { Permission } from "../shared/permissions";

// See docs/DATA-MODEL.md. Update that file in the same commit as any change here.
//
// Timestamps are UTC ISO text, except on columns owned by Better Auth
// (created_at / updated_at / expires_at on users, sessions, accounts,
// verifications), which it reads and writes as Date (unix seconds).

/* ---------- Platform ---------- */

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  gaCode: text("ga_code").notNull().unique(),
  name: text("name").notNull(),
  status: text("status").$type<TenantStatus>().notNull().default("active"),
  createdAt: text("created_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    // Null only for Platform Admin.
    tenantId: text("tenant_id").references(() => tenants.id),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    name: text("name").notNull(),
    image: text("image"),
    // Null for Marketing / Admin.
    agentCode: text("agent_code"),
    status: text("status").$type<UserStatus>().notNull().default("INVITED"),
    lastLoginAt: text("last_login_at"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("users_tenant_idx").on(t.tenantId), uniqueIndex("users_tenant_agent_uq").on(t.tenantId, t.agentCode)],
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

export const agents = sqliteTable(
  "agents",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    agentCode: text("agent_code").notNull(),
    name: text("name").notNull(),
    rank: text("rank").$type<AgentRank>().notNull(),
    managerCode: text("manager_code"),
    // Materialized ancestry incl. self, e.g. /9000500/9000100/9000001/
    path: text("path").notNull(),
    status: text("status"),
    gender: text("gender"),
    dob: text("dob"),
    phone: text("phone"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    officeCode: text("office_code"),
    // Set when a GA Head fixes the manager link by hand; imports then leave the link alone.
    managerFixed: integer("manager_fixed", { mode: "boolean" }).notNull().default(false),
    updatedByImportId: text("updated_by_import_id"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.agentCode] }), index("agents_manager_idx").on(t.tenantId, t.managerCode)],
);

// RBAC: which functions each role has in a tenant (see src/shared/permissions.ts).
export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    role: text("role").$type<Role>().notNull(),
    permission: text("permission").$type<Permission>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.role, t.permission] })],
);

/* ---------- Auth (Better Auth) ---------- */

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256 of the token. The token itself only ever lives in the invite link.
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("invitations_user_idx").on(t.userId)],
);

/* ---------- CRM-owned: campaigns, leads, activities ---------- */

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // As the GA names it, e.g. HC2, Package3. Unique per tenant; lead imports create missing ones.
    name: text("name").notNull(),
    type: text("type").notNull().default("OTHER"),
    channel: text("channel"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    budgetVnd: integer("budget_vnd"),
    ownerUserId: text("owner_user_id"),
    status: text("status").notNull().default("ACTIVE"),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("campaigns_name_uq").on(t.tenantId, t.name)],
);

export const leads = sqliteTable(
  "leads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // "LEAD ID" in the GA's sheet, if any.
    externalId: text("external_id"),
    fullName: text("full_name").notNull(),
    nameNorm: text("name_norm").notNull(),
    // Normalized 0xxxxxxxxx. One lead per phone per tenant.
    phone: text("phone").notNull(),
    email: text("email"),
    gender: text("gender"),
    dob: text("dob"),
    age: integer("age"),
    ageBand: text("age_band"),
    province: text("province"),
    // "Khu vực khách hàng", e.g. Hà Nội / Khác.
    region: text("region"),
    need: text("need"),
    // Channel, e.g. Page BHN, Web, DLVN - Web tư vấn.
    source: text("source").notNull(),
    // How the phone number was obtained: Xin số, Điền form Web, Quét số, Form Đky.
    phoneSource: text("phone_source"),
    campaignId: text("campaign_id"),
    // "Ngày cập nhật lead": the day the lead came in / was handed out.
    leadDate: text("lead_date").notNull(),
    registeredAt: text("registered_at"),
    productInterest: text("product_interest"),
    productSecondary: text("product_secondary"),
    valueVnd: integer("value_vnd"),
    refLink: text("ref_link"),
    extraInfo: text("extra_info"),
    stage: text("stage").$type<LeadStage>().notNull().default("NEW"),
    interest: text("interest").$type<LeadInterest>(),
    careStatus: text("care_status").$type<LeadCareStatus>(),
    lostReason: text("lost_reason"),
    // "Tiến độ tư vấn" as kept in the GA's sheet. Each change is also an activity.
    progressNote: text("progress_note"),
    messageStatus: text("message_status"),
    assignedAgentCode: text("assigned_agent_code"),
    assignedBy: text("assigned_by"),
    assignedAt: text("assigned_at"),
    // Set when the assignee first opens the lead ("Mới được giao" until then).
    assigneeSeenAt: text("assignee_seen_at"),
    // Last time the assignee opened the lead, to flag comments they have not read.
    assigneeViewedAt: text("assignee_viewed_at"),
    lastCommentAt: text("last_comment_at"),
    lastCommentBy: text("last_comment_by"),
    firstContactAt: text("first_contact_at"),
    lastContactAt: text("last_contact_at"),
    nextActionAt: text("next_action_at"),
    consentMarketing: integer("consent_marketing", { mode: "boolean" }).notNull().default(false),
    consentAt: text("consent_at"),
    consentSource: text("consent_source"),
    clientCode: text("client_code"),
    applicationNo: text("application_no"),
    // Given by the FC when the lead is "Đã chốt" (with or instead of the application number).
    policyNo: text("policy_no"),
    // GA (created in the CRM by a lead manager), IMPORT (lead file) or FC_OWN (an FC's own
    // prospect: cannot be reassigned while that FC still works for the GA).
    origin: text("origin").notNull().default("GA"),
    linkStatus: text("link_status").notNull().default("NONE"),
    linkedBy: text("linked_by"),
    linkedAt: text("linked_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastImportId: text("last_import_id"),
  },
  (t) => [
    uniqueIndex("leads_phone_uq").on(t.tenantId, t.phone),
    index("leads_assignee_idx").on(t.tenantId, t.assignedAgentCode),
    index("leads_date_idx").on(t.tenantId, t.leadDate),
  ],
);

// Every change of stage, interest, care status or assignee of a lead.
export const leadHistory = sqliteTable(
  "lead_history",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    leadId: text("lead_id").notNull(),
    // stage | interest | care_status | assignee
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    note: text("note"),
    importId: text("import_id"),
    changedBy: text("changed_by").notNull(),
    changedAt: text("changed_at").notNull(),
  },
  (t) => [index("lead_history_lead_idx").on(t.tenantId, t.leadId, t.changedAt)],
);

// Tasks on a lead (F6.2 "Việc cần làm"). Auto tasks: contact within 48 h of assignment,
// and the follow-up set as "Hẹn liên hệ tiếp".
export const leadTasks = sqliteTable(
  "lead_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    leadId: text("lead_id").notNull(),
    agentCode: text("agent_code"),
    title: text("title").notNull(),
    dueAt: text("due_at").notNull(),
    // OPEN, DONE, CANCELLED
    status: text("status").notNull().default("OPEN"),
    // APP, AUTO_ASSIGN, NEXT_ACTION
    source: text("source").notNull().default("APP"),
    doneAt: text("done_at"),
    doneBy: text("done_by"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("lead_tasks_lead_idx").on(t.tenantId, t.leadId), index("lead_tasks_agent_idx").on(t.tenantId, t.agentCode, t.status, t.dueAt)],
);

// Managers' (and others') comments on a lead, to coach the FC who works it.
export const leadComments = sqliteTable(
  "lead_comments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    leadId: text("lead_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("lead_comments_lead_idx").on(t.tenantId, t.leadId, t.createdAt)],
);

export const crmActivities = sqliteTable(
  "crm_activities",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    agentCode: text("agent_code"),
    leadId: text("lead_id"),
    clientCode: text("client_code"),
    type: text("type").$type<ActivityType>().notNull(),
    outcome: text("outcome"),
    note: text("note"),
    occurredAt: text("occurred_at").notNull(),
    dueAt: text("due_at"),
    doneAt: text("done_at"),
    // APP (logged in the CRM) or IMPORT (progress note from a lead file).
    source: text("source").notNull().default("APP"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("crm_activities_lead_idx").on(t.tenantId, t.leadId, t.occurredAt),
    index("crm_activities_client_idx").on(t.tenantId, t.clientCode, t.occurredAt),
  ],
);

/* ---------- Success data (imported, read-only in the UI) ---------- */

// Every imported row records the import that last wrote it.
const imported = {
  lastImportId: text("last_import_id"),
  lastSeenAt: text("last_seen_at"),
};
const tenantRef = () =>
  text("tenant_id")
    .notNull()
    .references(() => tenants.id);

export const clients = sqliteTable(
  "clients",
  {
    tenantId: tenantRef(),
    clientCode: text("client_code").notNull(),
    name: text("name").notNull(),
    nameNorm: text("name_norm").notNull(),
    tier: text("tier"),
    activePolicies: integer("active_policies"),
    lapsedPolicies: integer("lapsed_policies"),
    dob: text("dob"),
    gender: text("gender"),
    maritalStatus: text("marital_status"),
    loyaltyPoints: integer("loyalty_points"),
    usesDconnect: integer("uses_dconnect", { mode: "boolean" }),
    dconnectLastLoginAt: text("dconnect_last_login_at"),
    // "Đã cập nhật Căn cước": a yes/no flag from Success, never the ID number itself.
    idUpdated: integer("id_updated", { mode: "boolean" }),
    ekycRegistered: integer("ekyc_registered", { mode: "boolean" }),
    ekycRegisteredAt: text("ekyc_registered_at"),
    birthDayMonth: text("birth_day_month"),
    ageBand: text("age_band"),
    ...imported,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.clientCode] }), index("clients_name_idx").on(t.tenantId, t.nameNorm)],
);

// Agents who uploaded a client in their 02_Clients sheet. Together with policy and
// application links this decides who sees a client (scope.ts, clientInScope).
export const clientAgents = sqliteTable(
  "client_agents",
  {
    tenantId: tenantRef(),
    clientCode: text("client_code").notNull(),
    agentCode: text("agent_code").notNull(),
    source: text("source").notNull().default("CLIENTS_SHEET"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.clientCode, t.agentCode] }), index("client_agents_agent_idx").on(t.tenantId, t.agentCode)],
);

export const policies = sqliteTable(
  "policies",
  {
    tenantId: tenantRef(),
    policyNo: text("policy_no").notNull(),
    holderClientCode: text("holder_client_code").notNull(),
    insuredClientCode: text("insured_client_code"),
    // The agent with the largest share (see policy_agents). Changes are logged in record_changes.
    servicingAgentCode: text("servicing_agent_code").notNull(),
    holderName: text("holder_name").notNull(),
    holderNameNorm: text("holder_name_norm").notNull(),
    insuredName: text("insured_name").notNull(),
    insuredNameNorm: text("insured_name_norm").notNull(),
    status: text("status").notNull(),
    effectiveDate: text("effective_date").notNull(),
    maturityDate: text("maturity_date").notNull(),
    premiumFrequency: text("premium_frequency").notNull(),
    premiumDueDate: text("premium_due_date"),
    plannedPremiumVnd: integer("planned_premium_vnd"),
    basePremiumVnd: integer("base_premium_vnd").notNull(),
    unpaidPremiumVnd: integer("unpaid_premium_vnd"),
    aplDebtVnd: integer("apl_debt_vnd"),
    hasBeneficiary: integer("has_beneficiary", { mode: "boolean" }),
    ...imported,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.policyNo] }), index("policies_holder_idx").on(t.tenantId, t.holderClientCode)],
);

// The agents of a policy and their share. A split policy has one row per agent.
// A link that is no longer in the latest import of the policy is ended, not deleted.
export const policyAgents = sqliteTable(
  "policy_agents",
  {
    tenantId: tenantRef(),
    policyNo: text("policy_no").notNull(),
    agentCode: text("agent_code").notNull(),
    splitPercent: integer("split_percent"),
    isServicing: integer("is_servicing", { mode: "boolean" }).notNull().default(false),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    ...imported,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.policyNo, t.agentCode] }), index("policy_agents_agent_idx").on(t.tenantId, t.agentCode)],
);

// The clients of a policy and their role: PO (bên mua), LI (người được bảo hiểm), BEN (người thụ hưởng).
export const policyClients = sqliteTable(
  "policy_clients",
  {
    tenantId: tenantRef(),
    policyNo: text("policy_no").notNull(),
    clientCode: text("client_code").notNull(),
    role: text("role").$type<"PO" | "LI" | "BEN">().notNull(),
    // POLICY (03_Policies) or PRODUCT (04_Policy_Products insured).
    source: text("source").notNull(),
    endedAt: text("ended_at"),
    ...imported,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.policyNo, t.clientCode, t.role] }), index("policy_clients_client_idx").on(t.tenantId, t.clientCode)],
);

export const policyProducts = sqliteTable(
  "policy_products",
  {
    tenantId: tenantRef(),
    policyNo: text("policy_no").notNull(),
    productCode: text("product_code").notNull(),
    // Empty string when the sheet gives no insured for the product (part of the key).
    insuredCode: text("insured_code").notNull().default(""),
    productName: text("product_name"),
    productRole: text("product_role").notNull(),
    sumAssuredVnd: integer("sum_assured_vnd"),
    annualPremiumVnd: integer("annual_premium_vnd"),
    plan: text("plan"),
    startDate: text("start_date"),
    status: text("status"),
    ...imported,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.policyNo, t.productCode, t.insuredCode] })],
);

// DLVN-wide product catalog (11_Products), loaded by the Platform Admin. Not tenant data.
// `category` decides the coverage group shown on the client page (src/shared/coverage.ts).
// fit_rule / trigger_event are kept for later: product suggestions wait until rule_status is approved.
export const products = sqliteTable("products", {
  productCode: text("product_code").primaryKey(),
  productName: text("product_name").notNull(),
  productRole: text("product_role"),
  category: text("category"),
  minEntryAge: text("min_entry_age"),
  maxEntryAge: text("max_entry_age"),
  maxCoverAge: text("max_cover_age"),
  gender: text("gender"),
  waitingPeriod: text("waiting_period"),
  keyBenefits: text("key_benefits"),
  fitRule: text("fit_rule"),
  triggerEvent: text("trigger_event"),
  ruleStatus: text("rule_status"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Family of a client, kept by the FC (Success has no relationship column). A row either
// labels another client (related_client_code: linked through policies or picked by the FC)
// or describes a family member who is not a client yet (full_name, birth_year, gender),
// who can be turned into the FC's own lead (lead_id). `relation` is from the client's side.
export const clientFamily = sqliteTable(
  "client_family",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    clientCode: text("client_code").notNull(),
    relatedClientCode: text("related_client_code"),
    fullName: text("full_name"),
    // Date of birth, each part optional (the FC may know only the day and month).
    birthDay: integer("birth_day"),
    birthMonth: integer("birth_month"),
    birthYear: integer("birth_year"),
    gender: text("gender"),
    relation: text("relation").$type<FamilyRelation>().notNull(),
    note: text("note"),
    leadId: text("lead_id"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("client_family_client_idx").on(t.tenantId, t.clientCode),
    index("client_family_related_idx").on(t.tenantId, t.relatedClientCode),
    uniqueIndex("client_family_pair_idx").on(t.tenantId, t.clientCode, t.relatedClientCode),
  ],
);

export const applications = sqliteTable(
  "applications",
  {
    tenantId: tenantRef(),
    applicationNo: text("application_no").notNull(),
    policyNo: text("policy_no"),
    agentCode: text("agent_code").notNull(),
    clientCode: text("client_code"),
    holderName: text("holder_name").notNull(),
    holderNameNorm: text("holder_name_norm").notNull(),
    createdDate: text("created_date").notNull(),
    receivedDate: text("received_date"),
    status: text("status").notNull(),
    issuedDate: text("issued_date"),
    productCode: text("product_code"),
    apeVnd: integer("ape_vnd"),
    ...imported,
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.applicationNo] }),
    index("applications_agent_idx").on(t.tenantId, t.agentCode),
    index("applications_client_idx").on(t.tenantId, t.clientCode),
  ],
);

// 07_Activities: actions recorded in the Success activity tracking module.
export const successActivities = sqliteTable(
  "success_activities",
  {
    tenantId: tenantRef(),
    activityId: text("activity_id").notNull(),
    agentCode: text("agent_code").notNull(),
    leaderCode: text("leader_code"),
    officeCode: text("office_code"),
    programCode: text("program_code"),
    programMonth: integer("program_month"),
    // CHECKIN, CALL, SOCIAL_POST, MEETING, COACHING, OTHER, PROPOSAL
    activityType: text("activity_type").notNull(),
    subActivityTitle: text("sub_activity_title"),
    recordMode: text("record_mode"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    durationSeconds: integer("duration_seconds"),
    status: text("status").notNull(),
    customerId: text("customer_id"),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    activityMethod: text("activity_method"),
    callType: text("call_type"),
    callOutcome: text("call_outcome"),
    callPhoneHash: text("call_phone_hash"),
    contentNote: text("content_note"),
    locationName: text("location_name"),
    // Day in Vietnam time, and masked phone (0912***678) to match CRM contacts.
    activityDate: text("activity_date").notNull(),
    phoneKey: text("phone_key"),
    ...imported,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.activityId] }), index("success_activities_agent_idx").on(t.tenantId, t.agentCode, t.activityDate)],
);

/* ---------- Imports ---------- */

export const imports = sqliteTable(
  "imports",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    agentCode: text("agent_code"),
    // Null when the original workbook was not kept (it had PDP-banned columns, or was never sent).
    r2Key: text("r2_key"),
    fileName: text("file_name").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    status: text("status").$type<ImportStatus>().notNull(),
    // Per sheet: status, columns found, and found / inserted / updated / rejected / warnings.
    sheetCounts: text("sheet_counts", { mode: "json" }).$type<ImportSheetCounts>().notNull(),
    createdAt: text("created_at").notNull(),
    committedAt: text("committed_at"),
  },
  (t) => [index("imports_tenant_idx").on(t.tenantId, t.createdAt), index("imports_user_idx").on(t.userId)],
);

export const importErrors = sqliteTable(
  "import_errors",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    tenantId: tenantRef(),
    sheet: text("sheet").notNull(),
    // Excel row number. 1 = header row, for problems with the sheet or a column as a whole.
    row: integer("row").notNull(),
    column: text("column"),
    code: text("code").notNull(),
    // Key of the record as written in the file (e.g. the policy number), to know what to re-import.
    recordKey: text("record_key"),
    messageVi: text("message_vi").notNull(),
    // error = the row (or sheet) was not imported; warning = imported, please check.
    severity: text("severity").$type<"error" | "warning">().notNull(),
  },
  (t) => [index("import_errors_import_idx").on(t.importId, t.sheet, t.row)],
);

// Validated rows waiting for the uploader to confirm. Emptied on commit.
export const importRows = sqliteTable(
  "import_rows",
  {
    importId: text("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    tenantId: tenantRef(),
    sheet: text("sheet").notNull(),
    rowNo: integer("row_no").notNull(),
    key: text("key").notNull(),
    // Owning agent code, for the upload scope rule. Null when the sheet has no owner column.
    owner: text("owner"),
    // JSON object keyed by target column name.
    data: text("data").notNull(),
    status: text("status").$type<"OK" | "REJECTED">().notNull(),
  },
  (t) => [primaryKey({ columns: [t.importId, t.sheet, t.rowNo] }), index("import_rows_key_idx").on(t.importId, t.sheet, t.key)],
);

// Field-level history of existing records changed by an import or by hand.
export const recordChanges = sqliteTable(
  "record_changes",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    // agent | client | policy | policy_product | application
    entity: text("entity").notNull(),
    entityKey: text("entity_key").notNull(),
    // A column name, or "agents" / "clients" for the links of a policy.
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    importId: text("import_id"),
    changedBy: text("changed_by").notNull(),
    changedAt: text("changed_at").notNull(),
  },
  (t) => [index("record_changes_entity_idx").on(t.tenantId, t.entity, t.entityKey, t.changedAt)],
);

/* ---------- AI assistants ---------- */

// Per GA: models used per tier, the router model and the monthly token budget.
export const aiSettings = sqliteTable("ai_settings", {
  tenantId: tenantRef().primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // { FAST, BALANCED, DEEP } -> { provider, model }
  tiers: text("tiers", { mode: "json" }).$type<Record<AiTier, AiModelChoice>>().notNull(),
  router: text("router", { mode: "json" }).$type<AiModelChoice>().notNull(),
  monthlyTokenLimit: integer("monthly_token_limit").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull(),
});

// A GA's own API key per provider, encrypted (src/server/ai/keys.ts). Never returned to the browser.
export const aiProviderKeys = sqliteTable(
  "ai_provider_keys",
  {
    tenantId: tenantRef(),
    provider: text("provider").$type<AiProvider>().notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    last4: text("last4").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.provider] })],
);

// An AI agent ("trợ lý") configured by the GA Head: character, instructions, models, knowledge.
export const aiAgents = sqliteTable(
  "ai_agents",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    kind: text("kind").$type<AgentKind>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    instructions: text("instructions").notNull(),
    contexts: text("contexts", { mode: "json" }).$type<AiContext[]>().notNull(),
    // Optional per-agent model override per tier; missing tiers use the GA settings.
    models: text("models", { mode: "json" }).$type<Partial<Record<AiTier, AiModelChoice>>>().notNull(),
    // Optional per-agent override of the tier used for a task class.
    taskTiers: text("task_tiers", { mode: "json" }).$type<Partial<Record<TaskClass, AiTier>>>().notNull(),
    // CRM data and tools on/off, the agent's own quick prompts (migration 0009).
    config: text("config", { mode: "json" }).$type<Partial<AgentConfig>>().notNull().default({}),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("ai_agents_tenant_idx").on(t.tenantId)],
);

// Knowledge bases (product T&C, underwriting, policy services...), shared by the GA's agents.
export const aiKnowledgeBases = sqliteTable(
  "ai_knowledge_bases",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").$type<KbCategory>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("ai_kb_tenant_idx").on(t.tenantId)],
);

export const aiAgentKnowledge = sqliteTable(
  "ai_agent_knowledge",
  {
    tenantId: tenantRef(),
    agentId: text("agent_id").notNull(),
    kbId: text("kb_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.agentId, t.kbId] })],
);

export const aiDocuments = sqliteTable(
  "ai_documents",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    kbId: text("kb_id").notNull(),
    title: text("title").notNull(),
    // 11_Products code the document is about (e.g. a product's terms), so client context can find it.
    productCode: text("product_code"),
    sourceName: text("source_name"),
    chars: integer("chars").notNull(),
    chunks: integer("chunks").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("ai_documents_kb_idx").on(t.tenantId, t.kbId)],
);

// Text chunks of a document. Full-text index ai_chunks_fts (FTS5, migration 0007) follows this table.
export const aiChunks = sqliteTable(
  "ai_chunks",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    kbId: text("kb_id").notNull(),
    documentId: text("document_id").notNull(),
    seq: integer("seq").notNull(),
    heading: text("heading"),
    body: text("body").notNull(),
  },
  (t) => [index("ai_chunks_doc_idx").on(t.tenantId, t.documentId)],
);

export const aiConversations = sqliteTable(
  "ai_conversations",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    context: text("context").$type<AiContext>().notNull(),
    // Lead id or client code for LEAD / CLIENT.
    contextRef: text("context_ref"),
    title: text("title").notNull(),
    // Pseudonyms: token -> { type, ref, name }. Real names never leave the CRM.
    pseudonyms: text("pseudonyms", { mode: "json" }).$type<Record<string, { type: string; ref: string; name: string }>>().notNull(),
    coach: text("coach", { mode: "json" }).$type<CoachSetup>(),
    score: text("score", { mode: "json" }).$type<CoachScore>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("ai_conversations_user_idx").on(t.tenantId, t.userId, t.updatedAt)],
);

export const aiMessages = sqliteTable(
  "ai_messages",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRef(),
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    // As typed by the FC (user) or written by the model with pseudonym tokens (assistant).
    content: text("content").notNull(),
    task: text("task").$type<TaskClass>(),
    provider: text("provider").$type<AiProvider>(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    sources: text("sources", { mode: "json" }).$type<{ n: number; title: string; kb: string; heading: string | null }[]>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("ai_messages_conv_idx").on(t.tenantId, t.conversationId, t.createdAt), index("ai_messages_usage_idx").on(t.tenantId, t.createdAt)],
);

/* ---------- Audit ---------- */

// Append-only: UPDATE and DELETE are blocked by triggers (see migration 0000).
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    // Null for platform-level events.
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    action: text("action").$type<AuditAction>().notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    meta: text("meta"),
    ip: text("ip"),
    at: text("at").notNull(),
  },
  (t) => [index("audit_tenant_at_idx").on(t.tenantId, t.at)],
);
