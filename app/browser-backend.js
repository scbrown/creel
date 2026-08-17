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

  // The same locator vocabulary creel's own ui_ tools use — deliberately
  // identical, so an agent has one mental model for "drive a page" whether
  // the page is creel's or a stranger's. The bridge injects the very same
  // engine (creel-locator.js) into the target tab.
  const LOC = {
    ref: { type: 'string', description: 'a [ref] handle from the last browser_snapshot of this tab' },
    role: { type: 'string', description: 'ARIA role: button, link, textbox, checkbox, combobox, heading…' },
    name: { type: 'string', description: 'accessible name, case-insensitive substring (pair with role)' },
    text: { type: 'string', description: 'visible text of the element that most directly contains it' },
    label: { type: 'string', description: 'the label of a form field' },
    placeholder: { type: 'string', description: 'a field\'s placeholder text' },
    testId: { type: 'string', description: 'data-testid value' },
    selector: { type: 'string', description: 'CSS escape hatch' },
    exact: { type: 'boolean' },
    nth: { type: 'integer', description: '0-based index when the locator matches several' },
  };
  // Locator fields travel nested under `locator` on the wire, but an agent
  // should be able to write them flat; the call path lifts them.
  const withLoc = (extra) => ({ ...LOC, ...extra, tabId: TAB, timeout: { type: 'integer', description: 'ms to auto-wait, default 5000' } });

  const BRIDGE_TOOLS = [
    { op: 'list_tabs', name: 'browser_list_tabs', description: 'List the user\'s open browser tabs (excluding creel\'s own tabs). Returns {id, title, url, active}.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { op: 'open_tab', name: 'browser_open_tab', description: 'Open a new browser tab at any website (bare hosts get https://) and return {tabId, url, title} once loaded. Subsequent browser_* calls default to this tab.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'website URL or bare host' }, focus: { type: 'boolean', description: 'foreground the tab (default true)' }, wait: { type: 'boolean', description: 'wait for load before returning (default true)' } }, required: ['url'] } },
    { op: 'navigate', name: 'browser_navigate', description: 'Navigate a tab to any website; returns {tabId, url, title} once loaded.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: TAB, wait: { type: 'boolean' } }, required: ['url'] } },
    { op: 'close_tab', name: 'browser_close_tab', description: 'Close a tab the bridge opened. Clean up when done with a site.', inputSchema: { type: 'object', properties: { tabId: TAB }, required: [] } },
    { op: 'history', name: 'browser_history', description: 'Go back, go forward, or reload a tab.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] }, tabId: TAB, wait: { type: 'boolean' } }, required: ['action'] } },
    { op: 'snapshot', name: 'browser_snapshot', description: 'The accessibility tree of a web page: every visible control as role + accessible name + a [ref] handle. Take a snapshot after every navigation, then act by {ref} or {role, name} — never by guessing at CSS.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'default 200' }, all: { type: 'boolean', description: 'include landmarks and headings too' }, filter: { type: 'string' }, format: { type: 'string', enum: ['text', 'json'] }, tabId: TAB }, required: [] } },
    { op: 'click', name: 'browser_click', description: 'Click a control. Auto-waits for it to be visible and enabled, so no sleep is ever needed first.', inputSchema: { type: 'object', properties: withLoc({}), required: [] } },
    { op: 'fill', name: 'browser_fill', description: 'Set the value of a field (clears then writes, firing input+change so frameworks observe it). Auto-waits. Password fields are written but never echoed back.', inputSchema: { type: 'object', properties: withLoc({ value: { type: 'string' } }), required: ['value'] } },
    { op: 'type', name: 'browser_type', description: 'Type key by key, appending — for inputs that react to each keystroke, like autocompletes.', inputSchema: { type: 'object', properties: withLoc({ text: { type: 'string' } }), required: ['text'] } },
    { op: 'press', name: 'browser_press', description: 'Press a key on a control, or on whatever is focused. Enter submits the owning form when the page does not handle it.', inputSchema: { type: 'object', properties: withLoc({ key: { type: 'string', description: 'e.g. Enter, Escape, ArrowDown' } }), required: [] } },
    { op: 'hover', name: 'browser_hover', description: 'Hover a control — reveals menus and tooltips that only appear on pointer-over.', inputSchema: { type: 'object', properties: withLoc({}), required: [] } },
    { op: 'check', name: 'browser_check', description: 'Check or uncheck a checkbox, idempotently — it verifies the resulting state rather than blindly toggling.', inputSchema: { type: 'object', properties: withLoc({ checked: { type: 'boolean', description: 'default true' } }), required: [] } },
    { op: 'select_option', name: 'browser_select_option', description: 'Choose an option in a <select>, by value or by visible label.', inputSchema: { type: 'object', properties: withLoc({ value: { type: 'string' }, label: { type: 'string' } }), required: [] } },
    { op: 'wait_for', name: 'browser_wait_for', description: 'Wait until a control is visible / hidden / attached / detached / enabled. Use after a click that triggers navigation or async loading instead of guessing at a delay.', inputSchema: { type: 'object', properties: withLoc({ state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached', 'enabled'] } }), required: [] } },
    { op: 'text', name: 'browser_text', description: 'Read the text of one region of a page, located the same way as any action.', inputSchema: { type: 'object', properties: withLoc({}), required: [] } },
    { op: 'read', name: 'browser_read', description: 'Read the visible text of a whole tab (or a CSS-selected region) — the bulk-reading counterpart to browser_text.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'integer', description: 'max characters (default 20000)' }, tabId: TAB }, required: [] } },
    { op: 'query', name: 'browser_query', description: 'List elements matching a CSS selector, each with its own selector. The escape hatch for pages the accessibility tree describes poorly.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'integer' }, tabId: TAB }, required: ['selector'] } },
    { op: 'scroll', name: 'browser_scroll', description: 'Scroll a tab to top/bottom, by a pixel delta, or bring a CSS selector into view (lazy-loaded content).', inputSchema: { type: 'object', properties: { to: { type: 'string', description: '"top", "bottom", or a pixel delta' }, selector: { type: 'string' }, tabId: TAB }, required: [] } },
  ];

  // Which tools speak the locator vocabulary — their flat locator fields are
  // lifted into `locator` before crossing to the extension.
  const LOCATOR_TOOLS = new Set(['browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_hover', 'browser_check', 'browser_select_option', 'browser_wait_for', 'browser_text']);
  const LOC_KEYS = Object.keys(LOC);

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
            let payload = args || {};
            if (LOCATOR_TOOLS.has(name)) {
              // Agents write locator fields flat; the engine wants them
              // grouped. Lift them here so both shapes work.
              const locator = {};
              const rest = {};
              for (const [k, v] of Object.entries(payload)) {
                if (LOC_KEYS.includes(k)) locator[k] = v; else rest[k] = v;
              }
              payload = { ...rest, locator };
            }
            const result = await bridgeCall(OP[name], payload);
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
