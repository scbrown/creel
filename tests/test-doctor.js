/* creel — test-doctor.js (aegis-edp2n.4): the preflight.
 * Zero dependencies. Run: node tests/test-doctor.js
 *
 * `evaluate` is a pure function, so every case here is a full statement of a
 * world and nothing is stubbed — including the worlds you cannot conjure in a
 * real browser on demand: an evicted store, a stale service worker, a lease
 * whose tab has gone.
 *
 * What is worth reading if you change this file:
 *
 *   · THE UNKNOWN CASES. They decide whether a doctor that could not look can
 *     report "fine", which is the only way this thing does real damage. An
 *     installer that gets 0 from a blind probe ships anyway.
 *   · THE REDACTION CASE. It asserts a property of the whole serialised record
 *     rather than of one field, because a leak is whatever ends up in the JSON.
 *   · THE ID LIST. Those ids are a contract with CABOODLE. Changing one is a
 *     breaking change and this test is where that gets noticed.
 */
'use strict';

const assert = require('assert');
const D = require('../app/creel-doctor.js');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

const byId = (record, id) => record.checks.find((c) => c.id === id);

/** A world in which every REQUIRED check passes and nothing else is known. */
function healthy(extra) {
  return Object.assign({
    secureContext: true,
    quipu: { bound: true, persistence: 'opfs' },
    provider: { id: 'anthropic', keyPresent: true },
  }, extra || {});
}

/* ── the contract CABOODLE consumes ──────────────────────────────────────── */

{
  const r = D.evaluate(healthy());
  eq(r.contract, 'creel.doctor/1', 'contract is versioned and stable');
  ok(typeof r.ok === 'boolean' && typeof r.code === 'number', 'aggregate is machine-readable');
  for (const c of r.checks) {
    ok(typeof c.id === 'string' && c.id.length > 0, `${c.id}: durable id`);
    ok(c.status === 'pass' || c.status === 'fail' || c.status === 'unknown',
      `${c.id}: status is pass/fail/unknown`);
    ok(c.severity === 'required' || c.severity === 'advisory',
      `${c.id}: severity is required/advisory`);
    ok(typeof c.evidence === 'string' && c.evidence.length > 0,
      `${c.id}: carries evidence`);
    ok(c.status === 'pass' || typeof c.remediation === 'string',
      `${c.id}: a non-pass carries remediation text`);
  }
  const ids = r.checks.map((c) => c.id);
  eq(new Set(ids).size, ids.length, 'check ids are unique');
  /* PINNED ON PURPOSE. These ids are the contract; renaming one silently breaks
   * a consumer that keys on it, so it should break here first. */
  eq(ids, [
    'secure-context', 'quipu-wasm', 'provider-credential',
    'storage-persistence', 'unsynced-changes', 'service-worker-fresh',
    'popup-permission', 'extension-bridge', 'state-repo', 'fleet-leases',
  ], 'the durable id list');
  ok(JSON.parse(JSON.stringify(r)).contract === D.CONTRACT, 'record round-trips as JSON');
}

/* ── the aggregate: nonzero for a required failure OR a required unknown ──── */

{
  const blind = D.evaluate({});
  eq(blind.code, 2, 'NO EVIDENCE IS NOT A PASS — a blind doctor exits 2');
  ok(!blind.ok, 'and is not ok');
  ok(blind.checks.every((c) => c.status === 'unknown'), 'every check is unknown');
  ok(blind.summary.required_unknown > 0, 'the required unknowns are counted');

  eq(D.evaluate(healthy()).code, 0, 'all required checks passing exits 0');
  ok(D.evaluate(healthy()).ok, 'and is ok');

  const failed = D.evaluate(healthy({ secureContext: false }));
  eq(failed.code, 1, 'a required FAILURE exits 1');
  eq(byId(failed, 'secure-context').status, 'fail', 'and names the check');

  /* FAILURE OUTRANKS UNKNOWN. Both are nonzero; when a run has one of each the
   * operator should be sent to what is definitely broken first. */
  const both = D.evaluate({ secureContext: false, provider: { keyPresent: true } });
  eq(both.summary.required_fail, 1, 'one required failure');
  ok(both.summary.required_unknown > 0, 'and a required unknown alongside it');
  eq(both.code, 1, 'failure outranks unknown in the aggregate');
}

/* ── advisory checks never change the code ───────────────────────────────── */

