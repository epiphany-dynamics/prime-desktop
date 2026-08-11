"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { isWithin } = require("./workspace-service");

const MAX_ROSTER_BYTES = 1 * 1024 * 1024;
const MAX_CHILDREN = 100;


function readSessionHeaderId(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return null;
  try {
    const fd = fs.openSync(sessionPath, "r");
    try {
      const size = fs.fstatSync(fd).size || 0;
      if (size <= 0) return null;
      const buf = Buffer.alloc(Math.min(64 * 1024, size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const line = buf.slice(0, n).toString("utf8").split("\n").find((row) => row && row[0] === "{");
      if (!line) return null;
      const header = JSON.parse(line);
      return header && header.type === "session" && typeof header.id === "string" ? header.id : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function resolveArtifactsRoot(primeDir) {
  return path.resolve(primeDir, "session-artifacts");
}

function safeRealpathSync(candidate) {
  try { return fs.realpathSync(candidate); }
  catch { return path.resolve(candidate); }
}

/**
 * Latest rlm_subagent row per childId from a parent artifact roster file.
 * File is an append-only JSONL log; last row wins.
 */
function parseRosterFile(filePath) {
  let text;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return [];
    const start = stat.size > MAX_ROSTER_BYTES ? stat.size - MAX_ROSTER_BYTES : 0;
    text = fs.readFileSync(filePath, { encoding: "utf8", start, end: stat.size - 1 });
  } catch {
    return [];
  }
  const latest = new Map();
  for (const line of text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.type !== "rlm_subagent" || typeof row.childId !== "string") continue;
    latest.set(row.childId, row);
  }
  return [...latest.values()];
}

function normalizeAgentRow(row, parentSessionPath) {
  if (!row || typeof row !== "object") return null;
  const sessionFile = typeof row.sessionFile === "string" ? safeRealpathSync(row.sessionFile) : null;
  const status = String(row.status || row.state || "unknown").toLowerCase();
  const running = status === "running" || status === "queued" || status === "streaming" || status === "starting";
  const name = row.sessionName || row.label || row.name || row.childId || row.id || "sub-agent";
  return {
    id: row.childId || row.id || name,
    childId: row.childId || row.id || null,
    name,
    label: row.label || name,
    status,
    running,
    model: row.model || null,
    recap: row.recap || row.answerPreview || null,
    prompt: typeof row.prompt === "string" ? row.prompt.slice(0, 500) : null,
    sessionFile,
    path: sessionFile,
    sessionDir: typeof row.sessionDir === "string" ? row.sessionDir : null,
    parentSessionFile: typeof row.parentSessionFile === "string" ? safeRealpathSync(row.parentSessionFile) : parentSessionPath || null,
    parentSessionId: row.parentSessionId || null,
    rlmDepth: Number.isFinite(row.rlmDepth) ? row.rlmDepth : 1,
    tokenCount: row.tokenCount ?? null,
    toolUseCount: row.toolUseCount ?? null,
    updatedAt: row.updatedAt || row.createdAt || null,
    source: "artifact-roster",
  };
}

function normalizeLiveChild(child) {
  if (!child || typeof child !== "object") return null;
  const sessionDir = typeof child.sessionDir === "string" ? child.sessionDir : null;
  let sessionFile = typeof child.sessionFile === "string" ? child.sessionFile : null;
  if (!sessionFile && sessionDir) {
    try {
      const jsonl = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
      if (jsonl.length === 1) sessionFile = path.join(sessionDir, jsonl[0]);
    } catch {}
  }
  const status = String(child.status || "unknown").toLowerCase();
  const running = status === "running" || status === "queued" || status === "streaming" || status === "starting";
  const name = child.sessionName || child.label || child.id || "sub-agent";
  return {
    id: child.id || name,
    childId: child.id || null,
    name,
    label: child.label || name,
    status,
    running,
    model: child.model || null,
    recap: child.recap || child.answerPreview || null,
    prompt: null,
    sessionFile: sessionFile ? safeRealpathSync(sessionFile) : null,
    path: sessionFile ? safeRealpathSync(sessionFile) : null,
    sessionDir,
    parentSessionFile: null,
    parentSessionId: child.parentId || null,
    activeSessionId: child.activeSessionId || null,
    rlmDepth: null,
    tokenCount: child.tokenCount ?? null,
    toolUseCount: child.toolUseCount ?? null,
    activity: child.activity || null,
    error: child.error || null,
    updatedAt: null,
    source: "live-snapshot",
  };
}

/**
 * List child agents for a parent top-level session.
 * Uses session-artifacts/<parentSessionId>/rlm-subagents.jsonl and parentSessionFile matches.
 */
function listSubagentsForParent(primeDir, { parentSessionPath = null, parentSessionId = null } = {}) {
  const artifactsRoot = resolveArtifactsRoot(primeDir);
  const parentReal = parentSessionPath ? safeRealpathSync(parentSessionPath) : null;
  // IMPORTANT: session filename stem is often NOT the session id.
  // Artifacts are stored under header.id (e.g. 019fef05-1a51-...), while the
  // sessions file may be named 019fef05-1914-.... Always prefer the header id.
  const headerId = parentReal ? readSessionHeaderId(parentReal) : null;
  const fileStem = parentReal ? path.basename(parentReal, ".jsonl") : null;
  const parentIds = [...new Set([parentSessionId, headerId, fileStem].filter(Boolean))];
  const rows = [];
  const seenDirs = new Set();

  const considerRoster = (rosterPath) => {
    const real = safeRealpathSync(rosterPath);
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    if (!fs.existsSync(real)) return;
    for (const row of parseRosterFile(real)) {
      if (parentReal && row.parentSessionFile) {
        try {
          if (safeRealpathSync(row.parentSessionFile) !== parentReal) {
            // Still accept if parentSessionId matches any known id.
            if (!parentIds.length || !parentIds.includes(row.parentSessionId)) continue;
          }
        } catch {
          if (!parentIds.length || !parentIds.includes(row.parentSessionId)) continue;
        }
      } else if (parentIds.length && row.parentSessionId && !parentIds.includes(row.parentSessionId)) {
        continue;
      }
      const normalized = normalizeAgentRow(row, parentReal);
      if (normalized) rows.push(normalized);
    }
  };

  // Fast paths: try every known parent id as an artifact directory name.
  for (const id of parentIds) {
    considerRoster(path.join(artifactsRoot, id, "rlm-subagents.jsonl"));
  }

  // If still empty, scan a small recent window of artifact dirs (mtime order).
  if (!rows.length && parentReal) {
    try {
      const entries = fs.readdirSync(artifactsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const full = path.join(artifactsRoot, entry.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch {}
          return { name: entry.name, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 60);
      for (const entry of entries) {
        if (parentIds.includes(entry.name)) continue;
        considerRoster(path.join(artifactsRoot, entry.name, "rlm-subagents.jsonl"));
        if (rows.length) break;
      }
    } catch {}
  }

  // Prefer non-deleted when duplicates exist; keep latest status per id.
  const byId = new Map();
  for (const row of rows) {
    const key = row.childId || row.sessionFile || row.id;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, row);
      continue;
    }
    const prevT = Date.parse(prev.updatedAt || 0) || 0;
    const nextT = Date.parse(row.updatedAt || 0) || 0;
    if (nextT >= prevT) byId.set(key, row);
  }

  return [...byId.values()]
    .sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0);
    })
    .slice(0, MAX_CHILDREN);
}

