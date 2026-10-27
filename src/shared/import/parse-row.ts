import { AGENT_RANKS, NO, YES } from "../enums";
import { looseForm, maskPhone, normalizeName, normalizePhone } from "../normalize";
import type { ColumnDef, KeyKind, SheetDef } from "./template";

/** A cell as read from the workbook. A number means Excel stored the cell as a number. */
export type Cell = string | number | null;

export type Issue = {
  column: string;
  code: string;
  severity: "error" | "warning";
  /** Values for the Vietnamese message (see vi.importErrors). */
  value?: string;
};

export type ParsedRow = {
  key: string;
  owner: string | null;
  data: Record<string, string | number | null>;
  issues: Issue[];
};

// Keys are text and keep leading zeros. A fixed length is the length in the template.
const KEYS: Record<KeyKind, { pattern: RegExp; length?: number }> = {
  client: { pattern: /^\d{10}$/, length: 10 },
  policy: { pattern: /^\d{9}$/, length: 9 },
  agent: { pattern: /^\d{1,20}$/ },
  application: { pattern: /^[A-Za-z0-9]{4,20}$/ },
  product: { pattern: /^[A-Za-z0-9_.-]{1,40}$/ },
};

const AGENT_REF = /^(\w+):\s*(\d+)-(.+)$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

function isoDate(d: number, m: number, y: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return real && y >= 1900 && y <= 2200 ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

/** dd/mm/yyyy -> YYYY-MM-DD, or null for a malformed or impossible date. */
export function parseDate(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? isoDate(+m[1]!, +m[2]!, +m[3]!) : null;
}

/** dd/mm/yyyy HH:MM[:SS] in Vietnam time (+07:00) -> UTC ISO. */
export function parseDateTime(s: string): string | null {
  const m = /^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  const day = m && parseDate(m[1]!);
  if (!m || !day) return null;
  const [h, min, sec] = [+(m[2] ?? 0), +(m[3] ?? 0), +(m[4] ?? 0)];
  if (h > 23 || min > 59 || sec > 59) return null;
  return new Date(`${day}T${pad2(h)}:${pad2(min)}:${pad2(sec)}+07:00`).toISOString();
}

/** ISO timestamp with an offset or Z, or dd/mm/yyyy hh:mm[:ss] in Vietnam time -> UTC ISO. */
export function parseTimestamp(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return parseDateTime(s);
}

/** Non-negative whole number. Accepts 13000000, "13000000", "13.000.000" and "13,000,000". */
function parseInteger(raw: Cell): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  const s = String(raw).replace(/\s/g, "");
  const digits = /^\d{1,3}([.,]\d{3})+$/.test(s) ? s.replace(/[.,]/g, "") : s;
  return /^\d{1,15}$/.test(digits) ? Number(digits) : null;
}

/** "100%", "100" or an Excel percent cell (1 = 100%) -> 0..100. */
function parsePercent(raw: Cell): number | null {
  const n = typeof raw === "number" ? (raw <= 1 ? raw * 100 : raw) : Number(String(raw).replace(/\s|%/g, "").replace(",", "."));
  const rounded = Math.round(n * 1e6) / 1e6;
  return Number.isInteger(rounded) && rounded >= 0 && rounded <= 100 ? rounded : null;
}

function parseKey(col: ColumnDef, kind: KeyKind, raw: Cell, issues: Issue[]): string | null {
  const { pattern, length } = KEYS[kind];
  let value = String(raw).trim();
  if (typeof raw === "number" && length && Number.isInteger(raw) && value.length < length) {
    // Excel turned the key into a number and dropped the leading zeros.
    value = value.padStart(length, "0");
    issues.push({ column: col.header, code: "padded_key", severity: "warning", value });
  }
  if (pattern.test(value)) return value;
  issues.push({ column: col.header, code: `invalid_key_${kind}`, severity: "error", value });
  return null;
}

/**
 * Validates one row of a sheet and maps it to target columns.
 * `cells` is aligned to `def.columns`; `present[i]` tells whether column i exists in the file.
 * Columns missing from the file are left out of `data`, so an import never wipes them.
 */
