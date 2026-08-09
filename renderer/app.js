// Prime Desktop renderer v0.6 — multi-pane, multi-process sessions.
/* global prime, marked, DOMPurify */

marked.setOptions({ breaks: false, gfm: true });

// ---------------- utils ----------------
const $ = (sel, rootEl) => (rootEl || document).querySelector(sel);
const $$ = (sel, rootEl) => [...(rootEl || document).querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function md(text) { return DOMPurify.sanitize(marked.parse(text || '')); }
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
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}
function toolSummary(toolName, args) {
  if (!args) return '';
  const a = args;
  const val = a.command ?? a.code ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.message ?? a['sub-task'] ?? a.task ?? '';
  let s = typeof val === 'string' ? val : JSON.stringify(val);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

// ---------------- global state ----------------
const G = {
  sessions: [],
  pinnedPaths: new Set(),
  homeDir: null,
  panes: [],
  focused: null,
  extUiOwner: null, // pane that issued the current extension dialog
};

// ---------------- Pane ----------------
class Pane {
  constructor(index) {
    this.index = index;
    this.key = null;            // client key (sessionFile once mapped)
    this.sessionFile = null;
    this.cwd = null;
    this.model = null;
    this.thinkingLevel = null;
    this.isStreaming = false;
    this.stream = null;
    this.toolCards = new Map();
    this.ready = false;

    const tpl = $('#pane-template').content.cloneNode(true);
    this.el = tpl.querySelector('.pane');
    $('#panes').appendChild(this.el);
    this.titleEl = $('.pane-title', this.el);
    this.gitPill = $('.git-pill', this.el);
    this.bannerEl = $('.pane-banner', this.el);
    this.chatEl = $('.chat', this.el);
    this.scrollEl = $('.chat-scroll', this.el);
    this.emptyEl = $('.empty-state', this.el);
    this.inputEl = $('.input', this.el);
    this.sendBtn = $('.send-btn', this.el);
    this.stopBtn = $('.stop-btn', this.el);
    this.queueHint = $('.queue-hint', this.el);
    this.cwdLabel = $('.cwd-label', this.el);
    this.agentState = $('.agent-state', this.el);
    this.contextMeter = $('.context-meter', this.el);
    this.modelBtn = $('.model-btn', this.el);
    this.modelMenu = $('.model-menu', this.el);
    this.modelFilter = $('.model-filter', this.el);
    this.modelList = $('.model-list', this.el);
    this.thinkingBtn = $('.thinking-btn', this.el);
    this.thinkingMenu = $('.thinking-menu', this.el);
    this.closeBtn = $('.pane-close', this.el);

    this.el.addEventListener('mousedown', () => setFocusedPane(this));
    this.inputEl.addEventListener('input', () => this.autoSize());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.sendBtn.onclick = () => this.send();
    this.stopBtn.onclick = () => this.stop();
    this.modelBtn.onclick = async () => {
      if (!this.modelCache || !this.modelCache.length) await this.loadModels();
      this.renderModelMenu();
      toggleMenu(this.modelMenu);
      this.modelFilter.focus();
    };
    this.modelFilter.addEventListener('input', () => this.renderModelMenu());
    this.thinkingBtn.onclick = () => { this.renderThinkingMenu(); toggleMenu(this.thinkingMenu); };
    $('.pane-popout', this.el).onclick = () => prime.popOut(this.sessionFile || undefined);
    this.closeBtn.onclick = () => closePane(this);
  }

  // ---------- activation ----------
  async activate(sessionPath, cwd) {
    this.setBanner(null);
    const r = await prime.activate({ sessionPath: sessionPath || undefined, cwd: cwd || undefined });
    if (!r.ok) { this.setBanner('Could not start session: ' + (r.error || 'unknown'), true); return false; }
    this.key = r.key;
    this.sessionFile = r.sessionFile || sessionPath || null;
    await this.syncState();
    const msgs = await prime.command(this.key, { type: 'get_messages' });
    if (msgs.success) this.renderHistory(msgs.data.messages, { dropInFlight: this.isStreaming });
    this.ready = true;
    renderSidebar();
    return true;
  }

  async newChat(cwd) {
    // Fresh agent process on a brand-new session
    return this.activate(null, cwd || this.cwd);
  }

  async syncState() {
    if (!this.key) return;
    const r = await prime.command(this.key, { type: 'get_state' });
    if (!r.success) return;
    const d = r.data;
    this.sessionFile = d.sessionFile || this.sessionFile;
    this.model = d.model || null;
    this.thinkingLevel = d.thinkingLevel || null;
    this.isStreaming = !!d.isStreaming;
    this.updateTopbar();
    this.updateComposer();
    const st = await prime.command(this.key, { type: 'get_session_stats' });
    if (st.success && st.data.contextUsage && st.data.contextUsage.percent != null) {
      this.contextMeter.textContent = `${Math.round(st.data.contextUsage.percent)}% ctx · $${(st.data.cost || 0).toFixed(3)}`;
    } else this.contextMeter.textContent = '';
    this.refreshGitPill();
  }

  async refreshGitPill() {
    const s = G.sessions.find((x) => x.path === this.sessionFile);
    const dir = (s && s.cwd) || this.cwd;
    if (!dir) { this.gitPill.classList.add('hidden'); return; }
    this.cwd = dir;
    const g = await prime.gitInfo(dir);
    if (g.ok && g.branch) {
      this.gitPill.textContent = `⑂ ${g.branch}${g.dirty ? ' ±' + g.dirty : ''}`;
      this.gitPill.title = g.root + (g.dirty ? ` — ${g.dirty} uncommitted` : ' — clean');
      this.gitPill.classList.remove('hidden');
    } else {
      this.gitPill.textContent = baseName(dir);
      this.gitPill.title = dir;
      this.gitPill.classList.remove('hidden');
    }
    this.cwdLabel.textContent = 'cwd: ' + dir;
  }

  updateTopbar() {
    const s = G.sessions.find((x) => x.path === this.sessionFile);
    this.titleEl.textContent = s ? (s.name || s.preview || 'Untitled session') : 'New session';
    this.modelBtn.textContent = this.model ? `${this.model.provider}/${this.model.id} ▾` : '… ▾';
    this.thinkingBtn.textContent = `thinking: ${this.thinkingLevel || 'off'} ▾`;
  }

  updateComposer() {
    this.stopBtn.classList.toggle('hidden', !this.isStreaming);
    this.inputEl.placeholder = this.isStreaming
      ? 'Agent is working - type to steer it…'
      : 'Message Prime Agent…  (Enter to send, Shift+Enter for newline)';
  }

  setBanner(text, isError) {
    if (!text) { this.bannerEl.classList.add('hidden'); return; }
    this.bannerEl.classList.remove('hidden');
    this.bannerEl.classList.toggle('error', !!isError);
    this.bannerEl.textContent = text;
  }
  setAgentState(text) { this.agentState.textContent = text || ''; }

  autoSize() {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
  }
  nearBottom() { return this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 120; }
  scrollBottom(force) { if (force || this.nearBottom()) this.scrollEl.scrollTop = this.scrollEl.scrollHeight; }
  hideEmpty() { this.emptyEl.classList.add('hidden'); }
  showEmptyIfEmpty() { this.emptyEl.classList.toggle('hidden', this.chatEl.children.length > 0); }

  // ---------- sending ----------
  async send() {
    const text = this.inputEl.value.trim();
    if (!text || !this.key) return;
    this.inputEl.value = '';
    this.autoSize();
    const cmd = { type: 'prompt', message: text };
    if (this.isStreaming) cmd.streamingBehavior = 'steer';
    else this.addUserBubble(text);
    const r = await prime.command(this.key, cmd);
    if (!r.success) this.setBanner('Prompt rejected: ' + (r.error || 'unknown'), true);
  }

  async stop() {
    if (!this.key) return;
    await prime.command(this.key, { type: 'abort' });
    this.isStreaming = false;
    this.updateComposer();
    this.setAgentState('');
  }

  // ---------- rendering ----------
  addUserBubble(text) {
    this.hideEmpty();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.innerHTML = `<div class="msg-role">You</div><div class="msg-body">${esc(text)}</div>`;
    this.chatEl.appendChild(div);
    this.scrollBottom(true);
  }
  addNotice(text) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.textContent = text;
    this.chatEl.appendChild(div);
    this.scrollBottom();
  }

  beginStream() {
    this.hideEmpty();
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    msg.innerHTML = `<div class="msg-role">Prime Agent</div><div class="msg-body"></div>`;
    this.chatEl.appendChild(msg);
    this.stream = { root: msg.querySelector('.msg-body'), blocks: new Map(), rafPending: false };
    this.scrollBottom();
  }
  streamBlock(idx, kind) {
    const st = this.stream;
    if (!st.blocks.has(idx)) {
      let el;
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
      st.blocks.set(idx, { kind, el, raw: '' });
    }
    return st.blocks.get(idx);
  }
  syncStreamFromMessage(msg) {
    for (let i = 0; i < (msg.content || []).length; i++) {
      const c = msg.content[i];
      if (c.type === 'text' && c.text) { const b = this.streamBlock(i, 'text'); b.raw = c.text; }
      else if (c.type === 'thinking' && c.thinking) { const b = this.streamBlock(i, 'thinking'); b.raw = c.thinking; }
      else if (c.type === 'toolCall') this.ensureToolCard(c.id, c.name, c.arguments);
    }
  }
  renderStreamBlock(block) {
    if (block.kind === 'thinking') {
      block.el._body.textContent = block.raw;
      block.el.querySelector('summary').textContent = 'Thinking';
    } else block.el.innerHTML = md(block.raw);
  }
  scheduleStreamRender() {
    const st = this.stream;
    if (!st || st.rafPending) return;
    st.rafPending = true;
    requestAnimationFrame(() => {
      st.rafPending = false;
      for (const b of st.blocks.values()) this.renderStreamBlock(b);
      this.scrollBottom();
    });
  }
  endStream() {
    if (!this.stream) return;
    for (const b of this.stream.blocks.values()) this.renderStreamBlock(b);
    this.stream = null;
    this.scrollBottom();
  }

  ensureToolCard(toolCallId, toolName, args) {
    this.hideEmpty();
    let card = this.toolCards.get(toolCallId);
    if (card) return card;
    const host = (this.stream && this.stream.root) || this.chatEl;
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
    this.toolCards.set(toolCallId, card);
    this.scrollBottom();
    return card;
  }
  toolResult(card, result, isError) {
    card.dot.className = 'tool-dot ' + (isError ? 'err' : 'ok');
    const text = extractText(result && result.content);
    if (text) {
      card.out.classList.remove('hidden');
      card.outPre.textContent = text.length > 20000 ? text.slice(0, 20000) + '\n… [truncated]' : text;
    }
    this.scrollBottom();
  }

  renderHistory(messages, opts) {
    this.chatEl.innerHTML = '';
    this.toolCards.clear();
    this.endStream();
    let list = messages || [];
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
        if (text) this.addUserBubble(text);
      } else if (m.role === 'assistant') {
        this.hideEmpty();
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
            this.chatEl.appendChild(div);
            this.ensureToolCard(c.id, c.name, c.arguments);
          }
        }
        if (!div.isConnected) this.chatEl.appendChild(div);
      } else if (m.role === 'toolResult') {
        const card = this.toolCards.get(m.toolCallId) || this.ensureToolCard(m.toolCallId, m.toolName, null);
        this.toolResult(card, m, m.isError);
        card.el.classList.remove('open');
      } else if (m.role === 'bashExecution') {
        const card = this.ensureToolCard('bash-' + (m.timestamp || Math.random()), 'bash', { command: m.command });
        this.toolResult(card, { content: [{ type: 'text', text: m.output || '' }] }, (m.exitCode || 0) !== 0);
        card.el.classList.remove('open');
      } else if (m.role === 'compactionSummary') {
        this.addNotice('Context compacted - earlier messages summarized');
      }
    }
    this.showEmptyIfEmpty();
    this.scrollBottom(true);
  }

  // ---------- pickers ----------
  async loadModels() {
    if (!this.key) return;
    const r = await prime.command(this.key, { type: 'get_available_models' });
    if (r.success) this.modelCache = r.data.models || [];
  }
  renderModelMenu() {
    const filter = this.modelFilter.value.trim().toLowerCase();
    const host = this.modelList;
    host.innerHTML = '';
    const groups = new Map();
    for (const m of (this.modelCache || [])) {
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
        const cur = this.model && this.model.provider === m.provider && this.model.id === m.id;
        item.className = 'model-item' + (cur ? ' current' : '');
        item.innerHTML = `<span>${esc(m.name || m.id)}</span><span class="m-id">${esc(m.id)}</span>`;
        item.onclick = async () => {
          toggleMenu(this.modelMenu, false);
          const r = await prime.command(this.key, { type: 'set_model', provider: m.provider, modelId: m.id });
          if (r.success) { this.model = r.data; this.updateTopbar(); }
          else this.setBanner('Model switch failed: ' + (r.error || ''), true);
        };
        host.appendChild(item);
      }
    }
  }
  renderThinkingMenu() {
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    const host = this.thinkingMenu;
    host.innerHTML = '';
    for (const lv of levels) {
      const item = document.createElement('div');
      item.className = 'model-item' + (this.thinkingLevel === lv ? ' current' : '');
      item.innerHTML = `<span>${lv}</span>`;
      item.onclick = async () => {
        toggleMenu(host, false);
        const r = await prime.command(this.key, { type: 'set_thinking_level', level: lv });
        if (r.success) { this.thinkingLevel = lv; this.updateTopbar(); this.syncState(); }
        else this.setBanner('Thinking level failed: ' + (r.error || ''), true);
      };
      host.appendChild(item);
    }
  }

  // ---------- event handling ----------
  handleEvent(ev) {
    switch (ev.type) {
      case 'agent_start':
        this.isStreaming = true;
        this.setAgentState('working…');
        this.updateComposer();
        renderSidebar();
        break;
      case 'message_start':
        if (ev.message && ev.message.role === 'assistant' && !this.stream) this.beginStream();
        break;
      case 'message_update': {
        const d = ev.assistantMessageEvent;
        if (d && d.type === 'error') { this.addNotice('Generation error: ' + (d.error && d.error.message || 'unknown')); break; }
        const msg = ev.message;
        if (!msg || msg.role !== 'assistant') break;
        if (!this.stream) this.beginStream();
        this.syncStreamFromMessage(msg);
        this.scheduleStreamRender();
        break;
      }
      case 'message_end':
        if (this.stream && ev.message && ev.message.role === 'assistant') this.syncStreamFromMessage(ev.message);
        this.endStream();
        break;
      case 'tool_execution_start':
        this.ensureToolCard(ev.toolCallId, ev.toolName, ev.args);
        break;
      case 'tool_execution_update': {
        const card = this.toolCards.get(ev.toolCallId);
        if (card && ev.partialResult) {
          const text = extractText(ev.partialResult.content);
          if (text) {
            card.out.classList.remove('hidden');
            card.outPre.textContent = text.length > 20000 ? text.slice(0, 20000) + '\n… [truncated]' : text;
            this.scrollBottom();
          }
        }
        break;
      }
      case 'tool_execution_end': {
        const card = this.toolCards.get(ev.toolCallId) || this.ensureToolCard(ev.toolCallId, ev.toolName, ev.args);
        this.toolResult(card, ev.result, ev.isError);
        break;
      }
      case 'agent_end':
        this.isStreaming = false;
        this.setAgentState('');
        this.endStream();
        this.updateComposer();
        this.syncState();
        refreshSessions();
        break;
      case 'compaction_start': this.setAgentState('compacting context…'); break;
      case 'compaction_end':
        this.setAgentState('');
        if (ev.aborted) this.addNotice('Compaction aborted');
        else if (!ev.result) this.addNotice('Compaction failed' + (ev.errorMessage ? ': ' + ev.errorMessage : ''));
        else this.addNotice('Context compacted');
        break;
      case 'auto_retry_start': this.setBanner(`Retrying (attempt ${ev.attempt}/${ev.maxAttempts})`); break;
      case 'auto_retry_end':
        if (ev.success) this.setBanner(null);
        else this.setBanner('Failed after retries: ' + (ev.finalError || ''), true);
        break;
      case 'session_action_update': {
        const a = ev.actions || {};
        const parts = [];
        if (a.steering && a.steering.length) parts.push(`${a.steering.length} steering`);
        if (a.followUps && a.followUps.length) parts.push(`${a.followUps.length} follow-up`);
        if (parts.length) { this.queueHint.textContent = 'Queued: ' + parts.join(', '); this.queueHint.classList.remove('hidden'); }
        else this.queueHint.classList.add('hidden');
        break;
      }
      case 'extension_ui_request':
        handleExtensionUi(this, ev);
        break;
      case 'extension_error':
        this.addNotice('Extension error: ' + (ev.error || ''));
        break;
    }
  }
}

