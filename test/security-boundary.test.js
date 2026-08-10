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
  const pasteGuard = preload.slice(preload.indexOf("const MAX_PASTE_IMAGE_BYTES"), preload.indexOf("contextBridge.exposeInMainWorld"));
  assert.match(pasteGuard, /MAX_PASTE_IMAGE_BYTES = 20_000_000/);
  assert.match(pasteGuard, /bytes instanceof ArrayBuffer \|\| ArrayBuffer\.isView\(bytes\)/);
  assert.match(pasteGuard, /byteLength < 1 \|\| byteLength > MAX_PASTE_IMAGE_BYTES/);
  assert.match(pasteGuard, /name\.length > 255/);
  assert.ok(pasteGuard.indexOf("byteLength > MAX_PASTE_IMAGE_BYTES") < pasteGuard.indexOf("ipcRenderer.invoke('attachments:paste-image'"));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src 'self' data: blob:/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
});


test("pane-scoped authority requires exact binding epochs and serializes lifecycle transitions", () => {
  const paneGuard = main.slice(main.indexOf("function paneContextFor"), main.indexOf("function bindingMeta"));
  assert.match(paneGuard, /typeof request\.key !== 'string'/);
  assert.match(paneGuard, /typeof request\.bindingEpoch !== 'string'/);
  assert.match(paneGuard, /!request\.bindingEpoch/);
  assert.match(paneGuard, /context\.bindingEpoch !== request\.bindingEpoch/);
  const activation = main.slice(main.indexOf("secureHandle('rpc:activate'"), main.indexOf("secureHandle('rpc:list-clients'"));
  const release = main.slice(main.indexOf("secureHandle('pane:release'"), main.indexOf("\/\/ ---------- Empty-session cleanup"));
  assert.match(activation, /runPaneTransition/);
  assert.match(activation, /failed session activation rollback/);
  assert.match(release, /runPaneTransition/);
  assert.match(main, /if \(context\.sending\) throw new Error\('Wait for the current message before adding attachments'\)/);
  assert.match(main, /if \(context\.pendingActions > 0\) throw new AttachmentError\('ATTACHMENTS_PENDING'/);
  assert.doesNotMatch(preload, /rpc-flush-wait|rpcFlushWait/);
});


test("session deletion is serialized and the renderer honors failed deletes", () => {
  const deletion = main.slice(main.indexOf("secureHandle('sessions:delete'"), main.indexOf("secureHandle('sessions:tail'"));
  assert.match(deletion, /runPaneTransition/);
  assert.match(deletion, /sessionLifecycle\.run\(canonical/);
  assert.match(deletion, /assertPaneLocallyIdle/);
  assert.match(deletion, /attached\.length/);
  const renderer = read("renderer/app.js");
  const deleteUi = renderer.slice(renderer.indexOf("item.querySelector('.s-delete')"), renderer.indexOf("return item", renderer.indexOf("item.querySelector('.s-delete')")));
  assert.match(deleteUi, /if \(!deleted\.ok\)/);
  assert.ok(deleteUi.indexOf("if (!deleted.ok)") < deleteUi.indexOf("G.pinnedPaths.delete"));
});


test("draft-preserving restarts lock pane authority and reuse same-session drafts", () => {
  const restart = main.slice(main.indexOf("secureHandle('agent:kill-all'"), main.indexOf("// ---------- Config files"));
  assert.match(restart, /runPaneTransition/);
  assert.match(restart, /context\.lifecycleLocked = true/);
  assert.match(restart, /reservePaneAction/);
  assert.match(main, /rebindDraftWorkspace/);
  const renderer = read("renderer/app.js");
  assert.match(renderer, /response\.preservedDraft/);
  assert.match(renderer, /prime\.killAllAgents\(\{ preserveDrafts: true \}\)/);
});

test('resident daemon sessions attach non-owningly and never pass through destructive handoff', () => {
  const adapter = fs.readFileSync(path.join(root, 'lib/daemon-rpc-adapter.js'), 'utf8');
  assert.match(main, /new DaemonRpcAdapter\(\{ socketPath: DAEMON_LAUNCH\.socketPath, sessionPath, moduleEntry \}\)/);
  assert.match(main, /error instanceof NoResidentSessionError/);
  assert.match(main, /client\.transport = 'rpc-process'/);
  assert.doesNotMatch(main, /prepareSessionHandoff|prepareTargetSession/);
  assert.match(adapter, /includeClientOwned: true/);
  assert.match(adapter, /sendClientEnv: false/);
  assert.match(adapter, /ownedSession: false/);
  assert.match(adapter, /await connection\.dispose\(\)/);
  assert.match(main, /releaseUnreferencedDaemonClient/);
  assert.match(main, /clientHasPaneConsumer/);
  assert.match(main, /last desktop pane released/);
  assert.match(main, /client && client\.transport === 'daemon-attachment'/);
  assert.match(main, /resident\.attachedClients <= 1/);
  assert.match(main, /const stillResident = moduleEntry && await discoverResidentSession/);
  assert.match(main, /This session is active in Prime Agent\. Stop it there before deleting it\./);
});


test("app quit detaches clients without killing agent workers", () => {
  const main = require("fs").readFileSync(require("path").join(__dirname, "..", "main.js"), "utf8");
  const rpc = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "rpc-manager.js"), "utf8");
  assert.match(main, /disposeClient\(client, 'app-quit'/);
  assert.match(main, /detachOnly/);
  assert.doesNotMatch(main, /disposeClient\(client, 'shutdown'\)/);
  assert.match(rpc, /killProcess/);
  assert.match(rpc, /reason !== "app-quit"/);
});
