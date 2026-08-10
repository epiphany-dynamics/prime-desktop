"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const {
  DaemonRpcAdapter,
  NoResidentSessionError,
  findPrimeAgentModuleEntry,
  discoverResidentSession,
  listResidentDaemonSessions,
} = require("../lib/daemon-rpc-adapter");

function fixture(t, { resident = true, streaming = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-desktop-daemon-adapter-"));
  const sessionFile = path.join(root, "terminal-session.jsonl");
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "terminal", cwd: root }) + "\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = {
    worker: {
      activeSessionId: "active-terminal",
      sessionFile,
      attachedClients: 1, // the terminal UI is already attached
      leaseWriters: 1,    // its daemon worker remains the sole JSONL writer
      stopped: false,
    },
    clients: [],
    connections: [],
    commands: [],
  };

  class FakeDaemonClient {
    constructor(socketPath) { this.socketPath = socketPath; this.closed = false; backend.clients.push(this); }
    async connect() { this.connected = true; }
    async waitForHello() { return { protocol: { name: "prime-agent.daemon", version: 7 }, appVersion: "0.7.1" }; }
    async request(command) {
      backend.commands.push(command);
      if (command.type !== "list") throw new Error("unexpected raw command");
      return { type: "response", command: "list", success: true, data: { sessions: resident ? [{ ...backend.worker }] : [] } };
    }
    close() { this.closed = true; }
  }

  class FakeConnection {
    static async attach(client, activeSessionId, options) {
      assert.equal(activeSessionId, backend.worker.activeSessionId);
      backend.worker.attachedClients += 1;
      const connection = new FakeConnection(client, options);
      backend.connections.push(connection);
      return connection;
    }
    constructor(client, options) {
      this.client = client;
      this.options = options;
      this.listeners = new Set();
      this.disposed = false;
      this.state = {
        activeSessionId: backend.worker.activeSessionId,
        cwd: root,
        model: { provider: "fixture", id: "model" },
        thinkingLevel: "medium",
        serviceTier: "standard",
        isStreaming: streaming,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionFile,
        sessionId: "terminal",
        autoCompactionEnabled: true,
        messageCount: 2,
        sessionActions: { steering: [], followUps: [] },
        goal: { status: "idle" },
      };
      this.streamingMessage = streaming ? { role: "assistant", content: [{ type: "text", text: "still running" }] } : undefined;
      this.messages = [{ role: "user", content: "from terminal" }];
      this.calls = [];
    }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    emit(event) { for (const listener of [...this.listeners]) listener(event); }
    async getInitialSnapshot() { return { state: this.state, messages: this.messages, streamingMessage: this.streamingMessage }; }
    async getState() { return this.state; }
    async getMessages() { return this.messages; }
    async getSessionStats() { return { contextUsage: { percent: 12 }, cost: 0 }; }
    async getCommands() { return [{ name: "review", description: "Review", source: "skill", sourceInfo: { path: "redacted" } }]; }
    async getAvailableModels() { return [{ provider: "fixture", id: "model" }]; }
    async prompt(message, options) {
      this.calls.push(["prompt", message, options]);
      this.emit({ type: "session_event", event: { type: "agent_start" } });
      this.streamingMessage = { role: "assistant", content: [{ type: "text", text: "live" }] };
      this.emit({ type: "session_event", event: { type: "message_update", message: this.streamingMessage } });
    }
    async steer(message, images) { this.calls.push(["steer", message, images]); }
    async followUp(message, images) { this.calls.push(["followUp", message, images]); }
    async abort() { this.calls.push(["abort"]); }
    async setModel(provider, modelId) { return { provider, id: modelId }; }
    async setThinkingLevel(level) { this.calls.push(["thinking", level]); }
    async setServiceTier(tier) { this.calls.push(["tier", tier]); }
    async setSessionName(name) { this.calls.push(["name", name]); }
    async listCronJobs() { return []; }
    async listHeartbeats() { return []; }
    async dispose() {
      this.disposed = true;
      backend.worker.attachedClients -= 1;
      this.client.close();
      // ownedSession:false means detach only: the terminal worker and its lease survive.
      if (this.options.ownedSession) backend.worker.stopped = true;
    }
  }

  return {
    root, sessionFile, backend,
    primeModule: { DaemonClient: FakeDaemonClient, DaemonAgentConnection: FakeConnection },
  };
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

test("desktop attaches beside a terminal client without acquiring a second session lease", async (t) => {
  const f = fixture(t);
  const adapter = new DaemonRpcAdapter({ socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule: f.primeModule });
  await adapter.start();
  assert.equal(f.backend.worker.attachedClients, 2);
  assert.equal(f.backend.worker.leaseWriters, 1);
  assert.equal(f.backend.worker.stopped, false);
  assert.deepEqual(f.backend.commands, [{ type: "list", includeClientOwned: true }]);
  assert.deepEqual(f.backend.connections[0].options, {
    closeClientOnDispose: true,
    sendClientEnv: false,
    supportsExtensionUi: true,
    ownedSession: false,
  });

  const state = await adapter.command({ type: "get_state" });
  const messages = await adapter.command({ type: "get_messages" });
  assert.equal(state.success, true);
  assert.equal(state.data.isStreaming, true);
  assert.equal(messages.data.messages[0].content, "from terminal");
  assert.equal(messages.data.streamingMessage.content[0].text, "still running");

  await adapter.stop("pane closed");
  assert.equal(f.backend.worker.attachedClients, 1, "desktop detached while terminal stayed attached");
  assert.equal(f.backend.worker.leaseWriters, 1);
  assert.equal(f.backend.worker.stopped, false, "desktop close must never stop the resident worker");
});

