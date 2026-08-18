/* The service worker takes over, even when the precache cannot complete.
 *
 * A static site's update path is its whole deployment story, and creel's was
 * broken in the way that is hardest to notice: `install` did
 * `await cache.addAll(APP_SHELL)` and only then called `skipWaiting()`.
 * cache.addAll is ATOMIC — one 404, one flaky response, one timeout on the
 * 3.3MB wasm rejects the entire call. Install then fails, the new worker
 * never activates, and the PREVIOUS one keeps serving its old cache. Reloading
 * does not help, because a reload does not evict a controlling worker. The
 * deploy is green, the site is correct, and the browser shows the old build.
 *
 * So the test is not "does the worker cache things" — it is "does the worker
 * take over when one asset is unreachable". It runs against a copy of app/
 * whose shell list names a file that does not exist.
 *
 * Run: node tests/test-sw.js   (or `just test`)
 * Skips cleanly (exit 0) when no Chromium is present.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Browser } = require('./browser.js');

const APP = path.join(__dirname, '..', 'app');

const results = [];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 5).join('\n       ')}`); failures++; }
};

/** Wait until a service worker is actually controlling the page. */
const controlled = (page, timeout = 20000) => page.waitForFunction(
  () => !!navigator.serviceWorker.controller,
  { timeout, message: 'a service worker to take control' });

