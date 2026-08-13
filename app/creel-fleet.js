/* creel — fleet mode: agents as browser tabs (VISION.md v1, first cut).
 *
 * Tabs are the bobbins. The platform does the scheduler's hard parts:
 *   work queue      → IndexedDB ('creel_fleet'), shared by every same-origin tab
 *   spawning        → window.open('onepagent.html#creel-agent=<id>')
 *   liveness        → Web Locks: each agent tab holds 'creel-agent-<id>' for
 *                     its lifetime; the lock vanishing = the tab died
 *   fleet bus       → BroadcastChannel 'creel-fleet'
 *   config          → localStorage is same-origin, so spawned tabs inherit
 *                     the operator's API key, model, and MCP servers free
 *
 * Completion is agent-driven: the spawn wraps the task with an instruction
 * to call fleet_report when done — no surgery on the harness's loop.
 *
 * Popup blockers: window.open outside a user gesture may be blocked. Spawn
 * tools report it, tasks stay 'queued', and the 🧺 fleet dashboard has a
 * Launch button (a real click) that opens them; or allow popups for this
 * origin once and agent-initiated spawns just work.
 *
 * Note: only the first tab gets the OPFS quipu store (the VFS pool is
 * single-owner); agent tabs fall back to in-memory quipu automatically.
 */
