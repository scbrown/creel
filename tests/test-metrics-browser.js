/* creel — test-metrics-browser.js (aegis-q9lh3): the exporter WIRED IN, in a
 * real page.
 *
 * tests/test-metrics.js proves the projection. It cannot prove any of what this
 * file is for, and on this codebase the gap has already been measured twice:
 * `creel-setpoint.js` was once "referenced only by its tests; nothing in app/
 * loads it" (aegis-5pfde), and the doctor's own checks were correct and never
 * once run against the live page. An exporter nothing loads exports nothing,
 * and it fails with NO SYMPTOM — its unit suite passes exactly as loudly either
 * way, and a missing scrape looks like a quiet component rather than a dead
 * one. That is the `up=1`-while-dead class the parent epic (aegis-wou8k) exists
 * to close, so shipping the projection without this file would reproduce the
 * very defect it was written to detect.
 *
 * So the subject here is the wiring:
 *
 *   1. creel-metrics.js actually loads in thread.html.
 *   2. It projects the DOCTOR'S record — one collector, two readers — so the
 *      two can never disagree about the same page.
 *   3. Looking does not TREAT: rendering metrics requeues nothing.
 *   4. A real page produces real functional series, not the empty payload a
 *      headless caller with no doctor gets.
 *   5. Absent evidence stays absent in a real page too, rather than becoming a
 *      reassuring zero.
 *   6. No credential reaches the exposition, including through the tool path.
 *
 * Run: node tests/test-metrics-browser.js   (or `just test`)
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

const sample = (text, name) => text.split('\n')
  .filter((l) => l && !l.startsWith('#'))
  .filter((l) => l === name || l.startsWith(`${name} `) || l.startsWith(`${name}{`));

(async () => {
  if (!Browser.available()) {
    console.log('creel metrics (in page)\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  let page = null;
  try {
    page = await browser.newPage('/thread.html');
    await page.waitForFunction(() => typeof window.CreelMetrics !== 'undefined',
      { message: 'CreelMetrics to load' });

    await check('the exporter loads in the page, with its contract', async () => {
      const wired = await page.evaluate(() => ({
        metrics: typeof window.CreelMetrics,
        contract: window.CreelMetrics && window.CreelMetrics.CONTRACT,
        run: typeof (window.CreelMetrics || {}).run,
        exposition: typeof (window.CreelMetrics || {}).exposition,
      }));
      assert.strictEqual(wired.metrics, 'object', 'window.CreelMetrics is absent — thread.html does not load it');
      assert.strictEqual(wired.contract, 'creel.metrics/1');
      assert.strictEqual(wired.run, 'function');
      assert.strictEqual(wired.exposition, 'function');
    });

    await check('ONE COLLECTOR, TWO READERS — the projection is the doctor\'s own record', async () => {
      /* The seam this pins: metrics must read the doctor rather than probe the
       * page a second time. A second collector disagrees with the first exactly
       * when an operator is comparing them. */
      const both = await page.evaluate(async () => {
        const record = await window.CreelDoctor.run();
        const text = await window.CreelMetrics.run();
        return { code: record.code, text };
      });
      assert.ok(both.text.includes(`creel_doctor_code ${both.code}`),
        `the exposition must carry the doctor's OWN aggregate (${both.code}):\n${both.text}`);
      assert.ok(both.text.includes('doctor_contract="creel.doctor/1"'),
        'and name the doctor contract it read');
    });

    await check('LOOKING DOES NOT TREAT — rendering metrics requeues nothing', async () => {
      /* The doctor holds this rule and metrics inherits it by construction —
       * but "by construction" is the claim, and this is the measurement. */
      const before = await page.evaluate(async () => {
        const F = window.CreelFleetInternal;
        await F.putTask({ id: 'metrics-stale', kind: 'lease', status: 'running', lastHeartbeat: 1 });
        return (await F.getTask('metrics-stale')).status;
      });
      assert.strictEqual(before, 'running', 'the planted lease starts running');

      const text = await page.evaluate(async () => window.CreelMetrics.run());
      assert.deepStrictEqual(sample(text, 'creel_fleet_leases').filter((l) => l.includes('stale')),
        ['creel_fleet_leases{state="stale"} 1'], `and the exporter SEES it:\n${text}`);

      const after = await page.evaluate(async () =>
        (await window.CreelFleetInternal.getTask('metrics-stale')).status);
      assert.strictEqual(after, 'running', 'and left it exactly as it found it');

      await page.evaluate(async () => window.CreelFleetInternal.delTask('metrics-stale'));
    });

    await check('a real page yields real functional series, not a headless empty', async () => {
      const text = await page.evaluate(async () => window.CreelMetrics.run());
      for (const name of ['creel_build_info', 'creel_doctor_code', 'creel_doctor_check', 'creel_fleet_leases']) {
        assert.ok(sample(text, name).length > 0, `${name} is missing from a live page:\n${text}`);
      }
      /* Every sample is preceded by its own HELP and TYPE, or a scrape rejects
       * the payload wholesale rather than the one bad line. */
      const declared = new Set();
      for (const line of text.split('\n')) {
        if (line.startsWith('# TYPE ')) declared.add(line.split(' ')[2]);
        else if (line && !line.startsWith('#')) {
          const n = line.split(/[ {]/)[0];
          assert.ok(declared.has(n), `${n} emitted before its TYPE`);
        }
      }
    });

    await check('absent evidence stays ABSENT in a real page, and never becomes a zero', async () => {
      /* The roster answers over a BroadcastChannel; a page with no sibling tab
       * still has itself, so tabs is a real 1 here. The absence under test is a
       * signal with no producer at all — creel pushes no shares yet, and the
       * honest projection of that is silence, not `0`. */
      const text = await page.evaluate(async () => window.CreelMetrics.run());
      assert.ok(!text.includes('creel_shares_pushed_total'),
        'a counter with no producer must be wholly absent, HELP and TYPE included');
      assert.ok(!text.includes('creel_attestations_signed_total'),
        'and so must the attestation counter until something signs one');
      assert.deepStrictEqual(sample(text, 'creel_tabs'), ['creel_tabs 1'],
        'while a roster that WAS read reports its real count');
    });

    await check('metrics_export answers on the in-page MCP surface', async () => {
      const out = await page.evaluate(async () => {
        const listed = await window.CreelMetrics.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const called = await window.CreelMetrics.handle({
          jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'metrics_export', arguments: {} },
        });
        const bogus = await window.CreelMetrics.handle({
          jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} },
        });
        return {
          names: listed.result.tools.map((t) => t.name),
          text: called.result.content[0].text,
          refused: !!(bogus.error && /unknown tool/.test(bogus.error.message)),
        };
      });
      assert.deepStrictEqual(out.names, ['metrics_export'], 'the tool is listed under its durable name');
      assert.ok(out.text.includes('creel_doctor_code'), 'and returns a real payload through the tool path');
      assert.ok(out.refused, 'an unknown tool is refused rather than answered with empty text');
    });

    await check('no credential reaches the exposition, including through the tool', async () => {
      const SECRET = 'sk-ant-METRICS-MUST-NEVER-APPEAR-0000';
      const text = await page.evaluate(async (secret) => {
        try { localStorage.setItem('ba_providers_v1', JSON.stringify({ providers: [{ id: 'p1', apiKey: secret }] })); } catch {}
        try { localStorage.setItem('ba_active_provider_id', 'p1'); } catch {}
        const res = await window.CreelMetrics.handle({
          jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'metrics_export', arguments: {} },
        });
        return res.result.content[0].text;
      }, SECRET);
      assert.ok(!text.includes(SECRET), 'the stored key never leaves the page');
      assert.ok(!text.includes('sk-ant-'), 'nor a recognisable prefix');
      assert.ok(text.includes('creel_doctor_check{id="provider-credential"'),
        'while still reporting THAT the credential check ran');
    });
  } finally {
    if (page) await page.close();
    await browser.close();
  }

  console.log('creel metrics (in page)');
  for (const line of results) console.log(line);
  console.log(`\n${results.length - failures} passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
})();
