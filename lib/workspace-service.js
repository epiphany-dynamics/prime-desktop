"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const FIXED_IGNORES = new Set([
  ".git", ".hg", ".svn", ".worktrees", "node_modules",
  "build", "dist", "out", "coverage", ".coverage", ".cache", "cache",
  ".next", ".nuxt", ".turbo", ".parcel-cache", "target",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".venv", "venv", "env", ".tox", ".ds_store",
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".secrets",
]);
const PRIVATE_NAMES = new Set([
  ".env", ".npmrc", ".netrc", ".pypirc", "credentials", "credentials.json",
  "auth.json", "token.json", "google_token.json", "xai-oauth.json",
  "id_rsa", "id_ed25519", "service-account.json",
]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".jsonl", ".js", ".ts", ".py", ".sh",
  ".css", ".html", ".yaml", ".yml", ".toml", ".xml", ".svg", ".csv",
  ".log", ".gitignore", ".cjs", ".mjs", ".jsx", ".tsx", ".sql", ".rb",
  ".go", ".rs", ".java", ".c", ".h", ".cpp", ".plist",
]);

function makeToken(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalDirectory(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096) {
    throw new Error("A valid project folder is required");
  }
  const real = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(real).isDirectory()) throw new Error("The selected project is not a folder");
  return real;
}

function isSensitivePath(candidate) {
  if (typeof candidate !== "string" || !candidate) return true;
  const parts = path.resolve(candidate).split(path.sep).filter(Boolean).map((part) => part.toLowerCase());
  const name = parts.at(-1) || "";
  const privateDirectories = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".secrets", ".git"]);
  if (parts.some((part) => privateDirectories.has(part))) return true;
  if (PRIVATE_NAMES.has(name)) return true;
  if (/^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(name)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(name)) return true;
  return false;
}

function safeName(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
}

function parseWorktreePorcelain(text) {
  const records = [];
  let current = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = raw.indexOf(" ");
    const key = space === -1 ? raw : raw.slice(0, space);
    const value = space === -1 ? true : raw.slice(space + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value };
    } else if (current) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = String(value).replace(/^refs\/heads\//, "");
      else if (key === "detached") current.detached = true;
      else if (key === "bare") current.bare = true;
      else if (key === "locked") current.locked = value === true ? true : value;
      else if (key === "prunable") current.prunable = value === true ? true : value;
    }
  }
  if (current) records.push(current);
  return records;
}

