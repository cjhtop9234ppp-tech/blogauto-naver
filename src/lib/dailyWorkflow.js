const fs = require("node:fs");
const path = require("node:path");

const MEMBER_BOARD_URL = "https://onsaecar.co.kr/board";
const MEMBER_BOARD_PUBLIC_URL = "https://onsaecar.co.kr/board";
const MEMBER_BOARD_WRITE_URL = "https://onsaecar.co.kr/board/add";
const MEMBER_BOARD_AUTO_TITLE_PREFIX = "[자동발행]";
const DEFAULT_DAILY_PUBLISH_CATEGORY = "알아두면 좋은 지식";
const NAVER_STYLE_URL = "https://blog.naver.com/PostList.naver?blogId=ctx9234&from=postList&categoryNo=7";
const DAILY_PUBLISH_START_MINUTES = 12 * 60;
const DAILY_PUBLISH_INTERVAL_MINUTES = 10;

const SOURCE_CATEGORY_SLOTS = [
  {
    slot: 1,
    sourceCategory: "정부·공공기관",
    blogDisplay: "공공정책",
    sourceExamples: "국토부, 금융감독원, 공정위, 서울시",
    topicHint: "보험 제도·약관 개정, 전기차 정책, 소비자 안전정책",
    keywordRule: "정책명+시행일+적용대상",
    excludedTopics: "자동차·보험·정비와 무관한 일반 행정(교육·복지 등)",
    purposeTemplate: "○○ 제도/정책 변경 내용을 정리해 소비자·정비업계가 놓치지 않도록 안내",
    keywords: ["국토교통부", "금융감독원", "공정거래위원회", "서울시", "정책", "제도", "시행", "자동차보험", "전기차"]
  },
  {
    slot: 2,
    sourceCategory: "법원·법률",
    blogDisplay: "법률·판례",
    sourceExamples: "대법원, 법원, 국회, 법률 개정안",
    topicHint: "사고 과실·분쟁·손해사정, 정비수가 분쟁",
    keywordRule: "사건명/쟁점+관련 법조항",
    excludedTopics: "자동차·보험과 무관한 판례·법안",
    purposeTemplate: "○○ 판례/법 개정이 실무(보상·정비)에 미치는 영향 정리",
    keywords: ["대법원", "법원", "국회", "법률", "법령", "판례", "과실", "분쟁", "손해사정"]
  },
  {
    slot: 3,
    sourceCategory: "보험업계",
    blogDisplay: "보험업계",
    sourceExamples: "손해보험사, 손해보험협회, 보험개발원",
    topicHint: "보험료·손해율, 보상절차, 표준작업시간 연구",
    keywordRule: "보험사명+상품/제도명",
    excludedTopics: "개별 보험사 마케팅·광고성 내용",
    purposeTemplate: "보험업계 ○○ 동향이 가입자·정비업계에 미치는 영향 안내",
    keywords: ["손해보험", "보험협회", "보험개발원", "보험료", "손해율", "보상", "표준작업시간"]
  },
  {
    slot: 4,
    sourceCategory: "정비업계",
    blogDisplay: "정비업계",
    sourceExamples: "정비업체, 정비협회, 자동차정비협의회",
    topicHint: "공임·표준작업시간, 부품비, 정비불량·수리피해",
    keywordRule: "공임/부품/작업시간 관련 용어+차종",
    excludedTopics: "개별 업체 광고성 내용",
    purposeTemplate: "정비업계 ○○ 이슈가 소비자·정비업소에 미치는 실무 영향 정리",
    keywords: ["자동차정비", "정비업계", "공임", "부품비", "작업시간", "수리", "정비불량"]
  },
  {
    slot: 5,
    sourceCategory: "완성차·기업",
    blogDisplay: "기업자료",
    sourceExamples: "현대차, 기아, 삼성화재, 플랫폼 기업",
    topicHint: "신모델·SDV·커넥티드카, 플랫폼 서비스",
    keywordRule: "기업명+제품/서비스명",
    excludedTopics: "단순 신차·서비스 홍보성 보도자료",
    purposeTemplate: "○○(기업)의 발표가 소비자·산업에 주는 의미 해설",
    keywords: ["현대자동차", "기아", "자동차기업", "신차", "SDV", "커넥티드카", "플랫폼"]
  },
  {
    slot: 6,
    sourceCategory: "연구·전문가",
    blogDisplay: "연구·전문가",
    sourceExamples: "대학, 연구기관, 전문가 기고",
    topicHint: "표준작업시간 연구, 전문가 분석·칼럼",
    keywordRule: "연구주제+기관명",
    excludedTopics: "자동차·보험·정비와 무관한 학술내용",
    purposeTemplate: "○○ 연구/전문가 의견을 근거로 심층 정보 제공",
    keywords: ["연구", "연구기관", "대학교", "전문가", "표준작업시간", "분석"]
  },
  {
    slot: 7,
    sourceCategory: "언론기사",
    blogDisplay: "언론보도",
    sourceExamples: "뉴시스, 연합뉴스, 경제지 등",
    topicHint: "사고사례, 업계 시황, 산업 뉴스",
    keywordRule: "기사 핵심어+매체명",
    excludedTopics: "자동차·보험·정비와 무관한 일반 사회면 기사",
    purposeTemplate: "주요 보도(○○) 내용을 정리해 놓치지 않도록 안내",
    keywords: ["연합뉴스", "뉴시스", "언론", "기사", "자동차뉴스", "산업뉴스", "사고"]
  },
  {
    slot: 8,
    sourceCategory: "소비자·안전",
    blogDisplay: "소비자·안전",
    sourceExamples: "소비자원, 경찰, 교통안전기관",
    topicHint: "사고예방, 안전관리, 리콜정보",
    keywordRule: "안전/리콜/사고예방 관련어",
    excludedTopics: "자동차와 무관한 일반 안전정보",
    purposeTemplate: "소비자가 알아야 할 ○○ 안전정보 정리",
    keywords: ["한국소비자원", "경찰", "교통안전", "안전", "리콜", "사고예방", "자동차안전"]
  },
  {
    slot: 9,
    sourceCategory: "일반 시사",
    blogDisplay: "일반시사",
    sourceExamples: "정치·경제·부동산·건강 매체",
    topicHint: "정책·경제·사회 브리핑(자동차 연관성이 낮은 소재)",
    keywordRule: "시사 핵심어(정책명·이슈명)",
    excludedTopics: "자동차·보험·정비와 조금이라도 연결되지 않는 경우",
    purposeTemplate: "참고용 시사 브리핑으로 간단 정리(선별적 게시)",
    keywords: ["정책", "경제", "사회", "시사", "자동차산업", "보험산업", "정비업계"]
  }
];

