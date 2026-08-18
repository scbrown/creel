/* creel — the fleet's tool surface (creel-hun).
 *
 * Split out of creel-fleet.js, which was one 1150-line closure. This half is
 * what an agent can ask the fleet to do: the tool schemas and their
 * implementations. The other half — the IndexedDB queue, Web Lock leasing,
 * the cross-tab bus, worker boot — is creel-fleet.js, and it must load FIRST:
 * this file fills the `tools` and `impl` collections CreelFleet.handle
 * already closes over.
 *
 * Note what is NOT imported here: the variables tracking which task this tab
 * holds. fleet_report ends a lease, but it does so through releaseLease(),
 * because a lease and the Web Lock proving it have to be dropped together.
 */
(function () {
  'use strict';

  const FLEET = window.CreelFleetInternal;
  if (!FLEET) throw new Error('creel-fleet-tools.js loaded before creel-fleet.js — check the script order in onepagent.html');
  const {
    BC, DIGEST_ID, DRAIN_ID, MY_TASK_ID, MY_WORKER_ID, myLabelPromise,
    putTask, getTask, allTasks, delTask, genId, notify,
    digestAdd, requeueStale, statusReport, aliveLocks, isMeta,
    heldLease, releaseLease, claimNext, stopHeartbeat,
    readTokenCounters, deviceInfo, tabCap, resolveCaps, spawnWindow,
    inbox, commsLog, logComms,
  } = FLEET;
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
          maxConcurrent: { type: 'integer', description: 'optional 1..24 override of the device tab cap (default: 3 mobile / 4 tablet / 8 desktop)' },
        },
        required: ['task'],
      },
    },
    {
      name: 'fleet_device',
      description: 'Report the current device class (mobile/tablet/desktop) and the concurrent agent-tab cap it implies — mobile browsers evict background tabs, so bursts on phones are capped at 3 tabs, tablets 4, desktop 8 — plus how many of those slots are currently in use. Check this before planning a burst.',
      inputSchema: {
        type: 'object',
        properties: { maxConcurrent: { type: 'integer', description: 'optional 1..24 override to evaluate' } },
        required: [],
      },
    },
    {
      name: 'fleet_status',
      description: 'List fleet tasks/agents: queued, running (with tab-alive liveness from Web Locks), done (with results), failed, or dead (tab closed without reporting). Rows include the task text, heartbeat age (seconds since the worker last checked in), and requeue reason when a task was requeued.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'fleet_digest',
      description: 'Return the fleet work log — every task transition (claimed/done/failed/requeued/aborted) with timestamps and detail. The main tab also receives an automatic 🧺 FLEET DIGEST message when work changes; use this to audit history or catch up after a reload.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'how many recent entries (default 30)' } },
        required: [],
      },
    },
    {
      name: 'fleet_report',
      description: 'FOR SPAWNED AGENTS: report your task result back to the fleet. Call exactly once when your task is complete (prefix "FAILED:" if it could not be completed). Token usage for the task is captured automatically from the harness.',
      inputSchema: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'concise result summary' },
          inputTokens: { type: 'integer', description: 'optional explicit override; normally auto-captured from the harness counters' },
          outputTokens: { type: 'integer', description: 'optional explicit override; normally auto-captured from the harness counters' },
        },
        required: ['result'],
      },
    },
    {
      name: 'fleet_enqueue',
      description: 'Add tasks to the shared work queue WITHOUT spawning tabs. Worker tabs (fleet_spawn_workers) lease tasks one at a time; a worker dying mid-task auto-requeues it. Use this + workers for N-tasks-M-agents bursts; use fleet_spawn for one dedicated tab per task.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'string' }, description: 'task descriptions to enqueue' },
          label_prefix: { type: 'string', description: 'labels become <prefix>-1, <prefix>-2, … (default "task")' },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'fleet_spawn_workers',
      description: 'Spawn N worker tabs that repeatedly lease tasks from the queue (fleet_enqueue) until it is empty or draining. Same popup-blocker caveat as fleet_spawn.',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer', description: 'worker tabs to open (default 2, max 8)' } },
        required: [],
      },
    },
    {
      name: 'fleet_drain',
      description: 'Toggle queue draining: while draining, workers finish their current task and stop claiming. fleet_drain {on:false} resumes claiming.',
      inputSchema: {
        type: 'object',
        properties: { on: { type: 'boolean', description: 'default true' } },
        required: [],
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
      name: 'fleet_synthesize',
      description: 'THE WEFT (burst synthesis): collect every finished agent/task result into one structured payload for the operator to synthesize across the parallel threads. Returns {tasks:[{label,status,task,result}], done, failed}. Call this at burst end, then write your combined answer.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'fleet_writeback',
      description: 'Record what a burst learned into the shared quipu graph as episodes tagged with a burst id, so the knowledge outlives the tabs and shows up in the ◉ graph. Pass findings (one episode each); each becomes a quipu episode linked to a Burst node.',
      inputSchema: {
        type: 'object',
        properties: {
          burst: { type: 'string', description: 'a name for this burst (default: burst-<timestamp-ish>)' },
          findings: {
            type: 'array',
            description: 'the durable takeaways to record',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                body: { type: 'string' },
                entities: { type: 'array', items: { type: 'string' }, description: 'key entity names this finding is about' },
              },
              required: ['title', 'body'],
            },
          },
        },
        required: ['findings'],
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
      const caps = await resolveCaps(args.maxConcurrent);
      const want = Math.max(1, Math.min(8, args.count || 1));
      // Device-aware cap: on a 3-tab phone with 2 already running, a burst
      // of 4 spawns only the 1 free slot; the rest are reported `capped`
      // (status stays queued — launchable from the dashboard once slots free).
      const count = Math.max(0, Math.min(want, caps.free));
      const spawned = [];
      const queued = [];
      const capped = [];
      for (let i = 0; i < want; i++) {
        const id = genId();
        const label = (args.label || 'agent') + (want > 1 ? `-${i + 1}` : '');
        const t = {
          id, label, task: args.task, status: 'queued',
          createdAt: Date.now(), result: null,
        };
        await putTask(t);
        if (i >= count) { capped.push({ id, label }); continue; }
        if (spawnWindow(id)) { t.status = 'spawned'; await putTask(t); spawned.push({ id, label }); }
        else queued.push({ id, label });
      }
      notify();
      return {
        spawned, queued, capped,
        device: caps.device, cap: caps.cap,
        hint: capped.length
          ? `capped at ${caps.cap} concurrent agent tabs on ${caps.device} — ${caps.free} free; the rest stay queued until a slot frees`
          : queued.length
            ? 'popup blocked — the user can launch queued agents from the 🧺 fleet dashboard, or allow popups for this site'
            : undefined,
      };
    },

    async fleet_status() {
      const report = await statusReport();
      const mapped = report.map(({ id, label, kind, status, alive, result, createdAt, doneAt, claimedBy, requeues, inputTokens, outputTokens, totalTokens, lastHeartbeat, requeueReason, task }) => ({
        id, label, kind: kind || 'agent', status, alive, result, createdAt, doneAt, claimedBy, requeues,
        inputTokens: inputTokens || 0, outputTokens: outputTokens || 0, totalTokens: totalTokens || 0,
        task: task ? String(task).slice(0, 300) : undefined,
        heartbeatAgeSec: lastHeartbeat ? Math.round((Date.now() - lastHeartbeat) / 1000) : null,
        requeueReason: requeueReason || undefined,
      }));
      return mapped;
    },

    async fleet_digest(args) {
      const d = await getTask(DIGEST_ID);
      // Belt and braces after the tx() miss bug above: its two siblings guard
      // `d.entries` and this one did not, which is why a read-only status call
      // was the thing that threw rather than the write that was actually wrong.
      const entries = (d && d.entries ? d.entries : []).slice(-(args.limit || 30)).reverse();
      return {
        count: entries.length,
        hint: 'every fleet transition (claimed/done/failed/requeued/aborted) is logged here; the main tab also receives an automatic digest when work changes',
        entries,
      };
    },

    async fleet_report(args) {
      const taskId = MY_TASK_ID || heldLease();
      if (!taskId) throw new Error('fleet_report is only for spawned agent/worker tabs (no task claimed)');
      const t = await getTask(taskId);
      if (!t) throw new Error(`unknown task ${taskId}`);
      // creel-sbx: attribute this task's token spend (delta since claim/boot).
      const start = t.tokenStart || { input: 0, output: 0, total: 0 };
      const end = readTokenCounters();
      t.inputTokens = (args.inputTokens != null) ? Number(args.inputTokens)
        : Math.max(0, end.input - (start.input || 0));
      t.outputTokens = (args.outputTokens != null) ? Number(args.outputTokens)
        : Math.max(0, end.output - (start.output || 0));
      t.totalTokens = Math.max(0, end.total - (start.total || 0));
      t.status = String(args.result || '').startsWith('FAILED:') ? 'failed' : 'done';
      t.result = args.result;
      t.doneAt = Date.now();
      t.lastHeartbeat = null;
      await putTask(t);
      digestAdd(t.status === 'done' ? 'done' : 'failed', t, args.result);
      stopHeartbeat();
      notify();
      // Lease workers: release the task lock and pull the next one.
      if (!MY_TASK_ID && releaseLease(taskId)) setTimeout(claimNext, 1500);
      return { ok: true, reported: t.status };
    },

    async fleet_enqueue(args) {
      const prefix = args.label_prefix || 'task';
      const ids = [];
      let i = 0;
      for (const task of args.tasks || []) {
        i++;
        const id = genId();
        await putTask({
          id, kind: 'lease', label: `${prefix}-${i}`, task,
          status: 'queued', createdAt: Date.now(), result: null, requeues: 0,
        });
        ids.push(id);
      }
      notify();   // idle workers hear this and claim
      return { enqueued: ids.length, ids };
    },

    async fleet_spawn_workers(args) {
      const caps = await resolveCaps(args.maxConcurrent);
      const want = Math.max(1, Math.min(8, args.count || 2));
      const count = Math.max(0, Math.min(want, caps.free));
      const spawned = [];
      const blocked = [];
      for (let i = 0; i < count; i++) {
        const wid = genId();
        (spawnWindow(wid, 'worker') ? spawned : blocked).push(wid);
      }
      return {
        spawned: spawned.length,
        blocked: blocked.length,
        device: caps.device, cap: caps.cap,
        hint: want > count
          ? `capped at ${caps.cap} concurrent agent tabs on ${caps.device} (${caps.free} free) — spawned ${count} of ${want}`
          : blocked.length
            ? 'popup blocked — allow popups for this site, or spawn workers from the 🧺 fleet dashboard'
            : undefined,
      };
    },

    async fleet_device(args) {
      const caps = await resolveCaps(args.maxConcurrent);
      return {
        ...caps,
        tab_caps: (typeof window !== 'undefined' && window.CreelDevice && window.CreelDevice.TAB_CAPS)
          || { mobile: 3, tablet: 4, desktop: 8 },
        note: caps.free > 0
          ? `${caps.free} tab slot${caps.free === 1 ? '' : 's'} free on ${caps.device}`
          : `at the ${caps.cap}-tab cap on ${caps.device} — further spawns stay queued`,
      };
    },

    async fleet_drain(args) {
      const on = args.on !== false;
      await putTask({ id: DRAIN_ID, kind: 'meta', status: 'meta', drain: on, createdAt: 0 });
      notify();
      return { draining: on };
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

    async fleet_synthesize() {
      const report = await statusReport();
      const finished = report.filter((t) => ['done', 'failed', 'dead'].includes(t.status));
      return {
        tasks: finished.map((t) => ({
          label: t.label || t.id, status: t.status,
          task: String(t.task || '').slice(0, 400), result: t.result || null,
          inputTokens: t.inputTokens || 0, outputTokens: t.outputTokens || 0, totalTokens: t.totalTokens || 0,
        })),
        done: finished.filter((t) => t.status === 'done').length,
        failed: finished.filter((t) => t.status !== 'done').length,
        pending: report.filter((t) => !['done', 'failed', 'dead'].includes(t.status)).length,
      };
    },

    async fleet_writeback(args) {
      const findings = Array.isArray(args.findings) ? args.findings : [];
      if (!findings.length) throw new Error('no findings to write back');
      if (!window.CreelQuipu) throw new Error('quipu not available in this tab');
      await window.CreelQuipu.ensureWasm();
      const call = (name, a) => window.CreelQuipu.provider.callTool(name, a);
      // Deterministic burst id (Date.now is unavailable in some contexts; use
      // the fleet's own timestamp source, which is Date.now here in the page).
      const burst = args.burst || `burst-${Date.now().toString(36)}`;
      const written = [];
      for (const f of findings) {
        const nodes = [
          { name: burst, type: 'Burst', description: 'a creel agent burst; groups the episodes its parallel threads produced' },
          ...(f.entities || []).map((e) => ({ name: e, type: 'Entity', description: `referenced by burst ${burst}` })),
        ];
        await call('quipu_episode', {
          name: `${burst}:${f.title}`,
          episode_body: f.body,
          source: 'creel-weft',
          nodes,
          edges: (f.entities || []).map((e) => ({ source: burst, target: e, relation: 'learned_about' })),
        });
        written.push(f.title);
      }
      notify();
      return { burst, episodes: written.length, titles: written, hint: 'visible now in the ◉ graph and to every fleet tab' };
    },

    async fleet_abort(args) {
      const t = await getTask(args.id);
      if (!t) throw new Error(`unknown task ${args.id}`);
      BC.postMessage({ type: 'abort', id: args.id });
      if (t.status !== 'done') {
        t.status = 'failed';
        t.result = t.result || 'aborted';
        await putTask(t);
        digestAdd('aborted', t);
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


  // Fill the collections CreelFleet.handle is already holding. Mutate, never
  // reassign — see the seam comment in creel-fleet.js.
  FLEET.tools.push(...TOOLS);
  Object.assign(FLEET.impl, impl);
})();