(function () {
  'use strict';

  const BC = new BroadcastChannel('creel-fleet');
  const DB_NAME = 'creel_fleet';
  const LOCK_PREFIX = 'creel-agent-';

  const agentMatch = location.hash.match(/creel-agent=([a-z0-9]+)/);
  const MY_TASK_ID = agentMatch ? agentMatch[1] : null;

  // ── IndexedDB task store ─────────────────────────────────────────
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('tasks', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction('tasks', mode);
      const out = fn(t.objectStore('tasks'));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }
  const putTask = (task) => tx('readwrite', (s) => { s.put(task); return task; });
  const getTask = (id) => tx('readonly', (s) => s.get(id)).then((r) => r);
  const allTasks = () => tx('readonly', (s) => s.getAll()).then((r) => r || []);
  const delTask = (id) => tx('readwrite', (s) => s.delete(id));

  const genId = () => Math.random().toString(36).slice(2, 10);
  const notify = () => { try { BC.postMessage({ type: 'update' }); } catch { /* closed */ } };

  async function aliveLocks() {
    if (!navigator.locks || !navigator.locks.query) return new Set();
    const { held = [] } = await navigator.locks.query();
    return new Set(held.filter((l) => l.name.startsWith(LOCK_PREFIX))
      .map((l) => l.name.slice(LOCK_PREFIX.length)));
  }

  async function statusReport() {
    const tasks = await allTasks();
    const alive = await aliveLocks();
    return tasks
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((t) => ({
        ...t,
        alive: alive.has(t.id),
        status: (t.status === 'running' && !alive.has(t.id)) ? 'dead' : t.status,
      }));
  }

  function spawnWindow(id) {
    const w = window.open(`onepagent.html#creel-agent=${id}`, '_blank');
    return !!w;
  }

  function wrapTask(t) {
    return `${t.task}\n\n---\nYou are a spawned creel fleet agent (task id: ${t.id}`
      + `${t.label ? `, label: ${t.label}` : ''}). Work autonomously. When the task is`
      + ' complete, call the fleet_report tool with a concise result summary in the'
      + ' `result` argument. If you cannot complete it, call fleet_report with a'
      + ' result starting "FAILED:" explaining why.'
      + '\nFleet comms: fleet_send({to, message}) delivers a message INTO another'
      + ' agent\'s conversation (to = task id or label, or "dashboard" for the'
      + ' operator tab); fleet_send({message}) without `to` broadcasts to every'
      + ' inbox instead. Check fleet_inbox for broadcasts and anything received'
      + ' while you were busy. fleet_status lists the other agents.';
  }

  // ── cross-tab comms ──────────────────────────────────────────────
  const inbox = [];
  const commsLog = [];
  const myLabelPromise = MY_TASK_ID ? getTask(MY_TASK_ID).then((t) => t?.label || MY_TASK_ID) : null;

  function logComms(m) {
    commsLog.push(m);
    if (commsLog.length > 50) commsLog.shift();
    if (overlay) renderDashboard();
  }

  /** Deliver a directed message into this tab's conversation as guidance —
   *  the harness treats a send during a run as a non-interrupting guide, so
   *  the LLM actually sees it without polling. Preserves any half-typed
   *  operator input. */
  function injectMessage(m) {
    const input = document.getElementById('userInput');
    if (!input || typeof handleSend !== 'function') { inbox.push(m); return; }
    const stash = input.value;
    input.value = `[fleet message from ${m.fromLabel || m.from}] ${m.text}`;
    if (typeof handleInputChange === 'function') handleInputChange(input);
    handleSend();
    input.value = stash;
    if (typeof handleInputChange === 'function') handleInputChange(input);
  }

  async function onFleetMsg(m) {
    logComms(m);
    const myLabel = myLabelPromise ? await myLabelPromise : null;
    const me = MY_TASK_ID ? [MY_TASK_ID, myLabel] : ['dashboard'];
    if (!m.to) { inbox.push(m); return; }              // broadcast → inbox only
    if (!me.includes(m.to)) return;                    // not addressed to us
    if (m.to === 'dashboard') { inbox.push(m); return; } // never hijack the operator's chat
    inbox.push(m);
    injectMessage(m);
  }

  // ── in-page MCP server: 'fleet' ──────────────────────────────────
  const TOOLS = [
    {
      name: 'fleet_spawn',
      description: 'Spawn one or more autonomous agents, each in its own browser tab, working the given task. Tabs inherit the operator\'s model/key. If the popup blocker intervenes, tasks stay queued — the user launches them from the 🧺 fleet dashboard (or allows popups for this site).',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'the task for the spawned agent(s)' },
          label: { type: 'string', description: 'short label shown in the dashboard and tab title' },
          count: { type: 'integer', description: 'number of agent tabs (default 1)' },
        },
        required: ['task'],
      },
    },
    {
      name: 'fleet_status',
      description: 'List fleet tasks/agents: queued, running (with tab-alive liveness from Web Locks), done (with results), failed, or dead (tab closed without reporting).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'fleet_report',
      description: 'FOR SPAWNED AGENTS: report your task result back to the fleet. Call exactly once when your task is complete (prefix "FAILED:" if it could not be completed).',
      inputSchema: {
        type: 'object',
        properties: { result: { type: 'string', description: 'concise result summary' } },
        required: ['result'],
      },
    },
    {
      name: 'fleet_send',
      description: 'Send a message across the fleet. With `to` (a task id, label, or "dashboard"), the message is delivered INTO that agent tab\'s conversation so its LLM sees it immediately. Without `to`, it broadcasts to every tab\'s inbox (read with fleet_inbox) — use broadcasts for status, directed sends for coordination.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'target task id, label, or "dashboard" (omit to broadcast)' },
          message: { type: 'string' },
        },
        required: ['message'],
      },
    },
    {
      name: 'fleet_inbox',
      description: 'Read this tab\'s fleet messages (broadcasts, and directed messages received). Pass clear:true to drain after reading.',
      inputSchema: {
        type: 'object',
        properties: { clear: { type: 'boolean' } },
        required: [],
      },
    },
    {
      name: 'fleet_abort',
      description: 'Abort a spawned agent: its tab is asked to close and the task is marked failed.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'task id from fleet_status' } },
        required: ['id'],
      },
    },
    {
      name: 'fleet_clear',
      description: 'Remove finished (done/failed/dead) tasks from the fleet list.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ];

  const impl = {
    async fleet_spawn(args) {
      const count = Math.max(1, Math.min(8, args.count || 1));
      const spawned = [];
      const queued = [];
      for (let i = 0; i < count; i++) {
        const id = genId();
        const label = (args.label || 'agent') + (count > 1 ? `-${i + 1}` : '');
        const t = {
          id, label, task: args.task, status: 'queued',
          createdAt: Date.now(), result: null,
        };
        await putTask(t);
        if (spawnWindow(id)) { t.status = 'spawned'; await putTask(t); spawned.push({ id, label }); }
        else queued.push({ id, label });
      }
      notify();
      return {
        spawned, queued,
        hint: queued.length
          ? 'popup blocked — the user can launch queued agents from the 🧺 fleet dashboard, or allow popups for this site'
          : undefined,
      };
    },

    async fleet_status() {
      const report = await statusReport();
      return report.map(({ id, label, status, alive, result, createdAt, doneAt }) => ({
        id, label, status, alive, result, createdAt, doneAt,
      }));
    },

    async fleet_report(args) {
      if (!MY_TASK_ID) throw new Error('fleet_report is only for spawned agent tabs');
      const t = await getTask(MY_TASK_ID);
      if (!t) throw new Error(`unknown task ${MY_TASK_ID}`);
      t.status = String(args.result || '').startsWith('FAILED:') ? 'failed' : 'done';
      t.result = args.result;
      t.doneAt = Date.now();
      await putTask(t);
      notify();
      return { ok: true, reported: t.status };
    },

    async fleet_send(args) {
      const myLabel = myLabelPromise ? await myLabelPromise : null;
      const m = {
        type: 'msg',
        from: MY_TASK_ID || 'dashboard',
        fromLabel: MY_TASK_ID ? (myLabel || MY_TASK_ID) : 'dashboard',
        to: args.to || null,
        text: args.message,
        ts: Date.now(),
      };
      if (args.to && args.to !== 'dashboard') {
        // Resolve label → confirm the target exists (id or label).
        const tasks = await allTasks();
        const target = tasks.find((t) => t.id === args.to || t.label === args.to);
        if (!target) throw new Error(`no fleet agent matches ${JSON.stringify(args.to)} — see fleet_status`);
        m.to = target.id === args.to ? target.id : target.label;
      }
      logComms(m);
      BC.postMessage(m);
      return { sent: true, to: m.to || 'broadcast' };
    },

    async fleet_inbox(args) {
      const msgs = inbox.map(({ from, fromLabel, to, text, ts }) => ({ from: fromLabel || from, to: to || 'broadcast', text, ts }));
      if (args && args.clear) inbox.length = 0;
      return { count: msgs.length, messages: msgs };
    },

    async fleet_abort(args) {
      const t = await getTask(args.id);
      if (!t) throw new Error(`unknown task ${args.id}`);
      BC.postMessage({ type: 'abort', id: args.id });
      if (t.status !== 'done') {
        t.status = 'failed';
        t.result = t.result || 'aborted';
        await putTask(t);
      }
      notify();
      return { ok: true };
    },

    async fleet_clear() {
      const tasks = await allTasks();
      const gone = [];
      const alive = await aliveLocks();
      for (const t of tasks) {
        const effective = (t.status === 'running' && !alive.has(t.id)) ? 'dead' : t.status;
        if (['done', 'failed', 'dead'].includes(effective)) { await delTask(t.id); gone.push(t.id); }
      }
      notify();
      return { removed: gone };
    },
  };

  const CreelFleet = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({
              protocolVersion: body.params?.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fleet', version: '0' },
            });
          case 'notifications/initialized':
            return null;
          case 'tools/list':
            return reply({ tools: TOOLS });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!impl[name]) return fail(`unknown tool: ${name}`);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await impl[name](args || {})) }] });
          }
          default:
            return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },

    registerDefaults() {
      window.CreelInpage.register('inpage:fleet', this);
      if (typeof mcpServers !== 'undefined' && !mcpServers.find((s) => s.id === 'mcp_fleet_inpage')) {
        mcpServers.push({
          id: 'mcp_fleet_inpage', name: 'fleet', type: 'inpage',
          url: 'inpage:fleet', token: '', corsProxy: '', enabled: true,
        });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = (typeof mcpServers !== 'undefined')
        && mcpServers.find((s) => s.id === 'mcp_fleet_inpage');
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) => console.warn('fleet in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };

  window.CreelFleet = CreelFleet;

  // ── agent-tab boot: claim the task, hold the lock, auto-start ────
  async function agentBoot() {
    const t = await getTask(MY_TASK_ID);
    if (!t) { console.warn('fleet: no task record for', MY_TASK_ID); return; }
    document.title = `creel · ${t.label || t.id}`;
    if (navigator.locks) {
      navigator.locks.request(LOCK_PREFIX + MY_TASK_ID, () => new Promise(() => {}));
    }
    t.status = 'running';
    t.startedAt = Date.now();
    await putTask(t);
    notify();
    BC.addEventListener('message', (e) => {
      if (e.data?.type === 'abort' && e.data.id === MY_TASK_ID) window.close();
    });
    // Give the harness a beat to finish booting (providers, MCP connects),
    // then hand it the task exactly as a user would.
    setTimeout(() => {
      const input = document.getElementById('userInput');
      if (!input || typeof handleSend !== 'function') {
        console.warn('fleet: harness send surface not found');
        return;
      }
      input.value = wrapTask(t);
      if (typeof handleInputChange === 'function') handleInputChange(input);
      handleSend();
    }, 2000);
  }

  // ── dashboard overlay ────────────────────────────────────────────
  let overlay = null;
  function h(tag, style, ...kids) {
    const n = document.createElement(tag);
    if (style) n.style.cssText = style;
    n.append(...kids);
    return n;
  }

  async function renderDashboard() {
    if (!overlay) return;
    const list = overlay.querySelector('#creelFleetList');
    const report = await statusReport();
    list.textContent = '';
    if (!report.length) {
      list.appendChild(h('div', 'color:#8892a4;padding:14px;', 'No fleet tasks. Spawn below, or ask the agent to use fleet_spawn.'));
    }
    const COLORS = { queued: '#e0af68', spawned: '#e0af68', running: '#8be9fd', done: '#9ece6a', failed: '#ff8080', dead: '#ff8080' };
    for (const t of report) {
      const row = h('div', 'border:1px solid #2a2a3a;border-radius:6px;padding:8px 10px;margin:8px 0;background:#181826;');
      const head = h('div', 'display:flex;gap:8px;align-items:center;');
      head.append(
        h('span', 'font-weight:600;', t.label || t.id),
        h('span', `color:${COLORS[t.status] || '#cfd2d6'};font-size:11px;`, t.status + (t.status === 'running' && t.alive ? ' ●' : '')),
        h('span', 'flex:1', ''),
      );
      if (['queued', 'spawned'].includes(t.status)) {
        const launch = h('button', 'background:#1d2e1d;border:1px solid #2a3a2a;color:#9ece6a;padding:2px 10px;border-radius:4px;cursor:pointer;', 'Launch');
        launch.onclick = () => { spawnWindow(t.id); };
        head.appendChild(launch);
      }
      if (['running', 'spawned', 'queued'].includes(t.status)) {
        const abort = h('button', 'background:#2e1d1d;border:1px solid #3a2a2a;color:#ff8080;padding:2px 10px;border-radius:4px;cursor:pointer;', 'Abort');
        abort.onclick = () => impl.fleet_abort({ id: t.id }).then(renderDashboard);
        head.appendChild(abort);
      }
      row.appendChild(head);
      row.appendChild(h('div', 'color:#8892a4;font-size:12px;margin-top:4px;white-space:pre-wrap;', t.task.slice(0, 200)));
      if (t.result) row.appendChild(h('div', 'color:#cfd2d6;font-size:12px;margin-top:6px;border-top:1px dashed #2a2a3a;padding-top:6px;white-space:pre-wrap;', t.result.slice(0, 500)));
      list.appendChild(row);
    }

    const comms = overlay.querySelector('#creelFleetComms');
    if (comms) {
      comms.textContent = '';
      comms.appendChild(h('div', 'color:#e0af68;font-weight:600;margin-bottom:4px;', 'comms'));
      if (!commsLog.length) comms.appendChild(h('div', 'color:#8892a4;', 'no fleet messages yet'));
      for (const m of commsLog.slice(-15).reverse()) {
        comms.appendChild(h('div', 'color:#8892a4;margin:2px 0;',
          `${new Date(m.ts).toLocaleTimeString()} · ${m.fromLabel || m.from} → ${m.to || 'all'}: `,
          h('span', 'color:#cfd2d6;', m.text.slice(0, 120))));
      }
    }
  }

  function openDashboard() {
    if (overlay) { overlay.remove(); overlay = null; return; }
    overlay = h('div', 'position:fixed;top:0;right:0;bottom:0;width:min(430px,95vw);z-index:99998;background:#12121c;border-left:1px solid #2a2a3a;color:#cfd2d6;font:13px system-ui,sans-serif;display:flex;flex-direction:column;box-shadow:-4px 0 16px rgba(0,0,0,.5);');
    const head = h('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a2a3a;');
    const clear = h('button', 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Clear done');
    clear.onclick = () => impl.fleet_clear().then(renderDashboard);
    const close = h('button', 'background:#2a1d1d;border:1px solid #3a2a2a;color:#ff8080;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Close');
    close.onclick = () => { overlay.remove(); overlay = null; };
    head.append(h('span', 'font-weight:600;color:#e0af68;', '🧺 fleet'), h('span', 'flex:1', ''), clear, close);
    overlay.appendChild(head);

    const list = h('div', 'flex:1;overflow:auto;padding:6px 12px;');
    list.id = 'creelFleetList';
    overlay.appendChild(list);

    const comms = h('div', 'max-height:30%;overflow:auto;border-top:1px solid #2a2a3a;padding:6px 12px;font-size:11px;');
    comms.id = 'creelFleetComms';
    overlay.appendChild(comms);

    const form = h('div', 'border-top:1px solid #2a2a3a;padding:10px 12px;display:flex;flex-direction:column;gap:6px;');
    const label = document.createElement('input');
    label.placeholder = 'label (optional)';
    label.style.cssText = 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:5px 8px;border-radius:4px;';
    const task = document.createElement('textarea');
    task.placeholder = 'task for a new agent tab…';
    task.rows = 3;
    task.style.cssText = 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:5px 8px;border-radius:4px;resize:vertical;';
    const spawn = h('button', 'background:#1d2e1d;border:1px solid #2a3a2a;color:#9ece6a;padding:6px;border-radius:4px;cursor:pointer;font-weight:600;', 'Spawn agent tab');
    spawn.onclick = async () => {
      if (!task.value.trim()) return;
      await impl.fleet_spawn({ task: task.value.trim(), label: label.value.trim() || undefined });
      task.value = '';
      renderDashboard();
    };
    form.append(label, task, spawn);
    overlay.appendChild(form);

    document.body.appendChild(overlay);
    renderDashboard();
  }

  function injectButton() {
    if (document.getElementById('creelFleetBtn')) return;
    const btn = h('button', 'position:fixed;bottom:118px;right:16px;z-index:9999;background:#1d1d2e;color:#e0af68;'
      + 'border:1px solid #2a2a3a;border-radius:18px;padding:7px 14px;cursor:pointer;'
      + 'font:12px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);', '🧺 fleet');
    btn.id = 'creelFleetBtn';
    btn.title = 'Fleet dashboard — agents in tabs';
    btn.onclick = openDashboard;
    document.body.appendChild(btn);
  }

  BC.addEventListener('message', (e) => {
    if (e.data?.type === 'update' && overlay) renderDashboard();
    if (e.data?.type === 'msg') onFleetMsg(e.data);
  });

  function start() {
    CreelFleet.registerDefaults();
    injectButton();
    if (MY_TASK_ID) agentBoot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
