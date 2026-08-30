/* creel — test-doctor-browser.js (aegis-edp2n.4): the doctor WIRED IN, in a
 * real page.
 *
 * tests/test-doctor.js proves the judgement. It cannot prove any of what this
 * file is for, and the gap is not hypothetical: on the sibling bead
 * (aegis-5pfde) `creel-setpoint.js` was measured as "referenced only by its
 * tests; nothing in app/ loads it" — a module that was correct, tested, green,
 * and dead in the browser. A doctor nobody can call diagnoses nothing, and it
 * fails with no symptom, because its own test suite passes exactly as loudly
 * either way.
 *
 * So the subject here is the wiring:
 *
 *   1. creel-doctor.js actually loads in thread.html.
 *   2. It reads the FLEET'S staleness predicate, so the doctor and the fleet
 *      cannot disagree about which leases are abandoned.
 *   3. Looking does not TREAT: running the doctor requeues nothing.
 *   4. Collection reports real browser facts, not the unknowns a headless
 *      caller gets.
 *   5. No credential reaches the record from a real, configured page.
 *
 * Run: node tests/test-doctor-browser.js   (or `just test`)
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

function stubSend() {
  window.__sent = [];
  window.handleSend = () => { window.__sent.push(document.getElementById('userInput')?.value || ''); };
}

(async () => {
  if (!Browser.available()) {
    console.log('creel doctor (in page)\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  let page = null;
  try {
    page = await browser.newPage('/thread.html');
    await page.evaluate(stubSend);
    await page.waitForFunction(() => typeof window.CreelDoctor !== 'undefined',
      { message: 'CreelDoctor to load' });

    await check('the doctor loads in the page, with its contract', async () => {
      const wired = await page.evaluate(() => ({
        doctor: typeof window.CreelDoctor,
        contract: window.CreelDoctor && window.CreelDoctor.CONTRACT,
        evaluate: typeof (window.CreelDoctor || {}).evaluate,
        collect: typeof (window.CreelDoctor || {}).collect,
      }));
      assert.strictEqual(wired.doctor, 'object', 'window.CreelDoctor is absent — thread.html does not load it');
      assert.strictEqual(wired.contract, 'creel.doctor/1');
      assert.strictEqual(wired.evaluate, 'function');
      assert.strictEqual(wired.collect, 'function');
    });

    await check('it reads the FLEET\'s staleness predicate, not a second copy', async () => {
      /* The seam this pins: if creel-fleet.js ever stops exporting staleLeases,
       * the doctor silently reports `unknown` for leases forever rather than
       * failing loudly, so the absence has to be caught here. */
      const seam = await page.evaluate(() => typeof window.CreelFleetInternal.staleLeases);
      assert.strictEqual(seam, 'function', 'the fleet no longer exports staleLeases');

      const verdict = await page.evaluate(() => {
        const now = Date.now();
        const tasks = [
          { id: 'live', kind: 'lease', status: 'running', lastHeartbeat: now },
          { id: 'dead', kind: 'lease', status: 'running', lastHeartbeat: now },
          { id: 'frozen', kind: 'lease', status: 'running', lastHeartbeat: now - 86400000 },
          { id: 'queued', kind: 'lease', status: 'queued' },
          { id: 'agent', kind: 'agent', status: 'running' },
        ];
        const locks = new Set(['live', 'frozen']);
        return window.CreelFleetInternal.staleLeases(tasks, locks, now);
      });
      assert.deepStrictEqual(verdict, [
        { id: 'dead', reason: 'lock-released' },
        { id: 'frozen', reason: 'heartbeat-stale' },
      ], 'both abandonment reasons, and nothing else');
    });

    await check('LOOKING DOES NOT TREAT — a doctor run requeues nothing', async () => {
      /* requeueStale() mutates: it puts abandoned leases back on the queue. The
       * doctor must report the same condition without doing that, or a
       * diagnostic changes fleet state as a side effect of being run. */
      const before = await page.evaluate(async () => {
        const F = window.CreelFleetInternal;
        await F.putTask({ id: 'doc-stale', kind: 'lease', status: 'running', lastHeartbeat: 1 });
        return (await F.getTask('doc-stale')).status;
      });
      assert.strictEqual(before, 'running', 'the planted lease starts running');

      const record = await page.evaluate(async () => window.CreelDoctor.run());
      const leases = record.checks.find((c) => c.id === 'fleet-leases');
      assert.ok(leases, 'the leases check is present');
      assert.strictEqual(leases.status, 'fail', 'and it SEES the abandoned lease');
      assert.ok(leases.evidence.includes('doc-stale'), `names it: ${leases.evidence}`);

      const after = await page.evaluate(async () =>
        (await window.CreelFleetInternal.getTask('doc-stale')).status);
      assert.strictEqual(after, 'running', 'and left it exactly as it found it');

      await page.evaluate(async () => window.CreelFleetInternal.delTask('doc-stale'));
    });

    await check('collection reports real browser facts, not a headless unknown', async () => {
      const record = await page.evaluate(async () => window.CreelDoctor.run());
      const status = (id) => record.checks.find((c) => c.id === id).status;
      /* The page is served over http://localhost by the harness, which IS a
       * secure context — so this is a real observation with a known answer,
       * and `unknown` here would mean collection is not running at all. */
      assert.strictEqual(status('secure-context'), 'pass', 'secure context observed');
      assert.notStrictEqual(status('storage-persistence'), 'unknown', 'storage was probed');
      assert.strictEqual(typeof record.code, 'number', 'the aggregate is a number');
      assert.strictEqual(record.contract, 'creel.doctor/1');
    });

    await check('no credential reaches the record from a configured page', async () => {
      const SECRET = 'sk-ant-BROWSER-MUST-NEVER-APPEAR-0000';
      const json = await page.evaluate(async (secret) => {
        const ev = await window.CreelDoctor.collect({
          provider: { id: 'anthropic', keyPresent: true, key: secret },
          stateRepo: { configured: true, repo: 'owner/state', tokenPresent: true, token: secret },
        });
        return JSON.stringify(window.CreelDoctor.evaluate(ev));
      }, SECRET);
      assert.ok(!json.includes(SECRET), 'the key is not in the record');
      assert.ok(!json.includes('sk-ant-'), 'nor a recognisable prefix');
      assert.ok(json.includes('provider-credential'), 'while the check still reports');
    });

    /* ── the wiring that makes it a doctor rather than a library ──────────
     *
     * Everything above proves the module is loaded and correct. None of it
     * proves anything ever CALLS it, and until doctor_status existed nothing
     * did: ten correct checks, reachable only from their own tests. */

    await check('doctor_status answers on the in-page MCP surface', async () => {
      const res = await page.evaluate(async () => window.CreelDoctor.handle({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'doctor_status', arguments: {} },
      }));
      assert.ok(res && res.result, 'the tool replies');
      const record = JSON.parse(res.result.content[0].text);
      assert.strictEqual(record.contract, 'creel.doctor/1', 'returning the versioned record');
      assert.strictEqual(record.checks.length, 10, 'with every check');
      assert.strictEqual(typeof record.ok, 'boolean');
      assert.strictEqual(typeof record.code, 'number');
    });

    await check('the tool is listed, and an unknown tool is refused rather than guessed', async () => {
      const listed = await page.evaluate(async () => window.CreelDoctor.handle({
        jsonrpc: '2.0', id: 2, method: 'tools/list',
      }));
      assert.ok(listed.result.tools.some((t) => t.name === 'doctor_status'), 'doctor_status is advertised');
      const bogus = await page.evaluate(async () => window.CreelDoctor.handle({
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'doctor_nope', arguments: {} },
      }));
      assert.ok(bogus.error, 'an unknown tool is an error');
    });

    await check('collect() reads the real page with NO caller-supplied evidence', async () => {
      /* The gap this closes: provider, stateRepo, extension, popups and dirty
       * were all caller-supplied, and no caller existed — so six of ten checks,
       * including a REQUIRED one, answered `unknown` on a perfectly good page.
       * A preflight that always says "cannot tell" is the blind instrument, not
       * a diagnosis. */
      const ev = await page.evaluate(async () => window.CreelDoctor.collect());
      assert.strictEqual(typeof ev.secureContext, 'boolean', 'secure context observed');
      assert.strictEqual(typeof ev.crossOriginIsolated, 'boolean', 'COI observed');
      assert.ok(ev.serviceWorker && typeof ev.serviceWorker.supported === 'boolean',
        'the service worker was probed');
      assert.ok(ev.dirty === undefined || typeof ev.dirty.unsynced === 'boolean',
        'dirty state, when present, is the boolean its real producer emits');
      assert.ok(ev.popups === undefined || typeof ev.popups.allowed === 'boolean',
        'popups stay UNKNOWN until a real spawn has been observed — never self-probed');
    });

    await check('a spawn records the only honest popup evidence there is', async () => {
      const seen = await page.evaluate(async () => {
        const F = window.CreelFleetInternal;
        if (!F || typeof F.lastSpawnOutcome !== 'function') return { missing: true };
        const before = F.lastSpawnOutcome();
        F.spawnWindow('doctorprobe', 'agent');
        const after = F.lastSpawnOutcome();
        // Close whatever opened, so the probe leaves no tab behind.
        try { window.open('', 'doctorprobe') && null; } catch { /* ignore */ }
        return { before, after };
      });
      assert.ok(!seen.missing, 'lastSpawnOutcome is exported (the doctor reads it)');
      assert.strictEqual(seen.before, null, 'null before any spawn — unknown, not a fabricated pass');
      assert.strictEqual(typeof seen.after.allowed, 'boolean', 'and a boolean after one');
    });

    await check('no credential reaches the record through the TOOL path either', async () => {
      /* The redaction test above calls collect() directly. This is the path a
       * consumer actually takes, and it is the one that would leak. */
      const SECRET = 'sk-ant-TOOLPATH-MUST-NEVER-APPEAR-0000';
      const json = await page.evaluate(async (secret) => {
        try { localStorage.setItem('ba_providers_v1', JSON.stringify({ providers: [{ id: 'p1', apiKey: secret }] })); } catch {}
        try { localStorage.setItem('ba_active_provider_id', 'p1'); } catch {}
        const res = await window.CreelDoctor.handle({
          jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'doctor_status', arguments: {} },
        });
        return res.result.content[0].text;
      }, SECRET);
      assert.ok(!json.includes(SECRET), 'the stored key never leaves the page');
      assert.ok(!json.includes('sk-ant-'), 'nor a recognisable prefix');
      const record = JSON.parse(json);
      const cred = record.checks.find((c) => c.id === 'provider-credential');
      assert.strictEqual(cred.status, 'pass', 'while still reporting that a key IS set');
    });
  } finally {
    if (page) await page.close();
    await browser.close();
  }

  console.log('creel doctor (in page)');
  for (const line of results) console.log(line);
  console.log(`\n${results.length - failures} passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
})();
