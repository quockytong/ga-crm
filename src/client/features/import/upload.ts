import { api, type Import, type ImportError, type Rejected } from "@/client/lib/api";
import { importReasons, vi } from "@/i18n/vi";
import type { Workbook } from "@/shared/import/workbook";
import { IMPORT_CHUNK_ROWS } from "@/shared/schemas";

export class WorkbookError extends Error {}

/**
 * Reads the workbook in the browser, sends the template columns in chunks and
 * asks the server to validate. Nothing is written to the Success tables yet.
 */
export async function checkWorkbook(file: File, snapshotDate: string, onProgress: (text: string) => void): Promise<Import> {
  onProgress(vi.imports.progress.reading);
  const buffer = await file.arrayBuffer();
  // SheetJS is large; load it only when a file is actually checked.
  const { readWorkbook } = await import("@/shared/import/workbook");
  let wb: ReturnType<typeof readWorkbook>;
  try {
    wb = readWorkbook(buffer);
  } catch {
    throw new WorkbookError(vi.imports.notWorkbook);
  }
  if (wb.sheets.length === 0) throw new WorkbookError(vi.imports.noSheets);
  return submitWorkbook(wb, file.name, buffer, snapshotDate, onProgress, wb.sheets.some((s) => s.plan.banned.length > 0));
}

/** Sends a workbook read in the browser and asks the server to validate it. */
export async function submitWorkbook(
  wb: Workbook,
  fileName: string,
  buffer: ArrayBuffer,
  snapshotDate: string,
  onProgress: (text: string) => void,
  hasBannedColumns: boolean,
): Promise<Import> {
  const imp = await api<Import>("/api/imports", {
    json: {
      fileName,
      snapshotDate,
      sheets: [...wb.sheets.map((s) => ({ name: s.name, headers: s.headers })), ...wb.later.map((name) => ({ name, headers: [] }))],
    },
  });

  for (const sheet of wb.sheets) {
    if (imp.sheets[sheet.name]?.status !== "READY") continue;
    for (let i = 0; i < sheet.rows.length; i += IMPORT_CHUNK_ROWS) {
      onProgress(vi.imports.progress.sending(sheet.name, i, sheet.rows.length));
      await api(`/api/imports/${imp.id}/rows`, { json: { sheet: sheet.name, rows: sheet.rows.slice(i, i + IMPORT_CHUNK_ROWS) } });
    }
  }

  // Keep the original for 90 days, unless it holds columns that must not be stored.
  if (!hasBannedColumns) {
    await fetch(`/api/imports/${imp.id}/file`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/octet-stream" },
      body: buffer,
    }).catch(() => undefined);
  }

  onProgress(vi.imports.progress.validating);
  return api<Import>(`/api/imports/${imp.id}/validate`, { method: "POST" });
}

async function allPages<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const res = await api<{ items: T[]; total: number }>(`${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=500`);
    rows.push(...res.items);
    if (rows.length >= res.total || res.items.length === 0) return rows;
  }
}

/**
 * F2.4: the error report as an Excel file. First sheet: the records to fix and import
 * again, one line each; second sheet: every error and warning.
 */
export async function downloadErrorReport(imp: Pick<Import, "id" | "fileName">) {
  const [rows, rejected] = await Promise.all([
    allPages<ImportError>(`/api/imports/${imp.id}/errors`),
    allPages<Rejected["items"][number]>(`/api/imports/${imp.id}/rejected`),
  ]);
  const XLSX = await import("xlsx");
  const t = vi.imports.report;
  const again = XLSX.utils.json_to_sheet(
    rejected.map((r) => ({
      [t.sheet]: r.sheet,
      [t.row]: r.row,
      [t.key]: r.recordKey ?? "",
      [t.reasons]: r.codes.map((c) => importReasons[c] ?? c).join("; "),
    })),
  );
  again["!cols"] = [{ wch: 20 }, { wch: 8 }, { wch: 24 }, { wch: 70 }];
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((e) => ({
      [t.sheet]: e.sheet,
      [t.row]: e.row,
      [t.key]: e.recordKey ?? "",
      [t.column]: e.column ?? "",
      [t.severity]: vi.imports.severity[e.severity],
      [t.code]: e.code,
      [t.message]: e.message,
    })),
  );
  sheet["!cols"] = [{ wch: 20 }, { wch: 8 }, { wch: 24 }, { wch: 30 }, { wch: 10 }, { wch: 24 }, { wch: 90 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, again, t.reimportSheet);
  XLSX.utils.book_append_sheet(book, sheet, t.errorsSheet);
  XLSX.writeFile(book, `bao-cao-loi-${imp.fileName.replace(/\.[^.]+$/, "")}.xlsx`);
}

export const todayInVietnam = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

export function totals(imp: Import) {
  const ready = Object.values(imp.sheets).filter((s) => s.status === "READY");
  const sum = (key: "inserted" | "updated" | "rejected" | "warnings") => ready.reduce((n, s) => n + s[key], 0);
  return { inserted: sum("inserted"), updated: sum("updated"), rejected: sum("rejected"), warnings: sum("warnings") };
}
