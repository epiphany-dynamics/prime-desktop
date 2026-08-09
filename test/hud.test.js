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
