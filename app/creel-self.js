/* creel — self-model: the dispatcher pattern, made legible to the agents.
 *
 * Three things live here, deliberately together, because they are one idea —
 * creel understanding and operating itself:
 *
 * 1. ROOT PANE. There is always exactly one root pane (the dispatcher): a
 *    Web Lock ('creel-root-pane') elects it among non-agent tabs, and if it
 *    closes the next non-agent tab inherits the role. Agent (bobbin) tabs
 *    never take it. A badge shows every tab its role.
 *
 * 2. THE WORLD MODEL LIVES IN QUIPU. The root pane seeds a 'creel-world-model'
 *    episode into the shared store describing the system to its own agents —
 *    roles, servers, tools, panels, conventions. Agents learn their world by
 *    QUERYING THE GRAPH, not by reading docs: this is how creel documents
 *    itself for agents, and the model is versioned so it can evolve.
 *
 * 3. SELF-CONFIGURATION + VISIBLE HANDS. The 'ui' in-page MCP server lets the
 *    agent drive creel's own interface from user demands — switch model,
 *    reconfigure the provider, toggle tool servers, open panels, click and
 *    fill arbitrary controls. Every input — the human's and the agent's —
 *    flashes a highlight ring, so what is being touched is always visible
 *    (agent touches glow orange, human touches cyan).
 */
