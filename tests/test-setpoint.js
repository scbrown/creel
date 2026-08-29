/* creel — test-setpoint.js (aegis-45vco.1): the setpoint controller.
 * Zero dependencies. Run: node tests/test-setpoint.js
 *
 * The controller is a pure function, so every case is a full statement of a
 * world and nothing is stubbed. What is worth reading if you change this file:
 * the FREEZE cases and the CLAMP cases. Those are not coverage — they decide
 * whether a blind gauge or an armed burndown can talk this thing into growing
 * the fleet, which is the only way it can do real damage.
 */
'use strict';

const assert = require('assert');
const S = require('../app/creel-setpoint.js');

const NOW = 1_756_000_000;
const WEEK = 7 * 86400;

/** A governor verdict carrying one seven_day reading. */
function verdict(pct, o) {
  o = o || {};
  return {
    verdict: o.verdict || 'admit',
    enforced: o.enforced || 'allow',
    drain: { allowed: true },
    admission: { capSource: o.capSource || 'device-cap' },
    provider: {
      windows: {
        seven_day: {
          pct, fresh: o.fresh !== false, lowerBound: !!o.lowerBound,
          resetAt: o.resetAt === undefined ? NOW + o.remaining : o.resetAt,
          error: o.fresh === false ? 'STALE' : '',
        },
      },
      lowerBoundOnly: o.lowerBound ? ['seven_day'] : [],
      signalLost: o.fresh === false ? ['seven_day'] : [],
    },
  };
}

/** Target 90% by reset. Halfway through the week the trajectory is 45%. */
const POLICY = S.parsePolicy({ windows: { seven_day: { target: 90 } }, maxDelta: 2, deadband: 3 });

const half = WEEK / 2;   // remaining seconds => 50% elapsed