function mergeAgentLists(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const agent of list || []) {
      if (!agent) continue;
      const key = String(agent.childId || agent.id || agent.sessionFile || agent.path || agent.name).slice(0, 300);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, agent);
        continue;
      }
      // Live snapshot wins status/recap; roster wins durable sessionFile if missing.
      byKey.set(key, {
        ...prev,
        ...agent,
        sessionFile: agent.sessionFile || prev.sessionFile,
        path: agent.path || agent.sessionFile || prev.path || prev.sessionFile,
        name: agent.name || prev.name,
        recap: agent.recap || prev.recap,
        prompt: agent.prompt || prev.prompt,
        running: !!(agent.running || prev.running),
        status: agent.running ? agent.status : (prev.running ? prev.status : (agent.status || prev.status)),
        source: agent.source === "live-snapshot" || prev.source === "live-snapshot" ? "merged" : agent.source || prev.source,
      });
    }
  }
  return [...byKey.values()].slice(0, MAX_CHILDREN);
}

/**
 * Allow top-level ~/.prime/agent/sessions/*.jsonl and nested
 * ~/.prime/agent/session-artifacts/**&#47;*.jsonl child sessions only.
 */
async function canonicalPrimeSessionPath(primeDir, candidate, options = {}) {
  if (typeof candidate !== "string" || !candidate || candidate.length > 4096) {
    throw new Error("Invalid session selection");
  }
  const primeRoot = path.resolve(primeDir);
  let primeReal;
  try { primeReal = fs.realpathSync(primeRoot); }
  catch {
    fs.mkdirSync(primeRoot, { recursive: true });
    primeReal = fs.realpathSync(primeRoot);
  }
  const sessionsRoot = path.join(primeReal, "sessions");
  const artifactsRoot = path.join(primeReal, "session-artifacts");
  for (const dir of [sessionsRoot, artifactsRoot]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  let resolved;
  try { resolved = await fsp.realpath(path.resolve(candidate)); }
  catch {
    if (!options.allowMissing) throw new Error("That session is no longer available");
    resolved = path.resolve(candidate);
  }
  if (path.extname(resolved) !== ".jsonl") throw new Error("Invalid session selection");

  const sessionsReal = safeRealpathSync(sessionsRoot);
  const artifactsReal = safeRealpathSync(artifactsRoot);

  if (isWithin(sessionsReal, resolved) && path.dirname(resolved) === sessionsReal) {
    return resolved;
  }
  if (isWithin(artifactsReal, resolved)) {
    // Child sessions live in session-artifacts/<parentId>/sub-*/file.jsonl
    const rel = path.relative(artifactsReal, resolved);
    const parts = rel.split(path.sep);
    if (parts.length >= 3 && parts[1].startsWith("sub-") && !parts.some((part) => part === ".." )) {
      return resolved;
    }
  }
  throw new Error("Invalid session selection");
}

module.exports = {
  readSessionHeaderId,
  resolveArtifactsRoot,
  parseRosterFile,
  normalizeAgentRow,
  normalizeLiveChild,
  listSubagentsForParent,
  mergeAgentLists,
  canonicalPrimeSessionPath,
};
