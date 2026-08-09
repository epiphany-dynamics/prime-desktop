"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const {
  WorkspaceService,
  activateWorkspaceForClient,
  SESSION_WORKSPACE_WARNING,
  isWithin,
  parseWorktreePorcelain,
  parseIgnoreFile,
  ignoreRuleMatches,
} = require("../lib/workspace-service");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createRepo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-workspace-test-"));
  const home = path.join(base, "home");
  const repo = path.join(base, "repo");
  fs.mkdirSync(home); fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Prime Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, home, repo };
}

async function listRoot(service, workspace) {
  return service.listDirectory({
    workspaceId: workspace.workspaceId,
    generation: workspace.generation,
    nodeId: workspace.rootNodeId,
  });
}

test("containment rejects prefix collisions", () => {
  assert.equal(isWithin("/tmp/project", "/tmp/project/file"), true);
  assert.equal(isWithin("/tmp/project", "/tmp/project-secret/file"), false);
});

test("porcelain parser preserves worktree branch and detached identity", () => {
  const parsed = parseWorktreePorcelain("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n");
  assert.deepEqual(parsed, [
    { path: "/a", head: "abc", branch: "main" },
    { path: "/b", head: "def", detached: true },
  ]);
});

test("basic gitignore rules support anchored, glob, and negation", () => {
  const rules = parseIgnoreFile("*.log\n/build/\n!important.log\n");
  const ignored = (file, dir = false) => {
    let value = false;
    for (const rule of rules) if (ignoreRuleMatches(rule, file, dir)) value = !rule.negated;
    return value;
  };
  assert.equal(ignored("tmp/a.log"), true);
  assert.equal(ignored("important.log"), false);
  assert.equal(ignored("build", true), true);
  assert.equal(ignored("src/build", true), false);
});

test("lazy tree filters heavy/private/ignored entries and blocks escaping symlinks", async (t) => {
  const { base, home, repo } = createRepo(t);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "index.js"), "ok\n");
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.mkdirSync(path.join(repo, "dist"));
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=fixture\n");
  fs.writeFileSync(path.join(repo, "ignored.log"), "ignored\n");
  fs.writeFileSync(path.join(repo, "keep.txt"), "keep\n");
  fs.appendFileSync(path.join(repo, ".gitignore"), "\n*.log\n");
  const outside = path.join(base, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "nope\n");
  fs.symlinkSync(outside, path.join(repo, "escape"));

  const service = new WorkspaceService({ homeDir: home, statePath: path.join(base, "state.json"), watchFactory: null, entryCap: 100 });
  t.after(() => service.dispose());
  const workspace = await service.activatePath(repo);
  const result = await listRoot(service, workspace);
  assert.equal(result.ok, true);
  const names = result.entries.map((entry) => entry.name);
  assert.ok(names.includes("src"));
  assert.ok(names.includes("keep.txt"));
  assert.ok(names.includes(".gitignore"));
  for (const hidden of ["node_modules", "dist", ".env", "ignored.log", "escape", ".git"]) assert.ok(!names.includes(hidden), hidden);

  const src = result.entries.find((entry) => entry.name === "src");
  const nested = await service.listDirectory({ workspaceId: workspace.workspaceId, generation: workspace.generation, nodeId: src.nodeId });
  assert.deepEqual(nested.entries.map((entry) => entry.relativePath), ["src/index.js"]);
});


test("unreadable and removed directories return intentional states", async (t) => {
  const { base, home, repo } = createRepo(t);
  const locked = path.join(repo, "locked"); fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, "inside.txt"), "x");
  const service = new WorkspaceService({ homeDir: home, statePath: path.join(base, "state.json"), watchFactory: null });
  t.after(() => { try { fs.chmodSync(locked, 0o700); } catch {} service.dispose(); });
  const workspace = await service.activatePath(repo);
  const root = await listRoot(service, workspace);
  const node = root.entries.find((entry) => entry.name === "locked");
  fs.chmodSync(locked, 0o000);
  const unreadable = await service.listDirectory({ workspaceId: workspace.workspaceId, generation: workspace.generation, nodeId: node.nodeId });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.code, "UNREADABLE");
  fs.chmodSync(locked, 0o700);
  fs.rmSync(locked, { recursive: true });
  const missing = await service.listDirectory({ workspaceId: workspace.workspaceId, generation: workspace.generation, nodeId: node.nodeId });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "UNREADABLE");
});