async function main() {
  let n = 0;
  const ok = (name) => { n++; console.log('  ✓ ' + name); };

  // ── policy validation ───────────────────────────────────────────────
  for (const [name, raw] of [
    ['non-object', 'nope'],
    ['unknown window', { windows: { two_week: { target: 90 } } }],
    ['target 0', { windows: { seven_day: { target: 0 } } }],
    ['target > 100', { windows: { seven_day: { target: 101 } } }],
    ['negative gain', { windows: { seven_day: { target: 90, kp: -1 } } }],
    ['fractional maxDelta', { maxDelta: 1.5 }],
    ['negative deadband', { deadband: -1 }],
  ]) {
    assert.throws(() => S.parsePolicy(raw), S.SetpointError, `${name} must be refused`);
    ok(`policy refuses ${name}`);
  }
  assert.deepStrictEqual(Object.keys(S.parsePolicy(null).windows), []);
  ok('an absent policy parses to the inert default');

  // ── the trajectory, and its two refusals ────────────────────────────
  assert.strictEqual(S.trajectory('seven_day', NOW + half, NOW, 90), 45);
  ok('halfway through the week the trajectory is half the target');
  assert.strictEqual(S.trajectory('seven_day', NOW + WEEK, NOW, 90), 0);
  assert.strictEqual(S.trajectory('seven_day', NOW + 1, NOW, 90).toFixed(2), '90.00');
  ok('trajectory runs 0 -> target across the window');

  assert.strictEqual(S.trajectory('seven_day', null, NOW, 90), null,
    'no published reset must not become a guessed trajectory');
  assert.strictEqual(S.trajectory('seven_day', NOW - 10, NOW, 90), null,
    'a reset already past is not a trajectory');
  assert.strictEqual(S.trajectory('seven_day', NOW + WEEK * 2, NOW, 90), null,
    'a reset further out than the window is long means length and reset DISAGREE — refuse');
  ok('trajectory REFUSES rather than guessing: no reset, past reset, inconsistent length');

  // ── inert until a setpoint is declared ──────────────────────────────
  const inert = S.advise({ policy: S.parsePolicy(null), verdict: verdict(5, { remaining: half }), now: NOW });
  assert.strictEqual(inert.advisory, 0);
  assert.strictEqual(inert.hold, S.HOLD_NO_SETPOINT);
  assert.strictEqual(inert.alarm, '', 'an undeclared setpoint must not alarm');
  ok('no setpoint declared = inert, silent, recommends nothing');

  // ── the motivating case: under-burn recommends GROWTH ───────────────
  // Halfway through the week, trajectory 45%, actual 5% => 40 points behind.
  const under = S.advise({ policy: POLICY, verdict: verdict(5, { remaining: half }), now: NOW, liveAgents: 2 });
  assert.strictEqual(under.windows.seven_day.trajectory, 45);
  assert.strictEqual(under.windows.seven_day.actual, 5);
  assert.strictEqual(under.windows.seven_day.error, 40);
  assert.ok(under.advisory > 0, `deep under-burn must recommend growth, got ${under.advisory}`);
  assert.match(under.reason, /BEHIND/);
  ok('codex-shaped under-burn (5% at the halfway mark) recommends GROWTH');

  // ── over-burn recommends SHRINK ─────────────────────────────────────
  const over = S.advise({ policy: POLICY, verdict: verdict(85, { remaining: half }), now: NOW, liveAgents: 5 });
  assert.strictEqual(over.windows.seven_day.error, -40);
  assert.ok(over.advisory < 0, `over-burn must recommend shrink, got ${over.advisory}`);
  assert.match(over.reason, /AHEAD OF/);
  ok('over-burn recommends SHRINK');

  // ── deadband: on trajectory is a HOLD with a distinct reason ─────────
  const onTraj = S.advise({ policy: POLICY, verdict: verdict(44, { remaining: half }), now: NOW, liveAgents: 3 });
  assert.strictEqual(onTraj.advisory, 0);
  assert.strictEqual(onTraj.hold, S.HOLD_ON_TRAJECTORY);
  assert.strictEqual(onTraj.alarm, '', 'being correctly sized is not an alarm');
  ok('inside the deadband: hold, reason on-trajectory, no alarm');

  // ── FREEZE 1: signal lost ───────────────────────────────────────────
  const blind = S.advise({
    policy: POLICY, verdict: verdict(5, { remaining: half, fresh: false }), now: NOW,
    integral: { seven_day: 1.5 }, liveAgents: 2,
  });
  assert.strictEqual(blind.advisory, 0);
  assert.strictEqual(blind.hold, S.HOLD_SIGNAL_LOST);
  assert.match(blind.alarm, /CONTROLLER FROZEN/);
  assert.match(blind.alarm, /NOT because the fleet is correctly sized/);
  assert.strictEqual(blind.integral.seven_day, 1.5, 'the integrator is CARRIED across a freeze, not reset');
  ok('signal lost: frozen, alarms LOUDLY, integrator carried not zeroed');

  // ── FREEZE 2: lowerBound — the one that is NOT `unknown` ────────────
  // A lower bound is a real number that engages tiers correctly, so it does not
  // present as unknown. But it errs in exactly one direction — always "under" —
  // which is the direction the integrator acts on hardest.
  const lb = S.advise({
    policy: POLICY, verdict: verdict(5, { remaining: half, lowerBound: true }), now: NOW, liveAgents: 2,
  });
  assert.strictEqual(lb.advisory, 0, 'a lower bound must not be allowed to drive growth');
  assert.strictEqual(lb.hold, S.HOLD_LOWER_BOUND);
  assert.match(lb.alarm, /CONTROLLER FROZEN/);
  ok('lowerBound freezes too — a one-directional gauge cannot drive the I term');

  // The same reading WITHOUT the lower-bound flag does recommend growth. That is
  // the discriminating control: it proves the freeze came from the flag and not
  // from the number.
  const lbControl = S.advise({ policy: POLICY, verdict: verdict(5, { remaining: half }), now: NOW, liveAgents: 2 });
  assert.ok(lbControl.advisory > 0, 'control: the same number without the flag DOES recommend growth');
  ok('control: identical reading minus the lowerBound flag recommends growth — the flag is what froze it');

  // ── FREEZE 3: no usable reset ───────────────────────────────────────
  const noReset = S.advise({
    policy: POLICY, verdict: verdict(5, { resetAt: null }), now: NOW, liveAgents: 2,
  });
  assert.strictEqual(noReset.advisory, 0);
  assert.strictEqual(noReset.hold, S.HOLD_NO_RESET);
  ok('no published reset: hold, and the reason names it rather than guessing a trajectory');

  // ── BURNDOWN OUTRANKS ───────────────────────────────────────────────
  // The fixture is chosen so the UNCLAMPED controller would recommend growth —
  // otherwise the test proves nothing about precedence.
  const wouldGrow = S.advise({ policy: POLICY, verdict: verdict(5, { remaining: half }), now: NOW, liveAgents: 2 });
  assert.ok(wouldGrow.advisory > 0, 'fixture precondition: unclamped this recommends growth');
  const burn = S.advise({
    policy: POLICY, verdict: verdict(5, { remaining: half }), now: NOW,
    liveAgents: 2, burndown: ['seven_day'],
  });
  assert.strictEqual(burn.advisory, 0, 'burndown armed must clamp the controller to zero');
  assert.strictEqual(burn.hold, S.HOLD_BURNDOWN);
  assert.match(burn.reason, /owns the end of the window/);
  ok('burndown armed clamps output to 0 — proven against a fixture that would otherwise grow');

  // ── THE FENCE NEVER MOVES ───────────────────────────────────────────
  const fenced = S.advise({
    policy: POLICY, verdict: verdict(5, { remaining: half }), now: NOW,
    liveAgents: 6, fenceMax: 6,
  });
  assert.strictEqual(fenced.advisory, 0, 'at max_agents the controller may not recommend past the fence');
  assert.ok(fenced.preClampDelta > 0, 'and it records what it WOULD have said');
  assert.match(fenced.clampedBy, /max_agents 6/);
  ok('max_agents clamps growth, and the pre-clamp value is preserved for the reader');

  const drained = S.advise({
    policy: POLICY,
    verdict: verdict(5, { remaining: half, verdict: 'refuse', enforced: 'block', capSource: 'provider-drain' }),
    now: NOW, liveAgents: 1, fenceMax: 6,
  });
  assert.strictEqual(drained.advisory, 0, 'a provider drain outranks any recommendation to grow');
  assert.match(drained.clampedBy, /fence never moves/);
  ok('provider drain clamps growth to 0 — the controller cannot argue past a drain');

  // ── D damps a spike ─────────────────────────────────────────────────
  // Same error, same everything, except a fast recent climb. The recommendation
  // must be strictly lower.
  const base = S.advise({ policy: POLICY, verdict: verdict(20, { remaining: half }), now: NOW, liveAgents: 2 });
  const spiking = S.advise({
    policy: POLICY, verdict: verdict(20, { remaining: half }), now: NOW, liveAgents: 2,
    prev: { seven_day: { pct: 8, at: NOW - 3600 } },     // +12 points in an hour
  });
  assert.ok(spiking.windows.seven_day.burnPerHour > 10, 'fixture: this is a fast climb');
  assert.ok(spiking.windows.seven_day.raw < base.windows.seven_day.raw,
    'a burn-rate spike must DAMP the recommendation');
  ok('D term damps on a burn-rate spike, with the flat case as the control');

  // ── anti-windup ─────────────────────────────────────────────────────
  let integral = {};
  for (let i = 0; i < 200; i++) {
    integral = S.advise({ policy: POLICY, verdict: verdict(5, { remaining: half }), now: NOW, integral, liveAgents: 2 }).integral;
  }
  assert.ok(Math.abs(integral.seven_day) <= 2 + 1e-9,
    `integrator must clamp at iClamp, got ${integral.seven_day}`);
  ok('anti-windup: 200 passes of sustained under-burn clamp the integrator at iClamp');

  // ── REPLAY, including the stale stretch the acceptance requires ──────
  // A week of samples: under-burn, then a blind stretch, then recovery.
  // The reset is a FIXED INSTANT — the window refills once, at one moment. An
  // earlier version of this fixture recomputed it relative to each sample, which
  // put the reset in the past by day 5, and the controller correctly refused to
  // build a trajectory from it (`no-reset-published`). The controller caught the
  // bad fixture; keep the reset absolute.
  const RESET = NOW + WEEK;
  const samples = [];
  for (let d = 0; d < 7; d++) {
    const stale = d >= 3 && d <= 4;                 // the blind stretch
    samples.push({
      now: NOW + d * 86400,
      liveAgents: 2, fenceMax: 6,
      verdict: verdict(2 + d, { resetAt: RESET, fresh: !stale }),
    });
  }
  const advisories = S.replay(POLICY, samples);
  assert.strictEqual(advisories.length, 7);
  assert.ok(advisories.slice(0, 3).some((a) => a.advisory > 0), 'replay recommends growth during under-burn');
  assert.ok(advisories.slice(3, 5).every((a) => a.advisory === 0 && a.hold === S.HOLD_SIGNAL_LOST),
    'replay HOLDS through the stale stretch');
  assert.ok(advisories.slice(3, 5).every((a) => /CONTROLLER FROZEN/.test(a.alarm)),
    'and alarms on every frozen pass, not just the first');
  assert.ok(advisories.slice(5).some((a) => a.advisory > 0), 'replay RESUMES after the signal returns');
  ok('replay: growth during under-burn, hold+alarm through a stale stretch, resume on recovery');

  // ── the record shape ────────────────────────────────────────────────
  for (const a of [under, blind, burn, inert, fenced]) {
    assert.strictEqual(a.contract, 'creel.setpoint/1');
    assert.strictEqual(typeof a.advisory, 'number');
    assert.ok(a.reason.length > 0, 'every advisory carries a reason');
    assert.strictEqual(JSON.parse(JSON.stringify(a)).advisory, a.advisory, 'round-trips as JSON');
  }
  ok('every advisory carries contract creel.setpoint/1, a reason, and round-trips as JSON');

  assert.match(S.explain(under), /^↑ governor recommends \+/);
  assert.match(S.explain(over), /^↓/);
  assert.match(S.explain(blind), /CONTROLLER FROZEN/);
  ok('explain renders one operator line and surfaces the freeze alarm');

  console.log(`setpoint: ${n} checks ok`);
}

main().catch((e) => { console.error(e); process.exit(1); });
