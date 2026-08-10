#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-desktop-ui-smoke-"));
const home = path.join(base, "isolated-home");
const project = path.join(base, "workspace-fixture");
const worktree = path.join(base, "worktree-fixture");
fs.mkdirSync(home); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "fixture.txt"), "workspace fixture\n");
fs.writeFileSync(path.join(project, "ignored.log"), "ignored\n");
fs.writeFileSync(path.join(project, ".gitignore"), "*.log\n");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const webp = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+MqfGVP+PIAAAA=", "base64");
const pickedImage = path.join(project, "picked.png");
fs.writeFileSync(pickedImage, png);
git(project, "init", "-q", "-b", "ui-smoke");
git(project, "config", "user.email", "ui-smoke@example.invalid");
git(project, "config", "user.name", "Prime UI Smoke");
git(project, "add", ".");
git(project, "commit", "-qm", "fixture");
git(project, "worktree", "add", "-q", "-b", "ui-smoke-linked", worktree);

const primeDir = path.join(home, ".prime", "agent");
fs.mkdirSync(primeDir, { recursive: true });
const secretSentinel = "UI_SMOKE_SECRET_MUST_NOT_RENDER";
fs.writeFileSync(path.join(primeDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1.invalid", apiKey: secretSentinel, models: [{ id: "offline-model" }] } } }));
const privateDir = path.join(home, ".ssh"); fs.mkdirSync(privateDir);
const privateFile = path.join(privateDir, "id_rsa"); fs.writeFileSync(privateFile, "PRIVATE_UI_SMOKE_SENTINEL\n");
const sessionsDir = path.join(primeDir, "sessions"); fs.mkdirSync(sessionsDir, { recursive: true });
const unsafeSession = path.join(sessionsDir, "unsafe-cwd.jsonl");
const deletableSession = path.join(sessionsDir, "inactive-delete.jsonl");
const routingSession = path.join(sessionsDir, "routing-target.jsonl");
const routingSessionTwo = path.join(sessionsDir, "routing-target-two.jsonl");
const unsafeCwd = fs.realpathSync("/usr");
fs.writeFileSync(unsafeSession, JSON.stringify({ type: "session", version: 1, id: "unsafe-cwd", cwd: unsafeCwd }) + "\n");
fs.writeFileSync(deletableSession, JSON.stringify({ type: "session", version: 1, id: "inactive-delete", cwd: project }) + "\n");
fs.writeFileSync(routingSession, [
  JSON.stringify({ type: "session", version: 1, id: "routing-target", cwd: project }),
  JSON.stringify({ type: "session_info", name: "Routing target" }),
  "",
].join("\n"));
fs.writeFileSync(routingSessionTwo, [
  JSON.stringify({ type: "session", version: 1, id: "routing-target-two", cwd: project }),
  JSON.stringify({ type: "session_info", name: "Routing target two" }),
  "",
].join("\n"));
const routingSessionCanonical = fs.realpathSync(routingSession);
const routingSessionTwoCanonical = fs.realpathSync(routingSessionTwo);

const waitSource = `(predicate, label, timeout = 12000) => new Promise((resolve, reject) => { const started = Date.now(); const tick = () => { let value = false; try { value = predicate(); } catch {} if (value) return resolve(value); if (Date.now() - started > timeout) return reject(new Error('Timed out: ' + label)); setTimeout(tick, 50); }; tick(); })`;
const evalSource = `(async () => {
  const wait = ${waitSource};
  try {
    await wait(() => window.prime && document.querySelector('.pane') && document.querySelector('.pane .pane-folder'), 'app boot');
  } catch (error) {
    throw new Error(error.message + ' [prime=' + !!window.prime + ', pane=' + !!document.querySelector('.pane') + ', body=' + document.body.textContent.slice(0, 120) + ']');
  }
  await wait(() => typeof G !== 'undefined' && G.focused && G.focused.ready, 'initial pane ready');
  const results = {};
  const key = (key, options = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  const paneEl = () => G.focused.el;
  const inPane = (selector) => paneEl().querySelector(selector);

  const initialPane = G.focused;
  results.persistentSplitControl = getComputedStyle(initialPane.splitBtn).display !== 'none' && initialPane.splitBtn.textContent.includes('Split View');
  const blankSplitOpened = await splitPane(null);
  await wait(() => G.panes.length === 2 && G.focused.ready, 'blank chat split');
  const blankPane = G.focused;
  const paneBounds = G.panes.map((pane) => pane.el.getBoundingClientRect());
  const initialWindowState = await window.prime.testWindowState();
  results.blankSplit = blankSplitOpened && blankPane.sessionFile !== initialPane.sessionFile;
  results.trueSingleWindowSplit = initialWindowState.mainWindowCount === 1 && initialWindowState.visibleMainWindowCount === 1 && paneBounds[0].width > 100 && paneBounds[1].width > 100 && paneBounds[0].right <= paneBounds[1].left + 1;
  results.twoPaneLimitVisible = G.panes.every((pane) => pane.splitBtn.disabled && pane.splitBtn.title.includes('Two panes maximum'));
  await closePane(blankPane);
  await wait(() => G.panes.length === 1 && G.focused === initialPane, 'close blank split');

  document.querySelector('#hud-btn').click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const hudWindowState = await window.prime.testWindowState();
  results.hudFallback = hudWindowState.hudVisible && hudWindowState.hudExists && hudWindowState.hudAlwaysOnTop && hudWindowState.menuHasHud && hudWindowState.menuHasSplit && hudWindowState.shortcutRegistered === false;
  await window.prime.toggleHud();

  key('o', { metaKey: true });
  await wait(() => !document.querySelector('#project-surface').classList.contains('hidden'), 'Cmd+O project surface');
  results.cmdO = true;
  document.querySelector('#choose-folder-btn').click();
  await wait(() => G.focused.workspace.selected && G.focused.workspace.name === 'workspace-fixture', 'project activation');
  results.project = inPane('.git-pill').textContent.includes('ui-smoke');
  results.projectPathVisible = inPane('.cwd-label').textContent.includes('workspace-fixture');
  const projectSourcePane = G.focused;
  const projectSplit = await splitPane(null);
  await wait(() => G.panes.length === 2 && G.focused.ready, 'project-inheriting blank split');
  const projectBlankPane = G.focused;
  results.blankSplitInheritsProject = projectSplit && projectBlankPane.workspace.selected && projectBlankPane.workspace.cwd === projectSourcePane.workspace.cwd;
  await closePane(projectBlankPane);
  await wait(() => G.panes.length === 1 && G.focused === projectSourcePane, 'close project blank split');

  document.querySelector('#tree-toggle').click();
  await wait(() => [...document.querySelectorAll('#tree-body .tree-row.file')].some((row) => row.textContent.includes('fixture.txt')), 'lazy file tree');
  results.tree = !document.querySelector('#tree-body').textContent.includes('ignored.log');
  const fileRow = [...document.querySelectorAll('#tree-body .tree-row.file')].find((row) => row.textContent.includes('fixture.txt'));
  fileRow.click();
  await wait(() => inPane('.attachment-strip').querySelectorAll('.attachment-chip.file').length === 1, 'tree file attachment');
  results.fileChip = true;

  const bytes = Uint8Array.from(atob('${png.toString("base64")}'), (char) => char.charCodeAt(0));
  const pastedFile = new File([bytes], 'pasted.png', { type: 'image/png' });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => pastedFile }] } });
  inPane('.input').dispatchEvent(paste);
  await wait(() => inPane('.attachment-strip').querySelectorAll('.attachment-chip.image').length === 1, 'pasted image thumbnail');
  results.pasteImage = !!inPane('.attachment-chip.image img');
  inPane('.attachment-chip.image .attachment-remove').click();
  await wait(() => inPane('.attachment-strip').querySelectorAll('.attachment-chip.image').length === 0, 'remove image');
  results.remove = true;

  const pasteFormat = async (base64, name, type) => {
    const formatBytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const file = new File([formatBytes], name, { type });
    const formatPaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(formatPaste, 'clipboardData', { value: { items: [{ kind: 'file', type, getAsFile: () => file }] } });
    inPane('.input').dispatchEvent(formatPaste);
    await wait(() => inPane('.attachment-strip').querySelectorAll('.attachment-chip.image').length === 1, name + ' normalize');
    const normalized = inPane('.attachment-chip.image').textContent.includes('image/png') && !!inPane('.attachment-chip.image img');
    inPane('.attachment-chip.image .attachment-remove').click();
    await wait(() => inPane('.attachment-strip').querySelectorAll('.attachment-chip.image').length === 0, name + ' remove');
    return normalized;
  };
  results.gifPaste = await pasteFormat('${gif.toString("base64")}', 'fixture.gif', 'image/gif');
  results.webpPaste = await pasteFormat('${webp.toString("base64")}', 'fixture.webp', 'image/webp');

  key('a', { metaKey: true, shiftKey: true });
  await wait(() => inPane('.attachment-strip').querySelectorAll('.attachment-chip.image').length === 1, 'Cmd+Shift+A picker');
  results.cmdShiftA = true;
  results.sensitivePickerDenied = !inPane('.attachment-error').classList.contains('hidden') && !document.documentElement.outerHTML.includes('PRIVATE_UI_SMOKE_SENTINEL');

  const retainedCount = inPane('.attachment-strip').querySelectorAll('.attachment-chip').length;
  inPane('.input').value = '__REJECT__';
  inPane('.send-btn').click();
  await wait(() => inPane('.pane-banner').textContent.includes('Prompt rejected'), 'prompt rejection');
  results.rejectedRetained = inPane('.input').value === '__REJECT__' && inPane('.attachment-strip').querySelectorAll('.attachment-chip').length === retainedCount;

  inPane('.input').value = '';
  inPane('.send-btn').click();
  await wait(() => inPane('.chat').querySelectorAll('.msg.user').length >= 1 && inPane('.attachment-strip').querySelectorAll('.attachment-chip').length === 0, 'attachment-only send');
  results.attachmentOnly = !!inPane('.chat .message-attachment');

  const first = G.focused;
  const firstKey = first.key;
  const firstSession = first.sessionFile;
  inPane('.input').value = '__HOLD__';
  inPane('.input').dispatchEvent(new Event('input', { bubbles: true }));
  inPane('.send-btn').click();
  await wait(() => first.isStreaming && !inPane('.stop-btn').classList.contains('hidden'), 'streaming response');
  const streamingKey = first.key;
  key('o', { metaKey: true });
  await wait(() => !document.querySelector('#project-surface').classList.contains('hidden'), 'streaming project surface');
  document.querySelector('#choose-folder-btn').click();
  await wait(() => document.querySelector('#project-choice-error').textContent.includes('Stop the current response'), 'streaming project rejection');
  results.streamingBlocked = first.key === streamingKey && !document.querySelector('#choose-folder-btn').disabled;
  key('Escape');
  await wait(() => document.querySelector('#project-surface').classList.contains('hidden'), 'Escape closes project surface');
  results.escape = document.activeElement === inPane('.input') || document.activeElement === inPane('.pane-folder');

  const routeItem = [...document.querySelectorAll('.session-item')].find((item) => item.querySelector('.s-name') && item.querySelector('.s-name').textContent.trim() === 'Routing target');
  if (!routeItem) throw new Error('Routing target session was not rendered');
  results.daemonDiscovered = routeItem.querySelector('.s-meta').textContent.includes('terminal live') && !!routeItem.querySelector('.live-dot.resident');
  routeItem.focus();
  results.sessionSplitDiscoverable = getComputedStyle(routeItem.querySelector('.s-actions')).display === 'flex' && routeItem.querySelector('.s-split').textContent.includes('Split');
  routeItem.click();
  await wait(() => G.panes.length === 2 && G.focused !== first && G.focused.ready && G.focused.sessionFile === ${JSON.stringify(routingSessionCanonical)}, 'normal-click streaming session route');
  const second = G.focused;
  results.streamingSessionRouted = first.isStreaming && first.key === firstKey && second.sessionFile === ${JSON.stringify(routingSessionCanonical)} && !first.bannerEl.textContent.includes('Stop the current response before changing sessions');
  const daemonClients = await window.prime.listClients();
  second.inputEl.value = '__DAEMON_HOLD__';
  second.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  await second.send();
  await wait(() => second.isStreaming && second.chatEl.textContent.includes('daemon attachment live stream'), 'resident daemon live stream');
  results.daemonAttachment = daemonClients.some((client) => client.key === second.key && client.transport === 'daemon-attachment') && first.isStreaming;
  await second.stop();
  await wait(() => !second.isStreaming && first.isStreaming, 'resident daemon abort without terminal stop');
  setFocusedPane(first);
  const alreadyOpenItem = [...document.querySelectorAll('.session-item')].find((item) => item.querySelector('.s-name') && item.querySelector('.s-name').textContent.trim() === 'Routing target');
  alreadyOpenItem.click();
  results.existingSessionFocused = G.focused === second && G.panes.length === 2 && first.isStreaming;
  setFocusedPane(first);
  const routeItemTwo = [...document.querySelectorAll('.session-item')].find((item) => item.querySelector('.s-name') && item.querySelector('.s-name').textContent.trim() === 'Routing target two');
  if (!routeItemTwo) throw new Error('Second routing target session was not rendered');
  routeItemTwo.click();
  await wait(() => G.focused === second && second.ready && second.sessionFile === ${JSON.stringify(routingSessionTwoCanonical)}, 'two-pane non-streaming route');
  results.twoPaneSessionRouted = first.isStreaming && first.key === firstKey && G.panes.length === 2 && second.sessionFile === ${JSON.stringify(routingSessionTwoCanonical)};
  const sessionsAfterDaemonDetach = await window.prime.listSessions();
  const detachedResident = sessionsAfterDaemonDetach.find((session) => session.path === ${JSON.stringify(routingSessionCanonical)});
  results.daemonDetachNotStop = !!(detachedResident && detachedResident.daemonResident && detachedResident.daemonAttachedClients === 1);
  await first.stop();
  await wait(() => !first.isStreaming, 'stop routed source response');
  await second.activate(firstSession);
  await wait(() => second.ready && second.key === first.key && second.sessionFile === firstSession, 'share first session after routing proof');
  first.inputEl.value = '__HOLD__';
  first.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  await first.send();
  await wait(() => first.isStreaming && second.isStreaming, 'same-session event fan-out');
  setFocusedPane(first);
  const bothStreamingRoute = await openSessionFromSidebar(${JSON.stringify(routingSessionCanonical)});
  results.bothStreamingRouteBounded = bothStreamingRoute === false && first.isStreaming && second.isStreaming && first.bannerEl.textContent.includes('Both panes are streaming');
  const deleteWhileStreaming = await window.prime.deleteSession(firstSession);
  const restartWhileStreaming = await restartAllAgents();
  results.busyLifecycleRejected = deleteWhileStreaming.ok === false && restartWhileStreaming === false && first.isStreaming && second.isStreaming;
  await second.stop();
  await wait(() => !first.isStreaming && !second.isStreaming, 'same-session abort fan-out');
  results.sameSessionFanoutAbort = first.key === second.key;

  const sharedSearch = await window.prime.searchWorkspace(first.key, first.paneId, first.bindingEpoch, {
    workspaceId: first.workspace.workspaceId, generation: first.workspace.generation, query: 'fixture.txt', limit: 10,
  });
  const sharedFile = (sharedSearch.entries || []).find((entry) => entry.name === 'fixture.txt');
  const pendingAttachment = first.addTreeAttachment(sharedFile.nodeId);
  const deleteWhileAttaching = await window.prime.deleteSession(firstSession);
  await pendingAttachment;
  const deleteWhileShared = await window.prime.deleteSession(firstSession);
  results.sharedDeleteRejected = deleteWhileAttaching.ok === false && deleteWhileShared.ok === false && first.key === firstSession && second.key === firstSession && first.draftState.items.some((item) => item.name === 'fixture.txt');

  const residentDelete = await window.prime.deleteSession(${JSON.stringify(routingSessionCanonical)});
  results.residentDeleteRejected = residentDelete.ok === false && residentDelete.error.includes('active in Prime Agent');
  const inactiveDeleted = await window.prime.deleteSession('${deletableSession}');
  const sessionsAfterDelete = await window.prime.listSessions();
  const secondKeyBeforeDeletedReopen = second.key;
  const deletedReopen = await second.activate('${deletableSession}');
  results.inactiveDeleteLifecycle = inactiveDeleted.ok === true && !sessionsAfterDelete.some((session) => session.path === '${deletableSession}') && deletedReopen === false && second.key === secondKeyBeforeDeletedReopen;
  const hudPrompt = await window.prime.hudPrompt({ key: first.key, text: '__HOLD__' });
  await wait(() => first.isStreaming && second.isStreaming, 'HUD prompt fan-out');
  const hudAbort = await window.prime.hudAbort();
  await wait(() => !first.isStreaming && !second.isStreaming, 'HUD abort fan-out');
  results.hudSharedClient = hudPrompt.ok === true && hudAbort.ok === true;
  const automation = await window.prime.automationCommand(second.key, { type: 'list_schedules', includeInactive: true });
  const genericAutomation = await window.prime.command(second.key, { type: 'list_schedules', includeInactive: true });
  results.automationRoute = automation.success === true && genericAutomation.success === false;

  await openProjectSurface(second);
  await wait(() => [...document.querySelectorAll('#project-choice-list .project-choice')].some((button) => button.textContent.includes('worktree-fixture') || button.textContent.includes('ui-smoke-linked')), 'worktree choice');
  const worktreeChoice = [...document.querySelectorAll('#project-choice-list .project-choice')].find((button) => button.textContent.includes('worktree-fixture') || button.textContent.includes('ui-smoke-linked'));
  worktreeChoice.click();
  await wait(() => second.workspace.cwd && second.workspace.cwd.includes('worktree-fixture'), 'worktree activation');
  results.multiPaneSafe = first.key === firstKey && first.workspace.cwd.includes('workspace-fixture') && second.key !== first.key && second.workspace.cwd.includes('worktree-fixture');

  const synthetic = new File(['outside'], 'outside.txt', { type: 'text/plain' });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [synthetic], types: ['Files'], getData: () => '' } });
  second.inputEl.dispatchEvent(drop);
  await wait(() => !second.attachmentError.classList.contains('hidden'), 'invalid synthetic drop rejected');
  results.syntheticDropRejected = second.draftState.items.length === 0;

  const config = await window.prime.readConfig();
  results.redacted = !JSON.stringify(config).includes('${secretSentinel}') && config.modelsJson.providers.fixture.hasApiKey === true;
  openCustomForm('fixture', config.modelsJson.providers.fixture, false);
  document.querySelector('#cf-baseurl').value = 'http://127.0.0.1.invalid/edited';
  document.querySelector('#cf-save').click();
  await wait(() => document.querySelector('#custom-form').classList.contains('hidden'), 'redacted provider edit');
  const editedConfig = await window.prime.readConfig();
  results.providerSecretPreserved = editedConfig.modelsJson.providers.fixture.hasApiKey === true && editedConfig.modelsJson.providers.fixture.baseUrl.endsWith('/edited');
  window.open('https://example.invalid/window-smoke');
  const link = document.createElement('a'); link.href = 'https://example.invalid/navigation-smoke'; link.textContent = 'navigation test'; document.body.appendChild(link); link.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const security = await window.prime.getSecurityEvents();
  results.navigationDenied = security.events.some((event) => event.type === 'window-open-denied') && security.events.some((event) => event.type === 'navigation-denied');

  second.inputEl.value = 'retain on failed activation';
  const failedActivation = await second.activate('${path.join(base, "missing-session.jsonl")}');
  const retainedOnFailure = failedActivation === false && second.inputEl.value === 'retain on failed activation';
  second.inputEl.value = 'clear on successful activation';
  const unsafeActivation = second.activate('${unsafeSession}');
  const bindingControlsLocked = second.sendBtn.disabled && second.attachBtn.disabled && !second.inputEl.disabled;
  const concurrentActivation = await second.activate(firstSession);
  const unsafeOpened = await unsafeActivation;
  const clients = await window.prime.listClients();
  const unsafeClient = clients.find((client) => client.key === second.key);
  results.savedUnsafeCwdDegrades = unsafeOpened === true && !second.workspace.selected && second.bannerEl.textContent.includes('saved project is unavailable') && unsafeClient && unsafeClient.cwd === '${unsafeCwd}';
  results.activationTextLifecycle = retainedOnFailure && second.inputEl.value === '';
  results.concurrentActivationGuard = concurrentActivation === false && bindingControlsLocked;
  first.inputEl.value = 'UNSENT RESTART DRAFT';
  first.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  const restartDraftBefore = { id: first.draftState.id, sessionFile: first.sessionFile, items: first.draftState.items.map((item) => item.name) };
  const restarted = await restartAllAgents();
  const restartedClients = await window.prime.listClients();
  results.restartRecovery = restarted === true && G.panes.every((pane) => pane.ready && pane.key && pane.bindingEpoch && restartedClients.some((client) => client.key === pane.key && client.alive));
  results.restartDraftPreserved = first.sessionFile === restartDraftBefore.sessionFile && first.draftState.id === restartDraftBefore.id && first.inputEl.value === 'UNSENT RESTART DRAFT' && JSON.stringify(first.draftState.items.map((item) => item.name)) === JSON.stringify(restartDraftBefore.items);
  const crashDraftBefore = { id: first.draftState.id, epoch: first.bindingEpoch, text: first.inputEl.value, items: first.draftState.items.map((item) => item.name) };
  await window.prime.command(first.key, { type: 'get_state', testCrash: true });
  await wait(() => first.bannerEl.textContent.includes('Click to restart'), 'synthetic crash banner');
  first.bannerEl.click();
  await wait(() => first.ready && first.bindingEpoch !== crashDraftBefore.epoch, 'synthetic crash recovery');
  results.crashDraftPreserved = first.draftState.id === crashDraftBefore.id && first.inputEl.value === crashDraftBefore.text && JSON.stringify(first.draftState.items.map((item) => item.name)) === JSON.stringify(crashDraftBefore.items);
  results.noRealHome = !document.documentElement.outerHTML.includes('${os.homedir().replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');
  results.sandboxSurface = typeof window.require === 'undefined' && typeof window.process === 'undefined';
  results.controls = !!document.querySelector('.attach-btn') && !!document.querySelector('.pane-folder') && !!document.querySelector('#tree-toggle');
  if (!Object.values(results).every(Boolean)) throw new Error('UI assertions failed: ' + JSON.stringify(results));
  return results;
})()`;

const electron = require("electron");
const safeEnv = {
  PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  USER: "prime-desktop-ui-smoke",
  LOGNAME: "prime-desktop-ui-smoke",
  SHELL: "/bin/zsh",
  TMPDIR: process.env.TMPDIR || os.tmpdir(),
  LANG: process.env.LANG || "en_US.UTF-8",
  PRIME_DESKTOP_TEST_MODE: "1",
  PRIME_DESKTOP_TEST_HOME: home,
  PRIME_DESKTOP_TEST_PROJECT: project,
  PRIME_DESKTOP_TEST_ATTACH_PATHS: JSON.stringify([path.join(project, "fixture.txt"), pickedImage, privateFile]),
  PRIME_DESKTOP_AGENT_SCRIPT: path.join(__dirname, "fake-agent.js"),
  PRIME_DESKTOP_AGENT_MODULE: path.join(__dirname, "fake-daemon-module.mjs"),
  PRIME_DESKTOP_FAKE_DAEMON_SESSIONS: JSON.stringify([routingSession, routingSessionTwo]),
  PRIME_DESKTOP_EVAL: evalSource,
  PRIME_DESKTOP_EVAL_DELAY: "600",
  PRIME_DESKTOP_QUIT_AFTER_EVAL: "1",
  PRIME_DESKTOP_TEST_SHORTCUT_FAILURE: "1",
  PRIME_DESKTOP_TEST_SHOW_WINDOWS: "1",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};
if (process.env.PRIME_DESKTOP_UI_SMOKE_CAPTURE) safeEnv.PRIME_DESKTOP_CAPTURE = path.resolve(process.env.PRIME_DESKTOP_UI_SMOKE_CAPTURE);

const child = spawn(electron, [path.join(__dirname, "..")], { cwd: path.join(__dirname, ".."), env: safeEnv, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 60_000);
child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  try {
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("EVAL_RESULT "));
    if (code !== 0 || !line) throw new Error(`Electron UI smoke failed (code ${code}, signal ${signal || "none"})${stderr ? `: ${stderr.slice(-2000)}` : ""}`);
    const result = JSON.parse(line.slice("EVAL_RESULT ".length));
    const storedProvider = JSON.parse(fs.readFileSync(path.join(primeDir, "models.json"), "utf8")).providers.fixture;
    if (storedProvider.apiKey !== secretSentinel) throw new Error("Redacted provider edit did not preserve the exact stored key");
    console.log("UI-SMOKE project/worktree + multi-pane: PASS");
    console.log("UI-SMOKE lazy tree + file chip: PASS");
    console.log("UI-SMOKE PNG/GIF/WebP paste + picker/reject/attachment-only: PASS");
    console.log("UI-SMOKE streaming session routing + project guard + same-session/HUD fan-out: PASS");
    console.log("UI-SMOKE shared/busy/inactive session deletion lifecycle: PASS");
    console.log("UI-SMOKE redacted provider edit preserves exact stored key: PASS");
    console.log("UI-SMOKE synthetic pathless drop rejection (real outside-drop policy is unit-tested): PASS");
    console.log("UI-SMOKE saved unsafe cwd degrade + activation/restart/crash draft lifecycle: PASS");
    console.log("UI-SMOKE navigation/sandbox/redaction: PASS");
    console.log("UI-SMOKE OK", JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    if (stdout) console.error(stdout.slice(-3000));
    process.exitCode = 1;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
