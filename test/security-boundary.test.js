"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("main.js");
const preload = read("preload.js");
const html = read("renderer/index.html");

test("generic RPC cannot prompt, switch sessions, carry images, or mutate automation", () => {
  const allowlist = main.match(/const GENERIC_RPC_COMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(allowlist);
  for (const forbidden of ["prompt", "steer", "follow_up", "new_session", "switch_session", "delete_session", "add_schedule", "cancel_schedule", "manage_heartbeat", "bash", "read_file"]) {
    assert.doesNotMatch(allowlist[1], new RegExp(`['\"]${forbidden}['\"]`));
  }
  const genericHandler = main.slice(main.indexOf("secureHandle('rpc:command'"), main.indexOf("secureHandle('automation:command'"));
  assert.match(genericHandler, /GENERIC_RPC_COMMANDS\.has\(request\.cmd\.type\)/);
  assert.match(genericHandler, /hasOwnProperty\.call\(request\.cmd, 'images'\)/);
});

test("high-authority chat, workspace, attachment, config, skill, and automation paths use dedicated trusted IPC", () => {
  assert.match(main, /event\.senderFrame === event\.sender\.mainFrame/);
  for (const channel of [
    "chat:send", "workspace:pick", "workspace:activate", "attachments:pick", "attachments:drop",
    "attachments:paste-image", "automation:command", "config:write-settings", "config:set-api-key",
    "skills:read", "skills:toggle", "agent:kill-all",
  ]) assert.match(main, new RegExp(`secureHandle\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  assert.match(main, /assertSmallDto\(request/);
  assert.match(main, /AUTOMATION_RPC_COMMANDS\.has\(request\.cmd\.type\)/);
});

test("sandbox bridge exposes descriptors, not raw IPC or arbitrary filesystem authority", () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld\('prime'/);
  assert.doesNotMatch(preload, /ipcRenderer\s*:\s*ipcRenderer|rawIpc|sendChannel/);
  assert.doesNotMatch(preload, /sendSync|executeJavaScript|readFileSync|writeFileSync|child_process/);
  assert.match(preload, /webUtils\.getPathForFile/);
  assert.match(preload, /paths: filePaths\(files\)/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src 'self' data: blob:/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
});
