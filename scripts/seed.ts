// Seeds the LOCAL D1 database (the same one `npm run dev` uses).
// Run `npm run db:migrate` first.
import { hashPassword } from "better-auth/crypto";
import { count } from "drizzle-orm";
import { getPlatformProxy } from "wrangler";
import { createDb } from "../src/db/client";
import { tenants } from "../src/db/schema";
import { DEV_PASSWORD, seed } from "../src/db/seed";

const proxy = await getPlatformProxy<Env>();
try {
  const db = createDb(proxy.env.DB);
  const existing = await db.select({ n: count() }).from(tenants).get();
  if (existing?.n) {
    console.log("Database already has tenants; nothing seeded. Delete .wrangler/state to start over.");
  } else {
    const result = await seed(db, await hashPassword(DEV_PASSWORD));
    console.log("Seeded", result);
    console.log("Sign in as e.g. head@ga1.test, um1@ga1.test, fc1@ga1.test, platform@dlvn.test.");
    console.log("The shared dev password is DEV_PASSWORD in src/db/seed.ts.");
  }
} finally {
  await proxy.dispose();
}
