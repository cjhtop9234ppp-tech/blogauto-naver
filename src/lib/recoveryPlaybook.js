const fs = require("node:fs");
const path = require("node:path");

const PLAYBOOK_FILE = "recovery-playbook.json";
const MAX_LESSONS = 80;
const MAX_ATTEMPTS = 80;

function cleanText(value, maxLength = 2400) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/(?:password|passwd|비밀번호|secret|token|cookie|authorization|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizePhase(value) {
  const phase = String(value || "").trim().toLowerCase();
  return ["research", "writer", "main_review", "image", "session", "publish", "unknown"].includes(phase)
    ? phase
    : "unknown";
}

function classifyFailure(phase, reason) {
  const text = `${String(phase || "")} ${String(reason || "")}`.toLowerCase();
  if (/검색 후보|search candidate|근거 부족|검색이 필요|no usable|no.*candidate/.test(text)) return "research:no-search-candidates";
  if (/최신|현재 상태|법률|정책|시행|current|freshness|official/.test(text)) return "research:freshness";
  if (/제목.*본문|본문.*제목|title.*body|mismatch|writer contract/.test(text)) return "review:title-body-mismatch";
  if (/image worker|이미지.*(시간|검증|실패)|이미지.*생성|ai 활용|timeout/.test(text)) return "image:image-worker";
  if (/카테고리|category/.test(text)) return "publish:category";
  if (/태그|tag.*input/.test(text)) return "publish:tag-input";
  if (/최종 발행|발행 완료|publish.*button|final.*submit/.test(text)) return "publish:final-submit";
  if (/브라우저|browser|session|로그인|login|context/.test(text)) return "publish:browser-session";
  return `${normalizePhase(phase)}:error`;
}

const BUILT_IN_LESSONS = [
  {
    key: "research:no-search-candidates",
    phase: "research",
    guidance: "검색 후보가 없으면 검색 필요 여부를 다시 판단하고, 필요하면 설정된 검색 제공자에서 좁은 질의를 재시도하세요. 그래도 공식·독립 근거가 없으면 사실을 만들거나 이미지 생성으로 우회하지 말고 확인 필요 상태로 보존하세요."
  },
  {
    key: "research:freshness",
    phase: "research",
    guidance: "법률·정책·제도·현재 상태 주장은 최신 공식 원문 또는 신뢰 가능한 독립 자료로 확인하세요. 확인되지 않은 날짜·조항·시행 상태는 본문에 확정적으로 쓰지 말고 재검수로 보냅니다."
  },
  {
    key: "review:title-body-mismatch",
    phase: "main_review",
    guidance: "제목의 구체적 대상과 독자 약속을 본문이 직접 충족하는지 먼저 맞추세요. 본문에 없는 사건·수치·조건을 제목에 추가하지 말고, 근거 범위 안에서 제목과 구조를 함께 정리하세요."
  },
  {
    key: "image:image-worker",
    phase: "image",
    guidance: "이미지 단계 오류는 완료된 본문을 버리지 말고 실패한 이미지 단계만 재시도하세요. 구체적인 파일 경로와 검증 결과가 없으면 이미지를 성공으로 표시하거나 발행을 강행하지 마세요."
  },
  {
    key: "publish:category",
    phase: "publish",
    guidance: "발행 카테고리는 블로그에 실제 존재하는 정확한 표시명과 매칭하세요. 일치하지 않으면 현재 카테고리로 조용히 발행하지 말고 중단하여 사용자가 선택하게 하세요."
  },
  {
    key: "publish:tag-input",
    phase: "publish",
    guidance: "태그 입력칸이 없으면 태그만 생략하고 본문·제목 발행 흐름은 유지할 수 있습니다. 태그 누락을 본문 발행 실패로 확대하지 않되, 최종 발행 확인은 별도로 수행하세요."
  },
  {
    key: "publish:final-submit",
    phase: "publish",
    guidance: "발행 설정에서 공개 설정·카테고리를 확인한 다음 설정창의 발행 버튼을 누르고, 완료 알림 또는 화면 상태 변화를 확인한 뒤에만 성공 처리하세요. 확인 전 브라우저를 닫지 마세요."
  },
  {
    key: "publish:browser-session",
    phase: "session",
    guidance: "로그인 세션과 발행 페이지는 동일한 브라우저 프로필과 살아 있는 페이지를 사용하세요. 로그인 확인 전 다음 단계로 진행하거나 브라우저를 닫지 말고, 세션 만료 시 해당 단계부터 재개하세요."
  }
];

function playbookPath(runtimeRoot) {
  return path.join(runtimeRoot, PLAYBOOK_FILE);
}

function readRecoveryPlaybook(runtimeRoot) {
  let stored = {};
  try {
    const filePath = playbookPath(runtimeRoot);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.lessons)) stored = parsed;
    }
  } catch {
    stored = {};
  }
  const persisted = stored.lessons || [];
  const byKey = new Map();
  for (const lesson of BUILT_IN_LESSONS) byKey.set(`${lesson.key}\u0000`, { ...lesson, source: "built-in", useCount: 0 });
  for (const lesson of persisted) {
    if (!lesson || typeof lesson !== "object" || !lesson.key || !lesson.guidance) continue;
    const normalizedCategory = cleanText(lesson.category, 160);
    byKey.set(`${String(lesson.key)}\u0000${normalizedCategory}`, {
      key: String(lesson.key),
      phase: normalizePhase(lesson.phase),
      guidance: cleanText(lesson.guidance),
      source: lesson.source === "built-in" ? "built-in" : "user-confirmed",
      useCount: Math.max(0, Number(lesson.useCount || 0)),
      firstSeenAt: String(lesson.firstSeenAt || ""),
      lastUsedAt: String(lesson.lastUsedAt || ""),
      category: normalizedCategory
    });
  }
  const attempts = (Array.isArray(stored.attempts) ? stored.attempts : [])
    .filter((attempt) => attempt && typeof attempt === "object")
    .map((attempt) => ({
      phase: normalizePhase(attempt.phase),
      errorType: cleanText(attempt.errorType || attempt.key, 160),
      errorReason: cleanText(attempt.errorReason, 2400),
      repairPrompt: cleanText(attempt.repairPrompt, 2400),
      appliedAt: String(attempt.appliedAt || "")
    }))
    .filter((attempt) => attempt.errorReason || attempt.repairPrompt)
    .slice(-MAX_ATTEMPTS);
  return { version: 1, lessons: [...byKey.values()].slice(0, MAX_LESSONS), attempts };
}

