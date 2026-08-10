const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer/hud.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer/hud.js'), 'utf8');

test('HUD binds to an alive client from the focused window before global recency fallback', () => {
  const selector = main.match(/function selectHudClient\(key\) \{([\s\S]*?)\n\}/);
  assert.ok(selector, 'selectHudClient helper is present');
  assert.match(selector[1], /client\.alive/);
  assert.match(selector[1], /client\.viewers && client\.viewers\.has\(lastFocusedMainWin\)/);
  assert.match(selector[1], /sort\(\(a, b\) => b\.lastUsed - a\.lastUsed\)/);
  assert.match(main, /hudClient = selectHudClient\(null\)/);
});

test('HUD receives only bound-client assistant lifecycle and error events', () => {
  assert.match(main, /if \(!hudWin \|\| hudWin\.isDestroyed\(\) \|\| client !== hudClient\) return/);
  assert.match(main, /obj\.type === 'message_update'/);
  assert.match(main, /obj\.type === 'message_end'/);
  assert.match(main, /obj\.type === 'agent_end'/);
  assert.match(main, /assistantMessageEvent\.type === 'error'/);
  assert.match(preload, /onHudEvent: \(callback\) => on\('hud-event', callback\)/);
  assert.match(js, /prime\.onHudEvent/);
  assert.match(js, /assistantText\(event\.message\)/);
});

test('HUD keeps output visible and exposes stop and full-session actions', () => {
  assert.match(html, /id="output"[^>]*role="log"/);
  assert.match(html, /id="open-session"/);
  assert.match(html, /id="abort"/);
  assert.match(preload, /hudAbort: \(\) => ipcRenderer\.invoke\('hud:abort'\)/);
  assert.match(preload, /hudOpenSession: \(\) => ipcRenderer\.invoke\('hud:open-session'\)/);
  assert.match(main, /secureHandle\('hud:abort'/);
  assert.match(main, /secureHandle\('hud:open-session'/);

  const sendBody = js.match(/async function send\(\) \{([\s\S]*?)\n\}/);
  assert.ok(sendBody);
  assert.doesNotMatch(sendBody[1], /hudHide/);
});


test('HUD never falls back when an explicit bound session is dead', () => {
  assert.match(main, /if \(key\) \{\s*const explicit = clients\.get\(key\);\s*return explicit && explicit\.alive \? explicit : null;/s);
  assert.match(main, /const client = key \? selectHudClient\(key\)/);
});

test('RPC events fan out to every window viewing a client', () => {
  assert.match(main, /function sendToClientWindows/);
  assert.match(main, /sendToClientWindows\(client, 'rpc-event'/);
  assert.match(main, /refreshClientViewers\(client\)/);
  assert.match(main, /viewers\.add\(context\.ownerWin\)/);
});

test('HUD is discoverable when global shortcut registration fails and waits for renderer readiness', () => {
  const appHtml = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  assert.match(appHtml, /id="hud-btn"[^>]*>[^<]*Prime HUD/);
  assert.match(appJs, /\$\('#hud-btn'\)\.onclick = \(\) => prime\.toggleHud\(\)/);
  assert.match(main, /id: 'toggle-prime-hud'.*label: 'Show Prime HUD'/s);
  assert.match(main, /globalShortcut\.register/);
  assert.match(main, /globalShortcut\.isRegistered/);
  assert.match(main, /PRIME_HUD_SHORTCUT_UNAVAILABLE/);
  assert.match(main, /hudOpenPending = true/);
  const createHud = main.slice(main.indexOf('function createHud()'), main.indexOf('function selectHudClient'));
  assert.match(createHud, /frame: false/);
  assert.match(createHud, /alwaysOnTop: true/);
  assert.match(createHud, /show: false/);
  assert.match(main, /webContents\.once\('did-finish-load'/);
  assert.match(main, /candidate\.once\('ready-to-show'/);
  assert.match(preload, /toggleHud: \(\) => ipcRenderer\.invoke\('hud:toggle'\)/);
});

test('Dock activation counts main windows instead of the persistent hidden HUD', () => {
  const activation = main.match(/function activateMainWindow\(\) \{([\s\S]*?)\n\}/);
  assert.ok(activation);
  assert.match(activation[1], /\[\.\.\.wins\]/);
  assert.doesNotMatch(activation[1], /BrowserWindow\.getAllWindows/);
  assert.match(main, /app\.on\('activate', activateMainWindow\)/);
});
