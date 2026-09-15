const path = require("node:path");
const {
  MEMBER_BOARD_WRITE_URL,
  MEMBER_BOARD_AUTO_TITLE_PREFIX
} = require("./dailyWorkflow");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeLaunchOptions() {
  return {
    channel: "chrome",
    chromiumSandbox: true,
    headless: false,
    viewport: { width: 1440, height: 920 },
    args: ["--hide-crash-restore-bubble", "--disable-session-crashed-bubble", "--no-first-run"]
  };
}

async function pageBodyText(page) {
  return String(await page.locator("body").innerText().catch(() => ""));
}

async function looksLikeLoginPage(page) {
  const url = page.url();
  const text = await pageBodyText(page);
  const hasPasswordInput = await page.locator("input[type='password']").count().catch(() => 0);
  return /(?:\/core\/login|\/member\/login|login)/i.test(url)
    || hasPasswordInput > 0
    || (/아이디/.test(text) && /비밀번호/.test(text));
}

async function waitForManualLogin(page, log, timeoutMs = 180000) {
  log("회원마당 글쓰기 로그인 화면입니다. 열린 Chrome에서 직접 로그인·보안확인을 완료해 주세요.", "warn");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await looksLikeLoginPage(page))) {
      log("회원마당 글쓰기 로그인 세션을 확인했습니다.", "info");
      return;
    }
    await sleep(1500);
  }
  const error = new Error("회원마당 글쓰기 로그인 또는 보안 확인 완료를 제한 시간 안에 확인하지 못했습니다.");
  error.code = "MEMBER_BOARD_LOGIN_REQUIRED";
  throw error;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:script|style|iframe|object|embed|form|input|button)[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, "")
    .trim();
}

function textToHtml(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const output = [];
  let listType = "";
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = "";
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length);
      output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
    } else if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${escapeHtml((unordered || ordered)[1])}</li>`);
    } else if (!line) {
      closeList();
    } else {
      closeList();
      output.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  closeList();
  return output.join("\n");
}

function articleToHtml(article) {
  const raw = String(article || "").trim();
  if (!raw) return "";
  return /<\/?(?:p|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|br|strong|em|a)\b/i.test(raw)
    ? sanitizeHtml(raw)
    : textToHtml(raw);
}

async function setEditableHtml(editable, html) {
  await editable.evaluate((element, value) => {
    element.innerHTML = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, html);
}

async function fillRichEditor(page, html, plainText) {
  for (const frame of page.frames()) {
    const editor = frame.locator("body[contenteditable='true']").first();
    if (await editor.count().catch(() => 0)) {
      await setEditableHtml(editor, html);
      return "iframe-contenteditable";
    }
  }

  const editable = page.locator("[contenteditable='true']:visible").first();
  if (await editable.count().catch(() => 0)) {
    await setEditableHtml(editable, html);
    return "contenteditable";
  }

  const textarea = page.locator("textarea:visible").first();
  if (await textarea.count().catch(() => 0)) {
    await textarea.fill(plainText);
    return "textarea-plain-text";
  }

  const error = new Error("회원마당 리치텍스트 편집기 입력 영역을 찾지 못했습니다.");
  error.code = "MEMBER_BOARD_EDITOR_UNRESOLVED";
  throw error;
}

async function publishMemberBoardPost({
  browserProfileDir,
  title,
  article,
  attachments = [],
  url = MEMBER_BOARD_WRITE_URL,
  log = () => {}
} = {}) {
  if (!browserProfileDir) throw new Error("회원마당 글쓰기용 Chrome 프로필 경로가 필요합니다.");
  const rawTitle = String(title || "").trim();
  if (!rawTitle) throw new Error("회원마당 등록 제목이 없습니다.");
  const memberTitle = rawTitle.startsWith(MEMBER_BOARD_AUTO_TITLE_PREFIX)
    ? rawTitle
    : `${MEMBER_BOARD_AUTO_TITLE_PREFIX} ${rawTitle}`;
  const plainText = String(article || "").trim();
  if (!plainText) throw new Error("회원마당 등록 본문이 없습니다.");
  const html = articleToHtml(plainText);
  const chromium = require("playwright-core").chromium;
  const context = await chromium.launchPersistentContext(path.resolve(browserProfileDir), chromeLaunchOptions());
  let page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(700);
    if (await looksLikeLoginPage(page)) await waitForManualLogin(page, log);
    if (!/onsaecar\.co\.kr\/board\/add/i.test(page.url())) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(700);
    }
    if (await looksLikeLoginPage(page)) await waitForManualLogin(page, log);

    const titleInput = page.locator('input[placeholder="제목을 입력해주세요"]').first();
    if (!(await titleInput.count().catch(() => 0))) {
      const error = new Error("회원마당 글쓰기 제목 입력칸을 찾지 못했습니다. 로그인 상태와 페이지 구조를 확인하세요.");
      error.code = "MEMBER_BOARD_TITLE_UNRESOLVED";
      throw error;
    }
    await titleInput.fill(memberTitle);
    const editorMode = await fillRichEditor(page, html, plainText);

    const fileInput = page.locator('input[type="file"]').first();
    if (attachments.length && await fileInput.count().catch(() => 0)) {
      await fileInput.setInputFiles(attachments.map((item) => path.resolve(item)));
    } else if (attachments.length) {
      log("회원마당 첨부 입력칸을 찾지 못해 첨부 없이 등록을 중단합니다.", "warn");
      throw new Error("회원마당 첨부파일 입력칸을 찾지 못했습니다.");
    }

    const registerButton = page.locator("button").filter({ hasText: /^\s*등록\s*$/ }).first();
    const submitButton = (await registerButton.count().catch(() => 0))
      ? registerButton
      : page.locator('input[type="submit"][value="등록"], input[type="button"][value="등록"]').first();
    if (!(await submitButton.count().catch(() => 0))) {
      const error = new Error("회원마당 글쓰기 등록 버튼을 찾지 못했습니다.");
      error.code = "MEMBER_BOARD_SUBMIT_UNRESOLVED";
      throw error;
    }

    let dialogMessage = "";
    const dialogHandler = async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept();
    };
    page.once("dialog", dialogHandler);
    await submitButton.click({ timeout: 10000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const body = await pageBodyText(page);
    if (/로그인|권한이 없|필수 입력|등록 실패|오류가 발생|실패했습니다/i.test(dialogMessage)) {
      throw new Error(`회원마당 등록 실패: ${dialogMessage}`);
    }
    const titleAfter = await titleInput.inputValue().catch(() => "");
    const movedToList = /\/board(?:[?#]|$)/i.test(page.url()) && !/\/board\/add/i.test(page.url());
    const successMessage = /등록되었|작성되었|저장되었|등록 완료|작성 완료/i.test(dialogMessage);
    if (!movedToList && !successMessage && titleAfter === memberTitle) {
      throw new Error("회원마당 등록 결과를 확인하지 못했습니다. 제출 여부를 확인하지 않아 중복 등록을 방지했습니다.");
    }
    log(`회원마당 등록 완료: ${memberTitle} (${editorMode})`, "info");
    return {
      status: "success",
      title: memberTitle,
      url: page.url(),
      editorMode,
      dialogMessage
    };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = {
  MEMBER_BOARD_WRITE_URL,
  MEMBER_BOARD_AUTO_TITLE_PREFIX,
  articleToHtml,
  publishMemberBoardPost
};
