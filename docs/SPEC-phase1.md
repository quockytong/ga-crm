# GA CRM - Phase 1 Spec (PoC launch)

| | |
|---|---|
| Owner | John, DLVN Innovation team |
| Pilot | 3 GAs, one shared instance, multi-tenant |
| Launch | Friday 30 October 2026 |
| Status | Draft v0.1, 11 Oct 2026 |

## 1. Problem
GAs run the lead half of the business (ads, seminars, telesales, referrals, Zalo/social, about 300 leads per GA per month) in Excel and Google Sheets. When a lead becomes a DLVN client, the link is lost. GAs cannot answer: which source or seminar produced revenue, which FC converts best, or which existing clients to approach for cross-sell.

## 2. Goals and non-goals
**Goals (Phase 1)**
1. Replace sheets for lead capture, assignment and pipeline tracking.
2. Give each FC and manager one view of their leads, Success clients, policies, applications and activities.
3. Link each converted lead to its DLVN Client ID so the GA can measure source-to-revenue.
4. Prove tenant-ready design so more GAs can join without rework.

**Non-goals (Phase 1)**
- AI next best action and cross-sell suggestions (Phase 2; `products` rules are still DRAFT).
- Credential-based sync with Success.
- Sending SMS / Zalo / email from the CRM.
- Commission or payout calculations.
- Native mobile apps (PWA only).

## 3. Success metrics (capture baseline in week 1 from current sheets)
| Metric | Baseline | Pilot target (8 weeks) |
|---|---|---|
| Leads managed in CRM vs sheets | 0% | 90% |
| Median time from lead created to first contact | to measure | under 24 h |
| Issued policies linked to a lead source | about 0% | 80% |
| Weekly active FCs / total FCs per GA | n/a | 60% |
| FCs uploading Success export at least weekly | n/a | 70% |

## 4. Users and access
See CLAUDE.md section 4. Summary: FC < UM < BM < GAD by downline scope; GA Head full tenant; Marketing full leads and campaigns, masked Success data; Admin users and config; Platform Admin cross-tenant.

## 5. Features and acceptance criteria
Priority: **P0** must ship on 30 Oct, **P1** ship if ready, else first week of November.

### F1. Tenants, users and hierarchy (P0)
- F1.1 Platform Admin creates a tenant (GA code, name) and the first GA Head user.
- F1.2 GA Head / Admin invites users by email, sets roles, links agent code. A user can hold several roles.
- F1.3 Agent tree is built from the Agents sheet (`Quản lý` column). GA Head sees the tree and can fix a manager link manually (audited).
- **AC:** a UM sees data of FCs below them and not of a peer UM. A GA-1 user gets 404 on any GA-2 record ID. Automated tests cover both.

### F2. Success data import (P0 for sheets 01-05, P1 for 06-10)
- F2.1 FC uploads the template workbook from the Import screen. Parsing happens in the browser.
- F2.2 Preview per sheet: rows found, new, updated, errors. FC confirms before commit.
- F2.3 Validation: required columns, key format, dates, lists from 12_Lookups, PDP banned columns, upload scope rule (DATA-MODEL section 5).
- F2.4 Error report downloadable as Excel with row, column and Vietnamese message.
- F2.5 Import history per user; GA Head and Admin see all imports in the tenant.
- F2.6 After commit, linked leads auto-advance: application exists, stage SUBMITTED; status "Đã phát hành hợp đồng", stage ISSUED.
- **AC:** the sample template imports with 0 errors. A file with a policy of another FC's agent outside scope rejects only that row. 2,000 rows across sheets commit in under 30 seconds. Leading zeros survive.

### F3. Leads (P0)
- F3.1 Create lead manually (mobile form, under 30 seconds to fill required fields: name, phone, source, consent).
- F3.2 Bulk import leads from CSV / Excel (Google Sheet export) with column mapping and duplicate check by phone within the tenant (warn, do not block).
- F3.3 Public web form per campaign (shareable link / QR) that creates leads with consent checkbox and timestamp. Rate-limited, Turnstile captcha.
- F3.4 Lead list with filters: stage, source, campaign, assignee, date, overdue next action. Saved views "Lead của tôi", "Chưa phân công", "Quá hạn".
- F3.5 Lead detail: info, timeline (stage changes, CRM activities), linked client panel.
- **AC:** a lead without consent cannot be assigned to a telesales campaign. Every change creates history and audit rows.

### F4. Lead assignment (P0)
- F4.1 Marketing (and GA Head) assigns one or many leads to an FC manually, from list or detail.
- F4.2 Assignee picker shows FC name, team, open leads count.
- F4.3 Reassign keeps history. FC sees new leads flagged "Mới được giao".
- **AC:** bulk assign 50 leads in one action. FC sees them on next refresh.

