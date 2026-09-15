const fs = require("node:fs");
const path = require("node:path");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
const JSZip = require("jszip");

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function parserError(code, message, filePath = "") {
  const error = new Error(message);
  error.code = code;
  error.filePath = filePath;
  return error;
}

function titleFromText(text, fallback) {
  const heading = String(text || "").match(/^\s*#{1,6}\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim().slice(0, 200);
  const firstLine = String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return (firstLine || fallback || "파일 기반 문서").replace(/^[-*]\s+/, "").slice(0, 200);
}

function sectionsFromText(text, prefix = "") {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  let current = prefix || "본문";
  let buffer = [];
  const flush = () => {
    const value = buffer.join("\n").trim();
    if (value) sections.push({ heading: current, text: value });
    buffer = [];
  };
  for (const line of lines) {
    const heading = line.match(/^\s*(?:#{1,6}\s+|\[슬라이드\s+[^\]]+\]\s*)(.+)?$/i);
    if (heading) {
      flush();
      current = String(heading[1] || line).trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ heading: current, text: String(text || "").trim() }].filter((item) => item.text);
}

function cleanXmlText(value) {
  return String(value || "")
    .replace(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi, "$1")
    .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function rowsToText(rows) {
  return rows.map((row) => row.map((cell) => String(cell ?? "")).join("\t")).join("\n");
}

function detectSourceConflicts(documents) {
  const values = new Map();
  for (const document of documents) {
    for (const table of document.tables || []) {
      const rows = Array.isArray(table.rows) ? table.rows : [];
      if (rows.length < 2) continue;
      for (let index = 1; index < rows.length; index += 1) {
        const key = String(rows[index]?.[0] ?? "").trim().toLowerCase();
        const value = rows[index].slice(1).map((cell) => String(cell ?? "").trim()).join(" | ");
        if (!key || !value) continue;
        const entry = values.get(key) || { key, values: new Map() };
        entry.values.set(value, [...(entry.values.get(value) || []), document.filename]);
        values.set(key, entry);
      }
    }
  }
  return [...values.values()]
    .filter((entry) => entry.values.size > 1)
    .map((entry) => ({
      field: entry.key,
      values: [...entry.values.entries()].map(([value, files]) => ({ value, files: [...new Set(files)] })),
      message: `같은 항목에 서로 다른 값이 있습니다: ${entry.key}`
    }));
}

function baseDocument(filePath, overrides = {}) {
  const filename = path.basename(filePath);
  return {
    sourcePath: filePath,
    filename,
    file_type: path.extname(filename).slice(1).toLowerCase(),
    title: filename.replace(/\.[^.]+$/, ""),
    text: "",
    tables: [],
    metadata: {},
    source_sections: [],
    ...overrides
  };
}

async function parsePdf(filePath, document) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await pdfjs.getDocument({ data }).promise;
  const sections = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || "").join(" ").replace(/\s+/g, " ").trim();
    if (text) sections.push({ heading: `페이지 ${pageNumber}`, text });
  }
  if (!sections.length) {
    throw parserError(
      "PDF_TEXT_EMPTY",
      "PDF에서 읽을 수 있는 텍스트를 찾지 못했습니다. 스캔·이미지형 PDF라면 OCR 처리된 PDF 또는 TXT/MD 파일을 선택하세요.",
      filePath
    );
  }
  document.text = sections.map((section) => `[${section.heading}]\n${section.text}`).join("\n\n");
  document.source_sections = sections;
  document.metadata = { pageCount: pdf.numPages };
  document.title = titleFromText(document.text, document.title);
  return document;
}

async function parseDocx(filePath, document) {
  const raw = await mammoth.extractRawText({ path: filePath });
  const text = String(raw.value || "").trim();
  document.text = text;
  document.title = titleFromText(text, document.title);
  document.source_sections = sectionsFromText(text);
  try {
    const html = String((await mammoth.convertToHtml({ path: filePath })).value || "");
    const tableMatches = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)];
    document.tables = tableMatches.map((match, tableIndex) => {
      const rows = [...match[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((rowMatch) =>
        [...rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanXmlText(cell[1]))
      ).filter((row) => row.length);
      return { name: `표 ${tableIndex + 1}`, rows };
    }).filter((table) => table.rows.length);
  } catch {
    // Raw text remains usable when a DOCX has unusual HTML conversion markup.
  }
  return document;
}

function parseSpreadsheet(filePath, document) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const tables = [];
  const sections = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    const normalizedRows = rows.map((row) => row.map((cell) => String(cell ?? "")));
    tables.push({ name: sheetName, rows: normalizedRows });
    sections.push({ heading: `시트 ${sheetName}`, text: rowsToText(normalizedRows) });
  }
  document.tables = tables;
  document.source_sections = sections;
  document.text = sections.map((section) => `[${section.heading}]\n${section.text}`).join("\n\n");
  document.title = titleFromText(document.text, document.title);
  document.metadata = { sheetNames: workbook.SheetNames, sheetCount: workbook.SheetNames.length };
  return document;
}

