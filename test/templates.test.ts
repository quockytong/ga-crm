import { expect, it } from "vitest";
import { SUCCESS_TEMPLATE_SHEETS, templateBytes } from "../src/shared/import/template-file";
import { autoMap, openWorkbook, readSheet } from "../src/shared/import/lead-sheet";
import { SHEETS } from "../src/shared/import/template";
import { readWorkbook } from "../src/shared/import/workbook";

// The downloadable templates must map column for column on import.

it("the Success template is read back with every column found and no data rows", async () => {
  const wb = readWorkbook(await templateBytes("Mẫu", SUCCESS_TEMPLATE_SHEETS));
  expect(wb.sheets.map((s) => s.name)).toEqual(SUCCESS_TEMPLATE_SHEETS);
  for (const s of wb.sheets) {
    expect(s.plan.positions.every((p) => p >= 0), s.name).toBe(true);
    expect(s.plan.missingRequired, s.name).toEqual([]);
    expect(s.plan.banned, s.name).toEqual([]);
    // Pre-formatted empty Text cells are not data.
    expect(s.rows, s.name).toEqual([]);
  }
});

it("the lead template maps every field automatically", async () => {
  const book = openWorkbook(await templateBytes("Mẫu", ["13_Leads"]));
  const sheet = readSheet(book, "13_Leads");
  expect(sheet.headerRow).toBe(1);
  const mapping = autoMap(sheet.headers);
  for (const c of SHEETS["13_Leads"].columns) expect(mapping[c.db], c.header).toBeGreaterThanOrEqual(0);
  expect(sheet.rows).toEqual([]);
});

it("key and phone columns are formatted as Text so leading zeros survive", async () => {
  const XLSX = await import("xlsx");
  const book = XLSX.read(await templateBytes("Mẫu", ["02_Clients", "13_Leads"]), { type: "array", cellNF: true });
  expect(book.Sheets["02_Clients"]!.A2).toMatchObject({ t: "s", z: "@" });
  const leads = book.Sheets["13_Leads"]!;
  const phoneCol = SHEETS["13_Leads"].columns.findIndex((c) => c.db === "phone");
  expect(leads[XLSX.utils.encode_cell({ r: 1, c: phoneCol })]).toMatchObject({ z: "@" });
});
