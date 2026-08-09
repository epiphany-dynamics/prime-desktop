// Prime Desktop renderer - chat UI over the prime-agent RPC bridge.
/* global prime, marked, DOMPurify */

marked.setOptions({ breaks: false, gfm: true });

// ---------------- state ----------------
const S = {
  sessions: [],
  activeSessionFile: null,
  models: [],
  currentModel: null,
  thinkingLevel: null,
  isStreaming: false,
  sessionCwd: null,
  stream: null,      // per-run streaming render state
  toolCards: new Map(), // toolCallId -> card element refs
  extPending: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const chatEl = $('#chat');
const scrollEl = $('#chat-scroll');
const inputEl = $('#input');
const sendBtn = $('#send-btn');
const stopBtn = $('#stop-btn');

// ---------------- helpers ----------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function md(text) {
  return DOMPurify.sanitize(marked.parse(text || ''));
}
function relTime(ts) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24);
  if (days < 30) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}
function baseName(p) { return p ? p.replace(/\/+$/, '').split('/').pop() : ''; }

function nearBottom() {
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
}
function scrollBottom(force) {
  if (force || nearBottom()) scrollEl.scrollTop = scrollEl.scrollHeight;
}

function setBanner(text, isError, actionLabel, action) {
  const b = $('#status-banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.classList.toggle('error', !!isError);
  b.innerHTML = esc(text) + (actionLabel ? ` <button id="banner-action">${esc(actionLabel)}</button>` : '');
  if (actionLabel) $('#banner-action').onclick = action;
}

function setAgentState(text) { $('#agent-state').textContent = text || ''; }

// ---------------- messaging rendering ----------------
function addUserBubble(text) {
  hideEmptyState();
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="msg-role">You</div><div class="msg-body">${esc(text)}</div>`;
  chatEl.appendChild(div);
  scrollBottom(true);
}

function addNotice(text) {
  const div = document.createElement('div');
  div.className = 'notice';
  div.textContent = text;
  chatEl.appendChild(div);
}

function hideEmptyState() { $('#empty-state').classList.add('hidden'); }
function showEmptyStateIfEmpty() {
  $('#empty-state').classList.toggle('hidden', chatEl.children.length > 0);
}

// streaming assistant message assembly
function beginAssistantStream() {
  hideEmptyState();
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.innerHTML = `<div class="msg-role">Prime Agent</div><div class="msg-body"></div>`;
  chatEl.appendChild(msg);
  S.stream = {
    root: msg.querySelector('.msg-body'),
    blocks: new Map(),       // contentIndex -> { kind, el, raw }
    rafPending: false,
  };
  scrollBottom();
}

function streamBlock(idx, kind) {
  const st = S.stream;
  if (!st.blocks.has(idx)) {
    let el, raw = '';
    if (kind === 'thinking') {
      el = document.createElement('details');
      el.className = 'thinking';
      el.innerHTML = `<summary>Thinking…</summary><div class="thinking-body"></div>`;
      el._body = el.querySelector('.thinking-body');
    } else {
      el = document.createElement('div');
      el.className = 'stream-text';
    }
    st.root.appendChild(el);
    st.blocks.set(idx, { kind, el, raw });
  }
  return st.blocks.get(idx);
}

// Mirror an assistant message's content blocks into the streaming container.
function syncStreamFromMessage(msg) {
  for (let i = 0; i < (msg.content || []).length; i++) {
    const c = msg.content[i];
    if (c.type === 'text' && c.text) {
      const b = streamBlock(i, 'text');
      b.raw = c.text;
    } else if (c.type === 'thinking' && c.thinking) {
      const b = streamBlock(i, 'thinking');
      b.raw = c.thinking;
    } else if (c.type === 'toolCall') {
      ensureToolCard(c.id, c.name, c.arguments);
    }
  }
}

function renderStreamBlock(block) {
  if (block.kind === 'thinking') {
    block.el._body.textContent = block.raw;
    block.el.querySelector('summary').textContent = 'Thinking';
  } else {
    block.el.innerHTML = md(block.raw);
  }
}

function scheduleStreamRender() {
  const st = S.stream;
  if (!st || st.rafPending) return;
  st.rafPending = true;
  requestAnimationFrame(() => {
    st.rafPending = false;
    for (const b of st.blocks.values()) renderStreamBlock(b);
    scrollBottom();
  });
}

function endAssistantStream() {
  if (!S.stream) return;
  for (const b of S.stream.blocks.values()) renderStreamBlock(b);
  S.stream = null;
  scrollBottom();
}

// ---------------- tool cards ----------------
function toolSummary(toolName, args) {
  if (!args) return '';
  const a = args;
  const val = a.command ?? a.code ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.message ?? a['sub-task'] ?? a.task ?? '';
  let s = typeof val === 'string' ? val : JSON.stringify(val);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function ensureToolCard(toolCallId, toolName, args) {
  hideEmptyState();
  let card = S.toolCards.get(toolCallId);
  if (card) return card;
  const host = (S.stream && S.stream.root) || chatEl;
  const el = document.createElement('div');
  el.className = 'tool-card open';
  el.innerHTML = `
    <div class="tool-head">
      <span class="tool-dot running"></span>
      <span class="tool-name">${esc(toolName)}</span>
      <span class="tool-summary">${esc(toolSummary(toolName, args))}</span>
      <span class="tool-chevron">▼</span>
    </div>
    <div class="tool-detail">
      <div class="tool-section t-args"><h5>Input</h5><pre></pre></div>
      <div class="tool-section t-out hidden"><h5>Output</h5><pre></pre></div>
    </div>`;
  el.querySelector('.tool-head').onclick = () => el.classList.toggle('open');
  el.querySelector('.t-args pre').textContent = args ? JSON.stringify(args, null, 2) : '';
  host.appendChild(el);
  card = { el, dot: el.querySelector('.tool-dot'), out: el.querySelector('.t-out'), outPre: el.querySelector('.t-out pre') };
  S.toolCards.set(toolCallId, card);
  scrollBottom();
  return card;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function toolResult(card, result, isError) {
  card.dot.className = 'tool-dot ' + (isError ? 'err' : 'ok');
  const text = extractText(result && result.content);
  if (text) {
    card.out.classList.remove('hidden');
    card.outPre.textContent = text.length > 20000 ? text.slice(0, 20000) + '\n… [truncated]' : text;
  }
  scrollBottom();
}

// ---------------- history rendering ----------------
function renderHistory(messages, opts) {
  chatEl.innerHTML = '';
  S.toolCards.clear();
  endAssistantStream();
  let list = messages || [];
  // When joining a session that is still streaming, the last assistant message
  // is in flight — the live message_update stream renders it (from full
  // partials), so skip it here to avoid a duplicate.
  if (opts && opts.dropInFlight) {
    const copy = [...list];
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].role === 'assistant') { copy.splice(i, 1); break; }
      if (copy[i].role === 'toolResult') { copy.splice(i, 1); continue; }
      break;
    }
    list = copy;
  }
  for (const m of list) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : extractText(m.content);
      if (text) addUserBubble(text);
    } else if (m.role === 'assistant') {
      hideEmptyState();
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.innerHTML = `<div class="msg-role">Prime Agent</div><div class="msg-body"></div>`;
      const body = div.querySelector('.msg-body');
      for (const c of m.content || []) {
        if (c.type === 'text' && c.text) {
          const t = document.createElement('div');
          t.innerHTML = md(c.text);
          body.appendChild(t);
        } else if (c.type === 'thinking' && c.thinking) {
          const d = document.createElement('details');
          d.className = 'thinking';
          d.innerHTML = `<summary>Thinking</summary><div class="thinking-body"></div>`;
          d.querySelector('.thinking-body').textContent = c.thinking;
          body.appendChild(d);
        } else if (c.type === 'toolCall') {
          chatEl.appendChild(div); // ensure host exists before card
          ensureToolCard(c.id, c.name, c.arguments);
        }
      }
      if (!div.isConnected) chatEl.appendChild(div);
    } else if (m.role === 'toolResult') {
      const card = S.toolCards.get(m.toolCallId) || ensureToolCard(m.toolCallId, m.toolName, null);
      toolResult(card, m, m.isError);
      card.el.classList.remove('open'); // collapsed in history
    } else if (m.role === 'bashExecution') {
      const card = ensureToolCard('bash-' + (m.timestamp || Math.random()), 'bash', { command: m.command });
      toolResult(card, { content: [{ type: 'text', text: m.output || '' }] }, (m.exitCode || 0) !== 0);
      card.el.classList.remove('open');
    } else if (m.role === 'compactionSummary') {
      addNotice('Context compacted - earlier messages summarized');
    }
  }
  showEmptyStateIfEmpty();
  scrollBottom(true);
}

// ---------------- sidebar ----------------
async function refreshSessions(list) {
  S.sessions = list || (await prime.listSessions());
  renderSidebar();
}

function renderSidebar() {
  const filter = $('#session-filter').value.trim().toLowerCase();
  const host = $('#session-list');
  host.innerHTML = '';
  for (const s of S.sessions) {
    const label = s.name || s.preview || 'Untitled session';
    if (filter && !label.toLowerCase().includes(filter) && !(s.cwd || '').toLowerCase().includes(filter)) continue;
    const item = document.createElement('div');
    item.className = 'session-item' + (s.path === S.activeSessionFile ? ' active' : '');
    item.innerHTML = `
      <div class="s-name">${(s.path === S.activeSessionFile && S.isStreaming) ? '<span class="live-dot"></span>' : ''}${esc(label)}</div>
      <div class="s-meta">${esc(baseName(s.cwd))} · ${relTime(s.updatedAt)} · ${s.messageCount} msgs</div>
      <button class="s-delete" title="Delete session">✕</button>`;
    item.onclick = () => switchSession(s.path);
    item.querySelector('.s-name').ondblclick = (e) => {
      e.stopPropagation();
      startRename(item, s);
    };
    item.querySelector('.s-delete').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this session? This cannot be undone.')) return;
      await prime.deleteSession(s.path);
      if (s.path === S.activeSessionFile) await newSession();
      refreshSessions();
    };
    host.appendChild(item);
  }
}

async function startRename(item, session) {
  const nameEl = item.querySelector('.s-name');
  const current = session.name || '';
  const inp = document.createElement('input');
  inp.className = 'rename-input';
  inp.value = current;
  inp.placeholder = session.preview || 'Session name';
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  const commit = async () => {
    const v = inp.value.trim();
    if (v && v !== current) {
      const wasActive = session.path === S.activeSessionFile;
      if (wasActive) {
        await prime.command({ type: 'set_session_name', name: v });
      } else {
        // set_session_name only affects the attached session; write the
        // session_info entry via a quick switch + restore.
        const prev = S.activeSessionFile;
        await prime.command({ type: 'switch_session', sessionPath: session.path });
        await prime.command({ type: 'set_session_name', name: v });
        if (prev) await prime.command({ type: 'switch_session', sessionPath: prev });
        await syncState();
        const msgs = await prime.command({ type: 'get_messages' });
        if (msgs.success) renderHistory(msgs.data.messages, { dropInFlight: S.isStreaming });
      }
    }
    refreshSessions();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') refreshSessions();
    e.stopPropagation();
  };
  inp.onblur = commit;
  inp.onclick = (e) => e.stopPropagation();
}

// ---------------- session ops ----------------
async function switchSession(sessionPath) {
  if (sessionPath === S.activeSessionFile) return;
  setBanner(null);
  const r = await prime.command({ type: 'switch_session', sessionPath });
  if (!r.success) { setBanner('Failed to switch session: ' + (r.error || 'unknown'), true); return; }
  await syncState();
  const msgs = await prime.command({ type: 'get_messages' });
  if (msgs.success) renderHistory(msgs.data.messages, { dropInFlight: S.isStreaming });
  renderSidebar();
}

async function newSession() {
  if (S.isStreaming) { setBanner('Agent is still running - stop it first.'); return; }
  const r = await prime.command({ type: 'new_session' });
  if (!r.success) { setBanner('Failed to start new session: ' + (r.error || 'unknown'), true); return; }
  chatEl.innerHTML = '';
  showEmptyStateIfEmpty();
  await syncState();
  renderSidebar();
  inputEl.focus();
}

async function syncState() {
  const r = await prime.command({ type: 'get_state' });
  if (!r.success) return;
  const d = r.data;
  S.activeSessionFile = d.sessionFile || null;
  S.currentModel = d.model || null;
  S.thinkingLevel = d.thinkingLevel || null;
  S.isStreaming = !!d.isStreaming;
  updateTopbar();
  updateComposerState();
  const st = await prime.command({ type: 'get_session_stats' });
  if (st.success && st.data.contextUsage && st.data.contextUsage.percent != null) {
    $('#context-meter').textContent =
      `${Math.round(st.data.contextUsage.percent)}% ctx · $${(st.data.cost || 0).toFixed(3)}`;
  } else {
    $('#context-meter').textContent = '';
  }
}

function updateTopbar() {
  const s = S.sessions.find((x) => x.path === S.activeSessionFile);
  $('#session-title').textContent = s ? (s.name || s.preview || 'Untitled session') : 'New session';
  $('#model-btn').textContent = S.currentModel
    ? `${S.currentModel.provider}/${S.currentModel.id} ▾`
    : 'no model ▾';
  $('#thinking-btn').textContent = `thinking: ${S.thinkingLevel || 'off'} ▾`;
}

function updateComposerState() {
  stopBtn.classList.toggle('hidden', !S.isStreaming);
  sendBtn.disabled = false;
  inputEl.placeholder = S.isStreaming
    ? 'Agent is working - type to steer it…'
    : 'Message Prime Agent…  (Enter to send, Shift+Enter for newline)';
}

// ---------------- model / thinking pickers ----------------
function toggleMenu(menu, show) {
  document.querySelectorAll('.picker-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
  menu.classList.toggle('hidden', show === undefined ? undefined : !show);
}

async function loadModels() {
  const r = await prime.command({ type: 'get_available_models' });
  if (!r.success) {
    $('#model-btn').textContent = S.currentModel
      ? `${S.currentModel.provider}/${S.currentModel.id} ▾`
      : 'models unavailable - click to retry ▾';
    return false;
  }
  S.models = r.data.models || [];
  renderModelMenu();
  updateTopbar();
  return true;
}

function renderModelMenu() {
  const filter = $('#model-filter').value.trim().toLowerCase();
  const host = $('#model-list');
  host.innerHTML = '';
  const groups = new Map();
  for (const m of S.models) {
    const key = `${m.provider}/${m.id}`.toLowerCase() + ' ' + (m.name || '').toLowerCase();
    if (filter && !key.includes(filter)) continue;
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  for (const [provider, models] of groups) {
    const g = document.createElement('div');
    g.className = 'model-group';
    g.textContent = provider;
    host.appendChild(g);
    for (const m of models) {
      const item = document.createElement('div');
      const cur = S.currentModel && S.currentModel.provider === m.provider && S.currentModel.id === m.id;
      item.className = 'model-item' + (cur ? ' current' : '');
      item.innerHTML = `<span>${esc(m.name || m.id)}</span><span class="m-id">${esc(m.id)}</span>`;
      item.onclick = async () => {
        toggleMenu($('#model-menu'), false);
        const r = await prime.command({ type: 'set_model', provider: m.provider, modelId: m.id });
        if (r.success) { S.currentModel = r.data; updateTopbar(); }
        else setBanner('Model switch failed: ' + (r.error || ''), true);
      };
      host.appendChild(item);
    }
  }
}

function renderThinkingMenu() {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  const host = $('#thinking-menu');
  host.innerHTML = '';
  for (const lv of levels) {
    const item = document.createElement('div');
    item.className = 'model-item' + (S.thinkingLevel === lv ? ' current' : '');
    item.innerHTML = `<span>${lv}</span>`;
    item.onclick = async () => {
      toggleMenu(host, false);
      const r = await prime.command({ type: 'set_thinking_level', level: lv });
      if (r.success) { S.thinkingLevel = lv; updateTopbar(); syncState(); }
      else setBanner('Thinking level failed: ' + (r.error || ''), true);
    };
    host.appendChild(item);
  }
}

// ---------------- extension UI dialogs ----------------
function handleExtensionUi(req) {
  const { id, method } = req;
  if (method === 'notify') {
    setBanner(req.message || '', req.notifyType === 'error');
    if (req.notifyType !== 'error') setTimeout(() => setBanner(null), 5000);
    return;
  }
  if (method === 'setTitle') { document.title = req.title || 'Prime Agent'; return; }
  if (method === 'setStatus' || method === 'setWidget' || method === 'set_editor_text') {
    if (method === 'set_editor_text' && typeof req.text === 'string') { inputEl.value = req.text; autoSize(); }
    if (method === 'setStatus') setAgentState(req.statusText || '');
    return;
  }

  // dialog methods
  const backdrop = $('#modal-backdrop');
  const title = $('#modal-title');
  const body = $('#modal-body');
  const actions = $('#modal-actions');
  title.textContent = req.title || method;
  body.innerHTML = '';
  actions.innerHTML = '';

  const close = () => backdrop.classList.add('hidden');
  const respond = (payload) => {
    prime.command({ type: 'extension_ui_response', id, ...payload });
    close();
  };

  let inputControl = null;
  if (method === 'confirm') {
    body.innerHTML = `<div>${esc(req.message || '')}</div>`;
  } else if (method === 'select') {
    const sel = document.createElement('select');
    for (const opt of req.options || []) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      sel.appendChild(o);
    }
    body.appendChild(sel);
    inputControl = sel;
  } else if (method === 'input') {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = req.placeholder || '';
    body.appendChild(inp);
    inputControl = inp;
  } else if (method === 'editor') {
    const ta = document.createElement('textarea');
    ta.value = req.prefill || '';
    body.appendChild(ta);
    inputControl = ta;
  } else {
    return; // unknown dialog; ignore
  }

  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = method === 'confirm' ? 'Confirm' : 'OK';
  ok.onclick = () => {
    if (method === 'confirm') respond({ confirmed: true });
    else respond({ value: inputControl ? inputControl.value : '' });
  };
  const cancel = document.createElement('button');
  cancel.className = 'secondary';
  cancel.textContent = method === 'confirm' ? 'No' : 'Cancel';
  cancel.onclick = () => {
    if (method === 'confirm') respond({ confirmed: false });
    else respond({ cancelled: true });
  };
  actions.appendChild(cancel);
  actions.appendChild(ok);
  backdrop.classList.remove('hidden');
  if (inputControl) inputControl.focus();
}

// ---------------- RPC event handling ----------------
function handleRpcEvent(ev) {
  switch (ev.type) {
    case 'agent_start':
      S.isStreaming = true;
      setAgentState('working…');
      updateComposerState();
      renderSidebar();
      break;

    case 'message_start':
      if (ev.message && ev.message.role === 'assistant' && !S.stream) beginAssistantStream();
      break;

    case 'message_update': {
      const d = ev.assistantMessageEvent;
      if (d && d.type === 'error') {
        addNotice('Generation error: ' + (d.error && d.error.message || 'unknown'));
        break;
      }
      // Rebuild from the full partial message (idempotent) — robust to joining
      // a session mid-stream where deltas alone would be incomplete.
      const msg = ev.message;
      if (!msg || msg.role !== 'assistant') break;
      if (!S.stream) beginAssistantStream();
      syncStreamFromMessage(msg);
      scheduleStreamRender();
      break;
    }

    case 'message_end':
      if (S.stream && ev.message && ev.message.role === 'assistant') {
        syncStreamFromMessage(ev.message);
      }
      endAssistantStream();
      break;

    case 'tool_execution_start':
      ensureToolCard(ev.toolCallId, ev.toolName, ev.args);
      break;

    case 'tool_execution_update': {
      const card = S.toolCards.get(ev.toolCallId);
      if (card && ev.partialResult) {
        const text = extractText(ev.partialResult.content);
        if (text) {
          card.out.classList.remove('hidden');
          card.outPre.textContent = text.length > 20000 ? text.slice(0, 20000) + '\n… [truncated]' : text;
          scrollBottom();
        }
      }
      break;
    }

    case 'tool_execution_end': {
      const card = S.toolCards.get(ev.toolCallId) || ensureToolCard(ev.toolCallId, ev.toolName, ev.args);
      toolResult(card, ev.result, ev.isError);
      break;
    }

    case 'agent_end':
      S.isStreaming = false;
      setAgentState('');
      endAssistantStream();
      updateComposerState();
      syncState();
      refreshSessions();
      break;

    case 'compaction_start':
      setAgentState('compacting context…');
      break;
    case 'compaction_end':
      setAgentState('');
      if (ev.aborted) addNotice('Compaction aborted');
      else if (!ev.result) addNotice('Compaction failed' + (ev.errorMessage ? ': ' + ev.errorMessage : ''));
      else addNotice('Context compacted');
      break;

    case 'auto_retry_start':
      setBanner(`Retrying (attempt ${ev.attempt}/${ev.maxAttempts}) - ${ev.errorMessage || ''}`);
      break;
    case 'auto_retry_end':
      if (ev.success) setBanner(null);
      else setBanner('Failed after retries: ' + (ev.finalError || ''), true);
      break;

    case 'session_action_update': {
      const a = ev.actions || {};
      const parts = [];
      if (a.steering && a.steering.length) parts.push(`${a.steering.length} steering`);
      if (a.followUps && a.followUps.length) parts.push(`${a.followUps.length} follow-up`);
      const hint = $('#queue-hint');
      if (parts.length) { hint.textContent = 'Queued: ' + parts.join(', '); hint.classList.remove('hidden'); }
      else hint.classList.add('hidden');
      break;
    }

    case 'extension_ui_request':
      handleExtensionUi(ev);
      break;

    case 'extension_error':
      addNotice('Extension error: ' + (ev.error || ''));
      break;
  }
}

// ---------------- sending ----------------
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  autoSize();

  const cmd = { type: 'prompt', message: text };
  if (S.isStreaming) cmd.streamingBehavior = 'steer';
  else addUserBubble(text);

  const r = await prime.command(cmd);
  if (!r.success) {
    setBanner('Prompt rejected: ' + (r.error || 'unknown'), true);
  }
}

async function stopGeneration() {
  await prime.command({ type: 'abort' });
  S.isStreaming = false;
  updateComposerState();
  setAgentState('');
}

// ---------------- composer ----------------
function autoSize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

inputEl.addEventListener('input', autoSize);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.onclick = sendMessage;
stopBtn.onclick = stopGeneration;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.picker-menu').forEach((m) => m.classList.add('hidden'));
    $('#modal-backdrop').classList.add('hidden');
  }
});

// ---------------- topbar wiring ----------------
$('#new-chat-btn').onclick = newSession;
$('#session-filter').addEventListener('input', renderSidebar);
$('#model-btn').onclick = async () => {
  if (!S.models.length) await loadModels();
  renderModelMenu();
  toggleMenu($('#model-menu'));
  $('#model-filter').focus();
};
$('#model-filter').addEventListener('input', renderModelMenu);
$('#thinking-btn').onclick = () => { renderThinkingMenu(); toggleMenu($('#thinking-menu')); };
document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) document.querySelectorAll('.picker-menu').forEach((m) => m.classList.add('hidden'));
});

let cwd = null;
$('#cwd-btn').onclick = async () => {
  const dir = await prime.pickDirectory();
  if (dir) {
    cwd = dir;
    $('#cwd-label').textContent = 'cwd: ' + dir;
    $('#cwd-btn').textContent = '📁 ' + baseName(dir);
    const r = await prime.restartRpc(dir);
    if (r.ok) { await newSession(); } else setBanner('Failed to restart agent in ' + dir, true);
  }
};

// ---------------- boot ----------------
prime.onRpcEvent(handleRpcEvent);
prime.onSessionsChanged((list) => refreshSessions(list));
prime.onFlushWait(() => setAgentState('saving session before switching…'));

// ---------------- menu actions & agent self-repair ----------------
function openProgressModal(titleText) {
  const backdrop = $('#modal-backdrop');
  $('#modal-title').textContent = titleText;
  const body = $('#modal-body');
  body.innerHTML = '<pre id="install-log" style="max-height:300px;overflow-y:auto;font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;color:var(--text-dim)"></pre>';
  const actions = $('#modal-actions');
  actions.innerHTML = '';
  backdrop.classList.remove('hidden');
  return body.querySelector('#install-log');
}

async function runAgentInstall(titleText) {
  const log = openProgressModal(titleText);
  const off = prime.onInstallProgress((line) => {
    log.textContent += line + '\n';
    log.scrollTop = log.scrollHeight;
  });
  const r = await prime.installAgent();
  off();
  const actions = $('#modal-actions');
  const close = document.createElement('button');
  close.className = r.ok ? 'primary' : 'secondary';
  close.textContent = 'Close';
  close.onclick = () => $('#modal-backdrop').classList.add('hidden');
  actions.appendChild(close);
  if (r.ok) {
    log.textContent += '\nDone — agent is ready.';
    await newSession();
    await loadModels();
  } else {
    log.textContent += '\nFailed: ' + (r.error || 'unknown error');
  }
}

async function runAgentRestart() {
  setBanner('Restarting agent…');
  const r = await prime.restartRpc();
  if (r.ok) { setBanner(null); await newSession(); }
  else setBanner('Restart failed: ' + (r.error || ''), true);
}


// ---------------- Settings panel ----------------
const BUILTIN_PROVIDERS = [
  ['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['google', 'Google Gemini'],
  ['xai', 'xAI'], ['groq', 'Groq'], ['mistral', 'Mistral'], ['deepseek', 'DeepSeek'],
  ['openrouter', 'OpenRouter'], ['cerebras', 'Cerebras'], ['fireworks', 'Fireworks'],
  ['huggingface', 'Hugging Face'], ['prime-inference', 'Prime Inference'],
  ['vercel-ai-gateway', 'Vercel AI Gateway'], ['zai', 'ZAI'],
  ['kimi-coding', 'Kimi For Coding'], ['minimax', 'MiniMax'], ['minimax-cn', 'MiniMax (China)'],
  ['xiaomi', 'Xiaomi MiMo'], ['xiaomi-token-plan-cn', 'Xiaomi Token Plan (CN)'],
  ['xiaomi-token-plan-ams', 'Xiaomi Token Plan (AMS)'], ['xiaomi-token-plan-sgp', 'Xiaomi Token Plan (SGP)'],
  ['opencode', 'OpenCode Zen'], ['opencode-go', 'OpenCode Go'],
  ['azure-openai-responses', 'Azure OpenAI Responses'],
  ['cloudflare-ai-gateway', 'Cloudflare AI Gateway'], ['cloudflare-workers-ai', 'Cloudflare Workers AI'],
  ['openai-codex', 'OpenAI Codex (subscription)'],
];
const API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];

let settingsDirty = false;

async function openSettings() {
  $('#settings-backdrop').classList.remove('hidden');
  await Promise.allSettled([renderProviderList(), renderCustomList(), renderDefaultsTab()]);
  $('#settings-foot').classList.toggle('hidden', !settingsDirty);
}
function closeSettings() { $('#settings-backdrop').classList.add('hidden'); }

function markSettingsDirty() {
  settingsDirty = true;
  $('#settings-foot').classList.remove('hidden');
}

// --- Providers tab ---
async function renderProviderList() {
  const cfg = await prime.readConfig();
  const host = $('#provider-list');
  host.innerHTML = '';
  const known = new Map(BUILTIN_PROVIDERS);
  // any extra keys in auth.json not in the built-in list (OAuth subs, mcp, etc.)
  for (const [p, info] of Object.entries(cfg.auth || {})) {
    if (!known.has(p)) known.set(p, p + (info.type !== 'api_key' ? ' (' + info.type + ')' : ''));
  }
  for (const [id, label] of known) {
    const info = (cfg.auth || {})[id];
    const row = document.createElement('div');
    row.className = 'provider-row';
    let status;
    if (id === 'xai') {
      const xs = await prime.xaiStatus();
      if (xs.connected) status = '<span class="p-status ok">connected via xAI subscription (OAuth)</span>';
    }
    if (!status) {
      status = info
        ? (info.type === 'api_key' ? `<span class="p-status ok">key saved ${esc(info.masked || '')}</span>` : `<span class="p-status ok">${esc(info.type)}</span>`)
        : '<span class="p-status">not configured</span>';
    }
    row.innerHTML = `<span class="p-name">${esc(label)}</span>${status}<span class="p-actions"></span>`;
    const actions = row.querySelector('.p-actions');
    if (!info || info.type === 'api_key') {
      if (id === 'xai') {
        const xs = await prime.xaiStatus();
        const oauthBtn = document.createElement('button');
        oauthBtn.className = 's-btn';
        oauthBtn.textContent = xs.connected ? 'Disconnect subscription' : 'Connect subscription…';
        oauthBtn.title = 'Use your xAI/Grok subscription via browser sign-in (like Hermes)';
        oauthBtn.onclick = () => xs.connected ? disconnectXai() : connectXai();
        actions.appendChild(oauthBtn);
      }
      const addModelBtn = document.createElement('button');
      addModelBtn.className = 's-btn';
      addModelBtn.textContent = 'Add model…';
      addModelBtn.title = 'Extend this provider with a model that is not in its built-in catalog';
      addModelBtn.onclick = () => {
        document.querySelector('.stab[data-tab="custom"]').click();
        openCustomForm(id, null, true);
      };
      actions.appendChild(addModelBtn);
      const addBtn = document.createElement('button');
      addBtn.className = 's-btn';
      addBtn.textContent = info ? 'Replace key' : 'Add key';
      addBtn.onclick = () => {
        const inp = document.createElement('input');
        inp.type = 'password'; inp.placeholder = 'paste API key'; inp.className = 'key-input';
        const save = document.createElement('button'); save.className = 's-btn primary'; save.textContent = 'Save';
        const cancel = document.createElement('button'); cancel.className = 's-btn'; cancel.textContent = '✕';
        actions.innerHTML = ''; actions.append(inp, save, cancel);
        inp.focus();
        const doSave = async () => {
          if (!inp.value.trim()) return;
          const r = await prime.setApiKey(id, inp.value.trim());
          if (r.ok) { markSettingsDirty(); renderProviderList(); }
          else setBanner('Failed to save key: ' + r.error, true);
        };
        save.onclick = doSave;
        inp.onkeydown = (e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') renderProviderList(); };
        cancel.onclick = () => renderProviderList();
      };
      actions.appendChild(addBtn);
      if (info) {
        const del = document.createElement('button');
        del.className = 's-btn danger'; del.textContent = 'Remove';
        del.onclick = async () => {
          if (!confirm('Remove the saved key for ' + label + '?')) return;
          await prime.deleteApiKey(id);
          markSettingsDirty(); renderProviderList();
        };
        actions.appendChild(del);
      }
    }
    host.appendChild(row);
  }
}

// --- Custom providers tab ---
async function renderCustomList() {
  const cfg = await prime.readConfig();
  const providers = (cfg.modelsJson && cfg.modelsJson.providers) || {};
  const host = $('#custom-list');
  host.innerHTML = '';
  for (const [id, p] of Object.entries(providers)) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = `<span class="p-name">${esc(id)}</span>
      <span class="p-status">${esc(p.baseUrl || '')} · ${(p.models || []).length} models</span>
      <span class="p-actions"></span>`;
    const actions = row.querySelector('.p-actions');
    const edit = document.createElement('button');
    edit.className = 's-btn'; edit.textContent = 'Edit';
    edit.onclick = () => openCustomForm(id, p);
    const del = document.createElement('button');
    del.className = 's-btn danger'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete custom provider ' + id + '?')) return;
      delete providers[id];
      const r = await prime.writeModels({ providers });
      if (r.ok) { markSettingsDirty(); renderCustomList(); }
      else setBanner('Save failed: ' + r.error, true);
    };
    actions.append(edit, del);
    host.appendChild(row);
  }
  if (!Object.keys(providers).length) {
    host.innerHTML = '<p class="s-help" style="padding:8px 0">No custom providers yet.</p>';
  }
}

function openCustomForm(editId, existing, isBuiltinExtension) {
  const form = $('#custom-form');
  form.classList.remove('hidden');
  const p = existing || {};
  const models = (p.models || []).map((m) => ({ ...m }));
  if (!models.length) models.push({ id: '' });
  form.innerHTML = `
    ${isBuiltinExtension ? `<p class="s-help">Adding models to built-in provider <b>${esc(editId)}</b> — they merge into its catalog and use its saved credentials. Only the model list is needed.</p>` : ''}
    <div class="s-field"><label>Provider ID (lowercase, no spaces)</label>
      <input id="cf-id" value="${esc(editId || '')}" ${editId ? 'disabled' : ''} placeholder="ollama" /></div>
    <div class="s-field ${isBuiltinExtension ? 'hidden' : ''}"><label>Base URL</label><input id="cf-baseurl" value="${esc(p.baseUrl || '')}" placeholder="http://localhost:11434/v1" /></div>
    <div class="s-field"><label>API type</label><select id="cf-api">${API_TYPES.map((a) => `<option ${p.api === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
    <div class="s-field"><label>API key <span class="s-dim">(literal, ENV_VAR name, or !shell command)</span></label>
      <input id="cf-apikey" value="${esc(p.apiKey || '')}" placeholder="sk-... or MY_ENV_VAR" /></div>
    <div class="s-field"><label><input type="checkbox" id="cf-authheader" ${p.authHeader ? 'checked' : ''} /> Send <code>Authorization: Bearer</code> header</label></div>
    <div class="s-field"><label>Models</label><div id="cf-models"></div>
      <button id="cf-add-model" class="s-btn">+ Add model</button></div>
    <div class="cf-actions">
      <button id="cf-save" class="s-btn primary">Save provider</button>
      <button id="cf-cancel" class="s-btn">Cancel</button>
    </div>`;

  const modelsHost = form.querySelector('#cf-models');
  function renderModelRows() {
    modelsHost.innerHTML = '';
    models.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'cf-model-row';
      row.innerHTML = `
        <input class="cm-id" placeholder="model id (required)" value="${esc(m.id || '')}" />
        <input class="cm-name" placeholder="display name" value="${esc(m.name || '')}" />
        <input class="cm-ctx" placeholder="ctx" value="${m.contextWindow || ''}" title="context window" />
        <label class="cm-reason"><input type="checkbox" class="cm-reasoning" ${m.reasoning ? 'checked' : ''} /> reasoning</label>
        <button class="s-btn danger cm-del">✕</button>`;
      row.querySelector('.cm-del').onclick = () => { models.splice(i, 1); renderModelRows(); };
      modelsHost.appendChild(row);
    });
  }
  renderModelRows();
  form.querySelector('#cf-add-model').onclick = () => {
    syncModelsFromRows();
    models.push({ id: '' });
    renderModelRows();
  };
  function syncModelsFromRows() {
    models.length = 0;
    for (const row of modelsHost.querySelectorAll('.cf-model-row')) {
      const id = row.querySelector('.cm-id').value.trim();
      const name = row.querySelector('.cm-name').value.trim();
      const ctx = parseInt(row.querySelector('.cm-ctx').value, 10);
      const reasoning = row.querySelector('.cm-reasoning').checked;
      const m = { id };
      if (name) m.name = name;
      if (!isNaN(ctx)) m.contextWindow = ctx;
      if (reasoning) m.reasoning = true;
      models.push(m);
    }
  }
  form.querySelector('#cf-cancel').onclick = () => form.classList.add('hidden');
  form.querySelector('#cf-save').onclick = async () => {
    syncModelsFromRows();
    const id = editId || form.querySelector('#cf-id').value.trim();
    const baseUrl = form.querySelector('#cf-baseurl').value.trim();
    const api = form.querySelector('#cf-api').value;
    const apiKey = form.querySelector('#cf-apikey').value.trim();
    const authHeader = form.querySelector('#cf-authheader').checked;
    if (!id || (!isBuiltinExtension && !baseUrl)) { setBanner('Provider ID and Base URL are required.', true); return; }
    if (!models.length || models.some((x) => !x.id)) { setBanner('Every model needs an id.', true); return; }
    const cfg = await prime.readConfig();
    const providers = (cfg.modelsJson && cfg.modelsJson.providers) || {};
    const prev = providers[id] || {};
    let entry;
    if (isBuiltinExtension) {
      // Merge: keep any existing override fields, upsert models by id
      const merged = [...(prev.models || [])];
      for (const m of models) {
        const ix = merged.findIndex((x) => x.id === m.id);
        if (ix >= 0) merged[ix] = m; else merged.push(m);
      }
      entry = { ...prev, models: merged };
    } else {
      entry = { baseUrl, api, apiKey: apiKey || 'none', models };
      if (authHeader) entry.authHeader = true;
    }
    providers[id] = entry;
    const r = await prime.writeModels({ providers });
    if (r.ok) { markSettingsDirty(); form.classList.add('hidden'); renderCustomList(); }
    else setBanner('Save failed: ' + r.error, true);
  };
}

// --- xAI OAuth (device code flow) ---
async function connectXai() {
  const log = openProgressModal('Connect xAI subscription');
  log.textContent = 'Requesting device code from xAI…\n';
  const off = prime.onXaiDeviceCode(({ userCode, verificationUri }) => {
    log.textContent = 'Your browser was opened to ' + verificationUri + '\n\nEnter this code:  ' + userCode + '\n\nWaiting for authorization…';
  });
  const r = await prime.xaiConnect();
  off();
  const actions = $('#modal-actions');
  const close = document.createElement('button');
  close.className = r.ok ? 'primary' : 'secondary';
  close.textContent = 'Close';
  close.onclick = () => $('#modal-backdrop').classList.add('hidden');
  actions.appendChild(close);
  if (r.ok) {
    log.textContent += '\nConnected. Grok models on your xAI subscription are now available.';
    markSettingsDirty();
    renderProviderList();
  } else {
    log.textContent += '\nFailed: ' + (r.error || 'unknown');
  }
}

async function disconnectXai() {
  if (!confirm('Disconnect the xAI subscription from Prime Agent?')) return;
  await prime.xaiDisconnect();
  markSettingsDirty();
  renderProviderList();
}

// --- Defaults tab ---
async function renderDefaultsTab() {
  const cfg = await prime.readConfig();
  const sel = $('#default-model-select');
  sel.innerHTML = '';
  const current = cfg.settings.defaultProvider && cfg.settings.defaultModel
    ? cfg.settings.defaultProvider + '/' + cfg.settings.defaultModel : '';
  for (const m of S.models) {
    const v = m.provider + '/' + m.id;
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  }
  if (cfg.settings.defaultThinkingLevel) $('#default-thinking-select').value = cfg.settings.defaultThinkingLevel;
}

$('#save-defaults-btn').onclick = async () => {
  const v = $('#default-model-select').value;
  const [provider, ...rest] = v.split('/');
  const r = await prime.writeSettings({
    defaultProvider: provider,
    defaultModel: rest.join('/'),
    defaultThinkingLevel: $('#default-thinking-select').value,
  });
  if (r.ok) setBanner('Defaults saved.');
  else setBanner('Save failed: ' + r.error, true);
};

// --- wiring ---
$('#settings-close').onclick = closeSettings;
$('#settings-backdrop').onclick = (e) => { if (e.target === $('#settings-backdrop')) closeSettings(); };
document.querySelectorAll('.stab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.stab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.stab-page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== b.dataset.tab));
  };
});
$('#add-provider-btn').onclick = () => openCustomForm(null, null);
$('#settings-restart').onclick = async () => {
  $('#settings-restart').textContent = 'Restarting…';
  const r = await prime.restartRpc();
  settingsDirty = false;
  $('#settings-foot').classList.add('hidden');
  $('#settings-restart').textContent = 'Restart agent';
  if (r.ok) {
    await Promise.allSettled([syncState(), loadModels()]);
    updateTopbar();
    closeSettings();
    setBanner('Agent restarted — provider changes applied.');
  } else setBanner('Restart failed: ' + (r.error || ''), true);
};

