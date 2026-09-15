const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { normalizeMaxBodyImages } = require("./settings");

const DEFAULT_AGENT_MODELS = {
  main: "high",
  research: "high",
  writer: "high",
  image: "medium",
  imageStyle: "medium"
};
const VALID_AGENT_MODEL_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
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
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1"]);
const DEFAULT_CODEX_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_USAGE_LIMIT_TYPES = new Set([
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);
const AGENT_DISPLAY_NAMES = {
  main: "Main Agent",
  research: "Research/Title Agent",
  writer: "Writer Agent",
  image: "Image Worker",
  imageStyle: "Image Style Agent"
};

function normalizeAgentModels(models = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_MODELS).map(([agent, fallback]) => {
    const value = String(models?.[agent] || fallback);
    return [agent, VALID_AGENT_MODEL_EFFORTS.has(value) ? value : fallback];
  }));
}

function modelEffortForAgent(options, agent) {
  return normalizeAgentModels(options.agentModels)[agent] || DEFAULT_AGENT_MODELS[agent] || "high";
}

function normalizeCodexModel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CODEX_MODEL_IDS.has(normalized) ? normalized : "";
}

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function agentDisplayName(agent) {
  return AGENT_DISPLAY_NAMES[String(agent || "").toLowerCase()] || "Agent";
}

function shouldRunCodexViaShell(commandPath) {
  if (process.platform !== "win32") return false;
  const value = String(commandPath || "");
  const ext = path.extname(value).toLowerCase();
  return ext === ".cmd" || ext === ".bat" || !path.isAbsolute(value);
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeRateLimitType(value) {
  return String(value || "")
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/[A-Z]/g, (char, index) => `${index ? "_" : ""}${char.toLowerCase()}`)
    .replace(/__+/g, "_")
    .replace(/^rate_limit_reached_type[:=]/i, "")
    .trim()
    .toLowerCase();
}

function createCodexUsageLimitError(rateLimitType = "", detail = "") {
  const normalizedType = normalizeRateLimitType(rateLimitType);
  const isUsageLimit = CODEX_USAGE_LIMIT_TYPES.has(normalizedType) || /usage_limit/i.test(normalizedType);
  const message = isUsageLimit
    ? "Codex 사용량 한도에 도달해 작업을 중단합니다. 한도가 초기화되거나 사용량이 추가된 뒤 다시 실행해 주세요."
    : "Codex 한도에 도달해 작업을 중단합니다. 한도가 초기화되거나 제한이 해제된 뒤 다시 실행해 주세요.";
  const error = new Error(message);
  error.code = "CODEX_USAGE_LIMIT";
  error.codexRateLimitType = normalizedType || "unknown";
  error.codexLimitDetail = String(detail || "").slice(0, 1000);
  return error;
}

function createCodexExecutionError(message, { model = "", detail = "" } = {}) {
  const activeModel = model ? ` 현재 Codex 모델: ${model}.` : "";
  const diagnostic = detail ? `\n마지막 Codex 출력: ${detail}` : "";
  const error = new Error(`${message}${activeModel} Codex CLI 실행환경, 로그인 상태, 모델 설정을 확인해 주세요.${diagnostic}`);
  error.code = "CODEX_EXEC_FAILED";
  error.failurePhase = "codex";
  error.codexModel = model || "";
  error.codexExecutionDetail = String(detail || "").slice(0, 1000);
  return error;
}

function isCodexUsageLimitError(error) {
  return error?.code === "CODEX_USAGE_LIMIT";
}

function tryParseJsonLine(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectRateLimitReachedTypes(value, found = [], depth = 0) {
  if (!value || depth > 8) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectRateLimitReachedTypes(item, found, depth + 1);
    return found;
  }
  if (typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    if (["rate_limit_reached_type", "rateLimitReachedType", "x-codex-rate-limit-reached-type"].includes(key)) {
      const type = normalizeRateLimitType(nested);
      if (type && type !== "null" && type !== "undefined") found.push(type);
    }
    collectRateLimitReachedTypes(nested, found, depth + 1);
  }
  return found;
}

function detectCodexUsageLimitSignal(line) {
  const text = stripAnsi(line).trim();
  if (!text) return null;

  const parsed = tryParseJsonLine(text);
  const jsonTypes = parsed ? collectRateLimitReachedTypes(parsed) : [];
  const directMatch = text.match(/\b(workspace_owner_usage_limit_reached|workspace_member_usage_limit_reached)\b/i);
  const type = normalizeRateLimitType(jsonTypes[0] || directMatch?.[1] || "");
  if (CODEX_USAGE_LIMIT_TYPES.has(type)) {
    return { type, detail: text };
  }

  if (/\bUsageLimitExceeded\b/i.test(text)) {
    return { type: "usage_limit_exceeded", detail: text };
  }
  if (/\busage[_ -]?limit\b/i.test(text) && /\b(reached|exceeded|exhausted|hit)\b/i.test(text)) {
    return { type: "usage_limit_message", detail: text };
  }
  return null;
}

function jsonTokenTotal(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info?.total_token_usage?.total_tokens,
    payload?.info?.last_token_usage?.total_tokens,
    payload?.info?.total_tokens,
    payload?.total_token_usage?.total_tokens,
    payload?.last_token_usage?.total_tokens,
    payload?.total_tokens,
    event?.info?.total_token_usage?.total_tokens,
    event?.info?.last_token_usage?.total_tokens,
    event?.total_token_usage?.total_tokens
  ];
  for (const candidate of candidates) {
    const total = Number(candidate);
    if (Number.isFinite(total) && total >= 0) return total;
  }
  return null;
}

function normalizeTokenNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function tokenUsageFromInfo(info = {}) {
  const totalUsage = info?.total_token_usage || null;
  const lastUsage = info?.last_token_usage || null;
  const grossTotal = normalizeTokenNumber(totalUsage?.total_tokens);
  const inputTokens = normalizeTokenNumber(totalUsage?.input_tokens);
  const cachedInputTokens = normalizeTokenNumber(totalUsage?.cached_input_tokens);
  const outputTokens = normalizeTokenNumber(totalUsage?.output_tokens);
  const lastTotal = normalizeTokenNumber(lastUsage?.total_tokens);
  const lastInputTokens = normalizeTokenNumber(lastUsage?.input_tokens);
  const lastCachedInputTokens = normalizeTokenNumber(lastUsage?.cached_input_tokens);
  const lastOutputTokens = normalizeTokenNumber(lastUsage?.output_tokens);

  let total = null;
  if (inputTokens !== null || outputTokens !== null) {
    total = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0)) + (outputTokens || 0);
  } else if (grossTotal !== null) {
    total = grossTotal;
  } else if (lastInputTokens !== null || lastOutputTokens !== null) {
    total = Math.max(0, (lastInputTokens || 0) - (lastCachedInputTokens || 0)) + (lastOutputTokens || 0);
  } else if (lastTotal !== null) {
    total = lastTotal;
  }

  if (total === null && grossTotal === null && lastTotal === null) return null;
  return {
    total: total || 0,
    grossTotal: grossTotal ?? lastTotal ?? total ?? 0,
    inputTokens: inputTokens || 0,
    cachedInputTokens: cachedInputTokens || 0,
    outputTokens: outputTokens || 0,
    lastTotal: lastTotal || 0,
    lastInputTokens: lastInputTokens || 0,
    lastCachedInputTokens: lastCachedInputTokens || 0,
    lastOutputTokens: lastOutputTokens || 0
  };
}

function jsonTokenUsage(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info,
    payload,
    event?.info,
    event
  ];
  for (const candidate of candidates) {
    const usage = tokenUsageFromInfo(candidate);
    if (usage) return usage;
  }
  const total = jsonTokenTotal(event);
  return total === null ? null : { total, grossTotal: total };
}

function normalizePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}

function normalizeCodexRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = normalizePercent(window.used_percent ?? window.usedPercent);
  const remainingPercent = usedPercent === null ? null : Number((100 - usedPercent).toFixed(2));
  const windowMinutes = Number(window.window_minutes ?? window.windowMinutes);
  return {
    usedPercent,
    remainingPercent,
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    resetsAt: String(window.resets_at ?? window.resetsAt ?? "")
  };
}

function normalizeCodexRateLimits(rawRateLimits) {
  if (!rawRateLimits || typeof rawRateLimits !== "object") return null;
  const primary = normalizeCodexRateLimitWindow(rawRateLimits.primary);
  const secondary = normalizeCodexRateLimitWindow(rawRateLimits.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: String(rawRateLimits.limit_id ?? rawRateLimits.limitId ?? ""),
    limitName: rawRateLimits.limit_name ?? rawRateLimits.limitName ?? null,
    primary,
    secondary,
    credits: rawRateLimits.credits ?? null,
    planType: String(rawRateLimits.plan_type ?? rawRateLimits.planType ?? ""),
    rateLimitReachedType: normalizeRateLimitType(rawRateLimits.rate_limit_reached_type ?? rawRateLimits.rateLimitReachedType ?? ""),
    updatedAt: new Date().toISOString()
  };
}

function jsonRateLimits(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info?.rate_limits,
    payload?.rate_limits,
    event?.info?.rate_limits,
    event?.rate_limits
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCodexRateLimits(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function codexSessionsRoot() {
  const codexHome = String(process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function listRecentSessionFiles(root, limit = 80) {
  if (!root || !fs.existsSync(root)) return [];
  const stack = [root];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);
}

function readLatestCodexRateLimitsFromSessions() {
  const files = listRecentSessionFiles(codexSessionsRoot());
  for (const filePath of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/).reverse();
    for (const line of lines) {
      const parsed = tryParseJsonLine(line);
      if (!parsed) continue;
      const rateLimits = jsonRateLimits(parsed);
      if (!rateLimits) continue;
      rateLimits.updatedAt = String(parsed.timestamp || rateLimits.updatedAt || new Date().toISOString());
      rateLimits.source = "codex-session";
      return {
        source: "codex-session",
        tokenUsage: {
          ...(jsonTokenUsage(parsed) || { total: 0, grossTotal: jsonTokenTotal(parsed) || 0 }),
          rateLimits
        },
        rateLimits
      };
    }
  }
  return null;
}

function normalizePathForSearch(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function sessionCwdFromRaw(raw) {
  for (const line of String(raw || "").split(/\r?\n/).slice(0, 40)) {
    const parsed = tryParseJsonLine(line);
    if (!parsed) continue;
    const cwd = parsed?.payload?.cwd;
    if (typeof cwd === "string" && cwd.trim()) return cwd;
  }
  return "";
}

function sessionMatchesJob(raw, jobDir, resultPath) {
  const normalizedJobDir = normalizePathForSearch(jobDir);
  const normalizedResultPath = normalizePathForSearch(resultPath);
  const sessionCwd = sessionCwdFromRaw(raw);
  if (sessionCwd) {
    return normalizePathForSearch(sessionCwd) === normalizedJobDir;
  }
  const searchable = normalizePathForSearch(raw);
  return searchable.includes(normalizedResultPath) || searchable.includes(normalizedJobDir);
}

function readLatestCodexTokenUsageFromSessions({
  sinceMs = 0,
  jobDir = "",
  resultFileName = ""
} = {}) {
  const expectedResultPath = resultFileName && jobDir
    ? normalizePathForSearch(path.join(jobDir, resultFileName))
    : "";
  const expectedFileName = normalizePathForSearch(resultFileName);
  const files = listRecentSessionFiles(codexSessionsRoot(), 120);
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (sinceMs && stat.mtimeMs < sinceMs - 10000) continue;
    } catch {
      continue;
    }

    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }

    if (expectedResultPath && !sessionMatchesJob(raw, jobDir, path.join(jobDir, resultFileName))) continue;

    let latestUsage = null;
    let latestRateLimits = null;
    let updatedAt = "";
    for (const line of raw.split(/\r?\n/)) {
      const parsed = tryParseJsonLine(line);
      if (!parsed) continue;
      const parsedUsage = jsonTokenUsage(parsed);
      if (parsedUsage) {
        latestUsage = parsedUsage;
        updatedAt = String(parsed.timestamp || updatedAt || "");
      }
      const parsedRateLimits = jsonRateLimits(parsed);
      if (parsedRateLimits) {
        latestRateLimits = parsedRateLimits;
        latestRateLimits.updatedAt = String(parsed.timestamp || latestRateLimits.updatedAt || new Date().toISOString());
        latestRateLimits.source = "codex-session";
        updatedAt = String(parsed.timestamp || updatedAt || "");
      }
    }
    if (latestUsage || latestRateLimits) {
      return {
        source: "codex-session",
        sessionFile: filePath,
        updatedAt,
        tokenUsage: {
          ...(latestUsage || { total: 0, grossTotal: 0 }),
          rateLimits: latestRateLimits
        },
        rateLimits: latestRateLimits
      };
    }
  }
  return null;
}

function pushAssistantContentText(content, texts) {
  if (typeof content === "string") {
    texts.push(content);
    return;
  }
  if (!content) return;
  if (Array.isArray(content)) {
    for (const item of content) pushAssistantContentText(item, texts);
    return;
  }
  if (typeof content !== "object") return;
  if (typeof content.text === "string") texts.push(content.text);
  if (typeof content.output_text === "string") texts.push(content.output_text);
  if (typeof content.message === "string") texts.push(content.message);
}

function extractAssistantOutputTexts(event) {
  const payload = event?.payload || event || {};
  const item = payload.item || payload.payload || payload;
  const texts = [];

  if (payload.type === "agent_message" && typeof payload.message === "string") {
    texts.push(payload.message);
  }
  if (payload.type === "response_item" && item?.role === "assistant") {
    pushAssistantContentText(item.content, texts);
  }
  if (item?.type === "message" && item?.role === "assistant") {
    pushAssistantContentText(item.content, texts);
  }
  if (item?.type === "agent_message" && typeof item.message === "string") {
    texts.push(item.message);
  }
  if (payload.type === "agent_message_delta" && typeof payload.delta === "string") {
    texts.push(payload.delta);
  }
  return texts;
}

function isUsefulCodexFeedback(line) {
  const text = stripAnsi(line).trim();
  if (!text) return false;
  if (looksLikeMojibake(text)) return false;
  if (/^OpenAI Codex\b/i.test(text)) return false;
  if (/^-{3,}$/.test(text)) return false;
  if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(text)) return false;
  if (/^(user|assistant)$/i.test(text)) return false;
  if (/^BLOGAUTO_RESULT_READY$/i.test(text)) return false;
  if (/^mcp:/i.test(text)) return false;
  if (/codex_core::tools::router/i.test(text)) return false;
  if (/codex_core_plugins::manifest/i.test(text)) return false;
  if (/ignoring interface\.defaultPrompt/i.test(text)) return false;
  if (/^Wall time:/i.test(text)) return false;
  if (/^Output:/i.test(text)) return false;
  if (/ConvertFrom-Json|CategoryInfo|FullyQualifiedErrorId/i.test(text)) return false;
  if (/^(Get-Content|Invoke-WebRequest|Set-Content|Out-File|Copy-Item|Move-Item|Remove-Item)\s*:/i.test(text)) return false;
  if (/Cannot find path|because it does not exist|원격 서버에 연결할 수 없습니다|액세스가 거부되었습니다|AccessException|PermissionDenied|Exception\b|At line:/i.test(text)) return false;
  if (/^위치\s+줄|^At line:/i.test(text)) return false;
  if (/^\+\s+/.test(text)) return false;
  if (/^[\{\}\],]+$/.test(text)) return false;
  const inlineJsonFragment = text.startsWith("{") || text.startsWith("[")
    ? text.slice(1).trimStart()
    : "";
  if (inlineJsonFragment.startsWith("\"") && inlineJsonFragment.indexOf("\":") > 1) return false;
  const inlineJsonColonIndex = inlineJsonFragment.indexOf(":");
  if (inlineJsonColonIndex > 0 && /^[A-Za-z0-9_$-]+$/.test(inlineJsonFragment.slice(0, inlineJsonColonIndex))) return false;
  if (/^"[^"]+"\s*:\s*/.test(text)) return false;
  if (/^"[^"]*"\s*,?$/.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}T.*\b(WARN|DEBUG|TRACE)\b/i.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}T.*\bERROR\b.*codex_core/i.test(text)) return false;
  if (/^\[?codex\]?\s*mcp:/i.test(text)) return false;
  return true;
}

function looksLikeMojibake(text) {
  const value = String(text || "");
  if (value.includes("\uFFFD")) return true;
  const questionMarks = (value.match(/\?/g) || []).length;
  const cjkMarkers = (value.match(/[一-龥燎-刺]/g) || []).length;
  if (questionMarks >= 2 && cjkMarkers >= 2) return true;
  const markerCount = [
    "怨", "寃", "湲", "醫", "諛", "蹂", "吏", "泥", "理", "踰", "援", "紐",
    "묒", "떖", "쇰", "ъ", "꽦", "쒕", "떎", "쒖", "섏", "먯", "꾩", "낅", "뺤", "앸", "뻽", "듬", "땲",
    "씤", "덈", "쓣", "쓽", "쟻", "젙", "룞", "쉶", "깆", "낵", "쓬", "븯"
  ].reduce((count, marker) => count + (value.includes(marker) ? 1 : 0), 0);
  return (markerCount >= 2 && questionMarks >= 1) || markerCount >= 4;
}

function shouldSuppressWriterFeedback(agent, level) {
  return agent === "writer" && !["warn", "error"].includes(String(level || "info"));
}

function shouldForwardRawCodexOutput(options = {}) {
  return options.debugCodexRawOutput === true || process.env.BLOGAUTO_DEBUG_CODEX_RAW === "1";
}

function parseTokenLine(text, tokenState) {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return null;
  const sameLine = cleaned.match(/tokens?\s+used\s*:?\s*([0-9][0-9,]*)/i);
  if (sameLine) {
    const total = Number(sameLine[1].replace(/,/g, ""));
    return Number.isFinite(total) ? total : null;
  }
  if (/tokens?\s+used/i.test(cleaned)) {
    tokenState.awaitingValue = true;
    return null;
  }
  if (tokenState.awaitingValue) {
    const nextLine = cleaned.match(/^([0-9][0-9,]*)$/);
    tokenState.awaitingValue = false;
    if (nextLine) {
      const total = Number(nextLine[1].replace(/,/g, ""));
      return Number.isFinite(total) ? total : null;
    }
  }
  return null;
}

function parseProgressLine(text, options = {}) {
  const match = String(text || "").trim().match(/^BLOGAUTO_PROGRESS:\s*(.+)$/i);
  if (!match) return null;
  const code = match[1].trim().toLowerCase();
  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  const usesImages = options.includeTitleImage !== false || bodyImageLimit > 0;
  if (code === "image" && !usesImages) return null;
  const labels = {
    research: "리서치 흐름 분석 중",
    title: "제목 선정 중",
    source_review: "검색 후보 검토 중",
    date_filter: "기간성 정보 검증 중",
    writer: "Writer Agent 작성 중",
    article: "본문 작성 중",
    main_review: "Main Agent 최종 검수 중",
    image: "이미지 생성 중",
    save: "결과 저장 중"
  };
  return labels[code] || match[1].trim();
}

function compactSearchResultsForPrompt(searchResults, {
  maxResults = 12,
  excerptChars = 700
} = {}) {
  return rankSearchResultsForPrompt(searchResults)
    .slice(0, maxResults)
    .map((item, index) => {
      const relevance = item?.relevance || {};
      return {
        sourceId: String(item?.sourceId || `source-${index + 1}`),
        provider: String(item?.provider || ""),
        title: String(item?.title || ""),
        url: String(item?.url || ""),
        fetchedUrl: String(item?.fetchedUrl || ""),
        contentLength: Number(item?.contentLength || 0),
        excerpt: String(item?.excerpt || "").replace(/\s+/g, " ").trim().slice(0, excerptChars),
        relevance: {
          score: Number(relevance.score || 0),
          topicMatchedTerms: Array.isArray(relevance.topicMatchedTerms) ? relevance.topicMatchedTerms.slice(0, 8) : [],
          keywordMatchedTerms: Array.isArray(relevance.keywordMatchedTerms) ? relevance.keywordMatchedTerms.slice(0, 8) : [],
          officialSource: relevance.officialSource === true,
          institutionalSource: relevance.institutionalSource === true,
          independentSource: relevance.independentSource === true,
          blogTrustedSource: relevance.blogTrustedSource === true,
          lowTrustSource: relevance.lowTrustSource === true,
          currentFactSignal: relevance.currentFactSignal === true,
          strictEvidence: relevance.strictEvidence === true,
          authorityEvidence: relevance.authorityEvidence === true,
          independentEvidence: relevance.independentEvidence === true
        }
      };
    });
}

function searchResultPromptKey(item) {
  return String(item?.fetchedUrl || item?.url || item?.title || "").trim().toLowerCase();
}

function isAuthorityPromptCandidate(item) {
  const relevance = item?.relevance || {};
  return relevance.officialSource === true || relevance.institutionalSource === true;
}

function isIndependentPromptCandidate(item) {
  return item?.relevance?.independentSource === true;
}

function isStrongPromptCandidate(item) {
  const relevance = item?.relevance || {};
  return relevance.strictEvidence === true
    && relevance.currentFactSignal === true
    && relevance.lowTrustSource !== true
    && Number(relevance.score || 0) >= 8;
}

function scoreSearchResultForPrompt(item) {
  return Number(item?.relevance?.score || 0);
}

function uniquePromptCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = searchResultPromptKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function rankSearchResultsForPrompt(searchResults) {
  const items = Array.isArray(searchResults) ? searchResults.filter(Boolean) : [];
  const authorityItems = items
    .filter(isAuthorityPromptCandidate)
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  const independentItems = items
    .filter((item) => !isAuthorityPromptCandidate(item) && isIndependentPromptCandidate(item))
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  const strongItems = items
    .filter((item) => !isAuthorityPromptCandidate(item) && !isIndependentPromptCandidate(item) && isStrongPromptCandidate(item))
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  return uniquePromptCandidates([...authorityItems, ...independentItems, ...strongItems, ...items]);
}

function compactResearchHandoffForPrompt(researchResult, { includeWriterContract = false } = {}) {
  const source = researchResult && typeof researchResult === "object" ? researchResult : {};
  const compact = {
    status: source.status || "",
    failureReason: source.failureReason || "",
    finalTitle: source.finalTitle || source.selectedTitle || "",
    topicThesis: source.topicThesis || "",
    topicLane: source.topicLane || "",
    selectedKeywordPhrases: Array.isArray(source.selectedKeywordPhrases) ? source.selectedKeywordPhrases : [],
    searchNeed: source.searchNeed || "",
    safeGeneralTopicFallback: source.safeGeneralTopicFallback === true,
    factBased: source.factBased === true,
    directTopicPreserved: source.directTopicPreserved !== false,
    anchorEvent: source.anchorEvent || {},
    currentPeg: source.currentPeg || {},
    currentBridgeRequired: source.currentBridgeRequired === true,
    currentBridgeSatisfied: source.currentBridgeSatisfied === true,
    coreQuestions: compactTextList(source.coreQuestions),
    mustCover: compactTextList(source.mustCover),
    avoidDirections: compactTextList(source.avoidDirections),
    confirmedFacts: compactTextList(source.confirmedFacts),
    uncertainItems: compactTextList(source.uncertainItems),
    usableSources: (Array.isArray(source.usableSources) ? source.usableSources : []).slice(0, 12).map((item) => ({
      sourceId: item?.sourceId || "",
      title: item?.title || "",
      url: item?.url || "",
      reason: item?.reason || ""
    })),
    writerBrief: source.writerBrief || ""
  };
  if (includeWriterContract) compact.writerContract = source.writerContract || {};
  return compact;
}

function compactWriterResultForPrompt(writerResult) {
  const source = writerResult && typeof writerResult === "object" ? writerResult : {};
  return {
    status: source.status || "",
    failureReason: source.failureReason || "",
    title: source.title || "",
    article: source.article || "",
    tags: Array.isArray(source.tags) ? source.tags : [],
    titleImagePrompt: source.titleImagePrompt || "",
    titleImageText: Array.isArray(source.titleImageText) ? source.titleImageText : [],
    bodyImages: Array.isArray(source.bodyImages) ? source.bodyImages : [],
    notes: compactTextList(source.notes)
  };
}

