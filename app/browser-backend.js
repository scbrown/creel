/* creel — the 'browser' in-page MCP server: drive cross-origin web pages.
 *
 * The static creel page is CORS-bound and can't touch other sites' DOM. The
 * companion "creel bridge" Chrome extension (extension/, MV3) can: its content
 * script relays tool calls to the extension's privileged background worker,
 * which acts on real tabs via chrome.scripting.
 *
 * If the extension isn't installed, the server stays present with one tool,
 * browser_status, reporting so — same graceful-degradation shape as
 * quipu-wasm. Nothing here can reach a page without the extension; the
 * extension is the capability, opt-in by installing it.
 *
 * ── Discovery is a ping, not a wait ──
 * The connector announces itself at document_start, but this file is the last
 * script tag in the document — an announcement alone is a race we lose almost
 * every time. So we PING and let the connector answer; we keep pinging on a
 * short backoff while the page settles (the MV3 service worker may be asleep
 * on the first try) and re-list the toolset the moment a hello lands.
 *
 * ── Capability negotiation ──
 * The hello carries the worker's op list. Tools whose op the installed
 * extension doesn't implement are not offered, so an older extension against
 * a newer creel degrades to a smaller toolset instead of a wall of
 * "unknown op" failures mid-task.
 */
(function () {
  'use strict';

  const REQ = 'creel-bridge:req';
  const RES = 'creel-bridge:res';
  const HELLO = 'creel-bridge:hello';
  const PING = 'creel-bridge:ping';

  let bridge = { present: false, version: null, ops: null };
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.__creel === HELLO) { onHello(m); return; }
    if (m.__creel === RES && pending.has(m.reqId)) {
      const p = pending.get(m.reqId);
      pending.delete(m.reqId);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'bridge error'));
    }
  });

  function onHello(m) {
    const first = !bridge.present;
    bridge = { present: true, version: m.version || null, ops: Array.isArray(m.ops) ? m.ops : null };
    if (first) {
      console.log('creel: bridge extension connected', bridge.version, bridge.ops ? `(${bridge.ops.length} ops)` : '');
      relist();
    }
  }

  /** Ping until the connector answers. Bounded: after ~8s of silence the
   *  extension genuinely isn't there, and browser_status says so. */
  function discover() {
    let delay = 60;
    let elapsed = 0;
    (function attempt() {
      if (bridge.present) return;
      window.postMessage({ __creel: PING }, window.location.origin);
      if (elapsed >= 8000) return;
      elapsed += delay;
      setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 2000);
    })();
  }

  function relist() {
    const server = (typeof mcpServers !== 'undefined') && mcpServers.find((s) => s.id === 'mcp_browser_inpage');
    if (server && typeof mcpReconnectServer === 'function') mcpReconnectServer(server.id).catch(() => {});
    if (typeof renderMcpServerList === 'function') renderMcpServerList();
  }

  function bridgeCall(op, args) {
    if (!bridge.present) {
      return Promise.reject(new Error('the creel bridge extension is not installed — see extension/ in the creel repo; load it unpacked in chrome://extensions'));
    }
    if (bridge.ops && !bridge.ops.includes(op)) {
      return Promise.reject(new Error(`the installed bridge (v${bridge.version}) does not implement '${op}' — update the extension from extension/ in the creel repo`));
    }
    return new Promise((resolve, reject) => {
      const reqId = `b${seq++}`;
      pending.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('bridge call timed out (35s)')); }
      }, 35000);
      window.postMessage({ __creel: REQ, reqId, op, args }, window.location.origin);
    });
  }

  const STATUS_TOOL = {
    name: 'browser_status',
    description: 'Report whether the creel bridge extension is installed (which is what enables driving cross-origin web pages), its version, and the ops it supports.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  };

  const TAB = { type: 'integer', description: 'target tab; omit to reuse the tab this bridge last opened or navigated' };

  const BRIDGE_TOOLS = [
    { op: 'list_tabs', name: 'browser_list_tabs', description: 'List the user\'s open browser tabs (excluding creel\'s own tabs). Returns {id, title, url, active}.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { op: 'open_tab', name: 'browser_open_tab', description: 'Open a new browser tab at any website (bare hosts get https://) and return {tabId, url, title} once loaded. Subsequent browser_* calls default to this tab.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'website URL or bare host' }, focus: { type: 'boolean', description: 'foreground the tab (default true)' }, wait: { type: 'boolean', description: 'wait for load before returning (default true)' } }, required: ['url'] } },
    { op: 'navigate', name: 'browser_navigate', description: 'Navigate a tab to any website; returns {tabId, url, title} once loaded.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: TAB, wait: { type: 'boolean' } }, required: ['url'] } },
    { op: 'close_tab', name: 'browser_close_tab', description: 'Close a tab the bridge opened. Clean up when done with a site.', inputSchema: { type: 'object', properties: { tabId: TAB }, required: [] } },
    { op: 'history', name: 'browser_history', description: 'Go back, go forward, or reload a tab.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] }, tabId: TAB, wait: { type: 'boolean' } }, required: ['action'] } },
    { op: 'snapshot', name: 'browser_snapshot', description: 'The page as a list of things you can DO: every visible link, button, input and select with a label and a verified CSS selector. Call this before click/fill instead of guessing selectors.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'max elements (default 60)' }, tabId: TAB }, required: [] } },
    { op: 'read', name: 'browser_read', description: 'Read the visible text of a tab (or a CSS-selected region). Returns {url, title, text}.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'integer', description: 'max characters (default 20000)' }, tabId: TAB }, required: [] } },
    { op: 'query', name: 'browser_query', description: 'List elements matching a CSS selector: {tag, text, href, id, name, selector}. Narrower than browser_snapshot when you know what you are looking for.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'integer' }, tabId: TAB }, required: ['selector'] } },
    { op: 'click', name: 'browser_click', description: 'Click an element (CSS selector) on a tab.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: TAB }, required: ['selector'] } },
    { op: 'fill', name: 'browser_fill', description: 'Fill an input/textarea/contenteditable (CSS selector) and fire input/change events. Set submit:true to submit the owning form.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, submit: { type: 'boolean' }, tabId: TAB }, required: ['selector', 'value'] } },
    { op: 'select_option', name: 'browser_select_option', description: 'Choose an option in a <select>, by value or by visible label.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, label: { type: 'string' }, tabId: TAB }, required: ['selector'] } },
    { op: 'press', name: 'browser_press', description: 'Press a key (default Enter) on an element or the focused element — submits forms and triggers key handlers a click cannot.', inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'e.g. Enter, Escape, ArrowDown, a' }, selector: { type: 'string' }, tabId: TAB }, required: [] } },
    { op: 'scroll', name: 'browser_scroll', description: 'Scroll a tab to top/bottom, by a pixel delta, or bring a selector into view (lazy-loaded content).', inputSchema: { type: 'object', properties: { to: { type: 'string', description: '"top", "bottom", or a pixel delta' }, selector: { type: 'string' }, tabId: TAB }, required: [] } },
    { op: 'wait_for', name: 'browser_wait_for', description: 'Wait until a selector appears (or vanishes with gone:true), or until text shows up in the page. Use after clicks that trigger navigation or async loads instead of guessing.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, gone: { type: 'boolean' }, timeoutMs: { type: 'integer', description: 'default 10000, max 30000' }, tabId: TAB }, required: [] } },
  ];

  const OP = Object.fromEntries(BRIDGE_TOOLS.map((t) => [t.name, t.op]));

  /** Only offer tools the installed bridge can actually perform. An older
   *  extension advertises fewer ops; an extension too old to advertise at
   *  all (no ops list) gets the benefit of the doubt. */
  function availableTools() {
    if (!bridge.present) return [STATUS_TOOL];
    const usable = BRIDGE_TOOLS
      .filter((t) => !bridge.ops || bridge.ops.includes(t.op))
      .map(({ op, ...tool }) => tool);
    return [STATUS_TOOL, ...usable];
  }

  const CreelBrowser = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({ protocolVersion: body.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'browser', version: '0' } });
          case 'notifications/initialized': return null;
          case 'tools/list':
            return reply({ tools: availableTools() });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (name === 'browser_status') {
              return reply({ content: [{ type: 'text', text: JSON.stringify({
                bridge_installed: bridge.present,
                version: bridge.version,
                ops: bridge.ops || undefined,
                hint: bridge.present
                  ? 'cross-origin browser control is available — start with browser_open_tab, then browser_snapshot to see what you can act on'
                  : 'install the creel bridge extension (extension/ in the repo) to enable web control; creel\'s OWN interface is driven by the ui_* tools instead, which need no extension',
              }) }] });
            }
            if (!OP[name]) return fail(`unknown tool: ${name}`);
            const result = await bridgeCall(OP[name], args || {});
            // In-page ops report soft failures (selector missed, wait timed
            // out) as {error} rather than throwing. Surface those as tool
            // errors so the agent retries instead of reading "ok" — carrying
            // any context the op attached (a select's real option list, the
            // URL it timed out on) into the message rather than dropping it.
            if (result && result.error) {
              const { error, ...context } = result;
              const extra = Object.keys(context).length ? ` — ${JSON.stringify(context)}` : '';
              return fail(`${error}${extra}`);
            }
            return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
          }
          default: return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
    registerDefaults() {
      window.CreelInpage.register('inpage:browser', this);
      if (typeof mcpServers !== 'undefined' && !mcpServers.find((s) => s.id === 'mcp_browser_inpage')) {
        mcpServers.push({ id: 'mcp_browser_inpage', name: 'browser', type: 'inpage', url: 'inpage:browser', token: '', corsProxy: '', enabled: true });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = (typeof mcpServers !== 'undefined') && mcpServers.find((s) => s.id === 'mcp_browser_inpage');
      if (server && typeof mcpConnectServer === 'function') mcpConnectServer(server).catch(() => {});
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
      discover();   // relist() re-lists the toolset when the hello lands
    },
  };
  window.CreelBrowser = CreelBrowser;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelBrowser.registerDefaults());
  } else {
    CreelBrowser.registerDefaults();
  }
})();
