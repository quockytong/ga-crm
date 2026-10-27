import { applyD1Migrations, env } from "cloudflare:test";

// Storage is isolated per test file; each file starts from an empty, migrated database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
