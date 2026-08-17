/* Fixture behaviour. In a separate file because the fixture's CSP is
 * `script-src 'self'` — an inline <script> would be blocked, which is the
 * point: this page behaves like a real site that forbids eval. */
'use strict';

document.getElementById('submit').addEventListener('click', () => {
  const item = document.getElementById('item').value;
  const qty = document.getElementById('qty').value;
  const gift = document.getElementById('gift').checked;
  const card = document.getElementById('secret').value;
  document.getElementById('banner').textContent =
    `Ordered ${qty} x ${item}${gift ? ' (gift wrapped)' : ''}; card ends ${card.slice(-4) || 'none'}`;
});

// Appears only after a delay, so auto-waiting has something real to wait for.
document.getElementById('reveal').addEventListener('click', () => {
  setTimeout(() => document.getElementById('delayed').classList.remove('hidden'), 700);
});

// The file input echoes what it really received. If the bridge's attach_file
// produced genuine File objects (DataTransfer → FileList), the page sees
// names, sizes and types — exactly like a user's picker. If an agent faked
// it (e.g. by setting .value, which is impossible, or by dispatching a
// synthetic event with no files), the handler below would have nothing to
// read and this whole check would fail.
document.getElementById('receipt').addEventListener('change', (e) => {
  const names = [...e.target.files].map((f) => `${f.name}:${f.size}:${f.type}`).join(', ');
  document.getElementById('uploaded').textContent = `Attached ${names || '(no files)'}`;
});

// An open shadow root with a button — the locator engine must pierce it.
const host = document.getElementById('widget');
const shadow = host.attachShadow({ mode: 'open' });
const btn = document.createElement('button');
btn.type = 'button';
btn.setAttribute('aria-label', 'Turbo widget');
btn.textContent = 'Turbo';
btn.addEventListener('click', () => {
  document.getElementById('banner').textContent = 'Turbo widget engaged';
});
shadow.appendChild(btn);
