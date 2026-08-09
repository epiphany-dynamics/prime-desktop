"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const { isWithin } = require("./workspace-service");

function canonicalSessionsRoot(root) {
  const absolute = path.resolve(root);
  try { return fs.realpathSync(absolute); }
  catch {
    fs.mkdirSync(absolute, { recursive: true });
    return fs.realpathSync(absolute);
  }
}

async function canonicalSessionPath(sessionsRoot, candidate, options = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4096) {
    throw new Error("Invalid session selection");
  }
  const root = canonicalSessionsRoot(sessionsRoot);
  let resolved;
  try { resolved = await fsp.realpath(path.resolve(candidate)); }
  catch {
    if (!options.allowMissing) throw new Error("That session is no longer available");
    resolved = path.resolve(candidate);
  }
  if (!isWithin(root, resolved) || path.dirname(resolved) !== root || path.extname(resolved) !== ".jsonl") {
    throw new Error("Invalid session selection");
  }
  return resolved;
}

async function readFirstJsonLine(filePath, maxBytes = 256 * 1024) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error("That session is not a file");
  if (stat.size === 0) throw new Error("Session header is missing");
  const stream = fs.createReadStream(filePath, { encoding: "utf8", start: 0, end: Math.min(stat.size, maxBytes) - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > maxBytes) throw new Error("Session header is too large");
      try { return JSON.parse(line); }
      catch { throw new Error("Session header is invalid"); }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  throw new Error("Session header is missing");
}

async function validateSessionHeader(sessionsRoot, candidate) {
  const sessionPath = await canonicalSessionPath(sessionsRoot, candidate);
  const header = await readFirstJsonLine(sessionPath);
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw new Error("Session header is invalid");
  }
  const version = header.version == null ? 1 : header.version;
  if (!Number.isInteger(version) || version < 1 || version > 3) {
    throw new Error("This session version is not supported by Prime Desktop");
  }
  if (typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) {
    throw new Error("Session project folder is invalid");
  }
  let cwd;
  try {
    cwd = await fsp.realpath(header.cwd);
    if (!(await fsp.stat(cwd)).isDirectory()) throw new Error();
  } catch { throw new Error("The project folder for this session is no longer available"); }
  return { sessionPath, header: { ...header, cwd } };
}

async function safeDeleteSession(sessionsRoot, candidate) {
  const sessionPath = await canonicalSessionPath(sessionsRoot, candidate);
  await fsp.unlink(sessionPath);
  return true;
}

function assertIdleState(state, action = "changing sessions") {
  if (state && state.isStreaming) throw new Error(`Stop the current response before ${action}`);
  return state;
}

function countSessionMessages(filePath) {
  try {
    let count = 0;
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim() || line[0] !== "{") continue;
      try { const record = JSON.parse(line); if (record && record.type === "message") count += 1; } catch {}
    }
    return count;
  } catch { return -1; }
}

async function safeCleanupSession(sessionsRoot, candidate, countMessages) {
  let sessionPath;
  try { sessionPath = await canonicalSessionPath(sessionsRoot, candidate); }
  catch { return false; }
  const messages = await Promise.resolve(countMessages(sessionPath)).catch(() => -1);
  if (messages !== 0) return false;
  try { await fsp.unlink(sessionPath); return true; } catch { return false; }
}

async function cleanupTrackedEmptySessions(sessionsRoot, trackedPaths, countMessages = countSessionMessages) {
  const deleted = [];
  for (const candidate of new Set(trackedPaths || [])) {
    if (await safeCleanupSession(sessionsRoot, candidate, countMessages)) deleted.push(candidate);
  }
  return deleted;
}

module.exports = {
  canonicalSessionsRoot,
  canonicalSessionPath,
  readFirstJsonLine,
  validateSessionHeader,
  safeDeleteSession,
  safeCleanupSession,
  cleanupTrackedEmptySessions,
  countSessionMessages,
  assertIdleState,
};
