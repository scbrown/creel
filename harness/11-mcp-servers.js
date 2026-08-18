/* creel harness — part 11 of 26: mcp-servers
 *
 * Extracted verbatim from app/thread.html (creel-yny). These are CLASSIC
 * scripts, deliberately not modules: classic scripts share one global lexical
 * environment, so top-level const/let and function declarations stay visible
 * across every part and to the inline onclick= handlers in the markup. That
 * shared scope is what let the split be mechanical rather than a rewrite.
 *
 * THE LOAD ORDER IN thread.html IS PART OF THE SEMANTICS. Do not reorder
 * the tags, do not add defer or async, and do not move a declaration across a
 * file boundary without checking what reads it while the page is loading.
 *
 * Sections here:
 *   - CUSTOM MCP TOOLS
 */
// ═══════════════════════════════════════════════════════════════════
// CUSTOM MCP TOOLS
// ═══════════════════════════════════════════════════════════════════
let mcpTools = [];
try { const s = localStorage.getItem('ba_mcp_tools'); if (s) mcpTools = JSON.parse(s); } catch {}
// MCP Servers (JSON-RPC over streamable_http or SSE). Server-sourced tools are
// registered into mcpTools with a `serverId` back-reference so executeMcpTool
// can route calls to the correct transport.
let mcpServers = [];
try { const s = localStorage.getItem('ba_mcp_servers'); if (s) mcpServers = JSON.parse(s); } catch {}
// Transient per-server runtime state (not persisted): EventSource, pending RPC
// map, session id, sse endpoint.
const _mcpRuntime = new Map(); // serverId -> { es, pending: Map, endpoint, sessionId, protocolVersion, connected, lastError, tools }
function _mcpRt(id) { let r = _mcpRuntime.get(id); if (!r) { r = { es: null, pending: new Map(), endpoint: null, sessionId: null, protocolVersion: null, connected: false, lastError: null, tools: [] }; _mcpRuntime.set(id, r); } return r; }

// Optional CORS proxy prefix. Browsers can't fetch cross-origin MCP endpoints
// that don't return proper CORS headers (ModelScope, most public MCP servers).
// The proxy URL is prepended to the target URL, or substituted at `{url}` when
// present. Common forms:
//   https://cors.example.workers.dev/          → proxy/<full-target-url>
//   https://cors.example.com/?url={url}        → proxy?url=<encoded-target-url>
// A per-server `corsProxy` overrides this global default.
let mcpCorsProxy = '';
try { mcpCorsProxy = localStorage.getItem('ba_mcp_cors_proxy') || ''; } catch {}
function saveMcpCorsProxy() { try { localStorage.setItem('ba_mcp_cors_proxy', mcpCorsProxy); } catch {} }

function _mcpProxyWrap(server, url) {
  const proxy = (server.corsProxy || mcpCorsProxy || '').trim();
  if (!proxy) return url;
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url));
  return proxy.replace(/\/+$/, '') + '/' + url;
}

function _mcpIsCorsError(e) {
  const msg = String(e?.message || e || '');
  return /Failed to fetch|NetworkError|CORS|preflight|cross-origin|ERR_FAILED/i.test(msg);
}

function _mcpWrapError(server, e) {
  if (_mcpIsCorsError(e)) {
    const hint = server.corsProxy || mcpCorsProxy
      ? 'Request failed through the CORS proxy. Verify the proxy URL is reachable and forwards Authorization/MCP-Protocol-Version/Mcp-Session-Id headers.'
      : 'Blocked by browser CORS policy. The MCP server did not include your origin in Access-Control-Allow-Origin. Set a CORS proxy in the MCP modal (Import tab) and retry — e.g. a Cloudflare Worker that forwards requests.';
    return new Error(hint + ' (' + (e.message || e) + ')');
  }
  return e;
}