{
  const world = healthy({
    storage: { persisted: false, usageMB: 12, quotaMB: 300 },
    dirty: { unsynced: 4 },
    extension: { present: false },
    stateRepo: { configured: false },
    popups: { allowed: false },
    fleet: { liveLeases: 0, staleLeases: [{ id: 't1', reason: 'lock-released' }] },
  });
  const r = D.evaluate(world);
  eq(r.code, 0, 'six advisory failures still exit 0');
  ok(r.ok, 'and the run is ok');
  eq(r.summary.fail, 6, 'while being reported, not hidden');
  eq(r.summary.required_fail, 0, 'none of them required');
  ok(byId(r, 'storage-persistence').evidence.includes('12MB of 300MB'),
    'an advisory failure still carries its numbers');
  ok(byId(r, 'fleet-leases').evidence.includes('t1(lock-released)'),
    'and abandoned leases are named with the fleet\'s own reason string');
}

/* ── absent evidence is unknown, never fail ──────────────────────────────── */

{
  const r = D.evaluate(healthy());   // no storage/sw/popup/extension evidence
  for (const id of ['storage-persistence', 'service-worker-fresh',
    'popup-permission', 'extension-bridge', 'state-repo', 'fleet-leases',
    'unsynced-changes']) {
    eq(byId(r, id).status, 'unknown', `${id}: absent evidence -> unknown, NOT fail`);
  }
}

{
  /* A check that throws is a broken INSTRUMENT, not a failing subject.
   * Reporting `fail` here would invent a diagnosis out of our own bug. */
  const saved = D.CHECKS[0].run;
  D.CHECKS[0].run = () => { throw new Error('probe exploded'); };
  try {
    const r = D.evaluate(healthy());
    eq(byId(r, 'secure-context').status, 'unknown', 'a throwing check reports unknown');
    ok(byId(r, 'secure-context').evidence.includes('probe exploded'),
      'and says what went wrong');
    eq(r.code, 2, 'which makes the run blind, not failed');
  } finally {
    D.CHECKS[0].run = saved;
  }
}

/* ── credentials are never in the record ─────────────────────────────────── */

{
  /* The property is about the SERIALISED RECORD, not about one field: a leak is
   * whatever ends up in the JSON, however it got there. Collection never reads
   * a key, so this asserts the design rather than a scrub step that a future
   * caller could forget to apply. */
  const SECRET = 'sk-ant-THIS-MUST-NEVER-APPEAR-00000';
  const r = D.evaluate(healthy({
    provider: { id: 'anthropic', keyPresent: true, key: SECRET },
    stateRepo: { configured: true, repo: 'owner/state', tokenPresent: true, token: SECRET },
  }));
  const json = JSON.stringify(r);
  ok(!json.includes(SECRET), 'no credential reaches the record');
  ok(!json.includes('sk-ant-'), 'not even a recognisable prefix');
  eq(byId(r, 'provider-credential').status, 'pass', 'while still reporting the key IS set');
  ok(byId(r, 'provider-credential').evidence.includes('not read'),
    'and saying plainly that it was not read');
}

/* ── individual judgements worth pinning ─────────────────────────────────── */

{
  /* Only the first tab gets the OPFS store; agent tabs fall back to memory BY
   * DESIGN. Flagging the designed case would train operators to ignore this
   * check in exactly the tabs that are working correctly. */
  const r = D.evaluate(healthy({ quipu: { bound: true, persistence: 'memory' } }));
  eq(byId(r, 'quipu-wasm').status, 'pass', 'an agent tab on the memory store is healthy');
  eq(r.code, 0, 'and does not fail the run');
}

{
  const r = D.evaluate(healthy({ quipu: { bound: false, bootError: 'fetch failed' } }));
  eq(byId(r, 'quipu-wasm').status, 'fail', 'an unbound quipu is a required failure');
  ok(byId(r, 'quipu-wasm').evidence.includes('fetch failed'), 'carrying the boot error');
  eq(r.code, 1, 'and exits 1');
}

