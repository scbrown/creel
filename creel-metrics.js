/* creel — app/creel-metrics.js: Prometheus exposition for a page with no server.
 *
 * Requested on aegis-q9lh3 (child of the stack-metrics epic aegis-wou8k), whose
 * premise is FUNCTIONAL verification: a component that answers with real
 * work-signals proves it is DOING its job, not merely alive. The `up=1`-while-
 * dead class is the thing being defended against, so nothing here reports a
 * number it did not measure.
 *
 * ── WHY CREEL PUSHES AND IS NOT SCRAPED ─────────────────────────────────────
 *
 * creel is a static page. There is no listener to scrape, no address to point a
 * job at, and adding one would delete `server-none` — the property the README
 * calls the bet. That is not a shortfall to be worked around: a creel tab is the
 * same SHAPE of producer as a Shantytown agent (ephemeral, no listener), and
 * Shantytown already solved it by pushing rather than by being scraped. Parity
 * therefore means the same push path, which is why this module's job ends at
 * producing exposition TEXT. Who ships it — the local sidecar, or the extension
 * service worker, both of which hold an address and a credential the page must
 * never see — is the transport's business and deliberately not this file's.
 *
 * ── ONE COLLECTOR, TWO READERS ──────────────────────────────────────────────
 *
 * `snapshot()` probes nothing. It takes the doctor's evaluated RECORD and the
 * very EVIDENCE that record was evaluated from — both produced by one
 * `CreelDoctor.collect()` — and projects them. `creel-doctor.js` already states
 * the rule for this codebase: the fleet exposes the PREDICATE separately from
 * the action, "one rule, two readers — because a second copy of a staleness
 * rule disagrees with the first exactly when it matters". A second collector
 * would disagree with the doctor exactly when an operator is comparing the two,
 * which is exactly when they are looking at both. So metrics are a PROJECTION
 * of the doctor and cannot drift from it.
 *
 * The evidence is passed in rather than read off the record because the record
 * deliberately does not carry it — the doctor's contract with CABOODLE is
 * `{contract, at, build, ok, code, summary, checks}` and widening it here would
 * be a breaking change made for a reader's convenience. The caller already
 * holds the evidence; it ran `collect()` to get the record.
 *
 * ── ABSENT EVIDENCE OMITS THE SERIES. IT NEVER EMITS A ZERO ─────────────────
 *
 * The single rule this file exists to hold. `0` and "never measured" are
 * different facts and an operator needs opposite responses to them; a dashboard
 * that renders a fabricated zero as a flat green line is the reassuring
 * direction, which is the dangerous one. Prometheus already has the right
 * answer — an absent series is absent, and `absent()` is a first-class query —
 * so the honest projection of "I could not look" is to say nothing at all.
 *
 * The doctor's third verdict survives the same way. A per-check gauge valued
 * 1/0 can only say pass or fail, so `unknown` would be flattened into `fail`
 * (alarming, wrong) or `pass` (reassuring, worse). Instead each check emits ONE
 * series carrying its status as a LABEL, valued 1 — the same enum-gauge shape
 * as `node_systemd_unit_state`. A blind gauge stays legible as blind.
 *
 * ── OUTPUT IS DETERMINISTIC ─────────────────────────────────────────────────
 *
 * Series are emitted in a fixed order with sorted labels, so two snapshots of
 * the same world are byte-identical. That is what makes the tests statements
 * about content rather than about iteration order, and what makes a diff
 * between two pushes readable.
 */
