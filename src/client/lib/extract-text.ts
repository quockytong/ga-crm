/**
 * Plain text of a knowledge document, read in the browser (CLAUDE.md: heavy parsing stays
 * client-side). PDF via pdf.js, DOCX by unzipping word/document.xml; TXT and MD as they are.
 * Loaded on demand from the AI settings page only.
 */
export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return pdfText(file);
  if (name.endsWith(".docx")) return docxText(file);
  return file.text();
}

async function pdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push(lines.join("\n"));
  }
  return pages.join("\n\n");
}

async function docxText(file: File): Promise<string> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) return "";
  const doc = new DOMParser().parseFromString(strFromU8(xml), "application/xml");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return [...doc.getElementsByTagNameNS(W, "p")]
    .map((p) => {
      const heading = p.getElementsByTagNameNS(W, "pStyle")[0]?.getAttributeNS(W, "val")?.toLowerCase().startsWith("heading");
      const text = [...p.getElementsByTagNameNS(W, "t")].map((t) => t.textContent ?? "").join("");
      return heading && text ? `# ${text}` : text;
    })
    .join("\n");
}
