/* Fleet leasing, in real tabs (creel-psr).
 *
 * creel-fleet.js is the most concurrency-sensitive code in the repo and had no
 * test of its own. Its whole claim is that the browser does the scheduler's
 * hard parts — Web Locks for leasing, the same lock's release for crash
 * detection, IndexedDB for the queue, BroadcastChannel for the bus. None of
 * that can be proven against a stub: a DOM stub will happily agree that two
 * tabs each hold the same lock. So this opens real tabs in real Chromium and
 * lets them race.
 *
 * The one thing stubbed is handleSend. Claiming a task ends by injecting it
 * into the chat and pressing send, which would fire an LLM request at a
 * provider that is not configured. The subject here is leasing, not the agent
 * loop, and worker boot waits 2500ms before its first claim — enough room to
 * replace the send with a recorder before any of this starts.
 *
 * What is pinned:
 *   1. One queued task, two workers → exactly one claim. Never two.
 *   2. A worker that dies releases its lease, and the survivor picks it up.
 *   3. A worker that freezes (lock held, heartbeat stale) is requeued too —
 *      the lock alone is not liveness.
 *   4. Draining stops claiming.
 *   5. Every transition lands in the work log.
 *
 * Run: node tests/test-fleet.js   (or `just test`)
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

/* Replace the chat send with a recorder. A claim ends in injectTask →
 * handleSend; leaving the real one in place would fire an LLM request at an
 * unconfigured provider on every claim, which is noise this test would then
 * have to tolerate rather than assert about. */
function stubSend() {
  window.__sent = [];
  window.handleSend = () => { window.__sent.push(document.getElementById('userInput')?.value || ''); };
}

/** Call a fleet_* tool the way an agent would. */
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
  () => !!window.CreelFleet && !!window.CreelFleet.debug, { message: 'fleet module' });

/** Open a worker tab and neutralise its send before it can claim anything. */
async function newWorker(browser, id) {
  const page = await browser.newPage(`/onepagent.html#creel-worker=${id}`);
  await page.evaluate(stubSend);
  await ready(page);
  return page;
}

const debug = (page) => page.evaluate(() => window.CreelFleet.debug());

/** Poll until `fn(debugState)` holds, so the assertions never race the
 *  2500ms boot delay or the bus's deliberate claim jitter. */
