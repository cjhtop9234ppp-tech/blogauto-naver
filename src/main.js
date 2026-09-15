const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { pathToFileURL } = require("node:url");
const { readHistory, appendHistory, markHistoryItemsSuccess, updateHistoryItemCategory, markHistoryItemPublished, deleteHistoryItems, ensureRuntimeFiles } = require("./lib/history");
const { createEmbedding, cosineSimilarity } = require("./lib/embedding");
const { collectSearchResults, summarizeSourceQuality } = require("./lib/search");
const { runCodexGeneration, fetchCodexUsageSnapshot } = require("./lib/codexRunner");
const {
  findRecoveryGuidance,
  markRecoveryGuidanceUsed,
  recordRecoveryAttempt,
  recordRecoveryLesson,
  recoveryOverview
} = require("./lib/recoveryPlaybook");
const { parseFiles, normalizeSourceDocuments, SUPPORTED_EXTENSIONS } = require("./lib/fileParser");
const { normalizeAgentResult, getPreviewImages, normalizeHistoryDraftAssets } = require("./lib/imageAssets");
const {
  publishToNaver,
  checkNaverSession,
  verifyOpenNaverSession,
  closeReusablePublishSession,
  closeAllReusablePublishSessions
} = require("./lib/naverPublisher");
const { publishToTistory, checkTistorySession } = require("./lib/tistoryPublisher");
const { ensureSettingsFile, normalizeCodexModel, normalizeImageAspectRatio, normalizeMaxBodyImages, resolveCodexCmdPath, readSettings, writeSettings } = require("./lib/settings");
const {
  ensureAccountStoreFile,
  readAccountStore,
  writeAccountStore,
  updateAccountSession,
  getAccountProfileDir
} = require("./lib/accountStore");
const {
  MEMBER_BOARD_URL,
  MEMBER_BOARD_WRITE_URL,
  DEFAULT_DAILY_PUBLISH_CATEGORY,
  NAVER_STYLE_URL,
  ensureDailyWorkflowFiles,
  readDailyPlan,
  writeDailyPlan,
  updatePlanItem,
  readMemberSource,
  writeMemberSource,
  createDailyPlan,
  createRandomResearchPlan,
  extractStyleRules,
  readStyleRules,
  writeStyleRules
} = require("./lib/dailyWorkflow");
const { crawlMemberBoard, crawlNaverStylePosts } = require("./lib/memberBoardCrawler");
const { publishMemberBoardPost } = require("./lib/memberBoardPublisher");
const {
  readSchedulerStatus,
  registerWindowsScheduler,
  unregisterWindowsScheduler,
  recordScheduledRun
} = require("./lib/windowsScheduler");

let mainWindow;
let activeJob = null;
let dailyWorkflowRunning = false;
let memberBoardLoginContext = null;
let memberBoardLoginProfileDir = "";
const activeNaverSessions = new Map();
const activeTistorySessions = new Map();
const scheduledStage = String(process.argv.find((arg) => arg.startsWith("--scheduled-stage=")) || "")
  .slice("--scheduled-stage=".length)
  .trim();
