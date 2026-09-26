/* creel — the `ui` server's tools: creel operates creel (creel-hun).
 *
 * Split out of creel-self.js, which was one 805-line closure. This half is
 * the tool surface: the schemas an agent sees and the implementations that
 * run against a real document. The other half — identity, root-pane
 * election, the cross-tab bus that routes these calls to the right tab — is
 * creel-self.js, and it must load FIRST: this file fills the `impl` and
 * `tools` collections that the bus and CreelUi.handle already close over.
 *
 * Nothing here knows which tab it is running in. A call that arrived from
 * another tab is marked `_remote` by the bus and is otherwise identical, so
 * every tool works the same whether the operator's tab or a peer bobbin
 * asked for it.
 */
(function () {
  'use strict';

  const SELF = window.CreelSelfInternal;
  if (!SELF) throw new Error('creel-ui-tools.js loaded before creel-self.js — check the script order in thread.html');
  const { TAB_ID, AGENT_ID, CreelSelf, flash, identity, matchesMe, remoteCall, roster } = SELF;
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
    {
      name: 'ui_update_status',
      description: 'Whether a newer creel bundle is deployed than the one this tab is running. '
        + 'A static site cannot restart itself, so a long-lived tab can run an old build for days; '
        + 'this is how you find out. Also reports whether state can be saved before reloading.',
      inputSchema: { type: 'object', properties: { tab: TAB_ARG }, required: [] },
    },
    {
      name: 'ui_reload',
      description: 'Reload creel — saving state first. Use after ui_update_status reports an update, '
        + 'or to recover a wedged tab. THE SAVE IS THE POINT: a creel tab holds its conversation, its '
        + 'FILES workspace and its share of the knowledge graph in browser memory and storage, so '
        + 'reloading without pushing discards them. Refuses by default when this tab holds a claimed '
        + 'fleet task (call fleet_report first) or when no state repo is configured to save into.',
      inputSchema: {
        type: 'object',
        properties: {
          tab: TAB_ARG,
          scope: {
            type: 'string',
            enum: ['self', 'all'],
            description: "self (default) = this tab. all = every live creel tab, one at a time with a "
              + 'pause between them, so a burst does not go dark at once. Each tab saves its own state.',
          },
          force: {
            type: 'boolean',
            description: 'Reload even when state cannot be saved, or when a fleet task is still held. '
              + 'This discards work — only when the operator asked for it.',
          },
          stagger_ms: {
            type: 'integer',
            description: 'Pause between tabs when scope is "all". Default 1500.',
          },
        },
        required: [],
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


    /** Is this tab behind the deployed bundle, and could it save if asked? */
    async ui_update_status() {
      const st = window.CreelState;
      const configured = !!(st && st.isConfigured && st.isConfigured());
      let lease = null;
      try { lease = (await window.CreelFleet?.debug())?.currentLeaseTaskId || null; } catch { /* no fleet */ }
      return {
        updateReady: !!window.CREEL_UPDATE_READY,
        canSaveState: configured,
        unpushedChanges: typeof stateIsDirty === 'function' ? stateIsDirty() : null,
        holdsFleetTask: lease,
        hint: window.CREEL_UPDATE_READY
          ? 'a newer bundle is deployed; ui_reload saves state and picks it up'
          : 'this tab is running the current bundle as far as it knows',
      };
    },

    async ui_reload(args) {
      const stagger = Number.isFinite(args.stagger_ms) ? Math.max(0, args.stagger_ms) : 1500;

      if (args.scope === 'all') {
        // Peers first, one at a time, this tab last — reloading ourselves
        // first would kill the loop that is driving the rest.
        const tabs = await roster();
        const others = tabs.filter((t) => !t.self);
        const reloaded = [];
        for (const t of others) {
          try {
            await remoteCall(t.tab, 'ui_reload', { force: args.force, scope: 'self' });
            reloaded.push({ tab: t.tab, label: t.label || null, ok: true });
          } catch (e) {
            reloaded.push({ tab: t.tab, label: t.label || null, ok: false, error: (e && e.message) || String(e) });
          }
          if (stagger) await new Promise((r) => setTimeout(r, stagger));
        }
        const self = await impl.ui_reload({ force: args.force });
        return { scope: 'all', peers: reloaded, self };
      }

      return CreelSelf.saveStateAndReload({ force: args.force });
    },
  };


  /* ── Saving before reloading (creel-ick) ──────────────────────────
   *
   * A reload is destructive here in a way it is not for an ordinary web page.
   * This tab holds a conversation, a FILES workspace, and whatever it has
   * learned that has not reached the graph — all in memory and evictable
   * browser storage. So the order is not negotiable: persist, then reload.
   *
   * Two refusals, both deliberate. A tab holding a claimed fleet task should
   * end it through fleet_report rather than by vanishing, because a lease
   * dropped by a dying tab is a requeue that looks like a crash. And with no
   * state repo configured there is nowhere to save TO, which makes "save and
   * reload" a promise this cannot keep — better to say so than to reload and
   * call it saved. `force` overrides either, for an operator who means it.
   */
  CreelSelf.saveStateAndReload = async function saveStateAndReload(opts = {}) {
    const out = { tab: TAB_ID, saved: false, reloading: false };

    let lease = null;
    try { lease = (await window.CreelFleet?.debug())?.currentLeaseTaskId || null; } catch { /* no fleet here */ }
    if (lease && !opts.force) {
      throw new Error(`this tab holds fleet task ${lease}; call fleet_report to finish it first `
        + '(or pass force: true to reload anyway, which requeues the task as if the tab had crashed)');
    }
    out.heldFleetTask = lease || undefined;

    const st = window.CreelState;
    if (st && st.isConfigured && st.isConfigured()) {
      // A spawned tab owns a slice; the operator's tab owns the shared state.
      const scope = (CreelSelf.agentId || IS_AGENT_TAB) ? 'agent' : 'shared';
      const reply = await st.handle({
        jsonrpc: '2.0', id: 'reload', method: 'tools/call',
        params: { name: 'state_push', arguments: { scope } },
      });
      if (reply.error) {
        if (!opts.force) throw new Error(`state_push failed, so nothing was reloaded: ${reply.error.message}`);
        out.saveError = reply.error.message;
      } else {
        out.saved = true;
        out.savedTo = JSON.parse(reply.result.content[0].text).prefix;
      }
    } else if (!opts.force) {
      throw new Error('no state repo is configured, so this tab has nowhere to save and a reload would '
        + 'discard its conversation and workspace. Run state_configure first, or pass force: true.');
    }

    // Reload after the caller has its answer — an RPC that reloads before
    // replying looks like a dead tab to whoever asked.
    out.reloading = true;
    window.__creelSuppressLeaveWarn = true;
    setTimeout(() => location.reload(), 250);
    return out;
  };

  // Fill the collections the bus and CreelUi.handle are already holding.
  // Mutate, never reassign — see the seam comment in creel-self.js.
  SELF.tools.push(...TOOLS);
  Object.assign(SELF.impl, impl);
})();
