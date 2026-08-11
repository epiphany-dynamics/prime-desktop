// Prime Desktop renderer v0.6 — multi-pane, multi-process sessions.
/* global prime, marked, DOMPurify, PrimeDraftState */

marked.setOptions({ breaks: false, gfm: true });

// ---------------- utils ----------------
const $ = (sel, rootEl) => (rootEl || document).querySelector(sel);
const $$ = (sel, rootEl) => [...(rootEl || document).querySelectorAll(sel)];

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}


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
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB';
  return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}
const FILE_TRANSPORT_START = '[Prime Desktop local files:v1]';
const FILE_TRANSPORT_END = '[/Prime Desktop local files]';
function parseLocalFileTransport(input) {
  const text = String(input || '');
  const start = text.lastIndexOf('\n' + FILE_TRANSPORT_START + '\n');
  const index = start >= 0 ? start + 1 : (text.startsWith(FILE_TRANSPORT_START + '\n') ? 0 : -1);
  if (index < 0) return { text, files: [] };
  const closing = '\n' + FILE_TRANSPORT_END;
  const end = text.indexOf(closing, index);
  if (end < 0) return { text, files: [] };
  const lines = text.slice(index, end + closing.length).split('\n');
  if (lines.length !== 4 || lines[0] !== FILE_TRANSPORT_START || lines[1] !== 'Attached local files — use file tools to inspect:' || lines[3] !== FILE_TRANSPORT_END) return { text, files: [] };
  let records;
  try { records = JSON.parse(lines[2]); } catch { return { text, files: [] }; }
  if (!Array.isArray(records) || !records.length || records.length > 20) return { text, files: [] };
  const valid = records.every((record) => {
    if (!record || Object.getPrototypeOf(record) !== Object.prototype || !['workspace', 'external'].includes(record.scope)) return false;
    if (Object.keys(record).sort().join(',') !== 'name,path,scope,size,type') return false;
    if (typeof record.path !== 'string' || !record.path || record.path.length > 4096 || /[\u0000\r\n]/.test(record.path)) return false;
    const normalized = record.path.replace(/\\/g, '/');
    if (record.scope === 'workspace' && (normalized.startsWith('/') || normalized.split('/').includes('..'))) return false;
    if (record.scope === 'external' && !normalized.startsWith('~/') && !normalized.startsWith('/')) return false;
    return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(record.name)
      && typeof record.type === 'string' && record.type.length > 0 && record.type.length <= 120 && !/[\u0000\r\n]/.test(record.type)
      && Number.isSafeInteger(record.size) && record.size >= 0;
  });
  if (!valid) return { text, files: [] };
  return {
    text: (text.slice(0, index) + text.slice(end + closing.length)).trim(),
    files: records.map((record) => ({ kind: 'file', name: record.name, mimeType: record.type, size: record.size, external: record.scope === 'external' })),
  };
}
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
  hudShortcutWarning: null,
  hudShortcutWarningShown: false,
  // Unsent composer text keyed by sessionFile (or "new:<paneId>" for blank chats).
  composerDrafts: new Map(),
  liveAgents: [],
};

function composerDraftKey(sessionFile, paneId) {
  if (typeof sessionFile === 'string' && sessionFile) return sessionFile;
  return 'new:' + (paneId || 'pane');
}

function showHudShortcutWarning(pane) {
  if (!pane || !pane.ready || !G.hudShortcutWarning || G.hudShortcutWarningShown) return;
  G.hudShortcutWarningShown = true;
  pane.setBanner(G.hudShortcutWarning, false);
}

