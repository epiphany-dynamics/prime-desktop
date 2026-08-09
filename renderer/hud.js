/* global prime */
const input = document.getElementById('input');
const status = document.getElementById('status');

async function send() {
  const text = input.value.trim();
  if (!text) return;
  status.className = ''; status.textContent = 'sending…';
  const r = await prime.hudPrompt({ key: null, text });
  if (r.ok) {
    status.className = 'ok';
    status.textContent = r.streaming ? 'sent (steering the running agent)' : 'sent to current session';
    input.value = '';
    setTimeout(() => prime.hudHide(), 900);
  } else {
    status.className = 'err';
    status.textContent = 'failed: ' + (r.error || 'unknown');
  }
}

document.getElementById('send').onclick = send;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape') prime.hudHide();
});
prime.onHudOpened(() => { status.textContent = ''; input.focus(); });
