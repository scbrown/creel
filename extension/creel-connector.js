/* creel bridge — connector content script, injected ONLY into creel origins.
 *
 * It is the trust boundary between the creel page (window.postMessage) and the
 * extension's privileged background worker (chrome.runtime). The page cannot
 * talk to the extension directly; it must go through here, and here we accept
 * only our own message shape and only from this window. The background worker
 * is what actually reaches cross-origin tabs.
 */
(function () {
  'use strict';
  const REQ = 'creel-bridge:req';
  const RES = 'creel-bridge:res';
  const HELLO = 'creel-bridge:hello';

  // Announce the bridge so creel's in-page 'browser' server knows it exists.
  window.postMessage({ __creel: HELLO, version: '0.1.0' }, window.location.origin);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__creel !== REQ || typeof msg.reqId !== 'string') return;

    chrome.runtime.sendMessage({ op: msg.op, args: msg.args || {} }, (reply) => {
      const err = chrome.runtime.lastError;
      window.postMessage({
        __creel: RES,
        reqId: msg.reqId,
        ok: !err && reply && reply.ok !== false,
        result: err ? undefined : (reply && reply.result),
        error: err ? err.message : (reply && reply.error),
      }, window.location.origin);
    });
  });
})();
