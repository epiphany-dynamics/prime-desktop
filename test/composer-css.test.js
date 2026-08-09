const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer/styles.css'), 'utf8');

test('pane composer controls use class-based production styles', () => {
  assert.match(html, /<textarea class="input"/);
  assert.match(css, /\.composer \.input\s*\{/);
  assert.match(css, /\.composer \.input::placeholder\s*\{/);
  assert.match(css, /\.composer\s*\{/);
  assert.match(css, /\.queue-hint\s*\{/);
  assert.match(css, /\.composer \.attach-btn, \.composer \.send-btn, \.composer \.stop-btn\s*\{/);
  assert.match(css, /\.composer \.send-btn:hover\s*\{/);
  assert.match(css, /\.composer \.send-btn:disabled\s*\{/);
  assert.match(css, /\.composer \.stop-btn:hover\s*\{/);
  assert.doesNotMatch(css, /#(?:composer|queue-hint|input|send-btn|stop-btn)/);
});

test('composer textarea fills the prompt row without native white chrome', () => {
  const rule = css.match(/\.composer \.input\s*\{([^}]*)\}/s);
  assert.ok(rule);
  assert.match(rule[1], /flex:\s*1/);
  assert.match(rule[1], /width:\s*100%/);
  assert.match(rule[1], /background:\s*transparent/);
  assert.match(rule[1], /border:\s*0/);
  assert.match(rule[1], /appearance:\s*none/);
});