function sourcePromptRole(document, documents) {
  const fileType = String(document?.file_type || "").toLowerCase();
  const hasPdf = (Array.isArray(documents) ? documents : []).some((item) => String(item?.file_type || "").toLowerCase() === "pdf");
  if (fileType === "pdf") {
    return {
      code: "primary_original_pdf",
      label: "최우선 원본(PDF)",
      priority: 1,
      rule: "숫자·조건·날짜·표·페이지 근거의 최종 판단 기준"
    };
  }
  if (hasPdf && fileType === "md") {
    return {
      code: "auxiliary_md_summary",
      label: "보조 정리(MD)",
      priority: 2,
      rule: "원본 PDF의 내용을 정리한 보조 자료; PDF를 대체하지 않음"
    };
  }
  return {
    code: "supporting_user_file",
    label: "보조 원본 파일",
    priority: 3,
    rule: "PDF가 없을 때 사용 가능한 사용자 제공 근거"
  };
}

function sourcePromptFocusTerms(focusText) {
  const normalized = String(focusText || "")
    .replace(/[\r\n,，、/|()[\]{}:：;；]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return [];
  return [...new Set(normalized.split(" ").map((item) => item.trim()).filter((item) => item.length >= 2))];
}

function sourceSectionScore(section, focusTerms) {
  const value = `${String(section?.heading || "")} ${String(section?.text || "")}`.toLowerCase();
  return focusTerms.reduce((score, term) => score + (value.includes(term) ? (term.length >= 4 ? 3 : 1) : 0), 0);
}

function selectSourceSectionsForPrompt(sections, focusTerms, maxSections = 48) {
  const list = Array.isArray(sections) ? sections : [];
  if (!list.length) return [];
  if (!focusTerms.length || list.length <= maxSections) return list;
  const ranked = list
    .map((section, index) => ({ section, index, score: sourceSectionScore(section, focusTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selectedIndexes = new Set();
  for (const item of ranked.slice(0, Math.max(1, Math.floor(maxSections / 2)))) {
    selectedIndexes.add(item.index);
    if (item.index > 0) selectedIndexes.add(item.index - 1);
    if (item.index + 1 < list.length) selectedIndexes.add(item.index + 1);
  }
  if (!selectedIndexes.size) return list.slice(0, Math.min(maxSections, list.length));
  return list.filter((_section, index) => selectedIndexes.has(index)).slice(0, maxSections);
}

function rankSourceSectionsForPrompt(sections, focusTerms, maxSections = 24) {
  const list = Array.isArray(sections) ? sections : [];
  if (!focusTerms.length) return [];
  return list
    .map((section, index) => ({ section, index, score: sourceSectionScore(section, focusTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxSections)
    .map((item) => item.section);
}

function compactSourceDocumentsForPrompt(documents, conflicts = [], maxChars = 70000, focusText = "") {
  const list = Array.isArray(documents) ? documents : [];
  let remaining = Math.max(1000, Number(maxChars || 70000));
  const focusTerms = sourcePromptFocusTerms(focusText);
  const ordered = list
    .map((document, index) => ({ document, index, role: sourcePromptRole(document, list) }))
    .sort((a, b) => a.role.priority - b.role.priority || a.index - b.index);
  const output = [];
  for (const [position, entry] of ordered.entries()) {
    if (remaining <= 0) break;
    const document = entry.document;
    const sections = Array.isArray(document?.source_sections) ? document.source_sections : [];
    const tables = Array.isArray(document?.tables) ? document.tables : [];
    const perDocumentBudget = entry.role.priority === 1
      ? Math.max(12000, Math.floor(remaining * 0.8))
      : Math.max(4000, Math.floor(remaining / Math.max(1, ordered.length - position)));
    const selectedSections = selectSourceSectionsForPrompt(
      sections,
      focusTerms,
      entry.role.priority === 1 ? 64 : 100
    );
    const focusSections = rankSourceSectionsForPrompt(sections, focusTerms, entry.role.priority === 1 ? 24 : 18);
    const value = {
      filename: String(document?.filename || ""),
      file_type: String(document?.file_type || ""),
      source_role: entry.role.label,
      source_role_code: entry.role.code,
      source_priority_rule: entry.role.rule,
      title: String(document?.title || ""),
      text: sections.length ? "(페이지·섹션별 근거는 source_sections에 수록)" : String(document?.text || ""),
      tables: tables.slice(0, 30).map((table) => ({
        name: String(table?.name || ""),
        rows: Array.isArray(table?.rows) ? table.rows.slice(0, 300) : []
      })),
      source_coverage: {
        total_sections: sections.length,
        included_sections: selectedSections.length,
        focused_sections: focusSections.length,
        focus_terms: focusTerms,
        selection_rule: sections.length > selectedSections.length
          ? "긴 문서에서 주제 일치 구간과 인접 페이지를 우선 전달함"
          : "추출된 섹션 전체를 전달함"
      },
      focus_sections: focusSections,
      source_sections: selectedSections,
      metadata: document?.metadata || {}
    };
    const serialized = JSON.stringify(value, null, 2);
    const clipped = serialized.length > perDocumentBudget
      ? `${serialized.slice(0, perDocumentBudget)}\n...[이 파일의 나머지 원문은 프롬프트 길이 제한으로 생략됨]`
      : serialized;
    output.push(clipped);
    remaining -= clipped.length;
  }
  return [
    "SOURCE DOCUMENTS (user-provided factual basis; automatic source roles are included per document):",
    output.join("\n\n"),
    "SOURCE ROLE POLICY:",
    "- PDF가 포함된 경우 PDF는 최우선 원본 근거입니다. MD와 표현·숫자·조건이 다르면 PDF를 우선합니다.",
    "- MD에만 있는 설명은 사실로 단정하지 말고 [추가 설명] 또는 [원본 확인 필요]로 표시합니다.",
    "- 두 자료를 단순 반복하지 말고 PDF의 사실과 MD의 정리 내용을 대조·통합합니다.",
    "SOURCE CONFLICTS:",
    JSON.stringify(Array.isArray(conflicts) ? conflicts : [], null, 2)
  ].join("\n");
}

function isMissingCodexResultFileError(error) {
  return /Codex result file was not created:/i.test(String(error?.message || ""));
}

function formatRecoveryGuidance(guidance = []) {
  if (!Array.isArray(guidance) || !guidance.length) return "";
  return guidance.slice(0, 8).map((item, index) => (
    `${index + 1}. [${String(item?.key || "recovery")}] ${String(item?.guidance || "").trim()}`
  )).filter((line) => !line.endsWith("] ")).join("\n");
}

function buildPrompt({
  topic,
  keyword,
  category,
  searchResults,
  jobDir,
  runtimeRoot,
  currentDateLabel,
  includeTitleImage = true,
  maxBodyImages = 10,
  sourceQuality = null,
  topicMode = "manual",
  researchTitleResult = null,
  excludedTopics = "",
  publishPurpose = "",
  preferredTone = "",
  researchGuidance = "",
  freshnessLevel = "auto",
  writerRevisionFeedback = "",
  writerAttempt = 1,
  maxWriterAttempts = 1,
  accountImageStylePrompt = "",
  sourceMode = "research",
  sourceDocuments = [],
  sourceConflicts = []
}) {
  const resultPath = path.join(jobDir, "agent-result.json");
  const imageDir = path.join(runtimeRoot || path.dirname(path.dirname(jobDir)), "image");
  const bodyImageLimit = normalizeMaxBodyImages(maxBodyImages);
  const usesImages = includeTitleImage !== false || bodyImageLimit > 0;
  const researchSearchNeed = String(researchTitleResult?.searchNeed || "").toLowerCase();
  const sourceFocusText = [topic, keyword, category, publishPurpose, excludedTopics].filter(Boolean).join(" ");
  const writerContract = buildWriterContract(researchTitleResult, {
    topic,
    keyword,
    category,
    publishPurpose,
    preferredTone,
    topicMode,
    currentDateLabel
  });
  const safeGeneralTopicFallback = researchTitleResult?.safeGeneralTopicFallback === true;
  fs.mkdirSync(imageDir, { recursive: true });

  return [
    "You are generating a Korean Naver Blog post for a local desktop automation app.",
    "Do not include credentials or ask for secrets.",
    `Topic: ${topic}`,
    `Content source mode: ${sourceMode}`,
    `Topic mode: ${topicMode}`,
    `Optional keyword: ${keyword || "(none)"}`,
    `Category: ${category}`,
    `Category excluded topics: ${excludedTopics || "(agent decides)"}`,
    `Category publishing direction: ${publishPurpose || "(agent decides)"}`,
    `Preferred tone: ${preferredTone || "(agent decides)"}`,
    researchGuidance ? `Scheduled research guidance:\n${researchGuidance}` : "",
    "- Tone priority: explicit Preferred tone > Writer Contract tone > default human Naver Blog voice. If Preferred tone conflicts with default style rules, follow Preferred tone while preserving factual accuracy, safety, and title/body promise.",
    `Freshness level: ${freshnessLevel || "auto"}`,
    researchTitleResult ? `Research/Title selected title: ${researchTitleResult.finalTitle || researchTitleResult.selectedTitle || ""}` : "",
    `Current writing date: ${currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    sourceMode === "file_upload" ? compactSourceDocumentsForPrompt(sourceDocuments, sourceConflicts, 70000, sourceFocusText) : "",
    sourceMode === "file_upload" ? "- File mode rule: use only the user-provided source documents above. Do not use web search or unstated prior knowledge. Preserve numbers, dates, names, units, and table relationships exactly; if conflicts remain, apply the PDF-first source role policy rather than guessing." : "",
    sourceMode === "file_upload" ? "- File mode paired-source rule: PDF is the primary original, while MD is an auxiliary summary. Use MD to locate or explain relevant content, but verify every publishable value against the PDF when the PDF contains that item." : "",
    sourceMode === "file_upload" ? "- File mode completeness rule: do not fail merely because the uploaded source does not contain a requested technical comparison, decision criterion, legal meaning, or operational detail. Explain only the distinction supported by the source and mark the missing part as [원본에서 확인 불가] or [추가 자료 필요]." : "",
    `Output JSON path: ${resultPath}`,
    `App image directory for later app-side copy: ${imageDir}`,
    "",
    "Progress logging:",
    "- Print only these concise progress lines as each stage begins. Do not print scripts, code, shell commands, or tool internals.",
    "- BLOGAUTO_PROGRESS: source_review",
    "- BLOGAUTO_PROGRESS: date_filter",
    "- BLOGAUTO_PROGRESS: article",
    "- BLOGAUTO_PROGRESS: save",
    "",
    writerRevisionFeedback ? "Revision retry:" : "",
    writerRevisionFeedback ? `- This is Writer retry attempt ${writerAttempt}/${maxWriterAttempts}. Keep the Research/Title final title and rewrite the article JSON to fix the issues below.` : "",
    writerRevisionFeedback ? `- Revision instructions from Main Agent or previous Writer result: ${writerRevisionFeedback}` : "",
    writerRevisionFeedback ? "- Overwrite the same Output JSON path with the corrected result. Do not explain the retry in the article." : "",
    writerRevisionFeedback ? "" : "",
    researchTitleResult ? "Writer contract (highest priority):" : "",
    researchTitleResult ? JSON.stringify(writerContract, null, 2) : "",
    researchTitleResult ? "- The Writer Contract is the only writing brief. Use source candidates and the full Research/Title handoff only to support facts, limits, and source boundaries." : "",
    researchTitleResult ? "- If the full handoff or source candidates conflict with the Writer Contract, keep the selected title/topic and return status \"failed\" rather than drifting." : "",
    researchTitleResult ? "- Category publishing direction may include topic-selection notes for Research/Title Agent. As Writer Agent, treat it only as category scope and reader intent, not as an instruction to perform research, select a topic, or change the selected title." : "",
    researchTitleResult ? "- If Writer Contract says currentBridgeRequired is true, the article must explain both the older anchorEvent and the currentPeg/progress. If currentBridgeSatisfied is not true or currentPeg is missing, return status \"failed\" instead of writing a stale current-issue article." : "",
    safeGeneralTopicFallback ? "- SAFE GENERAL TOPIC FALLBACK: The topic is broad, so write a useful reader-facing explainer from the supplied search excerpts. Do not claim a specific law, enforcement action, current policy status, company announcement, deadline, price, or implementation result unless the excerpt directly supports it. Clearly separate established industry context from interpretation." : "",
    researchTitleResult ? "" : "",
    "Instruction harness:",
    researchTitleResult ? "- You are the Writer Agent. Do not create a new topic and do not change the selected title from the Research/Title Agent." : "",
    researchTitleResult ? "- Use the Writer Contract above as the writing boundary. If it is insufficient, return status \"failed\" instead of inventing facts." : "",
    "- Editorial priority order: Writer Contract > Research/Title finalTitle and topicThesis > confirmed facts/source boundaries > Category publishing direction > Optional keyword.",
    sourceMode === "file_upload"
      ? "- In file mode, treat uncertainty and source boundaries as guardrails, but include a concise [원본에서 확인 불가] or [추가 자료 필요] note when that limitation is necessary to answer the reader's question. Do not invent facts or fail solely because the source is incomplete."
      : "- Treat uncertainty, source boundaries, and source limitations as guardrails. They are not article material by themselves.",
    sourceMode === "file_upload"
      ? "- In file mode, if Writer Contract safetyBoundaries require a comparison or decision criterion that is absent from the uploaded source, state that the source does not provide it and continue with the supported facts; do not pad or invent."
      : "- Treat Writer Contract safetyBoundaries as internal publishing limits. Convert them into supported reader decisions only when the sources provide useful action; otherwise fail instead of describing the article's own limits.",
    "- When facts come from source review, rewrite them as reader-facing subject-state sentences. Do not make the article sound like the writer is reporting that something was observed, checked, or confirmed.",
    "- Use confirmation or verification framing only for the reader's next check on uncertain or variable details, not as the default way to state confirmed menus, programs, facts, or conditions.",
    "- Before writing, map the selected title to reader questions. A successful post must answer those questions with supported information, not fill sections with reminders that information is uncertain.",
    "- Every section must move the reader forward with at least one concrete value item: a confirmed fact, a practical step, a decision criterion, a comparison, a consequence, or a next-check path supported by the handoff.",
    sourceMode === "file_upload"
      ? "- In file mode, if the selected title asks for a comparison but the source only supports a limited distinction, write the supported comparison and explicitly mark the unsupported decision criteria as [원본에서 확인 불가]. Return status \"failed\" only for an empty or contradictory source, not for a bounded technical limitation."
      : safeGeneralTopicFallback
        ? "- In safe general-topic fallback mode, a broad explainer is acceptable only when it gives the reader concrete concepts, industry relationships, decision criteria, and source-bounded next steps. Do not pad the article with research-process narration or unsupported current claims."
        : "- If you can only write broad cautions, repeated verification advice, or a vague overview that does not answer the selected title, return status \"failed\" instead of padding the article.",
    "- If Topic mode is manual, treat Topic as the fixed editorial thesis. Category and Optional keyword are only routing/tagging context and must never override, broaden, rename, or replace the Topic.",
    "- If Topic mode is auto and Topic is only a seed generated from Category/Optional keyword, derive one narrow current thesis from the strongest source candidates. After deriving it, treat that thesis as the fixed article topic.",
    "- Before choosing sources or writing, parse Topic into: main subject, controlling event/action, angle, and the reader question the article must answer.",
    "- If Topic contains an event word such as suspension, shutdown, discontinued, ended, launch, outage, price increase, policy change, controversy, recall, application, recruitment, exhibition, or deadline, that event/action is the controlling angle.",
    "- Example: for a Topic like 'recent Fable 5 service suspension issue', Fable 5 is the subject and service/access suspension is the controlling event. Do not turn it into a generic Claude Code update, AI agent trend, or model comparison article.",
    "- Do not drift into adjacent categories just because a high-ranking result is popular. If a candidate does not directly help explain the Topic thesis, discard it even when it matches Category or Optional keyword.",
    "- Always interpret sources relative to the Current writing date. Use that date only as an internal validation reference.",
    "- Harness step 1: lock the Topic thesis from Topic mode and Topic. Only in auto mode may Category/Optional keyword be used to derive that thesis.",
    "- Harness step 2: discard candidates that do not directly support the locked Topic thesis, including broad background pages that only mention related entities.",
    "- Harness step 3: for date-bound material, discard expired events, closed applications, past deadlines, and outdated schedules using Current writing date.",
    "- Harness step 4: write a reader-facing Naver Blog article by summarizing, explaining, and reorganizing only the remaining relevant extracted excerpts. Do not create an unsupported generic article.",
    "- Harness step 5: before saving JSON, check date handling. The title must not contain the Current writing date. The article must not mention the writing date as a meta value such as 작성일, 작성일자, 오늘 날짜, or 현재 날짜.",
    "- Exception: if the title or body claims 접수중, 모집중, 신청 가능, 현재 운영, current availability, or another current/date-bound status, the article body must include a concise confirmation 기준일 such as '2026년 6월 18일 기준'. This required 기준일 is not a date leak.",
    "- If a true date-leak check fails, rewrite the title/article silently until only allowed 기준일 usage remains. Do not print 'date leak check failed' or mention this internal check in the article.",
    "",
    researchSearchNeed === "skip"
      ? "Research/Title Agent judged that external search can be skipped. Use the Writer Contract as the writing boundary, avoid current/date-bound claims, and do not invent specific facts."
      : "Use the extracted source candidates below as the factual basis. Each candidate may include title, url, fetchedUrl, excerpt, contentLength, and relevance.",
    JSON.stringify(compactSearchResultsForPrompt(searchResults, {
      maxResults: 8,
      excerptChars: 700
    }), null, 2),
    researchTitleResult ? "Compact Research/Title factual handoff (Writer Contract is intentionally not duplicated here):" : "",
    researchTitleResult ? JSON.stringify(compactResearchHandoffForPrompt(researchTitleResult), null, 2) : "",
    "",
    "Source quality summary:",
    JSON.stringify(sourceQuality || { status: "unknown" }, null, 2),
    safeGeneralTopicFallback
      ? "- SAFE GENERAL TOPIC FALLBACK SOURCE RULE: Source quality may be insufficient for an authority-grade current-policy article. Continue only as a source-bounded general explainer. Do not present blog/discovery candidates as official authority and do not state current legal effect or implementation status."
      : "- If Source quality status is \"insufficient\", immediately write the failed JSON described below and stop. Do not write an explanatory article.",
    "- If Source quality status is \"skipped\", continue only when the Research/Title Agent marked searchNeed as \"skip\" and the topic is not fact-risky or current/date-bound.",
    safeGeneralTopicFallback
      ? "- In safe general-topic fallback mode, topicMatchedCandidates may be zero when the strict classifier could not map a broad topic phrase. Use the excerpts only when their meaning clearly relates to the topic; do not introduce unrelated facts."
      : "- If sourceQuality.topicMatchedCandidates is 0 for a manual Topic, treat it as insufficient support unless the excerpts clearly use synonyms for the same subject/event.",
    safeGeneralTopicFallback
      ? "- In safe general-topic fallback mode, the excerpts must still answer the broad topic with concrete concepts, relationships, or examples. A completely unrelated or empty excerpt set remains a failure."
      : "- Even when Source quality status is \"usable\", you must still fail if the excerpts cannot answer the locked Topic thesis. Broad related information is not enough.",
    safeGeneralTopicFallback
      ? "- In safe general-topic fallback mode, independent or official evidence is not required for general context, but do not write specific launch, release, legal-effect, enforcement, current-policy, or company-result claims from Naver blog candidates alone."
      : "- If Source quality says independentEvidenceRequired is true, do not write from Naver blog candidates alone. The article needs at least one official/institutional source or independent editorial source candidate supporting the core launch/release/announcement fact.",
    safeGeneralTopicFallback
      ? "- Failure is still required when the excerpts are empty, contradictory, or unrelated. Do not fail only because the topic is broad or authority-grade current evidence is unavailable."
      : "- Failure is a normal valid output. If you cannot support the post from extracted excerpts, you must set status to \"failed\". Do not try to be helpful by writing a caveat-filled article.",
    "",
    "Required output:",
    "- Write a JSON file at the exact Output JSON path.",
    "- The JSON file must be UTF-8 and Korean text must not be mojibake or escaped into a broken encoding.",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"title\": string, \"article\": string, \"tags\": string[], \"bodyImages\": [{\"sequence\": number, \"sectionHeading\": string, \"path\": string, \"prompt\": string}], \"titleImagePath\": string, \"titleImagePrompt\": string, \"titleImageText\": string[], \"notes\": string[] }.",
    "- If the extracted excerpts are missing, too thin, unrelated to the locked Topic thesis, or cannot support a publishable post, do not write an explanatory article.",
    "- In that failure case, set status to \"failed\", set failureReason to a concise Korean reason, set title and article to empty strings, set bodyImages to [], set titleImagePath to \"\", and put the reason in notes.",
    "- In a failure case, do not generate images and do not write article sections explaining why writing is difficult.",
    "- Only set status to \"success\" when the remaining extracted excerpts support a real article.",
    "- If status is \"failed\", the desktop app will record failure history and stop the cycle. That is the correct behavior.",
    "- Article must be Korean, Naver Blog SEO oriented, 1500-2000 Korean characters when possible.",
    researchTitleResult ? "- The article must fulfill the Writer Contract: articleMission, selectedTitle, topicThesis, readerPromise, firstSectionFocus, mustAnswer, mustCover, mustNotDo, and current bridge fields when required." : "",
    researchTitleResult ? "- The article must also fulfill the Writer Contract readerValueChecklist. If it cannot, return status \"failed\"." : "",
    safeGeneralTopicFallback
      ? "- SAFE GENERAL TOPIC FALLBACK HARD RULE: Any named bill, statute section, vote/committee result, exact date, agency action, legal effect, company announcement, or current-status detail not explicitly present in the Research/Title handoff or extracted excerpts must be removed or rewritten as a clearly bounded general concept. Never fill the gap from prior knowledge."
      : "",
    safeGeneralTopicFallback
      ? "- In safe general-topic fallback mode, do not preserve unsupported specifics as examples, parenthetical background, or confident conclusions. Keep the article useful through source-bounded concepts, relationships, and practical reader criteria, without research-process narration."
      : "",
    researchSearchNeed === "skip"
      ? "- Because search was skipped by Research/Title Agent, write from stable general explanation and the handoff only. Do not invent current facts, dates, amounts, conditions, official claims, or personal experience."
      : safeGeneralTopicFallback
        ? "- In safe general-topic fallback mode, summarize and reorganize the extracted candidate excerpts into a clearly bounded general explainer. Do not fill missing specifics from prior knowledge."
        : "- Do not write a fresh generic article from prior knowledge. Summarize and reorganize the extracted candidate excerpts.",
    "- Build the title from the locked Topic thesis and directly supporting excerpts, not from Category, Optional keyword, or a broad common theme.",
    "- The article must synthesize overlapping facts, dates, names, programs, events, products, releases, causes, effects, reactions, and implications found in excerpts that support the locked Topic thesis.",
    "- Do not copy source sentences verbatim. Rewrite in original Korean while preserving factual meaning.",
    "- If the excerpts are too thin or unrelated to the locked Topic thesis, fail with status \"failed\". Do not put source problems inside the article body.",
    "- Write like an excellent Korean Naver blogger/editor, not like an internal research report. The article body must not use meta words such as candidate, excerpt, provided material, search result, source quality, notes, or report.",
    "- Default human Naver Blog voice: sound like a real person organizing the issue for a reader. Use a warm but not chatty lead, mix sentence lengths, include reader-facing transitions such as what this means, why readers search for it, what to check before acting, and avoid stiff summary-report cadence.",
    "- Unless Preferred tone explicitly asks otherwise, the opening should start from the reader's situation or curiosity before moving into facts. Do not fake personal experience, visits, purchases, or emotions that were not provided.",
    "- Mandatory meta-cleanup: if the opening or conclusion mentions 자료 확인, 확인 가능한 자료, 검증, 검증 한계, 확인되는 것은, 기준점으로 삼는 이유, 출처를 확인했다, or what could not be verified, rewrite those paragraphs completely. The opening must state the selected subject, the concrete event/action, and its reader-facing meaning. The conclusion must state the practical implication or judgment criterion for the reader. Keep at most one short evidence caveat inside the relevant body section, never as the article's lead or closing.",
    "- Convert process language into subject language: replace phrases like '확인 가능한 자료에서 X' with 'X가 공개됐다/제시됐다', and replace '확인되는 것은 X, 확인할 것은 Y' with the subject's meaning followed by a concise practical next step. Do not merely append a reader sentence; remove the meta sentence itself.",
    "- The article body must never narrate the agent's research process, source collection process, or verification workflow.",
    "- The article body must speak directly to the reader about the selected subject, not about the article's own coverage choices, writing limits, or internal validation decisions.",
    "- Category publishing direction is internal guidance. Do not copy it into the article body, do not justify the category, and do not open with a defensive contrast such as 'this is not a general guide/advice'.",
    "- The first section must answer the title from the reader's point of view: what the topic is, who should care, why it matters, and what the reader should understand or check next.",
    "- When the topic uses an older anchorEvent as a current issue, the first section must bridge it to the currentPeg: current status, recent procedure, new ruling/order, settlement/dismissal, policy change, official position shift, or another source-backed reason it matters now.",
    "- Source attribution is allowed only as reader-facing verification guidance. Do not make source verification itself the main content.",
    "- For policy, support program, recruitment, education, training, money, price, schedule, deadline, or application topics, include practical reader sections for target/eligibility, support details, application or checking path, variable items to verify, and cautions. If the handoff cannot support those sections, fail instead of writing a shallow article.",
    "- Do not make uncertainty the article's main structure. For reader-risk topics, use one concise caution where needed, then focus on supported facts, usable paths, criteria, and reader decisions. If those are not available, fail.",
    "- The reader should feel the post is explaining the Topic itself: what happened, why it matters, what is confirmed, what is uncertain, who is affected, and what to watch next.",
    "- For issue/news topics, keep the controlling event visible from title through every section. Background context is allowed only when it explains that event.",
    "- Do not repeat the generated title as a plain article line. The app will place the title as a Naver quote block at the top of the post.",
    "- Do not mention the current writing date in the title. In the article body, mention it only when it is needed as a factual 확인 기준일 for current/date-bound status such as 접수중, 모집중, 신청 가능, 현재 운영, prices, schedules, deadlines, policy/support conditions, or official announcements.",
    "- Structure the article into readable sections when the topic naturally has steps, criteria, examples, pros/cons, or enumerated points.",
    "- For each section heading, put a standalone marker line in article exactly like [SECTION - 소제목].",
    "- Every section marker must start with \"[SECTION - \" and end with \"]\" on the same standalone line. Never omit the closing bracket.",
    "- If you would write 첫째/둘째/첫 번째/두 번째 as an item label, convert that item label into a [SECTION - ...] marker instead of keeping it inside a paragraph.",
    "- Section marker text must be concise, natural Korean, reader-facing, and suitable as a Naver Blog section heading. Avoid headings that describe research/source process instead of reader value.",
    bodyImageLimit > 0 ? `- Body images are section-centric. Keep the article at no more than ${bodyImageLimit} sections and create exactly one body image handoff for every [SECTION - ...] section.` : "",
    "- For events, job fairs, exhibitions, contests, applications, recruitment notices, sales, deadlines, or any date-bound information: exclude anything whose event date, application period, deadline, or relevant operating period is already past relative to the Current writing date.",
    "- If a date-bound candidate has no confirmable current or future date from an official/reliable source, do not present it as an upcoming/current opportunity. You may mention it only as a general example without implying availability.",
    "- Prefer official/current pages for date-bound information and record in notes that outdated or unconfirmed date-bound candidates were excluded when applicable.",
    bodyImageLimit > 0
      ? "- Immediately after every [SECTION - 소제목] marker, insert exactly one matching [IMAGE INSERT - n] marker. Number them consecutively from 1 in section order."
      : "- Do not insert any [IMAGE INSERT - n] markers in the article body.",
    bodyImageLimit > 0
      ? `- Prepare exactly one bodyImages item for every section, up to ${bodyImageLimit}. sequence must match section order, sectionHeading must exactly match the [SECTION - ...] heading, prompt must compress the whole section, and path must stay empty.`
      : "- Do not generate body images. Set bodyImages to an empty array.",
    includeTitleImage
      ? "- Prepare one title image prompt in titleImagePrompt, extract 2-5 concise visible Korean strings into titleImageText, and keep titleImagePath empty. Do not generate an actual title image file."
      : "- Do not prepare a title image. Set titleImagePath and titleImagePrompt to empty strings and titleImageText to an empty array.",
    usesImages
      ? "- Actual image generation is handled later by Image Worker. Writer Agent must only provide grounded prompts and marker positions."
      : "- Since no images were requested, do not perform an image prompt or image-generation stage and do not write image-generation notes.",
    usesImages ? "- Image prompts must be concrete and content-grounded, not abstract decorative art. Avoid vague prompts like network glow, futuristic background, abstract data waves, generic robot, or unrelated stock-style visuals." : "",
    usesImages && accountImageStylePrompt ? "- Account-specific image style prompt: apply this style when drafting titleImagePrompt and bodyImages[].prompt, while keeping the article facts and each section context primary." : "",
    usesImages && accountImageStylePrompt ? accountImageStylePrompt : "",
    usesImages && accountImageStylePrompt ? "- If the account style conflicts with title text policy, body no-text policy, or verified facts, follow the app policy and facts first." : "",
    includeTitleImage ? "- The title image must be one information-rich Korean editorial summary card that compresses the whole completed article across all sections, not a generic representative scene or decorative illustration." : "",
    includeTitleImage ? "- Automatically derive titleImageText from the completed article without waiting for user-specified wording: include one concise Korean headline plus 1-4 of the most useful verified numbers, periods, benefits, conditions, comparisons, or checklist cues." : "",
    includeTitleImage ? "- Every titleImageText string must appear verbatim inside titleImagePrompt with an explicit instruction to render it visibly, large, readable, and accurate in the image. Do not invent facts." : "",
    bodyImageLimit > 0 ? "- Every body image must compress its entire corresponding section, not merely decorate or loosely support it. Use the section's concrete subject plus its key relationship, process, comparison, timeline, decision cue, or factual structure." : "",
    usesImages ? "- When writing image prompts, include the article title or section heading context, 2-4 concrete visual elements from the extracted facts, and a clear Korean blog editorial style. Do not invent facts that are not in the article." : "",
    bodyImageLimit > 0 ? "- Body images remain visual summaries rather than title cards: avoid readable Korean paragraphs, long labels, UI copy, and text-heavy charts. Prefer concrete visual composition, objects, scenes, icons, timelines, comparisons, and process cues grounded in that section." : "",
    usesImages ? "- Do not return an image directory path as an image path. Each path must include the concrete image filename such as .png, .jpg, .jpeg, or .webp." : "",
    usesImages ? "- Do not call image generation tools. Do not spend time trying PowerShell, shell copy, or Node copy workarounds for images." : "",
    "- For automatic/current-information topics, avoid generic how-to guide titles such as '~찾는 법', '~확인법', '~가이드' unless the user explicitly asked for a how-to guide.",
    "- Choose a concrete current angle that fits the category and keyword. Examples: for news categories, cover a specific recent issue or trend; for job categories, cover currently valid openings/programs/events; for tech categories, cover a specific product, model, policy, release, or market change.",
    "- Do not force every category into opportunities, programs, or events. Let the category and source candidates decide the article angle.",
    "- Do not write filler, do not exaggerate claims, and do not create an advertisement.",
    "- Tags must not include more than 29 values.",
    "",
    "After writing the JSON file, print one final line: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildResearchTitlePrompt({
  topic,
  keyword,
  category,
  searchResults,
  historyTitles,
  jobDir,
  currentDateLabel,
  sourceQuality = null,
  topicMode = "manual",
  excludedTopics = "",
  publishPurpose = "",
  preferredTone = "",
  researchGuidance = "",
  freshnessLevel = "auto",
  keywordLanes = [],
  recommendedKeywordLanes = [],
  researchRevisionContext = "",
  recoveryGuidance = [],
  sourceMode = "research",
  sourceDocuments = [],
  sourceConflicts = []
}) {
  const resultPath = path.join(jobDir, "research-title-result.json");
  const hasSearchCandidates = Array.isArray(searchResults) && searchResults.length > 0;
  const laneList = Array.isArray(keywordLanes) ? keywordLanes : [];
  const recommendedLaneList = Array.isArray(recommendedKeywordLanes) ? recommendedKeywordLanes : [];
  const sourceFocusText = [topic, keyword, category, publishPurpose, excludedTopics].filter(Boolean).join(" ");
  return [
    "You are the Research/Title Agent for a Korean Naver Blog automation app.",
    "Do not write the article body. Do not generate images.",
    `Category: ${category}`,
    `Category keyword: ${keyword || "(none)"}`,
    `User direct topic: ${topic || "(none)"}`,
    `Content source mode: ${sourceMode}`,
    `Topic mode: ${topicMode}`,
    `Current writing date: ${currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    `Excluded topics: ${excludedTopics || "(agent decides)"}`,
    `Publish purpose: ${publishPurpose || "(agent decides)"}`,
    `Preferred tone: ${preferredTone || "(agent decides)"}`,
    researchGuidance ? `Scheduled research guidance:\n${researchGuidance}` : "",
    "- Tone priority: if Preferred tone is provided, it is the highest style signal for finalTitle and writerContract.tone. Default hook and human-blog guidance apply only when they do not conflict with Preferred tone.",
    `Freshness level: ${freshnessLevel || "auto"}`,
    sourceMode === "file_upload" ? compactSourceDocumentsForPrompt(sourceDocuments, sourceConflicts, 70000, sourceFocusText) : "",
    sourceMode === "file_upload" ? "- File mode rule: do not search the web. Build the title and writer contract only from the uploaded documents. Preserve exact values and expose unresolved conflicts in uncertainItems." : "",
    sourceMode === "file_upload" ? "- When a PDF and MD are paired, treat the PDF as the primary original source and the MD as an auxiliary summary. If they disagree, use the PDF value and mark MD-only additions as [추가 설명] or [원본 확인 필요]." : "",
    "",
    "Keyword lanes:",
    JSON.stringify(laneList, null, 2),
    "Recommended keyword lane order from HISTORY:",
    JSON.stringify(recommendedLaneList, null, 2),
    "- In auto topic mode, treat Category keyword as a lane pool, not as one search query.",
    "- Select one narrow topicLane first, preferably from the recommended order, then derive the title and searchQueries inside that lane.",
    "- In auto topic mode, the selected topicLane is only a discovery lane. It is not itself the article subject or final title.",
    "- After search candidates are provided, PASS only when finalTitle is anchored to a concrete source-backed subject, event/action, tension, consequence, or reader decision point found inside that lane.",
    "- Do not PASS a lane-level or category-level title that could fit many unrelated items, such as a generic question about whether the lane matters. If no concrete anchor is available, return REVISION with sharper discovery searchQueries or BLOCK.",
    "- When returning REVISION because the concrete anchor is missing, make searchQueries/coreQuestions/uncertainItems describe the missing facts and discovery intent, not just the lane name.",
    "- Do not repeatedly choose the original first keyword just because it appears first. HISTORY order is provided to reduce repetition.",
    "- Do not combine all keyword lanes into one search query.",
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: research",
    "- BLOGAUTO_PROGRESS: title",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Core rules:",
    hasSearchCandidates
      ? "- Search/source candidates are provided because the Research/Title Agent or the app determined they are needed. Analyze them as signals and facts, not as copy material."
      : "- No NAVER/GOOGLE search candidates have been collected yet. First judge whether search is needed from the input itself; do not assume search was already performed.",
    hasSearchCandidates
      ? ""
      : "- When search candidates are absent, do not perform web searches, browser actions, network fetches, or shell/file reads for research. Decide searchNeed from the user's category/topic/keyword only, then write the output JSON. Use shell only if it is needed to write the JSON result file.",
    "- If a user direct topic exists and topicMode is manual, preserve that topic. Search results can refine expression and verify facts, but must not replace the user's topic.",
    "- If no direct topic exists or topicMode is auto, derive one narrow candidate topic from a single Keyword lane. If current facts are required, return searchNeed light/normal/strict and wait for app-provided search candidates instead of verifying facts yourself.",
    "- If topicMode is auto and search candidates are present, use the candidates to select a concrete anchor before finalTitle. Do not summarize the common denominator of several keyword lanes.",
    "- Treat Current writing date as an internal freshness reference, not as title material. Put a year/month in finalTitle only when that date is part of the confirmed event, policy, product, deadline, edition, or source-backed fact itself.",
    "- Current bridge rule: when a selected topic is anchored in an older event but framed as a current issue, separate anchorEvent from currentPeg. anchorEvent is the original event/date; currentPeg is the source-backed current reason to write now, such as recent progress, ruling, order, discovery, settlement, dismissal, official statement, policy change, deadline, application status, product change, price/schedule update, or similar current development.",
    "- For strict/current topics, if anchorEvent exists and currentPeg cannot be confirmed from usable sources, do not return PASS. Return REVISION/BLOCK and make searchQueries seek the currentPeg rather than repeating only the old event.",
    "- If currentBridgeRequired is true, currentBridgeSatisfied may be true only when currentPeg has a date/summary and at least one usable source boundary or usable source supports it.",
    "- Determine search need as one of: skip, light, normal, strict. Map freshness level low/medium/high to lighter or stricter research, but official/current facts still require strict handling.",
    "- Use searchNeed \"skip\" only for stable concept/explanation/opinion/experience-style topics that can be written safely without current facts.",
    "- Use searchNeed \"light\", \"normal\", or \"strict\" when current search flow, NAVER exposure, Google/official fact checks, or official/current sources are needed.",
    "- If search candidates are absent and searchNeed is light/normal/strict, return status \"REVISION\" quickly unless the topic must be blocked immediately. In that case, describe what search or official facts are needed in writerBrief, coreQuestions, and notes.",
    "- If search candidates are absent and searchNeed is skip, you may return PASS/REVISION with a safe title and writer brief.",
    "- Separate confirmed facts from interpretation.",
    "- For policy, support programs, law, tax, recruitment, prices, schedules, application conditions, official announcements, or reader-risk topics, require official or reliable sources.",
    "- If Source quality summary says authorityEvidenceRequired is true and authorityEvidenceCandidates is 0, do not treat trusted blog candidates as final authority. Use them only as discovery clues.",
    "- In that case, extract agency names, program names, application channels, notice titles, dates, and PDF/notice hints from the blog candidates. If the blog includes an official link, use that source boundary; if not, return REVISION with narrow searchQueries aimed at the official/institutional website so the app can crawl it directly.",
    "- If Source quality summary says independentEvidenceRequired is true and independentEvidenceCandidates is 0, do not return PASS from blog candidates alone. Return REVISION with broad web searchQueries aimed at official pages or independent editorial coverage; do not downgrade into a vague commentary article.",
    "- For AI/technology launch, release, announcement, model, product, chip, roadmap, market, or earnings topics, Naver blog candidates are discovery clues unless official/institutional or independent editorial candidates also support the core fact.",
    "- Return BLOCK when facts are insufficient, sources conflict, the direct topic cannot be preserved, or a publishable title cannot be supported.",
    "- Do not copy source titles. Extract search flow, reader interest, repeated angles, and gaps.",
    "- Include writerContract as the compact Writer handoff. It must define the reader-facing article mission, selected title, topic thesis, reader promise, first section focus, required answers, reader coverage items, confirmed facts, safety boundaries, source boundaries, current bridge requirements, and must-not-do items.",
    "- In writerContract, keep article fields for reader value only. Put limitations, unsupported variables, source gaps, and publishing constraints into safetyBoundaries, uncertainItems, sourceBoundaries, or mustNotDo instead of turning them into coverage or section structure.",
    "- writerContract must not narrate the search process, source collection process, or verification workflow. Put process detail in searchFlowSummary or notes, not in the Writer handoff.",
    "",
    researchRevisionContext ? "Revision context from previous agent step:" : "",
    researchRevisionContext || "",
    researchRevisionContext ? "- Use this context to repair the Writer Contract and source boundaries. Do not merely repeat the previous PASS if the Writer could not support the article." : "",
    formatRecoveryGuidance(recoveryGuidance) ? "Previously successful recovery guidance (advisory only; never override evidence or safety rules):" : "",
    formatRecoveryGuidance(recoveryGuidance),
    formatRecoveryGuidance(recoveryGuidance) ? "- Treat these as hints learned from an earlier confirmed recovery. If they do not fit the current evidence, ignore them and return the appropriate review state." : "",
    researchRevisionContext ? "" : "",
    `Search candidates already collected: ${hasSearchCandidates ? "yes" : "no"}`,
    "Search/source candidates:",
    JSON.stringify(compactSearchResultsForPrompt(searchResults, {
      maxResults: 6,
      excerptChars: 420
    }), null, 2),
    "",
    "Source quality summary:",
    JSON.stringify(sourceQuality || { status: "unknown" }, null, 2),
    "",
    "Existing titles for duplicate awareness:",
    JSON.stringify((historyTitles || []).slice(0, 40).map((title) => String(title || "").trim().slice(0, 140)), null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"PASS\" | \"REVISION\" | \"BLOCK\", \"failureReason\": string, \"finalTitle\": string, \"topicThesis\": string, \"topicLane\": string, \"selectedKeywordIndexes\": number[], \"selectedKeywordPhrases\": string[], \"searchQueries\": string[], \"anchorEvent\": {\"name\": string, \"date\": string, \"summary\": string}, \"currentPeg\": {\"date\": string, \"summary\": string, \"sourceIds\": string[]}, \"currentBridgeRequired\": boolean, \"currentBridgeSatisfied\": boolean, \"directTopicPreserved\": boolean, \"factBased\": boolean, \"searchNeed\": \"skip\" | \"light\" | \"normal\" | \"strict\", \"searchFlowSummary\": string, \"coreQuestions\": string[], \"mustCover\": string[], \"avoidDirections\": string[], \"confirmedFacts\": string[], \"uncertainItems\": string[], \"usableSources\": [{\"sourceId\": string, \"title\": string, \"url\": string, \"reason\": string}], \"writerBrief\": string, \"writerContract\": { \"articleMission\": string, \"selectedTitle\": string, \"topicThesis\": string, \"targetReader\": string, \"readerPromise\": string, \"firstSectionFocus\": string, \"mustAnswer\": string[], \"mustCover\": string[], \"mustNotDo\": string[], \"confirmedFacts\": string[], \"uncertainItems\": string[], \"sourceBoundaries\": string[], \"safetyBoundaries\": string[], \"recommendedStructure\": string[], \"currentBridgeRequired\": boolean, \"currentBridgeSatisfied\": boolean, \"anchorEvent\": object, \"currentPeg\": object, \"tone\": string }, \"notes\": string[] }.",
    "- topicLane, selectedKeywordIndexes, selectedKeywordPhrases, and searchQueries are required in auto topic mode. searchQueries must be narrow and must not contain the full Category keyword pool.",
    "- Keep output compact: at most 4 searchQueries, 8 coreQuestions/mustCover/avoidDirections items each, 12 confirmedFacts/uncertainItems items each, 10 usableSources, and only actionable notes.",
    "- For REVISION, searchQueries must carry the next-step research intent from the missing facts. Do not leave the app with only a broad category or keyword-lane phrase.",
    "- anchorEvent/currentPeg/currentBridgeRequired/currentBridgeSatisfied are required. Use empty strings/arrays only when no older anchorEvent exists and explain that in notes.",
    "- If status is BLOCK, keep finalTitle empty unless a safe non-publishable working title is useful, and explain failureReason concisely in Korean.",
    "- If status is PASS or REVISION, finalTitle must be a Korean Naver Blog title that is click-worthy without exaggeration.",
    "- Naver-home title judgment: act like an editor choosing one homepage card, not a template filler. The title should combine a concrete subject, a confirmed event/action/tension, and the reader curiosity created by this specific topic.",
    "- In auto topic mode, reject your own title if replacing the concrete subject/event with another item from the same keyword lane would leave the title essentially unchanged.",
    "- Consider at least three title angles internally before choosing finalTitle: event-first, reader-question-first, and consequence-first. Output only the chosen title to avoid unused verbose data.",
    "- A good title should fail if the named entity/event can be swapped out and the title still works for many unrelated posts. Rewrite until the title depends on the actual subject, source-backed facts, and reader promise.",
    "- Do not append a generic freshness or preparation suffix just to make the title look timely. Avoid vague guide-title cadence, keyword stuffing, and unsupported sensational words.",
    "- If Preferred tone conflicts with the default Naver-home judgment, Preferred tone wins.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildResearchTitleRetryPrompt(options, previousResearchResult) {
  const resultPath = path.join(options.jobDir, "research-title-result.json");
  const hasSearchCandidates = Array.isArray(options.searchResults) && options.searchResults.length > 0;
  const repairPrompt = String(options.repairPrompt || options.resumePrompt || "").trim();
  const recoveryContext = formatRecoveryGuidance(options.recoveryGuidance);
  return [
    "You are the Research/Title Agent revising an existing Korean Naver Blog research decision.",
    "Do not write the article body or generate images. Re-evaluate only what changed after the previous decision.",
    `Category: ${options.category}`,
    `Category keyword: ${options.keyword || "(none)"}`,
    `User direct topic: ${options.topic || "(none)"}`,
    `Topic mode: ${options.topicMode || "manual"}`,
    `Current writing date: ${options.currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    `Preferred tone: ${options.preferredTone || "(agent decides)"}`,
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: research",
    "- BLOGAUTO_PROGRESS: title",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Previous compact decision:",
    JSON.stringify(compactResearchHandoffForPrompt(previousResearchResult, { includeWriterContract: true }), null, 2),
    "",
    options.researchRevisionContext ? "Additional revision context:" : "",
    options.researchRevisionContext || "",
    recoveryContext ? "Previously successful recovery guidance (advisory only; never override evidence or safety rules):" : "",
    recoveryContext,
    repairPrompt ? "User-provided repair instruction (apply it only when it is consistent with the available evidence):" : "",
    repairPrompt,
    "New/merged search candidates:",
    JSON.stringify(compactSearchResultsForPrompt(options.searchResults, { maxResults: 6, excerptChars: 420 }), null, 2),
    "Source quality summary:",
    JSON.stringify(options.sourceQuality || { status: "unknown" }, null, 2),
    "",
    "Revision rules:",
    `- Search candidates are ${hasSearchCandidates ? "available" : "not available"}. Do not use browser, network, or unrelated file reads; use only this handoff.`,
    "- Preserve a manual user topic. In auto mode keep one narrow keyword lane and choose a concrete source-backed subject/event, not a category-level generic title.",
    "- Reassess status, finalTitle, facts, source boundaries, current bridge, and writerContract from the new evidence. Do not repeat unsupported fields from the previous decision.",
    "- Official/current/reader-risk claims require suitable evidence. Blog candidates alone are discovery clues when authority or independent evidence is required.",
    "- If an older anchorEvent is presented as current, PASS only with a dated, source-backed currentPeg and currentBridgeSatisfied=true.",
    "- Return REVISION with narrow next searchQueries when a fixable evidence gap remains; return BLOCK when the title promise cannot be supported.",
    "- finalTitle must remain Korean, specific, non-clickbait, and answerable by the evidence. Compare three materially different title angles internally before choosing it.",
    "- writerContract must be a compact reader-facing brief. Put gaps and limits in uncertainItems/sourceBoundaries/safetyBoundaries/mustNotDo, not in article coverage.",
    "",
    "Required output:",
    "- Overwrite the exact Output JSON path with UTF-8 JSON.",
    "- JSON shape: { \"status\": \"PASS\" | \"REVISION\" | \"BLOCK\", \"failureReason\": string, \"finalTitle\": string, \"topicThesis\": string, \"topicLane\": string, \"selectedKeywordIndexes\": number[], \"selectedKeywordPhrases\": string[], \"searchQueries\": string[], \"anchorEvent\": {\"name\": string, \"date\": string, \"summary\": string}, \"currentPeg\": {\"date\": string, \"summary\": string, \"sourceIds\": string[]}, \"currentBridgeRequired\": boolean, \"currentBridgeSatisfied\": boolean, \"directTopicPreserved\": boolean, \"factBased\": boolean, \"searchNeed\": \"skip\" | \"light\" | \"normal\" | \"strict\", \"searchFlowSummary\": string, \"coreQuestions\": string[], \"mustCover\": string[], \"avoidDirections\": string[], \"confirmedFacts\": string[], \"uncertainItems\": string[], \"usableSources\": [{\"sourceId\": string, \"title\": string, \"url\": string, \"reason\": string}], \"writerBrief\": string, \"writerContract\": object, \"notes\": string[] }.",
    "- Keep output compact: at most 4 searchQueries, 8 coreQuestions/mustCover/avoidDirections items each, 12 confirmedFacts/uncertainItems items each, 10 usableSources, and only actionable notes.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildWriterRetryPrompt(options, previousWriterResult) {
  const resultPath = path.join(options.jobDir, "agent-result.json");
  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  const writerContract = buildWriterContract(options.researchTitleResult, options);
  const recoveryContext = formatRecoveryGuidance(options.recoveryGuidance);
  return [
    "You are the Writer Agent revising an existing Korean Naver Blog article.",
    "Correct only the requested problems while preserving supported content, the selected title, and factual boundaries.",
    `Selected title: ${options.researchTitleResult?.finalTitle || options.topic || ""}`,
    `Current writing date: ${options.currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    `Preferred tone: ${options.preferredTone || "(agent decides)"}`,
    `Output JSON path: ${resultPath}`,
    `Revision attempt: ${options.writerAttempt || 2}/${options.maxWriterAttempts || 2}`,
    `Revision instructions: ${options.writerRevisionFeedback || "Correct the invalid Writer result."}`,
    recoveryContext ? "Previously successful recovery guidance (advisory only; use only when compatible with the current handoff):" : "",
    recoveryContext,
    "",
    "Writer Contract (highest priority):",
    JSON.stringify(writerContract, null, 2),
    "Compact factual handoff (Writer Contract intentionally omitted):",
    JSON.stringify(compactResearchHandoffForPrompt(options.researchTitleResult), null, 2),
    "Previous Writer result to revise:",
    JSON.stringify(compactWriterResultForPrompt(previousWriterResult), null, 2),
    "",
    "Revision requirements:",
    "- Keep the exact selected title and rewrite the complete JSON result at the same path. Do not explain the retry in the article.",
    "- Use only confirmed facts and source boundaries in the handoff. Do not invent dates, amounts, conditions, official claims, experience, or current status.",
    options.researchTitleResult?.safeGeneralTopicFallback === true
      ? "- SAFE GENERAL TOPIC FALLBACK HARD RULE: Treat every detail absent from the Research/Title handoff or extracted source excerpts as unusable. Remove unsupported bill numbers, statute sections, committee/vote counts, exact dates, agency actions, legal effects, company announcements, and current-status claims; never supply them from memory. Replace them only with a source-bounded general explanation when the excerpts support that broader point."
      : "",
    options.researchTitleResult?.safeGeneralTopicFallback === true
      ? "- In safe general-topic fallback mode, do not mention examples such as H.R. numbers, named statutes, vote totals, committee dates, or regulatory provisions unless that exact detail appears in the supplied handoff/source excerpts. An unsupported example is still an unsupported factual claim even if phrased as background."
      : "",
    "- The article must be Korean, reader-facing, naturally structured, normally 1500-2000 Korean characters, and must directly fulfill every Writer Contract promise.",
    "- Do not narrate research, prompts, candidates, agents, reports, JSON, source quality, or internal limitations in the article.",
    "- Mandatory meta-cleanup on every retry: rewrite the complete first paragraph and complete final paragraph when the review mentions research/verification meta language. The first paragraph must begin with the selected subject and what happened; the final paragraph must end with what the subject means for the reader or how to judge its practical relevance. Do not use '확인 가능한 자료', '확인되는 것은', '검증되지 않았', '자료 확인', '검증 한계', '기준점', or '이 발표만으로 확인할 수 없다' in those paragraphs.",
    "- A caveat about an unverified license, performance claim, adoption result, or market effect belongs in the specific section where that claim is discussed. Do not make the opening or conclusion a source audit or a list of limitations.",
    "- Preserve [SECTION - heading] markers. Do not repeat the generated title as a plain article line.",
    options.includeTitleImage !== false
      ? "- Return 2-5 Korean titleImageText strings derived from the whole article and a titleImagePrompt that explicitly renders every string as one readable whole-article information card."
      : "- Title image generation is disabled; leave titleImage fields empty.",
    bodyImageLimit > 0
      ? `- For every article section, up to ${bodyImageLimit}, place exactly one sequential [IMAGE INSERT - n] immediately after its SECTION marker and return one matching bodyImages item whose prompt compresses the entire section.`
      : "- Body image generation is disabled; return bodyImages as an empty array.",
    "- If the revision cannot satisfy the contract from supplied evidence, return status failed instead of padding or inventing.",
    "",
    "Required output:",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"title\": string, \"article\": string, \"tags\": string[], \"bodyImages\": [{\"sequence\": number, \"sectionHeading\": string, \"path\": string, \"prompt\": string}], \"titleImagePath\": string, \"titleImagePrompt\": string, \"titleImageText\": string[], \"notes\": string[] }.",
    "- Do not generate images in this step. Leave image paths empty.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildMainReviewPrompt({
  topic,
  keyword,
  category,
  topicMode = "manual",
  sourceMode = "research",
  jobDir,
  currentDateLabel,
  researchTitleResult,
  writerResult,
  finalTitle,
  preferredTone = "",
  resumeRepairPrompt = "",
  recoveryGuidance = []
}) {
  const resultPath = path.join(jobDir, "main-review-result.json");
  const writerContract = buildWriterContract(researchTitleResult, {
    topic,
    keyword,
    category,
    topicMode,
    currentDateLabel,
    finalTitle,
    preferredTone
  });
  const safeGeneralTopicFallback = researchTitleResult?.safeGeneralTopicFallback === true;
  const recoveryContext = formatRecoveryGuidance(recoveryGuidance);
  return [
    "You are the Main Agent for a Korean Naver Blog automation app.",
    "This is the final review step. Do not act as a separate Review Agent.",
    "Do not rewrite the article. Judge whether it can proceed to preview/publish.",
    `Category: ${category}`,
    `Category keyword: ${keyword || "(none)"}`,
    `User direct topic: ${topic || "(none)"}`,
    `Topic mode: ${topicMode}`,
    `Source mode: ${sourceMode}`,
    `Current writing date: ${currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    `Research/Title final title: ${finalTitle}`,
    `Preferred tone: ${preferredTone || "(agent decides)"}`,
    resumeRepairPrompt ? `사용자 오류 해결 지시(검수에 반영): ${resumeRepairPrompt}` : "",
    recoveryContext ? "이전에 성공한 복구 해결책(참고 지시; 현재 근거·검수 규칙을 절대 무시하지 않음):" : "",
    recoveryContext,
    `Output JSON path: ${resultPath}`,
    "",
    "Writer contract used for review:",
    JSON.stringify(writerContract, null, 2),
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: main_review",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Main Agent final review scope:",
    "- You are responsible for the entire final publishability judgment, not only title/article matching.",
    "- Review the Research/Title Agent result, Writer Agent result, selected title, article body, tags, image directions/notes, facts, uncertainty, source use, and risk expressions together.",
    "- Do not trust Writer status by itself. Independently judge whether the output followed the harness principles.",
    "- Use the Writer Contract as the shared writing/review contract. Check articleMission, selectedTitle, topicThesis, readerPromise, firstSectionFocus, mustAnswer, mustCover, and mustNotDo.",
    "- Also check readerValueChecklist. A post that is safe but vague, caveat-heavy, or mostly tells readers to verify elsewhere is not publishable if it fails to answer the title promise.",
    "- Also check currentBridgeRequired, currentBridgeSatisfied, anchorEvent, and currentPeg from the Writer Contract. A current-issue article based only on an older anchorEvent must not pass.",
    "- Return REVISION if the body follows search/source/research-process flow instead of fulfilling the Writer Contract, even when the facts are technically true.",
    ...(sourceMode === "file_upload" ? [
      "- FILE-UPLOAD SOURCE-BOUNDARY RULE: The uploaded file is the complete evidence boundary. Do not require a comparison, decision criterion, legal meaning, insurance interpretation, or technical detail that is not present in the uploaded material.",
      "- In file-upload mode, if a requested detail cannot be established from the uploaded material, it is acceptable to state [원본에서 확인 불가] or [추가 자료 필요] and continue. Do not return REVISION solely because that unsupported detail was not expanded.",
      "- For file-upload mode, PASS when all supported facts are covered accurately, unsupported details are clearly bounded, and the article remains useful without inventing facts. A source limitation is not by itself a publishability failure.",
    ] : []),
    "- When returning REVISION, collect every independent fixable issue found in the article into revisionInstructions and issues in the same response. Do not reveal only the first issue if the opening, conclusion, current bridge, title promise, or factual wording also needs correction; the next Writer retry must be able to fix all listed issues at once.",
    "",
    "Title review:",
    "- The final title must match the category and the Research/Title Agent finalTitle.",
    safeGeneralTopicFallback ? "- SAFE GENERAL TOPIC FALLBACK: The title may be a broad educational framing because no single current policy action was sufficiently anchored. Review whether the body gives concrete reader value and avoids unsupported current-status, legal-effect, or company-specific claims." : "",
    "- If topicMode is manual and a user direct topic exists, the final title and body must preserve that topic. Category or keyword must not replace it.",
    "- The title must include the core keyword naturally, have Naver-home clickability, avoid clickbait, and be answerable by the body.",
    "- Naver-home title review expects an editorial homepage-card title tied to the specific subject, event/action/tension, and reader promise. It must not pass only because it has a generic hook phrase.",
    safeGeneralTopicFallback
      ? "- In safe general-topic fallback mode, do not reject the title solely because it is a broad industry explainer. Reject it only when it promises a specific current event, policy action, company result, or decision that the body cannot support."
      : "- In auto topic mode, the title must not be only a keyword-lane or category-level generalization. It needs a concrete source-backed anchor from the Research result, such as a named subject, event/action, tension, consequence, or decision point.",
    safeGeneralTopicFallback
      ? "- In safe general-topic fallback mode, a title may remain useful after swapping individual examples, provided the article's concepts, relationships, and reader decision criteria remain concrete and source-bounded."
      : "- Return REVISION when a title could still work after swapping in many unrelated subjects from the same selected keyword lane.",
    "- Date words in the title must be source-backed story material, not decoration from Current writing date. Explicit Preferred tone wins style conflicts unless it creates clickbait, unsupported claims, or a title/body mismatch.",
    "- The body must directly answer the question or promise implied by the title.",
    "- If the title promises a guide, checklist, reason, comparison, application path, or decision help, the body must deliver that exact reader value with supported specifics. Generic warnings or broad background do not satisfy the title.",
    "",
    "Image contract review:",
    "- When title image generation is enabled, titleImageText must contain 2-5 automatically derived visible Korean strings and titleImagePrompt must explicitly render every string as a readable part of one whole-article information card.",
    "- The title image direction must compress the completed article across sections. A generic scene, background, product shot, or collection of objects without an editorial information hierarchy must receive REVISION.",
    "- When body image generation is enabled, every [SECTION - ...] section must contain exactly one sequential [IMAGE INSERT - n] marker and exactly one bodyImages item with the same sequence and exact sectionHeading.",
    "- Every body image prompt must compress that entire section's actual relationship, process, comparison, timeline, decision cue, or factual structure. A decorative or loosely related illustration must receive REVISION.",
    "",
    "Factuality review:",
    "- For fact-based topics, only confirmed facts from the Research/Title handoff and usable sources may be used.",
    "- Conditions, dates, amounts, targets, application methods, prices, schedules, official claims, statistics, and policy details must not be invented.",
    "- If a confirmation 기준일/current 기준 is needed for 접수중, 모집중, 신청 가능, 현재 운영, current availability, prices, schedules, deadlines, policy/support conditions, or official announcements but absent or misused, do not PASS.",
    safeGeneralTopicFallback
      ? "- SAFE GENERAL TOPIC FALLBACK HARD RULE: A named bill, statute section, vote/committee result, exact date, agency action, legal effect, company announcement, or current-status detail is publishable only when that exact detail appears in the Research/Title handoff or extracted excerpts. If it is absent, require the Writer to remove it or rewrite it as a clearly bounded general concept; never accept prior-knowledge supplementation."
      : "",
    safeGeneralTopicFallback
      ? "- When unsupported specifics can be removed without new research, classify the draft as REVISION (not an unrecoverable BLOCK) and give a concrete rewrite instruction. Keep BLOCK for empty, contradictory, unrelated, or otherwise unsafe evidence that cannot be made publishable by removing unsupported detail."
      : "",
    safeGeneralTopicFallback
      ? "- In safe general-topic fallback mode, currentBridgeRequired must be false unless the body makes a specific current claim. Do not require a currentPeg for a stable educational explanation."
      : "- If currentBridgeRequired is true, PASS only when currentBridgeSatisfied is true and the body explains the currentPeg as the reason the older anchorEvent matters now. If the article only retells the anchorEvent, return BLOCK or REVISION.",
    "- Facts and interpretation must be distinguishable. Uncertain items must not become definite claims.",
    "",
    "Search/source-use review:",
    "- The article must not copy search-result sentences, Naver top-post structure, source titles, or source paragraph order.",
    "- Search results may be used as signals, facts, reader-interest clues, and gap analysis only. They must not be pasted together into a new article.",
    "- If official or reliable sources are required but missing, return BLOCK.",
    ...(sourceMode === "file_upload" ? [
      "- In file-upload mode, missing external comparison criteria are not an official-source failure when the article explicitly marks them as unavailable from the uploaded source. Do not demand web research or external evidence to fill that gap.",
    ] : []),
    "",
    "Body quality review:",
    "- The introduction must be natural, the flow must be readable, and the article must not be a mechanical list.",
    "- Unless explicit Preferred tone asks for a stricter style, return REVISION when the post reads like a stiff report, press-summary, bullet rewrite, or generic encyclopedia entry instead of a human Naver Blog explanation.",
    "- Return REVISION when the article appears to fill space with broad cautions, repeated verification reminders, or vague statements instead of giving concrete reader-facing information tied to the selected title.",
    "- Each major section must advance the title promise. It should provide at least one useful unit such as a confirmed fact, practical step, decision criterion, comparison, consequence, or supported next-check path.",
    "- If multiple sections mainly say that details are uncertain or should be checked elsewhere, the article is not reader-facing enough to PASS.",
    "- Do not reject a stylistic choice solely for differing from the default human-blog voice when explicit Preferred tone requested that style and the article remains reader-facing and accurate.",
    "- Keyword repetition must not be excessive.",
    "- [SECTION - ...] markers are intentional app markers for Naver section headings. They are allowed in the Writer Agent article field and must not be treated as exposed internal text or a body quality failure.",
    "- The article must not expose internal words such as source candidate, source quality, prompt, JSON, agent, report, handoff, or review as reader-facing text.",
    "- Return REVISION when the article speaks about its own writing choices, coverage limits, or validation posture instead of explaining the selected subject directly to the reader.",
    "- Return REVISION when confirmed facts are repeatedly framed as source-observation or writer-observation statements instead of subject-state explanations for the reader.",
    "- The first section and opening paragraph must explain the article topic itself, not how the agent verified sources. Return REVISION if the lead reads like a research report or source-verification memo.",
    "- Return REVISION if the opening explains category exclusions, defends what the article is not, or copies category publishing direction instead of starting with the selected subject and reader value.",
    "- For policy/support/recruitment/training topics, PASS only when the body gives practical reader value: target/eligibility, support details, application or checking path, variable items to verify, and cautions when supported by sources.",
    "- For policy/support/recruitment/training topics, a caution-only article is not enough. If eligibility, support details, path, or decision criteria are not sufficiently supported, return BLOCK or REVISION instead of passing a vague filler article.",
    "- The article must not pretend to have personal experience unless the user provided that experience.",
    "",
    "Risk expression review:",
    "- Reject exaggerated income claims, fear-driven claims, unsupported future certainty, and expressions like 100%, 무조건, 완전 자동, 곧 사라진다, 충격, 대박 when used as unsupported hooks.",
    "- Reader-risk information must be blocked when uncertain, especially policy, support programs, law, tax, jobs, money, prices, schedules, applications, and official announcements.",
    "",
    "Final verdict rules:",
    "- Return PASS only if every review area can be published as-is.",
    "- Return REVISION if the issue is fixable by rewriting without new research, but do not rewrite it here.",
    ...(sourceMode === "file_upload" ? [
      "- Do not use REVISION to force unsupported technical completeness in file-upload mode. If the only issue is that the uploaded source does not provide a requested comparison or reader decision criterion, treat the limitation note as sufficient and return PASS.",
    ] : []),
    "- Return BLOCK if facts are insufficient, sources conflict, official/current evidence is missing, the article is unsupported, the direct topic changed, or publishing could mislead readers.",
    "",
    "Compact Research/Title Agent result (Writer Contract is supplied separately above):",
    JSON.stringify(compactResearchHandoffForPrompt(researchTitleResult), null, 2),
    "",
    "Writer Agent result:",
    JSON.stringify(compactWriterResultForPrompt(writerResult), null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"PASS\" | \"REVISION\" | \"BLOCK\", \"failureReason\": string, \"titleReviewPass\": boolean, \"articleAnswersTitle\": boolean, \"topicPreserved\": boolean, \"factualityPass\": boolean, \"currentBridgePass\": boolean, \"sourceUsePass\": boolean, \"bodyQualityPass\": boolean, \"imageContractPass\": boolean, \"riskExpressionPass\": boolean, \"writerContractPass\": boolean, \"readerFacingArticlePass\": boolean, \"noResearchProcessNarrationPass\": boolean, \"publishable\": boolean, \"issues\": string[], \"revisionInstructions\": string[], \"notes\": string[] }.",
    "- Use Korean for failureReason, issues, revisionInstructions, and notes.",
    "- If status is PASS, failureReason must be empty and every boolean review field must be true.",
    "- If status is REVISION or BLOCK, failureReason must concisely explain why it cannot be published as-is.",
    "- Keep issues, revisionInstructions, and notes concise and non-duplicative; include only items that change the verdict or next Writer revision.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildWriterContractRefinementPrompt({
  jobDir,
  researchTitleResult,
  draftWriterContract,
  sourceQuality
}) {
  const resultPath = path.join(jobDir, "writer-contract-result.json");
  const safeGeneralTopicFallback = researchTitleResult?.safeGeneralTopicFallback === true;
  return [
    "You are the Main Agent contract refinement step for a Korean Naver Blog automation app.",
    "Your task is semantic classification, not article writing.",
    "Read the Research/Title result and the draft Writer Contract.",
    "Refine the Writer Contract so the Writer Agent receives a clean article brief.",
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: main_review",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Semantic role rules:",
    "- Keep reader-facing article content in articleMission, readerPromise, firstSectionFocus, mustAnswer, mustCover, confirmedFacts, and recommendedStructure.",
    "- Put internal publishing limits, unsupported variables, source gaps, verification boundaries, and risk controls in safetyBoundaries, uncertainItems, sourceBoundaries, or mustNotDo.",
    "- Do not use token overlap, wording similarity, or phrase matching. Judge by meaning and field role.",
    "- Convert source-observation wording into subject-state wording before handing it to the Writer Agent.",
    "- Confirmed facts should read as what exists, where it belongs, what changes, who is affected, or what action the reader can take.",
    "- Keep verification wording only when the reader's actual task is to verify an uncertain variable or official condition.",
    "- mustCover and recommendedStructure must describe what useful subject matter the reader should learn, not what the writer should avoid saying.",
    "- safetyBoundaries are not article material. They protect the article from unsupported claims.",
    safeGeneralTopicFallback
      ? "- SAFE GENERAL TOPIC FALLBACK: A broad reader-facing explainer is allowed when the supplied excerpts support concrete concepts, relationships, and practical decision points. Keep unsupported current-policy or official-effect claims in safetyBoundaries and do not turn them into article content."
      : "- If the available confirmed facts cannot support a useful reader-facing article, return status failed instead of turning limitations into the article's main content.",
    "- Preserve the selected title, topic thesis, target reader, current bridge fields, and factual limits unless they are internally inconsistent.",
    "",
    "Draft Writer Contract:",
    JSON.stringify(draftWriterContract || {}, null, 2),
    "",
    "Compact Research/Title Agent result (the draft contract above is intentionally not duplicated):",
    JSON.stringify(compactResearchHandoffForPrompt(researchTitleResult), null, 2),
    "",
    "Source quality summary:",
    JSON.stringify(sourceQuality || { status: "unknown" }, null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"writerContract\": { \"articleMission\": string, \"selectedTitle\": string, \"topicThesis\": string, \"targetReader\": string, \"readerPromise\": string, \"firstSectionFocus\": string, \"mustAnswer\": string[], \"mustCover\": string[], \"mustNotDo\": string[], \"confirmedFacts\": string[], \"uncertainItems\": string[], \"sourceBoundaries\": string[], \"safetyBoundaries\": string[], \"recommendedStructure\": string[], \"readerValueChecklist\": string[], \"currentBridgeRequired\": boolean, \"currentBridgeSatisfied\": boolean, \"anchorEvent\": object, \"currentPeg\": object, \"tone\": string }, \"notes\": string[] }.",
    "- If status is failed, explain why the contract cannot support a publishable reader-facing article.",
    "- Keep every array concise and deduplicated. Do not repeat the same fact or boundary in notes.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildImageStylePrompt({
  jobDir,
  sampleImagePath,
  sampleImageHash = ""
}) {
  const resultPath = path.join(jobDir, "image-style-result.json");
  return [
    "You are the Image Style Agent for a Korean Naver Blog automation app.",
    "Analyze the local sample image and write a reusable image style prompt.",
    "Do not generate images. Do not write article content.",
    `Sample image path: ${sampleImagePath}`,
    `Sample image hash: ${sampleImageHash || "(unknown)"}`,
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: image",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Style prompt requirements:",
    "- Describe visual style only: composition, layout, palette, lighting, texture, camera/framing, graphic treatment, typography style if visible, and overall mood.",
    "- Make it reusable for future Korean Naver Blog title thumbnails and body support images.",
    "- Do not identify private people, infer sensitive traits, or copy exact text from the sample image.",
    "- Do not include article-specific facts, dates, products, programs, or claims from the sample image.",
    "- Keep the prompt concrete enough for image generation and under 1200 Korean/English characters.",
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"imageStylePrompt\": string, \"notes\": string[] }.",
    "- If the image cannot be inspected, set status to \"failed\" and explain the reason concisely in Korean.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildImageWorkerPrompt({
  jobDir,
  runtimeRoot,
  includeTitleImage = true,
  imageAspectRatio = DEFAULT_IMAGE_ASPECT_RATIO,
  titleImageAspectRatio,
  bodyImageAspectRatio,
  maxBodyImages = 10,
  writerResult,
  finalTitle,
  accountImageStylePrompt = "",
  imageRevisionFeedback = "",
  recoveryGuidance = []
}) {
  const resultPath = path.join(jobDir, "image-worker-result.json");
  const imageDir = path.join(runtimeRoot || path.dirname(path.dirname(jobDir)), "image");
  const selectedTitleImageAspectRatio = normalizeImageAspectRatio(titleImageAspectRatio || imageAspectRatio);
  const selectedBodyImageAspectRatio = normalizeImageAspectRatio(bodyImageAspectRatio || imageAspectRatio);
  const bodyImageLimit = normalizeMaxBodyImages(maxBodyImages);
  const recoveryContext = formatRecoveryGuidance(recoveryGuidance);
  fs.mkdirSync(imageDir, { recursive: true });
  return [
    "You are the Image Worker for a Korean Naver Blog automation app.",
    "You are not a content agent. Do not rewrite the title, article, tags, facts, or structure.",
    "Generate only the requested reference images from the Writer Agent image prompts.",
    `Final title: ${finalTitle || writerResult?.title || ""}`,
    `Image output directory: ${imageDir}`,
    `Output JSON path: ${resultPath}`,
    `Per-image progress directory: ${jobDir}`,
    imageRevisionFeedback ? `Previous image contract failure to correct: ${imageRevisionFeedback}` : "",
    recoveryContext ? "Previously successful recovery guidance (advisory only; do not mark unverified assets as successful):" : "",
    recoveryContext,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: image",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Image generation scope:",
    includeTitleImage ? "- Generate exactly one title image when titleImagePrompt is available." : "- Do not generate a title image.",
    bodyImageLimit > 0 ? `- Generate exactly one body image for every supplied bodyImages item, up to ${bodyImageLimit}; do not skip, merge, or reorder sections.` : "- Do not generate body images.",
    `- Requested title image aspect ratio: ${selectedTitleImageAspectRatio}.`,
    `- Requested body image aspect ratio: ${selectedBodyImageAspectRatio}.`,
    "- Generate title images in the requested title image aspect ratio and body images in the requested body image aspect ratio.",
    "- Keep each selected orientation and do not substitute a different ratio unless the image tool cannot support it.",
    "- Do not run shell, PowerShell, Node, Python, Copy-Item, cp, move, or file-copy commands for images.",
    "- Do not call cua_repl, browser automation, or an undefined tools object. Image Worker must invoke only an image-generation tool that is directly available in the current Codex session.",
    "- If no image-generation tool is directly available, stop promptly with status failure and a precise note; do not wait for or simulate a tool call.",
    "- Image Worker must not copy image files into the app image directory. The desktop app will copy returned image paths later.",
    "- If image generation returns a file outside the app image directory, return that original generated file path as-is.",
    "- If image generation fails or the tool is unavailable, return empty paths and put the reason in notes.",
    "- If image generation returns a concrete existing image file path ending in .png, .jpg, .jpeg, or .webp, return that path.",
    "- After each individual image is generated and verified, write a progress JSON file named image-worker-progress-<sequence>.json in the job directory. Use {status:\"partial\", titleImagePath:string, titleImageVerified:boolean, bodyImages:[{sequence,sectionHeading,path,prompt,summaryVerified}], notes:string[]} and keep completed paths and verification flags there so a later timeout can resume only missing images.",
    "- If the image tool responds with generated image data but without a concrete file path, do not paste base64 into the JSON. Leave paths empty and note that the generated image data is available in the Codex session; the desktop app will save it as an image file.",
    "- Use the exact sequence numbers from bodyImages[].sequence.",
    "- Paths must point to concrete .png, .jpg, .jpeg, or .webp files. Do not return a directory path.",
    "- Prefer concrete editorial blog visuals that summarize the article or nearby section. Avoid abstract decorative backgrounds.",
    accountImageStylePrompt ? "- Apply this account-specific visual style prompt unless it conflicts with factual accuracy, no-text rules, or the article context:" : "",
    accountImageStylePrompt ? accountImageStylePrompt : "",
    "",
    "Title image policy:",
    includeTitleImage ? "- The title image is one information-rich Korean editorial card that compresses the whole article across sections, not a generic background, representative scene, product shot, or body-style illustration." : "- Title image generation is disabled.",
    includeTitleImage ? `- The title image must use aspect ratio ${selectedTitleImageAspectRatio}.` : "",
    includeTitleImage ? "- Visible Korean text is mandatory. Render every supplied titleImageText string verbatim, large, readable, accurate, and integrated into a clear headline/key-fact hierarchy." : "",
    includeTitleImage ? "- Do not add long Korean paragraphs, fake official marks, unverified amounts, unverified dates, or labels that are not supported by the article." : "",
    includeTitleImage ? "- Combine the visible headline/key facts with 2-4 concrete article-wide visual fact cues. The result must be visibly distinct from body images." : "",
    includeTitleImage ? "- Inspect the generated title image before accepting it. If any required text is missing, unreadable, materially misspelled, or the image does not summarize the whole article, regenerate it once before returning a path." : "",
    "",
    "Body image policy:",
    bodyImageLimit > 0 ? "- Body images are section-compression visuals, not generic decoration and not title cards. Avoid readable Korean paragraphs, long labels, UI copy, and text-heavy charts." : "- Body image generation is disabled.",
    bodyImageLimit > 0 ? `- Every body image must use aspect ratio ${selectedBodyImageAspectRatio}.` : "",
    bodyImageLimit > 0 ? "- For every supplied item, preserve sequence and sectionHeading and compress the entire section's concrete subject, relationship, process, comparison, timeline, or decision cue into one coherent image." : "",
    bodyImageLimit > 0 ? "- Inspect each generated body image before accepting it. If it is generic, loosely related, or misses the section's central structure, regenerate it once before returning a path." : "",
    "",
    "Writer Agent image handoff:",
    JSON.stringify({
      titleImagePrompt: writerResult?.titleImagePrompt || "",
      titleImageText: Array.isArray(writerResult?.titleImageText) ? writerResult.titleImageText : [],
      bodyImages: Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages.slice(0, bodyImageLimit) : []
    }, null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"partial\" | \"failed\", \"failureReason\": string, \"titleImagePath\": string, \"titleImageVerified\": boolean, \"bodyImages\": [{\"sequence\": number, \"sectionHeading\": string, \"path\": string, \"prompt\": string, \"summaryVerified\": boolean}], \"notes\": string[] }.",
    "- If no image prompt is available, return status \"failed\", empty image paths, and a concise Korean note.",
    "- If some images succeed and some fail, return status \"partial\" with successful paths and notes for failures.",
    "- Keep notes concise and include only generation failures or verification facts needed by the app.",
    "- Status \"success\" is allowed only when every requested image has a concrete image file path, titleImageVerified is true when requested, and every body image has summaryVerified true.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function mergeImageWorkerResult(writerResult, imageResult, options = {}) {
  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  const writerBodyImages = Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages : [];
  const generatedBodyImages = Array.isArray(imageResult?.bodyImages) ? imageResult.bodyImages : [];
  const mergedBodyImages = generatedBodyImages
    .filter((item) => String(item?.path || "").trim())
    .slice(0, bodyImageLimit)
    .map((item) => ({
      sequence: Number(item.sequence || 0),
      sectionHeading: String(item.sectionHeading || writerBodyImages.find((writerImage) => Number(writerImage.sequence) === Number(item.sequence))?.sectionHeading || ""),
      path: String(item.path || ""),
      prompt: String(item.prompt || writerBodyImages.find((writerImage) => Number(writerImage.sequence) === Number(item.sequence))?.prompt || ""),
      summaryVerified: item.summaryVerified === true
    }))
    .filter((item) => item.sequence > 0);

  const notes = [
    ...(Array.isArray(imageResult?.notes) ? imageResult.notes : [])
  ];
  if (imageResult && String(imageResult.status || "").toLowerCase() !== "success") {
    const reason = String(imageResult.failureReason || "").trim();
    notes.push(reason || "이미지 Worker가 일부 또는 전체 이미지를 생성하지 못했습니다. 이미지 삽입은 가능한 항목만 진행합니다.");
  }

  return {
    ...writerResult,
    titleImagePath: options.includeTitleImage === false ? "" : String(imageResult?.titleImagePath || ""),
    bodyImages: mergedBodyImages,
    notes
  };
}

function mergeImageWorkerAttempts(previousResult, currentResult) {
  if (!previousResult) return currentResult || {};
  const previousImages = Array.isArray(previousResult.bodyImages) ? previousResult.bodyImages : [];
  const currentImages = Array.isArray(currentResult?.bodyImages) ? currentResult.bodyImages : [];
  const bySequence = new Map();
  for (const item of [...previousImages, ...currentImages]) {
    const sequence = Number(item?.sequence || 0);
    if (sequence <= 0) continue;
    const existing = bySequence.get(sequence);
    const itemIsUsable = Boolean(String(item?.path || "").trim()) && item?.summaryVerified === true;
    const existingIsUsable = Boolean(String(existing?.path || "").trim()) && existing?.summaryVerified === true;
    if (!existing || itemIsUsable || !existingIsUsable) bySequence.set(sequence, item);
  }
  const titleFromCurrent = Boolean(String(currentResult?.titleImagePath || "").trim())
    && currentResult?.titleImageVerified === true;
  return {
    ...previousResult,
    ...currentResult,
    status: "success",
    failureReason: "",
    titleImagePath: titleFromCurrent ? currentResult.titleImagePath : previousResult.titleImagePath || currentResult?.titleImagePath || "",
    titleImageVerified: titleFromCurrent ? true : previousResult.titleImageVerified === true || currentResult?.titleImageVerified === true,
    bodyImages: [...bySequence.values()].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0)),
    notes: compactTextList([previousResult.notes, currentResult?.notes])
  };
}

function pendingImageWriterResult(writerResult, imageResult, options = {}) {
  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  const titlePending = options.includeTitleImage !== false
    && !(String(imageResult?.titleImagePath || "").trim() && imageResult?.titleImageVerified === true);
  const generatedImages = Array.isArray(imageResult?.bodyImages) ? imageResult.bodyImages : [];
  const pendingBodyImages = (Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages : [])
    .slice(0, bodyImageLimit)
    .filter((expected) => {
      const actual = generatedImages.find((item) => Number(item?.sequence) === Number(expected?.sequence));
      return !actual
        || !String(actual.path || "").trim()
        || actual.summaryVerified !== true
        || normalizedSectionHeading(actual.sectionHeading) !== normalizedSectionHeading(expected.sectionHeading);
    });
  return {
    title: writerResult?.title || "",
    titleImagePrompt: titlePending ? writerResult?.titleImagePrompt || "" : "",
    titleImageText: titlePending && Array.isArray(writerResult?.titleImageText) ? writerResult.titleImageText : [],
    bodyImages: pendingBodyImages
  };
}

function imageWorkerContractIssueReason(imageResult, writerResult, options = {}) {
  const status = String(imageResult?.status || "").toLowerCase();
  const sessionImageDataAvailable = /(?:generated\s+image\s+data|codex\s+session|세션.*이미지|이미지.*세션)/i.test(
    [imageResult?.failureReason, ...(Array.isArray(imageResult?.notes) ? imageResult.notes : [])]
      .filter(Boolean)
      .join(" ")
  );
  if (status !== "success" && !(status === "partial" && sessionImageDataAvailable)) {
    return String(imageResult?.failureReason || "").trim() || "Image Worker가 모든 요청 이미지를 성공 상태로 반환하지 않았습니다.";
  }
  if (options.includeTitleImage !== false) {
    if (!String(imageResult?.titleImagePath || "").trim() && !sessionImageDataAvailable) {
      return "본문 전체를 압축한 타이틀 이미지 파일이 없습니다.";
    }
    if (imageResult?.titleImageVerified !== true) {
      return "타이틀 이미지의 필수 문구 가독성과 본문 전체 요약 여부가 검증되지 않았습니다.";
    }
  }

  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  if (bodyImageLimit === 0) return "";
  const expected = Array.isArray(writerResult?.bodyImages)
    ? writerResult.bodyImages.slice(0, bodyImageLimit)
    : [];
  const generated = Array.isArray(imageResult?.bodyImages) ? imageResult.bodyImages : [];
  if (generated.length !== expected.length) {
    return `섹션별 본문 이미지 ${expected.length}장이 필요하지만 ${generated.length}장이 반환됐습니다.`;
  }
  for (const expectedImage of expected) {
    const actual = generated.find((item) => Number(item?.sequence) === Number(expectedImage?.sequence));
    if (!actual || (!String(actual.path || "").trim() && !sessionImageDataAvailable)) {
      return `본문 섹션 ${expectedImage.sequence} 이미지 파일이 없습니다.`;
    }
    if (normalizedSectionHeading(actual.sectionHeading) !== normalizedSectionHeading(expectedImage.sectionHeading)) {
      return `본문 섹션 ${expectedImage.sequence} 이미지의 sectionHeading이 Writer 전달값과 다릅니다.`;
    }
    if (actual.summaryVerified !== true) {
      return `본문 섹션 ${expectedImage.sequence} 이미지가 섹션 전체 압축 이미지로 검증되지 않았습니다.`;
    }
  }
  return "";
}

function escapeJsonControlCharacters(raw) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const char of String(raw || "")) {
    const code = char.charCodeAt(0);
    if (inString && code < 0x20) {
      if (code === 0x0a) output += "\\n";
      else if (code === 0x0d) output += "\\r";
      else if (code === 0x09) output += "\\t";
      else if (code === 0x08) output += "\\b";
      else if (code === 0x0c) output += "\\f";
      else output += `\\u${code.toString(16).padStart(4, "0")}`;
      escaped = false;
      continue;
    }
    output += char;
    if (inString && char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === '"' && !escaped) inString = !inString;
    escaped = false;
  }
  return output;
}

function readAgentResult(jobDir, fileName = "agent-result.json") {
  const resultPath = path.join(jobDir, fileName);
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Codex result file was not created: ${fileName}`);
  }
  const raw = fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(raw);
  } catch (error) {
    try {
      return JSON.parse(escapeJsonControlCharacters(raw));
    } catch {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      throw new Error(`Codex Agent 결과 JSON 파싱 실패(${fileName}): ${message}`);
    }
  }
}

function preserveAgentFile(jobDir, fromName, toName) {
  const fromPath = path.join(jobDir, fromName);
  const toPath = path.join(jobDir, toName);
  if (fs.existsSync(fromPath)) {
    fs.copyFileSync(fromPath, toPath);
  }
}

function removeAgentResultFile(jobDir, fileName) {
  const resultPath = path.join(jobDir, fileName);
  if (fs.existsSync(resultPath)) {
    fs.rmSync(resultPath, { force: true });
  }
}

function compactTextList(values) {
  return (Array.isArray(values) ? values : [values])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function uniqueCompactTextList(values, limit = 8) {
  const seen = new Set();
  const result = [];
  for (const value of compactTextList(values)) {
    const key = value.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function firstCompactText(values, fallback = "") {
  return compactTextList(values)[0] || fallback;
}

function summarizeUsableSourcesForContract(sources, limit = 5) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, limit)
    .map((source) => uniqueCompactTextList([
      source?.sourceId ? `id: ${source.sourceId}` : "",
      source?.title ? `title: ${source.title}` : "",
      source?.url ? `url: ${source.url}` : "",
      source?.reason ? `use: ${source.reason}` : ""
    ], 4).join(" / "))
    .filter(Boolean);
}

function recommendedStructureForContract(researchResult = {}) {
  const factBased = Boolean(researchResult?.factBased);
  const searchNeed = String(researchResult?.searchNeed || "").toLowerCase();
  const mustCover = uniqueCompactTextList(researchResult?.mustCover, 8).join(" ");
  const title = String(researchResult?.finalTitle || researchResult?.selectedTitle || "").toLowerCase();
  const factRiskText = `${title} ${mustCover}`;
  const isReaderRiskTopic = factBased
    || searchNeed === "strict"
    || /policy|support|program|recruit|job|application|deadline|price|tax|law|grant|loan|education|training|schedule/i.test(factRiskText);

  if (isReaderRiskTopic) {
    return [
      "Open by answering the title promise from the reader's point of view.",
      "Explain the confirmed subject, current status, and who is affected.",
      "Cover eligibility/target, key details, checking or application path, variable items to verify, and cautions when the handoff supports them.",
      "Separate confirmed facts from interpretation and uncertainty.",
      "Close with what the reader should check next."
    ];
  }

  return [
    "Open by answering the title promise from the reader's point of view.",
    "Explain why this topic matters now or why readers care.",
    "Develop the main points in reader-facing sections tied to the selected title.",
    "Mention limits or uncertainty without turning the post into a research memo.",
    "Close with a concise practical takeaway."
  ];
}

function readerValueChecklistForContract(researchResult = {}) {
  const factBased = Boolean(researchResult?.factBased);
  const searchNeed = String(researchResult?.searchNeed || "").toLowerCase();
  const mustAnswerCount = uniqueCompactTextList(researchResult?.mustAnswer || researchResult?.coreQuestions, 8).length;
  const mustCoverCount = uniqueCompactTextList(researchResult?.mustCover, 10).length;
  const confirmedFactCount = uniqueCompactTextList(researchResult?.confirmedFacts, 12).length;
  const isFactRiskTopic = factBased || searchNeed === "strict";
  return [
    "Every section must answer a reader question implied by the selected title, not merely restate that the reader should verify something elsewhere.",
    "Each section should add at least one concrete reader value item: a confirmed fact, a practical step, a decision criterion, a comparison, a consequence, or a next-check path supported by the handoff.",
    "Uncertainty and source boundaries are constraints for safe writing, not the main article material. Turn necessary uncertainty into a short practical caution or fail if it dominates the article.",
    "If the supported material cannot produce several specific reader-facing sections tied to the title promise, return status failed instead of padding with broad advice or repeated caveats.",
    isFactRiskTopic
      ? "For fact-risk topics, the article must still be useful: explain what is confirmed, what the reader can do with it, and exactly which variable items to check next when supported."
      : "For explanatory topics, keep the subject, event, cause, effect, and reader takeaway visible through the whole article.",
    `Support snapshot: mustAnswer=${mustAnswerCount}, mustCover=${mustCoverCount}, confirmedFacts=${confirmedFactCount}.`
  ].filter(Boolean);
}

function buildWriterContract(researchResult = {}, context = {}) {
  const hasRefinedWriterContract = researchResult?.writerContractRefined === true;
  const finalTitle = firstCompactText([
    researchResult?.finalTitle,
    researchResult?.selectedTitle,
    context.finalTitle,
    context.topic
  ]);
  const topicThesis = firstCompactText([
    researchResult?.topicThesis,
    researchResult?.writerBrief,
    context.topic,
    finalTitle
  ], finalTitle);
  const coreQuestions = uniqueCompactTextList(researchResult?.coreQuestions, 8);
  const mustCover = uniqueCompactTextList(researchResult?.mustCover, 10);
  const confirmedFacts = uniqueCompactTextList(researchResult?.confirmedFacts, 12);
  const uncertainItems = uniqueCompactTextList(researchResult?.uncertainItems, 8);
  const avoidDirections = uniqueCompactTextList(researchResult?.avoidDirections, 10);
  const anchorEvent = {
    name: firstCompactText([
      researchResult?.writerContract?.anchorEvent?.name,
      researchResult?.anchorEvent?.name
    ]),
    date: firstCompactText([
      researchResult?.writerContract?.anchorEvent?.date,
      researchResult?.anchorEvent?.date
    ]),
    summary: firstCompactText([
      researchResult?.writerContract?.anchorEvent?.summary,
      researchResult?.anchorEvent?.summary
    ])
  };
  const currentPeg = {
    date: firstCompactText([
      researchResult?.writerContract?.currentPeg?.date,
      researchResult?.currentPeg?.date
    ]),
    summary: firstCompactText([
      researchResult?.writerContract?.currentPeg?.summary,
      researchResult?.currentPeg?.summary
    ]),
    sourceIds: uniqueCompactTextList([
      researchResult?.writerContract?.currentPeg?.sourceIds,
      researchResult?.currentPeg?.sourceIds
    ], 6)
  };
  const currentBridgeRequired = researchResult?.writerContract?.currentBridgeRequired === true
    || researchResult?.currentBridgeRequired === true;
  const currentBridgeSatisfied = researchResult?.writerContract?.currentBridgeSatisfied === true
    || researchResult?.currentBridgeSatisfied === true;

  return {
    articleMission: firstCompactText([
      researchResult?.writerContract?.articleMission,
      topicThesis,
      finalTitle
    ], "Write the selected article promised by the final title."),
    selectedTitle: finalTitle,
    topicThesis,
    targetReader: firstCompactText([
      researchResult?.writerContract?.targetReader,
      researchResult?.targetReader
    ], "Readers who need to understand this selected topic and decide what to check next."),
    readerPromise: firstCompactText([
      researchResult?.writerContract?.readerPromise,
      coreQuestions.length ? coreQuestions.join(" / ") : "",
      researchResult?.writerBrief
    ], "Answer the selected title directly with useful reader-facing context."),
    firstSectionFocus: firstCompactText([
      researchResult?.writerContract?.firstSectionFocus
    ], "Start with the topic promised by the title from the reader's point of view. Do not begin with source collection, search flow, or verification-process narration."),
    mustAnswer: uniqueCompactTextList([
      researchResult?.writerContract?.mustAnswer,
      hasRefinedWriterContract ? [] : coreQuestions
    ], 8),
    mustCover: uniqueCompactTextList([
      researchResult?.writerContract?.mustCover,
      hasRefinedWriterContract ? [] : mustCover
    ], 12),
    mustNotDo: uniqueCompactTextList([
      researchResult?.writerContract?.mustNotDo,
      avoidDirections,
      "Do not create a new topic or change the selected title.",
      "Do not narrate the agent's search, source collection, or verification workflow as article content.",
      "Do not turn the opening section into a source report.",
      "Do not use category direction or keywords to broaden the article away from the selected title.",
      "Do not copy category publishing direction into the article body.",
      "Do not open by explaining what the article is not. Start with the selected subject and the reader value directly."
    ], 12),
    confirmedFacts: uniqueCompactTextList([
      researchResult?.writerContract?.confirmedFacts,
      confirmedFacts
    ], 12),
    uncertainItems: uniqueCompactTextList([
      researchResult?.writerContract?.uncertainItems,
      uncertainItems
    ], 8),
    sourceBoundaries: uniqueCompactTextList([
      researchResult?.writerContract?.sourceBoundaries,
      summarizeUsableSourcesForContract(researchResult?.usableSources)
    ], 8),
    safetyBoundaries: uniqueCompactTextList([
      researchResult?.writerContract?.safetyBoundaries,
      uncertainItems,
      researchResult?.writerContract?.sourceBoundaries,
      summarizeUsableSourcesForContract(researchResult?.usableSources)
    ], 12),
    recommendedStructure: uniqueCompactTextList([
      researchResult?.writerContract?.recommendedStructure,
      hasRefinedWriterContract ? [] : recommendedStructureForContract(researchResult)
    ], 8),
    readerValueChecklist: uniqueCompactTextList([
      researchResult?.writerContract?.readerValueChecklist,
      readerValueChecklistForContract(researchResult)
    ], 8),
    currentBridgeRequired,
    currentBridgeSatisfied,
    anchorEvent,
    currentPeg,
    tone: firstCompactText([
      context.preferredTone,
      researchResult?.writerContract?.tone
    ], "Korean Naver Blog editorial tone; human, reader-facing, practical, clear, and non-clickbait.")
  };
}

function summarizeAgentReason(values, fallback, maxLength = 700) {
  const text = compactTextList(values)
    .map((value) => stripAnsi(value).replace(/\s+/g, " ").trim())
    .filter((value) => value && !looksLikeMojibake(value))
    .join(" / ")
    .trim();
  return (text || fallback).slice(0, maxLength);
}

function researchRevisionReason(researchResult) {
  return summarizeAgentReason([
    researchResult?.failureReason,
    researchResult?.notes,
    researchResult?.uncertainItems
  ], "Research/Title Agent가 본문 작성 전 추가 확인이 필요하다고 판단했습니다.");
}

function isSafeGeneralTopicFallbackEligible(options = {}, researchResult = {}) {
  if (options.sourceMode === "file_upload") return false;
  if (options.forceWebSearch !== true) return false;
  if (!Array.isArray(options.searchResults) || options.searchResults.length < 3) return false;
  if (!["REVISION", "BLOCK"].includes(String(researchResult?.status || "").toUpperCase())) return false;
  const topic = String(options.topic || "").replace(/\s+/g, " ").trim();
  if (!topic) return false;
  const hasBroadSignal = /관련|동향|영향|경쟁|산업|정책|기술|전망|변화|이슈|흐름|원리|이해/.test(topic);
  const hasActionRisk = /신청|접수|마감|가격|금액|보험금|보상청구|과실|처벌|판결|위반|리콜|사망|진단|치료|지원금|세금/.test(topic);
  const usableCandidates = options.searchResults.filter((item) => {
    const url = String(item?.fetchedUrl || item?.url || "").trim();
    const excerpt = String(item?.excerpt || "").trim();
    return url && excerpt.length >= 120;
  });
  return hasBroadSignal && !hasActionRisk && usableCandidates.length >= 3;
}

function buildSafeGeneralTopicFallback(options = {}, previousResult = {}) {
  if (!isSafeGeneralTopicFallbackEligible(options, previousResult)) return null;
  const topic = String(options.topic || "").replace(/\s+/g, " ").trim();
  const previousTitle = String(previousResult?.finalTitle || previousResult?.selectedTitle || "").replace(/\s+/g, " ").trim();
  const unsafeTitlePattern = /현재|최신|시행|신청|접수|마감|가격|금액|처벌|위반|확정|공식\s*정책/;
  const finalTitle = previousTitle && !unsafeTitlePattern.test(previousTitle)
    ? previousTitle
    : `${topic}이 자동차산업에 미치는 영향과 이해할 핵심 흐름`;
  const candidateSources = options.searchResults
    .filter((item) => String(item?.url || item?.fetchedUrl || "").trim())
    .slice(0, 8)
    .map((item, index) => ({
      sourceId: String(item?.sourceId || `source-${index + 1}`),
      title: String(item?.title || "").trim(),
      url: String(item?.fetchedUrl || item?.url || "").trim(),
      reason: "검색 후보의 관련 내용을 일반 설명의 참고 근거로 사용합니다."
    }));
  const priorUncertain = Array.isArray(previousResult?.uncertainItems) ? previousResult.uncertainItems : [];
  const priorFacts = Array.isArray(previousResult?.confirmedFacts) ? previousResult.confirmedFacts : [];
  return {
    ...previousResult,
    status: "PASS",
    failureReason: "",
    finalTitle,
    selectedTitle: finalTitle,
    topicThesis: `${topic}을 특정 법률·정책의 시행 여부로 단정하지 않고, 검색 후보에서 확인된 산업 맥락과 자동차산업의 연결 구조를 독자가 이해할 수 있도록 설명합니다.`,
    currentBridgeRequired: false,
    currentBridgeSatisfied: true,
    anchorEvent: { name: "", date: "", summary: "" },
    currentPeg: { date: "", summary: "", sourceIds: [] },
    directTopicPreserved: true,
    factBased: true,
    safeGeneralTopicFallback: true,
    searchNeed: "normal",
    searchFlowSummary: compactTextList([
      previousResult?.searchFlowSummary,
      "구체적인 최신 정책 조치가 충분히 확인되지 않아, 검색 후보 범위 안의 일반 산업 설명 모드로 전환했습니다."
    ]).join(" / "),
    coreQuestions: [
      `${topic}의 핵심 개념은 무엇인가?`,
      "자동차산업과 연결되는 지점은 무엇인가?",
      "독자가 구분해서 봐야 할 사실과 해석은 무엇인가?",
      "추가 확인이 필요한 변수는 무엇인가?"
    ],
    mustCover: [
      "주제의 핵심 개념과 구성 요소",
      "자동차 제조·소프트웨어·정비 생태계와의 연결 구조",
      "검색 후보에서 직접 뒷받침되는 사례와 의미",
      "독자가 판단할 때 사용할 수 있는 구분 기준"
    ],
    avoidDirections: compactTextList([
      previousResult?.avoidDirections,
      "특정 정책의 시행·법적 효력·기업의 현재 조치를 근거 없이 단정하지 않기",
      "검색 과정이나 검수 실패를 본문 도입부와 결론에서 설명하지 않기"
    ]),
    confirmedFacts: priorFacts.slice(0, 12),
    uncertainItems: compactTextList([
      priorUncertain,
      "특정 정부 조치의 법적 성격과 시행 상태",
      "개별 기업의 직접적인 정책 대응 여부"
    ]),
    usableSources: candidateSources.length ? candidateSources : (previousResult?.usableSources || []),
    writerBrief: `${topic}에 대해 검색 후보가 직접 뒷받침하는 범위에서 개념, 산업 연결 구조, 사례의 의미, 독자 판단 기준을 설명하는 정보형 글을 작성합니다. 특정 최신 정책의 시행이나 기업별 조치를 단정하지 않습니다.`,
    notes: compactTextList([
      previousResult?.notes,
      "검색 후보와 본문·이미지 연결을 보존하기 위해 안전한 일반 설명 모드로 전환했습니다.",
      "공식 시행·법적 효력·현재 상태가 필요한 문장은 발행 대상에서 제외합니다."
    ])
  };
}

function currentBridgeIssueReason(researchResult) {
  if (researchResult?.currentBridgeRequired !== true) return "";
  if (researchResult?.currentBridgeSatisfied === true) return "";
  return summarizeAgentReason([
    researchResult?.failureReason,
    researchResult?.currentPeg?.summary,
    researchResult?.uncertainItems,
    researchResult?.notes
  ], "과거 anchorEvent를 현재 이슈로 다루려면 현재 진행 상황이나 최근 변화(currentPeg)가 확인되어야 합니다.");
}

function isResearchSourceFailure(researchResult) {
  const searchNeed = String(researchResult?.searchNeed || "").toLowerCase();
  if (!["light", "normal", "strict"].includes(searchNeed)) return false;

  const status = String(researchResult?.status || "").toUpperCase();
  const text = compactTextList([
    researchResult?.failureReason,
    researchResult?.searchFlowSummary,
    researchResult?.coreQuestions,
    researchResult?.mustCover,
    researchResult?.confirmedFacts,
    researchResult?.uncertainItems,
    researchResult?.usableSources,
    researchResult?.writerBrief,
    researchResult?.writerContract?.sourceBoundaries,
    researchResult?.notes
  ]).join(" / ");

  if (!text) return status === "REVISION";
  return /근거|자료|출처|발췌|검색\s*후보|공식|지도|네이버지도|카카오맵|확인.*부족|부족.*확인|관련되지|관련성이\s*없|직접\s*관련|source|insufficient|unsupported|cannot\s+support|not\s+enough|official|map/i.test(text);
}

function isAuthoritySourceQualityFailure(sourceQuality) {
  return sourceQuality?.status === "insufficient"
    && sourceQuality?.authorityEvidenceRequired === true
    && Number(sourceQuality?.authorityEvidenceCandidates || 0) === 0;
}

function authoritySourceQualityIssueReason(sourceQuality) {
  if (!isAuthoritySourceQualityFailure(sourceQuality)) return "";
  return sourceQuality.reason
    || "블로그 후보는 주제 단서로 확인되었지만 공식/기관 근거가 부족합니다. 공식 원문 보강 검색이 필요합니다.";
}

function writerOutputIssueReason(writerResult) {
  const writerStatus = String(writerResult?.status || "").toLowerCase();
  const writerReason = summarizeAgentReason([
    writerResult?.failureReason,
    writerResult?.notes,
    writerResult?.revisionInstructions
  ], "Writer Agent가 본문 작성에 실패했습니다.");

  if (writerStatus === "failed") return writerReason;
  if (!writerStatus) return "Writer Agent 상태값이 비어 있습니다.";
  if (writerStatus !== "success") return `Writer Agent 상태값이 유효하지 않습니다: ${writerStatus}`;
  if (!String(writerResult?.article || "").trim()) {
    return "Writer Agent가 본문(article)을 비워 반환했습니다.";
  }
  if (!Array.isArray(writerResult?.tags) || writerResult.tags.filter(Boolean).length === 0) {
    return "Writer Agent가 태그(tags)를 반환하지 않았습니다.";
  }
  return "";
}

function articleSections(article) {
  const text = String(article || "");
  const matches = [...text.matchAll(/^\[SECTION\s*-\s*(.+?)\]\s*$/gmi)];
  return matches.map((match, index) => ({
    heading: String(match[1] || "").replace(/\s+/g, " ").trim(),
    content: text.slice(match.index, matches[index + 1]?.index ?? text.length)
  }));
}

function normalizedSectionHeading(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function writerImageContractIssueReason(writerResult, options = {}) {
  if (options.includeTitleImage !== false) {
    const titleText = Array.isArray(writerResult?.titleImageText)
      ? writerResult.titleImageText.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const titlePrompt = String(writerResult?.titleImagePrompt || "").trim();
    if (titleText.length < 2 || titleText.length > 5) {
      return "타이틀 이미지가 본문 전체를 압축한 2~5개의 표시 문구(titleImageText)를 반환하지 않았습니다.";
    }
    if (!titleText.some((item) => /[가-힣]/.test(item))) {
      return "타이틀 이미지 표시 문구에 한국어 핵심 헤드라인이 없습니다.";
    }
    if (!titlePrompt || !titleText.every((item) => titlePrompt.includes(item))) {
      return "타이틀 이미지 프롬프트가 자동 추출한 모든 표시 문구를 이미지 안에 명확히 넣도록 전달하지 않았습니다.";
    }
  }

  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  if (bodyImageLimit === 0) return "";

  const sections = articleSections(writerResult?.article);
  if (sections.length === 0) {
    return "본문 이미지 생성을 위해 필요한 [SECTION - 소제목] 섹션이 없습니다.";
  }
  if (sections.length > bodyImageLimit) {
    return `본문 섹션이 ${sections.length}개로 섹션별 이미지 안전 한도 ${bodyImageLimit}개를 초과했습니다.`;
  }

  const bodyImages = Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages : [];
  if (bodyImages.length !== sections.length) {
    return `본문 ${sections.length}개 섹션에 각각 한 장이 필요하지만 이미지 프롬프트가 ${bodyImages.length}개입니다.`;
  }

  for (let index = 0; index < sections.length; index += 1) {
    const expectedSequence = index + 1;
    const image = bodyImages[index] || {};
    const markerPattern = new RegExp(`^\\[IMAGE INSERT\\s*-\\s*${expectedSequence}\\]\\s*$`, "mi");
    if (!markerPattern.test(sections[index].content)) {
      return `본문 섹션 ${expectedSequence}(${sections[index].heading}) 안에 대응 이미지 마커가 없습니다.`;
    }
    const sectionLines = sections[index].content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!new RegExp(`^\\[IMAGE INSERT\\s*-\\s*${expectedSequence}\\]$`, "i").test(sectionLines[1] || "")) {
      return `본문 섹션 ${expectedSequence}(${sections[index].heading}) 바로 뒤에 대응 이미지 마커가 없습니다.`;
    }
    if (Number(image.sequence) !== expectedSequence) {
      return `본문 이미지 sequence가 섹션 순서와 일치하지 않습니다: ${expectedSequence}번이 필요합니다.`;
    }
    if (normalizedSectionHeading(image.sectionHeading) !== normalizedSectionHeading(sections[index].heading)) {
      return `본문 이미지 ${expectedSequence}의 sectionHeading이 실제 섹션 제목과 일치하지 않습니다.`;
    }
    if (String(image.prompt || "").trim().length < 30) {
      return `본문 이미지 ${expectedSequence} 프롬프트가 해당 섹션 전체를 압축하기에 너무 짧습니다.`;
    }
  }
  return "";
}

function isSourceInsufficientWriterIssue(reason, writerResult, researchResult) {
  const text = compactTextList([
    reason,
    writerResult?.failureReason,
    writerResult?.notes,
    researchResult?.failureReason,
    researchResult?.notes,
    researchResult?.uncertainItems
  ]).join(" / ");
  if (String(researchResult?.status || "").toUpperCase() === "REVISION") return true;
  return /근거|자료|출처|발췌|검색\s*후보|공식|확인.*부족|부족.*확인|관련되지|관련성이\s*없|직접\s*관련|source|insufficient|unsupported|cannot\s+support/i.test(text);
}

function retryableWriterFailureReason(writerResult, researchResult) {
  const issueReason = writerOutputIssueReason(writerResult);
  if (!issueReason) return "";
  if (isSourceInsufficientWriterIssue(issueReason, writerResult, researchResult)) {
    return "";
  }
  return issueReason;
}

function revisionFeedbackFrom(mainReviewResult, writerResult) {
  return compactTextList([
    mainReviewResult?.failureReason,
    mainReviewResult?.revisionInstructions,
    mainReviewResult?.issues,
    mainReviewResult?.notes,
    writerResult?.failureReason,
    writerResult?.notes
  ]).join(" / ").slice(0, 4000);
}

function safeGeneralFallbackBlockIsRewriteable(mainReviewResult) {
  if (String(mainReviewResult?.status || "").toUpperCase() !== "BLOCK") return false;
  const reviewText = compactTextList([
    mainReviewResult?.failureReason,
    mainReviewResult?.revisionInstructions,
    mainReviewResult?.issues,
    mainReviewResult?.notes
  ]).join(" / ");
  if (!reviewText) return false;
  const unsupportedSpecificClaim = /(근거에 없는|출처에 없는|자료에 없는|확정적으로 사용|사용 가능 출처|법안|법률|법 조항|조항|표결|투표|위원회|법적 범위|공식 원문|현재 상태|법적 효력|unsupported|unsubstantiated|source)/i;
  const unrecoverable = /(본문이 없|원문이 없|자료가 없|비어 있|완전히 무관|로그인|파일.*찾을 수 없|이미지.*없)/i;
  return unsupportedSpecificClaim.test(reviewText) && !unrecoverable.test(reviewText);
}

function mainReviewPassIssueReason(mainReviewResult) {
  if (String(mainReviewResult?.status || "").toUpperCase() !== "PASS") return "";
  const requiredTrueFields = [
    ["titleReviewPass", "title review"],
    ["articleAnswersTitle", "article answers title"],
    ["topicPreserved", "topic preserved"],
    ["factualityPass", "factuality"],
    ["currentBridgePass", "current bridge"],
    ["sourceUsePass", "source use"],
    ["bodyQualityPass", "body quality"],
    ["imageContractPass", "image contract"],
    ["riskExpressionPass", "risk expressions"],
    ["writerContractPass", "writer contract"],
    ["readerFacingArticlePass", "reader-facing article"],
    ["noResearchProcessNarrationPass", "no research-process narration"],
    ["publishable", "publishable"]
  ];
  const failedFields = requiredTrueFields
    .filter(([field]) => mainReviewResult?.[field] !== true)
    .map(([, label]) => label);
  if (failedFields.length) {
    return `Main Agent returned PASS but required review checks failed: ${failedFields.join(", ")}`;
  }
  const failureReason = String(mainReviewResult?.failureReason || "").trim();
  if (failureReason) {
    return `Main Agent returned PASS with a failure reason: ${failureReason}`;
  }
  return "";
}

async function runCodexTask({
  options,
  prompt,
  promptFileName,
  resultFileName,
  log = () => {},
  tokenOffset = 0,
  grossTokenOffset = 0,
  inputTokenOffset = 0,
  cachedInputTokenOffset = 0,
  outputTokenOffset = 0,
  promptCharacterOffset = 0,
  agentTokenOffset = 0,
  agent = "main"
}) {
  fs.writeFileSync(path.join(options.jobDir, promptFileName), prompt, "utf8");
  removeAgentResultFile(options.jobDir, resultFileName);
  const outputState = { section: "meta" };
  const tokenState = {
    awaitingValue: false,
    total: 0,
    grossTotal: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    lastTotal: 0,
    lastInputTokens: 0,
    lastCachedInputTokens: 0,
    lastOutputTokens: 0,
    rateLimits: null
  };
  let taskEffort = modelEffortForAgent(options, agent);
  let finalTokenUsageLogged = false;
  let taskStartedAt = Date.now();
  const promptCharacters = String(prompt || "").length;
  const estimatedPromptTokens = Math.ceil(promptCharacters / 3);
  log(`${agentDisplayName(agent)} 프롬프트 크기: ${promptCharacters.toLocaleString()}자 (약 ${estimatedPromptTokens.toLocaleString()} tokens)`, "info", agent);
  const fallbackUsage = {
    total: 0,
    grossTotal: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rateLimits: null
  };

  const recoverTokenUsageFromSession = () => {
    if (tokenState.total > 0 && tokenState.rateLimits) return;
    const recovered = readLatestCodexTokenUsageFromSessions({
      sinceMs: taskStartedAt,
      jobDir: options.jobDir,
      resultFileName
    });
    if (!recovered?.tokenUsage) return;
    const recoveredTotal = Number(recovered.tokenUsage.total || 0);
    if (recoveredTotal > 0 && tokenState.total <= 0) {
      Object.assign(tokenState, {
        total: recoveredTotal,
        grossTotal: Number(recovered.tokenUsage.grossTotal || recoveredTotal || 0),
        inputTokens: Number(recovered.tokenUsage.inputTokens || 0),
        cachedInputTokens: Number(recovered.tokenUsage.cachedInputTokens || 0),
        outputTokens: Number(recovered.tokenUsage.outputTokens || 0),
        lastTotal: Number(recovered.tokenUsage.lastTotal || 0),
        lastInputTokens: Number(recovered.tokenUsage.lastInputTokens || 0),
        lastCachedInputTokens: Number(recovered.tokenUsage.lastCachedInputTokens || 0),
        lastOutputTokens: Number(recovered.tokenUsage.lastOutputTokens || 0)
      });
    }
    if (!tokenState.rateLimits && recovered.tokenUsage.rateLimits) {
      tokenState.rateLimits = recovered.tokenUsage.rateLimits;
    }
  };

  const reportTokenUsage = ({ final = false } = {}) => {
    const taskTokens = fallbackUsage.total + Number(tokenState.total || 0);
    const taskGrossTokens = fallbackUsage.grossTotal + Number(tokenState.grossTotal || tokenState.total || 0);
    const taskInputTokens = fallbackUsage.inputTokens + Number(tokenState.inputTokens || 0);
    const taskCachedInputTokens = fallbackUsage.cachedInputTokens + Number(tokenState.cachedInputTokens || 0);
    const taskOutputTokens = fallbackUsage.outputTokens + Number(tokenState.outputTokens || 0);
    const cumulativeTokens = tokenOffset + taskTokens;
    const cumulativeGrossTokens = grossTokenOffset + taskGrossTokens;
    const cumulativePromptCharacters = promptCharacterOffset + promptCharacters;
    const agentCumulativeTokens = agentTokenOffset + taskTokens;
    if (typeof options.onTokenUsage === "function") {
      options.onTokenUsage({
        total: cumulativeTokens,
        grossTotal: cumulativeGrossTokens,
        inputTokens: inputTokenOffset + taskInputTokens,
        cachedInputTokens: cachedInputTokenOffset + taskCachedInputTokens,
        outputTokens: outputTokenOffset + taskOutputTokens,
        promptCharacters: cumulativePromptCharacters,
        estimatedPromptTokens: Math.ceil(cumulativePromptCharacters / 3),
        lastTotal: Number(tokenState.lastTotal || 0),
        rateLimits: tokenState.rateLimits,
        agent,
        agentTotal: agentCumulativeTokens,
        agentDelta: taskTokens,
        agentGrossDelta: taskGrossTokens,
        final: Boolean(final)
      });
    }
    if (final && taskTokens > 0 && !finalTokenUsageLogged) {
      finalTokenUsageLogged = true;
      log(`${agentDisplayName(agent)} 토큰 사용량: ${agentCumulativeTokens.toLocaleString()} tokens`, "info", agent);
    }
  };

  const handleOutputLine = (line, level = "info") => {
    const text = stripAnsi(line).trim();
    if (!text) return;

    const parsedJson = tryParseJsonLine(text);
    if (parsedJson) {
      const parsedRateLimits = jsonRateLimits(parsedJson);
      if (parsedRateLimits) {
        tokenState.rateLimits = parsedRateLimits;
      }
      const parsedUsage = jsonTokenUsage(parsedJson);
      if (parsedUsage || parsedRateLimits) {
        if (parsedUsage) {
          Object.assign(tokenState, {
            total: Number(parsedUsage.total || 0),
            grossTotal: Number(parsedUsage.grossTotal || parsedUsage.total || 0),
            inputTokens: Number(parsedUsage.inputTokens || 0),
            cachedInputTokens: Number(parsedUsage.cachedInputTokens || 0),
            outputTokens: Number(parsedUsage.outputTokens || 0),
            lastTotal: Number(parsedUsage.lastTotal || 0),
            lastInputTokens: Number(parsedUsage.lastInputTokens || 0),
            lastCachedInputTokens: Number(parsedUsage.lastCachedInputTokens || 0),
            lastOutputTokens: Number(parsedUsage.lastOutputTokens || 0)
          });
        }
        reportTokenUsage();
      }
      for (const assistantText of extractAssistantOutputTexts(parsedJson)) {
        String(assistantText || "")
          .split(/\r?\n/)
          .forEach((nestedLine) => {
            const assistantProgress = parseProgressLine(nestedLine, options);
            if (assistantProgress) {
              log(`Codex 단계: ${assistantProgress}`, "info", agent);
            }
          });
      }
      return;
    }

    const progress = parseProgressLine(text, options);
    if (progress) {
      log(`Codex 단계: ${progress}`, "info", agent);
      return;
    }

    const parsedTokens = parseTokenLine(text, tokenState);
    if (parsedTokens !== null) {
      tokenState.total = parsedTokens;
      tokenState.grossTotal = parsedTokens;
      reportTokenUsage();
      return;
    }

    if (/^user$/i.test(text)) {
      outputState.section = "user";
      return;
    }
    if (/^assistant$/i.test(text)) {
      outputState.section = "assistant";
      return;
    }
    if (outputState.section === "user") {
      return;
    }
    if (outputState.section === "assistant") {
      return;
    }
    if (shouldForwardRawCodexOutput(options) && isUsefulCodexFeedback(text) && !shouldSuppressWriterFeedback(agent, level)) {
      log(text, level, agent);
    }
  };

  const executeCodex = () => new Promise((resolve, reject) => {
    const codexModel = normalizeCodexModel(options.codexModel);
    const args = [
      "exec",
      "--json",
      "--approve-for-me",
      "--skip-git-repo-check",
      ...(codexModel ? ["--model", codexModel] : []),
      "-c",
      `model_reasoning_effort=${taskEffort}`,
      "-"
    ];
    const child = spawn(options.codexCmdPath, args, {
      cwd: options.jobDir,
      windowsHide: false,
      shell: shouldRunCodexViaShell(options.codexCmdPath)
    });

    let settled = false;
    const taskTimeoutMs = Number(options.codexTaskTimeoutMs || DEFAULT_CODEX_TASK_TIMEOUT_MS);
    let timeoutHandle = null;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (error) reject(error);
      else resolve();
    };

    const streamBuffers = { info: "", warn: "" };
    const diagnosticLines = [];
    const rememberDiagnosticLine = (line) => {
      const text = stripAnsi(line).trim();
      if (!text) return;
      diagnosticLines.push(text);
      while (diagnosticLines.length > 8) diagnosticLines.shift();
    };
    const processOutputLine = (line, level = "info") => {
      if (settled) return;
      rememberDiagnosticLine(line);
      const limitSignal = detectCodexUsageLimitSignal(line);
      if (limitSignal) {
        const parsedLimitJson = tryParseJsonLine(stripAnsi(line).trim());
        const limitRateLimits = parsedLimitJson ? jsonRateLimits(parsedLimitJson) : null;
        if (limitRateLimits) {
          tokenState.rateLimits = limitRateLimits;
          reportTokenUsage();
        }
        const limitError = createCodexUsageLimitError(limitSignal.type, limitSignal.detail);
        log(limitError.message, "error", agent);
        child.kill();
        settle(limitError);
        return;
      }
      handleOutputLine(line, level);
    };

    const handleChunk = (chunk, level = "info") => {
      const key = level === "warn" ? "warn" : "info";
      streamBuffers[key] += String(chunk);
      const lines = streamBuffers[key].split(/\r?\n/);
      streamBuffers[key] = lines.pop() || "";
      for (const line of lines) {
        processOutputLine(line, level);
      }
    };

    const flushStreamBuffers = () => {
      for (const [key, buffered] of Object.entries(streamBuffers)) {
        if (!buffered) continue;
        streamBuffers[key] = "";
        processOutputLine(buffered, key === "warn" ? "warn" : "info");
      }
    };

    child.stdout.on("data", (chunk) => handleChunk(chunk));
    child.stderr.on("data", (chunk) => handleChunk(chunk, "warn"));
    child.stdin.end(prompt);
    child.on("error", (error) => settle(createCodexExecutionError(
      `codex.cmd 실행 실패: ${error.message}`,
      { model: codexModel, detail: diagnosticLines.join("\n") }
    )));
    child.on("close", (code) => {
      flushStreamBuffers();
      if (code === 0) settle();
      else settle(createCodexExecutionError(
        `codex.cmd가 종료 코드 ${code}로 실패했습니다.`,
        { model: codexModel, detail: diagnosticLines.join("\n") }
      ));
    });
    if (taskTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        const timeoutError = createCodexExecutionError(
          `${agentDisplayName(agent)} 실행이 ${Math.ceil(taskTimeoutMs / 60000)}분 제한시간을 초과했습니다.`,
          { model: codexModel, detail: diagnosticLines.join("\\n") }
        );
        log(timeoutError.message, "warn", agent);
        child.kill();
        settle(timeoutError);
      }, taskTimeoutMs);
    }
  });

  try {
    taskStartedAt = Date.now();
    await executeCodex();
  } catch (error) {
    if (isCodexUsageLimitError(error)) {
      throw error;
    }
    if (taskEffort !== "xhigh") {
      throw error;
    }
    recoverTokenUsageFromSession();
    fallbackUsage.total += Number(tokenState.total || 0);
    fallbackUsage.grossTotal += Number(tokenState.grossTotal || tokenState.total || 0);
    fallbackUsage.inputTokens += Number(tokenState.inputTokens || 0);
    fallbackUsage.cachedInputTokens += Number(tokenState.cachedInputTokens || 0);
    fallbackUsage.outputTokens += Number(tokenState.outputTokens || 0);
    fallbackUsage.rateLimits = tokenState.rateLimits || fallbackUsage.rateLimits;
    log("xhigh 호출이 실패하여 high로 낮춰 다시 실행합니다.", "warn", agent);
    taskEffort = "high";
    tokenState.awaitingValue = false;
    tokenState.total = 0;
    tokenState.grossTotal = 0;
    tokenState.inputTokens = 0;
    tokenState.cachedInputTokens = 0;
    tokenState.outputTokens = 0;
    tokenState.lastTotal = 0;
    tokenState.lastInputTokens = 0;
    tokenState.lastCachedInputTokens = 0;
    tokenState.lastOutputTokens = 0;
    tokenState.rateLimits = null;
    finalTokenUsageLogged = false;
    removeAgentResultFile(options.jobDir, resultFileName);
    taskStartedAt = Date.now();
    await executeCodex();
  }
  recoverTokenUsageFromSession();
  reportTokenUsage({ final: true });

  return {
    ...readAgentResult(options.jobDir, resultFileName),
    tokenUsage: {
      total: fallbackUsage.total + Number(tokenState.total || 0),
      grossTotal: fallbackUsage.grossTotal + Number(tokenState.grossTotal || tokenState.total || 0),
      inputTokens: fallbackUsage.inputTokens + Number(tokenState.inputTokens || 0),
      cachedInputTokens: fallbackUsage.cachedInputTokens + Number(tokenState.cachedInputTokens || 0),
      outputTokens: fallbackUsage.outputTokens + Number(tokenState.outputTokens || 0),
      lastTotal: tokenState.lastTotal,
      lastInputTokens: tokenState.lastInputTokens,
      lastCachedInputTokens: tokenState.lastCachedInputTokens,
      lastOutputTokens: tokenState.lastOutputTokens,
      rateLimits: tokenState.rateLimits || fallbackUsage.rateLimits,
      promptCharacters,
      estimatedPromptTokens
    }
  };
}

async function fetchCodexUsageSnapshot({
  codexCmdPath = "codex.cmd",
  cwd = process.cwd(),
  timeoutMs = 30000
} = {}) {
  const sessionSnapshot = readLatestCodexRateLimitsFromSessions();
  if (sessionSnapshot?.rateLimits) {
    return sessionSnapshot;
  }

  return new Promise((resolve) => {
    const child = spawn(codexCmdPath, [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "-c",
      "model_reasoning_effort=low",
      "-"
    ], {
      cwd,
      windowsHide: true,
      shell: shouldRunCodexViaShell(codexCmdPath)
    });

    let settled = false;
    let latestRateLimits = null;
    let latestTokens = 0;
    let timer = null;
    const finish = (unavailableReason = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!child.killed) {
        child.kill();
      }
      const fallbackSnapshot = readLatestCodexRateLimitsFromSessions();
      if (!latestRateLimits && fallbackSnapshot?.rateLimits) {
        resolve(fallbackSnapshot);
        return;
      }
      if (unavailableReason) {
        resolve({
          source: "unavailable",
          unavailableReason,
          tokenUsage: {
            total: latestTokens,
            rateLimits: null
          },
          rateLimits: null
        });
        return;
      }
      resolve({
        source: "codex-exec",
        tokenUsage: {
          total: latestTokens,
          rateLimits: latestRateLimits
        },
        rateLimits: latestRateLimits
      });
    };
    timer = setTimeout(() => {
      if (latestRateLimits) {
        finish();
      } else {
        finish("Codex 사용량 정보를 제한 시간 안에 읽지 못했습니다.");
      }
    }, timeoutMs);

    const handleChunk = (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .forEach((line) => {
          if (settled) return;
          const text = stripAnsi(line).trim();
          if (!text) return;
          const parsed = tryParseJsonLine(text);
          if (!parsed) return;
          const parsedTokens = jsonTokenTotal(parsed);
          if (parsedTokens !== null) {
            latestTokens = parsedTokens;
          }
          const parsedRateLimits = jsonRateLimits(parsed);
          if (parsedRateLimits) {
            latestRateLimits = parsedRateLimits;
            finish();
          }
        });
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.on("error", (error) => finish(`codex.cmd 사용량 확인 실패: ${error.message}`));
    child.on("close", (code) => {
      if (settled) return;
      if (latestRateLimits) {
        finish();
      } else {
        const reason = code === 0
          ? "codex.cmd 사용량 조회는 정상 종료됐지만 rate_limits가 포함되지 않아 배지를 갱신하지 못했습니다."
          : `codex.cmd 사용량 조회가 종료 코드 ${code}로 끝났고 rate_limits가 포함되지 않아 배지를 갱신하지 못했습니다.`;
        finish(reason);
      }
    });
    child.stdin.end("Return exactly OK.");
  });
}

async function runCodexGeneration(options, log = () => {}) {
  const resumeState = options?.resumeState && typeof options.resumeState === "object"
    ? options.resumeState
    : null;
  const resumeFrom = String(resumeState?.resumeFrom || "").trim().toLowerCase();
  const resumePrompt = String(resumeState?.repairPrompt || options?.resumePrompt || "").trim();
  const recoveryContext = formatRecoveryGuidance(options?.recoveryGuidance);
  const checkpoint = (payload = {}) => {
    if (typeof options?.onCheckpoint !== "function") return;
    try {
      options.onCheckpoint({
        status: "running",
        ...payload
      });
    } catch (error) {
      log(`재개 체크포인트 저장을 건너뛰었습니다: ${error.message}`, "warn", "main");
    }
  };
  let effectiveOptions = {
    ...options,
    codexModel: normalizeCodexModel(options.codexModel),
    agentModels: normalizeAgentModels(options.agentModels),
    searchResults: Array.isArray(options.searchResults) ? options.searchResults : [],
    sourceQuality: options.sourceQuality || { status: "not_requested" },
    recoveryGuidance: Array.isArray(options.recoveryGuidance) ? options.recoveryGuidance : [],
    researchRevisionContext: [
      resumeFrom === "research" && resumePrompt
        ? `사용자가 입력한 오류 해결 지시입니다. 이 지시를 반영해 이전 실패 지점부터 다시 확인하세요.\n${resumePrompt}`
        : "",
      options.researchRevisionContext || "",
      recoveryContext ? `이전에 성공한 복구 해결책입니다. 참고만 하고 현재 근거와 검수 규칙을 우선하세요.\n${recoveryContext}` : ""
    ].filter(Boolean).join("\n\n")
  };
  const agentTokenTotals = {
    main: 0,
    research: 0,
    writer: 0,
    image: 0,
    imageStyle: 0
  };
  const agentGrossTokenTotals = {
    main: 0,
    research: 0,
    writer: 0,
    image: 0,
    imageStyle: 0
  };
  let totalTokens = 0;
  let totalGrossTokens = 0;
  let totalInputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalOutputTokens = 0;
  let totalPromptCharacters = 0;
  const agentPromptCharacters = {
    main: 0,
    research: 0,
    writer: 0,
    image: 0,
    imageStyle: 0
  };
  let latestRateLimits = null;
  const rememberRateLimits = (result) => {
    if (result?.tokenUsage?.rateLimits) {
      latestRateLimits = result.tokenUsage.rateLimits;
    }
  };
  const recordTaskUsage = (result, agent) => {
    const usage = result?.tokenUsage || {};
    const total = Number(usage.total || 0);
    const grossTotal = Number(usage.grossTotal || total || 0);
    totalTokens += total;
    totalGrossTokens += grossTotal;
    totalInputTokens += Number(usage.inputTokens || 0);
    totalCachedInputTokens += Number(usage.cachedInputTokens || 0);
    totalOutputTokens += Number(usage.outputTokens || 0);
    totalPromptCharacters += Number(usage.promptCharacters || 0);
    if (Object.prototype.hasOwnProperty.call(agentTokenTotals, agent)) {
      agentTokenTotals[agent] += total;
      agentGrossTokenTotals[agent] += grossTotal;
      agentPromptCharacters[agent] += Number(usage.promptCharacters || 0);
    }
    rememberRateLimits(result);
  };
  const tokenUsageSnapshot = () => ({
    total: totalTokens,
    grossTotal: totalGrossTokens,
    inputTokens: totalInputTokens,
    cachedInputTokens: totalCachedInputTokens,
    outputTokens: totalOutputTokens,
    promptCharacters: totalPromptCharacters,
    estimatedPromptTokens: Math.ceil(totalPromptCharacters / 3),
    rateLimits: latestRateLimits,
    agents: { ...agentTokenTotals },
    grossAgents: { ...agentGrossTokenTotals },
    promptCharactersByAgent: { ...agentPromptCharacters }
  });
  const duplicateTitleOutcome = async (title, researchResult) => {
    if (typeof options.onFinalTitleCandidate !== "function") return null;
    const verdict = await options.onFinalTitleCandidate(title, researchResult);
    if (!verdict?.duplicate) return null;
    return {
      status: "duplicate_retry",
      failurePhase: "title_duplicate",
      failureReason: String(verdict.reason || "기존 제목과 유사해 본문 및 이미지 생성을 시작하지 않았습니다."),
      duplicateSimilarity: Number(verdict.similarity || 0),
      title,
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: [String(verdict.reason || "기존 제목과 유사함")],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  };

  const accountImageStyle = effectiveOptions.accountImageStyle || {};
  const sampleImagePath = String(accountImageStyle.sampleImagePath || "").trim();
  let accountImageStylePrompt = sampleImagePath ? String(accountImageStyle.imageStylePrompt || "").trim() : "";
  const sampleImageHash = String(accountImageStyle.sampleImageHash || "").trim();
  const sourceHash = String(accountImageStyle.imageStylePromptSourceImageHash || "").trim();
  const styleStatus = String(accountImageStyle.imageStylePromptStatus || "").trim();
  const needsStylePrompt = sampleImagePath
    && (!accountImageStylePrompt || styleStatus === "missing" || styleStatus === "stale" || styleStatus === "failed" || (sourceHash && sampleImageHash && sourceHash !== sampleImageHash));
  if (needsStylePrompt) {
    log("Image Style Agent sample image analysis start", "info", "imageStyle");
    const styleResult = await runCodexTask({
      options: effectiveOptions,
      prompt: buildImageStylePrompt({
        jobDir: effectiveOptions.jobDir,
        sampleImagePath,
        sampleImageHash
      }),
      promptFileName: "image-style-prompt.txt",
      resultFileName: "image-style-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      inputTokenOffset: totalInputTokens,
      cachedInputTokenOffset: totalCachedInputTokens,
      outputTokenOffset: totalOutputTokens,
      promptCharacterOffset: totalPromptCharacters,
      agentTokenOffset: agentTokenTotals.imageStyle,
      agent: "imageStyle"
    });
    recordTaskUsage(styleResult, "imageStyle");
    const generatedStylePrompt = String(styleResult.imageStylePrompt || "").trim();
    if (String(styleResult.status || "").toLowerCase() === "success" && generatedStylePrompt) {
      accountImageStylePrompt = generatedStylePrompt;
      log("Image Style Agent sample image analysis complete", "info", "imageStyle");
      if (typeof options.onAccountImageStylePrompt === "function") {
        options.onAccountImageStylePrompt({
          status: "success",
          imageStylePrompt: accountImageStylePrompt,
          sampleImageHash
        });
      }
    } else {
      const failureReason = String(styleResult.failureReason || "Image style prompt generation failed.").trim();
      accountImageStylePrompt = "";
      log(`Image Style Agent failed: ${failureReason}`, "warn", "imageStyle");
      if (typeof options.onAccountImageStylePrompt === "function") {
        options.onAccountImageStylePrompt({
          status: "failed",
          imageStylePrompt: "",
          sampleImageHash,
          failureReason
        });
      }
    }
  }
  effectiveOptions = {
    ...effectiveOptions,
    accountImageStylePrompt
  };

  let researchResult;
  const isPostResearchResume = Boolean(resumeFrom && resumeFrom !== "research");
  if (resumeFrom !== "research" && resumeState?.researchTitleResult && typeof resumeState.researchTitleResult === "object") {
    researchResult = { ...resumeState.researchTitleResult };
    log("저장된 Research/Title 결과를 사용해 중단된 작업을 이어갑니다.", "info", "research");
    if (typeof options.onResearchTitle === "function") options.onResearchTitle(researchResult);
  } else {
    researchResult = await runCodexTask({
      options: effectiveOptions,
      prompt: resumeFrom === "research" && resumeState?.researchTitleResult
        ? buildResearchTitleRetryPrompt(effectiveOptions, resumeState.researchTitleResult)
        : buildResearchTitlePrompt(effectiveOptions),
      promptFileName: resumeFrom === "research" ? "research-title-resume-prompt.txt" : "research-title-prompt.txt",
      resultFileName: "research-title-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      inputTokenOffset: totalInputTokens,
      cachedInputTokenOffset: totalCachedInputTokens,
      outputTokenOffset: totalOutputTokens,
      promptCharacterOffset: totalPromptCharacters,
      agentTokenOffset: agentTokenTotals.research,
      agent: "research"
    });

    recordTaskUsage(researchResult, "research");
    log(`Research/Title Agent 분석 완료: ${String(researchResult.status || "UNKNOWN").toUpperCase()}`, "info", "research");
    if (typeof options.onResearchTitle === "function") {
      options.onResearchTitle(researchResult);
    }
    checkpoint({
      resumeFrom: ["PASS", "SUCCESS"].includes(String(researchResult.status || "").toUpperCase())
        ? "writer"
        : "research",
      lastCompletedPhase: ["PASS", "SUCCESS"].includes(String(researchResult.status || "").toUpperCase())
        ? "research"
        : "",
      phaseDetail: "Research/Title 결과 저장 완료"
    });
  }

  let researchStatus = String(researchResult.status || "").toUpperCase();
  let requestedSearchNeed = String(researchResult.searchNeed || "").toLowerCase();
  const validSearchNeeds = new Set(["skip", "light", "normal", "strict"]);
  if (effectiveOptions.sourceMode === "file_upload") {
    researchResult = {
      ...researchResult,
      searchNeed: "skip",
      searchQueries: [],
      searchFlowSummary: "사용자 업로드 파일만을 사실 근거로 사용했습니다. 웹 검색은 실행하지 않았습니다."
    };
    requestedSearchNeed = "skip";
    log("파일 원문 기반 생성: 웹 검색을 실행하지 않습니다.", "info", "research");
    if (effectiveOptions.allowHistoricalFileDraft === true && researchStatus !== "PASS") {
      researchResult = {
        ...researchResult,
        status: "PASS",
        failureReason: "",
        searchNeed: "skip",
        currentBridgeRequired: false,
        currentBridgeSatisfied: true,
        finalTitle: researchResult.finalTitle || researchResult.selectedTitle || effectiveOptions.topic || "파일 원문 기반 글",
        selectedTitle: researchResult.selectedTitle || researchResult.finalTitle || effectiveOptions.topic || "파일 원문 기반 글",
        notes: compactTextList([
          researchResult.notes,
          "사용자 요청에 따른 과거 원문 복구 모드입니다. 원문 날짜와 사실 범위를 현재 사실로 확대하지 않습니다."
        ])
      };
      researchStatus = "PASS";
      requestedSearchNeed = "skip";
      log("과거 파일 원문 복구 모드로 Research/Title 보류를 해제하고 원문 범위 내 초안을 생성합니다.", "warn", "research");
    }
  }
  if (!isPostResearchResume && effectiveOptions.forceWebSearch === true && effectiveOptions.sourceMode !== "file_upload") {
    const forcedNeed = ["light", "normal", "strict"].includes(String(effectiveOptions.forcedSearchNeed || "").toLowerCase())
      ? String(effectiveOptions.forcedSearchNeed).toLowerCase()
      : "normal";
    if (!["light", "normal", "strict"].includes(requestedSearchNeed)) {
      researchResult = {
        ...researchResult,
        status: "REVISION",
        searchNeed: forcedNeed,
        searchQueries: Array.isArray(researchResult.searchQueries) && researchResult.searchQueries.length
          ? researchResult.searchQueries
          : [[effectiveOptions.keyword || effectiveOptions.topic || effectiveOptions.category].filter(Boolean).join(" ")]
      };
      researchStatus = "REVISION";
      requestedSearchNeed = forcedNeed;
      log("예약 웹 검색 모드가 켜져 있어 Research/Title Agent의 검색 생략 판단을 보정합니다.", "info", "research");
    }
  }
  let needsSearch = ["light", "normal", "strict"].includes(requestedSearchNeed);
  const maxResearchSearchRounds = 2;
  let researchSearchRound = 0;
  while (
    !isPostResearchResume
    &&
    needsSearch
    && typeof options.onSearchNeeded === "function"
    && researchSearchRound < maxResearchSearchRounds
    && (
      effectiveOptions.searchResults.length === 0
      || (
        ["REVISION", "BLOCK"].includes(researchStatus)
        && isResearchSourceFailure(researchResult)
      )
      || isAuthoritySourceQualityFailure(effectiveOptions.sourceQuality)
    )
  ) {
    researchSearchRound += 1;
    const searchRoundLabel = researchSearchRound === 1
      ? `Research/Title Agent 검색 필요 판단: ${requestedSearchNeed}`
      : `Research/Title Agent 근거 부족으로 보강 재검색 (${researchSearchRound}/${maxResearchSearchRounds}): ${requestedSearchNeed}`;
    log(searchRoundLabel, "info", "research");
    preserveAgentFile(
      options.jobDir,
      "research-title-prompt.txt",
      researchSearchRound === 1 ? "research-title-initial-prompt.txt" : `research-title-before-search-${researchSearchRound}.txt`
    );
    preserveAgentFile(
      options.jobDir,
      "research-title-result.json",
      researchSearchRound === 1 ? "research-title-initial-result.json" : `research-title-before-search-${researchSearchRound}.json`
    );
    const searchPayload = await options.onSearchNeeded(researchResult, {
      round: researchSearchRound,
      previousSearchResults: effectiveOptions.searchResults,
      sourceQuality: effectiveOptions.sourceQuality
    });
    effectiveOptions = {
      ...effectiveOptions,
      searchResults: Array.isArray(searchPayload?.searchResults) ? searchPayload.searchResults : [],
      sourceQuality: searchPayload?.sourceQuality || { status: "unknown" }
    };
    try {
      researchResult = await runCodexTask({
        options: effectiveOptions,
        prompt: buildResearchTitleRetryPrompt(effectiveOptions, researchResult),
        promptFileName: researchSearchRound === 1 ? "research-title-prompt.txt" : `research-title-search-${researchSearchRound}-prompt.txt`,
        resultFileName: "research-title-result.json",
        log,
        tokenOffset: totalTokens,
        grossTokenOffset: totalGrossTokens,
        inputTokenOffset: totalInputTokens,
        cachedInputTokenOffset: totalCachedInputTokens,
        outputTokenOffset: totalOutputTokens,
        promptCharacterOffset: totalPromptCharacters,
        agentTokenOffset: agentTokenTotals.research,
        agent: "research"
      });
      if (researchSearchRound > 1) {
        preserveAgentFile(
          options.jobDir,
          "research-title-result.json",
          `research-title-search-${researchSearchRound}-result.json`
        );
      }
    } catch (error) {
      if (!isMissingCodexResultFileError(error)) {
        throw error;
      }
      const reason = compactTextList([
        "추가 검색 후 Research/Title Agent가 결과 파일을 생성하지 못했습니다.",
        effectiveOptions.sourceQuality?.reason,
        researchResult?.failureReason
      ]).join(" / ");
      log(reason, "warn", "research");
      researchResult = {
        ...researchResult,
        status: researchStatus || researchResult?.status || "BLOCK",
        failureReason: researchResult?.failureReason || reason,
        notes: compactTextList([researchResult?.notes, reason])
      };
      break;
    }
    recordTaskUsage(researchResult, "research");
    log(`Research/Title Agent 재분석 완료: ${String(researchResult.status || "UNKNOWN").toUpperCase()}`, "info", "research");
    if (typeof options.onResearchTitle === "function") {
      options.onResearchTitle(researchResult);
    }
    checkpoint({
      resumeFrom: ["PASS", "SUCCESS"].includes(String(researchResult.status || "").toUpperCase())
        ? "writer"
        : "research",
      lastCompletedPhase: ["PASS", "SUCCESS"].includes(String(researchResult.status || "").toUpperCase())
        ? "research"
        : "",
      phaseDetail: `Research/Title 검색 ${researchSearchRound}차 결과 저장 완료`
    });
    researchStatus = String(researchResult.status || "").toUpperCase();
    requestedSearchNeed = String(researchResult.searchNeed || "").toLowerCase();
    needsSearch = ["light", "normal", "strict"].includes(requestedSearchNeed);
  }

  const safeGeneralTopicFallback = buildSafeGeneralTopicFallback(effectiveOptions, researchResult);
  if (safeGeneralTopicFallback) {
    researchResult = safeGeneralTopicFallback;
    researchStatus = "PASS";
    requestedSearchNeed = "normal";
    needsSearch = true;
    log("구체적인 최신 정책 근거가 부족하지만 검색 후보가 충분해 안전한 일반 설명 모드로 전환합니다. 본문·이미지 생성과 최종 검수는 계속 진행합니다.", "warn", "research");
    if (typeof options.onResearchTitle === "function") options.onResearchTitle(researchResult);
    checkpoint({
      resumeFrom: "writer",
      lastCompletedPhase: "research",
      phaseDetail: "안전 일반 설명용 Research/Title 결과 저장 완료"
    });
  }

  const authoritySourceIssue = safeGeneralTopicFallback
    ? ""
    : authoritySourceQualityIssueReason(effectiveOptions.sourceQuality);
  if (authoritySourceIssue) {
    log(`Research/Title Agent 공식 근거 보강 실패: ${authoritySourceIssue}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: authoritySourceIssue,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([authoritySourceIssue, researchResult.notes]),
      researchTitleResult: {
        ...researchResult,
        status: researchStatus === "PASS" ? "REVISION" : researchResult.status,
        failureReason: researchResult.failureReason || authoritySourceIssue
      },
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (!validSearchNeeds.has(requestedSearchNeed)) {
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: "Research/Title Agent가 검색 필요 수준을 명확히 판단하지 못했습니다.",
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (needsSearch && effectiveOptions.searchResults.length === 0) {
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: "Research/Title Agent가 검색이 필요하다고 판단했지만 사용할 수 있는 검색 후보가 확보되지 않았습니다.",
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (requestedSearchNeed === "skip" && effectiveOptions.searchResults.length === 0) {
    effectiveOptions = {
      ...effectiveOptions,
      sourceQuality: {
        status: "skipped",
        reason: "Research/Title Agent가 외부 검색 없이 진행 가능하다고 판단했습니다."
      }
    };
  }

  if (researchStatus === "BLOCK" || String(researchResult.status || "").toLowerCase() === "failed") {
    const researchReason = researchResult.failureReason || "Research/Title Agent가 본문 작성 가능한 제목을 만들지 못했습니다.";
    log(`Research/Title Agent 중단: ${researchReason}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: researchReason,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (researchStatus === "REVISION") {
    const researchReason = researchRevisionReason(researchResult);
    log(`Research/Title Agent가 본문 작성 가능 상태가 아닙니다: ${researchReason}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: researchReason,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([researchReason, researchResult.notes]),
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  const currentBridgeIssue = currentBridgeIssueReason(researchResult);
  if (currentBridgeIssue) {
    log(`Research/Title Agent ?꾩옱???뚯쓣 ?뺤씤?섏? 紐삵뻽?듬땲?? ${currentBridgeIssue}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: currentBridgeIssue,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([currentBridgeIssue, researchResult.notes]),
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  let finalTitle = String(researchResult.finalTitle || "").trim();
  if (!finalTitle) {
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: "Research/Title Agent가 최종 제목을 확정하지 못했습니다.",
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (!resumeState) {
    const earlyDuplicateResult = await duplicateTitleOutcome(finalTitle, researchResult);
    if (earlyDuplicateResult) return earlyDuplicateResult;
  } else {
    log("이어받기 모드에서는 기존 제목 중복 검사를 건너뛰고 저장된 초안을 수정합니다.", "info", "main");
  }

  const refineWriterContract = async (promptFileName = "writer-contract-prompt.txt") => {
    const draftWriterContract = buildWriterContract(researchResult, {
      topic: finalTitle || effectiveOptions.topic,
      finalTitle,
      preferredTone: effectiveOptions.preferredTone || ""
    });
    log("Main Agent Writer Contract 의미 정리 시작", "info", "main");
    const contractResult = await runCodexTask({
      options: effectiveOptions,
      prompt: buildWriterContractRefinementPrompt({
        jobDir: effectiveOptions.jobDir,
        researchTitleResult: researchResult,
        draftWriterContract,
        sourceQuality: effectiveOptions.sourceQuality
      }),
      promptFileName,
      resultFileName: "writer-contract-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      inputTokenOffset: totalInputTokens,
      cachedInputTokenOffset: totalCachedInputTokens,
      outputTokenOffset: totalOutputTokens,
      promptCharacterOffset: totalPromptCharacters,
      agentTokenOffset: agentTokenTotals.main,
      agent: "main"
    });
    recordTaskUsage(contractResult, "main");
    const contractStatus = String(contractResult.status || "").toLowerCase();
    if (contractStatus !== "success" || !contractResult.writerContract || typeof contractResult.writerContract !== "object") {
      return {
        ok: false,
        reason: String(contractResult.failureReason || "Main Agent가 Writer Contract를 발행 가능한 의미 구조로 정리하지 못했습니다.").trim(),
        result: contractResult
      };
    }
    researchResult = {
      ...researchResult,
      writerContract: contractResult.writerContract,
      writerContractRefined: true,
      notes: compactTextList([researchResult.notes, contractResult.notes])
    };
    log("Main Agent Writer Contract 의미 정리 완료", "info", "main");
    return { ok: true, result: contractResult };
  };

  const initialContractRefinement = resumeState?.researchTitleResult?.writerContract
    ? { ok: true, result: null }
    : await refineWriterContract();
  if (!initialContractRefinement.ok) {
    return {
      status: "failed",
      failurePhase: "main_review",
      failureReason: initialContractRefinement.reason,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([initialContractRefinement.reason, initialContractRefinement.result?.notes]),
      researchTitleResult: researchResult,
      mainReviewResult: initialContractRefinement.result,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  const imageContractEnabled = effectiveOptions.includeTitleImage !== false
    || normalizeMaxBodyImages(effectiveOptions.maxBodyImages) > 0;
  const maxReviewAttempts = resumeState
    ? Math.max(3, Number(resumeState.maxReviewAttempts || 3))
    : String(effectiveOptions.topicMode || "").toLowerCase() === "auto"
      ? 3
      : imageContractEnabled ? 3 : 2;
  const firstReviewAttempt = resumeState
    ? (resumeFrom === "writer" || (resumeFrom === "main_review" && resumePrompt))
      ? Math.min(maxReviewAttempts, 2)
      : Math.min(maxReviewAttempts, Math.max(2, Number(resumeState.nextAttempt || 3)))
    : 1;
  let writerResult = resumeState?.writerResult || null;
  let mainReviewResult = null;
  let mainReviewStatus = "";
  const resumeNeedsWriterRepair = resumeFrom === "main_review"
    && Boolean(resumePrompt)
    && writerResult
    && typeof writerResult === "object";
  let resumeAtReview = resumeFrom === "main_review"
    && !resumeNeedsWriterRepair
    && writerResult
    && typeof writerResult === "object";
  let writerRevisionFeedback = [String(resumeState?.reviewFeedback || "").trim(), resumePrompt]
    .filter(Boolean)
    .join(" / ");
  let writerSupplementSearchUsed = false;

  if (resumeNeedsWriterRepair) {
    log("오류 해결 프롬프트를 반영해 저장된 본문을 Writer가 먼저 수정한 뒤 Main 검수를 재개합니다.", "info", "writer");
  }

  const resumeAtImage = resumeFrom === "image"
    && writerResult
    && typeof writerResult === "object";
  if (resumeAtImage) {
    mainReviewResult = resumeState.mainReviewResult && typeof resumeState.mainReviewResult === "object"
      ? resumeState.mainReviewResult
      : { status: "PASS", resumed: true };
    mainReviewStatus = String(mainReviewResult.status || "PASS").toUpperCase();
    log("저장된 본문과 최종 검수 결과를 사용해 이미지 생성 단계부터 이어갑니다.", "info", "main");
  }

  if (!resumeAtImage) for (let attempt = firstReviewAttempt; attempt <= maxReviewAttempts; attempt += 1) {
    if (!resumeAtReview) {
    checkpoint({
      resumeFrom: "writer",
      failurePhase: "writer",
      lastCompletedPhase: "research",
      attempt,
      phaseDetail: `Writer Agent 실행 준비 (${attempt}차)`
    });
    log(`Writer Agent 본문 작성 시작 (${attempt}/${maxReviewAttempts})`, "info", "writer");
    writerResult = await runCodexTask({
      options: effectiveOptions,
      prompt: attempt === 1 && !resumeState
        ? buildPrompt({
          ...effectiveOptions,
          topic: finalTitle || options.topic,
          researchTitleResult: researchResult,
          writerRevisionFeedback,
          writerAttempt: attempt,
          maxWriterAttempts: maxReviewAttempts
        })
        : buildWriterRetryPrompt({
          ...effectiveOptions,
          topic: finalTitle || options.topic,
          researchTitleResult: researchResult,
          writerRevisionFeedback,
          writerAttempt: attempt,
          maxWriterAttempts: maxReviewAttempts
        }, writerResult),
      promptFileName: resumeState
        ? `prompt-resume-${attempt}.txt`
        : attempt === 1 ? "prompt.txt" : `prompt-retry-${attempt}.txt`,
      resultFileName: "agent-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      inputTokenOffset: totalInputTokens,
      cachedInputTokenOffset: totalCachedInputTokens,
      outputTokenOffset: totalOutputTokens,
      promptCharacterOffset: totalPromptCharacters,
      agentTokenOffset: agentTokenTotals.writer,
      agent: "writer"
    });
    recordTaskUsage(writerResult, "writer");
    checkpoint({
      resumeFrom: "main_review",
      lastCompletedPhase: "writer",
      attempt,
      phaseDetail: `Writer 본문 결과 저장 완료 (${attempt}차)`
    });

    const writerIssueReason = writerOutputIssueReason(writerResult)
      || writerImageContractIssueReason(writerResult, effectiveOptions);
    if (writerIssueReason) {
      log(`Writer Agent 작성 실패: ${writerIssueReason}`, "warn", "writer");
      const writerSourceIssue = isSourceInsufficientWriterIssue(writerIssueReason, writerResult, researchResult);
      if (writerSourceIssue && !writerSupplementSearchUsed && typeof options.onSearchNeeded === "function") {
        writerSupplementSearchUsed = true;
        researchSearchRound += 1;
        const forcedSearchNeed = ["light", "normal", "strict"].includes(requestedSearchNeed)
          ? requestedSearchNeed
          : "normal";
        log(`Writer Agent가 근거 부족을 감지해 Research/Title 보강 검색을 1회 요청합니다: ${writerIssueReason}`, "warn", "main");
        preserveAgentFile(
          options.jobDir,
          attempt === 1 ? "prompt.txt" : `prompt-retry-${attempt}.txt`,
          `writer-source-search-before-prompt-${attempt}.txt`
        );
        preserveAgentFile(
          options.jobDir,
          "agent-result.json",
          `writer-source-search-before-result-${attempt}.json`
        );
        const supplementalResearchResult = {
          ...researchResult,
          status: "REVISION",
          searchNeed: forcedSearchNeed,
          failureReason: compactTextList([
            researchResult.failureReason,
            `Writer Agent 근거 부족: ${writerIssueReason}`
          ]).join(" / "),
          searchFlowSummary: compactTextList([
            researchResult.searchFlowSummary,
            `Writer Agent가 선택 제목을 뒷받침할 직접 근거가 부족하다고 판단했습니다: ${writerIssueReason}`
          ]).join(" / "),
          uncertainItems: compactTextList([
            researchResult.uncertainItems,
            writerIssueReason
          ]),
          notes: compactTextList([
            researchResult.notes,
            `Writer Agent 근거 부족 보강 검색 요청: ${writerIssueReason}`
          ])
        };
        const searchPayload = await options.onSearchNeeded(supplementalResearchResult, {
          round: researchSearchRound,
          previousSearchResults: effectiveOptions.searchResults,
          sourceQuality: effectiveOptions.sourceQuality,
          writerSupplement: true,
          writerIssueReason
        });
        effectiveOptions = {
          ...effectiveOptions,
          searchResults: Array.isArray(searchPayload?.searchResults) ? searchPayload.searchResults : [],
          sourceQuality: searchPayload?.sourceQuality || { status: "unknown" },
          researchRevisionContext: [
            "Writer Agent reported insufficient support after Research/Title PASS.",
            `Writer issue: ${writerIssueReason}`,
            "Re-check whether the selected title, topicThesis, writerContract, confirmedFacts, usableSources, and sourceBoundaries are directly supported by the expanded search candidates.",
            "If the expanded candidates still cannot support the title promise, return REVISION or BLOCK instead of PASS."
          ].join("\n")
        };
        preserveAgentFile(
          options.jobDir,
          "research-title-result.json",
          "research-title-writer-source-search-before-result.json"
        );
        researchResult = await runCodexTask({
          options: effectiveOptions,
          prompt: buildResearchTitleRetryPrompt(effectiveOptions, supplementalResearchResult),
          promptFileName: "research-title-writer-source-search-prompt.txt",
          resultFileName: "research-title-result.json",
          log,
          tokenOffset: totalTokens,
          grossTokenOffset: totalGrossTokens,
          inputTokenOffset: totalInputTokens,
          cachedInputTokenOffset: totalCachedInputTokens,
          outputTokenOffset: totalOutputTokens,
          promptCharacterOffset: totalPromptCharacters,
          agentTokenOffset: agentTokenTotals.research,
          agent: "research"
        });
        preserveAgentFile(
          options.jobDir,
          "research-title-result.json",
          "research-title-writer-source-search-result.json"
        );
        recordTaskUsage(researchResult, "research");
        log(`Research/Title Agent Writer 보강 검색 후 재분석 완료: ${String(researchResult.status || "UNKNOWN").toUpperCase()}`, "info", "research");
        if (typeof options.onResearchTitle === "function") {
          options.onResearchTitle(researchResult);
        }
        researchStatus = String(researchResult.status || "").toUpperCase();
        requestedSearchNeed = String(researchResult.searchNeed || "").toLowerCase();
        needsSearch = ["light", "normal", "strict"].includes(requestedSearchNeed);

        const supplementalAuthorityIssue = authoritySourceQualityIssueReason(effectiveOptions.sourceQuality);
        if (supplementalAuthorityIssue) {
          log(`Research/Title Agent Writer 보강 검색 후에도 공식 근거가 부족합니다: ${supplementalAuthorityIssue}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: supplementalAuthorityIssue,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([supplementalAuthorityIssue, researchResult.notes, writerIssueReason]),
            researchTitleResult: {
              ...researchResult,
              status: researchStatus === "PASS" ? "REVISION" : researchResult.status,
              failureReason: researchResult.failureReason || supplementalAuthorityIssue
            },
            tokenUsage: tokenUsageSnapshot()
          };
        }
        if (researchStatus === "BLOCK" || String(researchResult.status || "").toLowerCase() === "failed") {
          const researchReason = researchResult.failureReason || "Research/Title Agent가 보강 검색 후에도 본문 작성 가능한 제목을 만들지 못했습니다.";
          log(`Research/Title Agent Writer 보강 검색 후 중단: ${researchReason}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: researchReason,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        if (researchStatus === "REVISION") {
          const researchReason = researchRevisionReason(researchResult);
          log(`Research/Title Agent Writer 보강 검색 후에도 본문 작성 가능 상태가 아닙니다: ${researchReason}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: researchReason,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([researchReason, researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        const supplementalCurrentBridgeIssue = currentBridgeIssueReason(researchResult);
        if (supplementalCurrentBridgeIssue) {
          log(`Research/Title Agent Writer 보강 검색 후에도 현재 연결 근거가 부족합니다: ${supplementalCurrentBridgeIssue}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: supplementalCurrentBridgeIssue,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([supplementalCurrentBridgeIssue, researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        finalTitle = String(researchResult.finalTitle || "").trim();
        if (!finalTitle) {
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: "Research/Title Agent가 보강 검색 후에도 최종 제목을 확정하지 못했습니다.",
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        const supplementalDuplicateResult = await duplicateTitleOutcome(finalTitle, researchResult);
        if (supplementalDuplicateResult) return supplementalDuplicateResult;
        const supplementalContractRefinement = await refineWriterContract("writer-contract-writer-source-search-prompt.txt");
        if (!supplementalContractRefinement.ok) {
          return {
            status: "failed",
            failurePhase: "main_review",
            failureReason: supplementalContractRefinement.reason,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([supplementalContractRefinement.reason, supplementalContractRefinement.result?.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            mainReviewResult: supplementalContractRefinement.result,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        writerRevisionFeedback = "";
        attempt = Math.max(0, attempt - 1);
        log(`Writer Agent 근거 보강 후 본문 작성을 다시 시도합니다 (${attempt + 1}/${maxReviewAttempts})`, "warn", "main");
        continue;
      }
      const writerRetryReason = retryableWriterFailureReason(writerResult, researchResult);
      if (writerRetryReason && attempt < maxReviewAttempts) {
        writerRevisionFeedback = writerRetryReason;
        const retryLabel = /date\s*leak|작성일|작성일자|오늘\s*날짜|현재\s*날짜|기준일/i.test(writerRetryReason)
          ? "Writer Agent 날짜/기준일 수정이 필요해 다시 시도합니다"
          : "Writer Agent 결과 수정이 필요해 다시 시도합니다";
        log(`${retryLabel} (${attempt + 1}/${maxReviewAttempts})`, "warn", "main");
        continue;
      }
      return {
        status: "failed",
        failurePhase: "writer",
        failureReason: writerIssueReason,
        title: "",
        article: "",
        tags: [],
        bodyImages: [],
        titleImagePath: "",
        notes: compactTextList([writerIssueReason, writerResult?.notes]),
        researchTitleResult: researchResult,
        tokenUsage: tokenUsageSnapshot()
      };
    }
    } else {
      log(`저장된 Writer 본문을 사용해 Main Agent 검수부터 재개합니다 (${attempt}/${maxReviewAttempts})`, "info", "main");
    }

    log(`Writer Agent 본문 작성 완료 (${attempt}/${maxReviewAttempts})`, "info", "writer");
    log(`Main Agent 최종 검수 시작 (${attempt}/${maxReviewAttempts})`, "info", "main");
    checkpoint({
      resumeFrom: "main_review",
      failurePhase: "main_review",
      lastCompletedPhase: "writer",
      attempt,
      phaseDetail: `Main Agent 최종 검수 실행 준비 (${attempt}차)`
    });
    mainReviewResult = await runCodexTask({
      options: effectiveOptions,
      prompt: buildMainReviewPrompt({
        ...effectiveOptions,
        researchTitleResult: researchResult,
        writerResult,
        finalTitle,
        resumeRepairPrompt: resumeAtReview ? resumePrompt : ""
      }),
      promptFileName: resumeState
        ? `main-review-resume-${attempt}.txt`
        : attempt === 1 ? "main-review-prompt.txt" : `main-review-retry-${attempt}.txt`,
      resultFileName: "main-review-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      inputTokenOffset: totalInputTokens,
      cachedInputTokenOffset: totalCachedInputTokens,
      outputTokenOffset: totalOutputTokens,
      promptCharacterOffset: totalPromptCharacters,
      agentTokenOffset: agentTokenTotals.main,
      agent: "main"
    });
    recordTaskUsage(mainReviewResult, "main");

    mainReviewStatus = String(mainReviewResult.status || "").toUpperCase();
    const mainReviewPassIssue = mainReviewPassIssueReason(mainReviewResult);
    log(`Main Agent 최종 검수 결과: ${mainReviewStatus || "UNKNOWN"}`, mainReviewStatus === "PASS" ? "info" : "warn", "main");
    checkpoint({
      resumeFrom: mainReviewStatus === "PASS" && !mainReviewPassIssue ? "image" : "writer",
      failurePhase: mainReviewStatus === "PASS" && !mainReviewPassIssue ? "" : "main_review",
      lastCompletedPhase: "main_review",
      attempt,
      phaseDetail: `Main Agent 최종 검수 결과 저장 완료: ${mainReviewStatus || "UNKNOWN"}`
    });
    if (mainReviewPassIssue) {
      log(`Main Agent PASS verification failed: ${mainReviewPassIssue}`, "warn", "main");
    }
    if (mainReviewStatus === "PASS" && !mainReviewPassIssue) {
      break;
    }
    const safeFallbackBlockRewrite = safeGeneralTopicFallback
      && safeGeneralFallbackBlockIsRewriteable(mainReviewResult);
    if ((mainReviewStatus === "REVISION" || mainReviewPassIssue || safeFallbackBlockRewrite) && attempt < maxReviewAttempts) {
      resumeAtReview = false;
      writerRevisionFeedback = compactTextList([
        safeFallbackBlockRewrite
          ? "안전 일반 설명 재작성: Research/Title 핸드오프와 추출된 검색 후보에 직접 없는 법안 번호, 법 조항, 위원회·표결 수치, 날짜, 기관 조치, 법적 효력, 기업 발표, 현재 상태를 모두 삭제하거나 근거가 있는 일반 개념으로 완화하세요. 새 사실을 추가하지 말고, 독자-facing 본문으로 다시 작성한 뒤 최종 검수를 받으세요."
          : "",
        mainReviewPassIssue,
        revisionFeedbackFrom(mainReviewResult, writerResult)
      ]).join(" / ").slice(0, 4000);
      log(
        safeFallbackBlockRewrite
          ? `근거 없는 세부 주장만 제거하는 안전 재작성으로 전환합니다 (${attempt + 1}/${maxReviewAttempts})`
          : `Main Agent 수정 요청으로 다시 시도합니다 (${attempt + 1}/${maxReviewAttempts})`,
        "warn",
        "main"
      );
      continue;
    }

    const reviewReason = mainReviewPassIssue
      || String(mainReviewResult.failureReason || "").trim()
      || "Main Agent 최종 검수에서 발행 가능 기준을 통과하지 못했습니다.";
    return {
      status: "failed",
      failurePhase: "main_review",
      failureReason: reviewReason,
      reviewStatus: mainReviewStatus || "REVISION",
      title: finalTitle || String(writerResult?.title || "").trim(),
      article: String(writerResult?.article || ""),
      tags: Array.isArray(writerResult?.tags) ? writerResult.tags : [],
      bodyImages: Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages : [],
      titleImagePath: String(writerResult?.titleImagePath || ""),
      notes: [
        reviewReason,
        ...((Array.isArray(mainReviewResult.issues) ? mainReviewResult.issues : []))
      ],
      researchTitleResult: researchResult,
      mainReviewResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  let finalWriterResult = {
    ...writerResult,
    title: finalTitle || String(writerResult.title || "").trim()
  };
  const bodyImageLimit = normalizeMaxBodyImages(effectiveOptions.maxBodyImages);
  const usesImages = effectiveOptions.includeTitleImage !== false || bodyImageLimit > 0;
  if (usesImages) {
    log("Image Worker 이미지 생성 시작", "info", "main");
    let imageContractFailure = "";
    let accumulatedImageResult = resumeAtImage && resumeState?.imageWorkerResult
      && typeof resumeState.imageWorkerResult === "object"
      ? resumeState.imageWorkerResult
      : null;
    for (let imageAttempt = 1; imageAttempt <= 2; imageAttempt += 1) {
      try {
        checkpoint({
          resumeFrom: "image",
          failurePhase: "image",
          lastCompletedPhase: "main_review",
          attempt: imageAttempt,
          phaseDetail: `Image Worker 실행 준비 (${imageAttempt}차)`
        });
        const imageRequest = imageAttempt === 1 && !accumulatedImageResult
          ? finalWriterResult
          : pendingImageWriterResult(finalWriterResult, accumulatedImageResult, effectiveOptions);
        const requestTitleImage = imageAttempt === 1
          ? effectiveOptions.includeTitleImage !== false
          : Boolean(String(imageRequest.titleImagePrompt || "").trim());
        const imageWorkerResult = await runCodexTask({
          options: effectiveOptions,
          prompt: buildImageWorkerPrompt({
            ...effectiveOptions,
            includeTitleImage: requestTitleImage,
            writerResult: imageRequest,
            finalTitle,
        imageRevisionFeedback: [imageContractFailure, resumeAtImage && imageAttempt === 1 ? resumePrompt : ""]
          .filter(Boolean)
          .join(" / ")
          }),
          promptFileName: imageAttempt === 1 ? "image-worker-prompt.txt" : `image-worker-retry-${imageAttempt}.txt`,
          resultFileName: "image-worker-result.json",
          log,
          tokenOffset: totalTokens,
          grossTokenOffset: totalGrossTokens,
          inputTokenOffset: totalInputTokens,
          cachedInputTokenOffset: totalCachedInputTokens,
          outputTokenOffset: totalOutputTokens,
          promptCharacterOffset: totalPromptCharacters,
          agentTokenOffset: agentTokenTotals.image,
          agent: "image"
        });
        recordTaskUsage(imageWorkerResult, "image");
        accumulatedImageResult = mergeImageWorkerAttempts(accumulatedImageResult, imageWorkerResult);
        checkpoint({
          resumeFrom: "image",
          failurePhase: "image",
          lastCompletedPhase: "main_review",
          attempt: imageAttempt,
          phaseDetail: `Image Worker 결과 저장 완료 (${imageAttempt}차)`
        });
        imageContractFailure = imageWorkerContractIssueReason(accumulatedImageResult, finalWriterResult, effectiveOptions);
        if (!imageContractFailure) {
          log(`Image Worker 이미지 생성 및 요약 계약 검증 완료 (${imageAttempt}/2)`, "info", "main");
          finalWriterResult = mergeImageWorkerResult(finalWriterResult, accumulatedImageResult, effectiveOptions);
          break;
        }
        log(`Image Worker 요약 계약 검증 실패 (${imageAttempt}/2): ${imageContractFailure}`, "warn", "main");
        preserveAgentFile(
          options.jobDir,
          "image-worker-result.json",
          `image-worker-invalid-result-${imageAttempt}.json`
        );
      } catch (error) {
        if (isCodexUsageLimitError(error)) {
          throw error;
        }
        imageContractFailure = `Image Worker 실행 실패: ${error.message}`;
        log(`${imageContractFailure} (${imageAttempt}/2)`, "warn", "main");
      }
    }
    if (imageContractFailure) {
      if (effectiveOptions.requireImageAssets === true) {
        return {
          status: "failed",
          failurePhase: "image",
          failureReason: `필수 이미지 검증을 통과하지 못했습니다: ${imageContractFailure}`,
          title: finalWriterResult.title || finalTitle,
          article: String(finalWriterResult.article || ""),
          tags: Array.isArray(finalWriterResult.tags) ? finalWriterResult.tags : [],
          bodyImages: [],
          titleImagePath: "",
          notes: [imageContractFailure, "필수 이미지가 확인될 때까지 온새카 등록을 진행하지 않습니다."],
          researchTitleResult: researchResult,
          mainReviewResult,
          tokenUsage: tokenUsageSnapshot()
        };
      }
      log(`Image Worker를 완료하지 못했지만 PASS된 본문을 보존하고 이미지 없이 계속합니다: ${imageContractFailure}`, "warn", "main");
      finalWriterResult = {
        ...finalWriterResult,
        titleImagePath: "",
        bodyImages: [],
        imageWarnings: [
          ...(Array.isArray(finalWriterResult.imageWarnings) ? finalWriterResult.imageWarnings : []),
          imageContractFailure
        ]
      };
    }
  }

  return {
    ...finalWriterResult,
    researchTitleResult: researchResult,
    mainReviewResult,
    tokenUsage: tokenUsageSnapshot()
  };
}

module.exports = {
  runCodexGeneration,
  fetchCodexUsageSnapshot,
  _private: {
    compactSearchResultsForPrompt,
    compactSourceDocumentsForPrompt,
    compactResearchHandoffForPrompt,
    compactWriterResultForPrompt,
    rankSearchResultsForPrompt,
    buildPrompt,
    buildResearchTitleRetryPrompt,
    buildWriterRetryPrompt,
    buildMainReviewPrompt,
    buildWriterContractRefinementPrompt,
    buildImageWorkerPrompt,
    buildWriterContract,
    articleSections,
    isSafeGeneralTopicFallbackEligible,
    buildSafeGeneralTopicFallback,
    safeGeneralFallbackBlockIsRewriteable,
    writerImageContractIssueReason,
    imageWorkerContractIssueReason,
    mergeImageWorkerAttempts,
    pendingImageWriterResult
  }
};