// ---------------- pane management ----------------
function setFocusedPane(pane) {
  G.focused = pane;
  for (const p of G.panes) p.el.classList.toggle('focused', p === pane);
}

function toggleMenu(menu, show) {
  $$('.picker-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
  menu.classList.toggle('hidden', show === undefined ? undefined : !show);
}

async function createPane(index, sessionPath, cwd) {
  const pane = new Pane(index);
  G.panes.push(pane);
  if (index > 0) {
    pane.closeBtn.classList.remove('hidden');
    document.body.classList.add('split');
  }
  setFocusedPane(pane);
  await pane.activate(sessionPath || null, cwd);
  return pane;
}

async function closePane(pane) {
  if (G.panes.length <= 1) return;
  G.panes = G.panes.filter((p) => p !== pane);
  pane.el.remove();
  if (!G.panes.some((p) => p.index > 0)) document.body.classList.remove('split');
  setFocusedPane(G.panes[G.panes.length - 1]);
  // pane's agent process keeps running in the background by design
}

async function splitWithSession(sessionPath) {
  if (G.panes.length >= 2) { G.focused.setBanner('Two panes max for now.'); return; }
  await createPane(1, sessionPath);
}

// ---------------- extension UI dialogs ----------------
function handleExtensionUi(pane, req) {
  const { id, method } = req;
  if (method === 'notify') {
    pane.setBanner(req.message || '', req.notifyType === 'error');
    if (req.notifyType !== 'error') setTimeout(() => pane.setBanner(null), 5000);
    return;
  }
  if (method === 'setTitle') { document.title = req.title || 'Prime Agent'; return; }
  if (method === 'setStatus' || method === 'setWidget' || method === 'set_editor_text') {
    if (method === 'set_editor_text' && typeof req.text === 'string') { pane.inputEl.value = req.text; pane.autoSize(); }
    if (method === 'setStatus') pane.setAgentState(req.statusText || '');
    return;
  }
  G.extUiOwner = pane;
  const backdrop = $('#modal-backdrop');
  const title = $('#modal-title');
  const body = $('#modal-body');
  const actions = $('#modal-actions');
  title.textContent = req.title || method;
  body.innerHTML = '';
  actions.innerHTML = '';
  const close = () => backdrop.classList.add('hidden');
  const respond = (payload) => { prime.command(pane.key, { type: 'extension_ui_response', id, ...payload }); close(); };

  let inputControl = null;
  if (method === 'confirm') body.innerHTML = `<div>${esc(req.message || '')}</div>`;
  else if (method === 'select') {
    const sel = document.createElement('select');
    for (const opt of req.options || []) { const o = document.createElement('option'); o.value = opt; o.textContent = opt; sel.appendChild(o); }
    body.appendChild(sel); inputControl = sel;
  } else if (method === 'input') {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = req.placeholder || '';
    body.appendChild(inp); inputControl = inp;
  } else if (method === 'editor') {
    const ta = document.createElement('textarea');
    ta.value = req.prefill || '';
    body.appendChild(ta); inputControl = ta;
  } else return;

  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = method === 'confirm' ? 'Confirm' : 'OK';
  ok.onclick = () => { if (method === 'confirm') respond({ confirmed: true }); else respond({ value: inputControl ? inputControl.value : '' }); };
  const cancel = document.createElement('button');
  cancel.className = 'secondary';
  cancel.textContent = method === 'confirm' ? 'No' : 'Cancel';
  cancel.onclick = () => { if (method === 'confirm') respond({ confirmed: false }); else respond({ cancelled: true }); };
  actions.appendChild(cancel);
  actions.appendChild(ok);
  backdrop.classList.remove('hidden');
  if (inputControl) inputControl.focus();
}

// ---------------- sidebar ----------------
async function refreshSessions(list) {
  G.sessions = list || (await prime.listSessions());
  renderSidebar();
  for (const p of G.panes) p.updateTopbar();
}

function renderSidebar() {
  const filter = $('#session-filter').value.trim().toLowerCase();
  const host = $('#session-list');
  host.innerHTML = '';
  const activeFiles = new Set(G.panes.map((p) => p.sessionFile).filter(Boolean));
  const matches = (s) => {
    const label = s.name || s.preview || 'Untitled session';
    return !filter || label.toLowerCase().includes(filter) || (s.cwd || '').toLowerCase().includes(filter);
  };
  const pinned = G.sessions.filter((s) => G.pinnedPaths.has(s.path) && matches(s));
  const rest = G.sessions.filter((s) => !G.pinnedPaths.has(s.path) && matches(s));

  const makeItem = (s) => {
    const label = s.name || s.preview || 'Untitled session';
    const paneHere = G.panes.find((p) => p.sessionFile === s.path);
    const item = document.createElement('div');
    item.className = 'session-item' + (paneHere ? ' active' : '');
    item.innerHTML = `
      <div class="s-name">${(paneHere && paneHere.isStreaming) ? '<span class="live-dot"></span>' : ''}${esc(label)}</div>
      <div class="s-meta">${esc(baseName(s.cwd))} · ${relTime(s.updatedAt)} · ${s.messageCount} msgs</div>
      <div class="s-actions">
        <button class="s-act s-split" title="Open in second pane">⫿</button>
        <button class="s-act s-pin ${G.pinnedPaths.has(s.path) ? 'pinned' : ''}" title="${G.pinnedPaths.has(s.path) ? 'Unpin' : 'Pin'} session">⌃</button>
        <button class="s-act s-edit" title="Rename session">✎</button>
        <button class="s-act s-delete" title="Delete session">✕</button>
      </div>`;
    item.onclick = (e) => {
      if (e.shiftKey) { togglePin(s.path); return; }
      if (paneHere) { setFocusedPane(paneHere); return; }
      G.focused.activate(s.path);
    };
    item.querySelector('.s-name').ondblclick = (e) => { e.stopPropagation(); startRename(item, s); };
    item.querySelector('.s-split').onclick = (e) => { e.stopPropagation(); splitWithSession(s.path); };
    item.querySelector('.s-pin').onclick = (e) => { e.stopPropagation(); togglePin(s.path); };
    item.querySelector('.s-edit').onclick = (e) => { e.stopPropagation(); startRename(item, s); };
    item.querySelector('.s-delete').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this session? This cannot be undone.')) return;
      await prime.deleteSession(s.path);
      if (G.pinnedPaths.has(s.path)) { G.pinnedPaths.delete(s.path); await prime.writePrefs({ pins: [...G.pinnedPaths] }); }
      const pane = G.panes.find((p) => p.sessionFile === s.path);
      if (pane) await pane.newChat();
      refreshSessions();
    };
    return item;
  };

  if (pinned.length) {
    const l = document.createElement('div'); l.className = 'section-label'; l.textContent = 'PINNED';
    host.appendChild(l);
    pinned.forEach((s) => host.appendChild(makeItem(s)));
    const l2 = document.createElement('div'); l2.className = 'section-label'; l2.textContent = 'SESSIONS';
    host.appendChild(l2);
  }
  rest.forEach((s) => host.appendChild(makeItem(s)));
  renderSubagents();
}