function writeRecoveryPlaybook(runtimeRoot, playbook) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const filePath = playbookPath(runtimeRoot);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    version: 1,
    lessons: Array.isArray(playbook?.lessons) ? playbook.lessons.slice(0, MAX_LESSONS) : [],
    attempts: Array.isArray(playbook?.attempts) ? playbook.attempts.slice(-MAX_ATTEMPTS) : []
  }, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function findRecoveryGuidance(runtimeRoot, { failurePhase = "", failureReason = "", category = "" } = {}) {
  const playbook = readRecoveryPlaybook(runtimeRoot);
  const phase = normalizePhase(failurePhase);
  const key = classifyFailure(failurePhase, failureReason);
  const categoryText = cleanText(category, 160);
  return playbook.lessons
    .filter((lesson) => {
      const exact = lesson.key === key;
      const samePhase = phase !== "unknown" && lesson.phase === phase;
      const sameCategory = !lesson.category || !categoryText || lesson.category === categoryText;
      const freshRunHint = !failureReason && phase === "unknown"
        && (lesson.source === "built-in" || lesson.category === categoryText);
      return sameCategory && (exact || samePhase || freshRunHint);
    })
    .sort((a, b) => (Number(b.useCount || 0) - Number(a.useCount || 0)) || String(b.lastUsedAt || "").localeCompare(String(a.lastUsedAt || "")))
    .slice(0, 8)
    .map((lesson) => ({ key: lesson.key, phase: lesson.phase, guidance: lesson.guidance, source: lesson.source, useCount: lesson.useCount || 0 }));
}

function recordRecoveryLesson(runtimeRoot, { failurePhase = "", failureReason = "", repairPrompt = "", category = "" } = {}) {
  const guidance = cleanText(repairPrompt, 2400);
  if (!guidance) return false;
  const playbook = readRecoveryPlaybook(runtimeRoot);
  const key = classifyFailure(failurePhase, failureReason);
  const now = new Date().toISOString();
  const categoryText = cleanText(category, 160);
  const existing = playbook.lessons.find((lesson) => lesson.key === key && (lesson.category || "") === categoryText);
  if (existing) {
    existing.guidance = guidance;
    existing.source = "user-confirmed";
    existing.useCount = Math.max(0, Number(existing.useCount || 0)) + 1;
    existing.lastUsedAt = now;
    existing.firstSeenAt = existing.firstSeenAt || now;
    existing.phase = normalizePhase(failurePhase);
    existing.category = categoryText;
  } else {
    playbook.lessons.unshift({
      key,
      phase: normalizePhase(failurePhase),
      guidance,
      source: "user-confirmed",
      useCount: 1,
      firstSeenAt: now,
      lastUsedAt: now,
      category: categoryText
    });
  }
  writeRecoveryPlaybook(runtimeRoot, playbook);
  return true;
}

function markRecoveryGuidanceUsed(runtimeRoot, guidance = []) {
  const keys = new Set((Array.isArray(guidance) ? guidance : []).map((item) => String(item?.key || "")));
  if (!keys.size) return false;
  const playbook = readRecoveryPlaybook(runtimeRoot);
  let changed = false;
  const now = new Date().toISOString();
  for (const lesson of playbook.lessons) {
    if (!keys.has(lesson.key)) continue;
    lesson.useCount = Math.max(0, Number(lesson.useCount || 0)) + 1;
    lesson.lastUsedAt = now;
    changed = true;
  }
  if (changed) writeRecoveryPlaybook(runtimeRoot, playbook);
  return changed;
}

function recordRecoveryAttempt(runtimeRoot, { failurePhase = "", failureReason = "", repairPrompt = "" } = {}) {
  const reason = cleanText(failureReason, 2400);
  const prompt = cleanText(repairPrompt, 2400);
  if (!reason && !prompt) return false;
  const playbook = readRecoveryPlaybook(runtimeRoot);
  playbook.attempts = Array.isArray(playbook.attempts) ? playbook.attempts : [];
  playbook.attempts.push({
    phase: normalizePhase(failurePhase),
    errorType: classifyFailure(failurePhase, failureReason),
    errorReason: reason,
    repairPrompt: prompt,
    appliedAt: new Date().toISOString()
  });
  writeRecoveryPlaybook(runtimeRoot, playbook);
  return true;
}

function recoveryOverview(runtimeRoot) {
  const playbook = readRecoveryPlaybook(runtimeRoot);
  return {
    lessons: playbook.lessons.map((lesson) => ({
      key: lesson.key,
      phase: lesson.phase,
      guidance: lesson.guidance,
      source: lesson.source,
      useCount: lesson.useCount || 0
    })),
    attempts: playbook.attempts || []
  };
}

module.exports = {
  classifyFailure,
  findRecoveryGuidance,
  markRecoveryGuidanceUsed,
  normalizePhase,
  recordRecoveryAttempt,
  recoveryOverview,
  readRecoveryPlaybook,
  recordRecoveryLesson,
  writeRecoveryPlaybook
};
