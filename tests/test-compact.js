/* Compaction forks a thread instead of rewriting one (creel-7xu).
 *
 * Compaction used to splice its summary back into the SAME conversation, so
 * the transcript you were reading was rewritten underneath you and the detail
 * was gone with no way back. It now forks: the summary opens a new thread and
 * the original is left whole.
 *
 * The summarising half needs a live LLM, so what is tested here is everything
 * around it — the fork itself, which is where the losable things are. Chiefly
 * the VFS: newConversation() resets it, so a fork that forgets to carry it
 * hands the agent an empty workspace and its files are simply gone.
 *
 * Run: node tests/test-compact.js   (or `just test`)
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

(async () => {
  if (!Browser.available()) {
    console.log('creel compaction\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  const page = await browser.newPage('/thread.html');
  await page.waitForFunction(() => typeof window.forkThreadFromSummary === 'function',
    { message: 'the compaction layer' });

  await check('forking is the default, and the setting can turn it off', async () => {
    assert.strictEqual(await page.evaluate(() => compactionForksThread()), true);
    const off = await page.evaluate(() => {
      const s = loadSettings() || {};
      s.compactForksThread = false;
      saveSettingsToStorage(s);
      const v = compactionForksThread();
      delete s.compactForksThread;
      saveSettingsToStorage(s);
      return v;
    });
    assert.strictEqual(off, false, 'the opt-out does not take effect');
  });

  await check('a fork starts a new thread and leaves the original alone', async () => {
    const r = await page.evaluate(() => {
      // A thread with something in it, and a file in the workspace.
      newConversation(true);
      const parentId = activeConvId;
      appendSessionEntry('message', { role: 'user', content: 'the original question' });
      rebuildConversation();
      const parentEntries = sessionEntries.length;

      const forked = forkThreadFromSummary('a summary of what came before', { trigger: 'manual' });
      return {
        parentId, forked,
        switched: activeConvId === forked && forked !== parentId,
        parentStillListed: convHistory.some((c) => c.id === parentId),
        parentEntries,
      };
    });
    assert.ok(r.forked, 'forkThreadFromSummary returned nothing');
    assert.strictEqual(r.switched, true, 'the fork did not become the active thread');
    assert.strictEqual(r.parentStillListed, true, 'the original thread vanished from the list');
  });

  await check('the new thread opens with the summary as its context', async () => {
    const conv = await page.evaluate(() => {
      rebuildConversation();
      return conversation.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    });
    assert.ok(conv.length >= 1, 'the forked thread has no context at all');
    assert.match(conv[0], /a summary of what came before/,
      'the summary is not the opening context: ' + conv[0]);
    assert.ok(!conv.join('\n').includes('the original question'),
      'the fork dragged the original transcript along; the point is that it does not');
  });

  await check('the workspace comes with it — a fork must not lose the files', async () => {
    const r = await page.evaluate(() => {
      newConversation(true);
      vfs.children['work.txt'] = { type: 'file', content: 'the agent was working on this' };
      forkThreadFromSummary('summary', { trigger: 'manual' });
      return { carried: !!(vfs.children && vfs.children['work.txt']),
               content: vfs.children['work.txt'] && vfs.children['work.txt'].content };
    });
    assert.strictEqual(r.carried, true,
      'newConversation() reset the VFS and the fork did not carry it — the workspace is gone');
    assert.strictEqual(r.content, 'the agent was working on this');
  });

  await check('the new thread is named for the one it continues', async () => {
    const title = await page.evaluate(() => {
      newConversation(true);
      const meta = convHistory.find((c) => c.id === activeConvId);
      meta.title = 'Refactoring the parser';
      forkThreadFromSummary('summary', { trigger: 'manual' });
      return (convHistory.find((c) => c.id === activeConvId) || {}).title;
    });
    assert.match(title, /Refactoring the parser/, 'the lineage is not visible in the list: ' + title);
  });

  await check('a fork during a run is deferred, not performed underneath it', async () => {
    // A run owns its DOM and abort controller and is keyed by conversation id.
    // Switching threads mid-turn would strand it, so the fork waits.
    const r = await page.evaluate(async () => {
      newConversation(true);
      const convId = activeConvId;
      const fake = { convId, active: true, abortCtrl: new AbortController(), state: {} };
      conversationRuns.set(convId, fake);
      // Queue a fork the way an auto-compaction would.
      pendingCompactionFork = { summary: 'deferred summary', meta: { trigger: 'auto' }, convId };
      const duringRun = forkAfterRunIfPending();
      const stayed = activeConvId === convId;
      // The turn ends.
      fake.active = false;
      conversationRuns.delete(convId);
      const afterRun = forkAfterRunIfPending();
      return { duringRun, stayed, afterRun, movedNow: activeConvId !== convId };
    });
    assert.strictEqual(r.duringRun, null, 'it forked while a run was still active');
    assert.strictEqual(r.stayed, true, 'the active thread changed underneath a live run');
    assert.ok(r.afterRun, 'the deferred fork never happened once the run ended');
    assert.strictEqual(r.movedNow, true, 'the deferred fork did not switch threads');
  });

  await page.close();
  await browser.close();

  console.log('creel compaction');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
