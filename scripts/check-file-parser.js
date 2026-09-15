const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const XLSX = require("xlsx");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { parseUploadedFile, parseFiles } = require("../src/lib/fileParser");

async function writeDocx(filePath) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX 제목</w:t></w:r></w:p><w:p><w:r><w:t>DOCX 본문 숫자 123</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>값</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>날짜</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026-09-09</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writePptx(filePath) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
  zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"x\" xmlns:a=\"y\"><a:t>PPTX 제목</a:t><a:t>슬라이드 본문 456</a:t></p:sld>");
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writePdf(filePath) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("PDF source text 789", { x: 40, y: 220, size: 18, font, color: rgb(0, 0, 0) });
  fs.writeFileSync(filePath, await pdf.save());
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blogauto-parser-"));
  try {
    const txt = path.join(root, "note.txt");
    const md = path.join(root, "note.md");
    const csv = path.join(root, "data.csv");
    const xlsx = path.join(root, "data.xlsx");
    const xls = path.join(root, "data.xls");
    const docx = path.join(root, "note.docx");
    const pdf = path.join(root, "note.pdf");
    const pptx = path.join(root, "slides.pptx");
    fs.writeFileSync(txt, "TXT 제목\n본문 숫자 100\n날짜 2026-09-09", "utf8");
    fs.writeFileSync(md, "# MD 제목\n\n마크다운 본문", "utf8");
    fs.writeFileSync(csv, "항목,값\n날짜,2026-09-09\n수량,100", "utf8");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["항목", "값"], ["날짜", "2026-09-09"], ["수량", 100]]), "Sheet1");
    XLSX.writeFile(workbook, xlsx);
    XLSX.writeFile(workbook, xls, { bookType: "biff8" });
    await writeDocx(docx);
    await writePdf(pdf);
    await writePptx(pptx);

    for (const filePath of [txt, md, csv, xlsx, xls, docx, pdf, pptx]) {
      const parsed = await parseUploadedFile(filePath);
      assert.equal(parsed.filename, path.basename(filePath));
      assert.equal(parsed.sourcePath, filePath);
      assert.ok(parsed.text || parsed.tables.length, `empty parsed result: ${filePath}`);
      assert.ok(parsed.source_sections.length || parsed.tables.length, `missing sections: ${filePath}`);
    }
    const combined = await parseFiles([csv, xlsx]);
    assert.equal(combined.documents.length, 2);
    assert.deepEqual(combined.documents.map((item) => item.sourcePath), [csv, xlsx]);
    assert.ok(Array.isArray(combined.conflicts));
    const unsupported = path.join(root, "unsupported.hwp");
    fs.writeFileSync(unsupported, "not supported");
    await assert.rejects(() => parseUploadedFile(unsupported), { code: "UNSUPPORTED_FILE_TYPE" });
    console.log("File parser checks passed for TXT, MD, CSV, XLSX, XLS, DOCX, PDF, PPTX, and unsupported-type handling.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
