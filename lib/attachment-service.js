"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { isWithin, isSensitivePath } = require("./workspace-service");

const SOURCE_IMAGE_CAP = 20_000_000;
const PIXEL_CAP = 36_000_000;
const MAX_DIMENSION = 1568;
const MAX_IMAGE_BASE64 = Math.floor(4.5 * 1024 * 1024);
const MAX_IMAGES = 6;
const MAX_IMAGE_AGGREGATE_BASE64 = 18 * 1024 * 1024;
const MAX_FILE_REFS = 20;
const TRANSPORT_START = "[Prime Desktop local files:v1]";
const TRANSPORT_END = "[/Prime Desktop local files]";
const TRANSPORT_LABEL = "Attached local files — use file tools to inspect:";

class AttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    let marker = buffer[offset + 1];
    while (marker === 0xff) marker = buffer[++offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length >= 7) return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      break;
    }
    offset += length;
  }
  return null;
}

function imageDimensions(buffer, mimeType = sniffImageMime(buffer)) {
  try {
    if (mimeType === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mimeType === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mimeType === "image/jpeg") return jpegDimensions(buffer);
    if (mimeType === "image/webp" && buffer.length >= 30) {
      const chunk = buffer.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X") {
        const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
        const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
        return { width, height };
      }
      if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch {}
  return null;
}

function mimeForFile(filename) {
  const extension = path.extname(filename || "").toLowerCase();
  return ({
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".jsonl": "application/x-jsonlines", ".csv": "text/csv", ".html": "text/html",
    ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
    ".cjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
    ".jsx": "text/javascript", ".py": "text/x-python", ".sh": "text/x-shellscript",
    ".yaml": "application/yaml", ".yml": "application/yaml", ".toml": "application/toml",
    ".pdf": "application/pdf", ".zip": "application/zip",
  })[extension] || "application/octet-stream";
}

function safeFilename(filename, fallback = "Attachment") {
  const cleaned = String(filename || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return cleaned || fallback;
}

function buildFileTransport(text, files) {
  const body = String(text || "").trim();
  if (!Array.isArray(files) || files.length === 0) return body;
  const records = files.map((file) => ({
    scope: file.external ? "external" : "workspace",
    path: file.transportPath,
    name: file.name,
    size: file.size,
    type: file.mimeType,
  }));
  // Keep the marker on dedicated lines. JSON escapes filename/path newlines, so
  // an unusual filename cannot forge a closing marker.
  const json = JSON.stringify(records).replace(/</g, "\\u003c");
  return [body, TRANSPORT_START, TRANSPORT_LABEL, json, TRANSPORT_END].filter((part, index) => part || index > 0).join("\n");
}

function parseFileTransport(input) {
  const text = String(input || "");
  const start = text.lastIndexOf(`\n${TRANSPORT_START}\n`);
  const atStart = text.startsWith(`${TRANSPORT_START}\n`) ? 0 : -1;
  const index = start >= 0 ? start + 1 : atStart;
  if (index < 0) return { text, files: [] };
  const closing = `\n${TRANSPORT_END}`;
  const end = text.indexOf(closing, index);
  if (end < 0) return { text, files: [] };
  const block = text.slice(index, end + closing.length);
  const lines = block.split("\n");
  if (lines.length !== 4 || lines[0] !== TRANSPORT_START || lines[1] !== TRANSPORT_LABEL || lines[3] !== TRANSPORT_END) {
    return { text, files: [] };
  }
  let records;
  try { records = JSON.parse(lines[2]); }
  catch { return { text, files: [] }; }
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_FILE_REFS) return { text, files: [] };
  const files = [];
  for (const record of records) {
    if (!record || Object.getPrototypeOf(record) !== Object.prototype) return { text, files: [] };
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "name,path,scope,size,type") return { text, files: [] };
    if (!["workspace", "external"].includes(record.scope)) return { text, files: [] };
    if (typeof record.name !== "string" || !record.name || record.name.length > 255 || /[\u0000-\u001f\u007f]/.test(record.name)) return { text, files: [] };
    if (typeof record.path !== "string" || !record.path || record.path.length > 4096 || /[\u0000\r\n]/.test(record.path)) return { text, files: [] };
    if (record.scope === "workspace") {
      const normalized = path.posix.normalize(record.path.replace(/\\/g, "/"));
      if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) return { text, files: [] };
    } else if (!record.path.startsWith("~/") && !path.isAbsolute(record.path)) return { text, files: [] };
    if (typeof record.type !== "string" || !record.type || record.type.length > 120 || /[\u0000\r\n]/.test(record.type)) return { text, files: [] };
    if (!Number.isSafeInteger(record.size) || record.size < 0) return { text, files: [] };
    files.push({
      kind: "file",
      name: record.name,
      mimeType: record.type,
      size: record.size,
      external: record.scope === "external",
    });
  }
  const visible = `${text.slice(0, index)}${text.slice(end + closing.length)}`.trim();
  return { text: visible, files };
}

