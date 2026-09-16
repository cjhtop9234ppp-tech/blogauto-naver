const fs = require("node:fs");
const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isUsableImageFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
      && IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  } catch {
    return false;
  }
}

function resolveAttachmentPath(rawPath, runtimeRoot = "") {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(runtimeRoot || process.cwd(), value);
}

/**
 * Collect the generated title/body images that must be handed to the
 * member-board publisher. Missing paths are returned instead of silently
 * dropping them so a post cannot be reported as successful without images.
 */
function collectMemberBoardAttachments({ runtimeRoot = "", titleImagePath = "", bodyImages = [] } = {}) {
  const candidates = [];
  if (String(titleImagePath || "").trim()) {
    candidates.push({ label: "타이틀 이미지", path: titleImagePath });
  }
  for (const image of Array.isArray(bodyImages) ? bodyImages : []) {
    const sequence = Number(image?.sequence || 0);
    candidates.push({
      label: `본문 이미지 ${Number.isFinite(sequence) && sequence > 0 ? sequence : "?"}`,
      path: image?.path || ""
    });
  }

  const paths = [];
  const missing = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = resolveAttachmentPath(candidate.path, runtimeRoot);
    if (!resolved || !isUsableImageFile(resolved)) {
      missing.push({ label: candidate.label, path: String(candidate.path || "") });
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }

  return {
    paths,
    missing,
    requestedCount: candidates.length
  };
}

module.exports = {
  collectMemberBoardAttachments,
  isUsableImageFile,
  resolveAttachmentPath
};
