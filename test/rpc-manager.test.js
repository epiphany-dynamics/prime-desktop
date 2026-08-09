"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RpcManager } = require("../lib/rpc-manager");

class FakeProcess extends EventEmitter {
  constructor(onCommand, behavior = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.behavior = behavior;
    this.stdin = {
      write: (line, callback) => {
        try { onCommand(JSON.parse(line), this); if (callback) callback(null); }
        catch (error) { if (callback) callback(error); }
        return true;
      },
    };
  }
  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    const shouldExit = signal === "SIGKILL" ? this.behavior.exitOnKill !== false : this.behavior.exitOnTerm !== false;
    if (shouldExit) queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-rpc-test-"));
  const processes = [];
  const spawns = [];
  const onCommand = options.onCommand || ((command, proc) => {
    const data = command.type === "get_state" ? { sessionFile: path.join(root, `session-${processes.indexOf(proc)}.jsonl`) } : {};
    queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }) + "\n"));
  });
  const manager = new RpcManager({
    defaultCwd: root,
    commandTimeoutMs: options.commandTimeoutMs || 200,
    readyDeadlineMs: options.readyDeadlineMs || 200,
    readyProbeMs: options.readyProbeMs || 30,
    readyDelayMs: options.readyDelayMs == null ? 0 : options.readyDelayMs,
    killGraceMs: options.killGraceMs == null ? 20 : options.killGraceMs,
    killEscalationWaitMs: 10,
    extraArgs: ["--daemon-socket", "/fixture.sock"],
    resolveInvocation: () => ({ command: "/fake/node", args: ["fake-agent.js"] }),
    spawnProcess: (command, args, spawnOptions) => {
      spawns.push({ command, args, options: spawnOptions, at: Date.now() });
      const behavior = typeof options.processBehavior === "function" ? options.processBehavior(processes.length) : (options.processBehavior || {});
      const proc = new FakeProcess(onCommand, behavior);
      processes.push(proc);
      return proc;
    },
  });
  return { root, manager, processes, spawns };
}

async function cleanup(t, fixtureValue) {
  t.after(async () => {
    await fixtureValue.manager.stop("test cleanup");
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  });
}

test("spawn pins canonical cwd in process options and explicit --cwd/--resume arguments", async (t) => {
  const f = fixture(); await cleanup(t, f);
  const project = path.join(f.root, "project"); fs.mkdirSync(project);
  const session = path.join(f.root, "saved.jsonl");
  await f.manager.start({ cwd: project, sessionPath: session });
  assert.equal(f.spawns[0].options.cwd, fs.realpathSync(project));
  assert.deepEqual(f.spawns[0].args, ["fake-agent.js", "--mode", "rpc", "--cwd", fs.realpathSync(project), "--daemon-socket", "/fixture.sock", "--resume", session]);
  assert.equal((await f.manager.command({ type: "get_state" })).success, true);
});

test("chunked JSONL resolves only the owning generation", async (t) => {
  const f = fixture({ onCommand(command, proc) {
    const line = JSON.stringify({ id: command.id, type: "response", success: true, data: { value: 7 } }) + "\n";
    queueMicrotask(() => { proc.stdout.write(line.slice(0, 9)); proc.stdout.write(line.slice(9)); });
  } });
  await cleanup(t, f);
  await f.manager.start(f.root);
  assert.equal((await f.manager.command({ type: "get_state" })).data.value, 7);
});

test("replacement rejects pending work, waits for SIGTERM, then escalates to SIGKILL", async (t) => {
  const f = fixture({
    onCommand() {},
    killGraceMs: 15,
    processBehavior: (index) => index === 0 ? { exitOnTerm: false, exitOnKill: true } : {},
  });
  await cleanup(t, f);
  const exits = []; const events = [];
  f.manager.on("exit", (value) => exits.push(value));
  f.manager.on("event", (value) => events.push(value));
  await f.manager.start(f.root);
  const old = f.processes[0];
  const pending = f.manager.command({ type: "get_messages" });
  const replacement = f.manager.start(f.root);
  await assert.rejects(pending, /stopped for restart/);
  await replacement;
  assert.deepEqual(old.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(f.spawns.length, 2, "replacement spawns only after disposal finishes");
  old.stdout.write(JSON.stringify({ type: "agent_end", stale: true }) + "\n");
  old.emit("exit", 9);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, []);
  assert.deepEqual(events, []);
});

test("readiness uses short probes and an overall wall-clock deadline", async (t) => {
  const f = fixture({ onCommand() {}, readyDeadlineMs: 55, readyProbeMs: 12, commandTimeoutMs: 5_000 });
  await cleanup(t, f);
  await f.manager.start(f.root);
  const started = Date.now();
  await assert.rejects(f.manager.waitUntilReady(), (error) => error.code === "RPC_READY_TIMEOUT");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 40 && elapsed < 250, `deadline was bounded (${elapsed} ms)`);
});

test("unexpected active exit rejects requests and emits one banner event", async (t) => {
  const f = fixture({ onCommand() {} }); await cleanup(t, f);
  const exits = [];
  f.manager.on("exit", (value) => exits.push(value));
  await f.manager.start(f.root);
  const pending = f.manager.command({ type: "get_messages" });
  f.processes[0].emit("exit", 13);
  await assert.rejects(pending, /exited/);
  assert.equal(exits.length, 1);
  f.processes[0].emit("exit", 13);
  assert.equal(exits.length, 1);
});

test("restart preserves prior cwd and restores a requested session", async (t) => {
  const commands = [];
  const f = fixture({ onCommand(command, proc) {
    commands.push(command);
    const index = f.processes.indexOf(proc);
    const data = command.type === "get_state" ? { sessionFile: path.join(f.root, `spawned-${index}.jsonl`) } : {};
    queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: command.id, type: "response", success: true, data }) + "\n"));
  } });
  await cleanup(t, f);
  const project = path.join(f.root, "project"); fs.mkdirSync(project);
  await f.manager.start(project);
  const prior = path.join(f.root, "prior.jsonl");
  const result = await f.manager.restart({ restoreSession: prior, readyDeadlineMs: 150 });
  assert.equal(result.cwd, fs.realpathSync(project));
  assert.ok(commands.some((command) => command.type === "switch_session" && command.sessionPath === prior));
});


test("late and unmatched response records are ignored instead of emitted as events", async (t) => {
  let timedOutCommand = null;
  const f = fixture({
    commandTimeoutMs: 15,
    onCommand(command) { timedOutCommand = command; },
  });
  await cleanup(t, f);
  const events = [];
  f.manager.on("event", (event) => events.push(event));
  await f.manager.start(f.root);
  await assert.rejects(f.manager.command({ type: "get_messages" }), /timed out/);
  f.processes[0].stdout.write(JSON.stringify({ id: timedOutCommand.id, type: "response", success: true, data: {} }) + "\n");
  f.processes[0].stdout.write(JSON.stringify({ id: "never-issued", type: "response", success: true, data: {} }) + "\n");
  f.processes[0].stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "agent_end" }]);
});
