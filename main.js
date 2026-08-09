// Prime Desktop - Electron main process
// Spawns `prime-agent --mode rpc` and bridges its JSONL protocol to the renderer via IPC.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.prime', 'agent', 'sessions');
const COMMAND_TIMEOUT_MS = 30000;

let win = null;
let rpc = null; // { proc, pending: Map, buffer, alive, sessionFile }
let requestSeq = 0;
const createdSessionFiles = new Set(); // every session file created this app run

// ---------- Agent binary resolution ----------

function loginShellPath() {
  try {
    return execSync('/bin/zsh -lic \'echo $PATH\'', { timeout: 4000, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
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
  return env;
}

function findNode(childEnv) {
  const candidates = [
    path.join(HOME, '.hermes', 'node', 'bin', 'node'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    return execSync('which node', { env: childEnv, encoding: 'utf8' }).trim();
  } catch {
    return 'node';
  }
}

// Resolve prime-agent to an explicit [node, script.js] invocation so we never
// depend on PATH/shebang resolution (Finder launches have a sparse env).
function resolveAgentInvocation(childEnv) {
  const binCandidates = [
    path.join(HOME, '.local', 'bin', 'prime-agent'),
    path.join(HOME, '.local', 'lib', 'node_modules', 'prime-agent', 'dist', 'bundle', 'cli.js'),
    path.join(HOME, '.hermes', 'node', 'bin', 'prime-agent'),
    '/usr/local/bin/prime-agent',
    '/opt/homebrew/bin/prime-agent',
  ];
  let found = null;
  for (const c of binCandidates) {
    if (fs.existsSync(c)) { found = c; break; }
  }
  if (!found) {
    try { found = execSync('which prime-agent', { env: childEnv, encoding: 'utf8' }).trim(); }
    catch { found = null; }
  }
  if (!found) return null;
  const node = findNode(childEnv);
  try {
    const real = fs.realpathSync(found);
    if (real.endsWith('.js') || real.endsWith('.mjs') || real.endsWith('.cjs')) {
      return { command: node, args: [real], display: real };
    }
  } catch {}
  return { command: found, args: [], display: found };
}

// ---------- RPC client ----------

function startRpc(cwd) {
  stopRpc();
  const childEnv = buildChildEnv();
  const invocation = resolveAgentInvocation(childEnv);
  if (!invocation) {
    rpc = { alive: false, pending: new Map() };
    sendToRenderer('rpc-error', { message: 'prime-agent binary not found. Install it or check PATH.' });
    return rpc;
  }

  let proc;
  try {
    proc = spawn(invocation.command, [...invocation.args, '--mode', 'rpc'], {
      cwd: cwd || HOME,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    rpc = { alive: false, pending: new Map() };
    sendToRenderer('rpc-error', { message: 'Failed to spawn prime-agent: ' + String(err) });
    return rpc;
  }

  rpc = { proc, pending: new Map(), buffer: '', alive: true, sessionFile: null };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    if (!rpc || rpc.proc !== proc) return;
    rpc.buffer += chunk;
    let idx;
    // Strict JSONL: split on LF only (U+2028/U+2029 are valid inside JSON strings)
    while ((idx = rpc.buffer.indexOf('\n')) !== -1) {
      let line = rpc.buffer.slice(0, idx);
      rpc.buffer = rpc.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      handleRpcMessage(obj);
    }
  });

  proc.stderr.on('data', (d) => sendToRenderer('rpc-stderr', d.toString()));

  const onDead = (code, errMsg) => {
    if (rpc && rpc.proc === proc) {
      rpc.alive = false;
      for (const { reject, timer } of rpc.pending.values()) {
        clearTimeout(timer);
        reject(new Error(errMsg || ('RPC process exited (' + code + ')')));
      }
      rpc.pending.clear();
    }
    sendToRenderer('rpc-exit', { code: code == null ? -1 : code, error: errMsg || null });
  };
  proc.on('exit', (code) => onDead(code, null));
  proc.on('error', (err) => onDead(null, 'Failed to start prime-agent: ' + String(err)));

  return rpc;
}

function stopRpc() {
  if (rpc && rpc.proc) { try { rpc.proc.kill(); } catch {} }
  rpc = null;
}

function handleRpcMessage(obj) {
  if (obj.type === 'response' && obj.id && rpc && rpc.pending.has(obj.id)) {
    const { resolve, timer } = rpc.pending.get(obj.id);
    clearTimeout(timer);
    rpc.pending.delete(obj.id);
    resolve(obj);
    return;
  }
  // Track sessions created via new_session so empties can be cleaned on quit
  if (obj.type === 'response' && obj.command === 'new_session' && obj.success) {
    rpcCommand({ type: 'get_state' }).then((r) => {
      if (r.success && r.data.sessionFile) createdSessionFiles.add(r.data.sessionFile);
    }).catch(() => {});
  }
  sendToRenderer('rpc-event', obj);
}

function rpcCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (!rpc || !rpc.alive) return reject(new Error('Agent process is not running'));
    const id = 'req-' + (++requestSeq);
    cmd.id = id;
    const timer = setTimeout(() => {
      if (rpc && rpc.pending.has(id)) {
        rpc.pending.delete(id);
        reject(new Error('Command timed out: ' + (cmd.type || 'unknown')));
      }
    }, COMMAND_TIMEOUT_MS);
    rpc.pending.set(id, { resolve, reject, timer });
    try {
      rpc.proc.stdin.write(JSON.stringify(cmd) + '\n');
    } catch (e) {
      clearTimeout(timer);
      rpc.pending.delete(id);
      reject(e);
    }
  });
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- Empty-session cleanup ----------

function countMessagesInSession(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    let n = 0;
    for (const line of content.split('\n')) {
      if (line.includes('"type":"message"')) n++;
      if (n > 0) break;
    }
    return n;
  } catch { return -1; }
}

function cleanupAutoCreatedSession() {
  // Every spawn/new_session creates a session file immediately; if the user
  // never typed anything, remove the empty file so the sidebar stays clean.
  for (const f of createdSessionFiles) {
    if (countMessagesInSession(f) === 0) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ---------- Session listing (sidebar) ----------

async function listSessions() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch { return []; }
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
    } catch { /* skip unreadable session */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

let watchTimer = null;
function watchSessions() {
  try {
    fs.watch(SESSIONS_DIR, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
        sendToRenderer('sessions-changed', await listSessions());
      }, 400);
    });
  } catch {}
}

