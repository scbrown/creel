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
            if (!this.provider) {
              if (name === STATUS_TOOL.name) {
                return reply({
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      bound: false,
                      hint: 'quipu-wasm not loaded; use the bobbin MCP server '
                        + '(streamable_http) for knowledge tools',
                    }),
                  }],
                });
              }
              return fail(`quipu-wasm provider not bound; cannot call ${name}`);
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

    /** Register the in-page server + a bobbin template in the harness. */
    registerDefaults() {
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

  /* Boot the quipu-wasm worker and bind it as the in-page provider. If the
   * wasm bundle isn't deployed (404) or the browser can't run it, we stay
   * unbound and quipu_wasm_status keeps reporting so — never a hard failure. */
  async function bootWasmProvider() {
    let worker;
    try {
      const probe = await fetch('wasm/pkg/creel_quipu_provider.js', { method: 'HEAD' });
      if (!probe.ok) return;
      worker = new Worker('quipu-worker.js', { type: 'module' });
    } catch (e) { return; }

    let nextId = 1;
    const pending = new Map();
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => console.warn('quipu-worker error', e.message || e);
    const rpc = (op, args) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    });

    try {
      const { persistence } = await rpc('init');
      await CreelQuipu.bindProvider({
        serverInfo: { name: `quipu-wasm (${persistence})`, version: '0' },
        listTools: () => rpc('tools'),
        callTool: (name, args) => rpc('call', { name, args }),
      });
      CreelQuipu.exportDb = () => rpc('export');
      CreelQuipu.importDb = (bytes) => rpc('import', { bytes });
      console.log(`creel: quipu-wasm bound (${persistence})`);
    } catch (e) {
      console.warn('creel: quipu-wasm init failed, staying unbound', e);
    }
  }

  function start() {
    CreelQuipu.registerDefaults();
    bootWasmProvider();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
