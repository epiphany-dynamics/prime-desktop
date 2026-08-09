"use strict";

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const SOURCE_IMAGE_CAP = 20_000_000;

function resizeWithin(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function convertGifOrWebpWithSips({
  buffer,
  mimeType,
  dimensions,
  maxDimension,
  sipsPath = "/usr/bin/sips",
  runExecFile = execFileAsync,
}) {
  if (!Buffer.isBuffer(buffer) || !["image/gif", "image/webp"].includes(mimeType)) throw new Error("Unsupported conversion input");
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1) {
    throw new Error("Image dimensions are unavailable");
  }
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "prime-desktop-image-"));
  await fsp.chmod(temporary, 0o700);
  const extension = mimeType === "image/gif" ? ".gif" : ".webp";
  const inputPath = path.join(temporary, `source${extension}`);
  const outputPath = path.join(temporary, "normalized.png");
  try {
    await fsp.writeFile(inputPath, buffer, { mode: 0o600, flag: "wx" });
    const args = ["-s", "format", "png"];
    const target = resizeWithin(dimensions.width, dimensions.height, maxDimension);
    if (target.width < dimensions.width || target.height < dimensions.height) {
      args.push("--resampleHeightWidth", String(target.height), String(target.width));
    }
    args.push(inputPath, "--out", outputPath);
    await runExecFile(sipsPath, args, { timeout: 8_000, maxBuffer: 512 * 1024, windowsHide: true });
    await fsp.chmod(outputPath, 0o600);
    const stat = await fsp.stat(outputPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > SOURCE_IMAGE_CAP) throw new Error("Converted image is invalid");
    return await fsp.readFile(outputPath);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

function createElectronImageNormalizer({ nativeImage, AttachmentError, sniffImageMime }) {
  if (!nativeImage || !AttachmentError || typeof sniffImageMime !== "function") throw new TypeError("Electron image normalizer dependencies are required");
  return async function normalizeImageWithElectron({ buffer, mimeType, dimensions, maxDimension = 1568, maxBase64 = Math.floor(4.5 * 1024 * 1024) }) {
    let decodeBuffer = buffer;
    let decodeMime = mimeType;
    if (mimeType === "image/gif" || mimeType === "image/webp") {
      try {
        decodeBuffer = await convertGifOrWebpWithSips({ buffer, mimeType, dimensions, maxDimension });
        decodeMime = "image/png";
      } catch {
        throw new AttachmentError("IMAGE_DECODE", "That image could not be decoded safely");
      }
    }

    const image = nativeImage.createFromBuffer(decodeBuffer);
    if (image.isEmpty()) throw new AttachmentError("IMAGE_DECODE", "That image could not be decoded safely");
    const sourceSize = image.getSize();
    if (!sourceSize.width || !sourceSize.height || sourceSize.width * sourceSize.height > 36_000_000) {
      throw new AttachmentError("IMAGE_DIMENSIONS", "That image is too large to decode safely (36 megapixels maximum)");
    }
    const target = resizeWithin(sourceSize.width, sourceSize.height, maxDimension);
    let normalizedImage = target.width === sourceSize.width && target.height === sourceSize.height
      ? image
      : image.resize({ width: target.width, height: target.height, quality: "best" });
    let output = decodeBuffer;
    let outputMime = decodeMime;
    if (target.width !== sourceSize.width || target.height !== sourceSize.height || decodeBuffer.toString("base64").length >= maxBase64) {
      output = decodeMime === "image/png" ? normalizedImage.toPNG() : normalizedImage.toJPEG(90);
      outputMime = decodeMime === "image/png" ? "image/png" : "image/jpeg";
    }
    let quality = 88;
    for (let round = 0; output.toString("base64").length >= maxBase64 && round < 12; round += 1) {
      const size = normalizedImage.getSize();
      if (round >= 4) normalizedImage = normalizedImage.resize({ width: Math.max(1, Math.round(size.width * 0.86)), height: Math.max(1, Math.round(size.height * 0.86)), quality: "best" });
      output = normalizedImage.toJPEG(Math.max(45, quality));
      outputMime = "image/jpeg";
      quality -= 7;
    }
    if (!output.length || output.toString("base64").length >= maxBase64 || !sniffImageMime(output)) {
      throw new AttachmentError("IMAGE_NORMALIZE_LIMIT", "That image remains too large after resizing");
    }
    const size = normalizedImage.getSize();
    const previewSize = resizeWithin(size.width, size.height, 180);
    const preview = normalizedImage.resize({ ...previewSize, quality: "good" }).toPNG();
    return { buffer: output, mimeType: outputMime, width: size.width, height: size.height, previewBuffer: preview, previewMimeType: "image/png" };
  };
}

module.exports = {
  SOURCE_IMAGE_CAP,
  resizeWithin,
  convertGifOrWebpWithSips,
  createElectronImageNormalizer,
};
