// Prime Desktop - Electron main process
// Multi-session architecture: one `prime-agent --mode rpc` process per live session,
// routed per window/pane. Hermes-style isolated sessions with per-session cwd/git context.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, globalShortcut } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { primeDaemonLaunchConfig } = require('./daemon-launch');
const { prepareSessionHandoff } = require('./session-handoff');

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.prime', 'agent', 'sessions');
const COMMAND_TIMEOUT_MS = 30000;
const SWITCH_SESSION_TIMEOUT_MS = 90000;
const MAX_CLIENTS = 8;
const DAEMON_LAUNCH = primeDaemonLaunchConfig();

// ---------- Agent binary resolution ----------

function loginShellPath() {
  try { return execSync('/bin/zsh -lic \'echo $PATH\'', { timeout: 4000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function buildChildEnv() {
  const env = { ...process.env };
  const extra = [
    path.join(HOME, '.hermes', 'node', 'bin'),
    path.join(HOME, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const current = (env.PATH && env.PATH.length > 10 ? env.PATH : loginShellPath()) || '/usr/bin:/bin:/usr/sbin:/sbin';
  env.PATH = [...extra, ...current.split(':')].filter(Boolean).join(':');
  if (!env.SHELL) env.SHELL = '/bin/zsh';
  // Finder/Electron can expose /tmp while terminal clients use macOS's
  // DARWIN_USER_TEMP_DIR. Normalize it so every client reaches one daemon.
  env.TMPDIR = DAEMON_LAUNCH.tempDir;
  return env;
}

function findNode(childEnv) {
  const candidates = [
    path.join(HOME, '.hermes', 'node', 'bin', 'node'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return execSync('which node', { env: childEnv, encoding: 'utf8' }).trim(); }
  catch { return 'node'; }
}

function resolveAgentInvocation(childEnv) {
  const binCandidates = [
    path.join(HOME, '.local', 'bin', 'prime-agent'),
    path.join(HOME, '.local', 'lib', 'node_modules', 'prime-agent', 'dist', 'bundle', 'cli.js'),
    path.join(HOME, '.hermes', 'node', 'bin', 'prime-agent'),
    '/usr/local/bin/prime-agent',
    '/opt/homebrew/bin/prime-agent',
  ];
  let found = null;
  for (const c of binCandidates) if (fs.existsSync(c)) { found = c; break; }
  if (!found) {
    try { found = execSync('which prime-agent', { env: childEnv, encoding: 'utf8' }).trim(); }
    catch { found = null; }
  }
  if (!found) return null;
  const node = findNode(childEnv);
  try {
    const real = fs.realpathSync(found);
    if (/\.(js|mjs|cjs)$/.test(real)) return { command: node, args: [real], display: real };
  } catch {}
  return { command: found, args: [], display: found };
}

// ---------- Multi-client RPC manager ----------
// clients: Map<key, client>. key = session file path (or 'new:<n>' before known).
// A client owns one prime-agent RPC process bound to one session.

const clients = new Map();
let requestSeq = 0;
let tempSeq = 0;
const createdSessionFiles = new Set();

function sendToWindow(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) sendToWindow(win, channel, payload);
}

function spawnClient({ sessionPath, cwd, ownerWin }) {
  const childEnv = buildChildEnv();
  const invocation = resolveAgentInvocation(childEnv);
  const key = sessionPath || ('new:' + (++tempSeq));
  if (!invocation) {
    sendToWindow(ownerWin, 'rpc-error', { key, message: 'prime-agent binary not found.' });
    return null;
  }
  const args = [...invocation.args, '--mode', 'rpc', '--daemon-socket', DAEMON_LAUNCH.socketPath];
  if (sessionPath) args.push('--resume', sessionPath);
  let proc;
  try {
    proc = spawn(invocation.command, args, { cwd: cwd || HOME, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    sendToWindow(ownerWin, 'rpc-error', { key, message: 'Failed to spawn prime-agent: ' + String(err) });
    return null;
  }
  const client = {
    key, proc, pending: new Map(), buffer: '', alive: true,
    sessionFile: sessionPath || null, cwd: cwd || HOME,
    ownerWin, streaming: false, lastUsed: Date.now(), autoCreated: !sessionPath,
  };
  clients.set(key, client);

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    client.buffer += chunk;
    let idx;
    while ((idx = client.buffer.indexOf('\n')) !== -1) {
      let line = client.buffer.slice(0, idx);
      client.buffer = client.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      handleClientMessage(client, obj);
    }
  });
  proc.stderr.on('data', (d) => sendToWindow(client.ownerWin, 'rpc-stderr', { key: client.key, text: d.toString() }));
  const onDead = (code, errMsg) => {
    client.alive = false;
    for (const { reject, timer } of client.pending.values()) {
      clearTimeout(timer);
      reject(new Error(errMsg || ('RPC process exited (' + code + ')')));
    }
    client.pending.clear();
    sendToWindow(client.ownerWin, 'rpc-exit', { key: client.key, code: code == null ? -1 : code, error: errMsg || null });
  };
  proc.on('exit', (code) => onDead(code, null));
  proc.on('error', (err) => onDead(null, 'Failed to start prime-agent: ' + String(err)));

  // Learn the session file (new sessions get one assigned at spawn)
  if (!sessionPath) {
    (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const r = await clientCommand(client, { type: 'get_state' });
          if (r.success && r.data.sessionFile) {
            client.sessionFile = r.data.sessionFile;
            createdSessionFiles.add(r.data.sessionFile);
            if (client.key !== client.sessionFile) {
              clients.delete(key);
              client.key = client.sessionFile;
              clients.set(client.key, client);
              sendToWindow(client.ownerWin, 'rpc-key-mapped', { oldKey: key, key: client.key });
            }
            break;
          }
        } catch {}
        await new Promise((r2) => setTimeout(r2, 250));
      }
    })();
  } else {
    createdSessionFiles.add(sessionPath);
  }
  evictIdleClients();
  return client;
}

function evictIdleClients() {
  if (clients.size <= MAX_CLIENTS) return;
  const idle = [...clients.values()].filter((c) => !c.streaming).sort((a, b) => a.lastUsed - b.lastUsed);
  while (clients.size > MAX_CLIENTS && idle.length) {
    const c = idle.shift();
    clients.delete(c.key);
    try { c.proc.kill(); } catch {}
  }
}

function handleClientMessage(client, obj) {
  if (obj.type === 'response' && obj.id && client.pending.has(obj.id)) {
    const { resolve, timer } = client.pending.get(obj.id);
    clearTimeout(timer);
    client.pending.delete(obj.id);
    resolve(obj);
    return;
  }
  if (obj.type === 'agent_start') client.streaming = true;
  if (obj.type === 'agent_end') client.streaming = false;
  if (obj.type === 'response' && obj.command === 'new_session' && obj.success) {
    clientCommand(client, { type: 'get_state' }).then((r) => {
      if (r.success && r.data.sessionFile) createdSessionFiles.add(r.data.sessionFile);
    }).catch(() => {});
  }
  sendToWindow(client.ownerWin, 'rpc-event', { key: client.key, event: obj });
}

function clientCommand(client, cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!client || !client.alive) return reject(new Error('Agent process is not running'));
    const id = 'req-' + (++requestSeq);
    cmd.id = id;
    const timer = setTimeout(() => {
      if (client.pending.has(id)) {
        client.pending.delete(id);
        reject(new Error('Command timed out: ' + (cmd.type || 'unknown')));
      }
    }, timeoutMs || COMMAND_TIMEOUT_MS);
    client.pending.set(id, { resolve, reject, timer });
    try { client.proc.stdin.write(JSON.stringify(cmd) + '\n'); }
    catch (e) { clearTimeout(timer); client.pending.delete(id); reject(e); }
  });
}

