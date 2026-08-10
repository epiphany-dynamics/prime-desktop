import fs from "node:fs";
import path from "node:path";

const configured = (() => {
  try { return JSON.parse(process.env.PRIME_DESKTOP_FAKE_DAEMON_SESSIONS || "[]"); }
  catch { return []; }
})();
const rows = configured.map((sessionFile, index) => ({
  activeSessionId: `fake-resident-${index + 1}`,
  sessionFile: fs.realpathSync(sessionFile),
  sessionId: `fake-resident-session-${index + 1}`,
  cwd: JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]).cwd,
  attachedClients: 1,
  isStreaming: false,
  isCompacting: false,
  activity: "idle",
  lifecycle: "live",
}));

export class DaemonClient {
  constructor(socketPath) { this.socketPath = socketPath; this.closed = false; }
  async connect() { this.connected = true; }
  async waitForHello() { return { protocol: { name: "prime-agent.daemon", version: 7 }, appVersion: "0.7.1" }; }
  async request(command) {
    if (command.type !== "list" || command.includeClientOwned !== true) throw new Error("fake daemon expected client-owned-aware list");
    return { type: "response", command: "list", success: true, data: { sessions: rows.map((row) => ({ ...row })) } };
  }
  close() { this.closed = true; }
}

class Connection {
  constructor(client, row, options) {
    this.client = client;
    this.row = row;
    this.options = options;
    this.listeners = new Set();
    this.messages = [{ role: "user", content: `terminal history for ${path.basename(row.sessionFile)}` }];
    this.streamingMessage = null;
    this.state = {
      activeSessionId: row.activeSessionId,
      cwd: row.cwd,
      model: { provider: "fixture", id: "offline-model", name: "Offline model", contextWindow: 100000, reasoning: true },
      thinkingLevel: "medium",
      serviceTier: "standard",
      availableThinkingLevels: ["off", "medium"],
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: row.sessionFile,
      sessionId: row.sessionId,
      leafId: null,
      autoCompactionEnabled: true,
      messageCount: this.messages.length,
      sessionActions: { steering: [], followUps: [] },
      compactionCount: 0,
      goal: { status: "idle" },
      scopedModels: [], activeToolNames: [], contextUsage: { percent: 1 },
    };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  async getInitialSnapshot() { return { state: this.state, messages: this.messages, streamingMessage: this.streamingMessage || undefined }; }
  async getState() { return this.state; }
  async getMessages() { return this.messages; }
  async getSessionStats() { return { contextUsage: { percent: 1 }, cost: 0 }; }
  async getCommands() { return []; }
  async getAvailableModels() { return [this.state.model]; }
  async prompt(message, options) {
    this.messages.push({ role: "user", content: options && options.images && options.images.length ? [{ type: "text", text: message }, ...options.images] : message });
    this.state.messageCount = this.messages.length;
    this.state.isStreaming = true;
    this.row.isStreaming = true;
    this.streamingMessage = { role: "assistant", content: [{ type: "text", text: "daemon attachment live stream" }] };
    this.emit({ type: "session_event", event: { type: "agent_start" } });
    this.emit({ type: "session_event", event: { type: "message_start", message: { role: "assistant", content: [] } } });
    this.emit({ type: "session_event", event: { type: "message_update", message: this.streamingMessage } });
  }
  async steer(message, images) { return this.prompt(message, { images, streamingBehavior: "steer" }); }
  async followUp(message, images) { return this.prompt(message, { images, streamingBehavior: "followUp" }); }
  async abort() {
    if (!this.state.isStreaming) return;
    const final = this.streamingMessage;
    if (final) {
      this.messages.push(final);
      this.emit({ type: "session_event", event: { type: "message_end", message: final } });
    }
    this.streamingMessage = null;
    this.state.isStreaming = false;
    this.row.isStreaming = false;
    this.state.messageCount = this.messages.length;
    this.emit({ type: "session_event", event: { type: "agent_end" } });
  }
  async setModel(provider, modelId) { this.state.model = { ...this.state.model, provider, id: modelId }; return this.state.model; }
  async setThinkingLevel(level) { this.state.thinkingLevel = level; }
  async setServiceTier(tier) { this.state.serviceTier = tier; }
  async setSessionName(name) { this.state.sessionName = name; }
  async listCronJobs() { return []; }
  async listHeartbeats() { return []; }
  async dispose() {
    this.row.attachedClients -= 1;
    // The terminal's resident worker remains alive because ownedSession is false.
    if (this.options.ownedSession === true) throw new Error("desktop incorrectly owned the fake terminal worker");
    this.client.close();
  }
}

export class DaemonAgentConnection {
  static async attach(client, activeSessionId, options) {
    const row = rows.find((candidate) => candidate.activeSessionId === activeSessionId);
    if (!row) throw new Error("unknown fake resident session");
    if (options.ownedSession !== false || options.sendClientEnv !== false || options.closeClientOnDispose !== true) {
      throw new Error("unsafe desktop daemon attachment options");
    }
    row.attachedClients += 1;
    return new Connection(client, row, options);
  }
}
