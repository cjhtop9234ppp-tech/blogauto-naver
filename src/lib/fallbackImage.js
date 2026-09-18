const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function safeName(value) {
  return String(value || "blog")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function svgPngBuffer({ title = "", sequence = 0 } = {}) {
  try {
    const { nativeImage } = require("electron");
    if (!nativeImage || typeof nativeImage.createFromDataURL !== "function") return null;
    const escapedTitle = String(title || "정보 요약")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .slice(0, 48);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#15536f"/><stop offset="1" stop-color="#2d8e96"/></linearGradient></defs><rect width="1200" height="630" fill="url(#g)"/><circle cx="1020" cy="105" r="160" fill="#d8f0d5" fill-opacity=".15"/><circle cx="170" cy="570" r="210" fill="#e9c46a" fill-opacity=".12"/><rect x="90" y="105" width="11" height="350" rx="5" fill="#e9c46a"/><text x="135" y="185" fill="#e9c46a" font-family="Malgun Gothic, sans-serif" font-size="30" font-weight="700">BLOG SUMMARY</text><text x="135" y="290" fill="white" font-family="Malgun Gothic, sans-serif" font-size="52" font-weight="700">${escapedTitle}</text><text x="135" y="385" fill="#d8f0d5" font-family="Malgun Gothic, sans-serif" font-size="28">핵심 내용과 확인할 점</text><text x="135" y="500" fill="white" fill-opacity=".72" font-family="Malgun Gothic, sans-serif" font-size="22">IMAGE ${sequence || "TITLE"}</text></svg>`;
    const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    const png = image.toPNG();
    return png.length ? png : null;
  } catch {
    return null;
  }
}

function simplePngBuffer({ title = "", sequence = 0 } = {}) {
  const rendered = svgPngBuffer({ title, sequence });
  if (rendered) return rendered;
  const width = 640;
  const height = 360;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const diagonal = Math.floor((x / width) * 56 + (y / height) * 38);
      const band = ((x + y + sequence * 43) % 180) < 90 ? 1 : 0;
      raw[offset] = 21 + diagonal + band * 8;
      raw[offset + 1] = 73 + diagonal + band * 16;
      raw[offset + 2] = 111 + diagonal + band * 22;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function createFallbackImageAssets({
  runtimeRoot,
  topic,
  title,
  includeTitleImage = true,
  maxBodyImages = 0,
  bodyImageRequests = []
} = {}) {
  if (!runtimeRoot) throw new Error("대체 이미지를 저장할 런타임 경로가 없습니다.");
  const imageRoot = path.join(runtimeRoot, "image");
  fs.mkdirSync(imageRoot, { recursive: true });
  const base = safeName(topic || title);
  const bodyRequests = Array.isArray(bodyImageRequests) ? bodyImageRequests : [];
  const bodyCount = Math.max(
    bodyRequests.length,
    Number(maxBodyImages) > 0 ? 1 : 0
  );
  const bodyImages = [];
  let titleImagePath = "";

  if (includeTitleImage) {
    titleImagePath = path.join(imageRoot, `${base}_fallback_title.png`);
    fs.writeFileSync(titleImagePath, simplePngBuffer({ title, sequence: 0 }));
  }
  for (let index = 0; index < bodyCount; index += 1) {
    const sequence = Number(bodyRequests[index]?.sequence || index + 1);
    const target = path.join(imageRoot, `${base}_fallback_${sequence}.png`);
    fs.writeFileSync(target, simplePngBuffer({ title: bodyRequests[index]?.sectionHeading || title, sequence }));
    bodyImages.push({
      ...bodyRequests[index],
      sequence,
      path: target,
      prompt: String(bodyRequests[index]?.prompt || `대체 요약 이미지 ${sequence}`)
    });
  }

  if (!titleImagePath && !bodyImages.length) {
    throw new Error("대체 이미지가 필요하지만 이미지 생성 옵션이 모두 꺼져 있습니다.");
  }
  return { titleImagePath, bodyImages };
}

module.exports = { createFallbackImageAssets };
