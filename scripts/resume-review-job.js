const fs = require("node:fs");
const path = require("node:path");
const { runCodexGeneration } = require("../src/lib/codexRunner");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function copyIfPresent(sourcePath, targetPath) {
  if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, targetPath);
}

function usage() {
  console.error("사용법: node scripts/resume-review-job.js <runtimeRoot> <jobId>");
  process.exitCode = 2;
}

async function main() {
  const runtimeRoot = path.resolve(process.argv[2] || "");
  const jobId = String(process.argv[3] || "").trim();
  if (!runtimeRoot || !jobId) return usage();

  const jobDir = path.join(runtimeRoot, "jobs", jobId);
  const source = readJson(path.join(jobDir, "source-material.json"));
  const research = readJson(path.join(jobDir, "research-title-result.json"));
  const writer = readJson(path.join(jobDir, "agent-result.json"));
  const review = readJson(path.join(jobDir, "main-review-result.json"));
  const settings = readJson(path.join(runtimeRoot, "user-settings.json"));
  const sourceDocuments = Array.isArray(source.documents) ? source.documents : [];
  if (!sourceDocuments.length) throw new Error("복구 원본 문서가 없습니다.");
  if (!String(writer.article || "").trim()) throw new Error("복구할 Writer 초안 본문이 없습니다.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyIfPresent(path.join(jobDir, "agent-result.json"), path.join(jobDir, `agent-result-before-resume-${stamp}.json`));
  copyIfPresent(path.join(jobDir, "main-review-result.json"), path.join(jobDir, `main-review-result-before-resume-${stamp}.json`));

  const reviewFeedback = [
    review.failureReason,
    ...(Array.isArray(review.issues) ? review.issues : []),
    ...(Array.isArray(review.revisionInstructions) ? review.revisionInstructions : [])
  ].filter(Boolean).join(" / ").slice(0, 6000);
  const title = String(research.finalTitle || writer.title || settings.topic || "").trim();
  const category = String(settings.category || "(기본지식) 견적작성").trim();
  const keyword = String(settings.keyword || category).trim();

  const result = await runCodexGeneration({
    runtimeRoot,
    jobDir,
    codexCmdPath: settings.codexCmdPath,
    codexModel: settings.codexModel,
    agentModels: settings.agentModels || {},
    topic: title,
    keyword,
    category,
    topicMode: "manual",
    sourceMode: "file_upload",
    sourceDocuments,
    sourceConflicts: Array.isArray(source.conflicts) ? source.conflicts : [],
    currentDateLabel: new Date().toISOString().slice(0, 10),
    includeTitleImage: settings.includeTitleImage !== false,
    titleImageAspectRatio: settings.titleImageAspectRatio,
    bodyImageAspectRatio: settings.bodyImageAspectRatio,
    maxBodyImages: settings.maxBodyImages,
    breakSentencesInBody: settings.breakSentencesInBody !== false,
    preferredTone: settings.preferredTone || "읽기 쉬운 정보 전달형 문체",
    publishPurpose: settings.publishPurpose || "업로드 원문에 근거한 독자용 블로그 글",
    excludedTopics: settings.excludedTopics || "",
    freshnessLevel: "none",
    searchResults: [],
    accountImageStyle: {},
    resumeState: {
      researchTitleResult: research,
      writerResult: writer,
      reviewFeedback,
      nextAttempt: 3,
      maxReviewAttempts: 3
    },
    onTokenUsage: (usage) => {
      if (usage.final) console.log(`[resume] tokens=${usage.total || 0}`);
    }
  }, (message, level, agent) => {
    console.log(`[${level || "info"}/${agent || "main"}] ${message}`);
  });

  fs.writeFileSync(path.join(jobDir, "resume-result.json"), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ status: result.status, title: result.title, reviewStatus: result.reviewStatus, failureReason: result.failureReason }, null, 2));
}

main().catch((error) => {
  console.error(`[resume] ${error.stack || error.message}`);
  process.exitCode = 1;
});