// ---------------- Pane ----------------
class Pane {
  constructor(index) {
    this.index = index;
    this.key = null;            // client key (sessionFile once mapped)
    this.paneId = null;         // opaque main-issued pane/draft scope
    this.bindingEpoch = null;    // changes on every main-owned pane binding
    this.activationRequest = 0;
    this.bindingChangePending = false;
    this.composerRevision = 0;
    this.sessionFile = null;
    this.cwd = null;
    this.workspace = { selected: false, generation: 0 };
    this.draftState = new PrimeDraftState.DraftState();
    this.model = null;
    this.thinkingLevel = null;
    this.isStreaming = false;
    this.stream = null;
    this.toolCards = new Map();
    this.ready = false;
    this.suggestions = [];
    this.suggestionIndex = 0;
    this.commandCache = null;
    this.suggestionRequest = 0;
    this.sending = false;
    this.stickToBottom = true;
    this._scrollFollowRaf = 0;
    this._scrollGesturesBound = false;
    this._scrollAnchor = null;
    this._chatResizeObserver = null;
    this._chatMutationObserver = null;
    this._mutationScrollQueued = false;

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
    this.attachBtn = $('.attach-btn', this.el);
    this.attachmentStrip = $('.attachment-strip', this.el);
    this.attachmentError = $('.attachment-error', this.el);
    this.attachmentPending = $('.attachment-pending', this.el);
    this.composerPopover = $('.composer-popover', this.el);
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
    this.folderBtn = $('.pane-folder', this.el);
    this.splitBtn = $('.pane-split', this.el);

    this.el.addEventListener('mousedown', () => setFocusedPane(this));
    this.el.addEventListener('dragover', (e) => this.handlePaneDragOver(e));
    this.el.addEventListener('dragleave', (e) => { if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drag-target'); });
    this.el.addEventListener('drop', (e) => this.handlePaneDrop(e));
    this.ensureScrollFollowObserver();
    this.inputEl.addEventListener('input', () => {
      this.composerRevision += 1;
      this.autoSize();
      this.updateComposer();
      this.updateSuggestions();
      this.saveComposerDraft();
    });
    this.inputEl.addEventListener('paste', (e) => this.handlePaste(e));
    this.inputEl.addEventListener('dragover', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) e.preventDefault(); });
    this.inputEl.addEventListener('drop', (e) => this.handleFileDrop(e));
    this.inputEl.addEventListener('keydown', (e) => {
      if (this.handleSuggestionKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.attachBtn.onclick = () => this.pickAttachments();
    this.folderBtn.onclick = () => openProjectSurface(this);
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
    this.splitBtn.onclick = () => splitPane(this.sessionFile || null);
    $('.pane-popout', this.el).onclick = () => prime.popOut(this.sessionFile || undefined);
    this.closeBtn.onclick = () => closePane(this);
  }

  // ---------- composer context / workspace interactions ----------
  async chooseFolder() { return openProjectSurface(this); }

  setAttachmentError(message) {
    this.attachmentError.textContent = message || '';
    this.attachmentError.classList.toggle('hidden', !message);
  }

  beginAttachmentIngest() {
    if (this.bindingChangePending || this.draftState.sending) return null;
    const receipt = this.draftState.beginIngest();
    this.updateComposer();
    return receipt;
  }

  async applyIngest(receipt, promise) {
    let response;
    try { response = await promise; }
    catch { response = { error: 'That attachment could not be added' }; }
    if (!this.draftState.applyIngest(receipt, response)) return false;
    this.renderAttachments();
    return !!(response && response.ok);
  }

  async pickAttachments() {
    if (!this.key || !this.paneId || !this.draftState.id || this.draftState.sending) return;
    this.setAttachmentError(null);
    const receipt = this.beginAttachmentIngest();
    if (!receipt) return;
    await this.applyIngest(receipt, prime.pickAttachments(this.key, this.paneId, this.bindingEpoch, receipt.draftId));
  }

  renderAttachments() {
    const snapshot = this.draftState.snapshot();
    const host = this.attachmentStrip;
    host.innerHTML = '';
    host.classList.toggle('hidden', snapshot.items.length === 0);
    for (const item of snapshot.items) {
      const chip = document.createElement('div');
      chip.className = `attachment-chip ${item.kind}${item.external ? ' external' : ''}`;
      const visual = item.kind === 'image' && item.previewDataUrl
        ? `<img src="${esc(item.previewDataUrl)}" alt="" />`
        : `<b class="attachment-file-icon">${item.kind === 'image' ? 'IMG' : item.kind === 'session' ? 'CHAT' : item.kind === 'folder' ? 'DIR' : 'DOC'}</b>`;
      chip.innerHTML = `${visual}<span class="attachment-chip-copy"><strong>${esc(item.name)}</strong><small>${esc(item.mimeType || item.kind)} · ${formatBytes(item.size)}${item.external ? ' · External' : ''}</small></span><button class="attachment-remove" aria-label="Remove ${esc(item.name)}" title="Remove attachment">✕</button>`;
      chip.querySelector('.attachment-remove').onclick = async () => {
        if (this.bindingChangePending || this.draftState.sending) return;
        const response = await prime.removeAttachment(this.key, this.paneId, this.bindingEpoch, this.draftState.id, item.id);
        if (response.ok && response.draft) {
          this.draftState.applySnapshot(response.draft);
          this.renderAttachments();
          this.inputEl.focus();
        } else this.setAttachmentError(response.error || 'That attachment could not be removed');
      };
      host.appendChild(chip);
    }
    this.setAttachmentError(snapshot.error);
    this.updateComposer();
  }

  async handlePaste(event) {
    const items = [...((event.clipboardData && event.clipboardData.items) || [])];
    const images = items.filter((item) => item.kind === 'file' && /^image\//i.test(item.type || ''));
    if (!images.length || !this.draftState.id) return;
    event.preventDefault();
    this.setAttachmentError(null);
    for (const imageItem of images.slice(0, 6)) {
      const file = imageItem.getAsFile();
      if (!file) { this.setAttachmentError('The pasted image could not be read'); continue; }
      if (file.size > 20_000_000) { this.setAttachmentError('Images must be 20 MB or smaller'); continue; }
      const receipt = this.beginAttachmentIngest();
      if (!receipt) continue;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.applyIngest(receipt, prime.pasteImage(this.key, this.paneId, this.bindingEpoch, receipt.draftId, bytes, file.name || 'Pasted image'));
      } catch {
        this.draftState.applyIngest(receipt, { error: 'The pasted image could not be read' });
        this.renderAttachments();
      }
    }
  }

  async handleFileDrop(event) {
    const files = [...((event.dataTransfer && event.dataTransfer.files) || [])];
    if (!files.length || !this.draftState.id) return;
    event.preventDefault();
    event.stopPropagation();
    this.setAttachmentError(null);
    const receipt = this.beginAttachmentIngest();
    if (!receipt) return;
    await this.applyIngest(receipt, prime.dropAttachments(this.key, this.paneId, this.bindingEpoch, receipt.draftId, files));
  }

  async addTreeAttachment(nodeId) {
    if (!this.draftState.id) return false;
    const receipt = this.beginAttachmentIngest();
    if (!receipt) return false;
    return this.applyIngest(receipt, prime.addTreeAttachment(this.key, this.paneId, this.bindingEpoch, receipt.draftId, nodeId));
  }

  async addSessionAttachment(session) {
    if (!session || !this.draftState.id) return false;
    const receipt = this.beginAttachmentIngest();
    if (!receipt) return false;
    return this.applyIngest(receipt, prime.addSessionAttachment(this.key, this.paneId, this.bindingEpoch, receipt.draftId, session.path, session.name || session.preview || session.id));
  }

  handlePaneDragOver(e) {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('application/x-prime-session')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.el.classList.add('drag-target');
  }

  async handlePaneDrop(e) {
    this.el.classList.remove('drag-target');
    const sessionPath = e.dataTransfer && e.dataTransfer.getData('application/x-prime-session');
    if (!sessionPath) return;
    e.preventDefault(); e.stopPropagation();
    // Drop onto a pane opens that session IN THIS pane (or explicit split target).
    // Never invent a second pane from a sidebar drag — Split button is the only
    // way to create split view.
    const existing = G.panes.find((p) => p.sessionFile === sessionPath);
    if (existing && existing !== this && G.panes.length > 1) {
      // In split mode, dropping on a pane loads into that pane.
      await this.activate(sessionPath, null, { allowStreaming: true });
      return;
    }
    // Single-pane (or drop on the only pane): replace center view in place.
    await openSessionFromSidebar(sessionPath);
  }

  currentComposerToken() {
    const before = this.inputEl.value.slice(0, this.inputEl.selectionStart);
    const match = before.match(/(?:^|\s)([/@][^\s]*)$/);
    return match ? { value: match[1], start: before.length - match[1].length, end: this.inputEl.selectionStart } : null;
  }

  async updateSuggestions() {
    const token = this.currentComposerToken();
    if (!token || (token.value[0] === '/' && token.start !== 0)) { this.hideSuggestions(); return; }
    const request = ++this.suggestionRequest;
    let options = [];
    if (token.value.startsWith('/')) {
      if (!this.commandCache && this.key) {
        const r = await prime.command(this.key, { type: 'get_commands' });
        this.commandCache = r.success ? (r.data.commands || []) : [];
      }
      const query = token.value.slice(1).toLowerCase();
      options = (this.commandCache || []).filter((c) => !query || c.name.toLowerCase().includes(query)).slice(0, 40)
        .map((c) => ({ type: 'command', label: '/' + c.name, description: c.description || c.source || '', value: '/' + c.name + ' ' }));
    } else {
      const query = token.value.slice(1).toLowerCase();
      const sessions = G.sessions.filter((session) => {
        const label = session.name || session.preview || session.id || '';
        return !query || label.toLowerCase().includes(query);
      }).slice(0, 12).map((session) => ({
        type: 'session', label: '@' + (session.name || session.preview || session.id.slice(0, 8)), description: 'session',
        value: '@' + (session.name || session.id.slice(0, 8)), attachment: { kind: 'session', session },
      }));
      let files = [];
      if (this.workspace.selected) {
        const response = await prime.searchWorkspace(this.key, this.paneId, this.bindingEpoch, {
          workspaceId: this.workspace.workspaceId,
          generation: this.workspace.generation,
          query,
          limit: 40,
        });
        if (response.ok) files = (response.entries || []).map((entry) => ({
          type: entry.type, label: '@' + entry.relativePath, description: entry.type,
          value: '@' + entry.relativePath, attachment: { kind: entry.type, nodeId: entry.nodeId, name: entry.name },
        }));
      }
      options = [...sessions, ...files].slice(0, 50);
    }
    if (request !== this.suggestionRequest) return;
    this.suggestions = options;
    this.suggestionIndex = 0;
    this.renderSuggestions(token);
  }

  renderSuggestions(token) {
    const host = this.composerPopover;
    host.innerHTML = '';
    host.classList.toggle('hidden', this.suggestions.length === 0);
    this.suggestions.forEach((option, index) => {
      const row = document.createElement('button');
      row.className = 'composer-option' + (index === this.suggestionIndex ? ' active' : '');
      row.innerHTML = `<span>${option.type === 'command' ? '⌘' : option.type === 'session' ? '◫' : option.type === 'folder' ? '▱' : '▤'}</span><span class="composer-option-main"><div class="composer-option-name">${esc(option.label)}</div><div class="composer-option-desc">${esc(option.description)}</div></span>`;
      row.onmousedown = (e) => { e.preventDefault(); this.selectSuggestion(index, token); };
      host.appendChild(row);
    });
  }

  hideSuggestions() {
    this.suggestionRequest++;
    this.suggestions = [];
    this.composerPopover.classList.add('hidden');
    this.composerPopover.innerHTML = '';
  }

  selectSuggestion(index, providedToken) {
    const option = this.suggestions[index];
    const token = providedToken || this.currentComposerToken();
    if (!option || !token) return;
    const text = this.inputEl.value;
    this.inputEl.value = text.slice(0, token.start) + option.value + text.slice(token.end);
    const cursor = token.start + option.value.length;
    this.inputEl.setSelectionRange(cursor, cursor);
    if (option.attachment) {
      if (option.attachment.kind === 'session') void this.addSessionAttachment(option.attachment.session);
      else if (option.attachment.nodeId) void this.addTreeAttachment(option.attachment.nodeId);
    }
    this.hideSuggestions();
    this.autoSize();
    this.inputEl.focus();
  }

  handleSuggestionKey(e) {
    if (this.composerPopover.classList.contains('hidden') || !this.suggestions.length) return false;
    if (!this.currentComposerToken()) { this.hideSuggestions(); return false; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.suggestionIndex = (this.suggestionIndex + delta + this.suggestions.length) % this.suggestions.length;
      this.renderSuggestions(this.currentComposerToken());
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.selectSuggestion(this.suggestionIndex); return true; }
    if (e.key === 'Escape') { e.preventDefault(); this.hideSuggestions(); return true; }
    return false;
  }

  // ---------- activation ----------
  canChangeBinding(action = 'changing sessions', { allowStreaming = false, allowSupersede = false } = {}) {
    // Session switches may supersede an in-flight switch. Project changes stay exclusive.
    if (this.bindingChangePending && !allowSupersede) {
      this.setBanner(`Wait for the current project or session change before ${action}.`, true);
      return false;
    }
    // Session navigation is allowed while streaming (in-place switch). Project
    // changes still require a quiet response unless explicitly allowed.
    if (this.isStreaming && !allowStreaming) {
      this.setBanner(`Stop the current response before ${action}.`, true);
      return false;
    }
    if (this.sending || this.draftState.sending) {
      this.setBanner(`Wait for the current message before ${action}.`, true);
      return false;
    }
    if (this.draftState.pending.size > 0) {
      this.setBanner(`Wait for attachments to finish before ${action}.`, true);
      return false;
    }
    return true;
  }

  /** Force-clear sticky navigation locks so the UI can never soft-brick. */
  clearBindingLock(reason = '') {
    this.bindingChangePending = false;
    this.sending = false;
    if (this.draftState && this.draftState.sending) this.draftState.clearSending();
    this.updateComposer();
    if (reason) this.setBanner(reason, true);
  }

  async applyActivation(response, sessionPath, requestId) {
    if (requestId !== this.activationRequest) return false;
    const preserveDraft = !!(response.preservedDraft && this.sessionFile && response.sessionFile === this.sessionFile && response.draft && response.draft.id === this.draftState.id);
    this.key = response.key;
    this.paneId = response.paneId;
    this.bindingEpoch = response.bindingEpoch;
    this.sessionFile = response.sessionFile || sessionPath || null;
    this.workspace = response.workspace || { selected: false, generation: 0 };
    this.cwd = this.workspace.selected ? this.workspace.cwd : null;
    this.draftState.reset(response.draft || null);
    this.renderAttachments();
    this.setBanner(null);
    this.bannerEl.style.cursor = '';
    this.bannerEl.onclick = null;
    // A process-only same-session recovery keeps unsent text and the main-owned
    // draft. Otherwise restore any unsent composer text saved for this session.
    if (!preserveDraft) {
      const key = composerDraftKey(this.sessionFile, this.paneId);
      const saved = G.composerDrafts.get(key);
      this.inputEl.value = typeof saved === 'string' ? saved : '';
      this.composerRevision += 1;
      this.autoSize();
    }
    this.hideSuggestions();
    // Prefer activation payload state first (covers daemon attach race before get_state).
    if (response.state) {
      this.isStreaming = !!response.state.isStreaming;
      this.model = response.state.model || this.model;
      this.thinkingLevel = response.state.thinkingLevel || this.thinkingLevel;
      if (response.state.sessionFile) this.sessionFile = response.state.sessionFile;
    }
    // Paint the shell immediately so clicks feel instant.
    this.chatEl.innerHTML = '';
    this.emptyEl.classList.add('hidden');
    this.setAgentState('Loading…');
    this.ready = true;
    this.updateTopbar();
    this.updateComposer();
    renderSidebar();
    if (response.warning) this.setBanner(response.warning, false);
    else showHudShortcutWarning(this);

    // Background hydrate: state + history + agents. Abort if user clicked away.
    const hydrateId = requestId;
    const hydrateEpoch = response.bindingEpoch;
    void (async () => {
      try {
        await this.syncState();
        if (hydrateId !== this.activationRequest || this.bindingEpoch !== hydrateEpoch) return;
        const messages = await prime.command(this.key, { type: 'get_messages' });
        if (hydrateId !== this.activationRequest || this.bindingEpoch !== hydrateEpoch) return;
        if (messages.success) {
          const streamingMessage = (messages.data && messages.data.streamingMessage)
            || (response.state && response.state.streamingMessage)
            || null;
          this.renderHistory(messages.data.messages || [], { dropInFlight: this.isStreaming && !streamingMessage });
          if (this.isStreaming) {
            this.setAgentState('working…');
            if (streamingMessage && streamingMessage.role === 'assistant') {
              this.beginStream();
              this.syncStreamFromMessage(streamingMessage);
              this.scheduleStreamRender();
            }
          } else {
            this.setAgentState('');
          }
        } else if (this.isStreaming) {
          this.setAgentState('working…');
        } else {
          this.setAgentState('');
        }
        void refreshLiveAgents(this);
        if (treeVisible && G.focused === this) void renderTreeRoot();
      } catch {
        if (hydrateId === this.activationRequest && this.bindingEpoch === hydrateEpoch) {
          this.setAgentState('');
          this.setBanner('Could not load chat history', true);
        }
      }
    })();
    return true;
  }

  async activate(sessionPath, sourcePane = null, { allowStreaming = true } = {}) {
    // Default allowStreaming: navigation and New Chat replace this pane in place.
    // Split View is explicit (button / sidebar Split / drag-drop only).
    // Drop transient send/stream locks first so navigation is never sealed by a
    // held stream or a draft send that already returned from main.
    this.sending = false;
    if (this.draftState && this.draftState.sending) this.draftState.clearSending();
    // Session navigation ALWAYS supersedes an in-flight switch. Never soft-brick.
    if (!this.canChangeBinding(sessionPath ? 'changing sessions' : 'starting a new chat', {
      allowStreaming,
      allowSupersede: true,
    })) return false;
    // Persist unsent composer text for the session we are leaving.
    this.saveComposerDraft();
    // Invalidate any previous in-flight activate for this pane.
    const requestId = ++this.activationRequest;
    this.bindingChangePending = true;
    this.updateComposer();
    // Hard safety: if main never answers, unlock so the product remains usable.
    const lockWatchdog = setTimeout(() => {
      if (this.activationRequest === requestId && this.bindingChangePending) {
        this.clearBindingLock('Session switch timed out — try again.');
      }
    }, 12_000);
    // Leaving a streaming session: clear local stream chrome before the new binding loads.
    if (this.isStreaming || this.stream) {
      this.isStreaming = false;
      this.endStream();
      this.setAgentState('');
      this.toolCards.clear();
    }
    try {
      this.setBanner(null);
      this.commandCache = null;
      const response = await withTimeout(prime.activate({
        sessionPath: sessionPath || undefined,
        paneId: this.paneId || undefined,
        bindingEpoch: this.bindingEpoch || undefined,
        sourceKey: this.key || (sourcePane && sourcePane.key) || undefined,
        sourcePaneId: !this.paneId && sourcePane ? sourcePane.paneId : undefined,
        sourceBindingEpoch: !this.paneId && sourcePane ? sourcePane.bindingEpoch : undefined,
        allowStreamingLeave: allowStreaming,
      }), 12_000, 'Session switch timed out');
      if (requestId !== this.activationRequest) return false;
      if (!response || !response.ok) {
        this.setBanner('Could not start session: ' + ((response && response.error) || 'unknown'), true);
        return false;
      }
      return await this.applyActivation(response, sessionPath, requestId);
    } catch (error) {
      if (requestId === this.activationRequest) {
        const message = (error && error.message) ? error.message : 'Session switch failed';
        this.setBanner(message, true);
      }
      return false;
    } finally {
      clearTimeout(lockWatchdog);
      // Only the latest activate owns the lock.
      if (requestId === this.activationRequest) {
        this.bindingChangePending = false;
        this.updateComposer();
      }
    }
  }

  async newChat() {
    if (this !== G.focused) setFocusedPane(this);
    return startNewChat();
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
    this.refreshGitPill();
    // Stats are decorative — never block session switch on them.
    void prime.command(this.key, { type: 'get_session_stats' }).then((st) => {
      if (!st || !st.success) return;
      if (st.data.contextUsage && st.data.contextUsage.percent != null) {
        this.contextMeter.textContent = `${Math.round(st.data.contextUsage.percent)}% ctx · $${(st.data.cost || 0).toFixed(3)}`;
      } else this.contextMeter.textContent = '';
    }).catch(() => {});
  }

  async refreshGitPill() {
    const workspace = this.workspace || { selected: false };
    if (!workspace.selected) {
      this.cwd = null;
      this.gitPill.classList.add('hidden');
      this.cwdLabel.textContent = 'Choose a project';
      return;
    }
    this.cwd = workspace.cwd;
    const git = workspace.git;
    const branch = git && (git.branch || (git.sha ? `detached@${git.sha}` : null));
    this.gitPill.textContent = branch ? `⑂ ${branch}` : workspace.name;
    this.gitPill.title = git && git.worktree ? `${git.worktree.name} — ${workspace.cwd}` : workspace.cwd;
    this.gitPill.classList.remove('hidden');
    this.cwdLabel.textContent = 'cwd: ' + workspace.cwd;
  }

  updateTopbar() {
    const s = G.sessions.find((x) => x.path === this.sessionFile);
    this.titleEl.textContent = s ? (s.name || s.preview || 'Untitled session') : 'New session';
    this.modelBtn.textContent = this.model ? `${this.model.provider}/${this.model.id} ▾` : '… ▾';
    this.thinkingBtn.textContent = `thinking: ${this.thinkingLevel || 'off'} ▾`;
    const workspace = this.workspace || { selected: false };
    const branch = workspace.git && (workspace.git.branch || (workspace.git.sha ? `detached@${workspace.git.sha}` : ''));
    this.folderBtn.textContent = workspace.selected ? `${workspace.name}${branch ? ' · ' + branch : ''}` : 'Choose project';
    this.folderBtn.title = workspace.selected ? `${workspace.cwd} — choose project or worktree` : 'Choose project (Cmd+O)';
    this.folderBtn.setAttribute('aria-expanded', projectSurfacePane === this && !$('#project-surface').classList.contains('hidden') ? 'true' : 'false');
  }

  updateComposer() {
    this.stopBtn.classList.toggle('hidden', !this.isStreaming);
    const sending = this.sending || this.draftState.sending;
    const bindingPending = this.bindingChangePending;
    const attachmentPending = this.draftState.pending.size > 0;
    this.sendBtn.disabled = bindingPending || sending || attachmentPending || (!this.inputEl.value.trim() && this.draftState.items.length === 0) || !this.key;
    this.attachBtn.disabled = bindingPending || sending || !this.draftState.id;
    for (const button of this.attachmentStrip.querySelectorAll('.attachment-remove')) button.disabled = bindingPending || sending;
    this.attachmentPending.classList.toggle('hidden', !attachmentPending);
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

  saveComposerDraft() {
    const key = composerDraftKey(this.sessionFile, this.paneId);
    const text = this.inputEl ? this.inputEl.value : '';
    if (text && text.length) G.composerDrafts.set(key, text);
    else G.composerDrafts.delete(key);
  }

  clearComposerDraft(sessionFile = this.sessionFile) {
    G.composerDrafts.delete(composerDraftKey(sessionFile, this.paneId));
  }

  autoSize() {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
  }
  nearBottom(threshold = 72) {
    const el = this.scrollEl;
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
  }

  /**
   * ChatGPT-style stick-to-bottom:
   * - Follow latest output only while stickToBottom is true
   * - User scroll-away immediately releases and STAYS released
   * - Returning to the real bottom re-enables stick
   * - Stream/mutation updates must NEVER re-arm stick (that caused snap-back)
   */
  syncStickFromUserPosition() {
    if (this._programmaticScroll) return;
    if (this.nearBottom(72)) {
      this.stickToBottom = true;
    } else {
      this.stickToBottom = false;
      this._stopFollowLoop();
    }
  }

  releaseStickFromUserGesture() {
    // Immediate release on intentional wheel/touch away from bottom.
    this.stickToBottom = false;
    this._stopFollowLoop();
    // After the browser applies the gesture, re-evaluate (allows re-stick at bottom).
    requestAnimationFrame(() => this.syncStickFromUserPosition());
  }

  _pinScrollToEnd() {
    const el = this.scrollEl;
    if (!el || !this.stickToBottom) return;
    this._programmaticScroll = true;
    // Only scrollTop — never scrollIntoView (it can target the wrong box and snap mid-thread).
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      if (this.stickToBottom && this.scrollEl) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
      // Clear flag after layout settles so user scroll is heard again.
      requestAnimationFrame(() => { this._programmaticScroll = false; });
    });
  }

  _stopFollowLoop() {
    if (this._scrollFollowRaf) {
      cancelAnimationFrame(this._scrollFollowRaf);
      this._scrollFollowRaf = 0;
    }
  }

  _ensureFollowLoop() {
    // No continuous RAF hammer. Pin once per content change only.
    this._stopFollowLoop();
  }

  /**
   * @param {boolean} forcePin when true, pin if currently sticking (does NOT re-arm stick)
   * @param {boolean} engageStick when true, intentionally turn stick on (user send / jump-to-latest only)
   */
  scrollBottom(forcePin = false, engageStick = false) {
    if (engageStick) this.stickToBottom = true;
    if (!this.stickToBottom) return;
    if (!forcePin && !this.stickToBottom) return;
    this._pinScrollToEnd();
  }

  ensureScrollFollowObserver() {
    if (this.scrollEl && !this._scrollGesturesBound) {
      this._scrollGesturesBound = true;
      this.scrollEl.addEventListener('scroll', () => this.syncStickFromUserPosition(), { passive: true });
      // Wheel/touch: release immediately if user scrolls up; sync after for re-stick at bottom.
      this.scrollEl.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
          this.stickToBottom = false;
          this._stopFollowLoop();
        } else {
          requestAnimationFrame(() => this.syncStickFromUserPosition());
        }
      }, { passive: true });
      this.scrollEl.addEventListener('touchstart', () => { this._touchY = null; }, { passive: true });
      this.scrollEl.addEventListener('touchmove', (e) => {
        const y = e.touches && e.touches[0] ? e.touches[0].clientY : null;
        if (y != null && this._touchY != null && y > this._touchY + 2) {
          // Finger dragging down content = scrolling up historically → release
          this.stickToBottom = false;
          this._stopFollowLoop();
        }
        this._touchY = y;
      }, { passive: true });
      this.scrollEl.addEventListener('touchend', () => requestAnimationFrame(() => this.syncStickFromUserPosition()), { passive: true });
      this.scrollEl.addEventListener('keydown', (e) => {
        if (['PageUp', 'Home', 'ArrowUp'].includes(e.key)) {
          this.stickToBottom = false;
          this._stopFollowLoop();
        } else if (['PageDown', 'End', 'ArrowDown', ' '].includes(e.key)) {
          requestAnimationFrame(() => this.syncStickFromUserPosition());
        }
      });
    }

