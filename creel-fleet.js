/* creel — fleet mode: agents as browser tabs (VISION.md v1, first cut).
 *
 * Tabs are the bobbins. The platform does the scheduler's hard parts:
 *   work queue      → IndexedDB ('creel_fleet'), shared by every same-origin tab
 *   spawning        → window.open('thread.html#creel-agent=<id>')
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

  /* The lease is two variables that must always agree: the task this tab
   * believes it holds, and the resolver that drops the Web Lock proving it.
   * Reading them is harmless; CHANGING them is the moment a task stops being
   * ours, and doing that from a distance is how the two drift apart. So the
   * only two operations that matter get names, and everything outside the
   * claim loop — fleet_report, in particular — goes through them. */
  const heldLease = () => currentLeaseTaskId;

  /** Give up the lease on `taskId`, if that is the one we hold. Returns
   *  whether anything was actually released, so the caller can decide
   *  whether to go looking for more work. */
  function releaseLease(taskId) {
    if (currentLeaseTaskId !== taskId) return false;
    currentLeaseTaskId = null;
    if (releaseCurrentTaskLock) { releaseCurrentTaskLock(); releaseCurrentTaskLock = null; }
    return true;
  }

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
      // Unwrap by TYPE, not by whether the result happens to be undefined.
      // The old test — `out.result !== undefined ? out.result : out` — could
      // not tell "this fn returned a plain value" from "this get MISSED", and
      // returned the IDBRequest itself for a miss. Callers then read a truthy
      // object where they expected undefined: `(await getTask(id)) || {...}`
      // never took its fallback, and storing that object threw DataCloneError
      // into a promise nobody awaited. A miss must resolve undefined.
      const isRequest = typeof IDBRequest !== 'undefined' && out instanceof IDBRequest;
      t.oncomplete = () => resolve(isRequest ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }
  const putTask = (task) => tx('readwrite', (s) => { s.put(task); return task; }).then((r) => { refreshLiveMirror(); return r; });
  const getTask = (id) => tx('readonly', (s) => s.get(id)).then((r) => r);
  const allTasks = () => tx('readonly', (s) => s.getAll()).then((r) => r || []);
  const delTask = (id) => tx('readwrite', (s) => s.delete(id)).then((r) => { refreshLiveMirror(); return r; });

  // ── Live-task mirror ─────────────────────────────────────────────
  // beforeunload handlers must be synchronous, and the task store is
  // IndexedDB, so every mutation refreshes a localStorage count of live
  // tasks (queued/spawned/running). Tabs that only READ fleet state (the
  // dispatcher) get an accurate mirror at boot. Recompute-on-mutation keeps
  // it race-free across tabs; a stale count can only over-warn, never under.
  const LIVE_STATUS = new Set(['queued', 'spawned', 'running']);
  function refreshLiveMirror() {
    try {
      allTasks()
        .then((tasks) => {
          const n = tasks.filter((t) => LIVE_STATUS.has(t && t.status)).length;
          try { localStorage.setItem('creel_fleet_live', String(n)); } catch { /* private mode etc. */ }
        })
        .catch(() => {});
    } catch { /* IDB unavailable — warning simply stays DOM-based */ }
  }

  const genId = () => Math.random().toString(36).slice(2, 10);
  const notify = () => { try { BC.postMessage({ type: 'update' }); } catch { /* closed */ } };

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
  // ── the admission seam (aegis-edp2n.3) ────────────────────────────
  // Every spawn path already called resolveCaps to ask "how many tabs may I
  // open", so this is the one place the provider budget has to be composed in.
  // Doing it here rather than at each call site is deliberate: a governor
  // wired into three of four spawn paths is not a governor, and the fourth is
  // always the one somebody adds next week.
  //
  // `free` is what callers act on, so it carries the ENFORCED answer, not the
  // honest one — under `onSignalLost: warn` a blind governor alarms and the
  // fleet keeps running, which is the fail-safe direction. The honest answer
  // travels beside it as `governor` for anything that wants to report rather
  // than decide.
  async function resolveCaps(override) {
    const d = deviceInfo();
    const cap = tabCap(override);
    const running = await runningCount();
    const gov = (typeof window !== 'undefined' && window.CreelGovernor) ? window.CreelGovernor : null;
    if (!gov) return { device: d.kind, cap, running, free: Math.max(0, cap - running) };
    const v = gov.admission({ device: d.kind, deviceCap: cap, running, want: 1 });
    const controller = (typeof window !== 'undefined' && window.CreelSetpoint)
      ? window.CreelSetpoint.recommend({ verdict: v, liveAgents: running, fenceMax: v.admission.maxTabs })
      : null;
    return {
      device: d.kind,
      // The COMPOSED cap, so a caller that only reads `cap` still reports the
      // wall it will actually hit rather than the device's half of it.
      cap: v.admission.maxTabs,
      deviceCap: cap,
      running,
      // Advisory-first: the controller is evidence for a human, never an
      // admission input. Only the governor and the outer device/max_agents
      // fence decide whether a new tab may start.
      free: v.enforced === 'block' ? 0 : v.admission.free,
      governor: v,
      controller,
    };
  }

  /* The last spawn's outcome, remembered.
   *
   * `window.open()` returning null is the ONLY honest evidence that popups are
   * blocked — the Permissions API does not expose popup state, and probing by
   * opening a window to see whether windows open is treating the patient. So the
   * one moment the answer is knowable is a real spawn, and until now that
   * boolean was consumed inline at each call site and thrown away.
   *
   * Kept deliberately as `null` until a spawn has actually been attempted, so
   * the doctor reports `unknown` rather than inventing a pass for a fleet that
   * has never tried to open anything. */
  let lastSpawn = null;

  function lastSpawnOutcome() { return lastSpawn; }

  function spawnWindow(id, kind = 'agent') {
    const w = window.open(`thread.html#creel-${kind}=${id}`, '_blank');
    lastSpawn = { allowed: !!w, at: Date.now(), id, kind };
    return !!w;
  }

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
  /** Which running leases have been ABANDONED — pure, no I/O, no mutation.
   *
   * Split out of requeueStale (aegis-edp2n.4) so the doctor can REPORT this
   * without requeueing anything. requeueStale treats what it finds, and a
   * diagnostic that changes fleet state as a side effect of being looked at is
   * not a diagnostic. The alternative was a second copy of the predicate in
   * creel-doctor.js, and two copies of a staleness rule disagree exactly when
   * it matters — the same argument tools/creel-admission.js makes for not
   * recomputing the governor.
   *
   * Returns [{ id, reason }] with reason in {'lock-released','heartbeat-stale'},
   * the same strings requeueStale records on the task.
   */
  function staleLeases(tasks, locks, now) {
    const out = [];
    for (const t of tasks || []) {
      if (!t || t.kind !== 'lease' || t.status !== 'running') continue;
      const lockDead = !locks.has(t.id);
      const heartbeatStale = !!t.lastHeartbeat && (now - t.lastHeartbeat > STALE_HEARTBEAT_MS);
      if (lockDead || heartbeatStale) {
        out.push({ id: t.id, reason: lockDead ? 'lock-released' : 'heartbeat-stale' });
      }
    }
    return out;
  }

  async function requeueStale() {
    const tasks = await allTasks();
    const locks = await heldTaskLocks();
    const stale = new Map(staleLeases(tasks, locks, Date.now()).map((s) => [s.id, s.reason]));
    const requeued = [];
    for (const t of tasks) {
      const reason = stale.get(t.id);
      if (!reason) continue;
      t.status = 'queued';
      t.requeues = (t.requeues || 0) + 1;
      t.requeueReason = reason;
      t.claimedBy = null;
      t.lastHeartbeat = null;
      await putTask(t);
      FLEET.digestAdd('requeued', t, t.requeueReason || 'stale');
      requeued.push(t.id);
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
      + ' start with quipu_cord {"name": "creel-world-model-v4"} to learn the'
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
    // The dashboard is a separate file and may not be mounted (agent tabs
    // never open it). It publishes a repaint hook when it is.
    FLEET.repaintDashboard?.();
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


  /* ── The seam between this file and its siblings (creel-hun) ──────
   *
   * creel-fleet.js was one 1150-line closure. It is now three files and
   * three closures, sharing this one object. Everything on it is internal to
   * the fleet layer and unstable; the public surface stays window.CreelFleet.
   *
   * What deliberately does NOT cross: currentLeaseTaskId and its lock
   * resolver. Those two decide whether this tab owns a task, and they only
   * stay in agreement if one place changes them — so the seam carries
   * heldLease() and releaseLease() instead, and the variables stay in the
   * claim loop where they belong.
   *
   * `tools` and `impl` are created empty and filled by creel-fleet-tools.js;
   * they are mutated in place, never reassigned, because CreelFleet.handle
   * below closes over these exact objects.
   */
  const FLEET = {
    tools: [],       // MCP tool schemas       (filled by creel-fleet-tools.js)
    impl: {},        // tool name → handler    (filled by creel-fleet-tools.js)
  };
  window.CreelFleetInternal = FLEET;

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
            return reply({ tools: FLEET.tools });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!FLEET.impl[name]) return fail(`unknown tool: ${name}`);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await FLEET.impl[name](args || {})) }] });
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
      if (e.data?.type === 'abort' && e.data.id === MY_TASK_ID) {
        // The app is closing us on purpose — no leave-site dialog.
        window.__creelSuppressLeaveWarn = true;
        window.close();
      }
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
        // Someone else took it between the lock and the re-read. Drop the
        // lock directly: currentLeaseTaskId was never set, so releaseLease
        // has nothing to match on.
        if (releaseCurrentTaskLock) { releaseCurrentTaskLock(); releaseCurrentTaskLock = null; }
        continue;
      }
      fresh.status = 'running';
      fresh.claimedBy = MY_WORKER_ID;
      fresh.startedAt = Date.now();
      fresh.lastHeartbeat = Date.now();
      fresh.tokenStart = readTokenCounters();
      await putTask(fresh);
      FLEET.digestAdd('claimed', fresh);
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
      if (e.data?.type === 'abort' && e.data.id === MY_WORKER_ID) {
        // The app is closing us on purpose — no leave-site dialog.
        window.__creelSuppressLeaveWarn = true;
        window.close();
      }
      // New work while idle → claim it.
      if (e.data?.type === 'update' && !currentLeaseTaskId) {
        setTimeout(() => { if (!currentLeaseTaskId) claimNext(); }, 500 + Math.random() * 1000);
      }
    });
    setTimeout(claimNext, 2500);
  }


  // Everything the siblings need. Assigned last, so every name below is
  // defined by the time creel-fleet-tools.js runs.
  Object.assign(FLEET, {
    BC, DB_NAME, DRAIN_ID, TASK_LOCK, LOCK_PREFIX,
    MY_TASK_ID, MY_WORKER_ID, myLabelPromise,
    putTask, getTask, allTasks, delTask, genId, notify,
    requeueStale, staleLeases, isDraining, statusReport,
    aliveLocks, heldTaskLocks, isMeta, wrapTask,
    heldLease, releaseLease, claimNext, startHeartbeat, stopHeartbeat,
    readTokenCounters, deviceInfo, tabCap, runningCount, resolveCaps, spawnWindow, lastSpawnOutcome,
    inbox, commsLog, logComms, injectTask,
    agentBoot, workerBoot, refreshLiveMirror,
    CreelFleet,
  });
})();