function saveMcpTools() {
  try {
    // Only persist user-defined tools. Server-sourced tools (with `serverId`)
    // are re-registered when mcpConnectServer() runs on startup.
    const customOnly = mcpTools.filter(t => !t.serverId);
    localStorage.setItem('ba_mcp_tools', JSON.stringify(customOnly));
  } catch {}
}
function saveMcpServers() {
  try {
    // Only persist stable configuration; runtime state lives in _mcpRuntime.
    const persist = mcpServers.map(s => ({ id: s.id, name: s.name, type: s.type, url: s.url, token: s.token, corsProxy: s.corsProxy || '', enabled: s.enabled !== false }));
    localStorage.setItem('ba_mcp_servers', JSON.stringify(persist));
  } catch {}
}

function openMcpToolModal() {
  document.getElementById('mcpToolModal').classList.add('show');
  const proxyInput = document.getElementById('mcpCorsProxy');
  if (proxyInput) proxyInput.value = mcpCorsProxy || '';
  renderMcpToolList();
  renderMcpServerList();
}
function closeMcpToolModal() { document.getElementById('mcpToolModal').classList.remove('show'); }

function onMcpCorsProxyChange(v) {
  mcpCorsProxy = (v || '').trim();
  saveMcpCorsProxy();
}

function switchMcpTab(which) {
  document.querySelectorAll('.mcp-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.mcpTab === which));
  document.querySelectorAll('.mcp-tab-pane').forEach(p => p.style.display = p.dataset.mcpPane === which ? '' : 'none');
}

// ── JSON-RPC framing ──────────────────────────────────────────────
let _mcpNextRpcId = 1;
function _mcpGenRpcId() { return _mcpNextRpcId++; }
const MCP_PROTOCOL_VERSION = '2025-06-18';

function _mcpAuthHeaders(server) {
  const h = {};
  if (server.token) h['Authorization'] = 'Bearer ' + server.token;
  return h;
}

// ── Streamable HTTP transport ─────────────────────────────────────
// Single endpoint, POST JSON-RPC. Response is either application/json or
// text/event-stream. On `initialize` the server returns an Mcp-Session-Id
// header that must be echoed on subsequent requests.
async function _mcpStreamableRequest(server, body) {
  const rt = _mcpRt(server.id);
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': rt.protocolVersion || MCP_PROTOCOL_VERSION,
    ..._mcpAuthHeaders(server)
  };
  if (rt.sessionId) headers['Mcp-Session-Id'] = rt.sessionId;
  const endpoint = _mcpProxyWrap(server, server.url);
  let resp;
  try {
    resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), mode: 'cors' });
  } catch (e) {
    throw _mcpWrapError(server, e);
  }
  const newSession = resp.headers.get('mcp-session-id') || resp.headers.get('Mcp-Session-Id');
  if (newSession) rt.sessionId = newSession;
  if (resp.status === 202) return null; // accepted (notification)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) return await _mcpParseSseStreamForId(resp.body, body.id);
  if (ct.includes('application/json')) return await resp.json();
  const text = await resp.text();
  try { return JSON.parse(text); } catch { throw new Error('Unexpected response: ' + text.slice(0, 200)); }
}

async function _mcpParseSseStreamForId(stream, targetId) {
  if (!stream) throw new Error('No response stream');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let data = '';
        for (const line of block.split('\n')) { if (line.startsWith('data:')) data += line.slice(5).replace(/^\s/, ''); }
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id === targetId) { try { reader.cancel(); } catch {} return msg; }
        } catch {}
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  throw new Error('SSE stream ended without matching response');
}