class AttachmentService {
  constructor(options = {}) {
    this.normalizeImage = options.normalizeImage || (async ({ buffer, mimeType, dimensions }) => ({
      buffer,
      mimeType,
      width: dimensions && dimensions.width,
      height: dimensions && dimensions.height,
      previewBuffer: buffer.length <= 256_000 ? buffer : null,
      previewMimeType: mimeType,
    }));
    this.getWorkspace = options.getWorkspace || (() => ({ selected: false, generation: 0 }));
    this.homeDir = options.homeDir ? (() => { try { return fs.realpathSync(options.homeDir); } catch { return path.resolve(options.homeDir); } })() : null;
    this.drafts = new Map();
  }

  createDraft() {
    const workspace = this.getWorkspace() || { selected: false, generation: 0 };
    const draft = {
      id: `draft_${crypto.randomUUID()}`,
      workspaceId: workspace.selected ? workspace.workspaceId : null,
      workspaceGeneration: workspace.generation || 0,
      workspaceRoot: workspace.selected ? (() => { try { return fs.realpathSync(workspace.cwd); } catch { return path.resolve(workspace.cwd); } })() : null,
      items: new Map(),
      dedupe: new Map(),
      imageBase64Total: 0,
      revision: 0,
      pendingMutations: 0,
      mutationTail: Promise.resolve(),
      sealed: false,
      createdAt: Date.now(),
    };
    this.drafts.set(draft.id, draft);
    return this.describeDraft(draft.id);
  }

  deleteDraft(draftId) {
    const draft = this.drafts.get(draftId);
    if (draft) draft.sealed = true;
    return this.drafts.delete(draftId);
  }

  pendingMutationCount(draftId) {
    const draft = this.drafts.get(draftId);
    return draft ? draft.pendingMutations : 0;
  }

  _assertMutableDraft(draft) {
    if (!draft || this.drafts.get(draft.id) !== draft) throw new AttachmentError("STALE_DRAFT", "This attachment draft is no longer available");
    const current = this._getDraft(draft.id);
    if (current !== draft || draft.sealed) throw new AttachmentError("STALE_DRAFT", "This attachment draft is no longer available");
    return draft;
  }

  _mutate(draftId, operation) {
    const draft = this._getDraft(draftId);
    if (draft.sealed) return Promise.reject(new AttachmentError("STALE_DRAFT", "This attachment draft is no longer available"));
    draft.pendingMutations += 1;
    const run = draft.mutationTail.then(async () => {
      this._assertMutableDraft(draft);
      const result = await operation(draft);
      this._assertMutableDraft(draft);
      draft.revision += 1;
      return result;
    });
    draft.mutationTail = run.catch(() => {});
    return run.finally(() => { draft.pendingMutations = Math.max(0, draft.pendingMutations - 1); });
  }

  _getDraft(draftId) {
    if (typeof draftId !== "string" || draftId.length > 100) throw new AttachmentError("STALE_DRAFT", "This attachment draft is no longer available");
    const draft = this.drafts.get(draftId);
    if (!draft) throw new AttachmentError("STALE_DRAFT", "This attachment draft is no longer available");
    const workspace = this.getWorkspace() || { selected: false, generation: 0 };
    const currentWorkspaceId = workspace.selected ? workspace.workspaceId : null;
    if (draft.workspaceGeneration !== (workspace.generation || 0) || draft.workspaceId !== currentWorkspaceId) {
      throw new AttachmentError("STALE_DRAFT", "The project changed; add attachments again");
    }
    return draft;
  }

