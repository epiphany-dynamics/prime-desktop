const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('renderer/index.html');
const app = read('renderer/app.js');
const main = read('main.js');
const preload = read('preload.js');

test('composer exposes attachments and inline slash/@ references', () => {
  assert.match(html, /class="attach-btn"/);
  assert.match(html, /class="attachment-strip/);
  assert.match(html, /class="composer-popover/);
  assert.match(app, /type: 'get_commands'/);
  assert.match(app, /prime\.searchFiles/);
  assert.match(app, /<referenced_session/);
  assert.match(app, /cmd\.images = payload\.images/);
  assert.match(main, /dialog:pick-attachments/);
  assert.match(preload, /pickAttachments/);
});

test('workspace supports folder selection and drag-to-split sessions', () => {
  assert.match(html, /id="new-folder-chat-btn"/);
  assert.match(html, /class="picker-btn pane-folder"/);
  assert.match(main, /Open Folder….*CmdOrCtrl\+O/);
  assert.match(app, /application\/x-prime-session/);
  assert.match(app, /handlePaneDrop/);
  assert.match(app, /splitWithSession\(sessionPath\)/);
});

test('multi-view session events fan out to every matching pane', () => {
  assert.match(app, /for \(const pane of G\.panes\.filter\(\(p\) => p\.key === key\)\) pane\.handleEvent\(event\)/);
  assert.doesNotMatch(app, /const pane = G\.panes\.find\(\(p\) => p\.key === key\);\s*if \(pane\) pane\.handleEvent/);
});

test('schedules and heartbeat rows consume current RPC shapes', () => {
  assert.match(app, /schedule\.expression/);
  assert.match(app, /j\.status/);
  assert.match(app, /heartbeat\.job \|\| heartbeat/);
  assert.match(app, /jobId: h\.id/);
  assert.match(app, /job\.nextRunAt/);
});
