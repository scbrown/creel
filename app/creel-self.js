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

  /* ── The update notice (creel-vup) ────────────────────────────────
   *
   * The page fires `creel-update-ready` when a newer service worker has
   * installed, which means the bundle on the server is ahead of the one this
   * tab is running. Nothing reloads on its own: a creel tab may be mid-turn,
   * and a fleet worker may be holding a claimed task, so throwing the page
   * away is the operator's call (or an agent's, via ui_reload, which saves
   * first). This just makes the fact visible and offers the safe path.
   */
  let updateBanner = null;
  function showUpdateNotice() {
    if (updateBanner) return;
    updateBanner = document.createElement('div');
    updateBanner.id = 'creelUpdateBanner';
    updateBanner.setAttribute('role', 'status');
    updateBanner.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:14px;'
      + 'z-index:10000;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;'
      + 'font:12px system-ui,sans-serif;background:#1d2436;color:#cbd5e1;'
      + 'border:1px solid #33405c;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:min(92vw,560px)';

    const text = document.createElement('span');
    text.textContent = 'A newer version of creel is deployed.';
    updateBanner.appendChild(text);

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Save state and reload';
    reload.setAttribute('aria-label', 'Save state and reload');
    reload.style.cssText = 'cursor:pointer;border-radius:5px;padding:4px 10px;font:inherit;'
      + 'background:#2b3a55;color:#e2e8f0;border:1px solid #44557a';
    reload.onclick = async () => {
      reload.disabled = true;
      reload.textContent = 'Saving\u2026';
      try {
        // The same path the agent tool takes, so the button cannot be the
        // careless option: state first, reload second.
        await CreelSelf.saveStateAndReload({ force: true });
      } catch (e) {
        reload.disabled = false;
        reload.textContent = 'Reload anyway';
        text.textContent = 'Could not save state: ' + ((e && e.message) || e);
        reload.onclick = () => location.reload();
      }
    };
    updateBanner.appendChild(reload);

    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Later';
    later.setAttribute('aria-label', 'Dismiss update notice');
    later.style.cssText = 'cursor:pointer;border-radius:5px;padding:4px 10px;font:inherit;'
      + 'background:none;color:#8892a4;border:1px solid #33405c';
    later.onclick = () => { updateBanner.remove(); updateBanner = null; };
    updateBanner.appendChild(later);

    document.body.appendChild(updateBanner);
  }
  window.addEventListener('creel-update-ready', showUpdateNotice);
  // The event may have fired before this file ran — the registration lives in
  // the page head and the worker can install fast.
  if (window.CREEL_UPDATE_READY) showUpdateNotice();
  CreelSelf.showUpdateNotice = showUpdateNotice;

  function electRoot() {
    if (IS_AGENT_TAB || !navigator.locks) { renderBadge(); return; }
    navigator.locks.request(ROOT_LOCK, async () => {
      CreelSelf.role = 'root';
      renderBadge();
      CreelSelf.seedWorldModel?.();
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


  /* ── The seam between this file and its siblings (creel-hun) ──────
   *
   * creel-self.js was one 805-line closure. It is now three files, and they
   * are still three closures — the alternative was dropping ~40 names into
   * the global scope, which is what the harness parts do and is defensible
   * there (they were already one flat script) but would be a downgrade here.
   *
   * So the parts share ONE object, and this is it. Everything on it is
   * internal to creel-self and unstable; the public surfaces stay
   * window.CreelSelf and window.CreelUi.
   *
   * `impl` and `tools` are created empty and FILLED by creel-ui-tools.js.
   * Both are mutated in place, never reassigned — the bus below and
   * CreelUi.handle close over these exact objects, so a reassignment in a
   * sibling would leave them routing into an orphan.
   */
  const SELF = {
    impl: {},        // tool name → implementation (filled by creel-ui-tools.js)
    tools: [],       // MCP tool schemas      (filled by creel-ui-tools.js)
  };
  window.CreelSelfInternal = SELF;

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
      if (!matchesMe(m.target) || !SELF.impl[m.name]) return;   // not for us
      try {
        // _remote marks a call that arrived from another tab: ui_prompt uses
        // it to refuse prompting its own tab (a loop) while still allowing a
        // peer to prompt it.
        const result = await SELF.impl[m.name]({ ...(m.args || {}), _remote: true });
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
          case 'tools/list': return reply({ tools: SELF.tools });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!SELF.impl[name]) return fail(`unknown tool: ${name}`);
            // `tab` is routing, not an argument: strip it, and if it names
            // someone else, run the call in THAT tab instead of this one.
            const { tab: target, ...rest } = args || {};
            const remote = target && !matchesMe(target) && name !== 'ui_tabs';
            const result = remote ? await remoteCall(target, name, rest) : await SELF.impl[name](rest);
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

  // Hand the siblings what they need. Assigned at the end, so everything
  // below is already defined when creel-ui-tools.js runs.
  Object.assign(SELF, {
    TAB_ID, AGENT_ID, IS_AGENT_TAB, CreelSelf, CreelUi,
    flash, identity, matchesMe, remoteCall, roster, electRoot,
  });
})();
