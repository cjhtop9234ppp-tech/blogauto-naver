const fs = require("node:fs");
const path = require("node:path");

function ensureRuntimeFiles(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "image"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "jobs"), { recursive: true });
  const historyPath = path.join(runtimeRoot, "blog_history.jsonl");
  if (!fs.existsSync(historyPath)) {
    fs.writeFileSync(historyPath, "", "utf8");
  }
}

function getHistoryPath(runtimeRoot) {
  ensureRuntimeFiles(runtimeRoot);
  return path.join(runtimeRoot, "blog_history.jsonl");
}

function historyTitleKey(entry) {
  const title = entry?.title || entry?.research_title || entry?.topic || "";
  return String(title).trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function historyTimestamp(entry) {
  for (const value of [entry?.create_at, entry?.status_updated_at, entry?.published_at]) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function readHistory(runtimeRoot) {
  const historyPath = getHistoryPath(runtimeRoot);
  const text = fs.readFileSync(historyPath, "utf8");
  const records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return { line, entry: JSON.parse(line), valid: true };
      } catch (error) {
        return { line, valid: false, entry: {
          id: `invalid_${Date.now()}`,
          create_at: "",
          account_id: "",
          blog_id: "",
          title: "",
          topic: "",
          keyword: "",
          status: "failed",
          embedding_model: "",
          embedding: [],
          reason: "blog_history.jsonl 행을 읽을 수 없습니다."
        } };
      }
    });
  const sorted = records
    .slice()
    .sort((a, b) => historyTimestamp(b.entry) - historyTimestamp(a.entry));
  const seenTitles = new Set();
  const duplicateIds = new Set();
  const deduplicated = [];
  for (const record of sorted) {
    const key = record.valid ? historyTitleKey(record.entry) : "";
    const jobId = String(record.entry?.id || "");
    if (!key || !jobId || !record.valid) {
      deduplicated.push(record.entry);
      continue;
    }
    if (seenTitles.has(key)) {
      duplicateIds.add(jobId);
      continue;
    }
    seenTitles.add(key);
    deduplicated.push(record.entry);
  }

  if (duplicateIds.size > 0) {
    const nextLines = records
      .filter((record) => !record.valid || !duplicateIds.has(String(record.entry?.id || "")))
      .map((record) => record.line);
    fs.writeFileSync(historyPath, `${nextLines.join("\n")}\n`, "utf8");
  }
  return deduplicated;
}

function appendHistory(runtimeRoot, entry) {
  const historyPath = getHistoryPath(runtimeRoot);
  const safeEntry = { ...entry };
  delete safeEntry.naverPassword;
  delete safeEntry.password;
  fs.appendFileSync(historyPath, `${JSON.stringify(safeEntry)}\n`, "utf8");
}

function markHistoryItemsSuccess(runtimeRoot, jobIds, reason = "사용자가 외부에서 수동 발행한 것으로 표시") {
  const historyPath = getHistoryPath(runtimeRoot);
  const ids = new Set((Array.isArray(jobIds) ? jobIds : [jobIds])
    .map((value) => String(value || "").trim())
    .filter(Boolean));
  if (!ids.size) return { updated: 0, history: readHistory(runtimeRoot) };

  const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/);
  const now = new Date().toISOString();
  let updated = 0;
  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }
    if (!ids.has(String(entry.id || ""))) return line;
    updated += 1;
    return JSON.stringify({
      ...entry,
      status: "success",
      reason,
      manual_publish_confirmed: true,
      published_at: entry.published_at || now,
      status_updated_at: now
    });
  });

  if (updated > 0) fs.writeFileSync(historyPath, nextLines.join("\n"), "utf8");
  return { updated, history: readHistory(runtimeRoot) };
}

function updateHistoryItemCategory(runtimeRoot, jobId, category) {
  const historyPath = getHistoryPath(runtimeRoot);
  const safeJobId = String(jobId || "").trim();
  const nextCategory = String(category || "").trim();
  if (!/^job_[A-Za-z0-9_-]+$/.test(safeJobId)) throw new Error("유효하지 않은 작업 이력 ID입니다.");
  if (!nextCategory) throw new Error("발행 카테고리를 입력하세요.");

  const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/);
  let updated = 0;
  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }
    if (String(entry.id || "") !== safeJobId) return line;
    updated += 1;
    return JSON.stringify({
      ...entry,
      category: nextCategory,
      category_updated_at: new Date().toISOString()
    });
  });

  if (!updated) throw new Error("선택한 작업 이력을 찾지 못했습니다.");
  fs.writeFileSync(historyPath, nextLines.join("\n"), "utf8");
  return { updated, category: nextCategory, history: readHistory(runtimeRoot) };
}

function markHistoryItemPublished(runtimeRoot, jobId, title = "", reason = "작업 이력에서 발행 완료") {
  const historyPath = getHistoryPath(runtimeRoot);
  const safeJobId = String(jobId || "").trim();
  if (!/^job_[A-Za-z0-9_-]+$/.test(safeJobId)) throw new Error("유효하지 않은 작업 이력 ID입니다.");
  const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/);
  const now = new Date().toISOString();
  let updated = 0;
  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }
    if (String(entry.id || "") !== safeJobId) return line;
    updated += 1;
    return JSON.stringify({
      ...entry,
      title: String(title || entry.title || entry.research_title || entry.topic || "").trim(),
      status: "success",
      final_verdict: "PASS",
      reason,
      published_at: entry.published_at || now,
      status_updated_at: now,
      manual_publish_confirmed: false
    });
  });
  if (updated > 0) fs.writeFileSync(historyPath, nextLines.join("\n"), "utf8");
  return { updated, history: readHistory(runtimeRoot) };
}

function deleteHistoryItems(runtimeRoot, jobIds) {
  const historyPath = getHistoryPath(runtimeRoot);
  const ids = new Set((Array.isArray(jobIds) ? jobIds : [jobIds])
    .map((value) => String(value || "").trim())
    .filter((value) => /^job_[A-Za-z0-9_-]+$/.test(value)));
  if (!ids.size) return { deleted: 0, history: readHistory(runtimeRoot) };

  const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/);
  let deleted = 0;
  const nextLines = lines.filter((line) => {
    if (!line.trim()) return true;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return true;
    }
    if (!ids.has(String(entry.id || ""))) return true;
    deleted += 1;
    return false;
  });

  if (deleted > 0) fs.writeFileSync(historyPath, nextLines.join("\n"), "utf8");
  return { deleted, history: readHistory(runtimeRoot) };
}

module.exports = {
  ensureRuntimeFiles,
  readHistory,
  appendHistory,
  markHistoryItemsSuccess,
  updateHistoryItemCategory,
  markHistoryItemPublished,
  deleteHistoryItems
};
