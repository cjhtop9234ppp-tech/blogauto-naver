const state = {
  currentJobId: "",
  running: false,
  autoRunning: false,
  autoPausedForSession: false,
  autoWaitingSessionAccountId: "",
  autoResumeAccountId: "",
  autoPendingSessionTarget: null,
  saveTimer: null,
  autoDelayWake: null,
  tokenTotal: 0,
  codexRateLimits: null,
  chrome: { available: true, path: "" },
  accountStore: { selectedAccountId: "", accounts: [] },
  tistorySessionStatus: "unknown",
  accountManagerOpen: false,
  categoryManagerOpen: false,
  historyModalOpen: false,
  historyItems: [],
  historyFilter: "all",
  selectedHistoryJobIds: new Set(),
  draggingAccountId: "",
  draggingCategoryId: "",
  editingCategoryId: "",
  sourceMode: "research",
  sourceFilePaths: [],
  sourceDocuments: [],
  sourceConflicts: [],
  sourceErrors: [],
  dailyDate: "",
  dailyPlan: null,
  scheduler: { registered: false, tasks: [], lastRuns: {} },
  resumeJobId: "",
  resumeStage: "",
  resumeReason: ""
};

const $ = (selector) => document.querySelector(selector);
const DEFAULT_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const DEFAULT_GOOGLE_SEARCH_URL = "https://www.google.com/search?q={query}&num=20&hl=ko";
const STARTUP_NOTICE_KEY = "blogauto.startupNotice.dismissed.v2";
const DEFAULT_AGENT_MODELS = {
  main: "high",
  research: "high",
  writer: "high",
  image: "medium"
};
const CODEX_MODEL_IDS = new Set([
  "",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex"
]);
const AGENT_MODEL_SELECTORS = {
  main: "#mainAgentModel",
  research: "#researchAgentModel",
  writer: "#writerAgentModel",
  image: "#imageWorkerModel"
};
const VALID_AGENT_MODEL_VALUES = new Set(["low", "medium", "high", "xhigh"]);
const AUTO_TARGET_MAX_ATTEMPTS = 3;
const AUTO_RESEARCH_MAX_ATTEMPTS = 2;
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1"]);
const NAVER_BLOG_CATEGORY_OPTIONS = [
  { name: "알아두면 좋은 지식", categoryNo: "7" },
  { name: "(기본지식) 견적작성", categoryNo: "6" },
  { name: "(CAG) 비교분석프로그램란", categoryNo: "1" }
];

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function normalizeCodexModel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CODEX_MODEL_IDS.has(normalized) ? normalized : "";
}

function normalizeSearchProvider(value, fallback = "naver") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["naver", "google"].includes(normalized) ? normalized : fallback;
}

function normalizeSearchChannel(value, fallback = "blog") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["blog", "news", "web"].includes(normalized) ? normalized : fallback;
}

function searchChannelLabel(value) {
  const channel = normalizeSearchChannel(value);
  if (channel === "news") return "검색: 뉴스";
  if (channel === "web") return "검색: 웹";
  return "검색: 블로그";
}

function fallbackSearchProviderFor(primary) {
  return normalizeSearchProvider(primary, "naver") === "google" ? "naver" : "google";
}

function categorySearchProviders(category = {}) {
  const primarySearchProvider = normalizeSearchProvider(category?.primarySearchProvider, "naver");
  let fallbackSearchProvider = normalizeSearchProvider(
    category?.fallbackSearchProvider,
    fallbackSearchProviderFor(primarySearchProvider)
  );
  if (fallbackSearchProvider === primarySearchProvider) {
    fallbackSearchProvider = fallbackSearchProviderFor(primarySearchProvider);
  }
  return { primarySearchProvider, fallbackSearchProvider };
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSelectedAccount() {
  const accounts = state.accountStore.accounts || [];
  if (!accounts.length) {
    state.accountStore.selectedAccountId = "";
    return null;
  }
  const selected = accounts.find((account) => account.id === state.accountStore.selectedAccountId);
  if (selected) return selected;
  state.accountStore.selectedAccountId = accounts[0].id;
  return accounts[0];
}

function selectedAccount() {
  return ensureSelectedAccount();
}

function configuredBlogCategoryNames() {
  const account = selectedAccount();
  return [...new Set((account?.categories || [])
    .map((category) => String(category?.name || "").trim())
    .filter(Boolean))];
}

function refreshCategoryDatalists() {
  const names = configuredBlogCategoryNames();
  for (const id of ["historyCategoryOptions", "dailyCategoryOptions"]) {
    const datalist = document.getElementById(id);
    if (!datalist) continue;
    datalist.replaceChildren(...names.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      return option;
    }));
  }
}

function renderHistoryCategoryOptions(currentValue) {
  const current = String(currentValue || "").trim();
  const knownNames = new Set(NAVER_BLOG_CATEGORY_OPTIONS.map((option) => option.name));
  const options = NAVER_BLOG_CATEGORY_OPTIONS.map((option, index) => `
    <option value="${escapeHtml(option.name)}" ${current === option.name || (!current && index === 0) ? "selected" : ""}>${escapeHtml(option.name)}</option>
  `);
  if (current && !knownNames.has(current)) {
    options.unshift(`<option value="${escapeHtml(current)}" selected>현재 저장값: ${escapeHtml(current)}</option>`);
  }
  return options.join("");
}

function accountDisplayName(account) {
  return String(account?.label || account?.blogId || account?.naverId || "Naver 계정");
}

function setRunState(status, detail = "") {
  const badge = $("#runState");
  const classMap = {
    success: "success",
    generated: "success",
    PUBLISHED: "success",
    DRY_RUN: "info",
    PREVIEW_READY: "info",
    READY_TO_PUBLISH: "info",
    PUBLISHED: "success",
    DRY_RUN: "success",
    PREVIEW_READY: "info",
    READY_TO_PUBLISH: "info",
    PUBLISHING: "info",
    failed: "danger",
    codex_usage_limit: "danger",
    codex_exec_failed: "danger",
    session_expired: "danger",
    duplicate_retry: "warning",
    publishing: "info",
    generating: "info"
  };
  const labelMap = {
    success: "성공",
    generated: "DRY_RUN",
    DRY_RUN: "DRY_RUN",
    PREVIEW_READY: "DRY_RUN",
    READY_TO_PUBLISH: "DRY_RUN",
    PUBLISHED: "성공",
    DRY_RUN: "생성",
    PREVIEW_READY: "생성",
    READY_TO_PUBLISH: "생성",
    failed: "실패",
    codex_usage_limit: "한도초과",
    codex_exec_failed: "Codex실패",
    session_expired: "세션만료",
    duplicate_retry: "중복",
    publishing: "발행",
    generating: "생성중",
    PUBLISHED: "발행완료",
    DRY_RUN: "미리보기",
    PREVIEW_READY: "미리보기 준비",
    READY_TO_PUBLISH: "발행 준비",
    PUBLISHING: "발행중"
  };
  badge.className = `badge ${classMap[status] || "info"}`;
  badge.textContent = detail && detail !== status ? detail : (labelMap[status] || status || "대기");
}

function setTistoryTestButtonDisabled(disabled) {
  const button = $("#tistoryTestButton");
  if (button) button.disabled = disabled;
}

