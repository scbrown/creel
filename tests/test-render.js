/* The streaming renderer must not eat the main thread (creel-z96).
 *
 * renderMd re-parses and re-renders the WHOLE accumulated message, so its cost
 * grows with the answer — measured on the real page at ~22ms for 10KB, 117ms
 * at 40KB, 248ms at 80KB. The old throttle scheduled the next render 50ms
 * after the last one STARTED, regardless of how long it took, so partway
 * through a long reply each render took longer than the gap before the next
 * was queued. Streaming a 167KB answer spent 2545ms on the main thread at a
 * 58% duty cycle, in blocks up to 191ms: the interface stops responding
 * exactly when the answer gets interesting, and it gets worse as it grows.
 *
 * The fix makes the interval follow the measured cost. This test drives the
 * real throttle with a renderer of known, controllable cost, so it asserts the
 * scheduling rule rather than a wall-clock number that would be flaky on a
 * loaded machine.
 *
 * Run: node tests/test-render.js   (or `just test`)
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

/** Drive the real renderMdThrottled with a renderer that costs `costMs`,
 *  and report the gaps between the renders it actually performed. */
function driveThrottle(costMs, chunks) {
  const el = document.createElement('div');
  el.className = 'msg-body';
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.appendChild(el);
  document.getElementById('chatMessages').appendChild(wrap);

  const real = window.renderMd;
  const at = [];
  window.renderMd = () => {
    at.push(performance.now());
    const until = performance.now() + costMs;      // a render of known cost
    while (performance.now() < until) { /* busy — this is the point */ }
  };
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      if (i++ < chunks) {
        window.renderMdThrottled(el, 'x'.repeat(i * 100));
        setTimeout(tick, 5);                        // stream chunks arriving
        return;
      }
      setTimeout(() => {
        window.renderMd = real;
        wrap.remove();
        const gaps = at.slice(1).map((t, k) => Math.round(t - at[k]));
        resolve({ renders: at.length, gaps });
      }, costMs * 6 + 400);
    };
    tick();
  });
}

(async () => {
  if (!Browser.available()) {
    console.log('creel streaming render\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  const page = await browser.newPage('/onepagent.html');
  await page.waitForFunction(() => typeof window.renderMdThrottled === 'function',
    { message: 'the harness renderer' });

  await check('a cheap render keeps the old responsive cadence', async () => {
    const r = await page.evaluate(driveThrottle, 1, 40);
    assert.ok(r.renders >= 2, `expected several renders, got ${r.renders}`);
    // Cost near zero → the floor governs, so short messages stay smooth.
    const median = r.gaps.sort((a, b) => a - b)[Math.floor(r.gaps.length / 2)];
    assert.ok(median < 140, `a 1ms render should still repaint promptly; median gap ${median}ms`);
  });

  await check('an expensive render backs off instead of saturating the thread', async () => {
    const r = await page.evaluate(driveThrottle, 120, 40);
    assert.ok(r.renders >= 2, `expected several renders, got ${r.renders}`);
    const median = r.gaps.sort((a, b) => a - b)[Math.floor(r.gaps.length / 2)];
    // The rule is "wait a multiple of what the last render cost", so a 120ms
    // render must not be re-queued 50ms later. Bound generously: the point is
    // that the gap tracks cost at all, not its exact constant.
    assert.ok(median > 200,
      `a 120ms render was re-queued after ${median}ms — the throttle is ignoring cost`);
    // And the thread is left mostly free: renders are 120ms inside those gaps.
    const duty = 120 / median;
    assert.ok(duty < 0.5, `rendering used ${Math.round(duty * 100)}% of the main thread`);
  });

  await check('the last chunk is always rendered, however far it backed off', async () => {
    // Backing off must never lose the tail of an answer: flushRender is what
    // guarantees the final text lands when the stream ends.
    const text = await page.evaluate(async () => {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant';
      const el = document.createElement('div');
      el.className = 'msg-body';
      wrap.appendChild(el);
      document.getElementById('chatMessages').appendChild(wrap);
      window.renderMdThrottled(el, 'first');
      window.renderMdThrottled(el, 'THE FINAL TEXT');
      window.flushRender(el);
      const out = el.dataset.raw;
      wrap.remove();
      return out;
    });
    assert.strictEqual(text, 'THE FINAL TEXT');
  });

  await page.close();
  await browser.close();

  console.log('creel streaming render');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
