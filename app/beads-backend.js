/* creel — beads backend (creel-9wn): bd-style issue tracking, in the page.
 *
 * An in-page MCP server ('inpage:bd') giving the agent and the operator the
 * beads workflow without the bd CLI or Dolt: bd_ready / bd_list / bd_show /
 * bd_create / bd_update / bd_close over the shared BeadsStore (app/beads-store.js).
 *
 * Storage: when a repo checkout with .beads/ exists in the harness VFS, the
 * store reads and writes .beads/issues.jsonl + .beads/interactions.jsonl
 * there (so the work travels with the repo, and github_push carries it);
 * otherwise it falls back to a localStorage mirror of the same files. The
 * wire format is beads' passive export, byte-compatible for `bd dolt push`.
 */
(function () {
  'use strict';

  const LS_KEY = 'creel_beads_store';

  // Harness VFS first; localStorage mirror as fallback. vfsRead/vfsWrite are
  // globals in onepagent.html (see the VIRTUAL FILESYSTEM section).
  function browserAdapter() {
    const useVfs = typeof vfsRead === 'function' && typeof vfsWrite === 'function';
    const readMirror = () => {
      try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
    };
    return {
      async readText(p) {
        if (useVfs) {
          const r = vfsRead(p);
          if (r && !r.error) return r.content;
        }
        const mirror = readMirror();
        return mirror[p] || '';
      },
      async writeText(p, t) {
        if (useVfs) {
          const r = vfsWrite(p, t);
          if (r && !r.error) return;
        }
        const mirror = readMirror();
        mirror[p] = t;
        localStorage.setItem(LS_KEY, JSON.stringify(mirror));
      },
    };
  }

  const TOOLS = [
    {
      name: 'bd_ready',
      description: 'List open issues by priority (bd ready): highest priority first, then oldest. Use this to find available work.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'max rows (default all)' } } },
    },
    {
      name: 'bd_list',
      description: 'List issues with optional filters (status: open|in_progress|closed, issue_type: bug|feature|task, priority 1..3).',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'in_progress', 'closed'] },
          type: { type: 'string', enum: ['bug', 'feature', 'task'], description: 'issue_type filter' },
          priority: { type: 'integer' },
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'bd_show',
      description: 'Show one issue in full (id, title, description, acceptance_criteria, status, priority, type, timestamps).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'bd_create',
      description: 'Create an issue. Returns the full new record with a fresh <prefix>-xxx id.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance_criteria: { type: 'string' },
          priority: { type: 'integer', description: '1 highest .. 3 lowest (default 2)' },
          issue_type: { type: 'string', enum: ['bug', 'feature', 'task'] },
          actor: { type: 'string', description: 'audit actor (default Claude)' },
        },
        required: ['title'],
      },
    },
    {
      name: 'bd_update',
      description: 'Update an issue. Patch any of status/priority/title/description/acceptance_criteria/issue_type/owner; claim with status=in_progress, close with status=closed + reason. Records a field_change interaction per changed field.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'in_progress', 'closed'] },
          priority: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance_criteria: { type: 'string' },
          issue_type: { type: 'string', enum: ['bug', 'feature', 'task'] },
          owner: { type: 'string' },
          reason: { type: 'string', description: 'close reason / change note' },
          actor: { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'bd_close',
      description: 'Close an issue: status=closed with a close_reason. Shortcut for bd_update.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'close reason' },
          actor: { type: 'string' },
        },
        required: ['id'],
      },
    },
  ];

  let storePromise = null;
  function getStore() {
    if (!storePromise) {
      storePromise = new BeadsStore({ adapter: browserAdapter(), prefix: 'creel' }).load();
    }
    return storePromise;
  }

  const impl = {
    async bd_ready(args) { return (await getStore()).ready({ limit: args.limit }); },
    async bd_list(args) {
      return (await getStore()).list({ status: args.status, type: args.type, priority: args.priority, limit: args.limit });
    },
    async bd_show(args) {
      const rec = (await getStore()).get(args.id);
      if (!rec) throw new Error(`no such issue: ${args.id}`);
      return rec;
    },
    async bd_create(args) { return (await getStore()).create(args); },
    async bd_update(args) {
      const { id, reason, actor, ...patch } = args;
      return (await getStore()).update(id, patch, { actor, reason });
    },
    async bd_close(args) { return (await getStore()).close(args.id, { actor: args.actor, reason: args.reason }); },
  };

  const CreelBeads = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({
              protocolVersion: body.params?.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'bd', version: '0' },
            });
          case 'notifications/initialized':
            return null;
          case 'tools/list':
            return reply({ tools: TOOLS });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!impl[name]) return fail(`unknown tool: ${name}`);
            const result = await impl[name](args || {});
            return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
          }
          default:
            return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },

    registerDefaults() {
      if (typeof BeadsStore === 'undefined') {
        console.warn('beads-backend: BeadsStore missing — is beads-store.js loaded?');
        return;
      }
      window.CreelInpage.register('inpage:bd', this);
      if (typeof mcpServers === 'undefined') return;
      if (!mcpServers.find((s) => s.id === 'mcp_bd_inpage')) {
        mcpServers.push({
          id: 'mcp_bd_inpage', name: 'bd', type: 'inpage',
          url: 'inpage:bd', token: '', corsProxy: '', enabled: true,
        });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = mcpServers.find((s) => s.id === 'mcp_bd_inpage');
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) => console.warn('bd in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };

  window.CreelBeads = CreelBeads;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelBeads.registerDefaults());
  } else {
    CreelBeads.registerDefaults();
  }
})();