test("entry caps expose explicit truncation and an opaque next cursor", async (t) => {
  const { base, home, repo } = createRepo(t);
  for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(repo, `file-${String(index).padStart(2, "0")}.txt`), "x");
  const service = new WorkspaceService({ homeDir: home, statePath: path.join(base, "state.json"), watchFactory: null, entryCap: 20 });
  t.after(() => service.dispose());
  const workspace = await service.activatePath(repo);
  const first = await listRoot(service, workspace);
  assert.equal(first.truncated, true);
  assert.equal(first.entries.length, 20);
  assert.ok(first.nextCursor && !/^\d+$/.test(first.nextCursor));
  const second = await service.listDirectory({ workspaceId: workspace.workspaceId, generation: workspace.generation, nodeId: workspace.rootNodeId, cursor: first.nextCursor });
  assert.equal(second.ok, true);
  assert.ok(second.entries.length >= 10);
});

test("git metadata and choices identify linked worktrees without shell interpolation", async (t) => {
  const { base, home, repo } = createRepo(t);
  const worktree = path.join(base, "feature worktree");
  git(repo, "worktree", "add", "-q", "-b", "feature/test", worktree);
  const service = new WorkspaceService({ homeDir: home, statePath: path.join(base, "state.json"), watchFactory: null });
  t.after(() => service.dispose());
  const workspace = await service.activatePath(worktree);
  assert.equal(workspace.git.branch, "feature/test");
  assert.equal(workspace.git.worktree.path, fs.realpathSync(worktree));
  assert.equal(workspace.git.worktree.isMain, false);
  const choices = await service.choicesForRenderer();
  assert.ok(choices.some((choice) => choice.kind === "worktree" && choice.path === fs.realpathSync(repo)));
});

test("recents persist while stale generations and stale choice tokens fail", async (t) => {
  const { base, home, repo } = createRepo(t);
  const other = path.join(base, "other"); fs.mkdirSync(other);
  const statePath = path.join(base, "state.json");
  const service = new WorkspaceService({ homeDir: home, statePath, watchFactory: null });
  const first = await service.activatePath(repo);
  const oldRequest = { workspaceId: first.workspaceId, generation: first.generation, nodeId: first.rootNodeId };
  const choices = await service.choicesForRenderer();
  const currentChoice = choices.find((choice) => choice.current);
  await service.activatePath(other);
  const stale = await service.listDirectory(oldRequest);
  assert.equal(stale.code, "STALE_WORKSPACE");
  await assert.rejects(service.resolveChoice(currentChoice.id), /no longer available/);
  service.dispose();

  const reloaded = new WorkspaceService({ homeDir: home, statePath, watchFactory: null });
  t.after(() => reloaded.dispose());
  const recentChoices = await reloaded.choicesForRenderer();
  assert.ok(recentChoices.some((choice) => choice.kind === "recent" && choice.path === fs.realpathSync(repo)));
  assert.ok(recentChoices.some((choice) => choice.kind === "recent" && choice.path === fs.realpathSync(other)));
});

test("home is an intentional no-project boundary", async (t) => {
  const { base, home } = createRepo(t);
  const service = new WorkspaceService({ homeDir: home, statePath: path.join(base, "state.json"), watchFactory: null });
  t.after(() => service.dispose());
  await assert.rejects(service.activatePath(home), /whole home folder/);
  assert.deepEqual(service.describe(), { selected: false, generation: 0 });
});


test("filesystem roots, direct system roots, home ancestors, and broad directories are rejected", async (t) => {
  const { base, home, repo } = createRepo(t);
  const service = new WorkspaceService({ homeDir: home, statePath: path.join(base, "state.json"), watchFactory: null, maxRootEntries: 100 });
  t.after(() => service.dispose());
  await assert.rejects(service.inspectPath(path.parse(home).root), /filesystem or user root/);
  await assert.rejects(service.inspectPath(path.dirname(home)), /filesystem or user root/);
  for (const systemRoot of ["/usr", "/Applications", "/private/var"]) {
    if (fs.existsSync(systemRoot)) await assert.rejects(service.inspectPath(systemRoot), /filesystem or user root/);
  }
  assert.equal((await service.inspectPath(repo)).root, fs.realpathSync(repo), "normal project subdirectories remain selectable");
  const privateRoot = path.join(home, ".ssh"); fs.mkdirSync(privateRoot);
  await assert.rejects(service.inspectPath(privateRoot), /private credential directory/);
  const broad = path.join(base, "broad"); fs.mkdirSync(broad);
  for (let index = 0; index < 101; index += 1) fs.writeFileSync(path.join(broad, `entry-${index}`), "x");
  await assert.rejects(service.inspectPath(broad), /too broad to watch safely/);
});