  _publicItem(item) {
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      external: !!item.external,
      previewDataUrl: item.previewDataUrl || null,
      status: "ready",
    };
  }

  describeDraft(draftId) {
    const draft = this.drafts.get(draftId);
    if (!draft) return null;
    return { id: draft.id, workspaceGeneration: draft.workspaceGeneration, revision: draft.revision, items: [...draft.items.values()].map((item) => this._publicItem(item)) };
  }

  async ingestClipboardImage({ draftId, bytes, name = "Pasted image" }) {
    let buffer;
    try { buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); }
    catch { throw new AttachmentError("INVALID_IMAGE", "The pasted image could not be read"); }
    return this._mutate(draftId, (draft) => this._ingestImageBuffer(draft, buffer, safeFilename(name, "Pasted image")));
  }

  async _ingestImageBuffer(draft, buffer, name, canonicalPath = null, external = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AttachmentError("INVALID_IMAGE", "That image is empty or unreadable");
    if (buffer.length > SOURCE_IMAGE_CAP) throw new AttachmentError("IMAGE_TOO_LARGE", "Images must be 20 MB or smaller");
    const mimeType = sniffImageMime(buffer);
    if (!mimeType) throw new AttachmentError("UNSUPPORTED_IMAGE", "Use a PNG, JPEG, GIF, or WebP image");
    const dimensions = imageDimensions(buffer, mimeType);
    if (dimensions && (dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > PIXEL_CAP)) {
      throw new AttachmentError("IMAGE_DIMENSIONS", "That image is too large to decode safely (36 megapixels maximum)");
    }
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const dedupeKey = `image:${hash}`;
    if (draft.dedupe.has(dedupeKey)) return { duplicate: true, item: this._publicItem(draft.items.get(draft.dedupe.get(dedupeKey))) };
    const imageCount = [...draft.items.values()].filter((item) => item.kind === "image").length;
    if (imageCount >= MAX_IMAGES) throw new AttachmentError("IMAGE_COUNT", `Attach up to ${MAX_IMAGES} images per message`);

    let normalized;
    try { normalized = await this.normalizeImage({ buffer, mimeType, dimensions, maxDimension: MAX_DIMENSION, maxBase64: MAX_IMAGE_BASE64 }); }
    catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("IMAGE_DECODE", "That image could not be decoded safely");
    }
    // Reject late results after a session/project rotation or accepted send.
    this._assertMutableDraft(draft);
    if (!normalized || !Buffer.isBuffer(normalized.buffer) || !sniffImageMime(normalized.buffer)) {
      throw new AttachmentError("IMAGE_DECODE", "That image could not be normalized safely");
    }
    const actualMime = sniffImageMime(normalized.buffer);
    const actualDimensions = imageDimensions(normalized.buffer, actualMime) || { width: normalized.width, height: normalized.height };
    if (actualDimensions && actualDimensions.width * actualDimensions.height > PIXEL_CAP) {
      throw new AttachmentError("IMAGE_DIMENSIONS", "That image is too large to decode safely (36 megapixels maximum)");
    }
    const base64 = normalized.buffer.toString("base64");
    if (base64.length >= MAX_IMAGE_BASE64) throw new AttachmentError("IMAGE_NORMALIZE_LIMIT", "That image remains too large after resizing");
    if (draft.imageBase64Total + base64.length > MAX_IMAGE_AGGREGATE_BASE64) {
      throw new AttachmentError("IMAGE_AGGREGATE", "The attached images are too large together; remove one and try again");
    }
    let previewDataUrl = null;
    if (normalized.previewBuffer && Buffer.isBuffer(normalized.previewBuffer) && normalized.previewBuffer.length <= 512_000) {
      const previewMime = sniffImageMime(normalized.previewBuffer) || normalized.previewMimeType || actualMime;
      previewDataUrl = `data:${previewMime};base64,${normalized.previewBuffer.toString("base64")}`;
    } else if (normalized.buffer.length <= 256_000) {
      previewDataUrl = `data:${actualMime};base64,${base64}`;
    }
    const extension = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" })[actualMime];
    if (!path.extname(name)) name += extension;
    const item = {
      id: `attachment_${crypto.randomUUID()}`,
      kind: "image",
      name: safeFilename(name, `Image${extension}`),
      mimeType: actualMime,
      size: normalized.buffer.length,
      originalSize: buffer.length,
      base64,
      hash,
      canonicalPath,
      external: !!external,
      previewDataUrl,
    };
    draft.items.set(item.id, item);
    draft.dedupe.set(dedupeKey, item.id);
    if (canonicalPath) draft.dedupe.set(`path:${canonicalPath}`, item.id);
    draft.imageBase64Total += base64.length;
    return { duplicate: false, item: this._publicItem(item) };
  }

  async ingestPaths({ draftId, paths, source = "drop" }) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILE_REFS) {
      throw new AttachmentError("INVALID_SELECTION", `Select between 1 and ${MAX_FILE_REFS} files`);
    }
    if (!["picker", "drop", "tree", "test"].includes(source)) throw new AttachmentError("INVALID_SELECTION", "That file selection is not available");
    return this._mutate(draftId, async (draft) => {
      const results = [];
      const errors = [];
      for (const selectedPath of paths) {
        try { results.push(await this._ingestPath(draft, selectedPath, source)); }
        catch (error) { errors.push({ code: error.code || "FILE_ERROR", error: error.message || "That file could not be attached" }); }
      }
      return { items: results.filter((item) => item && !item.duplicate).map((item) => item.item), duplicates: results.filter((item) => item && item.duplicate).length, errors };
    });
  }

  async _ingestPath(draft, selectedPath, source) {
    if (typeof selectedPath !== "string" || selectedPath.length === 0 || selectedPath.length > 4096) {
      throw new AttachmentError("INVALID_FILE", "That file selection is invalid");
    }
    let real;
    let stat;
    try {
      real = await fsp.realpath(path.resolve(selectedPath));
      stat = await fsp.stat(real);
      await fsp.access(real, fs.constants.R_OK);
    } catch { throw new AttachmentError("FILE_UNAVAILABLE", "A selected file is missing or cannot be read"); }
    if (!stat.isFile()) throw new AttachmentError("NOT_A_FILE", "Select files rather than folders");
    if (["picker", "drop", "tree"].includes(source) && isSensitivePath(real)) {
      throw new AttachmentError("SENSITIVE_PATH", "Private credentials and secret files cannot be attached");
    }
    const inWorkspace = !!(draft.workspaceRoot && isWithin(draft.workspaceRoot, real));
    if (["tree", "drop"].includes(source) && !inWorkspace) {
      throw new AttachmentError("OUTSIDE_PROJECT", source === "drop"
        ? "Drop files from the selected project; use the Attach button for an external file"
        : "That file is outside the selected project");
    }
    const pathKey = `path:${real}`;
    if (draft.dedupe.has(pathKey)) return { duplicate: true, item: this._publicItem(draft.items.get(draft.dedupe.get(pathKey))) };
    const head = await fsp.open(real, "r").then(async (handle) => {
      try {
        const buffer = Buffer.alloc(Math.min(64, stat.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    }).catch(() => Buffer.alloc(0));
    const imageMime = sniffImageMime(head);
    if (imageMime) {
      if (stat.size > SOURCE_IMAGE_CAP) throw new AttachmentError("IMAGE_TOO_LARGE", "Images must be 20 MB or smaller");
      const imageBuffer = await fsp.readFile(real).catch(() => null);
      if (!imageBuffer) throw new AttachmentError("FILE_UNAVAILABLE", "A selected file is missing or cannot be read");
      return this._ingestImageBuffer(draft, imageBuffer, path.basename(real), real, !inWorkspace);
    }
    this._assertMutableDraft(draft);
    const references = [...draft.items.values()].filter((item) => item.kind !== "image");
    if (references.length >= MAX_FILE_REFS) throw new AttachmentError("FILE_COUNT", `Attach up to ${MAX_FILE_REFS} file and context references per message`);
    const relative = inWorkspace ? path.relative(draft.workspaceRoot, real).split(path.sep).join("/") : null;
    let externalPath = real;
    if (!inWorkspace && this.homeDir && isWithin(this.homeDir, real)) {
      externalPath = `~/${path.relative(this.homeDir, real).split(path.sep).join("/")}`;
    }
    const item = {
      id: `attachment_${crypto.randomUUID()}`,
      kind: "file",
      name: safeFilename(path.basename(real), "File"),
      mimeType: mimeForFile(real),
      size: stat.size,
      canonicalPath: real,
      relativePath: relative,
      external: !inWorkspace,
      transportPath: inWorkspace ? relative : externalPath,
    };
    draft.items.set(item.id, item);
    draft.dedupe.set(pathKey, item.id);
    return { duplicate: false, item: this._publicItem(item) };
  }

  ingestReference({ draftId, kind, name, text, dedupeKey }) {
    if (!["session", "folder"].includes(kind) || typeof text !== "string" || !text || text.length > 100_000) {
      return Promise.reject(new AttachmentError("INVALID_REFERENCE", "That reference could not be attached"));
    }
    return this._mutate(draftId, async (draft) => {
      const key = `reference:${String(dedupeKey || "").slice(0, 4096)}`;
      if (draft.dedupe.has(key)) return { duplicate: true, item: this._publicItem(draft.items.get(draft.dedupe.get(key))) };
      const references = [...draft.items.values()].filter((item) => item.kind !== "image");
      if (references.length >= MAX_FILE_REFS) throw new AttachmentError("FILE_COUNT", `Attach up to ${MAX_FILE_REFS} file and context references per message`);
      const item = {
        id: `attachment_${crypto.randomUUID()}`,
        kind,
        name: safeFilename(name, kind === "session" ? "Session" : "Folder"),
        mimeType: kind === "session" ? "application/x-prime-session" : "inode/directory",
        size: Buffer.byteLength(text, "utf8"),
        external: false,
        referenceText: text,
      };
      draft.items.set(item.id, item);
      draft.dedupe.set(key, item.id);
      return { duplicate: false, item: this._publicItem(item) };
    });
  }

  remove({ draftId, attachmentId }) {
    return this._mutate(draftId, async (draft) => {
      const item = draft.items.get(attachmentId);
      if (!item) return null;
      draft.items.delete(attachmentId);
      for (const [key, value] of draft.dedupe.entries()) if (value === attachmentId) draft.dedupe.delete(key);
      if (item.kind === "image") draft.imageBase64Total = Math.max(0, draft.imageBase64Total - item.base64.length);
      return this._publicItem(item);
    });
  }

  serialize({ draftId, text = "", behavior = "prompt" }) {
    const draft = this._getDraft(draftId);
    if (typeof text !== "string" || text.length > 200_000) throw new AttachmentError("MESSAGE_SIZE", "The message is too large to send");
    if (!["prompt", "steer", "followUp"].includes(behavior)) throw new AttachmentError("INVALID_BEHAVIOR", "Unsupported send mode");
    const images = [...draft.items.values()].filter((item) => item.kind === "image");
    const files = [...draft.items.values()].filter((item) => item.kind === "file");
    const references = [...draft.items.values()].filter((item) => item.kind === "session" || item.kind === "folder");
    let message = buildFileTransport(text, files);
    if (references.length) message = [message, ...references.map((item) => item.referenceText)].filter(Boolean).join("\n\n");
    if (!message.trim() && images.length === 0) throw new AttachmentError("EMPTY_MESSAGE", "Write a message or add an attachment");
    const command = behavior === "prompt"
      ? { type: "prompt", message }
      : behavior === "steer"
        ? { type: "steer", message }
        : { type: "follow_up", message };
    if (images.length) command.images = images.map((item) => ({ type: "image", data: item.base64, mimeType: item.mimeType }));
    return { command, visibleText: String(text || "").trim(), attachments: [...draft.items.values()].map((item) => this._publicItem(item)) };
  }

  async sendDraft(payload, sender) {
    const draft = this._getDraft(payload && payload.draftId);
    if (draft.pendingMutations > 0) throw new AttachmentError("ATTACHMENTS_PENDING", "Wait for attachments to finish before sending");
    if (draft.sealed) throw new AttachmentError("STALE_DRAFT", "This attachment draft is no longer available");
    draft.sealed = true;
    let serialized;
    try {
      serialized = this.serialize(payload);
      const response = await sender(serialized.command);
      if (!response || !response.success) {
        draft.sealed = false;
        return { accepted: false, error: response && response.error || "The message was rejected", response, serialized };
      }
      return { accepted: true, response, serialized };
    } catch (error) {
      draft.sealed = false;
      if (error instanceof AttachmentError) throw error;
      return { accepted: false, error: error.message || "The message was rejected", serialized };
    }
  }
}

module.exports = {
  AttachmentService,
  AttachmentError,
  SOURCE_IMAGE_CAP,
  PIXEL_CAP,
  MAX_DIMENSION,
  MAX_IMAGE_BASE64,
  MAX_IMAGES,
  MAX_IMAGE_AGGREGATE_BASE64,
  MAX_FILE_REFS,
  TRANSPORT_START,
  TRANSPORT_END,
  TRANSPORT_LABEL,
  sniffImageMime,
  imageDimensions,
  buildFileTransport,
  parseFileTransport,
  mimeForFile,
};
