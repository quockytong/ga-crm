# GA CRM - Data Model (v0.1)

Source of truth for the schema. Update this file in the same commit as any migration.

## 1. Overview

```
                 tenants (GA)
                    |
   users --- user_roles          agents (tree via manager_code + path)
     \___ agent_code ___________/   |
                                    | agent_code
  CRM-OWNED (GA data)               |          SUCCESS DATA (imported, read-only in UI)
  campaigns 1-n leads -------- client_code --> clients 1-n policies 1-n policy_products n-1 products
  leads 1-n crm_activities         \                  \
  leads 1-n lead_stage_history      application_no --> applications
  campaigns 1-n campaign_members                      production_monthly, agent_monthly
                                                      success_activities 1-n success_activity_movements
                                                      activity_targets
  imports 1-n import_errors        audit_log
```

All business tables carry `tenant_id` (FK `tenants.id`) except `products` (DLVN-wide catalog).
Natural keys from Success are unique per tenant: `UNIQUE(tenant_id, <key>)`.

## 2. Platform tables

| Table | Key columns |
|---|---|
| `tenants` | `id`, `ga_code` (unique, e.g. GA-HCM-012), `name`, `status` (active / suspended), `created_at` |
| `users` | `id`, `tenant_id` (null for Platform Admin), `email` (unique across the instance, lower case), `name`, `agent_code` (null for Marketing / Admin; unique per tenant), `status` (INVITED, ACTIVE, DISABLED), `last_login_at`, plus Better Auth columns `email_verified`, `image`, `created_at`, `updated_at` |
| `user_roles` | PK (`user_id`, `role`); role is one of FC, UM, BM, GAD, GA_HEAD, MARKETING, ADMIN, PLATFORM_ADMIN |
| `invitations` | `id`, `tenant_id`, `user_id`, `token_hash` (SHA-256; the token itself is only in the invite link), `expires_at` (7 days), `accepted_at`, `created_by`, `created_at` |
| `role_permissions` | PK (`tenant_id`, `role`, `permission`). RBAC grants per GA, see below |
| `sessions`, `accounts`, `verifications` | Better Auth tables (sessions in D1; `accounts.password` holds the scrypt hash). Managed by Better Auth, children of `users` |
| `agents` | PK (`tenant_id`, `agent_code`), `name`, `rank` (SUM, BM, UM, SA, FC), `manager_code`, `path` (materialized, e.g. `/9000500/9000100/9000001/`), `status`, `gender`, `dob`, `phone`, `start_date`, `end_date`, `office_code`, `manager_fixed` (set when a GA Head fixes the manager link by hand; imports then keep that link), `updated_by_import_id` |

**Scope rule:** a user with agent_code X sees records whose owning agent's `path` contains `/X/`. GA Head sees all rows of the tenant. `path` is rebuilt after each Agents import and after a manual manager fix.

How far a user reaches is derived from their roles (`reachOf` in `src/server/scope.ts`), the union when they hold several:

| Roles include | Reach | Agent-owned rows visible |
|---|---|---|
| GA_HEAD | TENANT | all rows of the tenant |
| UM, BM or GAD (with agent_code X) | DOWNLINE | owner = X, or owner's `path` contains `/X/` |
| FC only (with agent_code X) | OWN | owner = X |
| none of the above (Marketing, Admin) | NONE | none through hierarchy; their access is per feature |

The agent directory itself (code, name, rank, manager; no dob or phone) is visible tenant-wide to GA Head, Marketing and Admin, and by the rule above to agents.

`path` holds only agents that exist in the tenant: an agent whose `manager_code` is not loaded yet is a root, and agents on a manager cycle are cut loose as roots.

**RBAC:** functions are granted per role and per GA in `role_permissions`, edited by the GA Head on the Phân quyền screen (audited). A user's permissions are the union over their roles. GA Head always holds every permission and alone manages the matrix, so a GA cannot lock itself out. Permissions never widen the data scope above, except the two import permissions, which say for whom an upload may write.

