import * as XLSX from "xlsx";
import type { Cell } from "./parse-row";
import { isSheetName, LATER_SHEETS, planSheet, SHEETS, type SheetName, type SheetPlan } from "./template";

export type WorkbookSheet = {
  name: SheetName;
  /** Every header found in row 1, as written. */
  headers: string[];
  plan: SheetPlan;
  /** Data rows, cells aligned to the template columns. `r` is the Excel row number. */
  rows: { r: number; c: Cell[] }[];
};

export type Workbook = {
  sheets: WorkbookSheet[];
  /** Template sheets that are present but not imported yet. */
  later: string[];
};

const pad2 = (n: number) => String(n).padStart(2, "0");

function cellValue(cell: XLSX.CellObject | undefined): Cell {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (cell.t === "s") return String(cell.v);
  if (cell.t === "n") {
    const n = cell.v as number;
    // A date-formatted cell: write it the way the template expects, free of time zones.
    if (cell.z && XLSX.SSF.is_date(String(cell.z))) {
      const d = XLSX.SSF.parse_date_code(n);
      const day = `${pad2(d.d)}/${pad2(d.m)}/${d.y}`;
      return d.H || d.M || d.S ? `${day} ${pad2(d.H)}:${pad2(d.M)}:${pad2(Math.floor(d.S))}` : day;
    }
    return n;
  }
  if (cell.t === "b") return String(cell.v);
  return null;
}

/**
 * Reads the template sheets of an uploaded workbook. Runs in the browser.
 * Only template columns are read: anything else, including PDP-banned columns, stays in the file.
 */
export function readWorkbook(file: ArrayBuffer): Workbook {
  const wb = XLSX.read(file, { type: "array", cellNF: true, cellText: false });
  const sheets: WorkbookSheet[] = [];
  const later: string[] = [];

  for (const rawName of wb.SheetNames) {
    const name = rawName.trim();
    if ((LATER_SHEETS as readonly string[]).includes(name)) later.push(name);
    const ws = wb.Sheets[rawName];
    if (!isSheetName(name) || !ws?.["!ref"]) continue;

    const range = XLSX.utils.decode_range(ws["!ref"]);
    const at = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    const headers: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) headers.push(String(at(range.s.r, c)?.v ?? ""));
    const plan = planSheet(SHEETS[name], headers);

    const rows: WorkbookSheet["rows"] = [];
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const cells = plan.positions.map((p) => (p < 0 ? null : cellValue(at(r, range.s.c + p))));
      if (cells.some((v) => v !== null && String(v).trim() !== "")) rows.push({ r: r + 1, c: cells });
    }
    sheets.push({ name, headers, plan, rows });
  }
  return { sheets, later };
}
