/* creel — the 'browser' in-page MCP server: drive cross-origin web pages.
 *
 * The static creel page is CORS-bound and can't touch other sites' DOM. The
 * companion "creel bridge" Chrome extension (extension/, MV3) can: its content
 * script announces itself here (postMessage 'hello'), and this server relays
 * tool calls to the extension's privileged background worker, which acts on
 * real tabs via chrome.scripting.
 *
 * If the extension isn't installed, the server stays present with one tool,
 * browser_status, reporting so — same graceful-degradation shape as
 * quipu-wasm. Nothing here can reach a page without the extension; the
 * extension is the capability, opt-in by installing it.
 */
(function () {
  'use strict';

  const REQ = 'creel-bridge:req';
  const RES = 'creel-bridge:res';
  const HELLO = 'creel-bridge:hello';

  let bridge = { present: false, version: null };
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.__creel === HELLO) { bridge = { present: true, version: m.version }; return; }
    if (m.__creel === RES && pending.has(m.reqId)) {
      const p = pending.get(m.reqId);
      pending.delete(m.reqId);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'bridge error'));
    }
  });

  function bridgeCall(op, args) {
    if (!bridge.present) {
      return Promise.reject(new Error('the creel bridge extension is not installed — see extension/ in the creel repo; load it unpacked in chrome://extensions'));
    }
    return new Promise((resolve, reject) => {
      const reqId = `b${seq++}`;
      pending.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('bridge call timed out (15s)')); }
      }, 15000);
      window.postMessage({ __creel: REQ, reqId, op, args }, window.location.origin);
    });
  }

  const STATUS_TOOL = {
    name: 'browser_status',
    description: 'Report whether the creel bridge extension is installed (which is what enables driving cross-origin web pages).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  };

  const BRIDGE_TOOLS = [
    { name: 'browser_list_tabs', description: 'List the user\'s open browser tabs (excluding creel\'s own tabs). Returns {id, title, url, active}.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'browser_open_tab', description: 'Open a new browser tab at any website (bare hosts get https://) and return {tabId, url, title} once loaded. Then use browser_read/query/click/fill with that tabId.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'website URL or bare host' }, focus: { type: 'boolean', description: 'foreground the tab (default true)' }, wait: { type: 'boolean', description: 'wait for load before returning (default true)' } }, required: ['url'] } },
    { name: 'browser_navigate', description: 'Navigate a tab (default: the active tab) to any website; returns {tabId, url, title} once loaded.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'integer' }, wait: { type: 'boolean' } }, required: ['url'] } },
    { name: 'browser_read', description: 'Read the visible text of a tab (or a CSS-selected region). Returns {url, title, text}.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'integer' } }, required: [] } },
    { name: 'browser_query', description: 'List elements matching a CSS selector on a tab: {tag, text, href, id, name}. Use to find things to click/fill.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'integer' }, tabId: { type: 'integer' } }, required: ['selector'] } },
    { name: 'browser_click', description: 'Click an element (CSS selector) on a tab.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'integer' } }, required: ['selector'] } },
    { name: 'browser_fill', description: 'Fill an input/textarea (CSS selector) on a tab and fire input/change events.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'integer' } }, required: ['selector', 'value'] } },
  ];
  const OP = {
    browser_list_tabs: 'list_tabs', browser_open_tab: 'open_tab', browser_navigate: 'navigate',
    browser_read: 'read', browser_query: 'query', browser_click: 'click', browser_fill: 'fill',
  };

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
            return reply({ tools: bridge.present ? [STATUS_TOOL, ...BRIDGE_TOOLS] : [STATUS_TOOL] });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (name === 'browser_status') {
              return reply({ content: [{ type: 'text', text: JSON.stringify({ bridge_installed: bridge.present, version: bridge.version, hint: bridge.present ? 'cross-origin browser control is available' : 'install the creel bridge extension (extension/ in the repo) to enable web control' }) }] });
            }
            if (!OP[name]) return fail(`unknown tool: ${name}`);
            const result = await bridgeCall(OP[name], args || {});
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
      if (server && typeof mcpConnectServer === 'function') {
        // Re-list shortly after the bridge hello may arrive, so the full
        // toolset appears once the extension announces itself.
        mcpConnectServer(server).catch(() => {});
        setTimeout(() => { if (bridge.present && typeof mcpReconnectServer === 'function') mcpReconnectServer(server.id).catch(() => {}); }, 800);
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };
  window.CreelBrowser = CreelBrowser;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelBrowser.registerDefaults());
  } else {
    CreelBrowser.registerDefaults();
  }
})();