// ── SSE transport (legacy HTTP+SSE) ───────────────────────────────
// GET the URL via EventSource, await `endpoint` event for POST URL, then POST
// each JSON-RPC request there. Responses are delivered back on the SSE stream
// correlated by JSON-RPC id. EventSource can't set headers, so Bearer tokens
// must be passed via query string (`access_token`) for SSE servers.
async function _mcpSseInit(server) {
  const rt = _mcpRt(server.id);
  if (rt.es && rt.endpoint) return;
  if (rt.es) { try { rt.es.close(); } catch {} rt.es = null; }
  let url = _mcpProxyWrap(server, server.url);
  if (server.token) { const sep = url.includes('?') ? '&' : '?'; url += sep + 'access_token=' + encodeURIComponent(server.token); }
  return new Promise((resolve, reject) => {
    const es = new EventSource(url);
    rt.es = es;
    let settled = false;
    const timeout = setTimeout(() => { if (!settled) { settled = true; try { es.close(); } catch {} rt.es = null; reject(_mcpWrapError(server, new Error('SSE connect timeout'))); } }, 15000);
    const onEndpoint = (e) => {
      if (settled) return;
      clearTimeout(timeout); settled = true;
      try { rt.endpoint = new URL(e.data, server.url).toString(); } catch { rt.endpoint = e.data; }
      resolve();
    };
    const onMessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg && msg.id != null && rt.pending.has(msg.id)) {
          const { resolve: r, reject: j } = rt.pending.get(msg.id);
          rt.pending.delete(msg.id);
          if (msg.error) j(new Error(msg.error.message || 'RPC error')); else r(msg);
        }
      } catch {}
    };
    es.addEventListener('endpoint', onEndpoint);
    es.addEventListener('message', onMessage);
    es.addEventListener('error', () => {
      if (!settled) { clearTimeout(timeout); settled = true; try { es.close(); } catch {} rt.es = null; reject(_mcpWrapError(server, new Error('SSE connection error'))); }
    });
  });
}

async function _mcpSsePost(server, body) {
  const rt = _mcpRt(server.id);
  if (!rt.endpoint) throw new Error('SSE endpoint not established');
  const headers = { 'Content-Type': 'application/json', ..._mcpAuthHeaders(server) };
  const isNotification = body.id == null;
  let pending = null;
  if (!isNotification) {
    pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rt.pending.delete(body.id); reject(new Error('SSE RPC timeout')); }, 45000);
      rt.pending.set(body.id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    });
  }
  const postTarget = _mcpProxyWrap(server, rt.endpoint);
  let resp;
  try {
    resp = await fetch(postTarget, { method: 'POST', headers, body: JSON.stringify(body), mode: 'cors' });
  } catch (e) {
    if (pending && rt.pending.has(body.id)) rt.pending.delete(body.id);
    throw _mcpWrapError(server, e);
  }
  if (!resp.ok) {
    if (pending && rt.pending.has(body.id)) rt.pending.delete(body.id);
    throw new Error(`HTTP ${resp.status} posting to SSE endpoint`);
  }
  return isNotification ? null : pending;
}

// ── Unified RPC entry points ──────────────────────────────────────
async function _mcpCall(server, method, params) {
  const body = { jsonrpc: '2.0', id: _mcpGenRpcId(), method, params: params || {} };
  // creel: 'inpage' servers dispatch to in-page providers (quipu-backend.js registry).
  const msg = server.type === 'inpage' ? await window.CreelInpage.dispatch(server, body)
    : server.type === 'sse' ? await _mcpSsePost(server, body) : await _mcpStreamableRequest(server, body);
  if (!msg) return null;
  if (msg.error) throw new Error(msg.error.message || 'RPC error');
  return msg.result;
}

async function _mcpNotify(server, method, params) {
  const body = { jsonrpc: '2.0', method, params: params || {} };
  if (server.type === 'inpage') await window.CreelInpage.dispatch(server, body);
  else if (server.type === 'sse') await _mcpSsePost(server, body);
  else await _mcpStreamableRequest(server, body);
}

