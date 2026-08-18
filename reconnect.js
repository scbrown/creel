/* reconnect.js — Android / mobile tab-switch resilience
 *
 * Problem: Android Chrome aggressively freezes background tabs, killing active
 * fetch streams and SSE connections. When the user returns, the app is in a
 * broken state with no feedback.
 *
 * This module:
 *  1. Tracks page visibility (Page Visibility API)
 *  2. Monitors online/offline network events
 *  3. Auto-reconnects MCP SSE servers when the page comes back to foreground
 *  4. Acquires a Web Lock during active streams to discourage tab freezing
 *  5. Shows a toast banner so the user knows what happened
 */
(function () {
  'use strict';

  // ── state ────────────────────────────────────────────────────────
  let hiddenSince = 0;            // timestamp when page went hidden (0 = visible)
  let wasStreamingWhenHidden = false;
  let networkWentOffline = false;
  let reconnectInFlight = false;
  let keepAliveLock = null;       // Web Lock release function

  const FREEZE_THRESHOLD_MS = 2000;

  // ── toast banner ─────────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = null;

  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = document.createElement('div');
    toastEl.id = 'creelReconnectToast';
    toastEl.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:10000;padding:8px 16px;'
      + 'font:13px/1.4 system-ui,sans-serif;text-align:center;'
      + 'transition:transform .3s ease,opacity .3s ease;'
      + 'transform:translateY(-100%);opacity:0;pointer-events:none;';
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function showToast(msg, type) {
    const el = ensureToast();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    const colors = {
      warn:  'background:#3a2e12;color:#e0af68;border-bottom:1px solid #5a4a22;',
      ok:    'background:#1a2e1a;color:#68e0a0;border-bottom:1px solid #2a5a2a;',
      error: 'background:#2e1a1a;color:#e06868;border-bottom:1px solid #5a2a2a;',
    };
    el.style.cssText = el.style.cssText.replace(/background:[^;]+;color:[^;]+;border-bottom:[^;]+;/g, '');
    el.style.cssText += colors[type] || colors.warn;
    el.textContent = msg;
    el.style.transform = 'translateY(0)';
    el.style.opacity = '1';
    const duration = type === 'ok' ? 3000 : 6000;
    toastTimer = setTimeout(hideToast, duration);
  }

  function hideToast() {
    if (!toastEl) return;
    toastEl.style.transform = 'translateY(-100%)';
    toastEl.style.opacity = '0';
    toastTimer = null;
  }

  // ── Web Lock keep-alive ──────────────────────────────────────────
  // Acquiring a Web Lock during active LLM streaming tells the browser
  // that important work is happening, which can delay tab freezing.
  function acquireKeepAlive() {
    if (keepAliveLock || !navigator.locks) return;
    navigator.locks.request('creel-stream-keepalive', { ifAvailable: true }, (lock) => {
      if (!lock) return;
      return new Promise((resolve) => { keepAliveLock = resolve; });
    }).catch(() => {});
  }

  function releaseKeepAlive() {
    if (keepAliveLock) { keepAliveLock(); keepAliveLock = null; }
  }

  // ── MCP reconnection ────────────────────────────────────────────
  async function reconnectDeadMcpServers() {
    if (typeof mcpServers === 'undefined' || !mcpServers.length) return 0;
    let reconnected = 0;
    const staleServers = mcpServers.filter(function (s) {
      if (s.enabled === false) return false;
      if (s.type === 'inpage') return false;
      if (typeof _mcpRt !== 'function') return false;
      var rt = _mcpRt(s.id);
      if (s.type === 'sse' && (!rt.es || rt.es.readyState === EventSource.CLOSED)) return true;
      if (!rt.connected) return true;
      return false;
    });
    for (var i = 0; i < staleServers.length; i++) {
      try {
        await mcpReconnectServer(staleServers[i].id);
        reconnected++;
      } catch (e) {
        console.warn('reconnect: failed to reconnect MCP server', staleServers[i].name, e);
      }
    }
    return reconnected;
  }

  // ── visibility change handler ────────────────────────────────────
  function onVisibilityChange() {
    if (document.hidden) {
      hiddenSince = Date.now();
      wasStreamingWhenHidden = typeof isGenerating !== 'undefined' && isGenerating;
    } else {
      var elapsed = hiddenSince ? Date.now() - hiddenSince : 0;
      hiddenSince = 0;

      if (elapsed < FREEZE_THRESHOLD_MS) return;

      if (networkWentOffline && navigator.onLine) {
        networkWentOffline = false;
      }

      if (!navigator.onLine) {
        showToast('Network offline — waiting for connection…', 'warn');
        return;
      }

      handleReconnect(elapsed);
    }
  }

  async function handleReconnect(elapsed) {
    if (reconnectInFlight) return;
    reconnectInFlight = true;

    try {
      showToast('Reconnecting…', 'warn');

      var reconnected = await reconnectDeadMcpServers();

      if (wasStreamingWhenHidden) {
        var stillStreaming = typeof isGenerating !== 'undefined' && isGenerating;
        if (!stillStreaming) {
          showToast('Connection lost while generating — please resend your last message.', 'error');
          wasStreamingWhenHidden = false;
          reconnectInFlight = false;
          return;
        }
      }

      if (reconnected > 0) {
        showToast('Reconnected ' + reconnected + ' server' + (reconnected > 1 ? 's' : '') + '.', 'ok');
      } else {
        hideToast();
      }
    } catch (e) {
      console.warn('reconnect: handleReconnect error', e);
      showToast('Reconnection failed — check your connection.', 'error');
    } finally {
      reconnectInFlight = false;
    }
  }

  // ── online / offline handlers ────────────────────────────────────
  function onOffline() {
    networkWentOffline = true;
    showToast('Network offline', 'warn');
  }

  function onOnline() {
    networkWentOffline = false;
    if (document.hidden) return;
    handleReconnect(0);
  }

  // ── keep-alive integration with streaming ────────────────────────
  // Patch into the global isGenerating flag changes by polling. This avoids
  // modifying the monolithic thread.html. A MutationObserver on the status
  // bar would also work but polling is simpler and cheaper here.
  var lastGeneratingState = false;
  function pollStreamingState() {
    var now = typeof isGenerating !== 'undefined' && isGenerating;
    if (now && !lastGeneratingState) acquireKeepAlive();
    if (!now && lastGeneratingState) releaseKeepAlive();
    lastGeneratingState = now;
  }

  // ── public API ────────────────────────────────────────────────────
  window.CreelReconnect = {
    wasRecentlyHidden: function () { return hiddenSince > 0 || (wasStreamingWhenHidden && !reconnectInFlight); },
    isOffline: function () { return networkWentOffline || !navigator.onLine; },
  };

  // ── init ─────────────────────────────────────────────────────────
  function start() {
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    setInterval(pollStreamingState, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