    if (!this._scrollAnchor && this.chatEl) {
      const anchor = document.createElement('div');
      anchor.className = 'chat-scroll-anchor';
      anchor.setAttribute('aria-hidden', 'true');
      this.chatEl.appendChild(anchor);
      this._scrollAnchor = anchor;
    }

    if (!this._chatResizeObserver && typeof ResizeObserver !== 'undefined') {
      this._chatResizeObserver = new ResizeObserver(() => {
        // Content grew: follow only if user is stuck to bottom. Never re-arm.
        if (this.stickToBottom) this.scrollBottom(true, false);
      });
      if (this.chatEl) this._chatResizeObserver.observe(this.chatEl);
      if (this.scrollEl) this._chatResizeObserver.observe(this.scrollEl);
    }

    if (!this._chatMutationObserver && typeof MutationObserver !== 'undefined' && this.chatEl) {
      this._chatMutationObserver = new MutationObserver(() => {
        if (!this.stickToBottom || this._mutationScrollQueued) return;
        this._mutationScrollQueued = true;
        requestAnimationFrame(() => {
          this._mutationScrollQueued = false;
          if (this.stickToBottom) this.scrollBottom(true, false);
        });
      });
      this._chatMutationObserver.observe(this.chatEl, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }
  hideEmpty() { this.emptyEl.classList.add('hidden'); }
  showEmptyIfEmpty() {
    const hasContent = [...this.chatEl.children].some((el) => el !== this._scrollAnchor && !el.classList.contains('empty-state'));
    this.emptyEl.classList.toggle('hidden', hasContent);
  }
  _keepScrollAnchorLast() {
    if (!this.chatEl) return;
    if (this._scrollAnchor && this._scrollAnchor.parentNode === this.chatEl) {
      // Only move when needed — re-append always fires MutationObserver and can thrash.
      if (this.chatEl.lastElementChild !== this._scrollAnchor) this.chatEl.appendChild(this._scrollAnchor);
      return;
    }
    this.ensureScrollFollowObserver();
  }

  // ---------- sending ----------
  async send() {
    const inputAtSend = this.inputEl.value;
    const inputRevisionAtSend = this.composerRevision;
    const text = inputAtSend.trim();
    if (this.bindingChangePending || this.sending || this.draftState.sending || this.draftState.pending.size > 0 || (!text && this.draftState.items.length === 0) || !this.key || !this.paneId || !this.bindingEpoch) return;
    const receipt = this.draftState.beginSend();
    if (!receipt) return;
    const sendBinding = { key: this.key, paneId: this.paneId, bindingEpoch: this.bindingEpoch };
    const fallbackAttachments = [...this.draftState.items];
    this.sending = true;
    this.hideSuggestions();
    this.setAttachmentError(null);
    this.updateComposer();
    try {
      const behavior = this.isStreaming ? 'steer' : 'prompt';
      const response = await prime.sendChat(sendBinding.key, sendBinding.paneId, sendBinding.bindingEpoch, receipt.draftId, text, behavior).catch(() => ({ ...sendBinding, ok: false, error: 'The message could not be sent' }));
      const stillThisPane = PrimeDraftState.sameBinding(sendBinding, { key: this.key, paneId: this.paneId, bindingEpoch: this.bindingEpoch });
      if (!stillThisPane) return;
      if (!response.ok || !response.accepted || !PrimeDraftState.sameBinding(sendBinding, response)) {
        if (!this.draftState.rejected(receipt, response.error || 'Prompt rejected')) this.draftState.clearSending();
        else {
          this.setBanner('Prompt rejected: ' + (response.error || 'unknown'), true);
          this.renderAttachments();
        }
        return;
      }
      const rendered = response.rendered || { text, attachments: fallbackAttachments };
      if (!this.draftState.accepted(receipt, response.draft)) this.draftState.clearSending();
      this.addUserBubble(rendered.text, rendered.attachments || []);
      if (this.composerRevision === inputRevisionAtSend && this.inputEl.value === inputAtSend) {
        this.inputEl.value = '';
        this.composerRevision += 1;
        this.autoSize();
      }
      this.renderAttachments();
      this.setBanner(null);
      // Sent text should not come back when revisiting the session.
      this.clearComposerDraft(sendBinding.key);
      this.clearComposerDraft(this.sessionFile);
    } finally {
      this.sending = false;
      // Never leave the composer permanently sealed after a send attempt.
      if (this.draftState.sending) this.draftState.clearSending();
      // Keep any typed-but-not-yet-cleared residual out of the map if empty.
      if (this.inputEl && !this.inputEl.value) this.clearComposerDraft(this.sessionFile);
      this.updateComposer();
    }
  }

  async stop() {
    if (!this.key) return;
    await prime.command(this.key, { type: 'abort' });
    this.isStreaming = false;
    this.updateComposer();
    this.setAgentState('');
  }

  // ---------- rendering ----------
  attachmentMarkup(item) {
    const external = item.external ? '<span class="attachment-external">External</span>' : '';
    if (item.kind === 'image') {
      const data = item.data || (item.source && item.source.data) || null;
      const source = item.previewDataUrl || (data ? `data:${item.mimeType || item.mime_type || 'image/png'};base64,${data}` : '');
      return `<div class="message-attachment image">${source ? `<img src="${esc(source)}" alt="${esc(item.name || 'Attached image')}" />` : '<span class="attachment-file-icon">IMG</span>'}<span><strong>${esc(item.name || 'Image')}</strong><small>${esc(item.mimeType || item.mime_type || 'image')} · ${formatBytes(item.size || (data ? Math.floor(data.length * 0.75) : 0))}</small></span>${external}</div>`;
    }
    const icon = item.kind === 'session' ? 'CHAT' : item.kind === 'folder' ? 'DIR' : 'DOC';
    return `<div class="message-attachment file"><span class="attachment-file-icon">${icon}</span><span><strong>${esc(item.name || 'Attachment')}</strong><small>${esc(item.mimeType || item.kind || 'file')} · ${formatBytes(item.size)}</small></span>${external}</div>`;
  }

  addUserBubble(text, attachments = []) {
    this.hideEmpty();
    const div = document.createElement('div');
    div.className = 'msg user';
    const body = text ? `<div class="msg-body">${esc(text)}</div>` : '';
    const tray = attachments.length ? `<div class="message-attachment-list">${attachments.map((item) => this.attachmentMarkup(item)).join('')}</div>` : '';
    div.innerHTML = `<div class="msg-role">You</div>${body}${tray}`;
    this.chatEl.appendChild(div);
    this._keepScrollAnchorLast();
    this.scrollBottom(true, true);
  }

  addNotice(text) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.textContent = text;
    this.chatEl.appendChild(div);
    this._keepScrollAnchorLast();
    this.scrollBottom(true, false);
  }

