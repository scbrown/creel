/* creel — the setpoint controller: how hard should we be pushing right now?
 *
 * The governor in creel-governor.js is a one-sided BRAKE. Tiers engage as usage
 * climbs, the composed cap shrinks, a drain tier stops everything. Nothing
 * pushes the other way, so UNDER-utilisation is invisible to it: a budget that
 * refills on a schedule and goes unspent is thrown away, and the governor is
 * perfectly happy about that. Measured 2026-08-29: codex at 5% of its weekly
 * budget with the fleet sized by hand-set caps and arithmetic in a coordinator's
 * head.
 *
 * This module adds the other half. It is a controller in the ordinary sense —
 * P on the current error, I on sustained drift, D on the rate of change — over
 * one error signal:
 *
 *     error = trajectory(now) - actual(now)
 *
 * where the trajectory is the utilisation we WANT to be at by now if the budget
 * is to be fully and evenly spent by the time it refills. Ahead of trajectory
 * means slow down; behind it means there is headroom being wasted.
 *
 * ── WHAT THIS IS NOT ALLOWED TO DO ───────────────────────────────────────────
 *
 * It ADVISES. It never actuates, and in v1 it is not even wired to anything that
 * could: `st tend` surfaces the recommendation to a human, who stays the actuator
 * until the advisory has a measured false-recommendation rate. That is the same
 * advise-then-enforce gate every other governed mechanism here went through, and
 * it is why the output is a third field rather than a new input to admission.
 *
 * THE FENCE NEVER MOVES BECAUSE THE CONTROLLER SAYS SO. Tier caps, the drain,
 * the per-session action ceiling and the fleet's max_agents all bound the output.
 * A controller that could argue its way past a drain is not a controller, it is
 * an off switch with extra steps — the same reasoning that makes burndown unable
 * to suspend a drain in the governor it sits beside.
 *
 * ── THE THREE ANSWERS, KEPT SEPARATE ─────────────────────────────────────────
 *
 *     verdict    admit | refuse | unknown        what is TRUE about the budget
 *     enforced   allow | block                   what creel DOES about it
 *     advisory   +N | 0 | -N + aggressiveness    what creel RECOMMENDS
 *
 * Three questions, three fields. The controller may recommend +2 while the
 * verdict is `refuse` — at the device cap with budget to spare, the right move
 * is to raise the cap, not to open another tab — and may recommend -1 while the
 * verdict is `admit`. Collapsing any pair makes one of those unrepresentable,
 * and both are real states we have been in.
 *
 * Pure, like the governor's `advise()` neighbour: every input is an argument,
 * nothing reads the clock or storage, and the integrator is carried in and out
 * rather than hidden in a closure. That is what makes the acceptance affordable
 * — replaying a week of recorded readings is a loop, not an integration test.
 */