$('#settings-btn').onclick = openSettings;

prime.onMenuAction(({ id }) => {
  if (id === 'new-chat') newSession();
  else if (id === 'install-agent') runAgentInstall('Install Prime Agent');
  else if (id === 'update-agent') runAgentInstall('Update Prime Agent');
  else if (id === 'restart-agent') runAgentRestart();
  else if (id === 'open-settings') openSettings();
});
prime.onRpcError(({ message }) => {
  const notFound = /not found/i.test(message || '');
  setBanner(message || 'Agent process error.', true, notFound ? 'Install Agent' : 'Restart', async () => {
    setBanner(null);
    if (notFound) runAgentInstall('Install Prime Agent');
    else runAgentRestart();
  });
});
prime.onRpcExit(({ code, error }) => {
  setBanner(`${error || 'Agent process exited'} (code ${code}).`, true, 'Restart', async () => {
    setBanner(null);
    const r = await prime.restartRpc();
    if (r.ok) { await newSession(); } else setBanner('Restart failed: ' + (r.error || ''), true);
  });
});

(async function init() {
  // Each step is independent — one failure must not block the others.
  await refreshSessions();
  await Promise.allSettled([syncState(), loadModels()]);
  updateTopbar();
  const msgs = await prime.command({ type: 'get_messages' }).catch(() => null);
  if (msgs && msgs.success && msgs.data.messages.length) {
    renderHistory(msgs.data.messages, { dropInFlight: S.isStreaming });
  } else {
    showEmptyStateIfEmpty();
  }
  renderSidebar();
  inputEl.focus();
})();
