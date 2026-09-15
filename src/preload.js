const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blogAuto", {
  getInitialData: () => ipcRenderer.invoke("app:getInitialData"),
  openChromeInstallAndQuit: () => ipcRenderer.invoke("chrome:installAndQuit"),
  refreshCodexUsage: () => ipcRenderer.invoke("codex:refreshUsage"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  chooseSourceFiles: () => ipcRenderer.invoke("source:chooseFiles"),
  parseSourceFiles: (filePaths) => ipcRenderer.invoke("source:parseFiles", filePaths),
  saveAccountStore: (store) => ipcRenderer.invoke("accounts:save", store),
  chooseAccountSampleImage: (accountId) => ipcRenderer.invoke("accounts:chooseSampleImage", accountId),
  deleteAccountSampleImage: (accountId) => ipcRenderer.invoke("accounts:deleteSampleImage", accountId),
  checkAccountSession: (accountId, options) => ipcRenderer.invoke("accounts:checkSession", accountId, options),
  checkTistorySession: (tistoryBlogId) => ipcRenderer.invoke("tistory:checkSession", tistoryBlogId),
  testTistoryPublish: (form) => ipcRenderer.invoke("tistory:testPublish", form),
  loadHistory: () => ipcRenderer.invoke("history:load"),
  loadHistoryDraft: (jobId) => ipcRenderer.invoke("history:loadDraft", jobId),
  publishHistoryDraft: (options) => ipcRenderer.invoke("history:publishDraft", options),
  publishHistoryDrafts: (options) => ipcRenderer.invoke("history:publishDrafts", options),
  regenerateHistoryDraft: (options) => ipcRenderer.invoke("history:regenerateDraft", options),
  markHistorySuccess: (options) => ipcRenderer.invoke("history:markSuccess", options),
  updateHistoryCategory: (options) => ipcRenderer.invoke("history:updateCategory", options),
  deleteHistory: (options) => ipcRenderer.invoke("history:delete", options),
  analyzeHistoryPublishFailure: (jobId) => ipcRenderer.invoke("history:analyzePublishFailure", jobId),
  getRecoveryOverview: () => ipcRenderer.invoke("recovery:overview"),
  recordRecoveryAttempt: (options) => ipcRenderer.invoke("recovery:recordAttempt", options),
  startJob: (form) => ipcRenderer.invoke("job:start", form),
  resumeJob: (options) => ipcRenderer.invoke("job:resume", options),
  loadDailyWorkflow: (date) => ipcRenderer.invoke("daily:load", date),
  crawlMemberBoard: (options) => ipcRenderer.invoke("daily:crawlMemberBoard", options),
  crawlNaverStyle: (options) => ipcRenderer.invoke("daily:crawlNaverStyle", options),
  prepareDailyPlan: (options) => ipcRenderer.invoke("daily:preparePlan", options),
  generateDailyDrafts: (options) => ipcRenderer.invoke("daily:generateDrafts", options),
  runRandomDailyResearch: (options) => ipcRenderer.invoke("daily:runRandomResearch", options),
  approveDailyItem: (payload) => ipcRenderer.invoke("daily:approveItem", payload),
  updateDailyItemCategory: (payload) => ipcRenderer.invoke("daily:updateCategory", payload),
  publishApprovedDaily: (options) => ipcRenderer.invoke("daily:publishApproved", options),
  openMemberBoardWritePage: (payload) => ipcRenderer.invoke("daily:openMemberBoardWrite", payload),
  closeMemberBoardWritePage: () => ipcRenderer.invoke("daily:closeMemberBoardWrite"),
  waitMemberBoardLogin: (options) => ipcRenderer.invoke("daily:waitMemberBoardLogin", options),
  loadScheduler: () => ipcRenderer.invoke("scheduler:load"),
  checkTodayScheduler: () => ipcRenderer.invoke("scheduler:checkToday"),
  runMissedScheduler: () => ipcRenderer.invoke("scheduler:runMissedToday"),
  registerScheduler: () => ipcRenderer.invoke("scheduler:register"),
  unregisterScheduler: () => ipcRenderer.invoke("scheduler:unregister"),
  openRuntimeFolder: () => ipcRenderer.invoke("runtime:open"),
  openFile: (filePath) => ipcRenderer.invoke("file:open", filePath),
  showFileInFolder: (filePath) => ipcRenderer.invoke("file:showInFolder", filePath),
  onLog: (handler) => {
    ipcRenderer.on("job:log", (_event, payload) => handler(payload));
  },
  onStatus: (handler) => {
    ipcRenderer.on("job:status", (_event, payload) => handler(payload));
  },
  onTokens: (handler) => {
    ipcRenderer.on("job:tokens", (_event, payload) => handler(payload));
  },
  onPreview: (handler) => {
    ipcRenderer.on("job:preview", (_event, payload) => handler(payload));
  },
  onSelectedTitle: (handler) => {
    ipcRenderer.on("job:selectedTitle", (_event, payload) => handler(payload));
  },
  onComplete: (handler) => {
    ipcRenderer.on("job:complete", (_event, payload) => handler(payload));
  },
  onAccountsUpdate: (handler) => {
    ipcRenderer.on("accounts:update", (_event, payload) => handler(payload));
  },
  onSchedulerUpdate: (handler) => {
    ipcRenderer.on("scheduler:update", (_event, payload) => handler(payload));
  }
});
