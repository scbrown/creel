/* creel — test-collect-metrics.js: the collector, and its exit ladder.
 * Zero dependencies. Run: node tests/test-collect-metrics.js
 *
 * `tools/creel-collect-metrics.js` is the middle of the standing producer:
 * app/creel-metrics.js renders inside a page, tools/creel-push-metrics.js
 * sends, and until this existed a human opening a tab sat between them.
 *
 * What is worth reading if you change this file:
 *
 *   · THE EXIT LADDER IS THE CONTRACT, and the interesting arm is not the happy
 *     one. `2` (took no reading) and `3` (could not run) must never collapse
 *     into each other, and neither may reach the caller as a bare crash. A
 *     scheduled caller publishes this code as a series; if a broken collector
 *     is indistinguishable from a quiet one, the gap in the dashboard means
 *     nothing, which is the failure the parent epic exists to close.
 *   · THE SPAWN FAULT. Chromium is spawned by the borrowed CDP driver, and a
 *     spawn failure arrives as an 'error' EVENT, not a rejected promise — so a
 *     try/catch cannot see it and node exits 1. Measured: before the guard in
 *     the tool, a missing binary exited 1, outside the ladder entirely. That
 *     case is asserted here so it cannot regress silently.
 *   · `status="unknown"` MUST SURVIVE. creel's doctor refuses to collapse
 *     "cannot tell" into a zero; a transport that filtered those samples would
 *     quietly undo that refusal.
 */
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const path = require('path');

const TOOL = path.join(__dirname, '..', 'tools', 'creel-collect-metrics.js');
const { Browser } = require('./browser.js');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks += 1; };

const run = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [TOOL, ...args],
    { env: Object.assign({}, process.env, env || {}), maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

(async () => {
  /* --- the ladder's non-happy arms, which need no browser at all --------- */

  {
    const r = await run(['--help']);
    eq(r.code, 0, '--help exits 0');
    ok(/usage:/.test(r.stdout), '--help prints usage');
    ok(/0 collected/.test(r.stdout) && /2 nothing collected/.test(r.stdout)
      && /3 could not run/.test(r.stdout), 'usage states the whole ladder');
  }

  {
    const r = await run(['--nope']);
    eq(r.code, 3, 'an unknown flag is 3 (could not run), never 2');
    ok(/unknown flag/.test(r.stderr), 'and it says which flag');
  }

  {
    const r = await run(['--timeout-ms', 'nonsense']);
    eq(r.code, 3, 'a bad --timeout-ms is 3');
  }

  {
    /* THE REGRESSION. A binary that cannot be spawned must land on 3, not on a
     * bare node crash (exit 1) outside the ladder. */
    const r = await run([], { CHROME_PATH: '/nonexistent' });
    eq(r.code, 3, 'a spawn fault is 3 — NOT an unhandled crash at 1');
    ok(/driver fault/.test(r.stderr), 'and it is named a driver fault');
    ok(!/Unhandled|throw er/.test(r.stderr), 'no raw node stack reaches the caller');
  }

  /* --- the happy arm, which needs a real browser ------------------------- */

  if (!Browser.available()) {
    console.log(`ok — test-collect-metrics.js: ${checks} checks passed `
      + '(collection arm skipped — no Chromium; set CHROME_PATH)');
    process.exit(0);
  }

  {
    const r = await run([]);
    eq(r.code, 0, 'a real page collects and exits 0');
    const samples = r.stdout.split('\n').filter((l) => l && !l.startsWith('#'));
    ok(samples.length > 0, 'exposition reaches stdout');
    ok(/^creel_/m.test(r.stdout), 'the samples are creel series');
    ok(/# TYPE /.test(r.stdout), 'TYPE lines survive — an untyped push 400s forever');
    ok(/collected \d+ samples/.test(r.stderr),
      'the count goes to stderr, so stdout stays a clean pipe into the push tool');
    ok(!/^\s*$/.test(r.stdout), 'stdout is not blank on a successful collect');
  }

  {
    /* Not a general property of every page — thread.html is the page the
     * producer actually reads, and it is the one that must not lose these. */
    const r = await run([]);
    ok(/status="unknown"/.test(r.stdout),
      'status="unknown" survives collection — "cannot tell" is not collapsed to a zero');
  }

  console.log(`ok — test-collect-metrics.js: ${checks} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
