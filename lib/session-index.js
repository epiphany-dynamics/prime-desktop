"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");

/**
 * Fast session sidebar index.
 * Never loads whole multi‑MB JSONL files into memory for listing.
 * Caches by (mtimeMs, size). Invalidates per-file when the file changes.
 */

const HEADER_SCAN_BYTES = 512 * 1024;
const MAX_SESSION_FILES = 500;

function createSessionIndex({ sessionsRoot, canonicalSessionPath }) {
  /** @type {Map<string, { mtimeMs: number, size: number, entry: object|null }>} */
  const cache = new Map();
  let lastAll = [];
  let lastBuiltAt = 0;
  let building = null;

  async function scanFile(filePath) {
    let stat;
    try { stat = await fsp.stat(filePath); }
    catch { return null; }
    if (!stat.isFile()) return null;

    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entry;
    }

    let header = null;
    let name = null;
    let preview = null;
    let messageCount = 0;
    let lastTs = stat.mtimeMs;
    let sawSessionInfo = false;
    let sawPreview = false;

    // Pass 1: header + early metadata from the head of the file only.
    const headEnd = Math.min(stat.size, HEADER_SCAN_BYTES) - 1;
    if (headEnd >= 0) {
      const stream = fs.createReadStream(filePath, { encoding: "utf8", start: 0, end: headEnd });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line || line[0] !== "{") continue;
          if (!header && line.includes('"type":"session"')) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === "session") header = obj;
            } catch {}
            continue;
          }
          if (!sawSessionInfo && line.includes('"type":"session_info"') && line.includes('"name"')) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === "session_info" && obj.name) {
                name = obj.name;
                sawSessionInfo = true;
              }
            } catch {}
          }
          if (!sawPreview && line.includes('"type":"message"') && line.includes('"role":"user"')) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === "message" && obj.message && obj.message.role === "user") {
                const m = obj.message;
                const text = typeof m.content === "string"
                  ? m.content
                  : (Array.isArray(m.content) ? ((m.content.find((c) => c.type === "text") || {}).text || "") : "");
                if (text) {
                  preview = String(text).replace(/\s+/g, " ").slice(0, 140);
                  sawPreview = true;
                }
                if (obj.timestamp) lastTs = Date.parse(obj.timestamp) || lastTs;
              }
            } catch {}
          }
          // Cheap count in the head window.
          if (line.includes('"type":"message"')) messageCount += 1;
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }

    // Pass 2: if file is larger than the head window, count remaining messages with a
    // string scan (no JSON.parse) and sample the tail for a fresher updatedAt.
    if (stat.size > HEADER_SCAN_BYTES) {
      const restStart = HEADER_SCAN_BYTES;
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { encoding: "utf8", start: restStart });
        let carry = "";
        stream.on("data", (chunk) => {
          const text = carry + chunk;
          const parts = text.split("\n");
          carry = parts.pop() || "";
          for (const line of parts) {
            if (line.includes('"type":"message"')) messageCount += 1;
          }
        });
        stream.on("error", reject);
        stream.on("end", () => {
          if (carry.includes('"type":"message"')) messageCount += 1;
          resolve();
        });
      });

      // Tail timestamp sample (last ~64KB).
      try {
        const tailStart = Math.max(0, stat.size - 64 * 1024);
        const tail = await fsp.readFile(filePath, { encoding: "utf8", start: tailStart, end: stat.size - 1 });
        for (const line of tail.split("\n")) {
          if (!line.includes('"timestamp"') || !line.includes('"type":"message"')) continue;
          const match = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
          if (match) {
            const ts = Date.parse(match[1]);
            if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
          }
        }
      } catch {}
    }

    if (!header) {
      cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entry: null });
      return null;
    }

    const entry = {
      path: filePath,
      id: header.id,
      cwd: header.cwd,
      name,
      preview,
      messageCount,
      rlmDepth: header.rlmDepth || 0,
      parentSession: header.parentSession || null,
      createdAt: Date.parse(header.timestamp) || stat.birthtimeMs,
      updatedAt: lastTs,
    };
    cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
    return entry;
  }

  async function list() {
    if (building) return building;
    building = (async () => {
      let names;
      try {
        names = (await fsp.readdir(sessionsRoot)).filter((f) => f.endsWith(".jsonl")).slice(0, MAX_SESSION_FILES);
      } catch {
        lastAll = [];
        return lastAll;
      }

      // Drop cache entries for deleted files.
      const live = new Set(names.map((f) => path.join(sessionsRoot, f)));
      for (const key of cache.keys()) {
        if (!live.has(key) && !names.some((f) => key.endsWith(f))) {
          // also try resolved paths later
        }
      }

      const out = [];
      // Parallelize a bit without melting the disk.
      const concurrency = 8;
      let i = 0;
      async function worker() {
        while (i < names.length) {
          const idx = i++;
          const name = names[idx];
          try {
            const absolute = path.join(sessionsRoot, name);
            const canonical = canonicalSessionPath
              ? await canonicalSessionPath(sessionsRoot, absolute)
              : absolute;
            const entry = await scanFile(canonical);
            if (entry) out.push(entry);
          } catch {}
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      lastAll = out;
      lastBuiltAt = Date.now();

      // Prune cache for paths no longer present.
      const keep = new Set(out.map((e) => e.path));
      for (const key of [...cache.keys()]) {
        if (!keep.has(key)) cache.delete(key);
      }
      return out;
    })();
    try {
      return await building;
    } finally {
      building = null;
    }
  }

  function invalidate(fileNameOrPath) {
    if (!fileNameOrPath) {
      cache.clear();
      return;
    }
    const base = path.basename(fileNameOrPath);
    for (const key of [...cache.keys()]) {
      if (key === fileNameOrPath || path.basename(key) === base) cache.delete(key);
    }
  }

  function getCached() {
    return lastAll;
  }

  return { list, invalidate, getCached, scanFile };
}

module.exports = { createSessionIndex };
