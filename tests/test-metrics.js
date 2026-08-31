/* creel — test-metrics.js (aegis-q9lh3): the Prometheus exposition.
 * Zero dependencies. Run: node tests/test-metrics.js
 *
 * `exposition` is pure, so every case here is a full statement of a world.
 *
 * What is worth reading if you change this file:
 *
 *   · THE ABSENCE CASES. They are the reason this module exists. A metric that
 *     reports 0 for something never measured is the `up=1`-while-dead class in
 *     miniature, and it fails in the reassuring direction — a flat green line
 *     on a dashboard for a signal nobody is producing. The pair
 *     `absent_evidence_emits_nothing` / `measured_false_emits_zero` is what
 *     keeps those two facts apart, and they must both stay.
 *   · THE UNKNOWN CASE. The doctor has three verdicts and Prometheus gauges
 *     naturally have two. If `unknown` ever collapses into pass or fail here,
 *     the projection has started lying about a blind instrument.
 *   · THE DOCTOR CONTRACT CASE. `evidence` is NOT on the doctor's record — it
 *     is passed alongside. That test is here because the first draft of this
 *     module read `record.evidence`, found nothing, and silently emitted no
 *     fleet or storage series at all: correct-looking output, no error, and the
 *     most functional half of the payload missing. Nothing but composing the
 *     two modules for real would have caught it.
 *   · THE ESCAPING CASE. One unescaped quote corrupts every series after it, so
 *     a single bad label is a whole-scrape failure rather than one bad value.
 */
'use strict';

const assert = require('assert');
const M = require('../app/creel-metrics.js');
const D = require('../app/creel-doctor.js');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

const lines = (text) => text.split('\n').filter(Boolean);
const seriesFor = (text, name) =>
  lines(text).filter((l) => !l.startsWith('#') && (l === name || l.startsWith(`${name} `) || l.startsWith(`${name}{`)));

/** A doctor record with nothing but the aggregate — the minimum a caller has. */
const bareRecord = () => ({
  contract: 'creel.doctor/1',
  code: 0,
  summary: { pass: 2, fail: 0, unknown: 0, required_fail: 0, required_unknown: 0 },
  checks: [],
});

/* ── the rule this module exists to hold ─────────────────────────────────── */

{
  /* absent evidence emits NOTHING */
  const text = M.render(bareRecord(), {});
  eq(seriesFor(text, 'creel_fleet_leases'), [], 'no fleet evidence must emit no fleet series');
  eq(seriesFor(text, 'creel_storage_persisted'), [], 'no storage evidence must emit no persisted series');
  eq(seriesFor(text, 'creel_tabs'), [], 'no roster count must emit no tabs series');
  /* Every evidence-derived series, enumerated. A blanket "no zeros anywhere"
   * assertion would be wrong — the doctor's own aggregate of 0 is MEASURED and
   * must be emitted — so the list is explicit, and a new evidence-derived
   * metric belongs in it. */
  for (const name of [
    'creel_fleet_leases', 'creel_tabs',
    'creel_storage_persisted', 'creel_storage_usage_megabytes', 'creel_storage_quota_megabytes',
    'creel_admission_exit', 'creel_setpoint_recommended_delta',
    'creel_shares_pushed_total', 'creel_attestations_signed_total',
  ]) {
    ok(!text.includes(name), `${name} must be wholly absent — HELP and TYPE included — when nothing measured it`);
  }
  eq(seriesFor(text, 'creel_doctor_code'), ['creel_doctor_code 0'],
    'the doctor aggregate of 0 is MEASURED and must still be emitted — the contrast that makes the absences above mean something');
}

{
  /* measured false emits ZERO — the other half of the pair */
  const text = M.render(bareRecord(), { evidence: { storage: { persisted: false } }, tabs: 0 });
  eq(seriesFor(text, 'creel_storage_persisted'), ['creel_storage_persisted 0'],
    'a MEASURED false is a real zero and must be emitted');
  eq(seriesFor(text, 'creel_tabs'), ['creel_tabs 0'],
    'a measured roster of zero is a fact, not an absence');
}

/* ── the doctor's third verdict survives the projection ──────────────────── */

{
  const record = Object.assign(bareRecord(), {
    code: 2,
    summary: { pass: 1, fail: 0, unknown: 1, required_fail: 0, required_unknown: 1 },
    checks: [
      { id: 'quipu-wasm', status: 'pass', severity: 'required' },
      { id: 'popups', status: 'unknown', severity: 'advisory' },
    ],
  });
  const text = M.render(record, {});
  ok(text.includes('creel_doctor_check{id="popups",severity="advisory",status="unknown"} 1'),
    'unknown must survive as a label rather than collapsing into a 1/0 gauge');
  ok(text.includes('creel_doctor_checks{outcome="required_unknown"} 1'),
    'a blind REQUIRED check must be countable on its own');
  eq(seriesFor(text, 'creel_doctor_code'), ['creel_doctor_code 2'],
    'aggregate 2 (blind) must not be reported as 1 (diagnosed failure)');
}

