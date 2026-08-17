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
 *    reconfigure the provider, toggle tool servers, open panels, read the
 *    transcript, type into the chat, stop a run, and operate any control.
 *    Targets are named Playwright-style, by ARIA role and accessible name or
 *    by a [ref] from ui_snapshot, and every action auto-waits for its target
 *    to be visible and enabled (see app/creel-locator.js). Every input — the
 *    human's and the agent's — flashes a highlight ring, so what is being
 *    touched is always visible (agent touches glow orange, human cyan).
 *
 * 4. THOSE HANDS REACH ACROSS TABS. Every ui_ tool takes an optional `tab`,
 *    and a 'creel-ui' BroadcastChannel carries the call to that tab, which
 *    runs it against its OWN DOM and answers. So an agent can do for another
 *    bobbin exactly what the operator could do by switching to its window:
 *    see what it is running, re-point its provider, read its transcript,
 *    type into its chat, stop it. The parity with the human is the point —
 *    an agent that can only touch its own tab is not a peer of the operator,
 *    it is a guest in one window.
 *
 * 5. CREDENTIALS GO IN, NEVER OUT. An operator who pastes an API key and
 *    says "set this up" is asking for something an agent should be able to
 *    do, so the write path is open — ui_fill writes credential fields, and
 *    ui_set_credential persists a provider key. The read path is closed at
 *    every exit: snapshots mark such fields write-only, action results
 *    report a character count rather than the value, and ui_describe says
 *    only whether a key EXISTS. The asymmetry is the design; a symmetric
 *    rule would either block a legitimate request or turn every agent into
 *    an exfiltration path.
 *
 *    The one other permanent limit: a tab may not prompt itself, because
 *    that is a token-burning loop rather than a capability.
 */