function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const ch = glob[index];
    if (ch === "*") {
      if (glob[index + 1] === "*") {
        while (glob[index + 1] === "*") index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end !== -1) {
        source += glob.slice(index, end + 1);
        index = end;
      } else source += "\\[";
    } else {
      source += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function parseIgnoreFile(text, baseRelative = "") {
  const rules = [];
  for (let raw of String(text || "").split(/\r?\n/)) {
    if (!raw || raw === "\r") continue;
    if (raw.startsWith("\\#")) raw = raw.slice(1);
    else if (raw.startsWith("#")) continue;
    raw = raw.trim();
    if (!raw) continue;
    let negated = false;
    if (raw.startsWith("!")) { negated = true; raw = raw.slice(1); }
    if (!raw) continue;
    const directoryOnly = raw.endsWith("/");
    if (directoryOnly) raw = raw.slice(0, -1);
    const anchored = raw.startsWith("/");
    if (anchored) raw = raw.slice(1);
    const hasSlash = raw.includes("/");
    rules.push({
      negated,
      directoryOnly,
      anchored,
      hasSlash,
      baseRelative: baseRelative.split(path.sep).join("/"),
      pattern: raw,
      regex: globToRegExp(raw),
    });
  }
  return rules;
}

function ignoreRuleMatches(rule, relativePath, isDirectory) {
  if (rule.directoryOnly && !isDirectory) return false;
  const normalized = relativePath.split(path.sep).join("/");
  const base = rule.baseRelative;
  if (base && normalized !== base && !normalized.startsWith(`${base}/`)) return false;
  const local = base ? normalized.slice(base.length + (normalized === base ? 0 : 1)) : normalized;
  if (!local) return false;
  if (rule.anchored || rule.hasSlash) return rule.regex.test(local);
  return local.split("/").some((part) => rule.regex.test(part));
}

class WorkspaceService {
  constructor(options = {}) {
    this.homeDir = canonicalDirectory(options.homeDir || process.cwd());
    this.statePath = options.statePath || path.join(this.homeDir, ".prime-desktop-workspaces.json");
    this.execFile = options.execFile || execFileAsync;
    this.watchFactory = options.watchFactory === undefined ? fs.watch : options.watchFactory;
    this.onInvalidated = options.onInvalidated || (() => {});
    this.entryCap = Math.max(20, Math.min(options.entryCap || 200, 500));
    this.maxRootEntries = Math.max(100, Math.min(options.maxRootEntries || 10_000, 50_000));
    this.choiceTtlMs = options.choiceTtlMs || 10 * 60_000;
    this.cacheTtlMs = options.cacheTtlMs || 30_000;
    this.generation = 0;
    this.current = null;
    this.nodes = new Map();
    this.nodeByRelative = new Map();
    this.directoryCache = new Map();
    this.choices = new Map();
    this.watcher = null;
    this.watchTimer = null;
    this.recents = this._readState().recents || [];
  }

  _readState() {
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return value && typeof value === "object" ? value : { recents: [] };
    } catch { return { recents: [] }; }
  }

  _writeState() {
    const parent = path.dirname(this.statePath);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${this.statePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify({ recents: this.recents }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
  }

  _recordRecent(projectPath) {
    const onDisk = this._readState().recents;
    const merged = Array.isArray(onDisk) ? onDisk : this.recents;
    this.recents = [
      { path: projectPath, lastOpened: Date.now() },
      ...merged.filter((item) => item && item.path !== projectPath),
    ].slice(0, 10);
    try { this._writeState(); } catch {}
  }

  async _git(args, cwd) {
    const result = await this.execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return typeof result === "string" ? result.trim() : String(result.stdout || "").trim();
  }

  async _gitMetadata(cwd) {
    let root;
    try { root = canonicalDirectory(await this._git(["rev-parse", "--show-toplevel"], cwd)); }
    catch { return null; }
    let branch = null;
    let detached = false;
    let sha = null;
    try { branch = await this._git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd); }
    catch { detached = true; }
    try { sha = await this._git(["rev-parse", "--short=12", "HEAD"], cwd); } catch {}
    let worktrees = [];
    try {
      const parsed = parseWorktreePorcelain(await this._git(["worktree", "list", "--porcelain"], root));
      worktrees = parsed.map((item, index) => {
        let canonical = null;
        try { canonical = canonicalDirectory(item.path); } catch {}
        return {
          path: canonical || path.resolve(item.path),
          isMain: index === 0,
          branch: item.branch || null,
          detached: !!item.detached,
          head: item.head || null,
          locked: !!item.locked,
          prunable: !!item.prunable,
          bare: !!item.bare,
        };
      }).filter((item) => !item.bare);
    } catch {}
    const currentWorktree = worktrees
      .filter((item) => isWithin(item.path, cwd))
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
    return { root, branch: branch || null, detached, sha, currentWorktree, worktrees };
  }

  _publicGit(git) {
    if (!git) return null;
    const current = git.currentWorktree;
    return {
      root: git.root,
      branch: git.branch,
      detached: git.detached,
      sha: git.sha,
      worktree: current ? {
        path: current.path,
        name: path.basename(current.path),
        branch: current.branch,
        detached: current.detached,
        head: current.head,
        isMain: !!current.isMain,
      } : null,
    };
  }

  _issueNode(realPath, relativePath, type, stat = null, isSymlink = false) {
    const normalized = relativePath.split(path.sep).join("/");
    const existingId = this.nodeByRelative.get(normalized);
    if (existingId && this.nodes.has(existingId)) {
      const node = this.nodes.get(existingId);
      Object.assign(node, { realPath, type, stat, isSymlink });
      return node;
    }
    const node = {
      id: makeToken("node"),
      workspaceId: this.current.id,
      generation: this.generation,
      realPath,
      relativePath: normalized,
      type,
      stat,
      isSymlink,
    };
    this.nodes.set(node.id, node);
    this.nodeByRelative.set(normalized, node.id);
    return node;
  }

  _closeWatcher() {
    clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
  }

  _startWatcher() {
    this._closeWatcher();
    if (!this.current || !this.watchFactory) return;
    const snapshot = { id: this.current.id, generation: this.generation };
    const changed = () => {
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        if (!this.current || this.current.id !== snapshot.id || this.generation !== snapshot.generation) return;
        this.directoryCache.clear();
        this.onInvalidated({ workspaceId: snapshot.id, generation: snapshot.generation, reason: "filesystem" });
      }, 300);
    };
    try { this.watcher = this.watchFactory(this.current.root, { recursive: true }, changed); }
    catch {
      try { this.watcher = this.watchFactory(this.current.root, changed); }
      catch { throw new Error("The selected project cannot be watched safely"); }
    }
  }

  async _assertReasonableRoot(canonical, options = {}) {
    if (options.allowBroadRoot) return;
    const filesystemRoot = path.parse(canonical).root;
    const isHomeAncestor = canonical !== this.homeDir && isWithin(canonical, this.homeDir);
    const isVolumeRoot = path.dirname(canonical) === path.join(filesystemRoot, "Volumes");
    if (canonical === filesystemRoot || isHomeAncestor || isVolumeRoot) {
      throw new Error("Choose a project folder instead of a filesystem or user root");
    }
    let count = 0;
    let directory;
    try {
      directory = await fsp.opendir(canonical);
      for await (const _entry of directory) {
        count += 1;
        if (count > this.maxRootEntries) throw new Error("This folder is too broad to watch safely; choose a project subfolder");
      }
    } finally {
      if (directory) await directory.close().catch(() => {});
    }
  }

  async inspectPath(projectPath, options = {}) {
    const canonical = canonicalDirectory(projectPath);
    if (isSensitivePath(canonical)) throw new Error("Choose a project folder that is not a private credential directory");
    if (!options.allowHome && canonical === this.homeDir) {
      throw new Error("Choose a project folder instead of your whole home folder");
    }
    await this._assertReasonableRoot(canonical, options);
    const git = await this._gitMetadata(canonical);
    return { root: canonical, name: safeName(path.basename(canonical)) || "Project", git };
  }

  async activatePath(projectPath, options = {}) {
    const inspected = options.inspected || await this.inspectPath(projectPath, options);
    const rootStat = fs.statSync(inspected.root);
    if (!rootStat.isDirectory()) throw new Error("The selected project is not a folder");
    const previous = {
      generation: this.generation,
      current: this.current,
      nodes: this.nodes,
      nodeByRelative: this.nodeByRelative,
      directoryCache: this.directoryCache,
      choices: this.choices,
    };
    this._closeWatcher();
    try {
      this.generation += 1;
      this.nodes = new Map();
      this.nodeByRelative = new Map();
      this.directoryCache = new Map();
      this.choices = new Map();
      this.current = {
        id: makeToken("workspace"),
        generation: this.generation,
        root: inspected.root,
        name: inspected.name,
        git: inspected.git,
      };
      const rootNode = this._issueNode(inspected.root, "", "dir", rootStat, false);
      this.current.rootNodeId = rootNode.id;
      this._startWatcher();
      if (options.recordRecent !== false) this._recordRecent(inspected.root);
      return this.describe();
    } catch (error) {
      this.generation = previous.generation;
      this.current = previous.current;
      this.nodes = previous.nodes;
      this.nodeByRelative = previous.nodeByRelative;
      this.directoryCache = previous.directoryCache;
      this.choices = previous.choices;
      if (this.current) { try { this._startWatcher(); } catch {} }
      throw error;
    }
  }

  clear(reason = "no-project") {
    this._closeWatcher();
    this.generation += 1;
    this.current = null;
    this.nodes.clear();
    this.nodeByRelative.clear();
    this.directoryCache.clear();
    this.choices.clear();
    this.onInvalidated({ workspaceId: null, generation: this.generation, reason });
    return this.describe();
  }

  describe() {
    if (!this.current) return { selected: false, generation: this.generation };
    return {
      selected: true,
      workspaceId: this.current.id,
      generation: this.generation,
      name: this.current.name,
      cwd: this.current.root,
      rootNodeId: this.current.rootNodeId,
      git: this._publicGit(this.current.git),
    };
  }

  _issueChoice(projectPath, kind, metadata = {}) {
    const id = makeToken("choice");
    this.choices.set(id, {
      id,
      path: projectPath,
      kind,
      createdAt: Date.now(),
      generation: this.generation,
      metadata,
    });
    return {
      id,
      kind,
      name: safeName(metadata.name || path.basename(projectPath)),
      path: projectPath,
      branch: metadata.branch || null,
      current: !!metadata.current,
    };
  }

  async choicesForRenderer() {
    this.choices.clear();
    const stored = this._readState().recents;
    if (Array.isArray(stored)) this.recents = stored;
    const choices = [];
    if (this.current) {
      choices.push(this._issueChoice(this.current.root, "current", {
        name: this.current.name,
        branch: this.current.git && (this.current.git.branch || (this.current.git.sha && `detached@${this.current.git.sha}`)),
        current: true,
      }));
      for (const worktree of (this.current.git && this.current.git.worktrees) || []) {
        if (worktree.path === this.current.root) continue;
        let available = false;
        try { available = fs.statSync(worktree.path).isDirectory(); } catch {}
        if (!available) continue;
        choices.push(this._issueChoice(worktree.path, "worktree", {
          name: path.basename(worktree.path),
          branch: worktree.branch || (worktree.head && `detached@${worktree.head.slice(0, 12)}`),
        }));
      }
    }
    for (const recent of this.recents) {
      if (!recent || typeof recent.path !== "string" || (this.current && recent.path === this.current.root)) continue;
      let canonical;
      try { canonical = canonicalDirectory(recent.path); } catch { continue; }
      if (canonical === this.homeDir) continue;
      choices.push(this._issueChoice(canonical, "recent", { name: path.basename(canonical) }));
    }
    return choices.slice(0, 20);
  }

  async issuePickerChoice(projectPath) {
    const inspected = await this.inspectPath(projectPath);
    return this._issueChoice(inspected.root, "picker", { name: inspected.name });
  }

  async resolveChoice(choiceId) {
    if (typeof choiceId !== "string" || choiceId.length > 100) throw new Error("That project choice is no longer available");
    const choice = this.choices.get(choiceId);
    if (!choice || choice.generation !== this.generation || Date.now() - choice.createdAt > this.choiceTtlMs) {
      throw new Error("That project choice is no longer available; reopen the project menu");
    }
    return this.inspectPath(choice.path);
  }

  async _ignoreRulesFor(relativeDirectory) {
    if (!this.current) return [];
    const segments = relativeDirectory ? relativeDirectory.split("/").filter(Boolean) : [];
    const directories = [""];
    let accumulated = "";
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      directories.push(accumulated);
    }
    const rules = [];
    for (const rel of directories) {
      const ignorePath = path.join(this.current.root, ...rel.split("/").filter(Boolean), ".gitignore");
      try {
        const realIgnorePath = await fsp.realpath(ignorePath);
        if (!isWithin(this.current.root, realIgnorePath)) continue;
        const text = await fsp.readFile(realIgnorePath, "utf8");
        rules.push(...parseIgnoreFile(text.slice(0, 512 * 1024), rel));
      } catch {}
    }
    return rules;
  }

  _fixedIgnore(name) {
    const normalized = String(name || "").toLowerCase();
    if (FIXED_IGNORES.has(normalized)) return true;
    if (PRIVATE_NAMES.has(normalized)) return true;
    if (/^\.env(?:\.|$)/.test(normalized) && !/^\.env\.(?:example|sample|template)$/.test(normalized)) return true;
    if (/\.(?:pem|key|p12|pfx)$/i.test(normalized)) return true;
    return false;
  }

  async _resolveNode(nodeId, expectedType = null) {
    if (!this.current) throw new Error("Choose a project first");
    if (typeof nodeId !== "string" || nodeId.length > 100) throw new Error("This file entry is invalid");
    const node = this.nodes.get(nodeId);
    if (!node || node.workspaceId !== this.current.id || node.generation !== this.generation) {
      throw new Error("This file entry is stale; refresh the project files");
    }
    const snapshotId = this.current.id;
    const snapshotGeneration = this.generation;
    let real;
    try { real = await fsp.realpath(node.realPath); }
    catch { throw new Error("This file is no longer available"); }
    if (!this.current || this.current.id !== snapshotId || this.generation !== snapshotGeneration) {
      throw new Error("This file entry is stale; refresh the project files");
    }
    if (!isWithin(this.current.root, real)) throw new Error("This file is outside the selected project");
    const stat = await fsp.stat(real).catch(() => null);
    if (!stat) throw new Error("This file is no longer available");
    if (!this.current || this.current.id !== snapshotId || this.generation !== snapshotGeneration) {
      throw new Error("This file entry is stale; refresh the project files");
    }
    const actualType = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
    if (expectedType && actualType !== expectedType) throw new Error(expectedType === "dir" ? "This entry is not a folder" : "This entry is not a file");
    return { ...node, realPath: real, stat, type: actualType };
  }

  _encodeCursor(offset, cacheToken) {
    return Buffer.from(JSON.stringify({ offset, cacheToken }), "utf8").toString("base64url");
  }

  _decodePageCursor(cursor, cacheToken) {
    if (!cursor) return 0;
    try {
      const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
      if (value && value.cacheToken === cacheToken && Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100_000) return value.offset;
    } catch {}
    throw new Error("This file-list page is stale; refresh the folder");
  }

  async _scanDirectory(directory, snapshot) {
    let dirents;
    try { dirents = await fsp.readdir(directory.realPath, { withFileTypes: true }); }
    catch { throw new Error("This folder cannot be read"); }
    const rules = await this._ignoreRulesFor(directory.relativePath);
    const entries = [];
    for (const dirent of dirents) {
      if (this._fixedIgnore(dirent.name)) continue;
      const lexical = path.join(directory.realPath, dirent.name);
      let lstat;
      let real;
      let stat;
      try {
        lstat = await fsp.lstat(lexical);
        real = await fsp.realpath(lexical);
        if (!this.current || !isWithin(this.current.root, real)) continue;
        stat = await fsp.stat(real);
      } catch { continue; }
      const type = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
      if (type === "other") continue;
      const relative = path.relative(this.current.root, real).split(path.sep).join("/");
      let ignored = false;
      for (const rule of rules) if (ignoreRuleMatches(rule, relative, type === "dir")) ignored = !rule.negated;
      if (ignored) continue;
      entries.push({ name: safeName(dirent.name), real, relative, type, stat, isSymlink: lstat.isSymbolicLink() });
    }
    entries.sort((a, b) => a.type === b.type
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.type === "dir" ? -1 : 1);
    if (!this.current || this.current.id !== snapshot.workspaceId || this.generation !== snapshot.generation) {
      throw new Error("Project changed; refresh files");
    }
    return entries;
  }

  async listDirectory(request = {}) {
    const snapshot = this.describe();
    if (!snapshot.selected) return { ok: false, code: "NO_PROJECT", error: "Choose a project to browse files" };
    if (request.workspaceId !== snapshot.workspaceId || request.generation !== snapshot.generation) {
      return { ok: false, code: "STALE_WORKSPACE", error: "Project changed; refresh files" };
    }
    let directory;
    try { directory = await this._resolveNode(request.nodeId, "dir"); }
    catch (error) { return { ok: false, code: "UNREADABLE", error: error.message }; }

    const cacheKey = `${snapshot.generation}:${request.nodeId}`;
    let cached = this.directoryCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt > this.cacheTtlMs) {
      this.directoryCache.delete(cacheKey);
      cached = null;
    }
    if (!cached && request.cursor) {
      return { ok: false, code: "STALE_CURSOR", error: "This folder changed; refresh it before loading more" };
    }
    if (!cached) {
      try {
        cached = {
          entries: await this._scanDirectory(directory, snapshot),
          cacheToken: makeToken("page"),
          createdAt: Date.now(),
        };
        this.directoryCache.set(cacheKey, cached);
      } catch (error) {
        const stale = /Project changed/.test(error.message);
        return { ok: false, code: stale ? "STALE_WORKSPACE" : "UNREADABLE", error: error.message };
      }
    }
    let offset;
    try { offset = this._decodePageCursor(request.cursor, cached.cacheToken); }
    catch (error) { return { ok: false, code: "INVALID_CURSOR", error: error.message }; }
    const page = cached.entries.slice(offset, offset + this.entryCap);
    const publicEntries = page.map((entry) => {
      const node = this._issueNode(entry.real, entry.relative, entry.type, entry.stat, entry.isSymlink);
      return {
        nodeId: node.id,
        name: entry.name,
        relativePath: entry.relative,
        type: entry.type,
        size: entry.type === "file" ? entry.stat.size : null,
        mtime: entry.stat.mtimeMs,
        symlink: entry.isSymlink,
      };
    });
    const nextOffset = offset + page.length;
    return {
      ok: true,
      workspaceId: snapshot.workspaceId,
      generation: snapshot.generation,
      entries: publicEntries,
      total: cached.entries.length,
      truncated: nextOffset < cached.entries.length,
      nextCursor: nextOffset < cached.entries.length ? this._encodeCursor(nextOffset, cached.cacheToken) : null,
    };
  }

  async search(request = {}) {
    const snapshot = this.describe();
    if (!snapshot.selected) return { ok: false, code: "NO_PROJECT", error: "Choose a project first", entries: [] };
    if (request.workspaceId !== snapshot.workspaceId || request.generation !== snapshot.generation) {
      return { ok: false, code: "STALE_WORKSPACE", error: "Project changed; refresh suggestions", entries: [] };
    }
    const query = String(request.query || "").trim().toLowerCase().slice(0, 200);
    const limit = Math.max(1, Math.min(Number(request.limit) || 40, 100));
    const output = [];
    const queue = [{ realPath: this.current.root, relativePath: "" }];
    const deadline = Date.now() + 1_500;
    let visited = 0;
    while (queue.length && output.length < limit && visited < 2_500 && Date.now() < deadline) {
      const directory = queue.shift();
      let dirents;
      try { dirents = await fsp.readdir(directory.realPath, { withFileTypes: true }); } catch { continue; }
      const ignoreRules = await this._ignoreRulesFor(directory.relativePath);
      for (const dirent of dirents) {
        if (++visited > 2_500 || Date.now() >= deadline) break;
        if (this._fixedIgnore(dirent.name)) continue;
        const lexicalRelative = directory.relativePath ? `${directory.relativePath}/${dirent.name}` : dirent.name;
        let ignored = false;
        for (const rule of ignoreRules) if (ignoreRuleMatches(rule, lexicalRelative, dirent.isDirectory())) ignored = !rule.negated;
        if (ignored) continue;
        const lexical = path.join(directory.realPath, dirent.name);
        let real;
        let lstat;
        let stat;
        try {
          lstat = await fsp.lstat(lexical);
          real = await fsp.realpath(lexical);
          if (!this.current || !isWithin(this.current.root, real)) continue;
          stat = await fsp.stat(real);
        } catch { continue; }
        const type = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
        if (type === "other") continue;
        const relative = path.relative(this.current.root, real).split(path.sep).join("/");
        if (type === "dir" && !lstat.isSymbolicLink()) queue.push({ realPath: real, relativePath: relative });
        if (!query || relative.toLowerCase().includes(query)) {
          const node = this._issueNode(real, relative, type, stat, lstat.isSymbolicLink());
          output.push({ nodeId: node.id, name: safeName(dirent.name), relativePath: relative, type });
          if (output.length >= limit) break;
        }
      }
    }
    if (!this.current || this.current.id !== snapshot.workspaceId || this.generation !== snapshot.generation) {
      return { ok: false, code: "STALE_WORKSPACE", error: "Project changed; refresh suggestions", entries: [] };
    }
    return { ok: true, entries: output, truncated: queue.length > 0 || visited >= 2_500 || Date.now() >= deadline };
  }

  async attachmentPath(nodeId) {
    const node = await this._resolveNode(nodeId, "file");
    return { path: node.realPath, relativePath: node.relativePath, size: node.stat.size };
  }

  async readFile(nodeId, maxBytes = 200_000) {
    let node;
    try { node = await this._resolveNode(nodeId, "file"); }
    catch (error) { return { ok: false, error: error.message }; }
    const extension = path.extname(node.realPath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && extension !== "") return { ok: false, binary: true };
    const cap = Math.max(1, Math.min(Number(maxBytes) || 200_000, 1_000_000));
    try {
      const handle = await fsp.open(node.realPath, "r");
      const buffer = Buffer.alloc(cap);
      const { bytesRead } = await handle.read(buffer, 0, cap, 0);
      await handle.close();
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) return { ok: false, binary: true };
      return { ok: true, text: content.toString("utf8"), truncated: node.stat.size > bytesRead };
    } catch { return { ok: false, error: "This file cannot be read" }; }
  }

  async contextPaths(nodeId) {
    const node = await this._resolveNode(nodeId);
    return { absolute: node.realPath, relative: node.relativePath || ".", isDirectory: node.type === "dir" };
  }

  refresh(reason = "agent") {
    if (!this.current) return;
    this.directoryCache.clear();
    this.onInvalidated({ workspaceId: this.current.id, generation: this.generation, reason });
  }

  dispose() {
    this._closeWatcher();
  }
}

module.exports = {
  WorkspaceService,
  FIXED_IGNORES,
  PRIVATE_NAMES,
  canonicalDirectory,
  isWithin,
  isSensitivePath,
  parseWorktreePorcelain,
  parseIgnoreFile,
  ignoreRuleMatches,
};
