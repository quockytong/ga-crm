import { readFile } from "node:fs/promises";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.resolve(import.meta.dirname, "src/db/migrations"),
  );
  const sample = (
    await readFile(path.resolve(import.meta.dirname, "samples/DLVN_BDM_CRM_Import_Template_v1.1.xlsx"))
  ).toString("base64");
  return {
    plugins: [
      cloudflareTest({
        // Tests call the Hono app directly, so only bindings are configured here.
        miniflare: {
          compatibilityDate: "2026-06-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["UPLOADS"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            SAMPLE_XLSX_BASE64: sample,
            APP_URL: "http://localhost",
            BETTER_AUTH_SECRET: "test-only-secret-not-used-anywhere-else",
            // AI calls go to a fake provider (setAiFetch); only Gemini and Qwen "have" a key.
            GEMINI_API_KEY: "test-key",
            QWEN_API_KEY: "test-key",
          },
        },
      }),
    ],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "src") },
    },
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