(function () {
  'use strict';

  const IS_AGENT_TAB = /creel-agent=/.test(location.hash);
  const ROOT_LOCK = 'creel-root-pane';
  const WORLD_VERSION = 'creel-world-model-v1';

  const CreelSelf = { role: IS_AGENT_TAB ? 'bobbin' : 'standby' };
  window.CreelSelf = CreelSelf;

  // ── 1. root-pane election ────────────────────────────────────────
  let badge = null;
  function renderBadge() {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'creelRoleBadge';
      badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;padding:3px 10px;'
        + 'border-radius:10px;font:11px system-ui,sans-serif;pointer-events:none;opacity:.9;';
      document.body.appendChild(badge);
    }
    const styles = {
      root: 'background:#3a2e12;color:#e0af68;border:1px solid #5a4a22;',
      bobbin: 'background:#12303a;color:#8be9fd;border:1px solid #224a5a;',
      standby: 'background:#1d1d2e;color:#8892a4;border:1px solid #2a2a3a;',
    };
    badge.style.cssText += styles[CreelSelf.role] || styles.standby;
    badge.textContent = CreelSelf.role === 'root' ? '⬢ root pane'
      : CreelSelf.role === 'bobbin' ? '🧵 bobbin' : 'standby';
    document.title = document.title.replace(/^⬢ /, '');
    if (CreelSelf.role === 'root') document.title = '⬢ ' + document.title;
  }

  function electRoot() {
    if (IS_AGENT_TAB || !navigator.locks) { renderBadge(); return; }
    navigator.locks.request(ROOT_LOCK, async () => {
      CreelSelf.role = 'root';
      renderBadge();
      seedWorldModel();
      return new Promise(() => {});    // hold while this tab lives
    }).catch(() => {});
    renderBadge();
  }

  // ── 3a. visible hands: highlight every input ─────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes creelFlash { 0% { box-shadow: 0 0 0 3px var(--creel-flash-color); }
      100% { box-shadow: 0 0 0 12px rgba(0,0,0,0); } }
    .creel-flash { --creel-flash-color: rgba(139,233,253,.8); animation: creelFlash .6s ease-out; border-radius: 4px; }
    .creel-flash-agent { --creel-flash-color: rgba(255,107,53,.9); animation: creelFlash .9s ease-out; border-radius: 4px; }
  `;
  document.head.appendChild(style);

  function flash(el, agent = false) {
    if (!(el instanceof Element)) return;
    const cls = agent ? 'creel-flash-agent' : 'creel-flash';
    el.classList.remove('creel-flash', 'creel-flash-agent');
    void el.offsetWidth;   // restart the animation
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1000);
  }

  const INTERACTIVE = 'button, a, input, textarea, select, [onclick], [role="button"]';
  document.addEventListener('click', (e) => {
    const el = e.composedPath().find((n) => n instanceof Element && n.matches?.(INTERACTIVE));
    if (el) flash(el);
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.composedPath()[0];
    if (el instanceof Element) flash(el);
  }, true);

  // ── 3b. the 'ui' server: creel configures creel ──────────────────
  function activeProfile() {
    const store = typeof _loadProviders === 'function' ? _loadProviders() : null;
    const id = (typeof getActiveProviderId === 'function' && getActiveProviderId())
      || localStorage.getItem('ba_active_provider_id') || '';
    const list = store?.providers || store || [];
    const arr = Array.isArray(list) ? list : Object.values(list);
    return { store, profile: arr.find((p) => p && p.id === id) || (typeof ACTIVE_PROVIDER !== 'undefined' ? ACTIVE_PROVIDER : null) };
  }

  const TOOLS = [
    {
      name: 'ui_describe',
      description: 'Describe creel\'s own interface state: role (root pane / bobbin), provider endpoint + model, tool servers and enabled state, open panels, run state. Call before reconfiguring anything.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'ui_set_model',
      description: 'Switch the active LLM model for this tab (e.g. deepseek-chat, deepseek-reasoner).',
      inputSchema: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
    },
    {
      name: 'ui_configure_provider',
      description: 'Update the active provider profile: endpoint base URL and/or default model. (API keys are never set through chat — direct the user to Settings for those.)',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'API base URL, e.g. https://api.deepseek.com' },
          model: { type: 'string', description: 'default model for the profile' },
        },
        required: [],
      },
    },
    {
      name: 'ui_toggle_server',
      description: 'Enable or disable one of the MCP tool servers by name (see ui_describe for the list).',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, enabled: { type: 'boolean' } },
        required: ['name', 'enabled'],
      },
    },
    {
      name: 'ui_open',
      description: 'Open one of creel\'s panels: "graph" (quipu explorer), "fleet" (agent dashboard), or "settings".',
      inputSchema: { type: 'object', properties: { panel: { type: 'string', enum: ['graph', 'fleet', 'settings'] } }, required: ['panel'] },
    },
    {
      name: 'ui_click',
      description: 'Click an element of creel\'s interface by CSS selector, with a visible highlight. Use ui_describe/ui_open first; prefer specific ids.',
      inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    },
    {
      name: 'ui_fill',
      description: 'Fill an input/textarea of creel\'s interface by CSS selector (dispatches input+change events), with a visible highlight. Never fill API-key fields.',
      inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] },
    },
  ];

  const impl = {
    async ui_describe() {
      const { profile } = activeProfile();
      return {
        build: window.CREEL_BUILD,
        role: CreelSelf.role,
        model: typeof API_MODEL !== 'undefined' ? API_MODEL : null,
        provider: profile ? { name: profile.name, type: profile.type, endpoint: profile.endpoint || profile.baseUrl, hasKey: !!(profile.apiKey || profile.api_key) } : null,
        servers: (typeof mcpServers !== 'undefined' ? mcpServers : []).map((s) => ({
          name: s.name, type: s.type, enabled: s.enabled !== false,
          tools: (typeof mcpTools !== 'undefined' ? mcpTools : []).filter((t) => t.serverId === s.id).length,
        })),
        panels: {
          graph: !!document.getElementById('creelQuipuExplorer'),
          fleet: !!document.getElementById('creelFleetList'),
          settings: !!document.querySelector('#settingsModal.show'),
        },
        running: typeof getActiveConversationRun === 'function' ? !!getActiveConversationRun()?.active : null,
        worldModel: 'query the quipu graph for the creel world model (search_nodes "creel world model")',
      };
    },

    async ui_set_model(args) {
      if (typeof API_MODEL === 'undefined') throw new Error('model surface unavailable');
      // Same effect as the top-bar dropdown: set the global + persist.
      window.API_MODEL = args.model;
      API_MODEL = args.model;
      localStorage.setItem('ba_selected_model', args.model);
      const dd = document.querySelector('#modelSelect, [id*="odelSel"], select[title*="model" i]');
      if (dd) { dd.value = args.model; flash(dd, true); }
      return { ok: true, model: args.model, note: 'applies from the next message' };
    },

    async ui_configure_provider(args) {
      const { store, profile } = activeProfile();
      if (!profile) throw new Error('no active provider profile — open Settings first');
      if (args.endpoint) { profile.endpoint = args.endpoint; profile.baseUrl = args.endpoint; }
      if (args.model) profile.defaultModel = args.model;
      if (store && typeof _saveProviders === 'function') _saveProviders(store);
      if (typeof ACTIVE_PROVIDER !== 'undefined' && ACTIVE_PROVIDER && ACTIVE_PROVIDER.id === profile.id) {
        Object.assign(ACTIVE_PROVIDER, profile);
      }
      if (args.model) await impl.ui_set_model({ model: args.model });
      return { ok: true, endpoint: profile.endpoint, model: args.model || undefined, note: 'applies from the next message' };
    },

    async ui_toggle_server(args) {
      const s = (mcpServers || []).find((x) => x.name === args.name);
      if (!s) throw new Error(`no MCP server named ${JSON.stringify(args.name)}`);
      s.enabled = args.enabled;
      if (typeof saveMcpServers === 'function') saveMcpServers();
      if (args.enabled && typeof mcpConnectServer === 'function') await mcpConnectServer(s).catch(() => {});
      if (!args.enabled && typeof mcpDisconnectServer === 'function') await mcpDisconnectServer(s).catch(() => {});
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
      return { ok: true, name: s.name, enabled: s.enabled };
    },

    async ui_open(args) {
      const map = { graph: '#creelGraphBtn', fleet: '#creelFleetBtn' };
      if (args.panel === 'settings') {
        if (typeof openSettingsModal === 'function') { openSettingsModal(); flash(document.getElementById('settingsModal'), true); return { ok: true }; }
        throw new Error('settings modal unavailable');
      }
      const btn = document.querySelector(map[args.panel] || '');
      if (!btn) throw new Error(`no panel ${JSON.stringify(args.panel)}`);
      flash(btn, true);
      btn.click();
      return { ok: true, panel: args.panel };
    },

    async ui_click(args) {
      const el = document.querySelector(args.selector);
      if (!el) throw new Error(`no element matches ${JSON.stringify(args.selector)}`);
      flash(el, true);
      el.click();
      return { ok: true, clicked: args.selector };
    },

    async ui_fill(args) {
      const el = document.querySelector(args.selector);
      if (!el) throw new Error(`no element matches ${JSON.stringify(args.selector)}`);
      const idHint = `${el.id || ''} ${el.name || ''} ${el.placeholder || ''}`.toLowerCase();
      if (/key|token|secret|passphrase/.test(idHint)) {
        throw new Error('refusing to fill a credential field — the user sets those in Settings directly');
      }
      flash(el, true);
      el.value = args.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, filled: args.selector };
    },
  };

  const CreelUi = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({
              protocolVersion: body.params?.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'ui', version: '0' },
            });
          case 'notifications/initialized': return null;
          case 'tools/list': return reply({ tools: TOOLS });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!impl[name]) return fail(`unknown tool: ${name}`);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await impl[name](args || {})) }] });
          }
          default: return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
    registerDefaults() {
      window.CreelInpage.register('inpage:ui', this);
      if (typeof mcpServers !== 'undefined' && !mcpServers.find((s) => s.id === 'mcp_ui_inpage')) {
        mcpServers.push({ id: 'mcp_ui_inpage', name: 'ui', type: 'inpage', url: 'inpage:ui', token: '', corsProxy: '', enabled: true });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = (typeof mcpServers !== 'undefined') && mcpServers.find((s) => s.id === 'mcp_ui_inpage');
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) => console.warn('ui in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };
  window.CreelUi = CreelUi;

  // ── 2. seed the world model into the shared quipu store ──────────
  async function seedWorldModel() {
    try {
      await window.CreelQuipu.ensureWasm();
      const call = (name, args) => window.CreelQuipu.provider.callTool(name, args);
      const existing = await call('quipu_query', {
        query: `SELECT ?s WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "${WORLD_VERSION}" } LIMIT 1`,
      });
      if (existing.count > 0) return;

      const servers = (typeof mcpServers !== 'undefined' ? mcpServers : [])
        .filter((s) => s.type === 'inpage');
      const serverNodes = servers.map((s) => ({
        name: `server:${s.name}`,
        type: 'ToolServer',
        description: {
          quipu: 'knowledge graph tools (37): episodes, SPARQL query, search, impact, export — the shared brain, one OPFS store for all tabs',
          github: 'repo checkout into FILES and push back over the GitHub API (github_checkout/push/open_pr)',
          local: 'sync a real local folder in/out of FILES (desktop Chrome/Edge)',
          fleet: 'spawn agent tabs, message them (fleet_send/inbox), collect results (fleet_status/report)',
          ui: 'drive creel\'s own interface: describe state, switch model/provider, toggle servers, open panels, click/fill controls',
        }[s.name] || 'in-page tool server',
      }));

      await call('quipu_episode', {
        name: WORLD_VERSION,
        episode_body: 'The creel world model: how this system is organized, written for its own agents. '
          + 'creel is a static browser page running agent loops. There is always exactly ONE root pane '
          + '(the dispatcher, elected by Web Lock, badge ⬢): it spawns bobbins (agent tabs), seeds and owns this '
          + 'world model, and synthesizes results. Bobbins work one task, coordinate via fleet_send, and MUST '
          + 'finish by calling fleet_report. All tabs share one quipu store (leader-elected OPFS host) — '
          + 'knowledge written anywhere is instantly visible everywhere; record durable findings as quipu episodes. '
          + 'The interface itself is operable through the ui tools; every click and input flashes a highlight '
          + '(orange = agent hands, cyan = human hands). Query this graph, not documentation, to understand the world.',
        source: 'creel-self',
        nodes: [
          { name: WORLD_VERSION, type: 'WorldModel', description: 'versioned self-description marker; re-seeded only when the version bumps' },
          { name: 'root-pane', type: 'Role', description: 'the dispatcher: exactly one, Web-Lock elected among non-agent tabs, survives tab death by takeover; spawns and synthesizes' },
          { name: 'bobbin', type: 'Role', description: 'a spawned agent tab: one task, autonomous, reports via fleet_report, coordinates via fleet_send' },
          { name: 'shared-brain', type: 'Subsystem', description: 'one OPFS quipu store for all tabs; leader tab hosts, others RPC over BroadcastChannel; leader death → takeover with data intact' },
          { name: 'files-panel', type: 'Surface', description: 'the VFS workspace agents edit; github/local servers move it to durable storage' },
          { name: 'graph-explorer', type: 'Surface', description: '◉ graph button: visual view of this very store (force layout, SPARQL, entity history)' },
          { name: 'fleet-dashboard', type: 'Surface', description: '🧺 fleet button: live agent list, results, comms log, manual spawn' },
          ...serverNodes,
        ],
        edges: [
          { source: 'root-pane', target: 'bobbin', relation: 'dispatches' },
          { source: 'root-pane', target: WORLD_VERSION, relation: 'maintains' },
          { source: 'bobbin', target: 'shared-brain', relation: 'grounds_in' },
          { source: 'root-pane', target: 'shared-brain', relation: 'grounds_in' },
          { source: 'graph-explorer', target: 'shared-brain', relation: 'renders' },
          ...serverNodes.map((n) => ({ source: n.name, target: 'root-pane', relation: 'serves' })),
        ],
      });
      console.log('creel: world model seeded into quipu', WORLD_VERSION);
    } catch (e) {
      console.warn('creel: world model seeding failed (will retry next root election)', e);
    }
  }

  function start() {
    CreelUi.registerDefaults();
    electRoot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
