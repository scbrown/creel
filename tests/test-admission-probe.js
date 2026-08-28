/* creel — test-admission-probe.js (aegis-edp2n.3): the CABOODLE-facing
 * admission probe. Zero dependencies. Run: node tests/test-admission-probe.js
 *
 * Every case runs the probe as a REAL subprocess and asserts the exit code, not
 * just the JSON. The exit code is the whole point of this tool — it is what a
 * shell gate in an installer reads, and it is the one thing a unit test of the
 * engine cannot check. A probe whose record says `refuse` and whose exit status
 * says success is worse than no probe: the installer proceeds and the JSON that
 * said otherwise is never parsed.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE = path.join(__dirname, '..', 'tools', 'creel-admission.js');
const NOW = 1_756_000_000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creel-probe-'));
const write = (name, obj) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
};

const POLICY = write('policy.json', {
  windows: {
    five_hour: { tiers: [{ at: 50, maxTabs: 4 }, { at: 70, maxTabs: 2 }, { at: 95, drain: true }] },
    seven_day: { tiers: [{ at: 45, maxTabs: 4 }, { at: 65, maxTabs: 1 }, { at: 90, drain: true }] },
  },
});

/** Run the probe. `cwd` is the temp dir so a stray creel-governor.json in the
 *  repo can never quietly become the policy under test. */
