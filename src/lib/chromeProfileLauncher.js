const path = require("node:path");

function isClosedBrowserLaunchError(error) {
  const text = String(error?.message || error || "");
  return /launchPersistentContext|target page.*context.*browser.*closed|process did exit|browser has been closed|context has been closed/i.test(text);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch a persistent Chrome profile without deleting locks or terminating
 * processes owned by the user. A short retry handles Chrome's hand-off/stale
 * startup race; a descriptive error is returned when the profile is still in use.
 */
async function launchPersistentContextWithRecovery(chromium, browserProfileDir, options, {
  label = "Chrome",
  log = () => {},
  retries = 2
} = {}) {
  const resolvedProfileDir = path.resolve(browserProfileDir);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const context = await chromium.launchPersistentContext(resolvedProfileDir, options);
      if (attempt > 0) log(`${label} 프로필을 재시도 ${attempt}회 후 열었습니다.`, "info");
      return context;
    } catch (error) {
      lastError = error;
      if (!isClosedBrowserLaunchError(error) || attempt >= retries) break;
      log(`${label}가 프로필을 사용 중이거나 시작 직후 종료되었습니다. ${attempt + 1}/${retries}회 재시도합니다.`, "warn");
      await sleep(1200 * (attempt + 1));
    }
  }

  if (isClosedBrowserLaunchError(lastError)) {
    const error = new Error(
      `${label} Chrome이 같은 자동화 프로필에서 즉시 종료되었습니다. `
      + "회원마당 로그인 창 또는 이전 자동화 Chrome 창이 열려 있으면 그 창을 먼저 닫은 뒤 다시 시도하세요. "
      + "네이버 발행 브라우저는 닫지 않아도 됩니다."
    );
    error.code = "BROWSER_PROFILE_LAUNCH_CLOSED";
    error.cause = lastError;
    throw error;
  }
  throw lastError;
}

module.exports = {
  isClosedBrowserLaunchError,
  launchPersistentContextWithRecovery
};
