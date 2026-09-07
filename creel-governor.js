/* creel — the budget governor: what the provider's budget and this device's
 * tab cap, together, will admit right now.
 *
 * Creel already had HALF an admission policy. `creel-device.js` caps concurrent
 * agent tabs by device class because mobile browsers evict background tabs, and
 * every spawn path consults it. What it could not see is the other wall a burst
 * hits: the provider's usage window. A phone that can hold three tabs and a key
 * that is 96% through its weekly budget are two different reasons not to spawn,
 * and only one of them was being checked.
 *
 * This module composes both into ONE verdict — admit, refuse, or unknown — and
 * that verdict is the same object for the operator (the dashboard), for agents
 * (`fleet_governor`), and for anything outside the browser preflighting a creel
 * launch (`tools/creel-admission.js`). One record, one contract, three readers:
 * a governor whose operator view and agent view can disagree is worse than none.
 *
 * ── THREE PROPERTIES, EACH LEARNED SOMEWHERE ELSE THE EXPENSIVE WAY ──────────
 *
 * 1. A STALE READING IS NOT A READING, AND BLINDNESS NEVER REFUSES BY DEFAULT.
 *    The last percentage of a dead probe reads green forever, which holds a
 *    spending fleet wide open at a number from last week. So an aged-out reading
 *    is SIGNAL LOST, loudly, every pass. But the fail-safe runs the other way at
 *    enforcement: a probe bug must not be able to stop a fleet, so `warn` is the
 *    default and `freeze` is opt-in. Which is why `verdict` and `enforced` are
 *    two fields rather than one — see the Verdict comment.
 *
 * 2. THE GOVERNOR IS INERT UNTIL SOMEBODY DECLARES A BUDGET. A default policy
 *    with tiers in it would put every fresh install into SIGNAL LOST on its
 *    first pass, and an alarm that fires on a clean install is an alarm people
 *    learn to close. `governed: false` is a first-class answer, not a silence:
 *    it says creel is governing by device cap alone and names what is missing.
 *
 * 3. CREEL'S OWN TOKEN LEDGER IS A LOWER BOUND, NEVER A MEASUREMENT. Creel can
 *    count what creel spent. It cannot see the same key being used by a CLI, a
 *    second browser profile, or a colleague. So a ledger reading of 20% is
 *    consistent with the provider being at 95%, and treating it as a measurement
 *    is the exact shape where one output stands for two different worlds. A
 *    ledger source may therefore REFUSE (a lower bound above a threshold is
 *    still above it) and may not by itself ADMIT — unless the operator declares
 *    the key exclusive to this browser, which is the only thing that can make it
 *    a measurement, and which only the operator knows.
 *
 * Pure and dependency-free, like creel-device.js. `verdict()` is a total
 * function of its arguments — no clock, no storage, no globals — so the whole
 * policy is exercisable from `node tests/test-governor.js`. The impure parts
 * (localStorage, response headers, Date.now) are thin wrappers around it.
 *
 * Loads after creel-device.js and before creel-fleet.js in thread.html.
 */