  beginStream() {
    this.hideEmpty();
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    msg.innerHTML = `<div class="msg-role">Prime Agent</div><div class="msg-body"></div>`;
    this.chatEl.appendChild(msg);
    this._keepScrollAnchorLast();
    this.stream = { root: msg.querySelector('.msg-body'), blocks: new Map(), rafPending: false };
    // New assistant turn re-engages follow (user just sent / new reply started).
    this.scrollBottom(true, true);
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
      if (!this.stream) return;
      for (const b of this.stream.blocks.values()) this.renderStreamBlock(b);
      this._keepScrollAnchorLast();
      // Pin only if user is following — never re-arm stick mid-stream.
      this.scrollBottom(true, false);
    });
  }
  endStream() {
    if (!this.stream) return;
    for (const b of this.stream.blocks.values()) this.renderStreamBlock(b);
    this.stream = null;
    this._keepScrollAnchorLast();
    this.scrollBottom(true, false);
    this._stopFollowLoop();
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
    this._keepScrollAnchorLast();
    card = { el, dot: el.querySelector('.tool-dot'), out: el.querySelector('.t-out'), outPre: el.querySelector('.t-out pre') };
    this.toolCards.set(toolCallId, card);
    this.scrollBottom(true, false);
    return card;
  }
  toolResult(card, result, isError) {
    card.dot.className = 'tool-dot ' + (isError ? 'err' : 'ok');
    const text = extractText(result && result.content);
    if (text) {
      card.out.classList.remove('hidden');
      card.outPre.textContent = text.length > 20000 ? text.slice(0, 20000) + '\n… [truncated]' : text;
    }
    this._keepScrollAnchorLast();
    this.scrollBottom(true, false);
  }

  renderHistory(messages, opts) {
    this.chatEl.innerHTML = '';
    this._scrollAnchor = null;
    this.toolCards.clear();
    this.endStream();
    this.ensureScrollFollowObserver();
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
        const rawText = typeof m.content === 'string' ? m.content : extractText(m.content);
        const parsed = parseLocalFileTransport(rawText);
        const images = Array.isArray(m.content) ? m.content.filter((part) => part && part.type === 'image').map((part, index) => ({
          kind: 'image', name: part.name || `Image ${index + 1}`, mimeType: part.mimeType || part.mime_type || 'image/png',
          size: (part.data || (part.source && part.source.data)) ? Math.floor((part.data || part.source.data).length * 0.75) : 0,
          data: part.data || (part.source && part.source.data) || null,
        })) : [];
        if (parsed.text || parsed.files.length || images.length) this.addUserBubble(parsed.text, [...images, ...parsed.files]);
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
    this._keepScrollAnchorLast();
    this.scrollBottom(true, true);
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
      case 'rlm_child_update': {
        if (G.focused === this) void refreshLiveAgents(this);
        break;
      }
      case 'session_resynced': {
        const state = ev.state || {};
        this.isStreaming = !!state.isStreaming;
        this.model = state.model || this.model;
        this.thinkingLevel = state.thinkingLevel || this.thinkingLevel;
        this.renderHistory(ev.messages || [], { dropInFlight: false });
        if (this.isStreaming && ev.streamingMessage && ev.streamingMessage.role === 'assistant') {
          this.beginStream();
          this.syncStreamFromMessage(ev.streamingMessage);
          this.scheduleStreamRender();
        } else if (this.isStreaming) {
          this.setAgentState('working…');
        }
        this.updateTopbar();
        this.updateComposer();
        renderSidebar();
        if (G.focused === this) void refreshLiveAgents(this);
        break;
      }
      case 'agent_start':
        void refreshLiveAgents(this);
        this.isStreaming = true;
        this.setAgentState('working…');
        this.updateComposer();
        renderSidebar();
        if (G.focused === this) void refreshLiveAgents(this);
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
            this.scrollBottom(true, false);
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
        this._stopFollowLoop();
        this.updateComposer();
        this.syncState();
        refreshSessions();
        if (G.focused === this) void refreshLiveAgents(this);
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
  if (pane && pane.key) prime.touchClient(pane.key);
  if (pane) pane.updateTopbar();
  updateSplitControls();
  if (treeVisible) void renderTreeRoot();
  void refreshLiveAgents(pane);
}

function updateSplitControls() {
  const atLimit = G.panes.length >= 2;
  const title = atLimit
    ? 'Two panes maximum. Close a pane before opening another.'
    : 'Open this session side by side in the same window';
  for (const pane of G.panes) {
    pane.splitBtn.disabled = atLimit;
    pane.splitBtn.title = title;
    pane.splitBtn.setAttribute('aria-label', atLimit ? 'Split View unavailable: two panes maximum' : 'Split View');
  }
  for (const button of $$('.s-split')) {
    button.disabled = atLimit;
    button.title = atLimit ? 'Two panes maximum. Close a pane before opening another.' : 'Open in Split View';
  }
  if (prime.setSplitAvailable) void prime.setSplitAvailable(!atLimit);
}

