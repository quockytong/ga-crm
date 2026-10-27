declare namespace Cloudflare {
  interface Env {
    SAMPLE_XLSX_BASE64: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
