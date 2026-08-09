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
const attachment = read('lib/attachment-service.js');
const workspace = read('lib/workspace-service.js');

test('composer exposes pane-scoped attachments and inline slash/@ references', () => {
  assert.match(html, /class="attach-btn"/);
  assert.match(html, /class="attachment-strip/);
  assert.match(html, /class="composer-popover/);
  assert.match(app, /type: 'get_commands'/);
  assert.match(app, /prime\.searchWorkspace/);
  assert.match(app, /prime\.addSessionAttachment/);
  assert.match(attachment, /command\.images = images\.map/);
  assert.match(main, /secureHandle\('attachments:pick'/);
  assert.match(preload, /pickAttachments/);
});

test('workspace supports folder selection and drag-to-split sessions', () => {
  assert.match(html, /id="new-folder-chat-btn"/);
  assert.match(html, /class="picker-btn pane-folder"/);
  assert.match(main, /Open Project….*CmdOrCtrl\+O/);
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

test('async suggestion invalidation, Electron file paths, and bounded safe search are wired', () => {
  assert.match(app, /hideSuggestions\(\) \{\s*this\.suggestionRequest\+\+/s);
  assert.match(preload, /webUtils\.getPathForFile/);
  assert.match(workspace, /await fsp\.readdir/);
  assert.match(workspace, /isWithin\(this\.current\.root, real\)/);
  assert.match(workspace, /visited < 2_500/);
  assert.match(workspace, /Math\.min\(Number\(request\.limit\) \|\| 40, 100\)/);
  assert.doesNotMatch(workspace, /readdirSync/);
});
