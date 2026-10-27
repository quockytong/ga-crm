import { z } from "zod";
import { AGENT_ROLES, FAMILY_RELATIONS, LEAD_CARE_STATUSES, LEAD_INTERESTS, TENANT_ROLES } from "./enums";
import { SHEET_NAMES } from "./import/template";
import { CONFIGURABLE_ROLES, PERMISSIONS } from "./permissions";

// Keys are text and keep leading zeros (CLAUDE.md rule 7).
export const agentCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}$/);

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const nameSchema = z.string().trim().min(1).max(120);
const rolesSchema = z
  .array(z.enum(TENANT_ROLES))
  .min(1)
  .transform((r) => [...new Set(r)]);

const needsAgentCode = (v: { roles?: readonly string[]; agentCode?: string | null }) =>
  !v.roles?.some((r) => (AGENT_ROLES as readonly string[]).includes(r)) || !!v.agentCode;

export const inviteUserSchema = z
  .object({
    email: emailSchema,
    name: nameSchema,
    roles: rolesSchema,
    agentCode: agentCodeSchema.nullish(),
  })
  .refine(needsAgentCode, { path: ["agentCode"], message: "agent_code_required" });
export type InviteUserInput = z.input<typeof inviteUserSchema>;

export const updateUserSchema = z.object({
  name: nameSchema.optional(),
  roles: rolesSchema.optional(),
  agentCode: agentCodeSchema.nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export const createTenantSchema = z.object({
  gaCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,30}[A-Z0-9]$/),
  name: nameSchema,
  head: z.object({
    email: emailSchema,
    name: nameSchema,
    agentCode: agentCodeSchema.nullish(),
  }),
});
export type CreateTenantInput = z.input<typeof createTenantSchema>;

export const setManagerSchema = z.object({ managerCode: agentCodeSchema.nullable() });

export const PASSWORD_MIN = 8;
export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(PASSWORD_MIN).max(128),
});

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
  q: z.string().trim().max(100).optional(),
});

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };

/* ---------- Imports ---------- */

export const IMPORT_CHUNK_ROWS = 500;

export const createImportSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  snapshotDate: z.iso.date(),
  sheets: z.array(z.object({ name: z.string().trim().max(100), headers: z.array(z.string().max(200)).max(200) })).max(40),
});
export type CreateImportInput = z.input<typeof createImportSchema>;

const cellSchema = z.union([z.string().max(2000), z.number(), z.null()]);
export const importRowsSchema = z.object({
  sheet: z.enum(SHEET_NAMES),
  rows: z
    .array(z.object({ r: z.number().int().min(2).max(2_000_000), c: z.array(cellSchema).max(40) }))
    .min(1)
    .max(IMPORT_CHUNK_ROWS),
});
export type ImportRowsInput = z.input<typeof importRowsSchema>;

export const importErrorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sheet: z.string().max(100).optional(),
});

/* ---------- RBAC ---------- */

export const setPermissionsSchema = z.object({
  grants: z.object(
    Object.fromEntries(CONFIGURABLE_ROLES.map((r) => [r, z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length)])) as Record<
      (typeof CONFIGURABLE_ROLES)[number],
      z.ZodArray<z.ZodEnum<{ [K in (typeof PERMISSIONS)[number]]: K }>>
    >,
  ),
});

/* ---------- Leads ---------- */

/** Optional text: absent stays undefined (unchanged), empty becomes null (cleared). */
const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null));
const isoDate = z.iso.date();

export const leadListSchema = pageQuerySchema.extend({
  interest: z.enum([...LEAD_INTERESTS, "NONE"]).optional(),
  care: z.enum([...LEAD_CARE_STATUSES, "NONE"]).optional(),
  source: z.string().trim().max(200).optional(),
  campaignId: z.string().max(64).optional(),
  /** An agent code, or NONE for unassigned leads. */
  assignee: z.string().trim().max(20).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  overdue: z.enum(["1"]).optional(),
  isNew: z.enum(["1"]).optional(),
  newComment: z.enum(["1"]).optional(),
});

export const leadCommentSchema = z.object({ body: z.string().trim().min(1).max(2000) });

export const createLeadSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(6).max(20),
  source: z.string().trim().min(1).max(200),
  /** Asked on every new lead (F3.1); false is a valid answer. */
  consent: z.boolean(),
  email: optionalText(),
  region: optionalText(),
  province: optionalText(),
  gender: optionalText(20),
  dob: isoDate.nullish(),
  campaignId: optionalText(64),
  note: optionalText(4000),
  /** Lead managers only; an FC's own lead is always theirs. */
  assignedAgentCode: agentCodeSchema.nullish(),
});

