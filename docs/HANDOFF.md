# GA CRM: handoff (state on 26 Oct 2026)

Read this first in a new session, then `CLAUDE.md` (rules), `docs/SPEC-phase1.md` (scope) and
`docs/DATA-MODEL.md` (schema, the source of truth for tables and import rules). Decisions below
were made by the product owner (John, DLVN Innovation) during the build and override the
original spec where they differ.

## 1. Business context
- Multi-tenant CRM for Dai-ichi Life Vietnam General Agencies (GA). Pilot: 3 GAs on one instance, launch 30 Oct 2026.
- Problem: GAs run leads (ads, pages, seminars, telesales, referrals) in Excel / Google Sheets; once a lead becomes a DLVN client the link is lost, so source-to-revenue, FC conversion and cross-sell cannot be measured.
- Solution: lead and pipeline CRM for the GA, plus import of each FC's own Dai-ichi Success exports (Excel template v1.1, `samples/`), plus lead-to-client linking (F7, not built yet).
- Users: FC < UM < BM < GAD by downline; GA Head (whole GA); Marketing (owns leads and campaigns, Success data masked); Admin (users, config, imports); Platform Admin (DLVN, cross-tenant, audited). A user can hold several roles.
- The project lives in `GAOps/ga-crm/` (the session folder `GAOps/` also has a copy of the spec). Not a deployed system yet; git initialised, nothing committed.

