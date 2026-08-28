#!/usr/bin/env node
/* creel — tools/creel-admission.js: the admission probe CABOODLE runs before
 * installing or launching creel.
 *
 * Requested on aegis-7k8xn.4 / aegis-edp2n.3: a stable, machine-readable answer
 * to "will creel admit work right now", so an installer can refuse rather than
 * reproduce the governor. It prints the SAME record `fleet_governor` returns in
 * the page and the dashboard renders — one contract, three readers — because a
 * preflight that computes its own opinion of the budget is a second governor,
 * and two governors disagree exactly when it matters.
 *
 * ── WHAT THIS CAN AND CANNOT SEE, STATED UP FRONT ───────────────────────────
 *
 * It evaluates a POLICY against the EVIDENCE it is given. It does not talk to a
 * provider and it cannot read a browser's localStorage.
 *
 * So there are two ways to get an `admit` out of it and they are NOT the same
 * fact: a declared budget whose readings are healthy, and no declared budget at
 * all — because creel with no policy really does admit on the device cap, and
 * saying otherwise would invent a refusal nobody made. The record separates them
 * with `governed`; a shell gate that reads only the exit code should pass
 * `--require-governed`, which turns the second case into 2 (instrument) rather
 * than 1 (refusal).
 *
 * Give it evidence one of two ways:
 *   --state <file>   a snapshot exported from a creel tab (fleet_governor's
 *                    record, or {readings, device, deviceCap, running})
 *   --pct W=N        a reading you have in front of you, e.g. --pct five_hour=72
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────
 *
 *   0  admit    policy and evidence agree there is room
 *   1  refuse   a POLICY decision — the budget or the device cap says no
 *   2  unknown  an INSTRUMENT decision — the signal is missing, stale or a
 *               lower bound. Deliberately distinct from 1: "the budget is
 *               spent" and "I cannot see the budget" call for opposite
 *               responses from an installer, and a single non-zero code would
 *               make a blind probe look like an exhausted account.
 *   3  error    the probe could not run at all — bad flags, unreadable policy.
 *               Never confuse this with 2: 3 means fix the invocation, 2 means
 *               the invocation was fine and the signal was not.
 *
 * Usage:
 *   node tools/creel-admission.js [--policy f] [--state f] [--pct W=N]...
 *                                 [--device K] [--cap N] [--running N]
 *                                 [--want N] [--now EPOCH] [--quiet]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const G = require(path.join(__dirname, '..', 'app', 'creel-governor.js'));

const USAGE = `creel-admission — will creel admit another agent tab?

  --policy <file>    governor policy JSON (default: ./creel-governor.json if present)
  --state <file>     evidence exported from a creel tab (fleet_governor output,
                     or {readings, device, deviceCap, running})
  --pct <win>=<n>    a usage reading, e.g. --pct five_hour=72 (repeatable)
  --reset <win>=<n>  epoch seconds when that window refills (repeatable)
  --device <kind>    mobile | tablet | desktop        (default: desktop)
  --cap <n>          device tab cap                   (default: by device kind)
  --running <n>      agent tabs already live          (default: 0)
  --want <n>         tabs the caller needs            (default: 1)
  --now <epoch>      evaluate at this time            (default: now)
  --require-governed treat an UNDECLARED budget as unknown (exit 2) instead of
                     admitting on the device cap alone
  --quiet            print the JSON record only, no human line
  --help

exit: 0 admit · 1 refuse (policy) · 2 unknown (signal) · 3 probe error`;

const DEVICE_CAPS = { mobile: 3, tablet: 4, desktop: 8 };

function die(msg) {
  process.stderr.write(`creel-admission: ${msg}\n\nUse --help for usage.\n`);
  process.exit(3);
}

function readJson(file, what) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { die(`cannot read ${what} ${file}: ${e.message}`); }
  try { return JSON.parse(raw); } catch (e) { die(`${what} ${file} is not valid JSON: ${e.message}`); }
  return null;
}

function parseArgs(argv) {
  const o = { pct: {}, reset: {}, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--help': case '-h': process.stdout.write(USAGE + '\n'); process.exit(0); break;
      case '--quiet': case '-q': o.quiet = true; break;
      case '--require-governed': o.requireGoverned = true; break;
      case '--policy': o.policy = need(); break;
      case '--state': o.state = need(); break;
      case '--device': o.device = need(); break;
      case '--cap': o.cap = Number(need()); break;
      case '--running': o.running = Number(need()); break;
      case '--want': o.want = Number(need()); break;
      case '--now': o.now = Number(need()); break;
      case '--pct': case '--reset': {
        const v = need();
        const m = /^([a-z_]+)=(-?[0-9.]+)$/.exec(v);
        if (!m) die(`${a} expects <window>=<number>, got ${JSON.stringify(v)}`);
        if (!G.WINDOWS.includes(m[1])) die(`unknown window ${JSON.stringify(m[1])} — known: ${G.WINDOWS.join(', ')}`);
        o[a === '--pct' ? 'pct' : 'reset'][m[1]] = Number(m[2]);
        break;
      }
      default: die(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  const now = Number.isFinite(o.now) ? o.now : Math.floor(Date.now() / 1000);

  // ── policy ────────────────────────────────────────────────────────────
  // A malformed policy exits 3 and never 1: refusing work because a config
  // file has a typo would be a policy decision the operator never made.
  let policyRaw = null;
  const policyFile = o.policy || (fs.existsSync('creel-governor.json') ? 'creel-governor.json' : null);
  if (policyFile) policyRaw = readJson(policyFile, 'policy');
  let policy;
  try { policy = G.parsePolicy(policyRaw); } catch (e) { die(`policy ${policyFile}: ${e.message}`); }

  // ── evidence ──────────────────────────────────────────────────────────
  const state = o.state ? readJson(o.state, 'state') : {};
  const readings = {};
  // A state file may be a raw {readings} bag or a whole verdict record; accept
  // either, because the thing an operator has to hand is whatever fleet_governor
  // printed, and making them reshape it is how a preflight stops being run.
  const stateReadings = state.readings
    || (state.provider && state.provider.windows)
    || {};
  for (const w of G.WINDOWS) {
    const r = stateReadings[w];
    if (r && (r.pct != null || r.error)) {
      readings[w] = G.reading({
        pct: r.pct, at: r.at, resetAt: r.resetAt, source: r.source,
        limitId: r.limitId, error: r.error, lowerBound: r.lowerBound,
      });
    }
  }
  // CLI readings win: the operator typing a number now is more current than a
  // snapshot, and they are the one who can see the console.
  for (const [w, pct] of Object.entries(o.pct)) {
    if (!(pct >= 0 && pct <= 100)) die(`--pct ${w}=${pct} must be a percentage 0..100`);
    readings[w] = G.reading({ pct, at: now, source: 'manual', resetAt: o.reset[w] });
  }

  const device = o.device || state.device && state.device.kind || 'desktop';
  if (!Object.keys(DEVICE_CAPS).includes(device)) {
    die(`--device must be one of ${Object.keys(DEVICE_CAPS).join(', ')}, got ${JSON.stringify(device)}`);
  }
  const deviceCap = Number.isFinite(o.cap) ? o.cap
    : (state.device && Number.isFinite(state.device.cap) ? state.device.cap
      : (Number.isFinite(state.deviceCap) ? state.deviceCap : DEVICE_CAPS[device]));
  if (!(deviceCap >= 0)) die(`--cap must be a non-negative integer, got ${o.cap}`);
  const running = Number.isFinite(o.running) ? o.running
    : (state.device && Number.isFinite(state.device.running) ? state.device.running
      : (Number.isFinite(state.running) ? state.running : 0));
  const want = Number.isFinite(o.want) ? o.want : 1;
  if (!(want >= 1)) die(`--want must be at least 1, got ${o.want}`);

  const v = G.verdict({
    policy, readings, now, device, deviceCap, running, want,
    held: state.held || {},
  });

  // ── the record ────────────────────────────────────────────────────────
  // `probe` says how this answer was reached, because the verdict alone cannot
  // distinguish "creel is blind" from "this probe was given nothing to look
  // at", and those have different owners.
  // AN INERT GOVERNOR GENUINELY ADMITS, and that is the trap this flag exists
  // for: "admit because the budget is healthy" and "admit because nobody
  // declared a budget" are the same exit code and very different facts. The
  // record always tells them apart through `governed`; a shell gate reads only
  // the exit code, so a caller that needs the distinction asks for it and gets
  // an instrument answer (2), never a policy refusal (1) — nobody declined this
  // work, the probe simply has nothing to check it against.
  const ungoverned = o.requireGoverned && !v.governed;
  const exit = ungoverned ? 2
    : v.verdict === G.ADMIT ? 0 : v.verdict === G.REFUSE ? 1 : 2;

  const record = {
    ...v,
    probe: {
      tool: 'creel-admission',
      contract: G.CONTRACT,
      policySource: policyFile || null,
      evidence: Object.keys(readings).length ? Object.keys(readings).sort() : [],
      evidenceSource: o.state ? 'state-file' : (Object.keys(o.pct).length ? 'cli' : 'none'),
      exit,
      exitReason: ungoverned ? 'no-budget-declared'
        : v.verdict === G.ADMIT ? 'admit'
          : v.verdict === G.REFUSE ? 'policy-refusal' : 'signal-unavailable',
      note: ungoverned
        ? 'creel would admit, but no provider budget is declared and --require-governed was given '
          + '— this is an instrument answer, not a refusal: declare a policy, or drop the flag.'
        : Object.keys(readings).length ? undefined
          : 'no usage evidence supplied — this probe cannot read a provider budget or a browser\'s storage. '
            + 'Pass --state (a fleet_governor export) or --pct <window>=<n>.',
    },
  };

  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  if (!o.quiet) {
    process.stderr.write(G.explain(v) + '\n');
    if (ungoverned) process.stderr.write(`  ${record.probe.note}\n`);
  }

  return exit;
}

process.exit(main(process.argv.slice(2)));