function getClient(key) {
  const c = clients.get(key);
  if (c) c.lastUsed = Date.now();
  return c;
}

// Ensure a client exists for a session; spawn with --resume if needed.
function ensureClient({ key, sessionPath, cwd, ownerWin }) {
  const existing = getClient(key) || (sessionPath && getClient(sessionPath));
  if (existing && existing.alive) return existing;
  return spawnClient({ sessionPath: sessionPath || (key && key.startsWith('/') ? key : null), cwd, ownerWin });
}

function runAgentCliJson(args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const childEnv = buildChildEnv();
    const invocation = resolveAgentInvocation(childEnv);
    if (!invocation) return reject(new Error('prime-agent binary not found'));
    let stdout = '', stderr = '', settled = false;
    const proc = spawn(invocation.command, [
      ...invocation.args,
      args[0],
      '--daemon-socket', DAEMON_LAUNCH.socketPath,
      ...args.slice(1),
    ], { cwd: HOME, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      reject(new Error(`prime-agent ${args[0]} timed out`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `prime-agent ${args[0]} exited with code ${code}`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); }
      catch { reject(new Error(`prime-agent ${args[0]} returned invalid JSON`)); }
    });
  });
}

async function prepareTargetSession(sessionPath) {
  return prepareSessionHandoff(sessionPath, {
    list: async () => (await runAgentCliJson(['list', '--json'])).sessions || [],
    stop: async (activeSessionId) => { await runAgentCliJson(['stop', activeSessionId, '--json']); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: 5000,
  });
}

// Upstream quirk guard: new-session files flush a few seconds after the first
// prompt; switching away before the flush orphans the session. Wait for it.
async function waitForSessionPersisted(filePath, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes('"type":"message"')) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

ipcMain.handle('rpc:command', async (e, { key, cmd }) => {
  try {
    const client = getClient(key);
    if (!client) throw new Error('No agent for this pane (key ' + key + ')');
    if (cmd.type === 'switch_session' && cmd.sessionPath) {
      try {
        const prep = await prepareTargetSession(cmd.sessionPath);
        if (!prep.ok) throw new Error(prep.error);
      } catch (err) {
        if (err && err.message) return { type: 'response', success: false, error: err.message };
      }
    }
    if (cmd.type === 'switch_session' || cmd.type === 'new_session') {
      try {
        const st = await clientCommand(client, { type: 'get_state' });
        if (st.success && st.data.isStreaming && st.data.sessionFile) {
          sendToWindow(client.ownerWin, 'rpc-flush-wait', { key: client.key, sessionFile: st.data.sessionFile });
          await waitForSessionPersisted(st.data.sessionFile);
        }
      } catch {}
    }
    const timeout = cmd.type === 'switch_session' ? SWITCH_SESSION_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    return await clientCommand(client, cmd, timeout);
  } catch (err) { return { type: 'response', success: false, error: String(err && err.message || err) }; }
});

// Activate a session for a pane: returns client key after ensuring the process exists.
ipcMain.handle('rpc:activate', async (e, { sessionPath, cwd }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (sessionPath && !clients.has(sessionPath)) {
    try {
      const prep = await prepareTargetSession(sessionPath);
      if (!prep.ok) return { ok: false, error: prep.error };
    } catch {}
  }
  const client = ensureClient({ sessionPath, cwd, ownerWin: win });
  if (!client) return { ok: false, error: 'failed to spawn agent' };
  client.ownerWin = win;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await clientCommand(client, { type: 'get_state' });
      if (r.success) return { ok: true, key: client.key, sessionFile: client.sessionFile, state: r.data };
    } catch {}
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return { ok: false, error: 'agent did not become ready' };
});

