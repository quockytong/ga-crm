import * as XLSX from "xlsx";
import { normalizeName } from "../normalize";
import type { Cell } from "./parse-row";
import { isBannedHeader, LEAD_HEADER_ALIASES, planSheet, SHEETS } from "./template";
import type { WorkbookSheet } from "./workbook";

// Reads a GA's own lead sheet (e.g. "Chia Lead") in the browser and maps it onto 13_Leads.

const def = SHEETS["13_Leads"];
const form = (h: string) => h.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
const pad2 = (n: number) => String(n).padStart(2, "0");

export type SourceSheet = {
  name: string;
  /** Excel row number of the header row. */
  headerRow: number;
  headers: string[];
  rows: { r: number; c: Cell[] }[];
};

export function openWorkbook(file: ArrayBuffer) {
  return XLSX.read(file, { type: "array", cellNF: true, cellText: false });
}

/** Visible sheets of the workbook. */
export const sheetNames = (wb: XLSX.WorkBook) =>
  wb.SheetNames.filter((_, i) => !wb.Workbook?.Sheets?.[i]?.Hidden);

function cellValue(cell: XLSX.CellObject | undefined): Cell {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (cell.t === "n") {
    if (cell.z && XLSX.SSF.is_date(String(cell.z))) {
      const d = XLSX.SSF.parse_date_code(cell.v as number);
      return `${pad2(d.d)}/${pad2(d.m)}/${d.y}`;
    }
    return cell.v as number;
  }
  return cell.t === "e" ? null : String(cell.v);
}

const knownHeaders = new Set([...def.columns.map((c) => form(c.header)), ...Object.values(LEAD_HEADER_ALIASES).flat().map(form)]);

/** Reads one sheet. The header row is the row (among the first 10) that looks most like lead headers. */
export function readSheet(wb: XLSX.WorkBook, name: string): SourceSheet {
  const ws = wb.Sheets[name];
  if (!ws?.["!ref"]) return { name, headerRow: 1, headers: [], rows: [] };
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const at = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  const width = range.e.c - range.s.c + 1;
  const textRow = (r: number) => Array.from({ length: width }, (_, i) => String(at(r, range.s.c + i)?.v ?? "").trim());

  let header = range.s.r;
  let best = -1;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 9); r++) {
    const score = textRow(r).filter((h) => knownHeaders.has(form(h))).length;
    if (score > best) [best, header] = [score, r];
  }
  const headers = textRow(header);
  const rows: SourceSheet["rows"] = [];
  for (let r = header + 1; r <= range.e.r; r++) {
    const c = headers.map((_, i) => cellValue(at(r, range.s.c + i)));
    if (c.some((v) => v !== null && String(v).trim() !== "")) rows.push({ r: r + 1, c });
  }
  return { name, headerRow: header + 1, headers, rows };
}

/** Column of the source sheet for each 13_Leads field (-1 = not mapped), by header names. */
export function autoMap(headers: readonly string[]): Record<string, number> {
  const forms = headers.map(form);
  return Object.fromEntries(
    def.columns.map((c) => {
      const names = [c.header, ...(LEAD_HEADER_ALIASES[c.db] ?? [])].map(form);
      return [c.db, forms.findIndex((h) => names.includes(h))];
    }),
  );
}

/** Headers of the source sheet that must never be read (PDP). Health notes are allowed in lead files. */
export const bannedColumns = (headers: readonly string[]) => headers.filter((h) => isBannedHeader(h, { allowHealth: true }));

type Agent = { agentCode: string; name: string };
const TITLES = /^(fc|um|bm|sum|gad|tvv|chị|chi|anh|em|c\.|a\.)\s+/i;

/**
 * Agent for a value written in the agent column: a code, a full name, or the short
 * name GAs use ("Minh", "FC Trang", "Chị Yến") when exactly one agent's name ends with it.
 */
export function matchAgent(value: string, agents: readonly Agent[]): string | null {
  const v = value.trim();
  if (/^\d+$/.test(v)) return agents.find((a) => a.agentCode === v)?.agentCode ?? null;
  let name = normalizeName(v);
  while (TITLES.test(name)) name = name.replace(TITLES, "");
  const exact = agents.filter((a) => normalizeName(a.name) === name);
  if (exact.length === 1) return exact[0]!.agentCode;
  const ending = agents.filter((a) => normalizeName(a.name).endsWith(` ${name}`));
  return ending.length === 1 ? ending[0]!.agentCode : null;
}

/** Distinct non-empty values of a column. */
export function distinctValues(sheet: SourceSheet, column: number): string[] {
  if (column < 0) return [];
  return [...new Set(sheet.rows.map((r) => String(r.c[column] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi"));
}

/** The source sheet as a 13_Leads sheet, with agent values replaced by agent codes (unmapped = unassigned). */
export function toLeadsSheet(sheet: SourceSheet, mapping: Record<string, number>, agentCodes: Record<string, string | null>): WorkbookSheet {
  const headers = def.columns.map((c) => ((mapping[c.db] ?? -1) >= 0 ? c.header : ""));
  const plan = planSheet(def, headers);
  const rows = sheet.rows.map((row) => ({
    r: row.r,
    c: def.columns.map((col): Cell => {
      const i = mapping[col.db] ?? -1;
      if (i < 0) return null;
      const v = row.c[i] ?? null;
      if (col.db !== "assigned_agent_code" || v === null) return v;
      return agentCodes[String(v).trim()] ?? null;
    }),
  }));
  return { name: "13_Leads", headers, plan, rows };
}
