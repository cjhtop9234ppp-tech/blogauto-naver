const { _electron: electron } = require("playwright-core");
const electronExecutable = require("electron");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const smokeRuntimeRoot = path.resolve(__dirname, "..", "runtime", ".smoke-electron-runtime");
  const screenshotDir = path.resolve(__dirname, "..", "runtime", ".smoke-electron-screenshots");
  const userDataDir = path.join(smokeRuntimeRoot, "browser-profile");
  const smokeAssetDir = path.join(smokeRuntimeRoot, "account-assets", "acct_smoke_delete");
  const smokeSampleImagePath = path.join(smokeAssetDir, "sample.png");
  fs.rmSync(smokeRuntimeRoot, { recursive: true, force: true });
  fs.rmSync(screenshotDir, { recursive: true, force: true });
  fs.mkdirSync(smokeRuntimeRoot, { recursive: true });
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log("Launching Electron...");
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: ["--disable-gpu", "--disable-software-rasterizer", `--user-data-dir=${userDataDir}`, "."],
    env: {
      ...process.env,
      BLOGAUTO_SKIP_CODEX_USAGE_REFRESH: "1",
      BLOGAUTO_RUNTIME_ROOT: smokeRuntimeRoot
    }
  });
  try {
    console.log("Waiting for first window...");
    const window = await Promise.race([
      app.firstWindow(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Electron window.")), 20000))
    ]);
    console.log("Window opened.");
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector("#jobForm", { timeout: 15000 });

    await window.evaluate(() => {
      const visibility = document.querySelector("#publishVisibility");
      const schedule = document.querySelector("#publishScheduleMode");
      const reserve = document.querySelector("#reserveAfterHours");
      if (visibility) visibility.value = "private";
      if (schedule) schedule.value = "now";
      if (reserve) reserve.value = "0";
      visibility?.dispatchEvent(new Event("change", { bubbles: true }));
      schedule?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const defaultFormValid = await window.locator("#jobForm").evaluate((form) => form.checkValidity());
    if (!defaultFormValid) {
      throw new Error("Default private/now form must remain valid when reservation is disabled.");
    }

    const checks = [
      ["title", "네이버 블로그 및 온새카 회원마당 글쓰기 자동화"],
      ["blog id", "#blogId"],
      ["manual login guidance", ".account-login-guidance"],
      ["startup notice", "#startupNotice"],
      ["dismiss startup notice", "#dismissStartupNoticeButton"],
      ["add account", "#addAccountButton"],
      ["update account", "#updateAccountButton"],
      ["clear account form", "#clearAccountFormButton"],
      ["account sample preview", "#accountSampleImagePreview"],
      ["account sample choose", "#chooseAccountSampleImageButton"],
      ["account sample delete", "#deleteAccountSampleImageButton"],
      ["topic", "#topic"],
      ["account list", "#accountList"],
      ["category list", "#categoryList"],
      ["topic mode", "#topicMode"],
      ["content source mode", "#contentSourceMode"],
      ["file upload panel", "#fileUploadPanel"],
      ["source drop zone", "#sourceDropZone"],
      ["clear uploaded files", "#clearSourceFilesButton"],
      ["publish visibility", "#publishVisibility"],
      ["publish schedule", "#publishScheduleMode"],
      ["codex model", "#codexModel"],
      ["main log", "#mainLogStream"],
      ["research log", "#researchLogStream"],
      ["writer log", "#writerLogStream"],
      ["selected title", "#selectedTitle"],
      ["preview status", "#previewStatus"],
      ["preview source files", "#previewSourceFiles"],
      ["preview tags", "#previewTags"],
      ["category excluded topics", "#categoryExcludedTopics"],
      ["category publish purpose", "#categoryPublishPurpose"],
      ["category preferred tone", "#categoryPreferredTone"],
      ["category freshness level", "#categoryFreshnessLevel"],
      ["article", "#articlePreview"],
      ["title image aspect ratio", "#titleImageAspectRatio"],
      ["body image aspect ratio", "#bodyImageAspectRatio"],
      ["image grid", "#imageGrid"],
      ["history", "#historyBody"],
      ["codex weekly usage badge", "#codexWeeklyLimitBadge"]
    ];

    for (const [name, selectorOrText] of checks) {
      if (name === "title") {
        const title = await window.title();
        if (!title.includes(selectorOrText)) {
          throw new Error(`Expected window title to include ${selectorOrText}, got ${title}`);
        }
        continue;
      }
      const count = await window.locator(selectorOrText).count();
      if (!count) {
        throw new Error(`Missing UI element: ${name}`);
      }
    }

    if (await window.locator("#naverId, #naverPassword").count()) {
      throw new Error("Naver credential fields must not be present.");
    }
    const loginGuidance = await window.locator(".account-login-guidance").textContent();
    if (!String(loginGuidance || "").includes("직접 입력")) {
      throw new Error("Manual Naver login guidance is missing.");
    }
    if (await window.locator("#startupNotice").isVisible().catch(() => false)) {
      await window.evaluate(() => {
        window.localStorage.setItem("blogauto.startupNotice.dismissed.v2", "true");
        const notice = document.querySelector("#startupNotice");
        if (notice) notice.hidden = true;
      });
    }

    const sourceSmokeFile = path.join(smokeRuntimeRoot, "source-delete-smoke.md");
    fs.writeFileSync(sourceSmokeFile, "# 삭제 테스트 원본\n\n파일 목록에서 제거되는지 확인합니다.", "utf8");
    await window.locator("#contentSourceMode").selectOption("file_upload");
    await window.locator("#sourceFileInput").setInputFiles(sourceSmokeFile);
    await window.waitForSelector(".source-file-card");
    const dialogHandler = (dialog) => dialog.accept();
    window.on("dialog", dialogHandler);
    await window.locator(".source-file-remove").first().click();
    await window.waitForTimeout(150);
    window.off("dialog", dialogHandler);
    if (await window.locator(".source-file-card").count()) {
      throw new Error("Uploaded source file was not removed from the list.");
    }
    if (await window.locator("#sourceFileStatus").textContent().then((text) => String(text).includes("작업 시작 가능"))) {
      throw new Error("Source status still reports a removed file as ready.");
    }
    console.log("Uploaded source-file deletion UI passed.");

    await window.evaluate(() => {
      const grid = document.querySelector("#imageGrid");
      if (!grid) return;
      grid.innerHTML = "";
      for (let index = 1; index <= 12; index += 1) {
        const card = document.createElement("div");
        card.className = "thumb";
        card.innerHTML = `
          <div style="height:90px;background:#dbeafe;border-radius:6px"></div>
          <span>IMAGE ${index}</span>
          <code class="image-path">runtime/image/test_${index}.png</code>
          <div class="thumb-actions"><button type="button">open</button><button type="button">show</button></div>
        `;
        grid.appendChild(card);
      }
    });
    const centerColumnScrollable = await window.locator(".center-column").evaluate((element) => (
      element.scrollHeight > element.clientHeight
    ));
    if (!centerColumnScrollable) {
      throw new Error("Center column is not scrollable with many images and central panels.");
    }

    const panelSelectors = [
      ".preview-panel",
      ".main-log-panel",
      ".research-log-panel",
      ".writer-log-panel",
      ".history-panel"
    ];
    for (const { width, height } of [
      { width: 1440, height: 900 },
      { width: 1280, height: 768 },
      { width: 1180, height: 900 },
      { width: 980, height: 900 }
    ]) {
      const nativeSize = await app.evaluate(({ BrowserWindow }, size) => {
        const targetWindow = BrowserWindow.getAllWindows()[0];
        targetWindow.setContentSize(size.width, size.height);
        return targetWindow.getContentSize();
      }, { width, height });
      await window.waitForTimeout(250);
      const viewportSize = await window.evaluate(() => ({
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
      }));
      if (Math.abs(nativeSize[0] - viewportSize.width) > 1 || Math.abs(nativeSize[1] - viewportSize.height) > 1) {
        throw new Error(`Native window/content viewport mismatch at ${width}x${height}: native=${nativeSize.join("x")}, viewport=${viewportSize.width}x${viewportSize.height}`);
      }
      const layoutResult = await window.evaluate(({ selectors, requireVerticalFit }) => {
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        return selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, ok: false, reason: "missing" };
          const rect = element.getBoundingClientRect();
          const horizontalOk = rect.left >= -1 && rect.right <= viewportWidth + 1 && rect.width > 0;
          const verticalOk = !requireVerticalFit || (
            rect.top >= -1 && rect.bottom <= viewportHeight + 1 && rect.height > 0
          );
          return {
            selector,
            ok: horizontalOk && verticalOk,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            viewportWidth,
            viewportHeight
          };
        });
      }, { selectors: panelSelectors, requireVerticalFit: width > 980 });
      const badPanel = layoutResult.find((item) => !item.ok);
      if (badPanel) {
        throw new Error(`Panel overflows at ${width}x${height}: ${JSON.stringify(badPanel)}`);
      }
      await window.screenshot({ path: path.join(screenshotDir, `layout-${width}x${height}.png`) });
    }

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 900);
    });
    await window.waitForTimeout(250);
    console.log("Responsive layout screenshots captured.");

    fs.mkdirSync(smokeAssetDir, { recursive: true });
    fs.writeFileSync(smokeSampleImagePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64"
    ));
    await window.evaluate(async ({ sampleImagePath }) => {
      await window.blogAuto.saveAccountStore({
        selectedAccountId: "acct_smoke_delete",
        accounts: [{
          id: "acct_smoke_delete",
          label: "Smoke Delete Account",
          blogId: "smoke-blog",
          checked: true,
          sessionStatus: "unknown",
          sessionCheckedAt: "",
          sampleImagePath,
          sampleImageHash: "smokehash",
          sampleImageUpdatedAt: new Date().toISOString(),
          imageStylePrompt: "smoke custom image style",
          imageStylePromptUpdatedAt: new Date().toISOString(),
          imageStylePromptStatus: "ready",
          imageStylePromptSourceImageHash: "smokehash",
          imageStylePromptError: "",
          categories: [{
            id: "cat_smoke_delete",
            name: "Smoke Category",
            keyword: "smoke keyword",
            excludedTopics: "smoke excluded topic",
            publishPurpose: "smoke publish purpose",
            preferredTone: "smoke preferred tone",
            freshnessLevel: "high",
            searchChannel: "news",
            primarySearchProvider: "google",
            fallbackSearchProvider: "naver",
            trustBlogAsSource: true,
            checked: true
          }]
        }]
      });
    }, { sampleImagePath: smokeSampleImagePath });
    await window.waitForSelector(".account-row");
    const rowSessionButtons = await window.locator(".account-row [data-action='session']").count();
    if (!rowSessionButtons) {
      throw new Error("Account row session check button is missing.");
    }
    await window.locator("#toggleAccountManagerButton").click();
    await window.locator(".account-row").filter({ hasText: "Smoke Delete Account" }).click();
    const samplePreviewImages = await window.locator("#accountSampleImagePreview img").count();
    if (!samplePreviewImages) {
      throw new Error("Account sample image preview did not render.");
    }
    await window.screenshot({ path: path.join(screenshotDir, "manual-login-account-ui.png") });
    console.log("Manual-login account UI captured.");
    await window.locator(".category-row").filter({ hasText: "Smoke Category" }).locator("[data-action='edit']").click();
    const categoryEditSnapshot = await window.evaluate(() => ({
      name: document.querySelector("#categoryName")?.value || "",
      keyword: document.querySelector("#categoryKeyword")?.value || "",
      excludedTopics: document.querySelector("#categoryExcludedTopics")?.value || "",
      publishPurpose: document.querySelector("#categoryPublishPurpose")?.value || "",
      preferredTone: document.querySelector("#categoryPreferredTone")?.value || "",
      freshnessLevel: document.querySelector("#categoryFreshnessLevel")?.value || "",
      searchChannel: document.querySelector("#categorySearchChannel")?.value || "",
      primarySearchProvider: document.querySelector("#categoryPrimarySearchProvider")?.value || "",
      fallbackSearchProvider: document.querySelector("#categoryFallbackSearchProvider")?.value || "",
      trustBlogAsSource: document.querySelector("#categoryTrustBlogAsSource")?.checked === true
    }));
    const expectedCategoryEditSnapshot = {
      name: "Smoke Category",
      keyword: "smoke keyword",
      excludedTopics: "smoke excluded topic",
      publishPurpose: "smoke publish purpose",
      preferredTone: "smoke preferred tone",
      freshnessLevel: "high",
      searchChannel: "news",
      primarySearchProvider: "google",
      fallbackSearchProvider: "naver",
      trustBlogAsSource: true
    };
    for (const [field, expected] of Object.entries(expectedCategoryEditSnapshot)) {
      if (categoryEditSnapshot[field] !== expected) {
        throw new Error(`Category edit field ${field} did not load: expected ${expected}, got ${categoryEditSnapshot[field]}`);
      }
    }
    await window.evaluate(() => document.querySelector("#toggleCategoryManagerButton")?.click());
    const autoRetryCalls = await window.evaluate(async () => {
      if (typeof window.startAutoPublishing !== "function") {
        throw new Error("startAutoPublishing is not available for renderer smoke test.");
      }
      const originalHooks = window.__blogAutoTestHooks;
      const originalDelayMinutes = document.querySelector("#repeatTermMinutes")?.value || "60";
      let calls = 0;
      window.__blogAutoTestHooks = {
        ...(originalHooks || {}),
        startJob: async () => {
          calls += 1;
          return calls < 3
            ? { status: "duplicate_retry", reason: "duplicate title in smoke test" }
            : { status: "codex_usage_limit" };
        }
      };
      const repeatTerm = document.querySelector("#repeatTermMinutes");
      if (repeatTerm) repeatTerm.value = "0";
      try {
        await window.startAutoPublishing();
      } finally {
        if (originalHooks) {
          window.__blogAutoTestHooks = originalHooks;
        } else {
          delete window.__blogAutoTestHooks;
        }
        if (repeatTerm) repeatTerm.value = originalDelayMinutes;
      }
      return calls;
    });
    if (autoRetryCalls !== 3) {
      throw new Error(`Auto publishing did not retry failed target 3 times, got ${autoRetryCalls}.`);
    }
    console.log("Duplicate retry flow passed.");
    const researchRetryCalls = await window.evaluate(async () => {
      const originalHooks = window.__blogAutoTestHooks;
      const originalDelayMinutes = document.querySelector("#repeatTermMinutes")?.value || "60";
      let calls = 0;
      window.__blogAutoTestHooks = {
        ...(originalHooks || {}),
        startJob: async () => {
          calls += 1;
          if (calls >= 2) {
            document.querySelector("#stopAutoButton")?.click();
          }
          return {
            status: "failed",
            reason: "research blocked in smoke test",
            failurePhase: "research"
          };
        }
      };
      const repeatTerm = document.querySelector("#repeatTermMinutes");
      if (repeatTerm) repeatTerm.value = "0";
      try {
        await window.startAutoPublishing();
      } finally {
        if (originalHooks) {
          window.__blogAutoTestHooks = originalHooks;
        } else {
          delete window.__blogAutoTestHooks;
        }
        if (repeatTerm) repeatTerm.value = originalDelayMinutes;
      }
      return calls;
    });
    if (researchRetryCalls !== 2) {
      throw new Error(`Research-stage auto retry should stop after 2 attempts, got ${researchRetryCalls}.`);
    }
    console.log("Research retry flow passed.");
    await window.locator("#accountLabel").fill("Smoke Edited Account");
    await window.locator("#updateAccountButton").click();
    await window.waitForFunction(() => (
      [...document.querySelectorAll(".account-row")]
        .some((row) => row.textContent.includes("Smoke Edited Account"))
    ));
    console.log("Account update flow passed.");
    window.on("dialog", (dialog) => dialog.accept());
    await window.locator(".account-row").filter({ hasText: "Smoke Edited Account" }).locator("[data-action='delete']").click();
    await window.waitForFunction(() => (
      [...document.querySelectorAll(".account-row")]
        .every((row) => !row.textContent.includes("Smoke Edited Account"))
    ));
    console.log("Account delete flow passed.");

    console.log("Electron smoke test passed.");

  } finally {
    await app.close();
    fs.rmSync(smokeRuntimeRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