/* ── the contract with creel-doctor.js ───────────────────────────────────── */

{
  /* Compose the two modules for real. `evidence` lives beside the record, not
   * on it; reading it off the record yields a payload that looks fine and has
   * lost every functional series. */
  const evidence = {
    secureContext: true,
    quipu: { bound: true, persistence: 'opfs' },
    provider: { id: 'anthropic', keyPresent: true },
    fleet: { liveLeases: 3, staleLeases: [{ id: 't1', reason: 'tab gone' }] },
    storage: { persisted: true, usageMB: 40, quotaMB: 1000 },
  };
  const record = D.evaluate(evidence);
  ok(record.evidence === undefined,
    'guard: the doctor record does not carry evidence — if this ever changes, the fallback path in findEvidence is live and wants its own test');

  const text = M.render(record, { evidence });
  eq(seriesFor(text, 'creel_fleet_leases'),
    ['creel_fleet_leases{state="live"} 3', 'creel_fleet_leases{state="stale"} 1'],
    'the fleet signal must survive a real doctor record');
  eq(seriesFor(text, 'creel_storage_usage_megabytes'), ['creel_storage_usage_megabytes 40'],
    'storage evidence must survive a real doctor record');
  ok(text.includes('doctor_contract="creel.doctor/1"'),
    'the projection must name the doctor contract it read');
  eq(seriesFor(text, 'creel_doctor_code'), [`creel_doctor_code ${record.code}`],
    'the aggregate must be the doctor’s own, not recomputed');
}

{
  /* A credential must not reach the payload even when the caller hands over the
   * whole evidence object. The doctor collects booleans only; this asserts the
   * property of the SERIALISED text, because a leak is whatever ends up in it. */
  const evidence = { provider: { id: 'anthropic', keyPresent: true, apiKey: 'sk-live-SHOULD-NEVER-APPEAR' } };
  const text = M.render(D.evaluate(evidence), { evidence });
  ok(!text.includes('sk-live-SHOULD-NEVER-APPEAR'), 'no credential may appear in the exposition');
}

/* ── escaping: one bad label must not corrupt the payload ────────────────── */

