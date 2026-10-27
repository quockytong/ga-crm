import { normalizeName } from "./normalize";

// Coverage groups shown on the client page. A product's group comes from its 11_Products
// category, or its name when the catalog does not have it. Matching is on the normalized
// form (no diacritics, upper case), English or Vietnamese.

export const COVERAGE_GROUPS = ["LIFE", "HEALTH", "CI", "ACCIDENT", "MATERNITY", "OTHER"] as const;
export type CoverageGroup = (typeof COVERAGE_GROUPS)[number];

/** Groups whose absence is shown as a gap for a person who already has product details. */
export const GAP_GROUPS = ["HEALTH", "CI", "ACCIDENT"] as const satisfies readonly CoverageGroup[];

const KEYWORDS: [CoverageGroup, string[]][] = [
  ["MATERNITY", ["THAI SAN", "MATERNITY"]],
  ["CI", ["UNG THU", "CANCER", "HIEM NGHEO", "CRITICAL"]],
  ["ACCIDENT", ["TAI NAN", "ACCIDENT"]],
  ["HEALTH", ["SUC KHOE", "HEALTH", "Y TE", "NOI TRU", "HOSPITAL", "MEDICAL", "VIEN PHI"]],
  ["LIFE", ["LIFE", "NHAN THO", "TU KY", "LIEN KET", "TRON DOI", "HUU TRI", "UNIVERSAL", "UNIT-LINKED", "ENDOWMENT"]],
];

export function coverageGroup(p: { category?: string | null; name?: string | null; role?: string | null }): CoverageGroup {
  for (const text of [p.category, p.name]) {
    if (!text) continue;
    const norm = normalizeName(text);
    for (const [group, words] of KEYWORDS) if (words.some((w) => norm.includes(w))) return group;
  }
  // Every main product of a life insurer carries the death benefit.
  return p.role === "Chính" ? "LIFE" : "OTHER";
}

/** Status of a policy (or product) in force, as Success writes it. */
export const ACTIVE_STATUS = "Đang hiệu lực";

/** Today in Vietnam (YYYY-MM-DD). */
export function vnToday(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

/** Days ahead for the "premium due" and "maturity" signals. */
export const PREMIUM_DUE_DAYS = 30;
export const MATURITY_DAYS = 365;