### F5. Pipeline (P0)
- F5.1 Kanban by stage (mobile: stage tabs) and list view.
- F5.2 Move stage with optional note; LOST requires a reason.
- F5.3 Next action date per lead; overdue badge.
- **AC:** stage history drives the funnel report correctly on the seed data.

### F6. CRM activities (P0)
- F6.1 Log call, Zalo, meeting, note, task against a lead or a client, with outcome and optional due date.
- F6.2 "Hôm nay" screen for FC: tasks due, overdue next actions, new leads.
- **AC:** activity appears on the lead or client timeline immediately.

### F7. Lead-to-client link (P0)
- F7.1 On a lead at PROPOSAL or later, FC opens "Liên kết khách hàng".
- F7.2 CRM shows up to 5 suggestions (DATA-MODEL section 6). FC can also search by client code or name.
- F7.3 FC confirms; optional application number. FC can unlink with reason (audited).
- **AC:** a client can be linked to one lead only. Suggestions never show clients outside the FC's scope.

### F8. Client 360 (P0)
- F8.1 Client page: tier, D-Connect use, eKYC, policies with products, applications, premium due date, unpaid premium and APL flags, linked lead and its source, CRM activities.
- F8.2 Client list with filters: tier, has lapsed policy, premium due in 30 days, birthday this month (`birth_day_month`), no D-Connect.
- **AC:** opening a client page writes VIEW_CLIENT to audit log.

### F9. Campaigns and seminars (P0 basic)
- F9.1 Marketing creates campaigns with type, dates, budget.
- F9.2 Seminar: register leads, mark attendance.
- F9.3 Campaign page: leads, stage breakdown, linked clients, issued APE (from linked applications).
- **AC:** cost per lead and cost per issued case shown when budget is set.

### F10. Reports (P0: R1-R3, P1: R4-R5)
| # | Report | Who |
|---|---|---|
| R1 | Funnel and conversion by source and campaign | Marketing, managers, GA Head |
| R2 | FC performance: leads assigned, contacted within 24 h, conversion, issued APE | Managers, GA Head |
| R3 | Pipeline by team (counts and expected APE per stage) | Managers, GA Head |
| R4 | Activity vs target (from 07, 09, 10) | Managers, GA Head |
| R5 | Portfolio view on masked policy data: product mix, premium, lapse | Marketing, GA Head |
- Export to Excel is audited. Marketing exports are masked.

### F11. Audit and PDP (P0)
- F11.1 Audit log per DATA-MODEL section 8; GA Head can view and filter it.
- F11.2 Lead consent captured with source and timestamp.
- F11.3 Delete lead on request (hard delete of personal fields, keep anonymized stats), audited.

## 6. UX notes
- Vietnamese only, mobile-first (most FCs work on phones), PWA installable.
- Bottom nav for FC: Hôm nay, Lead, Khách hàng, Hoạt động, Thêm.
- Manager and Marketing screens are desktop-first with tables.
- Empty states explain the next step, e.g. "Chưa có dữ liệu Success. Tải file xuất từ Dai-ichi Success để bắt đầu."

## 7. Build plan
| Week | Dates | Deliverables |
|---|---|---|
| 0 | Mon 12 Oct | Repo, Cloudflare account (Workers, D1, R2, Turnstile), CI, seed data |
| 1 | 12-17 Oct | F1 tenants, auth, roles, scope layer + tests; F2 import of sheets 01-05; audit log |
| 2 | 19-24 Oct | F3 leads, F4 assignment, F5 pipeline, F6 activities, F7 link, F8 client 360 |
| 3 | 26-28 Oct | F9 campaigns, F10 R1-R3, masking, Excel export; UAT with 1 GA Head + 1 FC per GA |
| 3 | 29 Oct | Fixes, onboarding guide (VN), load the 3 tenants |
| 3 | 30 Oct | Launch |
| 4+ | Nov | P1: sheets 06-10 import, R4-R5, then Phase 2 (cross-sell rules, AI next best action) |

## 8. Risks
| Risk | Mitigation |
|---|---|
| New Success fields not ready by launch | Import accepts missing optional columns; required keys gate only their sheet, not the whole file |
| FCs do not upload exports | Show "last upload" badge; manager report of upload freshness; GA Head reminder |
| Data hosted outside Vietnam (Cloudflare) | Accepted for PoC; DLVN Legal to confirm cross-border transfer file before commercial rollout |
| Name-based link suggestions wrong | FC always confirms; unlink allowed and audited |
| 2.5-week timeline | P0 / P1 split above; weekly demo every Friday to John |

## 9. Open items (do not block the start)
1. DLVN brand tokens for the UI (from Retheming guideline).
2. Who in each GA is Marketing and Admin for the pilot, and user lists.
3. Lost reason list and need list per GA (defaults provided in seed).
4. Product codes to replace `TMP_` keys (needed for Phase 2).