| Permission | Default roles (GA Head always) | What it allows |
|---|---|---|
| `users.manage` | Admin | Invite users, set roles and agent code, disable. Only a GA Head can create or change a GA Head |
| `agents.view_all` | Admin, Marketing | See the whole agent directory instead of own subtree |
| `agents.edit_tree` | Admin | Change the manager of any agent (also one created by an FC's own upload); sets `manager_fixed` |
| `imports.upload` | Admin, Marketing, GAD, BM, UM, FC | Use the Import screen |
| `imports.agent_tree` | Admin | 01_Agents for the whole GA: create agents, set managers |
| `imports.tenant_wide` | Marketing | 02-05 for every agent of the GA, not only own + downline |
| `imports.view_all` | Admin | Import history and error reports of every user |
| `leads.manage` | Admin, Marketing | See every lead of the GA (also unassigned), create and edit leads, assign / reassign, see every agent's results |
| `leads.import` | Admin, Marketing | Import the GA's lead sheets (13_Leads) |

The catalog and defaults live in `src/shared/permissions.ts`; a new tenant gets the defaults.

**Invitations:** there is no self sign-up. A user row is created as INVITED together with an invitation; the inviter passes the link on by hand (the CRM sends no email in Phase 1). Accepting sets the password and makes the user ACTIVE.

**Timestamps:** UTC ISO text everywhere, except the Better Auth owned columns (`created_at`, `updated_at`, `expires_at` on `users`, `sessions`, `accounts`, `verifications`), which are unix seconds.

## 3. CRM-owned tables

| Table | Key columns | Notes |
|---|---|---|
| `campaigns` | `id`, `tenant_id`, `name` (unique per tenant, as the GA names it: HC2, Package3...), `type` (ADS, SEMINAR, TELESALES, REFERRAL, SOCIAL_ZALO, EVENT, OTHER), `channel`, `start_date`, `end_date`, `budget_vnd`, `owner_user_id`, `status`, `notes`, `created_at` | Lead imports create missing campaigns (type OTHER). Seminar = type SEMINAR with `event_at`, `location` (F9) |
| `campaign_members` | `campaign_id`, `lead_id`, `status` (INVITED, REGISTERED, ATTENDED, NO_SHOW) | Seminar attendance (F9, not built yet) |
| `leads` | `id`, `tenant_id`, `external_id` (LEAD ID), `full_name`, `name_norm`, `phone` (normalized 0xxxxxxxxx, **unique per tenant**), `email`, `gender`, `age`, `age_band`, `province`, `region` (Khu vực), `need`, `source` (channel as the GA names it: Page BHN, Web, DLVN - Web tư vấn...), `phone_source` (Xin số, Điền form Web, Quét số, Form Đky), `campaign_id`, `lead_date` (Ngày cập nhật lead), `registered_at`, `product_interest`, `product_secondary`, `value_vnd`, `ref_link`, `extra_info`, `stage`, `interest`, `care_status`, `lost_reason`, `progress_note` (Tiến độ tư vấn), `message_status`, `assigned_agent_code`, `assigned_by`, `assigned_at`, `assignee_seen_at`, `first_contact_at`, `last_contact_at`, `next_action_at`, `consent_marketing`, `consent_at`, `consent_source`, `client_code`, `application_no`, `link_status` (NONE, CONFIRMED), `linked_by`, `linked_at`, `created_by`, `created_at`, `updated_at`, `last_import_id` | Owner for scope = `assigned_agent_code`. Unassigned leads visible with `leads.manage` only |
| `lead_tasks` | `id`, `tenant_id`, `lead_id`, `agent_code`, `title`, `due_at`, `status` (OPEN, DONE, CANCELLED), `source` (APP, AUTO_ASSIGN, NEXT_ACTION), `done_at`, `done_by`, `created_by`, `created_at` | "Việc cần làm". On (re)assignment the agent gets "contact within 48 h" (due = assigned_at + 48 h; the previous agent's open one is cancelled; not created for an imported lead that already has a status); the first logged contact completes it. Setting "Hẹn liên hệ tiếp" creates a task due then (replacing the previous one) |
| `lead_comments` | `id`, `tenant_id`, `lead_id`, `author_user_id`, `body`, `created_at` | Coaching thread: anyone who sees the lead may comment (typically the managers of the line); the FC sees it on the lead. `leads.last_comment_at` / `last_comment_by` / `assignee_viewed_at` flag comments the assignee has not read ("Góp ý mới"). A comment does not change `updated_at` |
| `lead_history` | `id`, `tenant_id`, `lead_id`, `field` (stage, interest, care_status, assignee), `old_value`, `new_value`, `note`, `import_id`, `changed_by`, `changed_at` | Every change, by hand or by import. Feeds the timeline, funnel and cycle-time reports |
| `crm_activities` | `id`, `tenant_id`, `agent_code`, `lead_id` (nullable), `client_code` (nullable), `type` (CALL, ZALO, MEETING, SEMINAR, NOTE, TASK), `outcome`, `note`, `occurred_at`, `due_at`, `done_at`, `source` (APP, IMPORT), `created_by`, `created_at` | At least one of lead_id / client_code. A changed progress note in a lead import becomes a NOTE activity |
| `client_family` | `id`, `tenant_id`, `client_code`, `related_client_code` (nullable), `full_name`, `birth_day`, `birth_month`, `birth_year` (each optional), `gender`, `relation` (SPOUSE, CHILD, PARENT, SIBLING, OTHER, from the client's side), `note`, `lead_id`, `created_by`, `created_at`, `updated_at`; unique (tenant, client_code, related_client_code) | Family kept by the FC (Success has no relationship column). A row labels another person (`related_client_code`: a client in scope, or a person on one of the client's policies in scope) or describes a member who is not a client yet (`full_name`...), who can become the FC's own lead (`lead_id`). One row per pair: the other client sees the inverse relation (CHILD <-> PARENT) |
| `config_lists` | `tenant_id`, `list` (lost_reason, lead_source, need), `code`, `label_vi`, `sort`, `active` | Tenant-editable dropdowns (not built yet; sources and campaigns are free text for now) |

**Lead fields added:** `dob`, `policy_no` (with `application_no`, required one of the two when the FC sets "Đã chốt"), `origin` (GA = created by a lead manager, IMPORT = from a lead file, FC_OWN = an FC's own prospect, created and assigned to themselves). An FC_OWN lead cannot be reassigned (by hand or by a lead file) while its creator is an active user whose agent has no end date and is not "Ngưng hoạt động".

**Notes** are NOTE activities (`crm_activities.type = NOTE`): several per lead, oldest first. Lead comments are also oldest first. Contacts are CALL, ZALO and MEETING only.

**Who sees and works a lead.** The assigned FC edits "Thông tin": name, phone (unique per tenant), date of birth, area, province, email, consent and "Nhu cầu" (the field formerly labelled Tình trạng); each change is in `lead_history`. Lead managers (`leads.manage`) and the assigned agent see everything and work the lead (status, contacts). Managers of the line (UM / BM / GAD above the assigned agent) see every field except the phone, which is masked as `0912***678`, cannot search by phone, and cannot change the lead or log contacts: they comment. Every history row, note and comment names the user who made it.

**Two statuses, as GAs use them** (definitions from the GA's lead sheet):
- `interest` = **Tình trạng**, classified at the first successful contact: NOT_REACHED Chưa nghe máy, UNDETERMINED Chưa xác định, NOT_INTERESTED Không quan tâm, LIFE Quan tâm nhân thọ, HEALTH_CARD Quan tâm thẻ rời. Once LIFE, HEALTH_CARD or NOT_INTERESTED it does not change (only `leads.manage` can correct it). Interested in both = LIFE.
- `care_status` = **Trạng thái hiện tại**, where the follow-up stands now: CARING Đang chăm sóc, WON Đã chốt, DROPPED Chốt xịt (needs `lost_reason`), NOT_INTERESTED Không quan tâm.

**Lead stages (fixed in Phase 1):**
`NEW` Mới > `CONTACTED` Đã liên hệ > `APPOINTMENT` Đã hẹn gặp > `MET` Đã gặp > `PROPOSAL` Đã tư vấn / báo giá > `SUBMITTED` Đã nộp HSYCBH > `ISSUED` Đã phát hành HĐ, plus `LOST` Thất bại (needs `lost_reason`).
The care status sets the stage: WON ("Đã chốt" = application submitted, confirmed by the product owner) -> SUBMITTED (unless already ISSUED), DROPPED / NOT_INTERESTED -> LOST, a first status or logged contact moves NEW -> CONTACTED (`stageFor()` in `src/shared/enums.ts`). `SUBMITTED` and `ISSUED` can also be set automatically once a lead is linked and the linked application status changes on import (F2.6, with F7).

**Results** (report per agent over lead dates): leads, contacted (a contact logged or a status set), contacted within 24 h of assignment (CRM-logged contacts only), overdue (assigned > 48 h ago and never contacted), counts per interest and care status, opportunities = LIFE + HEALTH_CARD, conversion = WON / leads. Managers see their downline, `leads.manage` everyone.

## 4. Success data tables (from template v1.1)

| Sheet | Table | Unique key (per tenant) | Owner agent for scope |
|---|---|---|---|
| 01_Agents | `agents` | agent_code | itself |
| 02_Clients | `clients` | client_code | via `client_agents` |
| 03_Policies | `policies` + `policy_agents` + `policy_clients` | policy_no (one row per agent in the file: policy_no + Mã đại lý) | every current agent in `policy_agents` |
| 04_Policy_Products | `policy_products` (+ LI in `policy_clients`) | (policy_no, product_code, insured_code) | via policy |
| 05_Applications | `applications` | application_no | `agent_code` |
| 06_Production_Monthly | `production_monthly` | (agent_code, month) | agent_code |
| 07_Activities | `success_activities` | activity_id | agent_code |
| 08_Activity_Movement | `success_activity_movements` | event_id | via activity |
| 09_Activity_Targets | `activity_targets` | (activity_type_id, sub_activity, program_code) | tenant config |
| 10_Agent_Monthly | `agent_monthly` | (agent_code, period) | agent_code |
| 11_Products | `products` (global, no tenant_id) | product_code | n/a: loaded by the Platform Admin on the "Các GA" screen (`POST /api/platform/products`). `category` gives the coverage group; `fit_rule` / `trigger_event` stored, not used until approved |
| 07_Activities | `success_activities` | activity_id | `agent_code` (like applications: in scope, never taken over). Optional new column `customer_phone` |
| 13_Leads | `leads` (+ `campaigns`, `lead_history`, `crm_activities`) | phone (normalized) | `assigned_agent_code`; imported with `leads.import` for the whole GA |
| 12_Lookups | seed enums in code | n/a | n/a |

### Policies, agents and clients
- **An FC's own Success export has one row per policy**: that FC's Mã đại lý and Tỉ lệ chia. It adds or updates only that agent's link; the other agents of the policy keep theirs. The FC's agent must be in the uploader's scope.
- **GA data** (uploads with `imports.tenant_wide`) may list every agent of a policy, one row each. The shares of a policy's rows must add up to 100% (a single row with 100% or no share counts as complete); otherwise all its rows are rejected (`split_total`). For anyone, a policy whose shares would exceed 100% is rejected.
- A complete set of rows (100%) is the whole picture: links not in the file are ended (`ended_at`, kept for history), e.g. a transfer. An ended link becomes current again if the agent reappears. Each agent of a split policy sees the policy with every agent and share.
- `policy_agents (tenant_id, policy_no, agent_code, split_percent, is_servicing, started_at, ended_at, last_import_id, last_seen_at)`, PK (tenant, policy, agent). The first row of a policy in the file carries the policy fields. Logic in `src/server/import/policy-links.ts`.
- **Servicing agent** = the current agent with the largest share; on a tie the current servicing agent stays, then file order. Stored in `policies.servicing_agent_code` and `policy_agents.is_servicing`. A change (customer request, agent left) is accepted, warned in the preview (`servicing_changed`) and logged.
- `policy_clients (tenant_id, policy_no, client_code, role, source, ended_at, last_import_id, last_seen_at)`, PK (tenant, policy, client, role). Role PO (Mã KH BMBH), LI (Mã NĐBH chính, and Mã NĐBH of each product), BEN (no source column yet: filled once Success provides a beneficiary client code). A customer can hold several roles on several policies. PO / LI from 03_Policies are replaced like agents (old link ended).
- `client_agents (tenant_id, client_code, agent_code, source = CLIENTS_SHEET)`: the uploader of a 02_Clients row.
- **A policy is visible** when one of its current agents is in the user's scope. **A client is visible** when a visible policy has them in any role, an application in scope is theirs, or an agent in scope uploaded them (`policyInScope`, `clientInScope` in `src/server/scope.ts`). Later: or a lead in scope is linked to them.

### Agent activities (07_Activities)
`success_activities (tenant_id, activity_id, agent_code, leader_code, office_code, program_code, program_month, activity_type, sub_activity_title, record_mode, started_at, ended_at, duration_seconds, status, customer_id, customer_name, customer_phone, activity_method, call_type, call_outcome, call_phone_hash, content_note, location_name, activity_date, phone_key, last_import_id, last_seen_at)`. `activity_type` from activity_type_id: 1 CHECKIN, 2 CALL, 3 SOCIAL_POST, 4 MEETING, 5 COACHING, 6 OTHER, 7 PROPOSAL. `activity_date` = day of `started_at` in Vietnam time; `phone_key` = masked phone (first 4 + last 3 digits) from `customer_phone`, else `call_phone_hash`, else `customer_id` when it is a phone.

**Report "Hoạt động đại lý"** counts, per agent and period, CRM contacts logged on leads (CALL, ZALO, MEETING, SEMINAR; notes and tasks are not actions) plus Success activities except `draft` and `rejected`. A Success call with `call_type` zalo counts as ZALO. Calls, Zalo and meetings with the same `phone_key` on the same day count once, across and within sources; rows without a phone are counted one by one. Shown with the leads marked WON in the period. *Matching needs a customer phone in the Success export: the v1.1 template's meetings only carry `customer_id` (e.g. KH-889201).*

### Record history
`record_changes (id, tenant_id, entity, entity_key, field, old_value, new_value, import_id, changed_by, changed_at)`: one row per changed column of an existing record, written in the same transaction as the import (or the manual fix) that changes it. `entity` is agent, client, policy, policy_product or application; `field` is the column name, or `agents` for a policy's agent set (e.g. `9000001:60;9000003:40` -> `9000003:100`). New records and unchanged columns are not logged.

Every imported row stores `last_import_id` and `last_seen_at` (`agents` stores `updated_by_import_id`). Rows missing from newer snapshots are not deleted in Phase 1. A column that is missing from an uploaded sheet is left untouched in rows that already exist.

`client_agents` has PK (`tenant_id`, `client_code`, `agent_code`); `source` is the first of POLICY_HOLDER, POLICY_INSURED, APPLICATION, CLIENTS_SHEET that created the link.

### Columns of the Success tables (sheets 01-05)
| Table | Columns (besides `tenant_id`, `last_import_id`, `last_seen_at`) |
|---|---|
| `clients` | `client_code`, `name`, `name_norm`, `tier`, `active_policies`, `lapsed_policies`, `dob`, `gender`, `marital_status`, `loyalty_points`, `uses_dconnect`, `dconnect_last_login_at`, `id_updated` (the yes/no flag "Đã cập nhật Căn cước", never an ID number), `ekyc_registered`, `ekyc_registered_at`, `birth_day_month`, `age_band` |
| `policies` | `policy_no`, `holder_client_code`, `insured_client_code`, `servicing_agent_code`, `holder_name`, `holder_name_norm`, `insured_name`, `insured_name_norm`, `status`, `effective_date`, `maturity_date`, `premium_frequency`, `premium_due_date`, `planned_premium_vnd`, `base_premium_vnd`, `unpaid_premium_vnd`, `apl_debt_vnd`, `has_beneficiary` |
| `policy_products` | `policy_no`, `product_code`, `insured_code` ('' when the sheet gives none), `product_name`, `product_role`, `sum_assured_vnd`, `annual_premium_vnd`, `plan`, `start_date`, `status` |
| `applications` | `application_no`, `policy_no`, `agent_code`, `client_code`, `holder_name`, `holder_name_norm`, `created_date`, `received_date`, `status`, `issued_date`, `product_code`, `ape_vnd` |

Sheets 06-10 are recognised but not imported yet (P1). The template definition lives in `src/shared/import/template.ts`.

### Column mapping highlights
| Source column | Target | Rule |
|---|---|---|
| `Quản lý`, `Tư vấn tài chính` | `manager_code`, `agent_code`, `rank`, `name` | Parse `RANK: code-Name`. Regex `^(\w+):\s*(\d+)-(.+)$` |
| `Mã Khách Hàng`, `Số HĐBH`, `Số HSYCBH`, `Mã đại lý` | text keys | Keep leading zeros. If Excel gave a number, left-pad to the template length (client 10, policy 9) and log a warning. Formats: client = 10 digits, policy = 9 digits, agent = digits, application = 4-20 letters and digits |
| `Mã KH BMBH` (sheet) / `Mã KH` (data dictionary) | `holder_client_code` | Both header names are accepted |
| Lists (agent status, client tier, marital status, premium frequency, application status, age band, product role, Có / Chưa) | text / boolean | Must match 12_Lookups, ignoring case. Policy and product status have no lookup and are stored as text |
| Money and counts | integer | `13000000`, `13.000.000` and `13,000,000` are accepted |
| Dates `dd/mm/yyyy` | ISO `YYYY-MM-DD` | Reject impossible dates |
| `Tỉ lệ chia` `100%` | integer percent | |
| `kpi_json`, `content_note`, `proof_json`, `eligibility_fail_codes` | JSON text | Validate parse; store raw if invalid and log warning |
| `Bên Mua BH`, `NĐBH chính` | `holder_name`, `insured_name` + `*_norm` | `_norm` used for link suggestions |
| Any column outside the template named like CCCD, CMND, căn cước, chứng minh, hộ chiếu, tài khoản, ngân hàng, bệnh, sức khỏe | rejected | PDP rule. The column is never read or sent by the browser, an error is listed for the sheet, and the original workbook is not kept in R2 |

### Client 360 (F8)
- **Who sees a client:** `clientInScope` (FC own, managers their line, GA Head all). Marketing and Admin have no agent scope and see no client page. Only the client's policies in the caller's scope are shown. Opening a client writes `VIEW_CLIENT`.
- **Who changes it:** the client's own agents (`clientInScope` with OWN reach: serving or sharing a policy, an application, their 02_Clients upload) edit the family, the notes ("Ghi chú", `crm_activities` type NOTE with `client_code`, shown oldest first) and the care log (CALL, ZALO, MEETING). Managers of the line read only.
- **Family:** people on the client's policies in scope are found automatically (PO / LI in `policy_clients`). 02_Clients lists policy holders only, so an insured child or spouse often has no `clients` row: they are shown from the policy (name from `policies.insured_name`, title-cased), with coverage, and can be labelled, but have no client page.
- **Coverage** per person: active products (`policy_products`, status empty or "Đang hiệu lực", on active policies) where they are the product insured (or the main insured when the product has none), summed by group: LIFE, HEALTH, CI, ACCIDENT, MATERNITY, OTHER (`src/shared/coverage.ts`, keywords on the catalog category, then the product name; an unknown main product = LIFE). Gaps (no HEALTH / CI / ACCIDENT) are shown only for people who have product details; without 04_Policy_Products only the policy count is known.
- **Care signals** (facts only, no product advice): premium due within 30 days (holder, active), unpaid premium, APL debt, maturity within 12 months, policy not in force, lapsed count from Success, birthday this month (`birth_day_month`), coverage gaps, family member without coverage, no D-Connect. The list filters on the first five (tabs with counts).

## 5. Import tables

| Table | Key columns |
|---|---|
| `imports` | `id`, `tenant_id`, `user_id`, `agent_code`, `r2_key` (null when the workbook was not kept), `file_name`, `snapshot_date`, `status` (PARSING, VALIDATED, COMMITTED, FAILED), `sheet_counts` JSON (per sheet: status READY / BLOCKED / LATER, columns present, found / inserted / updated / rejected / warnings), `created_at`, `committed_at` |
| `import_errors` | `id`, `import_id`, `tenant_id`, `sheet`, `row` (Excel row; 1 = header, for sheet or column problems), `column`, `code`, `record_key` (the record's key as written in the file, so the uploader knows what to re-import), `message_vi`, `severity` (error = not imported, warning = imported) |
| `import_rows` | Staging: `import_id`, `tenant_id`, `sheet`, `row_no`, `key`, `owner`, `data` JSON, `status` (OK, REJECTED). Emptied on commit |

**Flow:** the browser parses the workbook (SheetJS) and sends template columns only, in chunks of 500 rows. The server validates each cell and stages good rows (PARSING), then checks duplicates, scope and links between sheets and returns the preview (VALIDATED). When the uploader confirms, one transaction upserts every staged row with set-based `INSERT ... SELECT ... ON CONFLICT` (COMMITTED). Starting a new import abandons the user's unconfirmed one (FAILED). The original workbook goes to R2 at `imports/<tenant_id>/<import_id>.xlsx`.

**A missing required column blocks its own sheet only.** Other sheets of the same file are imported.

Warnings (imported, please check): `padded_key`, `servicing_changed`, `manager_fixed_kept`, `lead_exists` (a lead with that phone exists and is updated).

**Lead import (13_Leads).** The Lead screen reads any sheet of a GA's own workbook (e.g. "Chia Lead"): it finds the header row, maps columns by name (aliases in `LEAD_HEADER_ALIASES`) and maps the agent column's short names ("Minh", "FC Trang") to agent codes when exactly one agent matches; the user confirms both mappings. Rows are matched by phone, and an empty cell never wipes a value. **The later record wins:** `leads.updated_at` is the time of the last change (a change in the CRM stamps the exact time; an import stamps the row's NGÀY CẬP NHẬT LEAD at 00:00 Vietnam time). A row updates an existing lead only when its date is after `updated_at`; otherwise, or when the row has no date, the CRM data is kept and the row is listed as kept aside (`lead_not_newer`, status SKIPPED, counted in `skipped`). On the same day the CRM wins, as the file has no time of day. History and note activities from an import carry the row's date. For a new lead the date also becomes `lead_date`; it never changes afterwards.

**Health notes in lead files are stored** (product owner decision, Oct 2026): FCs need them to prepare their approach, so progress notes and health columns of lead files are kept as they are, per lead. ID card numbers and bank details are still rejected everywhere, and health columns stay rejected in Success imports. Status labels are accepted in the GA's wording (`INTEREST_LABELS`, `CARE_LABELS` in `template.ts`); anything else is rejected and listed to re-import.

**Upload scope rule:** an FC upload may only write rows whose owner agent is the uploader or in the uploader's downline. Out-of-scope rows are rejected and listed in `import_errors`. The first upload by a GA Head (or Admin) seeds the agent tree for the tenant.

How the rule is applied per sheet (`src/server/import/validate.ts`):

| Sheet | Rule for an uploader who is not GA Head |
|---|---|
| 01_Agents | Without `imports.agent_tree`: only the uploader's own row and rows of their downline; they cannot add other agents or change a manager link (an FC's first upload may create their own row). With it: also creates a manager named in `Quản lý` who has no row of their own, and never overwrites a link with `manager_fixed` (a warning is listed) |
| 03_Policies | Each row's agent must be in scope (an FC writes only their own share). Shares as described in section 4 |
| 05_Applications | `Mã đại lý` must be in scope, and an application that already belongs to an agent outside the scope cannot be overwritten |
| 04_Policy_Products | The policy must be in the same file, or already imported and in scope |
| 02_Clients | Accepted when the client is new, already linked to an agent in scope, or the file also has the uploader's policy or application for that client |

With `imports.tenant_wide` (Marketing by default) sheets 02-05 are written for the whole GA. Which sheets a user may upload at all follows the import permissions; a sheet they may not upload is blocked with a message. Two rows with the same key in one sheet (for 03_Policies: same policy and agent) keep the first; the others are rejected. The preview and the Excel report list every rejected record with its key and reasons, to fix and import again.

## 6. Lead-to-client link suggestions
Computed on request, not stored:
1. Candidates = clients in the FC's scope (via `client_agents`) not yet linked to another lead.
2. Score: exact `name_norm` match 0.6; same gender +0.1; same age_band +0.1; application created within 60 days after lead creation +0.2.
3. Show top 5 with score, policy and application summary. FC confirms one. Store `client_code`, optional `application_no`, `link_status = CONFIRMED`, audit row.

## 7. Masked views (Marketing)
`v_masked_clients`, `v_masked_policies`, `v_masked_applications` built in `src/server/mask.ts`:
- Names replaced by initials (e.g. `L. T. K.`), client code replaced by a per-tenant salted hash (stable, for joins in reports).
- Drop: `Ngày Sinh`, `birth_day_month`, phone, `Điểm Thưởng`, beneficiary flag.
- Keep: gender, age_band, client tier, marital status, product, sum assured, premium, frequency, status, dates, agent code.

## 8. Audit log
`audit_log (id, tenant_id, user_id, action, entity, entity_id, meta JSON, ip, at)`. Append-only, enforced by triggers that abort UPDATE and DELETE. `tenant_id` is null only for platform-level events. Actions: LOGIN, CREATE, UPDATE, DELETE, ASSIGN, LINK, UNLINK, IMPORT, EXPORT, VIEW_CLIENT, CROSS_TENANT_READ, AI_READ (a lead or client read for an AI answer; meta has the conversation id).

## 9. AI assistants (migration 0007, see docs/SPEC-ai.md)
All tenant-scoped.
- `ai_settings (tenant_id PK, enabled, tiers JSON {FAST, BALANCED, DEEP: {provider, model}}, router JSON, monthly_token_limit, updated_by, updated_at)`. Created with defaults on first use.
- `ai_provider_keys (tenant_id, provider, encrypted_key, last4, updated_by, updated_at)`, PK (tenant_id, provider), migration 0008: the GA's own API key, AES-GCM encrypted (`src/server/ai/keys.ts`), never returned to the browser.
- `ai_agents (id, tenant_id, kind ASSISTANT|OPS|COACH, name, description, enabled, instructions, contexts JSON, models JSON per tier, task_tiers JSON, config JSON {crmData, tools, quickPrompts} (migration 0009), sort_order, ...)`. Kind CUSTOM = role defined only by the GA's instructions. The three defaults have id `<tenant_id>:<kind>`.
- `ai_knowledge_bases (id, tenant_id, name, description, category PRODUCT|UNDERWRITING|SERVICE|SALES|OTHER, enabled, ...)`, `ai_agent_knowledge (tenant_id, agent_id, kb_id)`.
- `ai_documents (id, tenant_id, kb_id, title, product_code, source_name, chars, chunks, created_by, created_at)`; `ai_chunks (id, tenant_id, kb_id, document_id, seq, heading, body)` with the FTS5 table `ai_chunks_fts` (external content, kept in sync by triggers, `unicode61 remove_diacritics 2`). Search always joins back to `ai_chunks` and filters `tenant_id`.
- `ai_conversations (id, tenant_id, user_id, agent_id, context, context_ref, title, pseudonyms JSON token -> {type, ref, name}, coach JSON, score JSON, ...)`: private to `user_id`.
- `ai_messages (id, tenant_id, conversation_id, user_id, agent_id, role, content, task, provider, model, input_tokens, output_tokens, sources JSON, created_at)`. User messages are stored as typed; assistant messages with pseudonym tokens. Deleting a conversation blanks its messages' text and keeps the token counts for usage.
- Permissions `ai.use` (default GAD, BM, UM, FC; granted to existing GAs by the migration) and `ai.manage` (GA Head).
