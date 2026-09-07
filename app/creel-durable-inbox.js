/* Optional host-backed handoffs. Configuration is write-only and tab-local;
 * delivery and acknowledgement are read from the host, never browser storage. */
(function (root) {
  'use strict';
  const Handoff = root.CreelHandoff || (typeof require === 'function' && require('./creel-handoff.js'));
  let config = null;
  function configure(value) {
    if (value === null) { config = null; return { configured: false }; }
    const url = new URL(value.endpoint);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('bridge endpoint must be an origin without credentials or a path');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('bridge requires HTTPS, except on loopback');
    }
    if (typeof value.token !== 'string' || !/^[\x21-\x7e]{32,}$/.test(value.token)) throw new Error('bridge bearer is required');
    config = { endpoint: url.origin, token: value.token };
    return { configured: true };
  }
  async function request(path, body) {
    if (!config) throw new Error('durable inbox is not configured; no handoff was sent');
    const current = config;
    const response = await root.fetch(current.endpoint + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + current.token, 'Content-Type': 'application/json' },
      body, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('durable inbox returned HTTP ' + response.status + '; delivery unproven; retry only the identical envelope');
    const r = await response.json();
    if (r.version !== 'crew-inbox-receipt-v1' || r.delivery !== 'persisted'
        || !/^[0-9a-f]{64}$/.test(r.receipt_id) || !/^[0-9a-f]{64}$/.test(r.envelope_sha256)
        || typeof r.inbox_id !== 'string' || !r.inbox_id || typeof r.acknowledged !== 'boolean'
        || !['br', 'files', 'tracker'].includes(r.backend)
        || typeof r.handoff_id !== 'string' || typeof r.task_id !== 'string') {
      throw new Error('invalid durable receipt; delivery unproven');
    }
    return r;
  }
  async function send(envelope) {
    const body = Handoff.canonical(envelope);
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const receipt = await request('/handoffs', body);
    if (receipt.envelope_sha256 !== hash || receipt.handoff_id !== envelope.id || receipt.task_id !== envelope.task.id) {
      throw new Error('receipt does not bind the submitted envelope; delivery unproven');
    }
    return receipt;
  }
  async function status(receiptId) {
    if (typeof receiptId !== 'string' || !/^[0-9a-f]{64}$/.test(receiptId)) throw new Error('invalid receipt ID');
    const receipt = await request('/handoffs/' + receiptId);
    if (receipt.receipt_id !== receiptId) throw new Error('receipt identity mismatch');
    return receipt;
  }
  const api = Object.freeze({ configure, send, status });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreelDurableInbox = api;
})(globalThis);