function toggleMenu(menu, show) {
  $$('.picker-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
  menu.classList.toggle('hidden', show === undefined ? undefined : !show);
}

async function createPane(index, sessionPath, sourcePane = null) {
  const pane = new Pane(index);
  G.panes.push(pane);
  if (index > 0) {
    pane.closeBtn.classList.remove('hidden');
    document.body.classList.add('split');
  }
  setFocusedPane(pane);
  await pane.activate(sessionPath || null, sourcePane);
  updateSplitControls();
  return pane;
}

async function closePane(pane) {
  // Closing a split pane is navigation, not stop. Live work continues in the
  // background (Hermes model). Only local draft/send locks block close.
  if (G.panes.length <= 1) return;
  if (!pane.canChangeBinding('closing this pane', { allowStreaming: true })) return;
  if (pane.key && pane.paneId) {
    const released = await prime.releasePane(pane.key, pane.paneId, pane.bindingEpoch, { allowStreaming: true });
    if (!released.ok) { pane.setBanner(released.error || 'This pane could not be closed', true); return; }
  }
  if (pane._chatResizeObserver) {
    try { pane._chatResizeObserver.disconnect(); } catch {}
    pane._chatResizeObserver = null;
  }
  if (pane._chatMutationObserver) {
    try { pane._chatMutationObserver.disconnect(); } catch {}
    pane._chatMutationObserver = null;
  }
  if (pane._stopFollowLoop) pane._stopFollowLoop();
  G.panes = G.panes.filter((p) => p !== pane);
  pane.activationRequest += 1;
  pane.el.remove();
  if (!G.panes.some((p) => p.index > 0)) document.body.classList.remove('split');
  setFocusedPane(G.panes[G.panes.length - 1]);
  updateSplitControls();
  // Process-owned sessions may keep running; resident daemon sessions detach
  // after their final Desktop pane/HUD consumer releases them.
}

async function splitPane(sessionPath = null, sourcePane = null) {
  if (G.panes.length >= 2) {
    (G.focused || G.panes[0]).setBanner('Two panes maximum. Close a pane before opening another.', true);
    updateSplitControls();
    return false;
  }
  const source = sourcePane || G.focused;
  // Blank chats inherit project/cwd from source; named sessions activate by path alone.
  const pane = await createPane(1, sessionPath, sessionPath ? null : source);
  return !!(pane && pane.ready);
}

// Compatibility name retained for saved-session drag/drop call sites.
const splitWithSession = splitPane;

/**
 * Hermes-style navigation:
 * - Sidebar session click always opens that session in the SINGLE center pane.
 * - Never auto-splits. If a split is open, collapse it first, then show the session.
 * - New Chat replaces the focused/center pane in place (also collapses split so
 *   center is unambiguous).
 * - Split View is explicit only: pane Split button, sidebar "▥ Split", or
 *   drag-drop a session onto the chat surface.
 */
async function collapseToPrimaryPane() {
  // Close secondary panes until only the primary center pane remains.
  while (G.panes.length > 1) {
    const extra = G.panes[G.panes.length - 1];
    const before = G.panes.length;
    await closePane(extra);
    if (G.panes.length >= before) {
      // closePane refused (local lock); force-remove UI so navigation is never stuck.
      if (extra.key && extra.paneId) {
        try { await prime.releasePane(extra.key, extra.paneId, extra.bindingEpoch); } catch {}
      }
      G.panes = G.panes.filter((p) => p !== extra);
      if (extra._chatResizeObserver) {
        try { extra._chatResizeObserver.disconnect(); } catch {}
        extra._chatResizeObserver = null;
      }
      extra.activationRequest += 1;
      extra.el.remove();
      if (!G.panes.some((p) => p.index > 0)) document.body.classList.remove('split');
      setFocusedPane(G.panes[0] || null);
      updateSplitControls();
    }
  }
  if (G.panes[0]) setFocusedPane(G.panes[0]);
  return G.panes[0] || null;
}

async function startNewChat() {
  const pane = await collapseToPrimaryPane();
  if (!pane) return false;
  if (!pane.workspace.selected) {
    await openProjectSurface(pane);
    return false;
  }
  return pane.activate(null, null, { allowStreaming: true });
}

async function openSessionFromSidebar(sessionPath) {
  if (!sessionPath) return false;
  // HARD RULE: sidebar session click NEVER opens split view. Ever.
  // Collapse any existing split, then replace the single center pane in place.
  if (G.panes.length > 1 || document.body.classList.contains('split')) {
    try { await withTimeout(collapseToPrimaryPane(), 5_000, 'Could not leave split view'); }
    catch { /* continue with best-effort primary pane */ }
  }
  let pane = G.panes[0] || G.focused;
  if (!pane) {
    try { pane = await withTimeout(collapseToPrimaryPane(), 5_000, 'No pane available'); }
    catch { return false; }
  }
  if (!pane) return false;
  setFocusedPane(pane);
  // Already showing this session — never pay a full re-attach cost on a second click.
  if (pane.sessionFile === sessionPath && pane.ready && pane.key && !pane.bindingChangePending) {
    void refreshLiveAgents(pane);
    return true;
  }
  // Never let a sticky lock brick session clicks.
  if (pane.bindingChangePending) pane.clearBindingLock();
  return pane.activate(sessionPath, null, { allowStreaming: true });
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
  const matches = (s) => {
    const label = s.name || s.preview || 'Untitled session';
    return !filter || label.toLowerCase().includes(filter) || (s.cwd || '').toLowerCase().includes(filter);
  };
  const pinned = G.sessions.filter((s) => G.pinnedPaths.has(s.path) && matches(s));
  const rest = G.sessions.filter((s) => !G.pinnedPaths.has(s.path) && matches(s));
  // Active = the center/focused session only (not "any pane in a split").
  const activeSessionPath = (G.focused && G.focused.sessionFile) || (G.panes[0] && G.panes[0].sessionFile) || null;

  const makeItem = (s) => {
    const label = s.name || s.preview || 'Untitled session';
    const paneHere = G.panes.find((p) => p.sessionFile === s.path);
    const isActive = !!(activeSessionPath && s.path === activeSessionPath);
    const item = document.createElement('div');
    item.className = 'session-item' + (isActive ? ' active' : '');
    item.tabIndex = 0;
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-prime-session', s.path);
      e.dataTransfer.setData('text/plain', s.path);
    });
    const liveStreaming = !!(paneHere && paneHere.isStreaming) || !!s.daemonStreaming;
    const liveMarker = liveStreaming
      ? '<span class="live-dot" title="Streaming now"></span>'
      : s.daemonResident
        ? '<span class="live-dot resident" title="Running in Prime Agent terminal"></span>'
        : '';
    const liveMeta = liveStreaming ? ' · live' : (s.daemonResident ? ' · terminal live' : '');
    item.innerHTML = `
      <div class="s-name">${liveMarker}${esc(label)}</div>
      <div class="s-meta">${esc(baseName(s.cwd))} · ${relTime(s.updatedAt)} · ${s.messageCount} msgs${liveMeta}</div>
      <div class="s-actions">
        <button class="s-act s-split" title="Open in Split View" aria-label="Open in Split View">▥ Split</button>
        <button class="s-act s-pin ${G.pinnedPaths.has(s.path) ? 'pinned' : ''}" title="${G.pinnedPaths.has(s.path) ? 'Unpin' : 'Pin'} session">⌃</button>
        <button class="s-act s-edit" title="Rename session">✎</button>
        <button class="s-act s-delete" title="Delete session">✕</button>
      </div>`;
    item.onclick = (e) => {
      // Never treat session row clicks as "focus the other split pane".
      // Split is explicit via the row's Split button only.
      if (e.shiftKey) { togglePin(s.path); return; }
      if (e.target.closest('.s-actions')) return;
      // Instant visual selection — don't wait for attach/history.
      const hostEl = item.parentElement;
      if (hostEl) for (const el of hostEl.querySelectorAll('.session-item.active')) el.classList.remove('active');
      item.classList.add('active');
      void openSessionFromSidebar(s.path);
    };
    item.onkeydown = (e) => {
      if (e.target !== item || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      void openSessionFromSidebar(s.path);
    };
    item.querySelector('.s-name').ondblclick = (e) => { e.stopPropagation(); startRename(item, s); };
    item.querySelector('.s-split').onclick = (e) => { e.stopPropagation(); splitWithSession(s.path); };
    item.querySelector('.s-pin').onclick = (e) => { e.stopPropagation(); togglePin(s.path); };
    item.querySelector('.s-edit').onclick = (e) => { e.stopPropagation(); startRename(item, s); };
    item.querySelector('.s-delete').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this session? This cannot be undone.')) return;
      const deleted = await prime.deleteSession(s.path);
      if (!deleted.ok) {
        for (const pane of G.panes.filter((candidate) => candidate.sessionFile === s.path)) pane.setBanner(deleted.error || 'That session could not be deleted', true);
        return;
      }
      if (G.pinnedPaths.has(s.path)) { G.pinnedPaths.delete(s.path); await prime.writePrefs({ pins: [...G.pinnedPaths] }); }
      await refreshSessions();
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
  updateSplitControls();
}

async function loadPins() {
  const prefs = await prime.getPrefs();
  G.pinnedPaths = new Set(prefs.pins || []);
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

// ---------------- subagents / child agents (near-live) ----------------
G.liveAgents = [];
let liveAgentPoll = null;

function renderSubagents() {
  const focusedPath = (G.focused && G.focused.sessionFile) || null;
  // 1) Child sessions linked by parentSession to the focused center session
  const childSessions = focusedPath
    ? G.sessions.filter((s) => s.parentSession === focusedPath).slice(0, 30)
    : [];
  // 2) Live nested workers from RPC list_agents / get_active_subagents
  const live = Array.isArray(G.liveAgents) ? G.liveAgents.slice(0, 30) : [];
  const sec = $('#subagent-section');
  if (!childSessions.length && !live.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  const host = $('#subagent-list');
  host.innerHTML = '';

  if (live.length) {
    const liveLabel = document.createElement('div');
    liveLabel.className = 'section-label';
    liveLabel.textContent = 'LIVE WORKERS';
    host.appendChild(liveLabel);
    for (const agent of live) {
      const item = document.createElement('div');
      item.className = 'session-item subagent-item';
      const name = agent.name || agent.id || agent.role || 'worker';
      const status = agent.status || agent.state || (agent.isStreaming || agent.busy ? 'running' : 'idle');
      const detail = agent.model || agent.detail || agent.sessionFile || '';
      item.innerHTML = `
        <div class="s-name"><span class="sub-dot ${status === 'running' || status === 'streaming' ? 'live' : ''}"></span>${esc(name)}</div>
        <div class="s-meta">${esc(status)}${detail ? ' · ' + esc(String(detail).slice(0, 80)) : ''}</div>`;
      if (agent.sessionFile || agent.path) {
        const path = agent.sessionFile || agent.path;
        item.onclick = () => void openSessionFromSidebar(path);
        item.title = 'Open worker session';
      }
      host.appendChild(item);
    }
  }

  if (childSessions.length) {
    const childLabel = document.createElement('div');
    childLabel.className = 'section-label';
    childLabel.textContent = 'CHILD SESSIONS';
    host.appendChild(childLabel);
    for (const s of childSessions) {
      const item = document.createElement('div');
      item.className = 'session-item subagent-item';
      const label = s.name || s.preview || ('subagent depth ' + s.rlmDepth);
      const live = s.daemonStreaming || s.daemonResident;
      item.innerHTML = `
        <div class="s-name"><span class="sub-dot ${live ? 'live' : ''}"></span>${esc(label)}</div>
        <div class="s-meta">depth ${s.rlmDepth || 0} · ${relTime(s.updatedAt)} · ${s.messageCount} msgs${live ? ' · live' : ''}</div>`;
      item.onclick = () => openSubagentViewer(s);
      host.appendChild(item);
    }
  }
}

let liveAgentsInFlight = null;
let liveAgentsQueued = null;
async function refreshLiveAgents(pane = G.focused) {
  // Coalesce overlapping refreshes so polling never piles up behind a slow IPC.
  if (liveAgentsInFlight) {
    liveAgentsQueued = pane;
    return liveAgentsInFlight;
  }
  const run = async () => {
    const target = pane;
    const sessionPath = target && (target.sessionFile || (target.state && target.state.sessionFile)) || null;
    if (!target) {
      G.liveAgents = [];
      renderSubagents();
      renderAgentsDashboard();
      return;
    }
    try {
      // One IPC: main merges disk roster + live daemon children.
      const result = await prime.listAgents({ parentSessionPath: sessionPath }).catch(() => null);
      let list = (result && result.ok && Array.isArray(result.agents)) ? result.agents.slice() : [];

      // Only hit the live client if disk/live merge returned nothing while streaming.
      if (!list.length && target.key && target.ready && target.isStreaming) {
        try {
          const agents = await prime.command(target.key, { type: 'list_agents' }).catch(() => ({ success: false }));
          const raw = agents && agents.success ? agents.data : null;
          const extra = Array.isArray(raw) ? raw
            : (raw && Array.isArray(raw.agents) ? raw.agents
              : (raw && Array.isArray(raw.children) ? raw.children : []));
          for (const agent of extra) {
            if (!agent || typeof agent !== 'object') continue;
            list.push({
              id: agent.id || agent.childId || agent.sessionName || agent.label,
              childId: agent.id || agent.childId || null,
              name: agent.sessionName || agent.label || agent.name || agent.id || 'sub-agent',
              status: agent.status || 'unknown',
              running: ['running', 'queued', 'streaming', 'starting'].includes(String(agent.status || '').toLowerCase()),
              model: agent.model || null,
              recap: agent.recap || agent.answerPreview || null,
              sessionFile: agent.sessionFile || null,
              path: agent.sessionFile || null,
              sessionDir: agent.sessionDir || null,
              source: 'live-client',
            });
          }
        } catch {}
      }

      const seen = new Set();
      G.liveAgents = list.filter((agent) => {
        if (!agent || typeof agent !== 'object') return false;
        const status = String(agent.status || '').toLowerCase();
        // Keep running/queued always. Keep finished for a few minutes so the panel isn't empty the second a child ends.
        // Drop long-dead deleted rows so the panel matches Hermes "live spawn tree" feel.
        if (status === 'deleted' && !agent.running) {
          const age = Date.now() - (Date.parse(agent.updatedAt || 0) || 0);
          if (age > 2 * 60 * 1000) return false;
        }
        const key = String(agent.childId || agent.id || agent.sessionFile || agent.path || agent.name || '').slice(0, 300);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      G.liveAgents = [];
    }
    renderSubagents();
    renderAgentsDashboard();
  };

  liveAgentsInFlight = run().finally(() => {
    liveAgentsInFlight = null;
    if (liveAgentsQueued !== null) {
      const next = liveAgentsQueued;
      liveAgentsQueued = null;
      void refreshLiveAgents(next);
    }
  });
  return liveAgentsInFlight;
}

function ensureLiveAgentPolling() {
  if (liveAgentPoll) return;
  liveAgentPoll = setInterval(() => {
    if (!G.focused || !G.focused.ready) return;
    const dashOpen = !$('#agents-backdrop').classList.contains('hidden');
    // Hermes model: while a turn is live, keep the spawn tree fresh.
    if (dashOpen || G.focused.isStreaming || (G.liveAgents && G.liveAgents.some((a) => a.running))) {
      void refreshLiveAgents(G.focused);
    }
  }, 500);
}

let subagentPoll = null;
let currentViewerFile = null;
function agentSessionPath(agentOrSession) {
  if (!agentOrSession) return null;
  if (typeof agentOrSession === 'string') return agentOrSession;
  return agentOrSession.path || agentOrSession.sessionFile || agentOrSession.session_path || null;
}

async function openSubagentViewer(sessionOrAgent, { preferOpenSession = false } = {}) {
  currentViewerFile = null;
  const path = agentSessionPath(sessionOrAgent);
  const label = (sessionOrAgent && (sessionOrAgent.name || sessionOrAgent.label || sessionOrAgent.id || sessionOrAgent.role)) || (path ? path.split('/').pop() : 'worker');
  const status = sessionOrAgent && (sessionOrAgent.status || (sessionOrAgent.running ? 'running' : ''));

  // Full navigation into the child run when requested and a session file exists.
  if (preferOpenSession && path) {
    closeAgentsDashboard();
    await openSessionFromSidebar(path);
    return;
  }

  $('#viewer-add-chat').classList.add('hidden');
  $('#viewer-title').textContent = `Agent — ${label}${status ? ' · ' + status : ''}`;
  $('#viewer-backdrop').classList.remove('hidden');
  const body = $('#viewer-body');
  const render = async () => {
    body.innerHTML = '';
    // Header actions
    const actions = document.createElement('div');
    actions.className = 'viewer-actions';
    actions.style.cssText = 'display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap;';
    if (path) {
      const openBtn = document.createElement('button');
      openBtn.className = 's-btn';
      openBtn.textContent = 'Open live session';
      openBtn.onclick = () => { closeAgentsDashboard(); $('#viewer-backdrop').classList.add('hidden'); void openSessionFromSidebar(path); };
      actions.appendChild(openBtn);
      const copyBtn = document.createElement('button');
      copyBtn.className = 's-btn';
      copyBtn.textContent = 'Copy path';
      copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(path); copyBtn.textContent = 'Copied'; } catch {} };
      actions.appendChild(copyBtn);
    }
    body.appendChild(actions);

    if (sessionOrAgent && (sessionOrAgent.recap || sessionOrAgent.prompt || sessionOrAgent.model)) {
      const meta = document.createElement('div');
      meta.className = 's-help';
      meta.style.marginBottom = '10px';
      meta.innerHTML = [
        sessionOrAgent.model ? `<div><strong>Model</strong> · ${esc(sessionOrAgent.model)}</div>` : '',
        sessionOrAgent.recap ? `<div><strong>Recap</strong> · ${esc(sessionOrAgent.recap)}</div>` : '',
        sessionOrAgent.prompt ? `<div><strong>Task</strong> · ${esc(String(sessionOrAgent.prompt).slice(0, 400))}</div>` : '',
        sessionOrAgent.activity ? `<div><strong>Activity</strong> · ${esc(JSON.stringify(sessionOrAgent.activity))}</div>` : '',
      ].join('');
      body.appendChild(meta);
    }

    if (!path) {
      const pre = document.createElement('pre');
      pre.className = 'viewer-pre';
      pre.textContent = JSON.stringify(sessionOrAgent, null, 2);
      body.appendChild(pre);
      return;
    }
    const r = await prime.sessionTail(path, 120);
    if (!r.ok) {
      const err = document.createElement('p');
      err.className = 's-help';
      err.textContent = r.error || 'Could not load agent transcript';
      body.appendChild(err);
      return;
    }
    if (!r.messages || !r.messages.length) {
      const empty = document.createElement('p');
      empty.className = 's-help';
      empty.textContent = 'No messages yet — worker may still be starting.';
      body.appendChild(empty);
      return;
    }
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
  }, 1500);
}

function collectChildSessions(parentPath) {
  if (!parentPath) return [];
  return G.sessions.filter((s) => s.parentSession === parentPath).slice(0, 50);
}

function collectRelatedSessions(parentPath) {
  // Children + any daemon-resident sessions under same cwd as focused, for dashboard breadth.
  const focused = G.focused;
  const cwd = focused && focused.cwd;
  const kids = new Set(collectChildSessions(parentPath).map((s) => s.path));
  const related = [];
  for (const s of G.sessions) {
    if (kids.has(s.path) || s.path === parentPath) continue;
    if (s.daemonResident || s.daemonStreaming || (cwd && s.cwd === cwd && s.rlmDepth > 0)) related.push(s);
  }
  return related.slice(0, 40);
}

function renderAgentRows(host, rows, emptyText) {
  host.innerHTML = '';
  if (!rows.length) {
    host.innerHTML = `<div class="agent-empty">${esc(emptyText)}</div>`;
    return;
  }
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'agent-row';
    const running = !!(row.running || row.daemonStreaming || row.isStreaming || row.busy || row.status === 'running' || row.status === 'streaming');
    const status = running ? 'running' : (row.status || row.state || (row.daemonResident ? 'resident' : 'idle'));
    el.innerHTML = `
      <span class="sub-dot ${running ? 'live' : ''}"></span>
      <span class="ar-main">
        <div class="ar-name">${esc(row.name)}</div>
        <div class="ar-meta">${esc(row.meta || '')}</div>
      </span>
      <span class="ar-status ${running ? 'running' : 'idle'}">${esc(status)}</span>`;
    el.onclick = (event) => {
      if ((event.metaKey || event.ctrlKey || event.shiftKey) && row.path) {
        closeAgentsDashboard();
        void openSessionFromSidebar(row.path);
        return;
      }
      if (row.open === 'session' && row.path) void openSessionFromSidebar(row.path);
      else void openSubagentViewer(row.source || row);
    };
    el.title = row.path ? 'Click to inspect · ⌘/Ctrl-click to open live session' : 'Inspect agent';
    host.appendChild(el);
  }
}

function agentsEls() {
  return {
    backdrop: document.getElementById('agents-backdrop'),
    panel: document.getElementById('agents-panel'),
    live: document.getElementById('agents-live-list'),
    children: document.getElementById('agents-child-list'),
    related: document.getElementById('agents-related-list'),
    btn: document.getElementById('agents-btn'),
    close: document.getElementById('agents-close'),
    refresh: document.getElementById('agents-refresh'),
  };
}

function openAgentsDashboard() {
  // Open FIRST — never block the panel on data fetch (Hermes spawn-tree model).
  const els = agentsEls();
  if (!els.backdrop) {
    console.error('Agents panel missing from DOM');
    return;
  }
  els.backdrop.classList.remove('hidden');
  els.backdrop.style.display = 'flex';
  els.backdrop.setAttribute('aria-hidden', 'false');
  if (els.btn) els.btn.classList.add('active');
  try { ensureLiveAgentPolling(); } catch (err) { console.error(err); }
  // Fill immediately from cache, then refresh.
  try { renderAgentsDashboard(); } catch (err) { console.error(err); }
  void refreshLiveAgents(G.focused).then(() => {
    try { renderAgentsDashboard(); } catch (err) { console.error(err); }
  }).catch((err) => console.error(err));
}

function closeAgentsDashboard() {
  const els = agentsEls();
  if (!els.backdrop) return;
  els.backdrop.classList.add('hidden');
  els.backdrop.style.display = '';
  els.backdrop.setAttribute('aria-hidden', 'true');
  if (els.btn) els.btn.classList.remove('active');
}

function renderAgentsDashboard() {
  const els = agentsEls();
  if (!els.backdrop || els.backdrop.classList.contains('hidden')) return;
  const focusedPath = (G.focused && G.focused.sessionFile) || null;
  const bn = (typeof baseName === 'function')
    ? baseName
    : (value) => {
      const text = String(value || '');
      const parts = text.split(/[/\\]/);
      return parts[parts.length - 1] || text || '—';
    };

  // Hermes-style: one primary list = live / recent sub-agents for this turn/chat.
  const live = (G.liveAgents || []).map((agent) => {
    const status = String(agent.status || agent.state || '').toLowerCase();
    const running = !!(agent.running || agent.isStreaming || agent.busy
      || ['running', 'queued', 'streaming', 'starting'].includes(status));
    const metaParts = [
      agent.model,
      agent.recap || agent.detail || agent.prompt,
      status && status !== 'unknown' ? status : null,
    ].filter(Boolean).map(String);
    return {
      name: agent.name || agent.label || agent.id || agent.role || 'sub-agent',
      meta: metaParts.join(' · ').slice(0, 160),
      status: status || (running ? 'running' : 'idle'),
      running,
      path: agent.sessionFile || agent.path || null,
      source: agent,
      open: 'viewer',
    };
  });
  live.sort((a, b) => Number(b.running) - Number(a.running));

  // Secondary: disk-linked children only (same parent), not every random session.
  const children = collectChildSessions(focusedPath).map((s) => ({
    name: s.name || s.preview || s.id || 'child session',
    meta: `${bn(s.cwd)} · depth ${s.rlmDepth || 0} · ${s.messageCount || 0} msgs`,
    status: s.daemonStreaming ? 'running' : (s.daemonResident ? 'resident' : 'idle'),
    running: !!s.daemonStreaming,
    path: s.path,
    source: s,
    open: 'viewer',
  }));

  if (els.live) {
    renderAgentRows(
      els.live,
      live,
      focusedPath
        ? 'No live sub-agents on this chat yet. When the run spawns children, they appear here instantly.'
        : 'Open a chat first. Sub-agents for that run show up here while they work.',
    );
  }
  if (els.children) {
    renderAgentRows(els.children, children, 'No linked child sessions for this chat.');
  }
  // Related list intentionally unused in the simplified Hermes-like panel.
  if (els.related) {
    els.related.innerHTML = '';
  }
}

// ---------------- projects / worktrees ----------------
let projectSurfacePane = null;
function setProjectError(message) {
  const element = $('#project-choice-error');
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
}
function closeProjectSurface() {
  $('#project-surface').classList.add('hidden');
  if (projectSurfacePane) {
    projectSurfacePane.folderBtn.setAttribute('aria-expanded', 'false');
    projectSurfacePane.folderBtn.focus();
  }
  projectSurfacePane = null;
}
async function adoptWorkspaceActivation(pane, response, requestId) {
  if (!response.ok || requestId !== pane.activationRequest) return false;
  if (!await pane.applyActivation(response, null, requestId)) return false;
  await refreshSessions();
  setFocusedPane(pane);
  return true;
}
function renderProjectChoices(pane, choices) {
  const host = $('#project-choice-list');
  host.innerHTML = '';
  for (const choice of choices || []) {
    const button = document.createElement('button');
    button.className = 'project-choice' + (choice.current ? ' current' : '');
    const label = choice.kind === 'worktree' ? 'Worktree' : choice.kind === 'recent' ? 'Recent' : choice.kind === 'current' ? 'Current project' : 'Project';
    button.innerHTML = `<span class="project-choice-icon">${choice.kind === 'worktree' ? '⑂' : '⌘'}</span><span><strong>${esc(choice.name)}</strong><small>${esc(choice.branch || choice.path)}</small></span><em>${label}</em>`;
    button.onclick = async () => {
      if (choice.current) { closeProjectSurface(); return; }
      setProjectError(null);
      if (!pane.canChangeBinding('changing projects')) { setProjectError(pane.isStreaming ? 'Stop the current response before changing projects' : 'Wait for the current draft before changing projects'); return; }
      const requestId = ++pane.activationRequest;
      pane.bindingChangePending = true;
      pane.updateComposer();
      button.disabled = true;
      try {
        const response = await prime.activateWorkspace(pane.key, pane.paneId, pane.bindingEpoch, choice.id);
        if (!response.ok) { setProjectError(response.error || 'That project could not be opened'); return; }
        if (!await adoptWorkspaceActivation(pane, response, requestId)) return;
        closeProjectSurface();
        pane.inputEl.focus();
      } catch { setProjectError('That project could not be opened'); }
      finally { pane.bindingChangePending = false; pane.updateComposer(); button.disabled = false; }
    };
    host.appendChild(button);
  }
  if (!host.children.length) host.innerHTML = '<div class="project-empty">No recent projects yet.</div>';
}
async function openProjectSurface(pane = G.focused) {
  if (!pane || !pane.key || !pane.paneId) return;
  projectSurfacePane = pane;
  setProjectError(null);
  const response = await prime.getWorkspace(pane.key, pane.paneId, pane.bindingEpoch).catch(() => ({ ok: false }));
  if (response.ok) {
    pane.workspace = response.workspace || { selected: false, generation: 0 };
    pane.cwd = pane.workspace.selected ? pane.workspace.cwd : null;
    pane.updateTopbar();
    renderProjectChoices(pane, response.choices || []);
  }
  $('#project-surface').classList.remove('hidden');
  pane.folderBtn.setAttribute('aria-expanded', 'true');
  $('#choose-folder-btn').focus();
}
async function chooseFolderForProjectSurface() {
  const pane = projectSurfacePane || G.focused;
  if (!pane) return;
  const button = $('#choose-folder-btn');
  setProjectError(null);
  if (!pane.canChangeBinding('changing projects')) { setProjectError(pane.isStreaming ? 'Stop the current response before changing projects' : 'Wait for the current draft before changing projects'); return; }
  const requestId = ++pane.activationRequest;
  pane.bindingChangePending = true;
  pane.updateComposer();
  button.disabled = true;
  try {
    const response = await prime.pickWorkspace(pane.key, pane.paneId, pane.bindingEpoch);
    if (response.canceled) return;
    if (!response.ok) { setProjectError(response.error || 'That project could not be opened'); return; }
    if (!await adoptWorkspaceActivation(pane, response, requestId)) return;
    closeProjectSurface();
    pane.inputEl.focus();
  } catch { setProjectError('That project could not be opened'); }
  finally { pane.bindingChangePending = false; pane.updateComposer(); button.disabled = false; }
}
$('#project-surface-close').onclick = closeProjectSurface;
$('#choose-folder-btn').onclick = chooseFolderForProjectSurface;

// ---------------- safe project file tree ----------------
let treeVisible = false;
let treeEpoch = 0;
async function toggleTree(force) {
  treeVisible = typeof force === 'boolean' ? force : !treeVisible;
  $('#tree-panel').classList.toggle('hidden', !treeVisible);
  if (treeVisible) await renderTreeRoot();
}
async function renderTreeRoot() {
  const host = $('#tree-body');
  const pane = G.focused;
  const epoch = ++treeEpoch;
  if (!pane || !pane.workspace || !pane.workspace.selected) {
    $('#tree-root-label').textContent = 'Files';
    $('#tree-root-label').title = '';
    host.innerHTML = '<div class="tree-state"><strong>No project selected</strong><span>Choose a project to browse its files.</span><button class="s-btn">Choose project</button></div>';
    host.querySelector('button').onclick = () => openProjectSurface(pane);
    return;
  }
  $('#tree-root-label').textContent = pane.workspace.name;
  $('#tree-root-label').title = pane.workspace.cwd;
  await renderTreeLevel(pane, host, pane.workspace.rootNodeId, epoch, null, false);
}
async function renderTreeLevel(pane, container, nodeId, epoch, cursor = null, append = false) {
  if (!append) container.innerHTML = '<div class="tree-loading"><span></span> Loading…</div>';
  const workspaceSnapshot = pane.workspace;
  const response = await prime.listWorkspaceDirectory(pane.key, pane.paneId, pane.bindingEpoch, {
    workspaceId: workspaceSnapshot.workspaceId,
    generation: workspaceSnapshot.generation,
    nodeId,
    cursor,
  });
  if (epoch !== treeEpoch || !treeVisible || G.focused !== pane || pane.workspace.workspaceId !== workspaceSnapshot.workspaceId) return;
  if (!append) container.innerHTML = '';
  if (!response.ok) {
    const state = document.createElement('div');
    state.className = 'tree-state error';
    state.innerHTML = `<strong>${response.code === 'NO_PROJECT' ? 'No project selected' : 'Folder unavailable'}</strong><span>${esc(response.error || 'This folder could not be read.')}</span><button class="s-btn">Retry</button>`;
    state.querySelector('button').onclick = () => renderTreeLevel(pane, container, nodeId, epoch);
    container.appendChild(state);
    return;
  }
  for (const entry of response.entries || []) {
    const group = document.createElement('div');
    group.className = 'tree-entry';
    const row = document.createElement('div');
    row.className = 'tree-row ' + entry.type;
    row.dataset.nodeId = entry.nodeId;
    row.title = entry.relativePath;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', entry.type === 'dir' ? `Toggle folder ${entry.name}` : `Add ${entry.name} to chat`);
    row.innerHTML = `<span class="tree-icon">${entry.type === 'dir' ? '▸' : '·'}</span><span class="tree-name">${esc(entry.name)}</span>${entry.symlink ? '<span class="tree-symlink">↗</span>' : ''}${entry.type === 'file' ? '<button class="tree-preview" title="Preview file" aria-label="Preview ' + esc(entry.name) + '">⌕</button>' : ''}`;
    row.oncontextmenu = (event) => { event.preventDefault(); prime.showWorkspaceContextMenu(pane.key, pane.paneId, pane.bindingEpoch, entry.nodeId); };
    row.onkeydown = (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.tree-preview')) { event.preventDefault(); row.click(); }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); prime.showWorkspaceContextMenu(pane.key, pane.paneId, pane.bindingEpoch, entry.nodeId); }
    };
    if (entry.type === 'dir') {
      row.onclick = async () => {
        const open = row.dataset.open === '1';
        row.dataset.open = open ? '0' : '1';
        row.querySelector('.tree-icon').textContent = open ? '▸' : '▾';
        if (open) { group.querySelector('.tree-children')?.remove(); return; }
        const children = document.createElement('div');
        children.className = 'tree-children';
        group.appendChild(children);
        await renderTreeLevel(pane, children, entry.nodeId, epoch);
      };
    } else {
      row.onclick = async (event) => {
        if (event.target.closest('.tree-preview')) return;
        await pane.addTreeAttachment(entry.nodeId);
        pane.inputEl.focus();
      };
      row.querySelector('.tree-preview').onclick = (event) => {
        event.stopPropagation();
        openWorkspaceFileViewer(pane, entry.nodeId, entry.name);
      };
    }
    group.appendChild(row);
    container.appendChild(group);
  }
  if (!(response.entries || []).length && !append) container.innerHTML = '<div class="tree-state"><strong>Empty folder</strong><span>There are no visible files here.</span></div>';
  if (response.truncated && response.nextCursor) {
    const more = document.createElement('button');
    more.className = 'tree-load-more';
    more.textContent = `Load more (${Math.max(0, response.total - container.querySelectorAll('.tree-row').length)} remaining)`;
    more.onclick = async () => { more.remove(); await renderTreeLevel(pane, container, nodeId, epoch, response.nextCursor, true); };
    container.appendChild(more);
  }
}
async function openWorkspaceFileViewer(pane, nodeId, name) {
  currentViewerFile = { pane, nodeId, name };
  $('#viewer-add-chat').classList.remove('hidden');
  $('#viewer-title').textContent = name || 'File preview';
  const body = $('#viewer-body');
  body.innerHTML = '<p class="s-help">Loading…</p>';
  $('#viewer-backdrop').classList.remove('hidden');
  const response = await prime.readWorkspaceFile(pane.key, pane.paneId, pane.bindingEpoch, nodeId, 200000);
  if (!response.ok) {
    body.innerHTML = response.binary
      ? '<div class="tree-state"><strong>Preview unavailable</strong><span>This binary file can still be added to chat or revealed from its context menu.</span></div>'
      : `<div class="tree-state error"><strong>Cannot preview file</strong><span>${esc(response.error || '')}</span></div>`;
    return;
  }
  const pre = document.createElement('pre');
  pre.className = 'viewer-pre';
  pre.textContent = response.text + (response.truncated ? '\n\n… [truncated]' : '');
  body.replaceChildren(pre);
}

// ---------------- restart helpers ----------------
async function restartAllAgents() {
  // Restart is a deliberate lifecycle action: clear local stream/send locks first.
  for (const pane of G.panes) {
    pane.sending = false;
    if (pane.draftState && pane.draftState.sending) pane.draftState.clearSending();
    if (pane.isStreaming) {
      try { await pane.stop(); } catch {}
      pane.isStreaming = false;
      pane.endStream();
    }
  }
  for (const pane of G.panes) if (!pane.canChangeBinding('restarting agents', { allowStreaming: true })) return false;
  const snapshot = G.panes.map((pane) => ({ pane, sessionFile: pane.sessionFile }));
  for (const { pane } of snapshot) { pane.bindingChangePending = true; pane.updateComposer(); }
  try {
    const stopped = await prime.killAllAgents({ preserveDrafts: true });
    if (!stopped.ok) {
      for (const { pane } of snapshot) pane.setBanner(stopped.error || 'Agents could not be restarted', true);
      return false;
    }
    let restored = true;
    for (const { pane, sessionFile } of snapshot) {
      pane.bindingChangePending = false;
      pane.ready = false;
      pane.isStreaming = false;
      // Keep paneId/key/epoch so main can find the pane context and preserve drafts.
      // Main treats dead clients as rebindable.
      try { if (!await pane.activate(sessionFile || null, null, { allowStreaming: true })) restored = false; }
      catch { restored = false; }
    }
    renderSidebar();
    return restored;
  } finally {
    for (const { pane } of snapshot) { pane.bindingChangePending = false; pane.updateComposer(); }
  }
}

async function recoverPanesForKey(key) {
  const targets = G.panes.filter((pane) => pane.key === key);
  for (const pane of targets) if (!pane.canChangeBinding('recovering this session')) return false;
  for (const pane of targets) { pane.bindingChangePending = true; pane.updateComposer(); }
  try {
    let recovered = true;
    for (const pane of targets) {
      pane.bindingChangePending = false;
      pane.ready = false;
      try { if (!await pane.activate(pane.sessionFile || null, null, { allowStreaming: true })) recovered = false; }
      catch { recovered = false; }
    }
    return recovered;
  } finally {
    for (const pane of targets) { pane.bindingChangePending = false; pane.updateComposer(); }
  }
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
    <div class="s-field ${isBuiltinExtension ? 'hidden' : ''}"><label>API key <span class="s-dim">(blank preserves; use none to remove, or enter a literal, ENV_VAR, or !shell command)</span></label>
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
      entry = { baseUrl, api, models };
      if (apiKey) entry.apiKey = apiKey;
      else if (!prev.hasApiKey) entry.apiKey = 'none';
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
    row.querySelector('.p-name').onclick = async () => {
      const response = await prime.readSkill(s.id);
      if (!response.ok) return;
      $('#viewer-title').textContent = s.name;
      const pre = document.createElement('pre');
      pre.className = 'viewer-pre';
      pre.textContent = response.text + (response.truncated ? '\n\n… [truncated]' : '');
      $('#viewer-body').replaceChildren(pre);
      currentViewerFile = null;
      $('#viewer-add-chat').classList.add('hidden');
      $('#viewer-backdrop').classList.remove('hidden');
    };
    row.querySelector('input').onchange = async (e) => {
      const r = await prime.toggleSkill(s.id, e.target.checked);
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

function scheduleText(schedule) {
  if (!schedule) return '';
  if (typeof schedule === 'string') return schedule;
  return schedule.expression || schedule.kind || '';
}
function jobTiming(job) {
  const bits = [];
  if (job.nextRunAt) bits.push('next ' + relTime(Date.parse(job.nextRunAt)));
  if (job.lastRunAt) bits.push('last ' + relTime(Date.parse(job.lastRunAt)));
  if (Number.isFinite(job.runCount)) bits.push(job.runCount + ' runs');
  return bits.join(' · ');
}

async function renderSchedulesList() {
  const pane = scheduleClient();
  const host = $('#schedules-list');
  host.innerHTML = '<p class="s-help">Loading…</p>';
  const r = await prime.automationCommand(pane.key, { type: 'list_schedules', includeInactive: true });
  const jobs = (r.success && r.data.jobs) || [];
  host.innerHTML = jobs.length ? '' : '<p class="s-help">No scheduled jobs.</p>';
  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    const summary = (j.prompt || '').slice(0, 72) + ((j.prompt || '').length > 72 ? '…' : '');
    const timing = jobTiming(j);
    row.innerHTML = `<span class="p-name" style="min-width:150px;font-family:var(--mono);font-size:12px">${esc(scheduleText(j.schedule))}</span>
      <span class="p-status" style="font-family:inherit"><b>${esc(j.label || summary || 'Scheduled prompt')}</b>${timing ? `<small>${esc(timing)}</small>` : ''}${j.lastError ? `<small class="error-text">${esc(j.lastError)}</small>` : ''}</span>
      <span class="p-actions"><span class="s-dim">${esc(j.status || 'active')}</span></span>`;
    const del = document.createElement('button');
    del.className = 's-btn danger'; del.textContent = 'Cancel';
    del.onclick = async () => {
      if (!confirm('Cancel this scheduled job?')) return;
      await prime.automationCommand(pane.key, { type: 'cancel_schedule', jobId: j.id || j.jobId });
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
  const r = await prime.automationCommand(pane.key, { type: 'list_heartbeats' });
  const hbs = (r.success && r.data.heartbeats) || [];
  host.innerHTML = hbs.length ? '' : '<p class="s-help">No heartbeats configured.</p>';
  for (const heartbeat of hbs) {
    const h = heartbeat.job || heartbeat;
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = `<span class="p-name" style="min-width:150px;font-family:var(--mono);font-size:12px">${esc(scheduleText(h.schedule))}</span>
      <span class="p-status" style="font-family:inherit"><b>${esc(h.label || heartbeat.sessionName || 'Heartbeat')}</b><small>${esc((h.prompt || heartbeat.firstMessage || '').slice(0, 72))}</small>${jobTiming(h) ? `<small>${esc(jobTiming(h))}</small>` : ''}</span>
      <span class="p-actions"><span class="s-dim">${esc(h.status || 'active')}</span></span>`;
    const actions = row.querySelector('.p-actions');
    for (const [label, action] of [['Pause', 'pause'], ['Resume', 'resume'], ['Stop', 'stop']]) {
      const b = document.createElement('button');
      b.className = 's-btn' + (action === 'stop' ? ' danger' : '');
      b.textContent = label;
      b.disabled = (action === 'pause' && h.status === 'paused') || (action === 'resume' && h.status === 'active');
      b.onclick = async () => {
        await prime.automationCommand(pane.key, { type: 'manage_heartbeat', activeSessionId: h.activeSessionId, jobId: h.id, action });
        renderHeartbeatsList();
      };
      actions.appendChild(b);
    }
    host.appendChild(row);
  }
}

// ---------------- menu actions / wiring ----------------
$('#new-chat-btn').onclick = () => { void startNewChat(); };
$('#new-folder-chat-btn').onclick = () => openProjectSurface(G.focused);
$('#session-filter').addEventListener('input', renderSidebar);
$('#hud-btn').onclick = () => prime.toggleHud();
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

(function wireAgentsPanel() {
  const els = agentsEls();
  if (els.btn) {
    els.btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAgentsDashboard();
    });
  } else {
    console.error('agents-btn missing — Agents panel cannot open');
  }
  if (els.close) els.close.addEventListener('click', (event) => { event.preventDefault(); closeAgentsDashboard(); });
  if (els.refresh) {
    els.refresh.addEventListener('click', async (event) => {
      event.preventDefault();
      await refreshLiveAgents(G.focused);
      renderAgentsDashboard();
    });
  }
  if (els.backdrop) {
    els.backdrop.addEventListener('click', (event) => {
      if (event.target === els.backdrop) closeAgentsDashboard();
    });
  }
})();
if ($('#capabilities-btn')) $('#capabilities-btn').onclick = openCapabilities;
else console.error('capabilities-btn missing');
if ($('#capabilities-close')) $('#capabilities-close').onclick = () => $('#capabilities-backdrop').classList.add('hidden');
if ($('#capabilities-backdrop')) $('#capabilities-backdrop').onclick = (e) => { if (e.target === $('#capabilities-backdrop')) $('#capabilities-backdrop').classList.add('hidden'); };
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
  const r = await prime.automationCommand(pane.key, { type: 'add_schedule', schedule, prompt: promptText });
  if (r.success) { $('#schedule-form').classList.add('hidden'); $('#sf-schedule').value = ''; $('#sf-prompt').value = ''; renderSchedulesList(); }
  else alert('Failed: ' + (r.error || 'unknown'));
};

$('#tree-close').onclick = () => toggleTree(false);
$('#tree-refresh').onclick = async () => {
  if (G.focused && G.focused.key) await prime.refreshWorkspace(G.focused.key, G.focused.paneId, G.focused.bindingEpoch);
  if (treeVisible) await renderTreeRoot();
};
$('#viewer-add-chat').onclick = async () => {
  if (!currentViewerFile || !currentViewerFile.pane) return;
  await currentViewerFile.pane.addTreeAttachment(currentViewerFile.nodeId);
  $('#viewer-backdrop').classList.add('hidden');
  setFocusedPane(currentViewerFile.pane);
  currentViewerFile.pane.inputEl.focus();
};
$('#viewer-close').onclick = () => { clearInterval(subagentPoll); $('#viewer-backdrop').classList.add('hidden'); };
$('#viewer-backdrop').onclick = (e) => { if (e.target === $('#viewer-backdrop')) { clearInterval(subagentPoll); $('#viewer-backdrop').classList.add('hidden'); } };

function closeTopSurface() {
  if ($('#agents-backdrop') && !$('#agents-backdrop').classList.contains('hidden')) { closeAgentsDashboard(); return true; }
  const surfaces = [
    ['#modal-backdrop', () => $('#modal-backdrop').classList.add('hidden')],
    ['#viewer-backdrop', () => { clearInterval(subagentPoll); $('#viewer-backdrop').classList.add('hidden'); }],
    ['#schedules-backdrop', () => $('#schedules-backdrop').classList.add('hidden')],
    ['#capabilities-backdrop', () => $('#capabilities-backdrop').classList.add('hidden')],
    ['#settings-backdrop', closeSettings],
    ['#project-surface', closeProjectSurface],
  ];
  for (const [selector, close] of surfaces) {
    if (!$(selector).classList.contains('hidden')) { close(); if (G.focused) G.focused.inputEl.focus(); return true; }
  }
  const openMenu = [...document.querySelectorAll('.picker-menu')].find((menu) => !menu.classList.contains('hidden'));
  if (openMenu) { openMenu.classList.add('hidden'); if (G.focused) G.focused.inputEl.focus(); return true; }
  return false;
}
document.addEventListener('keydown', (event) => {
  const command = event.metaKey || event.ctrlKey;
  if (command && !event.altKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    void openProjectSurface(G.focused);
    return;
  }
  if (command && event.shiftKey && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    if (G.focused) void G.focused.pickAttachments();
    return;
  }
  if (command && !event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    void startNewChat();
    return;
  }
  if (event.key === 'Escape' && closeTopSurface()) event.preventDefault();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.picker')) $$('.picker-menu').forEach((menu) => menu.classList.add('hidden'));
});
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  });
}
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer || !event.dataTransfer.files.length) return;
  event.preventDefault();
  if (G.focused) void G.focused.handleFileDrop(event);
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
  for (const pane of G.panes.filter((p) => p.key === key)) pane.handleEvent(event);
});
prime.onSessionsChanged((list) => refreshSessions(list));
if (typeof prime.onAgentsChanged === 'function') {
  prime.onAgentsChanged(() => { if (G.focused) void refreshLiveAgents(G.focused); });
}
prime.onWorkspaceInvalidated(({ key, degraded }) => {
  if (degraded) {
    for (const pane of G.panes.filter((candidate) => candidate.key === key)) pane.setBanner('Automatic project watching stopped. Refresh Files manually to see later changes.', false);
  }
  if (treeVisible && G.focused && G.focused.key === key) void renderTreeRoot();
});
prime.onWorkspaceChanged(({ key, paneId, bindingEpoch, workspace }) => {
  const pane = G.panes.find((candidate) => candidate.paneId === paneId && candidate.key === key && candidate.bindingEpoch === bindingEpoch);
  if (!pane || !workspace) return;
  pane.workspace = workspace;
  pane.cwd = workspace.selected ? workspace.cwd : null;
  pane.updateTopbar();
});
prime.onAttachmentsReset(({ key, paneId, bindingEpoch, draft }) => {
  const pane = G.panes.find((candidate) => candidate.paneId === paneId && candidate.key === key && candidate.bindingEpoch === bindingEpoch);
  if (!pane || !draft || pane.draftState.sending) return;
  pane.draftState.reset(draft);
  pane.renderAttachments();
});
prime.onRpcExit(({ key, code, error }) => {
  const targets = G.panes.filter((pane) => pane.key === key);
  const recover = async () => {
    for (const pane of targets) pane.bannerEl.onclick = null;
    await recoverPanesForKey(key);
  };
  for (const pane of targets) {
    pane.isStreaming = false;
    pane.endStream();
    pane.updateComposer();
    pane.setBanner(`${error || 'Agent connection closed'} (code ${code}). Click to restart.`, true);
    pane.bannerEl.style.cursor = 'pointer';
    pane.bannerEl.onclick = recover;
  }
});
prime.onRpcError(({ key, message }) => {
  const pane = (key && G.panes.find((p) => p.key === key)) || G.focused;
  if (pane) pane.setBanner(message || 'Agent process error.', true);
});
prime.onHudShortcutStatus(({ registered, message }) => {
  if (registered) return;
  G.hudShortcutWarning = message || 'The global HUD shortcut is unavailable. Use Prime HUD here or Window → Show Prime HUD.';
  showHudShortcutWarning(G.focused);
});
prime.onMenuAction(({ id }) => {
  if (id === 'new-chat') void startNewChat();
  else if (id === 'split-view') void splitPane(G.focused && G.focused.sessionFile || null);
  else if (id === 'new-chat-split') void splitPane(null);
  else if (id === 'toggle-hud') void prime.toggleHud();
  else if (id === 'open-project') openProjectSurface(G.focused);
  else if (id === 'attach-files') G.focused && G.focused.pickAttachments();
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
  ensureLiveAgentPolling();
  void refreshLiveAgents(pane);
  const input = pane.inputEl;
  input.focus();
})();