function addLog(payload) {
  const streamMap = {
    main: "#mainLogStream",
    research: "#researchLogStream",
    writer: "#writerLogStream",
    image: "#mainLogStream"
  };
  const stream = $(streamMap[payload.agent] || streamMap.main);
  if (!stream) return;
  const line = document.createElement("div");
  line.className = `log-line ${payload.level || "info"}`;
  const time = payload.at ? new Date(payload.at).toLocaleTimeString() : new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${payload.message}`;
  stream.appendChild(line);
  stream.scrollTop = stream.scrollHeight;
  if (String(payload.jobId || "").startsWith("daily-") && $("#dailyWorkflowStatus")) {
    $("#dailyWorkflowStatus").textContent = payload.message;
  }
}

function shouldRetryAutoResult(result) {
  const status = String(result?.status || "").toLowerCase();
  if (["success", "generated", "codex_usage_limit", "codex_exec_failed", "session_expired"].includes(status)) {
    return false;
  }
  if (status === "duplicate_retry") return true;
  return String(result?.failurePhase || "").toLowerCase() === "research";
}

function autoAttemptLimitForResult(result) {
  return String(result?.failurePhase || "").toLowerCase() === "research"
    ? AUTO_RESEARCH_MAX_ATTEMPTS
    : AUTO_TARGET_MAX_ATTEMPTS;
}

function autoResultReason(result) {
  return String(result?.reason || result?.failureReason || result?.status || "unknown").trim();
}

function keywordLanePhrasesFromResult(result) {
  const lane = result?.keywordLane || {};
  return [
    lane.topicLane,
    ...(Array.isArray(lane.selectedKeywordPhrases) ? lane.selectedKeywordPhrases : [])
  ]
    .map((phrase) => String(phrase || "").trim())
    .filter(Boolean);
}

function runAutoStartJob(form) {
  const testStartJob = window.__blogAutoTestHooks?.startJob;
  if (typeof testStartJob === "function") {
    return testStartJob(form);
  }
  return window.blogAuto.startJob(form);
}

function clearAgentLogs() {
  ["#mainLogStream", "#researchLogStream", "#writerLogStream"].forEach((selector) => {
    const stream = $(selector);
    if (stream) stream.innerHTML = "";
  });
}

function formatTokens(total) {
  const value = Number(total || 0);
  return `${value.toLocaleString()} tokens`;
}

function setTokenTotal(total) {
  state.tokenTotal = Number(total || 0);
  $("#tokenBadge").textContent = `누적 ${formatTokens(state.tokenTotal)}`;
}

function formatPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "-";
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function limitBadgeClass(limitWindow) {
  const remaining = Number(limitWindow?.remainingPercent);
  if (!Number.isFinite(remaining)) return "badge limit unknown";
  if (remaining <= 10) return "badge limit danger";
  if (remaining <= 25) return "badge limit warning";
  return "badge limit";
}

function codexLimitWindows(rateLimits) {
  return [rateLimits?.primary, rateLimits?.secondary]
    .filter((limitWindow) => limitWindow && typeof limitWindow === "object");
}

function weeklyCodexLimitWindow(rateLimits) {
  const windows = codexLimitWindows(rateLimits);
  const weekly = windows.find((limitWindow) => Number(limitWindow.windowMinutes) === 10080);
  if (weekly) return weekly;
  return windows
    .slice()
    .sort((left, right) => Number(right.windowMinutes || 0) - Number(left.windowMinutes || 0))[0] || null;
}

function renderCodexRateLimits(status = "") {
  const weeklyBadge = $("#codexWeeklyLimitBadge");
  if (!weeklyBadge) return;

  const rateLimits = state.codexRateLimits || {};
  const weekly = weeklyCodexLimitWindow(rateLimits);

  weeklyBadge.className = limitBadgeClass(weekly);
  weeklyBadge.textContent = `주간 잔량 ${formatPercent(weekly?.remainingPercent)}`;

  if (status === "checking" && !weekly) {
    weeklyBadge.textContent = "주간 확인 중";
  }
  if (status === "failed" && !weekly) {
    weeklyBadge.textContent = "주간 확인 실패";
  }
}

function setCodexRateLimits(rateLimits, status = "") {
  if (rateLimits && typeof rateLimits === "object") {
    state.codexRateLimits = rateLimits;
  }
  renderCodexRateLimits(status);
}

function statusBadge(status) {
  const classMap = {
    success: "success",
    generated: "success",
    failed: "danger",
    codex_usage_limit: "danger",
    codex_exec_failed: "danger",
    session_expired: "danger",
    duplicate_retry: "warning",
    publishing: "info",
    generating: "info"
  };
  const labelMap = {
    success: "성공",
    generated: "생성",
    failed: "실패",
    codex_usage_limit: "한도초과",
    codex_exec_failed: "Codex실패",
    session_expired: "세션만료",
    duplicate_retry: "중복",
    publishing: "발행",
    generating: "생성중"
  };
  const filter = historyStatusFilterKey(status);
  return `<button type="button" class="badge history-status-filter ${classMap[status] || "info"}" data-history-filter="${filter}" title="${filter === "all" ? "전체 보기" : `${filter} 상태만 보기`}">${labelMap[status] || status || "대기"}</button>`;
}

function sessionBadge(account) {
  const status = account.sessionStatus || "unknown";
  const className = status === "valid" ? "success" : status === "expired" ? "danger" : "warning";
  const label = status === "valid" ? "정상" : status === "expired" ? "세션만료" : "미확인";
  return `<span class="badge ${className}">${label}</span>`;
}

function updateSessionNotice() {
  const notice = $("#sessionNotice");
  const text = $("#sessionNoticeText");
  if (!notice || !text) return;

  const accounts = state.accountStore.accounts || [];
  const needsLogin = !accounts.length || accounts.some((account) => account.sessionStatus !== "valid");
  if (!needsLogin) {
    notice.hidden = true;
    return;
  }

  if (!accounts.length) {
    text.textContent = "처음 실행 상태입니다. 계정을 추가한 뒤 계정별 세션 확인을 눌러 브라우저에서 로그인을 완료해 주세요.";
  } else {
    const names = accounts
      .filter((account) => account.sessionStatus !== "valid")
      .map((account) => accountDisplayName(account))
      .join(", ");
    text.textContent = `로그인이 필요한 계정: ${names}. 계정별로 선택 후 세션 확인을 진행해 주세요.`;
  }
  notice.hidden = false;
}

function wakeAutoDelay() {
  const wake = state.autoDelayWake;
  if (typeof wake === "function") {
    state.autoDelayWake = null;
    wake();
  }
}

function signalAutoSessionResume(accountId) {
  const verifiedAccountId = String(accountId || "");
  if (state.autoWaitingSessionAccountId && state.autoWaitingSessionAccountId === verifiedAccountId) {
    state.autoResumeAccountId = verifiedAccountId;
    wakeAutoDelay();
  }
}

async function checkAccountSession(account, options = {}) {
  if (!account) return;
  const resumeAuto = options.resumeAuto !== false;
  const startAuto = options.startAuto !== false;
  setRunState("generating", "로그인 완료 대기 중");
  addLog({
    level: "info",
    message: `${accountDisplayName(account)} 계정의 브라우저가 열리면 아이디와 비밀번호를 직접 입력해 로그인해 주세요.`,
    at: new Date().toISOString()
  });
  try {
    const result = await window.blogAuto.checkAccountSession(account.id, {
      includeTistorySession: options.includeTistorySession !== false
    });
    const currentAccount = state.accountStore.accounts.find((item) => item.id === account.id);
    const tistoryValid = !result.tistorySession || result.tistorySession.status === "valid";
    if (result.tistorySession) {
      state.tistorySessionStatus = result.tistorySession.status || "unknown";
      addLog({
        level: tistoryValid ? "info" : "warn",
        message: tistoryValid ? "티스토리 세션 확인 완료." : `티스토리 세션 확인 실패: ${result.tistorySession.reason || result.tistorySession.status}`,
        at: new Date().toISOString()
      });
    }
    if (result.status === "valid") {
      if (currentAccount) currentAccount.sessionStatus = "valid";
      renderAccounts();
      setRunState("generated", "세션 정상");
      const verifiedAccountId = currentAccount?.id || account.id || "";
      if (resumeAuto && state.autoRunning && state.autoWaitingSessionAccountId === verifiedAccountId) {
        addLog({
          level: "info",
          message: "현재 대기 중인 계정의 세션확인이 완료되어 자동 작업을 바로 이어갑니다.",
          at: new Date().toISOString()
        });
        signalAutoSessionResume(verifiedAccountId);
      } else if (resumeAuto && state.autoRunning && state.autoWaitingSessionAccountId) {
        addLog({
          level: "info",
          message: "세션확인은 완료되었지만 현재 대기 중인 계정이 아니므로 대기 작업은 유지합니다.",
          at: new Date().toISOString()
        });
      } else if (startAuto && !state.autoRunning && state.autoPendingSessionTarget?.accountId === verifiedAccountId) {
        const pending = state.autoPendingSessionTarget;
        addLog({
          level: "info",
          message: `${pending.accountLabel || accountDisplayName(account)} / ${pending.categoryName} 대기 작업을 다시 시작합니다.`,
          at: new Date().toISOString()
        });
        const startKey = pending.key;
        state.autoPendingSessionTarget = null;
        window.setTimeout(() => {
          startAutoPublishing(startKey).catch((error) => {
            state.running = false;
            state.autoRunning = false;
            state.autoPausedForSession = false;
            state.autoWaitingSessionAccountId = "";
            state.autoResumeAccountId = "";
            state.autoPendingSessionTarget = null;
            addLog({ level: "error", message: error.message, at: new Date().toISOString() });
            setRunState("failed", "실패");
          });
        }, 0);
      } else {
        const autoTarget = startAuto && $("#topicMode").value === "auto" ? firstAutoTargetForAccount(verifiedAccountId) : null;
        if (autoTarget && !state.running && !state.autoRunning) {
          const startKey = autoTargetKey(autoTarget);
          addLog({
            level: "info",
            message: `${accountDisplayName(autoTarget.account)} / ${autoTarget.category.name} 자동 작업을 바로 시작합니다.`,
            at: new Date().toISOString()
          });
          window.setTimeout(() => {
            startAutoPublishing(startKey).catch((error) => {
              state.running = false;
              state.autoRunning = false;
              state.autoPausedForSession = false;
              state.autoWaitingSessionAccountId = "";
              state.autoResumeAccountId = "";
    state.autoPendingSessionTarget = null;
    $("#startButton").disabled = false;
    setTistoryTestButtonDisabled(false);
    $("#stopAutoButton").disabled = true;
              addLog({ level: "error", message: error.message, at: new Date().toISOString() });
              setRunState("failed", "실패");
            });
          }, 0);
        } else {
          addLog({
            level: "info",
            message: "계정 세션확인이 완료되었습니다. 작업 시작을 누르면 이 세션으로 바로 진행합니다.",
            at: new Date().toISOString()
          });
        }
      }
    } else if (result.status === "expired") {
      if (currentAccount) currentAccount.sessionStatus = "expired";
      renderAccounts();
      setRunState("session_expired", "세션만료");
    } else {
      if (currentAccount) currentAccount.sessionStatus = "unknown";
      renderAccounts();
      setRunState("failed", "세션 확인 실패");
    }
  } catch (error) {
    addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    setRunState("failed", "세션 확인 실패");
  }
}

async function checkSelectedAccountSessions() {
  if (state.running || state.autoRunning) {
    addLog({ level: "warn", message: "작업 실행 중에는 세션일괄확인을 시작할 수 없습니다.", at: new Date().toISOString() });
    return;
  }
  const button = $("#bulkSessionCheckButton");
  const accounts = (state.accountStore.accounts || []).filter((account) => account.checked !== false);
  if (!accounts.length) {
    addLog({ level: "warn", message: "세션을 확인할 체크된 계정이 없습니다.", at: new Date().toISOString() });
    return;
  }

  if (button) button.disabled = true;
  addLog({ level: "info", message: `체크된 계정 ${accounts.length}개의 세션을 순차 확인합니다.`, at: new Date().toISOString() });
  try {
    const form = collectForm();
    if (form.publishToTistoryAfterNaver && form.tistoryBlogId) {
      try {
        const tistoryResult = await window.blogAuto.checkTistorySession(form.tistoryBlogId);
        state.tistorySessionStatus = tistoryResult.status || "unknown";
        addLog({
          level: tistoryResult.status === "valid" ? "info" : "warn",
          message: tistoryResult.status === "valid" ? "티스토리 세션 확인 완료." : `티스토리 세션 확인 실패: ${tistoryResult.reason || tistoryResult.status}`,
          at: new Date().toISOString()
        });
      } catch (error) {
        state.tistorySessionStatus = "expired";
        addLog({ level: "warn", message: `티스토리 세션 확인 실패: ${error.message}`, at: new Date().toISOString() });
      }
    }
    for (const account of accounts) {
      addLog({
        level: "info",
        message: `${accountDisplayName(account)} 계정 세션 확인을 시작합니다.`,
        at: new Date().toISOString()
      });
      await checkAccountSession(account, { resumeAuto: false, startAuto: false, includeTistorySession: false });
    }
    addLog({ level: "info", message: "세션일괄확인이 완료되었습니다.", at: new Date().toISOString() });
  } finally {
    if (button) button.disabled = false;
  }
}

function showStartupNoticeIfNeeded() {
  const notice = $("#startupNotice");
  if (!notice) return;
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(STARTUP_NOTICE_KEY) === "true";
  } catch {
    dismissed = false;
  }
  notice.hidden = dismissed && state.chrome.available !== false;
}

async function dismissStartupNotice() {
  const notice = $("#startupNotice");
  if (notice) notice.hidden = true;
  try {
    window.localStorage.setItem(STARTUP_NOTICE_KEY, "true");
  } catch {
    // Ignore storage failures; the notice can still be dismissed for this session.
  }
  if (state.chrome.available === false) {
    window.alert("Chrome이 설치되어 있지 않아 네이버 세션 확인과 블로그 발행을 진행할 수 없습니다. Chrome 설치 페이지를 연 뒤 프로그램을 종료합니다.");
    await window.blogAuto.openChromeInstallAndQuit();
  }
}

async function refreshCodexUsageOnStartup() {
  renderCodexRateLimits("checking");
  try {
    const usage = await window.blogAuto.refreshCodexUsage();
    if (usage?.rateLimits) {
      setCodexRateLimits(usage.rateLimits);
    } else if (!state.codexRateLimits) {
      renderCodexRateLimits();
    }
  } catch (error) {
    if (!state.codexRateLimits) {
      renderCodexRateLimits();
    }
  }
}

const HISTORY_DRAFT_STATUSES = ["DRY_RUN", "generated", "PREVIEW_READY", "READY_TO_PUBLISH"];
const HISTORY_RETRY_STATUSES = ["failed", "session_expired"];
const HISTORY_FILTER_DRAFT_STATUSES = new Set(HISTORY_DRAFT_STATUSES);
const HISTORY_FILTER_SUCCESS_STATUSES = new Set(["success", "PUBLISHED"]);

function historyStatusFilterKey(status) {
  const normalized = String(status || "");
  if (HISTORY_FILTER_SUCCESS_STATUSES.has(normalized)) return "success";
  if (HISTORY_FILTER_DRAFT_STATUSES.has(normalized)) return "dry_run";
  return "failed";
}

function historyMatchesFilter(item, filter = state.historyFilter) {
  return filter === "all" || historyStatusFilterKey(item?.status) === filter;
}

function currentHistoryVisibleItems() {
  return (Array.isArray(state.historyItems) ? state.historyItems : [])
    .filter((item) => historyMatchesFilter(item))
    .slice(0, 20);
}

function updateHistoryFilterButtons() {
  document.querySelectorAll("[data-history-filter]").forEach((button) => {
    const active = button.dataset.historyFilter === state.historyFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function historyHasArtifact(item) {
  return /^job_[A-Za-z0-9_-]+$/.test(String(item?.id || ""));
}

function historyCanPublish(item) {
  if (!historyHasArtifact(item)) return false;
  const status = String(item.status || "");
  const verdict = String(item.final_verdict || "").trim();
  const reviewAllowsPublish = !verdict || verdict === "PASS";
  if (HISTORY_DRAFT_STATUSES.includes(status)) return reviewAllowsPublish;
  return HISTORY_RETRY_STATUSES.includes(status) && reviewAllowsPublish;
}

function historyCanMarkSuccess(item) {
  if (!historyHasArtifact(item)) return false;
  return !["success", "PUBLISHED"].includes(String(item.status || ""));
}

function historyCanSelect(item) {
  return historyHasArtifact(item);
}

function updateHistoryBulkControls() {
  const visibleItems = currentHistoryVisibleItems();
  const selectable = visibleItems.filter(historyCanSelect);
  const publishable = visibleItems.filter(historyCanPublish);
  const markable = visibleItems.filter(historyCanMarkSuccess);
  const selected = selectable.filter((item) => state.selectedHistoryJobIds.has(String(item.id)));
  const selectedPublishable = publishable.filter((item) => state.selectedHistoryJobIds.has(String(item.id)));
  const selectedMarkable = markable.filter((item) => state.selectedHistoryJobIds.has(String(item.id)));
  const selectedFailed = visibleItems
    .filter((item) => historyStatusFilterKey(item.status) === "failed" && state.selectedHistoryJobIds.has(String(item.id)));
  const selectAll = $("#historySelectAll");
  const selectedStatus = $("#historySelectionStatus");
  const publishButton = $("#publishSelectedHistoryButton");
  const markSuccessButton = $("#markSelectedHistorySuccessButton");
  const feedbackButton = $("#analyzeSelectedHistoryButton");
  const deleteButton = $("#deleteSelectedHistoryButton");
  const categorySelect = $("#bulkHistoryCategorySelect");
  const categoryButton = $("#applyHistoryCategoryButton");
  if (selectAll) {
    selectAll.disabled = selectable.length === 0;
    selectAll.checked = selectable.length > 0 && selected.length === selectable.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < selectable.length;
  }
  if (selectedStatus) selectedStatus.textContent = `선택 ${selected.length}건 / 발행 가능 ${publishable.length}건 / 성공 처리 가능 ${markable.length}건`;
  if (publishButton) publishButton.disabled = selectedPublishable.length === 0;
  if (markSuccessButton) markSuccessButton.disabled = selectedMarkable.length === 0;
  if (feedbackButton) feedbackButton.disabled = selectedFailed.length === 0;
  if (deleteButton) deleteButton.disabled = selected.length === 0;
  if (categorySelect) categorySelect.disabled = selected.length === 0;
  if (categoryButton) categoryButton.disabled = selected.length === 0 || !String(categorySelect?.value || "").trim();
}

async function publishOneHistoryDraft(jobId, title, button, { confirmBefore = true } = {}) {
  if (confirmBefore && !window.confirm(`이력 글을 네이버에 발행할까요?\n\n${title}`)) return false;
  if (button) button.disabled = true;
  try {
    await window.blogAuto.publishHistoryDraft({
      jobId,
      publishVisibility: "public",
      publishScheduleMode: $("#publishScheduleMode")?.value || ""
    });
    state.selectedHistoryJobIds.delete(jobId);
    addLog({ level: "info", message: `작업 이력 글 발행 완료: ${title}`, at: new Date().toISOString() });
    renderHistory(await window.blogAuto.loadHistory());
    return true;
  } catch (error) {
    addLog({ level: "error", message: `작업 이력 글 발행 실패: ${error.message}`, at: new Date().toISOString() });
    addLog({ level: "warn", message: "발행 브라우저는 닫히지 않았습니다. 원인 분석·재발행 버튼으로 진단하거나 문제 해결 후 다시 시도하세요.", at: new Date().toISOString() });
    if (button) button.disabled = false;
    return false;
  }
}

async function showHistoryPublishFeedback(jobId, title, button) {
  if (button) button.disabled = true;
  try {
    const result = await window.blogAuto.analyzeHistoryPublishFailure(jobId);
    const failedAt = result.failedAt ? `\n실패 시각: ${formatHistoryDate(result.failedAt)}` : "";
    const feedback = [
      `제목: ${result.title || title}`,
      `최근 오류: ${result.errorMessage || "기록 없음"}${failedAt}`,
      `\n원인 분석: ${result.diagnosis}`,
      `수정 내용: ${result.fix}`,
      `다음 조치: ${result.action}`
    ].join("\n");
    if (!result.canRetry) {
      if (result.canRegenerate && window.confirm(`${feedback}\n\n연결된 초안 파일이 없지만 원본 자료가 있습니다. 원문 범위 내에서 초안을 재생성할까요?`)) {
        try {
          const regenerated = await window.blogAuto.regenerateHistoryDraft({ jobId });
          addLog({ level: "info", message: `초안 재생성이 완료되었습니다: ${regenerated.title || regenerated.jobId}`, at: new Date().toISOString() });
          renderHistory(regenerated.history || await window.blogAuto.loadHistory());
          if (window.confirm(`초안 재생성이 완료되었습니다. 새 초안을 바로 네이버에 발행할까요?\n\n제목: ${regenerated.title || "제목 확인 필요"}\n공개설정: 전체공개\n카테고리: 알아두면 좋은 지식 또는 저장된 발행 카테고리`)) {
            await publishOneHistoryDraft(regenerated.jobId, regenerated.title || "재생성 초안", null, { confirmBefore: false });
          }
        } catch (error) {
          addLog({ level: "error", message: `작업 이력 초안 재생성 실패: ${error.message}`, at: new Date().toISOString() });
        }
      } else {
        window.alert(feedback + "\n\n현재 초안 상태가 자동 재발행 대상이 아니므로 본문을 먼저 확인해야 합니다.");
      }
      return;
    }
    if (window.confirm(`${feedback}\n\n수정 내용을 적용해 지금 자동 재발행할까요?`)) {
      await publishOneHistoryDraft(jobId, title, button, { confirmBefore: false });
    }
  } catch (error) {
    addLog({ level: "error", message: `작업 이력 발행 원인 분석 실패: ${error.message}`, at: new Date().toISOString() });
  } finally {
    if (button && !button.isConnected) return;
    if (button && !button.disabled) button.disabled = false;
  }
}

async function analyzeAndRepublishSelectedHistory(items, button) {
  const seenJobIds = new Set();
  const queue = (Array.isArray(items) ? items : []).filter((item) => {
    const jobId = String(item?.id || "").trim();
    if (!jobId || seenJobIds.has(jobId)) return false;
    seenJobIds.add(jobId);
    return true;
  });
  if (!queue.length) return false;
  const titles = queue.map((item) => item.title || item.research_title || item.topic || "제목 없음");
  if (!window.confirm(`선택한 실패 이력 ${queue.length}건을 순서대로 원인 분석하고 가능한 항목은 자동 재발행할까요?\n\n${titles.join("\n")}\n\n각 항목은 독립적으로 처리하며, 한 항목이 실패해도 다음 항목을 계속 진행합니다. 실패 항목은 결과에 따로 표시됩니다.`)) return false;
  if (button) button.disabled = true;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      const jobId = String(item.id || "");
      const title = item.title || item.research_title || item.topic || "제목 없음";
      addLog({ level: "info", message: `[${index + 1}/${queue.length}] '${title}' 원인 분석·재발행을 시작합니다.`, at: new Date().toISOString() });
      try {
        const diagnosis = await window.blogAuto.analyzeHistoryPublishFailure(jobId);
        addLog({ level: "info", message: `[${title}] 원인 분석 완료: ${diagnosis.diagnosis || "분석 결과 확인 필요"}`, at: new Date().toISOString() });
        let publishJobId = jobId;
        let publishTitle = title;
        if (!diagnosis.canRetry) {
          if (!diagnosis.canRegenerate) {
            skipped += 1;
            addLog({ level: "warn", message: `[${index + 1}/${queue.length}] [${title}] 재발행 가능한 초안이 없어 건너뛰었습니다. 다음 항목으로 진행합니다.`, at: new Date().toISOString() });
            continue;
          }
          const regenerated = await window.blogAuto.regenerateHistoryDraft({ jobId });
          publishJobId = regenerated.jobId;
          publishTitle = regenerated.title || title;
          addLog({ level: "info", message: `[${title}] 초안을 재생성했습니다. 재발행을 진행합니다.`, at: new Date().toISOString() });
        }
        await window.blogAuto.publishHistoryDraft({
          jobId: publishJobId,
          publishVisibility: "public",
          publishScheduleMode: $("#publishScheduleMode")?.value || ""
        });
        completed += 1;
        addLog({ level: "info", message: `[${index + 1}/${queue.length}] 선택 원인 분석·재발행 완료: ${publishTitle}. 다음 항목으로 진행합니다.`, at: new Date().toISOString() });
      } catch (error) {
        failed += 1;
        addLog({ level: "error", message: `[${index + 1}/${queue.length}] '${title}' 처리 실패: ${error.message}`, at: new Date().toISOString() });
        addLog({ level: "warn", message: "현재 항목은 실패로 기록하고 발행 브라우저는 유지합니다. 다음 선택 항목으로 계속 진행합니다.", at: new Date().toISOString() });
        // A single diagnosis, regeneration, or publish failure must not abort the remaining queue.
        continue;
      }
    }
    state.selectedHistoryJobIds = new Set();
    renderHistory(await window.blogAuto.loadHistory());
    addLog({ level: skipped + failed > 0 ? "warn" : "info", message: `선택 원인 분석·재발행 결과: 완료 ${completed}건 / 확인 필요 ${skipped + failed}건 / 전체 ${queue.length}건을 순차 처리했습니다.`, at: new Date().toISOString() });
    return completed > 0;
  } finally {
    if (button) button.disabled = false;
    updateHistoryBulkControls();
  }
}

async function markHistoryItemsSuccess(jobIds, titles, button, { confirmBefore = true } = {}) {
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : [jobIds]).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) return false;
  const titleText = (Array.isArray(titles) ? titles : [titles]).filter(Boolean).join("\n");
  if (confirmBefore && !window.confirm(`이미 외부에서 발행한 ${ids.length}건을 성공으로 표시할까요?\n\n${titleText}`)) return false;
  if (button) button.disabled = true;
  try {
    const result = await window.blogAuto.markHistorySuccess({ jobIds: ids });
    state.selectedHistoryJobIds = new Set();
    addLog({ level: "info", message: `작업 이력 ${result.updated}건을 성공으로 반영했습니다.`, at: new Date().toISOString() });
    renderHistory(result.history || await window.blogAuto.loadHistory());
    return true;
  } catch (error) {
    addLog({ level: "error", message: `작업 이력 성공 처리 실패: ${error.message}`, at: new Date().toISOString() });
    return false;
  } finally {
    if (button) button.disabled = false;
    updateHistoryBulkControls();
  }
}

async function deleteSelectedHistoryItems(jobIds, titles, button) {
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : [jobIds])
    .map((value) => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) return false;
  const titleText = (Array.isArray(titles) ? titles : [titles]).filter(Boolean).join("\n");
  if (!window.confirm(`선택한 작업 이력 ${ids.length}건을 삭제할까요?\n\n${titleText}\n\n이력 목록에서만 제거되며 원본 작업 파일은 보존됩니다.`)) return false;
  if (button) button.disabled = true;
  try {
    const result = await window.blogAuto.deleteHistory({ jobIds: ids });
    state.selectedHistoryJobIds = new Set();
    addLog({ level: "info", message: `작업 이력 ${result.deleted}건을 삭제했습니다. 원본 작업 파일은 보존됩니다.`, at: new Date().toISOString() });
    renderHistory(result.history || await window.blogAuto.loadHistory());
    return true;
  } catch (error) {
    addLog({ level: "error", message: `작업 이력 삭제 실패: ${error.message}`, at: new Date().toISOString() });
    return false;
  } finally {
    if (button) button.disabled = false;
    updateHistoryBulkControls();
  }
}

function renderHistory(history) {
  const body = $("#historyBody");
  const summary = $("#historySummary");
  const modal = $("#historyModal");
  const items = Array.isArray(history) ? history : [];
  state.historyItems = items;
  refreshCategoryDatalists();
  const visibleItems = items.filter((item) => historyMatchesFilter(item)).slice(0, 20);
  const visibleIds = new Set(visibleItems.map((item) => String(item.id || "")));
  state.selectedHistoryJobIds = new Set([...state.selectedHistoryJobIds].filter((id) => visibleIds.has(id) && historyHasArtifact(visibleItems.find((item) => String(item.id) === id))));

  if (modal) modal.hidden = !state.historyModalOpen;
  if (summary) summary.innerHTML = renderHistorySummary(items);
  updateHistoryFilterButtons();

  body.innerHTML = "";
  updateHistoryBulkControls();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty history-empty";
    empty.textContent = "작업 기록이 없습니다.";
    body.appendChild(empty);
    return;
  }
  if (visibleItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty history-empty";
    empty.textContent = "현재 상태 필터에 해당하는 작업 이력이 없습니다.";
    body.appendChild(empty);
    return;
  }

  for (const item of visibleItems) {
    const card = document.createElement("article");
    card.className = `history-card ${historyStatusClass(item.status)}`;
    const title = item.title || item.research_title || item.topic || "제목 없음";
    const jobId = String(item.id || "");
    const hasJobArtifact = historyHasArtifact(item);
    const canPublish = historyCanPublish(item);
    const canMarkSuccess = historyCanMarkSuccess(item);
    const canSelect = historyCanSelect(item);
    const meta = [
      item.category && `카테고리 ${item.category}`,
      item.keyword && `키워드 ${item.keyword}`,
      item.blog_id && `블로그 ${item.blog_id}`
    ].filter(Boolean).join(" · ");
    const agentTokenText = Object.entries(item.token_agents || {})
      .filter(([, value]) => Number(value || 0) > 0)
      .map(([agent, value]) => `${agent} ${formatTokens(value)}`)
      .join(" · ");
    const detailRows = [
      ["주제", item.topic],
      ["선택 lane", item.selected_lane || item.lane || item.keyword_lane],
      ["검색어", item.search_query || item.query],
      ["Research 제목", item.research_title],
      ["검토 결과", item.final_verdict],
      ["실패 단계", item.failure_phase],
      ["근거 요약", item.source_summary],
      ["토큰 상세", Number(item.token_input || 0) > 0
        ? `입력 ${formatTokens(item.token_input)} · 캐시 ${formatTokens(item.token_cached_input)} · 출력 ${formatTokens(item.token_output)} · 유효 ${formatTokens(item.token_total)}`
        : ""],
      ["에이전트별 토큰", agentTokenText],
      ["직접 전달 프롬프트", Number(item.prompt_characters || 0) > 0 ? `${Number(item.prompt_characters).toLocaleString()}자` : ""],
      ["사유", item.reason]
    ].filter(([, value]) => String(value || "").trim());

    card.innerHTML = `
      <div class="history-card-top">
        ${canSelect ? `<label class="history-select"><input type="checkbox" data-history-select="${escapeHtml(jobId)}" ${state.selectedHistoryJobIds.has(jobId) ? "checked" : ""} /> 선택</label>` : ""}
        ${statusBadge(item.status)}
        <span class="history-date">${escapeHtml(formatHistoryDate(item.create_at))}</span>
        <span class="history-token">${escapeHtml(formatTokens(item.token_total || 0))}</span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p class="history-meta">${escapeHtml(meta || "작업 대상 정보 없음")}</p>
      ${hasJobArtifact ? `
        <label class="history-category-editor">
          <span>발행 카테고리</span>
           <select data-history-category aria-label="발행 카테고리 선택">
             ${renderHistoryCategoryOptions(item.category)}
           </select>
        </label>
      ` : ""}
      <p class="history-reason">${escapeHtml(item.reason || item.source_summary || "기록된 사유가 없습니다.")}</p>
      <details class="history-details">
        <summary>상세 보기</summary>
        <dl>
          ${detailRows.map(([label, value]) => `
            <div>
              <dt>${escapeHtml(label)}</dt>
              <dd>${escapeHtml(value)}</dd>
            </div>
          `).join("")}
        </dl>
      </details>
      ${hasJobArtifact ? `
        <div class="history-actions">
          <button type="button" class="ghost small" data-history-action="load">본문 불러오기</button>
          ${canPublish
            ? '<button type="button" class="primary small" data-history-action="publish">이력 글 발행</button>'
            : ""}
          ${canMarkSuccess
            ? '<button type="button" class="success small" data-history-action="mark-success">성공 처리</button>'
            : ""}
          <button type="button" class="ghost small" data-history-action="feedback">원인 분석·재발행</button>
        </div>
      ` : ""}
    `;
    body.appendChild(card);
    if (hasJobArtifact) {
      card.querySelector("[data-history-category]")?.addEventListener("change", async (event) => {
        const input = event.currentTarget;
        const category = String(input.value || "").trim();
        if (!category) {
          addLog({ level: "warn", message: "발행 카테고리를 입력해야 저장할 수 있습니다.", at: new Date().toISOString() });
          input.value = item.category || "";
          return;
        }
        input.disabled = true;
        try {
          const result = await window.blogAuto.updateHistoryCategory({ jobId, category });
          addLog({ level: "info", message: `작업 이력 발행 카테고리를 '${result.category}'로 저장했습니다.`, at: new Date().toISOString() });
          renderHistory(result.history || await window.blogAuto.loadHistory());
        } catch (error) {
          input.disabled = false;
          addLog({ level: "error", message: `작업 이력 카테고리 저장 실패: ${error.message}`, at: new Date().toISOString() });
        }
      });
      card.querySelector("[data-history-select]")?.addEventListener("change", (event) => {
        if (event.currentTarget.checked) state.selectedHistoryJobIds.add(jobId);
        else state.selectedHistoryJobIds.delete(jobId);
        updateHistoryBulkControls();
      });
      card.querySelector("[data-history-action='load']")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const payload = await window.blogAuto.loadHistoryDraft(jobId);
          showLoadedDraft(payload);
          addLog({ level: "info", message: `작업 이력 초안을 불러왔습니다: ${payload.title}`, at: new Date().toISOString() });
        } catch (error) {
          addLog({ level: "error", message: `작업 이력 초안 불러오기 실패: ${error.message}`, at: new Date().toISOString() });
        } finally {
          button.disabled = false;
        }
      });
      card.querySelector("[data-history-action='publish']")?.addEventListener("click", async (event) => {
        await publishOneHistoryDraft(jobId, title, event.currentTarget);
      });
      card.querySelector("[data-history-action='mark-success']")?.addEventListener("click", async (event) => {
        await markHistoryItemsSuccess([jobId], [title], event.currentTarget);
      });
      card.querySelector("[data-history-action='feedback']")?.addEventListener("click", async (event) => {
        await showHistoryPublishFeedback(jobId, title, event.currentTarget);
      });
    }
  }
  updateHistoryBulkControls();
}

function renderHistorySummary(items) {
  const total = items.length;
  const success = items.filter((item) => ["success", "PUBLISHED"].includes(String(item.status || ""))).length;
  const generated = items.filter((item) => ["generated", "DRY_RUN", "PREVIEW_READY", "READY_TO_PUBLISH"].includes(String(item.status || ""))).length;
  const failed = Math.max(0, total - success - generated);
  const latest = items[0];
  const latestTitle = latest ? (latest.title || latest.research_title || latest.topic || "제목 없음") : "기록 없음";
  const latestDate = latest ? formatHistoryDate(latest.create_at) : "-";
  return `
    <div class="history-metric">
      <strong>${escapeHtml(total)}</strong>
      <span>전체</span>
    </div>
    <div class="history-metric success">
      <strong>${escapeHtml(success)}</strong>
      <span>성공</span>
    </div>
    <div class="history-metric generated">
      <strong>${escapeHtml(generated)}</strong>
      <span>생성</span>
    </div>
    <div class="history-metric danger">
      <strong>${escapeHtml(failed)}</strong>
      <span>확인 필요</span>
    </div>
    <div class="history-latest">
      <span>최근 작업</span>
      <strong>${escapeHtml(latestTitle)}</strong>
      <em>${escapeHtml(latestDate)}</em>
    </div>
  `;
}

function historyStatusClass(status) {
  const normalized = String(status || "");
  if (["success", "generated", "PUBLISHED"].includes(normalized)) return "success";
  if (["DRY_RUN", "PREVIEW_READY", "READY_TO_PUBLISH"].includes(normalized)) return "info";
  if (normalized === "duplicate_retry") return "warning";
  if (normalized === "publishing" || normalized === "generating") return "info";
  return "danger";
}

function formatHistoryDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function closeHistoryModal() {
  state.historyModalOpen = false;
  const modal = $("#historyModal");
  if (modal) modal.hidden = true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderImages(images) {
  const grid = $("#imageGrid");
  grid.innerHTML = "";
  if (!images || images.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "생성된 이미지 파일이 없습니다. 아래 상태 메시지를 확인하세요.";
    grid.appendChild(empty);
    return;
  }

  for (const image of images) {
    const card = document.createElement("div");
    card.className = "thumb";
    card.title = image.path;
    card.innerHTML = `
      <img src="${image.url}" alt="${image.role === "title" ? "타이틀 이미지" : `본문 이미지 ${image.sequence}`}" />
      <span>${image.role === "title" ? "title" : `IMAGE ${image.sequence}`}</span>
      <code class="image-path">${escapeHtml(image.path)}</code>
      <div class="thumb-actions">
        <button type="button" data-action="open">열기</button>
        <button type="button" data-action="show">위치</button>
      </div>
    `;
    card.querySelector("[data-action='open']").addEventListener("click", () => window.blogAuto.openFile(image.path));
    card.querySelector("[data-action='show']").addEventListener("click", () => window.blogAuto.showFileInFolder(image.path));
    grid.appendChild(card);
  }
}

function renderImageNotes(imageNotes) {
  const notes = $("#imageNotes");
  notes.innerHTML = "";
  const usefulNotes = (imageNotes || []).filter(Boolean);
  for (const note of usefulNotes) {
    const item = document.createElement("div");
    item.className = note.includes("이미지") ? "note warn" : "note";
    item.textContent = note;
    notes.appendChild(item);
  }
}

function setImagePreviewCollapsed(collapsed) {
  const isCollapsed = Boolean(collapsed);
  const content = $("#imagePreviewContent");
  const button = $("#toggleImagePreviewButton");
  if (content) content.hidden = isCollapsed;
  if (button) {
    button.textContent = isCollapsed ? "펼치기" : "접기";
    button.title = isCollapsed ? "이미지 미리보기 펼치기" : "이미지 미리보기 접기";
    button.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  }
  try {
    window.localStorage.setItem("blogauto.imagePreviewCollapsed", isCollapsed ? "true" : "false");
  } catch {
    // Preference persistence is optional; the toggle still works in restricted contexts.
  }
}

function restoreImagePreviewState() {
  let collapsed = false;
  try {
    collapsed = window.localStorage.getItem("blogauto.imagePreviewCollapsed") === "true";
  } catch {
    collapsed = false;
  }
  setImagePreviewCollapsed(collapsed);
}

async function reloadHistoryWithFeedback(button, scope = "목록") {
  if (button) {
    button.disabled = true;
    button.dataset.previousLabel = button.textContent;
    button.textContent = "새로고침 중...";
  }
  const status = $(scope === "팝업" ? "#historyModalRefreshStatus" : "#historyRefreshStatus");
  if (status) status.textContent = "저장된 작업 이력을 다시 읽는 중...";
  try {
    const history = await window.blogAuto.loadHistory();
    renderHistory(history);
    const message = `작업 이력 ${history.length}건을 다시 불러왔습니다.`;
    if (status) status.textContent = `${message} (${new Date().toLocaleTimeString()})`;
    addLog({ level: "info", message: `${scope} 새로고침 완료: ${message}`, at: new Date().toISOString() });
    return history;
  } catch (error) {
    if (status) status.textContent = `새로고침 실패: ${error.message}`;
    addLog({ level: "error", message: `${scope} 새로고침 실패: ${error.message}`, at: new Date().toISOString() });
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.previousLabel || "새로고침";
      delete button.dataset.previousLabel;
    }
  }
}

function sourceTypeLabel(document) {
  const type = String(document?.file_type || "").toUpperCase();
  const details = [];
  if (document?.metadata?.pageCount) details.push(`${document.metadata.pageCount}페이지`);
  if (document?.metadata?.sheetCount) details.push(`${document.metadata.sheetCount}시트`);
  if (document?.metadata?.slideCount) details.push(`${document.metadata.slideCount}슬라이드`);
  if (Array.isArray(document?.tables) && document.tables.length) details.push(`표 ${document.tables.length}개`);
  return [type, ...details].filter(Boolean).join(" · ");
}

function renderSourceFiles() {
  const list = $("#sourceFileList");
  const status = $("#sourceFileStatus");
  if (!list || !status) return;
  list.innerHTML = "";
  const appendRemoveButton = (item, index, { error = false } = {}) => {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost source-file-remove";
    removeButton.textContent = "삭제";
    removeButton.title = error ? "읽기 실패한 파일을 목록에서 제거" : "이 파일을 업로드 목록에서 제거";
    removeButton.addEventListener("click", () => removeSourceFile(index, { error }));
    item.appendChild(removeButton);
  };
  state.sourceDocuments.forEach((sourceDocument, index) => {
    const item = document.createElement("div");
    item.className = "source-file-card";
    const details = document.createElement("div");
    details.className = "source-file-card-details";
    const title = document.createElement("strong");
    title.textContent = sourceDocument.filename;
    const meta = document.createElement("span");
    meta.textContent = `${sourceTypeLabel(sourceDocument)} · ${sourceDocument.title || "제목 없음"}`;
    details.append(title, meta);
    item.appendChild(details);
    appendRemoveButton(item, index);
    list.appendChild(item);
  });
  state.sourceErrors.forEach((sourceError, index) => {
    const item = document.createElement("div");
    item.className = "source-file-card source-file-card-error";
    const details = document.createElement("div");
    details.className = "source-file-card-details";
    const title = document.createElement("strong");
    title.textContent = `${sourceError.filename || "파일"} (읽기 실패)`;
    const meta = document.createElement("span");
    meta.textContent = sourceError.message || "파일을 읽지 못했습니다.";
    details.append(title, meta);
    item.appendChild(details);
    appendRemoveButton(item, index, { error: true });
    list.appendChild(item);
  });
  const errors = state.sourceErrors.map((item) => `${item.filename}: ${item.message}`);
  const conflictText = state.sourceConflicts.length ? ` 충돌 ${state.sourceConflicts.length}건은 미리보기에서 확인하세요.` : "";
  const hasDocuments = state.sourceDocuments.length > 0;
  status.classList.toggle("source-status-error", Boolean(errors.length) || (!hasDocuments && state.sourceMode === "file_upload"));
  status.classList.toggle("source-status-ready", hasDocuments && !errors.length);
  status.setAttribute("aria-live", "polite");
  if (hasDocuments) {
    status.textContent = `${state.sourceDocuments.length}개 원본을 읽었습니다.${conflictText}${errors.length ? ` 일부 파일 오류: ${errors.join(" / ")}` : " 작업 시작 가능"}`;
  } else if (errors.length) {
    status.textContent = `파일 분석 실패: ${errors.join(" / ")} 파일을 다시 선택하세요.`;
  } else {
    status.textContent = state.sourceMode === "file_upload"
      ? "파일 업로드 방식이 선택되었습니다. 먼저 읽을 수 있는 원본 파일을 선택하세요."
      : "업로드된 원본 없음";
  }
}

function removePathFromSourceSelection(sourcePath, filename = "") {
  const resolvedPath = String(sourcePath || "").trim();
  if (resolvedPath) {
    const normalized = resolvedPath.toLowerCase();
    state.sourceFilePaths = state.sourceFilePaths.filter((filePath) => String(filePath || "").toLowerCase() !== normalized);
    return;
  }
  const targetName = String(filename || "").trim().toLowerCase();
  let removed = false;
  state.sourceFilePaths = state.sourceFilePaths.filter((filePath) => {
    const currentName = String(filePath || "").split(/[\\/]/).pop().toLowerCase();
    if (!removed && targetName && currentName === targetName) {
      removed = true;
      return false;
    }
    return true;
  });
}

async function removeSourceFile(index, { error = false } = {}) {
  const collection = error ? state.sourceErrors : state.sourceDocuments;
  const item = collection[index];
  if (!item) return;
  const filename = String(item.filename || "파일");
  if (!window.confirm(`'${filename}'을(를) 업로드 목록에서 삭제하시겠습니까?\n원본 파일 자체는 삭제되지 않습니다.`)) return;
  removePathFromSourceSelection(error ? item.filePath : item.sourcePath, filename);
  collection.splice(index, 1);
  if (!error) {
    state.sourceConflicts = state.sourceConflicts.filter((conflict) => (
      !Array.isArray(conflict?.values)
      || !conflict.values.some((entry) => Array.isArray(entry?.files) && entry.files.includes(filename))
    ));
  }
  renderSourceFiles();
  renderPreviewSource({
    sourceMode: state.sourceMode,
    sourceFiles: state.sourceDocuments.map((sourceDocument) => sourceDocument.filename),
    sourceConflicts: state.sourceConflicts,
    tags: []
  });
  await persistSourceSelection();
  addLog({ level: "info", message: `업로드 목록에서 '${filename}'을(를) 제거했습니다. 원본 파일은 삭제하지 않았습니다.`, at: new Date().toISOString() });
}

async function clearSourceFiles() {
  if (!state.sourceFilePaths.length && !state.sourceDocuments.length && !state.sourceErrors.length) return;
  if (!window.confirm("선택된 원본 파일을 업로드 목록에서 모두 삭제하시겠습니까?\n원본 파일 자체는 삭제되지 않습니다.")) return;
  const count = Math.max(state.sourceFilePaths.length, state.sourceDocuments.length + state.sourceErrors.length);
  state.sourceFilePaths = [];
  state.sourceDocuments = [];
  state.sourceConflicts = [];
  state.sourceErrors = [];
  if ($("#sourceFileInput")) $("#sourceFileInput").value = "";
  renderSourceFiles();
  renderPreviewSource({ sourceMode: state.sourceMode, sourceFiles: [], sourceConflicts: [], tags: [] });
  await persistSourceSelection();
  addLog({ level: "info", message: `업로드 목록의 원본 ${count}개를 모두 제거했습니다. 원본 파일은 삭제하지 않았습니다.`, at: new Date().toISOString() });
}

async function persistSourceSelection() {
  try {
    await window.blogAuto.saveSettings({
      sourceMode: state.sourceMode,
      sourceFilePaths: state.sourceMode === "file_upload" ? [...state.sourceFilePaths] : []
    });
  } catch (error) {
    addLog({ level: "warn", message: `파일 선택 상태 저장 실패: ${error.message}`, at: new Date().toISOString() });
  }
}

async function parseSourceFilePaths(filePaths, { persist = true } = {}) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter(Boolean);
  if (!paths.length) return;
  state.sourceMode = "file_upload";
  state.sourceFilePaths = [...new Set(paths)];
  const result = await window.blogAuto.parseSourceFiles(paths);
  state.sourceFilePaths = Array.isArray(result.filePaths) ? result.filePaths : state.sourceFilePaths;
  state.sourceDocuments = Array.isArray(result.documents) ? result.documents : [];
  state.sourceConflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  state.sourceErrors = Array.isArray(result.errors) ? result.errors : [];
  renderSourceFiles();
  if (state.sourceDocuments[0]?.title && !$("#topic").value.trim()) $("#topic").value = state.sourceDocuments[0].title;
  if (persist) await persistSourceSelection();
}

async function restoreSourceFiles(filePaths) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter(Boolean);
  if (!paths.length) return;
  state.sourceMode = "file_upload";
  state.sourceFilePaths = [...new Set(paths)];
  $("#contentSourceMode").value = "file_upload";
  updateModeControls();
  $("#sourceFileStatus").textContent = `저장된 ${paths.length}개 파일을 다시 읽는 중...`;
  try {
    await parseSourceFilePaths(paths, { persist: false });
    addLog({ level: "info", message: `이전에 선택한 원본 ${state.sourceDocuments.length}개를 자동으로 복원했습니다.`, at: new Date().toISOString() });
  } catch (error) {
    state.sourceDocuments = [];
    state.sourceConflicts = [];
    state.sourceErrors = [{ filename: paths.join(", "), message: error.message }];
    renderSourceFiles();
    addLog({ level: "warn", message: `저장된 원본 파일을 다시 읽지 못했습니다: ${error.message}`, at: new Date().toISOString() });
  }
}

function resumeStageLabel(stage) {
  const labels = {
    research: "Research/Title 검색·제목 단계",
    writer: "Writer 본문 작성 단계",
    main_review: "Main Agent 최종 검수 단계",
    image: "Image Worker 이미지 단계"
  };
  return labels[String(stage || "").toLowerCase()] || "저장된 작업 단계";
}

function hideResumePanel() {
  state.resumeJobId = "";
  state.resumeStage = "";
  state.resumeReason = "";
  const panel = $("#resumePanel");
  if (panel) panel.hidden = true;
  const prompt = $("#resumePromptInput");
  if (prompt) prompt.value = "";
  const stateLabel = $("#resumeState");
  if (stateLabel) stateLabel.textContent = "";
  const button = $("#resumeJobButton");
  if (button) button.disabled = true;
}

function updateResumeButtonState() {
  const button = $("#resumeJobButton");
  if (!button) return;
  button.disabled = !state.resumeJobId || state.running || state.autoRunning;
  button.title = button.disabled && (state.running || state.autoRunning)
    ? "현재 실행 중인 작업이 끝난 뒤 재개할 수 있습니다."
    : "입력한 오류 해결 프롬프트를 적용해 저장된 중단 지점부터 재개합니다.";
}

function showResumePanel(payload = {}) {
  const canResume = payload.resumeAvailable === true && String(payload.jobId || "").trim();
  if (!canResume) {
    hideResumePanel();
    return;
  }
  state.resumeJobId = String(payload.jobId).trim();
  state.resumeStage = String(payload.resumeStage || "").trim().toLowerCase();
  state.resumeReason = String(payload.resumeReason || "").trim();
  const panel = $("#resumePanel");
  if (panel) panel.hidden = false;
  const summary = $("#resumeSummary");
  if (summary) {
    summary.textContent = `${resumeStageLabel(payload.resumeStage)}에서 멈췄습니다. 저장된 본문·검색·검수 결과를 재사용하고 이 단계부터 이어갈 수 있습니다.`;
  }
  const stateLabel = $("#resumeState");
  if (stateLabel) stateLabel.textContent = payload.resumeReason ? `마지막 오류: ${payload.resumeReason}` : "재개 가능";
  updateResumeButtonState();
}

function recoveryAppliedTime(value) {
  if (!value) return "기본 적용";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("ko-KR", { hour12: false });
}

function recoveryErrorLabel(value) {
  const labels = {
    "image:image-worker": "Image Worker",
    "research:no-search-candidates": "검색 후보 없음",
    "research:freshness": "최신성·공식 근거",
    "review:title-body-mismatch": "제목·본문 불일치",
    "publish:category": "발행 카테고리",
    "publish:tag-input": "태그 입력칸",
    "publish:final-submit": "최종 발행",
    "publish:browser-session": "브라우저·로그인 세션"
  };
  return labels[String(value || "")] || String(value || "복구 시도");
}

async function renderRecoveryGuide() {
  const body = $("#recoveryGuideTableBody");
  if (!body || !window.blogAuto.getRecoveryOverview) return;
  try {
    const overview = await window.blogAuto.getRecoveryOverview();
    const attempts = Array.isArray(overview?.attempts) ? overview.attempts.slice().sort((a, b) => String(a.appliedAt || "").localeCompare(String(b.appliedAt || ""))) : [];
    body.querySelectorAll("tr[data-recovery-attempt='true']").forEach((row) => row.remove());
    const rows = [...body.querySelectorAll("tr")];
    rows.forEach((row, index) => {
      if (row.dataset.recoveryDecorated === "true") return;
      const cells = [...row.children];
      const no = document.createElement("td");
      no.textContent = String(index + 1);
      row.prepend(no);
      const applied = document.createElement("td");
      applied.textContent = "기본 적용";
      row.append(applied);
      row.dataset.recoveryDecorated = "true";
      if (cells[0]) cells[0].scope = "row";
    });
    attempts.forEach((attempt) => {
      const row = document.createElement("tr");
      const number = body.querySelectorAll("tr").length + 1;
      [
        String(number),
        recoveryErrorLabel(attempt.errorType),
        attempt.errorReason || "오류 원인이 기록되지 않았습니다.",
        attempt.repairPrompt || "입력된 오류 해결 프롬프트가 없습니다.",
        recoveryAppliedTime(attempt.appliedAt)
      ].forEach((value, index) => {
        const cell = document.createElement(index === 1 ? "th" : "td");
        cell.textContent = value;
        if (index === 1) cell.scope = "row";
        row.append(cell);
      });
      row.dataset.recoveryAttempt = "true";
      body.append(row);
    });
  } catch (error) {
    addLog({ level: "warn", message: `오류 해결 방향을 불러오지 못했습니다: ${error.message}`, at: new Date().toISOString() });
  }
}

function renderPreviewSource(payload = {}) {
  const files = Array.isArray(payload.sourceFiles) ? payload.sourceFiles : [];
  const conflicts = Array.isArray(payload.sourceConflicts) ? payload.sourceConflicts : [];
  const status = $("#previewStatus");
  const sourceFiles = $("#previewSourceFiles");
  const tags = $("#previewTags");
  const conflictBox = $("#previewConflicts");
  if (status) status.textContent = payload.status || (payload.sourceMode === "file_upload" ? "PREVIEW_READY" : "DRY_RUN");
  if (sourceFiles) sourceFiles.textContent = files.length ? files.join(", ") : "없음";
  if (tags) tags.textContent = Array.isArray(payload.tags) && payload.tags.length ? payload.tags.join(", ") : "없음";
  if (conflictBox) {
    conflictBox.hidden = conflicts.length === 0;
    conflictBox.textContent = conflicts.length
      ? `원본 충돌 확인 필요: ${conflicts.map((item) => item.message || item.field || "값 충돌").join(" / ")}`
      : "";
  }
}

function localFileUrl(filePath) {
  const value = String(filePath || "").trim();
  if (!value) return "";
  if (/^file:\/\//i.test(value)) return value;
  const normalized = value.replace(/\\/g, "/");
  return `file:///${encodeURI(normalized.replace(/^\/+/, ""))}`;
}

