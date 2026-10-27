import { queryOptions } from "@tanstack/react-query";
import { vi } from "@/i18n/vi";
import type {
  ActivityType,
  FamilyRelation,
  AgentRank,
  ImportStatus,
  LeadCareStatus,
  LeadInterest,
  LeadStage,
  Reach,
  Role,
  TenantStatus,
  UserStatus,
} from "@/shared/enums";
import type { ActionKind } from "@/shared/enums";
import type { CoverageGroup } from "@/shared/coverage";
import type { ImportSheetCounts } from "@/shared/import/template";
import type { ConfigurableRole, Permission } from "@/shared/permissions";
import type { Page } from "@/shared/schemas";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const hasBody = init.json !== undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (hasBody ? "POST" : "GET"),
      credentials: "same-origin",
      headers: hasBody ? { "content-type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "internal");
  return body as T;
}

export const errorText = (e: unknown) =>
  (e instanceof ApiError && vi.errors[e.code]) || vi.errors.internal!;

const dateTime = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  dateStyle: "short",
  timeStyle: "short",
});
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : null);

export type Me = {
  user: { id: string; email: string; name: string; agentCode: string | null };
  tenant: { id: string; gaCode: string; name: string } | null;
  roles: Role[];
  permissions: Permission[];
  reach: Reach;
};

export const can = (me: Me, permission: Permission) => me.permissions.includes(permission);
export type User = {
  id: string;
  email: string;
  name: string;
  agentCode: string | null;
  agentName: string | null;
  status: UserStatus;
  lastLoginAt: string | null;
  roles: Role[];
};
export type Agent = {
  agentCode: string;
  name: string;
  rank: AgentRank;
  managerCode: string | null;
  path: string;
  status: string | null;
  officeCode: string | null;
};
export type Tenant = { id: string; gaCode: string; name: string; status: TenantStatus; createdAt: string };
export type InviteLink = { inviteUrl: string; inviteExpiresAt: string };

export const meQuery = queryOptions({ queryKey: ["me"], queryFn: () => api<Me>("/api/me"), staleTime: 60_000 });

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])),
  ).toString();

export const usersQuery = (page: number, q: string) =>
  queryOptions({
    queryKey: ["users", page, q],
    queryFn: () => api<Page<User>>(`/api/users?${qs({ page, q })}`),
  });

export const agentTreeQuery = queryOptions({
  queryKey: ["agents", "tree"],
  queryFn: () => api<{ items: Agent[] }>("/api/agents/tree"),
});

export const tenantsQuery = (page: number) =>
  queryOptions({
    queryKey: ["tenants", page],
    queryFn: () => api<Page<Tenant>>(`/api/platform/tenants?${qs({ page })}`),
  });

export const tenantUsersQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["tenants", tenantId, "users"],
    queryFn: () => api<{ tenant: Tenant; users: Page<User> }>(`/api/platform/tenants/${tenantId}?pageSize=50`),
    staleTime: Infinity, // every fetch is an audited cross-tenant read; do not refetch in the background
  });

export type Import = {
  id: string;
  userId: string;
  userName?: string;
  fileName: string;
  snapshotDate: string;
  status: ImportStatus;
  sheets: ImportSheetCounts;
  fileKept: boolean;
  createdAt: string;
  committedAt: string | null;
};
export type ImportError = {
  sheet: string;
  row: number;
  column: string | null;
  code: string;
  recordKey: string | null;
  message: string;
  severity: "error" | "warning";
};
export type Rejected = {
  items: { sheet: string; row: number; recordKey: string | null; codes: string[] }[];
  bySheet: { sheet: string; code: string; rows: number }[];
  total: number;
};
export type PermissionMatrix = {
  permissions: Permission[];
  roles: ConfigurableRole[];
  grants: Record<ConfigurableRole, Permission[]>;
};

export const permissionsQuery = queryOptions({
  queryKey: ["permissions"],
  queryFn: () => api<PermissionMatrix>("/api/permissions"),
});

export const rejectedQuery = (id: string) =>
  queryOptions({
    queryKey: ["imports", id, "rejected"],
    queryFn: () => api<Rejected>(`/api/imports/${id}/rejected?pageSize=20`),
  });

export const importsQuery = (page: number) =>
  queryOptions({
    queryKey: ["imports", page],
    queryFn: () => api<Page<Import>>(`/api/imports?${qs({ page, pageSize: 10 })}`),
  });

export const importErrorsQuery = (id: string) =>
  queryOptions({
    queryKey: ["imports", id, "errors"],
    queryFn: () => api<Page<ImportError>>(`/api/imports/${id}/errors?pageSize=20`),
  });

/* ---------- Leads ---------- */

