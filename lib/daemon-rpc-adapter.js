"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

class NoResidentSessionError extends Error {
  constructor(message = "No resident daemon session is available") {
    super(message);
    this.name = "NoResidentSessionError";
    this.code = "NO_RESIDENT_SESSION";
  }
}

function canonicalFile(value) {
  if (typeof value !== "string" || !value) return null;
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); }
  catch { return resolved; }
}

function isDaemonAbsentError(error) {
  return !!(error && (["ENOENT", "ECONNREFUSED"].includes(error.code) || /\b(?:ENOENT|ECONNREFUSED)\b/.test(String(error.message || ""))));
}

function findPrimeAgentModuleEntry({ homeDir, invocation, override } = {}) {
  const candidates = [];
  if (override) candidates.push(path.resolve(override));
  if (homeDir) {
    candidates.push(
      path.join(homeDir, ".local", "lib", "node_modules", "prime-agent", "dist", "index.js"),
      path.join(homeDir, ".hermes", "node", "lib", "node_modules", "prime-agent", "dist", "index.js"),
    );
  }
  const invocationPaths = [invocation && invocation.display, invocation && invocation.command].filter(Boolean);
  for (const value of invocationPaths) {
    let current;
    try { current = fs.statSync(value).isFile() ? path.dirname(fs.realpathSync(value)) : null; }
    catch { current = null; }
    while (current && current !== path.dirname(current)) {
      const manifest = path.join(current, "package.json");
      try {
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "prime-agent") {
          candidates.push(path.join(current, "dist", "index.js"));
          break;
        }
      } catch {}
      current = path.dirname(current);
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function importPrimeAgent(moduleEntry) {
  if (!moduleEntry) throw new NoResidentSessionError("Prime Agent's daemon module is unavailable");
  return import(pathToFileURL(moduleEntry).href);
}

async function listResidentDaemonSessions({ socketPath, moduleEntry, primeModule, loadPrimeAgent = importPrimeAgent } = {}) {
  if (!primeModule && !moduleEntry) return [];
  let prime;
  try { prime = primeModule || await loadPrimeAgent(moduleEntry); }
  catch (error) {
    if (error instanceof NoResidentSessionError) return [];
    throw error;
  }
  if (!prime || typeof prime.DaemonClient !== "function") return [];
  const client = new prime.DaemonClient(socketPath);
  try {
    await client.connect(1_000);
    const hello = await client.waitForHello(1_000);
    if (!hello || !hello.protocol || hello.protocol.name !== "prime-agent.daemon") throw new Error("Unsupported Prime Agent daemon protocol");
    const listed = await client.request({ type: "list", includeClientOwned: true }, 2_000);
    if (!listed || listed.success !== true || !listed.data || !Array.isArray(listed.data.sessions)) {
      throw new Error(listed && listed.error || "Prime Agent daemon session discovery failed");
    }
    return listed.data.sessions.filter((item) => item && typeof item.activeSessionId === "string" && item.activeSessionId && typeof item.sessionFile === "string" && item.sessionFile);
  } catch (error) {
    if (isDaemonAbsentError(error)) return [];
    throw error;
  } finally { client.close(); }
}

async function discoverResidentSession(options = {}) {
  const targetPath = canonicalFile(options.sessionPath);
  if (!targetPath) return null;
  const sessions = await listResidentDaemonSessions(options);
  return sessions.find((item) => canonicalFile(item.sessionFile) === targetPath) || null;
}

function response(command, data) {
  return data === undefined
    ? { type: "response", command, success: true }
    : { type: "response", command, success: true, data };
}

function failure(command, error) {
  return {
    type: "response",
    command,
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function rpcState(state, streamingMessage) {
  return {
    model: state && state.model,
    thinkingLevel: state && state.thinkingLevel,
    isStreaming: !!(state && state.isStreaming),
    isCompacting: !!(state && state.isCompacting),
    steeringMode: state && state.steeringMode,
    followUpMode: state && state.followUpMode,
    sessionFile: state && state.sessionFile,
    sessionId: state && state.sessionId,
    sessionName: state && state.sessionName,
    autoCompactionEnabled: !!(state && state.autoCompactionEnabled),
    messageCount: Number(state && state.messageCount || 0),
    sessionActions: state && state.sessionActions,
    goal: state && state.goal,
    ...(streamingMessage ? { streamingMessage } : {}),
  };
}

function extensionResponse(command) {
  if (command.cancelled === true) return { cancelled: true };
  if (Object.prototype.hasOwnProperty.call(command, "value")) return { value: String(command.value) };
  return { confirmed: command.confirmed === true };
}

/**
 * Adapts Prime Agent 0.7's public daemon AgentConnection to Desktop's existing
 * narrow RPC event/response contract. It never owns the resident worker:
 * dispose sends detach and closes only this desktop socket client.
 */
class DaemonRpcAdapter extends EventEmitter {
  constructor({ socketPath, sessionPath, moduleEntry, primeModule, loadPrimeAgent = importPrimeAgent } = {}) {
    super();
    this.socketPath = socketPath;
    this.sessionPath = canonicalFile(sessionPath);
    this.moduleEntry = moduleEntry;
    this.primeModule = primeModule;
    this.loadPrimeAgent = loadPrimeAgent;
    this.client = null;
    this.connection = null;
    this.unsubscribe = null;
    this.snapshot = null;
    this.streamingMessage = null;
    this.activeSessionId = null;
    this.started = false;
    this.stopping = false;
    this.inputResponsesPending = 0;
    this.bufferedEvents = [];
  }

  async start() {
    if (this.started) throw new Error("Daemon attachment already started");
    if (!this.sessionPath) throw new NoResidentSessionError();
    const prime = this.primeModule || await this.loadPrimeAgent(this.moduleEntry);
    if (!prime || typeof prime.DaemonClient !== "function" || !prime.DaemonAgentConnection || typeof prime.DaemonAgentConnection.attach !== "function") {
      throw new NoResidentSessionError("This Prime Agent build does not support safe daemon attachment");
    }

    const client = new prime.DaemonClient(this.socketPath);
    this.client = client;
    try {
      await client.connect();
      const hello = await client.waitForHello();
      if (!hello || !hello.protocol || hello.protocol.name !== "prime-agent.daemon") {
        throw new Error("Unsupported Prime Agent daemon protocol");
      }
      const listed = await client.request({ type: "list", includeClientOwned: true });
      if (!listed || listed.success !== true || !listed.data || !Array.isArray(listed.data.sessions)) {
        throw new Error(listed && listed.error || "Prime Agent daemon session discovery failed");
      }
      const target = listed.data.sessions.find((item) =>
        item && item.activeSessionId && item.sessionFile && canonicalFile(item.sessionFile) === this.sessionPath);
      if (!target) {
        client.close();
        this.client = null;
        throw new NoResidentSessionError();
      }
      this.activeSessionId = target.activeSessionId;
      const connection = await prime.DaemonAgentConnection.attach(client, target.activeSessionId, {
        closeClientOnDispose: true,
        sendClientEnv: false,
        supportsExtensionUi: true,
        ownedSession: false,
      });
      this.connection = connection;
      // Attach installs the adapter's sequenced daemon listener before returning.
      // Subscribe before reading the snapshot so subsequent live events cannot gap.
      this.unsubscribe = connection.subscribe((event) => this._handleConnectionEvent(event));
      this.snapshot = await connection.getInitialSnapshot();
      this.streamingMessage = this.snapshot && this.snapshot.streamingMessage || null;
      const reported = canonicalFile(this.snapshot && this.snapshot.state && this.snapshot.state.sessionFile);
      if (reported && reported !== this.sessionPath) throw new Error("Daemon attached a different session than requested");
      this.started = true;
      return this.waitUntilReady();
    } catch (error) {
      if (this.connection) await this.connection.dispose().catch(() => {});
      else if (this.client) this.client.close();
      this.connection = null;
      this.client = null;
      this.unsubscribe = null;
      if (error instanceof NoResidentSessionError) throw error;
      // A missing/refused socket means there is no resident daemon to attach to.
      if (isDaemonAbsentError(error)) throw new NoResidentSessionError();
      throw error;
    }
  }

  async waitUntilReady() {
    if (!this.connection || !this.snapshot) throw new Error("Daemon attachment is not ready");
    const state = this.snapshot.state || await this.connection.getState();
    const data = rpcState(state, this.streamingMessage);
    data.sessionFile = this.sessionPath;
    return response("ready", data);
  }

  _emitRpcEvent(event) {
    if (this.inputResponsesPending > 0) this.bufferedEvents.push(event);
    else this.emit("event", event);
  }

  _flushInputEvents() {
    if (this.inputResponsesPending > 0) return;
    const pending = this.bufferedEvents.splice(0);
    if (!pending.length) return;
    // Let every accepting chat:send rotate its draft and render its user bubble
    // before daemon output fans out, matching Prime's RPC response ordering.
    setImmediate(() => {
      if (this.stopping) return;
      for (const event of pending) this.emit("event", event);
    });
  }

  async _admitInput(run) {
    this.inputResponsesPending += 1;
    try { return await run(); }
    finally {
      this.inputResponsesPending = Math.max(0, this.inputResponsesPending - 1);
      this._flushInputEvents();
    }
  }

  _observeSessionEvent(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "message_update" && event.message && event.message.role === "assistant") this.streamingMessage = event.message;
    if (event.type === "message_end" && event.message && event.message.role === "assistant") this.streamingMessage = null;
    if (event.type === "agent_end") this.streamingMessage = null;
    this._emitRpcEvent(event);
  }

  _replaceSnapshot(snapshot) {
    if (!snapshot) return;
    const reported = canonicalFile(snapshot.state && snapshot.state.sessionFile);
    if (reported && reported !== this.sessionPath) {
      this.emit("exit", { code: 1, error: "The resident Prime Agent worker switched sessions; reopen the session to continue." });
      void this.stop();
      return;
    }
    this.snapshot = snapshot;
    this.streamingMessage = snapshot.streamingMessage || null;
    // Existing renderers ignore unknown events, while upgraded renderers use
    // this bounded DTO to rehydrate after daemon replay/resynchronization.
    this._emitRpcEvent({
      type: "session_resynced",
      state: { ...rpcState(snapshot.state || {}, this.streamingMessage), sessionFile: this.sessionPath },
      messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
      streamingMessage: this.streamingMessage || undefined,
    });
  }

  _handleConnectionEvent(event) {
    if (!event || this.stopping) return;
    if (event.type === "session_event") return this._observeSessionEvent(event.event);
    if (event.type === "session_replaced") {
      return this._replaceSnapshot({ state: event.state, messages: event.messages || [] });
    }
    if (event.type === "session_resynced") return this._replaceSnapshot(event.snapshot);
    if (event.type === "extension_error") {
      return this._emitRpcEvent({ type: "extension_error", extensionPath: event.extensionPath, event: event.event, error: event.error });
    }
    if (event.type === "extension_ui_request" && event.request) {
      const method = event.request.method === "setEditorText" ? "set_editor_text" : event.request.method;
      return this._emitRpcEvent({ ...(event.request.payload || {}), type: "extension_ui_request", id: event.request.id, method });
    }
    if (event.type === "connection_status" && event.status === "reconnecting") {
      return this.emit("error-event", { message: event.error || "Prime Agent daemon connection is recovering" });
    }
    if (event.type === "closed") {
      this.emit("exit", { code: 1, error: event.error || "Prime Agent daemon connection closed" });
    }
  }

  async _currentState() {
    const state = await this.connection.getState();
    const data = rpcState(state, this.streamingMessage);
    data.sessionFile = this.sessionPath;
    return data;
  }

  async command(command) {
    const type = command && command.type;
    if (!this.connection || !type) return failure(type || "unknown", new Error("Daemon attachment is not running"));
    try {
      switch (type) {
        case "prompt": await this._admitInput(() => this.connection.prompt(command.message, {
          images: command.images,
          streamingBehavior: command.streamingBehavior,
          source: "rpc",
        })); return response(type);
        case "steer": await this._admitInput(() => this.connection.steer(command.message, command.images)); return response(type);
        case "follow_up": await this._admitInput(() => this.connection.followUp(command.message, command.images)); return response(type);
        case "abort": await this.connection.abort(); return response(type);
        case "get_state": return response(type, await this._currentState());
        case "get_messages": {
          const messages = await this.connection.getMessages();
          return response(type, { messages, ...(this.streamingMessage ? { streamingMessage: this.streamingMessage } : {}) });
        }
        case "get_session_stats": return response(type, await this.connection.getSessionStats());
        case "get_commands": {
          const commands = (await this.connection.getCommands()).map((item) => ({
            name: item.name, description: item.description, source: item.source, sourceInfo: item.sourceInfo,
          }));
          return response(type, { commands });
        }
        case "get_available_models": return response(type, { models: await this.connection.getAvailableModels() });
        case "set_model": return response(type, await this.connection.setModel(command.provider, command.modelId));
        case "set_thinking_level": await this.connection.setThinkingLevel(command.level); return response(type);
        case "set_service_tier": await this.connection.setServiceTier(command.serviceTier); return response(type);
        case "set_streaming_behavior": {
          if (command.steeringMode) await this.connection.setSteeringMode(command.steeringMode);
          if (command.followUpMode) await this.connection.setFollowUpMode(command.followUpMode);
          return response(type);
        }
        case "set_follow_up_mode": await this.connection.setFollowUpMode(command.mode); return response(type);
        case "set_retry_settings": if (typeof command.enabled === "boolean") await this.connection.setAutoRetryEnabled(command.enabled); return response(type);
        case "set_compaction_settings": if (typeof command.enabled === "boolean") await this.connection.setAutoCompactionEnabled(command.enabled); return response(type);
        case "set_session_name": await this.connection.setSessionName(String(command.name || "").trim()); return response(type);
        case "abort_retry": await this.connection.abortRetry(); return response(type);
        case "abort_compaction": await this.connection.abortCompaction(); return response(type);
        case "abort_branch_summary": await this.connection.abortBranchSummary(); return response(type);
        case "reload": await this.connection.reload(); return response(type);
        case "compact": return response(type, await this.connection.compact(command.customInstructions));
        case "extension_ui_response": await this.connection.respondToExtensionUiRequest(command.id, extensionResponse(command)); return response(type);
        case "get_tree": return response(type, await this.connection.getSessionTree());
        case "get_branch": return response(type, await this.connection.getSessionContext());
        case "navigate_tree": return response(type, await this.connection.navigateTree(command.targetId, {
          summarize: command.summarize, customInstructions: command.customInstructions,
          replaceInstructions: command.replaceInstructions, label: command.label,
        }));
        case "list_agents":
        case "get_active_subagents": return response(type, { agents: (this.snapshot && this.snapshot.children) || [] });
        case "list_schedules": return response(type, { jobs: await this.connection.listCronJobs({ includeInactive: command.includeInactive }) });
        case "add_schedule": return response(type, { job: await this.connection.addCronJob(command.schedule, command.prompt) });
        case "cancel_schedule": return response(type, { job: await this.connection.cancelCronJob(command.jobId) });
        case "list_heartbeats": return response(type, { heartbeats: await this.connection.listHeartbeats() });
        case "manage_heartbeat": return response(type, { heartbeat: await this.connection.manageHeartbeat(command.activeSessionId, command.jobId, command.action) });
        default: return failure(type, new Error(`Unsupported daemon command: ${type}`));
      }
    } catch (error) { return failure(type, error); }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.bufferedEvents.length = 0;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    const connection = this.connection;
    this.connection = null;
    try {
      if (connection) await connection.dispose();
      else if (this.client) this.client.close();
    } finally {
      this.client = null;
      this.started = false;
    }
  }
}

module.exports = {
  DaemonRpcAdapter,
  NoResidentSessionError,
  canonicalFile,
  findPrimeAgentModuleEntry,
  listResidentDaemonSessions,
  discoverResidentSession,
  rpcState,
};
