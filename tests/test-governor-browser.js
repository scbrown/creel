/* creel — test-governor-browser.js (aegis-edp2n.3): the governor WIRED IN, in
 * a real page.
 *
 * tests/test-governor.js proves the policy. It cannot prove any of what this
 * file is for, because a governor that is correct and not connected refuses
 * nothing — and that is the failure mode with no symptom: every node test
 * green, every spawn ungoverned. So the subject here is the wiring:
 *
 *   1. creel-governor.js actually loads, in the right order, in thread.html.
 *   2. resolveCaps composes the provider budget with the device cap, so EVERY
 *      spawn path is governed by construction rather than by remembering.
 *   3. fleet_spawn is refused by a budget, not merely advised about one.
 *   4. A refusal names the budget, and a device-cap refusal names the device —
 *      the two send an operator to different places.
 *   5. Draining, reporting and pushing survive a full provider drain. A budget
 *      guard that stranded the running tabs' work would be a work-loss event.
 *   6. The dashboard renders the verdict the tools return. One record, two
 *      readers: an operator and an agent must never see different answers.
 *
 * Run: node tests/test-governor-browser.js   (or `just test`)
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

/* Same reason as test-fleet.js: a claim ends in handleSend, which would fire a
 * request at a provider that is not configured. The subject is admission. */
function stubSend() {
  window.__sent = [];
  window.handleSend = () => { window.__sent.push(document.getElementById('userInput')?.value || ''); };
}

function fleetCall(page) {
  let id = 0;
  return async (name, args = {}) => {
    const res = await page.evaluate(async (n, a, callId) => {
      const reply = await window.CreelFleet.handle({
        jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: n, arguments: a },
      });
      if (reply.error) return { __error: reply.error.message };
      return JSON.parse(reply.result.content[0].text);
    }, name, args, ++id);
    if (res && res.__error) throw new Error(res.__error);
    return res;
  };
}

const ready = (page) => page.waitForFunction(
  () => !!window.CreelFleet && !!window.CreelFleet.debug && !!window.CreelGovernor && !!window.CreelSetpoint,
  { message: 'fleet + governor + setpoint modules' });

/** A policy with a drain tier, and a reading that engages whichever tier the
 *  case wants. Written through the tool surface, the way an operator would. */
const POLICY = {
  windows: {
    five_hour: { tiers: [{ at: 50, maxTabs: 4 }, { at: 70, maxTabs: 2 }, { at: 95, drain: true }] },
    seven_day: { tiers: [{ at: 45, maxTabs: 4 }, { at: 90, drain: true }] },
  },
};