(function () {
  'use strict';

  const CONTRACT = 'creel.metrics/1';
  const PREFIX = 'creel_';

  /* Prometheus label values are quoted strings in which backslash, double
   * quote and newline must be escaped. Check ids and build strings are ours,
   * but a stale-lease `reason` and a provider id are not necessarily, and a
   * single unescaped quote corrupts every series after it in the payload —
   * a whole-scrape failure caused by one field. Escape at the boundary. */
  function escapeLabel(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }

  /** A metric name must match [a-zA-Z_:][a-zA-Z0-9_:]*; ours are literals, but
   *  this is asserted rather than assumed so a future caller cannot inject. */
  const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

  /* Prometheus spells the non-finite values differently from JavaScript, and
   * `Infinity` in a payload is a parse error rather than a large number. */
  function formatValue(n) {
    if (n === Infinity) return '+Inf';
    if (n === -Infinity) return '-Inf';
    if (Number.isNaN(n)) return 'NaN';
    return String(n);
  }

  /** One series. `labels` is a plain object; keys are emitted sorted. */
  function series(name, labels, value) {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
    const keys = Object.keys(labels || {}).filter((k) => labels[k] !== undefined && labels[k] !== null).sort();
    const rendered = keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',');
    return `${name}${rendered ? `{${rendered}}` : ''} ${formatValue(value)}`;
  }

  /* ── the snapshot: a doctor record projected into countable facts ──────────
   *
   * Total and pure. Every field is optional, and an absent one produces an
   * absent metric rather than a zero.
   *
   *   record  the doctor's evaluated record (`CreelDoctor.evaluate`)
   *   extra   { evidence, tabs, admissionExit, recommendedDelta,
   *             sharesPushed, attestationsSigned } — `evidence` is the object
   *           the record was evaluated FROM; the rest are signals that do not
   *           come from the doctor at all. A caller who has one passes it; a
   *           caller who does not simply omits it and the series is absent.
   */
  function snapshot(record, extra) {
    const r = record || {};
    const e = extra || {};
    const s = { contract: CONTRACT };

    if (r.contract) s.doctorContract = r.contract;
    if (r.build) s.build = r.build;
    if (r.at) s.at = r.at;
    if (typeof r.code === 'number') s.doctorCode = r.code;

    if (r.summary && typeof r.summary === 'object') {
      s.doctorSummary = {};
      for (const k of ['pass', 'fail', 'unknown', 'required_fail', 'required_unknown']) {
        if (typeof r.summary[k] === 'number') s.doctorSummary[k] = r.summary[k];
      }
    }

    if (Array.isArray(r.checks)) {
      s.checks = r.checks
        .filter((c) => c && typeof c.id === 'string' && typeof c.status === 'string')
        .map((c) => ({ id: c.id, status: c.status, severity: c.severity }));
    }

    /* Fleet leases are the clearest "it is doing work" signal creel has: they
     * move whenever a tab takes or drops a task. `staleLeases` is the doctor's
     * evidence field, and it is a LIST there — a length here, because the
     * identities belong in the doctor record and not in a metrics label, where
     * they would be unbounded cardinality. */
    const fleetEv = findEvidence(r, e, 'fleet');
    if (fleetEv) {
      s.fleet = {};
      if (typeof fleetEv.liveLeases === 'number') s.fleet.live = fleetEv.liveLeases;
      if (Array.isArray(fleetEv.staleLeases)) s.fleet.stale = fleetEv.staleLeases.length;
      if (!Object.keys(s.fleet).length) delete s.fleet;
    }

    const storageEv = findEvidence(r, e, 'storage');
    if (storageEv) {
      s.storage = {};
      if (typeof storageEv.persisted === 'boolean') s.storage.persisted = storageEv.persisted;
      if (typeof storageEv.usageMB === 'number') s.storage.usageMB = storageEv.usageMB;
      if (typeof storageEv.quotaMB === 'number') s.storage.quotaMB = storageEv.quotaMB;
      if (!Object.keys(s.storage).length) delete s.storage;
    }

    if (typeof e.tabs === 'number') s.tabs = e.tabs;
    if (typeof e.admissionExit === 'number') s.admissionExit = e.admissionExit;
    if (typeof e.recommendedDelta === 'number') s.recommendedDelta = e.recommendedDelta;
    if (typeof e.sharesPushed === 'number') s.sharesPushed = e.sharesPushed;
    if (typeof e.attestationsSigned === 'number') s.attestationsSigned = e.attestationsSigned;

    return s;
  }

  /* Evidence comes from the caller's `extra.evidence`; a record that happens to
   * carry its own is accepted as a fallback so that a future doctor which does
   * publish evidence needs no change here. Reading through ONE accessor is what
   * keeps a move of that field a one-line change rather than several silent
   * absences — and a silent absence is indistinguishable from a healthy zero
   * everywhere except in this file, which is the whole point of it. */
  function findEvidence(record, extra, key) {
    for (const src of [extra && extra.evidence, record && record.evidence]) {
      const v = src && typeof src === 'object' ? src[key] : undefined;
      if (v && typeof v === 'object') return v;
    }
    return undefined;
  }

  /* ── the exposition ───────────────────────────────────────────────────────
   *
   * Pure: snapshot in, text out. No clock, no storage, no DOM — the same split
   * `creel-doctor.js` and `creel-setpoint.js` make, and for the same reason:
   * every case below can then be stated as a full world under plain node.
   */
  function exposition(snap) {
    const s = snap || {};
    const out = [];
    const emit = (name, help, type, lines) => {
      if (!lines.length) return;                 // absent evidence emits NOTHING
      out.push(`# HELP ${name} ${help}`);
      out.push(`# TYPE ${name} ${type}`);
      for (const l of lines) out.push(l);
    };

    emit(`${PREFIX}build_info`,
      'Always 1. Carries the harness build and contract version as labels.',
      'gauge',
      [series(`${PREFIX}build_info`, {
        contract: s.contract || CONTRACT,
        doctor_contract: s.doctorContract,
        build: s.build,
      }, 1)]);

    emit(`${PREFIX}doctor_code`,
      'Doctor aggregate: 0 ok, 1 a required check FAILED, 2 a required check could not be determined, 3 the doctor could not run.',
      'gauge',
      typeof s.doctorCode === 'number' ? [series(`${PREFIX}doctor_code`, {}, s.doctorCode)] : []);

    emit(`${PREFIX}doctor_checks`,
      'Doctor checks by outcome. `unknown` is a blind gauge, not a pass and not a failure.',
      'gauge',
      s.doctorSummary
        ? Object.keys(s.doctorSummary).sort()
          .map((k) => series(`${PREFIX}doctor_checks`, { outcome: k }, s.doctorSummary[k]))
        : []);

    emit(`${PREFIX}doctor_check`,
      'Always 1. One series per check carrying its status as a label, so `unknown` survives the projection.',
      'gauge',
      (s.checks || [])
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((c) => series(`${PREFIX}doctor_check`, { id: c.id, status: c.status, severity: c.severity }, 1)));

    emit(`${PREFIX}fleet_leases`,
      'Task leases held by agent tabs, by state. Moves whenever a tab takes or drops work.',
      'gauge',
      s.fleet
        ? Object.keys(s.fleet).sort().map((k) => series(`${PREFIX}fleet_leases`, { state: k }, s.fleet[k]))
        : []);

    emit(`${PREFIX}tabs`,
      'Agent tabs currently in the roster.',
      'gauge',
      typeof s.tabs === 'number' ? [series(`${PREFIX}tabs`, {}, s.tabs)] : []);

    emit(`${PREFIX}storage_persisted`,
      '1 when the browser granted persistent storage for the in-page graph, 0 when it did not.',
      'gauge',
      s.storage && typeof s.storage.persisted === 'boolean'
        ? [series(`${PREFIX}storage_persisted`, {}, s.storage.persisted ? 1 : 0)] : []);

    emit(`${PREFIX}storage_usage_megabytes`,
      'Bytes the in-page store reports using, in MB as the browser reports them.',
      'gauge',
      s.storage && typeof s.storage.usageMB === 'number'
        ? [series(`${PREFIX}storage_usage_megabytes`, {}, s.storage.usageMB)] : []);

    emit(`${PREFIX}storage_quota_megabytes`,
      'Storage quota the browser reports for this origin, in MB.',
      'gauge',
      s.storage && typeof s.storage.quotaMB === 'number'
        ? [series(`${PREFIX}storage_quota_megabytes`, {}, s.storage.quotaMB)] : []);

    emit(`${PREFIX}admission_exit`,
      'Admission verdict: 0 admit, 1 refuse on policy, 2 unknown signal, 3 probe error.',
      'gauge',
      typeof s.admissionExit === 'number' ? [series(`${PREFIX}admission_exit`, {}, s.admissionExit)] : []);

    emit(`${PREFIX}setpoint_recommended_delta`,
      'Agent delta the setpoint controller recommends. Negative means shed.',
      'gauge',
      typeof s.recommendedDelta === 'number'
        ? [series(`${PREFIX}setpoint_recommended_delta`, {}, s.recommendedDelta)] : []);

    emit(`${PREFIX}shares_pushed_total`,
      'Knowledge shares this harness has pushed across the trust boundary.',
      'counter',
      typeof s.sharesPushed === 'number'
        ? [series(`${PREFIX}shares_pushed_total`, {}, s.sharesPushed)] : []);

    emit(`${PREFIX}attestations_signed_total`,
      'Share attestations this tab has signed. The fleet-side counterpart is counted where it is VERIFIED, which is the trustworthy number.',
      'counter',
      typeof s.attestationsSigned === 'number'
        ? [series(`${PREFIX}attestations_signed_total`, {}, s.attestationsSigned)] : []);

    return out.length ? `${out.join('\n')}\n` : '';
  }

  /** Convenience: doctor record straight to text. Still pure. */
  function render(record, extra) { return exposition(snapshot(record, extra)); }

  /* ── the only part that touches the browser ───────────────────────────────
   *
   * It probes nothing itself. It runs the DOCTOR'S collector once and keeps
   * both halves — the evidence and the record evaluated from it — which is what
   * makes "one collector, two readers" true in code rather than in a comment.
   * A failure to reach a source is an ABSENT field, never a zero; the doctor's
   * own `collect` already drops what it could not read, and the projection
   * simply has less to say. */
  async function collect(opts) {
    const o = opts || {};
    const tryIt = async (fn) => { try { return await fn(); } catch { return undefined; } };
    const Doctor = o.doctor || (typeof window !== 'undefined' ? window.CreelDoctor : undefined);
    if (!Doctor) return { record: null, extra: {} };

    const evidence = await Doctor.collect(o);
    const record = Doctor.evaluate(evidence);
    const extra = { evidence };

    /* `CreelSelfInternal`, not `CreelSelf`. The public `window.CreelSelf` is the
     * four-field identity card; `roster()` lives on the internal object, the
     * same split `CreelFleetInternal` makes and the same one the doctor reads
     * through. Reaching for the public name returns an object that EXISTS and
     * lacks the method, so the absence is silent — measured by
     * tests/test-metrics-browser.js, which is the only thing that could see it:
     * every unit test passed while the live page reported no tabs at all. */
    const tabs = await tryIt(async () => {
      const S = o.self
        || (typeof window !== 'undefined' ? (window.CreelSelfInternal || window.CreelSelf) : undefined);
      if (!S || typeof S.roster !== 'function') return undefined;
      const r = await S.roster();
      return Array.isArray(r) ? r.length : undefined;
    });
    if (typeof tabs === 'number') extra.tabs = tabs;

    return { record, extra };
  }

  async function run(opts) {
    const { record, extra } = await collect(opts);
    return render(record, extra);
  }

  /* ── the in-page MCP surface: `metrics_export` ────────────────────────────
   *
   * An exporter nothing calls exports nothing, which is the same shape as the
   * doctor's own note above it and the same shape as the failures wou8k was
   * written against. Exposing it as a tool is also what makes the PUSH
   * transport possible without this file knowing anything about transports: a
   * sidecar or the extension bridge calls the tool, gets exposition text, and
   * ships it with a credential the page never holds.
   */
  const TOOLS = [{
    name: 'metrics_export',
    description: 'Render this harness as Prometheus exposition text (creel.metrics/1): doctor '
      + 'aggregate and per-check status, fleet leases, storage persistence and usage, roster '
      + 'size. A signal that was not measured is ABSENT rather than zero, and the doctor\'s '
      + '`unknown` verdict survives as a label. Never contains a credential.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }];

  const api = {
    CONTRACT, PREFIX, TOOLS,
    escapeLabel, series, snapshot, exposition, render, collect, run,
  };

  api.handle = async function handle(body) {
    const reply = (result) => ({ jsonrpc: '2.0', id: body && body.id, result });
    const fail = (message) => ({ jsonrpc: '2.0', id: body && body.id, error: { code: -32601, message } });
    try {
      switch (body && body.method) {
        case 'initialize':
          return reply({
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'metrics', version: '0' },
          });
        case 'notifications/initialized':
          return null;
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call': {
          const name = body.params && body.params.name;
          if (name !== 'metrics_export') return fail(`unknown tool: ${name}`);
          return reply({ content: [{ type: 'text', text: await run() }] });
        }
        default:
          return fail(`method not supported in-page: ${body.method}`);
      }
    } catch (e) {
      return fail(e && e.message ? e.message : String(e));
    }
  };

  api.registerDefaults = function registerDefaults() {
    if (typeof window === 'undefined' || !window.CreelInpage) return;
    window.CreelInpage.register('inpage:metrics', api);
    if (typeof mcpServers === 'undefined') return;
    if (!mcpServers.find((s) => s.id === 'mcp_metrics_inpage')) {
      mcpServers.push({
        id: 'mcp_metrics_inpage', name: 'metrics', type: 'inpage',
        url: 'inpage:metrics', token: '', corsProxy: '', enabled: true,
      });
      if (typeof saveMcpServers === 'function') saveMcpServers();
    }
    const server = mcpServers.find((s) => s.id === 'mcp_metrics_inpage');
    if (server && typeof mcpConnectServer === 'function') {
      mcpConnectServer(server).catch((e) => console.warn('metrics in-page MCP connect failed', e));
    }
    if (typeof renderMcpServerList === 'function') renderMcpServerList();
  };

  if (typeof window !== 'undefined') window.CreelMetrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => api.registerDefaults());
    } else {
      api.registerDefaults();
    }
  }
})();