(async () => {
  if (!Browser.available()) {
    console.log('creel service worker\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  // A copy of the app whose shell list names one file that is not there.
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'creel-sw-'));
  fs.cpSync(APP, broken, { recursive: true });
  const swPath = path.join(broken, 'sw.js');
  const sw = fs.readFileSync(swPath, 'utf8');
  assert.ok(sw.includes("const APP_SHELL = ["), 'sw.js no longer has an APP_SHELL list');
  fs.writeFileSync(swPath, sw.replace("const APP_SHELL = [",
    "const APP_SHELL = [\n  './this-asset-does-not-exist.js',"));

  const browser = await Browser.launch({ root: broken });
  const page = await browser.newPage('/onepagent.html');

  await check('the worker takes over even though one shell asset 404s', async () => {
    await controlled(page);
    assert.strictEqual(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
  });

  await check('it activated rather than getting stuck installing or waiting', async () => {
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { active: reg.active ? reg.active.state : null, waiting: !!reg.waiting, installing: !!reg.installing };
    });
    assert.strictEqual(state.active, 'activated', `worker state is ${state.active}`);
    assert.strictEqual(state.installing, false, 'a worker is still stuck installing');
  });

  await check('the reachable assets were cached anyway — one bad URL costs one asset', async () => {
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((n) => n.startsWith('onepagent-')));
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    assert.ok(cached.some((p) => p.endsWith('/onepagent.html')), 'the page itself was not cached');
    assert.ok(cached.some((p) => p.includes('/harness/')), 'no harness part was cached');
    assert.ok(!cached.some((p) => p.includes('this-asset-does-not-exist')),
      'a URL that 404s should not be in the cache');
  });

  await page.close();
  await browser.close();
  fs.rmSync(broken, { recursive: true, force: true });

  // And the real app/, unmodified: the healthy path still works.
  const clean = await Browser.launch({ root: APP });
  const page2 = await clean.newPage('/onepagent.html');

  await check('the unmodified app registers and is controlled', async () => {
    await controlled(page2);
    const v = await page2.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active && reg.active.state;
    });
    assert.strictEqual(v, 'activated');
  });

  await check('the page checks for updates instead of registering once and forgetting', async () => {
    // The failure this guards is a tab left open for weeks on a stale bundle,
    // which is creel's normal mode — the fleet lives in long-lived tabs.
    const html = fs.readFileSync(path.join(APP, 'onepagent.html'), 'utf8');
    assert.match(html, /reg\.update\(\)/, 'nothing ever calls registration.update()');
    assert.match(html, /visibilitychange/, 'no update check when returning to the tab');
    assert.match(html, /SKIP_WAITING/, 'a waiting worker is never promoted, so it waits forever');
    // And it must NOT reload: creel tabs run agents, and reloading one
    // mid-turn discards a conversation or abandons a claimed fleet task.
    assert.ok(!/controllerchange[\s\S]{0,200}location\.reload/.test(html),
      'the page reloads itself on update — that throws away an agent mid-run');
  });

  // ── the update reaches the operator and the agent (creel-vup, creel-ick) ──

  /** Call a ui_* tool the way an agent would. */
  let uid = 0;
  const ui = async (name, args = {}) => {
    const res = await page2.evaluate(async (n, a, id) => {
      const reply = await window.CreelUi.handle({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: n, arguments: a },
      });
      if (reply.error) return { __error: reply.error.message };
      return JSON.parse(reply.result.content[0].text);
    }, name, args, ++uid);
    if (res && res.__error) throw new Error(res.__error);
    return res;
  };

  await check('an agent can ask whether it is running a stale bundle', async () => {
    const s = await ui('ui_update_status');
    assert.strictEqual(typeof s.updateReady, 'boolean');
    assert.strictEqual(s.updateReady, false, 'nothing was deployed during the test');
    assert.strictEqual(typeof s.canSaveState, 'boolean');
    assert.ok(s.hint, 'the status should say what it means, not just a flag');
  });

  await check('the operator gets a notice when an update lands', async () => {
    const banner = await page2.evaluate(() => {
      window.dispatchEvent(new CustomEvent('creel-update-ready'));
      const el = document.getElementById('creelUpdateBanner');
      return el && {
        text: el.textContent,
        role: el.getAttribute('role'),
        // Every control must be reachable by accessible name, like any other.
        buttons: [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent),
      };
    });
    assert.ok(banner, 'no update notice appeared');
    assert.match(banner.text, /newer version/i);
    assert.strictEqual(banner.role, 'status', 'the notice should announce itself to a screen reader');
    assert.ok(banner.buttons.some((b) => /save/i.test(b)), 'no save-and-reload action: ' + banner.buttons);
    assert.ok(banner.buttons.some((b) => /later|dismiss/i.test(b)), 'the notice cannot be dismissed');
  });

  await check('the notice offers saving, not just reloading', async () => {
    // The button must not be the careless option — it goes through the same
    // save-first path the agent tool uses.
    const wired = await page2.evaluate(() => typeof window.CreelSelf.saveStateAndReload === 'function');
    assert.strictEqual(wired, true, 'the banner has nothing safe to call');
  });

  await check('reloading refuses when there is nowhere to save', async () => {
    // No state repo configured in this fresh profile: a reload here would
    // discard the conversation and workspace, so it must not happen quietly.
    const err = await ui('ui_reload').then(() => null, (e) => e.message);
    assert.ok(err, 'ui_reload discarded state instead of refusing');
    assert.match(err, /no state repo/i);
    assert.match(err, /state_configure/, 'the refusal should say how to fix it');
    assert.match(err, /force/, 'the refusal should name the override');
    // And it really did not reload.
    assert.strictEqual(await page2.evaluate(() => !!window.CreelUi), true);
  });

  await check('a tab holding a fleet task refuses before it refuses about saving', async () => {
    // Order matters: a lease dropped by a vanishing tab looks like a crash to
    // the fleet, so that is the first thing checked.
    const err = await page2.evaluate(async () => {
      const real = window.CreelFleet.debug;
      window.CreelFleet.debug = async () => ({ currentLeaseTaskId: 'task-abc' });
      try {
        return await window.CreelSelf.saveStateAndReload({}).then(() => null, (e) => e.message);
      } finally { window.CreelFleet.debug = real; }
    });
    assert.ok(err, 'a tab holding a claimed task reloaded anyway');
    assert.match(err, /task-abc/);
    assert.match(err, /fleet_report/, 'the refusal should name the proper way to finish');
  });

  await check('scope "all" reloads every live creel tab, peers before self', async () => {
    const peer = await clean.newPage('/onepagent.html');
    await peer.waitForFunction(() => !!window.CreelUi && !!window.CreelSelf, { message: 'peer boot' });
    // A marker that cannot survive a real navigation.
    await peer.evaluate(() => { window.__beforeReload = true; });
    await page2.evaluate(() => { window.__beforeReload = true; });
    // Let the two tabs discover each other over the real BroadcastChannel.
    await page2.waitForFunction(async () => {
      const r = await window.CreelUi.handle({ jsonrpc: '2.0', id: 900, method: 'tools/call',
        params: { name: 'ui_tabs', arguments: {} } });
      return JSON.parse(r.result.content[0].text).tabs.length >= 2;
    }, { timeout: 15000, message: 'both tabs on the bus' });

    // force: no state repo is configured here, and this test is about the
    // fan-out, not about the refusal (covered above).
    const out = await ui('ui_reload', { scope: 'all', force: true, stagger_ms: 0 });
    assert.strictEqual(out.scope, 'all');
    assert.strictEqual(out.peers.length, 1, 'expected exactly one peer: ' + JSON.stringify(out.peers));
    assert.strictEqual(out.peers[0].ok, true, 'the peer refused: ' + out.peers[0].error);
    assert.strictEqual(out.self.reloading, true, 'the calling tab did not schedule its own reload');

    // Both really navigated — the marker is gone on a fresh document.
    await peer.waitForFunction(() => !window.__beforeReload && !!window.CreelUi,
      { timeout: 15000, message: 'the peer tab to come back reloaded' });
    await page2.waitForFunction(() => !window.__beforeReload && !!window.CreelUi,
      { timeout: 15000, message: 'the calling tab to come back reloaded' });
    await peer.close();
  });

  await page2.close();
  await clean.close();

  console.log('creel service worker');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
