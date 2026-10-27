import { vi } from "@/i18n/vi";
import { SUCCESS_TEMPLATE_SHEETS, templateBytes } from "@/shared/import/template-file";
import type { SheetName } from "@/shared/import/template";

async function download(title: string, sheets: SheetName[], fileName: string) {
  const bytes = await templateBytes(title, sheets);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  a.click();
  URL.revokeObjectURL(url);
}

/** Success data: sheets 01-05 as the Import screen reads them. */
export const downloadSuccessTemplate = () => download(vi.imports.title, SUCCESS_TEMPLATE_SHEETS, "GA_CRM_Mau_nhap_du_lieu_Success.xlsx");

/** Leads: the 13_Leads sheet as the lead import maps it. */
export const downloadLeadTemplate = () => download(vi.leads.importTitle, ["13_Leads"], "GA_CRM_Mau_nhap_lead.xlsx");
