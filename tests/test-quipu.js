/* The knowledge graph loads — including when the network does not.
 *
 * The graph is what makes creel's bet work: cheap models become viable agents
 * when grounding is local and free. So "the graph failed to load" is not a
 * degraded feature, it is the feature.
 *
 * The regression that prompted this file: ensureWasm probed for the bundle
 * with a HEAD request, and the service worker only handles GET — so the probe
 * skipped the cache, went to the network, and failed offline even with both
 * wasm files precached. A liveness check that defeated the cache it was
 * checking. It failed on any blip, captive portal, or offline PWA launch.
 *
 * Run: node tests/test-quipu.js   (or `just test`)
 * Skips cleanly (exit 0) when no Chromium is present.
 */
'use strict';

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

const bootQuipu = (page, force = false) => page.evaluate(async (f) => {
  try {
    const ok = await window.CreelQuipu.ensureWasm(f);
    return { ok, provider: !!window.CreelQuipu.provider, err: window.CreelQuipu.lastBootError };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}, force);

(async () => {
  if (!Browser.available()) {
    console.log('creel knowledge graph\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  const alpha = await browser.newPage('/thread.html');
  await alpha.waitForFunction(() => !!window.CreelQuipu, { message: 'the quipu binding' });

  await check('the store boots and binds a provider', async () => {
    const r = await bootQuipu(alpha);
    assert.ok(r.ok, 'ensureWasm failed: ' + (r.error || r.err));
    assert.strictEqual(r.provider, true, 'no provider bound');
  });

  await check('it is a real store: a fact written is a fact read back', async () => {
    const found = await alpha.evaluate(async () => {
      const call = (n, a) => window.CreelQuipu.provider.callTool(n, a);
      await call('quipu_episode', {
        name: 'test-episode-' + Math.random().toString(36).slice(2, 8),
        episode_body: 'a fact for the round trip',
        nodes: [{ name: 'roundtrip-probe', type: 'Probe', description: 'written by the test' }],
        edges: [],
      });
      const r = await call('quipu_cord', { limit: 200 });
      return JSON.stringify(r).includes('roundtrip-probe');
    });
    assert.strictEqual(found, true, 'a written entity was not readable');
  });

  await check('a second tab shares the store rather than forking it', async () => {
    const beta = await browser.newPage('/thread.html');
    await beta.waitForFunction(() => !!window.CreelQuipu, { message: 'second tab' });
    const r = await bootQuipu(beta);
    assert.ok(r.ok, 'the second tab could not reach the store: ' + (r.error || r.err));
    // One store, leader-elected: the second tab is a client of the first.
    const scope = await beta.evaluate(() =>
      window.CreelQuipu.provider.serverInfo && window.CreelQuipu.provider.serverInfo.name);
    assert.match(String(scope), /fleet-client|fleet-host|tab/, 'unexpected store scope: ' + scope);
    // And it can see what the first tab wrote.
    const shared = await beta.evaluate(async () => {
      const r = await window.CreelQuipu.provider.callTool('quipu_cord', { limit: 200 });
      return JSON.stringify(r).includes('roundtrip-probe');
    });
    assert.strictEqual(shared, true, 'the second tab cannot see the first tab\'s facts');
    await beta.close();
  });

  await check('the graph explorer opens without throwing', async () => {
    const r = await alpha.evaluate(async () => {
      window.__errs = [];
      window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason && e.reason.message)));
      const btn = document.getElementById('creelGraphBtn');
      if (!btn) return { error: 'no graph button in the page' };
      btn.click();
      await new Promise((res) => setTimeout(res, 2500));
      return { errs: window.__errs, opened: document.body.children.length };
    });
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(r.errs, [], 'opening the explorer threw: ' + JSON.stringify(r.errs));
  });

  await check('the graph loads OFFLINE from the precached bundle', async () => {
    // The regression. Warm the cache, cut the network, reload, and the graph
    // must still come up: everything it needs is local by design.
    const page = await browser.newPage('/thread.html');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller,
      { timeout: 25000, message: 'the service worker to take control' });
    await page.evaluate(async () => { try { await window.CreelQuipu.ensureWasm(); } catch { /* warming */ } });
    await new Promise((r) => setTimeout(r, 1200));

    const cached = await page.evaluate(async () => {
      const name = (await caches.keys()).find((k) => k.startsWith('onepagent-'));
      const c = await caches.open(name);
      return (await c.keys()).filter((r) => /wasm/.test(r.url)).length;
    });
    assert.ok(cached >= 2, `the wasm bundle is not precached (${cached} entries) — test cannot prove anything`);

    await page.browser.send('Network.enable', {}, page.sessionId);
    await page.browser.send('Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, page.sessionId);
    await page.evaluate(() => location.reload());
    await new Promise((r) => setTimeout(r, 2500));
    await page.waitForFunction(() => !!window.CreelQuipu, { timeout: 25000, message: 'the page to come back offline' });

    const r = await bootQuipu(page, true);
    assert.ok(r.ok, 'the graph failed offline even though its bundle was cached: ' + (r.error || r.err));
    assert.strictEqual(r.provider, true, 'no provider bound offline');

    await page.browser.send('Network.emulateNetworkConditions',
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, page.sessionId);
    await page.close();
  });

  await alpha.close();
  await browser.close();

  console.log('creel knowledge graph');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
