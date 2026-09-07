/* creel — the measurement: does free grounding rescue a cheap model?
 *
 * VISION v2's bet, made testable. An in-page 'bench' MCP server that runs the
 * same grounding-sensitive task suite three ways and reports success rate and
 * cost-per-completed-task:
 *
 *   ungrounded-cheap  deepseek-v4-flash, empty graph   (baseline)
 *   grounded-cheap    deepseek-v4-flash, seeded graph  (the treatment)
 *   frontier          deepseek-v4-pro,   empty graph   (the ceiling)
 *
 * The tasks are designed so their answers depend on facts that only exist in
 * the seeded graph — so an ungrounded model must guess while a grounded one
 * queries for free. That gap, priced against the frontier arm, is the bet.
 *
 * This module is the harness, not the run: bench_seed loads the knowledge,
 * bench_tasks yields the prompts (to enqueue as a fleet burst), bench_grade
 * scores an answer objectively, bench_record logs a row, bench_report does
 * the cost math. The actual LLM calls happen through creel's real agent loop
 * (that is the point — measure the real harness), so a run costs real tokens
 * and needs the operator's key. See docs/measurement.md for the protocol.
 */
(function () {
  'use strict';

  // ── the suite: a synthetic service fleet, grounding-sensitive ────
  // Entity names exist ONLY here, so without the seed a model cannot know the
  // dependency graph, the incidents, or the decisions — it can only guess.
  const SUITE = {
    version: 'bench-v1',
    seed: {
      // Each becomes a quipu episode. nodes/edges build the graph the tasks probe.
      episodes: [
        {
          name: 'fleet-topology',
          body: 'The Kestrel platform runs six services. gateway fronts all traffic and calls auth and search. auth calls ledger. billing calls ledger and notify. search calls ledger. notify calls nothing. ledger is the shared system of record.',
          nodes: [
            { name: 'gateway', type: 'Service', description: 'edge/front door for all traffic' },
            { name: 'auth', type: 'Service', description: 'authentication service' },
            { name: 'billing', type: 'Service', description: 'billing and invoicing' },
            { name: 'search', type: 'Service', description: 'catalog search' },
            { name: 'notify', type: 'Service', description: 'notifications' },
            { name: 'ledger', type: 'Service', description: 'shared system of record' },
          ],
          edges: [
            { source: 'gateway', target: 'auth', relation: 'calls' },
            { source: 'gateway', target: 'search', relation: 'calls' },
            { source: 'auth', target: 'ledger', relation: 'calls' },
            { source: 'billing', target: 'ledger', relation: 'calls' },
            { source: 'billing', target: 'notify', relation: 'calls' },
            { source: 'search', target: 'ledger', relation: 'calls' },
          ],
        },
        {
          name: 'incident-K17',
          body: 'Incident K17: login failed platform-wide. Root cause was deployment d-4471, which shipped a ledger schema change that auth could not read. Resolved by rolling back d-4471.',
          nodes: [
            { name: 'K17', type: 'Incident', description: 'platform-wide login failure' },
            { name: 'd-4471', type: 'Deployment', description: 'ledger schema change' },
          ],
          edges: [
            { source: 'd-4471', target: 'ledger', relation: 'targets' },
            { source: 'd-4471', target: 'K17', relation: 'caused' },
          ],
        },
        {
          name: 'incident-K23',
          body: 'Incident K23: duplicate invoices. Root cause was deployment d-4490 to billing that retried on a timeout without idempotency. Two incidents have now involved billing indirectly through ledger.',
          nodes: [
            { name: 'K23', type: 'Incident', description: 'duplicate invoices' },
            { name: 'd-4490', type: 'Deployment', description: 'billing retry change' },
          ],
          edges: [
            { source: 'd-4490', target: 'billing', relation: 'targets' },
            { source: 'd-4490', target: 'K23', relation: 'caused' },
          ],
        },
        {
          name: 'decision-D9',
          body: 'Decision D9 (ratified): billing must never call auth synchronously; any identity check billing needs must be read from ledger, because a synchronous billing->auth call reintroduces the K17 blast radius.',
          nodes: [{ name: 'D9', type: 'Decision', description: 'billing must not call auth synchronously' }],
          edges: [
            { source: 'D9', target: 'billing', relation: 'governs' },
            { source: 'D9', target: 'auth', relation: 'governs' },
          ],
        },
        {
          name: 'ownership',
          body: 'ledger is owned by the Core team. auth and gateway are owned by the Edge team. billing and notify are owned by the Money team. search is owned by the Edge team.',
          nodes: [
            { name: 'Core-team', type: 'Team', description: 'owns ledger' },
            { name: 'Edge-team', type: 'Team', description: 'owns auth, gateway, search' },
            { name: 'Money-team', type: 'Team', description: 'owns billing, notify' },
          ],
          edges: [
            { source: 'Core-team', target: 'ledger', relation: 'owns' },
            { source: 'Edge-team', target: 'auth', relation: 'owns' },
            { source: 'Edge-team', target: 'gateway', relation: 'owns' },
            { source: 'Edge-team', target: 'search', relation: 'owns' },
            { source: 'Money-team', target: 'billing', relation: 'owns' },
            { source: 'Money-team', target: 'notify', relation: 'owns' },
          ],
        },
      ],
    },
    // Each task: a prompt that needs the seed, plus a machine-checkable key.
    // grade types: set (unordered names), exact (one token), contains (phrase),
    // numeric (a number), judge (needs an LLM/human — no objective key).
    tasks: [
      { id: 't1', prompt: 'In the Kestrel platform, which services does gateway directly call? Answer with a comma-separated list of service names.', grade: 'set', key: ['auth', 'search'] },
      { id: 't2', prompt: 'Which service is the shared system of record that most other Kestrel services call?', grade: 'exact', key: 'ledger' },
      { id: 't3', prompt: 'Which deployment caused incident K17?', grade: 'exact', key: 'd-4471' },
      { id: 't4', prompt: 'If the ledger service changes, which Kestrel services are directly or transitively impacted (i.e. depend on ledger)? Comma-separated service names.', grade: 'set', key: ['auth', 'billing', 'search', 'gateway'] },
      { id: 't5', prompt: 'What does decision D9 forbid? Answer in one short phrase.', grade: 'contains', key: 'synchronous' },
      { id: 't6', prompt: 'Which team owns the ledger service?', grade: 'exact', key: 'Core-team' },
      { id: 't7', prompt: 'How many incidents (K-numbered) are recorded for the Kestrel platform?', grade: 'numeric', key: 2 },
      { id: 't8', prompt: 'Incident K17 was a login failure. Given the dependency graph, explain why a ledger deployment could break login, and name the service in the middle of that chain.', grade: 'contains', key: 'auth' },
      { id: 't9', prompt: 'A proposed change makes billing call auth synchronously for an identity check. Does this violate a ratified decision? If so, which one, and what should billing read instead?', grade: 'contains', key: 'ledger' },
      { id: 't10', prompt: 'Which services does the Edge team own? Comma-separated.', grade: 'set', key: ['auth', 'gateway', 'search'] },
      { id: 't11', prompt: 'Summarize the risk of changing ledger for the Kestrel platform, citing the incident and the decision that make it high-blast-radius.', grade: 'judge', key: 'Should reference K17 (login failure from a ledger deploy) and D9 (billing/auth constraint) and note ledger is depended on by most services.' },
    ],
  };

  // DeepSeek v4 pricing (USD per 1M tokens), editable. Frontier defaults to pro.
  const PRICES = {
    'deepseek-v4-flash': { in: 0.14, out: 0.28 },
    'deepseek-v4-pro': { in: 0.435, out: 0.87 },
  };
  const priceFor = (model) => PRICES[model] || { in: 0, out: 0 };

  // ── results store (IndexedDB) ────────────────────────────────────
  const DB = 'creel_bench';
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('rows', { keyPath: 'k' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function putRow(row) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('rows', 'readwrite');
      tx.objectStore('rows').put(row);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }
  async function allRows() {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction('rows').objectStore('rows').getAll();
      q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
    });
  }
  async function clearRows() {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('rows', 'readwrite');
      tx.objectStore('rows').clear();
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  // ── grading ──────────────────────────────────────────────────────
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function grade(task, answer) {
    const a = norm(answer);
    switch (task.grade) {
      case 'exact':
        return { pass: norm(answer).split(' ').includes(norm(task.key)) || a === norm(task.key), objective: true };
      case 'contains':
        return { pass: a.includes(norm(task.key)), objective: true };
      case 'numeric': {
        const nums = (String(answer).match(/-?\d+(\.\d+)?/g) || []).map(Number);
        return { pass: nums.includes(Number(task.key)), objective: true };
      }
      case 'set': {
        const want = task.key.map(norm);
        const got = new Set(a.split(/[ ,]+/).filter(Boolean));
        // Pass = every expected name present (extra guesses are penalized only
        // if they include wrong service names from the known universe).
        const missing = want.filter((w) => !got.has(w));
        return { pass: missing.length === 0, objective: true, missing };
      }
      case 'judge':
        return { pass: null, objective: false, needsJudge: true, rubric: task.key };
      default:
        return { pass: null, objective: false };
    }
  }

  // ── tools ────────────────────────────────────────────────────────
  const TOOLS = [
    { name: 'bench_info', description: 'Explain the measurement: the three arms (ungrounded-cheap, grounded-cheap, frontier), the grounding-sensitive task suite, the price table, and how to run it. Start here.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'bench_seed', description: 'Load the suite\'s knowledge into the shared quipu graph (the GROUNDED arm setup). For the ungrounded/frontier arms, run on a fresh browser profile (empty OPFS) and do NOT seed. Returns episodes loaded.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'bench_tasks', description: 'The task prompts (no answers) — enqueue these as a fleet burst (fleet_enqueue) for the arm under test.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'bench_grade', description: 'Objectively grade an agent\'s answer to a task. Returns {pass} for objective tasks, or {needsJudge, rubric} for judged ones.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, answer: { type: 'string' } }, required: ['taskId', 'answer'] } },
    { name: 'bench_record', description: 'Record one measured result row: which arm/model, task, pass/fail, and token usage. Call once per task per arm.', inputSchema: { type: 'object', properties: { arm: { type: 'string', description: 'ungrounded-cheap | grounded-cheap | frontier' }, model: { type: 'string' }, taskId: { type: 'string' }, pass: { type: 'boolean' }, inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' } }, required: ['arm', 'model', 'taskId', 'pass'] } },
    { name: 'bench_report', description: 'Aggregate all recorded rows into the results table: per-arm success rate, total cost, and cost per COMPLETED task. This is the measurement.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'bench_reset', description: 'Clear all recorded bench result rows (does not touch the quipu graph).', inputSchema: { type: 'object', properties: {}, required: [] } },
  ];

  const impl = {
    async bench_info() {
      return {
        suite: SUITE.version,
        bet: 'small, cheap models become viable agents when grounding is local and free (VISION v2)',
        arms: [
          { arm: 'ungrounded-cheap', model: 'deepseek-v4-flash', graph: 'empty', role: 'baseline' },
          { arm: 'grounded-cheap', model: 'deepseek-v4-flash', graph: 'seeded (bench_seed)', role: 'treatment' },
          { arm: 'frontier', model: 'deepseek-v4-pro', graph: 'empty', role: 'ceiling' },
        ],
        tasks: SUITE.tasks.length,
        prices_usd_per_1m: PRICES,
        metric: 'cost per COMPLETED task = (input*in_price + output*out_price) / tasks_passed',
        howto: 'per arm: set the model (ui_set_model), seed or use a clean profile, fleet_enqueue bench_tasks, run, bench_grade each answer, bench_record it. Then bench_report. Full protocol in docs/measurement.md.',
      };
    },
    async bench_seed() {
      if (!window.CreelQuipu) throw new Error('quipu unavailable in this tab');
      await window.CreelQuipu.ensureWasm();
      const call = (n, a) => window.CreelQuipu.provider.callTool(n, a);
      // Idempotent: skip if the topology marker is already present.
      const exists = await call('quipu_query', { query: 'SELECT ?s WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "fleet-topology" } LIMIT 1' });
      if (exists.count > 0) return { seeded: false, reason: 'already seeded', episodes: SUITE.seed.episodes.length };
      for (const ep of SUITE.seed.episodes) {
        await call('quipu_episode', { name: ep.name, episode_body: ep.body, source: 'bench', nodes: ep.nodes, edges: ep.edges });
      }
      return { seeded: true, episodes: SUITE.seed.episodes.length, hint: 'grounded arm ready; agents can quipu_query / quipu_cord the Kestrel graph' };
    },
    async bench_tasks() {
      return { count: SUITE.tasks.length, tasks: SUITE.tasks.map((t) => ({ id: t.id, prompt: t.prompt })) };
    },
    async bench_grade(args) {
      const task = SUITE.tasks.find((t) => t.id === args.taskId);
      if (!task) throw new Error(`no task ${args.taskId}`);
      return { taskId: task.id, ...grade(task, args.answer) };
    },
    async bench_record(args) {
      await putRow({
        k: `${args.arm}:${args.taskId}`,
        arm: args.arm, model: args.model, taskId: args.taskId,
        pass: !!args.pass, inputTokens: args.inputTokens || 0, outputTokens: args.outputTokens || 0,
      });
      return { ok: true, recorded: `${args.arm}:${args.taskId}` };
    },
    async bench_report() {
      const rows = await allRows();
      if (!rows.length) return { rows: 0, hint: 'no results recorded yet — run the arms and bench_record each task' };
      const byArm = {};
      for (const r of rows) {
        const a = byArm[r.arm] || (byArm[r.arm] = { arm: r.arm, model: r.model, n: 0, passed: 0, inTok: 0, outTok: 0 });
        a.n++; if (r.pass) a.passed++; a.inTok += r.inputTokens; a.outTok += r.outputTokens; a.model = r.model;
      }
      const table = Object.values(byArm).map((a) => {
        const p = priceFor(a.model);
        const cost = (a.inTok / 1e6) * p.in + (a.outTok / 1e6) * p.out;
        return {
          arm: a.arm, model: a.model, tasks: a.n, passed: a.passed,
          successRate: +(a.passed / a.n).toFixed(3),
          totalTokens: a.inTok + a.outTok,
          costUsd: +cost.toFixed(5),
          costPerCompletedUsd: a.passed ? +(cost / a.passed).toFixed(5) : null,
        };
      });
      // The headline: grounded-cheap cost/completed vs frontier's.
      const g = table.find((t) => t.arm === 'grounded-cheap');
      const f = table.find((t) => t.arm === 'frontier');
      const verdict = (g && f && g.costPerCompletedUsd && f.costPerCompletedUsd)
        ? `grounded-cheap costs ${(f.costPerCompletedUsd / g.costPerCompletedUsd).toFixed(1)}x less per completed task than frontier, at ${(g.successRate * 100).toFixed(0)}% vs ${(f.successRate * 100).toFixed(0)}% success`
        : 'record all three arms for the headline comparison';
      return { table, verdict };
    },
    async bench_reset() { await clearRows(); return { ok: true, cleared: true }; },
  };

  const CreelBench = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize': return reply({ protocolVersion: body.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'bench', version: '0' } });
          case 'notifications/initialized': return null;
          case 'tools/list': return reply({ tools: TOOLS });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!impl[name]) return fail(`unknown tool: ${name}`);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await impl[name](args || {})) }] });
          }
          default: return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) { return fail(e && e.message ? e.message : String(e)); }
    },
    registerDefaults() {
      window.CreelInpage.register('inpage:bench', this);
      if (typeof mcpServers !== 'undefined' && !mcpServers.find((s) => s.id === 'mcp_bench_inpage')) {
        mcpServers.push({ id: 'mcp_bench_inpage', name: 'bench', type: 'inpage', url: 'inpage:bench', token: '', corsProxy: '', enabled: true });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = (typeof mcpServers !== 'undefined') && mcpServers.find((s) => s.id === 'mcp_bench_inpage');
      if (server && typeof mcpConnectServer === 'function') mcpConnectServer(server).catch(() => {});
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
    // Exposed for the headless harness self-test.
    _suite: SUITE, _grade: grade,
  };
  window.CreelBench = CreelBench;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelBench.registerDefaults());
  } else {
    CreelBench.registerDefaults();
  }
})();