(() => {
  'use strict';

  /** The wire contract. Bump only for a breaking change to the record shape:
   *  CABOODLE preflights a creel install against this and must be able to tell
   *  a field it does not understand from a field that is missing. */
  const CONTRACT = 'creel.admission/1';

  const FIVE_HOUR = 'five_hour';
  const SEVEN_DAY = 'seven_day';
  const WINDOWS = [FIVE_HOUR, SEVEN_DAY];
  const WINDOW_LENGTH_S = { [FIVE_HOUR]: 5 * 3600, [SEVEN_DAY]: 7 * 86400 };

  const ADMIT = 'admit';
  const REFUSE = 'refuse';
  const UNKNOWN = 'unknown';

  /** Where a reading came from, most authoritative first. `headers` is the
   *  provider's own accounting; `manual` is the operator reading their console;
   *  `ledger` is creel counting its own spend (see property 3 above). */
  const SOURCES = ['headers', 'manual', 'ledger'];

  const WARN = 'warn';
  const FREEZE = 'freeze';

  /** How old a reading may be before it is SIGNAL LOST rather than a number.
   *  Fifteen minutes because the header source refreshes on every model call:
   *  a fleet doing any work at all re-reads far faster than this, so aging out
   *  means the fleet is idle (nothing to govern) or the source has failed. */
  const DEFAULT_MAX_AGE_S = 900;

  /** Leaving a tier requires falling this far below its threshold. Without it a
   *  reading oscillating around 70 re-plans the burst on every pass, and each
   *  flip is a spawn decision an agent has already acted on. */
  const DEFAULT_RELAX_MARGIN = 5;

  class GovernorError extends Error {}

  // ── policy ────────────────────────────────────────────────────────────
  //
  // A tier is a percentage threshold on ONE window plus what holds while it is
  // engaged. `maxTabs` is the only restriction creel has to offer — there is no
  // priority floor in a browser burst and no trait bands, because there is one
  // operator and every tab is theirs. `drain: true` is the full stop.
  //
  // TIERS ARE PER-WINDOW ON PURPOSE. The two budgets exhaust independently and
  // refill at wildly different speeds, so a five-hour window at 80% and a weekly
  // at 80% are not the same situation, and averaging them lets a fresh five-hour
  // reading mask an exhausted week.

  const DEFAULT_POLICY = Object.freeze({
    // No windows declared -> the governor is INERT (property 2). This is the
    // shipped default and it is deliberately not a set of example tiers: an
    // example threshold governs a real budget the moment somebody forgets to
    // change it.
    windows: Object.freeze({}),
    onSignalLost: WARN,
    maxAgeS: DEFAULT_MAX_AGE_S,
    relaxMargin: DEFAULT_RELAX_MARGIN,
    // The operator's declaration that this key is spent by this browser and
    // nothing else. The ONLY thing that promotes the local ledger from a lower
    // bound to a measurement, and the only person who can know it is the one
    // holding the key.
    ledgerExclusive: false,
    // {window: tokens} — what the operator says the budget IS, so the local
    // ledger has a denominator. Without one the ledger source cannot produce a
    // percentage at all, which is correct: a token count with no budget behind
    // it is a number, not a reading.
    tokenBudgets: Object.freeze({}),
  });

  function num(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  /** A number, or null if there was nothing to read. Distinct from num() because
   *  Number(null), Number(undefined) and Number('') do not all mean the same
   *  thing to JavaScript and none of them mean it to us: an absent header is not
   *  a zero. Used wherever a missing input must stay missing. */
  function strictNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Validate a policy object, naming the key that is wrong. A governor that
   *  silently drops a malformed tier governs less than the operator thinks it
   *  does, which is the failure that has no symptom. */
  function parsePolicy(raw) {
    const p = { ...DEFAULT_POLICY, windows: {} };
    if (raw == null) return Object.freeze(p);
    if (typeof raw !== 'object') throw new GovernorError('governor policy must be an object');

    if (raw.onSignalLost != null) {
      if (raw.onSignalLost !== WARN && raw.onSignalLost !== FREEZE) {
        throw new GovernorError(`governor.onSignalLost must be "${WARN}" or "${FREEZE}", got ${JSON.stringify(raw.onSignalLost)}`);
      }
      p.onSignalLost = raw.onSignalLost;
    }
    if (raw.maxAgeS != null) {
      const n = num(raw.maxAgeS, NaN);
      if (!(n > 0)) throw new GovernorError('governor.maxAgeS must be a positive number of seconds');
      p.maxAgeS = n;
    }
    if (raw.relaxMargin != null) {
      const n = num(raw.relaxMargin, NaN);
      if (!(n >= 0)) throw new GovernorError('governor.relaxMargin must be zero or more percentage points');
      p.relaxMargin = n;
    }
    if (raw.ledgerExclusive != null) {
      if (typeof raw.ledgerExclusive !== 'boolean') throw new GovernorError('governor.ledgerExclusive must be true or false');
      p.ledgerExclusive = raw.ledgerExclusive;
    }

    p.tokenBudgets = {};
    for (const [w, v] of Object.entries(raw.tokenBudgets || {})) {
      if (!WINDOWS.includes(w)) {
        throw new GovernorError(`governor.tokenBudgets has unknown window ${JSON.stringify(w)} — known: ${WINDOWS.join(', ')}`);
      }
      const n = num(v, NaN);
      if (!(n > 0)) throw new GovernorError(`governor.tokenBudgets.${w} must be a positive token count`);
      p.tokenBudgets[w] = n;
    }
    p.tokenBudgets = Object.freeze(p.tokenBudgets);

    for (const [w, spec] of Object.entries(raw.windows || {})) {
      if (!WINDOWS.includes(w)) {
        throw new GovernorError(`governor.windows has unknown window ${JSON.stringify(w)} — known: ${WINDOWS.join(', ')}`);
      }
      const tiers = (spec && spec.tiers) || [];
      if (!Array.isArray(tiers) || !tiers.length) {
        throw new GovernorError(`governor.windows.${w} declares no tiers — remove the window or give it at least one`);
      }
      const seen = new Set();
      const parsed = tiers.map((t, i) => {
        const where = `governor.windows.${w}.tiers[${i}]`;
        const at = num(t && t.at, NaN);
        if (!(at >= 0 && at <= 100)) throw new GovernorError(`${where}.at must be a percentage 0..100`);
        // Two tiers at one threshold means the governor picks one silently and
        // the operator never learns which. Refused, the way st refuses it.
        if (seen.has(at)) throw new GovernorError(`${where}.at duplicates ${at} — thresholds must be unique within a window`);
        seen.add(at);
        const drain = t.drain === true;
        let maxTabs = null;
        if (t.maxTabs != null) {
          const n = num(t.maxTabs, NaN);
          if (!(Number.isInteger(n) && n >= 0)) throw new GovernorError(`${where}.maxTabs must be a non-negative integer`);
          maxTabs = n;
        }
        if (!drain && maxTabs === null) {
          throw new GovernorError(`${where} declares no restriction — give it maxTabs, or drain: true`);
        }
        return Object.freeze({ at, window: w, maxTabs, drain });
      }).sort((a, b) => a.at - b.at);
      p.windows[w] = Object.freeze({ tiers: Object.freeze(parsed) });
    }
    p.windows = Object.freeze(p.windows);
    return Object.freeze(p);
  }

  /** What this tier does, in one clause, for a refusal an operator can act on.
   *  Every label names its window: "usage 72%" with no window sends somebody to
   *  look at the wrong budget, and the two refill days apart. */
  function tierLabel(t) {
    const what = t.drain ? 'FULL STOP — no new tabs; running tabs finish and push'
      : t.maxTabs === 0 ? 'no new agent tabs'
        : `at most ${t.maxTabs} agent tab${t.maxTabs === 1 ? '' : 's'}`;
    return `${what} [${t.window} >= ${t.at}%]`;
  }

  // ── readings ──────────────────────────────────────────────────────────

  /** One observation of one window's budget.
   *
   *  `pct == null` and `error` non-empty are both could-not-look and are kept
   *  apart because they need different fixes: no value means nothing has been
   *  recorded for that window yet, while an error means a source ran and failed.
   *
   *  `lowerBound` is the ledger's honesty flag (property 3): the number is real
   *  and the true figure is at least this, so it may refuse and may not admit.
   */
  function reading(o) {
    o = o || {};
    return {
      pct: o.pct == null ? null : num(o.pct, null),
      at: o.at == null ? null : num(o.at, null),
      resetAt: o.resetAt == null ? null : num(o.resetAt, null),
      source: o.source || '',
      limitId: o.limitId || null,
      error: o.error || '',
      lowerBound: o.lowerBound === true,
    };
  }

  /** "" if this reading is usable, else WHY it is not — the string an operator
   *  reads when the fleet is running ungoverned. */
  function lost(r, now, maxAgeS) {
    if (!r) return 'no reading recorded for this window — nothing is publishing a usage number to govern by';
    if (r.error) return r.error;
    if (r.pct == null) return 'no usage percentage recorded for this window yet';
    if (r.at == null) {
      return 'the reading carries no timestamp, so its age cannot be checked — an unaged reading is indistinguishable from a frozen one';
    }
    const age = now - r.at;
    if (age > maxAgeS) {
      return `the reading is ${Math.round(age)}s old (limit ${Math.round(maxAgeS)}s) — STALE, and a stale number reads green forever`;
    }
    if (age < -maxAgeS) {
      return `the reading is timestamped ${Math.round(-age)}s in the FUTURE — clock skew, so its age cannot be trusted`;
    }
    return '';
  }

  // ── the verdict ───────────────────────────────────────────────────────

  /** Compose provider windows and the device tab cap into one admission answer.
   *
   *  PURE: every input is an argument and nothing is read from the clock, the
   *  DOM, or storage. `held` in, `held` out, so hysteresis is the caller's
   *  state rather than a hidden variable — which is what lets a test drive a
   *  reading up and down across a threshold and assert it does not flap.
   *
   *  TWO ANSWERS, DELIBERATELY, and conflating them is the trap this shape
   *  exists to prevent:
   *
   *    verdict   what is TRUE about the budget: admit | refuse | unknown
   *    enforced  what creel DOES about it:      allow  | block
   *
   *  They differ exactly when the signal is lost under `onSignalLost: warn` —
   *  the honest answer is "I cannot tell" and the applied consequence is "run
   *  anyway, loudly", because no probe failure may be able to stop a fleet. A
   *  single field would have to lie about one of them, and the field a caller
   *  reaches for first is not the same for the dashboard, an agent, and a
   *  preflight gate.
   *
   *  @param {object}   o
   *  @param {object}   o.policy     from parsePolicy()
   *  @param {object}   o.readings   {window: reading}
   *  @param {number}   o.now        epoch seconds
   *  @param {string}   o.device     'mobile' | 'tablet' | 'desktop'
   *  @param {number}   o.deviceCap  concurrent agent tabs this device allows
   *  @param {number}   o.running    agent tabs live right now
   *  @param {number}   o.want       tabs being asked for (default 1)
   *  @param {object}   o.held       {window: at} tiers held by hysteresis
   */
  function verdict(o) {
    const policy = o.policy || DEFAULT_POLICY;
    const now = num(o.now, 0);
    const readings = o.readings || {};
    const deviceCap = Math.max(0, num(o.deviceCap, 8));
    const running = Math.max(0, num(o.running, 0));
    const want = Math.max(1, num(o.want, 1));
    const prevHeld = o.held || {};

    const declared = Object.keys(policy.windows);
    // Evidence and policy are different axes.  A headless reader can be handed
    // a real provider sample even when it cannot see a browser's localStorage
    // policy.  Preserve that sample in the record without letting it govern
    // admission; the setpoint controller is a consumer of evidence, while
    // `declared` remains the only enabling act for the brake.
    const observed = [...new Set([...declared, ...Object.keys(readings)])];
    const governed = declared.length > 0;

    const windows = {};
    const engaged = [];
    const signalLost = [];
    const lowerBoundOnly = [];
    const held = {};

    for (const w of observed) {
      const r = readings[w] || null;
      const why = lost(r, now, policy.maxAgeS);
      const tiers = policy.windows[w] ? policy.windows[w].tiers : [];

      const row = {
        pct: r && why === '' ? r.pct : (r ? r.pct : null),
        source: r ? r.source : '',
        at: r ? r.at : null,
        ageSec: (r && r.at != null) ? Math.round(now - r.at) : null,
        resetAt: r ? r.resetAt : null,
        resetInSec: (r && r.resetAt != null) ? Math.round(r.resetAt - now) : null,
        limitId: r ? r.limitId : null,
        lowerBound: !!(r && r.lowerBound),
        fresh: why === '',
        error: why,
        tier: null,
      };

      if (why !== '') {
        if (declared.includes(w)) signalLost.push(w);
        windows[w] = row;
        continue;                       // a lost window engages nothing, and a
      }                                 // held tier does not survive blindness:
                                        // hysteresis holds a MEASUREMENT, and
                                        // there is no longer one.

      // A ledger reading is a lower bound. Above a threshold that is still
      // proof — the true figure is at least this — so it engages normally. Below
      // every threshold it proves nothing, so it may not clear the window.
      const promoted = row.lowerBound && !policy.ledgerExclusive;

      // Hysteresis: a tier that was engaged stays engaged until the reading
      // falls `relaxMargin` points BELOW its threshold. Applies on the way up
      // too — leaving and immediately re-entering is the same flap.
      const wasAt = prevHeld[w];
      const top = tiers.filter((t) => {
        if (row.pct >= t.at) return true;
        return wasAt != null && t.at <= wasAt && row.pct >= t.at - policy.relaxMargin;
      }).pop() || null;

      if (top) {
        held[w] = top.at;
        engaged.push(top);
        row.tier = { at: top.at, window: w, maxTabs: top.maxTabs, drain: top.drain, label: tierLabel(top) };
      } else if (promoted) {
        // Below every threshold on a lower-bound source: not a refusal and not
        // a clearance. Reported as its own thing rather than folded into
        // signalLost, because the fix is different — declare the key exclusive,
        // or read the provider's own number.
        lowerBoundOnly.push(w);
      }
      windows[w] = row;
    }

    // ── compose the caps ────────────────────────────────────────────────
    // Strictest wins. The device cap is a STATIC number an operator's hardware
    // implies; it needs no reading, so a dead usage source can never uncap the
    // fleet. Tier caps ride `engaged`, which is already empty when blind — so a
    // failed source relaxes toward the DEVICE cap, never toward unlimited.
    const drains = engaged.some((t) => t.drain);
    const tierCaps = engaged.filter((t) => t.maxTabs != null).map((t) => t.maxTabs);
    const providerCap = drains ? 0 : (tierCaps.length ? Math.min(...tierCaps) : null);
    const maxTabs = providerCap == null ? deviceCap : Math.min(deviceCap, providerCap);
    const free = Math.max(0, maxTabs - running);

    // Which wall are we actually against? Named, because "no free slots" sends
    // an operator to close tabs when the answer is that the week is spent.
    const capSource = drains ? 'provider-drain'
      : (providerCap != null && providerCap <= deviceCap) ? 'provider-tier'
        : 'device-cap';

    // ── the verdict ─────────────────────────────────────────────────────
    // refuse > unknown > admit. A definite refusal is not made uncertain by a
    // second blind window: if one budget says stop, we know the answer.
    let v = ADMIT;
    let reason;
    const blind = signalLost.length > 0 || lowerBoundOnly.length > 0;

    if (free < want) {
      v = REFUSE;
      reason = drains
        ? `provider budget exhausted — ${engaged.filter((t) => t.drain).map(tierLabel).join('; ')}`
        : capSource === 'provider-tier'
          ? `provider budget throttled to ${maxTabs} tab${maxTabs === 1 ? '' : 's'}, ${running} already running — ${engaged.map(tierLabel).join('; ')}`
          : `at the ${deviceCap}-tab ${o.device || 'device'} cap with ${running} running — ${free} slot${free === 1 ? '' : 's'} free, ${want} asked for`;
    } else if (blind) {
      v = UNKNOWN;
      reason = signalLost.length
        ? `usage signal lost for ${signalLost.join(', ')} — running UNGOVERNED on the ${deviceCap}-tab ${o.device || 'device'} cap alone`
        : `only creel's own token ledger is reporting ${lowerBoundOnly.join(', ')}, and it cannot see spend from any other client — a low reading here is not evidence the budget is open`;
    } else if (!governed) {
      reason = `no provider budget declared — admitting on the ${deviceCap}-tab ${o.device || 'device'} cap alone, ${free} slot${free === 1 ? '' : 's'} free`;
    } else {
      reason = `${free} slot${free === 1 ? '' : 's'} free of ${maxTabs}`
        + (engaged.length ? ` — ${engaged.map(tierLabel).join('; ')}` : ' — no tier engaged');
    }

    // Enforcement. Blindness alarms; whether it BLOCKS is the operator's call
    // and defaults to no, because a source that fails must not be able to stop
    // a fleet. A refusal always blocks: that one is a measurement.
    const enforced = (v === REFUSE || (v === UNKNOWN && policy.onSignalLost === FREEZE))
      ? 'block' : 'allow';

    // The alarm is separate from the reason and is meant to be repeated EVERY
    // pass while it stands. A blind governor that says so once is a blind
    // governor.
    let alarm = '';
    if (signalLost.length) {
      alarm = `USAGE SIGNAL LOST [${signalLost.join(', ')}] — ${signalLost.map((w) => `${w}: ${windows[w].error}`).join(' | ')}`;
    } else if (lowerBoundOnly.length) {
      alarm = `USAGE IS A LOWER BOUND [${lowerBoundOnly.join(', ')}] — creel is counting only its own spend; set ledgerExclusive if this key is used by nothing else`;
    }

    return {
      contract: CONTRACT,
      verdict: v,
      enforced,
      governed,
      reason,
      alarm,
      at: now,
      provider: {
        declared,
        windows,
        engaged: engaged.map((t) => ({ at: t.at, window: t.window, maxTabs: t.maxTabs, drain: t.drain, label: tierLabel(t) })),
        signalLost,
        lowerBoundOnly,
        onSignalLost: policy.onSignalLost,
      },
      device: { kind: o.device || 'desktop', cap: deviceCap, running },
      admission: { maxTabs, running, free, want, capSource, deviceCap, providerCap },
      // Draining is ALWAYS available and that is an invariant, not a default.
      // A refusal that also stranded queued work would turn a budget guard into
      // a work-loss event: the tabs already running hold the only copy of what
      // they have done, and getting it out costs nothing the budget cares about.
      drain: {
        allowed: true,
        note: 'refusal governs NEW agent tabs only — running tabs finish, fleet_drain, fleet_report, state_push and github_push are never governed',
      },
      held,
    };
  }

  /** One line for a human. The dashboard shows this; so does a refusal. */
  function explain(v) {
    const mark = v.verdict === ADMIT ? '✓' : v.verdict === REFUSE ? '✕' : '?';
    return `${mark} ${v.verdict.toUpperCase()} — ${v.reason}${v.alarm ? `\n  ${v.alarm}` : ''}`;
  }

  // ── the impure edges ──────────────────────────────────────────────────
  // Everything below touches storage, the clock, or a Response. The engine
  // above does not, and that is what makes the policy testable in node.

  const POLICY_KEY = 'creel_governor';
  const READINGS_KEY = 'creel_governor_readings';
  const LEDGER_KEY = 'creel_governor_ledger';
  const HELD_KEY = 'creel_governor_held';

  const nowS = () => Math.floor(Date.now() / 1000);

  function lsGet(key, dflt) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : dflt;
    } catch { return dflt; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
  }

  function readPolicy() {
    try { return parsePolicy(lsGet(POLICY_KEY, null)); } catch (e) {
      // A policy that will not parse is not a reason to run ungoverned in
      // silence. Fall back to inert and carry the error where a reader sees it.
      const p = { ...DEFAULT_POLICY, error: String(e.message || e) };
      return Object.freeze(p);
    }
  }
  function writePolicy(raw) {
    const p = parsePolicy(raw);            // throws before anything is stored
    lsSet(POLICY_KEY, raw || {});
    return p;
  }

  // ── source: provider response headers ─────────────────────────────────
  //
  // The only signal in a browser that is the PROVIDER'S OWN accounting rather
  // than ours. It arrives free on every model call — but only if the endpoint
  // lists these headers in Access-Control-Expose-Headers, which is a property of
  // the endpoint and not of creel. When it does not, `observe` records the
  // ABSENCE as a named error rather than leaving the window silently empty:
  // "the endpoint exposed no rate-limit headers to this origin" is a fixable
  // fact, and an empty window is a mystery.

  const HEADER_MAP = [
    // [header prefix, window, what the pair measures]
    ['anthropic-ratelimit-tokens', SEVEN_DAY, 'tokens'],
    ['anthropic-ratelimit-input-tokens', FIVE_HOUR, 'input-tokens'],
    ['anthropic-ratelimit-output-tokens', FIVE_HOUR, 'output-tokens'],
    ['anthropic-ratelimit-requests', FIVE_HOUR, 'requests'],
    ['x-ratelimit-tokens', FIVE_HOUR, 'tokens'],
    ['x-ratelimit-requests', FIVE_HOUR, 'requests'],
  ];

  /** limit/remaining -> percent CONSUMED. Providers publish what is left; a
   *  governor thresholds on what is spent, and inverting at the seam means no
   *  reader downstream has to remember which direction this provider counts. */
  function pctFromPair(limit, remaining) {
    // strictNum, not num(): Number(null) and Number('') are both 0, so a header
    // the endpoint did not send would read as "0 remaining" — i.e. 100%
    // consumed — and the governor would refuse a wide-open budget on the
    // strength of a header that does not exist. An ABSENT input must produce an
    // absent reading, never a confident extreme.
    const l = strictNum(limit);
    const r = strictNum(remaining);
    if (l == null || r == null || !(l > 0)) return null;
    return Math.max(0, Math.min(100, ((l - r) / l) * 100));
  }

  function parseResetHeader(v, now) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      // A bare integer is seconds-until on some providers and an epoch on
      // others. Anything below the epoch floor cannot be an epoch.
      return n > 1e9 ? n : now + n;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }

  /** Read whatever rate-limit headers a provider response carries. Returns
   *  {window: reading}; a window nothing spoke about is simply absent. */
  function readingsFromHeaders(headers, now) {
    const get = (k) => {
      try { return headers && typeof headers.get === 'function' ? headers.get(k) : null; } catch { return null; }
    };
    const out = {};
    for (const [prefix, window, limitId] of HEADER_MAP) {
      const pct = pctFromPair(get(`${prefix}-limit`), get(`${prefix}-remaining`));
      if (pct == null) continue;
      const r = reading({
        pct, at: now, source: 'headers', limitId,
        resetAt: parseResetHeader(get(`${prefix}-reset`), now),
      });
      // Two limits mapping to one window: keep the more consumed. They are
      // separate walls and hitting either one stops the call, so the binding
      // constraint is the higher number, never an average of them.
      if (!out[window] || r.pct > out[window].pct) out[window] = r;
    }
    return out;
  }

  /** Called from the provider fetch seam. Records what the response revealed —
   *  including that it revealed nothing. Never throws into the caller. */
  function observe(url, resp, opts) {
    opts = opts || {};
    const now = num(opts.now, nowS());
    try {
      const llmUrl = String(opts.llmUrl || '');
      // Only the model endpoint's headers describe the model budget. A GitHub
      // or MCP response carrying an x-ratelimit header is a different limit
      // entirely, and filing it under the provider window would be a true
      // number answering an adjacent question.
      if (!llmUrl || String(url || '') !== llmUrl) return null;
      const fresh = readingsFromHeaders(resp && resp.headers, now);
      const store = lsGet(READINGS_KEY, {});
      if (!Object.keys(fresh).length) {
        store.headersExposed = false;
        store.headersCheckedAt = now;
      } else {
        store.headersExposed = true;
        store.headersCheckedAt = now;
        for (const [w, r] of Object.entries(fresh)) store[w] = r;
      }
      lsSet(READINGS_KEY, store);
      return fresh;
    } catch { return null; }
  }

  /** Operator-entered reading: they can see their own console, and on a BYO-key
   *  harness that is often the only honest number available. */
  function recordManual(window, pct, opts) {
    opts = opts || {};
    if (!WINDOWS.includes(window)) throw new GovernorError(`unknown window ${JSON.stringify(window)} — known: ${WINDOWS.join(', ')}`);
    const n = num(pct, NaN);
    if (!(n >= 0 && n <= 100)) throw new GovernorError('pct must be a percentage 0..100');
    const store = lsGet(READINGS_KEY, {});
    store[window] = reading({
      pct: n, at: num(opts.now, nowS()), source: 'manual',
      resetAt: opts.resetAt == null ? null : num(opts.resetAt, null),
    });
    lsSet(READINGS_KEY, store);
    return store[window];
  }

  // ── source: creel's own token ledger ──────────────────────────────────
  //
  // A rolling record of tokens creel spent, bucketed so a window's total is a
  // sum over the buckets inside it. Every reading it produces is marked
  // lowerBound (property 3) — the arithmetic is exact and the premise is not.

  const BUCKET_S = 300;

  function recordSpend(tokens, opts) {
    opts = opts || {};
    const t = Math.max(0, num(tokens, 0));
    if (!t) return null;
    const now = num(opts.now, nowS());
    const bucket = Math.floor(now / BUCKET_S) * BUCKET_S;
    const led = lsGet(LEDGER_KEY, {});
    led[bucket] = (led[bucket] || 0) + t;
    // Drop anything older than the longest window — the ledger is a governor
    // input, not an accounting record, and an unbounded one eventually fills
    // the origin's storage quota and takes the fleet queue down with it.
    const floor = now - WINDOW_LENGTH_S[SEVEN_DAY];
    for (const k of Object.keys(led)) if (Number(k) < floor) delete led[k];
    lsSet(LEDGER_KEY, led);
    return led[bucket];
  }

  function spentIn(windowS, now, led) {
    const floor = now - windowS;
    let sum = 0;
    for (const [k, v] of Object.entries(led || {})) if (Number(k) >= floor) sum += num(v, 0);
    return sum;
  }

  /** Ledger readings for whatever windows the policy declares a token budget
   *  for. `budgets` is {window: tokens}; a window with no declared budget gets
   *  no ledger reading, because a percentage needs a denominator. */
  function readingsFromLedger(budgets, opts) {
    opts = opts || {};
    const now = num(opts.now, nowS());
    const led = opts.ledger || lsGet(LEDGER_KEY, {});
    const out = {};
    for (const [w, budget] of Object.entries(budgets || {})) {
      const b = num(budget, 0);
      if (!WINDOWS.includes(w) || !(b > 0)) continue;
      out[w] = reading({
        pct: Math.min(100, (spentIn(WINDOW_LENGTH_S[w], now, led) / b) * 100),
        at: now, source: 'ledger', lowerBound: true,
      });
    }
    return out;
  }

  /** Everything we can currently see, most authoritative source winning per
   *  window. A window with no source at all is left absent so `verdict` reports
   *  it as signal lost rather than inventing a zero — "we cannot see the
   *  budget" must never become "the budget is empty". */
  function currentReadings(opts) {
    opts = opts || {};
    const now = num(opts.now, nowS());
    const store = opts.store || lsGet(READINGS_KEY, {});
    const budgets = opts.budgets || readPolicy().tokenBudgets || {};
    const out = {};

    for (const w of WINDOWS) if (store[w]) out[w] = reading(store[w]);
    for (const [w, r] of Object.entries(readingsFromLedger(budgets, { now, ledger: opts.ledger }))) {
      // Ledger only fills a gap: a provider number beats our own count every
      // time, because ours is a lower bound on theirs.
      if (!out[w]) out[w] = r;
    }
    // Say why a window is empty when we know why. `headersExposed: false` is a
    // measured fact about the endpoint and a far better error than silence.
    if (store.headersExposed === false) {
      for (const w of WINDOWS) {
        if (!out[w]) {
          out[w] = reading({
            source: 'headers',
            error: 'the model endpoint exposed no rate-limit headers to this origin '
              + '(Access-Control-Expose-Headers) — creel cannot read the provider\'s own budget from a browser. '
              + 'Enter a reading with fleet_governor {pct}, or declare a token budget for the local ledger',
          });
        }
      }
    }
    return out;
  }

  /** The whole thing, from storage and the clock. This is what the dashboard,
   *  the fleet tools, and the exported probe record all call. */
  function admission(o) {
    o = o || {};
    const now = num(o.now, nowS());
    const policy = o.policy || readPolicy();
    const v = verdict({
      policy,
      readings: o.readings || currentReadings({ now, budgets: policy.tokenBudgets }),
      now,
      device: o.device,
      deviceCap: o.deviceCap,
      running: o.running,
      want: o.want,
      held: o.held || lsGet(HELD_KEY, {}),
    });
    if (o.persistHeld !== false) lsSet(HELD_KEY, v.held);
    if (policy.error) v.alarm = `GOVERNOR POLICY IS UNREADABLE — ${policy.error}${v.alarm ? ` | ${v.alarm}` : ''}`;
    return v;
  }

  const api = {
    CONTRACT, WINDOWS, WINDOW_LENGTH_S, SOURCES, ADMIT, REFUSE, UNKNOWN,
    WARN, FREEZE, DEFAULT_POLICY, DEFAULT_MAX_AGE_S, DEFAULT_RELAX_MARGIN,
    GovernorError,
    parsePolicy, tierLabel, reading, lost, verdict, explain,
    readPolicy, writePolicy, observe, recordManual, recordSpend,
    readingsFromHeaders, readingsFromLedger, currentReadings, admission,
    pctFromPair, parseResetHeader,
    _keys: { POLICY_KEY, READINGS_KEY, LEDGER_KEY, HELD_KEY },
  };

  if (typeof window !== 'undefined') window.CreelGovernor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
