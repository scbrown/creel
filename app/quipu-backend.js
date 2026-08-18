/* creel — quipu knowledge backend for the OnePagent harness.
 *
 * The quipu tool surface reaches the agent through MCP framing over one of
 * two transports, selectable per server entry ("the transport switch"):
 *
 *   1. streamable_http  → bobbin's MCP server (`bobbin serve --mcp-http`,
 *      default http://localhost:3031/mcp). Works today; bobbin embeds quipu
 *      and serves knowledge_context / knowledge_query etc.
 *   2. inpage           → quipu compiled to wasm, living in this page.
 *      Tool schemas come from quipu's own tool_definitions() via the bound
 *      provider, so the surface is identical to what any other transport
 *      serves — never a hand-copied schema list that can drift.
 *
 * The in-page transport is live as soon as something calls
 * CreelQuipu.bindProvider(provider). Until then it exposes a single
 * `quipu_wasm_status` tool so agents (and humans) can see the seam exists
 * and what state it is in.
 *
 * Provider contract (what the quipu-wasm glue must implement):
 *   {
 *     serverInfo?: { name, version },
 *     listTools(): Promise<Array<{name, description, inputSchema}>>,
 *       // expected to surface quipu's tool_definitions() verbatim
 *     callTool(name, args): Promise<any>,
 *       // dispatch to the wasm module's tool dispatch; return JSON result
 *   }
 */
