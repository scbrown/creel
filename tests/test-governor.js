/* creel — test-governor.js (aegis-edp2n.3): the budget governor's admission
 * policy. Zero dependencies. Run: node tests/test-governor.js
 *
 * The engine is a pure function, so every case here is a full statement of a
 * world: a policy, a set of readings, a device, a clock. Nothing is stubbed
 * because nothing needs to be.
 *
 * What is worth reading if you are changing this file: the fail-safe cases.
 * `blind never refuses by default`, `refuse beats unknown` and `drain is always
 * allowed` are not coverage — they are the three properties that decide whether
 * a broken usage probe can stop a fleet or strand its work.
 */
'use strict';

const assert = require('assert');
const G = require('../app/creel-governor.js');

const NOW = 1_756_000_000;

/** A policy with the shape an operator would actually write. */
const POLICY = G.parsePolicy({
  windows: {
    five_hour: { tiers: [{ at: 50, maxTabs: 4 }, { at: 70, maxTabs: 2 }, { at: 95, drain: true }] },
    seven_day: { tiers: [{ at: 45, maxTabs: 4 }, { at: 65, maxTabs: 1 }, { at: 90, drain: true }] },
  },
});

const fresh = (pct, extra) => G.reading({ pct, at: NOW, source: 'headers', ...(extra || {}) });

/** A desktop with nothing running unless said otherwise. */
function ask(o) {
  return G.verdict({
    policy: POLICY, now: NOW, device: 'desktop', deviceCap: 8, running: 0, want: 1,
    ...o,
  });
}