const singleInstanceLock = app.requestSingleInstanceLock({ scheduledStage });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, _commandLine, _workingDirectory, additionalData = {}) => {
    const stage = String(additionalData?.scheduledStage || "").trim();
    if (stage) executeScheduledStage(stage, { shutdownAfter: false }).catch((error) => {
      console.error(`예약 작업 실행 실패: ${error.message}`);
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: "#f4f7f5",
    title: "네이버 블로그 및 온새카 회원마당 글쓰기 자동화",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone: ${details.reason || "unknown"} (${details.exitCode || 0})`);
  });
}

function getRuntimeRoot() {
  const overrideRoot = process.env.BLOGAUTO_RUNTIME_ROOT;
  if (overrideRoot) {
    return path.resolve(overrideRoot);
  }

  if (app.isPackaged) {
    const persistentRoot = path.join(app.getPath("userData"), "runtime");
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
    const portableRoots = [
      portableDir && fs.existsSync(portableDir) ? path.join(portableDir, "runtime") : "",
      portableFile && fs.existsSync(portableFile) ? path.join(path.dirname(portableFile), "runtime") : "",
      path.join(path.dirname(process.execPath), "runtime")
    ].filter(Boolean);
    const hasRuntimeData = (runtimeRoot) => {
      try {
        const accountPath = path.join(runtimeRoot, "account-categories.json");
        if (fs.existsSync(accountPath)) {
          const store = JSON.parse(fs.readFileSync(accountPath, "utf8").replace(/^\uFEFF/, ""));
          if (Array.isArray(store?.accounts) && store.accounts.length > 0) return true;
        }
        const historyPath = path.join(runtimeRoot, "blog_history.jsonl");
        if (fs.existsSync(historyPath) && fs.statSync(historyPath).size > 0) return true;
        const jobsPath = path.join(runtimeRoot, "jobs");
        return fs.existsSync(jobsPath) && fs.readdirSync(jobsPath, { withFileTypes: true }).some((entry) => entry.isDirectory());
      } catch {
        return false;
      }
    };
    try {
      // The portable package contains a template runtime. Prefer the user's
      // persistent runtime so accounts, settings, history, and daily plans
      // survive switching between installed and portable builds. Only seed
      // it from a packaged/legacy runtime when the persistent store is empty.
      if (!hasRuntimeData(persistentRoot)) {
        const seedRoot = portableRoots.find((runtimeRoot) => (
          path.resolve(runtimeRoot).toLowerCase() !== path.resolve(persistentRoot).toLowerCase()
          && hasRuntimeData(runtimeRoot)
        ));
        if (seedRoot) {
          fs.mkdirSync(persistentRoot, { recursive: true });
          fs.cpSync(seedRoot, persistentRoot, { recursive: true, force: true });
        }
      }
      if (!fs.existsSync(persistentRoot)) {
        fs.mkdirSync(persistentRoot, { recursive: true });
      }
    } catch (error) {
      console.error(`사용자 런타임 저장소 초기화 실패: ${error.message}`);
      fs.mkdirSync(persistentRoot, { recursive: true });
    }
    return persistentRoot;
  }
  return path.join(app.getAppPath(), "runtime");
}

function getSchedulerScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "register-scheduler.ps1")
    : path.join(__dirname, "lib", "register-scheduler.ps1");
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function safeLog(jobId, message, level = "info", agent = "main") {
  let text = String(message || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/password\s*[:=]\s*\S+/gi, "password=[redacted]");
  if (/^mcp:/i.test(text) || /codex_core_plugins::manifest/i.test(text)) {
    return;
  }
  if (text.includes("Call log:")) {
    text = text.split("Call log:")[0].trim();
  }
  emit("job:log", {
    jobId,
    level,
    agent,
    message: text,
    at: new Date().toISOString()
  });
}

function updateStatus(jobId, status, detail = "") {
  emit("job:status", { jobId, status, detail, at: new Date().toISOString() });
}

function safeHistoryJobId(value) {
  const jobId = String(value || "").trim();
  if (!/^job_[A-Za-z0-9_-]+$/.test(jobId)) throw new Error("유효하지 않은 작업 이력 ID입니다.");
  return jobId;
}

function jobInputPath(runtimeRoot, jobId) {
  return path.join(runtimeRoot, "jobs", safeHistoryJobId(jobId), "job-input.json");
}

function jobCheckpointPath(runtimeRoot, jobId) {
  return path.join(runtimeRoot, "jobs", safeHistoryJobId(jobId), "job-checkpoint.json");
}

function readJsonObject(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readFirstJsonObject(jobDir, fileNames = []) {
  for (const fileName of fileNames) {
    const value = readJsonObject(path.join(jobDir, fileName));
    if (value) return { value, fileName };
  }
  return { value: null, fileName: "" };
}

function readImageProgressArtifacts(jobDir) {
  let fileNames = [];
  try {
    fileNames = fs.readdirSync(jobDir)
      .filter((fileName) => /^image-worker-progress-\d+\.json$/i.test(fileName))
      .sort((left, right) => Number(left.match(/(\d+)/)?.[1] || 0) - Number(right.match(/(\d+)/)?.[1] || 0));
  } catch {
    return { value: null, fileName: "" };
  }
  const bodyBySequence = new Map();
  let titleImagePath = "";
  let titleImageVerified = false;
  const notes = [];
  for (const fileName of fileNames) {
    const value = readJsonObject(path.join(jobDir, fileName));
    if (!value) continue;
    if (String(value.titleImagePath || "").trim()) titleImagePath = String(value.titleImagePath).trim();
    titleImageVerified = titleImageVerified || value.titleImageVerified === true;
    if (Array.isArray(value.notes)) notes.push(...value.notes);
    const images = Array.isArray(value.bodyImages) ? value.bodyImages : value.sequence ? [value] : [];
    for (const image of images) {
      const sequence = Number(image?.sequence || 0);
      if (sequence > 0) bodyBySequence.set(sequence, image);
    }
  }
  if (!bodyBySequence.size && !titleImagePath) return { value: null, fileName: "" };
  return {
    value: {
      status: "partial",
      failureReason: "Image Worker가 일부 이미지까지 저장한 후 제한시간에 도달했습니다.",
      titleImagePath,
      titleImageVerified,
      bodyImages: [...bodyBySequence.values()].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0)),
      notes: [...new Set(notes.map((note) => String(note || "").trim()).filter(Boolean))]
    },
    fileName: fileNames.join(", ")
  };
}

function sanitizeResumeInput(value, key = "") {
  if (/(password|secret|token|cookie|authorization)/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeResumeInput(item, key)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .map(([entryKey, entryValue]) => [entryKey, sanitizeResumeInput(entryValue, entryKey)])
    .filter(([, entryValue]) => entryValue !== undefined));
}

function readJobResumeState(runtimeRoot, jobId, { failurePhase = "", failureReason = "", repairPrompt = "" } = {}) {
  const safeJobId = safeHistoryJobId(jobId);
  const jobDir = path.join(runtimeRoot, "jobs", safeJobId);
  const checkpoint = readJsonObject(path.join(jobDir, "job-checkpoint.json")) || {};
  const researchArtifact = readFirstJsonObject(jobDir, [
    "research-title-result.json",
    "research-title-search-2-result.json",
    "research-title-writer-source-search-result.json",
    "research-title-before-search-2.json",
    "research-title-initial-result.json"
  ]);
  const writerArtifact = readFirstJsonObject(jobDir, [
    "agent-result.json",
    "writer-source-search-before-result-3.json",
    "writer-source-search-before-result-2.json",
    "writer-source-search-before-result-1.json"
  ]);
  const mainReviewArtifact = readFirstJsonObject(jobDir, ["main-review-result.json"]);
  const imageProgressArtifact = readImageProgressArtifacts(jobDir);
  const researchTitleResult = researchArtifact.value;
  const writerResult = writerArtifact.value;
  const mainReviewResult = mainReviewArtifact.value;
  const phase = String(failurePhase || checkpoint.failurePhase || "").trim().toLowerCase();
  let resumeFrom = String(checkpoint.resumeFrom || "").trim().toLowerCase();
  if (!resumeFrom) {
    if (phase === "image" && writerResult && mainReviewResult?.status === "PASS") resumeFrom = "image";
    else if (phase === "main_review" && writerResult) resumeFrom = "main_review";
    else if (phase === "writer" && researchTitleResult) resumeFrom = "writer";
    else if (phase === "research" || (!phase && researchTitleResult)) resumeFrom = "research";
  }
  const hasWriterDraft = Boolean(writerResult && typeof writerResult === "object" && (
    String(writerResult.article || "").trim()
    || String(writerResult.title || "").trim()
  ));
  const hasMainReview = Boolean(mainReviewResult && typeof mainReviewResult === "object" && String(mainReviewResult.status || "").trim());
  if (phase === "image" && hasWriterDraft && hasMainReview) {
    resumeFrom = "image";
  } else if (phase === "main_review" && hasWriterDraft) {
    resumeFrom = "main_review";
  } else if (phase === "writer" && researchTitleResult) {
    resumeFrom = "writer";
  }
  if (resumeFrom === "image" && (!hasWriterDraft || !hasMainReview)) {
    resumeFrom = hasWriterDraft
      ? "main_review"
      : researchTitleResult ? "writer" : "research";
  }
  if (resumeFrom === "main_review" && !hasWriterDraft) {
    resumeFrom = researchTitleResult ? "writer" : "research";
  }
  if (resumeFrom === "writer" && !researchTitleResult) {
    resumeFrom = "research";
  }
  return {
    jobId: safeJobId,
    resumeFrom,
    failurePhase: phase,
    failureReason: String(failureReason || checkpoint.failureReason || "").trim(),
    repairPrompt: String(repairPrompt || checkpoint.repairPrompt || "").trim(),
    researchTitleResult,
    writerResult,
    mainReviewResult,
    imageWorkerResult: imageProgressArtifact.value,
    nextAttempt: Number(checkpoint.nextAttempt || 2),
    maxReviewAttempts: Number(checkpoint.maxReviewAttempts || 3),
    lastCompletedPhase: String(checkpoint.lastCompletedPhase || ""),
    phaseDetail: String(checkpoint.phaseDetail || ""),
    recoveryArtifacts: {
      research: researchArtifact.fileName,
      writer: writerArtifact.fileName,
      mainReview: mainReviewArtifact.fileName,
      imageProgress: imageProgressArtifact.fileName
    },
    updatedAt: checkpoint.updatedAt || ""
  };
}

function writeJobCheckpoint(runtimeRoot, jobId, payload = {}) {
  const safeJobId = safeHistoryJobId(jobId);
  const jobDir = path.join(runtimeRoot, "jobs", safeJobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const checkpointPath = path.join(jobDir, "job-checkpoint.json");
  const previous = readJsonObject(checkpointPath) || {};
  const checkpoint = {
    ...previous,
    version: 1,
    jobId: safeJobId,
    status: payload.status === undefined ? String(previous.status || "paused") : String(payload.status || "paused"),
    resumeFrom: payload.resumeFrom === undefined
      ? String(previous.resumeFrom || "").trim().toLowerCase()
      : String(payload.resumeFrom || "").trim().toLowerCase(),
    failurePhase: payload.failurePhase === undefined ? String(previous.failurePhase || "") : String(payload.failurePhase || ""),
    failureReason: payload.failureReason === undefined ? String(previous.failureReason || "") : String(payload.failureReason || ""),
    repairPrompt: payload.repairPrompt === undefined ? String(previous.repairPrompt || "") : String(payload.repairPrompt || ""),
    nextAttempt: payload.nextAttempt === undefined ? Number(previous.nextAttempt || 2) : Number(payload.nextAttempt || 2),
    maxReviewAttempts: payload.maxReviewAttempts === undefined
      ? Number(previous.maxReviewAttempts || 3)
      : Number(payload.maxReviewAttempts || 3),
    internalDaily: payload.internalDaily === undefined ? previous.internalDaily === true : payload.internalDaily === true,
    lastCompletedPhase: payload.lastCompletedPhase === undefined
      ? String(previous.lastCompletedPhase || "")
      : String(payload.lastCompletedPhase || ""),
    phaseDetail: payload.phaseDetail === undefined ? String(previous.phaseDetail || "") : String(payload.phaseDetail || ""),
    attempt: payload.attempt === undefined ? Number(previous.attempt || 0) : Number(payload.attempt || 0),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
  return checkpoint;
}

function saveJobInput(runtimeRoot, jobId, form = {}) {
  const safeJobId = safeHistoryJobId(jobId);
  const filePath = jobInputPath(runtimeRoot, safeJobId);
  fs.writeFileSync(filePath, JSON.stringify(sanitizeResumeInput(form), null, 2), "utf8");
}

function readJobInput(runtimeRoot, jobId) {
  const value = readJsonObject(jobInputPath(runtimeRoot, jobId));
  if (!value) throw new Error("이 작업을 이어갈 원래 입력값(job-input.json)을 찾을 수 없습니다.");
  return value;
}

function latestResumeCandidate(runtimeRoot) {
  const jobsRoot = path.join(runtimeRoot, "jobs");
  if (!fs.existsSync(jobsRoot)) return null;
  const candidates = fs.readdirSync(jobsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^job_[A-Za-z0-9_-]+$/.test(entry.name))
    .map((entry) => readJsonObject(path.join(jobsRoot, entry.name, "job-checkpoint.json")))
    .filter((checkpoint) => checkpoint?.status === "paused" && checkpoint?.resumeFrom)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  const candidate = candidates[0];
  if (!candidate) return null;
  return {
    jobId: candidate.jobId,
    resumeAvailable: true,
    resumeStage: candidate.resumeFrom,
    resumeReason: candidate.failureReason || "저장된 작업이 중단되었습니다.",
    resumePhaseDetail: candidate.phaseDetail || "",
    lastCompletedPhase: candidate.lastCompletedPhase || "",
    updatedAt: candidate.updatedAt || ""
  };
}

function readHistoryDraft(runtimeRoot, jobId, { allowMissingArtifact = false } = {}) {
  const safeJobId = safeHistoryJobId(jobId);
  const historyItem = readHistory(runtimeRoot).find((item) => String(item.id || "") === safeJobId);
  if (!historyItem) throw new Error("해당 작업 이력을 찾을 수 없습니다.");
  const resultPath = path.join(runtimeRoot, "jobs", safeJobId, "agent-result.json");
  if (!fs.existsSync(resultPath)) {
    if (!allowMissingArtifact) throw new Error("이력에 연결된 초안 파일(agent-result.json)을 찾을 수 없습니다.");
    return {
      jobId: safeJobId,
      historyItem,
      title: String(historyItem.title || historyItem.research_title || historyItem.topic || "").trim(),
      article: "",
      tags: [],
      titleImagePath: "",
      bodyImages: [],
      images: [],
      imageNotes: [],
      sourceMode: historyItem.content_source || "research",
      sourceFiles: Array.isArray(historyItem.source_files) ? historyItem.source_files : [],
      resultPath,
      missingArtifact: true
    };
  }
  let agentResult;
  try {
    agentResult = JSON.parse(fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`이력 초안 파일을 읽을 수 없습니다: ${error.message}`);
  }
  const title = String(agentResult.title || historyItem.title || "").trim();
  const article = String(agentResult.article || "").trim();
  if (!title || !article) throw new Error("이력에 발행 가능한 제목 또는 본문이 없습니다.");
  const assets = normalizeHistoryDraftAssets({
    runtimeRoot,
    jobDir: path.dirname(resultPath),
    historyItem,
    agentResult
  });
  const normalizedResult = {
    ...agentResult,
    title,
    article,
    titleImagePath: assets.titleImagePath,
    bodyImages: assets.bodyImages
  };
  return {
    jobId: safeJobId,
    historyItem,
    title,
    article,
    tags: Array.isArray(agentResult.tags) ? agentResult.tags : [],
    titleImagePath: normalizedResult.titleImagePath,
    bodyImages: normalizedResult.bodyImages,
    images: getPreviewImages(normalizedResult),
    imageNotes: assets.warnings,
    sourceMode: historyItem.content_source || "research",
    sourceFiles: Array.isArray(historyItem.source_files) ? historyItem.source_files : []
  };
}

function readableDraftFile(runtimeRoot, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const candidates = path.isAbsolute(text)
    ? [text]
    : [text, path.resolve(runtimeRoot, text)];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

function hydrateDailyPlanDraftAssets(runtimeRoot, plan, { persist = false } = {}) {
  if (!plan || !Array.isArray(plan.items)) return plan;
  const hydratedPlan = JSON.parse(JSON.stringify(plan));
  const history = readHistory(runtimeRoot);
  let changed = false;

  for (const item of hydratedPlan.items) {
    if (!item?.draftReady || !item.draftJobId) continue;
    let jobId = "";
    try {
      jobId = safeHistoryJobId(item.draftJobId);
    } catch {
      continue;
    }
    const historyItem = history.find((entry) => String(entry.id || "") === jobId) || {
      id: jobId,
      title: item.draftTitle || item.postTitle || "",
      topic: item.postTitle || ""
    };
    const jobDir = path.join(runtimeRoot, "jobs", jobId);
    const resultPath = path.join(jobDir, "agent-result.json");
    if (!fs.existsSync(resultPath)) continue;
    let agentResult;
    try {
      agentResult = JSON.parse(fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    const assets = normalizeHistoryDraftAssets({ runtimeRoot, jobDir, historyItem, agentResult });

    const currentTitleImage = readableDraftFile(runtimeRoot, item.draftTitleImagePath);
    if (!currentTitleImage && assets.titleImagePath) {
      item.draftTitleImagePath = assets.titleImagePath;
      changed = true;
    } else if (currentTitleImage && currentTitleImage !== item.draftTitleImagePath) {
      item.draftTitleImagePath = currentTitleImage;
      changed = true;
    }

    const existingBodyImages = Array.isArray(item.draftBodyImages) ? item.draftBodyImages : [];
    const storedBySequence = new Map(assets.bodyImages.map((image) => [Number(image.sequence), image]));
    const hydratedBodyImages = existingBodyImages
      .map((image) => {
        const sequence = Number(image?.sequence);
        const currentPath = readableDraftFile(runtimeRoot, image?.path);
        if (currentPath) {
          return currentPath === image.path ? image : { ...image, path: currentPath };
        }
        const stored = storedBySequence.get(sequence);
        return stored ? { ...image, ...stored, sequence } : null;
      })
      .filter(Boolean);
    if (!existingBodyImages.length && assets.bodyImages.length) {
      item.draftBodyImages = assets.bodyImages;
      changed = true;
    } else if (JSON.stringify(hydratedBodyImages) !== JSON.stringify(existingBodyImages)) {
      item.draftBodyImages = hydratedBodyImages;
      changed = true;
    }
  }

  if (changed && persist) return writeDailyPlan(runtimeRoot, hydratedPlan);
  return hydratedPlan;
}

function normalizedHistoryQueueTitle(value) {
  return String(value || "")
    .replace(/[\u00a0\s]+/g, " ")
    .trim();
}

async function publishHistoryDraft({ jobId = "", publishVisibility = "", publishScheduleMode = "", expectedTitle = "", queuePosition = 0, queueSize = 0 } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  const draft = readHistoryDraft(runtimeRoot, jobId);
  const requestedTitle = normalizedHistoryQueueTitle(expectedTitle);
  const loadedTitle = normalizedHistoryQueueTitle(draft.title);
  if (requestedTitle && requestedTitle !== loadedTitle) {
    throw new Error(`선택 큐 항목 불일치: ${jobId}의 초안 제목이 '${requestedTitle}'가 아니라 '${loadedTitle}'입니다. 잘못된 글 발행을 방지하기 위해 중단했습니다.`);
  }
  const queueLabel = queuePosition > 0 && queueSize > 0 ? ` [선택 큐 ${queuePosition}/${queueSize}]` : "";
  const historyStatus = String(draft.historyItem.status || "");
  const retryableFailedDraft = ["failed", "session_expired"].includes(historyStatus)
    && Boolean(draft.article)
    && (!draft.historyItem.final_verdict || draft.historyItem.final_verdict === "PASS");
  if (!["DRY_RUN", "generated", "PREVIEW_READY", "READY_TO_PUBLISH"].includes(historyStatus) && !retryableFailedDraft) {
    throw new Error(`현재 상태(${historyStatus || "알 수 없음"})의 이력은 수동 발행 대상이 아닙니다.`);
  }
  if (draft.historyItem.final_verdict && draft.historyItem.final_verdict !== "PASS") {
    throw new Error("최종 검수가 통과되지 않은 이력은 발행할 수 없습니다.");
  }
  const settings = readSettings(runtimeRoot);
  const store = readAccountStore(runtimeRoot, settings);
  const account = store.accounts.find((item) => item.id === draft.historyItem.account_id)
    || store.accounts.find((item) => item.checked !== false)
    || store.accounts[0];
  if (!account) throw new Error("발행에 사용할 네이버 계정을 찾을 수 없습니다.");
  const blogId = String(draft.historyItem.blog_id || account.blogId || account.naverId || "").trim();
  const category = String(draft.historyItem.category || "알아두면 좋은 지식").trim();
  if (!blogId) throw new Error("이력에 네이버 Blog ID가 없습니다.");
  if (!category) throw new Error("이력에 네이버 카테고리 정보가 없습니다.");
  const visibility = "public";
  const publishPrivate = visibility !== "public";
  const scheduleMode = String(publishScheduleMode || settings.publishScheduleMode || "now");
  const publishJobId = `${draft.jobId}-history-publish-${Date.now()}`;
  activeJob = { id: publishJobId, cancelled: false };
  try {
    updateStatus(publishJobId, "publishing", "작업 이력의 초안을 네이버에 발행하는 중");
    safeLog(publishJobId, `작업 이력 ${draft.jobId}${queueLabel}의 초안 발행을 시작합니다: '${draft.title}'`);
    safeLog(publishJobId, `발행 설정: 전체공개 / 카테고리 '${category}'`);
    await publishToNaver({
      blogId,
      category,
      publishPrivate,
      publishVisibility: visibility,
      publishScheduleMode: scheduleMode,
      reserveAfterHours: Number(settings.reserveAfterHours || 3),
      failOnLoginRequired: false,
      title: draft.title,
      article: draft.article,
      titleImagePath: draft.titleImagePath,
      bodyImages: draft.bodyImages,
      breakSentencesInBody: settings.breakSentencesInBody !== false,
      tags: draft.tags,
      domNotes: settings.naverEditorDomNotes || "",
      browserProfileDir: getAccountProfileDir(runtimeRoot, account),
      runtimeRoot,
      reuseBrowserSession: true,
      closeReusableSessionOnSuccess: true,
      log: (message, level) => safeLog(publishJobId, message, level)
    });
    if (account.id) {
      updateAccountSession(runtimeRoot, account.id, "valid", settings);
      emitAccountStore(runtimeRoot);
    }
    markHistoryItemPublished(runtimeRoot, draft.jobId, draft.title, "작업 이력에서 발행 완료");
    appendHistory(runtimeRoot, {
      ...draft.historyItem,
      id: `history-publish-${Date.now()}`,
      create_at: new Date().toISOString(),
      source_job_id: draft.jobId,
      status: "success",
      reason: "작업 이력에서 사용자가 선택하여 네이버 발행 완료"
    });
    writeHistoryPublishFailure(runtimeRoot, draft.jobId, null);
    updateStatus(publishJobId, "PUBLISHED", "작업 이력 발행 완료");
    const history = readHistory(runtimeRoot);
    emit("job:complete", {
      jobId: publishJobId,
      status: "success",
      title: draft.title,
      article: draft.article,
      images: draft.images,
      tags: draft.tags,
      history
    });
    return { status: "success", title: draft.title, history };
  } catch (error) {
    if (error.code === "SESSION_EXPIRED" && account.id) {
      updateAccountSession(runtimeRoot, account.id, "expired", settings);
      emitAccountStore(runtimeRoot);
    }
    safeLog(publishJobId, `작업 이력 발행 실패: ${error.message}`, "error");
    writeHistoryPublishFailure(runtimeRoot, draft.jobId, {
      message: error.message,
      code: error.code || "",
      at: new Date().toISOString()
    });
    updateStatus(publishJobId, error.code === "SESSION_EXPIRED" ? "session_expired" : "failed", error.message);
    throw error;
  } finally {
    activeJob = null;
  }
}

function historyPublishFailurePath(runtimeRoot) {
  return path.join(runtimeRoot, "history-publish-failures.json");
}

function readHistoryPublishFailures(runtimeRoot) {
  const filePath = historyPublishFailurePath(runtimeRoot);
  if (!fs.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeHistoryPublishFailure(runtimeRoot, jobId, failure) {
  const safeJobId = safeHistoryJobId(jobId);
  const failures = readHistoryPublishFailures(runtimeRoot);
  if (failure) failures[safeJobId] = { ...failure };
  else delete failures[safeJobId];
  fs.writeFileSync(historyPublishFailurePath(runtimeRoot), JSON.stringify(failures, null, 2), "utf8");
}

function diagnoseHistoryPublishFailure(errorMessage = "") {
  const message = String(errorMessage || "");
  if (/태그|tagInput|placeholder.*tag/i.test(message)) {
    return {
      diagnosis: "네이버 편집기의 태그 입력칸 선택자가 현재 화면과 맞지 않아 태그 입력 단계에서 중단된 오류입니다.",
      fix: "현재 버전은 태그 입력칸을 못 찾아도 태그만 생략하고 본문 발행을 계속하도록 수정했습니다.",
      action: "네이버 글쓰기 화면을 닫지 말고, 다시 발행하면 태그 없이 본문 발행을 재시도합니다."
    };
  }
  if (/login|session|보안|captcha|로그인|세션/i.test(message)) {
    return {
      diagnosis: "네이버 로그인 세션 또는 보안 확인 단계에서 발행이 중단된 오류입니다.",
      fix: "열린 Chrome에서 로그인·보안 확인을 완료한 뒤 다시 발행할 수 있습니다.",
      action: "Chrome을 닫지 말고 로그인 상태를 확인한 후 재발행하세요."
    };
  }
  return {
    diagnosis: "발행 과정의 입력·편집기·네트워크 단계 중 하나에서 오류가 발생했습니다.",
    fix: "상세 오류 메시지와 열린 Chrome 화면을 확인한 뒤, 수정 후 재발행할 수 있습니다.",
    action: "브라우저를 닫지 않고 문제를 해결한 뒤 재발행하세요."
  };
}

function analyzeHistoryPublishFailure(runtimeRoot, jobId) {
  const draft = readHistoryDraft(runtimeRoot, jobId, { allowMissingArtifact: true });
  const failure = readHistoryPublishFailures(runtimeRoot)[draft.jobId] || {};
  const sourceMessage = failure.message || draft.historyItem.reason || "최근 저장된 발행 실패 메시지가 없습니다.";
  const publishableStatus = ["DRY_RUN", "generated", "PREVIEW_READY", "READY_TO_PUBLISH"].includes(String(draft.historyItem.status || ""));
  const retryableFailedStatus = ["failed", "session_expired"].includes(String(draft.historyItem.status || ""));
  if (draft.missingArtifact) {
    const sourceMaterialPath = path.join(runtimeRoot, "jobs", draft.jobId, "source-material.json");
    const canRegenerate = fs.existsSync(sourceMaterialPath);
    return {
      jobId: draft.jobId,
      title: draft.title,
      status: draft.historyItem.status || "",
      errorMessage: sourceMessage,
      failedAt: failure.at || draft.historyItem.create_at || "",
      diagnosis: "이 이력은 본문 생성 전 Research/Title 단계에서 중단되어 agent-result.json 초안 파일이 생성되지 않았습니다. 따라서 기존 이력을 바로 재발행할 수 없습니다.",
      fix: canRegenerate
        ? "작업 폴더에 보존된 source-material.json을 사용해 초안을 재생성한 뒤 새 초안을 발행할 수 있습니다."
        : "원본 source-material.json과 본문이 없어 이력만으로는 복구할 수 없습니다.",
      action: canRegenerate
        ? "초안 재생성 후 발행을 선택하세요."
        : "원본 파일로 새 작업을 다시 생성해야 합니다.",
      canRetry: false,
      canRegenerate
    };
  }
  return {
    jobId: draft.jobId,
    title: draft.title,
    status: draft.historyItem.status || "",
    errorMessage: sourceMessage,
    failedAt: failure.at || "",
    ...diagnoseHistoryPublishFailure(sourceMessage),
    canRetry: Boolean(draft.article)
      && (publishableStatus || retryableFailedStatus)
      && (!draft.historyItem.final_verdict || draft.historyItem.final_verdict === "PASS")
  };
}

async function regenerateHistoryDraft({ jobId = "" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  const draft = readHistoryDraft(runtimeRoot, jobId, { allowMissingArtifact: true });
  const sourceMaterialPath = path.join(runtimeRoot, "jobs", draft.jobId, "source-material.json");
  if (!fs.existsSync(sourceMaterialPath)) {
    throw new Error("복구에 필요한 source-material.json을 찾을 수 없습니다.");
  }
  let sourceMaterial;
  try {
    sourceMaterial = JSON.parse(fs.readFileSync(sourceMaterialPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`복구 원본 파일을 읽을 수 없습니다: ${error.message}`);
  }
  const sourceDocuments = normalizeSourceDocuments(sourceMaterial?.documents);
  if (!sourceDocuments.length) throw new Error("복구 원본에 읽을 수 있는 문서가 없습니다.");
  const settings = readSettings(runtimeRoot);
  const store = readAccountStore(runtimeRoot, settings);
  const account = store.accounts.find((item) => item.id === draft.historyItem.account_id)
    || store.accounts.find((item) => item.checked !== false)
    || store.accounts[0];
  if (!account) throw new Error("복구에 사용할 네이버 계정을 찾을 수 없습니다.");
  const category = String(draft.historyItem.category || "알아두면 좋은 지식").trim();
  const topic = String(draft.historyItem.topic || draft.historyItem.research_title || draft.title || sourceDocuments[0]?.title || "파일 원문 기반 콘텐츠").trim();
  const keyword = String(draft.historyItem.keyword || category).trim();
  safeLog("history-recovery", `이력 ${draft.jobId}의 초안 재생성을 시작합니다. 원문 ${sourceDocuments.length}개 / 카테고리 '${category}'`);
  const result = await startJob({
    internalHistoryRecovery: true,
    allowHistoricalFileDraft: true,
    accountId: account.id || "",
    blogId: draft.historyItem.blog_id || account.blogId || account.naverId || "",
    topicMode: "manual",
    sourceMode: "file_upload",
    sourceDocuments,
    sourceConflicts: Array.isArray(sourceMaterial.conflicts) ? sourceMaterial.conflicts : [],
    topic,
    category,
    keyword,
    excludedTopics: settings.excludedTopics || "",
    publishPurpose: `원문 날짜와 사실 범위 안에서 작성합니다. 현재 제도나 최신 상황으로 확대 해석하지 마세요. ${settings.publishPurpose || ""}`.trim(),
    preferredTone: settings.preferredTone || "읽기 쉬운 정보 전달형 문체",
    publishAfterGenerate: false,
    publishToTistoryAfterNaver: false,
    includeTitleImage: settings.includeTitleImage !== false,
    titleImageAspectRatio: settings.titleImageAspectRatio,
    bodyImageAspectRatio: settings.bodyImageAspectRatio,
    maxBodyImages: settings.maxBodyImages,
    breakSentencesInBody: settings.breakSentencesInBody !== false,
    codexModel: settings.codexModel,
    agentModels: settings.agentModels || {},
    freshnessLevel: "none",
    failOnLoginRequired: false
  });
  if (!result || !["DRY_RUN", "success", "generated"].includes(result.status)) {
    throw new Error(result?.reason || "초안 재생성 결과를 받지 못했습니다.");
  }
  return {
    status: "generated",
    sourceJobId: draft.jobId,
    jobId: result.jobId,
    title: result.title || "",
    history: readHistory(runtimeRoot)
  };
}

async function publishHistoryDrafts({ jobIds = [], expectedTitles = {}, publishVisibility = "", publishScheduleMode = "" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const uniqueJobIds = [...new Set((Array.isArray(jobIds) ? jobIds : []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!uniqueJobIds.length) throw new Error("선택된 이력 발행 항목이 없습니다.");

  const results = [];
  for (let index = 0; index < uniqueJobIds.length; index += 1) {
    const selectedJobId = uniqueJobIds[index];
    try {
      const result = await publishHistoryDraft({
        jobId: selectedJobId,
        expectedTitle: expectedTitles && typeof expectedTitles === "object" ? expectedTitles[selectedJobId] : "",
        queuePosition: index + 1,
        queueSize: uniqueJobIds.length,
        publishVisibility,
        publishScheduleMode
      });
      results.push({ jobId: selectedJobId, status: "success", title: result.title || "" });
    } catch (error) {
      results.push({ jobId: selectedJobId, status: "failed", reason: error.message });
      break;
    }
  }
  const completed = results.filter((item) => item.status === "success").length;
  const paused = results.some((item) => item.status === "failed") || completed < uniqueJobIds.length;
  return {
    status: paused ? "paused" : "success",
    completed,
    requested: uniqueJobIds.length,
    results,
    history: readHistory(getRuntimeRoot())
  };
}

function markHistorySuccess({ jobIds = [], reason = "사용자가 외부에서 수동 발행한 것으로 표시" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : [jobIds])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!ids.length) throw new Error("성공 처리할 작업 이력을 선택하세요.");
  const result = markHistoryItemsSuccess(runtimeRoot, ids, reason);
  if (!result.updated) throw new Error("선택한 작업 이력을 찾지 못했습니다.");
  for (const jobId of ids) writeHistoryPublishFailure(runtimeRoot, jobId, null);
  const message = `작업 이력 ${result.updated}건을 성공으로 표시했습니다.`;
  safeLog("history-manual-status", message);
  return { status: "success", updated: result.updated, history: result.history };
}

function updateHistoryCategory({ jobId = "", category = "" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 작업 실행 중에는 카테고리를 변경할 수 없습니다.");
  const runtimeRoot = getRuntimeRoot();
  const result = updateHistoryItemCategory(runtimeRoot, jobId, category);
  safeLog("history-category", `작업 이력 카테고리를 '${result.category}'로 저장했습니다.`);
  return { status: "success", ...result };
}

function deleteHistoryRecords({ jobIds = [] } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : [jobIds])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!ids.length) throw new Error("삭제할 작업 이력을 선택하세요.");
  const result = deleteHistoryItems(runtimeRoot, ids);
  if (!result.deleted) throw new Error("선택한 작업 이력을 찾지 못했습니다.");
  for (const jobId of ids) writeHistoryPublishFailure(runtimeRoot, jobId, null);
  safeLog("history-delete", `작업 이력 ${result.deleted}건을 삭제했습니다. 원본 작업 파일은 보존됩니다.`);
  return { status: "success", deleted: result.deleted, history: result.history };
}

function updateDailyItemCategory({ date = "", itemId = "", category = "" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 작업 실행 중에는 카테고리를 변경할 수 없습니다.");
  const nextCategory = String(category || "").trim();
  if (!nextCategory) throw new Error("발행 카테고리를 입력하세요.");
  const runtimeRoot = getRuntimeRoot();
  const item = updatePlanItem(runtimeRoot, date, itemId, {
    blogCategory: nextCategory,
    blogDisplayCategory: nextCategory,
    categoryUpdatedAt: new Date().toISOString()
  });
  safeLog("daily-plan", `[${item.slot || "-"}/9] 블로그 발행 카테고리를 '${nextCategory}'로 저장했습니다.`);
  return { status: "success", item };
}

function persistCodexRateLimits(runtimeRoot, rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  return writeSettings(runtimeRoot, { codexRateLimits: rateLimits });
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function accountAssetDir(runtimeRoot, accountId) {
  return path.join(runtimeRoot, "account-assets", String(accountId || "unknown"));
}

function accountSampleImagePath(runtimeRoot, accountId, sourcePath) {
  const ext = path.extname(String(sourcePath || "")).toLowerCase();
  const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
  return path.join(accountAssetDir(runtimeRoot, accountId), `sample${safeExt}`);
}

function withAccountImageUrls(runtimeRoot, store) {
  return {
    ...store,
    accounts: (store.accounts || []).map((account) => {
      const sampleImagePath = String(account.sampleImagePath || "");
      const sampleImageUrl = sampleImagePath && fs.existsSync(sampleImagePath)
        ? pathToFileURL(sampleImagePath).toString()
        : "";
      return { ...account, sampleImageUrl };
    })
  };
}

function emitAccountStore(runtimeRoot) {
  emit("accounts:update", withAccountImageUrls(runtimeRoot, readAccountStore(runtimeRoot, readSettings(runtimeRoot))));
}

function sessionKeyFor(account, browserProfileDir) {
  return account?.id || browserProfileDir;
}

function safeProfileSegment(value) {
  return String(value || "profile")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function getTistoryProfileDir(runtimeRoot, tistoryBlogId) {
  return path.join(runtimeRoot, "browser-profiles", safeProfileSegment(`tistory_${tistoryBlogId || "default"}`));
}

function tistorySessionKey(tistoryBlogId, browserProfileDir) {
  return String(tistoryBlogId || "") || browserProfileDir;
}

function crc32(buffer) {
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
  }));
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createTistoryTestPng(width = 640, height = 360) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      raw[offset] = Math.floor(40 + (x / Math.max(1, width - 1)) * 150);
      raw[offset + 1] = Math.floor(90 + (y / Math.max(1, height - 1)) * 120);
      raw[offset + 2] = 210;
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND")
  ]);
}

function ensureTistoryTestImage(runtimeRoot) {
  const dir = path.join(runtimeRoot, "test-assets");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "tistory-test-image.png");
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, createTistoryTestPng());
  }
  return filePath;
}

function buildTistoryTestArticle() {
  return [
    "[SECTION - 편집기 입력 테스트]",
    "이 글은 티스토리 전용 자동화 테스트 글입니다.",
    "네이버 세션 확인, 본문 생성, 이미지 생성, 네이버 발행 과정을 건너뛰고 티스토리 입력과 발행 흐름만 확인합니다.",
    "",
    "[IMAGE INSERT - 1]",
    "",
    "[SECTION - 발행 흐름 테스트]",
    "이 글이 티스토리 글 목록에 보이면 카카오 로그인, 제목 입력, 본문 입력, 이미지 업로드, 카테고리 선택, 최종 발행 단계까지 도달한 것입니다."
  ].join("\n");
}

function detectChromeInstall() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  const chromePath = candidates.find((candidate) => fs.existsSync(candidate));
  return {
    available: Boolean(chromePath),
    path: chromePath || ""
  };
}

async function closeNaverSession(key) {
  const session = activeNaverSessions.get(key);
  if (!session) return;
  activeNaverSessions.delete(key);
  await session.context?.close().catch(() => {});
}

async function closeTistorySession(key) {
  const session = activeTistorySessions.get(key);
  if (!session) return;
  activeTistorySessions.delete(key);
  await session.context?.close().catch(() => {});
}

function reusableNaverSession(key) {
  const session = activeNaverSessions.get(key);
  if (!session?.context || session.page?.isClosed?.()) {
    activeNaverSessions.delete(key);
    return null;
  }
  return session;
}

function reusableTistorySession(key) {
  const session = activeTistorySessions.get(key);
  if (!session?.context || session.page?.isClosed?.()) {
    activeTistorySessions.delete(key);
    return null;
  }
  return session;
}

function sanitizeNaverTag(value) {
  return String(value || "")
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function buildTags(topic, keyword, articleTags) {
  const raw = [
    topic,
    keyword,
    ...(Array.isArray(articleTags) ? articleTags : [])
  ]
    .flatMap((item) => String(item || "").split(/[,\n#]+/))
    .map(sanitizeNaverTag)
    .filter(Boolean);

  return [...new Set(raw)].slice(0, 29);
}

function clearPendingNaverPublishDraft(runtimeRoot) {
  writeSettings(runtimeRoot, { pendingNaverPublishDraft: null });
}

function pendingDraftMatches(draft, { account, blogId, category } = {}) {
  if (!draft || typeof draft !== "object") return false;
  const accountId = String(account?.id || "");
  return String(draft.accountId || "") === accountId
    && String(draft.blogId || "") === String(blogId || "")
    && String(draft.category || "") === String(category || "")
    && String(draft.status || "") === "pending_naver_publish";
}

function buildPendingNaverPublishDraft({
  jobId,
  account,
  blogId,
  category,
  topic,
  keyword,
  agentResult,
  tags,
  publishPrivate,
  publishVisibility,
  publishScheduleMode,
  reserveAfterHours,
  breakSentencesInBody,
  publishToTistoryAfterNaver,
  tistoryBlogId,
  latestLaneResult,
  researchTitleResult,
  tokenUsage
}) {
  if (!agentResult?.title || !agentResult?.article) return null;
  return {
    status: "pending_naver_publish",
    jobId,
    createdAt: new Date().toISOString(),
    accountId: account?.id || "",
    blogId,
    category,
    topic,
    keyword,
    title: agentResult.title,
    article: agentResult.article,
    titleImagePath: agentResult.titleImagePath || "",
    bodyImages: Array.isArray(agentResult.bodyImages) ? agentResult.bodyImages : [],
    tags: Array.isArray(tags) ? tags : [],
    publishPrivate,
    publishVisibility,
    publishScheduleMode,
    reserveAfterHours,
    breakSentencesInBody,
    publishToTistoryAfterNaver,
    tistoryBlogId,
    keywordLane: keywordLaneResultPayload(latestLaneResult),
    researchTitle: researchTitleResult?.finalTitle || researchTitleResult?.selectedTitle || "",
    factBased: researchTitleResult?.factBased === true,
    sourceSummary: researchTitleResult?.searchFlowSummary || "",
    tokenTotal: Number(tokenUsage?.total || 0)
  };
}

function normalizeKeywordLane(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const parts = text.split(" ");
  if (parts.length % 2 === 0) {
    const half = parts.length / 2;
    if (parts.slice(0, half).join(" ") === parts.slice(half).join(" ")) {
      return parts.slice(0, half).join(" ");
    }
  }
  return text;
}

function splitKeywordLanes(keyword) {
  const seen = new Set();
  return String(keyword || "")
    .split(/[,\n]+/)
    .map(normalizeKeywordLane)
    .filter(Boolean)
    .filter((lane) => {
      const key = lane.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((phrase, index) => ({ index: index + 1, phrase }));
}

function keywordLaneFromEntry(entry) {
  return String(entry?.topic_lane || entry?.topicLane || "").trim();
}

function buildKeywordLanePlan(keyword, history = [], { blogId = "", category = "", excludedKeywordLanes = [] } = {}) {
  const allLanes = splitKeywordLanes(keyword);
  const excluded = new Set((Array.isArray(excludedKeywordLanes) ? excludedKeywordLanes : [])
    .map((lane) => String(lane || "").trim().toLowerCase())
    .filter(Boolean));
  const availableLanes = allLanes.filter((lane) => !excluded.has(lane.phrase.toLowerCase()));
  const lanes = availableLanes.length ? availableLanes : allLanes;
  const scopedHistory = (Array.isArray(history) ? history : [])
    .filter((entry) => !blogId || String(entry?.blog_id || "") === blogId)
    .filter((entry) => !category || String(entry?.category || "") === category || String(entry?.keyword || "") === String(keyword || ""));
  const usage = new Map(lanes.map((lane) => [lane.phrase.toLowerCase(), { count: 0, lastCreateAt: "" }]));
  for (const entry of scopedHistory) {
    const lane = keywordLaneFromEntry(entry);
    if (!lane) continue;
    const key = lane.toLowerCase();
    if (!usage.has(key)) continue;
    const stat = usage.get(key);
    stat.count += 1;
    stat.lastCreateAt = [stat.lastCreateAt, String(entry.create_at || "")].sort().pop() || stat.lastCreateAt;
  }
  const recommended = [...lanes].sort((a, b) => {
    const aStat = usage.get(a.phrase.toLowerCase()) || { count: 0, lastCreateAt: "" };
    const bStat = usage.get(b.phrase.toLowerCase()) || { count: 0, lastCreateAt: "" };
    if (aStat.count !== bStat.count) return aStat.count - bStat.count;
    if (aStat.lastCreateAt !== bStat.lastCreateAt) return String(aStat.lastCreateAt).localeCompare(String(bStat.lastCreateAt));
    return a.index - b.index;
  });
  return { lanes, recommended, usage: Object.fromEntries([...usage.entries()]) };
}

function normalizeResearchLaneResult(researchResult, lanePlan) {
  const lanes = Array.isArray(lanePlan?.lanes) ? lanePlan.lanes : [];
  const byIndex = new Map(lanes.map((lane) => [lane.index, lane]));
  const byPhrase = new Map(lanes.map((lane) => [lane.phrase.toLowerCase(), lane]));
  const selected = [];
  for (const index of Array.isArray(researchResult?.selectedKeywordIndexes) ? researchResult.selectedKeywordIndexes : []) {
    const lane = byIndex.get(Number(index));
    if (lane && !selected.some((item) => item.index === lane.index)) selected.push(lane);
  }
  for (const phrase of [
    researchResult?.topicLane,
    ...(Array.isArray(researchResult?.selectedKeywordPhrases) ? researchResult.selectedKeywordPhrases : [])
  ]) {
    const lane = byPhrase.get(String(phrase || "").trim().toLowerCase());
    if (lane && !selected.some((item) => item.index === lane.index)) selected.push(lane);
  }
  const fallback = Array.isArray(lanePlan?.recommended) ? lanePlan.recommended[0] : null;
  if (!selected.length && fallback) selected.push(fallback);
  const topicLane = String(researchResult?.topicLane || selected[0]?.phrase || "").trim();
  const lanePhrases = lanes.map((lane) => lane.phrase.toLowerCase());
  const searchQueries = (Array.isArray(researchResult?.searchQueries) ? researchResult.searchQueries : [])
    .map((query) => String(query || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((query) => {
      if (query.length > 120) return false;
      const lower = query.toLowerCase();
      const matchedLaneCount = lanePhrases.filter((phrase) => phrase && lower.includes(phrase)).length;
      return matchedLaneCount <= 2;
    })
    .slice(0, 4);
  return {
    topicLane,
    selectedKeywordIndexes: selected.map((lane) => lane.index),
    selectedKeywordPhrases: selected.map((lane) => lane.phrase),
    searchQueries
  };
}

function keywordLaneHistoryFields(laneResult = {}) {
  return {
    topic_lane: String(laneResult.topicLane || ""),
    selected_keyword_indexes: Array.isArray(laneResult.selectedKeywordIndexes) ? laneResult.selectedKeywordIndexes : [],
    selected_keyword_phrases: Array.isArray(laneResult.selectedKeywordPhrases) ? laneResult.selectedKeywordPhrases : [],
    search_queries: Array.isArray(laneResult.searchQueries) ? laneResult.searchQueries : []
  };
}

function keywordLaneResultPayload(laneResult = {}) {
  return {
    topicLane: String(laneResult.topicLane || ""),
    selectedKeywordIndexes: Array.isArray(laneResult.selectedKeywordIndexes) ? laneResult.selectedKeywordIndexes : [],
    selectedKeywordPhrases: Array.isArray(laneResult.selectedKeywordPhrases) ? laneResult.selectedKeywordPhrases : [],
    searchQueries: Array.isArray(laneResult.searchQueries) ? laneResult.searchQueries : []
  };
}

function mergeSearchResults(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const key = String(item?.url || item?.fetchedUrl || "").replace(/[#?].*$/, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged.slice(0, 20).map((item, index) => ({
    ...item,
    sourceId: item.sourceId || `${item.provider || "source"}-${index + 1}`
  }));
}

function selectSearchTopicForResearch(researchResult, context = {}) {
  const topicMode = String(context.topicMode || "manual").toLowerCase();
  const directTopic = String(context.topic || "").trim();
  if (topicMode === "manual" && directTopic) return directTopic;
  return String(
    researchResult?.finalTitle
    || researchResult?.selectedTitle
    || directTopic
    || `${context.category || ""} ${context.keyword || ""}`.trim()
  ).replace(/\s+/g, " ").trim();
}

function uniqueSearchQueries(values, limit = 4) {
  const seen = new Set();
  const queries = [];
  for (const value of Array.isArray(values) ? values : []) {
    const query = String(value || "").replace(/\s+/g, " ").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query.slice(0, 120));
    if (queries.length >= limit) break;
  }
  return queries;
}

function flattenSearchIntentParts(value, output = []) {
  if (value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenSearchIntentParts(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) flattenSearchIntentParts(item, output);
    return output;
  }
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text) output.push(text);
  return output;
}

function cleanSearchIntentPhrase(value) {
  return String(value || "")
    .replace(/^[\s"'\[\]{}()<>]+|[\s"'\[\]{}()<>]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectResearchIntentPhrases(researchResult, limit = 8) {
  const rawParts = flattenSearchIntentParts([
    researchResult?.coreQuestions,
    researchResult?.mustCover,
    researchResult?.uncertainItems,
    researchResult?.notes,
    researchResult?.writerBrief,
    researchResult?.writerContract?.mustAnswer,
    researchResult?.writerContract?.mustCover,
    researchResult?.writerContract?.uncertainItems,
    researchResult?.writerContract?.sourceBoundaries
  ]);
  const seen = new Set();
  const phrases = [];
  for (const part of rawParts) {
    const chunks = String(part || "").split(/[,\n\r;|/]+|(?:\s+-\s+)|(?:\.\s+)/);
    for (const chunk of chunks) {
      const phrase = cleanSearchIntentPhrase(chunk);
      if (phrase.length < 2 || phrase.length > 70) continue;
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
      if (phrases.length >= limit) return phrases;
    }
  }
  return phrases;
}

function buildResearchIntentSearchQueries(researchResult, laneResult = {}, searchTopic = "") {
  const selectedTopic = cleanSearchIntentPhrase(
    researchResult?.finalTitle
    || researchResult?.selectedTitle
    || researchResult?.topicThesis
    || searchTopic
    || ""
  );
  const lane = cleanSearchIntentPhrase(
    laneResult.topicLane
    || (Array.isArray(laneResult.selectedKeywordPhrases) ? laneResult.selectedKeywordPhrases[0] : "")
    || ""
  );
  const phrases = collectResearchIntentPhrases(researchResult, 6);
  const candidates = [];
  for (const phrase of phrases) {
    if (selectedTopic) candidates.push(`${selectedTopic} ${phrase}`);
    if (lane && phrase !== lane) candidates.push(`${lane} ${phrase}`);
  }
  if (selectedTopic && lane && !selectedTopic.includes(lane)) {
    candidates.push(`${selectedTopic} ${lane}`);
  }
  return uniqueSearchQueries(candidates, 4);
}

function buildResearchIntentGuidance(researchResult, context = {}) {
  const phrases = collectResearchIntentPhrases(researchResult, 10);
  const writerIssue = cleanSearchIntentPhrase(context.writerIssueReason || "");
  return [
    writerIssue,
    ...phrases
  ].filter(Boolean).join(" ");
}

function authorityEvidenceText(researchResult, searchTopic = "", sourceQuality = null) {
  return flattenSearchIntentParts([
    searchTopic,
    sourceQuality?.reason,
    researchResult?.finalTitle,
    researchResult?.selectedTitle,
    researchResult?.topicThesis,
    researchResult?.topicLane,
    researchResult?.selectedKeywordPhrases,
    researchResult?.searchQueries,
    researchResult?.failureReason,
    researchResult?.searchFlowSummary,
    researchResult?.writerBrief,
    researchResult?.coreQuestions,
    researchResult?.mustCover,
    researchResult?.uncertainItems,
    researchResult?.notes,
    researchResult?.writerContract?.sourceBoundaries,
    researchResult?.writerContract?.mustAnswer,
    researchResult?.writerContract?.mustCover,
    researchResult?.writerContract?.uncertainItems
  ]).join(" ");
}

function collectAuthorityEvidenceTerms(researchResult, searchTopic = "", sourceQuality = null, limit = 8) {
  const text = authorityEvidenceText(researchResult, searchTopic, sourceQuality);
  const groups = [
    {
      pattern: /(신청|접수|모집|채용|지원금|지원\s*대상|지원\s*조건|정책\s*자금|대출|보조금|자격|마감|공고)/i,
      terms: ["공식 공고", "신청 조건", "대상 자격", "접수 기간"]
    },
    {
      pattern: /(공시|계약|수주|공급계약|IR|investor|투자자|실적|잠정실적|매출|영업이익|배당|자사주)/i,
      terms: ["공시", "IR", "투자자 자료", "계약 원문"]
    },
    {
      pattern: /(보고서|전망|지표|지수|통계|데이터|등급|신용평가|산업\s*전망|수주잔고|선가|시장\s*자료)/i,
      terms: ["보고서", "지표", "통계", "원문", "PDF"]
    },
    {
      pattern: /(발표|출시|공개|업데이트|로드맵|제품|모델|기술|launch|release|announcement|unveil)/i,
      terms: ["공식 발표", "뉴스룸", "자료", "원문"]
    },
    {
      pattern: /(법령|법률|규제|세금|세무|의료|보험|허가|인증)/i,
      terms: ["법령", "고시", "기관 원문", "PDF"]
    }
  ];
  const terms = [];
  for (const group of groups) {
    if (group.pattern.test(text)) {
      terms.push(...group.terms);
    }
  }
  if (/PDF|원문|공식|기관|자료/i.test(text)) {
    terms.push("공식 자료", "원문", "PDF");
  }
  return uniqueSearchQueries(terms.length ? terms : ["공식 자료", "원문", "보고서", "PDF"], limit);
}

function collectAuthoritySubjectPhrases(researchResult, searchTopic = "", limit = 5) {
  const rawParts = flattenSearchIntentParts([
    researchResult?.finalTitle,
    researchResult?.selectedTitle,
    researchResult?.topicLane,
    researchResult?.selectedKeywordPhrases,
    researchResult?.searchQueries,
    searchTopic,
    researchResult?.topicThesis,
    researchResult?.coreQuestions,
    researchResult?.uncertainItems,
    researchResult?.writerContract?.uncertainItems
  ]);
  const seen = new Set();
  const phrases = [];
  for (const part of rawParts) {
    const chunks = String(part || "").split(/[,\n\r;|/?]+|(?:\s+-\s+)|(?:\.\s+)/);
    for (const chunk of chunks) {
      let phrase = cleanSearchIntentPhrase(chunk)
        .replace(/^(최신|정확한|현재|공식|기관|원문|다음|확인|필요|여부)\s+/g, "")
        .replace(/\s+(무엇인가|무엇인지|어떤가|확인해야 합니다|확인 필요)$/g, "")
        .trim();
      if (phrase.length < 3 || phrase.length > 80) continue;
      if (/^(공식|기관|원문|보고서|자료|PDF|확인|필요)$/i.test(phrase)) continue;
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
      if (phrases.length >= limit) return phrases;
    }
  }
  return phrases;
}

function needsAuthorityRecheckQueries(researchResult, sourceQuality = null) {
  if (sourceQuality?.authorityEvidenceRequired === true && Number(sourceQuality?.authorityEvidenceCandidates || 0) === 0) return true;
  const text = [
    researchResult?.failureReason,
    researchResult?.searchFlowSummary,
    researchResult?.writerBrief,
    researchResult?.coreQuestions,
    researchResult?.mustCover,
    researchResult?.uncertainItems,
    researchResult?.notes
  ].flat().filter(Boolean).join(" ");
  return /(공고|잡알리오|모집\s*기간|신청\s*조건|접수\s*기간|지원\s*조건|지원\s*대상|채용|인턴|지원금|정책\s*자금|대출|보조금|법령|법률|세금|세무|자격|마감)/i.test(text);
}

function buildAuthorityRecheckQueries(researchResult, searchTopic, sourceQuality = null) {
  if (!needsAuthorityRecheckQueries(researchResult, sourceQuality)) return [];
  const subjects = collectAuthoritySubjectPhrases(researchResult, searchTopic, 5);
  const evidenceTerms = collectAuthorityEvidenceTerms(researchResult, searchTopic, sourceQuality, 8);
  if (!subjects.length || !evidenceTerms.length) return [];
  const evidenceBundle = evidenceTerms.slice(0, 4).join(" ");
  const secondaryBundle = evidenceTerms.slice(2, 6).join(" ") || evidenceBundle;
  const candidates = [
    `${subjects[0]} ${evidenceBundle}`,
    subjects[1] ? `${subjects[1]} ${secondaryBundle}` : "",
    subjects[2] ? `${subjects[2]} ${evidenceTerms.slice(0, 3).join(" ")}` : ""
  ];
  return uniqueSearchQueries(candidates, 3);
}

function detectCodexSourceFailure(result) {
  const status = String(result?.status || "").toLowerCase();
  const explicitReason = String(result?.failureReason || result?.reason || "").trim();
  if (["failed", "failure", "source_failed", "insufficient_sources"].includes(status)) {
    return explicitReason || "본문 발췌 실패: Codex가 발행 가능한 근거 자료를 확보하지 못했습니다.";
  }
  if (explicitReason) return explicitReason;
  return "";
}

function normalizeTopicTitle(title, fallback) {
  const cleaned = String(title || "")
    .replace(/\s*[-|:]\s*(네이버|NAVER|Google|구글|뉴스|블로그|카페).*$/i, "")
    .replace(/\[[^\]]*(광고|AD|Sponsored)[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function todayLabel() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
}

async function resolveTopicInput(form, category, log) {
  const topicMode = String(form.topicMode || "manual");
  const manualTopic = String(form.topic || "").trim();
  const manualKeyword = String(form.keyword || "").trim();

  if (topicMode !== "auto") {
    return {
      topic: manualTopic,
      keyword: manualKeyword
    };
  }

  const seedKeyword = manualKeyword || category;
  log("자동 주제 모드: 카테고리와 키워드를 Research/Title Agent에 전달합니다.");
  return {
    topic: "",
    keyword: seedKeyword
  };
}

function resolveAccount(form, accountStore) {
  const accountId = String(form.accountId || "").trim();
  const account = accountStore.accounts.find((item) => item.id === accountId);
  if (account) return account;
  return {
    id: accountId,
    label: String(form.blogId || "").trim() || "Naver 계정",
    blogId: String(form.blogId || "").trim(),
    sessionStatus: "unknown",
    categories: []
  };
}

function createSessionExpiredError(reason = "네이버 세션이 만료되어 사용자 로그인이 필요합니다.") {
  const error = new Error(reason);
  error.code = "SESSION_EXPIRED";
  return error;
}

async function verifyPublishSessionBeforeGeneration({ runtimeRoot, account, blogId, form, settings, jobId }) {
  const browserProfileDir = getAccountProfileDir(runtimeRoot, account);
  const sessionKey = sessionKeyFor(account, browserProfileDir);
  updateStatus(jobId, "publishing", "Naver 글쓰기 편집기 확인");
  safeLog(jobId, "본문 생성 전 Naver 계정 로그인 세션과 블로그 글쓰기 편집기 화면을 먼저 확인합니다.");
  safeLog(jobId, `계정 profile: ${browserProfileDir}`);
  const cached = reusableNaverSession(sessionKey);
  if (cached) {
    safeLog(jobId, "이미 확인된 글쓰기 편집기 브라우저 세션을 재사용합니다.");
    return cached;
  }

  let result;
  try {
    result = await checkNaverSession({
      blogId,
      browserProfileDir,
      interactiveLogin: true,
      keepOpen: true,
      requireEditor: true,
      domNotes: form.naverEditorDomNotes || "",
      runtimeRoot,
      log: (message, level) => safeLog(jobId, message, level)
    });
  } catch (error) {
    if (error.code === "SESSION_EXPIRED" && account.id) {
      updateAccountSession(runtimeRoot, account.id, "expired", settings);
      emitAccountStore(runtimeRoot);
    }
    throw error;
  }
  if (result.status !== "valid" || !result.preparedSession) {
    throw createSessionExpiredError("Naver 로그인 세션을 확인하지 못했습니다. 먼저 계정관리에서 세션확인을 완료해 주세요.");
  }

  if (account.id) {
    updateAccountSession(runtimeRoot, account.id, "valid", settings);
    emitAccountStore(runtimeRoot);
  }
  const prepared = result.preparedSession;
  activeNaverSessions.set(sessionKey, prepared);
  safeLog(jobId, "Naver 글쓰기 편집기 준비 결과를 앱에 저장했습니다.");
  safeLog(jobId, "Naver 글쓰기 편집기 확인 완료. Research/Title Agent를 시작합니다.");
  return prepared;
}

async function verifyTistorySessionBeforeGeneration({ runtimeRoot, form, settings, jobId }) {
  const tistoryBlogId = String(form.tistoryBlogId || settings.tistoryBlogId || "").trim();
  const browserProfileDir = getTistoryProfileDir(runtimeRoot, tistoryBlogId);
  const key = tistorySessionKey(tistoryBlogId, browserProfileDir);
  updateStatus(jobId, "publishing", "티스토리 편집기 세션 확인");
  safeLog(jobId, `티스토리 프로필: ${browserProfileDir}`);
  try {
    const existingSession = reusableTistorySession(key);
    if (existingSession) {
      writeSettings(runtimeRoot, {
        tistorySessionStatus: "valid",
        tistorySessionCheckedAt: new Date().toISOString()
      });
      safeLog(jobId, "열려 있는 티스토리 편집기 세션을 재사용합니다.");
      return {
        status: "valid",
        reason: "reused_open_tistory_editor",
        url: existingSession.page?.url?.() || "",
        browserProfileDir,
        preparedSession: existingSession,
        page: existingSession.page
      };
    }
    const result = await checkTistorySession({
      tistoryBlogId,
      browserProfileDir,
      runtimeRoot,
      failOnLoginRequired: true,
      keepOpen: true,
      log: (message, level) => safeLog(jobId, message, level)
    });
    if (result.preparedSession) {
      activeTistorySessions.set(key, result.preparedSession);
    }
    writeSettings(runtimeRoot, {
      tistorySessionStatus: result.status === "valid" ? "valid" : "unknown",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    if (result.status !== "valid") {
      safeLog(jobId, "티스토리 세션이 유효하지 않습니다. 네이버 발행은 계속 진행하고 티스토리 발행은 건너뜁니다.", "warn");
      return {
        status: "expired",
        reason: "티스토리 발행 전에 카카오 로그인이 필요합니다."
      };
    }
    safeLog(jobId, "티스토리 편집기 세션 확인 완료.");
    return result;
  } catch (error) {
    writeSettings(runtimeRoot, {
      tistorySessionStatus: "expired",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    safeLog(jobId, `티스토리 세션 확인에 실패했습니다. 네이버 발행은 계속 진행하고 티스토리 발행은 건너뜁니다: ${error.message}`, "warn");
    return {
      status: "expired",
      reason: error.message
    };
  }
}

async function startTistoryTestPublish(form = {}) {
  if (activeJob) {
    throw new Error("이미 실행 중인 작업이 있습니다.");
  }

  const runtimeRoot = getRuntimeRoot();
  ensureRuntimeFiles(runtimeRoot);
  ensureSettingsFile(runtimeRoot);
  const settings = readSettings(runtimeRoot);
  const jobId = `tistory_test_${Date.now()}`;
  activeJob = { id: jobId, cancelled: false };

  const tistoryBlogId = String(form.tistoryBlogId || settings.tistoryBlogId || "").trim();
  if (!tistoryBlogId) {
    activeJob = null;
    throw new Error("티스토리 블로그 ID가 필요합니다.");
  }

  const imagePath = ensureTistoryTestImage(runtimeRoot);
  const browserProfileDir = getTistoryProfileDir(runtimeRoot, tistoryBlogId);
  const tistoryKey = tistorySessionKey(tistoryBlogId, browserProfileDir);
  const preparedTistorySession = reusableTistorySession(tistoryKey);
  const title = `[티스토리 테스트] ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
  const article = buildTistoryTestArticle();
  const images = [{
    role: "body",
    sequence: 1,
    path: imagePath,
    url: pathToFileURL(imagePath).toString()
  }];
  const publishVisibility = String(form.publishVisibility || settings.publishVisibility || (settings.publishPrivate === false ? "public" : "private"));
  const publishScheduleMode = String(form.publishScheduleMode || settings.publishScheduleMode || "now");
  const reserveAfterHours = Number(form.reserveAfterHours || settings.reserveAfterHours || 0);
  const publishPrivate = publishVisibility !== "public";

  emit("job:preview", {
    jobId,
    title,
    article,
    images,
    imageNotes: ["티스토리 전용 테스트 이미지가 로컬에서 생성되었습니다."],
    tokenUsage: { total: 0 }
  });

  try {
    updateStatus(jobId, "publishing", "티스토리 테스트 발행");
    safeLog(jobId, "티스토리 전용 테스트 발행을 시작합니다.");
    await publishToTistory({
      tistoryBlogId,
      category: String(form.category || settings.category || "").trim(),
      publishPrivate,
      publishVisibility,
      publishScheduleMode,
      reserveAfterHours,
      failOnLoginRequired: false,
      title,
      article,
      titleImagePath: "",
      bodyImages: [{ sequence: 1, path: imagePath }],
      breakSentencesInBody: form.breakSentencesInBody !== false,
      tags: ["티스토리테스트", "자동화테스트"],
      browserProfileDir,
      preparedContext: preparedTistorySession?.context,
      preparedPage: preparedTistorySession?.page,
      runtimeRoot,
      log: (message, level) => safeLog(jobId, message, level)
    });
    writeSettings(runtimeRoot, {
      tistoryBlogId,
      tistorySessionStatus: "valid",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    updateStatus(jobId, "success", "티스토리 테스트 발행 완료");
    safeLog(jobId, "티스토리 전용 테스트 발행 완료.");
    const payload = {
      jobId,
      status: "success",
      reason: "티스토리 전용 테스트 발행 완료.",
      title,
      article,
      images,
      imageNotes: ["티스토리 전용 테스트 이미지가 로컬에서 생성되었습니다."],
      tokenUsage: { total: 0 },
      history: readHistory(runtimeRoot)
    };
    emit("job:complete", payload);
    return payload;
  } catch (error) {
    writeSettings(runtimeRoot, {
      tistorySessionStatus: error.code === "TISTORY_SESSION_EXPIRED" ? "expired" : "unknown",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    safeLog(jobId, `티스토리 전용 테스트 발행 실패: ${error.message}`, "error");
    updateStatus(jobId, "failed", error.message);
    throw error;
  } finally {
    activeJob = null;
  }
}

async function startJob(form = {}) {
  if (activeJob) {
    throw new Error("이미 실행 중인 작업이 있습니다.");
  }

  const runtimeRoot = getRuntimeRoot();
  ensureRuntimeFiles(runtimeRoot);
  ensureSettingsFile(runtimeRoot);
  const settings = readSettings(runtimeRoot);
  ensureAccountStoreFile(runtimeRoot, settings);

  const requestedResumeJobId = String(form?.resumeJobId || "").trim();
  const resumeStateOverride = form?.resumeStateOverride && typeof form.resumeStateOverride === "object"
    ? form.resumeStateOverride
    : null;
  const savedInput = { ...form };
  delete savedInput.resumeStateOverride;
  if (requestedResumeJobId) safeHistoryJobId(requestedResumeJobId);
  const jobId = requestedResumeJobId || `job_${Date.now()}`;
  activeJob = { id: jobId, cancelled: false };

  const accountStore = readAccountStore(runtimeRoot, settings);
  const account = resolveAccount(form, accountStore);
  const sourceMode = String(form.sourceMode || "research") === "file_upload" ? "file_upload" : "research";
  const sourceDocuments = normalizeSourceDocuments(form.sourceDocuments);
  const sourceConflicts = Array.isArray(form.sourceConflicts) ? form.sourceConflicts : [];
  const requestedCategory = String(form.category || "").trim();
  const category = form.internalDaily === true ? DEFAULT_DAILY_PUBLISH_CATEGORY : requestedCategory;
  const categoryKeyword = String(form.keyword || "").trim();
  const blogId = String(form.blogId || account.blogId || account.naverId || "").trim();
  const codexCmdPath = resolveCodexCmdPath(form.codexCmdPath || settings.codexCmdPath);
  const codexModel = normalizeCodexModel(form.codexModel || settings.codexModel);
  const publishVisibility = String(form.publishVisibility || (form.publishPrivate === false ? "public" : "private"));
  const publishPrivate = publishVisibility !== "public";
  const publishScheduleMode = String(form.publishScheduleMode || "now");
  const reserveAfterHours = Number(form.reserveAfterHours || 0);
  const includeTitleImage = form.includeTitleImage !== false;
  const titleImageAspectRatio = normalizeImageAspectRatio(form.titleImageAspectRatio || settings.titleImageAspectRatio || form.imageAspectRatio || settings.imageAspectRatio);
  const bodyImageAspectRatio = normalizeImageAspectRatio(form.bodyImageAspectRatio || settings.bodyImageAspectRatio || form.imageAspectRatio || settings.imageAspectRatio);
  const maxBodyImages = normalizeMaxBodyImages(form.maxBodyImages);
  const breakSentencesInBody = form.breakSentencesInBody !== false;
  const agentModels = form.agentModels || settings.agentModels || {};
  const shouldPublish = form.publishAfterGenerate === true || (sourceMode !== "file_upload" && form.topicMode === "auto");
  const publishToTistoryAfterNaver = shouldPublish && form.publishToTistoryAfterNaver === true;
  let tistoryPublishReady = publishToTistoryAfterNaver;
  const tistoryBlogId = String(form.tistoryBlogId || settings.tistoryBlogId || "").trim();
  if (!category) {
    activeJob = null;
    throw new Error("카테고리는 필수입니다.");
  }
  if (!categoryKeyword) {
    if (sourceMode === "file_upload") {
      // File-backed jobs use the uploaded material as their source and do not require a search keyword.
    } else {
      activeJob = null;
      throw new Error("카테고리별 검색 키워드는 필수입니다.");
    }
  }
  if (sourceMode === "file_upload" && !sourceDocuments.length) {
    activeJob = null;
    throw new Error("파일 기반 생성에는 읽을 수 있는 파일이 하나 이상 필요합니다.");
  }
  if (shouldPublish && !blogId) {
    activeJob = null;
    throw new Error("발행까지 진행하려면 Blog ID가 필요합니다.");
  }
  if (publishToTistoryAfterNaver && !tistoryBlogId) {
    activeJob = null;
    throw new Error("티스토리 발행에는 블로그 ID가 필요합니다.");
  }
  if (shouldPublish) {
    safeLog(jobId, `Naver 블로그 주소 ID: ${blogId} (로그인은 열린 Chrome에서 직접 입력)`);
  }

  let preparedNaverSession = null;
  let preparedTistorySession = null;
  let browserProfileDir = getAccountProfileDir(runtimeRoot, account);
  let latestAgentResultForResume = null;
  let latestTagsForResume = [];
  const jobDir = path.join(runtimeRoot, "jobs", jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  // Read the original checkpoint before any restart-safe write can replace its phase.
  const resumeState = requestedResumeJobId
    ? (resumeStateOverride || readJobResumeState(runtimeRoot, requestedResumeJobId, {
      repairPrompt: form.resumePrompt || ""
    }))
    : null;
  // Save restart-safe input before session checks so a login timeout can also be resumed.
  saveJobInput(runtimeRoot, jobId, { ...savedInput, resumeJobId: undefined });
  writeJobCheckpoint(runtimeRoot, jobId, {
    status: "running",
    resumeFrom: "research",
    failurePhase: "",
    failureReason: "",
    repairPrompt: form.resumePrompt || "",
    internalDaily: form.internalDaily === true,
    lastCompletedPhase: "",
    phaseDetail: "입력 저장 완료"
  });
  try {
    if (shouldPublish) {
      preparedNaverSession = await verifyPublishSessionBeforeGeneration({
        runtimeRoot,
        account,
        blogId,
        form,
        settings,
        jobId
      });
      browserProfileDir = preparedNaverSession.browserProfileDir || browserProfileDir;
      if (tistoryPublishReady) {
        const tistorySession = await verifyTistorySessionBeforeGeneration({
          runtimeRoot,
          form,
          settings,
          jobId
        });
        tistoryPublishReady = tistorySession.status === "valid";
        preparedTistorySession = tistoryPublishReady ? tistorySession.preparedSession || null : null;
      }
      safeLog(jobId, "Naver 세션 확인 완료. 주제 입력값 준비 단계로 이동합니다.");
    }
  } catch (error) {
    activeJob = null;
    if (error.code === "SESSION_EXPIRED") {
      if (account.id) {
        updateAccountSession(runtimeRoot, account.id, "expired", settings);
        emitAccountStore(runtimeRoot);
        await closeNaverSession(sessionKeyFor(account, browserProfileDir));
      }
      safeLog(jobId, error.message, "warn");
      writeJobCheckpoint(runtimeRoot, jobId, {
        status: "paused",
        resumeFrom: "research",
        failurePhase: "session",
        failureReason: error.message,
        internalDaily: form.internalDaily === true,
        phaseDetail: "로그인 세션 확인 필요"
      });
      updateStatus(jobId, "session_expired", error.message);
      emit("job:complete", {
        jobId,
        accountId: account.id || "",
        topic: "",
        keyword: "",
        category,
        blogId,
        status: "session_expired",
        title: "",
        article: "",
        images: [],
        imageNotes: [],
        resumeAvailable: true,
        resumeStage: "research",
        resumeReason: error.message,
        tokenUsage: { total: 0 },
        tags: [],
        history: readHistory(runtimeRoot)
      });
      return { status: "session_expired", reason: error.message };
    }
    throw error;
  }

  let resolved;
  let topic = "";
  let keyword = "";
  try {
    safeLog(jobId, "주제 입력값 준비 시작");
    resolved = sourceMode === "file_upload"
      ? {
        topic: String(form.topic || sourceDocuments[0]?.title || sourceDocuments[0]?.filename || "파일 기반 콘텐츠").trim(),
        keyword: categoryKeyword || "파일 기반 콘텐츠"
      }
      : await resolveTopicInput(form, category, (message, level) => safeLog(jobId, message, level, "research"));
    topic = resolved.topic;
    keyword = resolved.keyword;
    safeLog(jobId, "주제 입력값 준비 완료");
  } catch (error) {
    activeJob = null;
    throw error;
  }

  if (!topic && sourceMode !== "file_upload" && String(form.topicMode || "manual") !== "auto") {
    activeJob = null;
    throw new Error("주제는 필수입니다.");
  }

  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "source-material.json"), JSON.stringify({
    sourceMode,
    documents: sourceDocuments,
    conflicts: sourceConflicts
  }, null, 2), "utf8");
  const recoveryGuidance = findRecoveryGuidance(runtimeRoot, {
    failurePhase: resumeState?.failurePhase || "",
    failureReason: resumeState?.failureReason || "",
    category
  });
  if (recoveryGuidance.length) {
    safeLog(jobId, `저장된 복구 해결책 ${recoveryGuidance.length}개를 참고 지시로 적용합니다. 근거·검수·발행 확인은 그대로 수행합니다.`, "info");
  }
  saveJobInput(runtimeRoot, jobId, { ...savedInput, resumeJobId: undefined });
  writeJobCheckpoint(runtimeRoot, jobId, {
    status: "running",
    resumeFrom: resumeState?.resumeFrom || "research",
    failurePhase: resumeState?.failurePhase || "",
    failureReason: resumeState?.failureReason || "",
    repairPrompt: form.resumePrompt || "",
    internalDaily: form.internalDaily === true
  });
  if (resumeState?.resumeFrom) {
    safeLog(jobId, `저장된 ${resumeState.resumeFrom} 단계부터 작업을 이어갑니다.`, "info");
    if (resumeState.recoveryArtifacts?.research || resumeState.recoveryArtifacts?.writer || resumeState.recoveryArtifacts?.imageProgress) {
      safeLog(jobId, `재개 원본 확인: Research=${resumeState.recoveryArtifacts.research || "없음"}, Writer=${resumeState.recoveryArtifacts.writer || "없음"}, Image=${resumeState.recoveryArtifacts.imageProgress || "없음"}`, "info");
    }
  }

  const nonSensitiveJob = {
    jobId, accountId: account.id || "", topic, keyword, category, blogId, status: "generating",
    sourceMode,
    sourceFiles: sourceDocuments.map((item) => item.filename),
    sourceConflicts
  };
  const jobTokenUsage = {
    total: 0,
    grossTotal: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    promptCharacters: 0,
    estimatedPromptTokens: 0,
    agents: {},
    grossAgents: {},
    promptCharactersByAgent: {},
    rateLimits: null
  };
  writeSettings(runtimeRoot, {
    blogId,
    topic,
    keyword,
    category,
    codexCmdPath,
    codexModel,
    primarySearchProvider: form.primarySearchProvider || "naver",
    fallbackSearchProvider: form.fallbackSearchProvider || "google",
    naverSearchUrl: form.naverSearchUrl || "",
    googleSearchUrl: form.googleSearchUrl || "",
    naverEditorDomNotes: form.naverEditorDomNotes || "",
    publishAfterGenerate: shouldPublish,
    publishPrivate,
    topicMode: sourceMode === "file_upload" ? "manual" : (form.topicMode || "manual"),
    repeatTermMinutes: Number(form.repeatTermMinutes || 60),
    publishVisibility,
    publishScheduleMode,
    reserveAfterHours,
    publishToTistoryAfterNaver,
    tistoryBlogId,
    includeTitleImage,
    titleImageAspectRatio,
    bodyImageAspectRatio,
    maxBodyImages,
    breakSentencesInBody,
    agentModels
  });
  updateStatus(jobId, "generating", "Agent 생성 준비");

  const excludedKeywordLanes = Array.isArray(form.excludedKeywordLanes) ? form.excludedKeywordLanes : [];
  let keywordLanePlan = buildKeywordLanePlan(keyword, [], { blogId, category, excludedKeywordLanes });
  let latestLaneResult = normalizeResearchLaneResult({}, keywordLanePlan);
  let latestResearchTitleResult = null;
  const pendingDraft = settings.pendingNaverPublishDraft;
  if (shouldPublish && pendingDraftMatches(pendingDraft, { account, blogId, category })) {
    const resumeAgentResult = {
      title: pendingDraft.title || "",
      article: pendingDraft.article || "",
      titleImagePath: pendingDraft.titleImagePath || "",
      bodyImages: Array.isArray(pendingDraft.bodyImages) ? pendingDraft.bodyImages : [],
      imageWarnings: []
    };
    const resumeTags = Array.isArray(pendingDraft.tags) ? pendingDraft.tags : [];
    latestAgentResultForResume = resumeAgentResult;
    latestTagsForResume = resumeTags;
    emit("job:preview", {
      jobId,
      title: resumeAgentResult.title,
      article: resumeAgentResult.article,
      images: getPreviewImages(resumeAgentResult),
      imageNotes: [],
      tokenUsage: jobTokenUsage,
      tags: resumeTags
    });
    try {
      updateStatus(jobId, "publishing", "Naver pending draft publish resume");
      safeLog(jobId, "이전 작업의 작성 완료 draft를 재사용해 발행만 이어갑니다.", "info");
      await publishToNaver({
        blogId,
        category,
        publishPrivate: pendingDraft.publishPrivate ?? publishPrivate,
        publishVisibility: pendingDraft.publishVisibility || publishVisibility,
        publishScheduleMode: pendingDraft.publishScheduleMode || publishScheduleMode,
        reserveAfterHours: Number(pendingDraft.reserveAfterHours ?? reserveAfterHours),
        failOnLoginRequired: form.failOnLoginRequired === true,
        title: resumeAgentResult.title,
        article: resumeAgentResult.article,
        titleImagePath: resumeAgentResult.titleImagePath,
        bodyImages: resumeAgentResult.bodyImages,
        breakSentencesInBody: pendingDraft.breakSentencesInBody !== false,
        tags: resumeTags,
        domNotes: form.naverEditorDomNotes || "",
        browserProfileDir,
        preparedContext: preparedNaverSession?.context,
        preparedPage: preparedNaverSession?.page,
        resumeExistingDraft: true,
        log: (message, level) => safeLog(jobId, message, level)
      });
      if (account.id) {
        updateAccountSession(runtimeRoot, account.id, "valid", settings);
        emitAccountStore(runtimeRoot);
      }
      let publishReason = "네이버 보류 발행 초안 발행 완료.";
      if (pendingDraft.publishToTistoryAfterNaver && tistoryPublishReady) {
        try {
          updateStatus(jobId, "publishing", "네이버 이어하기 발행 후 티스토리 발행");
          const tistoryProfileDir = getTistoryProfileDir(runtimeRoot, tistoryBlogId);
          const tistoryKey = tistorySessionKey(tistoryBlogId, tistoryProfileDir);
          preparedTistorySession = reusableTistorySession(tistoryKey);
          await publishToTistory({
            tistoryBlogId,
            category,
            publishPrivate: pendingDraft.publishPrivate ?? publishPrivate,
            publishVisibility: pendingDraft.publishVisibility || publishVisibility,
            publishScheduleMode: pendingDraft.publishScheduleMode || publishScheduleMode,
            reserveAfterHours: Number(pendingDraft.reserveAfterHours ?? reserveAfterHours),
            failOnLoginRequired: form.failOnLoginRequired === true,
            title: resumeAgentResult.title,
            article: resumeAgentResult.article,
            titleImagePath: resumeAgentResult.titleImagePath,
            bodyImages: resumeAgentResult.bodyImages,
            breakSentencesInBody: pendingDraft.breakSentencesInBody !== false,
            tags: resumeTags,
            browserProfileDir: tistoryProfileDir,
            preparedContext: preparedTistorySession?.context,
            preparedPage: preparedTistorySession?.page,
            runtimeRoot,
            log: (message, level) => safeLog(jobId, message, level)
          });
          writeSettings(runtimeRoot, {
            tistorySessionStatus: "valid",
            tistorySessionCheckedAt: new Date().toISOString()
          });
          publishReason = "네이버 보류 발행 초안과 티스토리 발행 완료.";
        } catch (error) {
          publishReason = `네이버 보류 발행 초안은 완료됐지만 티스토리 발행에 실패했습니다: ${error.message}`;
          writeSettings(runtimeRoot, {
            tistorySessionStatus: error.code === "TISTORY_SESSION_EXPIRED" ? "expired" : "unknown",
            tistorySessionCheckedAt: new Date().toISOString()
          });
          safeLog(jobId, publishReason, "warn");
        }
      }
      clearPendingNaverPublishDraft(runtimeRoot);
      const embedding = createEmbedding(resumeAgentResult.title);
      appendHistory(runtimeRoot, {
        id: jobId,
        create_at: new Date().toISOString(),
        account_id: account.id || "",
        blog_id: blogId,
        title: resumeAgentResult.title,
        topic: pendingDraft.topic || topic,
        keyword: pendingDraft.keyword || keyword,
        category,
        ...(pendingDraft.keywordLane || {}),
        status: "success",
        harness_version: "lean-agent-v1",
        final_verdict: "PASS",
        failure_phase: "",
        research_title: pendingDraft.researchTitle || "",
        fact_based: pendingDraft.factBased === true,
        source_summary: pendingDraft.sourceSummary || "",
        embedding_model: "local-hash-v1",
        embedding,
        token_total: Number(pendingDraft.tokenTotal || 0),
        reason: publishReason
      });
      updateStatus(jobId, "PUBLISHED", "발행 완료");
      emit("job:complete", {
        ...nonSensitiveJob,
        status: "success",
        title: resumeAgentResult.title,
        article: resumeAgentResult.article,
        images: getPreviewImages(resumeAgentResult),
        imageNotes: [],
        tokenUsage: jobTokenUsage,
        tags: resumeTags,
        history: readHistory(runtimeRoot)
      });
      return { status: "success", resumedPendingPublish: true };
    } catch (error) {
      if (error.code === "SESSION_EXPIRED" && account.id) {
        updateAccountSession(runtimeRoot, account.id, "expired", settings);
        emitAccountStore(runtimeRoot);
      }
      safeLog(jobId, error.message, "error");
      updateStatus(jobId, error.code === "SESSION_EXPIRED" ? "session_expired" : "failed", error.message);
      emit("job:complete", {
        ...nonSensitiveJob,
        status: error.code === "SESSION_EXPIRED" ? "session_expired" : "failed",
        title: resumeAgentResult.title,
        article: resumeAgentResult.article,
        images: getPreviewImages(resumeAgentResult),
        tags: resumeTags,
        tokenUsage: jobTokenUsage,
        history: readHistory(runtimeRoot)
      });
      return {
        status: error.code === "SESSION_EXPIRED" ? "session_expired" : "failed",
        reason: error.message,
        resumedPendingPublish: true
      };
    } finally {
      activeJob = null;
    }
  }
  try {
    const currentDateLabel = todayLabel();
    const history = readHistory(runtimeRoot);
    const accountHistory = history.filter((entry) => String(entry.blog_id || "") === blogId);
    keywordLanePlan = buildKeywordLanePlan(keyword, history, { blogId, category, excludedKeywordLanes });
    latestLaneResult = normalizeResearchLaneResult({}, keywordLanePlan);
    const bypassTitleDuplicateCheck = form.internalHistoryRecovery === true;
    const titleHistory = accountHistory
      .filter((entry) => Array.isArray(entry.embedding))
      .map((entry) => ({ title: entry.title, embedding: entry.embedding }));

    const usesImages = includeTitleImage || maxBodyImages > 0;
    const generationSubject = topic || `${category} ${keyword}`.trim();
    const modelSnapshot = {
      codexModel: codexModel || "Codex 기본값",
      main: agentModels.main || "high",
      research: agentModels.research || "high",
      writer: agentModels.writer || "high",
      image: agentModels.image || "medium"
    };
    safeLog(jobId, `Agent 모델 설정: Codex ${modelSnapshot.codexModel}, Main ${modelSnapshot.main}, Research/Title ${modelSnapshot.research}, Writer ${modelSnapshot.writer}, Image Worker ${modelSnapshot.image}`);
    safeLog(jobId, `Codex ${usesImages ? "본문/이미지 프롬프트" : "본문"} 생성 시작: ${generationSubject}`);
    const generationStartedAt = Date.now();
    let generationPhase = "준비 중";
    const generationHeartbeat = setInterval(() => {
      const minutes = Math.max(1, Math.ceil((Date.now() - generationStartedAt) / 60000));
      safeLog(jobId, `현재 작업 중입니다 - 경과 ${minutes}분`);
      updateStatus(jobId, "generating", `${generationPhase} (${minutes}분 경과)`);
    }, 60000);
    let codexResult;
    try {
      codexResult = await runCodexGeneration({
        codexCmdPath,
        runtimeRoot,
        jobDir,
        codexModel,
        topic,
        keyword,
        category,
        topicMode: sourceMode === "file_upload" ? "manual" : (form.topicMode || "manual"),
        sourceMode,
        sourceDocuments,
        sourceConflicts,
        allowHistoricalFileDraft: form.allowHistoricalFileDraft === true,
        searchResults: [],
        currentDateLabel,
        includeTitleImage,
        titleImageAspectRatio,
        bodyImageAspectRatio,
        maxBodyImages,
        requireImageAssets: form.requireImageAssets === true,
        sourceQuality: sourceMode === "file_upload"
          ? { status: "file_upload", reason: "사용자가 업로드한 원문과 표를 사실 근거로 사용합니다." }
          : { status: "not_requested" },
        excludedTopics: form.excludedTopics || "",
        publishPurpose: form.publishPurpose || "",
        preferredTone: form.preferredTone || "",
        researchGuidance: form.researchGuidance || "",
        forceWebSearch: form.forceWebSearch === true,
        forcedSearchNeed: form.forcedSearchNeed || "",
        freshnessLevel: form.freshnessLevel || "auto",
        searchChannel: form.searchChannel || "blog",
        trustBlogAsSource: form.trustBlogAsSource === true,
        resumeState,
        resumePrompt: String(form.resumePrompt || ""),
        recoveryGuidance,
        keywordLanes: keywordLanePlan.lanes,
        recommendedKeywordLanes: keywordLanePlan.recommended,
        agentModels,
        historyTitles: titleHistory.map((item) => item.title),
        accountImageStyle: {
          accountId: account.id || "",
          sampleImagePath: account.sampleImagePath || "",
          sampleImageHash: account.sampleImageHash || "",
          imageStylePrompt: account.imageStylePrompt || "",
          imageStylePromptStatus: account.imageStylePromptStatus || "missing",
          imageStylePromptSourceImageHash: account.imageStylePromptSourceImageHash || ""
        },
        onAccountImageStylePrompt: (styleResult) => {
          const store = readAccountStore(runtimeRoot, readSettings(runtimeRoot));
          const target = store.accounts.find((item) => item.id === account.id);
          if (!target) return;
          target.imageStylePrompt = String(styleResult.imageStylePrompt || "");
          target.imageStylePromptUpdatedAt = new Date().toISOString();
          target.imageStylePromptStatus = styleResult.status === "success" ? "ready" : "failed";
          target.imageStylePromptSourceImageHash = String(styleResult.sampleImageHash || target.sampleImageHash || "");
          target.imageStylePromptError = String(styleResult.failureReason || "");
          const saved = writeAccountStore(runtimeRoot, store, readSettings(runtimeRoot));
          emit("accounts:update", withAccountImageUrls(runtimeRoot, saved));
        },
        onResearchTitle: (researchResult) => {
          latestResearchTitleResult = researchResult || null;
          latestLaneResult = normalizeResearchLaneResult(researchResult, keywordLanePlan);
          const selectedTitle = String(researchResult.finalTitle || researchResult.selectedTitle || "").trim();
          emit("job:selectedTitle", {
            jobId,
            title: selectedTitle,
            status: researchResult.status || "",
            verdict: researchResult.status || "",
            factBased: researchResult.factBased === true,
            searchNeed: researchResult.searchNeed || "",
            at: new Date().toISOString()
          });
          if (selectedTitle) {
            safeLog(jobId, `선정 제목: ${selectedTitle}`, "info", "main");
          }
          if (latestLaneResult.topicLane) {
            safeLog(jobId, `선택 키워드 lane: ${latestLaneResult.topicLane}`, "info", "research");
          }
        },
        onCheckpoint: (checkpoint = {}) => {
          writeJobCheckpoint(runtimeRoot, jobId, {
            ...checkpoint,
            internalDaily: form.internalDaily === true,
            ...(form.resumePrompt ? { repairPrompt: form.resumePrompt } : {})
          });
        },
        onFinalTitleCandidate: (selectedTitle) => {
          if (bypassTitleDuplicateCheck) {
            return { duplicate: false, similarity: 0, reason: "이력 복구 재생성으로 제목 중복 검사를 생략했습니다." };
          }
          const titleEmbedding = createEmbedding(selectedTitle);
          let similarity = 0;
          for (const item of titleHistory) {
            similarity = Math.max(similarity, cosineSimilarity(titleEmbedding, item.embedding));
          }
          return {
            duplicate: similarity >= 0.75,
            similarity,
            reason: similarity >= 0.75
              ? `기존 제목과 cosine similarity ${similarity.toFixed(3)}`
              : ""
          };
        },
        onTokenUsage: (usage) => {
          jobTokenUsage.total = Number(usage.total || 0);
          jobTokenUsage.grossTotal = Number(usage.grossTotal || jobTokenUsage.grossTotal || 0);
          jobTokenUsage.inputTokens = Number(usage.inputTokens || 0);
          jobTokenUsage.cachedInputTokens = Number(usage.cachedInputTokens || 0);
          jobTokenUsage.outputTokens = Number(usage.outputTokens || 0);
          jobTokenUsage.promptCharacters = Number(usage.promptCharacters || jobTokenUsage.promptCharacters || 0);
          jobTokenUsage.estimatedPromptTokens = Number(usage.estimatedPromptTokens || jobTokenUsage.estimatedPromptTokens || 0);
          if (usage.rateLimits) {
            jobTokenUsage.rateLimits = usage.rateLimits;
          }
          emit("job:tokens", {
            jobId,
            total: jobTokenUsage.total,
            grossTotal: jobTokenUsage.grossTotal,
            inputTokens: jobTokenUsage.inputTokens,
            cachedInputTokens: jobTokenUsage.cachedInputTokens,
            outputTokens: jobTokenUsage.outputTokens,
            promptCharacters: jobTokenUsage.promptCharacters,
            estimatedPromptTokens: jobTokenUsage.estimatedPromptTokens,
            rateLimits: jobTokenUsage.rateLimits,
            agent: usage.agent || "",
            agentTotal: Number(usage.agentTotal || 0),
            agentDelta: Number(usage.agentDelta || 0),
            agentGrossDelta: Number(usage.agentGrossDelta || 0),
            final: usage.final === true,
            at: new Date().toISOString()
          });
        },
        onSearchNeeded: async (researchResult, context) => {
          const searchContext = context || {};
          const searchTopic = selectSearchTopicForResearch(researchResult, {
            topic,
            category,
            keyword,
            topicMode: form.topicMode || "manual"
          });
          const laneResult = normalizeResearchLaneResult(researchResult, keywordLanePlan);
          const searchKeyword = laneResult.selectedKeywordPhrases.join(", ") || laneResult.topicLane || category;
          const authorityQueries = buildAuthorityRecheckQueries(researchResult, searchTopic, searchContext.sourceQuality);
          const intentQueries = buildResearchIntentSearchQueries(researchResult, laneResult, searchTopic);
          const searchQueries = uniqueSearchQueries([...authorityQueries, ...laneResult.searchQueries, ...intentQueries], 4);
          laneResult.searchQueries = searchQueries;
          latestLaneResult = laneResult;
          if (authorityQueries.length) {
            safeLog(jobId, `공식 근거 보강 검색어: ${authorityQueries.join(" / ")}`, "info", "research");
          }
          if (searchContext.writerSupplement && searchContext.writerIssueReason) {
            safeLog(jobId, `Writer Agent 근거 부족 사유로 보강 검색합니다: ${searchContext.writerIssueReason}`, "warn", "research");
          }
          safeLog(jobId, `Research/Title Agent 요청으로 검색 후보 수집 시작: ${researchResult.searchNeed || "normal"}`, "info", "research");
          const researchIntentGuidance = buildResearchIntentGuidance(researchResult, searchContext);
          const researchGuidance = [
            form.researchGuidance || "",
            researchIntentGuidance,
            researchResult.searchFlowSummary,
            researchResult.writerBrief,
            searchContext.writerIssueReason,
            ...(Array.isArray(researchResult.coreQuestions) ? researchResult.coreQuestions : []),
            ...(Array.isArray(researchResult.mustCover) ? researchResult.mustCover : []),
            ...(Array.isArray(researchResult.uncertainItems) ? researchResult.uncertainItems : [])
          ].filter(Boolean).join(" ");
          const searchResults = await collectSearchResults({
            topic: searchTopic,
            keyword: searchKeyword,
            category,
            publishPurpose: form.publishPurpose || "",
            researchGuidance,
            searchQueries: laneResult.searchQueries,
            searchNeed: researchResult.searchNeed || "",
            topicMode: form.topicMode || "manual",
            primaryProvider: form.primarySearchProvider || "naver",
            fallbackProvider: form.fallbackSearchProvider || "google",
            naverSearchUrl: form.naverSearchUrl,
            googleSearchUrl: form.googleSearchUrl,
            searchChannel: form.searchChannel || "blog",
            trustBlogAsSource: form.trustBlogAsSource === true,
            freshnessLevel: form.freshnessLevel || "auto",
            currentDate: currentDateLabel
          }, (message, level) => safeLog(jobId, message, level, "research"));
          const mergedSearchResults = mergeSearchResults(searchContext.previousSearchResults, searchResults);
          safeLog(jobId, `검색 후보 수집 완료: ${searchResults.length}개, 누적 ${mergedSearchResults.length}개`, "info", "research");
          const sourceQuality = summarizeSourceQuality(mergedSearchResults, form.topicMode || "manual", {
            topic: searchTopic,
            keyword: searchKeyword,
            category,
            publishPurpose: form.publishPurpose || "",
            researchGuidance,
            searchQueries: laneResult.searchQueries,
            searchNeed: researchResult.searchNeed || "",
            freshnessLevel: form.freshnessLevel || "auto",
            currentDate: currentDateLabel
          });
          if (sourceQuality.status === "insufficient") {
            safeLog(jobId, sourceQuality.reason, "warn", "research");
          }
          return { searchResults: mergedSearchResults, sourceQuality };
        }
      }, (message, level, agent = "main") => {
        const phaseMatch = String(message || "").match(/^Codex 단계:\s*(.+)$/);
        if (phaseMatch) {
          generationPhase = phaseMatch[1];
          updateStatus(jobId, "generating", `Codex ${generationPhase}`);
        }
        safeLog(jobId, message, level, agent);
      });
    } finally {
      clearInterval(generationHeartbeat);
    }
    if (codexResult.tokenUsage?.total) {
      jobTokenUsage.total = Number(codexResult.tokenUsage.total || 0);
      jobTokenUsage.grossTotal = Number(codexResult.tokenUsage.grossTotal || 0);
      jobTokenUsage.inputTokens = Number(codexResult.tokenUsage.inputTokens || 0);
      jobTokenUsage.cachedInputTokens = Number(codexResult.tokenUsage.cachedInputTokens || 0);
      jobTokenUsage.outputTokens = Number(codexResult.tokenUsage.outputTokens || 0);
      jobTokenUsage.promptCharacters = Number(codexResult.tokenUsage.promptCharacters || 0);
      jobTokenUsage.estimatedPromptTokens = Number(codexResult.tokenUsage.estimatedPromptTokens || 0);
      jobTokenUsage.agents = codexResult.tokenUsage.agents || {};
      jobTokenUsage.grossAgents = codexResult.tokenUsage.grossAgents || {};
      jobTokenUsage.promptCharactersByAgent = codexResult.tokenUsage.promptCharactersByAgent || {};
    }
    if (codexResult.tokenUsage?.rateLimits) {
      jobTokenUsage.rateLimits = codexResult.tokenUsage.rateLimits;
    }
    persistCodexRateLimits(runtimeRoot, jobTokenUsage.rateLimits);
    if (String(codexResult.status || "").toLowerCase() === "duplicate_retry") {
      const duplicateTitle = String(codexResult.title || codexResult.researchTitleResult?.finalTitle || "").trim();
      const duplicateEmbedding = createEmbedding(duplicateTitle);
      const duplicateSimilarity = Number(codexResult.duplicateSimilarity || 0);
      const duplicateEntry = {
        id: jobId,
        create_at: new Date().toISOString(),
        account_id: account.id || "",
        blog_id: blogId,
        title: duplicateTitle,
        topic,
        keyword,
        category,
        ...keywordLaneHistoryFields(latestLaneResult),
        status: "duplicate_retry",
        harness_version: "lean-agent-v1",
        final_verdict: "REVISION",
        failure_phase: "title_duplicate",
        research_title: duplicateTitle,
        embedding_model: "local-hash-v1",
        embedding: duplicateEmbedding,
        token_total: jobTokenUsage.total,
        token_gross_total: jobTokenUsage.grossTotal,
        token_input: jobTokenUsage.inputTokens,
        token_cached_input: jobTokenUsage.cachedInputTokens,
        token_output: jobTokenUsage.outputTokens,
        prompt_characters: jobTokenUsage.promptCharacters,
        token_agents: jobTokenUsage.agents,
        reason: codexResult.failureReason || `기존 제목과 cosine similarity ${duplicateSimilarity.toFixed(3)}`
      };
      appendHistory(runtimeRoot, duplicateEntry);
      safeLog(jobId, `${duplicateEntry.reason} — 본문·검수·이미지 생성을 생략했습니다.`, "warn");
      updateStatus(jobId, "duplicate_retry", "유사 제목으로 조기 중단");
      emit("job:complete", {
        ...nonSensitiveJob,
        status: "duplicate_retry",
        title: duplicateTitle,
        article: "",
        images: [],
        imageNotes: [],
        tokenUsage: jobTokenUsage,
        history: readHistory(runtimeRoot)
      });
      return { status: "duplicate_retry", keywordLane: keywordLaneResultPayload(latestLaneResult) };
    }
    const sourceFailureReason = detectCodexSourceFailure(codexResult);
    if (sourceFailureReason) {
      latestResearchTitleResult = codexResult.researchTitleResult || latestResearchTitleResult;
      latestLaneResult = normalizeResearchLaneResult(latestResearchTitleResult, keywordLanePlan);
      // A final review failure can still contain a complete, reviewable draft.
      // Preserve it for preview/history/resume instead of replacing it with an empty result.
      if (String(codexResult.article || "").trim() || String(codexResult.title || "").trim()) {
        latestAgentResultForResume = normalizeAgentResult({
          runtimeRoot,
          jobDir,
          topic,
          keyword,
          includeTitleImage,
          maxBodyImages,
          currentDateLabel,
          result: codexResult
        });
        latestTagsForResume = Array.isArray(latestAgentResultForResume.tags)
          ? latestAgentResultForResume.tags
          : [];
        safeLog(jobId, "검수 보류 초안을 보존했습니다. 본문은 확인 필요 상태로 남아 이어서 재시도할 수 있습니다.", "warn");
      }
      const sourceError = new Error(sourceFailureReason);
      sourceError.failurePhase = codexResult.failurePhase || (codexResult.researchTitleResult ? "research" : "");
      throw sourceError;
    }
    const researchTitleResult = codexResult.researchTitleResult || {};

    const agentResult = normalizeAgentResult({
      runtimeRoot,
      jobDir,
      topic,
      keyword,
      includeTitleImage,
      maxBodyImages,
      currentDateLabel,
      result: codexResult
    });
    latestAgentResultForResume = agentResult;
    for (const note of agentResult.imageWarnings || []) {
      const imageNoteLevel = /실패|없|못|권한|거부|찾을 수 없|Access|EPERM|denied/i.test(String(note || ""))
        ? "warn"
        : "info";
      safeLog(jobId, note, imageNoteLevel);
    }

    const embedding = createEmbedding(agentResult.title);
    let maxSimilarity = 0;
    for (const item of titleHistory) {
      maxSimilarity = Math.max(maxSimilarity, cosineSimilarity(embedding, item.embedding));
    }

    if (maxSimilarity >= 0.75 && !bypassTitleDuplicateCheck) {
      const duplicateEntry = {
        id: jobId,
        create_at: new Date().toISOString(),
        account_id: account.id || "",
        blog_id: blogId,
        title: agentResult.title,
        topic,
        keyword,
        category,
        ...keywordLaneHistoryFields(latestLaneResult),
        status: "duplicate_retry",
        harness_version: "lean-agent-v1",
        final_verdict: "REVISION",
        failure_phase: "main_review",
        research_title: researchTitleResult.finalTitle || researchTitleResult.selectedTitle || "",
        embedding_model: "local-hash-v1",
        embedding,
        token_total: jobTokenUsage.total,
        token_gross_total: jobTokenUsage.grossTotal,
        token_input: jobTokenUsage.inputTokens,
        token_cached_input: jobTokenUsage.cachedInputTokens,
        token_output: jobTokenUsage.outputTokens,
        prompt_characters: jobTokenUsage.promptCharacters,
        token_agents: jobTokenUsage.agents,
        reason: `기존 제목과 cosine similarity ${maxSimilarity.toFixed(3)}`
      };
      appendHistory(runtimeRoot, duplicateEntry);
      safeLog(jobId, duplicateEntry.reason, "warn");
      updateStatus(jobId, "duplicate_retry", "유사 제목으로 중단");
      emit("job:complete", {
        ...nonSensitiveJob,
        status: "duplicate_retry",
        title: agentResult.title,
        article: agentResult.article,
        images: getPreviewImages(agentResult),
        imageNotes: agentResult.imageWarnings || [],
        tokenUsage: jobTokenUsage,
        history: readHistory(runtimeRoot)
      });
      return { status: "duplicate_retry", keywordLane: keywordLaneResultPayload(latestLaneResult) };
    }

    const tags = buildTags(topic, keyword, agentResult.tags);
    latestTagsForResume = tags;
    emit("job:preview", {
      jobId,
      title: agentResult.title,
      article: agentResult.article,
      images: getPreviewImages(agentResult),
      imageNotes: agentResult.imageWarnings || [],
      tokenUsage: jobTokenUsage,
      tags,
      sourceMode,
      sourceFiles: sourceDocuments.map((item) => item.filename),
      sourceConflicts,
      status: shouldPublish ? "READY_TO_PUBLISH" : "PREVIEW_READY"
    });

    let publishStatus = shouldPublish ? "PUBLISHING" : "DRY_RUN";
    let publishReason = "";

    if (shouldPublish) {
      writeJobCheckpoint(runtimeRoot, jobId, {
        status: "running",
        resumeFrom: "",
        failurePhase: "publish",
        failureReason: "",
        lastCompletedPhase: "image",
        phaseDetail: "본문·이미지 생성 완료, 네이버 발행 시작"
      });
      updateStatus(jobId, "publishing", `Naver 블로그 ${publishVisibility === "public" ? "전체공개" : "비공개"} 발행 자동화`);
      await publishToNaver({
        accountId: account.id || "",
        blogId,
        category,
        publishPrivate,
        publishVisibility,
        publishScheduleMode,
        reserveAfterHours,
        failOnLoginRequired: form.failOnLoginRequired === true,
        title: agentResult.title,
        article: agentResult.article,
        titleImagePath: agentResult.titleImagePath,
        bodyImages: agentResult.bodyImages,
        breakSentencesInBody,
        tags,
        domNotes: form.naverEditorDomNotes || "",
        browserProfileDir,
        preparedContext: preparedNaverSession?.context,
        preparedPage: preparedNaverSession?.page,
        log: (message, level) => safeLog(jobId, message, level)
      });
      if (account.id) {
        updateAccountSession(runtimeRoot, account.id, "valid", settings);
        emitAccountStore(runtimeRoot);
      }
      if (tistoryPublishReady) {
        try {
          updateStatus(jobId, "publishing", "네이버 발행 후 티스토리 발행");
          const tistoryProfileDir = getTistoryProfileDir(runtimeRoot, tistoryBlogId);
          const tistoryKey = tistorySessionKey(tistoryBlogId, tistoryProfileDir);
          preparedTistorySession = reusableTistorySession(tistoryKey);
          await publishToTistory({
            tistoryBlogId,
            category,
            publishPrivate,
            publishVisibility,
            publishScheduleMode,
            reserveAfterHours,
            failOnLoginRequired: form.failOnLoginRequired === true,
            title: agentResult.title,
            article: agentResult.article,
            titleImagePath: agentResult.titleImagePath,
            bodyImages: agentResult.bodyImages,
            breakSentencesInBody,
            tags,
            browserProfileDir: tistoryProfileDir,
            preparedContext: preparedTistorySession?.context,
            preparedPage: preparedTistorySession?.page,
            runtimeRoot,
            log: (message, level) => safeLog(jobId, message, level)
          });
          writeSettings(runtimeRoot, {
            tistorySessionStatus: "valid",
            tistorySessionCheckedAt: new Date().toISOString()
          });
          publishReason = "네이버와 티스토리 발행 완료.";
        } catch (error) {
          publishReason = `네이버 발행은 완료됐지만 티스토리 발행에 실패했습니다: ${error.message}`;
          writeSettings(runtimeRoot, {
            tistorySessionStatus: error.code === "TISTORY_SESSION_EXPIRED" ? "expired" : "unknown",
            tistorySessionCheckedAt: new Date().toISOString()
          });
          safeLog(jobId, publishReason, "warn");
        }
      } else if (publishToTistoryAfterNaver) {
        publishReason = "네이버 발행 완료. 티스토리 세션이 유효하지 않아 티스토리 발행은 건너뜁니다.";
        safeLog(jobId, publishReason, "warn");
      }
      publishStatus = "PUBLISHED";
      updateStatus(jobId, "PUBLISHED", "발행 완료");
    } else {
      publishReason = "DRY_RUN: 사용자가 발행 실행을 켜지 않아 본문만 생성했습니다.";
      updateStatus(jobId, "DRY_RUN", "본문 생성 완료, 발행 대기");
    }

    writeJobCheckpoint(runtimeRoot, jobId, {
      status: "completed",
      internalDaily: form.internalDaily === true
    });

    const entry = {
      id: jobId,
      create_at: new Date().toISOString(),
      account_id: account.id || "",
      blog_id: blogId,
      title: agentResult.title,
      topic,
      keyword,
      category,
      ...keywordLaneHistoryFields(latestLaneResult),
      status: publishStatus,
      content_source: sourceMode,
      source_files: sourceDocuments.map((item) => item.filename),
      source_conflicts: sourceConflicts,
      harness_version: "lean-agent-v1",
      final_verdict: "PASS",
      failure_phase: "",
      research_title: researchTitleResult.finalTitle || researchTitleResult.selectedTitle || "",
      topic_type: researchTitleResult.topicType || "",
      fact_based: researchTitleResult.factBased === true,
      source_summary: researchTitleResult.searchFlowSummary || "",
      embedding_model: "local-hash-v1",
      embedding,
      token_total: jobTokenUsage.total,
      token_gross_total: jobTokenUsage.grossTotal,
      token_input: jobTokenUsage.inputTokens,
      token_cached_input: jobTokenUsage.cachedInputTokens,
      token_output: jobTokenUsage.outputTokens,
      prompt_characters: jobTokenUsage.promptCharacters,
      token_agents: jobTokenUsage.agents,
      reason: publishReason
    };
    appendHistory(runtimeRoot, entry);
    if (recoveryGuidance.length) {
      markRecoveryGuidanceUsed(runtimeRoot, recoveryGuidance);
    }
    if (requestedResumeJobId && String(form.resumePrompt || "").trim()) {
      const saved = recordRecoveryLesson(runtimeRoot, {
        failurePhase: resumeState?.failurePhase || "",
        failureReason: resumeState?.failureReason || "",
        repairPrompt: form.resumePrompt,
        category
      });
      if (saved) {
        safeLog(jobId, "성공한 오류 해결 프롬프트를 복구 해결책에 저장했습니다. 다음 유사 오류에 참고 지시로 재사용합니다.", "info");
      }
    }
    if (publishStatus === "PUBLISHED") {
      safeLog(jobId, "Naver 발행 완료");
    }

    emit("job:complete", {
      ...nonSensitiveJob,
      status: publishStatus,
      title: agentResult.title,
      article: agentResult.article,
      images: getPreviewImages(agentResult),
        imageNotes: agentResult.imageWarnings || [],
      tokenUsage: jobTokenUsage,
      tags,
      sourceMode,
      sourceFiles: sourceDocuments.map((item) => item.filename),
      sourceConflicts,
      history: readHistory(runtimeRoot)
    });
    return {
      status: publishStatus,
      jobId,
      title: agentResult.title,
      article: agentResult.article,
      tags,
      images: getPreviewImages(agentResult),
      titleImagePath: agentResult.titleImagePath || "",
      bodyImages: agentResult.bodyImages || [],
      keywordLane: keywordLaneResultPayload(latestLaneResult)
    };
  } catch (error) {
    const failedStatus = error.code === "SESSION_EXPIRED"
      ? "session_expired"
      : error.code === "CODEX_USAGE_LIMIT" ? "codex_usage_limit"
        : error.code === "CODEX_EXEC_FAILED" ? "codex_exec_failed"
          : "failed";
    persistCodexRateLimits(runtimeRoot, jobTokenUsage.rateLimits);
    const resumeFailureState = readJobResumeState(runtimeRoot, jobId, {
      failurePhase: error.failurePhase || "",
      failureReason: error.message,
      repairPrompt: form.resumePrompt || ""
    });
    const resumablePhase = ["research", "writer", "main_review", "image"].includes(resumeFailureState.resumeFrom)
      ? resumeFailureState.resumeFrom
      : "";
    writeJobCheckpoint(runtimeRoot, jobId, {
      status: "paused",
      resumeFrom: resumablePhase,
      failurePhase: error.failurePhase || resumeFailureState.failurePhase,
      failureReason: error.message,
      repairPrompt: form.resumePrompt || "",
      internalDaily: form.internalDaily === true
    });
    if (failedStatus === "session_expired" && account.id) {
      updateAccountSession(runtimeRoot, account.id, "expired", settings);
      emitAccountStore(runtimeRoot);
      const pendingDraft = buildPendingNaverPublishDraft({
        jobId,
        account,
        blogId,
        category,
        topic,
        keyword,
        agentResult: latestAgentResultForResume,
        tags: latestTagsForResume,
        publishPrivate,
        publishVisibility,
        publishScheduleMode,
        reserveAfterHours,
        breakSentencesInBody,
        publishToTistoryAfterNaver,
        tistoryBlogId,
        latestLaneResult,
        researchTitleResult: latestResearchTitleResult,
        tokenUsage: jobTokenUsage
      });
      if (pendingDraft) {
        writeSettings(runtimeRoot, { pendingNaverPublishDraft: pendingDraft });
        safeLog(jobId, "Naver 작성 완료 draft를 보존했습니다. 세션확인 후 재생성 없이 발행을 이어갑니다.", "warn");
      }
    }
    const embedding = createEmbedding(`${topic} ${keyword}`.trim() || topic);
    appendHistory(runtimeRoot, {
      id: jobId,
      create_at: new Date().toISOString(),
      account_id: account.id || "",
      blog_id: blogId,
      title: latestAgentResultForResume?.title || "",
      topic,
      keyword,
      category,
      ...keywordLaneHistoryFields(latestLaneResult),
      status: failedStatus,
      embedding_model: "local-hash-v1",
      embedding,
      token_total: jobTokenUsage.total,
      token_gross_total: jobTokenUsage.grossTotal,
      token_input: jobTokenUsage.inputTokens,
      token_cached_input: jobTokenUsage.cachedInputTokens,
      token_output: jobTokenUsage.outputTokens,
      prompt_characters: jobTokenUsage.promptCharacters,
      token_agents: jobTokenUsage.agents,
      failure_phase: error.failurePhase || "",
      research_title: latestResearchTitleResult?.finalTitle || latestResearchTitleResult?.selectedTitle || "",
      reason: error.message
    });
    safeLog(jobId, error.message, "error");
    updateStatus(jobId, failedStatus, error.message);
    emit("job:complete", {
      ...nonSensitiveJob,
      status: failedStatus,
      title: latestAgentResultForResume?.title || "",
      article: latestAgentResultForResume?.article || "",
      images: latestAgentResultForResume ? getPreviewImages(latestAgentResultForResume) : [],
      failurePhase: error.failurePhase || "",
      resumeAvailable: Boolean(resumablePhase),
      resumeStage: resumablePhase,
      resumeReason: error.message,
      tokenUsage: jobTokenUsage,
      tags: latestTagsForResume,
      history: readHistory(runtimeRoot)
    });
    return {
      status: failedStatus,
      jobId,
      reason: error.message,
      failurePhase: error.failurePhase || "",
      resumeAvailable: Boolean(resumablePhase),
      resumeStage: resumablePhase,
      keywordLane: keywordLaneResultPayload(latestLaneResult)
    };
  } finally {
    activeJob = null;
  }
}

async function resumeJob({ jobId = "", repairPrompt = "" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  const safeJobId = safeHistoryJobId(jobId);
  const input = readJobInput(runtimeRoot, safeJobId);
  const checkpoint = readJsonObject(jobCheckpointPath(runtimeRoot, safeJobId));
  if (checkpoint?.status === "completed") {
    throw new Error("이미 완료된 작업입니다. 새 작업을 시작하려면 작업 시작 버튼을 사용하세요.");
  }
  const resumeState = readJobResumeState(runtimeRoot, safeJobId, {
    failurePhase: checkpoint?.failurePhase || "",
    repairPrompt
  });
  if (!resumeState.resumeFrom) {
    throw new Error("저장된 재개 지점을 찾지 못했습니다. 이 작업은 처음부터 다시 실행해야 합니다.");
  }
  safeLog(safeJobId, `오류 해결 프롬프트를 반영해 ${resumeState.resumeFrom} 단계부터 재개합니다.`, "info");
  if (input.internalDaily === true) {
    return runRandomDailyResearch({
      accountId: input.accountId || "",
      date: input.dailyDate || localDateKey(),
      resumeJobId: safeJobId,
      resumeStateOverride: resumeState,
      resumePrompt: String(repairPrompt || "").trim()
    });
  }
  return startJob({
    ...input,
    resumeJobId: safeJobId,
    resumeStateOverride: resumeState,
    resumePrompt: String(repairPrompt || "").trim()
  });
}

function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((result, item) => {
    result[item.type] = item.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function todayMorningPrepState(runtimeRoot, date = localDateKey()) {
  const scheduler = readSchedulerStatus(runtimeRoot);
  const lastRun = scheduler.lastRuns?.["morning-prep"] || null;
  const runDate = lastRun?.at ? new Date(lastRun.at) : null;
  const ranToday = Boolean(
    runDate
    && !Number.isNaN(runDate.getTime())
    && localDateKey(runDate) === date
  );
  const completed = ranToday && lastRun.status === "success";
  return {
    date,
    completed,
    needsManualRun: !completed,
    lastRun: ranToday ? lastRun : null,
    reason: completed
      ? "오늘 09:00 랜덤 주제 검색·초안·온새카 등록 작업이 이미 완료되었습니다."
      : ranToday
        ? `오늘 09:00 작업이 ${lastRun.status || "완료되지 않은 상태"} 상태입니다.`
        : "오늘 09:00 랜덤 주제 검색·초안·온새카 등록 작업의 실행 기록이 없습니다."
  };
}

function dailyAccount(runtimeRoot, accountId = "") {
  const settings = readSettings(runtimeRoot);
  const store = readAccountStore(runtimeRoot, settings);
  const requested = String(accountId || "").trim();
  const account = store.accounts.find((item) => item.id === requested)
    || store.accounts.find((item) => item.checked !== false)
    || store.accounts[0];
  if (!account) throw new Error("회원마당 일일 작업에 사용할 네이버 계정을 먼저 등록하세요.");
  const blogId = String(account.blogId || account.naverId || "").trim();
  if (!blogId) throw new Error("일일 작업 계정에 Blog ID가 없습니다.");
  return { settings, store, account, blogId };
}

function memberPostSourceDocument(item) {
  const lines = [
    `# 회원마당 원본: ${item.postTitle || "제목 없음"}`,
    "",
    "[원본 게시글 메타데이터]",
    `- 원문 URL: ${item.sourceUrl || "확인 불가"}`,
    `- 원문 게시글 ID: ${item.sourcePostId || "확인 불가"}`,
    `- 작성자: ${item.author || "확인 불가"}`,
    `- 등록일: ${item.postRegisteredAt || "확인 불가"}`,
    `- 게시일: ${item.articleDate || "확인 불가"}`,
    `- 분류: ${item.sourceCategory || "확인 불가"}`,
    "",
    "[원본 게시글 본문]",
    item.coreFacts || "[원문 본문을 확인할 수 없습니다.]"
  ];
  return {
    filename: `member-board-${item.sourcePostId || item.id}.md`,
    file_type: "md",
    title: item.postTitle || "회원마당 게시글",
    text: lines.join("\n"),
    tables: [],
    metadata: {
      sourceUrl: item.sourceUrl || "",
      sourcePostId: item.sourcePostId || "",
      originalSourceVerified: item.originalSourceVerified === true
    },
    source_sections: [{ heading: "회원마당 원본", text: item.coreFacts || "" }]
  };
}

function dailyDraftNeedsHumanReview(error) {
  const text = `${error?.message || ""} ${error?.failurePhase || ""} ${error?.reviewStatus || ""}`;
  return /REVISION|BLOCK|검수|보류|최신|현재s*(?:상황|기준|정보)|검색s*후보|근거s*(?:부족|불일치)|제목.*본문|본문.*제목|원문.*확인/i.test(text);
}

async function crawlDailyMemberBoard({ accountId = "", url = MEMBER_BOARD_URL } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  ensureDailyWorkflowFiles(runtimeRoot);
  let account = null;
  try {
    ({ account } = dailyAccount(runtimeRoot, accountId));
    const browserProfileDir = getAccountProfileDir(runtimeRoot, account);
    const result = await crawlMemberBoard({
      browserProfileDir,
      url: String(url || MEMBER_BOARD_URL).trim() || MEMBER_BOARD_URL,
      log: (message, level) => safeLog("daily-member-board", message, level, "main")
    });
    const source = writeMemberSource(runtimeRoot, {
      ...result,
      status: "success",
      failureReason: "",
      retryable: false,
      retryCount: 0,
      accountId: account.id || "",
      fetchedAt: result.fetchedAt || new Date().toISOString()
    });
    safeLog("daily-member-board", `회원마당 원본 ${source.posts?.length || 0}건을 저장했습니다.`);
    return source;
  } catch (error) {
    const previous = readMemberSource(runtimeRoot);
    writeMemberSource(runtimeRoot, {
      ...previous,
      status: "failed",
      failureReason: error.message,
      failedAt: new Date().toISOString(),
      retryable: true,
      retryCount: Number(previous.retryCount || 0) + 1,
      accountId: account?.id || previous.accountId || ""
    });
    safeLog("daily-member-board", `회원마당 수집 실패: ${error.message}`, "error");
    throw error;
  }
}

async function crawlDailyNaverStyle({ accountId = "" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  ensureDailyWorkflowFiles(runtimeRoot);
  const { account } = dailyAccount(runtimeRoot, accountId);
  const result = await crawlNaverStylePosts({
    browserProfileDir: getAccountProfileDir(runtimeRoot, account),
    log: (message, level) => safeLog("daily-style", message, level, "main")
  });
  const rules = writeStyleRules(runtimeRoot, extractStyleRules(result.posts || []));
  safeLog("daily-style", `기존 네이버 블로그 ${rules.sampleCount}건에서 스타일 규칙을 저장했습니다.`);
  return { ...result, rules };
}

function dailyPlanHasProgress(plan) {
  return Array.isArray(plan?.items) && plan.items.some((item) => (
    item?.draftReady === true
    || Boolean(item?.draftBody)
    || ["승인됨", "발행완료", "확인 필요"].includes(item?.status)
  ));
}

function prepareDailyPlan({ accountId = "", date = localDateKey(), force = false } = {}) {
  const runtimeRoot = getRuntimeRoot();
  ensureDailyWorkflowFiles(runtimeRoot);
  const source = readMemberSource(runtimeRoot);
  const { account, blogId } = dailyAccount(runtimeRoot, accountId || source.accountId);
  const dailyCategory = dailyResearchCategory(account);
  const existingPlan = readDailyPlan(runtimeRoot, date);
  if (existingPlan && !force && dailyPlanHasProgress(existingPlan)) {
    for (const item of existingPlan.items || []) {
      item.blogCategory = dailyCategory.name;
      item.blogDisplayCategory = dailyCategory.name;
      item.publishCategory = dailyCategory.name;
      item.accountId = account.id || "";
      item.blogId = blogId;
    }
    existingPlan.categoryName = dailyCategory.name;
    existingPlan.publishTarget = "naver";
    existingPlan.updatedAt = new Date().toISOString();
    safeLog("daily-plan", `${date} 기존 초안·승인 상태를 유지하고 계획 재생성을 건너뜁니다.`, "warn");
    return hydrateDailyPlanDraftAssets(runtimeRoot, existingPlan, { persist: true });
  }
  if (source.status === "failed") {
    throw new Error(`회원마당 수집이 실패한 상태입니다. 먼저 수집을 재시도하세요: ${source.failureReason || "원인 미상"}`);
  }
  const history = readHistory(runtimeRoot);
  const plan = createDailyPlan({
    date,
    posts: Array.isArray(source.posts) ? source.posts : [],
    history,
    fetchedAt: source.fetchedAt || "",
    sourceUrl: source.sourceUrl || MEMBER_BOARD_URL
  });
  plan.accountId = account.id || "";
  plan.blogId = blogId;
  plan.categoryName = dailyCategory.name;
  plan.publishTarget = "naver";
  plan.styleRules = readStyleRules(runtimeRoot);
  for (const item of plan.items) {
    item.accountId = account.id || "";
    item.blogId = blogId;
    item.blogCategory = dailyCategory.name;
    item.blogDisplayCategory = dailyCategory.name;
    item.publishCategory = dailyCategory.name;
  }
  writeDailyPlan(runtimeRoot, plan);
  safeLog("daily-plan", `${date} 일일 계획을 준비했습니다. 소재 ${plan.items.filter((item) => item.status === "대기").length}건 / 소재없음 ${plan.items.filter((item) => item.status === "소재없음").length}건`);
  return plan;
}

function dailyResearchCategory(account) {
  const category = (Array.isArray(account?.categories) ? account.categories : [])
    .find((item) => String(item?.name || "").replace(/\s+/g, "").trim() === "알아두면좋은지식");
  if (!category) {
    throw new Error("예약 웹 검색에 사용할 카테고리 '알아두면 좋은 지식'이 계정 관리에 등록되어 있지 않습니다.");
  }
  if (!String(category.keyword || "").trim()) {
    throw new Error("카테고리 '알아두면 좋은 지식'의 검색 키워드를 먼저 입력하세요.");
  }
  return category;
}

function randomResearchItem(plan) {
  return (Array.isArray(plan?.items) ? plan.items : [])
    .find((item) => item?.eligibleForRun === true && item?.selectionState === "selected")
    || (Array.isArray(plan?.items) ? plan.items : []).find((item) => item?.eligibleForRun === true)
    || null;
}

async function runRandomDailyResearch({ accountId = "", date = localDateKey(), resumeJobId = "", resumeStateOverride = null, resumePrompt = "" } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  ensureDailyWorkflowFiles(runtimeRoot);
  const { account, settings, blogId } = dailyAccount(runtimeRoot, accountId);
  const category = dailyResearchCategory(account);
  let plan = hydrateDailyPlanDraftAssets(runtimeRoot, readDailyPlan(runtimeRoot, date), { persist: true });
  if (!plan || plan.workflowMode !== "random-slot-web-research" || plan.categoryName !== category.name) {
    plan = createRandomResearchPlan({
      date,
      accountId: account.id || "",
      blogId,
      category,
      styleRules: readStyleRules(runtimeRoot)
    });
    writeDailyPlan(runtimeRoot, plan);
    safeLog("daily-random", `[${date}] 9개 슬롯 중 ${plan.selectedSlot}번 '${plan.selectedSlotCategory}' 슬롯을 오늘의 주제로 선택했습니다.`);
  }
  plan.categoryName = category.name;
  plan.publishTarget = "onsaecar";
  for (const planItem of plan.items || []) {
    planItem.blogCategory = category.name;
    planItem.blogDisplayCategory = category.name;
    planItem.publishCategory = category.name;
  }
  writeDailyPlan(runtimeRoot, plan);
  const item = randomResearchItem(plan);
  if (!item) throw new Error("오늘 실행할 랜덤 주제 슬롯을 찾지 못했습니다.");
  if (item.memberBoardStatus === "발행완료") {
    safeLog("daily-random", "오늘 선택된 주제는 이미 온새카 회원마당에 등록되어 있어 중복 등록하지 않습니다.", "warn");
    return { status: "success", skipped: true, reason: "오늘 선택된 주제가 이미 온새카에 등록되었습니다.", plan };
  }

  dailyWorkflowRunning = true;
  try {
    if (!item.draftReady || !item.draftBody) {
      safeLog("daily-random", `[${item.slot}/9] '${item.topic}' 웹 검색·최종 글 작성을 시작합니다.`);
      const result = await startJob({
        internalDaily: true,
        accountId: account.id || "",
        blogId,
        topicMode: "manual",
        sourceMode: "research",
        topic: item.topic,
        category: category.name,
        keyword: item.searchKeyword,
        excludedTopics: item.excludedTopics,
        publishPurpose: item.publishPurpose,
        preferredTone: item.preferredTone,
        researchGuidance: item.researchGuidance,
        forceWebSearch: true,
        forcedSearchNeed: "normal",
        freshnessLevel: item.freshnessLevel,
        searchChannel: item.searchChannel,
        primarySearchProvider: item.primarySearchProvider,
        fallbackSearchProvider: item.fallbackSearchProvider,
        trustBlogAsSource: item.trustBlogAsSource,
        dailyDate: date,
        resumeJobId: resumeJobId || undefined,
        resumeStateOverride,
        resumePrompt: String(resumePrompt || ""),
        publishAfterGenerate: false,
        publishToTistoryAfterNaver: false,
        includeTitleImage: settings.includeTitleImage !== false,
         titleImageAspectRatio: settings.titleImageAspectRatio,
         bodyImageAspectRatio: settings.bodyImageAspectRatio,
         maxBodyImages: settings.maxBodyImages,
         requireImageAssets: true,
         breakSentencesInBody: settings.breakSentencesInBody !== false,
        codexModel: settings.codexModel,
        agentModels: settings.agentModels || {},
        failOnLoginRequired: false
      });
      if (!result || !["DRY_RUN", "success", "generated"].includes(result.status)) {
        const error = new Error(result?.reason || "웹 검색 기반 글 생성 결과를 받지 못했습니다.");
        error.jobId = result?.jobId || "";
        error.failurePhase = result?.failurePhase || "research";
        error.reviewStatus = result?.reviewStatus || result?.mainReviewResult?.status || "";
        throw error;
      }
      Object.assign(item, {
        status: "초안 생성 완료",
        draftReady: true,
        draftJobId: result.jobId || "",
        draftTitle: result.title || item.topic,
        draftBody: result.article || "",
        draftTags: Array.isArray(result.tags) ? result.tags : [],
        draftImages: Array.isArray(result.images) ? result.images : [],
        draftTitleImagePath: result.titleImagePath || "",
        draftBodyImages: Array.isArray(result.bodyImages) ? result.bodyImages : [],
        failureReason: "",
        failurePhase: ""
      });
      plan.status = "초안 생성 완료";
      writeDailyPlan(runtimeRoot, plan);
      safeLog("daily-random", `[${item.slot}/9] 웹 검색 기반 최종 글 작성이 완료되었습니다. 온새카 등록을 시작합니다.`);
    }

    const memberResult = await publishMemberBoardPost({
      browserProfileDir: getAccountProfileDir(runtimeRoot, account),
      title: item.draftTitle || item.topic,
      article: item.draftBody,
      log: (message, level) => safeLog("daily-random-publish", `[${item.slot}/9] ${message}`, level)
    });
    Object.assign(item, {
      status: "발행완료",
      memberBoardStatus: "발행완료",
      memberBoardTitle: memberResult.title || "",
      memberBoardUrl: memberResult.url || "",
      memberBoardFailureReason: "",
      publishedAt: new Date().toISOString(),
      failureReason: ""
    });
    plan.status = "온새카 발행 완료";
    writeDailyPlan(runtimeRoot, plan);
    safeLog("daily-random", `[${item.slot}/9] 온새카 등록 완료: ${memberResult.title || item.draftTitle}`);
    return { status: "success", title: item.draftTitle, url: memberResult.url || "", plan };
  } catch (error) {
    item.memberBoardStatus = item.draftReady ? "실패" : "미대상";
    item.draftJobId = error.jobId || item.draftJobId || "";
    item.failureReason = error.message;
    item.failurePhase = error.failurePhase || item.failurePhase || "";
    item.retryCount = Number(item.retryCount || 0) + 1;
    plan.status = "실패·10:30 재시도 대기";
    plan.updatedAt = new Date().toISOString();
    writeDailyPlan(runtimeRoot, plan);
    safeLog("daily-random", `랜덤 주제 예약 작업 실패: ${error.message}`, "error");
      return {
        status: "failed",
        jobId: error.jobId || "",
        reason: error.message,
        resumeAvailable: Boolean(error.jobId),
        resumeStage: error.failurePhase || "research",
        plan
      };
  } finally {
    dailyWorkflowRunning = false;
  }
}

async function generateDailyDrafts({ accountId = "", date = localDateKey() } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  let plan = hydrateDailyPlanDraftAssets(runtimeRoot, readDailyPlan(runtimeRoot, date), { persist: true });
  if (!plan) plan = prepareDailyPlan({ accountId, date });
  const { account, settings, blogId } = dailyAccount(runtimeRoot, accountId || plan.accountId);
  const styleRules = readStyleRules(runtimeRoot);
  const styleGuidance = styleRules?.rules?.join(" ") || "기존 블로그의 정보 전달형 문체를 따릅니다.";
  dailyWorkflowRunning = true;
  try {
    for (const item of plan.items) {
      if (!(["대기", "실패"].includes(item.status)) || item.draftReady !== false || !item.coreFacts) continue;
      if (Number(item.retryCount || 0) >= 2) {
        safeLog("daily-plan", `[${item.slot}/9] 초안 재시도 한도(2회)에 도달해 보류합니다.`, "warn");
        continue;
      }
      safeLog("daily-plan", `[${item.slot}/9] ${item.postTitle} 초안 생성을 시작합니다.`);
      try {
        const result = await startJob({
          internalDaily: true,
          accountId: account.id || "",
          blogId,
          topicMode: "manual",
          sourceMode: "file_upload",
          sourceDocuments: [memberPostSourceDocument(item)],
          sourceConflicts: [],
          topic: item.postTitle,
          category: item.blogCategory,
          keyword: item.searchKeyword || `${item.sourceCategory} ${item.postTitle}`,
          excludedTopics: item.excludedTopics,
          publishPurpose: item.publishPurpose,
          preferredTone: styleGuidance,
          publishAfterGenerate: false,
          publishToTistoryAfterNaver: false,
          includeTitleImage: settings.includeTitleImage !== false,
          titleImageAspectRatio: settings.titleImageAspectRatio,
          bodyImageAspectRatio: settings.bodyImageAspectRatio,
          maxBodyImages: settings.maxBodyImages,
          breakSentencesInBody: settings.breakSentencesInBody !== false,
          codexModel: settings.codexModel,
          agentModels: settings.agentModels || {},
          failOnLoginRequired: false
        });
        if (!result || !["DRY_RUN", "success", "generated"].includes(result.status)) {
          const generationError = new Error(result?.reason || "초안 생성 결과를 받지 못했습니다.");
          generationError.jobId = result?.jobId || "";
          generationError.failurePhase = result?.failurePhase || "";
          generationError.reviewStatus = result?.reviewStatus || result?.mainReviewResult?.status || "";
          throw generationError;
        }
        Object.assign(item, {
          status: "초안 생성 완료",
          draftReady: true,
          draftJobId: result.jobId || "",
          draftTitle: result.title || item.postTitle,
          draftBody: result.article || "",
          draftTags: Array.isArray(result.tags) ? result.tags : [],
          draftImages: Array.isArray(result.images) ? result.images : [],
          draftTitleImagePath: result.titleImagePath || "",
          draftBodyImages: Array.isArray(result.bodyImages) ? result.bodyImages : [],
          failureReason: ""
        });
        safeLog("daily-plan", `[${item.slot}/9] 초안 생성 완료. 승인 전 발행하지 않습니다.`);
      } catch (error) {
        item.status = dailyDraftNeedsHumanReview(error) ? "확인 필요" : "실패";
        item.failureReason = error.message;
        item.failurePhase = error.failurePhase || "";
        item.retryable = item.status === "실패";
        if (item.retryable) item.retryCount = Number(item.retryCount || 0) + 1;
        safeLog("daily-plan", `[${item.slot}/9] ${item.status === "확인 필요" ? "사람 확인 필요" : "초안 생성 실패"}: ${error.message}`, "error");
      }
      plan.updatedAt = new Date().toISOString();
      writeDailyPlan(runtimeRoot, plan);
    }
    plan.status = "승인 대기";
    plan.updatedAt = new Date().toISOString();
    return writeDailyPlan(runtimeRoot, plan);
  } finally {
    dailyWorkflowRunning = false;
  }
}

function waitUntil(timestamp) {
  const target = Number(timestamp || 0);
  if (!target || target <= Date.now()) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, target - Date.now()));
}

async function publishApprovedDaily({ accountId = "", date = localDateKey(), scheduled = false } = {}) {
  if (activeJob || dailyWorkflowRunning) throw new Error("현재 다른 작업이 실행 중입니다.");
  const runtimeRoot = getRuntimeRoot();
  const plan = hydrateDailyPlanDraftAssets(runtimeRoot, readDailyPlan(runtimeRoot, date), { persist: true });
  if (!plan) throw new Error(`${date} 일일 계획이 없습니다. 먼저 일일 계획을 준비하세요.`);
  const { account, settings, blogId } = dailyAccount(runtimeRoot, accountId || plan.accountId);
  const browserProfileDir = getAccountProfileDir(runtimeRoot, account);
  const approved = plan.items.filter((item) => item.status === "승인됨" && item.draftReady && item.draftBody);
  if (!approved.length) throw new Error("승인됨 상태이며 초안이 준비된 항목이 없습니다.");
  dailyWorkflowRunning = true;
  let pausedOnError = false;
  try {
    let previousPublishedAt = 0;
    for (const [index, item] of approved.sort((a, b) => a.slot - b.slot).entries()) {
      if (scheduled) {
        const scheduledAt = Date.parse(String(item.scheduledAt || ""));
        const nextAt = index === 0
          ? Math.max(Date.now(), Number.isFinite(scheduledAt) ? scheduledAt : 0)
          : Math.max(Date.now(), previousPublishedAt + (10 * 60 * 1000), Number.isFinite(scheduledAt) ? scheduledAt : 0);
        await waitUntil(nextAt);
      }
      try {
        await publishToNaver({
          accountId: account.id || "",
          blogId,
          category: item.blogCategory,
          publishPrivate: false,
          publishVisibility: "public",
          publishScheduleMode: "now",
          reserveAfterHours: 0,
          failOnLoginRequired: true,
          title: item.draftTitle,
          article: item.draftBody,
          titleImagePath: item.draftTitleImagePath,
          bodyImages: item.draftBodyImages || [],
          breakSentencesInBody: settings.breakSentencesInBody !== false,
          tags: item.draftTags || [],
          domNotes: settings.naverEditorDomNotes || "",
          browserProfileDir,
          runtimeRoot,
          reuseBrowserSession: true,
          log: (message, level) => safeLog("daily-publish", `[${item.slot}/9] ${message}`, level)
        });
        item.status = "발행완료";
        item.publishedAt = new Date().toISOString();
        previousPublishedAt = Date.now();
        item.failureReason = "";
      } catch (error) {
        item.status = "실패";
        item.failureReason = error.message;
        safeLog("daily-publish", `[${item.slot}/9] 발행 실패: ${error.message}`, "error");
        pausedOnError = true;
        plan.status = "발행 일시중지";
        plan.updatedAt = new Date().toISOString();
        writeDailyPlan(runtimeRoot, plan);
        safeLog(
          "daily-publish",
          `[${item.slot}/9] 오류가 발생해 발행을 일시중지했습니다. 열린 Chrome에서 문제를 해결한 뒤 '승인 항목 발행'을 다시 누르면 이 항목을 건너뛰고 다음 승인 글부터 이어갑니다.`,
          "warn"
        );
        break;
      }
      // The approval queue is the Naver-only publishing path. Member-board
      // registration is intentionally limited to runRandomDailyResearch().
      safeLog("daily-publish", `[${item.slot}/9] 네이버 발행 완료. 온새카 회원마당에는 등록하지 않습니다.`, "info");
      plan.updatedAt = new Date().toISOString();
      writeDailyPlan(runtimeRoot, plan);
    }
    plan.status = pausedOnError
      ? "발행 일시중지"
      : plan.items.some((item) => item.status === "실패")
      ? "일부 실패"
      : "발행 완료";
    plan.updatedAt = new Date().toISOString();
    return writeDailyPlan(runtimeRoot, plan);
  } finally {
    if (!pausedOnError) await closeReusablePublishSession(browserProfileDir);
    dailyWorkflowRunning = false;
  }
}

async function executeScheduledStage(stage, { shutdownAfter = false } = {}) {
  const runtimeRoot = getRuntimeRoot();
  const normalizedStage = String(stage || "").trim();
  const knownStages = new Set(["morning-prep", "draft-retry", "publish-approved"]);
  if (!knownStages.has(normalizedStage)) {
    recordScheduledRun(runtimeRoot, normalizedStage || "unknown", {
      status: "failed",
      reason: "지원하지 않는 예약 작업 단계입니다."
    });
    return { status: "failed", reason: "지원하지 않는 예약 작업 단계입니다." };
  }

  if (activeJob || dailyWorkflowRunning) {
    const result = { status: "skipped", reason: "다른 작업이 실행 중이어서 예약 작업을 건너뛰었습니다." };
    recordScheduledRun(runtimeRoot, normalizedStage, result);
    safeLog("daily-scheduler", result.reason, "warn");
    return result;
  }

  const date = localDateKey();
  safeLog("daily-scheduler", `[${normalizedStage}] ${date} 예약 작업을 시작합니다.`);
  try {
    let result;
    if (normalizedStage === "morning-prep") {
      result = await runRandomDailyResearch({ date });
    } else if (normalizedStage === "draft-retry") {
      safeLog("daily-scheduler", "09:00 랜덤 주제 작업의 실패·초안 누락·온새카 등록 실패 항목을 재시도합니다.", "warn");
      result = await runRandomDailyResearch({ date });
    } else {
      const plan = hydrateDailyPlanDraftAssets(runtimeRoot, readDailyPlan(runtimeRoot, date), { persist: true });
      const approved = plan?.items?.filter((item) => item.status === "승인됨" && item.draftReady && item.draftBody) || [];
      if (!approved.length) {
        result = { status: "skipped", reason: "승인된 초안이 없어 발행하지 않았습니다." };
        safeLog("daily-scheduler", result.reason, "warn");
      } else {
        result = await publishApprovedDaily({
          date,
          accountId: plan.accountId || "",
          scheduled: true
        });
      }
    }
    const runStatus = result?.status === "skipped"
      ? "skipped"
      : result?.status === "failed"
        ? "failed"
        : "success";
    recordScheduledRun(runtimeRoot, normalizedStage, {
      status: runStatus,
      reason: result?.reason || "",
      completedAt: new Date().toISOString()
    });
    safeLog("daily-scheduler", `[${normalizedStage}] 예약 작업 ${runStatus === "success" ? "완료" : "건너뜀"}.`);
    return result;
  } catch (error) {
    recordScheduledRun(runtimeRoot, normalizedStage, {
      status: "failed",
      reason: error.message,
      completedAt: new Date().toISOString(),
      retryable: error.code === "MEMBER_BOARD_LOGIN_REQUIRED" || normalizedStage === "draft-retry"
    });
    safeLog("daily-scheduler", `[${normalizedStage}] 예약 작업 실패: ${error.message}`, "error");
    return { status: "failed", reason: error.message };
  } finally {
    if (shutdownAfter) setTimeout(() => app.quit(), 300);
  }
}

app.whenReady().then(() => {
  if (!singleInstanceLock) return;
  ensureRuntimeFiles(getRuntimeRoot());
  ensureSettingsFile(getRuntimeRoot());
  ensureAccountStoreFile(getRuntimeRoot(), readSettings(getRuntimeRoot()));
  ensureDailyWorkflowFiles(getRuntimeRoot());
  createWindow();

  ipcMain.handle("app:getInitialData", () => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    return {
      runtimeRoot,
      codexCmdPath: resolveCodexCmdPath(settings.codexCmdPath),
      chrome: detectChromeInstall(),
      settings,
      accountStore: withAccountImageUrls(runtimeRoot, readAccountStore(runtimeRoot, settings)),
      history: readHistory(runtimeRoot),
      dailyWorkflow: {
        memberSource: readMemberSource(runtimeRoot),
        plan: hydrateDailyPlanDraftAssets(runtimeRoot, readDailyPlan(runtimeRoot, localDateKey()), { persist: true }),
        styleRules: readStyleRules(runtimeRoot)
      },
      scheduler: readSchedulerStatus(runtimeRoot),
      resumeCandidate: latestResumeCandidate(runtimeRoot)
    };
  });

  ipcMain.handle("chrome:installAndQuit", async () => {
    await shell.openExternal("https://www.google.com/chrome/");
    setTimeout(() => app.quit(), 500);
    return true;
  });
  ipcMain.handle("daily:openMemberBoardWrite", async (_event, { accountId = "" } = {}) => {
    const runtimeRoot = getRuntimeRoot();
    const { account } = dailyAccount(runtimeRoot, accountId);
    const browserProfileDir = getAccountProfileDir(runtimeRoot, account);
    if (memberBoardLoginContext && memberBoardLoginProfileDir !== browserProfileDir) {
      await memberBoardLoginContext.close().catch(() => {});
      memberBoardLoginContext = null;
      memberBoardLoginProfileDir = "";
    }
    if (!memberBoardLoginContext) {
      const chromium = require("playwright-core").chromium;
      memberBoardLoginContext = await chromium.launchPersistentContext(path.resolve(browserProfileDir), {
        channel: "chrome",
        headless: false,
        viewport: { width: 1440, height: 920 },
        args: ["--disable-blink-features=AutomationControlled", "--hide-crash-restore-bubble", "--disable-session-crashed-bubble", "--no-first-run"]
      });
      memberBoardLoginProfileDir = browserProfileDir;
      const context = memberBoardLoginContext;
      context.on("close", () => {
        if (memberBoardLoginContext === context) {
          memberBoardLoginContext = null;
          memberBoardLoginProfileDir = "";
        }
      });
    }
    const page = memberBoardLoginContext.pages()[0] || await memberBoardLoginContext.newPage();
    await page.bringToFront().catch(() => {});
    await page.goto(MEMBER_BOARD_WRITE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    safeLog("daily-member-board", `회원마당 글쓰기 로그인 페이지를 열었습니다: ${MEMBER_BOARD_WRITE_URL}`);
    safeLog("daily-member-board", "로그인 창과 회원마당 수집기가 동일한 Chrome 프로필을 사용합니다.");
    return { url: MEMBER_BOARD_WRITE_URL, profile: browserProfileDir };
  });
  ipcMain.handle("daily:closeMemberBoardWrite", async () => {
    if (memberBoardLoginContext) await memberBoardLoginContext.close().catch(() => {});
    memberBoardLoginContext = null;
    memberBoardLoginProfileDir = "";
    return true;
  });
  ipcMain.handle("daily:waitMemberBoardLogin", async (_event, { timeoutMs = 20000 } = {}) => {
    if (!memberBoardLoginContext) return { loggedIn: false, url: "", reason: "로그인 창이 열려 있지 않습니다." };
    const page = memberBoardLoginContext.pages()[0] || await memberBoardLoginContext.newPage();
    const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || 20000, 60000));
    let lastUrl = page.url();
    while (Date.now() < deadline) {
      lastUrl = page.url();
      const bodyText = String(await page.locator("body").innerText().catch(() => ""));
      const hasPassword = await page.locator("input[type='password']").count().catch(() => 0);
      const loginPage = /login|로그인/i.test(lastUrl) || hasPassword > 0 || (/아이디/.test(bodyText) && /비밀번호/.test(bodyText));
      if (!loginPage) return { loggedIn: true, url: lastUrl, reason: "로그인 세션이 확인되었습니다." };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { loggedIn: false, url: lastUrl, reason: "로그인 또는 보안 확인이 아직 완료되지 않았습니다." };
  });

  ipcMain.handle("settings:save", (_event, settings) => {
    const runtimeRoot = getRuntimeRoot();
    return writeSettings(runtimeRoot, settings);
  });
  ipcMain.handle("source:chooseFiles", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "콘텐츠 원본 파일 선택",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "지원 파일", extensions: [...SUPPORTED_EXTENSIONS].map((item) => item.slice(1)) },
        { name: "모든 파일", extensions: ["*"] }
      ]
    });
    if (result.canceled) return { canceled: true, documents: [], conflicts: [], errors: [] };
    return { canceled: false, ...(await parseFiles(result.filePaths)) };
  });
  ipcMain.handle("source:parseFiles", async (_event, filePaths) => parseFiles(filePaths));
  ipcMain.handle("codex:refreshUsage", async () => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const savedRateLimits = settings.codexRateLimits || null;
    if (activeJob || process.env.BLOGAUTO_SKIP_CODEX_USAGE_REFRESH === "1") {
      return {
        skipped: true,
        rateLimits: savedRateLimits,
        tokenUsage: {
          total: 0,
          rateLimits: savedRateLimits
        }
      };
    }
    let snapshot;
    try {
      snapshot = await fetchCodexUsageSnapshot({
        codexCmdPath: resolveCodexCmdPath(settings.codexCmdPath),
        cwd: runtimeRoot
      });
    } catch (error) {
      snapshot = {
        source: "unavailable",
        unavailableReason: error instanceof Error ? error.message : String(error || "Codex 사용량 조회 실패"),
        rateLimits: null,
        tokenUsage: {
          total: 0,
          rateLimits: null
        }
      };
    }
    if (snapshot.rateLimits) {
      persistCodexRateLimits(runtimeRoot, snapshot.rateLimits);
    }
    if (!snapshot.rateLimits && savedRateLimits) {
      return {
        ...snapshot,
        source: snapshot.source || "saved",
        savedFallback: true,
        rateLimits: savedRateLimits,
        tokenUsage: {
          ...(snapshot.tokenUsage || {}),
          total: Number(snapshot.tokenUsage?.total || 0),
          rateLimits: savedRateLimits
        }
      };
    }
    return snapshot;
  });
  ipcMain.handle("accounts:save", (_event, store) => {
    const runtimeRoot = getRuntimeRoot();
    const saved = writeAccountStore(runtimeRoot, store, readSettings(runtimeRoot));
    const publicStore = withAccountImageUrls(runtimeRoot, saved);
    emit("accounts:update", publicStore);
    return publicStore;
  });
  ipcMain.handle("accounts:chooseSampleImage", async (_event, accountId) => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const store = readAccountStore(runtimeRoot, settings);
    const account = store.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose sample image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return withAccountImageUrls(runtimeRoot, store);
    }
    const sourcePath = result.filePaths[0];
    const destDir = accountAssetDir(runtimeRoot, account.id);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = accountSampleImagePath(runtimeRoot, account.id, sourcePath);
    fs.copyFileSync(sourcePath, destPath);
    const nextHash = fileHash(destPath);
    const changed = nextHash !== account.sampleImageHash;
    account.sampleImagePath = destPath;
    account.sampleImageHash = nextHash;
    account.sampleImageUpdatedAt = new Date().toISOString();
    if (changed) {
      account.imageStylePromptStatus = account.imageStylePrompt ? "stale" : "missing";
      account.imageStylePromptError = "";
    }
    const saved = writeAccountStore(runtimeRoot, store, settings);
    const publicStore = withAccountImageUrls(runtimeRoot, saved);
    emit("accounts:update", publicStore);
    return publicStore;
  });
  ipcMain.handle("accounts:deleteSampleImage", (_event, accountId) => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const store = readAccountStore(runtimeRoot, settings);
    const account = store.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    const samplePath = String(account.sampleImagePath || "");
    const assetRoot = path.resolve(accountAssetDir(runtimeRoot, account.id));
    const resolvedSample = samplePath ? path.resolve(samplePath) : "";
    if (resolvedSample && resolvedSample.startsWith(assetRoot) && fs.existsSync(resolvedSample)) {
      fs.rmSync(resolvedSample, { force: true });
    }
    account.sampleImagePath = "";
    account.sampleImageHash = "";
    account.sampleImageUpdatedAt = "";
    account.imageStylePrompt = "";
    account.imageStylePromptUpdatedAt = "";
    account.imageStylePromptStatus = "missing";
    account.imageStylePromptSourceImageHash = "";
    account.imageStylePromptError = "";
    const saved = writeAccountStore(runtimeRoot, store, settings);
    const publicStore = withAccountImageUrls(runtimeRoot, saved);
    emit("accounts:update", publicStore);
    return publicStore;
  });
  ipcMain.handle("accounts:checkSession", async (_event, accountId, options = {}) => {
    if (activeJob) {
      throw new Error("작업 실행 중에는 계정 세션을 다시 확인할 수 없습니다.");
    }
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const store = readAccountStore(runtimeRoot, settings);
    const account = store.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("계정을 찾을 수 없습니다.");
    const browserProfileDir = getAccountProfileDir(runtimeRoot, account);
    const key = sessionKeyFor(account, browserProfileDir);
    safeLog("session", `계정 profile: ${browserProfileDir}`);
    const existingNaverSession = reusableNaverSession(key);
    const result = existingNaverSession
      ? await verifyOpenNaverSession({
        blogId: account.blogId || account.naverId,
        browserProfileDir,
        preparedContext: existingNaverSession.context,
        preparedPage: existingNaverSession.page,
        interactiveLogin: true,
        domNotes: settings.naverEditorDomNotes || "",
        runtimeRoot,
        log: (message, level) => safeLog("session", message, level)
      })
      : await checkNaverSession({
        blogId: account.blogId || account.naverId,
        browserProfileDir,
        interactiveLogin: true,
        keepOpen: true,
        requireEditor: true,
        domNotes: settings.naverEditorDomNotes || "",
        runtimeRoot,
        log: (message, level) => safeLog("session", message, level)
      });
    const { preparedSession, page, ...publicResult } = result;
    if (options.includeTistorySession !== false && settings.publishToTistoryAfterNaver === true && settings.tistoryBlogId) {
      try {
        const tistoryProfileDir = getTistoryProfileDir(runtimeRoot, settings.tistoryBlogId);
        const tistoryKey = tistorySessionKey(settings.tistoryBlogId, tistoryProfileDir);
        const existingTistorySession = reusableTistorySession(tistoryKey);
        const tistoryResult = existingTistorySession
          ? {
            status: "valid",
            reason: "reused_open_tistory_editor",
            url: existingTistorySession.page?.url?.() || "",
            preparedSession: existingTistorySession
          }
          : await checkTistorySession({
            tistoryBlogId: settings.tistoryBlogId,
            browserProfileDir: tistoryProfileDir,
            runtimeRoot,
            keepOpen: true,
            log: (message, level) => safeLog("session", message, level)
          });
        if (tistoryResult.preparedSession) {
          activeTistorySessions.set(tistoryKey, tistoryResult.preparedSession);
        }
        publicResult.tistorySession = {
          status: tistoryResult.status,
          reason: tistoryResult.reason || "",
          url: tistoryResult.url || ""
        };
        writeSettings(runtimeRoot, {
          tistorySessionStatus: tistoryResult.status === "valid" ? "valid" : "unknown",
          tistorySessionCheckedAt: new Date().toISOString()
        });
      } catch (error) {
        publicResult.tistorySession = {
          status: "expired",
          reason: error.message
        };
        writeSettings(runtimeRoot, {
          tistorySessionStatus: "expired",
          tistorySessionCheckedAt: new Date().toISOString()
        });
      }
    }
    const sessionStatus = result.status === "valid"
      ? "valid"
      : result.status === "expired"
        ? "expired"
        : "unknown";
    const saved = updateAccountSession(runtimeRoot, account.id, sessionStatus, settings);
    emit("accounts:update", saved);
    if (result.status !== "valid") {
      safeLog("session", `${account.label || account.blogId || account.naverId} 계정 세션이 만료 상태입니다.`, "warn");
      return publicResult;
    }
    if (preparedSession) {
      activeNaverSessions.set(key, preparedSession);
    }
    safeLog("session", `${account.label || account.blogId || account.naverId} 계정 글쓰기 편집기 확인 완료.`);
    return publicResult;
  });
  ipcMain.handle("tistory:checkSession", async (_event, tistoryBlogId) => {
    if (activeJob) {
      throw new Error("작업 실행 중에는 티스토리 세션을 확인할 수 없습니다.");
    }
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const selectedBlogId = String(tistoryBlogId || settings.tistoryBlogId || "").trim();
    const browserProfileDir = getTistoryProfileDir(runtimeRoot, selectedBlogId);
    const key = tistorySessionKey(selectedBlogId, browserProfileDir);
    const existingTistorySession = reusableTistorySession(key);
    const result = existingTistorySession
      ? {
        status: "valid",
        reason: "reused_open_tistory_editor",
        url: existingTistorySession.page?.url?.() || "",
        preparedSession: existingTistorySession
      }
      : await checkTistorySession({
        tistoryBlogId: selectedBlogId,
        browserProfileDir,
        runtimeRoot,
        keepOpen: true,
        log: (message, level) => safeLog("session", message, level)
      });
    if (result.preparedSession) {
      activeTistorySessions.set(key, result.preparedSession);
    }
    writeSettings(runtimeRoot, {
      tistoryBlogId: selectedBlogId,
      tistorySessionStatus: result.status === "valid" ? "valid" : "unknown",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    return {
      status: result.status,
      reason: result.reason || "",
      url: result.url || ""
    };
  });
  ipcMain.handle("tistory:testPublish", (_event, form) => startTistoryTestPublish(form));
  ipcMain.handle("history:load", () => readHistory(getRuntimeRoot()));
  ipcMain.handle("history:loadDraft", (_event, jobId = "") => readHistoryDraft(getRuntimeRoot(), jobId));
  ipcMain.handle("history:publishDraft", (_event, options = {}) => publishHistoryDraft(options));
  ipcMain.handle("history:publishDrafts", (_event, options = {}) => publishHistoryDrafts(options));
  ipcMain.handle("history:regenerateDraft", (_event, options = {}) => regenerateHistoryDraft(options));
  ipcMain.handle("history:markSuccess", (_event, options = {}) => markHistorySuccess(options));
  ipcMain.handle("history:updateCategory", (_event, options = {}) => updateHistoryCategory(options));
  ipcMain.handle("history:delete", (_event, options = {}) => deleteHistoryRecords(options));
  ipcMain.handle("history:analyzePublishFailure", (_event, jobId = "") => analyzeHistoryPublishFailure(getRuntimeRoot(), jobId));
  ipcMain.handle("recovery:overview", () => recoveryOverview(getRuntimeRoot()));
  ipcMain.handle("recovery:recordAttempt", (_event, options = {}) => recordRecoveryAttempt(getRuntimeRoot(), options));
  ipcMain.handle("daily:load", (_event, date = "") => {
    const runtimeRoot = getRuntimeRoot();
    return {
      memberSource: readMemberSource(runtimeRoot),
      plan: hydrateDailyPlanDraftAssets(runtimeRoot, readDailyPlan(runtimeRoot, date), { persist: true }),
      styleRules: readStyleRules(runtimeRoot)
    };
  });
  ipcMain.handle("daily:crawlMemberBoard", (_event, options = {}) => crawlDailyMemberBoard(options));
  ipcMain.handle("daily:crawlNaverStyle", (_event, options = {}) => crawlDailyNaverStyle(options));
  ipcMain.handle("daily:preparePlan", (_event, options = {}) => prepareDailyPlan(options));
  ipcMain.handle("daily:generateDrafts", (_event, options = {}) => generateDailyDrafts(options));
  ipcMain.handle("daily:runRandomResearch", (_event, options = {}) => runRandomDailyResearch(options));
  ipcMain.handle("daily:approveItem", (_event, { date, itemId, approved = true } = {}) => {
    const runtimeRoot = getRuntimeRoot();
    const plan = readDailyPlan(runtimeRoot, date);
    const item = plan?.items?.find((entry) => entry.id === itemId);
    return updatePlanItem(runtimeRoot, date, itemId, {
      status: approved ? "승인됨" : (item?.draftReady ? "초안 생성 완료" : "대기")
    });
  });
  ipcMain.handle("daily:updateCategory", (_event, options = {}) => updateDailyItemCategory(options));
  ipcMain.handle("daily:publishApproved", (_event, options = {}) => publishApprovedDaily(options));
  ipcMain.handle("scheduler:load", () => readSchedulerStatus(getRuntimeRoot()));
  ipcMain.handle("scheduler:checkToday", () => todayMorningPrepState(getRuntimeRoot()));
  ipcMain.handle("scheduler:runMissedToday", async () => {
    const runtimeRoot = getRuntimeRoot();
    const state = todayMorningPrepState(runtimeRoot);
    if (!state.needsManualRun) {
      return { status: "skipped", reason: state.reason };
    }
    return executeScheduledStage("morning-prep", { shutdownAfter: false });
  });
  ipcMain.handle("scheduler:register", () => {
    const runtimeRoot = getRuntimeRoot();
    const status = registerWindowsScheduler({
      runtimeRoot,
      executablePath: process.execPath,
      appPath: app.getAppPath(),
      workingDirectory: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
      scriptPath: getSchedulerScriptPath()
    });
    emit("scheduler:update", status);
    safeLog("daily-scheduler", "Windows 작업 스케줄러에 09:00 랜덤 주제·온새카 등록 / 10:30 재시도 / 12:00 승인 네이버 발행 작업을 등록했습니다.");
    return status;
  });
  ipcMain.handle("scheduler:unregister", () => {
    const runtimeRoot = getRuntimeRoot();
    const status = unregisterWindowsScheduler({
      runtimeRoot,
      scriptPath: getSchedulerScriptPath()
    });
    emit("scheduler:update", status);
    safeLog("daily-scheduler", "Windows 작업 스케줄러 예약 작업을 해제했습니다.");
    return status;
  });
  ipcMain.handle("job:start", (_event, form) => startJob(form));
  ipcMain.handle("job:resume", (_event, options = {}) => resumeJob(options));
  ipcMain.handle("runtime:open", () => shell.openPath(getRuntimeRoot()));
  ipcMain.handle("file:open", (_event, filePath) => {
    if (!filePath) return false;
    const runtimeRoot = path.resolve(getRuntimeRoot());
    const resolved = path.resolve(String(filePath));
    if (!resolved.startsWith(runtimeRoot)) {
      throw new Error("런타임 폴더 밖의 파일은 열 수 없습니다.");
    }
    return shell.openExternal(pathToFileURL(resolved).toString());
  });
  ipcMain.handle("file:showInFolder", (_event, filePath) => {
    if (!filePath) return false;
    const runtimeRoot = path.resolve(getRuntimeRoot());
    const resolved = path.resolve(String(filePath));
    if (!resolved.startsWith(runtimeRoot)) {
      throw new Error("런타임 폴더 밖의 파일 위치는 열 수 없습니다.");
    }
    shell.showItemInFolder(resolved);
    return true;
  });

  if (scheduledStage) {
    setTimeout(() => executeScheduledStage(scheduledStage, {
      // 09:00/10:30 이후에는 사용자가 초안을 확인·승인할 수 있도록 앱을 유지합니다.
      shutdownAfter: scheduledStage === "publish-approved"
    }), 700);
  }

  if (process.env.BLOGAUTO_AUTOSTART === "1") {
    const runAutostart = () => {
      const runtimeRoot = getRuntimeRoot();
      const settings = readSettings(runtimeRoot);
      setTimeout(() => {
        startJob(settings).catch((error) => {
          safeLog("autorun", error.message, "error");
          updateStatus("autorun", "failed", error.message);
        });
      }, 700);
    };

    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once("did-finish-load", runAutostart);
    } else {
      runAutostart();
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const key of activeTistorySessions.keys()) {
    closeTistorySession(key).catch(() => {});
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  for (const session of activeNaverSessions.values()) {
    session.context?.close().catch(() => {});
  }
  activeNaverSessions.clear();
  closeAllReusablePublishSessions().catch(() => {});
});
