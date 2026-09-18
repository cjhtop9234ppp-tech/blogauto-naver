const path = require("node:path");
const {
  MEMBER_BOARD_URL,
  NAVER_STYLE_URL,
  MEMBER_BOARD_AUTO_TITLE_PREFIX,
  normalizeMemberPost
} = require("./dailyWorkflow");
const { launchPersistentContextWithRecovery } = require("./chromeProfileLauncher");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeLaunchOptions() {
  return {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 920 },
    args: ["--disable-blink-features=AutomationControlled"]
  };
}

async function loadChromium() {
  try {
    return require("playwright-core").chromium;
  } catch {
    throw new Error("playwright-core가 설치되어 있지 않아 Chrome 수집을 실행할 수 없습니다.");
  }
}

async function pageBodyText(page) {
  return String(await page.locator("body").innerText().catch(() => ""));
}

async function looksLikeLoginPage(page) {
  const url = page.url();
  const text = await pageBodyText(page);
  const hasPasswordInput = await page.locator("input[type='password']").count().catch(() => 0);
  return /login|로그인/i.test(url) || hasPasswordInput > 0 || (/아이디/.test(text) && /비밀번호/.test(text));
}

async function waitForManualLogin(page, log, timeoutMs = 180000) {
  const startedAt = Date.now();
  log("회원마당 로그인 화면입니다. 열린 Chrome에서 사용자가 직접 로그인해 주세요.", "warn");
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await looksLikeLoginPage(page))) {
      log("회원마당 로그인 세션을 확인했습니다.", "info");
      return;
    }
    await sleep(1500);
  }
  const error = new Error("회원마당 로그인 또는 보안 확인 완료를 제한 시간 안에 확인하지 못했습니다.");
  error.code = "MEMBER_BOARD_LOGIN_REQUIRED";
  throw error;
}

async function collectAnchors(page) {
  return page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => ({
    text: String(anchor.textContent || "").replace(/\s+/g, " ").trim(),
    href: anchor.href,
    parentText: String(anchor.parentElement?.textContent || "").replace(/\s+/g, " ").trim()
  })).filter((item) => item.text && item.href));
}

function isPaginationAnchor(item) {
  return /(?:[?&](?:page|pageNo|p)=\d+|javascript:.*(?:page|pageNo))/i.test(item.href) || /^\d{1,3}$/.test(item.text);
}