(() => {
  'use strict';

  const G = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./creel-governor.js')
    : (typeof window !== 'undefined' ? window.CreelGovernor : null);

  const FIVE_HOUR = 'five_hour';
  const SEVEN_DAY = 'seven_day';
  const WINDOW_LENGTH_S = { [FIVE_HOUR]: 5 * 3600, [SEVEN_DAY]: 7 * 86400 };

  /** Why the controller is not recommending anything, when it is not. These are
   *  reported, never inferred from a zero — a controller that recommends 0
   *  because it is frozen and one that recommends 0 because the fleet is exactly
   *  on trajectory are opposite facts, and a bare 0 cannot tell them apart. */
  const HOLD_ON_TRAJECTORY = 'on-trajectory';
  const HOLD_SIGNAL_LOST = 'signal-lost';
  const HOLD_LOWER_BOUND = 'lower-bound-only';
  const HOLD_BURNDOWN = 'burndown-armed';
  const HOLD_NO_SETPOINT = 'no-setpoint-declared';
  const HOLD_NO_RESET = 'no-reset-published';

  const DEFAULT_DECLARATION = Object.freeze({
    activeUntil: Math.floor(Date.parse('2026-09-01T00:00:00-04:00') / 1000),
    active: Object.freeze({ windows: Object.freeze({ seven_day: Object.freeze({ target: 100 }) }), maxDelta: 2, deadband: 3 }),
    steady: Object.freeze({ windows: Object.freeze({ seven_day: Object.freeze({ target: 80 }) }), maxDelta: 1, deadband: 5 }),
  });

  class SetpointError extends Error {}

  function num(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  // ── policy ────────────────────────────────────────────────────────────
  //
  // INERT UNTIL A SETPOINT IS DECLARED, for the same reason the governor is
  // inert until a budget is: a default trajectory would start recommending
  // fleet changes on a fresh install against a budget nobody described, and a
  // recommendation nobody asked for is worse than silence because somebody may
  // act on it.

  const DEFAULT_POLICY = Object.freeze({
    windows: Object.freeze({}),   // {window: {target, kp, ki, kd, ...}}
    // How many agents a full-scale error may move. The controller's whole output
    // range, before the fence clamps it further.
    maxDelta: 2,
    // Deadband, in percentage points of utilisation. Inside it the answer is
    // "hold" and the reason is on-trajectory. Without one, a controller chases
    // sensor noise and produces a stream of +1/-1 that trains its reader to
    // ignore it.
    deadband: 3,
  });

  function parsePolicy(raw) {
    const p = { ...DEFAULT_POLICY, windows: {} };
    if (raw == null) return Object.freeze(p);
    if (typeof raw !== 'object') throw new SetpointError('setpoint policy must be an object');

    if (raw.maxDelta != null) {
      const n = num(raw.maxDelta, NaN);
      if (!(Number.isInteger(n) && n >= 0)) throw new SetpointError('setpoint.maxDelta must be a non-negative integer');
      p.maxDelta = n;
    }
    if (raw.deadband != null) {
      const n = num(raw.deadband, NaN);
      if (!(n >= 0)) throw new SetpointError('setpoint.deadband must be zero or more percentage points');
      p.deadband = n;
    }

    for (const [w, spec] of Object.entries(raw.windows || {})) {
      if (!Object.prototype.hasOwnProperty.call(WINDOW_LENGTH_S, w)) {
        throw new SetpointError(`setpoint.windows has unknown window ${JSON.stringify(w)}`);
      }
      const target = num(spec && spec.target, NaN);
      if (!(target > 0 && target <= 100)) {
        throw new SetpointError(`setpoint.windows.${w}.target must be a percentage in (0, 100] — the utilisation to reach BY RESET`);
      }
      const gain = (k, dflt) => {
        const n = num(spec[k], dflt);
        if (!(n >= 0)) throw new SetpointError(`setpoint.windows.${w}.${k} must be zero or more`);
        return n;
      };
      p.windows[w] = Object.freeze({
        target,
        kp: gain('kp', 0.06),
        ki: gain('ki', 0.01),
        kd: gain('kd', 0.30),
        // Anti-windup: the integrator is clamped to +/- this in "agent-equivalents".
        // Without it a long blind or burndown-clamped stretch accumulates a
        // recommendation that lands all at once the moment the clamp lifts.
        iClamp: gain('iClamp', 2),
      });
    }
    p.windows = Object.freeze(p.windows);
    return Object.freeze(p);
  }

  const DECLARATION_KEY = 'creel_setpoint';
  const STATE_KEY = 'creel_setpoint_state';

  function lsGet(key, dflt) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : dflt; } catch { return dflt; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
  }
  function parseDeclaration(raw) {
    const d = raw == null ? DEFAULT_DECLARATION : raw;
    if (!d || typeof d !== 'object') throw new SetpointError('setpoint declaration must be an object');
    const activeUntil = num(d.activeUntil, NaN);
    if (!(activeUntil > 0)) throw new SetpointError('setpoint.activeUntil must be an epoch-second timestamp');
    return Object.freeze({ activeUntil, active: parsePolicy(d.active), steady: parsePolicy(d.steady) });
  }
  function readDeclaration() { return parseDeclaration(lsGet(DECLARATION_KEY, null)); }
  function writeDeclaration(raw) {
    const d = parseDeclaration(raw);
    lsSet(DECLARATION_KEY, raw);
    return d;
  }
  function declaredPolicy(declaration, now) {
    const d = declaration || readDeclaration();
    return now < d.activeUntil ? d.active : d.steady;
  }

  // ── the trajectory ────────────────────────────────────────────────────

  /** Where utilisation SHOULD be now, if the window is to reach `target` exactly
   *  as it refills, spending evenly.
   *
   *  Returns null when it cannot be computed rather than guessing, and the two
   *  reasons are different: no reset published means we do not know when the
   *  window ends, and a reset further out than the window is long means the
   *  published length and reset disagree. Both make an elapsed fraction a
   *  fiction, and a fiction here is a fleet-sizing recommendation.
   *
   *  This is deliberately the same refusal `pace_ratio` makes in the st governor
   *  (aegis-7kwtu) — a wrong window length must produce NO answer, never a
   *  plausible one. */
  function trajectory(window, resetAt, now, target) {
    const len = WINDOW_LENGTH_S[window];
    if (!len || resetAt == null) return null;
    const remaining = resetAt - now;
    if (!(remaining > 0)) return null;          // reset is past; producer has not re-read
    if (remaining > len) return null;           // reset and length disagree — refuse
    const elapsedFraction = (len - remaining) / len;
    return target * elapsedFraction;
  }

  // ── the controller ────────────────────────────────────────────────────

  /** Recommend a fleet-size delta. PURE.
   *
   *  @param {object} o
   *  @param {object} o.policy      from parsePolicy()
   *  @param {object} o.verdict     a creel-governor verdict record
   *  @param {number} o.now         epoch seconds
   *  @param {object} o.integral    {window: accumulated} carried in
   *  @param {object} o.prev        {window: {pct, at}} the previous reading, for D
   *  @param {Array}  o.burndown    windows whose burndown is ARMED — output clamps to 0
   *  @param {number} o.liveAgents  agents currently live, for clamping against the fence
   *  @param {number} o.fenceMax    the hard cap the fence permits (max_agents)
   */
  function advise(o) {
    const policy = o.policy || DEFAULT_POLICY;
    const now = num(o.now, 0);
    const v = o.verdict || {};
    const prev = o.prev || {};
    const integralIn = o.integral || {};
    const burndown = Array.isArray(o.burndown) ? o.burndown : [];
    const liveAgents = Math.max(0, num(o.liveAgents, 0));
    const fenceMax = num(o.fenceMax, null);

    const declared = Object.keys(policy.windows);
    const windows = {};
    const integral = {};
    const holds = [];
    let worst = null;   // the window whose error most demands action

    for (const w of declared) {
      const spec = policy.windows[w];
      const reading = (v.provider && v.provider.windows && v.provider.windows[w]) || null;
      const row = { target: spec.target, trajectory: null, actual: null, error: null, frozen: false, hold: null };

      // ── the two freeze conditions, and they are NOT the same condition ──
      //
      // A lost signal is "we cannot see the gauge". A lower bound is "we can see
      // A gauge, and it reads at least X" — a real number, which is why it
      // engages tiers correctly and why it is not `unknown`. But it is wrong in
      // one DIRECTION only: creel counts what creel spent and cannot see the same
      // key spent by a CLI, another profile, or a colleague. So an integrator fed
      // a lower bound accumulates error one way forever — always under budget,
      // always grow — which is the dangerous direction and precisely the one the
      // I term acts on hardest.
      const lost = !reading || !reading.fresh;
      const lowerBound = !!(reading && reading.lowerBound);
      if (lost) { row.frozen = true; row.hold = HOLD_SIGNAL_LOST; }
      else if (lowerBound) { row.frozen = true; row.hold = HOLD_LOWER_BOUND; }

      const traj = reading ? trajectory(w, reading.resetAt, now, spec.target) : null;
      if (traj == null && !row.frozen) { row.frozen = true; row.hold = HOLD_NO_RESET; }

      row.trajectory = traj;
      row.actual = reading ? reading.pct : null;

      // The integrator is CARRIED, never reset, across a freeze. Zeroing it would
      // discard a genuine sustained drift measured before the gauge went dark,
      // and the fleet would re-learn it from scratch on recovery.
      integral[w] = num(integralIn[w], 0);

      if (row.frozen || traj == null || row.actual == null) {
        holds.push({ window: w, hold: row.hold });
        windows[w] = row;
        continue;
      }

      const error = traj - row.actual;           // + = behind trajectory (headroom going unspent)
      row.error = error;

      // P
      let out = spec.kp * error;

      // I — only outside the deadband, so noise around the setpoint does not
      // accumulate into a recommendation nobody would make deliberately.
      if (Math.abs(error) > policy.deadband) {
        const next = integral[w] + spec.ki * error;
        integral[w] = Math.max(-spec.iClamp, Math.min(spec.iClamp, next));
      }
      out += integral[w];

      // D — on the rate of change of ACTUAL, damping a spike before the brake
      // tier trips. Sign is negative: a fast climb subtracts from the
      // recommendation. Normalised per hour so the gain means the same thing
      // whichever cadence the caller runs at.
      const p = prev[w];
      if (p && p.at != null && p.pct != null && now > p.at) {
        const perHour = ((row.actual - p.pct) / (now - p.at)) * 3600;
        row.burnPerHour = perHour;
        out -= spec.kd * (perHour / 10);         // 10%/hr is the unit of "fast"
      }

      row.raw = out;
      windows[w] = row;
      if (worst === null || out < windows[worst].raw) worst = w;   // most restrictive wins
    }

    // ── compose ─────────────────────────────────────────────────────────
    // The most RESTRICTIVE window wins, exactly as the governor's tiers compose.
    // Never an average: an average lets a fresh five-hour window mask an
    // exhausted weekly, which was the original single-window bug one layer down.
    let delta = 0;
    let reason;
    let hold = null;

    if (!declared.length) {
      hold = HOLD_NO_SETPOINT;
      reason = 'no setpoint declared — the controller is inert and recommends nothing';
    } else if (worst === null) {
      hold = holds.length ? holds[0].hold : HOLD_SIGNAL_LOST;
      reason = `no window is usable — ${holds.map((h) => `${h.window}: ${h.hold}`).join('; ')}`;
    } else if (burndown.length) {
      // BURNDOWN OUTRANKS (v1). It is already spending the window down on
      // purpose; a controller adding growth on top of it double-counts at
      // exactly the moment the budget is tightest, and both mechanisms look
      // correct in isolation. v2 merges them so this precedence can retire.
      hold = HOLD_BURNDOWN;
      reason = `burndown armed on ${burndown.join(', ')} — it owns the end of the window; controller output clamped to 0`;
    } else {
      const raw = windows[worst].raw;
      const err = windows[worst].error;
      if (Math.abs(err) <= policy.deadband) {
        hold = HOLD_ON_TRAJECTORY;
        reason = `${worst} is within ${policy.deadband} points of trajectory (error ${err.toFixed(1)}) — hold`;
      } else {
        delta = Math.max(-policy.maxDelta, Math.min(policy.maxDelta, Math.round(raw)));
        reason = delta === 0
          ? `${worst} error ${err.toFixed(1)} points, but the computed delta rounds to 0 — hold`
          : `${worst} is ${err > 0 ? 'BEHIND' : 'AHEAD OF'} trajectory by ${Math.abs(err).toFixed(1)} points — recommend ${delta > 0 ? '+' : ''}${delta}`;
      }
    }

    // ── the fence, which the controller may never move ──────────────────
    // Clamping here rather than at the consumer so the recommendation a human
    // reads is already the one that could actually be enacted. A recommendation
    // that the fence would refuse is not advice, it is noise.
    const fenced = { delta, clampedBy: null };
    if (fenceMax != null && delta > 0 && liveAgents + delta > fenceMax) {
      fenced.delta = Math.max(0, fenceMax - liveAgents);
      fenced.clampedBy = `max_agents ${fenceMax} (${liveAgents} live)`;
    }
    if (v.drain && v.drain.allowed === true && v.verdict === 'refuse'
        && v.admission && v.admission.capSource === 'provider-drain' && fenced.delta > 0) {
      fenced.delta = 0;
      fenced.clampedBy = 'provider drain engaged — the fence never moves because the controller says so';
    }

    // A frozen controller must SAY so, every pass. A 0 that means "I cannot see"
    // and a 0 that means "we are exactly on trajectory" are opposite facts, and
    // the reader acts differently on each.
    const alarm = (hold === HOLD_SIGNAL_LOST || hold === HOLD_LOWER_BOUND)
      ? `CONTROLLER FROZEN [${holds.map((h) => `${h.window}: ${h.hold}`).join(', ')}] — recommending nothing because the gauge cannot drive growth, NOT because the fleet is correctly sized`
      : '';

    return {
      contract: 'creel.setpoint/1',
      advisory: fenced.delta,
      aggressiveness: worst !== null && windows[worst].error != null
        ? Math.max(-1, Math.min(1, windows[worst].error / 100)) : 0,
      hold,
      reason,
      alarm,
      clampedBy: fenced.clampedBy,
      preClampDelta: delta,
      at: now,
      windows,
      integral,
      governing: worst,
    };
  }

  /** One line for a human, for `st tend` and the dashboard. */
  function explain(a) {
    const mark = a.advisory > 0 ? '↑' : a.advisory < 0 ? '↓' : '·';
    const d = a.advisory > 0 ? `+${a.advisory}` : String(a.advisory);
    return `${mark} governor recommends ${d} — ${a.reason}`
      + (a.clampedBy ? `\n  clamped by ${a.clampedBy}` : '')
      + (a.alarm ? `\n  ${a.alarm}` : '');
  }

  /** Drive the controller over a series of historical readings. THE ACCEPTANCE
   *  RUNS THROUGH HERE — replaying recorded governor states is the only way to
   *  test a controller before it is allowed to advise on anything live. */
  function replay(policy, samples, opts) {
    opts = opts || {};
    let integral = opts.integral || {};
    let prev = {};
    const out = [];
    for (const s of samples) {
      const a = advise({
        policy, verdict: s.verdict, now: s.now, integral, prev,
        burndown: s.burndown || [], liveAgents: s.liveAgents, fenceMax: s.fenceMax,
      });
      integral = a.integral;
      const w = (s.verdict && s.verdict.provider && s.verdict.provider.windows) || {};
      prev = {};
      for (const [k, r] of Object.entries(w)) if (r && r.pct != null && r.fresh) prev[k] = { pct: r.pct, at: s.now };
      out.push(a);
    }
    return out;
  }

  function recommend(o) {
    o = o || {};
    const now = num(o.now, Math.floor(Date.now() / 1000));
    const declaration = o.declaration || readDeclaration();
    const state = o.state || lsGet(STATE_KEY, { integral: {}, prev: {} });
    const windows = (o.verdict && o.verdict.provider && o.verdict.provider.windows) || {};
    const sampleSignature = JSON.stringify(Object.entries(windows).map(([w, r]) => [
      w, r && r.pct, r && r.at, r && r.resetAt, r && r.fresh, r && r.lowerBound,
    ]));
    let policy = o.policy || declaredPolicy(declaration, now);
    // resolveCaps is a read seam, not a clock tick. Dashboard repaints and
    // spawn preflights can inspect one provider sample many times; integrating
    // each inspection would make controller gain depend on render frequency.
    // A repeated sample still recomputes P, D and the live-agent fence, but its
    // I contribution is zero.
    if (state.sampleSignature === sampleSignature) {
      policy = Object.freeze({
        ...policy,
        windows: Object.freeze(Object.fromEntries(Object.entries(policy.windows)
          .map(([w, spec]) => [w, Object.freeze({ ...spec, ki: 0 })]))),
      });
    }
    const a = advise({
      policy, verdict: o.verdict,
      now, integral: state.integral || {}, prev: state.prev || {},
      burndown: o.burndown || [], liveAgents: o.liveAgents, fenceMax: o.fenceMax,
    });
    const prev = {};
    for (const [w, r] of Object.entries(windows)) if (r && r.pct != null && r.fresh) prev[w] = { pct: r.pct, at: now };
    if (o.persist !== false) lsSet(STATE_KEY, { integral: a.integral, prev, sampleSignature });
    return { ...a, phase: now < declaration.activeUntil ? 'aggressive' : 'steady', sampleSignature };
  }

  const api = {
    CONTRACT: 'creel.setpoint/1',
    DEFAULT_POLICY, WINDOW_LENGTH_S, SetpointError,
    HOLD_ON_TRAJECTORY, HOLD_SIGNAL_LOST, HOLD_LOWER_BOUND,
    HOLD_BURNDOWN, HOLD_NO_SETPOINT, HOLD_NO_RESET,
    DEFAULT_DECLARATION, parsePolicy, parseDeclaration, readDeclaration,
    writeDeclaration, declaredPolicy, trajectory, advise, recommend, explain, replay,
    _keys: { DECLARATION_KEY, STATE_KEY },
  };

  if (typeof window !== 'undefined') window.CreelSetpoint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