function run(...args) {
  const r = spawnSync(process.execPath, [PROBE, ...args], { cwd: tmp, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* exit 3 prints usage, not JSON */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

async function main() {
  let n = 0;
  const ok = (name) => { n++; console.log('  ✓ ' + name); };

  // ── 0: admit ────────────────────────────────────────────────────────
  const admit = run('--policy', POLICY, '--pct', 'five_hour=10', '--pct', 'seven_day=12', '--now', String(NOW), '--quiet');
  assert.strictEqual(admit.code, 0, 'a healthy budget exits 0');
  assert.strictEqual(admit.json.verdict, 'admit');
  assert.strictEqual(admit.json.governed, true);
  assert.strictEqual(admit.json.probe.exitReason, 'admit');
  assert.deepStrictEqual(admit.json.probe.evidence, ['five_hour', 'seven_day']);
  ok('exit 0: declared budget, healthy readings');

  // ── 1: policy refusal ───────────────────────────────────────────────
  const drained = run('--policy', POLICY, '--pct', 'five_hour=96', '--pct', 'seven_day=12', '--now', String(NOW), '--quiet');
  assert.strictEqual(drained.code, 1, 'an exhausted budget is a POLICY refusal');
  assert.strictEqual(drained.json.verdict, 'refuse');
  assert.strictEqual(drained.json.probe.exitReason, 'policy-refusal');
  assert.strictEqual(drained.json.admission.capSource, 'provider-drain');
  ok('exit 1: drain tier engaged — policy refusal');

  const atCap = run('--policy', POLICY, '--pct', 'five_hour=10', '--pct', 'seven_day=12',
    '--device', 'mobile', '--running', '3', '--now', String(NOW), '--quiet');
  assert.strictEqual(atCap.code, 1, 'a full device is also a policy refusal');
  assert.strictEqual(atCap.json.admission.capSource, 'device-cap');
  assert.strictEqual(atCap.json.device.cap, 3, 'mobile defaults to the 3-tab cap');
  ok('exit 1: device cap full — refusal names the device, not the budget');

  // ── 2: instrument, not policy ───────────────────────────────────────
  // The distinction malcolm asked for: "the budget is spent" and "I cannot see
  // the budget" call for opposite responses from an installer.
  const blind = run('--policy', POLICY, '--pct', 'five_hour=10', '--now', String(NOW), '--quiet');
  assert.strictEqual(blind.code, 2, 'a window with no reading is an INSTRUMENT answer');
  assert.strictEqual(blind.json.verdict, 'unknown');
  assert.strictEqual(blind.json.probe.exitReason, 'signal-unavailable');
  assert.deepStrictEqual(blind.json.provider.signalLost, ['seven_day']);
  assert.match(blind.json.alarm, /USAGE SIGNAL LOST/);
  ok('exit 2: a declared window with no reading — signal, not policy');

  // Staleness needs a SNAPSHOT: a --pct reading is stamped at --now by
  // definition and can never age, so a stale case built from --pct would pass
  // while testing nothing. The real risk is an exported state file being
  // preflighted hours later, which is exactly this.
  const old = write('state-stale.json', {
    readings: { five_hour: { pct: 10, at: NOW, source: 'headers' }, seven_day: { pct: 12, at: NOW, source: 'headers' } },
  });
  const stale = run('--policy', POLICY, '--state', old, '--now', String(NOW + 7200), '--quiet');
  assert.strictEqual(stale.code, 2, 'a snapshot aged past maxAge is lost, not green');
  assert.match(stale.json.provider.windows.five_hour.error, /STALE/);
  assert.strictEqual(stale.json.verdict, 'unknown');
  ok('exit 2: an exported snapshot preflighted two hours later is STALE, not green');

  // ── the two admits that are not the same fact ───────────────────────
  const inert = run('--quiet', '--now', String(NOW));
  assert.strictEqual(inert.code, 0, 'creel with no policy genuinely admits');
  assert.strictEqual(inert.json.governed, false);
  assert.strictEqual(inert.json.verdict, 'admit');
  assert.strictEqual(inert.json.probe.evidenceSource, 'none');
  assert.match(inert.json.probe.note, /cannot read a provider budget/);
  ok('exit 0: no policy declared — admits, and says governed:false');

  const demanded = run('--quiet', '--require-governed', '--now', String(NOW));
  assert.strictEqual(demanded.code, 2, '--require-governed makes an undeclared budget an instrument answer');
  assert.strictEqual(demanded.json.verdict, 'admit', 'the RECORD still says what creel would do');
  assert.strictEqual(demanded.json.probe.exitReason, 'no-budget-declared');
  assert.notStrictEqual(demanded.json.probe.exitReason, 'policy-refusal', 'nobody declined this work');
  ok('exit 2 under --require-governed: undeclared budget is instrument, never refusal');

  // ── 3: the probe could not run ──────────────────────────────────────
  // Never 1 and never 2. A typo in a config file must not read as an exhausted
  // account, and it must not read as a dead probe either.
  const badPolicy = write('bad.json', { windows: { five_hour: { tiers: [{ at: 50 }] } } });
  const bad = run('--policy', badPolicy, '--quiet');
  assert.strictEqual(bad.code, 3, 'a malformed policy is a probe error');
  assert.match(bad.stderr, /declares no restriction/, 'and it names the offending key');
  ok('exit 3: malformed policy — names the key, never refuses work over a typo');

  assert.strictEqual(run('--policy', path.join(tmp, 'nope.json'), '--quiet').code, 3);
  assert.strictEqual(run('--pct', 'five_hour').code, 3);
  assert.strictEqual(run('--pct', 'yearly=10').code, 3);
  assert.strictEqual(run('--pct', 'five_hour=140').code, 3);
  assert.strictEqual(run('--device', 'watch').code, 3);
  assert.strictEqual(run('--want', '0').code, 3);
  assert.strictEqual(run('--nonsense').code, 3);
  assert.strictEqual(run('--policy').code, 3, 'a flag with no value');
  ok('exit 3: missing file, malformed --pct, unknown window/device, bad --want, unknown flag');

  const help = run('--help');
  assert.strictEqual(help.code, 0);
  assert.match(help.stdout, /exit: 0 admit · 1 refuse \(policy\) · 2 unknown \(signal\) · 3 probe error/);
  ok('--help exits 0 and states the exit-code contract');

  // ── the state file ──────────────────────────────────────────────────
  // An operator's evidence is whatever fleet_governor printed. Making them
  // reshape it is how a preflight stops being run, so both shapes are accepted.
  const raw = write('state-raw.json', {
    readings: { five_hour: { pct: 72, at: NOW, source: 'headers' }, seven_day: { pct: 10, at: NOW, source: 'headers' } },
    device: { kind: 'desktop', cap: 8, running: 0 },
  });
  const fromRaw = run('--policy', POLICY, '--state', raw, '--now', String(NOW), '--quiet');
  assert.strictEqual(fromRaw.code, 0);
  assert.strictEqual(fromRaw.json.admission.maxTabs, 2, 'the 70% tier came through the state file');
  assert.strictEqual(fromRaw.json.probe.evidenceSource, 'state-file');
  ok('a {readings, device} state file is accepted');

  // The verdict record itself, fed back in — the shape an agent actually has.
  const record = write('state-record.json', admit.json);
  const roundTrip = run('--policy', POLICY, '--state', record, '--now', String(NOW), '--quiet');
  assert.strictEqual(roundTrip.code, 0);
  assert.strictEqual(roundTrip.json.verdict, 'admit');
  assert.deepStrictEqual(roundTrip.json.probe.evidence, ['five_hour', 'seven_day']);
  ok('a whole fleet_governor record round-trips back in as evidence');

  // A CLI reading beats the snapshot: the operator typing a number now is more
  // current than a file, and they are the one who can see the console.
  const override = run('--policy', POLICY, '--state', raw, '--pct', 'five_hour=96', '--now', String(NOW), '--quiet');
  assert.strictEqual(override.code, 1, '--pct overrides the state file');
  assert.strictEqual(override.json.admission.capSource, 'provider-drain');
  ok('--pct overrides a state-file reading for the same window');

  // ── the contract itself ─────────────────────────────────────────────
  for (const r of [admit, drained, blind, inert, demanded]) {
    assert.strictEqual(r.json.contract, 'creel.admission/1');
    assert.strictEqual(r.json.probe.contract, 'creel.admission/1');
    assert.strictEqual(r.json.probe.exit, r.code, 'the record states the exit code it produced');
    assert.strictEqual(r.json.drain.allowed, true, 'draining survives every probe answer');
    assert.ok(r.json.reason.length > 0);
  }
  ok('every answer carries contract creel.admission/1, its own exit code, and drain:true');

  // stdout is the record and nothing else, so `| jq` works under every outcome.
  for (const r of [admit, drained, blind]) {
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout must be parseable JSON alone');
  }
  const loud = run('--policy', POLICY, '--pct', 'five_hour=96', '--pct', 'seven_day=12', '--now', String(NOW));
  assert.doesNotThrow(() => JSON.parse(loud.stdout), 'the human line goes to stderr, never stdout');
  assert.match(loud.stderr, /✕ REFUSE/);
  ok('stdout is the JSON record alone; the human line goes to stderr');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`admission probe: ${n} checks ok`);
}

main().catch((e) => { console.error(e); process.exit(1); });