ipcMain.handle('rpc:list-clients', () =>
  [...clients.values()].map((c) => ({ key: c.key, sessionFile: c.sessionFile, streaming: c.streaming, alive: c.alive, cwd: c.cwd })));

// ---------- Empty-session cleanup ----------

function countMessagesInSession(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (line.includes('"type":"message"')) return 1;
    }
    return 0;
  } catch { return -1; }
}
function cleanupAutoCreatedSessions() {
  for (const f of createdSessionFiles) {
    if (countMessagesInSession(f) === 0) { try { fs.unlinkSync(f); } catch {} }
  }
}

// ---------- Session listing ----------

async function listSessions() {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const p = path.join(SESSIONS_DIR, f);
    try {
      const stat = fs.statSync(p);
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.split('\n');
      let header = null, name = null, preview = null, messageCount = 0;
      let lastTs = stat.mtimeMs;
      for (const line of lines) {
        if (!line || line[0] !== '{') continue;
        let obj = null;
        if (!header && line.includes('"type":"session"')) {
          obj = JSON.parse(line);
          if (obj.type === 'session') { header = obj; continue; }
        }
        if (line.includes('"type":"session_info"') && line.includes('"name"')) {
          obj = obj || JSON.parse(line);
          if (obj.type === 'session_info' && obj.name) { name = obj.name; continue; }
        }
        if (line.includes('"type":"message"')) {
          obj = obj || JSON.parse(line);
          if (obj.type !== 'message') continue;
          messageCount++;
          if (obj.timestamp) lastTs = Date.parse(obj.timestamp) || lastTs;
          const m = obj.message;
          if (!preview && m && m.role === 'user') {
            const text = typeof m.content === 'string'
              ? m.content
              : (Array.isArray(m.content) ? (m.content.find((c) => c.type === 'text') || {}).text : '');
            if (text) preview = String(text).replace(/\s+/g, ' ').slice(0, 140);
          }
        }
      }
      if (!header) continue;
      out.push({
        path: p, id: header.id, cwd: header.cwd, name, preview, messageCount,
        rlmDepth: header.rlmDepth || 0,
        parentSession: header.parentSession || null,
        createdAt: Date.parse(header.timestamp) || stat.birthtimeMs,
        updatedAt: lastTs,
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

let watchTimer = null;
function watchSessions() {
  try {
    fs.watch(SESSIONS_DIR, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => broadcast('sessions-changed', await listSessions()), 400);
    });
  } catch {}
}

ipcMain.handle('sessions:list', () => listSessions());
ipcMain.handle('sessions:delete', async (_e, sessionPath) => {
  try {
    if (!sessionPath.startsWith(SESSIONS_DIR)) throw new Error('refusing to delete outside sessions dir');
    const c = clients.get(sessionPath);
    if (c) { clients.delete(sessionPath); try { c.proc.kill(); } catch {} }
    fs.unlinkSync(sessionPath);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('sessions:tail', (_e, { path: p, max }) => {
  try {
    if (!p.startsWith(SESSIONS_DIR)) throw new Error('outside sessions dir');
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const msgs = [];
    for (const line of lines) {
      if (!line.includes('"type":"message"')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'message') continue;
        const m = obj.message || {};
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) {
          text = m.content.map((c) => c.type === 'text' ? c.text : (c.type === 'toolCall' ? '[tool: ' + c.name + ']' : '')).filter(Boolean).join('\n');
        }
        msgs.push({ role: m.role, text: text.slice(0, 2000), timestamp: m.timestamp });
      } catch {}
    }
    return { ok: true, messages: msgs.slice(-(max || 50)) };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ---------- Git context ----------

ipcMain.handle('git:info', (_e, dir) => {
  try {
    if (typeof dir !== 'string' || !dir.startsWith(HOME)) throw new Error('bad dir');
    const opts = { cwd: dir, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const branch = execSync('git branch --show-current', opts).trim();
    const root = execSync('git rev-parse --show-toplevel', opts).trim();
    let dirty = 0;
    try { dirty = execSync('git status --porcelain | wc -l', { ...opts, shell: '/bin/sh' }).trim(); } catch {}
    return { ok: true, branch, root, dirty: Number(dirty) || 0 };
  } catch { return { ok: false }; }
});

// ---------- Agent self-repair / update ----------

const INSTALL_CMD = 'curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh';
function runAgentInstaller() {
  return new Promise((resolve) => {
    const childEnv = buildChildEnv();
    let proc;
    try { proc = spawn('/bin/sh', ['-c', INSTALL_CMD], { env: childEnv }); }
    catch (err) { resolve({ ok: false, error: String(err) }); return; }
    const pump = (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) broadcast('agent-install-progress', line.trim());
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }));
    proc.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: 'Installer exited with code ' + code }));
  });
}
ipcMain.handle('agent:install', () => runAgentInstaller());

ipcMain.handle('agent:kill-all', () => {
  for (const c of clients.values()) { try { c.proc.kill(); } catch {} }
  clients.clear();
  return { ok: true };
});

// ---------- Config files ----------

const PRIME_DIR = path.join(HOME, '.prime', 'agent');
const SETTINGS_PATH = path.join(PRIME_DIR, 'settings.json');
const MODELS_PATH = path.join(PRIME_DIR, 'models.json');
const AUTH_PATH = path.join(PRIME_DIR, 'auth.json');

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(p, obj) {
  JSON.parse(JSON.stringify(obj));
  if (fs.existsSync(p)) { try { fs.copyFileSync(p, p + '.bak'); } catch {} }
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

ipcMain.handle('config:read', () => {
  const settings = readJsonSafe(SETTINGS_PATH, {});
  const modelsJson = readJsonSafe(MODELS_PATH, { providers: {} });
  const auth = readJsonSafe(AUTH_PATH, {});
  const authSummary = {};
  for (const [provider, entry] of Object.entries(auth)) {
    if (entry && typeof entry === 'object') {
      authSummary[provider] = { type: entry.type || 'unknown', masked: entry.type === 'api_key' ? maskKey(entry.key) : null };
    } else authSummary[provider] = { type: 'unknown', masked: null };
  }
  return { settings, modelsJson, auth: authSummary };
});
ipcMain.handle('config:write-settings', (_e, patch) => {
  try { const s = readJsonSafe(SETTINGS_PATH, {}); Object.assign(s, patch); writeJsonAtomic(SETTINGS_PATH, s); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('config:write-models', (_e, modelsJson) => {
  try {
    if (!modelsJson || typeof modelsJson !== 'object' || typeof modelsJson.providers !== 'object') throw new Error('models.json must have a providers map');
    writeJsonAtomic(MODELS_PATH, modelsJson);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('config:set-api-key', (_e, { provider, key }) => {
  try {
    if (!provider || !key) throw new Error('provider and key required');
    const auth = readJsonSafe(AUTH_PATH, {});
    auth[provider] = { type: 'api_key', key };
    writeJsonAtomic(AUTH_PATH, auth);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('config:delete-api-key', (_e, { provider }) => {
  try { const auth = readJsonSafe(AUTH_PATH, {}); delete auth[provider]; writeJsonAtomic(AUTH_PATH, auth); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});

// ---------- xAI OAuth (device code flow) ----------

const XAI_ISSUER = 'https://auth.x.ai';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_CACHE = path.join(PRIME_DIR, 'xai-oauth.json');
const XAI_BRIDGE = path.join(PRIME_DIR, 'xai-oauth-bridge.py');
const XAI_BRIDGE_SOURCE = `#!/usr/bin/env python3
import json, os, sys, time, urllib.request, urllib.parse
CACHE = os.path.expanduser('~/.prime/agent/xai-oauth.json')
TOKEN_URL = '${XAI_ISSUER}/oauth2/token'
CLIENT_ID = '${XAI_CLIENT_ID}'
def main():
    try:
        with open(CACHE) as f: data = json.load(f)
    except Exception: sys.exit(1)
    tokens = data.get('tokens') or {}
    if time.time() > data.get('expires_at', 0) - 300:
        try:
            body = urllib.parse.urlencode({'grant_type': 'refresh_token', 'client_id': CLIENT_ID,
                                           'refresh_token': tokens['refresh_token']}).encode()
            req = urllib.request.Request(TOKEN_URL, data=body,
                                         headers={'content-type': 'application/x-www-form-urlencoded'})
            with urllib.request.urlopen(req, timeout=30) as r: nt = json.load(r)
            tokens.update(nt)
            data['tokens'] = tokens
            data['expires_at'] = time.time() + int(nt.get('expires_in', 21600))
            tmp = CACHE + '.tmp'
            with open(tmp, 'w') as f: json.dump(data, f)
            os.chmod(tmp, 0o600); os.replace(tmp, CACHE)
        except Exception:
            if time.time() > data.get('expires_at', 0): sys.exit(1)
    sys.stdout.write(tokens.get('access_token', ''))
main()
`;

function xaiPost(urlStr, params) {
  return fetch(urlStr, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }).then((r) => r.json().catch(() => ({})).then((j) => ({ status: r.status, json: j })));
}
function xaiEnsureOverride() {
  const modelsJson = readJsonSafe(MODELS_PATH, { providers: {} });
  if (!modelsJson.providers) modelsJson.providers = {};
  const prev = modelsJson.providers.xai || {};
  prev.apiKey = '!python3 ' + XAI_BRIDGE;
  modelsJson.providers.xai = prev;
  writeJsonAtomic(MODELS_PATH, modelsJson);
}
ipcMain.handle('xai:status', () => {
  try {
    const data = JSON.parse(fs.readFileSync(XAI_CACHE, 'utf8'));
    return { connected: true, expiresAt: data.expires_at || 0, email: data.email || null };
  } catch { return { connected: false }; }
});
ipcMain.handle('xai:disconnect', () => {
  try { fs.unlinkSync(XAI_CACHE); } catch {}
  try {
    const modelsJson = readJsonSafe(MODELS_PATH, { providers: {} });
    if (modelsJson.providers && modelsJson.providers.xai) {
      delete modelsJson.providers.xai.apiKey;
      if (!Object.keys(modelsJson.providers.xai).length) delete modelsJson.providers.xai;
      writeJsonAtomic(MODELS_PATH, modelsJson);
    }
  } catch {}
  return { ok: true };
});
ipcMain.handle('xai:connect', async () => {
  const dc = await xaiPost(XAI_ISSUER + '/oauth2/device/code', { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE });
  if (dc.status !== 200 || !dc.json.device_code) return { ok: false, error: 'xAI device flow failed: ' + JSON.stringify(dc.json) };
  const d = dc.json;
  broadcast('xai-device-code', { userCode: d.user_code, verificationUri: d.verification_uri });
  shell.openExternal(d.verification_uri_complete || d.verification_uri);
  const deadline = Date.now() + (d.expires_in || 900) * 1000;
  let interval = (d.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const t = await xaiPost(XAI_ISSUER + '/oauth2/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: d.device_code, client_id: XAI_CLIENT_ID,
    });
    if (t.status === 200 && t.json.access_token) {
      fs.writeFileSync(XAI_BRIDGE, XAI_BRIDGE_SOURCE, { mode: 0o700 });
      const cache = { tokens: t.json, expires_at: Math.floor(Date.now() / 1000) + (t.json.expires_in || 21600), obtained_at: new Date().toISOString() };
      fs.writeFileSync(XAI_CACHE, JSON.stringify(cache, null, 2), { mode: 0o600 });
      xaiEnsureOverride();
      return { ok: true };
    }
    const err = t.json && t.json.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    return { ok: false, error: 'xAI authorization failed: ' + (err || t.status) };
  }
  return { ok: false, error: 'xAI authorization timed out' };
});

// ---------- App prefs ----------

const APP_SETTINGS_PATH = path.join(app.getPath('userData'), 'app-settings.json');
function readAppSettings() { return readJsonSafe(APP_SETTINGS_PATH, { pins: [] }); }
ipcMain.handle('prefs:get', () => ({ ...readAppSettings(), home: HOME }));
ipcMain.handle('prefs:write', (_e, patch) => {
  try { const s = readAppSettings(); Object.assign(s, patch); writeJsonAtomic(APP_SETTINGS_PATH, s); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});

// ---------- File tree ----------

const TREE_SKIP = new Set(['node_modules', '.git', 'dist', '.worktrees', '__pycache__', '.DS_Store']);
ipcMain.handle('fs:list-dir', (_e, dirPath) => {
  try {
    if (typeof dirPath !== 'string' || !dirPath.startsWith(HOME)) throw new Error('outside home');
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (TREE_SKIP.has(e.name)) continue;
      if (e.name.startsWith('.') && !['.prime', '.agents', '.hermes', '.env', '.gitignore'].includes(e.name)) continue;
      const p = path.join(dirPath, e.name);
      let stat = null;
      try { stat = fs.statSync(p); } catch { continue; }
      out.push({ name: e.name, path: p, type: e.isDirectory() ? 'dir' : 'file', size: stat.size, mtime: stat.mtimeMs });
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, entries: out };
  } catch (err) { return { ok: false, error: String(err) }; }
});
const TEXT_EXT = new Set(['.md','.txt','.json','.jsonl','.js','.ts','.py','.sh','.css','.html','.yaml','.yml','.toml','.xml','.svg','.csv','.log','.env','.gitignore','.cjs','.mjs','.jsx','.tsx','.sql','.rb','.go','.rs','.java','.c','.h','.cpp','.plist']);
ipcMain.handle('fs:read-file', (_e, { path: p, maxBytes }) => {
  try {
    if (typeof p !== 'string' || !p.startsWith(HOME)) throw new Error('outside home');
    const ext = path.extname(p).toLowerCase();
    if (!TEXT_EXT.has(ext) && ext !== '') return { ok: false, binary: true };
    const cap = Math.min(maxBytes || 200000, 1000000);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(cap);
    const bytes = fs.readSync(fd, buf, 0, cap, 0);
    fs.closeSync(fd);
    const stat = fs.statSync(p);
    return { ok: true, text: buf.slice(0, bytes).toString('utf8'), truncated: stat.size > bytes };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ---------- Skills (list / toggle / add) ----------

const SKILL_DIRS = [path.join(HOME, '.agents', 'skills'), path.join(PRIME_DIR, 'skills')];
function scanSkills() {
  const out = [];
  for (const base of SKILL_DIRS) {
    let names;
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      const dir = path.join(base, n);
      let stat;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const enabled = path.join(dir, 'SKILL.md');
      const disabled = path.join(dir, 'SKILL.md.disabled');
      let file = null, isEnabled = false;
      if (fs.existsSync(enabled)) { file = enabled; isEnabled = true; }
      else if (fs.existsSync(disabled)) { file = disabled; isEnabled = false; }
      else continue;
      try {
        const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
        const nameM = head.match(/^name:\s*(.+)$/m);
        const descM = head.match(/^description:\s*(.+)$/m);
        out.push({
          id: n,
          name: nameM ? nameM[1].trim() : n,
          description: descM ? descM[1].trim().slice(0, 300) : '',
          path: file, dir, enabled: isEnabled,
          source: base.includes('.agents') ? 'user' : 'prime',
        });
      } catch {}
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
ipcMain.handle('skills:list', () => scanSkills());
ipcMain.handle('skills:toggle', (_e, { dir, enable }) => {
  try {
    if (typeof dir !== 'string' || !SKILL_DIRS.some((b) => dir.startsWith(b))) throw new Error('outside skill dirs');
    const from = path.join(dir, enable ? 'SKILL.md.disabled' : 'SKILL.md');
    const to = path.join(dir, enable ? 'SKILL.md' : 'SKILL.md.disabled');
    fs.renameSync(from, to);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('skills:add-from-folder', async () => {
  try {
    const r = await dialog.showOpenDialog(null, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
    const src = r.filePaths[0];
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('No SKILL.md in that folder');
    const dest = path.join(PRIME_DIR, 'skills', path.basename(src));
    if (fs.existsSync(dest)) throw new Error('A skill with that name already exists');
    fs.cpSync(src, dest, { recursive: true });
    return { ok: true, dest };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ---------- HUD ----------

let hudWin = null;
const HUD_WIDTH = 620, HUD_HEIGHT = 320;
function createHud() {
  hudWin = new BrowserWindow({
    width: HUD_WIDTH, height: HUD_HEIGHT, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#0f1011',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  hudWin.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
  hudWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWin.on('blur', () => { if (hudWin && !hudWin.webContents.isDevToolsOpened()) hudWin.hide(); });
}
function toggleHud() {
  if (!hudWin) return;
  if (hudWin.isVisible()) { hudWin.hide(); return; }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  hudWin.setPosition(Math.round(x + (width - HUD_WIDTH) / 2), Math.round(y + height - HUD_HEIGHT - 72));
  hudWin.show(); hudWin.focus();
  hudWin.webContents.send('hud-opened');
}
ipcMain.handle('hud:hide', () => { if (hudWin) hudWin.hide(); });
ipcMain.handle('hud:prompt', async (_e, { key, text }) => {
  try {
    const client = getClient(key) || [...clients.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (!client) return { ok: false, error: 'no agent running' };
    const st = await clientCommand(client, { type: 'get_state' });
    const cmd = { type: 'prompt', message: text };
    if (st.success && st.data.isStreaming) cmd.streamingBehavior = 'steer';
    const r = await clientCommand(client, cmd);
    return { ok: !!r.success, error: r.error || null, streaming: !!(st.success && st.data.isStreaming) };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// ---------- Windows / pop-out ----------

const wins = new Set();
function createWindow(sessionQuery) {
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 940, minHeight: 600,
    title: 'Prime Agent', backgroundColor: '#08090a',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  wins.add(win);
  win.on('closed', () => wins.delete(win));
  const file = path.join(__dirname, 'renderer', 'index.html');
  if (sessionQuery) win.loadFile(file, { query: { session: sessionQuery } });
  else win.loadFile(file);
  if (process.env.PRIME_DESKTOP_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  if (process.env.PRIME_DESKTOP_CAPTURE) {
    win.webContents.once('did-finish-load', () => {
      if (process.env.PRIME_DESKTOP_EVAL) {
        setTimeout(() => {
          win.webContents.executeJavaScript(process.env.PRIME_DESKTOP_EVAL)
            .then((r) => { if (r !== undefined) console.log('EVAL_RESULT', JSON.stringify(r)); })
            .catch((e) => console.error('eval hook failed', e));
        }, Number(process.env.PRIME_DESKTOP_EVAL_DELAY || 1500));
      }
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.PRIME_DESKTOP_CAPTURE, img.toPNG());
          console.log('CAPTURED', process.env.PRIME_DESKTOP_CAPTURE);
        } catch (e) { console.error('capture failed', e); }
        if (process.env.PRIME_DESKTOP_QUIT_AFTER_CAPTURE) app.quit();
      }, Number(process.env.PRIME_DESKTOP_CAPTURE_DELAY || 2500));
    });
  }
  return win;
}

ipcMain.handle('window:pop-out', (_e, sessionPath) => {
  createWindow(sessionPath || undefined);
  return { ok: true };
});

ipcMain.handle('dialog:pick-directory', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:open-path', (_e, p) => shell.openPath(p));

// ---------- Menu ----------

function buildMenu() {
  const send = (id) => () => broadcast('menu-action', { id });
  const template = [
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Open at Login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: send('new-chat') },
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('open-settings') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { label: 'Agent', submenu: [
      { label: 'Install or Repair Agent…', click: send('install-agent') },
      { label: 'Update Agent…', click: send('update-agent') },
      { type: 'separator' },
      { label: 'Restart All Agents', click: send('restart-agent') },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Smoke test / boot ----------

async function smokeTest() {
  const win = null;
  const client = spawnClient({ ownerWin: null });
  try {
    const state = await clientCommand(client, { type: 'get_state' });
    console.log('SMOKE get_state:', state.success, state.data && state.data.model && state.data.model.id);
    const models = await clientCommand(client, { type: 'get_available_models' });
    console.log('SMOKE models:', models.success, models.data && models.data.models.length);
    const sessions = await listSessions();
    console.log('SMOKE sessions listed:', sessions.length);
    console.log('SMOKE OK');
    process.exit(0);
  } catch (err) { console.error('SMOKE FAIL', err); process.exit(1); }
}

app.whenReady().then(async () => {
  if (process.env.SMOKE_TEST) { smokeTest(); return; }
  buildMenu();
  createHud();
  globalShortcut.register('CommandOrControl+Shift+Space', toggleHud);
  createWindow();
  watchSessions();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { /* HUD hotkey keeps app alive; Cmd+Q to quit */ });
app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  cleanupAutoCreatedSessions();
  for (const c of clients.values()) { try { c.proc.kill(); } catch {} }
  clients.clear();
});
