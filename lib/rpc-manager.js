"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_READY_DEADLINE_MS = 20_000;
const DEFAULT_READY_PROBE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_COMMAND_BYTES = 28 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function canonicalDirectory(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096) {
    throw new Error("A valid project folder is required");
  }
  const resolved = fs.realpathSync(path.resolve(input));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error("The selected project is not a folder");
  return resolved;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One generation-safe Prime Agent JSONL process. Prime Desktop creates one
 * instance per live client/session; the clients map remains outside this class.
 */
class RpcManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.resolveInvocation = options.resolveInvocation;
    this.buildEnv = options.buildEnv || (() => ({ ...process.env }));
    this.spawnProcess = options.spawnProcess || spawn;
    this.defaultCwd = canonicalDirectory(options.defaultCwd || process.cwd());
    this.commandTimeoutMs = options.commandTimeoutMs || DEFAULT_TIMEOUT_MS;
    this.readyDeadlineMs = options.readyDeadlineMs || DEFAULT_READY_DEADLINE_MS;
    this.readyProbeMs = options.readyProbeMs || DEFAULT_READY_PROBE_MS;
    this.readyDelayMs = options.readyDelayMs == null ? 100 : options.readyDelayMs;
    this.killGraceMs = options.killGraceMs == null ? DEFAULT_KILL_GRACE_MS : options.killGraceMs;
    this.killEscalationWaitMs = options.killEscalationWaitMs == null ? 250 : options.killEscalationWaitMs;
    this.maxCommandBytes = options.maxCommandBytes || DEFAULT_MAX_COMMAND_BYTES;
    this.maxResponseBytes = options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;
    this.extraArgs = Array.isArray(options.extraArgs) ? [...options.extraArgs] : [];
    this.client = null;
    this.currentCwd = this.defaultCwd;
    this.currentSessionFile = null;
    this.generation = 0;
    this.requestSeq = 0;
    this._transitionTail = Promise.resolve();
    this._transitionCount = 0;
  }

  get alive() { return !!(this.client && this.client.alive && !this.client.disposed); }
  get transitioning() { return this._transitionCount > 0; }

  _rejectPending(client, message) {
    const error = new Error(message || "Agent process stopped");
    error.code = "RPC_PROCESS_REPLACED";
    for (const pending of client.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    client.pending.clear();
  }

  _waitForExit(client, timeoutMs) {
    if (!client || client.exitObserved) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (client.proc && client.proc.removeListener) client.proc.removeListener("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      if (client.proc && client.proc.once) client.proc.once("exit", onExit);
      const timer = setTimeout(() => finish(!!client.exitObserved), Math.max(0, timeoutMs));
    });
  }

  async _disposeClient(client, reason = "restart") {
    if (!client) return;
    if (client.disposePromise) return client.disposePromise;
    client.disposePromise = (async () => {
      client.disposed = true;
      client.intentionalStop = true;
      client.alive = false;
      this._rejectPending(client, `Agent process stopped for ${reason}`);
      if (!client.proc || client.exitObserved) return;
      try { client.proc.kill("SIGTERM"); } catch {}
      const exited = await this._waitForExit(client, this.killGraceMs);
      if (!exited) {
        try { client.proc.kill("SIGKILL"); } catch {}
        await this._waitForExit(client, this.killEscalationWaitMs);
      }
    })();
    return client.disposePromise;
  }

  async stop(reason = "shutdown") {
    const client = this.client;
    if (!client) return;
    await this._disposeClient(client, reason);
    if (this.client === client) this.client = null;
  }

  async start(input) {
    const options = typeof input === "string" || input == null ? { cwd: input } : input;
    const targetCwd = canonicalDirectory(options.cwd || this.currentCwd || this.defaultCwd);
    const sessionPath = typeof options.sessionPath === "string" ? options.sessionPath : null;
    const oldClient = this.client;
    if (oldClient) {
      // Never let a replacement open the same JSONL until the old process has
      // exited or has been escalated to SIGKILL.
      await this._disposeClient(oldClient, options.reason || "restart");
      if (this.client === oldClient) this.client = null;
    }

    const env = this.buildEnv();
    const invocation = this.resolveInvocation && this.resolveInvocation(env);
    if (!invocation || typeof invocation.command !== "string") {
      const error = new Error("prime-agent binary not found. Install it or check PATH.");
      error.code = "RPC_BINARY_NOT_FOUND";
      this.emit("error-event", { message: error.message, code: error.code });
      throw error;
    }

    const generation = ++this.generation;
    const args = [
      ...(invocation.args || []),
      "--mode", "rpc",
      "--cwd", targetCwd,
      ...this.extraArgs,
    ];
    if (sessionPath) args.push("--resume", sessionPath);
    let proc;
    try {
      proc = this.spawnProcess(invocation.command, args, {
        cwd: targetCwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      const error = new Error("Failed to spawn prime-agent");
      error.cause = cause;
      error.code = "RPC_SPAWN_FAILED";
      this.emit("error-event", { message: error.message, code: error.code });
      throw error;
    }

    const client = {
      proc,
      generation,
      cwd: targetCwd,
      sessionPath,
      pending: new Map(),
      buffer: "",
      alive: true,
      intentionalStop: false,
      disposed: false,
      deadHandled: false,
      exitObserved: false,
      disposePromise: null,
    };
    this.client = client;
    this.currentCwd = targetCwd;
    this.currentSessionFile = sessionPath;

    if (proc.stdout && proc.stdout.setEncoding) proc.stdout.setEncoding("utf8");
    if (proc.stdout && proc.stdout.on) proc.stdout.on("data", (chunk) => this._onStdout(client, String(chunk)));
    if (proc.stderr && proc.stderr.on) {
      proc.stderr.on("data", (chunk) => {
        if (this.client !== client || !client.alive || client.disposed) return;
        // Provider diagnostics can contain paths or credentials. Main may log
        // only by explicit development policy; renderer receives bounded data.
        this.emit("stderr", String(chunk).slice(0, 8_192));
      });
    }
    if (proc.on) {
      proc.on("exit", (code) => { client.exitObserved = true; this._onDead(client, code, null); });
      proc.on("error", () => this._onDead(client, null, "Failed to start prime-agent"));
    }
    return { generation, cwd: targetCwd, sessionPath };
  }

  _onStdout(client, chunk) {
    if (this.client !== client || !client.alive || client.disposed) return;
    client.buffer += chunk;
    if (Buffer.byteLength(client.buffer, "utf8") > this.maxResponseBytes) {
      this._onDead(client, null, "Agent returned an oversized RPC record");
      void this._disposeClient(client, "oversized response");
      return;
    }
    let newline;
    while ((newline = client.buffer.indexOf("\n")) !== -1) {
      let line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this._handleMessage(client, message);
    }
  }

  _handleMessage(client, message) {
    if (this.client !== client || !client.alive || client.disposed) return;
    if (message && message.type === "response" && message.id && client.pending.has(message.id)) {
      const pending = client.pending.get(message.id);
      client.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (pending.commandType === "get_state" && message.success && message.data) {
        this.currentSessionFile = message.data.sessionFile || this.currentSessionFile;
      }
      pending.resolve(message);
      return;
    }
    this.emit("event", message);
  }

  _onDead(client, code, errorMessage) {
    if (!client || client.deadHandled) return;
    client.deadHandled = true;
    client.alive = false;
    this._rejectPending(client, errorMessage || `RPC process exited (${code == null ? -1 : code})`);
    if (client.intentionalStop || this.client !== client) return;
    this.emit("exit", { code: code == null ? -1 : code, error: errorMessage || null });
  }

  command(command, options = {}) {
    if (this.transitioning && !options.allowDuringTransition) {
      return Promise.reject(new Error("Agent workspace is changing; wait for it to finish"));
    }
    const client = this.client;
    if (!client || !client.alive || client.disposed) return Promise.reject(new Error("Agent process is not running"));
    if (!command || typeof command !== "object" || Array.isArray(command)) return Promise.reject(new Error("Invalid RPC command"));
    const id = `req-${client.generation}-${++this.requestSeq}`;
    const payload = { ...command, id };
    let line;
    try { line = JSON.stringify(payload) + "\n"; }
    catch { return Promise.reject(new Error("RPC command must be serializable")); }
    if (Buffer.byteLength(line, "utf8") > this.maxCommandBytes) return Promise.reject(new Error("RPC command is too large"));

    return new Promise((resolve, reject) => {
      const timeoutMs = Math.max(1, Number(options.timeoutMs) || this.commandTimeoutMs);
      const timer = setTimeout(() => {
        if (!client.pending.has(id)) return;
        client.pending.delete(id);
        reject(new Error(`Command timed out: ${command.type || "unknown"}`));
      }, timeoutMs);
      client.pending.set(id, { resolve, reject, timer, commandType: command.type });
      try {
        client.proc.stdin.write(line, (error) => {
          if (!error || !client.pending.has(id)) return;
          clearTimeout(timer);
          client.pending.delete(id);
          reject(new Error("Failed to write to the agent process"));
        });
      } catch {
        clearTimeout(timer);
        client.pending.delete(id);
        reject(new Error("Failed to write to the agent process"));
      }
    });
  }

  async waitUntilReady(options = {}) {
    const deadlineMs = Math.max(1, Number(options.readyDeadlineMs) || this.readyDeadlineMs);
    const deadline = Date.now() + deadlineMs;
    const delayMs = options.delayMs == null ? this.readyDelayMs : Math.max(0, Number(options.delayMs));
    let lastError = null;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        const response = await this.command(
          { type: "get_state" },
          { allowDuringTransition: true, timeoutMs: Math.max(1, Math.min(this.readyProbeMs, remaining)) },
        );
        if (response && response.success) return response;
        lastError = new Error(response && response.error || "Agent is not ready");
      } catch (error) { lastError = error; }
      if (Date.now() < deadline && delayMs) await delay(Math.min(delayMs, deadline - Date.now()));
    }
    const error = new Error(`Agent did not become ready before the ${deadlineMs} ms deadline`);
    error.code = "RPC_READY_TIMEOUT";
    error.cause = lastError;
    throw error;
  }

  runTransition(task) {
    this._transitionCount += 1;
    const run = this._transitionTail.then(task, task);
    this._transitionTail = run.catch(() => {});
    return run.finally(() => { this._transitionCount -= 1; });
  }

  restart(options = {}) {
    return this.runTransition(async () => {
      const targetCwd = canonicalDirectory(options.cwd || this.currentCwd || this.defaultCwd);
      await this.start({ cwd: targetCwd, sessionPath: options.sessionPath || null, reason: options.reason || "restart" });
      const ready = await this.waitUntilReady(options);
      let restore = null;
      const spawnedSession = ready.data && ready.data.sessionFile;
      const restoreSession = options.restoreSession || null;
      if (restoreSession && restoreSession !== spawnedSession) {
        const restoreAttempts = Math.max(1, Math.min(options.restoreAttempts || 5, 10));
        for (let attempt = 0; attempt < restoreAttempts; attempt += 1) {
          restore = await this.command(
            { type: "switch_session", sessionPath: restoreSession },
            { allowDuringTransition: true },
          );
          if (restore && restore.success) break;
          if (attempt + 1 < restoreAttempts) await delay(options.restoreDelayMs == null ? 150 : options.restoreDelayMs);
        }
        if (restore && restore.success) {
          const state = await this.command({ type: "get_state" }, { allowDuringTransition: true });
          if (state.success) this.currentSessionFile = state.data.sessionFile || restoreSession;
        }
      }
      return {
        ok: true,
        state: ready.data || null,
        spawnedSession: spawnedSession || null,
        restore,
        generation: this.generation,
        cwd: this.currentCwd,
      };
    });
  }
}

module.exports = {
  RpcManager,
  canonicalDirectory,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_READY_DEADLINE_MS,
  DEFAULT_READY_PROBE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_COMMAND_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
};
