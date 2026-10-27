/**
 * PDP (product owner, Oct 2026): AI providers never see who a person is. Names become
 * tokens such as [K1] (client), [L1] (lead), [N1] (relative), [A1] (agent); phones,
 * emails and ID-like numbers are removed; client codes and lead ids stay in the CRM.
 * The map is kept per conversation, so tokens stay stable across turns, and the
 * browser shows the real names in place of the tokens.
 */

export type PseudonymMap = Record<string, { type: string; ref: string; name: string }>;

const PREFIX: Record<string, string> = { client: "K", lead: "L", relative: "N", agent: "A", policy: "P" };

const PHONE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LONG_NUMBER = /\b\d{9,}\b/g;
// A sentence (or line) about the person's health: illness, treatment, hospital, medicine...
// Product words ("bảo hiểm sức khỏe", "bệnh hiểm nghèo") are not health data.
const HEALTH_SENTENCE =
  /[^.!?\n]*(?<!\p{L})(?:bệnh(?! hiểm nghèo)|ốm|(?<!(?:bảo hiểm|thẻ|gói) )sức kho[ẻẻ]|ung thư|tiểu đường|huyết áp|tim mạch|phẫu thuật|mổ|nằm viện|nhập viện|điều trị|thuốc|khối u|xét nghiệm|mang bầu|có bầu)(?!\p{L})[^.!?\n]*[.!?]?/giu;

export class Pseudonymizer {
  constructor(readonly map: PseudonymMap) {}

  /** Token for a person; the same person keeps the same token. */
  token(type: keyof typeof PREFIX, ref: string, name: string | null | undefined): string {
    const found = Object.entries(this.map).find(([, v]) => v.type === type && v.ref === ref);
    if (found) return `[${found[0]}]`;
    const prefix = PREFIX[type]!;
    let n = 1;
    while (this.map[`${prefix}${n}`]) n++;
    const key = `${prefix}${n}`;
    this.map[key] = { type, ref, name: (name ?? "").trim() || key };
    return `[${key}]`;
  }

  /** Ref behind a token ("K1" or "[K1]"), if it is of the given type. */
  resolve(token: string, type: string): string | null {
    const entry = this.map[token.replace(/[[\]\s]/g, "").toUpperCase()];
    return entry && entry.type === type ? entry.ref : null;
  }

  /**
   * Free text: known names and policy numbers become tokens, contact details go. CRM notes
   * (`fromCrm`) also lose sentences about health, which the FC may have written down.
   */
  scrub(text: string | null | undefined, fromCrm = false): string {
    if (!text) return "";
    let out = text;
    // Policy numbers first: they are long digit runs that LONG_NUMBER would erase.
    for (const [key, v] of Object.entries(this.map)) if (v.type === "policy" && v.ref.length >= 6) out = out.split(v.ref).join(`[${key}]`);
    out = out.replace(EMAIL, "[email]").replace(PHONE, "[sđt]").replace(LONG_NUMBER, "[số]");
    if (fromCrm) out = out.replace(HEALTH_SENTENCE, "[thông tin sức khỏe đã ẩn]");
    // Longest names first, so "Nguyễn Văn An" wins over "An".
    const names = Object.entries(this.map)
      .flatMap(([key, v]) => {
        const parts = v.name.split(/\s+/).filter(Boolean);
        // Full name, and the given name with the last two words (how Vietnamese address people).
        const variants = [v.name, parts.length >= 3 ? parts.slice(-2).join(" ") : null].filter((x): x is string => !!x && x.length >= 4);
        return variants.map((name) => ({ key, name }));
      })
      .sort((a, b) => b.name.length - a.name.length);
    for (const { key, name } of names) {
      const pattern = new RegExp(`(^|[^\\p{L}])${escapeRegExp(name)}(?=$|[^\\p{L}])`, "giu");
      out = out.replace(pattern, (_m, pre: string) => `${pre}[${key}]`);
    }
    return out;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names as the browser shows them in place of the tokens. */
export const displayNames = (map: PseudonymMap) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.name]));
