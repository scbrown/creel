/* creel — the fleet work log (creel-vis, split out under creel-hun).
 *
 * Every task transition — claimed, done, failed, requeued, aborted — is
 * appended to one shared record in the task store, and the dispatcher tab
 * drains it into its own conversation. That is what makes fleet work visible
 * to the operator's agent automatically instead of only to whoever polls.
 * Workers only ever append; they never inject into the main tab.
 *
 * This log spent its whole life broken and silent (see creel-psr). The store
 * helper resolved a MISSING get to the IDBRequest object rather than to
 * undefined, so `(await getTask(DIGEST_ID)) || {…}` never took its fallback,
 * digestAdd assigned entries onto that request, and storing it threw
 * DataCloneError into a promise nobody awaited. The record was never created
 * and fleet_digest never returned an entry. Nothing reported a fault, because
 * every failure was a swallowed rejection. Hence the guards below, and hence
 * this file having its own home: a subsystem whose whole job is visibility is
 * exactly the one that must not fail invisibly.
 */
(function () {
  'use strict';

  const FLEET = window.CreelFleetInternal;
  if (!FLEET) throw new Error('creel-fleet-log.js loaded before creel-fleet.js — check the script order in onepagent.html');
  const { getTask, putTask, notify, MY_TASK_ID, MY_WORKER_ID } = FLEET;
  // ── fleet work log (creel-vis) ────────────────────────────────────
  // Every task transition (claimed/done/failed/requeued/aborted) is
  // appended to a shared log in the task store, and the main tab drains
  // it into its own conversation — so ALL fleet work is visible to the
  // operator's agent automatically, not just to whoever polls. Workers
  // only append; they never inject into the main tab. The main tab is
  // the one with no MY_TASK_ID and no MY_WORKER_ID.
  const DIGEST_ID = 'meta:digest';
  const DIGEST_CURSOR_ID = 'meta:digest-cursor';
  const MAX_DIGEST = 200;
  const isDispatcher = () => !MY_TASK_ID && !MY_WORKER_ID;
  async function digestAdd(event, t, detail) {
    const d = (await getTask(DIGEST_ID)) || { id: DIGEST_ID, kind: 'meta', status: 'meta', entries: [] };
    d.entries = d.entries || [];
    const ts = Math.max(Date.now(), (d.entries[d.entries.length - 1]?.ts || 0) + 1); // strictly increasing
    d.entries.push({ ts, event, id: t.id, label: t.label || null, detail: detail ? String(detail).slice(0, 300) : undefined });
    if (d.entries.length > MAX_DIGEST) d.entries.splice(0, d.entries.length - MAX_DIGEST);
    await putTask(d);
    notify();
  }
  let digestFlushTimer = null;
  function scheduleDigestDrain() {
    if (!isDispatcher()) return;
    clearTimeout(digestFlushTimer);
    digestFlushTimer = setTimeout(drainDigest, 800); // debounce: batch burst events into one message
  }
  async function drainDigest() {
    if (!isDispatcher()) return;
    const d = await getTask(DIGEST_ID);
    if (!d || !d.entries || !d.entries.length) return;
    const c = (await getTask(DIGEST_CURSOR_ID)) || { id: DIGEST_CURSOR_ID, kind: 'meta', status: 'meta', ts: 0 };
    const fresh = d.entries.filter((e) => e.ts > (c.ts || 0));
    if (!fresh.length) return;
    await putTask({ ...c, ts: fresh[fresh.length - 1].ts });
    const lines = fresh.map((e) => {
      const who = e.label || e.id;
      switch (e.event) {
        case 'claimed': return `· ${who} claimed by a worker`;
        case 'done': return `· ${who} DONE${e.detail ? `: ${e.detail}` : ''}`;
        case 'failed': return `· ${who} FAILED: ${e.detail || ''}`;
        case 'requeued': return `· ${who} requeued (${e.detail || 'stale'}) — its worker froze or died`;
        case 'aborted': return `· ${who} aborted`;
        case 'enqueued': return `· ${who} enqueued`;
        default: return `· ${who} ${e.event}${e.detail ? `: ${e.detail}` : ''}`;
      }
    });
    injectTask('🧺 FLEET DIGEST\n' + lines.join('\n'));
  }

  // creel-sbx: read the harness's token counters (top-level `let` globals in
  // onepagent.html — classic scripts share the global lexical scope). They are
  // cumulative for the tab's session; the delta between a task's start and its
  // fleet_report is that task's token spend. Guarded so a stale harness build
  // (no counters yet) degrades to zeros instead of throwing.
  Object.assign(FLEET, {
    DIGEST_ID, DIGEST_CURSOR_ID, digestAdd, scheduleDigestDrain, drainDigest,
  });
})();