test("pagination reuses one cached stat pass for a workspace generation and node", async (t) => {
  const { base, home, repo } = createRepo(t);
  for (let index = 0; index < 45; index += 1) fs.writeFileSync(path.join(repo, `page-${String(index).padStart(2, "0")}.txt`), "x");
  const service = new WorkspaceService({ homeDir: home, statePath: path.join(base, "state.json"), watchFactory: null, entryCap: 20, cacheTtlMs: 10_000 });
  t.after(() => service.dispose());
  const workspace = await service.activatePath(repo);
  const originalLstat = fs.promises.lstat;
  let lstatCalls = 0;
  fs.promises.lstat = async (...args) => { lstatCalls += 1; return originalLstat(...args); };
  t.after(() => { fs.promises.lstat = originalLstat; });
  const first = await listRoot(service, workspace);
  const afterFirst = lstatCalls;
  assert.ok(afterFirst > 20);
  const second = await service.listDirectory({ workspaceId: workspace.workspaceId, generation: workspace.generation, nodeId: workspace.rootNodeId, cursor: first.nextCursor });
  assert.equal(second.ok, true);
  assert.equal(lstatCalls, afterFirst, "second page must not re-stat the full directory");
});

test("workspace activation restores the prior state when watcher setup fails", async (t) => {
  const { base, home, repo } = createRepo(t);
  const other = path.join(base, "other-project"); fs.mkdirSync(other);
  const watchers = [];
  const service = new WorkspaceService({
    homeDir: home,
    statePath: path.join(base, "state.json"),
    watchFactory: () => { const watcher = { close() {} }; watchers.push(watcher); return watcher; },
  });
  t.after(() => service.dispose());
  const before = await service.activatePath(repo);
  service.watchFactory = () => { throw new Error("synthetic watcher failure"); };
  await assert.rejects(service.activatePath(other), /cannot be watched safely/);
  const after = service.describe();
  assert.equal(after.workspaceId, before.workspaceId);
  assert.equal(after.cwd, before.cwd);
  assert.equal(after.generation, before.generation);
});


test("saved-session workspace setup degrades rejected and unwatchable cwd to no-project", async (t) => {
  const { base, home, repo } = createRepo(t);
  const rejected = new WorkspaceService({ homeDir: home, statePath: path.join(base, "rejected-state.json"), watchFactory: null });
  t.after(() => rejected.dispose());
  const rejectedResult = await activateWorkspaceForClient(rejected, path.dirname(home), { degradeOnFailure: true });
  assert.deepEqual(rejectedResult.workspace, { selected: false, generation: 1 });
  assert.equal(rejectedResult.warning, SESSION_WORKSPACE_WARNING);
  await assert.rejects(
    activateWorkspaceForClient(rejected, path.dirname(home), { degradeOnFailure: false }),
    /filesystem or user root/,
    "project-picker activation must remain fatal and transactional",
  );

  const unwatchable = new WorkspaceService({
    homeDir: home,
    statePath: path.join(base, "unwatchable-state.json"),
    watchFactory: () => { throw new Error("synthetic watcher failure"); },
  });
  t.after(() => unwatchable.dispose());
  const unwatchableResult = await activateWorkspaceForClient(unwatchable, repo, { degradeOnFailure: true });
  assert.equal(unwatchableResult.workspace.selected, false);
  assert.equal(unwatchableResult.warning, SESSION_WORKSPACE_WARNING);
});


test("asynchronous watcher errors close once and emit bounded degraded invalidation", async (t) => {
  const { base, home, repo } = createRepo(t);
  const watcher = new EventEmitter();
  let closes = 0;
  watcher.close = () => { closes += 1; };
  const invalidations = [];
  let changed = null;
  const service = new WorkspaceService({
    homeDir: home,
    statePath: path.join(base, "watch-error-state.json"),
    watchFactory: (...args) => { changed = args.at(-1); return watcher; },
    onInvalidated: (event) => invalidations.push(event),
  });
  t.after(() => service.dispose());
  const workspace = await service.activatePath(repo);
  await listRoot(service, workspace);
  assert.ok(service.directoryCache.size > 0);
  changed();
  assert.doesNotThrow(() => watcher.emit("error", new Error("synthetic async watch failure")));
  assert.equal(closes, 1);
  assert.equal(service.watcher, null);
  assert.equal(service.directoryCache.size, 0);
  assert.deepEqual(invalidations, [{ workspaceId: workspace.workspaceId, generation: workspace.generation, reason: "watcher-error", degraded: true }]);
  watcher.emit("error", new Error("duplicate"));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(closes, 1);
  assert.equal(invalidations.length, 1);
});


test("macOS internal and mounted volume roots are rejected before watcher creation", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, home } = createRepo(t);
  const watched = [];
  const service = new WorkspaceService({
    homeDir: home,
    statePath: path.join(base, "volume-root-state.json"),
    watchFactory: (root) => { watched.push(root); return { close() {} }; },
  });
  t.after(() => service.dispose());
  for (const target of ["/System/Volumes", "/System/Volumes/Data", "/System/Volumes/Preboot"]) {
    if (!fs.existsSync(target)) continue;
    await assert.rejects(service.activatePath(target), /project folder|filesystem or user root/);
  }
  await assert.rejects(service._assertReasonableRoot("/Volumes/PrimeDesktopSyntheticVolume"), /project folder|filesystem or user root/);
  assert.deepEqual(watched, []);
});