test("daemon live events and prompt/steer/follow-up/abort images retain the RPC contract", async (t) => {
  const f = fixture(t, { streaming: false });
  const adapter = new DaemonRpcAdapter({ socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule: f.primeModule });
  await adapter.start();
  const received = [];
  adapter.on("event", (event) => received.push(event));
  const images = [{ type: "image", data: "exact-base64", mimeType: "image/png" }];
  const prompt = await adapter.command({ type: "prompt", message: "hello", images });
  assert.equal(prompt.success, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received.map((event) => event.type), ["agent_start", "message_update"]);
  assert.deepEqual(f.backend.connections[0].calls[0], ["prompt", "hello", { images, streamingBehavior: undefined, source: "rpc" }]);

  assert.equal((await adapter.command({ type: "steer", message: "now", images })).success, true);
  assert.equal((await adapter.command({ type: "follow_up", message: "later", images })).success, true);
  assert.equal((await adapter.command({ type: "abort" })).success, true);
  assert.deepEqual(f.backend.connections[0].calls.slice(1), [
    ["steer", "now", images], ["followUp", "later", images], ["abort"],
  ]);
  await adapter.stop();
});

test("live event fan-out reaches every desktop pane listener through one shared adapter", async (t) => {
  const f = fixture(t, { streaming: false });
  const adapter = new DaemonRpcAdapter({ socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule: f.primeModule });
  await adapter.start();
  const paneA = [], paneB = [];
  adapter.on("event", (event) => paneA.push(event));
  adapter.on("event", (event) => paneB.push(event));
  f.backend.connections[0].emit({ type: "session_event", event: { type: "agent_start" } });
  f.backend.connections[0].emit({ type: "session_event", event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "shared" }] } } });
  assert.deepEqual(paneA, paneB);
  assert.equal(f.backend.connections.length, 1, "split panes share the single desktop daemon attachment");
  assert.equal(f.backend.worker.attachedClients, 2, "terminal plus one desktop connection, not one per pane");
  await adapter.stop();
});

test("only an inactive saved session produces the RPC fallback sentinel", async (t) => {
  const f = fixture(t, { resident: false });
  const adapter = new DaemonRpcAdapter({ socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule: f.primeModule });
  await assert.rejects(adapter.start(), (error) => error instanceof NoResidentSessionError && error.code === "NO_RESIDENT_SESSION");
  assert.equal(f.backend.clients[0].closed, true);
  assert.equal(f.backend.connections.length, 0);
});

test("Prime Agent module discovery accepts an explicit packaged ESM entry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-desktop-module-entry-"));
  const entry = path.join(root, "index.js"); fs.writeFileSync(entry, "export {};\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(findPrimeAgentModuleEntry({ override: entry }), entry);
});

test("read-only discovery identifies a resident terminal session and closes its probe client", async (t) => {
  const f = fixture(t);
  const found = await discoverResidentSession({
    socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule: f.primeModule,
  });
  assert.equal(found.activeSessionId, f.backend.worker.activeSessionId);
  assert.equal(f.backend.clients[0].closed, true);
  assert.equal(f.backend.worker.attachedClients, 1, "discovery does not attach or change ownership");
  assert.equal(f.backend.worker.leaseWriters, 1);
});

test("a wrapped ENOENT daemon connect error permits inactive RPC fallback", async (t) => {
  const f = fixture(t);
  class MissingDaemonClient {
    async connect() { throw new Error("Failed to connect to the Prime Agent daemon: connect ENOENT /fake/daemon.sock"); }
    close() { this.closed = true; }
  }
  const primeModule = { ...f.primeModule, DaemonClient: MissingDaemonClient };
  const adapter = new DaemonRpcAdapter({ socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule });
  await assert.rejects(adapter.start(), (error) => error instanceof NoResidentSessionError);
  assert.deepEqual(await listResidentDaemonSessions({ socketPath: "/fake/daemon.sock", primeModule }), []);
});

test("a pre-daemon Prime Agent build permits inactive RPC fallback", async (t) => {
  const f = fixture(t);
  const adapter = new DaemonRpcAdapter({ socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule: {} });
  await assert.rejects(adapter.start(), (error) => error instanceof NoResidentSessionError);
  assert.deepEqual(await listResidentDaemonSessions({ socketPath: "/fake/daemon.sock", primeModule: {} }), []);
});

test("a terminal-side session replacement detaches instead of corrupting Desktop's canonical binding", async (t) => {
  const f = fixture(t, { streaming: false });
  const replacementFile = path.join(f.root, "other-session.jsonl");
  fs.writeFileSync(replacementFile, JSON.stringify({ type: "session", id: "other", cwd: f.root }) + "\n");
  const adapter = new DaemonRpcAdapter({ socketPath: "/fake/daemon.sock", sessionPath: f.sessionFile, primeModule: f.primeModule });
  await adapter.start();
  const closed = once(adapter, "exit");
  f.backend.connections[0].emit({
    type: "session_replaced",
    state: { ...f.backend.connections[0].state, sessionFile: replacementFile, sessionId: "other" },
    messages: [{ role: "user", content: "other session" }],
  });
  const event = await closed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(event.error, /switched sessions/);
  assert.equal(f.backend.worker.attachedClients, 1, "Desktop detached but the terminal worker survived");
  assert.equal(f.backend.worker.stopped, false);
});