## 2. Stack and how to run
- Cloudflare Workers (one Worker: Hono API + React app via `@cloudflare/vite-plugin`), D1 + Drizzle (migrations `src/db/migrations/0000`-`0009`), R2 for original workbooks, Better Auth (email + password, invite only), React 19 + TanStack Router (code routes) + TanStack Query, Tailwind v4 with the DLVN design system tokens, SheetJS in the browser, Zod, Vitest with `@cloudflare/vitest-plugin`.
- `npm run dev` (Vite, http://localhost:5173), `npm test` (14 files, 284 tests), `npm run db:migrate` (local D1), `npm run seed` (2 demo GAs; sign-ins in `src/db/seed.ts`, shared `DEV_PASSWORD`), `npm run typecheck`, `npm run build`.
- Deploy is not done: needs `wrangler d1 create ga-crm --location apac`, R2 bucket `ga-crm-uploads` with a 90-day lifecycle rule, `BETTER_AUTH_SECRET` secret, `APP_URL` (see `README.md`).
- The local dev database holds data the owner imported themselves (real-looking leads). Do not reset it without asking.

## 3. Business rules (built and tested)

### Tenancy, scope, permissions
- Every business table has `tenant_id`; all queries go through `src/server/scope.ts`. Another GA's record is a 404. `test/schema-guard.test.ts` fails if a new table lacks `tenant_id`.
- Data scope comes only from the agent tree (`agents.path`): GA Head = whole GA; UM / BM / GAD = own + downline; FC = own. Never from client input.
- RBAC (`src/shared/permissions.ts`, screen "Phân quyền"): functions per role per GA, edited by the GA Head only (GA Head always has everything). Defaults: Admin = users.manage, agents.view_all, agents.edit_tree, imports.upload, imports.agent_tree, imports.view_all, leads.manage, leads.import; Marketing = agents.view_all, imports.upload, imports.tenant_wide (sheets 02-05 for the whole GA, not the tree), leads.manage, leads.import; GAD / BM / UM / FC = imports.upload. Permissions never widen data scope except the two import ones.
- Only a GA Head creates or edits a GA Head; the last active GA Head cannot be removed.
- Invites are links the inviter copies and sends by hand (no email in Phase 1).
- Audit log is append-only (triggers); every change, import, assignment, comment and cross-tenant read is logged.

### Agent tree
- Built from 01_Agents (`Quản lý` = "RANK: code-Name"). Only users with `imports.agent_tree` (GA Head, Admin) load the tree, create agents (also managers named only in `Quản lý`) and set managers. An FC's own first upload may create their own row.
- A manager link fixed by hand (`agents.edit_tree`, GA Head and Admin) wins over later imports (`manager_fixed`, warning `manager_fixed_kept`).

### Success data import (Import screen, sheets 01-05 and 07)
- Browser parses (SheetJS), sends template columns only; server validates, stages, previews; nothing is written until the uploader confirms. Later sheets 06, 08-10 are recognised but not imported (P1).
- A missing required column blocks its own sheet only. Missing optional columns never wipe stored values. Keys are text, leading zeros kept; numbers that lost zeros are padded with a warning.
- List values must match 12_Lookups or the row is rejected. The preview and the Excel error report list every rejected record with sheet, row, record key and reason ("Cần sửa và nhập lại").
- PDP: ID card and bank-account columns are never read and the original workbook is then not kept in R2; health columns are rejected in Success imports.
- Upload scope: an FC writes only rows of their own agent or downline; with `imports.tenant_wide` the whole GA.
- Split policies: an FC's own export has one row per policy (their code + their share) and adds or updates only that link. GA data (tenant-wide upload) may list every agent of a policy; shares must total 100% or those rows are rejected. A complete set (100%, also one agent with 100%) ends links not in the file (transfer, logged, warning `servicing_changed`). Servicing agent = largest share (tie: current servicing agent). Both agents of a split see the policy with all shares.
- Customer roles on policies: PO (holder), LI (main insured and product insured), BEN (modelled, no source column yet).
- Every field an import changes on an existing record is logged in `record_changes` (old, new, who, which import). No UI shows it yet (planned for client 360).
- 07_Activities (Success activity tracking) is importable; optional new column `customer_phone` (ask Success/IT for it) so calls and meetings can be matched with CRM contacts.
- Each import screen has "Tải file mẫu (Excel)", generated from the same column definitions (`src/shared/import/template-file.ts`).

### Leads
- One lead per phone per GA. Origin: GA (created by a lead manager), IMPORT (lead file), FC_OWN (an FC's own prospect, flagged "Lead tự khai thác", always assigned to that FC; nobody can reassign it, by hand or by file, while that FC still works for the GA).
- Lead import (screen "Nhập lead từ Excel"): any sheet of the GA's own workbook (e.g. "Chia Lead"); header row found automatically; columns auto-mapped by name; agent short names ("Minh", "FC Trang") mapped to agent codes when exactly one agent matches, the user confirms. Matched by phone; empty cells never wipe data. The later record wins: a row updates an existing lead only if its "NGÀY CẬP NHẬT LEAD" is after the lead's last change in the CRM (same day: CRM wins; no date: kept aside). Health notes in lead files are stored as written (product-owner exception to PDP rule 6). Older sheets (e.g. "Dữ Liệu cũ") are ignored.
- Two statuses, as GAs use them: "Nhu cầu" (`interest`, formerly labelled Tình trạng; set at first successful contact, then locked for the FC; Nhân thọ wins over thẻ rời) and "Trạng thái hiện tại" (`care_status`: Đang chăm sóc / Đã chốt / Chốt xịt / Không quan tâm). "Chốt xịt" needs a reason. "Đã chốt" = application submitted (stage SUBMITTED) and needs Số hồ sơ or Số hợp đồng (at least one).
- Who works a lead: the assigned FC and lead managers (`leads.manage`). The FC edits "Thông tin" (name, phone, DoB, area, province, email, consent, Nhu cầu), adds notes, logs contacts (Gọi điện, Zalo, Gặp mặt only), manages tasks. Managers of the line see every lead below them with the phone masked (0912***678), cannot search by phone or change the lead, and leave comments ("Góp ý") the FC sees, flagged "Góp ý mới" until read.
- "Ghi chú" (leads and clients, shared component `src/client/components/notes.tsx`): notes and contacts in one list, oldest first. When adding, the FC may pick a chip (Gọi điện, Zalo, Gặp mặt): the entry is then logged as that contact (first contact, 48 h task, activity report) with the text as its note; no chip = plain note. There is no separate contact form or "Chăm sóc" tab any more.
- Layout: lead "Thông tin" tab = left Thông tin + Góp ý, right Cập nhật trạng thái + Ghi chú; client "Tổng quan" = left Thông tin khách hàng + Quyền lợi bảo hiểm, right Cơ hội chăm sóc + Ghi chú. Comments on a lead are oldest first.
- Tasks ("Việc cần làm"): due date and time; auto task "contact within 48 h" on assignment (completed by the first logged contact, cancelled on reassignment); "Hẹn liên hệ tiếp" creates a follow-up task. A calendar will be built later.
- Every history line, note and comment names who made it.
- The assignee picker shows only the agent's name and code ("Nguyễn Văn A (9000001)"). Bulk assignment takes up to 200 leads; statements are chunked (8 leads per insert) to stay under D1's 100 bound parameters.
- Lead list tabs always show counts (Lead của tôi, Mới được giao, Có góp ý mới, Quá hạn 48 giờ; managers: Tất cả, Chưa phân công, Quá hạn). Overdue = assigned > 48 h ago and never contacted.

### Customers (menu "Khách hàng", F8)
- For agents (own clients; managers their line, read only) and the GA Head. Marketing / Admin do not see it (masked views stay separate, not built).
- List: "Khách hàng của" checkbox filter (default: the signed-in agent's own clients; managers tick FCs of their line or "Tất cả trong nhóm"; server keeps only agents in scope), search by name or code, filter by tier, tabs with counts: Đến hạn phí 30 ngày, Nợ phí / APL, Đáo hạn 12 tháng, Sinh nhật tháng này, Có HĐ mất hiệu lực.
- Detail tabs: Tổng quan (care signals, profile, coverage table per person by group, "Ghi chú" with contacts, oldest first), Hợp đồng (policies with roles, agents and shares, premiums, debts, products; applications), Gia đình, Lịch sử (record_changes from imports).
- Family (product-owner choice): people on the client's policies are linked automatically; the FC labels the relationship (Vợ/Chồng, Con, Bố/Mẹ, Anh/Chị/Em, Khác) and can add other clients or relatives who are not clients yet (name, gender, optional birth day / month / year, note); shown as a table; a relative can become the FC's own lead ("Tạo lead"). 02_Clients only lists policy holders, so insured children / spouses appear from the policy data.
- Care signals (product-owner choice): facts only (due, unpaid, APL, maturity, lapsed, birthday, coverage gaps, uncovered family, no D-Connect). No product recommendations until the 11_Products fit rules are approved (all DRAFT today).
- Product catalog 11_Products is loaded by the Platform Admin ("Các GA" screen) and decides the coverage group; without it groups come from product names.

### Reports (menu "Báo cáo")
- Laid out along the agent tree the viewer sees (GA Head > BM > UM > FC). A manager with a team gets a group row ("Ban kinh doanh D" for a BM, "Phòng kinh doanh A" for a UM / SUM) with the whole team's total; inside it the manager's own numbers stand on a separate row, then units, then individuals. Groups fold (below the second level folded by default). FCs see themselves; lead managers see everyone plus "Chưa phân công".
- "Báo cáo chuyển đổi": per agent over lead dates: leads, contacted (logged contact or a status), contacted within 24 h (CRM-logged only), overdue, counts per Nhu cầu and Trạng thái, opportunities (Nhân thọ + Thẻ rời), close rate.
- "Hoạt động đại lý": per agent over Vietnam days: calls, Zalo, meetings, seminars, proposals, social posts, check-ins, coaching, other, from CRM contacts plus 07_Activities (draft / rejected excluded). Calls, Zalo and meetings with the same masked phone on the same day count once (across and within sources). Shown with leads closed (WON) in the period.

### UI
- Vietnamese only, strings in `src/i18n/vi.ts`. DLVN design system (from `~/Downloads/New design request/_ds/...`): tokens in `src/client/styles/dlvn/`, Logo and FutureLine copied verbatim in `src/client/components/brand/`. Blue-forward, Inter, outlined cards (1px inset ring, no shadows), chosen tab = blue bottom stroke only, page titles = blue bar + all-caps grey eyebrow. No green or amber in the brand: states use blue tints, red only for errors / overdue.

### AI assistants (menu "Trợ lý AI" for the GA Head; floating button for agents) — details in `docs/SPEC-ai.md`
- Three assistants per GA, editable by the GA Head (enable/disable, instructions, screens, knowledge bases, models): Trợ lý bán hàng (day plan, summaries, next best action, lead ranking, product fit / upsell, gifts, messages), Chuyên gia vận hành (underwriting / policy service Q&A from the knowledge bases, with citations), Luyện xử lý từ chối (AI plays a hard customer, then scores the FC).
- Context follows the screen (lead, client 360, lead list, client list, the FC's day), always through the scope layer; every lead / client read is audited (AI_READ). Conversations are private to the user.
- PO: providers Gemini / DeepSeek / Qwen (OpenAI-compatible API, model per tier and per agent). Each GA Head enters the GA's own API key per provider (encrypted, write-only, last 4 shown, "Kiểm tra" button); the platform's Worker secrets are the fallback. PO: pseudonymised — names, phones, emails, client codes and policy numbers never leave the CRM (tokens like [K1], shown with real names in the browser); health sentences in notes are hidden. PO: product suggestions allowed, always labelled "Gợi ý AI – cần kiểm tra trước khi tư vấn".
- Task router (cheap model, keyword fallback) picks task class → tier (Nhanh / Cân bằng / Chuyên sâu) → model, and whether to search the knowledge base; monthly token budget per GA; usage per user / assistant / model / task.
- The GA Head can add own assistants with a free name and prompt (kind "Tùy chỉnh" or a built-in frame), switch CRM data / tools on or off and define quick-prompt buttons.
- Knowledge bases per GA (several files per upload): PDF / DOCX / TXT / MD read in the browser, chunked, FTS5 keyword search (no embeddings yet). Document title and product code can be edited after upload.
- Local dev has no provider keys: enter one on "Trợ lý AI" > "Mô hình và hạn mức" as GA Head (or add `GEMINI_API_KEY` to `.dev.vars`) to try answers. Tests use a fake provider (`setAiFetch`).

## 4. Spec status
- Done: F1 (tenants, users, roles, tree, isolation tests), F2 for sheets 01-05 and 07 (except F2.6), F3 (leads, import, manual create; public web form F3.3 not built), F4 (assignment), F6 (contacts, notes, tasks; "Hôm nay" screen not built), F10 R1-R2 style reports and the activity report, F11 audit (viewer for GA Head not built), RBAC, F8 client 360 (list, detail, family, coverage, care signals, care log, record history), AI assistants (SPEC-ai.md).
- Not built: F2.6 (auto-advance linked leads when Success shows the application / policy), F5 kanban view, F7 lead-to-client link (suggestions; a lead created from a relative is linked to the family row only), Marketing masked client views, F9 campaigns / seminars screens (table exists, created by lead import), F10 R3-R5 and Excel exports (Marketing exports masked), F11.3 delete-on-request, public lead form with Turnstile, PWA install (icons, service worker), Playwright, CI, deploy.

## 5. Open questions for the product owner
- AI: provider keys and confirmed model ids per provider; monthly budget per GA; which documents go into the first knowledge bases (product terms per product code, underwriting, services, objection handbook); whether managers may see their FCs' practice scores; cross-border transfer notice for PDP (pseudonymised data still leaves Vietnam).
- Ask Success/IT for `customer_phone` in the activity export (meetings only carry `customer_id`), and for a beneficiary client code (BEN role).
- Whether the "Hẹn liên hệ tiếp" auto task is the intended second trigger (the request was cut off after "or").
- Ask Success/IT for 04_Policy_Products in the export: without it coverage groups and gaps are unknown (the owner's data has none yet), and for insured persons in 02_Clients (today holders only).
- Product fit rules / triggers in 11_Products (all DRAFT): approval needed before the CRM suggests products.
- Policy statuses other than "Đang hiệu lực" (lapsed, matured, surrendered) are shown as Success writes them; "lapsed" is matched on "mất hiệu lực" and the client's lapsed count. Confirm the exact Success values.
- Brand tokens are taken from one Figma screen; buttons, form inputs and status colours were inferred.

## 6. Technical notes that bite
- D1 batch results are keyed by column name: never `db.batch()` a select with a join that has two same-named columns (use `Promise.all`).
- D1 rejects compound SELECTs with many terms: write one statement per column instead of long `UNION ALL` (see `changesSql`).
- Drizzle's `db.batch()` cannot take raw `sql`; use `sqlBatch()` in `src/db/client.ts`.
- `contains()` (search) must stay parenthesised, or an OR escapes the tenant filter (a test catches it).
- Multi-row inserts must stay under 100 bound parameters: use `chunks()` from `src/server/http.ts` (a 25-lead bulk assign once failed this way).
- Optional Zod text fields must keep `undefined` for "not sent" (`optionalText` in `src/shared/schemas.ts`).
- The Vite dep cache goes stale after installing packages while the dev server runs: restart it.
- `tsc -b --noEmit` (TypeScript 7) trusted a stale build-info cache and passed with errors present; `npm run typecheck` now runs each project without incremental build info. Use it, not `tsc -b`.
- `loadClient360()` in `routes/clients.ts` is shared by the client page and the AI context: change it once. It does not write the VIEW_CLIENT audit row (the route does; the AI writes AI_READ).
- FTS5 (`ai_chunks_fts`) is not in the Drizzle schema: it lives in migration 0007 with its triggers. Query it only through `searchKnowledge()`.