async function loadPins() {
  const prefs = await prime.getPrefs();
  G.pinnedPaths = new Set(prefs.pins || []);
  G.homeDir = prefs.home || null;
}
async function togglePin(sessionPath) {
  if (G.pinnedPaths.has(sessionPath)) G.pinnedPaths.delete(sessionPath);
  else G.pinnedPaths.add(sessionPath);
  await prime.writePrefs({ pins: [...G.pinnedPaths] });
  renderSidebar();
}

async function startRename(item, session) {
  const nameEl = item.querySelector('.s-name');
  const current = session.name || '';
  const inp = document.createElement('input');
  inp.className = 'rename-input';
  inp.value = current;
  inp.placeholder = session.preview || 'Session name';
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = async () => {
    const v = inp.value.trim();
    if (v && v !== current) {
      const pane = G.panes.find((p) => p.sessionFile === session.path) || G.focused;
      const wasOnTarget = pane.sessionFile === session.path;
      if (!wasOnTarget) await pane.activate(session.path);
      await prime.command(pane.key, { type: 'set_session_name', name: v });
      if (!wasOnTarget) { /* leave pane on the renamed session — harmless */ }
      await pane.syncState();
      const msgs = await prime.command(pane.key, { type: 'get_messages' });
      if (msgs.success) pane.renderHistory(msgs.data.messages, { dropInFlight: pane.isStreaming });
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

// ---------------- subagents (near-live) ----------------
function renderSubagents() {
  const activeFiles = new Set(G.panes.map((p) => p.sessionFile).filter(Boolean));
  const subs = G.sessions.filter((s) => s.parentSession && activeFiles.has(s.parentSession)).slice(0, 20);
  const sec = $('#subagent-section');
  if (!subs.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  const host = $('#subagent-list');
  host.innerHTML = '';
  for (const s of subs) {
    const item = document.createElement('div');
    item.className = 'session-item subagent-item';
    const label = s.name || s.preview || ('subagent depth ' + s.rlmDepth);
    item.innerHTML = `
      <div class="s-name"><span class="sub-dot"></span>${esc(label)}</div>
      <div class="s-meta">depth ${s.rlmDepth} · ${relTime(s.updatedAt)} · ${s.messageCount} msgs</div>`;
    item.onclick = () => openSubagentViewer(s);
    host.appendChild(item);
  }
}

let subagentPoll = null;
async function openSubagentViewer(session) {
  $('#viewer-title').textContent = 'Subagent — ' + (session.name || session.id.slice(0, 8)) + ' (live)';
  $('#viewer-backdrop').classList.remove('hidden');
  const body = $('#viewer-body');
  const render = async () => {
    const r = await prime.sessionTail(session.path, 60);
    if (!r.ok) return;
    body.innerHTML = '';
    if (!r.messages.length) body.innerHTML = '<p class="s-help">No messages yet.</p>';
    for (const msg of r.messages) {
      const div = document.createElement('div');
      div.className = 'viewer-msg';
      div.innerHTML = `<div class="vm-role">${esc(msg.role)}</div><div class="vm-text">${esc(msg.text)}</div>`;
      body.appendChild(div);
    }
    body.scrollTop = body.scrollHeight;
  };
  await render();
  clearInterval(subagentPoll);
  subagentPoll = setInterval(() => {
    if ($('#viewer-backdrop').classList.contains('hidden')) { clearInterval(subagentPoll); return; }
    render();
  }, 2000);
}

// ---------------- file tree ----------------
let treeVisible = false, treeRoot = null;
async function toggleTree() {
  treeVisible = !treeVisible;
  $('#tree-panel').classList.toggle('hidden', !treeVisible);
  if (treeVisible) {
    const active = G.sessions.find((s) => s.path === (G.focused && G.focused.sessionFile));
    treeRoot = (active && active.cwd) || (G.focused && G.focused.cwd) || G.homeDir;
    if (!treeRoot) { treeVisible = false; $('#tree-panel').classList.add('hidden'); return; }
    $('#tree-root-label').textContent = baseName(treeRoot);
    $('#tree-root-label').title = treeRoot;
    renderTreeLevel($('#tree-body'), treeRoot);
  }
}
async function renderTreeLevel(container, dirPath) {
  container.innerHTML = '<div class="tree-loading">…</div>';
  const r = await prime.listDir(dirPath);
  container.innerHTML = '';
  if (!r.ok) { container.innerHTML = '<div class="tree-loading">error</div>'; return; }
  for (const e of r.entries) {
    const row = document.createElement('div');
    row.className = 'tree-row ' + e.type;
    row.innerHTML = `<span class="tree-icon">${e.type === 'dir' ? '▸' : '·'}</span><span class="tree-name">${esc(e.name)}</span>`;
    if (e.type === 'dir') {
      row.onclick = async () => {
        if (row.dataset.open === '1') {
          row.dataset.open = '0';
          row.querySelector('.tree-icon').textContent = '▸';
          row.nextElementSibling && row.nextElementSibling.remove();
          return;
        }
        row.dataset.open = '1';
        row.querySelector('.tree-icon').textContent = '▾';
        const child = document.createElement('div');
        child.className = 'tree-children';
        row.after(child);
        renderTreeLevel(child, e.path);
      };
    } else row.onclick = () => openFileViewer(e.path);
    container.appendChild(row);
  }
  if (!r.entries.length) container.innerHTML = '<div class="tree-loading">empty</div>';
}
async function openFileViewer(p) {
  $('#viewer-title').textContent = p.split('/').pop();
  const body = $('#viewer-body');
  body.innerHTML = '<p class="s-help">Loading…</p>';
  $('#viewer-backdrop').classList.remove('hidden');
  const r = await prime.readFile(p, 200000);
  if (!r.ok) {
    if (r.binary) {
      body.innerHTML = '<p class="s-help">Binary file.</p>';
      const b = document.createElement('button');
      b.className = 's-btn primary';
      b.textContent = 'Open in Finder/default app';
      b.onclick = () => { prime.openPath(p); $('#viewer-backdrop').classList.add('hidden'); };
      body.appendChild(b);
    } else body.innerHTML = '<p class="s-help">Cannot read: ' + esc(r.error || '') + '</p>';
    return;
  }
  const pre = document.createElement('pre');
  pre.className = 'viewer-pre';
  pre.textContent = r.text + (r.truncated ? '\n\n… [truncated]' : '');
  body.innerHTML = '';
  body.appendChild(pre);
}

// ---------------- restart helpers ----------------
async function restartAllAgents() {
  const snapshot = G.panes.map((p) => ({ pane: p, sessionFile: p.sessionFile, cwd: p.cwd }));
  await prime.killAllAgents();
  for (const { pane, sessionFile, cwd } of snapshot) {
    pane.key = null; pane.ready = false; pane.isStreaming = false;
    await pane.activate(sessionFile || null, cwd);
  }
  renderSidebar();
}

// ---------------- settings panel ----------------
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
function markSettingsDirty() { settingsDirty = true; $('#settings-foot').classList.remove('hidden'); }

async function renderProviderList() {
  const cfg = await prime.readConfig();
  const host = $('#provider-list');
  host.innerHTML = '';
  const known = new Map(BUILTIN_PROVIDERS);
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
    if (id === 'xai') {
      const xs = await prime.xaiStatus();
      const oauthBtn = document.createElement('button');
      oauthBtn.className = 's-btn';
      oauthBtn.textContent = xs.connected ? 'Disconnect subscription' : 'Connect subscription…';
      oauthBtn.onclick = () => xs.connected ? disconnectXai() : connectXai();
      actions.appendChild(oauthBtn);
    }
    if (!info || info.type === 'api_key') {
      const addModelBtn = document.createElement('button');
      addModelBtn.className = 's-btn';
      addModelBtn.textContent = 'Add model…';
      addModelBtn.title = 'Extend this provider with a model that is not in its built-in catalog';
      addModelBtn.onclick = () => { document.querySelector('.stab[data-tab="custom"]').click(); openCustomForm(id, null, true); };
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
          else alert('Failed to save key: ' + r.error);
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
    edit.onclick = () => openCustomForm(id, p, false);
    const del = document.createElement('button');
    del.className = 's-btn danger'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete custom provider ' + id + '?')) return;
      delete providers[id];
      const r = await prime.writeModels({ providers });
      if (r.ok) { markSettingsDirty(); renderCustomList(); }
      else alert('Save failed: ' + r.error);
    };
    actions.append(edit, del);
    host.appendChild(row);
  }
  if (!Object.keys(providers).length) host.innerHTML = '<p class="s-help" style="padding:8px 0">No custom providers yet.</p>';
}

function openCustomForm(editId, existing, isBuiltinExtension) {
  const form = $('#custom-form');
  form.classList.remove('hidden');
  const p = existing || {};
  const models = (p.models || []).map((m) => ({ ...m }));
  if (!models.length) models.push({ id: '' });
  form.innerHTML = `
    ${isBuiltinExtension ? `<p class="s-help">Adding models to built-in provider <b>${esc(editId)}</b> — they merge into its catalog and use its saved credentials.</p>` : ''}
    <div class="s-field"><label>Provider ID (lowercase, no spaces)</label>
      <input id="cf-id" value="${esc(editId || '')}" ${editId ? 'disabled' : ''} placeholder="ollama" /></div>
    <div class="s-field ${isBuiltinExtension ? 'hidden' : ''}"><label>Base URL</label><input id="cf-baseurl" value="${esc(p.baseUrl || '')}" placeholder="http://localhost:11434/v1" /></div>
    <div class="s-field ${isBuiltinExtension ? 'hidden' : ''}"><label>API type</label><select id="cf-api">${API_TYPES.map((a) => `<option ${p.api === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
    <div class="s-field ${isBuiltinExtension ? 'hidden' : ''}"><label>API key <span class="s-dim">(literal, ENV_VAR name, or !shell command)</span></label>
      <input id="cf-apikey" value="${esc(p.apiKey || '')}" placeholder="sk-... or MY_ENV_VAR" /></div>
    <div class="s-field ${isBuiltinExtension ? 'hidden' : ''}"><label><input type="checkbox" id="cf-authheader" ${p.authHeader ? 'checked' : ''} /> Send <code>Authorization: Bearer</code> header</label></div>
    <div class="s-field"><label>Models</label><div id="cf-models"></div>
      <button id="cf-add-model" class="s-btn">+ Add model</button></div>
    <div class="cf-actions">
      <button id="cf-save" class="s-btn primary">Save provider</button>
      <button id="cf-cancel" class="s-btn">Cancel</button>
    </div>`;
  const modelsHost = form.querySelector('#cf-models');
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
  form.querySelector('#cf-add-model').onclick = () => { syncModelsFromRows(); models.push({ id: '' }); renderModelRows(); };
  form.querySelector('#cf-cancel').onclick = () => form.classList.add('hidden');
  form.querySelector('#cf-save').onclick = async () => {
    syncModelsFromRows();
    const id = editId || form.querySelector('#cf-id').value.trim();
    const baseUrl = form.querySelector('#cf-baseurl').value.trim();
    const api = form.querySelector('#cf-api').value;
    const apiKey = form.querySelector('#cf-apikey').value.trim();
    const authHeader = form.querySelector('#cf-authheader').checked;
    if (!id || (!isBuiltinExtension && !baseUrl)) { alert('Provider ID and Base URL are required.'); return; }
    if (!models.length || models.some((x) => !x.id)) { alert('Every model needs an id.'); return; }
    const cfg = await prime.readConfig();
    const providers = (cfg.modelsJson && cfg.modelsJson.providers) || {};
    const prev = providers[id] || {};
    let entry;
    if (isBuiltinExtension) {
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
    else alert('Save failed: ' + r.error);
  };
}

async function renderDefaultsTab() {
  const cfg = await prime.readConfig();
  const sel = $('#default-model-select');
  sel.innerHTML = '';
  const current = cfg.settings.defaultProvider && cfg.settings.defaultModel
    ? cfg.settings.defaultProvider + '/' + cfg.settings.defaultModel : '';
  const pane = G.focused;
  if (pane && (!pane.modelCache || !pane.modelCache.length)) await pane.loadModels();
  for (const m of (pane && pane.modelCache) || []) {
    const v = m.provider + '/' + m.id;
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  }
  if (cfg.settings.defaultThinkingLevel) $('#default-thinking-select').value = cfg.settings.defaultThinkingLevel;
}

// xAI flows
function openProgressModal(titleText) {
  const backdrop = $('#modal-backdrop');
  $('#modal-title').textContent = titleText;
  const body = $('#modal-body');
  body.innerHTML = '<pre id="install-log" style="max-height:300px;overflow-y:auto;font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;color:var(--text-dim)"></pre>';
  $('#modal-actions').innerHTML = '';
  backdrop.classList.remove('hidden');
  return body.querySelector('#install-log');
}
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
  if (r.ok) { log.textContent += '\nConnected. Grok models on your xAI subscription are now available.'; markSettingsDirty(); renderProviderList(); }
  else log.textContent += '\nFailed: ' + (r.error || 'unknown');
}
async function disconnectXai() {
  if (!confirm('Disconnect the xAI subscription from Prime Agent?')) return;
  await prime.xaiDisconnect();
  markSettingsDirty();
  renderProviderList();
}

// ---------------- capabilities (actionable) ----------------
let capabilitiesDirty = false;
async function openCapabilities() {
  $('#capabilities-backdrop').classList.remove('hidden');
  capabilitiesDirty = false;
  $('#capabilities-foot').classList.add('hidden');
  await renderSkillsList();
  await renderCommandsList();
}

async function renderSkillsList() {
  const skills = await prime.listSkills();
  const host = $('#skills-list');
  host.innerHTML = '';
  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = `
      <label class="skill-toggle" title="${s.enabled ? 'Disable' : 'Enable'} skill">
        <input type="checkbox" ${s.enabled ? 'checked' : ''} />
        <span class="toggle-track"></span>
      </label>
      <span class="p-name">${esc(s.name)}</span>
      <span class="p-status" style="font-family:inherit">${esc(s.description.slice(0, 70))}${s.description.length > 70 ? '…' : ''}</span>
      <span class="p-actions"><span class="s-dim">${esc(s.source)}</span></span>`;
    row.querySelector('.p-name').style.cursor = 'pointer';
    row.querySelector('.p-name').onclick = () => openFileViewer(s.path);
    row.querySelector('input').onchange = async (e) => {
      const r = await prime.toggleSkill(s.dir, e.target.checked);
      if (!r.ok) { e.target.checked = !e.target.checked; alert('Toggle failed: ' + r.error); }
      else { capabilitiesDirty = true; $('#capabilities-foot').classList.remove('hidden'); }
    };
    host.appendChild(row);
  }
  if (!skills.length) host.innerHTML = '<p class="s-help">No skills found.</p>';
}

async function renderCommandsList() {
  const pane = G.focused;
  if (!pane || !pane.key) return;
  const cmds = await prime.command(pane.key, { type: 'get_commands' });
  const host = $('#commands-list');
  host.innerHTML = '';
  const list = (cmds.success && cmds.data.commands) || [];
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = `<span class="p-name" style="font-family:var(--mono)">/${esc(c.name)}</span>
      <span class="p-status" style="font-family:inherit">${esc((c.description || '').slice(0, 70))}</span>
      <span class="p-actions"><span class="s-dim">${esc(c.source)}</span></span>`;
    row.style.cursor = 'pointer';
    row.title = 'Click to run /' + c.name;
    row.onclick = () => {
      $('#capabilities-backdrop').classList.add('hidden');
      pane.inputEl.value = '/' + c.name + ' ';
      pane.inputEl.focus();
    };
    host.appendChild(row);
  }
  if (!list.length) host.innerHTML = '<p class="s-help">No commands registered.</p>';
}

// ---------------- schedules & heartbeats ----------------
async function openSchedules() {
  $('#schedules-backdrop').classList.remove('hidden');
  await Promise.allSettled([renderSchedulesList(), renderHeartbeatsList()]);
}
function scheduleClient() { return G.focused && G.focused.key ? G.focused : G.panes[0]; }

async function renderSchedulesList() {
  const pane = scheduleClient();
  const host = $('#schedules-list');
  host.innerHTML = '<p class="s-help">Loading…</p>';
  const r = await prime.command(pane.key, { type: 'list_schedules', includeInactive: true });
  const jobs = (r.success && r.data.jobs) || [];
  host.innerHTML = jobs.length ? '' : '<p class="s-help">No scheduled jobs.</p>';
  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = `<span class="p-name" style="min-width:130px;font-family:var(--mono);font-size:12px">${esc(j.schedule || '')}</span>
      <span class="p-status" style="font-family:inherit">${esc((j.prompt || '').slice(0, 60))}${(j.prompt || '').length > 60 ? '…' : ''}</span>
      <span class="p-actions"><span class="s-dim">${j.active === false ? 'inactive' : 'active'}</span></span>`;
    const del = document.createElement('button');
    del.className = 's-btn danger'; del.textContent = 'Cancel';
    del.onclick = async () => {
      if (!confirm('Cancel this scheduled job?')) return;
      await prime.command(pane.key, { type: 'cancel_schedule', jobId: j.id || j.jobId });
      renderSchedulesList();
    };
    row.querySelector('.p-actions').appendChild(del);
    host.appendChild(row);
  }
}

async function renderHeartbeatsList() {
  const pane = scheduleClient();
  const host = $('#heartbeats-list');
  host.innerHTML = '<p class="s-help">Loading…</p>';
  const r = await prime.command(pane.key, { type: 'list_heartbeats' });
  const hbs = (r.success && r.data.heartbeats) || [];
  host.innerHTML = hbs.length ? '' : '<p class="s-help">No heartbeats configured.</p>';
  for (const h of hbs) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    const state = h.paused ? 'paused' : (h.active === false ? 'stopped' : 'running');
    row.innerHTML = `<span class="p-name" style="min-width:130px;font-family:var(--mono);font-size:12px">${esc(h.schedule || '')}</span>
      <span class="p-status" style="font-family:inherit">${esc((h.prompt || '').slice(0, 60))}</span>
      <span class="p-actions"><span class="s-dim">${state}</span></span>`;
    const actions = row.querySelector('.p-actions');
    for (const [label, action] of [['Pause', 'pause'], ['Resume', 'resume'], ['Stop', 'stop']]) {
      const b = document.createElement('button');
      b.className = 's-btn' + (action === 'stop' ? ' danger' : '');
      b.textContent = label;
      b.onclick = async () => {
        await prime.command(pane.key, { type: 'manage_heartbeat', activeSessionId: h.activeSessionId, jobId: h.jobId || h.id, action });
        renderHeartbeatsList();
      };
      actions.appendChild(b);
    }
    host.appendChild(row);
  }
}

// ---------------- menu actions / wiring ----------------
$('#new-chat-btn').onclick = () => G.focused && G.focused.newChat();
$('#session-filter').addEventListener('input', renderSidebar);
$('#settings-btn').onclick = openSettings;
$('#settings-close').onclick = closeSettings;
$('#settings-backdrop').onclick = (e) => { if (e.target === $('#settings-backdrop')) closeSettings(); };
document.querySelectorAll('.stab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.stab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.stab-page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== b.dataset.tab));
  };
});
$('#add-provider-btn').onclick = () => openCustomForm(null, null, false);
$('#settings-restart').onclick = async () => {
  $('#settings-restart').textContent = 'Restarting…';
  await restartAllAgents();
  settingsDirty = false;
  $('#settings-foot').classList.add('hidden');
  $('#settings-restart').textContent = 'Restart agents';
  closeSettings();
};
$('#save-defaults-btn').onclick = async () => {
  const v = $('#default-model-select').value;
  const [provider, ...rest] = v.split('/');
  const r = await prime.writeSettings({
    defaultProvider: provider,
    defaultModel: rest.join('/'),
    defaultThinkingLevel: $('#default-thinking-select').value,
  });
  alert(r.ok ? 'Defaults saved.' : 'Save failed: ' + r.error);
};

$('#capabilities-btn').onclick = openCapabilities;
$('#capabilities-close').onclick = () => $('#capabilities-backdrop').classList.add('hidden');
$('#capabilities-backdrop').onclick = (e) => { if (e.target === $('#capabilities-backdrop')) $('#capabilities-backdrop').classList.add('hidden'); };
document.querySelectorAll('.ctab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.ctab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.ctab-page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== b.dataset.tab));
  };
});
$('#add-skill-btn').onclick = async () => {
  const r = await prime.addSkillFromFolder();
  if (r.ok) { capabilitiesDirty = true; $('#capabilities-foot').classList.remove('hidden'); renderSkillsList(); }
  else if (!r.cancelled) alert('Install failed: ' + r.error);
};
$('#capabilities-restart').onclick = async () => {
  $('#capabilities-restart').textContent = 'Restarting…';
  await restartAllAgents();
  capabilitiesDirty = false;
  $('#capabilities-foot').classList.add('hidden');
  $('#capabilities-restart').textContent = 'Restart agents';
  $('#capabilities-backdrop').classList.add('hidden');
};

$('#schedules-btn').onclick = openSchedules;
$('#schedules-close').onclick = () => $('#schedules-backdrop').classList.add('hidden');
$('#schedules-backdrop').onclick = (e) => { if (e.target === $('#schedules-backdrop')) $('#schedules-backdrop').classList.add('hidden'); };
$('#add-schedule-btn').onclick = () => $('#schedule-form').classList.toggle('hidden');
$('#sf-cancel').onclick = () => $('#schedule-form').classList.add('hidden');
$('#sf-save').onclick = async () => {
  const schedule = $('#sf-schedule').value.trim();
  const promptText = $('#sf-prompt').value.trim();
  if (!schedule || !promptText) { alert('Schedule and prompt are required.'); return; }
  const pane = scheduleClient();
  const r = await prime.command(pane.key, { type: 'add_schedule', schedule, prompt: promptText });
  if (r.success) { $('#schedule-form').classList.add('hidden'); $('#sf-schedule').value = ''; $('#sf-prompt').value = ''; renderSchedulesList(); }
  else alert('Failed: ' + (r.error || 'unknown'));
};

$('#tree-close').onclick = toggleTree;
$('#viewer-close').onclick = () => { clearInterval(subagentPoll); $('#viewer-backdrop').classList.add('hidden'); };
$('#viewer-backdrop').onclick = (e) => { if (e.target === $('#viewer-backdrop')) { clearInterval(subagentPoll); $('#viewer-backdrop').classList.add('hidden'); } };

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $$('.picker-menu').forEach((m) => m.classList.add('hidden'));
    $('#modal-backdrop').classList.add('hidden');
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) $$('.picker-menu').forEach((m) => m.classList.add('hidden'));
});

// tree toggle button lives per topbar? keep global keyboard: none. Add a floating button:
const treeBtn = document.createElement('button');
treeBtn.id = 'tree-toggle';
treeBtn.className = 'picker-btn';
treeBtn.title = 'Toggle file tree';
treeBtn.textContent = '🗂';
treeBtn.onclick = toggleTree;
$('#sidebar').querySelector('.sidebar-bottom-row').appendChild(treeBtn);

// ---------------- daemon events ----------------
prime.onRpcEvent(({ key, event }) => {
  const pane = G.panes.find((p) => p.key === key);
  if (pane) pane.handleEvent(event);
});
prime.onKeyMapped(({ oldKey, key }) => {
  const pane = G.panes.find((p) => p.key === oldKey);
  if (pane) { pane.key = key; pane.sessionFile = key; }
});
prime.onSessionsChanged((list) => refreshSessions(list));
prime.onRpcExit(({ key, code, error }) => {
  const pane = G.panes.find((p) => p.key === key);
  if (pane) {
    pane.setBanner(`${error || 'Agent process exited'} (code ${code}). Click to restart.`, true);
    pane.bannerEl.style.cursor = 'pointer';
    pane.bannerEl.onclick = async () => { pane.bannerEl.onclick = null; await pane.activate(pane.sessionFile || null, pane.cwd); };
  }
});
prime.onRpcError(({ key, message }) => {
  const pane = (key && G.panes.find((p) => p.key === key)) || G.focused;
  if (pane) pane.setBanner(message || 'Agent process error.', true);
});
prime.onFlushWait(({ key }) => {
  const pane = G.panes.find((p) => p.key === key);
  if (pane) pane.setAgentState('saving session before switching…');
});
prime.onMenuAction(({ id }) => {
  if (id === 'new-chat') G.focused && G.focused.newChat();
  else if (id === 'open-settings') openSettings();
  else if (id === 'install-agent' || id === 'update-agent') runAgentInstall(id === 'install-agent' ? 'Install Prime Agent' : 'Update Prime Agent');
  else if (id === 'restart-agent') restartAllAgents();
});

async function runAgentInstall(titleText) {
  const log = openProgressModal(titleText);
  const off = prime.onInstallProgress((line) => { log.textContent += line + '\n'; log.scrollTop = log.scrollHeight; });
  const r = await prime.installAgent();
  off();
  const actions = $('#modal-actions');
  const close = document.createElement('button');
  close.className = r.ok ? 'primary' : 'secondary';
  close.textContent = 'Close';
  close.onclick = () => $('#modal-backdrop').classList.add('hidden');
  actions.appendChild(close);
  log.textContent += r.ok ? '\nDone.' : '\nFailed: ' + (r.error || 'unknown');
  if (r.ok) await restartAllAgents();
}

// ---------------- init ----------------
(async function init() {
  await loadPins();
  await refreshSessions();
  const params = new URLSearchParams(location.search);
  const popSession = params.get('session');
  const pane = await createPane(0, popSession || null);
  setFocusedPane(pane);
  const input = pane.inputEl;
  input.focus();
})();