const PLAN_STATUSES = new Set(["대기", "선택 제외", "초안 생성 완료", "승인됨", "발행완료", "실패", "확인 필요", "소재없음"]);

function getDailyPlanPath(runtimeRoot) {
  return path.join(runtimeRoot, "member-board-daily-plan.json");
}

function getMemberSourcePath(runtimeRoot) {
  return path.join(runtimeRoot, "member-board-source.json");
}

function getStyleRulesPath(runtimeRoot) {
  return path.join(runtimeRoot, "naver-style-rules.json");
}

function ensureDailyWorkflowFiles(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  for (const filePath of [getDailyPlanPath(runtimeRoot), getMemberSourcePath(runtimeRoot)]) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}\n", "utf8");
  }
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

function readDailyPlan(runtimeRoot, date = "") {
  ensureDailyWorkflowFiles(runtimeRoot);
  const store = readJson(getDailyPlanPath(runtimeRoot), { plans: {} });
  if (!store || typeof store !== "object") return null;
  if (!store.plans || typeof store.plans !== "object") return null;
  return date ? store.plans[date] || null : store;
}

function writeDailyPlan(runtimeRoot, plan) {
  ensureDailyWorkflowFiles(runtimeRoot);
  const store = readJson(getDailyPlanPath(runtimeRoot), { plans: {} });
  store.plans = store.plans && typeof store.plans === "object" ? store.plans : {};
  plan.updatedAt = new Date().toISOString();
  plan.saveVersion = Number(plan.saveVersion || 0) + 1;
  store.plans[plan.date] = plan;
  writeJson(getDailyPlanPath(runtimeRoot), store);
  return plan;
}

