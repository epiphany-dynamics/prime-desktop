/* global prime */
const input = document.getElementById('input');
const output = document.getElementById('output');
const status = document.getElementById('status');
const sendButton = document.getElementById('send');
const abortButton = document.getElementById('abort');
let boundKey = null;
let active = false;

function assistantText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => part && part.type === 'text' ? (part.text || '') : '').join('');
}

function showOutput(text, isError) {
  output.classList.remove('empty');
  output.textContent = text || (isError ? 'Unknown agent error.' : '');
  if (isError) output.textContent = 'Error: ' + output.textContent;
  output.scrollTop = output.scrollHeight;
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  const wasActive = active;
  if (!wasActive) showOutput('Waiting for Prime Agent…');
  status.className = '';
  status.textContent = wasActive ? 'steering…' : 'sending…';
  sendButton.disabled = true;
  const r = await prime.hudPrompt({ key: boundKey, text });
  sendButton.disabled = false;
  if (r.ok) {
    boundKey = r.key || boundKey;
    active = true;
    abortButton.disabled = false;
    status.className = 'ok';
    status.textContent = r.streaming ? 'Steered running agent' : 'Working…';
    input.value = '';
    input.focus();
  } else {
    status.className = 'err';
    status.textContent = 'Failed: ' + (r.error || 'unknown');
    showOutput(r.error || 'Unknown failure.', true);
  }
}

sendButton.onclick = send;
abortButton.onclick = async () => {
  abortButton.disabled = true;
  status.className = '';
  status.textContent = 'stopping…';
  const r = await prime.hudAbort();
  if (!r.ok) {
    status.className = 'err';
    status.textContent = 'Stop failed: ' + (r.error || 'unknown');
    abortButton.disabled = !active;
  }
};
document.getElementById('open-session').onclick = () => prime.hudOpenSession();

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape') prime.hudHide();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') prime.hudHide();
});

prime.onHudOpened((info) => {
  boundKey = info && info.key || null;
  active = !!(info && info.streaming);
  abortButton.disabled = !active;
  status.className = '';
  status.textContent = boundKey ? (active ? 'Agent is working…' : 'Ready') : 'No active session';
  output.className = 'empty';
  output.textContent = 'Response will appear here.';
  input.focus();
});

prime.onHudEvent(({ key, event }) => {
  if (!event) return;
  // Main only forwards events from the bound client; accept key remaps for new sessions.
  boundKey = key || boundKey;
  if (event.type === 'message_update' || event.type === 'message_end') {
    const streamError = event.assistantMessageEvent && event.assistantMessageEvent.type === 'error';
    if (streamError) {
      const err = event.assistantMessageEvent.error;
      showOutput(err && err.message || event.error || 'Generation failed.', true);
      status.className = 'err'; status.textContent = 'Generation failed';
      active = false; abortButton.disabled = true;
      return;
    }
    if (!event.message || event.message.role !== 'assistant') return;
    showOutput(assistantText(event.message));
    status.className = '';
    status.textContent = event.type === 'message_end' ? 'Finishing…' : 'Working…';
    active = true;
    abortButton.disabled = false;
  } else if (event.type === 'error') {
    const err = event.error;
    showOutput(typeof err === 'string' ? err : (err && err.message) || 'Agent error.', true);
    status.className = 'err'; status.textContent = 'Agent error';
    active = false; abortButton.disabled = true;
  } else if (event.type === 'agent_end') {
    active = false;
    abortButton.disabled = true;
    status.className = 'ok';
    status.textContent = 'Done';
  }
});
