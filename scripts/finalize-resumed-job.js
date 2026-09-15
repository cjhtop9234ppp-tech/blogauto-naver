const fs = require("node:fs");
const path = require("node:path");
const { appendHistory, readHistory } = require("../src/lib/history");
const { createEmbedding } = require("../src/lib/embedding");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function main() {
  const runtimeRoot = path.resolve(process.argv[2] || "");
  const jobId = String(process.argv[3] || "").trim();
  if (!runtimeRoot || !jobId) throw new Error("사용법: node scripts/finalize-resumed-job.js <runtimeRoot> <jobId>");
  const jobDir = path.join(runtimeRoot, "jobs", jobId);
  const result = readJson(path.join(jobDir, "resume-result.json"));
  const writer = readJson(path.join(jobDir, "agent-result.json"));
  const source = readJson(path.join(jobDir, "source-material.json"));
  const research = result.researchTitleResult || readJson(path.join(jobDir, "research-title-result.json"));
  const review = result.mainReviewResult || readJson(path.join(jobDir, "main-review-result.json"));
  const settings = readJson(path.join(runtimeRoot, "user-settings.json"));
  if (String(review.status || "").toUpperCase() !== "PASS") throw new Error("최종 Main 검수가 PASS가 아닙니다.");
  const title = String(result.title || writer.title || research.finalTitle || "").trim();
  const article = String(result.article || writer.article || "").trim();
  if (!title || !article) throw new Error("완료 처리할 본문이 없습니다.");
  const id = `${jobId}_resume_3`;
  if (readHistory(runtimeRoot).some((item) => item.id === id)) {
    console.log(JSON.stringify({ updated: false, id, reason: "이미 완료 처리됨" }));
    return;
  }
  const entry = {
    id,
    create_at: new Date().toISOString(),
    account_id: String(settings.accountId || "").trim(),
    blog_id: String(settings.blogId || "").trim(),
    title,
    topic: String(settings.topic || title).trim(),
    keyword: String(settings.keyword || "").trim(),
    category: String(settings.category || "").trim(),
    status: "generated",
    content_source: "file_upload",
    source_files: (source.documents || []).map((item) => item.filename).filter(Boolean),
    source_conflicts: Array.isArray(source.conflicts) ? source.conflicts : [],
    harness_version: "lean-agent-v1",
    final_verdict: "PASS",
    failure_phase: "",
    research_title: String(research.finalTitle || title),
    fact_based: true,
    source_summary: "저장된 Research/Title 결과와 Writer 수정본을 이어받아 Main Agent 최종 검수 PASS. 이미지 생성은 제한시간 초과로 생략됨.",
    embedding_model: "local-hash-v1",
    embedding: createEmbedding(title),
    token_total: Number(result.tokenUsage?.total || 0),
    token_gross_total: Number(result.tokenUsage?.grossTotal || 0),
    token_input: Number(result.tokenUsage?.inputTokens || 0),
    token_cached_input: Number(result.tokenUsage?.cachedInputTokens || 0),
    token_output: Number(result.tokenUsage?.outputTokens || 0),
    prompt_characters: Number(result.tokenUsage?.promptCharacters || 0),
    token_agents: result.tokenUsage?.agents || {},
    reason: "중단된 작업을 Writer 수정·Main 재검수까지 이어서 완료 처리"
  };
  appendHistory(runtimeRoot, entry);
  console.log(JSON.stringify({ updated: true, id, title, status: entry.status, finalVerdict: entry.final_verdict }, null, 2));
}

try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