function readMemberSource(runtimeRoot) {
  ensureDailyWorkflowFiles(runtimeRoot);
  const source = readJson(getMemberSourcePath(runtimeRoot), {});
  return {
    posts: Array.isArray(source.posts) ? source.posts : [],
    fetchedAt: String(source.fetchedAt || ""),
    sourceUrl: String(source.sourceUrl || MEMBER_BOARD_URL),
    ...source
  };
}

function writeMemberSource(runtimeRoot, source) {
  ensureDailyWorkflowFiles(runtimeRoot);
  return writeJson(getMemberSourcePath(runtimeRoot), source);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value) {
  return normalizeWhitespace(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizeMemberPost(post = {}) {
  const title = normalizeWhitespace(post.title || post.subject || post.name);
  const text = String(post.text || post.body || post.content || "").trim();
  const sourceUrl = normalizeWhitespace(post.sourceUrl || post.url || "");
  const sourcePostId = normalizeWhitespace(post.sourcePostId || post.postId || post.id || "");
  return {
    sourcePostId,
    title,
    text,
    sourceUrl,
    sourceCategory: normalizeWhitespace(post.sourceCategory || post.category || ""),
    author: normalizeWhitespace(post.author || post.writer || ""),
    publishedAt: normalizeWhitespace(post.publishedAt || post.articleDate || ""),
    registeredAt: normalizeWhitespace(post.registeredAt || post.createdAt || post.date || ""),
    updatedAt: normalizeWhitespace(post.updatedAt || ""),
    originalSourceVerified: post.originalSourceVerified !== false,
    metadata: post.metadata && typeof post.metadata === "object" ? post.metadata : {}
  };
}

function slotScore(post, slot) {
  const haystack = `${post.sourceCategory} ${post.title} ${post.text}`.toLowerCase();
  const sourceCategory = String(post.sourceCategory || "").toLowerCase();
  let score = 0;
  if (sourceCategory && (sourceCategory.includes(slot.sourceCategory) || slot.sourceCategory.includes(sourceCategory))) score += 12;
  for (const keyword of slot.keywords) if (haystack.includes(keyword.toLowerCase())) score += 2;
  if (slot.slot !== 9 && /자동차|차량|보험|정비|공임|사고|교통|부품|수리/.test(haystack)) score += 3;
  if (slot.slot === 9 && /자동차|차량|보험|정비|교통/.test(haystack)) score += 2;
  return score;
}

function parseDateValue(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const timestamp = Date.parse(text.replace(/[.]/g, "-").replace(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/, "$1-$2-$3T$4:$5:00"));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function recencyScore(post) {
  return Math.max(parseDateValue(post.updatedAt), parseDateValue(post.registeredAt), parseDateValue(post.publishedAt));
}

function importanceScore(post) {
  const haystack = `${post.title} ${post.text}`;
  let score = 0;
  if (/변경|개정|시행|판결|리콜|사고|금액|공임|기준|주의|피해/.test(haystack)) score += 5;
  if (/국토교통부|금융감독원|대법원|보험개발원|소비자원/.test(haystack)) score += 4;
  return score;
}

function historyLooksDuplicate(post, history, cutoffTimestamp) {
  const comparableTitle = normalizeComparable(post.title);
  const comparableUrl = normalizeComparable(post.sourceUrl);
  return (Array.isArray(history) ? history : []).some((entry) => {
    const created = parseDateValue(entry.create_at || entry.createdAt);
    if (created && created < cutoffTimestamp) return false;
    const entryUrl = normalizeComparable(entry.source_url || entry.sourceUrl);
    const entryPostId = normalizeComparable(entry.source_post_id || entry.sourcePostId);
    if (post.sourcePostId && entryPostId && normalizeComparable(post.sourcePostId) === entryPostId) return true;
    if (comparableUrl && entryUrl && comparableUrl === entryUrl) return true;
    return comparableTitle && normalizeComparable(entry.title) === comparableTitle;
  });
}

function formatScheduledAt(date, slotIndex) {
  const totalMinutes = DAILY_PUBLISH_START_MINUTES + slotIndex * DAILY_PUBLISH_INTERVAL_MINUTES;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;
}

function purposeForSlot(slot, title) {
  return slot.purposeTemplate.replace("○○", title || "해당 이슈");
}

function keywordsForPost(post, slot) {
  const source = `${post.title} ${post.text}`;
  const selected = slot.keywords.filter((keyword) => source.includes(keyword));
  const titleWords = normalizeWhitespace(post.title).split(/[\s,·/()[\]{}]+/).filter((word) => word.length >= 2).slice(0, 4);
  return [...new Set([...selected, ...titleWords])].slice(0, 8).join(", ");
}

function stableDailyIndex(seed, length) {
  if (!length) return 0;
  let hash = 2166136261;
  for (const character of String(seed || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % length;
}

function splitTopicHints(value) {
  return [...new Set(String(value || "")
    .split(/[·,，/]+/)
    .map((item) => normalizeWhitespace(item))
    .filter((item) => item.length >= 2))];
}

function splitCategoryKeywords(value) {
  return [...new Set(String(value || "")
    .split(/[\n,，/]+/)
    .map((item) => normalizeWhitespace(item))
    .filter((item) => item.length >= 2))];
}

function validateRandomTopicCandidate({ slot, selectedKeyword = "", selectedHint = "", topic = "", searchKeyword = "" } = {}) {
  const reasons = [];
  const normalizedTopic = normalizeWhitespace(topic);
  const normalizedKeyword = normalizeWhitespace(selectedKeyword);
  const normalizedHint = normalizeWhitespace(selectedHint);
  const normalizedSearch = normalizeWhitespace(searchKeyword);
  if (!normalizedKeyword) reasons.push("카테고리 검색 키워드가 비어 있습니다.");
  if (!normalizedHint) reasons.push("슬롯 주제 힌트가 비어 있습니다.");
  if (normalizedTopic.length < 8) reasons.push("주제 문장이 너무 짧습니다.");
  const queryTerms = [...new Set(normalizedSearch.split(/[\s,·/|]+/).filter((term) => term.length >= 2))];
  if (queryTerms.length < 3) reasons.push("검색 후보를 만들 수 있는 핵심어가 3개 미만입니다.");
  const anchorText = `${normalizedKeyword} ${normalizedHint}`;
  if (Number(slot?.slot) === 9 && !/자동차|차량|보험|정비|교통|모빌리티|완성차|부품/.test(anchorText)) {
    reasons.push("일반 시사 주제가 자동차·보험·정비와 직접 연결되지 않습니다.");
  }
  if (Number(slot?.slot) !== 9) {
    const slotKeywords = Array.isArray(slot?.keywords) ? slot.keywords : [];
    if (slotKeywords.length && !slotKeywords.some((keyword) => anchorText.includes(String(keyword)))) {
      reasons.push("선택한 주제와 슬롯의 출처·키워드 방향이 일치하지 않습니다.");
    }
  }
  return {
    status: reasons.length ? "REJECT" : "PASS",
    eligible: reasons.length === 0,
    reasons
  };
}

function chooseCategoryKeywordForSlot(categoryKeywords, slot, date) {
  const keywords = Array.isArray(categoryKeywords) ? categoryKeywords : [];
  const slotText = `${slot?.sourceCategory || ""} ${slot?.topicHint || ""} ${Array.isArray(slot?.keywords) ? slot.keywords.join(" ") : ""} ${slot?.sourceExamples || ""}`;
  const scored = keywords
    .map((keyword, index) => ({
      keyword,
      index,
      score: String(keyword).split(/[\s·/]+/).filter((part) => part.length >= 2 && slotText.includes(part)).length
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => (right.score - left.score) || (left.index - right.index));
  if (scored.length) {
    const topScore = scored[0].score;
    const top = scored.filter((item) => item.score === topScore);
    return top[stableDailyIndex(`${date}|${slot.slot}|keyword`, top.length)].keyword;
  }
  const slotKeywords = Array.isArray(slot?.keywords) ? slot.keywords : [];
  return slotKeywords[stableDailyIndex(`${date}|${slot?.slot || 0}|fallback-keyword`, slotKeywords.length)]
    || keywords[stableDailyIndex(`${date}|${slot?.slot || 0}|keyword`, keywords.length)]
    || slot?.sourceCategory
    || "자동차산업";
}

function createRandomResearchPlan({
  date,
  accountId = "",
  blogId = "",
  category,
  styleRules = null,
  randomSeed = ""
} = {}) {
  const categoryName = normalizeWhitespace(category?.name);
  if (!date) throw new Error("랜덤 주제 계획에는 날짜가 필요합니다.");
  if (!categoryName) throw new Error("랜덤 주제 계획에 사용할 카테고리가 없습니다.");
  const slotIndex = stableDailyIndex(`${date}|${accountId}|${categoryName}|${randomSeed}`, SOURCE_CATEGORY_SLOTS.length);
  const categoryKeywords = splitCategoryKeywords(category.keyword);
  const topicCandidates = SOURCE_CATEGORY_SLOTS.map((slot) => {
    const topicHints = splitTopicHints(slot.topicHint);
    const selectedHint = topicHints[stableDailyIndex(`${date}|${slot.slot}|hint`, topicHints.length)] || slot.topicHint;
    const selectedKeyword = chooseCategoryKeywordForSlot(categoryKeywords, slot, date);
    const topic = `${selectedKeyword} 관련 ${selectedHint}`.replace(/\s+/g, " ").trim();
    const searchKeyword = [
      selectedKeyword,
      selectedHint,
      ...slot.keywords.slice(0, 5),
      slot.sourceExamples
    ].filter(Boolean).join(", ");
    return {
      slot,
      selectedHint,
      selectedKeyword,
      topic,
      searchKeyword,
      validation: validateRandomTopicCandidate({ slot, selectedKeyword, selectedHint, topic, searchKeyword })
    };
  });
  const rotatedCandidates = topicCandidates.slice(slotIndex).concat(topicCandidates.slice(0, slotIndex));
  const selectedCandidate = rotatedCandidates.find((candidate) => candidate.validation.eligible) || rotatedCandidates[0];
  const selectedSlot = selectedCandidate.slot;
  const selectedHint = selectedCandidate.selectedHint;
  const selectedKeyword = selectedCandidate.selectedKeyword;
  const topic = selectedCandidate.topic;
  const searchKeyword = selectedCandidate.searchKeyword;
  const excludedTopics = [
    category.excludedTopics,
    `선정 슬롯(${selectedSlot.sourceCategory}) 제외 기준: ${selectedSlot.excludedTopics}`
  ].filter(Boolean).join("\n");
  const publishPurpose = [
    category.publishPurpose,
    `[선정 슬롯 운영 목적] ${purposeForSlot(selectedSlot, topic)}`
  ].filter(Boolean).join("\n\n");
  const researchGuidance = [
    `오늘은 9개 슬롯 중 ${selectedSlot.slot}번 '${selectedSlot.sourceCategory}' 슬롯을 무작위로 선택했습니다.`,
    `선정 주제 씨앗: ${topic}`,
    `우선 확인할 출처·사이트·기관: ${selectedSlot.sourceExamples}`,
    `검색어 구성 기준: ${selectedSlot.keywordRule}`,
    "웹 검색을 반드시 실행하고, 위 출처·기관명과 직접 연결되는 최신 원문 후보를 우선 사용하세요.",
    "주제·검색어·출처의 연결이 사전 검증된 후보만 작성 대상으로 사용하세요.",
    "검색 후보가 부족하면 일반적인 전망글로 대체하지 말고 보강 검색 또는 확인 필요로 처리하세요."
  ].join("\n");
  const baseItem = {
    id: `${date}-random-slot-${selectedSlot.slot}`,
    registeredAt: new Date().toISOString(),
    date,
    slot: selectedSlot.slot,
    accountId,
    blogId,
    sourceCategory: selectedSlot.sourceCategory,
    blogDisplayCategory: categoryName,
    blogCategory: categoryName,
    topic,
    topicHint: selectedHint,
    sourceExamples: selectedSlot.sourceExamples,
    keywordRule: selectedSlot.keywordRule,
    searchKeyword,
    excludedTopics,
    publishPurpose,
    preferredTone: category.preferredTone || "",
    freshnessLevel: category.freshnessLevel || "auto",
    searchChannel: category.searchChannel || "blog",
    primarySearchProvider: category.primarySearchProvider || "naver",
    fallbackSearchProvider: category.fallbackSearchProvider || "google",
    trustBlogAsSource: category.trustBlogAsSource === true,
    researchGuidance,
    styleRules,
    status: "대기",
    draftReady: false,
    draftJobId: "",
    draftTitle: "",
    draftBody: "",
    draftTags: [],
    draftImages: [],
    draftTitleImagePath: "",
    draftBodyImages: [],
    memberBoardStatus: "대기",
    memberBoardTitle: "",
    memberBoardUrl: "",
    memberBoardFailureReason: "",
    failureReason: "",
    failurePhase: "",
    retryCount: 0,
    scheduledAt: `${date}T09:00:00+09:00`,
    eligibleForRun: true,
    selectionState: "selected",
    sourceCategoryRule: selectedSlot,
    topicValidation: selectedCandidate.validation
  };
  const items = SOURCE_CATEGORY_SLOTS.map((slot) => {
    if (slot.slot === selectedSlot.slot) return baseItem;
    return {
      id: `${date}-random-slot-${slot.slot}`,
      registeredAt: baseItem.registeredAt,
      date,
      slot: slot.slot,
      accountId,
      blogId,
      sourceCategory: slot.sourceCategory,
      blogDisplayCategory: categoryName,
      blogCategory: categoryName,
      topic: "",
      topicHint: slot.topicHint,
      sourceExamples: slot.sourceExamples,
      keywordRule: slot.keywordRule,
      status: "선택 제외",
      draftReady: false,
      memberBoardStatus: "미대상",
      memberBoardTitle: "",
      memberBoardUrl: "",
      memberBoardFailureReason: "",
      failureReason: "오늘은 다른 슬롯이 무작위 선택되었습니다.",
      retryCount: 0,
      scheduledAt: `${date}T09:00:00+09:00`,
      eligibleForRun: false,
      selectionState: "not_selected",
      sourceCategoryRule: slot
    };
  });
  return {
    date,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflowMode: "random-slot-web-research",
    planType: "single_random_topic",
    selectionSeed: `${date}|${accountId}|${categoryName}|${randomSeed}`,
    selectedSlot: selectedSlot.slot,
    selectedSlotCategory: selectedSlot.sourceCategory,
    accountId,
    blogId,
    categoryName,
    styleRules,
    sourceUrl: "",
    status: "초안 준비 전",
    reviewMode: "onsaecar_auto_publish",
    publishTarget: "onsaecar",
    publishStartAt: `${date}T09:00:00+09:00`,
    retryAt: `${date}T10:30:00+09:00`,
    publishIntervalMinutes: 10,
    topicSelectionValidation: {
      status: selectedCandidate.validation.status,
      selectedSlot: selectedSlot.slot,
      selectedCategory: selectedSlot.sourceCategory,
      rejectedCandidateCount: topicCandidates.filter((candidate) => !candidate.validation.eligible).length,
      note: selectedCandidate.validation.eligible
        ? "검색어·슬롯·자동차 연관성 사전 검증을 통과한 주제입니다."
        : "모든 후보가 사전 검증을 통과하지 못해 원래 랜덤 후보를 보류 상태로 기록했습니다.",
      rejectedCandidates: topicCandidates
        .filter((candidate) => !candidate.validation.eligible)
        .map((candidate) => ({
          slot: candidate.slot.slot,
          category: candidate.slot.sourceCategory,
          topic: candidate.topic,
          reasons: candidate.validation.reasons
        }))
    },
    items
  };
}

function createDailyPlan({ date, posts = [], history = [], fetchedAt = "", sourceUrl = MEMBER_BOARD_URL } = {}) {
  const normalizedPosts = posts.map(normalizeMemberPost).filter((post) => post.title || post.text);
  const cutoff = Date.parse(`${date}T00:00:00+09:00`) - (30 * 24 * 60 * 60 * 1000);
  const usedIds = new Set();
  const items = SOURCE_CATEGORY_SLOTS.map((slot) => {
    const candidates = normalizedPosts
      .map((post) => ({ post, score: slotScore(post, slot) }))
      .filter(({ post, score }) => score > 0 && !usedIds.has(post.sourcePostId || post.sourceUrl || post.title))
      .filter(({ post }) => !historyLooksDuplicate(post, history, cutoff))
      .sort((a, b) => (b.score - a.score) || (importanceScore(b.post) - importanceScore(a.post)) || (recencyScore(b.post) - recencyScore(a.post)));
    const selected = candidates[0]?.post || null;
    if (!selected) {
      return {
        id: `${date}-slot-${slot.slot}`,
        registeredAt: new Date().toISOString(),
        date,
        slot: slot.slot,
        sourceCategory: slot.sourceCategory,
        blogDisplayCategory: slot.blogDisplay,
        blogCategory: slot.blogDisplay,
        status: "소재없음",
        draftReady: false,
        memberBoardStatus: "미대상",
        memberBoardTitle: "",
        memberBoardUrl: "",
        memberBoardFailureReason: "",
        scheduledAt: formatScheduledAt(date, slot.slot - 1),
        sourceUrl,
        sourceCategoryRule: slot
      };
    }
    const identity = selected.sourcePostId || selected.sourceUrl || selected.title;
    usedIds.add(identity);
    return {
      id: `${date}-slot-${slot.slot}`,
      registeredAt: new Date().toISOString(),
      date,
      slot: slot.slot,
      sourceCategory: slot.sourceCategory,
      blogDisplayCategory: slot.blogDisplay,
      blogCategory: slot.blogDisplay,
      sourcePostId: selected.sourcePostId,
      postTitle: selected.title,
      sourceUrl: selected.sourceUrl || sourceUrl,
      sourceMedia: selected.metadata?.media || selected.metadata?.sourceMedia || "",
      author: selected.author,
      articleDate: selected.publishedAt,
      postRegisteredAt: selected.registeredAt,
      coreFacts: selected.text,
      authorInterpretation: "",
      practicalApplication: "",
      originalSourceVerified: selected.originalSourceVerified,
      searchKeyword: keywordsForPost(selected, slot),
      excludedTopics: slot.excludedTopics,
      publishPurpose: purposeForSlot(slot, selected.title),
      status: "대기",
      draftReady: false,
      draftTitle: "",
      draftBody: "",
      draftTags: [],
      draftImages: [],
      draftTitleImagePath: "",
      memberBoardStatus: "대기",
      memberBoardTitle: "",
      memberBoardUrl: "",
      memberBoardFailureReason: "",
      failureReason: "",
      retryCount: 0,
      scheduledAt: formatScheduledAt(date, slot.slot - 1),
      sourceCategoryRule: slot
    };
  });
  return {
    date,
    createdAt: new Date().toISOString(),
    fetchedAt,
    sourceUrl,
    status: "초안 준비 전",
    reviewMode: "approval_required",
    publishStartAt: `${date}T12:00:00+09:00`,
    publishIntervalMinutes: DAILY_PUBLISH_INTERVAL_MINUTES,
    items
  };
}

function updatePlanItem(runtimeRoot, date, itemId, patch) {
  const plan = readDailyPlan(runtimeRoot, date);
  if (!plan) throw new Error(`일일 계획을 찾을 수 없습니다: ${date}`);
  const item = plan.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`일일 계획 항목을 찾을 수 없습니다: ${itemId}`);
  Object.assign(item, patch);
  if (patch.status && !PLAN_STATUSES.has(patch.status)) throw new Error(`지원하지 않는 계획 상태입니다: ${patch.status}`);
  plan.updatedAt = new Date().toISOString();
  writeDailyPlan(runtimeRoot, plan);
  return item;
}

function extractStyleRules(posts = []) {
  const normalized = posts.map(normalizeMemberPost).filter((post) => post.title || post.text);
  const titles = normalized.map((post) => post.title).filter(Boolean);
  const bodies = normalized.map((post) => post.text).filter(Boolean);
  const averageTitleLength = titles.length ? Math.round(titles.reduce((sum, title) => sum + title.length, 0) / titles.length) : 0;
  const commonTerms = ["정리", "확인", "기준", "방법", "주의", "자동차", "보험", "정비"]
    .map((term) => ({ term, count: normalized.filter((post) => `${post.title} ${post.text}`.includes(term)).length }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
  return {
    sourceUrl: NAVER_STYLE_URL,
    extractedAt: new Date().toISOString(),
    extractionMode: "initial_crawl_heuristic",
    sampleCount: normalized.length,
    title: { averageLength: averageTitleLength, samples: titles.slice(0, 20) },
    body: { sampleCount: bodies.length, usesHeadings: bodies.some((body) => /\n\s*(?:#{1,6}|\[SECTION)/.test(body)) },
    commonTerms,
    rules: [
      "원문 사실과 작성자 해설을 구분합니다.",
      "자동차·보험·정비와 직접 관련된 실무 정보를 우선합니다.",
      "수치·날짜·조건·출처는 원문 범위에서 보존합니다.",
      "확인되지 않은 내용은 단정하지 않습니다."
    ]
  };
}

function readStyleRules(runtimeRoot) {
  const filePath = getStyleRulesPath(runtimeRoot);
  return fs.existsSync(filePath) ? readJson(filePath, null) : null;
}

function writeStyleRules(runtimeRoot, rules) {
  return writeJson(getStyleRulesPath(runtimeRoot), rules);
}

module.exports = {
  MEMBER_BOARD_URL,
  MEMBER_BOARD_PUBLIC_URL,
  MEMBER_BOARD_WRITE_URL,
  MEMBER_BOARD_AUTO_TITLE_PREFIX,
  DEFAULT_DAILY_PUBLISH_CATEGORY,
  NAVER_STYLE_URL,
  SOURCE_CATEGORY_SLOTS,
  PLAN_STATUSES,
  DAILY_PUBLISH_INTERVAL_MINUTES,
  ensureDailyWorkflowFiles,
  getDailyPlanPath,
  getMemberSourcePath,
  getStyleRulesPath,
  readDailyPlan,
  writeDailyPlan,
  updatePlanItem,
  readMemberSource,
  writeMemberSource,
  createDailyPlan,
  createRandomResearchPlan,
  validateRandomTopicCandidate,
  extractStyleRules,
  readStyleRules,
  writeStyleRules,
  normalizeMemberPost
};