async function mcpConnectServer(server) {
  const rt = _mcpRt(server.id);
  rt.lastError = null;
  if (server.type === 'sse') await _mcpSseInit(server);
  const init = await _mcpCall(server, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    clientInfo: { name: 'OnePagent', version: '1.0' }
  });
  rt.protocolVersion = init?.protocolVersion || MCP_PROTOCOL_VERSION;
  rt.serverInfo = init?.serverInfo || null;
  try { await _mcpNotify(server, 'notifications/initialized', {}); } catch (e) { console.warn('initialized notify failed', e); }
  const listed = await _mcpCall(server, 'tools/list', {});
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  rt.tools = tools.map(t => t.name);
  // Refresh mcpTools: drop any prior tools from this server, then add the new ones.
  mcpTools = mcpTools.filter(t => t.serverId !== server.id);
  for (const t of tools) {
    mcpTools.push({
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {}, required: [] },
      serverId: server.id
    });
  }
  rt.connected = true;
  saveMcpTools();
  rebuildToolDefs();
  renderMcpServerList();
}

async function mcpDisconnectServer(server) {
  const rt = _mcpRt(server.id);
  if (rt.es) { try { rt.es.close(); } catch {} }
  rt.es = null;
  rt.endpoint = null;
  rt.sessionId = null;
  rt.pending = new Map();
  rt.connected = false;
  mcpTools = mcpTools.filter(t => t.serverId !== server.id);
  saveMcpTools();
  rebuildToolDefs();
}

async function mcpRemoveServer(id) {
  const server = mcpServers.find(s => s.id === id);
  if (!server) return;
  await mcpDisconnectServer(server);
  mcpServers = mcpServers.filter(s => s.id !== id);
  _mcpRuntime.delete(id);
  saveMcpServers();
  renderMcpServerList();
}

async function mcpReconnectServer(id) {
  const server = mcpServers.find(s => s.id === id);
  if (!server) return;
  await mcpDisconnectServer(server);
  try { await mcpConnectServer(server); }
  catch (e) { _mcpRt(id).lastError = e.message; renderMcpServerList(); }
}

function _mcpGenServerId() { return 'mcp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function _mcpNormalizeType(t) {
  const v = String(t || '').toLowerCase();
  if (v === 'inpage') return 'inpage';
  if (v === 'sse') return 'sse';
  if (v === 'streamable_http' || v === 'streamable-http' || v === 'http' || v === 'streamableHttp'.toLowerCase() || v === '') return 'streamable_http';
  return null;
}

function _mcpExtractToken(cfg) {
  if (cfg.token) return String(cfg.token);
  if (cfg.bearer_token) return String(cfg.bearer_token);
  if (cfg.bearerToken) return String(cfg.bearerToken);
  if (cfg.authorization) return String(cfg.authorization).replace(/^Bearer\s+/i, '');
  if (cfg.headers) {
    const hdrs = cfg.headers;
    const auth = hdrs.Authorization || hdrs.authorization;
    if (auth) return String(auth).replace(/^Bearer\s+/i, '');
  }
  return '';
}

async function mcpImportFromJson(jsonStr) {
  let config;
  try { config = JSON.parse(jsonStr); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
  const map = config.mcpServers || config.servers || config;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Expected object with "mcpServers"');
  // Top-level corsProxy applies to all imported servers unless overridden.
  const globalProxy = config.corsProxy || '';
  const added = [];
  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (name === 'corsProxy' || name === 'mcpServers') continue;
    const type = _mcpNormalizeType(cfg.type || cfg.transport);
    if (!type) { console.warn('MCP import: unsupported transport for', name, cfg.type); continue; }
    if (!cfg.url || typeof cfg.url !== 'string') { console.warn('MCP import: missing url for', name); continue; }
    const token = _mcpExtractToken(cfg);
    const corsProxy = cfg.corsProxy || cfg.cors_proxy || globalProxy || '';
    // Replace any existing server with the same name.
    const existing = mcpServers.find(s => s.name === name);
    if (existing) { await mcpDisconnectServer(existing); mcpServers = mcpServers.filter(s => s.id !== existing.id); _mcpRuntime.delete(existing.id); }
    const server = { id: _mcpGenServerId(), name, type, url: cfg.url, token, corsProxy, enabled: true };
    mcpServers.push(server);
    added.push(server);
  }
  saveMcpServers();
  renderMcpServerList();
  await Promise.allSettled(added.map(s => mcpConnectServer(s).catch(e => { _mcpRt(s.id).lastError = e.message; renderMcpServerList(); })));
  return added;
}