export const updateLeadSchema = z.object({
  // "Thông tin": the assigned FC updates these while talking to the customer.
  fullName: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  dob: isoDate.nullish(),
  region: optionalText(),
  province: optionalText(),
  email: optionalText(),
  consent: z.boolean().optional(),
  interest: z.enum(LEAD_INTERESTS).nullish(),
  // "Cập nhật trạng thái"
  careStatus: z.enum(LEAD_CARE_STATUSES).nullish(),
  lostReason: optionalText(500),
  nextActionAt: z.iso.datetime({ offset: true }).nullish(),
  applicationNo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,20}$/)
    .nullish(),
  policyNo: z
    .string()
    .trim()
    .regex(/^\d{9}$/)
    .nullish(),
  // Lead managers only:
  source: z.string().trim().min(1).max(200).optional(),
  campaignId: optionalText(64),
});

export const leadNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const createTaskSchema = z.object({ title: z.string().trim().min(1).max(200), dueAt: z.iso.datetime({ offset: true }) });
export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  done: z.boolean().optional(),
});

export const assignLeadsSchema = z.object({
  leadIds: z.array(z.string().max(64)).min(1).max(200),
  /** null = unassign. */
  agentCode: agentCodeSchema.nullable(),
});

/** Contacts only: notes have their own endpoint, tasks their own tab. */
export const CONTACT_TYPES = ["CALL", "ZALO", "MEETING"] as const;
export const leadActivitySchema = z.object({
  type: z.enum(CONTACT_TYPES),
  outcome: optionalText(200),
  note: z.string().trim().min(1).max(4000),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

export const leadReportSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

/* ---------- Clients (F8) ---------- */

export const CLIENT_SIGNALS = ["due", "debt", "maturity", "birthday", "lapsed"] as const;
export type ClientSignal = (typeof CLIENT_SIGNALS)[number];

/** Agent codes, comma-separated: only their clients (each must be in the caller's scope). Absent = everyone in scope. */
const agentList = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .transform((v) =>
    v
      ? [
          ...new Set(
            v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ]
      : undefined,
  )
  .pipe(z.array(agentCodeSchema).max(200).optional());
export const clientListSchema = pageQuerySchema.extend({
  signal: z.enum(CLIENT_SIGNALS).optional(),
  tier: z.string().trim().max(50).optional(),
  agents: agentList,
});
export const clientCountsSchema = z.object({ agents: agentList });

const birthFields = {
  birthDay: z.number().int().min(1).max(31).nullish(),
  birthMonth: z.number().int().min(1).max(12).nullish(),
  birthYear: z.number().int().min(1900).max(2100).nullish(),
};
const familyFields = {
  relation: z.enum(FAMILY_RELATIONS),
  note: optionalText(1000),
};
/** Either another client (relatedClientCode) or a family member who is not a client yet (fullName). */
export const createFamilySchema = z.union([
  z.object({ ...familyFields, relatedClientCode: z.string().trim().min(1).max(20) }),
  z.object({
    ...familyFields,
    fullName: z.string().trim().min(1).max(200),
    ...birthFields,
    gender: optionalText(20),
  }),
]);
export const updateFamilySchema = z.object({
  relation: z.enum(FAMILY_RELATIONS).optional(),
  note: optionalText(1000),
  fullName: z.string().trim().min(1).max(200).optional(),
  ...birthFields,
  gender: optionalText(20),
});
export const clientNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const linkFamilyLeadSchema = z.object({ leadId: z.string().max(64) });

/** Care log: contacts only. Notes have their own endpoint and live in "Tổng quan". */
export const clientActivitySchema = z.object({
  type: z.enum(CONTACT_TYPES),
  outcome: optionalText(200),
  note: z.string().trim().min(1).max(4000),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

/* ---------- Product catalog (11_Products, Platform Admin) ---------- */

const catalogText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);
export const productRowSchema = z.object({
  productCode: z.string().trim().min(1).max(50),
  productName: z.string().trim().min(1).max(200),
  productRole: catalogText(50),
  category: catalogText(200),
  minEntryAge: catalogText(50),
  maxEntryAge: catalogText(50),
  maxCoverAge: catalogText(50),
  gender: catalogText(20),
  waitingPeriod: catalogText(200),
  keyBenefits: catalogText(),
  fitRule: catalogText(),
  triggerEvent: catalogText(),
  ruleStatus: catalogText(50),
});
export const productCatalogSchema = z.object({ rows: z.array(productRowSchema).min(1).max(500) });
export type ProductRow = z.infer<typeof productRowSchema>;