export type LeadRow = {
  id: string;
  fullName: string;
  phone: string;
  source: string;
  phoneSource: string | null;
  region: string | null;
  leadDate: string;
  stage: LeadStage;
  interest: LeadInterest | null;
  careStatus: LeadCareStatus | null;
  assignedAgentCode: string | null;
  agentName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  assignedAt: string | null;
  firstContactAt: string | null;
  lastContactAt: string | null;
  nextActionAt: string | null;
  consentMarketing: boolean;
  isNew: boolean;
  origin: string;
  newComment: boolean;
  overdue: boolean;
};
export type LeadFilters = {
  q?: string;
  interest?: string;
  care?: string;
  source?: string;
  campaignId?: string;
  assignee?: string;
  from?: string;
  to?: string;
  overdue?: "1";
  isNew?: "1";
  newComment?: "1";
};
export type LeadDetail = {
  lead: LeadRow & {
    email: string | null;
    province: string | null;
    gender: string | null;
    lostReason: string | null;
    progressNote: string | null;
    productInterest: string | null;
    extraInfo: string | null;
    consentSource: string | null;
    dob: string | null;
    applicationNo: string | null;
    policyNo: string | null;
    origin: string;
  };
  notes: { id: string; note: string | null; occurredAt: string; createdBy: string; source: string }[];
  contacts: { id: string; type: ActivityType; outcome: string | null; note: string | null; occurredAt: string; agentCode: string | null; source: string; createdBy: string }[];
  tasks: { id: string; title: string; dueAt: string; status: "OPEN" | "DONE" | "CANCELLED"; source: string; doneAt: string | null; doneBy: string | null; createdBy: string }[];
  assignee: { agentCode: string; name: string } | null;
  campaign: { id: string; name: string } | null;
  history: { id: string; field: string; oldValue: string | null; newValue: string | null; note: string | null; changedAt: string; changedBy: string; importId: string | null }[];
  agentNames: Record<string, string>;
  comments: { id: string; authorUserId: string; body: string; createdAt: string }[];
  /** Names of the users who made changes, wrote notes and comments. */
  userNames: Record<string, string>;
  /** False for a manager of the line: they see the lead (phone masked) and comment. */
  canWork: boolean;
  canManage: boolean;
  interestLocked: boolean;
};
export type Assignee = { agentCode: string; name: string; rank: AgentRank; managerName: string | null; openLeads: number };
export type LeadReportRow = {
  agentCode: string | null;
  agentName: string | null;
  managerName: string | null;
  total: number;
  contacted: number;
  timedContacts: number;
  contactedIn24h: number;
  overdue: number;
  notReached: number;
  undetermined: number;
  notInterested: number;
  life: number;
  healthCard: number;
  caring: number;
  won: number;
  dropped: number;
};

export const leadsQuery = (page: number, filters: LeadFilters) =>
  queryOptions({
    queryKey: ["leads", "list", page, filters],
    queryFn: () => api<Page<LeadRow>>(`/api/leads?${qs({ page, pageSize: 25, ...filters })}`),
  });
export const leadFacetsQuery = queryOptions({
  queryKey: ["leads", "facets"],
  queryFn: () => api<{ sources: string[]; campaigns: { id: string; name: string }[]; assignees: { agentCode: string; name: string }[] }>("/api/leads/facets"),
});
export const assigneesQuery = queryOptions({
  queryKey: ["leads", "assignees"],
  queryFn: () => api<{ items: Assignee[] }>("/api/leads/assignees"),
});
export const leadQuery = (id: string) =>
  queryOptions({ queryKey: ["leads", "detail", id], queryFn: () => api<LeadDetail>(`/api/leads/${id}`) });
export const leadReportQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ["leads", "report", from, to],
    queryFn: () => api<{ items: LeadReportRow[] }>(`/api/leads/report?${qs({ from, to })}`),
  });

export type ActivityReportRow = {
  agentCode: string;
  name: string;
  managerName: string | null;
  counts: Record<ActionKind, number>;
  total: number;
  fromCrm: number;
  fromSuccess: number;
  won: number;
};
export const activityReportQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ["reports", "activities", from, to],
    queryFn: () => api<{ from: string; to: string; items: ActivityReportRow[] }>(`/api/reports/activities?${qs({ from, to })}`),
  });

export type LeadCounts = { all: number; mine: number; unassigned: number; overdue: number; isNew: number; newComment: number };
export const leadCountsQuery = queryOptions({ queryKey: ["leads", "counts"], queryFn: () => api<LeadCounts>("/api/leads/counts") });

/* ---------- Clients (F8) ---------- */

export type ClientSignalKey = "due" | "debt" | "maturity" | "birthday" | "lapsed";
export type ClientRow = {
  clientCode: string;
  name: string;
  tier: string | null;
  ageBand: string | null;
  gender: string | null;
  birthDayMonth: string | null;
  activePolicies: number;
  nextDue: string | null;
  agentNames: string | null;
} & Record<ClientSignalKey, boolean>;
/** `agents`: comma-separated agent codes ("Khách hàng của"); absent = everyone in scope. */
export type ClientFilters = { q?: string; signal?: ClientSignalKey; tier?: string; agents?: string };
export const clientsQuery = (page: number, filters: ClientFilters) =>
  queryOptions({
    queryKey: ["clients", "list", page, filters],
    queryFn: () => api<Page<ClientRow>>(`/api/clients?${qs({ page, ...filters })}`),
  });
