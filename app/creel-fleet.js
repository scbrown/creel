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
  const workerMatch = location.hash.match(/creel-worker=([a-z0-9]+)/);
  const MY_WORKER_ID = workerMatch ? workerMatch[1] : null;
  let currentLeaseTaskId = null;       // the lease task this worker holds now
  let releaseCurrentTaskLock = null;   // resolves to drop the task's Web Lock

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

  // ── fleet work log (creel-vis) ────────────────────────────────────
  // Every task transition (claimed/done/failed/requeued/aborted) is
  // appended to a shared log in the task store, and the main tab drains
  // it into its own conversation — so ALL fleet work is visible to the
  // operator's agent automatically, not just to whoever polls. Workers
  // only append; they never inject into the main tab. The main tab is
  // the one with no MY_TASK_ID and no MY_WORKER_ID.
  const DIGEST_ID = 'meta:digest';
  const DIGEST_CURSOR_ID = 'meta:digest-cursor';
  const MAX_DIGEST = 200;
  const isDispatcher = () => !MY_TASK_ID && !MY_WORKER_ID;
  async function digestAdd(event, t, detail) {
    const d = (await getTask(DIGEST_ID)) || { id: DIGEST_ID, kind: 'meta', status: 'meta', entries: [] };
    d.entries = d.entries || [];
    const ts = Math.max(Date.now(), (d.entries[d.entries.length - 1]?.ts || 0) + 1); // strictly increasing
    d.entries.push({ ts, event, id: t.id, label: t.label || null, detail: detail ? String(detail).slice(0, 300) : undefined });
    if (d.entries.length > MAX_DIGEST) d.entries.splice(0, d.entries.length - MAX_DIGEST);
    await putTask(d);
    notify();
  }
  let digestFlushTimer = null;
  function scheduleDigestDrain() {
    if (!isDispatcher()) return;
    clearTimeout(digestFlushTimer);
    digestFlushTimer = setTimeout(drainDigest, 800); // debounce: batch burst events into one message
  }
  async function drainDigest() {
    if (!isDispatcher()) return;
    const d = await getTask(DIGEST_ID);
    if (!d || !d.entries || !d.entries.length) return;
    const c = (await getTask(DIGEST_CURSOR_ID)) || { id: DIGEST_CURSOR_ID, kind: 'meta', status: 'meta', ts: 0 };
    const fresh = d.entries.filter((e) => e.ts > (c.ts || 0));
    if (!fresh.length) return;
    await putTask({ ...c, ts: fresh[fresh.length - 1].ts });
    const lines = fresh.map((e) => {
      const who = e.label || e.id;
      switch (e.event) {
        case 'claimed': return `· ${who} claimed by a worker`;
        case 'done': return `· ${who} DONE${e.detail ? `: ${e.detail}` : ''}`;
        case 'failed': return `· ${who} FAILED: ${e.detail || ''}`;
        case 'requeued': return `· ${who} requeued (${e.detail || 'stale'}) — its worker froze or died`;
        case 'aborted': return `· ${who} aborted`;
        case 'enqueued': return `· ${who} enqueued`;
        default: return `· ${who} ${e.event}${e.detail ? `: ${e.detail}` : ''}`;
      }
    });
    injectTask('🧺 FLEET DIGEST\n' + lines.join('\n'));
  }

  // creel-sbx: read the harness's token counters (top-level `let` globals in
  // onepagent.html — classic scripts share the global lexical scope). They are
  // cumulative for the tab's session; the delta between a task's start and its
  // fleet_report is that task's token spend. Guarded so a stale harness build
  // (no counters yet) degrades to zeros instead of throwing.
  function readTokenCounters() {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
    try {
      return {
        total: num(typeof totalTokens === 'number' ? totalTokens : 0),
        input: num(typeof totalInputTokens === 'number' ? totalInputTokens : 0),
        output: num(typeof totalOutputTokens === 'number' ? totalOutputTokens : 0),
      };
    } catch { return { total: 0, input: 0, output: 0 }; }
  }

  async function aliveLocks() {
    if (!navigator.locks || !navigator.locks.query) return new Set();
    const { held = [] } = await navigator.locks.query();
    return new Set(held.filter((l) => l.name.startsWith(LOCK_PREFIX))
      .map((l) => l.name.slice(LOCK_PREFIX.length)));
  }

  async function statusReport() {
    await requeueStale();
    const tasks = await allTasks();
    const alive = await aliveLocks();
    const taskLocks = await heldTaskLocks();
    return tasks
      .filter((t) => !isMeta(t))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((t) => {
        if (t.kind === 'lease') {
          return { ...t, alive: taskLocks.has(t.id) };
        }
        return {
          ...t,
          alive: alive.has(t.id),
          status: (t.status === 'running' && !alive.has(t.id)) ? 'dead' : t.status,
        };
      });
  }

  // ── device-aware concurrency caps (creel-piv) ─────────────────────
  // Mobile browsers throttle and evict background tabs, so concurrent
  // agent tabs are capped by device class: 3 on phones, 4 on tablets,
  // 8 on desktop (maxConcurrent overrides 1..24). Every spawn path
  // consults the cap; the device is surfaced via fleet_device and the
  // dashboard chip.
  function deviceInfo() {
    const d = (typeof window !== 'undefined' && window.CreelDevice) ? window.CreelDevice : null;
    return d ? d.info() : { kind: 'desktop', isMobile: false, touch: false, width: 0, ua: '' };
  }
  function tabCap(override) {
    const d = (typeof window !== 'undefined' && window.CreelDevice) ? window.CreelDevice : null;
    return d ? d.tabCap(override) : 8;
  }
  async function runningCount() {
    const tasks = await allTasks();
    const locks = await heldTaskLocks();
    let running = 0;
    for (const t of tasks) {
      if (t.kind === 'lease' && t.status === 'running') running++;            // lease workers
      else if (t.kind !== 'lease' && t.status === 'running' && locks.has(t.id)) running++; // spawned agents
    }
    return running;
  }
  async function resolveCaps(override) {
    const d = deviceInfo();
    const cap = tabCap(override);
    const running = await runningCount();
    return { device: d.kind, cap, running, free: Math.max(0, cap - running) };
  }

  function spawnWindow(id, kind = 'agent') {
    const w = window.open(`onepagent.html#creel-${kind}=${id}`, '_blank');
    return !!w;
  }

  // ── work-queue leasing (creel-glv) ───────────────────────────────
  // Lease tasks live in the same IDB store with kind:'lease'. A worker
  // claims one by taking the Web Lock 'creel-task-<id>' (ifAvailable) and
  // holds it while working — so a dead worker's task lock vanishes and the
  // task is requeued by whoever looks next. Draining is a meta record
  // workers consult before claiming.
  const TASK_LOCK = 'creel-task-';
  const DRAIN_ID = 'meta:drain';
  const isMeta = (t) => t.id.startsWith('meta:');
  const STALE_HEARTBEAT_MS = 5 * 60 * 1000; // 5 min without heartbeat → stale

  async function heldTaskLocks() {
    if (!navigator.locks || !navigator.locks.query) return new Set();
    const { held = [] } = await navigator.locks.query();
    return new Set(held.filter((l) => l.name.startsWith(TASK_LOCK))
      .map((l) => l.name.slice(TASK_LOCK.length)));
  }

  /** Reset lease tasks whose worker died (running, but nobody holds the
   *  lock) OR whose worker is frozen (lock held but no heartbeat for
   *  STALE_HEARTBEAT_MS) back to queued. Returns the requeued ids. */
  async function requeueStale() {
    const tasks = await allTasks();
    const locks = await heldTaskLocks();
    const now = Date.now();
    const requeued = [];
    for (const t of tasks) {
      if (t.kind !== 'lease' || t.status !== 'running') continue;
      const lockDead = !locks.has(t.id);
      const heartbeatStale = t.lastHeartbeat && (now - t.lastHeartbeat > STALE_HEARTBEAT_MS);
      if (lockDead || heartbeatStale) {
        t.status = 'queued';
        t.requeues = (t.requeues || 0) + 1;
        t.requeueReason = lockDead ? 'lock-released' : 'heartbeat-stale';
        t.claimedBy = null;
        t.lastHeartbeat = null;
        await putTask(t);
        digestAdd('requeued', t, t.requeueReason || 'stale');
        requeued.push(t.id);
      }
    }
    if (requeued.length) notify();
    return requeued;
  }

  async function isDraining() {
    const m = await getTask(DRAIN_ID);
    return !!m?.drain;
  }

  function wrapTask(t) {
    return `${t.task}\n\n---\nYou are a spawned creel fleet agent (task id: ${t.id}`
      + `${t.label ? `, label: ${t.label}` : ''}). Work autonomously. When the task is`
      + ' complete, call the fleet_report tool with a concise result summary in the'
      + ' `result` argument. If you cannot complete it, call fleet_report with a'
      + ' result starting "FAILED:" explaining why.'
      + `\nDevice-aware cap: ${tabCap()} concurrent agent tabs on ${deviceInfo().kind}`
      + ' — keep background tabs productive (record findings, push branches, let'
      + ' the burst merge).'
      + '\nFleet comms: fleet_send({to, message}) delivers a message INTO another'
      + ' agent\'s conversation (to = task id or label, or "dashboard" for the'
      + ' operator tab); fleet_send({message}) without `to` broadcasts to every'
      + ' inbox instead. Check fleet_inbox for broadcasts and anything received'
      + ' while you were busy. fleet_status lists the other agents.'
      + '\nYour world is described IN the shared quipu graph, not in docs:'
      + ' start with quipu_cord {"name": "creel-world-model-v3"} to learn the'
      + ' roles (the root pane dispatches, bobbins like you execute), the tool'
      + ' servers, and the conventions; quipu_query answers anything deeper.'
      + ' Record durable findings as quipu episodes — every tab sees them'
      + ' instantly. At burst end the operator may synthesize all results'
      + ' (fleet_synthesize) and write the takeaways back to the graph'
      + ' (fleet_writeback); make your fleet_report result a clean, quotable'
      + ' summary so it composes well.'
      + '\nIf your task edits a repository, your workspace (the FILES panel and'
      + ' its github checkout) is private to THIS tab — edit freely without'
      + ` clobbering peers. Push to your own branch named creel/${t.label || t.id}`
      + ' (github_push branch:"creel/' + (t.label || t.id) + '"), and report'
      + ' that branch name in your fleet_report so the operator can github_merge'
      + ' every agent branch at burst end.';
  }

  // ── cross-tab comms ──────────────────────────────────────────────
  const inbox = [];
  const commsLog = [];
  const myLabelPromise = MY_TASK_ID ? getTask(MY_TASK_ID).then((t) => t?.label || MY_TASK_ID) : null;
  // Publish the label to the self-model so the cross-tab ui_ tools can be
  // addressed by the human-readable name the operator already uses, not just
  // by task id. creel-self.js loads after this file, so this is set on
  // resolution rather than at load.
  if (myLabelPromise) myLabelPromise.then((label) => { if (window.CreelSelf) window.CreelSelf.label = label; }).catch(() => {});

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
      const entries = d ? d.entries.slice(-(args.limit || 30)).reverse() : [];
      return {
        count: entries.length,
        hint: 'every fleet transition (claimed/done/failed/requeued/aborted) is logged here; the main tab also receives an automatic digest when work changes',
        entries,
      };
    },

    async fleet_report(args) {
      const taskId = MY_TASK_ID || currentLeaseTaskId;
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
      if (!MY_TASK_ID && currentLeaseTaskId === taskId) {
        currentLeaseTaskId = null;
        if (releaseCurrentTaskLock) { releaseCurrentTaskLock(); releaseCurrentTaskLock = null; }
        setTimeout(claimNext, 1500);
      }
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
  /* Introspection for tests and debugging — never load-bearing. */
  CreelFleet.debug = async () => ({
    workerId: MY_WORKER_ID,
    taskId: MY_TASK_ID,
    currentLeaseTaskId,
    draining: await isDraining(),
    tasks: (await allTasks()).map((t) => `${t.kind || 'agent'}/${t.label || t.id}:${t.status}${t.claimedBy ? '@' + t.claimedBy : ''}`),
    taskLocks: [...await heldTaskLocks()],
    agentLocks: [...await aliveLocks()],
  });

  // ── heartbeat: frozen-tab detection (creel-vkh) ──────────────────
  // Worker/agent tabs update lastHeartbeat every 30s. The dashboard's
  // requeueStale() requeues any running lease without a heartbeat for
  // STALE_HEARTBEAT_MS, even if the Web Lock is still held (frozen tab).
  let heartbeatInterval = null;
  function startHeartbeat(taskId) {
    stopHeartbeat();
    heartbeatInterval = setInterval(async () => {
      try {
        const t = await getTask(taskId);
        if (!t || t.status !== 'running') { stopHeartbeat(); return; }
        t.lastHeartbeat = Date.now();
        await putTask(t);
      } catch {}
    }, 30000);
  }
  function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  }

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
    t.lastHeartbeat = Date.now();
    t.tokenStart = readTokenCounters();
    await putTask(t);
    notify();
    startHeartbeat(MY_TASK_ID);
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

  // ── worker-tab boot: lease tasks from the queue until drained ────
  function injectTask(text) {
    const input = document.getElementById('userInput');
    if (!input || typeof handleSend !== 'function') return false;
    input.value = text;
    if (typeof handleInputChange === 'function') handleInputChange(input);
    handleSend();
    return true;
  }

  // Non-reentrant: the report-timeout and the fleet-bus update listener can
  // both trigger a claim — concurrent scans in one tab double-claim tasks
  // and clobber currentLeaseTaskId/releaseCurrentTaskLock. Coalesce them.
  let claimInFlight = null;
  let idleNoticeShown = false;
  function claimNext() {
    if (currentLeaseTaskId) return Promise.resolve();
    if (claimInFlight) return claimInFlight;
    claimInFlight = doClaimNext().finally(() => { claimInFlight = null; });
    return claimInFlight;
  }

  async function doClaimNext() {
    if (await isDraining()) {
      document.title = `creel · worker (drained)`;
      if (!idleNoticeShown) {
        idleNoticeShown = true;
        injectTask('The fleet queue is draining — no more tasks will be claimed. '
          + 'Summarize what you accomplished this session in one message, then stop.');
      }
      return;
    }
    await requeueStale();
    const tasks = (await allTasks()).filter((t) => t.kind === 'lease' && t.status === 'queued');
    tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const t of tasks) {
      // Try to take the task's lock; hold it until fleet_report releases it.
      const got = await new Promise((resolve) => {
        navigator.locks.request(TASK_LOCK + t.id, { ifAvailable: true }, (lock) => {
          if (!lock) { resolve(false); return; }
          resolve(true);
          return new Promise((release) => { releaseCurrentTaskLock = release; });
        }).catch(() => resolve(false));
      });
      if (!got) continue;
      const fresh = await getTask(t.id);
      if (!fresh || fresh.status !== 'queued') {
        if (releaseCurrentTaskLock) { releaseCurrentTaskLock(); releaseCurrentTaskLock = null; }
        continue;
      }
      fresh.status = 'running';
      fresh.claimedBy = MY_WORKER_ID;
      fresh.startedAt = Date.now();
      fresh.lastHeartbeat = Date.now();
      fresh.tokenStart = readTokenCounters();
      await putTask(fresh);
      digestAdd('claimed', fresh);
      startHeartbeat(fresh.id);
      currentLeaseTaskId = fresh.id;
      idleNoticeShown = false;
      document.title = `creel · worker: ${fresh.label || fresh.id}`;
      notify();
      injectTask(wrapTask(fresh) + '\nAfter fleet_report, your tab will automatically '
        + 'receive the next queued task, if any — treat each task independently.');
      return;
    }
    document.title = 'creel · worker (idle)';
    if (!idleNoticeShown) {
      idleNoticeShown = true;
      injectTask('The fleet queue is currently empty. Say "idle — waiting for work" and stop; '
        + 'this tab will receive the next enqueued task automatically.');
    }
    // Re-check when the queue changes.
  }

  async function workerBoot() {
    document.title = 'creel · worker';
    if (navigator.locks) {
      navigator.locks.request(LOCK_PREFIX + MY_WORKER_ID, () => new Promise(() => {}));
    }
    await putTask({
      id: MY_WORKER_ID, kind: 'worker', label: `worker-${MY_WORKER_ID.slice(0, 4)}`,
      status: 'running', createdAt: Date.now(), task: 'queue worker',
    });
    notify();
    BC.addEventListener('message', (e) => {
      if (e.data?.type === 'abort' && e.data.id === MY_WORKER_ID) window.close();
      // New work while idle → claim it.
      if (e.data?.type === 'update' && !currentLeaseTaskId) {
        setTimeout(() => { if (!currentLeaseTaskId) claimNext(); }, 500 + Math.random() * 1000);
      }
    });
    setTimeout(claimNext, 2500);
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
    const chip = overlay.querySelector('#creelFleetChip');
    if (chip) {
      const caps = await resolveCaps();
      const atCap = caps.running >= caps.cap;
      chip.textContent = `${caps.device === 'mobile' ? '📱' : caps.device === 'tablet' ? '📟' : '🖥️'} ${caps.device} · ${caps.running}/${caps.cap} tabs`;
      chip.style.cssText = 'font-size:11px;border:1px solid ' + (atCap ? '#8a6a2a' : '#2a2a3a')
        + ';border-radius:10px;padding:2px 8px;color:' + (atCap ? '#e0af68' : '#8892a4') + ';';
      chip.title = `concurrent agent tabs capped at ${caps.cap} on ${caps.device} — ${caps.free} free`;
    }
    const capnote = overlay.querySelector('#creelFleetCapNote');
    if (capnote) {
      const caps = await resolveCaps();
      capnote.textContent = caps.free > 0
        ? `${caps.free} tab slot${caps.free === 1 ? '' : 's'} free on ${caps.device} (cap ${caps.cap})`
        : `at the ${caps.cap}-tab cap on ${caps.device} — spawns stay queued until a slot frees`;
      capnote.style.color = caps.free > 0 ? '#8892a4' : '#e0af68';
    }
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
      row.appendChild(h('div', 'color:#8892a4;font-size:12px;margin-top:4px;white-space:pre-wrap;', String(t.task || '').slice(0, 200)));
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
    // The weft: hand every finished result to the operator's own agent so it
    // synthesizes across the parallel threads, in this same conversation.
    const weft = h('button', 'background:#2e2a12;border:1px solid #4a4422;color:#e0af68;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Synthesize');
    weft.onclick = async () => {
      const s = await impl.fleet_synthesize();
      if (!s.tasks.length) { weft.textContent = 'no results yet'; setTimeout(() => { weft.textContent = 'Synthesize'; }, 1500); return; }
      const lines = s.tasks.map((t) => `- [${t.label} · ${t.status}] ${t.result || '(no result)'}`).join('\n');
      injectTask(`Synthesize this creel burst across its parallel threads (${s.done} done, ${s.failed} failed). `
        + `Give one combined answer, note agreements/conflicts, then (if worth keeping) call fleet_writeback to record the key findings into the quipu graph.\n\n${lines}`);
      overlay.remove(); overlay = null;
    };
    const clear = h('button', 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Clear done');
    clear.onclick = () => impl.fleet_clear().then(renderDashboard);
    const close = h('button', 'background:#2a1d1d;border:1px solid #3a2a2a;color:#ff8080;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Close');
    close.onclick = () => { overlay.remove(); overlay = null; };
    const chip = h('span', 'font-size:11px;color:#8892a4;border:1px solid #2a2a3a;border-radius:10px;padding:2px 8px;', '…');
    chip.id = 'creelFleetChip';
    head.append(h('span', 'font-weight:600;color:#e0af68;', '🧺 fleet'), chip, h('span', 'flex:1', ''), weft, clear, close);
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
    const capnote = h('div', 'font-size:11px;color:#8892a4;', '');
    capnote.id = 'creelFleetCapNote';
    form.appendChild(capnote);
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
    // An emoji-prefixed label is a poor name to locate by; aria-label wins
    // over content, so {role:'button', name:'Fleet dashboard'} finds it.
    btn.setAttribute('aria-label', 'Fleet dashboard');
    btn.onclick = openDashboard;
    document.body.appendChild(btn);
  }

  BC.addEventListener('message', (e) => {
    if (e.data?.type === 'update' && overlay) renderDashboard();
    if (e.data?.type === 'update') scheduleDigestDrain();
    if (e.data?.type === 'msg') onFleetMsg(e.data);
  });

  // Burst isolation: fleet tabs must never carry the operator's conversation
  // (or any other tab's) into a task. The harness boots fleet tabs fresh
  // (onepagent.html loadConvHistory / IS_FLEET_TAB), but guard here too so a
  // stale harness build still starts clean — newConversation(true) resets
  // in-memory state and (since IS_FLEET_TAB) never touches ba_active_conv.
  function isolateContext() {
    if (!MY_TASK_ID && !MY_WORKER_ID) return;
    if (typeof newConversation === 'function' && typeof conversation !== 'undefined' && conversation.length) {
      newConversation(true);
    }
  }

  function start() {
    CreelFleet.registerDefaults();
    injectButton();
    isolateContext();
    if (MY_TASK_ID) agentBoot();
    if (MY_WORKER_ID) workerBoot();
    // Dashboard tabs: periodically requeue stale leases (frozen-tab detection)
    // and drain the fleet work log into the main tab's conversation.
    if (!MY_TASK_ID && !MY_WORKER_ID) {
      drainDigest();
      setInterval(async () => {
        const requeued = await requeueStale();
        if (requeued.length && overlay) renderDashboard();
        drainDigest();
      }, 60000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
