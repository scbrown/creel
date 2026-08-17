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