function onImportMcpServersClick() {
  const txt = document.getElementById('mcpServerJson').value.trim();
  if (!txt) return;
  mcpImportFromJson(txt)
    .then(added => {
      const msg = t('mcpModal.importOk').replace('{n}', added.length);
      appendSystemMsg('MCP: ' + msg);
      document.getElementById('mcpServerJson').value = '';
    })
    .catch(e => alert(t('mcpModal.importFail') + e.message));
}

function onAddMcpServerManualClick() {
  const name = document.getElementById('mcpSrvName').value.trim();
  const url = document.getElementById('mcpSrvUrl').value.trim();
  const type = document.getElementById('mcpSrvType').value;
  const token = document.getElementById('mcpSrvToken').value.trim();
  if (!name || !url) { alert('Name and URL are required'); return; }
  const cfg = { mcpServers: { [name]: { type, url, token } } };
  mcpImportFromJson(JSON.stringify(cfg))
    .then(added => {
      ['mcpSrvName','mcpSrvUrl','mcpSrvToken'].forEach(id => document.getElementById(id).value = '');
      appendSystemMsg('MCP: added server "' + name + '"');
    })
    .catch(e => alert(t('mcpModal.importFail') + e.message));
}

function renderMcpServerList() {
  const el = document.getElementById('mcpServerList');
  if (!el) return;
  if (!mcpServers.length) { el.textContent = t('mcpModal.noneInstalled'); return; }
  el.innerHTML = mcpServers.map(s => {
    const rt = _mcpRt(s.id);
    const status = rt.connected ? t('mcpModal.connected') : (rt.lastError ? t('mcpModal.disconnected') : t('mcpModal.connecting'));
    const dotCls = rt.connected ? 'connected' : (rt.lastError ? 'error' : '');
    const toolCount = mcpTools.filter(x => x.serverId === s.id).length;
    const meta = rt.lastError
      ? `<div class="mcp-server-meta error" title="${esc(rt.lastError)}">${esc(rt.lastError)}</div>`
      : `<div class="mcp-server-meta">${esc(s.type)} \u00B7 ${toolCount} ${esc(t('mcpModal.toolsCount'))} \u00B7 ${esc(status)}</div>`;
    return `<div class="mcp-server-row">
      <span class="mcp-server-dot ${dotCls}"></span>
      <div class="mcp-server-main">
        <div class="mcp-server-name">${esc(s.name)}</div>
        ${meta}
      </div>
      <button class="mcp-server-btn" onclick="mcpReconnectServer('${esc(s.id)}')">&#x21BB; ${esc(t('mcpModal.reconnect'))}</button>
      <button class="mcp-server-btn danger" onclick="mcpRemoveServer('${esc(s.id)}')">&times; ${esc(t('mcpModal.remove'))}</button>
    </div>`;
  }).join('');
}

async function initAllMcpServers() {
  if (!mcpServers.length) return;
  await Promise.allSettled(mcpServers
    .filter(s => s.enabled !== false)
    .map(s => mcpConnectServer(s).catch(e => {
      _mcpRt(s.id).lastError = e.message;
      console.warn('MCP connect failed for', s.name, '-', e.message);
    })));
  renderMcpServerList();
}



const PROVIDER_DEFAULT_ENDPOINTS = {
  anthropic_compat: 'https://api.anthropic.com',
  openai_compat: 'https://api.openai.com'
};

function onProviderTypeChange() {
  const provider = document.getElementById('setProvider').value;
  const epEl = document.getElementById('setEndpoint');
  const currentEp = epEl.value.trim();
  const defaults = Object.values(PROVIDER_DEFAULT_ENDPOINTS);
  if (!currentEp || defaults.includes(currentEp.replace(/\/+$/, ''))) {
    epEl.value = PROVIDER_DEFAULT_ENDPOINTS[provider] || '';
  }
}