export function parseRow(def: SheetDef, present: readonly boolean[], cells: readonly Cell[]): ParsedRow {
  const data: ParsedRow["data"] = {};
  const issues: Issue[] = [];
  const fail = (col: ColumnDef, code: string, value?: string) => {
    issues.push({ column: col.header, code, severity: "error", value });
  };

  def.columns.forEach((col, i) => {
    if (!present[i]) return;
    const cell = cells[i] ?? null;
    const raw: Cell = typeof cell === "string" ? cell.normalize("NFC").trim() : cell;
    const type = col.type;

    if (raw === null || raw === "") {
      if (col.required && !col.blankOk) fail(col, "required");
      if (type.t === "agentRef") data[type.code] = data[type.name] = data[type.rank] = null;
      else data[col.db] = col.blankAs ?? null;
      if (col.norm) data[col.norm] = null;
      return;
    }
    const s = String(raw);

    switch (type.t) {
      case "text":
        if (s.length > (type.max ?? 500)) return fail(col, "too_long");
        data[col.db] = s;
        if (col.norm) data[col.norm] = normalizeName(s);
        return;
      case "key":
        data[col.db] = parseKey(col, type.kind, raw, issues);
        return;
      case "phone": {
        const phone = normalizePhone(raw);
        if (!phone) return fail(col, "invalid_phone", s);
        data[col.db] = phone;
        return;
      }
      case "code": {
        const form = looseForm(s);
        const code = Object.entries(type.values).find(([, labels]) => labels.some((l) => looseForm(l) === form))?.[0];
        if (!code) return fail(col, "invalid_list", s);
        data[col.db] = code;
        return;
      }
      case "agentRef": {
        const m = AGENT_REF.exec(s);
        const rank = m?.[1]?.toUpperCase();
        if (!m || !(AGENT_RANKS as readonly string[]).includes(rank!)) return fail(col, "invalid_agent_ref", s);
        data[type.code] = m[2]!;
        data[type.name] = m[3]!.trim();
        data[type.rank] = rank!;
        return;
      }
      case "date": {
        const iso = typeof raw === "string" ? parseDate(s) : null;
        if (!iso) return fail(col, "invalid_date", s);
        data[col.db] = iso;
        return;
      }
      case "datetime": {
        const iso = typeof raw === "string" ? parseDateTime(s) : null;
        if (!iso) return fail(col, "invalid_datetime", s);
        data[col.db] = iso;
        return;
      }
      case "timestamp": {
        const iso = typeof raw === "string" ? parseTimestamp(s) : null;
        if (!iso) return fail(col, "invalid_datetime", s);
        data[col.db] = iso;
        return;
      }
      case "dayMonth": {
        const m = /^(\d{2})\/(\d{2})$/.exec(s);
        // 2000 is a leap year, so 29/02 is accepted.
        if (!m || !isoDate(+m[1]!, +m[2]!, 2000)) return fail(col, "invalid_day_month", s);
        data[col.db] = s;
        return;
      }
      case "int": {
        const n = parseInteger(raw);
        if (n === null) return fail(col, "invalid_number", s);
        data[col.db] = n;
        return;
      }
      case "percent": {
        const n = parsePercent(raw);
        if (n === null) return fail(col, "invalid_percent", s);
        data[col.db] = n;
        return;
      }
      case "list": {
        const match = type.values.find((v) => v.toLowerCase() === s.toLowerCase());
        if (!match) return fail(col, "invalid_list", s);
        data[col.db] = match;
        return;
      }
      case "yesNo": {
        const lower = s.toLowerCase();
        if (lower !== YES.toLowerCase() && lower !== NO.toLowerCase()) return fail(col, "invalid_yes_no", s);
        data[col.db] = lower === YES.toLowerCase() ? 1 : 0;
        return;
      }
    }
  });

  if (def.name === "07_Activities") {
    // The day in Vietnam, and a masked phone to match the same contact in the CRM.
    const started = typeof data.started_at === "string" ? data.started_at : null;
    data.activity_date = started ? new Date(Date.parse(started) + 7 * 3600_000).toISOString().slice(0, 10) : null;
    data.phone_key = maskPhone(data.customer_phone ?? null) ?? maskPhone((data.call_phone_hash as string | null) ?? null) ?? maskPhone((data.customer_id as string | null) ?? null);
  }
  if (def.name === "01_Agents" && data.manager_code && data.manager_code === data.agent_code) {
    issues.push({ column: "Quản lý", code: "self_manager", severity: "error" });
  }
  return {
    key: (def.rowKey ?? def.key).map((k) => data[k] ?? "").join("|"),
    owner: def.owner ? ((data[def.owner] as string | null | undefined) ?? null) : null,
    data,
    issues,
  };
}

/**
 * The record key as written in the file, even when it is invalid, so the uploader
 * knows which records to fix and import again.
 */
export function rawRecordKey(def: SheetDef, present: readonly boolean[], cells: readonly Cell[]): string | null {
  const parts = (def.rowKey ?? def.key).map((k) => {
    const i = def.columns.findIndex((c) => c.db === k || (c.type.t === "agentRef" && c.type.code === k));
    if (i < 0 || !present[i]) return "";
    const raw = cells[i];
    const s = raw === null || raw === undefined ? "" : String(raw).trim();
    return def.columns[i]!.type.t === "agentRef" ? (AGENT_REF.exec(s)?.[2] ?? s) : s;
  });
  return parts.some((p) => p !== "") ? parts.join("|").replace(/\|+$/, "") : null;
}