// ---------- Agent self-repair / update (official installer, no terminal needed) ----------

const INSTALL_CMD = 'curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh';

function runAgentInstaller() {
  return new Promise((resolve) => {
    const childEnv = buildChildEnv();
    let proc;
    try {
      proc = spawn('/bin/sh', ['-c', INSTALL_CMD], { env: childEnv });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
      return;
    }
    const pump = (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) sendToRenderer('agent-install-progress', line.trim());
      }
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }));
    proc.on('exit', async (code) => {
      if (code !== 0) return resolve({ ok: false, error: 'Installer exited with code ' + code });
      // Re-resolve and start the agent
      startRpc();
      for (let i = 0; i < 60; i++) {
        try {
          const r = await rpcCommand({ type: 'get_state' });
          if (r.success) {
            if (r.data.sessionFile) createdSessionFiles.add(r.data.sessionFile);
            return resolve({ ok: true });
          }
        } catch {}
        await new Promise((r2) => setTimeout(r2, 250));
      }
      resolve({ ok: false, error: 'Installed, but the agent did not become ready' });
    });
  });
}

ipcMain.handle('agent:install', () => runAgentInstaller());

// ---------- Config files (settings / providers / API keys) ----------

const PRIME_DIR = path.join(HOME, '.prime', 'agent');
const SETTINGS_PATH = path.join(PRIME_DIR, 'settings.json');
const MODELS_PATH = path.join(PRIME_DIR, 'models.json');
const AUTH_PATH = path.join(PRIME_DIR, 'auth.json');

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(p, obj) {
  JSON.parse(JSON.stringify(obj)); // validate serializable
  if (fs.existsSync(p)) {
    try { fs.copyFileSync(p, p + '.bak'); } catch {}
  }
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
      authSummary[provider] = {
        type: entry.type || 'unknown',
        masked: entry.type === 'api_key' ? maskKey(entry.key) : null,
      };
    } else {
      authSummary[provider] = { type: 'unknown', masked: null };
    }
  }
  return { settings, modelsJson, auth: authSummary };
});

