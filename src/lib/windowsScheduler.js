const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TASK_PREFIX = "NaverBlogAutomator";
const TASKS = [
  { stage: "morning-prep", time: "09:00", label: "랜덤 주제 웹 검색·온새카 등록" },
  { stage: "draft-retry", time: "10:30", label: "랜덤 주제 실패·등록 재시도" },
  { stage: "publish-approved", time: "12:00", label: "승인 글 발행" }
];
const LEGACY_TASK_LABELS = ["회원마당 수집·초안", "초안 재시도", "승인 글 발행"];

function statusPath(runtimeRoot) {
  return path.join(runtimeRoot, "scheduler-status.json");
}

function readSchedulerStatus(runtimeRoot) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(runtimeRoot), "utf8"));
  } catch {
    return { registered: false, tasks: [], lastRuns: {} };
  }
}

function writeSchedulerStatus(runtimeRoot, status) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statusPath(runtimeRoot), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return status;
}

function powershellPath() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(scriptPath, args) {
  const result = spawnSync(powershellPath(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...args
  ], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || "Windows 작업 스케줄러 명령이 실패했습니다.").trim());
  }
  return String(result.stdout || "").trim();
}

function taskDefinitions({ executablePath, appPath, workingDirectory }) {
  const packaged = path.basename(executablePath).toLowerCase() !== "electron.exe";
  return TASKS.map((task) => ({
    ...task,
    taskName: `${TASK_PREFIX} - ${task.stage}`,
    execute: executablePath,
    arguments: packaged ? `--scheduled-stage=${task.stage}` : `"${appPath}" --scheduled-stage=${task.stage}`,
    workingDirectory
  }));
}

function registerWindowsScheduler({ runtimeRoot, executablePath, appPath, workingDirectory, scriptPath }) {
  const tasks = taskDefinitions({ executablePath, appPath, workingDirectory });
  for (const label of LEGACY_TASK_LABELS) {
    runPowerShell(scriptPath, ["-TaskName", `${TASK_PREFIX} - ${label}`, "-Remove"]);
  }
  for (const task of tasks) {
    runPowerShell(scriptPath, [
      "-TaskName", task.taskName,
      "-Execute", task.execute,
      "-Arguments", task.arguments,
      "-WorkingDirectory", task.workingDirectory,
      "-Time", task.time
    ]);
  }
  return writeSchedulerStatus(runtimeRoot, {
    registered: true,
    registeredAt: new Date().toISOString(),
    tasks: tasks.map(({ stage, time, label, taskName }) => ({ stage, time, label, taskName })),
    lastRuns: readSchedulerStatus(runtimeRoot).lastRuns || {}
  });
}

function unregisterWindowsScheduler({ runtimeRoot, scriptPath }) {
  const previous = readSchedulerStatus(runtimeRoot);
  for (const task of TASKS) {
    runPowerShell(scriptPath, ["-TaskName", `${TASK_PREFIX} - ${task.stage}`, "-Remove"]);
  }
  for (const label of LEGACY_TASK_LABELS) {
    runPowerShell(scriptPath, ["-TaskName", `${TASK_PREFIX} - ${label}`, "-Remove"]);
  }
  return writeSchedulerStatus(runtimeRoot, {
    registered: false,
    unregisteredAt: new Date().toISOString(),
    tasks: previous.tasks || [],
    lastRuns: previous.lastRuns || {}
  });
}

function recordScheduledRun(runtimeRoot, stage, patch = {}) {
  const status = readSchedulerStatus(runtimeRoot);
  status.lastRuns = status.lastRuns && typeof status.lastRuns === "object" ? status.lastRuns : {};
  status.lastRuns[stage] = {
    stage,
    at: new Date().toISOString(),
    ...patch
  };
  return writeSchedulerStatus(runtimeRoot, status);
}

module.exports = {
  TASKS,
  TASK_PREFIX,
  readSchedulerStatus,
  registerWindowsScheduler,
  unregisterWindowsScheduler,
  recordScheduledRun,
  schedulerStatusPath: statusPath
};
