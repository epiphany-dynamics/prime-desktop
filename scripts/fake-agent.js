#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? fs.realpathSync(args[cwdIndex + 1]) : process.cwd();
const home = process.env.PRIME_DESKTOP_TEST_HOME || process.env.HOME || os.homedir();
const sessionsDir = path.join(home, ".prime", "agent", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

let currentSession = null;
let messages = [];
let model = { provider: "fixture", id: "offline-model", name: "Offline model" };
let thinkingLevel = "max";
let streaming = false;

function write(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function append(value) { if (currentSession) fs.appendFileSync(currentSession, JSON.stringify(value) + "\n"); }
function createSession(parentSession = null) {
  const id = crypto.randomUUID();
  currentSession = path.join(sessionsDir, `${Date.now()}-${id}.jsonl`);
  messages = [];
  const header = { type: "session", version: 1, id, timestamp: new Date().toISOString(), cwd };
  if (parentSession) header.parentSession = parentSession;
  fs.writeFileSync(currentSession, JSON.stringify(header) + "\n");
  return currentSession;
}
function loadSession(sessionPath) {
  const lines = fs.readFileSync(sessionPath, "utf8").split("\n");
  const header = JSON.parse(lines.find((line) => line.trim()));
  if (header.type !== "session") throw new Error("invalid session");
  currentSession = sessionPath;
  messages = [];
  for (const line of lines) {
    if (!line.includes('"type":"message"')) continue;
    try { const value = JSON.parse(line); if (value.type === "message") messages.push(value.message); } catch {}
  }
}
function respond(command, success = true, data = {}, error = null) {
  write({ id: command.id, type: "response", command: command.type, success, data, ...(error ? { error } : {}) });
}
function emitFixtureTurn(command) {
  if (String(command.message || "").includes("__REJECT__")) { respond(command, false, {}, "Synthetic prompt rejection"); return; }
  const content = [];
  if (command.message) content.push({ type: "text", text: command.message });
  for (const image of command.images || []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  const user = { role: "user", content, timestamp: new Date().toISOString() };
  messages.push(user); append({ type: "message", timestamp: user.timestamp, message: user });
  respond(command, true, {});
  streaming = true;
  write({ type: "agent_start" });
  if (String(command.message || "").includes("__HOLD__")) return;
  const assistant = { role: "assistant", content: [{ type: "text", text: "Offline fixture response." }], timestamp: new Date().toISOString() };
  write({ type: "message_start", message: assistant });
  write({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta" } });
  messages.push(assistant); append({ type: "message", timestamp: assistant.timestamp, message: assistant });
  write({ type: "message_end", message: assistant });
  streaming = false;
  write({ type: "agent_end" });
}

const resumeIndex = args.indexOf("--resume");
if (resumeIndex >= 0 && args[resumeIndex + 1] && fs.existsSync(args[resumeIndex + 1])) loadSession(args[resumeIndex + 1]);
else createSession();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  try {
    switch (command.type) {
      case "get_state":
        respond(command, true, { sessionFile: currentSession, model, thinkingLevel, isStreaming: streaming });
        if (command.testCrash === true) setTimeout(() => process.exit(23), 50);
        break;
      case "get_messages": respond(command, true, { messages }); break;
      case "get_session_stats": respond(command, true, { contextUsage: { percent: 1 }, cost: 0 }); break;
      case "get_available_models": respond(command, true, { models: [model] }); break;
      case "get_commands": respond(command, true, { commands: [{ name: "fixture", description: "Offline fixture command", source: "test" }] }); break;
      case "get_tree": case "get_branch": respond(command, true, {}); break;
      case "list_agents": case "get_active_subagents": respond(command, true, { agents: [] }); break;
      case "set_model": model = { provider: command.provider, id: command.modelId, name: command.modelId }; respond(command, true, model); break;
      case "set_thinking_level": thinkingLevel = command.level; respond(command, true, { level: thinkingLevel }); break;
      case "new_session": createSession(command.parentSession || null); respond(command, true, {}); break;
      case "switch_session": loadSession(command.sessionPath); respond(command, true, {}); break;
      case "set_session_name": append({ type: "session_info", name: command.name, timestamp: new Date().toISOString() }); respond(command, true, {}); break;
      case "prompt": case "steer": case "follow_up": emitFixtureTurn(command); break;
      case "abort": streaming = false; respond(command, true, {}); write({ type: "agent_end" }); break;
      case "extension_ui_response": case "reload": case "compact": respond(command, true, {}); break;
      default: respond(command, true, {}); break;
    }
  } catch (error) { respond(command, false, {}, error.message); }
});

process.on("SIGTERM", () => process.exit(0));
