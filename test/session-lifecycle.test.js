"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RpcManager } = require("../lib/rpc-manager");
const { SessionLifecycleRegistry } = require("../lib/session-lifecycle");

class SlowProcess extends EventEmitter {
  constructor(ignoreTerm = false) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { write(_line, callback) { if (callback) callback(null); return true; } };
    this.ignoreTerm = ignoreTerm;
    this.signals = [];
  }
  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGKILL" || !this.ignoreTerm) queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

test("canonical session reopen waits for a SIGTERM-ignoring disposal tombstone", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-session-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldProcesses = [];
  const oldManager = new RpcManager({
    defaultCwd: root,
    killGraceMs: 20,
    killEscalationWaitMs: 10,
    resolveInvocation: () => ({ command: "/fake/agent", args: [] }),
    spawnProcess: () => { const proc = new SlowProcess(true); oldProcesses.push(proc); return proc; },
  });
  await oldManager.start(root);

  const newProcesses = [];
  const newManager = new RpcManager({
    defaultCwd: root,
    resolveInvocation: () => ({ command: "/fake/agent", args: [] }),
    spawnProcess: () => { const proc = new SlowProcess(false); newProcesses.push(proc); return proc; },
  });
  t.after(() => newManager.stop("cleanup"));

  const registry = new SessionLifecycleRegistry();
  const session = path.join(root, "same.jsonl");
  const stopping = registry.trackDisposal(session, oldManager.stop("replacement"));
  const reopening = registry.run(session, async () => {
    await registry.waitForDisposal(session);
    return newManager.start({ cwd: root, sessionPath: session });
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(newProcesses.length, 0, "new manager cannot spawn during TERM grace");
  await stopping;
  await reopening;
  assert.deepEqual(oldProcesses[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(newProcesses.length, 1);
});


test("multiple disposal tombstones for one canonical session are all awaited", async () => {
  const registry = new SessionLifecycleRegistry();
  let releaseFirst; let releaseSecond;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const second = new Promise((resolve) => { releaseSecond = resolve; });
  registry.trackDisposal("same-session", first);
  registry.trackDisposal("same-session", second);
  let reopened = false;
  const wait = registry.waitForDisposal("same-session").then(() => { reopened = true; });
  releaseSecond();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened, false);
  releaseFirst();
  await wait;
  assert.equal(reopened, true);
});