async function until(page, fn, message, timeout = 25000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const d = await debug(page).catch(() => null);
    if (d && fn(d)) return d;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${message}\n       last state: ${JSON.stringify(d)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Poll several tabs until one of them satisfies the predicate, and return
 *  every tab's state at that moment.
 *
 *  Synchronising on the WORKERS rather than on the dashboard's view of the
 *  queue is deliberate. doClaimNext writes status:'running' to IndexedDB a
 *  beat before it sets the claiming tab's own currentLeaseTaskId, so a test
 *  that waits for the queue to say 'running' and then reads the workers can
 *  land inside that gap and conclude, wrongly, that nobody claimed anything. */
async function untilAny(pages, fn, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const states = [];
    for (const p of pages) states.push(await debug(p).catch(() => null));
    if (states.some((d) => d && fn(d))) return states;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${message}\n       last state: ${JSON.stringify(states)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

(async () => {
  if (!Browser.available()) {
    console.log('creel fleet leasing\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });

  // The dashboard tab: an ordinary page, which is what an operator has.
  const dash = await browser.newPage('/onepagent.html');
  await dash.evaluate(stubSend);
  await ready(dash);
  const fleet = fleetCall(dash);

  // A queue left over from a previous run would make every count below a lie.
  await dash.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('creel_fleet');
    req.onsuccess = req.onerror = req.onblocked = () => resolve(true);
  }));

  let taskId = null;
  let alpha = null;
  let beta = null;

  await check('a store lookup that misses reads as missing, not as a request object', async () => {
    // The regression that motivated this file. The task store resolved a
    // failed `get` to the IDBRequest instead of undefined, so every
    // `(await getTask(id)) || {default}` skipped its fallback and got a
    // truthy object with none of the expected fields. The work log was the
    // casualty: its record was never created, so in a fleet that had been
    // shipping for weeks, fleet_digest had never once returned an entry.
    // Reading the empty log is the observable form of that bug.
    const d = await fleet('fleet_digest', { limit: 5 });
    assert.deepStrictEqual(d.entries, [], 'an empty log should read empty');
    assert.strictEqual(d.count, 0);
  });

  await check('an enqueued task starts queued and claimed by nobody', async () => {
    const r = await fleet('fleet_enqueue', { tasks: ['count to three'], label_prefix: 'probe' });
    assert.strictEqual(r.enqueued, 1);
    [taskId] = r.ids;
    const [row] = (await fleet('fleet_status')).filter((t) => t.id === taskId);
    assert.strictEqual(row.status, 'queued');
    assert.ok(!row.claimedBy, 'a queued task already has an owner');
  });

  await check('two workers race for one task and exactly one wins', async () => {
    alpha = await newWorker(browser, 'alpha1');
    beta = await newWorker(browser, 'beta22');

    // Whoever gets there first is fine; that BOTH cannot is the point.
    const states = await untilAny([alpha, beta], (d) => d.currentLeaseTaskId === taskId,
      'one of the workers to claim the task');
    const holders = states.filter((d) => d && d.currentLeaseTaskId === taskId);
    assert.strictEqual(holders.length, 1,
      `${holders.length} workers claimed the same task — leasing is not exclusive`);

    // And it stays exclusive: the loser must not claim it a moment later.
    await new Promise((r) => setTimeout(r, 3000));
    const after = [await debug(alpha), await debug(beta)].filter((d) => d.currentLeaseTaskId === taskId);
    assert.strictEqual(after.length, 1, 'the second worker claimed the task after the first');

    const rows = await fleet('fleet_status');
    const row = rows.find((t) => t.id === taskId);
    assert.strictEqual(row.status, 'running');
    assert.strictEqual(row.claimedBy, holders[0].workerId, 'the queue disagrees about who holds the lease');
    assert.strictEqual(row.alive, true, 'a claimed task should show its lock held');
  });

  await check('the claim reached the agent as an actual instruction', async () => {
    // A lease that never becomes work is not a lease. Whichever tab won
    // should have had the task text pushed into its chat.
    const sentA = await alpha.evaluate(() => window.__sent);
    const sentB = await beta.evaluate(() => window.__sent);
    const withTask = [...sentA, ...sentB].filter((s) => s.includes('count to three'));
    assert.strictEqual(withTask.length, 1, 'the task text was injected into ' + withTask.length + ' tabs');
    assert.match(withTask[0], /fleet_report/, 'the wrapped task never tells the agent how to finish');
  });

  await check('a worker that dies releases its lease, and it is requeued', async () => {
    const holder = (await debug(alpha)).currentLeaseTaskId === taskId ? alpha : beta;
    const survivor = holder === alpha ? beta : alpha;
    await holder.close();

    // fleet_status runs requeueStale, which is how a dashboard notices.
    let row = null;
    const deadline = Date.now() + 25000;
    for (;;) {
      row = (await fleet('fleet_status')).find((t) => t.id === taskId);
      if (row && row.requeues > 0) break;
      if (Date.now() > deadline) assert.fail(`the dead worker's task was never requeued: ${JSON.stringify(row)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(row.requeueReason, 'lock-released',
      'the requeue should name the lock release, not guess at staleness');
    assert.ok(!row.claimedBy, 'a requeued task still names its dead owner');

    // And the survivor takes it: a requeue nobody picks up is just a leak.
    await until(survivor, (d) => d.currentLeaseTaskId === taskId,
      'the surviving worker to pick up the requeued task');
    if (holder === alpha) alpha = null; else beta = null;
  });

  await check('a frozen worker is requeued too — a held lock is not liveness', async () => {
    // The tab is alive and still holds the task lock, so only the heartbeat
    // can distinguish it from a working one. Backdate it past the threshold.
    await dash.evaluate((id) => new Promise((resolve, reject) => {
      const open = indexedDB.open('creel_fleet', 1);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('tasks', 'readwrite');
        const store = tx.objectStore('tasks');
        const get = store.get(id);
        get.onsuccess = () => {
          const t = get.result;
          t.lastHeartbeat = Date.now() - (10 * 60 * 1000);   // > STALE_HEARTBEAT_MS
          store.put(t);
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    }), taskId);

    const rows = await fleet('fleet_status');
    const row = rows.find((t) => t.id === taskId);
    assert.strictEqual(row.status, 'queued', 'a frozen worker kept its task');
    assert.strictEqual(row.requeueReason, 'heartbeat-stale');
    assert.strictEqual(row.requeues, 2, 'the requeue count should accumulate, not reset');
  });

  await check('draining stops the queue from handing out more work', async () => {
    await fleet('fleet_drain', { on: true });
    const r = await fleet('fleet_enqueue', { tasks: ['must not be claimed'], label_prefix: 'drained' });
    const drainedId = r.ids[0];
    // Long enough to cover the bus jitter a claim would use.
    await new Promise((res) => setTimeout(res, 4000));
    const row = (await fleet('fleet_status')).find((t) => t.id === drainedId);
    assert.strictEqual(row.status, 'queued', 'a task was claimed while the fleet was draining');
    await fleet('fleet_drain', { on: false });
  });

  await check('every transition is in the work log, with its reason', async () => {
    const d = await fleet('fleet_digest', { limit: 50 });
    const kinds = d.entries.map((e) => e.event || e.kind || e.type);
    assert.ok(kinds.includes('claimed'), 'no claim was logged: ' + JSON.stringify(kinds));
    assert.ok(kinds.includes('requeued'), 'no requeue was logged: ' + JSON.stringify(kinds));
    const requeue = d.entries.find((e) => (e.event || e.kind || e.type) === 'requeued');
    assert.match(JSON.stringify(requeue), /lock-released|heartbeat-stale/,
      'the log records a requeue without saying why');
  });

  for (const p of [alpha, beta, dash]) if (p) await p.close().catch(() => {});
  await browser.close();

  console.log('creel fleet leasing');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