(function () {
  'use strict';

  const IS_AGENT_TAB = /creel-agent=/.test(location.hash);
  const ROOT_LOCK = 'creel-root-pane';
  const WORLD_VERSION = 'creel-world-model-v4';

  // A stable handle for this tab, in sessionStorage so it survives reload
  // (a reloaded tab is the same bobbin) but never leaks to a new tab.
  const TAB_ID = (() => {
    let id = sessionStorage.getItem('creel_tab_id');
    if (!id) { id = `t${Math.random().toString(36).slice(2, 8)}`; sessionStorage.setItem('creel_tab_id', id); }
    return id;
  })();
  const AGENT_ID = (location.hash.match(/creel-(?:agent|worker)=([a-z0-9]+)/) || [])[1] || null;

  const CreelSelf = { role: IS_AGENT_TAB ? 'bobbin' : 'standby', tabId: TAB_ID, agentId: AGENT_ID, worldVersion: WORLD_VERSION };
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

  // The locator engine flashes through this, so an action routed in from
  // another tab lights up where it lands.
  CreelSelf.flash = flash;

  const INTERACTIVE = 'button, a, input, textarea, select, [onclick], [role="button"]';
  document.addEventListener('click', (e) => {
    const el = e.composedPath().find((n) => n instanceof Element && n.matches?.(INTERACTIVE));
    if (el) flash(el);
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.composedPath()[0];
    if (el instanceof Element) flash(el);
  }, true);

  // ── 4. cross-tab hands: the 'creel-ui' RPC bus ───────────────────
  // Same-origin tabs can't touch each other's DOM directly, so a ui call
  // aimed at another tab is delivered as a message and executed THERE,
  // against that tab's own document, by the same impl functions. The wire
  // is BroadcastChannel — the same bus the fleet already runs on.
  const UI_BC = new BroadcastChannel('creel-ui');
  const rpcPending = new Map();     // id → {resolve, reject, timer}
  const rosterPending = new Map();  // id → [] collecting 'iam' replies
  let rpcSeq = 0;

  /** How this tab answers "who are you" — also the row ui_tabs returns. */
  function identity() {
    let running = null;
    try { running = typeof getActiveConversationRun === 'function' ? !!getActiveConversationRun()?.active : null; } catch { /* harness not ready */ }
    return {
      tab: TAB_ID,
      role: CreelSelf.role,
      agentId: AGENT_ID,
      label: CreelSelf.label || null,
      title: document.title.replace(/^⬢ /, ''),
      model: typeof API_MODEL !== 'undefined' ? API_MODEL : null,
      running,
      device: (typeof window !== 'undefined' && window.CreelDevice)
        ? { kind: window.CreelDevice.info().kind, tabCap: window.CreelDevice.tabCap() }
        : null,
    };
  }

  /** Every name this tab answers to. A caller shouldn't have to know a tab's
   *  internal id to reach the root pane or a labelled bobbin. */
  function matchesMe(target) {
    if (!target) return false;
    const t = String(target);
    if (t === TAB_ID || (AGENT_ID && t === AGENT_ID)) return true;
    if (CreelSelf.label && t === CreelSelf.label) return true;
    if ((t === 'root' || t === 'dashboard') && CreelSelf.role === 'root') return true;
    return false;
  }

  function remoteCall(target, name, args, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = `u${++rpcSeq}`;
      const timer = setTimeout(() => {
        rpcPending.delete(id);
        reject(new Error(`no creel tab answered ${JSON.stringify(target)} within ${timeoutMs}ms — call ui_tabs to see which tabs are live`));
      }, timeoutMs);
      rpcPending.set(id, { resolve, reject, timer });
      UI_BC.postMessage({ t: 'call', id, target: String(target), name, args, from: TAB_ID });
    });
  }

  UI_BC.onmessage = async ({ data: m }) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'who') { UI_BC.postMessage({ t: 'iam', id: m.id, tab: identity() }); return; }
    if (m.t === 'iam') { rosterPending.get(m.id)?.push(m.tab); return; }
    if (m.t === 'call') {
      if (!matchesMe(m.target) || !impl[m.name]) return;   // not for us
      try {
        // _remote marks a call that arrived from another tab: ui_prompt uses
        // it to refuse prompting its own tab (a loop) while still allowing a
        // peer to prompt it.
        const result = await impl[m.name]({ ...(m.args || {}), _remote: true });
        UI_BC.postMessage({ t: 'ret', id: m.id, ok: true, result, from: TAB_ID });
      } catch (e) {
        UI_BC.postMessage({ t: 'ret', id: m.id, ok: false, error: (e && e.message) || String(e), from: TAB_ID });
      }
      return;
    }
    if (m.t === 'ret') {
      const p = rpcPending.get(m.id);
      if (!p) return;                       // already resolved (or timed out)
      rpcPending.delete(m.id);
      clearTimeout(p.timer);
      if (!m.ok) { p.reject(new Error(m.error || 'remote ui call failed')); return; }
      p.resolve(m.result && typeof m.result === 'object' ? { ...m.result, _tab: m.from } : m.result);
    }
  };

  /** Ask every live creel tab to identify itself. There is no registry to go
   *  stale: a tab that doesn't answer isn't there. */
  async function roster(waitMs = 400) {
    const id = `w${++rpcSeq}`;
    const found = [];
    rosterPending.set(id, found);
    UI_BC.postMessage({ t: 'who', id, from: TAB_ID });
    await new Promise((r) => setTimeout(r, waitMs));
    rosterPending.delete(id);
    const me = identity();
    const seen = new Set([me.tab]);
    const others = found.filter((t) => t && !seen.has(t.tab) && seen.add(t.tab));
    return [{ ...me, self: true }, ...others];
  }

  // ── 3b. the 'ui' server: creel configures creel ──────────────────
  function activeProfile() {
    const store = typeof _loadProviders === 'function' ? _loadProviders() : null;
    const id = (typeof getActiveProviderId === 'function' && getActiveProviderId())
      || localStorage.getItem('ba_active_provider_id') || '';
    const list = store?.providers || store || [];
    const arr = Array.isArray(list) ? list : Object.values(list);
    return { store, profile: arr.find((p) => p && p.id === id) || (typeof ACTIVE_PROVIDER !== 'undefined' ? ACTIVE_PROVIDER : null) };
  }

  // Every tool below accepts `tab`. Omit it to act on your own tab; pass a
  // tab id, an agent/task id, a fleet label, or "root" to act on another.
  const TAB_ARG = { type: 'string', description: 'target creel tab: a tab id from ui_tabs, an agent/task id, a fleet label, or "root" for the dispatcher. Omit to act on your own tab.' };
  const withTab = (props) => ({ ...props, tab: TAB_ARG });

  // How every action tool names its target — Playwright's locator model.
  // Give ONE of ref / role+name / text / label / placeholder / testId /
  // selector. An ambiguous locator is an error rather than a coin flip; add
  // `nth` or a more specific name to resolve it.
  const LOCATOR = {
    ref: { type: 'string', description: 'a [ref] handle from the last ui_snapshot — the most reliable target' },
    role: { type: 'string', description: 'ARIA role: button, link, textbox, checkbox, combobox, heading, tab, dialog…' },
    name: { type: 'string', description: 'accessible name, matched case-insensitively as a substring (pair with role)' },
    text: { type: 'string', description: 'visible text of the element that most directly contains it' },
    label: { type: 'string', description: 'the label of a form field' },
    placeholder: { type: 'string', description: 'a field\'s placeholder text' },
    testId: { type: 'string', description: 'data-testid value' },
    selector: { type: 'string', description: 'CSS escape hatch — prefer role+name, which survives restyling' },
    exact: { type: 'boolean', description: 'require an exact name match instead of a substring' },
    nth: { type: 'integer', description: '0-based index when the locator legitimately matches several' },
    timeout: { type: 'integer', description: 'milliseconds to auto-wait for the element, default 5000' },
  };
  const LOCATOR_KEYS = ['ref', 'role', 'name', 'text', 'label', 'placeholder', 'testId', 'selector', 'exact', 'nth'];

  /** Split an action tool's arguments into a locator and the rest. */
  function locatorOf(args) {
    const loc = {};
    for (const k of LOCATOR_KEYS) if (args[k] !== undefined) loc[k] = args[k];
    return loc;
  }
  const L = () => {
    if (!window.CreelLocator) throw new Error('the locator engine is not loaded in this tab (app/creel-locator.js)');
    return window.CreelLocator;
  };

  const TOOLS = [
    {
      name: 'ui_tabs',
      description: 'List every live creel tab — its tab id, role (root pane / bobbin / standby), agent id, label, title, model and whether it is currently running. This is the map for every other ui_ tool\'s `tab` argument.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'ui_describe',
      description: 'Describe a creel tab\'s interface state: role, provider endpoint + model, tool servers and enabled state, open panels, run state. Call before reconfiguring anything.',
      inputSchema: { type: 'object', properties: withTab({}), required: [] },
    },
    {
      name: 'ui_snapshot',
      description: 'The accessibility tree of a creel tab: every interactive control as role + accessible name + a [ref] handle, with values, checked state and disabled state. This is the map — take a snapshot, then act by {ref} or by {role, name}. Refs stay valid until the element leaves the page.',
      inputSchema: {
        type: 'object',
        properties: withTab({
          filter: { type: 'string', description: 'only nodes whose role/name/id contains this text' },
          all: { type: 'boolean', description: 'include landmarks, headings and text structure, not just interactive controls' },
          limit: { type: 'integer', description: 'default 200' },
          format: { type: 'string', enum: ['text', 'json'], description: 'indented text (default, far cheaper) or structured nodes' },
        }),
        required: [],
      },
    },
    {
      name: 'ui_set_model',
      description: 'Switch the active LLM model for a tab (e.g. deepseek-chat, deepseek-reasoner).',
      inputSchema: { type: 'object', properties: withTab({ model: { type: 'string' } }), required: ['model'] },
    },
    {
      name: 'ui_configure_provider',
      description: 'Update a tab\'s active provider profile: endpoint base URL and/or default model. To set that profile\'s API key, use ui_set_credential — it writes without ever exposing the value.',
      inputSchema: {
        type: 'object',
        properties: withTab({
          endpoint: { type: 'string', description: 'API base URL, e.g. https://api.deepseek.com' },
          model: { type: 'string', description: 'default model for the profile' },
        }),
        required: [],
      },
    },
    {
      name: 'ui_toggle_server',
      description: 'Enable or disable one of a tab\'s MCP tool servers by name (see ui_describe for the list).',
      inputSchema: {
        type: 'object',
        properties: withTab({ name: { type: 'string' }, enabled: { type: 'boolean' } }),
        required: ['name', 'enabled'],
      },
    },
    {
      name: 'ui_open',
      description: 'Open one of creel\'s panels in a tab: "graph" (quipu explorer), "fleet" (agent dashboard), or "settings".',
      inputSchema: { type: 'object', properties: withTab({ panel: { type: 'string', enum: ['graph', 'fleet', 'settings'] } }), required: ['panel'] },
    },
    {
      name: 'ui_transcript',
      description: 'Read the recent chat messages of a creel tab — what the operator asked and what that agent has been doing. Use it to check on another bobbin before deciding whether to guide or stop it.',
      inputSchema: { type: 'object', properties: withTab({ limit: { type: 'integer', description: 'how many trailing messages (default 12)' } }), required: [] },
    },
    {
      name: 'ui_prompt',
      description: 'Type a message into another creel tab\'s chat box and send it, exactly as the operator would — a new instruction if that tab is idle, non-interrupting guidance if it is mid-run. Requires `tab`: a tab may not prompt itself. Differs from fleet_send, which marks the message as fleet traffic; this one is indistinguishable from the human typing.',
      inputSchema: { type: 'object', properties: withTab({ text: { type: 'string' }, send: { type: 'boolean', description: 'false to type without sending (default true)' } }), required: ['text'] },
    },
    {
      name: 'ui_stop',
      description: 'Stop the running agent loop in a tab, as the operator\'s stop button does. Safe when nothing is running.',
      inputSchema: { type: 'object', properties: withTab({}), required: [] },
    },
    {
      name: 'ui_click',
      description: 'Click a control in a creel tab. Auto-waits for it to be visible and enabled first, so there is never a reason to sleep before clicking.',
      inputSchema: { type: 'object', properties: withTab(LOCATOR), required: [] },
    },
    {
      name: 'ui_fill',
      description: 'Set the value of a textbox in a creel tab (clears it, then writes, firing input+change so frameworks observe it). Auto-waits. Credential fields ARE writable — this is how you store a key the operator gives you — but no tool will ever read one back, and the value is not echoed in the result.',
      inputSchema: { type: 'object', properties: withTab({ ...LOCATOR, value: { type: 'string' } }), required: ['value'] },
    },
    {
      name: 'ui_type',
      description: 'Type into a control key by key, appending rather than replacing — for inputs that react to each keystroke (autocomplete, @-mentions). Use ui_fill for plain values.',
      inputSchema: { type: 'object', properties: withTab({ ...LOCATOR, text: { type: 'string' } }), required: ['text'] },
    },
    {
      name: 'ui_press',
      description: 'Press a key on a control, or on whatever is focused if no locator is given. Enter submits the owning form when the page does not handle it.',
      inputSchema: { type: 'object', properties: withTab({ ...LOCATOR, key: { type: 'string', description: 'e.g. Enter, Escape, ArrowDown, a' } }), required: [] },
    },
    {
      name: 'ui_hover',
      description: 'Hover a control — reveals menus and tooltips that only appear on pointer-over.',
      inputSchema: { type: 'object', properties: withTab(LOCATOR), required: [] },
    },
    {
      name: 'ui_check',
      description: 'Check or uncheck a checkbox/switch, idempotently — it verifies the resulting state rather than blindly toggling.',
      inputSchema: { type: 'object', properties: withTab({ ...LOCATOR, checked: { type: 'boolean', description: 'default true' } }), required: [] },
    },
    {
      name: 'ui_select_option',
      description: 'Choose an option in a <select>, by value or by visible label.',
      inputSchema: { type: 'object', properties: withTab({ ...LOCATOR, value: { type: 'string' }, label: { type: 'string' } }), required: [] },
    },
    {
      name: 'ui_wait_for',
      description: 'Wait until a control reaches a state: visible (default), hidden, attached, detached, or enabled. Use after an action that triggers async work instead of guessing at a delay.',
      inputSchema: {
        type: 'object',
        properties: withTab({
          ...LOCATOR,
          state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached', 'enabled'] },
          timeout: { type: 'integer', description: 'milliseconds, default 5000' },
        }),
        required: [],
      },
    },
    {
      name: 'ui_text',
      description: 'Read the text of a region of a creel tab — a panel, a message, a status line. Credential values are never included.',
      inputSchema: { type: 'object', properties: withTab(LOCATOR), required: [] },
    },
    {
      name: 'ui_set_credential',
      description: 'Store a credential the operator has given you — the active provider\'s API key, or a named settings field — into this tab\'s configuration, and persist it. WRITE-ONLY BY DESIGN: nothing returns the value, and every read path (ui_snapshot, ui_text, ui_fill results) masks it. Use when the user pastes a key and asks you to set it up.',
      inputSchema: {
        type: 'object',
        properties: withTab({
          value: { type: 'string', description: 'the secret itself' },
          field: { type: 'string', description: 'which credential: "apiKey" (the active provider, default), or the id of a settings input such as "setDaytonaApiKey"' },
          providerId: { type: 'string', description: 'set a specific provider profile instead of the active one' },
        }),
        required: ['value'],
      },
    },
  ];

  const impl = {
    async ui_tabs() {
      const tabs = await roster();
      return { count: tabs.length, tabs, hint: 'pass any tab id, agent id, label, or "root" as the `tab` argument of another ui_ tool' };
    },

    async ui_describe() {
      const { profile } = activeProfile();
      return {
        build: window.CREEL_BUILD,
        tab: TAB_ID,
        agentId: AGENT_ID,
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
        device: (typeof window !== 'undefined' && window.CreelDevice)
          ? { kind: window.CreelDevice.info().kind, cap: window.CreelDevice.tabCap() }
          : null,
        worldModel: 'query the quipu graph for the creel world model (search_nodes "creel world model")',
      };
    },

    /** The accessibility tree, with refs — creel seen the way an agent has
     *  to see it. Text by default: the indented form costs a fraction of the
     *  JSON and reads the same. */
    async ui_snapshot(args) {
      const opts = { filter: args.filter || '', all: args.all === true, limit: args.limit || 200 };
      const head = { tab: TAB_ID, role: CreelSelf.role, title: document.title.replace(/^⬢ /, '') };
      if (args.format === 'json') {
        const nodes = L().snapshot(opts);
        return { ...head, count: nodes.length, nodes };
      }
      const text = L().snapshotText(opts);
      return {
        ...head,
        snapshot: text || '(nothing interactive is visible — try all:true, or drop the filter)',
        hint: 'act with {ref:"e12"} or {role:"button", name:"Send"}',
      };
    },

    // ── Playwright-shaped actions. Each auto-waits for its target to be
    //    visible and enabled; none of them needs a sleep before it.
    async ui_click(args) { return L().actions.click(locatorOf(args), { timeout: args.timeout }); },
    async ui_fill(args) { return L().actions.fill(locatorOf(args), String(args.value ?? ''), { timeout: args.timeout }); },
    async ui_type(args) { return L().actions.type(locatorOf(args), String(args.text ?? ''), { timeout: args.timeout }); },
    async ui_hover(args) { return L().actions.hover(locatorOf(args), { timeout: args.timeout }); },
    async ui_check(args) { return L().actions.check(locatorOf(args), args.checked !== false, { timeout: args.timeout }); },
    async ui_select_option(args) { return L().actions.selectOption(locatorOf(args), { value: args.value, label: args.label }, { timeout: args.timeout }); },

    async ui_press(args) {
      const loc = locatorOf(args);
      const targeted = Object.keys(loc).length > 0;
      return L().actions.press(targeted ? loc : null, args.key || 'Enter', { timeout: args.timeout });
    },

    async ui_wait_for(args) {
      const state = args.state || 'visible';
      const el = await L().waitFor(locatorOf(args), { state, timeout: args.timeout || 5000 });
      return {
        ok: true,
        state,
        found: !!el,
        role: el ? L().role(el) : undefined,
        name: el ? L().accessibleName(el) : undefined,
      };
    },

    async ui_text(args) { return L().text(locatorOf(args)); },

    /** The write half of the credential asymmetry. There is deliberately no
     *  matching read: the operator can hand a key to an agent, and the agent
     *  can put it where it belongs, but it cannot be got back out of creel. */
    async ui_set_credential(args) {
      const value = String(args.value ?? '');
      if (!value) throw new Error('empty credential');
      const field = args.field || 'apiKey';

      if (field === 'apiKey') {
        const store = typeof _loadProviders === 'function' ? _loadProviders() : null;
        const providers = store && store.providers;
        if (!providers) throw new Error('no provider profiles exist yet — open Settings and create one first (ui_open {panel:"settings"})');
        const id = args.providerId
          || (typeof getActiveProviderId === 'function' && getActiveProviderId())
          || Object.keys(providers)[0];
        const profile = providers[id];
        if (!profile) throw new Error(`no provider profile ${JSON.stringify(id)} — ui_describe lists the active one`);
        profile.apiKey = value;
        if (typeof _saveProviders === 'function') _saveProviders(store);
        if (typeof ACTIVE_PROVIDER !== 'undefined' && ACTIVE_PROVIDER && ACTIVE_PROVIDER.id === id) ACTIVE_PROVIDER.apiKey = value;
        return { ok: true, tab: TAB_ID, field: 'apiKey', provider: profile.name || id, length: value.length, note: 'stored and persisted; it cannot be read back through any tool' };
      }

      // A named settings input (e.g. setDaytonaApiKey): write it and let the
      // harness's own save path persist it.
      const el = document.getElementById(field);
      if (!el) throw new Error(`no settings field with id ${JSON.stringify(field)} — ui_snapshot lists them`);
      flash(el, true);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, tab: TAB_ID, field, length: value.length, note: 'written into the settings field; click the settings Save control to persist it' };
    },

    /** What this tab has been saying — the operator reads it by looking at
     *  the window; an agent reads it with this. */
    async ui_transcript(args) {
      const limit = Math.min(args.limit || 12, 50);
      const nodes = Array.from(document.querySelectorAll('#chatMessages .msg')).slice(-limit);
      const messages = nodes.map((el) => ({
        role: (el.className.match(/msg-([a-z]+)/) || [])[1] || 'unknown',
        text: (el.innerText || '').replace(/\s+\n/g, '\n').trim().slice(0, 1500),
      })).filter((m) => m.text);
      return { tab: TAB_ID, role: CreelSelf.role, running: identity().running, count: messages.length, messages };
    },

    /** Type into a tab's chat and send — the operator's own move. The
     *  harness routes it as a new task when idle and as non-interrupting
     *  guidance mid-run, which is exactly what a human typing gets. */
    async ui_prompt(args) {
      if (!args._remote) {
        throw new Error('refusing to prompt your own tab — that is a loop, not a capability. Pass `tab` to prompt another creel tab (see ui_tabs), or just keep working.');
      }
      const text = String(args.text || '').trim();
      if (!text) throw new Error('empty text');
      const inp = document.getElementById('userInput');
      if (!inp) throw new Error('this tab has no chat input');
      const wasRunning = identity().running;
      flash(inp, true);
      inp.value = text;
      if (typeof handleInputChange === 'function') handleInputChange(inp);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      if (args.send === false) return { ok: true, tab: TAB_ID, typed: true, sent: false };
      if (typeof handleSend !== 'function') throw new Error('this tab cannot send (harness not ready)');
      await handleSend();
      return {
        ok: true,
        tab: TAB_ID,
        sent: true,
        delivered: wasRunning ? 'queued as guidance for the run already in flight' : 'started a new turn in that tab',
      };
    },

    async ui_stop() {
      if (typeof getActiveConversationRun !== 'function' || typeof stopConversationRun !== 'function') {
        throw new Error('run controls unavailable in this tab');
      }
      const run = getActiveConversationRun();
      if (!run || !run.active) return { ok: true, tab: TAB_ID, stopped: false, note: 'nothing was running' };
      if (run.state?.ralphRun?.active) run.state.ralphRun.cancelled = true;
      stopConversationRun(run.convId);
      return { ok: true, tab: TAB_ID, stopped: true, conversation: run.convId };
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
            // `tab` is routing, not an argument: strip it, and if it names
            // someone else, run the call in THAT tab instead of this one.
            const { tab: target, ...rest } = args || {};
            const remote = target && !matchesMe(target) && name !== 'ui_tabs';
            const result = remote ? await remoteCall(target, name, rest) : await impl[name](rest);
            return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
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
  /** Seed the world model, unless this version is already in the store.
   *  `version` is a parameter rather than a closed-over constant so a test
   *  can seed a later version against a store that already holds earlier
   *  ones — which is the only way to exercise the supersedes path. */
  async function seedWorldModel(version) {
    // Shadowing the module constant deliberately, so the body below reads the
    // same whether it is seeding the real version or a test's. (A default
    // parameter would resolve against the outer constant, which works but
    // reads like a bug.)
    const WORLD_VERSION = version || CreelSelf.worldVersion;
    try {
      await window.CreelQuipu.ensureWasm();
      const call = (name, args) => window.CreelQuipu.provider.callTool(name, args);
      const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
      const existing = await call('quipu_query', {
        query: `SELECT ?s WHERE { ?s <${RDFS_LABEL}> "${WORLD_VERSION}" } LIMIT 1`,
      });
      if (existing.count > 0) return;

      // A store seeded at an earlier version keeps that version's nodes — the
      // graph is append-only and facts stay true at write time, so we do not
      // rewrite them. But an agent that finds v1 must not read it as current,
      // so the new episode declares what it supersedes and edges point
      // forward. Following `supersedes` backwards from any version reaches
      // the newest one. (creel-b8b)
      const priorVersions = [];
      const currentN = Number((WORLD_VERSION.match(/v(\d+)$/) || [])[1] || 0);
      for (let v = 1; v < currentN; v++) {
        const label = WORLD_VERSION.replace(/v\d+$/, `v${v}`);
        const hit = await call('quipu_query', {
          query: `SELECT ?s WHERE { ?s <${RDFS_LABEL}> "${label}" } LIMIT 1`,
        }).catch(() => ({ count: 0 }));
        if (hit.count > 0) priorVersions.push(label);
      }

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
          ui: 'operate creel itself, in ANY tab: ui_tabs lists the live tabs; every other ui_ tool takes `tab` to act on one of them. Locate controls the Playwright way — {ref} from ui_snapshot, or {role,name} — and every action auto-waits for its target. Describe, snapshot, switch model/provider, toggle servers, open panels, read the transcript, prompt the chat, stop the run, click/fill/type/press/hover/check/select',
          browser: 'drive cross-origin websites through the creel bridge extension, with the SAME locator vocabulary the ui tools use — the bridge injects the same engine into the far page. Absent the extension only browser_status exists',
          state: 'creel\'s own durable state in a private GitHub repo the operator owns: state_push writes config, conversations, skills, memory and the quipu .db as ONE commit (content-addressed, only what changed); state_pull restores them. Refuses a public repo; carries API keys only on an explicit opt-in WITH a passphrase',
          bd: 'the issue tracker, byte-compatible with the .beads/ JSONL tracker in the repo (bd_ready/list/show/create/update/close)',
          measurement: 'the grounding measurement suite: does local knowledge make a cheap model a viable agent (bench_tasks/grade/record/report)',
        }[s.name] || 'in-page tool server',
      }));

      await call('quipu_episode', {
        name: WORLD_VERSION,
        episode_body: `The creel world model (${WORLD_VERSION}${priorVersions.length ? `, superseding ${priorVersions.join(', ')}` : ''}): how this system is organized, written for its own agents. `
          + 'creel is a static browser page running agent loops. There is always exactly ONE root pane '
          + '(the dispatcher, elected by Web Lock, badge ⬢): it spawns bobbins (agent tabs), seeds and owns this '
          + 'world model, and synthesizes results. Bobbins work one task, coordinate via fleet_send, and MUST '
          + 'finish by calling fleet_report. All tabs share one quipu store (leader-elected OPFS host) — '
          + 'knowledge written anywhere is instantly visible everywhere; record durable findings as quipu episodes. '
          + 'creel is operable by its agents to the same depth as by its operator. The ui tools drive the interface '
          + 'of ANY creel tab, not just your own: ui_tabs lists the live tabs, and every other ui_ tool takes a `tab` '
          + 'argument (tab id, agent id, label, or "root") — so you can inspect a peer bobbin, read its transcript, '
          + 're-point its provider, type into its chat (ui_prompt) or stop it, exactly as the human could by '
          + 'switching windows. Beyond creel, the browser tools drive real cross-origin websites when the creel '
          + 'bridge extension is installed (browser_status says whether it is). Every click and input flashes a '
          + 'highlight (orange = agent hands, cyan = human hands), so nothing an agent touches is invisible. '
          + 'Never guess a CSS selector: call ui_snapshot for the accessibility tree and act by {ref} or '
          + '{role, name}. Actions auto-wait for their target to be visible and enabled, so never sleep first; '
          + 'an ambiguous locator is an error listing the candidates, not a coin flip. '
          + 'CREDENTIALS ARE WRITE-ONLY: you CAN put an API key the operator gives you into the field that '
          + 'needs it (ui_fill, or ui_set_credential to persist a provider key), and you can never read one '
          + 'back — every snapshot and text read masks them. The other permanent limit is that a tab cannot '
          + 'prompt itself. Query this graph, not documentation, to understand the world.',
        source: 'creel-self',
        nodes: [
          { name: WORLD_VERSION, type: 'WorldModel', description: `versioned self-description marker; re-seeded only when the version bumps. THIS IS THE CURRENT VERSION${priorVersions.length ? `, superseding ${priorVersions.join(', ')} — those remain in the graph as history, and are not current` : ''}` },
          ...priorVersions.map((label) => ({ name: label, type: 'WorldModel', description: `superseded by ${WORLD_VERSION}; kept as history. Do not read it as current — follow supersedes forward` })),
          { name: 'root-pane', type: 'Role', description: 'the dispatcher: exactly one, Web-Lock elected among non-agent tabs, survives tab death by takeover; spawns and synthesizes' },
          { name: 'bobbin', type: 'Role', description: 'a spawned agent tab: one task, autonomous, reports via fleet_report, coordinates via fleet_send' },
          { name: 'shared-brain', type: 'Subsystem', description: 'one OPFS quipu store for all tabs; leader tab hosts, others RPC over BroadcastChannel; leader death → takeover with data intact' },
          { name: 'files-panel', type: 'Surface', description: 'the VFS workspace agents edit; github/local servers move it to durable storage' },
          { name: 'graph-explorer', type: 'Surface', description: '◉ graph button: visual view of this very store (force layout, SPARQL, entity history)' },
          { name: 'fleet-dashboard', type: 'Surface', description: '🧺 fleet button: live agent list, results, comms log, manual spawn' },
          { name: 'cross-tab-hands', type: 'Capability', description: 'the ui_ tools take a `tab` argument and route over the creel-ui BroadcastChannel, so any tab can operate any other tab\'s interface — parity with the operator, who could just switch windows' },
          { name: 'locator-engine', type: 'Subsystem', description: 'creel-locator.js: Playwright\'s model in the page — ARIA roles, accessible names, [ref] handles, strict resolution (ambiguity is an error), and auto-waiting on every action. The same file is injected into cross-origin pages by the bridge, so one vocabulary drives both' },
          { name: 'durability', type: 'Policy', description: 'NOTHING in creel is durable by default. The VFS, conversations and this very graph live in browser storage, which is evictable and exists on no other machine. Work leaves by exactly three doors: github_push for code, state_push for creel\'s own state (one commit to a private repo the operator owns — config, conversations, skills, memory, and this graph as .db bytes), and quipu episodes for durable facts. A result that went through none of them is not saved, however finished it looks' },
          { name: 'state-repo', type: 'Subsystem', description: 'the durable home: a PRIVATE GitHub repo (default <login>/creel-state) holding a manifest plus content-addressed objects and blobs. Reuses the v2 sync engine — hash dedup, AES-GCM envelope — over a GitHub transport that stages writes and flushes them as one commit. Refuses a repo GitHub reports as public, re-checked on every push, because this data can include keys' },
          { name: 'credential-asymmetry', type: 'Policy', description: 'an agent may WRITE a credential the operator hands it (ui_fill, ui_set_credential) and may never READ one: snapshots mark such fields write-only, results report a length not a value, ui_describe reports only whether a key exists' },
          { name: 'device-awareness', type: 'Capability', description: 'the harness classifies the device (creel-device.js) and caps concurrent agent tabs at 3 mobile / 4 tablet / 8 desktop — mobile browsers evict background tabs; fleet_device reports the class and free slots, fleet_spawn/fleet_spawn_workers clamp to free slots and report the rest `capped`, the 🧺 fleet dashboard shows a live `📱 mobile · 2/3 tabs` chip' },
          { name: 'fleet-visibility', type: 'Capability', description: 'every fleet transition (claimed/done/failed/requeued/aborted) is appended to a shared work log (meta:digest) and the main tab automatically receives a batched 🧺 FLEET DIGEST message in its conversation; fleet_digest returns the full log, fleet_status rows carry task text + heartbeat age — all fleet work is visible to the operator\'s agent without polling' },
          { name: 'web-hands', type: 'Capability', description: 'the browser_ tools drive cross-origin websites via the creel bridge Chrome extension (MV3). Opt-in: without the extension only browser_status exists. The bridge refuses to act on creel\'s own origins — that is the ui server\'s job' },
          ...serverNodes,
        ],
        edges: [
          { source: 'root-pane', target: 'bobbin', relation: 'dispatches' },
          { source: 'bobbin', target: 'cross-tab-hands', relation: 'wields' },
          { source: 'root-pane', target: 'cross-tab-hands', relation: 'wields' },
          { source: 'bobbin', target: 'web-hands', relation: 'wields' },
          { source: 'cross-tab-hands', target: 'locator-engine', relation: 'built_on' },
          { source: 'web-hands', target: 'locator-engine', relation: 'built_on' },
          { source: 'locator-engine', target: 'credential-asymmetry', relation: 'enforces' },
          { source: 'state-repo', target: 'durability', relation: 'enforces' },
          { source: 'shared-brain', target: 'state-repo', relation: 'persists_to' },
          { source: 'files-panel', target: 'state-repo', relation: 'persists_to' },
          { source: 'bobbin', target: 'durability', relation: 'bound_by' },
          { source: 'root-pane', target: 'durability', relation: 'bound_by' },
          { source: 'root-pane', target: WORLD_VERSION, relation: 'maintains' },
          ...priorVersions.map((label) => ({ source: WORLD_VERSION, target: label, relation: 'supersedes' })),
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

  // Exposed for tests and for an operator re-seeding after clearing a store.
  CreelSelf.seedWorldModel = seedWorldModel;

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
