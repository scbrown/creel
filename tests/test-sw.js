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

  await page2.close();
  await clean.close();

  console.log('creel service worker');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
