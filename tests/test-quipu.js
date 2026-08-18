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

  // ── the store outliving the tab that hosts it ────────────────────
  // One tab hosts the store and every other tab is its client, which makes
  // the host's liveness the whole fleet's liveness. The host is whichever tab
  // opened first — nearly always the operator's root tab, the one they close,
  // reload, or send through ui_reload when an update lands. So the failure an
  // agent tab actually hits is not "the graph is broken", it is "the tab that
  // had the graph is gone".

  await check('an agent tab reaches the store rather than forking its own', async () => {
    const agent = await browser.newPage('/thread.html#creel-agent=probe-fleet');
    await agent.waitForFunction(() => !!window.CreelQuipu, { message: 'the agent tab' });
    const r = await bootQuipu(agent);
    assert.ok(r.ok, 'an agent tab could not reach the store: ' + (r.error || r.err));
    const fleet = await agent.evaluate(() => IS_FLEET_TAB);
    assert.strictEqual(fleet, true, 'setup: #creel-agent did not make this a fleet tab');
    const shared = await agent.evaluate(async () => {
      const res = await window.CreelQuipu.provider.callTool('quipu_cord', { limit: 200 });
      return JSON.stringify(res).includes('roundtrip-probe');
    });
    assert.strictEqual(shared, true, 'the agent tab cannot see what the root tab wrote');
    await agent.close();
  });

  await check('the host answers a ping, so a client never has to guess', async () => {
    // One level below the tool surface, deliberately: this is the protocol
    // that makes recovery possible, and it is not observable from above until
    // something has already gone wrong. A client that cannot ask "is anyone
    // hosting the store?" can only post into the void and wait out a timeout.
    const agent = await browser.newPage('/thread.html#creel-agent=ping-probe');
    await agent.waitForFunction(() => !!window.CreelQuipu, { message: 'the agent tab' });
    assert.ok((await bootQuipu(agent)).ok, 'setup: the agent tab did not boot');
    const answered = await agent.evaluate(() => new Promise((resolve) => {
      const bc = new BroadcastChannel('creel-quipu-rpc');
      const done = (v) => { bc.close(); resolve(v); };
      bc.onmessage = (e) => { if (e.data && e.data.type === 'leader') done(true); };
      bc.postMessage({ type: 'ping' });
      setTimeout(() => done(false), 3000);
    }));
    assert.strictEqual(answered, true, 'no tab answered a ping — a client cannot tell an '
      + 'unserved request from a slow one, which is what turns a dead host into a 20s hang');
    await agent.close();
  });

  await check('a request is acknowledged before it is answered', async () => {
    // The ACK is what makes re-sending safe. Without it a client cannot
    // distinguish "nobody picked this up" (re-send freely, even for a write)
    // from "the host took it and died" (re-sending would double-apply it), so
    // the only safe move left is to wait, and the only thing to wait for is a
    // timeout.
    const agent = await browser.newPage('/thread.html#creel-agent=ack-probe');
    await agent.waitForFunction(() => !!window.CreelQuipu, { message: 'the agent tab' });
    assert.ok((await bootQuipu(agent)).ok, 'setup: the agent tab did not boot');
    const order = await agent.evaluate(() => new Promise((resolve) => {
      const bc = new BroadcastChannel('creel-quipu-rpc');
      const seen = [];
      const done = () => { bc.close(); resolve(seen); };
      bc.onmessage = (e) => {
        const m = e.data;
        if (!m || m.reqId !== 'probe-req-1') return;
        seen.push(m.type);
        if (m.type === 'res') done();
      };
      bc.postMessage({ type: 'req', reqId: 'probe-req-1', op: 'tools' });
      setTimeout(done, 5000);
    }));
    assert.deepStrictEqual(order, ['ack', 'res'],
      `expected the host to ack then answer; got ${JSON.stringify(order)}`);
    await agent.close();
  });

  await check('a call made as the host tab dies still completes', async () => {
    // The regression: the host held the only copy, clients had no way to know
    // whether anyone had picked up their request, and a request nobody picked
    // up sat out a 20-second timeout before failing. Closing the root tab
    // therefore broke every agent tab for twenty seconds — and broke the one
    // that took over for good, because a BroadcastChannel does not deliver to
    // the tab that posted, so it could never answer its own pending call.
    const host = await browser.newPage('/thread.html');
    await host.waitForFunction(() => !!window.CreelQuipu, { message: 'the host tab' });
    assert.ok((await bootQuipu(host)).ok, 'setup: the host tab did not boot');

    const clients = [];
    for (const id of ['fall-a', 'fall-b']) {
      const c = await browser.newPage(`/thread.html#creel-agent=${id}`);
      await c.waitForFunction(() => !!window.CreelQuipu, { message: 'a client tab' });
      assert.ok((await bootQuipu(c)).ok, 'setup: a client tab did not boot');
      clients.push(c);
    }

    const call = (p) => p.evaluate(async () => {
      const t0 = Date.now();
      try {
        const res = await window.CreelQuipu.provider.callTool('quipu_cord', { limit: 3 });
        return { ms: Date.now() - t0, ok: true, count: res && res.count };
      } catch (e) { return { ms: Date.now() - t0, ok: false, err: e.message }; }
    });
    // Prove the path works before taking the host away, so a failure below is
    // about the host dying and not about the call.
    assert.ok((await call(clients[0])).ok, 'setup: a client call failed while the host was alive');

    await host.close();
    const results = await Promise.all(clients.map(call));
    for (const [i, r] of results.entries()) {
      assert.ok(r.ok, `client ${i} failed after the host closed: ${r.err}`);
      assert.ok(r.ms < 5000, `client ${i} took ${r.ms}ms — it waited out a timeout instead of `
        + 'noticing the takeover');
    }
    // And the store is genuinely still there afterwards, not merely not-erroring.
    const still = await clients[0].evaluate(async () => {
      const res = await window.CreelQuipu.provider.callTool('quipu_cord', { limit: 200 });
      return JSON.stringify(res).includes('roundtrip-probe');
    });
    assert.strictEqual(still, true, 'the facts did not survive the host tab');
    for (const c of clients) await c.close();
  });

  await alpha.close();
  await browser.close();

  console.log('creel knowledge graph');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