(function () {
  'use strict';

  /* Shell build tag, surfaced by quipu_wasm_status so a live session can
   * prove which deploy it is actually running (stale-SW debugging). Bump
   * alongside sw.js CACHE_VERSION. */
  window.CREEL_BUILD = 'creel-v17 (2026-08-13, measurement harness)';

  /* Registry for in-page MCP servers ("the inpage transport"). Each handler
   * implements handle(jsonRpcBody) -> response|null. onepagent.html routes
   * `type: 'inpage'` servers here by their `url` (e.g. 'inpage:github'). */
  window.CreelInpage = {
    handlers: {},
    register(url, handler) { this.handlers[url] = handler; },
    dispatch(server, body) {
      const h = this.handlers[server.url] || window.CreelQuipu;
      return h.handle(body);
    },
  };

  const STATUS_TOOL = {
    name: 'quipu_wasm_status',
    description:
      'Reports whether an in-page quipu-wasm provider is bound. When unbound, ' +
      'quipu knowledge tools are only available via the bobbin MCP server ' +
      '(streamable_http transport).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  };

  const CreelQuipu = {
    provider: null,
    serverId: 'mcp_quipu_inpage',

    /** Bind the quipu-wasm provider and refresh the agent's tool registry. */
    async bindProvider(provider) {
      this.provider = provider;
      const server = (typeof mcpServers !== 'undefined')
        && mcpServers.find((s) => s.id === this.serverId);
      if (server && typeof mcpReconnectServer === 'function') {
        await mcpReconnectServer(server.id);
      }
    },

    /** JSON-RPC handler the harness routes `type: 'inpage'` servers to. */
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({
        jsonrpc: '2.0', id: body.id, error: { code: -32000, message },
      });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({
              protocolVersion: body.params?.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: this.provider?.serverInfo
                || { name: 'quipu-inpage', version: '0' },
            });
          case 'notifications/initialized':
            return null;
          case 'tools/list': {
            const tools = this.provider
              ? await this.provider.listTools()
              : [STATUS_TOOL];
            return reply({ tools });
          }
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            // Self-heal: a transient boot failure (mid-deploy fetch, slow
            // network) shouldn't strand the session — retry the bind on use.
            if (!this.provider && typeof this.ensureWasm === 'function') {
              await this.ensureWasm(true).catch(() => {});
            }
            if (name === STATUS_TOOL.name) {
              return reply({
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    bound: !!this.provider,
                    build: window.CREEL_BUILD || 'unknown',
                    server: this.provider?.serverInfo?.name,
                    storage: this.storageInfo || undefined,
                    group: tabGroupId() || undefined,
                    groupHint: 'episodes this tab ingests are stamped with this group_id unless '
                      + 'you pass your own; reads are fleet-wide by default',
                    bootError: this.lastBootError || undefined,
                    hint: this.provider
                      ? 'quipu tools are live in-page; call them directly'
                      : 'quipu-wasm not loaded (see bootError); the bobbin MCP '
                        + 'server (streamable_http) is the network alternative',
                  }),
                }],
              });
            }
            if (!this.provider) {
              return fail(`quipu-wasm provider not bound (${this.lastBootError || 'boot not attempted'}); cannot call ${name}`);
            }
            const result = await this.provider.callTool(name, scopeArgs(name, args || {}));
            // A fact written to the graph is unpushed state exactly like a
            // conversation is: the store lives in OPFS, which is evictable and
            // travels nowhere until state_push carries the .db. Without this
            // the leave guard would wave through a tab whose only work this
            // session was everything an agent learned.
            if (WRITE_TOOLS.has(name) && typeof markStateDirty === 'function') markStateDirty();
            return reply({
              content: [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result),
              }],
            });
          }
          default:
            return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },

    /** Register the in-page server + a bobbin template in the harness. */
    registerDefaults() {
      window.CreelInpage.register('inpage:quipu-wasm', this);
      if (typeof mcpServers === 'undefined') return;
      if (!mcpServers.find((s) => s.id === this.serverId)) {
        mcpServers.push({
          id: this.serverId,
          name: 'quipu',
          type: 'inpage',
          url: 'inpage:quipu-wasm',
          token: '',
          corsProxy: '',
          enabled: true,
        });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = mcpServers.find((s) => s.id === this.serverId);
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) =>
          console.warn('quipu in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };

  window.CreelQuipu = CreelQuipu;

  /* ── The fleet's shared brain: one OPFS store, leader-elected ─────
   *
   * OPFS sync access handles only exist in DEDICATED workers (a
   * SharedWorker cannot host the store without losing persistence), so
   * sharing works the creel way instead: Web Locks elect a leader tab,
   * whose dedicated worker owns the single OPFS store; every other tab
   * RPCs to it over BroadcastChannel 'creel-quipu-rpc'. When the leader
   * tab dies its lock releases, the next queued tab boots the store from
   * the same OPFS bytes and takes over serving. No locks API → plain
   * per-tab store, as before. */
  /* ── Per-tab attribution in a shared graph (creel-age) ───────────
   *
   * Every tab writes into ONE store — that is the point of the shared brain,
   * and forking a database per tab would trade the thing that makes cheap
   * agents viable (everyone sees what anyone learned) for isolation nobody
   * asked for. What was missing is not separation but ATTRIBUTION: with one
   * store and no marking, a fact recorded by a bobbin three tabs over is
   * indistinguishable from one the operator wrote, so nothing can be scoped,
   * reviewed, or undone per agent.
   *
   * quipu already has the handle: episodes carry a group_id. So a tab stamps
   * its own group on any episode that does not name one, and every fact it
   * ingests is thereafter queryable as its subgraph — or ignored, and the
   * whole graph read fleet-wide, which is still the default for reads.
   *
   * An explicit group_id from the caller always wins: an agent deliberately
   * writing into a shared or another agent's group is doing something
   * meaningful, and silently overriding it would be the bug.
   */
  const GROUPED_TOOLS = new Set(['quipu_episode', 'quipu_episodes_complete']);

  /** Graph tools that change the store, so the tab has something to push. */
  const WRITE_TOOLS = new Set([
    'quipu_episode', 'quipu_episodes_complete', 'quipu_knot', 'quipu_set',
    'quipu_transact', 'quipu_retract', 'quipu_retract_episode', 'quipu_datasets',
    'quipu_overlay_create', 'quipu_overlay_write', 'quipu_propose_schema_change',
    'quipu_accept_proposal', 'quipu_reject_proposal',
  ]);

  /** This tab's stable graph group. Prefers the fleet agent id (a spawned
   *  bobbin keeps its identity across a reload) and falls back to the tab id
   *  that creel-self.js keeps in sessionStorage. */
  function tabGroupId() {
    const self = window.CreelSelf;
    const id = (self && (self.agentId || self.tabId))
      || (() => { try { return sessionStorage.getItem('creel_tab_id'); } catch { return null; } })();
    return id ? `agent:${id}` : null;
  }

  function scopeArgs(name, args) {
    if (!GROUPED_TOOLS.has(name)) return args;
    if (args.group_id) return args;
    const group = tabGroupId();
    return group ? { ...args, group_id: group } : args;
  }

  CreelQuipu.tabGroupId = tabGroupId;

  const STORE_LOCK = 'creel-quipu-store';
  const RPC_BC = new BroadcastChannel('creel-quipu-rpc');
  const TAB_ID = Math.random().toString(36).slice(2, 10);
  let workerRpc = null;   // direct rpc when this tab hosts the worker

  function bootDedicatedWorker() {
    const w = new Worker('quipu-worker.js', { type: 'module' });
    let nextId = 1;
    const pending = new Map();
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
    };
    w.onerror = (e) => console.warn('quipu worker error', e.message || e);
    return (op, args) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, op, args });
    });
  }

  function serveFleet() {
    RPC_BC.addEventListener('message', async (e) => {
      const m = e.data;
      if (m?.type !== 'req' || !workerRpc) return;
      try {
        const result = await workerRpc(m.op, m.args);
        RPC_BC.postMessage({ type: 'res', reqId: m.reqId, ok: true, result });
      } catch (err) {
        RPC_BC.postMessage({ type: 'res', reqId: m.reqId, ok: false, error: err.message || String(err) });
      }
    });
  }

  const clientPending = new Map();
  RPC_BC.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type !== 'res') return;
    const p = clientPending.get(m.reqId);
    if (!p) return;
    clientPending.delete(m.reqId);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  });
  let clientSeq = 0;
  function fleetRpc(op, args) {
    return new Promise((resolve, reject) => {
      const reqId = `${TAB_ID}-${clientSeq++}`;
      clientPending.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (clientPending.has(reqId)) {
          clientPending.delete(reqId);
          reject(new Error('fleet store RPC timeout — leader tab may have just died; retry'));
        }
      }, 20000);
      RPC_BC.postMessage({ type: 'req', reqId, op, args });
    });
  }

  /** Try to become the store owner right now. Resolves true and holds the
   *  lock forever if we got it; false if another tab has it. */
  function tryAcquireStore() {
    if (!navigator.locks) return Promise.resolve('nolocks');
    return new Promise((resolve) => {
      navigator.locks.request(STORE_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        return new Promise(() => {});   // hold while this tab lives
      }).catch(() => resolve('nolocks'));
    });
  }

  /** Queue for takeover: fires if/when the current leader tab dies. */
  function queueTakeover() {
    if (!navigator.locks) return;
    navigator.locks.request(STORE_LOCK, async () => {
      console.log('creel: quipu store leader died — this tab is taking over');
      workerRpc = bootDedicatedWorker();
      await workerRpc('init');
      serveFleet();
      return new Promise(() => {});     // hold while this tab lives
    }).catch(() => {});
  }

  /* Boot the quipu-wasm store binding. Idempotent (concurrent calls share
   * one boot); failures record lastBootError for quipu_wasm_status and can
   * be retried (`force`). */
  let bootPromise = null;
  CreelQuipu.ensureWasm = function ensureWasm(force = false) {
    if (this.provider) return Promise.resolve(true);
    if (bootPromise && !force) return bootPromise;
    bootPromise = (async () => {
      const probe = await fetch('wasm/pkg/creel_quipu_provider.js', { method: 'HEAD' });
      if (!probe.ok) throw new Error(`wasm bundle missing (HTTP ${probe.status})`);

      const acquired = await tryAcquireStore();
      let rpc; let scope;
      if (acquired === true) {
        workerRpc = bootDedicatedWorker();
        serveFleet();
        rpc = (op, args) => workerRpc(op, args);
        scope = 'fleet-host';
      } else if (acquired === false) {
        // Dynamic: if this tab later wins the takeover lock, workerRpc
        // appears and calls transparently switch from the bus to the
        // locally-hosted store.
        rpc = (op, args) => (workerRpc ? workerRpc(op, args) : fleetRpc(op, args));
        scope = 'fleet-client';
        queueTakeover();
      } else {
        workerRpc = bootDedicatedWorker();
        rpc = (op, args) => workerRpc(op, args);
        scope = 'tab';
      }

      const { persistence } = await rpc('init');
      const EXPORT_TOOL = {
        name: 'quipu_export_db',
        description: 'Serialize the in-page quipu store to a .db file in the VFS '
          + '(FILES panel) so the user can download it — the same bytes open in '
          + 'the quipu CLI and quipu-server, whose Knowledge Graph Explorer '
          + 'visualizes the graph. Optional: path (default /quipu-export/creel.db).',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'VFS path for the .db file' } },
          required: [],
        },
      };
      await CreelQuipu.bindProvider({
        serverInfo: { name: `quipu-wasm (${persistence}, ${scope})`, version: '0' },
        listTools: async () => [...await rpc('tools'), EXPORT_TOOL],
        callTool: async (name, args) => {
          if (name === EXPORT_TOOL.name) {
            const bytes = await rpc('export');
            const path = normPath((args && args.path) || '/quipu-export/creel.db');
            const res = await vfsWriteBinary(path, new Uint8Array(bytes));
            return { ok: true, path, bytes: res.bytes, hint: 'download it from the FILES panel; open with quipu-server for the graph explorer' };
          }
          return rpc('call', { name, args });
        },
      });
      CreelQuipu.exportDb = () => rpc('export');
      CreelQuipu.importDb = (bytes) => rpc('import', { bytes });
      CreelQuipu.entityHistory = (iri) => rpc('entity_history', { iri });
      CreelQuipu.lastBootError = null;
      // OPFS is evictable under storage pressure — ask the browser to make
      // this origin durable (once), and keep quota facts for the status tool.
      try {
        let persisted = await navigator.storage?.persisted?.();
        if (!persisted && !localStorage.getItem('creel_persist_asked')) {
          localStorage.setItem('creel_persist_asked', '1');
          persisted = await navigator.storage.persist();
        }
        const est = await navigator.storage?.estimate?.();
        CreelQuipu.storageInfo = {
          persisted: !!persisted,
          usageMB: est ? Math.round(est.usage / 1e6) : undefined,
          quotaMB: est ? Math.round(est.quota / 1e6) : undefined,
        };
        if (!persisted) {
          CreelQuipu.storageInfo.hint = 'storage is evictable — quipu_export_db or github_push anything worth keeping';
        }
      } catch { /* storage API unavailable */ }
      console.log(`creel: quipu-wasm bound (${persistence}, ${scope})`);
      return true;
    })();
    bootPromise.catch((e) => {
      CreelQuipu.lastBootError = e && e.message ? e.message : String(e);
      console.warn('creel: quipu-wasm init failed, staying unbound', e);
    });
    return bootPromise;
  };

  function start() {
    CreelQuipu.registerDefaults();
    CreelQuipu.ensureWasm().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
