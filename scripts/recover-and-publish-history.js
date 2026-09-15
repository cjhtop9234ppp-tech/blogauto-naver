const fs = require("node:fs");
const path = require("node:path");
const { normalizeMaxBodyImages, readSettings, resolveCodexCmdPath } = require("../src/lib/settings");
const { readAccountStore, getAccountProfileDir } = require("../src/lib/accountStore");
const { ensureRuntimeFiles, readHistory, appendHistory } = require("../src/lib/history");
const { runCodexGeneration } = require("../src/lib/codexRunner");
const { normalizeAgentResult, getPreviewImages } = require("../src/lib/imageAssets");
const { publishToNaver } = require("../src/lib/naverPublisher");
const { createEmbedding } = require("../src/lib/embedding");

function log(message, level = "info") {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  console.log(`[${new Date().toLocaleTimeString()}] ${prefix} ${String(message || "")}`);
}

function todayLabel() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
}

async function main() {
  const runtimeRoot = process.env.BLOGAUTO_RUNTIME_ROOT
    ? path.resolve(process.env.BLOGAUTO_RUNTIME_ROOT)
    : path.join(process.env.APPDATA || process.cwd(), "blogauto-naver-tistory", "runtime");
  const sourceJobId = String(process.argv[2] || "job_1789120583332").trim();
  const history = readHistory(runtimeRoot);
  const sourceHistory = history.find((item) => String(item.id || "") === sourceJobId);
  if (!sourceHistory) throw new Error(`원본 작업 이력을 찾을 수 없습니다: ${sourceJobId}`);

  const sourceJobDir = path.join(runtimeRoot, "jobs", sourceJobId);
  const sourceMaterialPath = path.join(sourceJobDir, "source-material.json");
  if (!fs.existsSync(sourceMaterialPath)) throw new Error("복구 원본 source-material.json이 없습니다.");
  const sourceMaterial = JSON.parse(fs.readFileSync(sourceMaterialPath, "utf8").replace(/^\uFEFF/, ""));
  const sourceDocuments = Array.isArray(sourceMaterial.documents) ? sourceMaterial.documents : [];
  if (!sourceDocuments.length) throw new Error("복구 원본 문서가 비어 있습니다.");

  const settings = readSettings(runtimeRoot);
  const store = readAccountStore(runtimeRoot, settings);
  const account = store.accounts.find((item) => item.id === sourceHistory.account_id)
    || store.accounts.find((item) => item.checked !== false)
    || store.accounts[0];
  if (!account) throw new Error("복구에 사용할 네이버 계정이 없습니다.");
  const blogId = String(sourceHistory.blog_id || account.blogId || account.naverId || "").trim();
  const requestedCategory = String(sourceHistory.category || "").trim();
  const configuredCategories = Array.isArray(account.categories)
    ? account.categories.map((item) => String(item?.name || "").trim()).filter(Boolean)
    : [];
  const configuredFallback = String(settings.category || configuredCategories[0] || "알아두면 좋은 지식").trim();
  const category = configuredCategories.length === 0 || configuredCategories.includes(requestedCategory)
    ? (requestedCategory || configuredFallback)
    : configuredFallback;
  if (requestedCategory && requestedCategory !== category) {
    log(`WARN 저장된 카테고리 '${requestedCategory}'가 현재 계정에 없어 설정된 카테고리 '${category}'를 사용합니다.`);
  }
  const topic = String(sourceHistory.topic || sourceHistory.research_title || sourceDocuments[0].title || "파일 원문 기반 콘텐츠").trim();
  const keyword = String(sourceHistory.keyword || category).trim();
  const reuseJobId = String(process.env.BLOGAUTO_REUSE_JOB_ID || "").trim();
  const jobId = reuseJobId || `job_${Date.now()}_recovery`;
  const jobDir = path.join(runtimeRoot, "jobs", jobId);
  if (!reuseJobId) {
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "source-material.json"), JSON.stringify(sourceMaterial, null, 2), "utf8");
  }

  log(`복구 대상: ${sourceJobId}`);
  let result;
  let agentResult;
  if (reuseJobId) {
    const existingResultPath = path.join(jobDir, "agent-result.json");
    if (!fs.existsSync(existingResultPath)) throw new Error(`재사용할 복구 초안 파일이 없습니다: ${existingResultPath}`);
    agentResult = JSON.parse(fs.readFileSync(existingResultPath, "utf8").replace(/^\uFEFF/, ""));
    result = {
      status: "DRY_RUN",
      title: agentResult.title,
      article: agentResult.article,
      tags: agentResult.tags || [],
      tokenUsage: { total: 0 },
      researchTitleResult: { finalTitle: agentResult.title }
    };
    log(`기존 복구 초안 재사용: ${agentResult.title}`);
  } else {
    log(`원문 기반 초안 재생성 시작: ${topic}`);
    result = await runCodexGeneration({
    codexCmdPath: resolveCodexCmdPath(settings.codexCmdPath),
    runtimeRoot,
    jobDir,
    codexModel: settings.codexModel,
    topic,
    keyword,
    category,
    topicMode: "manual",
    sourceMode: "file_upload",
    sourceDocuments,
    sourceConflicts: Array.isArray(sourceMaterial.conflicts) ? sourceMaterial.conflicts : [],
    allowHistoricalFileDraft: true,
    searchResults: [],
    currentDateLabel: todayLabel(),
    // One-time recovery stays text-first so a slow image worker cannot block publication.
    includeTitleImage: false,
    titleImageAspectRatio: settings.titleImageAspectRatio,
    bodyImageAspectRatio: settings.bodyImageAspectRatio,
    maxBodyImages: 0,
    sourceQuality: { status: "file_upload", reason: "복구 원문만을 사실 근거로 사용합니다." },
    excludedTopics: settings.excludedTopics || "",
    publishPurpose: "원문 날짜와 사실 범위 안에서 독자에게 설명합니다. 현재 제도나 최신 사실로 확대하지 않습니다.",
    preferredTone: settings.preferredTone || "읽기 쉬운 정보 전달형 문체",
    freshnessLevel: "none",
    agentModels: settings.agentModels || {},
    historyTitles: history.filter((item) => String(item.blog_id || "") === blogId).map((item) => item.title).filter(Boolean),
    accountImageStyle: {
      accountId: account.id || "",
      sampleImagePath: account.sampleImagePath || "",
      sampleImageHash: account.sampleImageHash || "",
      imageStylePrompt: account.imageStylePrompt || "",
      imageStylePromptStatus: account.imageStylePromptStatus || "missing",
      imageStylePromptSourceImageHash: account.imageStylePromptSourceImageHash || ""
    },
    onTokenUsage: (usage) => log(`토큰 사용량 ${Number(usage.total || 0).toLocaleString()} tokens`)
    }, log);
  }
  if (!result || !["DRY_RUN", "success", "generated"].includes(result.status)) {
    throw new Error(result?.failureReason || result?.reason || "복구 초안 생성에 실패했습니다.");
  }

  if (!agentResult) {
    agentResult = normalizeAgentResult({
      runtimeRoot,
      jobDir,
      topic,
      includeTitleImage: false,
      maxBodyImages: 0,
      currentDateLabel: todayLabel(),
      result
    });
    fs.writeFileSync(path.join(jobDir, "agent-result.json"), JSON.stringify(agentResult, null, 2), "utf8");
  }
  if (!reuseJobId) appendHistory(runtimeRoot, {
    id: jobId,
    create_at: new Date().toISOString(),
    account_id: account.id || "",
    blog_id: blogId,
    title: agentResult.title,
    topic,
    keyword,
    category,
    status: "DRY_RUN",
    content_source: "file_upload",
    source_files: sourceHistory.source_files || sourceDocuments.map((item) => item.filename),
    final_verdict: "PASS",
    failure_phase: "",
    research_title: result.researchTitleResult?.finalTitle || agentResult.title,
    source_summary: "복구 원문만을 사실 근거로 사용했습니다. 웹 검색은 실행하지 않았습니다.",
    embedding_model: "local-hash-v1",
    embedding: createEmbedding(agentResult.title),
    token_total: Number(result.tokenUsage?.total || 0),
    reason: `작업 이력 ${sourceJobId}의 원문 기반 초안 복구 완료`
  });
  log(`초안 재생성 완료: ${agentResult.title}`);
  log(`발행 설정: 전체공개 / 카테고리 '${category}'`);

  await publishToNaver({
    blogId,
    category,
    publishPrivate: false,
    publishVisibility: "public",
    publishScheduleMode: "now",
    reserveAfterHours: 0,
    failOnLoginRequired: false,
    title: agentResult.title,
    article: agentResult.article,
    titleImagePath: agentResult.titleImagePath,
    bodyImages: agentResult.bodyImages,
    breakSentencesInBody: settings.breakSentencesInBody !== false,
    tags: result.tags || [],
    domNotes: settings.naverEditorDomNotes || "",
    browserProfileDir: getAccountProfileDir(runtimeRoot, account),
    runtimeRoot,
    reuseBrowserSession: true,
    log
  });
  appendHistory(runtimeRoot, {
    id: `${jobId}-publish`,
    create_at: new Date().toISOString(),
    account_id: account.id || "",
    blog_id: blogId,
    title: agentResult.title,
    topic,
    keyword,
    category,
    status: "success",
    source_job_id: jobId,
    final_verdict: "PASS",
    embedding_model: "local-hash-v1",
    embedding: createEmbedding(agentResult.title),
    token_total: Number(result.tokenUsage?.total || 0),
    reason: `이력 ${sourceJobId} 복구 초안을 전체공개로 발행 완료`
  });
  log("복구 초안 네이버 발행 완료");
  log(`이미지 ${getPreviewImages(agentResult).length}개를 사용했습니다.`);
}

main().catch((error) => {
  console.error(`[${new Date().toLocaleTimeString()}] ERROR ${error.message}`);
  process.exit(1);
});