ipcMain.handle('config:write-settings', (_e, patch) => {
  try {
    const settings = readJsonSafe(SETTINGS_PATH, {});
    Object.assign(settings, patch);
    writeJsonAtomic(SETTINGS_PATH, settings);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('config:write-models', (_e, modelsJson) => {
  try {
    if (!modelsJson || typeof modelsJson !== 'object' || typeof modelsJson.providers !== 'object') {
      throw new Error('models.json must be an object with a providers map');
    }
    writeJsonAtomic(MODELS_PATH, modelsJson);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('config:set-api-key', (_e, { provider, key }) => {
  try {
    if (!provider || !key) throw new Error('provider and key are required');
    const auth = readJsonSafe(AUTH_PATH, {});
    auth[provider] = { type: 'api_key', key };
    writeJsonAtomic(AUTH_PATH, auth);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('config:delete-api-key', (_e, { provider }) => {
  try {
    const auth = readJsonSafe(AUTH_PATH, {});
    delete auth[provider];
    writeJsonAtomic(AUTH_PATH, auth);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ---------- App prefs (pins etc.) ----------

const APP_SETTINGS_PATH = path.join(app.getPath('userData'), 'app-settings.json');
function readAppSettings() { return readJsonSafe(APP_SETTINGS_PATH, { pins: [] }); }
ipcMain.handle('prefs:get', () => ({ ...readAppSettings(), home: HOME }));
ipcMain.handle('prefs:write', (_e, patch) => {
  try {
    const s = readAppSettings();
    Object.assign(s, patch);
    writeJsonAtomic(APP_SETTINGS_PATH, s);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
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
      out.push({
        name: e.name, path: p,
        type: e.isDirectory() ? 'dir' : 'file',
        size: stat.size, mtime: stat.mtimeMs,
      });
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

// ---------- Skills scan ----------

ipcMain.handle('skills:list', () => {
  const dirs = [path.join(HOME, '.agents', 'skills'), path.join(PRIME_DIR, 'skills')];
  const out = [];
  for (const base of dirs) {
    let names;
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      const skillMd = path.join(base, n, 'SKILL.md');
      try {
        const head = fs.readFileSync(skillMd, 'utf8').slice(0, 2000);
        const nameM = head.match(/^name:\s*(.+)$/m);
        const descM = head.match(/^description:\s*(.+)$/m);
        out.push({
          id: n,
          name: nameM ? nameM[1].trim() : n,
          description: descM ? descM[1].trim().slice(0, 300) : '',
          path: skillMd,
          source: base.includes('.agents') ? 'user' : 'prime',
        });
      } catch { /* no SKILL.md */ }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});

// ---------- Session tail (subagent viewer) ----------

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

// ---------- Menu ----------

function buildMenu() {
  const send = (id) => () => sendToRenderer('menu-action', { id });
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Open at Login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: send('new-chat') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('open-settings') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        { label: 'Install or Repair Agent…', click: send('install-agent') },
        { label: 'Update Agent…', click: send('update-agent') },
        { type: 'separator' },
        { label: 'Restart Agent', click: send('restart-agent') },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- xAI OAuth (device code flow, like Hermes) ----------

const XAI_ISSUER = 'https://auth.x.ai';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_CACHE = path.join(PRIME_DIR, 'xai-oauth.json');
const XAI_BRIDGE = path.join(PRIME_DIR, 'xai-oauth-bridge.py');

const XAI_BRIDGE_SOURCE = `#!/usr/bin/env python3
# Prints a fresh xAI OAuth access token for prime-agent's models.json apiKey "!cmd" hook.
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
  if (dc.status !== 200 || !dc.json.device_code) {
    return { ok: false, error: 'xAI device flow failed to start: ' + JSON.stringify(dc.json) };
  }
  const d = dc.json;
  sendToRenderer('xai-device-code', { userCode: d.user_code, verificationUri: d.verification_uri });
  shell.openExternal(d.verification_uri_complete || d.verification_uri);

  const deadline = Date.now() + (d.expires_in || 900) * 1000;
  let interval = (d.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const t = await xaiPost(XAI_ISSUER + '/oauth2/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: d.device_code,
      client_id: XAI_CLIENT_ID,
    });
    if (t.status === 200 && t.json.access_token) {
      fs.writeFileSync(XAI_BRIDGE, XAI_BRIDGE_SOURCE, { mode: 0o700 });
      const cache = {
        tokens: t.json,
        expires_at: Math.floor(Date.now() / 1000) + (t.json.expires_in || 21600),
        obtained_at: new Date().toISOString(),
      };
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

// ---------- IPC ----------

// Upstream quirk: a brand-new session's file is only flushed a few seconds
// after the first prompt starts. Switching away before that flush orphans the
// session (in-flight work is lost). Guard: before switching while streaming,
// wait until the current session file exists and contains a message.
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

ipcMain.handle('rpc:command', async (_e, cmd) => {
  try {
    if (cmd.type === 'switch_session' || cmd.type === 'new_session') {
      try {
        const st = await rpcCommand({ type: 'get_state' });
        if (st.success && st.data.isStreaming && st.data.sessionFile) {
          sendToRenderer('rpc-flush-wait', { sessionFile: st.data.sessionFile });
          await waitForSessionPersisted(st.data.sessionFile);
        }
      } catch {}
    }
    return await rpcCommand(cmd);
  } catch (err) { return { type: 'response', success: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('sessions:list', () => listSessions());

ipcMain.handle('sessions:delete', async (_e, sessionPath) => {
  try {
    if (!sessionPath.startsWith(SESSIONS_DIR)) throw new Error('refusing to delete outside sessions dir');
    fs.unlinkSync(sessionPath);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('rpc:restart', async (_e, cwd) => {
  startRpc(cwd);
  for (let i = 0; i < 60; i++) {
    try {
      const r = await rpcCommand({ type: 'get_state' });
      if (r.success) {
        rpc.sessionFile = r.data.sessionFile || null;
        if (rpc.sessionFile) createdSessionFiles.add(rpc.sessionFile);
        return { ok: true, state: r.data };
      }
    } catch {}
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return { ok: false, error: 'Agent process did not become ready' };
});

ipcMain.handle('dialog:pick-directory', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:open-path', (_e, p) => shell.openPath(p));

// ---------- HUD (global quick-prompt, like Hermes) ----------

let hudWin = null;
const HUD_WIDTH = 620;
const HUD_HEIGHT = 320;

function createHud() {
  hudWin = new BrowserWindow({
    width: HUD_WIDTH, height: HUD_HEIGHT,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0f1011',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hudWin.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
  hudWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWin.on('blur', () => { if (hudWin && !hudWin.webContents.isDevToolsOpened()) hudWin.hide(); });
}

function toggleHud() {
  if (!hudWin) return;
  if (hudWin.isVisible()) { hudWin.hide(); return; }
  // Position bottom-center of the display containing the cursor (Hermes style)
  const { screen } = require('electron');
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  hudWin.setPosition(Math.round(x + (width - HUD_WIDTH) / 2), Math.round(y + height - HUD_HEIGHT - 72));
  hudWin.show();
  hudWin.focus();
  hudWin.webContents.send('hud-opened');
}

ipcMain.handle('hud:hide', () => { if (hudWin) hudWin.hide(); });
ipcMain.handle('hud:prompt', async (_e, text) => {
  try {
    const st = await rpcCommand({ type: 'get_state' });
    const cmd = { type: 'prompt', message: text };
    if (st.success && st.data.isStreaming) cmd.streamingBehavior = 'steer';
    const r = await rpcCommand(cmd);
    return { ok: !!r.success, error: r.error || null, streaming: !!(st.success && st.data.isStreaming) };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// ---------- Window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 940, minHeight: 600,
    title: 'Prime Agent',
    backgroundColor: '#08090a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.PRIME_DESKTOP_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  // Dev-only: capture a screenshot for headless UI verification
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
}

// ---------- Boot ----------

async function smokeTest() {
  startRpc();
  try {
    const state = await rpcCommand({ type: 'get_state' });
    console.log('SMOKE get_state:', state.success, state.data && state.data.model && state.data.model.id);
    const models = await rpcCommand({ type: 'get_available_models' });
    console.log('SMOKE models:', models.success, models.data && models.data.models.length);
    const sessions = await listSessions();
    console.log('SMOKE sessions listed:', sessions.length);
    console.log('SMOKE OK');
    process.exit(0);
  } catch (err) {
    console.error('SMOKE FAIL', err);
    process.exit(1);
  }
}

app.whenReady().then(async () => {
  if (process.env.SMOKE_TEST) { smokeTest(); return; }
  buildMenu();
  createHud();
  const { globalShortcut } = require('electron');
  globalShortcut.register('CommandOrControl+Shift+Space', toggleHud);
  startRpc();
  // Learn the auto-created session file so we can clean it up if unused
  for (let i = 0; i < 60; i++) {
    try {
      const r = await rpcCommand({ type: 'get_state' });
      if (r.success) { rpc.sessionFile = r.data.sessionFile || null; if (rpc.sessionFile) createdSessionFiles.add(rpc.sessionFile); break; }
    } catch {}
    await new Promise((r2) => setTimeout(r2, 250));
  }
  createWindow();
  watchSessions();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running for the HUD hotkey unless explicitly quit
  if (hudWin) { return; }
  cleanupAutoCreatedSession();
  stopRpc();
  app.quit();
});

app.on('before-quit', () => {
  const { globalShortcut } = require('electron');
  globalShortcut.unregisterAll();
  cleanupAutoCreatedSession();
  stopRpc();
});
