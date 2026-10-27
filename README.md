# GA CRM

Multi-tenant CRM for DLVN General Agencies. Rules and stack: [CLAUDE.md](CLAUDE.md). Spec: [docs/SPEC-phase1.md](docs/SPEC-phase1.md). Schema: [docs/DATA-MODEL.md](docs/DATA-MODEL.md).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
npm run db:migrate               # local D1
npm run seed                     # 2 demo tenants with a full hierarchy
npm run dev                      # http://localhost:5173
npm test
```

Seeded sign-ins are listed in `src/db/seed.ts` (e.g. `head@ga1.test`, `um1@ga1.test`, `platform@dlvn.test`), all with `DEV_PASSWORD` from the same file.

## First deploy

1. `wrangler d1 create ga-crm --location apac` and paste the id into `wrangler.jsonc`.
2. `wrangler r2 bucket create ga-crm-uploads`, then add the 90-day retention rule:
   `wrangler r2 bucket lifecycle add ga-crm-uploads --expire-days 90`
3. Set `APP_URL` in `wrangler.jsonc` to the public origin.
4. `wrangler secret put BETTER_AUTH_SECRET`, and for the AI assistants the keys of the providers the GAs may use:
   `wrangler secret put GEMINI_API_KEY` (and `DEEPSEEK_API_KEY`, `QWEN_API_KEY`) as platform-wide fallbacks (GA Heads can also enter their own keys in the app),
   and `wrangler secret put AI_KEYS_SECRET` (openssl rand -base64 32) to encrypt the keys GAs enter. See `docs/SPEC-ai.md`.
5. `npm run db:migrate:remote`, then `npm run deploy`.
