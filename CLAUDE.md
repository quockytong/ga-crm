# GA CRM (PoC) - Project Rules for Claude Code

## 1. What this is
A multi-tenant CRM for Dai-ichi Life Vietnam (DLVN) General Agencies (GA). It extends the BDM CRM PoC, organized by GA tenant.

- **Owner:** DLVN Innovation team, piloting with 3 GAs. Built to onboard more GAs later.
- **Problem:** GA leads, campaigns, seminars and telesales live in Excel / Google Sheets. Leads are never linked to the DLVN clients and policies they become, so attribution and cross-sell are impossible.
- **Solution:** GA-side lead and pipeline CRM + import of each FC's own Dai-ichi Success exports (Excel, template v1.1) + manual lead-to-client linking by Client ID (Mã Khách Hàng).
- **Launch:** end of October 2026. One shared PoC instance.

Read `docs/HANDOFF.md` first (current state, product-owner decisions, open items), then `docs/SPEC-phase1.md` before building a feature and `docs/DATA-MODEL.md` before touching the schema.

## 2. Non-negotiable rules
1. **Tenant isolation.** Every business table has `tenant_id`. Every query goes through the scope layer (`src/server/scope.ts`). Never write a raw query on a business table that skips it. A test must prove user A of GA-1 cannot read GA-2 data.
2. **Hierarchy scope.** FC sees own data. UM, BM, GAD see own data plus their downline. GA Head sees the whole tenant. Scope is computed from the agent tree, never from client input.
3. **Marketing masking.** Marketing can read Success data (clients, policies, applications) only through masked views: no names, no client code in clear, no birthday, only `age_band`, gender, product, premium, status, dates. Leads and campaigns are visible to Marketing in full (Marketing owns them).
4. **Audit log.** Write an `audit_log` row for: login, create / update / delete of business records, lead assignment, lead-to-client link and unlink, import, export, and opening a client detail page.
5. **No secrets or Success credentials** in the app. Success data enters only through manual Excel upload by the FC.
6. **PDP data rules.** Never store ID card numbers, bank details or health data. Reject such columns on import if they appear. Exception (product owner, Oct 2026): health details that FCs note about a lead (progress notes, lead files) are stored as written, per lead.
7. **Keys are text.** Client code, policy number, application number and agent code keep leading zeros. Never cast to number.
8. **UI is Vietnamese only.** All user-facing strings live in `src/i18n/vi.ts`. Code, comments, docs and commit messages are in English.

## 3. Stack (all Cloudflare)
| Layer | Choice | Note |
|---|---|---|
| Runtime | Cloudflare Workers | One Worker serves API and static assets |
| API | Hono (TypeScript) | Routes in `src/server/routes/` |
| Frontend | React + Vite + TanStack Router + TanStack Query | Mobile-first, installable PWA |
| UI kit | Tailwind CSS + shadcn/ui | DLVN brand colors as tokens |
| Database | Cloudflare D1 (SQLite), location hint APAC | Drizzle ORM + drizzle-kit migrations |
| Files | Cloudflare R2 | Keep original uploaded workbooks, 90-day retention |
| Auth | Better Auth (email + password, admin invite) | Sessions in D1 |
| Excel parsing | SheetJS in the browser | Parse client-side, send validated JSON in chunks. Install from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (npm registry version is outdated) |
| Validation | Zod, shared between client and server | |
| Tests | Vitest + Miniflare (D1 local), Playwright for key flows | |

**D1 limits to respect:** max 100 bound parameters per statement, so batch inserts in chunks (about 50 rows x 2 columns or fewer columns per row). Use `db.batch()` for transactions. Keep Worker CPU low; heavy parsing stays in the browser.

## 4. Roles
| Role | Is an agent? | Scope |
|---|---|---|
| FC | Yes | Own leads, clients, policies, applications, activities |
| UM | Yes (also FC) | Own + direct and indirect downline |
| BM | Yes (also FC) | Own + all UMs and FCs below |
| GAD | Yes (may also be BM) | Own + downline |
| GA Head | Usually yes | Entire tenant, full power incl. user admin |
| Marketing | No | Leads + campaigns full; Success data masked; assigns leads |
| Admin | No | Users, config, imports monitor; no lead content edits |
| Platform Admin (DLVN Innovation) | No | Cross-tenant: create tenants, support. Every cross-tenant read is audited |

A user can hold more than one role (e.g. GAD + BM). Permissions are the union. The functions above are the defaults: each GA Head can change them per role on the Phân quyền screen (RBAC, `src/shared/permissions.ts`); data scope always follows the agent tree.

## 5. Folder layout
```
src/
  client/            React app (routes/, components/, features/<feature>/)
  server/
    routes/          Hono routers per feature
    scope.ts         tenant + hierarchy scope helpers (the only door to data)
    mask.ts          masking for Marketing views
    audit.ts         audit log writer
    import/          sheet parsers, validators, upsert logic per sheet
  db/
    schema.ts        Drizzle schema
    migrations/
  shared/            Zod schemas, enums, Vietnamese labels
  i18n/vi.ts
samples/             DLVN_BDM_CRM_Import_Template_v1.1.xlsx + masked test files
docs/                SPEC-phase1.md, DATA-MODEL.md
```

## 6. Conventions
- Dates from Success are `dd/mm/yyyy`; timestamps are ISO with `+07:00`. Store dates as ISO `YYYY-MM-DD` text and timestamps as UTC ISO; display in Asia/Ho_Chi_Minh.
- Money in VND as integer.
- Vietnamese name matching uses a normalized form: remove diacritics, map đ to d, uppercase, collapse spaces.
- Every list endpoint is paginated and filtered server-side by scope.
- IDs: `crypto.randomUUID()` for CRM-owned records; natural keys from Success are stored as-is with a unique index per tenant.

## 7. Working style for Claude Code
- Build in vertical slices (schema, API, UI, test) per spec item. Do not start a new slice with failing tests.
- Before a schema change, update `docs/DATA-MODEL.md` in the same commit.
- Seed script `npm run seed` creates 2 tenants, a full hierarchy (GAD > BM > UM > FC), Marketing and Admin users, and loads `samples/` so access and masking can be tested.
- Commands: `npm run dev` (Vite with the Cloudflare plugin, http://localhost:5173), `npm test`, `npm run db:migrate`, `npm run seed`, `npm run deploy`.
- Ask the product owner (John) when a business rule is unclear. Do not invent insurance rules.