function isLegacyMemberBoardUrl(url) {
  return /onsaecar\.co\.kr\/core\/board\/member(?:[?#/]|$)/i.test(String(url || ""));
}

function isDetailAnchor(item, boardUrl) {
  if (!item.href || !item.text || isPaginationAnchor(item)) return false;
  if (item.text.trim().startsWith(MEMBER_BOARD_AUTO_TITLE_PREFIX)) return false;
  if (!/onsaecar\.co\.kr/i.test(item.href)) return false;
  if (!/(?:core\/board|\/board\/get_data\/)/i.test(item.href)) return false;
  if (/login|로그인|write|등록|검색|다음|이전|목록|공지/i.test(`${item.text} ${item.href}`)) return false;
  return item.href !== boardUrl && item.text.length >= 2 && item.text.length <= 300;
}

function pageNumberFromUrl(url) {
  const text = String(url || "");
  const queryMatch = text.match(/[?&](?:page|pageNo|p)=(\d+)/i);
  if (queryMatch) return Number(queryMatch[1]);
  const javascriptMatch = text.match(/(?:goPage|page|pageNo)\s*\(\s*['"\s%]*(\d+)/i);
  return javascriptMatch ? Number(javascriptMatch[1]) : 0;
}

async function collectListPage(page, boardUrl) {
  const anchors = await collectAnchors(page);
  const detailMap = new Map();
  const isMemberBoard = isLegacyMemberBoardUrl(boardUrl);
  if (!isMemberBoard) {
    for (const item of anchors) {
      if (isDetailAnchor(item, boardUrl) && !detailMap.has(item.href)) detailMap.set(item.href, item);
    }
  }
  const boardOrigin = new URL(boardUrl).origin;
  const rowCandidates = isMemberBoard
    ? await page.locator("tr").evaluateAll((rows, origin) => rows.map((row) => {
      const titleCell = row.querySelector(".msg_tit[onclick*='get_content']");
      if (!titleCell) return null;
      const onclick = titleCell.getAttribute("onclick") || "";
      const match = onclick.match(/get_content\(['\"]?(\d+)/i);
      if (!match) return null;
      const cells = [...row.querySelectorAll("td")].map((cell) => String(cell.textContent || "").replace(/\s+/g, " ").trim());
      return {
        text: String(titleCell.textContent || "").replace(/\s+/g, " ").trim(),
        postId: match[1],
        registeredAt: cells[2] || "",
        author: cells[6] || "",
        sourceUrl: `${origin}/core/board/member?post=${match[1]}`
      };
    }).filter((item) => item && !item.text.startsWith(MEMBER_BOARD_AUTO_TITLE_PREFIX)), boardOrigin)
    : [];
  for (const item of rowCandidates) {
    const key = `member-api:${item.postId}`;
    if (!detailMap.has(key)) detailMap.set(key, {
      ...item,
      href: item.sourceUrl,
      contentUrl: `${boardOrigin}/core/board/member/get_content`,
      parentText: "회원마당"
    });
  }
  const pageLinks = anchors
    .filter(isPaginationAnchor)
    .map((item) => ({ ...item, page: pageNumberFromUrl(item.href) }))
    .filter((item) => item.page > 0);
  return { details: [...detailMap.values()], pageLinks };
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function collectDetail(detailPage, candidate, log, requestPage = detailPage, requestContext = null) {
  if (candidate.contentUrl && candidate.postId) {
    let html = "";
    if (requestContext?.post) {
      const response = await requestContext.post(candidate.contentUrl, {
        form: { no: candidate.postId },
        timeout: 15000
      });
      if (!response.ok()) throw new Error(`회원마당 본문 요청 실패 (${response.status()})`);
      html = await response.text();
    } else {
      html = await requestPage.evaluate(async ({ url, postId }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: new URLSearchParams({ no: postId }).toString(),
            signal: controller.signal
          });
          if (!response.ok) throw new Error(`회원마당 본문 요청 실패 (${response.status})`);
          return response.text();
        } finally {
          clearTimeout(timer);
        }
      }, { url: candidate.contentUrl, postId: candidate.postId });
    }
    const text = htmlToText(html);
    const title = candidate.text || "회원마당 게시글";
    const body = text.replace(title, "").trim();
    return normalizeMemberPost({
      sourcePostId: candidate.postId,
      title,
      text: body || text,
      sourceUrl: candidate.href,
      sourceCategory: "회원마당",
      registeredAt: candidate.registeredAt || "",
      author: candidate.author || "",
      originalSourceVerified: true,
      metadata: { listLabel: candidate.text, contentEndpoint: candidate.contentUrl }
    });
  } else {
    await detailPage.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: 45000 });
    await detailPage.waitForTimeout(700);
    if (await looksLikeLoginPage(detailPage)) {
      await waitForManualLogin(detailPage, log);
    }
  }
  const text = await pageBodyText(detailPage);
  const title = candidate.text || String(await detailPage.locator("h1, h2, .title, .subject, [class*='title'], [class*='subject']").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const body = text.replace(title, "").trim();
  const dateMatch = body.match(/(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})(?:일)?(?:\s+(\d{1,2}):(\d{2}))?/);
  const registeredAt = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}${dateMatch[4] ? `T${String(dateMatch[4]).padStart(2, "0")}:${dateMatch[5]}:00+09:00` : ""}`
    : "";
  const category = String(await detailPage.locator("[class*='category'], .category, .board-name, .breadcrumb").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const idMatch = candidate.href.match(/(?:get_data\/|(?:idx|seq|no|id|wr_id)[=\/])(\d+)/i);
  return normalizeMemberPost({
    sourcePostId: idMatch?.[1] || "",
    title,
    text: body,
    sourceUrl: candidate.contentUrl ? candidate.href : candidate.href,
    sourceCategory: category || candidate.parentText,
    registeredAt,
    author: candidate.author || "",
    originalSourceVerified: true,
    metadata: { listLabel: candidate.text }
  });
}

async function gotoBoardPage(page, url, pageNumber) {
  if (pageNumber <= 1) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    return;
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.evaluate((number) => {
    const form = document.querySelector("#pageform");
    const input = form?.querySelector("#page_page");
    if (form && input) {
      input.value = String(number);
      form.submit();
      return;
    }
    if (typeof window.goPage === "function") {
      window.goPage(String(number));
      return;
    }
    const pageLink = [...document.querySelectorAll("a[href]")].find((anchor) => (
      String(anchor.getAttribute("href") || "").includes(`goPage('${number}')`)
      || String(anchor.textContent || "").trim() === String(number)
    ));
    if (pageLink) {
      pageLink.click();
      return;
    }
    throw new Error("회원마당 페이지 이동 방법을 찾지 못했습니다.");
  }, pageNumber);
  await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
}

async function crawlBoard({ browserProfileDir, url = MEMBER_BOARD_URL, maxPages = 17, maxPosts = 329, log = () => {} } = {}) {
  if (!browserProfileDir) throw new Error("Chrome 프로필 경로가 필요합니다.");
  const chromium = await loadChromium();
  const context = await launchPersistentContextWithRecovery(
    chromium,
    path.resolve(browserProfileDir),
    chromeLaunchOptions(),
    { label: "회원마당 수집용 Chrome", log }
  );
  let listPage = context.pages()[0] || await context.newPage();
  const isMemberBoard = isLegacyMemberBoardUrl(url);
  let detailPage = isMemberBoard ? null : await context.newPage();
  try {
    await listPage.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await listPage.waitForTimeout(900);
    if (await looksLikeLoginPage(listPage)) await waitForManualLogin(listPage, log);

    const visitedPages = new Set();
    const candidates = new Map();
    const pageQueue = [{ url, page: 1 }];
    while (pageQueue.length && visitedPages.size < maxPages) {
      const target = pageQueue.shift();
      if (visitedPages.has(target.page)) continue;
      visitedPages.add(target.page);
      await gotoBoardPage(listPage, target.url, target.page);
      await listPage.waitForTimeout(500);
      if (await looksLikeLoginPage(listPage)) await waitForManualLogin(listPage, log);
      const pageData = await collectListPage(listPage, url);
      for (const candidate of pageData.details) if (!candidates.has(candidate.href)) candidates.set(candidate.href, candidate);
      for (const link of pageData.pageLinks) {
        if (link.page <= maxPages && !visitedPages.has(link.page)) pageQueue.push({ url, page: link.page });
      }
      if (pageData.details.length) log(`회원마당 목록 ${visitedPages.size}/${maxPages}페이지 확인: ${pageData.details.length}건`, "info");
    }

    if (!candidates.size) {
      const error = new Error("회원마당 게시글 링크를 찾지 못했습니다. 로그인 세션 또는 게시판 HTML 구조를 확인하세요.");
      error.code = "MEMBER_BOARD_SELECTOR_UNRESOLVED";
      throw error;
    }

    const selectedCandidates = [...candidates.values()].slice(0, maxPosts);
    log(`회원마당 상세 본문 수집 시작: ${selectedCandidates.length}건`, "info");
    const posts = [];
    const detailPages = isMemberBoard ? [null, null, null, null] : [detailPage];
    for (let index = detailPages.length; index < Math.min(4, selectedCandidates.length); index += 1) {
      detailPages.push(await context.newPage());
    }
    let nextIndex = 0;
    let completed = 0;
    await Promise.all(detailPages.map(async (workerPage) => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= selectedCandidates.length) return;
        const candidate = selectedCandidates[index];
        try {
          const post = await collectDetail(workerPage, candidate, log, listPage, isMemberBoard ? context.request : null);
          posts.push(post);
        } catch (error) {
          log(`회원마당 게시글을 읽지 못했습니다: ${candidate.text} (${error.message})`, "warn");
        }
        completed += 1;
        if (completed % 10 === 0 || completed === selectedCandidates.length) {
          log(`회원마당 상세 본문 수집 진행: ${completed}/${selectedCandidates.length}건`, "info");
        }
      }
    }));
    return {
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      pagesVisited: visitedPages.size,
      candidateCount: candidates.size,
      posts
    };
  } finally {
    await detailPage?.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function crawlNaverStylePosts(options = {}) {
  if (!options.browserProfileDir) throw new Error("Chrome 프로필 경로가 필요합니다.");
  const chromium = await loadChromium();
  const context = await launchPersistentContextWithRecovery(
    chromium,
    path.resolve(options.browserProfileDir),
    chromeLaunchOptions(),
    { label: "네이버 스타일 수집용 Chrome", log: options.log }
  );
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(NAVER_STYLE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    const frame = page.frames().find((candidate) => (
      candidate.name() === "mainFrame" || /blog\.naver\.com\/PostList\.naver/i.test(candidate.url())
    ));
    if (!frame) throw new Error("네이버 블로그 본문 프레임(mainFrame)을 찾지 못했습니다.");
    const postLocator = frame.locator("div[id^='post_']");
    await postLocator.first().waitFor({ state: "attached", timeout: 15000 });
    const posts = await postLocator.evaluateAll((postElements, sourceUrl) => postElements.map((post) => {
      const title = String(post.querySelector(".se-documentTitle .se-title-text, .se-title-text")?.textContent || "")
        .replace(/\s+/g, " ").trim();
      const body = String(post.querySelector(".se-main-container")?.innerText || "").trim();
      const category = String(post.querySelector(".se-documentTitle .blog2_series a")?.textContent || "")
        .replace(/\s+/g, " ").trim();
      const author = String(post.querySelector(".se-documentTitle .nick, .se-documentTitle .writer")?.textContent || "")
        .replace(/\s+/g, " ").trim();
      const publishedAt = String(post.querySelector(".se-documentTitle .se_publishDate")?.textContent || "")
        .replace(/\s+/g, " ").trim();
      const url = String(post.querySelector(".copyTargetUrl")?.value || "").trim()
        || `${new URL(sourceUrl).origin}/ctx9234/${String(post.id || "").replace(/^post-?/, "")}`;
      const postId = (url.match(/\/([0-9]{8,})(?:[?#]|$)/) || [])[1] || "";
      const tags = [...post.querySelectorAll(".wrap_tag a")]
        .map((tag) => String(tag.textContent || "").replace(/^#/, "").trim())
        .filter(Boolean);
      return { title, text: body, sourceUrl: url, sourcePostId: postId, sourceCategory: category, author, publishedAt, tags };
    }).filter((post) => post.title && post.text), NAVER_STYLE_URL);
    if (!posts.length) {
      const error = new Error("네이버 블로그 공개 카테고리에서 게시글 본문을 찾지 못했습니다.");
      error.code = "NAVER_STYLE_SELECTOR_UNRESOLVED";
      throw error;
    }
    options.log?.(`네이버 블로그 ${posts.length}건의 공개 글 본문을 확인했습니다.`, "info");
    return {
      sourceUrl: NAVER_STYLE_URL,
      fetchedAt: new Date().toISOString(),
      pagesVisited: 1,
      candidateCount: posts.length,
      posts: posts.map(normalizeMemberPost)
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

module.exports = {
  MEMBER_BOARD_URL,
  NAVER_STYLE_URL,
  crawlBoard,
  crawlMemberBoard: crawlBoard,
  crawlNaverStylePosts
};
