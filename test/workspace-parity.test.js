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

test('workspace supports folder selection and session drag without auto-split', () => {
  assert.match(html, /id="new-folder-chat-btn"/);
  assert.match(html, /class="picker-btn pane-folder"/);
  assert.match(main, /Open Project….*CmdOrCtrl\+O/);
  assert.match(app, /application\/x-prime-session/);
  assert.match(app, /handlePaneDrop/);
  // Drop opens in place via sidebar open — never invents a second pane.
  assert.match(app, /openSessionFromSidebar\(sessionPath\)/);
  assert.match(app, /Split button is the only/);
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

test('session and new-chat navigation always uses a single center pane', () => {
  // Hermes model: sidebar click / New Chat never auto-splits and never requires stop.
  assert.match(app, /async function openSessionFromSidebar/);
  assert.match(app, /HARD RULE: sidebar session click NEVER opens split view/);
  assert.match(app, /sidebar session click NEVER opens split view/);
  assert.match(app, /async function startNewChat/);
  assert.match(app, /async function collapseToPrimaryPane/);
  assert.match(app, /allowStreaming:\s*true/);
  assert.match(app, /allowStreamingLeave/);
  assert.doesNotMatch(app, /routeBindingAroundBusyPanes/);
  assert.doesNotMatch(app, /Both panes are streaming/);
  // Sidebar click always goes through openSessionFromSidebar — never setFocusedPane(paneHere).
  assert.match(app, /void openSessionFromSidebar\(s\.path\)/);
  assert.doesNotMatch(app, /if \(paneHere\) \{ setFocusedPane\(paneHere\)/);
  assert.match(app, /collapseToPrimaryPane\(\)/);
  assert.match(app, /id === 'new-chat'\) void startNewChat/);
  assert.match(app, /\$\('#new-chat-btn'\)\.onclick = \(\) => \{ void startNewChat\(\); \}/);
  // Split is explicit only.
  assert.match(app, /splitWithSession\(s\.path\)/);
  assert.match(app, /handlePaneDrop/);
  // Close split pane while streaming is allowed.
  assert.match(app, /closing this pane', \{ allowStreaming: true \}/);
  assert.match(main, /Closing a split pane is navigation/);
  assert.match(main, /allowStreamingLeave/);
});

test('chat stream sticks to latest output with standard release/re-stick', () => {
  assert.match(app, /this\.stickToBottom = true/);
  assert.match(app, /syncStickFromUserPosition\(/);
  assert.match(app, /_programmaticScroll/);
  assert.match(app, /scrollBottom\(forcePin = false, engageStick = false\)/);
  assert.match(app, /ensureScrollFollowObserver/);
  assert.match(app, /_keepScrollAnchorLast/);
  assert.match(app, /MutationObserver/);
  // Stream updates pin without re-arming stick (prevents snap-back while reading).
  assert.match(app, /scrollBottom\(true, false\)/);
  assert.match(app, /never re-arm stick mid-stream/i);
  assert.match(app, /scrollEl\.addEventListener\('scroll'/);
  assert.match(app, /addEventListener\('wheel'/);
  assert.match(app, /_pinScrollToEnd/);
  assert.doesNotMatch(app, /scrollIntoView\(/); // no scrollIntoView() calls; comment may mention the name
  assert.match(read('renderer/styles.css'), /\.chat-scroll \{[\s\S]*min-height: 0/);
  assert.match(read('renderer/styles.css'), /\.pane \{[\s\S]*min-height: 0/);
  assert.match(read('renderer/styles.css'), /\.chat-scroll-anchor/);
});

test('Split View is persistent, keyboard discoverable, blank-capable, and honest at two panes', () => {
  assert.match(html, /class="picker-btn pane-split"[^>]*aria-label="Split View"[^>]*>[^<]*Split View/);
  assert.match(app, /async function splitPane\(sessionPath = null, sourcePane = null\)/);
  assert.match(app, /sourcePaneId: !this\.paneId && sourcePane/);
  assert.match(main, /sourceContext = paneContextFor/);
  assert.match(app, /id === 'new-chat-split'.*splitPane\(null\)/);
  assert.match(main, /id: 'split-view'.*label: 'Split View'/s);
  assert.match(main, /id: 'new-chat-split'.*label: 'New Chat in Split'/s);
  assert.match(app, /Two panes maximum\. Close a pane before opening another\./);
  assert.match(app, /button\.disabled = atLimit/);
  assert.match(app, /item\.tabIndex = 0/);
  assert.match(read('renderer/styles.css'), /session-item:focus-within \.s-actions/);
  assert.match(read('renderer/styles.css'), /session-item\.active \.s-actions/);
});