{
  eq(M.escapeLabel('a"b'), 'a\\"b', 'a double quote is escaped');
  eq(M.escapeLabel('a\\b'), 'a\\\\b', 'a backslash is escaped');
  eq(M.escapeLabel('a\nb'), 'a\\nb', 'a newline is escaped');
  /* Backslash first, or escaping the quote would then escape its own escape. */
  eq(M.escapeLabel('a\\"b'), 'a\\\\\\"b', 'backslash and quote together stay unambiguous');

  const record = Object.assign(bareRecord(), {
    build: 'b"1\nmalicious_metric 9',
    checks: [{ id: 'x"y', status: 'pass', severity: 'advisory' }],
  });
  const text = M.render(record, {});
  ok(!/^malicious_metric/m.test(text), 'a newline in a label must not forge a new series');
  for (const l of lines(text)) {
    if (l.startsWith('#')) continue;
    const body = l.slice(0, l.lastIndexOf(' '));
    const quotes = (body.match(/(?<!\\)"/g) || []).length;
    ok(quotes % 2 === 0, `unbalanced quotes would corrupt the rest of the scrape: ${l}`);
  }
}

/* ── determinism ─────────────────────────────────────────────────────────── */

{
  const world = () => ({
    record: Object.assign(bareRecord(), {
      checks: [
        { id: 'zeta', status: 'pass', severity: 'advisory' },
        { id: 'alpha', status: 'fail', severity: 'required' },
      ],
    }),
    extra: { evidence: { storage: { quotaMB: 5, persisted: true, usageMB: 1 } }, tabs: 2 },
  });
  const a = M.render(world().record, world().extra);
  const b = M.render(world().record, world().extra);
  eq(a, b, 'the same world must render byte-identically');

  const checkLines = seriesFor(a, 'creel_doctor_check');
  eq(checkLines, checkLines.slice().sort(), 'check series must be emitted in a stable order');
  ok(a.includes('creel_doctor_check{id="alpha",severity="required",status="fail"} 1'),
    'labels within a series are emitted in sorted key order');
}

/* ── exposition well-formedness ──────────────────────────────────────────── */

{
  const text = M.render(bareRecord(), {
    evidence: { fleet: { liveLeases: 1, staleLeases: [] }, storage: { persisted: true } },
    tabs: 1, admissionExit: 0, recommendedDelta: -2, sharesPushed: 7, attestationsSigned: 7,
  });
  const declared = new Set();
  const typed = new Set();
  for (const l of lines(text)) {
    if (l.startsWith('# HELP ')) declared.add(l.split(' ')[2]);
    else if (l.startsWith('# TYPE ')) typed.add(l.split(' ')[2]);
    else {
      const name = l.split(/[ {]/)[0];
      ok(declared.has(name) && typed.has(name), `${name} emitted before its HELP/TYPE`);
    }
  }
  for (const n of declared) ok(typed.has(n), `${n} has HELP but no TYPE`);
  ok(text.endsWith('\n'), 'exposition ends with a newline');
  ok(text.includes('# TYPE creel_shares_pushed_total counter'), 'a cumulative total is a counter');
  ok(text.includes('# TYPE creel_fleet_leases gauge'), 'a level is a gauge');
  for (const l of lines(text)) {
    if (l.startsWith('#')) continue;
    ok(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? -?[0-9+][^ ]*$/.test(l) || /^[^ ]+ -?\d+(\.\d+)?$/.test(l),
      `not a well-formed sample: ${l}`);
  }
  eq(seriesFor(text, 'creel_setpoint_recommended_delta'), ['creel_setpoint_recommended_delta -2'],
    'a negative recommendation must survive; shedding is a real verdict');
}

{
  /* Nothing known at all renders NOTHING — not a skeleton of zeros, and not a
   * lone `creel_up 1`, which is precisely the signal wou8k was written against. */
  const text = M.exposition({});
  ok(!text.includes('creel_doctor_code'), 'an empty snapshot invents no aggregate');
  ok(!/\bcreel_up\b/.test(text), 'there is deliberately no bare liveness metric');
}

{
  /* A metric name is never taken from data, and the guard says so out loud. */
  assert.throws(() => M.series('creel bad name', {}, 1), /invalid metric name/,
    'an invalid metric name must throw rather than emit a corrupt line');
  checks++;
  eq(M.series('creel_x', { b: 2, a: 1 }, 3), 'creel_x{a="1",b="2"} 3', 'labels sort by key');
  eq(M.series('creel_x', { a: undefined, b: null, c: 0 }, 1), 'creel_x{c="0"} 1',
    'an undefined or null label is dropped, but a zero is a value');
}

/* ── the collector, and the surface something can actually call ──────────── */

{
  /* `collect` runs the DOCTOR'S collector once and keeps both halves. Injecting
   * a fake doctor is what proves it does not probe on its own — a second probe
   * would show up here as a second call. */
  let collectCalls = 0;
  const evidence = { secureContext: true, fleet: { liveLeases: 5, staleLeases: [] } };
  const doctor = {
    collect: async () => { collectCalls++; return evidence; },
    evaluate: (e) => { eq(e, evidence, 'the record is evaluated from the SAME evidence that is projected'); return bareRecord(); },
  };
  const self = { roster: async () => [{ tab: 'a' }, { tab: 'b' }] };

  (async () => {
    const { record, extra } = await M.collect({ doctor, self });
    eq(collectCalls, 1, 'exactly one collection — metrics must not probe the browser a second time');
    eq(extra.evidence, evidence, 'the evidence is carried beside the record');
    eq(extra.tabs, 2, 'roster size is read from CreelSelf');
    ok(record && typeof record.code === 'number', 'the doctor record comes back intact');

    const text = await M.run({ doctor, self });
    eq(seriesFor(text, 'creel_fleet_leases'), ['creel_fleet_leases{state="live"} 5', 'creel_fleet_leases{state="stale"} 0'],
      'the collected fleet evidence reaches the exposition');

    /* A roster that throws is an ABSENT tab count, never a zero — the same rule
     * the doctor applies to every source it cannot reach. */
    const blind = await M.run({ doctor, self: { roster: async () => { throw new Error('no channel'); } } });
    ok(!blind.includes('creel_tabs'), 'a roster that could not be read emits no tabs series');

    /* No doctor at all: nothing to project, and it says nothing rather than
     * inventing a healthy-looking skeleton. */
    const nothing = await M.run({ doctor: null });
    ok(!nothing.includes('creel_doctor_code'), 'with no doctor there is no aggregate to report');
    ok(!nothing.includes('creel_fleet_leases'), 'with no doctor there are no fleet series');

    /* The MCP surface, because an exporter nothing calls exports nothing. */
    const listed = await M.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    eq(listed.result.tools.map((x) => x.name), ['metrics_export'], 'the tool is listed under its durable name');
    const bad = await M.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } });
    ok(bad.error && /unknown tool/.test(bad.error.message), 'an unknown tool fails rather than returning empty text');
    const called = await M.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'metrics_export' } });
    ok(typeof called.result.content[0].text === 'string', 'tools/call returns exposition text');
    eq(await M.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'the notification is acknowledged with no reply');

    console.log(`ok — test-metrics.js: ${checks} checks passed`);
  })();
}