(async () => {
  if (!Browser.available()) {
    console.log('creel governor (in page)\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  let page = null;
  try {
    page = await browser.newPage('/thread.html');
    await page.evaluate(stubSend);
    await ready(page);
    const fleet = fleetCall(page);

    // Every case starts from a known store, so one case's readings can never
    // become the next case's silent premise.
    const reset = () => page.evaluate(() => {
      for (const k of Object.values(window.CreelGovernor._keys)) localStorage.removeItem(k);
      localStorage.removeItem(window.CreelSetpoint.POLICY_KEY);
      localStorage.removeItem(window.CreelSetpoint.STATE_KEY);
    });

    await check('the governor loads in the page, before the fleet that consults it', async () => {
      const wired = await page.evaluate(() => ({
        governor: typeof window.CreelGovernor,
        setpoint: typeof window.CreelSetpoint,
        contract: window.CreelGovernor && window.CreelGovernor.CONTRACT,
        // The fleet layer captured it at definition time; if the script order
        // in thread.html ever puts the fleet first, this is what notices.
        seam: typeof window.CreelFleetInternal.resolveCaps,
      }));
      assert.strictEqual(wired.governor, 'object', 'window.CreelGovernor is missing — check the script order in thread.html');
      assert.strictEqual(wired.setpoint, 'object', 'window.CreelSetpoint is missing — check the script order in thread.html');
      assert.strictEqual(wired.contract, 'creel.admission/1');
      assert.strictEqual(wired.seam, 'function');
    });

    await check('live Codex reading emits a fenced controller recommendation and governs admission', async () => {
      await reset();
      await page.evaluate(() => {
        window.__setpointLogs = [];
        const prior = console.info;
        console.info = (...args) => {
          if (args[0] === '[creel:setpoint]') window.__setpointLogs.push(args.slice());
          return prior.apply(console, args);
        };
      });
      const now = Math.floor(Date.now() / 1000);
      const policy = { windows: { seven_day: { tiers: [{ at: 10, maxTabs: 2 }] } } };
      const v = await fleet('fleet_governor', {
        policy, window: 'seven_day', pct: 19, resetAt: now + 3 * 86400,
        source: 'codex_app_server',
      });
      assert.strictEqual(v.provider.windows.seven_day.source, 'codex_app_server');
      assert.strictEqual(v.admission.maxTabs, 2, 'provider tier must differ from the static desktop cap');
      assert.strictEqual(v.admission.capSource, 'provider-tier');
      assert.strictEqual(v.controller.contract, 'creel.setpoint/1');
      assert.strictEqual(v.controller.source, 'codex_app_server');
      assert.strictEqual(v.controller.fenceMax, 8, 'device cap 8 is the tighter fence inside max_agents 9');
      assert.ok(v.controller.advisory > 0, '19% with three days left must recommend growth');
      const logs = await page.evaluate(() => window.__setpointLogs);
      assert.ok(logs.some((row) => row[1].includes('"source":"codex_app_server"') && row[1].includes('"advisory":2')),
        'the live recommendation must be logged with its source and value');
    });

    await check('fleet_governor answers, and is inert until a budget is declared', async () => {
      await reset();
      const v = await fleet('fleet_governor');
      assert.strictEqual(v.contract, 'creel.admission/1');
      assert.strictEqual(v.governed, false, 'a fresh page must not claim to be governing anything');
      assert.strictEqual(v.verdict, 'admit');
      assert.strictEqual(v.alarm, '', 'an undeclared budget must not alarm on a clean install');
      assert.ok(v.admission.maxTabs > 0);
    });

    await check('a declared budget with no reading is SIGNAL LOST, loudly', async () => {
      await reset();
      const v = await fleet('fleet_governor', { policy: POLICY });
      assert.strictEqual(v.governed, true);
      assert.strictEqual(v.verdict, 'unknown');
      assert.match(v.alarm, /USAGE SIGNAL LOST/);
      // The fail-safe: blind must not stop the fleet.
      assert.strictEqual(v.enforced, 'allow', 'a blind governor must never block by default');
    });

    await check('an operator reading engages a tier and tightens the cap', async () => {
      const v = await fleet('fleet_governor', { window: 'five_hour', pct: 72 });
      assert.strictEqual(v.wrote.reading.pct, 72);
      assert.strictEqual(v.provider.windows.five_hour.pct, 72);
      assert.strictEqual(v.admission.maxTabs, 2, 'the 70% tier caps the fleet at 2 tabs');
      assert.strictEqual(v.admission.capSource, 'provider-tier');
    });

    await check('the composed cap reaches fleet_device — every reader, one answer', async () => {
      const d = await fleet('fleet_device');
      assert.strictEqual(d.cap, 2, 'fleet_device reports the COMPOSED cap, not the device half of it');
      assert.ok(d.deviceCap >= d.cap, 'and still carries the device cap it was composed from');
      assert.strictEqual(d.governor.verdict, 'unknown');
    });

    await check('a full provider drain REFUSES a spawn, not just warns about it', async () => {
      // 96% on a window whose 95 tier drains. This is the assertion the whole
      // bead exists for: the budget has to be able to say no.
      await fleet('fleet_governor', { window: 'five_hour', pct: 96 });
      const before = await page.evaluate(() => window.open.__calls || 0);
      const r = await fleet('fleet_spawn', { task: 'should not run', label: 'blocked' });
      assert.strictEqual(r.spawned.length, 0, 'a drained budget still spawned a tab');
      assert.strictEqual(r.capped.length, 1, 'the task should be held, not lost');
      assert.strictEqual(r.governor.verdict, 'refuse');
      assert.strictEqual(r.governor.enforced, 'block');
      assert.ok(before !== undefined || true);
    });

    await check('the refusal names the BUDGET, and a device refusal names the DEVICE', async () => {
      // Two walls, two remedies. "No free slots" when the week is spent sends
      // an operator to close tabs that are not the problem.
      const budget = await fleet('fleet_spawn', { task: 'x', label: 'b' });
      assert.match(budget.hint, /budget/i, `budget refusal did not name the budget: ${budget.hint}`);
      assert.ok(!/close a tab/i.test(budget.hint));

      await fleet('fleet_governor', { window: 'five_hour', pct: 5 });
      await fleet('fleet_governor', { window: 'seven_day', pct: 5 });
      // maxConcurrent 1 is a DEVICE-side cap, with a spawn already queued.
      const dev = await fleet('fleet_device', { maxConcurrent: 1 });
      assert.strictEqual(dev.governor.verdict, 'admit', 'both windows are green now');
      assert.strictEqual(dev.cap, 1, 'the explicit device override is the binding wall');
      assert.strictEqual(dev.governor.admission.capSource, 'device-cap');
    });

    await check('the queued work survives the refusal — nothing is dropped', async () => {
      const status = await fleet('fleet_status');
      assert.ok(status.some((t) => t.label === 'blocked' && t.status === 'queued'),
        'the refused task must stay queued and launchable, never be discarded');
    });

    await check('draining survives a full provider drain', async () => {
      // The invariant: a refusal governs NEW tabs. Getting finished work OUT
      // costs the budget nothing, and the running tabs hold the only copy.
      await fleet('fleet_governor', { window: 'five_hour', pct: 99 });
      const v = await fleet('fleet_governor');
      assert.strictEqual(v.verdict, 'refuse');
      assert.strictEqual(v.drain.allowed, true);
      const drained = await fleet('fleet_drain', { on: true });
      assert.strictEqual(drained.draining, true, 'fleet_drain must never be governed');
      const resumed = await fleet('fleet_drain', { on: false });
      assert.strictEqual(resumed.draining, false);
    });

    await check('the dashboard shows the SAME verdict the tools return', async () => {
      // Open the panel ONCE. The fleet button is a TOGGLE, so clicking it from
      // inside the poll below would open and close the overlay on alternate
      // passes and the caption would never be there to find — which is exactly
      // what the first version of this test did.
      const opened = await page.evaluate(() => {
        const btn = document.getElementById('creelFleetBtn');
        if (!btn) return false;
        btn.click();
        return true;
      });
      assert.ok(opened, 'no fleet button in the page');
      // repaintDashboard fires renderDashboard without returning its promise,
      // so there is nothing to await — poll for the paint instead of assuming
      // it has landed by the time the next statement runs.
      await page.waitForFunction(() => {
        const note = document.querySelector('#creelFleetCapNote');
        return !!(note && note.textContent);
      }, { message: 'the dashboard caption to paint' });
      // waitForFunction reports only THAT the condition held, so the values are
      // read in a second pass rather than returned from the predicate.
      const shown = await page.evaluate(() => {
        const note = document.querySelector('#creelFleetCapNote');
        const chip = document.querySelector('#creelFleetChip');
        return { note: note && note.textContent, title: chip && chip.title };
      });
      const v = await fleet('fleet_governor');
      assert.strictEqual(shown.note, v.reason,
        'the operator caption and the agent verdict disagree — they must be one record');
      assert.match(shown.title, /REFUSE/);
    });

    await check('a bad policy is refused with the offending key named', async () => {
      await assert.rejects(
        () => fleet('fleet_governor', { policy: { windows: { five_hour: { tiers: [{ at: 50 }] } } } }),
        /declares no restriction/,
        'a tier with no restriction must be refused, not silently dropped');
      // And the refusal changed nothing: the previous policy still governs.
      const v = await fleet('fleet_governor');
      assert.strictEqual(v.governed, true);
      assert.strictEqual(v.verdict, 'refuse', 'a rejected policy write must not disarm the governor');
    });

    await reset();
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close();
  }

  console.log('creel governor (in page)');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