{
  const stale = D.evaluate(healthy({
    serviceWorker: {
      supported: true, controlled: true, updateReady: true,
      activeVersion: 'creel-v26', pageBuild: 'creel-v17 (2026-08-13, measurement harness)',
    },
  }));
  eq(byId(stale, 'service-worker-fresh').status, 'fail', 'a stale SW is caught');
  ok(byId(stale, 'service-worker-fresh').evidence.includes('creel-v26'), 'naming both versions');
  ok(byId(stale, 'service-worker-fresh').evidence.includes('creel-v17'), 'naming both versions');
  eq(stale.code, 0, 'advisory: stale code is reported, it does not block');

  const fresh = D.evaluate(healthy({
    serviceWorker: {
      supported: true, controlled: true, updateReady: false,
      activeVersion: 'creel-v26', pageBuild: 'creel-v17 (2026-08-13, measurement harness)',
    },
  }));
  eq(byId(fresh, 'service-worker-fresh').status, 'pass', 'a fresh SW passes');

  /* REGRESSION, and the reason this check was rewritten.
   *
   * The two version strings above are the REAL values in this repo:
   * sw.js counts CACHE_VERSION 'creel-v26', the page counts CREEL_BUILD
   * 'creel-v17 (2026-08-13, measurement harness)'. They are independent
   * counters that have never matched and were never meant to, so the obvious
   * implementation — activeVersion === pageBuild — reports STALE on every
   * healthy page. `fresh` above is exactly that case and MUST pass.
   *
   * An advisory that fires on every load is worse than no advisory, because it
   * trains the reader to skip the one line that would have mattered. If someone
   * later "simplifies" this back to a string compare, this assertion is what
   * stops it. */
  eq(byId(fresh, 'service-worker-fresh').status, 'pass',
    'mismatched version STRINGS are not staleness — only a waiting worker is');

  const uncontrolled = D.evaluate(healthy({
    serviceWorker: { supported: true, controlled: false },
  }));
  eq(byId(uncontrolled, 'service-worker-fresh').status, 'pass',
    'an uncontrolled page is a first load, not a fault');

  const noSignal = D.evaluate(healthy({
    serviceWorker: { supported: true, controlled: true, activeVersion: 'creel-v26' },
  }));
  eq(byId(noSignal, 'service-worker-fresh').status, 'unknown',
    'a controlled page with no updateReady signal is unknown, never a pass');
}

/* ── unsynced-changes accepts the boolean its only real producer emits ────── */

{
  const dirty = D.evaluate(healthy({ dirty: { unsynced: true } }));
  eq(byId(dirty, 'unsynced-changes').status, 'fail', 'stateIsDirty() true is reported');
  eq(dirty.code, 0, 'advisory: unsynced state does not block');
  ok(!byId(dirty, 'unsynced-changes').evidence.includes('1 unsynced'),
    'and is NOT rendered as a count of 1 — creel has no producer of a real count, '
    + 'so a number here would be a lie with a plausible shape');

  const clean = D.evaluate(healthy({ dirty: { unsynced: false } }));
  eq(byId(clean, 'unsynced-changes').status, 'pass', 'stateIsDirty() false passes');

  const counted = D.evaluate(healthy({ dirty: { unsynced: 3 } }));
  eq(byId(counted, 'unsynced-changes').status, 'fail', 'a real count still works');
  ok(byId(counted, 'unsynced-changes').evidence.includes('3'), 'and is reported as a count');

  const absent = D.evaluate(healthy({ dirty: {} }));
  eq(byId(absent, 'unsynced-changes').status, 'unknown', 'no dirty signal is unknown');
}

{
  const r = D.evaluate(healthy({ fleet: { liveLeases: 3, staleLeases: [] } }));
  eq(byId(r, 'fleet-leases').status, 'pass', 'no abandoned leases passes');
  ok(byId(r, 'fleet-leases').evidence.includes('3 live'), 'and still states the live count');
}

{
  const r = D.evaluate(healthy({
    stateRepo: { configured: true, repo: 'owner/state', tokenPresent: false },
  }));
  eq(byId(r, 'state-repo').status, 'fail', 'a repo with no token cannot push');
  ok(byId(r, 'state-repo').evidence.includes('no token'), 'and says so');
}

/* ── the operator-readable half ──────────────────────────────────────────── */

{
  const r = D.evaluate(healthy({ secureContext: false }));
  const text = D.explain(r);
  ok(text.includes('NOT OK (code 1)'), 'explain leads with the verdict');
  ok(text.includes('secure-context'), 'names the failing check by its durable id');
  ok(text.includes('[required]'), 'and its severity');
  ok(text.includes('→'), 'and shows remediation for what is not passing');

  /* A world where EVERY check is known and passing — not merely the required
   * ones. `healthy()` leaves the advisory checks unknown, and an unknown check
   * correctly still offers remediation ("run this in a tab"), so it is the wrong
   * world to assert silence against. */
  const complete = D.evaluate(healthy({
    storage: { persisted: true, usageMB: 5, quotaMB: 500 },
    dirty: { unsynced: 0 },
    serviceWorker: {
      supported: true, controlled: true, updateReady: false, activeVersion: 'v1', pageBuild: 'v1',
    },
    popups: { allowed: true },
    extension: { present: true, version: '0.4.0' },
    stateRepo: { configured: true, repo: 'owner/state', tokenPresent: true },
    fleet: { liveLeases: 2, staleLeases: [] },
  }));
  eq(complete.summary.unknown, 0, 'nothing is unknown in a fully-observed world');
  eq(complete.summary.fail, 0, 'and nothing fails');
  const good = D.explain(complete);
  ok(good.includes('OK (code 0)'), 'a healthy run says OK');
  ok(!good.includes('→'), 'and offers no remediation, because there is nothing to remedy');
}

console.log(`doctor: ${checks} checks ok`);
