/* creel bridge — connector content script, injected ONLY into creel origins.
 *
 * It is the trust boundary between the creel page (window.postMessage) and the
 * extension's privileged background worker (chrome.runtime). The page cannot
 * talk to the extension directly; it must go through here, and here we accept
 * only our own message shape and only from this window. The background worker
 * is what actually reaches cross-origin tabs.
 *
 * ── Why the handshake is a ping, not just a hello ──
 * This script runs at document_start; the page's browser-backend.js is the
 * LAST script tag in an 18k-line document. A single hello posted here is
 * delivered long before the page has a listener for it — it lands in the
 * void, the page concludes no bridge exists, and the whole toolset stays
 * hidden. So the bridge announces itself at every point the page could have
 * come alive AND answers 'ping' on demand, which is the path the page
 * actually relies on. Announcements are advisory; the ping is the contract.
 */
(function () {
  'use strict';
  const REQ = 'creel-bridge:req';
  const RES = 'creel-bridge:res';
  const HELLO = 'creel-bridge:hello';
  const PING = 'creel-bridge:ping';

  let caps = null;   // {version, ops} from the background worker, cached

  function post(payload) {
    window.postMessage(payload, window.location.origin);
  }

  function announce() {
    if (caps) { post({ __creel: HELLO, version: caps.version, ops: caps.ops }); return; }
    // Ask the worker what it can do, so the page can degrade gracefully when
    // the installed extension is older (or newer) than the creel build.
    chrome.runtime.sendMessage({ op: '__ops' }, (reply) => {
      if (chrome.runtime.lastError) return;             // worker asleep; a later ping retries
      caps = (reply && reply.ok && reply.result) || { version: 'unknown', ops: [] };
      post({ __creel: HELLO, version: caps.version, ops: caps.ops });
    });
  }

  announce();
  document.addEventListener('DOMContentLoaded', announce);
  window.addEventListener('load', announce);

  window.addEventListener('message', (event) => {
    // Only this window, and only its own origin — the connector runs solely on
    // creel origins (manifest matches), so this listens to the creel page and
    // nothing else. An iframe or another origin cannot command the bridge.
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.__creel === PING) { announce(); return; }
    if (msg.__creel !== REQ || typeof msg.reqId !== 'string') return;

    chrome.runtime.sendMessage({ op: msg.op, args: msg.args || {} }, (reply) => {
      const err = chrome.runtime.lastError;
      post({
        __creel: RES,
        reqId: msg.reqId,
        ok: !err && reply && reply.ok !== false,
        result: err ? undefined : (reply && reply.result),
        error: err ? err.message : (reply && reply.error),
      });
    });
  });
})();
