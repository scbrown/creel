/* creel — yupana structural-analysis backend for the OnePagent harness.
 *
 * The structural half of in-page grounding, next to quipu-backend.js's
 * knowledge half: yupana's analysis core (tree-sitter, six grammars)
 * compiled to wasm, serving symbols / references / callers / callees /
 * analyze over the same `inpage` MCP transport.
 *
 * Tool schemas come from the provider crate's tool_definitions() (Rust,
 * adjacent to its dispatch — wasm/yupana-provider/src/lib.rs), so JS never
 * hand-copies a schema list. Response shapes mirror yupana's native MCP
 * tools field-for-field; every fact carries yupana's FR-3 `tier` tag.
 *
 * Deliberately simpler than the quipu backend: no worker, no OPFS, no
 * fleet locks. The project is IN-MEMORY and PER-TAB — an agent tab feeds
 * the files it is working on via yupana_load_file and queries its own
 * working set. Facts are recomputable from source at parse speed, so
 * nothing here needs to survive the tab or be shared across the fleet
 * (unlike the quipu store, where the bytes ARE the value).
 */
(function () {
  'use strict';

  const STATUS_TOOL = {
    name: 'yupana_wasm_status',
    description:
      'Reports whether the in-page yupana-wasm engine is loaded. When unbound, '
      + 'structural code analysis (symbols/references/callers) is unavailable '
      + 'in-page.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  };

  const CreelYupana = {
    provider: null,
    serverId: 'mcp_yupana_inpage',
    lastBootError: null,

    /** Bind the yupana-wasm provider and refresh the agent's tool registry. */
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
                || { name: 'yupana-inpage', version: '0' },
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
            // Self-heal: a transient boot failure shouldn't strand the
            // session — retry the bind on use.
            if (!this.provider) {
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
                    bootError: this.lastBootError || undefined,
                    hint: this.provider
                      ? 'yupana tools are live in-page; load files with '
                        + 'yupana_load_file, then query them'
                      : 'yupana-wasm not loaded (see bootError)',
                  }),
                }],
              });
            }
            if (!this.provider) {
              return fail(`yupana-wasm provider not bound (${this.lastBootError || 'boot not attempted'}); cannot call ${name}`);
            }
            const result = await this.provider.callTool(name, args || {});
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

    /** Register the in-page server in the harness. */
    registerDefaults() {
      window.CreelInpage.register('inpage:yupana-wasm', this);
      if (typeof mcpServers === 'undefined') return;
      if (!mcpServers.find((s) => s.id === this.serverId)) {
        mcpServers.push({
          id: this.serverId,
          name: 'yupana',
          type: 'inpage',
          url: 'inpage:yupana-wasm',
          token: '',
          corsProxy: '',
          enabled: true,
        });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = mcpServers.find((s) => s.id === this.serverId);
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) =>
          console.warn('yupana in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };

  /* Boot the yupana-wasm binding. Idempotent (concurrent calls share one
   * boot); failures record lastBootError for yupana_wasm_status and can be
   * retried (`force`). */
  let bootPromise = null;
  CreelYupana.ensureWasm = function ensureWasm(force = false) {
    if (this.provider) return Promise.resolve(true);
    if (bootPromise && !force) return bootPromise;
    bootPromise = (async () => {
      const probe = await fetch('wasm/yupana-pkg/creel_yupana_provider.js', { method: 'HEAD' });
      if (!probe.ok) throw new Error(`yupana wasm bundle missing (HTTP ${probe.status})`);

      const wasm = await import('./wasm/yupana-pkg/creel_yupana_provider.js');
      await wasm.default();
      const languages = JSON.parse(wasm.languages());

      await CreelYupana.bindProvider({
        serverInfo: { name: `yupana-wasm (${languages.length} languages)`, version: '0' },
        listTools: async () => JSON.parse(wasm.tool_definitions()),
        callTool: async (name, args) =>
          JSON.parse(wasm.call_tool(name, JSON.stringify(args || {}))),
      });
      CreelYupana.lastBootError = null;
      console.log(`creel: yupana-wasm bound (${languages.join(', ')})`);
      return true;
    })();
    bootPromise.catch((e) => {
      CreelYupana.lastBootError = e && e.message ? e.message : String(e);
      console.warn('creel: yupana-wasm init failed, staying unbound', e);
    });
    return bootPromise;
  };

  window.CreelYupana = CreelYupana;

  function start() {
    CreelYupana.registerDefaults();
    CreelYupana.ensureWasm().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