async function parsePptx(filePath, document) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
  const sections = [];
  for (const [index, name] of slideNames.entries()) {
    const xml = await zip.files[name].async("text");
    const text = cleanXmlText(xml);
    if (text) sections.push({ heading: `슬라이드 ${index + 1}`, text });
  }
  document.text = sections.map((section) => `[${section.heading}]\n${section.text}`).join("\n\n");
  document.source_sections = sections;
  document.metadata = { slideCount: slideNames.length };
  document.title = titleFromText(document.text, document.title);
  return document;
}

async function parseUploadedFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw parserError("FILE_NOT_FOUND", "파일을 찾을 수 없습니다.", resolved);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw parserError("UNSUPPORTED_FILE_TYPE", `지원하지 않는 파일 형식입니다: ${extension || "확장자 없음"}`, resolved);
  }
  if (fs.statSync(resolved).size > MAX_FILE_BYTES) {
    throw parserError("FILE_TOO_LARGE", "파일은 25MB 이하만 업로드할 수 있습니다.", resolved);
  }
  const document = baseDocument(resolved);
  if (extension === ".txt" || extension === ".md") {
    document.text = fs.readFileSync(resolved, "utf8");
    document.title = titleFromText(document.text, document.title);
    document.source_sections = sectionsFromText(document.text);
    return document;
  }
  if ([".xlsx", ".xls", ".csv"].includes(extension)) return parseSpreadsheet(resolved, document);
  if (extension === ".docx") return parseDocx(resolved, document);
  if (extension === ".pdf") return parsePdf(resolved, document);
  return parsePptx(resolved, document);
}

async function parseFiles(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  if (!paths.length) throw parserError("NO_FILES", "업로드할 파일을 선택하세요.");
  const documents = [];
  const errors = [];
  for (const filePath of paths) {
    try {
      documents.push(await parseUploadedFile(filePath));
    } catch (error) {
        errors.push({
          filename: path.basename(String(filePath || "")),
          filePath: path.resolve(String(filePath || "")),
          code: error.code || "PARSE_FAILED",
          message: error.message
        });
    }
  }
  if (!documents.length) {
    const error = parserError(errors[0]?.code || "PARSE_FAILED", errors[0]?.message || "파일을 읽지 못했습니다.");
    error.details = errors;
    throw error;
  }
  return {
    filePaths: paths,
    documents,
    conflicts: detectSourceConflicts(documents),
    errors
  };
}

function normalizeSourceDocuments(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    sourcePath: String(item?.sourcePath || item?.filePath || "").trim(),
    filename: String(item?.filename || "").trim(),
    file_type: String(item?.file_type || "").trim().toLowerCase(),
    title: String(item?.title || item?.filename || "").trim(),
    text: String(item?.text || ""),
    tables: Array.isArray(item?.tables) ? item.tables : [],
    metadata: item?.metadata && typeof item.metadata === "object" ? item.metadata : {},
    source_sections: Array.isArray(item?.source_sections) ? item.source_sections : []
  })).filter((item) => item.filename && (item.text.trim() || item.tables.length));
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  MAX_FILE_BYTES,
  parseUploadedFile,
  parseFiles,
  normalizeSourceDocuments,
  detectSourceConflicts
};