export type ClientCounts = { all: number } & Record<ClientSignalKey, number>;
export const clientCountsQuery = (agents?: string) =>
  queryOptions({ queryKey: ["clients", "counts", agents], queryFn: () => api<ClientCounts>(`/api/clients/counts?${qs({ agents })}`) });

type Product = {
  policyNo: string;
  productCode: string;
  insuredCode: string;
  productName: string | null;
  productRole: string;
  sumAssuredVnd: number | null;
  annualPremiumVnd: number | null;
  plan: string | null;
  startDate: string | null;
  status: string | null;
  category: string | null;
  group: CoverageGroup;
};
export type Coverage = {
  activePolicies: string[];
  covered: boolean;
  hasDetail: boolean;
  items: { policyNo: string; productCode: string; productName: string; productRole: string; category: string | null; group: CoverageGroup; sumAssuredVnd: number | null; annualPremiumVnd: number | null }[];
  groups: Partial<Record<CoverageGroup, number>>;
  gaps: CoverageGroup[] | null;
};
type PolicyRole = "PO" | "LI" | "BEN";
export type ClientPolicy = {
  policyNo: string;
  holderClientCode: string;
  insuredClientCode: string | null;
  insuredName: string;
  status: string;
  effectiveDate: string;
  maturityDate: string;
  premiumFrequency: string;
  premiumDueDate: string | null;
  plannedPremiumVnd: number | null;
  basePremiumVnd: number | null;
  unpaidPremiumVnd: number | null;
  aplDebtVnd: number | null;
  hasBeneficiary: boolean | null;
  roles: PolicyRole[];
  agents: { agentCode: string; name: string | null; splitPercent: number | null; isServicing: boolean }[];
  products: Product[];
};
export type FamilyClient = {
  kind: "CLIENT";
  clientCode: string;
  /** False for a person known only from a policy (Success lists holders only in 02_Clients). */
  isClient: boolean;
  name: string;
  ageBand: string | null;
  dob: string | null;
  gender: string | null;
  tier: string | null;
  label: { id: string; relation: FamilyRelation; note: string | null } | null;
  sharedPolicies: { policyNo: string; myRoles: PolicyRole[]; theirRoles: PolicyRole[] }[];
  coverage: Coverage;
};
export type FamilyMember = { kind: "MEMBER"; id: string; name: string; birthDay: number | null; birthMonth: number | null; birthYear: number | null; gender: string | null; relation: FamilyRelation; note: string | null; leadId: string | null };
export type ClientSignal = { kind: keyof typeof vi.clients.signal; policyNo?: string; date?: string | null; amount?: number | null; name?: string; groups?: CoverageGroup[] };
export type ClientDetail = {
  client: {
    clientCode: string;
    name: string;
    tier: string | null;
    activePolicies: number | null;
    lapsedPolicies: number | null;
    dob: string | null;
    gender: string | null;
    maritalStatus: string | null;
    loyaltyPoints: number | null;
    usesDconnect: boolean | null;
    dconnectLastLoginAt: string | null;
    idUpdated: boolean | null;
    ekycRegistered: boolean | null;
    ekycRegisteredAt: string | null;
    birthDayMonth: string | null;
    ageBand: string | null;
  };
  policies: ClientPolicy[];
  coverage: Coverage;
  family: (FamilyClient | FamilyMember)[];
  applications: { applicationNo: string; policyNo: string | null; agentCode: string; createdDate: string; status: string; issuedDate: string | null; productCode: string | null; apeVnd: number | null }[];
  notes: { id: string; note: string | null; occurredAt: string; createdBy: string }[];
  activities: { id: string; type: "CALL" | "ZALO" | "MEETING"; outcome: string | null; note: string | null; occurredAt: string; createdBy: string }[];
  history: { id: string; entity: string; entityKey: string; field: string; oldValue: string | null; newValue: string | null; importId: string | null; changedBy: string; changedAt: string }[];
  signals: ClientSignal[];
  userNames: Record<string, string>;
  clientNames: Record<string, string>;
  canEdit: boolean;
};
export const clientQuery = (code: string) => queryOptions({ queryKey: ["clients", "detail", code], queryFn: () => api<ClientDetail>(`/api/clients/${code}`) });
export const clientSearchQuery = (q: string) =>
  queryOptions({
    queryKey: ["clients", "search", q],
    queryFn: () => api<{ items: { clientCode: string; name: string; ageBand: string | null; gender: string | null }[] }>(`/api/clients/search?${new URLSearchParams({ q })}`),
    enabled: q.trim().length >= 2,
  });

export type CatalogProduct = { productCode: string; productName: string; productRole: string | null; category: string | null; ruleStatus: string | null; updatedAt: string };
export const productsQuery = queryOptions({ queryKey: ["platform", "products"], queryFn: () => api<{ items: CatalogProduct[] }>("/api/platform/products") });

const vnd = new Intl.NumberFormat("vi-VN");
export const formatVnd = (n: number | null | undefined) => (n === null || n === undefined ? null : `${vnd.format(n)} đ`);