function showDailyDraft(item) {
  const articlePreview = $("#articlePreview");
  if (articlePreview) articlePreview.value = item.draftBody || "";
  const displayStatus = item.status === "대기" && item.draftReady ? "초안 생성 완료" : (item.status || "대기");
  renderPreviewSource({
    status: displayStatus,
    sourceMode: "file_upload",
    sourceFiles: [item.memberBoardTitle || item.postTitle || "회원마당 원문"],
    tags: Array.isArray(item.draftTags) ? item.draftTags : [],
    sourceConflicts: []
  });
  const images = [];
  if (item.draftTitleImagePath) {
    images.push({ role: "title", sequence: "title", path: item.draftTitleImagePath, url: localFileUrl(item.draftTitleImagePath) });
  }
  for (const image of Array.isArray(item.draftBodyImages) ? item.draftBodyImages : []) {
    if (!image?.path) continue;
    images.push({ role: "body", sequence: image.sequence, path: image.path, url: localFileUrl(image.path) });
  }
  renderImages(images);
  renderImageNotes([]);
  $("#articlePreview")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showLoadedDraft(payload = {}) {
  const articlePreview = $("#articlePreview");
  if (articlePreview) articlePreview.value = payload.article || "";
  if (payload.title) {
    $("#articleMeta").textContent = payload.title;
    $("#selectedTitle").textContent = payload.title;
  }
  renderPreviewSource({
    status: "이력 초안 불러옴",
    sourceMode: payload.sourceMode,
    sourceFiles: payload.sourceFiles || [],
    tags: payload.tags || [],
    sourceConflicts: []
  });
  renderImages(payload.images || []);
  renderImageNotes(payload.imageNotes || []);
  articlePreview?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAccounts() {
  const list = $("#accountList");
  const manager = $("#accountManager");
  const toggle = $("#toggleAccountManagerButton");
  ensureSelectedAccount();
  if (manager && toggle) {
    manager.classList.toggle("collapsed", !state.accountManagerOpen);
    toggle.textContent = state.accountManagerOpen ? "접기" : "펼치기";
  }
  list.innerHTML = "";
  if (!state.accountStore.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 계정이 없습니다.";
    list.appendChild(empty);
    renderCategories();
    updateSessionNotice();
    return;
  }

  for (const account of state.accountStore.accounts) {
    const row = document.createElement("div");
    row.className = `account-row${account.id === state.accountStore.selectedAccountId ? " selected" : ""}`;
    row.dataset.accountId = account.id;
    row.innerHTML = `
      <button type="button" class="drag-handle account-drag-handle" draggable="true" aria-label="계정 순서 드래그" title="드래그해서 계정 순서 변경">⇅</button>
      <input class="list-check" type="checkbox" ${account.checked !== false ? "checked" : ""} aria-label="자동 발행 계정 선택" />
      <div class="account-main">
        <strong title="${escapeHtml(accountDisplayName(account))}">${escapeHtml(accountDisplayName(account))}</strong>
        <span>로그인 정보 직접 입력</span>
        <small>블로그 ${escapeHtml(account.blogId || account.naverId || "-")}</small>
        <small>카테고리 ${(account.categories || []).length}개</small>
      </div>
      <div class="account-actions">
        ${sessionBadge(account)}
        <button type="button" class="ghost small" data-action="session">세션확인</button>
        <button type="button" class="select-button small" data-action="select">${account.id === state.accountStore.selectedAccountId ? "선택됨" : "선택"}</button>
        <button type="button" class="ghost small danger-button" data-action="delete">삭제</button>
      </div>
    `;
    const dragHandle = row.querySelector(".account-drag-handle");
    dragHandle.addEventListener("click", (event) => event.stopPropagation());
    dragHandle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      state.draggingAccountId = account.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", account.id);
    });
    dragHandle.addEventListener("dragend", (event) => {
      event.stopPropagation();
      state.draggingAccountId = "";
      row.classList.remove("dragging");
      list.querySelectorAll(".account-row.drag-over").forEach((item) => item.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", (event) => {
      if (!state.draggingAccountId || state.draggingAccountId === account.id) return;
      event.preventDefault();
      row.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove("drag-over");
      const draggedId = state.draggingAccountId || event.dataTransfer.getData("text/plain");
      state.draggingAccountId = "";
      if (moveAccountBefore(draggedId, account.id)) {
        await persistAccountOrder();
      }
    });
    row.addEventListener("click", () => selectAccount(account.id));
    row.querySelector("input").addEventListener("click", (event) => {
      event.stopPropagation();
      account.checked = event.target.checked;
      saveAccountStoreNow();
    });
    row.querySelector("[data-action='select']").addEventListener("click", (event) => {
      event.stopPropagation();
      selectAccount(account.id);
    });
    row.querySelector("[data-action='session']").addEventListener("click", (event) => {
      event.stopPropagation();
      checkAccountSession(account);
    });
    row.querySelector("[data-action='delete']").addEventListener("click", async (event) => {
      event.stopPropagation();
      const label = accountDisplayName(account);
      if (!window.confirm(`${label} 계정을 삭제할까요? 이 계정에 등록된 카테고리도 함께 삭제됩니다.`)) {
        return;
      }
      state.accountStore.accounts = state.accountStore.accounts.filter((item) => item.id !== account.id);
      const nextAccount = ensureSelectedAccount();
      if (nextAccount) {
        fillAccountForm(nextAccount);
        clearCategoryForm();
        state.categoryManagerOpen = true;
      } else {
        clearAccountForm();
        clearCategoryForm();
      }
      await saveAccountStoreNow();
      addLog({
        agent: "main",
        level: "warn",
        message: `${label} 계정과 종속 카테고리를 삭제했습니다.`,
        at: new Date().toISOString()
      });
    });
    list.appendChild(row);
  }
  renderCategories();
  updateSessionNotice();
}

function renderCategories() {
  const account = selectedAccount();
  const list = $("#categoryList");
  const manager = $("#categoryManager");
  manager.classList.toggle("collapsed", !state.categoryManagerOpen);
  list.innerHTML = "";
  if (!account) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "카테고리를 등록할 계정을 먼저 선택하세요.";
    list.appendChild(empty);
    return;
  }
  if (!account.categories || !account.categories.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 카테고리가 없습니다.";
    list.appendChild(empty);
    return;
  }

  for (const [index, category] of account.categories.entries()) {
    const searchProviders = categorySearchProviders(category);
    const optionSummary = [
      category.excludedTopics ? `제외: ${category.excludedTopics}` : "",
      category.preferredTone ? `톤: ${category.preferredTone}` : "",
      category.freshnessLevel && category.freshnessLevel !== "auto" ? `최신성: ${category.freshnessLevel}` : "",
      searchChannelLabel(category.searchChannel),
      `Provider: ${searchProviders.primarySearchProvider} → ${searchProviders.fallbackSearchProvider}`,
      category.trustBlogAsSource ? "블로그 신뢰" : ""
    ].filter(Boolean).join(" · ");
    const row = document.createElement("div");
    row.className = `category-row${state.editingCategoryId === category.id ? " selected" : ""}`;
    row.dataset.categoryId = category.id;
    row.innerHTML = `
      <button type="button" class="drag-handle" draggable="true" aria-label="카테고리 순서 드래그" title="드래그해서 순서 변경">⇅</button>
      <input class="list-check" type="checkbox" ${category.checked !== false ? "checked" : ""} aria-label="자동 발행 카테고리 선택" />
      <div class="category-main">
        <strong>${escapeHtml(category.name)}</strong>
        <span>${escapeHtml(category.keyword || "검색 키워드 없음")}</span>
        ${optionSummary ? `<small>${escapeHtml(optionSummary)}</small>` : ""}
      </div>
      <div class="category-actions">
        <button type="button" class="ghost small" data-action="move-up" ${index === 0 ? "disabled" : ""}>위</button>
        <button type="button" class="ghost small" data-action="move-down" ${index === account.categories.length - 1 ? "disabled" : ""}>아래</button>
        <button type="button" class="ghost small" data-action="edit">수정</button>
        <button type="button" class="ghost small" data-action="delete">삭제</button>
      </div>
    `;
    const dragHandle = row.querySelector(".drag-handle");
    dragHandle.addEventListener("dragstart", (event) => {
      state.draggingCategoryId = category.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", category.id);
    });
    dragHandle.addEventListener("dragend", () => {
      state.draggingCategoryId = "";
      row.classList.remove("dragging");
      list.querySelectorAll(".category-row.drag-over").forEach((item) => item.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", (event) => {
      if (!state.draggingCategoryId || state.draggingCategoryId === category.id) return;
      event.preventDefault();
      row.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      row.classList.remove("drag-over");
      const draggedId = state.draggingCategoryId || event.dataTransfer.getData("text/plain");
      state.draggingCategoryId = "";
      if (moveCategoryBefore(account, draggedId, category.id)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("input").addEventListener("change", (event) => {
      category.checked = event.target.checked;
      saveAccountStoreNow();
    });
    row.querySelector("[data-action='move-up']").addEventListener("click", async () => {
      if (moveCategoryToIndex(account, category.id, index - 1)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("[data-action='move-down']").addEventListener("click", async () => {
      if (moveCategoryToIndex(account, category.id, index + 1)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("[data-action='edit']").addEventListener("click", () => {
      editCategory(category);
    });
    row.querySelector("[data-action='delete']").addEventListener("click", () => {
      account.categories = account.categories.filter((item) => item.id !== category.id);
      if (state.editingCategoryId === category.id) {
        clearCategoryForm();
      }
      saveAccountStoreNow();
      renderCategories();
    });
    list.appendChild(row);
  }
}

function selectAccount(accountId) {
  const account = state.accountStore.accounts.find((item) => item.id === accountId);
  if (!account) return;
  state.accountStore.selectedAccountId = account.id;
  fillAccountForm(account);
  clearCategoryForm();
  renderAccounts();
  saveAccountStoreNow();
}

function fillAccountForm(account) {
  $("#accountLabel").value = account?.label || "";
  $("#blogId").value = account?.blogId || account?.naverId || "";
  renderAccountSampleImage(account);
}

function accountImageStatusLabel(account) {
  if (!account?.sampleImagePath) return "Default image style";
  const status = account.imageStylePromptStatus || (account.imageStylePrompt ? "ready" : "missing");
  if (status === "ready") return "Custom style prompt ready";
  if (status === "stale") return "Image changed - prompt will regenerate";
  if (status === "failed") return `Prompt generation failed${account.imageStylePromptError ? `: ${account.imageStylePromptError}` : ""}`;
  return "Prompt will be generated on next run";
}

function renderAccountSampleImage(account = selectedAccount()) {
  const preview = $("#accountSampleImagePreview");
  const status = $("#accountImagePromptStatus");
  const chooseButton = $("#chooseAccountSampleImageButton");
  const deleteButton = $("#deleteAccountSampleImageButton");
  if (!preview || !status) return;
  preview.innerHTML = "";
  if (account?.sampleImageUrl) {
    const image = document.createElement("img");
    image.src = account.sampleImageUrl;
    image.alt = "Account sample image";
    preview.appendChild(image);
  } else {
    const empty = document.createElement("span");
    empty.textContent = "No sample image";
    preview.appendChild(empty);
  }
  status.textContent = accountImageStatusLabel(account);
  if (chooseButton) chooseButton.disabled = !account;
  if (deleteButton) deleteButton.disabled = !account || !account.sampleImagePath;
}

function clearAccountForm() {
  fillAccountForm(null);
}

function setCategoryButtonLabel() {
  const button = $("#addCategoryButton");
  if (button) {
    button.textContent = state.editingCategoryId ? "카테고리 수정" : "카테고리 등록";
  }
}

function fillCategoryForm(category = null) {
  $("#categoryName").value = category?.name || "";
  $("#categoryKeyword").value = category?.keyword || "";
  $("#categoryExcludedTopics").value = category?.excludedTopics || "";
  $("#categoryPublishPurpose").value = category?.publishPurpose || "";
  $("#categoryPreferredTone").value = category?.preferredTone || "";
  $("#categoryFreshnessLevel").value = category?.freshnessLevel || "auto";
  $("#categorySearchChannel").value = normalizeSearchChannel(category?.searchChannel);
  const searchProviders = categorySearchProviders(category);
  $("#categoryPrimarySearchProvider").value = searchProviders.primarySearchProvider;
  $("#categoryFallbackSearchProvider").value = searchProviders.fallbackSearchProvider;
  $("#categoryTrustBlogAsSource").checked = category?.trustBlogAsSource === true;
}

function findCategoryById(account, categoryId) {
  const id = String(categoryId || "");
  if (!id || !Array.isArray(account?.categories)) return null;
  return account.categories.find((category) => String(category.id || "") === id) || null;
}

function clearCategoryForm() {
  state.editingCategoryId = "";
  fillCategoryForm(null);
  setCategoryButtonLabel();
}

function readCategoryFormValues() {
  const primarySearchProvider = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
  let fallbackSearchProvider = normalizeSearchProvider(
    $("#categoryFallbackSearchProvider").value,
    fallbackSearchProviderFor(primarySearchProvider)
  );
  if (fallbackSearchProvider === primarySearchProvider) {
    fallbackSearchProvider = fallbackSearchProviderFor(primarySearchProvider);
  }
  return {
    name: $("#categoryName").value.trim(),
    keyword: $("#categoryKeyword").value.trim(),
    excludedTopics: $("#categoryExcludedTopics").value.trim(),
    publishPurpose: $("#categoryPublishPurpose").value.trim(),
    preferredTone: $("#categoryPreferredTone").value.trim(),
    freshnessLevel: $("#categoryFreshnessLevel").value || "auto",
    searchChannel: normalizeSearchChannel($("#categorySearchChannel").value),
    primarySearchProvider,
    fallbackSearchProvider,
    trustBlogAsSource: $("#categoryTrustBlogAsSource").checked === true
  };
}

function applyCategoryFormValues(category, values) {
  Object.assign(category, values, { checked: true });
}

async function persistPendingCategoryForStart() {
  const account = selectedAccount();
  if (!account) return false;

  const values = readCategoryFormValues();
  const hasPendingInput = Boolean(
    values.name
    || values.keyword
    || values.excludedTopics
    || values.publishPurpose
    || values.preferredTone
    || values.trustBlogAsSource
    || values.freshnessLevel !== "auto"
    || values.searchChannel !== "blog"
    || values.primarySearchProvider !== "naver"
    || values.fallbackSearchProvider !== "google"
  );
  if (!hasPendingInput) return false;
  if (!values.name || !values.keyword) {
    throw new Error("작업을 시작하려면 입력 중인 카테고리의 카테고리명과 검색 키워드를 모두 입력하세요.");
  }

  account.categories = Array.isArray(account.categories) ? account.categories : [];
  const editingCategory = findCategoryById(account, state.editingCategoryId);
  const existingCategory = editingCategory || account.categories.find((category) => category.name === values.name);
  if (existingCategory) {
    applyCategoryFormValues(existingCategory, values);
  } else {
    account.categories.push({ id: makeId("cat"), ...values, checked: true });
  }

  await saveAccountStoreNow();
  clearCategoryForm();
  renderCategories();
  addLog({
    level: "info",
    message: `입력 중인 카테고리 '${values.name}'를 자동 등록하고 작업을 시작합니다.`,
    at: new Date().toISOString()
  });
  return true;
}

function editCategory(category) {
  if (!category) return;
  state.editingCategoryId = category.id || "";
  state.categoryManagerOpen = true;
  const currentCategory = findCategoryById(selectedAccount(), state.editingCategoryId) || category;
  renderCategories();
  fillCategoryForm(currentCategory);
  setCategoryButtonLabel();
  $("#categoryName")?.focus();
}

function hasCategoryName(category) {
  return Boolean(String(category?.name || "").trim());
}

function hasCategoryKeyword(category) {
  return Boolean(String(category?.keyword || "").trim());
}

function autoTargetKey(target) {
  const accountId = String(target?.account?.id || "");
  const categoryId = String(target?.category?.id || target?.category?.name || "");
  return `${accountId}::${categoryId}`;
}

function setPendingAutoTarget(target) {
  state.autoPendingSessionTarget = {
    key: autoTargetKey(target),
    accountId: String(target?.account?.id || ""),
    categoryId: String(target?.category?.id || target?.category?.name || ""),
    accountLabel: accountDisplayName(target?.account),
    categoryName: String(target?.category?.name || "")
  };
}

function clearPendingAutoTarget(key = "") {
  if (!key || state.autoPendingSessionTarget?.key === key) {
    state.autoPendingSessionTarget = null;
  }
}

function findAutoTargetIndex(targets, key) {
  const index = targets.findIndex((target) => autoTargetKey(target) === key);
  return index >= 0 ? index : 0;
}

function firstAutoTargetForAccount(accountId) {
  const id = String(accountId || "");
  return getAutoTargets().find((target) => String(target?.account?.id || "") === id) || null;
}

async function saveAccountStoreNow() {
  state.accountStore = await window.blogAuto.saveAccountStore(state.accountStore);
  renderAccounts();
}

async function persistCategoryFormForSettings() {
  const account = selectedAccount();
  const values = readCategoryFormValues();
  if (!account) return false;
  const hasPendingInput = Boolean(
    values.name
    || values.keyword
    || values.excludedTopics
    || values.publishPurpose
    || values.preferredTone
    || values.trustBlogAsSource
    || values.freshnessLevel !== "auto"
    || values.searchChannel !== "blog"
    || values.primarySearchProvider !== "naver"
    || values.fallbackSearchProvider !== "google"
  );
  if (!hasPendingInput) return false;
  if (!values.name || !values.keyword) {
    throw new Error("카테고리명과 검색 키워드를 입력한 뒤 설정을 저장하세요.");
  }

  account.categories = Array.isArray(account.categories) ? account.categories : [];
  const editingCategory = findCategoryById(account, state.editingCategoryId);
  const category = editingCategory || account.categories.find((item) => item.name === values.name);
  if (category) {
    applyCategoryFormValues(category, values);
  } else {
    account.categories.push({ id: makeId("cat"), ...values, checked: true });
  }
  const savedCategory = category || account.categories[account.categories.length - 1];
  state.editingCategoryId = savedCategory.id;
  await saveAccountStoreNow();
  renderCategories();
  fillCategoryForm(savedCategory);
  setCategoryButtonLabel();
  return true;
}

function moveAccountToIndex(accountId, targetIndex) {
  const accounts = state.accountStore.accounts || [];
  const fromIndex = accounts.findIndex((account) => account.id === accountId);
  if (fromIndex < 0) return false;
  const boundedTarget = Math.max(0, Math.min(targetIndex, accounts.length - 1));
  if (fromIndex === boundedTarget) return false;
  const [account] = accounts.splice(fromIndex, 1);
  accounts.splice(boundedTarget, 0, account);
  return true;
}

function moveAccountBefore(accountId, beforeAccountId) {
  const accounts = state.accountStore.accounts || [];
  if (accountId === beforeAccountId) return false;
  const fromIndex = accounts.findIndex((account) => account.id === accountId);
  const targetIndex = accounts.findIndex((account) => account.id === beforeAccountId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return moveAccountToIndex(accountId, adjustedTarget);
}

async function persistAccountOrder() {
  await saveAccountStoreNow();
}

function moveCategoryToIndex(account, categoryId, targetIndex) {
  if (!account || !Array.isArray(account.categories)) return false;
  const fromIndex = account.categories.findIndex((category) => category.id === categoryId);
  if (fromIndex < 0) return false;
  const boundedTarget = Math.max(0, Math.min(targetIndex, account.categories.length - 1));
  if (fromIndex === boundedTarget) return false;
  const [category] = account.categories.splice(fromIndex, 1);
  account.categories.splice(boundedTarget, 0, category);
  return true;
}

function moveCategoryBefore(account, categoryId, beforeCategoryId) {
  if (!account || categoryId === beforeCategoryId || !Array.isArray(account.categories)) return false;
  const fromIndex = account.categories.findIndex((category) => category.id === categoryId);
  const targetIndex = account.categories.findIndex((category) => category.id === beforeCategoryId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return moveCategoryToIndex(account, categoryId, adjustedTarget);
}

async function persistCategoryOrder(account) {
  await saveAccountStoreNow();
  renderCategories();
}

function normalizeAgentModels(models = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_MODELS).map(([agent, fallback]) => {
    const value = String(models?.[agent] || fallback);
    return [agent, VALID_AGENT_MODEL_VALUES.has(value) ? value : fallback];
  }));
}

function currentAgentModels() {
  return normalizeAgentModels(Object.fromEntries(Object.entries(AGENT_MODEL_SELECTORS).map(([agent, selector]) => (
    [agent, $(selector)?.value || DEFAULT_AGENT_MODELS[agent]]
  ))));
}

function applyAgentModels(models = {}) {
  const normalized = normalizeAgentModels(models);
  for (const [agent, selector] of Object.entries(AGENT_MODEL_SELECTORS)) {
    const control = $(selector);
    if (control) control.value = normalized[agent];
  }
}

function collectForm(target = {}) {
  const account = target.account || selectedAccount();
  const category = target.category
    || (account?.categories || []).find((item) => item.checked !== false && hasCategoryName(item) && hasCategoryKeyword(item))
    || (account?.categories || []).find((item) => item.checked !== false);
  const useSelectedAccount = Boolean(target.account || account);
  const searchProviders = categorySearchProviders(category);
  const sourceMode = $("#contentSourceMode")?.value === "file_upload" ? "file_upload" : "research";
  return {
    accountId: account?.id || "",
    blogId: useSelectedAccount ? (account?.blogId || account?.naverId || "") : $("#blogId").value.trim(),
    topicMode: $("#topicMode").value,
    sourceMode,
    sourceFilePaths: sourceMode === "file_upload" ? [...state.sourceFilePaths] : [],
    sourceDocuments: sourceMode === "file_upload" ? state.sourceDocuments : [],
    sourceConflicts: sourceMode === "file_upload" ? state.sourceConflicts : [],
    repeatTermMinutes: Number($("#repeatTermMinutes").value || 60),
    topic: $("#topic").value.trim(),
    category: category?.name || "",
    keyword: category?.keyword || "",
    excludedTopics: category?.excludedTopics || "",
    publishPurpose: category?.publishPurpose || "",
    preferredTone: category?.preferredTone || "",
    freshnessLevel: category?.freshnessLevel || "auto",
    searchChannel: normalizeSearchChannel(category?.searchChannel),
    trustBlogAsSource: category?.trustBlogAsSource === true,
    codexCmdPath: "codex.cmd",
    codexModel: normalizeCodexModel($("#codexModel")?.value),
    primarySearchProvider: searchProviders.primarySearchProvider,
    fallbackSearchProvider: searchProviders.fallbackSearchProvider,
    naverSearchUrl: DEFAULT_NAVER_SEARCH_URL,
    googleSearchUrl: DEFAULT_GOOGLE_SEARCH_URL,
    naverEditorDomNotes: "",
    publishAfterGenerate: $("#publishAfterGenerate").checked,
    publishToTistoryAfterNaver: $("#publishToTistoryAfterNaver")?.checked === true,
    tistoryBlogId: $("#tistoryBlogId")?.value.trim() || "",
    publishVisibility: $("#publishVisibility").value,
    publishPrivate: $("#publishVisibility").value !== "public",
    publishScheduleMode: $("#publishScheduleMode").value,
    reserveAfterHours: Number($("#reserveAfterHours").value || 0),
    includeTitleImage: $("#includeTitleImage").checked,
    titleImageAspectRatio: normalizeImageAspectRatio($("#titleImageAspectRatio").value),
    bodyImageAspectRatio: normalizeImageAspectRatio($("#bodyImageAspectRatio").value),
    maxBodyImages: Number($("#maxBodyImages").value),
    breakSentencesInBody: $("#breakSentencesInBody").checked,
    agentModels: currentAgentModels(),
    excludedKeywordLanes: Array.isArray(target.excludedKeywordLanes) ? target.excludedKeywordLanes : [],
    failOnLoginRequired: target.failOnLoginRequired === true
  };
}

function applySettings(settings) {
  const map = {
    topic: "#topic",
    topicMode: "#topicMode",
    repeatTermMinutes: "#repeatTermMinutes",
    tistoryBlogId: "#tistoryBlogId",
    publishVisibility: "#publishVisibility",
    publishScheduleMode: "#publishScheduleMode",
    reserveAfterHours: "#reserveAfterHours",
    maxBodyImages: "#maxBodyImages"
  };
  for (const [key, selector] of Object.entries(map)) {
    if (settings[key] !== undefined && $(selector)) {
      $(selector).value = settings[key];
    }
  }
  $("#publishAfterGenerate").checked = settings.publishAfterGenerate === true;
  state.sourceMode = settings.sourceMode === "file_upload" ? "file_upload" : "research";
  state.sourceFilePaths = Array.isArray(settings.sourceFilePaths) ? settings.sourceFilePaths.filter(Boolean) : [];
  if ($("#contentSourceMode")) $("#contentSourceMode").value = state.sourceMode;
  if ($("#publishToTistoryAfterNaver")) $("#publishToTistoryAfterNaver").checked = settings.publishToTistoryAfterNaver === true;
  state.tistorySessionStatus = settings.tistorySessionStatus || "unknown";
  $("#includeTitleImage").checked = settings.includeTitleImage !== false;
  $("#titleImageAspectRatio").value = normalizeImageAspectRatio(settings.titleImageAspectRatio || settings.imageAspectRatio);
  $("#bodyImageAspectRatio").value = normalizeImageAspectRatio(settings.bodyImageAspectRatio || settings.imageAspectRatio);
  $("#breakSentencesInBody").checked = settings.breakSentencesInBody !== false;
  if ($("#codexModel")) $("#codexModel").value = normalizeCodexModel(settings.codexModel);
  applyAgentModels(settings.agentModels);
  if (settings.publishPrivate === false) $("#publishVisibility").value = "public";
  updateModeControls();
}

async function saveSettingsNow() {
  $("#settingsState").textContent = "설정 저장 중";
  await persistCategoryFormForSettings();
  const form = collectForm();
  await window.blogAuto.saveSettings({
    blogId: form.blogId,
    topic: form.topic,
    keyword: form.keyword,
    category: form.category,
    primarySearchProvider: form.primarySearchProvider,
    fallbackSearchProvider: form.fallbackSearchProvider,
    naverSearchUrl: form.naverSearchUrl,
    googleSearchUrl: form.googleSearchUrl,
    naverEditorDomNotes: form.naverEditorDomNotes,
    publishAfterGenerate: form.publishAfterGenerate,
    publishToTistoryAfterNaver: form.publishToTistoryAfterNaver,
    tistoryBlogId: form.tistoryBlogId,
    publishPrivate: form.publishPrivate,
    topicMode: form.topicMode,
    sourceMode: form.sourceMode,
    sourceFilePaths: form.sourceFilePaths,
    repeatTermMinutes: form.repeatTermMinutes,
    publishVisibility: form.publishVisibility,
    publishScheduleMode: form.publishScheduleMode,
    reserveAfterHours: form.reserveAfterHours,
    includeTitleImage: form.includeTitleImage,
    titleImageAspectRatio: form.titleImageAspectRatio,
    bodyImageAspectRatio: form.bodyImageAspectRatio,
    maxBodyImages: form.maxBodyImages,
    breakSentencesInBody: form.breakSentencesInBody,
    codexModel: form.codexModel,
    agentModels: form.agentModels
  });
  await saveAccountStoreNow();
  $("#settingsState").textContent = "설정 저장됨";
}

function scheduleSettingsSave() {
  window.clearTimeout(state.saveTimer);
  $("#settingsState").textContent = "변경 감지";
  state.saveTimer = window.setTimeout(() => {
    saveSettingsNow().catch((error) => {
      $("#settingsState").textContent = "설정 저장 실패";
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    });
  }, 450);
}

function updateModeControls() {
  const isFile = $("#contentSourceMode")?.value === "file_upload";
  if (isFile && $("#topicMode").value === "auto") $("#topicMode").value = "manual";
  const isAuto = !isFile && $("#topicMode").value === "auto";
  const isPrivatePublish = $("#publishVisibility").value !== "public";
  $("#repeatTermLabel").style.display = isAuto ? "grid" : "none";
  $("#manualTopicLabel").style.display = isAuto ? "none" : "grid";
  $("#fileUploadPanel").hidden = !isFile;
  $("#topicMode").disabled = isFile;
  $("#publishAfterGenerate").checked = isAuto ? true : $("#publishAfterGenerate").checked;
  $("#publishAfterGenerate").disabled = isAuto;
  if (isPrivatePublish && $("#publishScheduleMode").value === "reserve") {
    $("#publishScheduleMode").value = "now";
  }
  $("#publishScheduleMode").disabled = isPrivatePublish;
  const reserveEnabled = !isPrivatePublish && $("#publishScheduleMode").value === "reserve";
  $("#reserveAfterLabel").style.display = reserveEnabled ? "grid" : "none";
  // Hidden reservation input may contain the legacy default 0 while its HTML min is 1.
  // Disable it when reservation is not active so native form validation cannot block Start.
  $("#reserveAfterHours").disabled = !reserveEnabled;
  if (reserveEnabled && Number($("#reserveAfterHours").value || 0) < 1) {
    $("#reserveAfterHours").value = "1";
  }
}

function getAutoTargets() {
  const targets = [];
  for (const account of state.accountStore.accounts.filter((item) => item.checked !== false)) {
    for (const category of (account.categories || []).filter((item) => item.checked !== false && hasCategoryName(item) && hasCategoryKeyword(item))) {
      targets.push({ account, category });
    }
  }
  return targets;
}

function allNaverSessionsExpired(targets) {
  return Boolean(targets.length) && targets.every((target) => target.account?.sessionStatus === "expired");
}

function nextDifferentAccountIndex(targets, index) {
  if (!targets.length) return 0;
  const currentAccountId = targets[index % targets.length]?.account?.id || "";
  for (let offset = 1; offset <= targets.length; offset += 1) {
    const nextIndex = (index + offset) % targets.length;
    if ((targets[nextIndex]?.account?.id || "") !== currentAccountId) {
      return nextIndex;
    }
  }
  return index;
}

function delayAuto(minutes) {
  const ms = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (state.autoDelayWake === finish) state.autoDelayWake = null;
      resolve();
    };
    const started = Date.now();
    state.autoDelayWake = finish;
    const tick = () => {
      if (!state.autoRunning) {
        finish();
        return;
      }
      const remaining = Math.max(0, ms - (Date.now() - started));
      setRunState("generated", `다음 발행까지 ${Math.ceil(remaining / 1000)}초`);
      if (remaining <= 0) finish();
      else window.setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
  });
}

function waitForAccountSessionOrTerm(accountId, minutes) {
  const waitingAccountId = String(accountId || "");
  const ms = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Promise((resolve) => {
    if (state.autoResumeAccountId === waitingAccountId) {
      state.autoResumeAccountId = "";
      resolve("session");
      return;
    }
    let settled = false;
    const started = Date.now();
    const wake = () => {
      if (state.autoResumeAccountId === waitingAccountId) {
        finish("session");
      }
    };
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (state.autoDelayWake === wake) state.autoDelayWake = null;
      if (reason === "session") state.autoResumeAccountId = "";
      resolve(reason);
    };
    state.autoDelayWake = wake;
    const tick = () => {
      if (!state.autoRunning) {
        finish("stopped");
        return;
      }
      if (state.autoResumeAccountId === waitingAccountId) {
        finish("session");
        return;
      }
      const remaining = Math.max(0, ms - (Date.now() - started));
      setRunState("session_expired", `세션 확인 대기 중 ${Math.ceil(remaining / 1000)}초`);
      if (remaining <= 0) {
        finish("term");
        return;
      }
      window.setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
  });
}

async function startAutoPublishing(startTargetKey = "") {
  const checkedTargets = state.accountStore.accounts
    .filter((account) => account.checked !== false)
    .flatMap((account) => (account.categories || [])
      .filter((category) => category.checked !== false)
      .map((category) => ({ account, category })));
  if (!checkedTargets.length) {
    throw new Error("자동 발행할 체크된 계정/카테고리 조합이 없습니다.");
  }
  const checkedTargetsWithKeyword = checkedTargets.filter((target) => (
    hasCategoryName(target.category) && hasCategoryKeyword(target.category)
  ));
  if (!checkedTargetsWithKeyword.length) {
    throw new Error("자동 발행하려면 체크된 카테고리의 카테고리명과 키워드를 먼저 등록하세요.");
  }
  if (allNaverSessionsExpired(checkedTargetsWithKeyword)) {
    throw new Error("All selected Naver sessions are expired. Check at least one Naver session before starting auto publishing.");
  }
  const startupForm = collectForm();
  if (startupForm.publishToTistoryAfterNaver && !startupForm.tistoryBlogId) throw new Error("티스토리 블로그 ID가 필요합니다.");
  state.running = true;
  state.autoRunning = true;
  state.autoPausedForSession = false;
  $("#startButton").disabled = true;
  setTistoryTestButtonDisabled(true);
  $("#stopAutoButton").disabled = false;
  await saveSettingsNow();
  setTokenTotal(0);

  let index = startTargetKey ? findAutoTargetIndex(getAutoTargets(), startTargetKey) : 0;
  autoLoop:
  while (state.autoRunning) {
    const targets = getAutoTargets();
    if (!targets.length) {
      addLog({
        level: "warn",
        message: "체크된 계정 중 자동 발행 가능한 대상이 없습니다.",
        at: new Date().toISOString()
      });
      await delayAuto(Number($("#repeatTermMinutes").value || 60));
      continue;
    }
    if (allNaverSessionsExpired(targets)) {
      addLog({
        level: "warn",
        message: "All selected Naver sessions are expired. Auto publishing stopped.",
        at: new Date().toISOString()
      });
      state.autoRunning = false;
      break;
    }
    index %= targets.length;
    const target = targets[index];
    if (target.account.sessionStatus === "expired") {
      setPendingAutoTarget(target);
      addLog({
        level: "warn",
        message: `${accountDisplayName(target.account)} 계정은 세션만료 상태입니다. ${target.category.name} 작업은 세션확인 또는 반복주기까지 대기합니다.`,
        at: new Date().toISOString()
      });
      state.autoPausedForSession = true;
      state.autoWaitingSessionAccountId = target.account.id || "";
      const waitResult = await waitForAccountSessionOrTerm(target.account.id, Number($("#repeatTermMinutes").value || 60));
      state.autoPausedForSession = false;
      state.autoWaitingSessionAccountId = "";
      if (waitResult === "session") {
        clearPendingAutoTarget(autoTargetKey(target));
        addLog({
          level: "info",
          message: `${accountDisplayName(target.account)} 계정 세션확인이 완료되어 ${target.category.name} 작업을 즉시 재시도합니다.`,
          at: new Date().toISOString()
        });
        continue;
      }
      if (waitResult === "term") {
        clearPendingAutoTarget(autoTargetKey(target));
        index = nextDifferentAccountIndex(targets, index);
        continue;
      }
      break;
    }
    clearPendingAutoTarget(autoTargetKey(target));
    let autoAttemptLimit = AUTO_TARGET_MAX_ATTEMPTS;
    let skipDelayBeforeNextTarget = false;
    const excludedKeywordLanes = new Set();
    for (let attempt = 1; attempt <= autoAttemptLimit && state.autoRunning; attempt += 1) {
      addLog({
        level: "info",
        message: `자동 Cycle 시작 (${attempt}/${autoAttemptLimit}): ${accountDisplayName(target.account)} / ${target.category.name}`,
        at: new Date().toISOString()
      });
      $("#selectedTitle").textContent = "아직 선정 전";
      $("#articlePreview").value = "";
      renderImages([]);
      renderImageNotes([]);
      const result = await runAutoStartJob(collectForm({
        account: target.account,
        category: target.category,
        excludedKeywordLanes: [...excludedKeywordLanes],
        failOnLoginRequired: true
      }));
      if (result?.status === "codex_usage_limit") {
        addLog({
          level: "error",
          message: "Codex 사용량 한도 초과로 자동 작업을 중지합니다.",
          at: new Date().toISOString()
        });
        state.autoRunning = false;
        break autoLoop;
      }
      if (result?.status === "codex_exec_failed") {
        addLog({
          level: "error",
          message: `Codex 실행 실패로 자동 작업을 중지합니다: ${autoResultReason(result)}`,
          at: new Date().toISOString()
        });
        state.autoRunning = false;
        break autoLoop;
      }
      if (result?.status === "session_expired") {
        target.account.sessionStatus = "expired";
        if (allNaverSessionsExpired(getAutoTargets())) {
          renderAccounts();
          addLog({
            level: "warn",
            message: "All selected Naver sessions are expired. Auto publishing stopped.",
            at: new Date().toISOString()
          });
          state.autoRunning = false;
          break autoLoop;
        }
        setPendingAutoTarget(target);
        renderAccounts();
        addLog({
          level: "warn",
          message: `${accountDisplayName(target.account)} 계정은 세션만료 상태입니다. ${target.category.name} 작업은 세션확인 또는 반복주기까지 대기합니다.`,
          at: new Date().toISOString()
        });
        state.autoPausedForSession = true;
        state.autoWaitingSessionAccountId = target.account.id || "";
        const waitResult = await waitForAccountSessionOrTerm(target.account.id, Number($("#repeatTermMinutes").value || 60));
        state.autoPausedForSession = false;
        state.autoWaitingSessionAccountId = "";
        if (waitResult === "session") {
          clearPendingAutoTarget(autoTargetKey(target));
          addLog({
            level: "info",
            message: `${accountDisplayName(target.account)} 계정 세션확인이 완료되어 ${target.category.name} 작업을 즉시 재시도합니다.`,
            at: new Date().toISOString()
          });
          continue autoLoop;
        }
        if (waitResult === "term") {
          clearPendingAutoTarget(autoTargetKey(target));
          index = nextDifferentAccountIndex(targets, index);
          continue autoLoop;
        }
        break autoLoop;
      }
      if (!shouldRetryAutoResult(result)) {
        break;
      }
      const failedLanes = keywordLanePhrasesFromResult(result);
      for (const lane of failedLanes) excludedKeywordLanes.add(lane);
      autoAttemptLimit = Math.min(autoAttemptLimit, autoAttemptLimitForResult(result));
      if (attempt < autoAttemptLimit) {
        addLog({
          level: "warn",
          message: `자동 Cycle 실패, 같은 대상으로 재시도합니다 (${attempt + 1}/${autoAttemptLimit}): ${autoResultReason(result)}${failedLanes.length ? ` / 제외 lane: ${failedLanes.join(", ")}` : ""}`,
          at: new Date().toISOString()
        });
        continue;
      }
      addLog({
        level: "warn",
        message: `자동 Cycle ${autoAttemptLimit}회 실패로 다음 대상으로 이동합니다: ${autoResultReason(result)}`,
        at: new Date().toISOString()
      });
      skipDelayBeforeNextTarget = true;
    }
    index += 1;
    if (state.autoRunning && !skipDelayBeforeNextTarget) {
      await delayAuto(Number($("#repeatTermMinutes").value || 60));
    }
  }

  state.autoRunning = false;
  state.autoPausedForSession = false;
  state.autoWaitingSessionAccountId = "";
  state.autoResumeAccountId = "";
  state.autoPendingSessionTarget = null;
  state.running = false;
  $("#startButton").disabled = false;
  setTistoryTestButtonDisabled(false);
  $("#stopAutoButton").disabled = true;
  setRunState("generated", "자동 중지");
}

async function startManualJob() {
  const form = collectForm();
  hideResumePanel();
  state.sourceMode = form.sourceMode;
  if (form.sourceMode === "file_upload") renderSourceFiles();
  if (form.publishAfterGenerate && form.publishToTistoryAfterNaver && !form.tistoryBlogId) throw new Error("티스토리 블로그 ID가 필요합니다.");
  if (form.sourceMode === "file_upload" && !form.sourceDocuments.length) {
    const sourceError = state.sourceErrors.map((item) => `${item.filename}: ${item.message}`).join(" / ");
    throw new Error(sourceError
      ? `파일을 읽지 못했습니다. ${sourceError}`
      : "파일 업로드 방식에서는 먼저 읽을 수 있는 원본 파일을 하나 이상 선택하세요.");
  }
  if (!form.topic && form.sourceMode !== "file_upload") throw new Error("수동 방식에서는 주제가 필요합니다.");
  if (!form.category) throw new Error("선택 계정에서 카테고리를 체크하세요.");
  if (!form.keyword && form.sourceMode !== "file_upload") throw new Error("선택한 카테고리에 검색 키워드를 등록하세요.");
  if (form.publishAfterGenerate && !form.blogId) throw new Error("발행까지 진행하려면 Blog ID가 등록된 계정을 선택하세요.");
  state.running = true;
  $("#startButton").disabled = true;
  setTistoryTestButtonDisabled(true);
  await saveSettingsNow();
  setTokenTotal(0);
  $("#articlePreview").value = "";
  renderPreviewSource({ status: form.sourceMode === "file_upload" ? "PREVIEW_READY" : "DRY_RUN", sourceMode: form.sourceMode, sourceFiles: form.sourceDocuments.map((item) => item.filename), sourceConflicts: form.sourceConflicts, tags: [] });
  $("#selectedTitle").textContent = "아직 선정 전";
  renderImages([]);
  renderImageNotes([]);
  setRunState("generating", "생성 준비");
  try {
    await window.blogAuto.startJob(form);
  } finally {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
    }
  }
}

async function startTistoryTestPublish() {
  const form = collectForm();
  if (!form.tistoryBlogId) throw new Error("티스토리 블로그 ID가 필요합니다.");
  state.running = true;
  $("#startButton").disabled = true;
  setTistoryTestButtonDisabled(true);
  await saveSettingsNow();
  setTokenTotal(0);
  $("#articlePreview").value = "";
  $("#selectedTitle").textContent = "티스토리 테스트";
  renderImages([]);
  renderImageNotes([]);
  setRunState("publishing", "티스토리 테스트");
  try {
    const result = await window.blogAuto.testTistoryPublish({
      ...form,
      failOnLoginRequired: false
    });
    $("#articlePreview").value = result.article || $("#articlePreview").value;
    $("#articleMeta").textContent = result.title || "티스토리 테스트 완료";
    if (result.title) $("#selectedTitle").textContent = result.title;
    renderImages(result.images || []);
    renderImageNotes(result.imageNotes || []);
  } finally {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
    }
  }
}

function dailyDateKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderSchedulerStatus(snapshot = {}) {
  state.scheduler = snapshot || { registered: false, tasks: [], lastRuns: {} };
  const status = $("#schedulerStatus");
  if (!status) return;
  if (!state.scheduler.registered) {
    status.textContent = "미등록 · 버튼을 눌러 자동 실행을 등록하세요.";
    return;
  }
  const tasks = Array.isArray(state.scheduler.tasks) ? state.scheduler.tasks : [];
  const lastRuns = state.scheduler.lastRuns && typeof state.scheduler.lastRuns === "object"
    ? Object.values(state.scheduler.lastRuns)
    : [];
  const latest = lastRuns.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
  status.textContent = `등록됨 · ${tasks.length || 3}개 작업${latest ? ` · 최근 ${latest.status || "실행"}` : ""}`;
}

function renderDailyWorkflow(snapshot = {}) {
  const date = state.dailyDate || dailyDateKey();
  const plan = snapshot.plan || null;
  const source = snapshot.memberSource || {};
  state.dailyPlan = plan;
  const dateLabel = $("#dailyWorkflowDate");
  if (dateLabel) dateLabel.textContent = date;
  const status = $("#dailyWorkflowStatus");
  const list = $("#dailyPlanList");
  if (!status || !list) return;
  list.replaceChildren();
  const posts = Array.isArray(source.posts) ? source.posts.length : 0;
  if (!plan) {
    status.classList.remove("needs-review");
    status.textContent = plan?.workflowMode === "random-slot-web-research"
      ? "오늘 랜덤 주제 계획이 아직 없습니다."
      : posts ? `회원마당 원본 ${posts}건이 있습니다. 9개 슬롯 준비를 눌러 계획을 만드세요.` : "예약 실행은 카테고리 설정을 사용해 웹 검색으로 주제를 만듭니다.";
    return;
  }
  const items = Array.isArray(plan.items) ? plan.items : [];
  const waiting = items.filter((item) => item.status === "대기").length;
  const approved = items.filter((item) => item.status === "승인됨").length;
  const published = items.filter((item) => item.status === "발행완료").length;
  const needsReview = items.filter((item) => item.status === "확인 필요").length;
  const empty = items.filter((item) => item.status === "소재없음").length;
  const draftReady = items.filter((item) => item.draftReady === true).length;
  const savedAt = plan.updatedAt || plan.createdAt || "";
  const savedLabel = savedAt ? ` · 마지막 저장 ${new Date(savedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : "";
  status.textContent = plan.workflowMode === "random-slot-web-research"
    ? `${needsReview ? `⚠ 확인 필요 ${needsReview}건 · ` : ""}오늘 선택 슬롯 ${plan.selectedSlot || "-"}/9 (${plan.selectedSlotCategory || "-"}) · 초안 ${draftReady}건 · 온새카 상태 ${items.find((item) => item.eligibleForRun)?.memberBoardStatus || "대기"} · ${plan.status || ""}${savedLabel}`
    : `${needsReview ? `⚠ 확인 필요 ${needsReview}건 · ` : ""}원본 ${posts}건 · 대기 ${waiting}건 · 초안완료 ${draftReady}건 · 승인 ${approved}건 · 발행완료 ${published}건 · 소재없음 ${empty}건 · ${plan.status || ""}${savedLabel}`;
  status.classList.toggle("needs-review", needsReview > 0);
  for (const item of items) {
    const displayStatus = item.status === "대기" && item.draftReady ? "초안 생성 완료" : (item.status || "대기");
    const row = document.createElement("div");
    row.className = "daily-plan-item";
    const head = document.createElement("div");
    head.className = "daily-plan-item-head";
    const title = document.createElement("div");
    title.className = "daily-plan-item-title";
    title.textContent = `${item.slot}. ${item.postTitle || item.topic || (item.selectionState === "not_selected" ? "오늘 선택 제외" : "소재 없음")}`;
    const badge = document.createElement("span");
    badge.className = "badge " + (["실패", "확인 필요"].includes(displayStatus) ? "danger" : displayStatus === "승인됨" ? "success" : "info");
    badge.textContent = displayStatus;
    head.append(title, badge);
    const meta = document.createElement("div");
    meta.className = "daily-plan-item-meta";
    const memberBoardMessage = item.memberBoardStatus && item.memberBoardStatus !== "미대상"
      ? ` · ${plan.workflowMode === "random-slot-web-research" ? "온새카" : "회원마당"} ${item.memberBoardStatus}${item.memberBoardFailureReason ? `: ${item.memberBoardFailureReason}` : ""}`
      : "";
    meta.textContent = `${item.sourceCategory} → ${item.blogCategory || item.blogDisplayCategory || "-"} · 예약 기준 ${item.scheduledAt || "-"}${item.failureReason ? ` · ${item.failureReason}` : ""}${memberBoardMessage}`;
    row.append(head, meta);
    const categoryEditor = document.createElement("label");
    categoryEditor.className = "daily-plan-category-editor";
    const categoryLabel = document.createElement("span");
    categoryLabel.textContent = "블로그 발행 카테고리 (고정)";
    const categoryInput = document.createElement("input");
    categoryInput.type = "text";
    categoryInput.value = plan.categoryName || item.blogCategory || item.blogDisplayCategory || "알아두면 좋은 지식";
    categoryInput.readOnly = true;
    categoryInput.title = "일일 회원마당 수집·랜덤 온새카 작업은 알아두면 좋은 지식으로 고정됩니다.";
    categoryEditor.append(categoryLabel, categoryInput);
    row.appendChild(categoryEditor);
    if (item.draftReady) {
      const draftMeta = document.createElement("div");
      draftMeta.className = "daily-plan-item-meta";
      draftMeta.textContent = `초안: ${item.draftTitle || item.postTitle} · 태그 ${Array.isArray(item.draftTags) ? item.draftTags.join(", ") : "없음"}`;
      row.appendChild(draftMeta);
    }
    const actions = document.createElement("div");
    actions.className = "daily-plan-item-actions";
    if (item.draftReady) {
      const preview = document.createElement("button");
      preview.className = "ghost small";
      preview.type = "button";
      preview.textContent = "초안 보기";
      preview.addEventListener("click", () => showDailyDraft(item));
      actions.appendChild(preview);
    }
    if (item.draftReady && displayStatus !== "발행완료") {
      const approve = document.createElement("button");
      approve.className = displayStatus === "승인됨" ? "ghost small" : "primary small";
      approve.type = "button";
      approve.textContent = displayStatus === "승인됨" ? "승인 취소" : "승인";
      approve.addEventListener("click", async () => {
        try {
          await window.blogAuto.approveDailyItem({ date, itemId: item.id, approved: displayStatus !== "승인됨" });
          await refreshDailyWorkflow();
        } catch (error) {
          addLog({ level: "error", message: error.message, at: new Date().toISOString() });
        }
      });
      actions.appendChild(approve);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function refreshDailyWorkflow() {
  const snapshot = await window.blogAuto.loadDailyWorkflow(state.dailyDate);
  renderDailyWorkflow(snapshot);
  return snapshot;
}

async function runDailyWorkflowAction(label, action) {
  const status = $("#dailyWorkflowStatus");
  if (status) status.textContent = `${label} 진행 중... 열린 Chrome에서 필요한 로그인/보안확인을 완료하세요.`;
  for (const button of document.querySelectorAll("#dailyWorkflowPanel button")) button.disabled = true;
  try {
    await action();
    await refreshDailyWorkflow();
  } catch (error) {
    if (status) status.textContent = `${label} 실패: ${error.message}`;
    addLog({ level: "error", message: error.message, at: new Date().toISOString() });
  } finally {
    for (const button of document.querySelectorAll("#dailyWorkflowPanel button")) button.disabled = false;
  }
}

async function boot() {
  const initial = await window.blogAuto.getInitialData();
  $("#runtimePath").textContent = initial.runtimeRoot;
  state.chrome = initial.chrome || state.chrome;
  state.accountStore = initial.accountStore || state.accountStore;
  state.dailyDate = dailyDateKey();
  applySettings(initial.settings || {});
  setCodexRateLimits(initial.settings?.codexRateLimits || null);
  refreshCodexUsageOnStartup();
  showStartupNoticeIfNeeded();
  renderAccounts();
  const account = selectedAccount();
  if (account) selectAccount(account.id);
  renderHistory(initial.history || []);
  renderDailyWorkflow(initial.dailyWorkflow || {});
  renderSchedulerStatus(initial.scheduler || {});
  restoreImagePreviewState();
  if (initial.resumeCandidate?.resumeAvailable) {
    showResumePanel(initial.resumeCandidate);
    addLog({
      level: "warn",
      message: `이전 실행이 ${resumeStageLabel(initial.resumeCandidate.resumeStage)}에서 중단되어 재개 대기 중입니다.`,
      at: new Date().toISOString()
    });
  }

  window.blogAuto.onAccountsUpdate((store) => {
    state.accountStore = store;
    refreshCategoryDatalists();
    renderAccounts();
    fillAccountForm(selectedAccount());
    const editingCategory = findCategoryById(selectedAccount(), state.editingCategoryId);
    if (editingCategory) {
      fillCategoryForm(editingCategory);
      setCategoryButtonLabel();
    }
  });
  window.blogAuto.onLog(addLog);
  window.blogAuto.onStatus((payload) => {
    state.currentJobId = payload.jobId;
    setRunState(payload.status, payload.detail || payload.status);
  });
  window.blogAuto.onTokens((payload) => {
    setTokenTotal(payload.total || 0);
    if (payload.rateLimits) setCodexRateLimits(payload.rateLimits);
  });
  window.blogAuto.onPreview((payload) => {
    $("#articlePreview").value = payload.article || "";
    $("#articleMeta").textContent = payload.title || "본문 생성 완료";
    if (payload.title) $("#selectedTitle").textContent = payload.title;
    if (payload.tokenUsage) setTokenTotal(payload.tokenUsage.total || 0);
    if (payload.tokenUsage?.rateLimits) setCodexRateLimits(payload.tokenUsage.rateLimits);
    renderImages(payload.images || []);
    renderImageNotes(payload.imageNotes || []);
    renderPreviewSource(payload);
  });
  window.blogAuto.onSelectedTitle((payload) => {
    $("#selectedTitle").textContent = payload.title || "제목 선정 보류";
    $("#articleMeta").textContent = payload.verdict || payload.status || "제목 선정 완료";
  });
  window.blogAuto.onComplete((payload) => {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
    }
    setRunState(payload.status, payload.status);
    $("#articlePreview").value = payload.article || $("#articlePreview").value;
    $("#articleMeta").textContent = payload.title || payload.status || "완료";
    if (payload.title) $("#selectedTitle").textContent = payload.title;
    if (payload.tokenUsage) setTokenTotal(payload.tokenUsage.total || 0);
    if (payload.tokenUsage?.rateLimits) setCodexRateLimits(payload.tokenUsage.rateLimits);
    renderImages(payload.images || []);
    renderImageNotes(payload.imageNotes || []);
    renderPreviewSource(payload);
    renderHistory(payload.history || []);
    if (["failed", "codex_exec_failed", "codex_usage_limit", "session_expired"].includes(String(payload.status || "").toLowerCase())) {
      showResumePanel(payload);
    } else {
      hideResumePanel();
    }
    updateResumeButtonState();
  });

  $("#resumeJobButton")?.addEventListener("click", async (event) => {
    const jobId = state.resumeJobId;
    const stateLabel = $("#resumeState");
    if (!jobId) {
      if (stateLabel) stateLabel.textContent = "재개할 저장 작업을 찾지 못했습니다. 오늘 작업을 다시 불러오세요.";
      addLog({ level: "error", message: "중단 지점부터 재개할 작업 ID가 없습니다. 저장된 복구 후보를 다시 확인하세요.", at: new Date().toISOString() });
      return;
    }
    if (state.running || state.autoRunning) {
      if (stateLabel) stateLabel.textContent = "현재 다른 작업이 실행 중입니다. 작업이 끝난 뒤 다시 시도하세요.";
      addLog({ level: "warn", message: "중단 지점부터 재개를 보류했습니다. 현재 다른 작업이 실행 중입니다.", at: new Date().toISOString() });
      return;
    }
    const button = event.currentTarget;
    const repairPrompt = String($("#resumePromptInput")?.value || "").trim();
    try {
      await window.blogAuto.recordRecoveryAttempt({
        failurePhase: state.resumeStage,
        failureReason: state.resumeReason,
        repairPrompt
      });
    } catch {
      // Recording the guide is helpful but must never prevent a safe resume.
    }
    button.disabled = true;
    state.running = true;
    setRunState("generating", "중단 지점부터 재개");
    if (stateLabel) stateLabel.textContent = "오류 해결 프롬프트(선택) 값을 입력하여 재개 중.....";
    try {
      await window.blogAuto.resumeJob({ jobId, repairPrompt });
    } catch (error) {
      state.running = false;
      button.disabled = false;
      if (stateLabel) stateLabel.textContent = `재개 실패: ${error.message}`;
      addLog({ level: "error", message: `중단 지점부터 재개 실패: ${error.message}`, at: new Date().toISOString() });
    } finally {
      updateResumeButtonState();
    }
  });

  $("#jobForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.running) return;
    try {
      if ($("#topicMode").value === "auto") {
        await persistPendingCategoryForStart();
        await startAutoPublishing();
      } else {
        await startManualJob();
      }
    } catch (error) {
      state.running = false;
      state.autoRunning = false;
      state.autoPausedForSession = false;
      state.autoWaitingSessionAccountId = "";
      state.autoResumeAccountId = "";
      state.autoPendingSessionTarget = null;
      $("#startButton").disabled = false;
      $("#stopAutoButton").disabled = true;
      const message = String(error?.message || error || "알 수 없는 오류");
      setRunState("failed", "작업 시작 실패");
      $("#articleMeta").textContent = message;
      if ($("#contentSourceMode")?.value === "file_upload") {
        renderSourceFiles();
        $("#sourceFileStatus")?.scrollIntoView({ block: "nearest" });
      }
      addLog({ level: "error", message: `작업 시작 실패: ${message}`, at: new Date().toISOString() });
    }
  });

  $("#tistoryTestButton")?.addEventListener("click", async () => {
    if (state.running || state.autoRunning) return;
    try {
      await startTistoryTestPublish();
    } catch (error) {
      state.running = false;
      state.autoRunning = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
      $("#stopAutoButton").disabled = true;
      setRunState("failed", "티스토리 테스트 실패");
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    }
  });

  $("#addAccountButton").addEventListener("click", async () => {
    const blogId = $("#blogId").value.trim();
    if (!blogId) {
      addLog({ level: "error", message: "Blog ID를 입력하세요.", at: new Date().toISOString() });
      return;
    }
    const duplicate = state.accountStore.accounts.find((account) => String(account.blogId || account.naverId || "").trim() === blogId);
    if (duplicate) {
      addLog({ level: "error", message: "이미 등록된 Blog ID입니다. 기존 계정을 선택한 뒤 수정하세요.", at: new Date().toISOString() });
      return;
    }
    const account = {
      id: makeId("acct"),
      label: $("#accountLabel").value.trim() || blogId,
      blogId,
      sampleImagePath: "",
      sampleImageHash: "",
      sampleImageUpdatedAt: "",
      imageStylePrompt: "",
      imageStylePromptUpdatedAt: "",
      imageStylePromptStatus: "missing",
      imageStylePromptSourceImageHash: "",
      imageStylePromptError: "",
      checked: true,
      sessionStatus: "unknown",
      sessionCheckedAt: "",
      categories: []
    };
    state.accountStore.accounts.push(account);
    state.accountStore.selectedAccountId = account.id;
    state.categoryManagerOpen = true;
    clearCategoryForm();
    await saveAccountStoreNow();
    $("#categoryName")?.focus();
  });

  $("#updateAccountButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account) {
      addLog({ level: "error", message: "수정할 계정을 먼저 선택하세요.", at: new Date().toISOString() });
      return;
    }
    const blogId = $("#blogId").value.trim();
    if (!blogId) {
      addLog({ level: "error", message: "Blog ID를 입력하세요.", at: new Date().toISOString() });
      return;
    }
    const duplicate = state.accountStore.accounts.find((item) => item.id !== account.id && String(item.blogId || item.naverId || "").trim() === blogId);
    if (duplicate) {
      addLog({ level: "error", message: "다른 계정에 이미 등록된 Blog ID입니다.", at: new Date().toISOString() });
      return;
    }
    account.label = $("#accountLabel").value.trim() || blogId;
    account.blogId = blogId;
    await saveAccountStoreNow();
  });

  $("#clearAccountFormButton").addEventListener("click", () => {
    clearAccountForm();
    addLog({ level: "info", message: "신규 계정 입력을 시작합니다.", at: new Date().toISOString() });
  });

  $("#chooseAccountSampleImageButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account) {
      addLog({ level: "error", message: "Select an account before adding a sample image.", at: new Date().toISOString() });
      return;
    }
    state.accountStore = await window.blogAuto.chooseAccountSampleImage(account.id);
    renderAccounts();
    fillAccountForm(selectedAccount());
    scheduleSettingsSave();
  });

  $("#deleteAccountSampleImageButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account || !account.sampleImagePath) return;
    if (!window.confirm("Delete the sample image and custom image prompt?")) return;
    state.accountStore = await window.blogAuto.deleteAccountSampleImage(account.id);
    renderAccounts();
    fillAccountForm(selectedAccount());
    scheduleSettingsSave();
  });

  $("#toggleAccountManagerButton").addEventListener("click", () => {
    state.accountManagerOpen = !state.accountManagerOpen;
    if (state.accountManagerOpen) {
      fillAccountForm(selectedAccount());
    }
    renderAccounts();
  });

  const legacyCheckSessionButton = $("#checkSessionButton");
  if (legacyCheckSessionButton) {
    legacyCheckSessionButton.addEventListener("click", () => checkAccountSession(selectedAccount()));
  }
  $("#bulkSessionCheckButton").addEventListener("click", checkSelectedAccountSessions);

  $("#toggleCategoryManagerButton").addEventListener("click", () => {
    clearCategoryForm();
    state.categoryManagerOpen = !state.categoryManagerOpen;
    renderCategories();
  });
  $("#categoryPrimarySearchProvider").addEventListener("change", () => {
    const primary = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    const fallback = normalizeSearchProvider($("#categoryFallbackSearchProvider").value, fallbackSearchProviderFor(primary));
    if (fallback === primary) {
      $("#categoryFallbackSearchProvider").value = fallbackSearchProviderFor(primary);
    }
  });
  $("#categoryFallbackSearchProvider").addEventListener("change", () => {
    const primary = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    const fallback = normalizeSearchProvider($("#categoryFallbackSearchProvider").value, fallbackSearchProviderFor(primary));
    if (fallback === primary) {
      $("#categoryPrimarySearchProvider").value = fallbackSearchProviderFor(fallback);
    }
  });
  $("#addCategoryButton").addEventListener("click", async () => {
    const account = selectedAccount();
    const name = $("#categoryName").value.trim();
    const keyword = $("#categoryKeyword").value.trim();
    const excludedTopics = $("#categoryExcludedTopics").value.trim();
    const publishPurpose = $("#categoryPublishPurpose").value.trim();
    const preferredTone = $("#categoryPreferredTone").value.trim();
    const freshnessLevel = $("#categoryFreshnessLevel").value || "auto";
    const searchChannel = normalizeSearchChannel($("#categorySearchChannel").value);
    const primarySearchProvider = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    let fallbackSearchProvider = normalizeSearchProvider(
      $("#categoryFallbackSearchProvider").value,
      fallbackSearchProviderFor(primarySearchProvider)
    );
    if (fallbackSearchProvider === primarySearchProvider) {
      fallbackSearchProvider = fallbackSearchProviderFor(primarySearchProvider);
      $("#categoryFallbackSearchProvider").value = fallbackSearchProvider;
    }
    const trustBlogAsSource = $("#categoryTrustBlogAsSource").checked === true;
    if (!account) return;
    if (!name || !keyword) {
      addLog({
        level: "warn",
        message: "카테고리를 등록하려면 카테고리명과 검색 키워드를 모두 입력하세요.",
        at: new Date().toISOString()
      });
      setRunState("failed", "카테고리명/키워드 필요");
      return;
    }
    account.categories = account.categories || [];
    const editingId = state.editingCategoryId;
    const existing = editingId
      ? account.categories.find((category) => category.id === editingId)
      : null;
    if (editingId && existing) {
      existing.keyword = keyword;
      existing.name = name;
      existing.excludedTopics = excludedTopics;
      existing.publishPurpose = publishPurpose;
      existing.preferredTone = preferredTone;
      existing.freshnessLevel = freshnessLevel;
      existing.searchChannel = searchChannel;
      existing.primarySearchProvider = primarySearchProvider;
      existing.fallbackSearchProvider = fallbackSearchProvider;
      existing.trustBlogAsSource = trustBlogAsSource;
      existing.checked = true;
    } else if (account.categories.some((category) => category.name === name)) {
      addLog({
        level: "warn",
        message: "같은 이름의 카테고리가 이미 있습니다. 기존 카테고리를 수정하려면 목록의 수정 버튼을 눌러 주세요.",
        at: new Date().toISOString()
      });
      setRunState("failed", "중복 카테고리명");
      return;
    } else {
      account.categories.push({
        id: makeId("cat"),
        name,
        keyword,
        excludedTopics,
        publishPurpose,
        preferredTone,
        freshnessLevel,
        searchChannel,
        primarySearchProvider,
        fallbackSearchProvider,
        trustBlogAsSource,
        checked: true
      });
    }
    clearCategoryForm();
    await saveAccountStoreNow();
  });

  $("#stopAutoButton").addEventListener("click", () => {
    state.autoRunning = false;
    state.autoPausedForSession = false;
    state.autoWaitingSessionAccountId = "";
    state.autoResumeAccountId = "";
    state.autoPendingSessionTarget = null;
    $("#stopAutoButton").disabled = true;
    setRunState("generated", "자동 중지 요청");
  });
  $("#reloadHistoryButton").addEventListener("click", async (event) => {
    await reloadHistoryWithFeedback(event.currentTarget, "요약");
  });
  $("#openHistoryModalButton").addEventListener("click", async () => {
    state.historyModalOpen = true;
    renderHistory(await window.blogAuto.loadHistory());
  });
  $("#toggleImagePreviewButton")?.addEventListener("click", () => {
    const content = $("#imagePreviewContent");
    setImagePreviewCollapsed(!content || !content.hidden ? true : false);
  });
  $("#openDailyButtonHelp")?.addEventListener("click", () => {
    $("#dailyButtonHelpModal").hidden = false;
  });
  $("#closeDailyButtonHelp")?.addEventListener("click", () => {
    $("#dailyButtonHelpModal").hidden = true;
  });
  $("#dailyButtonHelpModal")?.addEventListener("click", (event) => {
    if (event.target?.id === "dailyButtonHelpModal") $("#dailyButtonHelpModal").hidden = true;
  });
  $("#openRecoveryGuideButton")?.addEventListener("click", async () => {
    $("#recoveryGuideModal").hidden = false;
    await renderRecoveryGuide();
  });
  $("#closeRecoveryGuideButton")?.addEventListener("click", () => {
    $("#recoveryGuideModal").hidden = true;
  });
  $("#recoveryGuideModal")?.addEventListener("click", (event) => {
    if (event.target?.id === "recoveryGuideModal") $("#recoveryGuideModal").hidden = true;
  });
  $("#reloadHistoryModalButton").addEventListener("click", async (event) => {
    await reloadHistoryWithFeedback(event.currentTarget, "팝업");
  });
  $("#historySelectAll")?.addEventListener("change", (event) => {
    const visibleItems = currentHistoryVisibleItems();
    for (const item of visibleItems.filter(historyCanSelect)) {
      const jobId = String(item.id || "");
      if (event.currentTarget.checked) state.selectedHistoryJobIds.add(jobId);
      else state.selectedHistoryJobIds.delete(jobId);
    }
    renderHistory(state.historyItems);
  });
  $("#publishSelectedHistoryButton")?.addEventListener("click", async (event) => {
    const selectedItems = currentHistoryVisibleItems()
      .filter((item) => historyCanPublish(item) && state.selectedHistoryJobIds.has(String(item.id || "")));
    if (!selectedItems.length) return;
    const button = event.currentTarget;
    // Snapshot both ID and title before the first publish. Rendering history
    // after a success must not change the queue that is still being processed.
    const seenJobIds = new Set();
    const queue = selectedItems.map((item) => ({
      jobId: String(item.id || "").trim(),
      title: item.title || item.research_title || item.topic || "제목 없음"
    })).filter((item) => {
      if (!item.jobId || seenJobIds.has(item.jobId)) return false;
      seenJobIds.add(item.jobId);
      return true;
    });
    const titles = queue.map((item) => item.title);
    if (!window.confirm(`선택한 ${queue.length}건을 순서대로 네이버에 발행할까요?\n\n${titles.join("\n")}\n\n각 항목의 ID·제목을 고정해 발행합니다. 오류가 나면 해당 지점에서 일시중지하고 브라우저는 유지합니다.`)) return;
    button.disabled = true;
    try {
      const result = await window.blogAuto.publishHistoryDrafts({
        jobIds: queue.map((item) => item.jobId),
        expectedTitles: Object.fromEntries(queue.map((item) => [item.jobId, item.title])),
        publishVisibility: $("#publishVisibility")?.value || "",
        publishScheduleMode: $("#publishScheduleMode")?.value || ""
      });
      for (const [index, item] of (result.results || []).entries()) {
        addLog({
          level: item.status === "success" ? "info" : "error",
          message: item.status === "success"
            ? `[선택 큐 ${index + 1}/${queue.length}] '${item.title || queue[index]?.title || "제목 없음"}' 발행 완료`
            : `[선택 큐 ${index + 1}/${queue.length}] '${queue[index]?.title || item.jobId}' 발행 실패: ${item.reason || "원인 확인 필요"}`,
          at: new Date().toISOString()
        });
      }
      const failed = result.results?.find((item) => item.status === "failed");
      addLog({
        level: failed ? "warn" : "info",
        message: failed
          ? `이력 일괄 발행이 ${result.completed}건 완료 후 일시중지되었습니다: ${failed.reason}`
          : `이력 일괄 발행이 ${result.completed}건 모두 완료되었습니다.`,
        at: new Date().toISOString()
      });
      state.selectedHistoryJobIds.clear();
      renderHistory(result.history || await window.blogAuto.loadHistory());
    } catch (error) {
      addLog({ level: "error", message: `이력 일괄 발행 실패: ${error.message}`, at: new Date().toISOString() });
    } finally {
      button.disabled = false;
      updateHistoryBulkControls();
    }
  });
  $("#analyzeSelectedHistoryButton")?.addEventListener("click", async (event) => {
    const selectedItems = currentHistoryVisibleItems()
      .filter((item) => historyStatusFilterKey(item.status) === "failed" && state.selectedHistoryJobIds.has(String(item.id || "")));
    if (!selectedItems.length) return;
    await analyzeAndRepublishSelectedHistory(selectedItems, event.currentTarget);
  });
  $("#bulkHistoryCategorySelect")?.addEventListener("change", () => updateHistoryBulkControls());
  $("#applyHistoryCategoryButton")?.addEventListener("click", async (event) => {
    const selectedItems = currentHistoryVisibleItems()
      .filter((item) => historyHasArtifact(item) && state.selectedHistoryJobIds.has(String(item.id || "")));
    const category = String($("#bulkHistoryCategorySelect")?.value || "").trim();
    if (!selectedItems.length || !category) return;
    if (!window.confirm(`선택한 ${selectedItems.length}건의 발행 카테고리를 '${category}'로 일괄 적용할까요?`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    let updated = 0;
    let failed = 0;
    try {
      for (const item of selectedItems) {
        try {
          await window.blogAuto.updateHistoryCategory({ jobId: String(item.id || ""), category });
          updated += 1;
        } catch (error) {
          failed += 1;
          addLog({ level: "error", message: `작업 이력 '${item.title || item.research_title || item.topic || "제목 없음"}' 카테고리 저장 실패: ${error.message}`, at: new Date().toISOString() });
        }
      }
      state.selectedHistoryJobIds = new Set();
      $("#bulkHistoryCategorySelect").value = "";
      renderHistory(await window.blogAuto.loadHistory());
      addLog({ level: failed > 0 ? "warn" : "info", message: `발행 카테고리 일괄 적용 결과: 성공 ${updated}건 / 실패 ${failed}건`, at: new Date().toISOString() });
    } finally {
      button.disabled = false;
      updateHistoryBulkControls();
    }
  });
  $("#markSelectedHistorySuccessButton")?.addEventListener("click", async (event) => {
    const selectedItems = currentHistoryVisibleItems()
      .filter((item) => historyCanMarkSuccess(item) && state.selectedHistoryJobIds.has(String(item.id || "")));
    if (!selectedItems.length) return;
    await markHistoryItemsSuccess(
      selectedItems.map((item) => String(item.id || "")),
      selectedItems.map((item) => item.title || item.research_title || item.topic || "제목 없음"),
      event.currentTarget
    );
  });
  $("#deleteSelectedHistoryButton")?.addEventListener("click", async (event) => {
    const selectedItems = currentHistoryVisibleItems()
      .filter((item) => historyHasArtifact(item) && state.selectedHistoryJobIds.has(String(item.id || "")));
    if (!selectedItems.length) return;
    await deleteSelectedHistoryItems(
      selectedItems.map((item) => String(item.id || "")),
      selectedItems.map((item) => item.title || item.research_title || item.topic || "제목 없음"),
      event.currentTarget
    );
  });
  $("#closeHistoryModalButton").addEventListener("click", closeHistoryModal);
  $("#historyModal").addEventListener("click", (event) => {
    const filterButton = event.target?.closest?.("[data-history-filter]");
    if (filterButton) {
      state.historyFilter = filterButton.dataset.historyFilter || "all";
      state.selectedHistoryJobIds = new Set();
      renderHistory(state.historyItems);
      return;
    }
    if (event.target?.id === "historyModal") closeHistoryModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.historyModalOpen) closeHistoryModal();
    if (event.key === "Escape" && !$("#dailyButtonHelpModal")?.hidden) $("#dailyButtonHelpModal").hidden = true;
    if (event.key === "Escape" && !$("#recoveryGuideModal")?.hidden) $("#recoveryGuideModal").hidden = true;
  });
  $("#clearLogButton").addEventListener("click", () => {
    clearAgentLogs();
  });
  $("#openRuntimeButton").addEventListener("click", () => {
    window.blogAuto.openRuntimeFolder();
  });
  $("#dismissSessionNoticeButton").addEventListener("click", () => {
    $("#sessionNotice").hidden = true;
  });
  $("#dismissStartupNoticeButton").addEventListener("click", dismissStartupNotice);
  $("#saveSettingsButton").addEventListener("click", () => {
    saveSettingsNow().catch((error) => {
      $("#settingsState").textContent = "설정 저장 실패";
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    });
  });
  for (const selector of ["#codexModel", ...Object.values(AGENT_MODEL_SELECTORS)]) {
    const control = $(selector);
    if (!control) continue;
    control.addEventListener("change", () => {
      saveSettingsNow().catch((error) => {
        $("#settingsState").textContent = "설정 저장 실패";
        addLog({ level: "error", message: error.message, at: new Date().toISOString() });
      });
    });
  }
  for (const selector of ["#titleImageAspectRatio", "#bodyImageAspectRatio"]) {
    $(selector).addEventListener("change", () => {
      saveSettingsNow().catch((error) => {
        $("#settingsState").textContent = "설정 저장 실패";
        addLog({ level: "error", message: error.message, at: new Date().toISOString() });
      });
    });
  }
  $("#topicMode").addEventListener("change", updateModeControls);
  $("#contentSourceMode").addEventListener("change", () => {
    state.sourceMode = $("#contentSourceMode").value === "file_upload" ? "file_upload" : "research";
    if (state.sourceMode !== "file_upload") {
      state.sourceFilePaths = [];
      state.sourceDocuments = [];
      state.sourceConflicts = [];
      state.sourceErrors = [];
    }
    updateModeControls();
    renderPreviewSource({ sourceMode: state.sourceMode, sourceFiles: state.sourceDocuments.map((item) => item.filename), sourceConflicts: state.sourceConflicts, tags: [] });
    persistSourceSelection();
  });
  if (typeof window.blogAuto.onSchedulerUpdate === "function") {
    window.blogAuto.onSchedulerUpdate((snapshot) => renderSchedulerStatus(snapshot));
  }
  $("#sourceDropZone").addEventListener("click", async () => {
    try {
      const result = await window.blogAuto.chooseSourceFiles();
      if (!result?.canceled) {
        state.sourceMode = "file_upload";
        state.sourceFilePaths = Array.isArray(result.filePaths) ? result.filePaths : [];
        state.sourceDocuments = result.documents || [];
        state.sourceConflicts = result.conflicts || [];
        state.sourceErrors = result.errors || [];
        renderSourceFiles();
        if (state.sourceDocuments[0]?.title && !$("#topic").value.trim()) $("#topic").value = state.sourceDocuments[0].title;
        await persistSourceSelection();
      }
    } catch (error) {
      state.sourceDocuments = [];
      state.sourceConflicts = [];
      state.sourceErrors = [{ filename: "파일", message: error.message }];
      renderSourceFiles();
    }
  });
  $("#clearSourceFilesButton")?.addEventListener("click", () => {
    clearSourceFiles().catch((error) => addLog({ level: "error", message: `업로드 목록 전체 삭제 실패: ${error.message}`, at: new Date().toISOString() }));
  });
  $("#sourceFileInput").addEventListener("change", async (event) => {
    try {
      await parseSourceFilePaths([...event.target.files].map((file) => file.path));
    } catch (error) {
      state.sourceDocuments = [];
      state.sourceConflicts = [];
      state.sourceErrors = [{ filename: "파일", message: error.message }];
      renderSourceFiles();
    } finally {
      event.target.value = "";
    }
  });
  $("#sourceDropZone").addEventListener("dragover", (event) => {
    event.preventDefault();
    event.currentTarget.classList.add("drag-over");
  });
  $("#sourceDropZone").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("drag-over"));
  $("#sourceDropZone").addEventListener("drop", async (event) => {
    event.preventDefault();
    event.currentTarget.classList.remove("drag-over");
    try {
      await parseSourceFilePaths([...event.dataTransfer.files].map((file) => file.path));
    } catch (error) {
      state.sourceDocuments = [];
      state.sourceConflicts = [];
      state.sourceErrors = [{ filename: "파일", message: error.message }];
      renderSourceFiles();
    }
  });
  $("#crawlMemberBoardButton")?.addEventListener("click", () => runDailyWorkflowAction("회원마당 수집", async () => {
    await window.blogAuto.crawlMemberBoard({ accountId: selectedAccount()?.id || "" });
    await window.blogAuto.prepareDailyPlan({ accountId: selectedAccount()?.id || "", date: state.dailyDate });
  }));
  $("#crawlNaverStyleButton")?.addEventListener("click", () => runDailyWorkflowAction("기존 블로그 스타일 추출", async () => {
    await window.blogAuto.crawlNaverStyle({ accountId: selectedAccount()?.id || "" });
  }));
  $("#prepareDailyPlanButton")?.addEventListener("click", () => runDailyWorkflowAction("9개 슬롯 준비", async () => {
    const hasProgress = state.dailyPlan?.items?.some((item) => (
      item.draftReady === true
      || Boolean(item.draftBody)
      || ["승인됨", "발행완료", "확인 필요"].includes(item.status)
    ));
    if (hasProgress && !window.confirm("오늘 이미 생성된 초안과 승인 상태가 있습니다.\n다시 준비하면 기존 내용이 모두 사라집니다.\n계속하시겠습니까?")) {
      const status = $("#dailyWorkflowStatus");
      if (status) status.textContent = "9개 슬롯 재준비를 취소했습니다. 기존 초안과 승인 상태를 유지합니다.";
      return;
    }
    await window.blogAuto.prepareDailyPlan({
      accountId: selectedAccount()?.id || "",
      date: state.dailyDate,
      force: Boolean(hasProgress)
    });
  }));
  $("#loadTodayDailyButton")?.addEventListener("click", async () => {
    const status = $("#dailyWorkflowStatus");
    if (status) status.textContent = "오늘 저장된 작업을 불러오는 중...";
    try {
      await refreshDailyWorkflow();
      addLog({ level: "info", message: "오늘 저장된 일일 계획·초안·승인 상태를 다시 불러왔습니다.", at: new Date().toISOString() });
    } catch (error) {
      if (status) status.textContent = `오늘 작업 불러오기 실패: ${error.message}`;
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    }
  });
  $("#generateDailyDraftsButton")?.addEventListener("click", () => runDailyWorkflowAction("일일 초안 생성", async () => {
    await window.blogAuto.generateDailyDrafts({ accountId: selectedAccount()?.id || "", date: state.dailyDate });
  }));
  $("#runRandomDailyButton")?.addEventListener("click", async () => {
    if (!window.confirm("9개 슬롯 중 1개 주제를 랜덤 선택하고, ‘알아두면 좋은 지식’ 카테고리 규칙으로 웹 검색·글 작성 후 온새카에 등록합니다. 계속할까요?")) return;
    await runDailyWorkflowAction("랜덤 주제 웹 검색·온새카 등록", async () => {
      await window.blogAuto.runRandomDailyResearch({ accountId: selectedAccount()?.id || "", date: state.dailyDate });
    });
  });
  $("#publishApprovedDailyButton")?.addEventListener("click", async () => {
    const approved = state.dailyPlan?.items?.filter((item) => item.status === "승인됨" && item.draftReady && item.draftBody) || [];
    const status = $("#dailyWorkflowStatus");
    if (!approved.length) {
      if (status) status.textContent = "발행할 승인 초안이 없습니다. 초안을 확인한 뒤 승인해 주세요.";
      addLog({ level: "warn", message: "발행 요청을 중단했습니다. 승인된 초안이 없습니다.", at: new Date().toISOString() });
      return;
    }
    if (!window.confirm(`승인된 ${approved.length}건만 네이버 블로그에 발행합니다. 온새카 회원마당에는 등록하지 않습니다. 계속할까요?`)) {
      if (status) status.textContent = "승인 항목 발행을 취소했습니다.";
      return;
    }
    await runDailyWorkflowAction("승인 항목 발행", () => window.blogAuto.publishApprovedDaily({ accountId: selectedAccount()?.id || "", date: state.dailyDate }));
  });
  $("#registerSchedulerButton")?.addEventListener("click", async () => {
    const status = $("#schedulerStatus");
    try {
      await window.blogAuto.openMemberBoardWritePage({ accountId: selectedAccount()?.id || "" });
      addLog({
        level: "info",
        message: "회원마당 글쓰기 로그인 페이지를 열었습니다. 브라우저에서 로그인을 완료한 뒤 계속하세요.",
        at: new Date().toISOString()
      });
      if (!window.confirm("회원마당 글쓰기 페이지가 열렸습니다. 브라우저에서 로그인 입력을 완료했으면 확인을 눌러 스케줄러 확인을 계속할까요?")) {
        if (status) status.textContent = "로그인 확인 대기 중 · 스케줄러 작업은 실행하지 않았습니다.";
        return;
      }
      const loginCheck = await window.blogAuto.waitMemberBoardLogin({ timeoutMs: 20000 });
      if (!loginCheck?.loggedIn) {
        if (status) status.textContent = `회원마당 로그인 확인 필요 · ${loginCheck?.url || "로그인 창 유지"}`;
        addLog({
          level: "warn",
          message: `회원마당 로그인 완료를 확인하지 못했습니다: ${loginCheck?.reason || "로그인 창을 유지합니다."} 프로그램이 직접 연 Chrome에서 로그인해 주세요.`,
          at: new Date().toISOString()
        });
        window.alert("프로그램이 직접 연 Chrome 로그인 창에서 로그인과 보안 확인을 완료한 뒤, 이 버튼을 다시 눌러 주세요. 로그인 창은 닫지 않았습니다.");
        return;
      }
      await window.blogAuto.closeMemberBoardWritePage();
      addLog({
        level: "info",
        message: "회원마당 로그인 세션을 저장하고 로그인 창을 닫았습니다. 이후 수집은 같은 Chrome 프로필을 사용합니다.",
        at: new Date().toISOString()
      });
      if (!window.confirm("09:00 랜덤 주제 선택·카테고리 규칙 적용·웹 검색·초안 작성·온새카 등록, 10:30 실패 재시도, 12:00 승인 네이버 글 발행을 Windows 작업 스케줄러에 등록할까요?")) return;
      if (status) status.textContent = "Windows 스케줄러 등록 중...";
      renderSchedulerStatus(await window.blogAuto.registerScheduler());
      const todayRun = await window.blogAuto.checkTodayScheduler();
      if (!todayRun.needsManualRun) {
        if (status) status.textContent = `등록됨 · ${todayRun.reason}`;
        return;
      }
      const lastRunNote = todayRun.lastRun?.reason ? `\n마지막 결과: ${todayRun.lastRun.reason}` : "";
      if (!window.confirm(
        `오늘 09:00 실행이 정상 완료되지 않았습니다.${lastRunNote}\n\n지금 즉시 랜덤 주제 선택 → ‘알아두면 좋은 지식’ 규칙 적용 → 웹 검색·초안 작성·온새카 등록을 시작할까요?`
      )) {
        if (status) status.textContent = "등록됨 · 오늘 놓친 실행은 시작하지 않았습니다.";
        addLog({ level: "info", message: "오늘 09:00 작업의 수동 실행을 취소했습니다. 예약은 등록된 상태입니다.", at: new Date().toISOString() });
        return;
      }
      await runDailyWorkflowAction("놓친 오늘 09:00 작업", () => window.blogAuto.runMissedScheduler());
      renderSchedulerStatus(await window.blogAuto.loadScheduler());
    } catch (error) {
      if (status) status.textContent = `등록 실패: ${error.message}`;
      addLog({ level: "error", message: `Windows 스케줄러 등록 실패: ${error.message}`, at: new Date().toISOString() });
    }
  });
  $("#unregisterSchedulerButton")?.addEventListener("click", async () => {
    if (!window.confirm("등록된 A안 Windows 작업 스케줄러를 해제할까요?")) return;
    const status = $("#schedulerStatus");
    if (status) status.textContent = "Windows 스케줄러 해제 중...";
    try {
      renderSchedulerStatus(await window.blogAuto.unregisterScheduler());
    } catch (error) {
      if (status) status.textContent = `해제 실패: ${error.message}`;
      addLog({ level: "error", message: `Windows 스케줄러 해제 실패: ${error.message}`, at: new Date().toISOString() });
    }
  });
  $("#publishVisibility").addEventListener("change", updateModeControls);
  $("#publishScheduleMode").addEventListener("change", updateModeControls);
  $("#jobForm").querySelectorAll("input, select, textarea").forEach((control) => {
    if ([
      "accountLabel",
      "blogId",
      "categoryName",
      "categoryKeyword",
      "categoryExcludedTopics",
      "categoryPublishPurpose",
      "categoryPreferredTone",
      "categoryFreshnessLevel",
      "categorySearchChannel",
      "categoryPrimarySearchProvider",
      "categoryFallbackSearchProvider",
      "categoryTrustBlogAsSource"
    ].includes(control.id)) {
      return;
    }
    control.addEventListener("input", scheduleSettingsSave);
      control.addEventListener("change", scheduleSettingsSave);
  });
  await restoreSourceFiles(initial.settings?.sourceFilePaths || []);
}

boot().catch((error) => {
  addLog({ level: "error", message: error.message, at: new Date().toISOString() });
});