async function main() {
  let n = 0;
  const ok = (name) => { n++; console.log('  ✓ ' + name); };

  // ── policy validation ───────────────────────────────────────────────
  // A governor that silently drops a malformed tier governs less than the
  // operator believes, and that failure has no symptom until it matters.
  const bad = [
    ['non-object policy', 'not an object'],
    ['unknown window', { windows: { two_week: { tiers: [{ at: 50, maxTabs: 1 }] } } }],
    ['window with no tiers', { windows: { five_hour: { tiers: [] } } }],
    ['tier out of range', { windows: { five_hour: { tiers: [{ at: 140, maxTabs: 1 }] } } }],
    ['duplicate threshold', { windows: { five_hour: { tiers: [{ at: 50, maxTabs: 2 }, { at: 50, maxTabs: 1 }] } } }],
    ['tier with no restriction', { windows: { five_hour: { tiers: [{ at: 50 }] } } }],
    ['negative maxTabs', { windows: { five_hour: { tiers: [{ at: 50, maxTabs: -1 }] } } }],
    ['bad onSignalLost', { onSignalLost: 'panic' }],
    ['bad token budget', { tokenBudgets: { five_hour: 0 } }],
    ['unknown budget window', { tokenBudgets: { yearly: 100 } }],
  ];
  for (const [name, raw] of bad) {
    assert.throws(() => G.parsePolicy(raw), G.GovernorError, `${name} must be refused`);
    ok(`policy refuses ${name}`);
  }
  assert.deepStrictEqual(Object.keys(G.parsePolicy(null).windows), []);
  ok('an absent policy parses to the inert default rather than throwing');

  // Thresholds sort ascending regardless of how they were written, because
  // "the top engaged tier" is the last one and the operator's file order is
  // not a promise.
  const sorted = G.parsePolicy({ windows: { five_hour: { tiers: [{ at: 90, drain: true }, { at: 50, maxTabs: 3 }] } } });
  assert.deepStrictEqual(sorted.windows.five_hour.tiers.map((t) => t.at), [50, 90]);
  ok('tiers sort by threshold whatever order they were declared in');

  // ── inert until a budget is declared ────────────────────────────────
  // Property 2: an alarm that fires on a clean install is an alarm people
  // learn to close.
  const inert = G.verdict({ policy: G.parsePolicy(null), now: NOW, device: 'desktop', deviceCap: 8, running: 0 });
  assert.strictEqual(inert.verdict, G.ADMIT);
  assert.strictEqual(inert.governed, false);
  assert.strictEqual(inert.alarm, '', 'an undeclared budget must not alarm');
  assert.match(inert.reason, /no provider budget declared/);
  assert.strictEqual(inert.admission.maxTabs, 8, 'inert governs by the device cap alone');
  ok('no declared budget = INERT: admits on the device cap, governed:false, silent');

  // ── the composition ─────────────────────────────────────────────────
  const open = ask({ readings: { five_hour: fresh(10), seven_day: fresh(12) } });
  assert.strictEqual(open.verdict, G.ADMIT);
  assert.strictEqual(open.admission.maxTabs, 8);
  assert.strictEqual(open.admission.capSource, 'device-cap');
  assert.strictEqual(open.provider.engaged.length, 0);
  ok('both windows low: admits at the device cap, no tier engaged');

  const throttled = ask({ readings: { five_hour: fresh(72), seven_day: fresh(12) } });
  assert.strictEqual(throttled.admission.maxTabs, 2, 'the 70% five_hour tier caps at 2');
  assert.strictEqual(throttled.admission.capSource, 'provider-tier');
  assert.strictEqual(throttled.verdict, G.ADMIT, 'two free slots still admits one');
  ok('provider tier tightens the cap below the device cap');

  // The strictest engaged tier across BOTH windows wins. Never an average: an
  // average lets a fresh five-hour window mask an exhausted week, which is the
  // whole reason the windows are governed separately.
  const both = ask({ readings: { five_hour: fresh(72), seven_day: fresh(66) } });
  assert.strictEqual(both.admission.maxTabs, 1, 'seven_day@65 (1 tab) beats five_hour@70 (2 tabs)');
  assert.strictEqual(both.provider.engaged.length, 2, 'both windows report their engaged tier');
  ok('two engaged windows compose to the STRICTEST cap, never an average');

  // A device smaller than the provider allowance is still the binding wall.
  const phone = ask({ device: 'mobile', deviceCap: 3, readings: { five_hour: fresh(55), seven_day: fresh(10) } });
  assert.strictEqual(phone.admission.maxTabs, 3, 'device cap 3 beats the tier cap of 4');
  assert.strictEqual(phone.admission.capSource, 'device-cap');
  ok('device cap wins when it is stricter than the provider tier');

  // ── refusal names the wall it hit ───────────────────────────────────
  // "No free slots" sends an operator to close tabs. If the real answer is
  // that the week is spent, closing tabs changes nothing.
  const full = ask({ running: 8, readings: { five_hour: fresh(10), seven_day: fresh(10) } });
  assert.strictEqual(full.verdict, G.REFUSE);
  assert.strictEqual(full.enforced, 'block');
  assert.strictEqual(full.admission.capSource, 'device-cap');
  assert.match(full.reason, /desktop cap/);
  ok('at the device cap: REFUSE, and the reason names the device');

  const spent = ask({ running: 1, readings: { five_hour: fresh(72), seven_day: fresh(66) } });
  assert.strictEqual(spent.verdict, G.REFUSE);
  assert.strictEqual(spent.admission.capSource, 'provider-tier');
  assert.match(spent.reason, /provider budget throttled/);
  assert.match(spent.reason, /seven_day >= 65%/, 'the refusal names the window that caused it');
  ok('throttled to a full cap: REFUSE, and the reason names the WINDOW');

  const drained = ask({ readings: { five_hour: fresh(96), seven_day: fresh(10) } });
  assert.strictEqual(drained.verdict, G.REFUSE);
  assert.strictEqual(drained.admission.maxTabs, 0);
  assert.strictEqual(drained.admission.capSource, 'provider-drain');
  assert.match(drained.reason, /exhausted/);
  ok('a drain tier: REFUSE at zero tabs, capSource provider-drain');

  // `want` is part of the question. Asking for four when one is free is a
  // refusal of the burst, not of the fleet.
  const burst = ask({ running: 7, want: 4, readings: { five_hour: fresh(10), seven_day: fresh(10) } });
  assert.strictEqual(burst.verdict, G.REFUSE);
  assert.strictEqual(burst.admission.free, 1);
  assert.match(burst.reason, /4 asked for/);
  ok('want is part of the verdict: 4 asked, 1 free -> REFUSE naming both');

  // ── signal loss is LOUD, and never refuses by default ───────────────
  // Property 1, and the case the whole fail-safe exists for.
  const stale = ask({ readings: { five_hour: G.reading({ pct: 10, at: NOW - 3600, source: 'headers' }), seven_day: fresh(10) } });
  assert.strictEqual(stale.verdict, G.UNKNOWN);
  assert.strictEqual(stale.enforced, 'allow', 'a dead probe must never be able to stop a fleet');
  assert.match(stale.alarm, /USAGE SIGNAL LOST \[five_hour\]/);
  assert.match(stale.provider.windows.five_hour.error, /STALE/);
  assert.strictEqual(stale.admission.maxTabs, 8, 'a lost window relaxes toward the DEVICE cap, not toward unlimited');
  ok('stale reading: UNKNOWN + loud alarm, but enforcement still ALLOWS');

  const missing = ask({ readings: { five_hour: fresh(10) } });
  assert.strictEqual(missing.verdict, G.UNKNOWN);
  assert.deepStrictEqual(missing.provider.signalLost, ['seven_day']);
  ok('a declared window with no reading at all is signal lost, not zero');

  const untimed = ask({ readings: { five_hour: G.reading({ pct: 10, source: 'headers' }), seven_day: fresh(10) } });
  assert.strictEqual(untimed.verdict, G.UNKNOWN);
  assert.match(untimed.provider.windows.five_hour.error, /no timestamp/);
  ok('an untimestamped reading is lost: unaged is indistinguishable from frozen');

  const skewed = ask({ readings: { five_hour: G.reading({ pct: 10, at: NOW + 4000, source: 'headers' }), seven_day: fresh(10) } });
  assert.strictEqual(skewed.verdict, G.UNKNOWN);
  assert.match(skewed.provider.windows.five_hour.error, /FUTURE/);
  ok('a reading from the future is lost: clock skew defeats every age check');

  // freeze is opt-in, and it is the ONLY way blindness blocks.
  const frozen = G.verdict({
    policy: G.parsePolicy({ onSignalLost: 'freeze', windows: POLICY.windows }),
    now: NOW, device: 'desktop', deviceCap: 8, running: 0,
    readings: { five_hour: fresh(10) },
  });
  assert.strictEqual(frozen.verdict, G.UNKNOWN);
  assert.strictEqual(frozen.enforced, 'block');
  ok('onSignalLost:freeze is the only thing that makes blindness BLOCK');

  // ── refuse beats unknown ────────────────────────────────────────────
  // A definite refusal is not made uncertain by a second blind window. If one
  // budget says stop, we know the answer.
  const mixed = ask({ readings: { five_hour: fresh(96) } });
  assert.strictEqual(mixed.verdict, G.REFUSE, 'a drained window outranks a blind one');
  assert.strictEqual(mixed.enforced, 'block');
  assert.match(mixed.alarm, /SIGNAL LOST \[seven_day\]/, 'and the blindness is still reported');
  ok('refuse > unknown: one window drained + one blind = REFUSE, alarm kept');

  // ── the ledger is a lower bound ─────────────────────────────────────
  // Property 3: 20% by creel's own count is consistent with 95% at the
  // provider, so a low ledger reading may not clear the window.
  const led = ask({ readings: { five_hour: G.reading({ pct: 20, at: NOW, source: 'ledger', lowerBound: true }), seven_day: fresh(10) } });
  assert.strictEqual(led.verdict, G.UNKNOWN);
  assert.deepStrictEqual(led.provider.lowerBoundOnly, ['five_hour']);
  assert.strictEqual(led.enforced, 'allow');
  assert.match(led.alarm, /LOWER BOUND/);
  assert.match(led.reason, /cannot see spend from any other client/);
  ok('a LOW ledger reading is UNKNOWN, not admit — it cannot see other clients');

  // Above a threshold it is proof: the true figure is at least this.
  const ledHigh = ask({ readings: { five_hour: G.reading({ pct: 72, at: NOW, source: 'ledger', lowerBound: true }), seven_day: fresh(10) } });
  assert.strictEqual(ledHigh.admission.maxTabs, 2, 'a lower bound above a threshold still engages the tier');
  assert.deepStrictEqual(ledHigh.provider.lowerBoundOnly, [], 'an engaged tier is not a lower-bound gap');
  ok('a HIGH ledger reading refuses normally: a lower bound above a wall is still above it');

  // The operator declaring the key exclusive is what promotes it, and only the
  // operator can know that.
  const exclusive = G.verdict({
    policy: G.parsePolicy({ ledgerExclusive: true, windows: POLICY.windows }),
    now: NOW, device: 'desktop', deviceCap: 8, running: 0,
    readings: { five_hour: G.reading({ pct: 20, at: NOW, source: 'ledger', lowerBound: true }), seven_day: fresh(10) },
  });
  assert.strictEqual(exclusive.verdict, G.ADMIT);
  assert.strictEqual(exclusive.alarm, '');
  ok('ledgerExclusive promotes the ledger to a measurement: ADMIT, no alarm');

  // ── hysteresis ──────────────────────────────────────────────────────
  // A reading oscillating around a threshold must not re-plan the burst every
  // pass; each flip is a spawn decision an agent has already acted on.
  const up = ask({ readings: { five_hour: fresh(71), seven_day: fresh(10) } });
  assert.strictEqual(up.held.five_hour, 70);
  const wobble = ask({ held: up.held, readings: { five_hour: fresh(68), seven_day: fresh(10) } });
  assert.strictEqual(wobble.admission.maxTabs, 2, '68 with a 5-point margin still holds the 70 tier');
  const release = ask({ held: up.held, readings: { five_hour: fresh(64), seven_day: fresh(10) } });
  assert.strictEqual(release.admission.maxTabs, 4, 'below 65 the tier releases to the 50 tier');
  assert.strictEqual(release.held.five_hour, 50);
  ok('hysteresis: 71 engages 70, 68 holds it, 64 releases it');

  // A held tier does NOT survive blindness. Hysteresis holds a measurement, and
  // when the signal is lost there is no longer one to hold.
  const heldBlind = ask({ held: { five_hour: 70 }, readings: { seven_day: fresh(10) } });
  assert.strictEqual(heldBlind.admission.maxTabs, 8);
  assert.strictEqual(heldBlind.held.five_hour, undefined);
  assert.strictEqual(heldBlind.verdict, G.UNKNOWN);
  ok('a held tier does not survive signal loss — hysteresis holds a reading, not a mood');

  // ── drain is ALWAYS allowed ─────────────────────────────────────────
  // A refusal that stranded queued work would turn a budget guard into a
  // work-loss event: the running tabs hold the only copy of what they have done.
  for (const v of [open, throttled, full, spent, drained, stale, mixed, inert, frozen]) {
    assert.strictEqual(v.drain.allowed, true, `drain must be allowed under ${v.verdict}/${v.admission.capSource}`);
    assert.match(v.drain.note, /never governed/);
  }
  ok('drain is allowed under EVERY verdict, including a full provider drain');

  // ── the wire record ─────────────────────────────────────────────────
  // CABOODLE preflights against this, so the shape is a contract and not a
  // convenience.
  for (const v of [open, drained, stale, inert]) {
    assert.strictEqual(v.contract, 'creel.admission/1');
    assert.ok(['admit', 'refuse', 'unknown'].includes(v.verdict));
    assert.ok(['allow', 'block'].includes(v.enforced));
    assert.strictEqual(typeof v.reason, 'string');
    assert.ok(v.reason.length > 0, 'every verdict carries a reason');
    assert.strictEqual(typeof v.provider.windows, 'object');
    assert.strictEqual(typeof v.device.cap, 'number');
    assert.strictEqual(typeof v.admission.free, 'number');
    assert.strictEqual(JSON.parse(JSON.stringify(v)).verdict, v.verdict, 'the record round-trips as JSON');
  }
  ok('every verdict carries the full versioned record and round-trips as JSON');

  // A refusal must never carry a key, a token, or an endpoint. The reason is
  // read by an operator and by CABOODLE, and one of them logs it.
  const secretish = /sk-|api[_-]?key|x-api-key|Bearer\s|authorization/i;
  for (const v of [open, drained, stale, spent, full]) {
    assert.ok(!secretish.test(v.reason), 'reason must be free of credential-shaped text');
    assert.ok(!secretish.test(v.alarm), 'alarm must be free of credential-shaped text');
  }
  ok('reasons and alarms are redacted by construction — no credential-shaped text');

  // ── header parsing ──────────────────────────────────────────────────
  // Providers publish what is LEFT; a governor thresholds on what is SPENT.
  // Inverting at the seam means no reader downstream has to remember which
  // direction this provider counts.
  assert.strictEqual(G.pctFromPair(100, 25), 75);
  assert.strictEqual(G.pctFromPair(100, 0), 100);
  assert.strictEqual(G.pctFromPair(100, 100), 0);
  assert.strictEqual(G.pctFromPair(0, 0), null, 'a zero limit is not a percentage');
  assert.strictEqual(G.pctFromPair(null, 5), null);
  assert.strictEqual(G.pctFromPair(100, null), null);
  ok('pctFromPair converts limit/remaining into percent CONSUMED');

  const H = (o) => ({ get: (k) => (k in o ? o[k] : null) });
  const hdr = G.readingsFromHeaders(H({
    'anthropic-ratelimit-requests-limit': '1000',
    'anthropic-ratelimit-requests-remaining': '400',
    'anthropic-ratelimit-requests-reset': '2025-08-24T00:00:00Z',
    'anthropic-ratelimit-tokens-limit': '2000',
    'anthropic-ratelimit-tokens-remaining': '1800',
  }), NOW);
  assert.strictEqual(hdr.five_hour.pct, 60);
  assert.strictEqual(hdr.five_hour.source, 'headers');
  assert.strictEqual(hdr.five_hour.limitId, 'requests');
  assert.strictEqual(hdr.seven_day.pct, 10);
  assert.ok(hdr.five_hour.resetAt > 1e9, 'an RFC3339 reset parses to an epoch');
  ok('readingsFromHeaders maps provider rate-limit headers onto windows');

  // Two limits mapping to one window are separate walls: hitting either stops
  // the call, so the binding constraint is the HIGHER number, never an average.
  const worst = G.readingsFromHeaders(H({
    'anthropic-ratelimit-requests-limit': '100',
    'anthropic-ratelimit-requests-remaining': '90',        // 10% consumed
    'anthropic-ratelimit-input-tokens-limit': '100',
    'anthropic-ratelimit-input-tokens-remaining': '20',    // 80% consumed
  }), NOW);
  assert.strictEqual(worst.five_hour.pct, 80, 'the more consumed limit wins, never an average');
  ok('two limits on one window: the MORE CONSUMED wins');

  assert.deepStrictEqual(G.readingsFromHeaders(H({}), NOW), {});
  assert.deepStrictEqual(G.readingsFromHeaders(null, NOW), {});
  ok('a response with no rate-limit headers yields no readings (not a zero)');

  assert.strictEqual(G.parseResetHeader('60', NOW), NOW + 60, 'a small integer is seconds-until');
  assert.strictEqual(G.parseResetHeader(String(NOW + 500), NOW), NOW + 500, 'a large integer is an epoch');
  assert.strictEqual(G.parseResetHeader('', NOW), null);
  assert.strictEqual(G.parseResetHeader('nonsense', NOW), null);
  ok('parseResetHeader handles seconds-until, epochs, RFC3339 and rubbish');

  // ── the ledger source ───────────────────────────────────────────────
  const ledger = { [NOW - 60]: 1000, [NOW - 4 * 3600]: 3000, [NOW - 6 * 86400]: 6000 };
  const lr = G.readingsFromLedger({ five_hour: 8000, seven_day: 20000 }, { now: NOW, ledger });
  assert.strictEqual(lr.five_hour.pct, 50, '4000 of 8000 tokens inside five hours');
  assert.strictEqual(lr.seven_day.pct, 50, '10000 of 20000 tokens inside seven days');
  assert.strictEqual(lr.five_hour.lowerBound, true, 'every ledger reading is marked a lower bound');
  ok('readingsFromLedger sums the buckets inside each window against its budget');

  assert.deepStrictEqual(G.readingsFromLedger({}, { now: NOW, ledger }), {});
  assert.deepStrictEqual(G.readingsFromLedger({ five_hour: 0 }, { now: NOW, ledger }), {});
  ok('no declared budget = no ledger reading: a count with no denominator is not a percentage');

  // ── explain ─────────────────────────────────────────────────────────
  assert.match(G.explain(open), /^✓ ADMIT/);
  assert.match(G.explain(drained), /^✕ REFUSE/);
  assert.match(G.explain(stale), /^\? UNKNOWN/);
  assert.match(G.explain(stale), /SIGNAL LOST/);
  ok('explain renders one operator-readable line, alarm included');

  // ── module shape ────────────────────────────────────────────────────
  for (const f of ['parsePolicy', 'verdict', 'explain', 'observe', 'admission',
    'recordManual', 'recordSpend', 'readingsFromHeaders', 'readingsFromLedger']) {
    assert.strictEqual(typeof G[f], 'function', `exports ${f}`);
  }
  ok('exports the engine and its edges for node');

  console.log(`governor: ${n} checks ok`);
}

main().catch((e) => { console.error(e); process.exit(1); });
