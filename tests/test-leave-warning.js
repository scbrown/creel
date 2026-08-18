/* The leave warning: when may creel pop the native beforeunload dialog?
 *
 * The predicate runs inside the unload path, so it must be pure and
 * synchronous, and the page's copy is the single source of truth — this test
 * extracts the fenced function verbatim from the harness and evaluates it in a
 * stubbed window. If the fence markers move, the test fails loudly instead of
 * silently testing a stale copy.
 *
 * The fence is searched for across the whole harness rather than in one named
 * file: the page's script was split into app/harness/ parts (creel-yny), and a
 * test that pins which part a function lives in would break on every later
 * move without ever telling you anything about the behaviour.
 *
 * Run: node tests/test-leave-warning.js   (or `just test-unit`)
 */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const APP = path.join(__dirname, '..', 'app');
const HARNESS = path.join(APP, 'harness');
const SOURCES = [
  path.join(APP, 'onepagent.html'),
  ...fs.readdirSync(HARNESS).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(HARNESS, f)),
];
const HTML = SOURCES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const m = HTML.match(/\/\/ BEGIN creelShouldWarnOnLeave\n([\s\S]*?)\n\/\/ END creelShouldWarnOnLeave/);
assert.ok(m, 'fenced creelShouldWarnOnLeave must exist somewhere in app/ (page or harness parts)');

// The fence body is `window.creelShouldWarnOnLeave = function ... };` —
// strip the assignment so it can be eval'd as a plain function expression.
const FN = m[1].replace('window.creelShouldWarnOnLeave = ', '');

// The wiring must exist too: the handler consults the suppress flag (fleet
// abort closes must not be blocked) and only acts when the predicate is true.
assert.match(
  HTML,
  /addEventListener\('beforeunload', \(e\) => \{\s*if \(window\.__creelSuppressLeaveWarn\) return;\s*if \(!window\.creelShouldWarnOnLeave\(\)\) return;/,
  'the unload handler must be wired after the fence'
);

function boot(stubs) {
  const win = {};
  const sandbox = {
    window: win,
    console,
    document: stubs.document,
    localStorage: stubs.localStorage,
  };
  sandbox.window = sandbox; // page code assigns to window.*
  vm.createContext(sandbox);
  vm.runInContext(`window.creelShouldWarnOnLeave = ${FN};`, sandbox);
  return sandbox.window.creelShouldWarnOnLeave;
}

const noStorage = { getItem: () => null };
const chat = (realMessages) => ({
  querySelector: (sel) => (realMessages && sel === '.msg:not(.msg-placeholder)') ? { found: true } : null,
});

/** A storage stub built from a plain map, so a case can say exactly what the
 *  browser holds and nothing else. */
const storage = (obj) => ({ getItem: (k) => (k in obj ? obj[k] : null) });

/** A configured, enabled state repo — i.e. there IS somewhere to push. */
const REPO = JSON.stringify({ enabled: true, owner: 'stiwi', repo: 'creel-state' });

const cases = [
  ['a pristine page (no chat element) never warns', boot({ document: { getElementById: () => null }, localStorage: noStorage }), false],
  ['a placeholder-only conversation never warns', boot({ document: { getElementById: () => chat(false) }, localStorage: noStorage }), false],
  ['a conversation with real messages warns', boot({ document: { getElementById: () => chat(true) }, localStorage: noStorage }), true],
  ['live fleet activity warns even with an empty conversation', boot({ document: { getElementById: () => chat(false) }, localStorage: { getItem: () => '3' } }), true],
  ['a zero fleet count does not warn', boot({ document: { getElementById: () => chat(false) }, localStorage: { getItem: () => '0' } }), false],

  // With somewhere to push, the question stops being "is there a transcript"
  // and becomes "is any of it unpushed".
  ['a pushed conversation does not warn, however long it is', boot({
    document: { getElementById: () => chat(true) },
    localStorage: storage({ creel_state_repo: REPO, creel_state_dirty_at: '1000', ba_s3_last_sync: '2000' }),
  }), false],
  ['unpushed state warns even with an empty transcript', boot({
    document: { getElementById: () => chat(false) },
    localStorage: storage({ creel_state_repo: REPO, creel_state_dirty_at: '3000', ba_s3_last_sync: '2000' }),
  }), true],
  ['state never pushed at all counts as unpushed', boot({
    document: { getElementById: () => chat(false) },
    localStorage: storage({ creel_state_repo: REPO, creel_state_dirty_at: '1' }),
  }), true],
  ['a repo that is configured but switched off is not somewhere to push', boot({
    document: { getElementById: () => chat(true) },
    localStorage: storage({
      creel_state_repo: JSON.stringify({ enabled: false, owner: 'stiwi', repo: 'creel-state' }),
      creel_state_dirty_at: '1000', ba_s3_last_sync: '2000',
    }),
  }), true],
  ['S3 sync counts as somewhere to push too', boot({
    document: { getElementById: () => chat(true) },
    localStorage: storage({
      ba_s3_sync: JSON.stringify({ endpoint: 'https://s3', bucket: 'b', accessKey: 'a', secretKey: 's' }),
      creel_state_dirty_at: '1000', ba_s3_last_sync: '2000',
    }),
  }), false],
  ['a claimed fleet task warns even when everything is pushed', boot({
    document: { getElementById: () => chat(false) },
    localStorage: storage({ creel_fleet_live: '2', creel_state_repo: REPO,
      creel_state_dirty_at: '1000', ba_s3_last_sync: '2000' }),
  }), true],
  ['malformed config is treated as no config, not as safe', boot({
    document: { getElementById: () => chat(true) },
    localStorage: storage({ creel_state_repo: '{not json', creel_state_dirty_at: '1' }),
  }), true],
  ['an unset fleet count does not warn', boot({ document: { getElementById: () => chat(false) }, localStorage: noStorage }), false],
  ['a broken DOM never throws', boot({ document: { getElementById: () => { throw new Error('boom'); } }, localStorage: noStorage }), false],
  ['a broken storage never throws', boot({ document: { getElementById: () => chat(false) }, localStorage: { getItem: () => { throw new Error('boom'); } } }), false],
];

let pass = 0;
for (const [label, fn, expected] of cases) {
  let actual;
  let threw = false;
  try { actual = fn(); } catch (e) { threw = true; actual = 'THREW: ' + e.message; }
  try {
    assert.strictEqual(threw, false, `${label} must not throw`);
    assert.strictEqual(actual, expected, label);
    pass++;
    console.log(`ok - ${label}`);
  } catch (e) {
    console.error(`not ok - ${label}: ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`${pass}/${cases.length} leave-warning checks passed`);
