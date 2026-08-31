#!/usr/bin/env node
/* creel — tools/creel-collect-metrics.js: the collector for a producer that
 * cannot be scraped.
 *
 * Requested on the standing-producer bead, child of the stack-metrics epic.
 * `app/creel-metrics.js` renders exposition INSIDE a page; `tools/creel-push-
 * metrics.js` sends exposition to a gateway. Between them sat a human opening a
 * tab, which is why the signal existed only when somebody was watching. This is
 * that missing middle: it opens an ephemeral page, asks it to render, and writes
 * the exposition to stdout. Pipe it to the push tool and the pair is standing.
 *
 * ── WHY THIS DOES NOT DELETE `server-none` ──────────────────────────────────
 *
 * The obvious way to make a page's metrics scrapable is to give the page a
 * server. That would delete the property the README calls the bet, so it is not
 * what this does. Nothing here listens. A scheduled caller opens a tab, takes a
 * reading, and the tab EXITS — which is creel's own thesis about tabs, not an
 * exception to it. The page stays static and address-less; the schedule lives
 * with the operator, where a credential can also safely live.
 *
 * A standing producer is therefore not an always-on creel component. It is a
 * periodic reader of an ephemeral one, the same shape as any other cron'd probe.
 *
 * ── THE ABSENCE QUESTION, WHICH IS THE WHOLE POINT ──────────────────────────
 *
 * A gap in a pushed series has two very different causes: the producer died, or
 * the producer ran and creel had nothing to say. They look identical at the
 * gateway, and treating them alike is the `up=1`-while-dead class this epic was
 * written against. So this tool NEVER fabricates a reading to fill a gap, and it
 * separates the two in its EXIT CODE rather than in prose. The scheduled caller
 * is expected to publish that code as its own series, so an operator reading a
 * flat line can tell which of the two they are looking at.
 *
 * It also does not filter the exposition. `status="unknown"` samples pass
 * through untouched: creel's doctor refuses to collapse "cannot tell" into a
 * zero, and a transport that quietly dropped those would undo that refusal.
 *
 * ── EXIT CODES (the same ladder as creel-doctor, -admission and -push-metrics)
 *
 *   0  collected  exposition on stdout
 *   2  unset      no browser available, or the page rendered nothing.
 *                 NOTHING WAS COLLECTED — this is not an error, and it is not
 *                 a reading either. Never report it as either.
 *   3  error      this tool could not run: bad flags, no page, a driver fault.
 *                 Never confuse with 2 — 3 means fix the run.
 *
 * Usage:
 *   node tools/creel-collect-metrics.js [--page /thread.html] [--timeout-ms N]
 *   node tools/creel-collect-metrics.js | node tools/creel-push-metrics.js --exposition -
 */
'use strict';

const path = require('node:path');

function die(msg) {
  process.stderr.write(`creel-collect-metrics: ${msg}\n`);
  process.exit(3);
}

/* THESE GUARDS ARE REGISTERED BEFORE THE DRIVER IS REQUIRED, AND THE ORDER IS
 * LOAD-BEARING. A fault reaches this tool two ways that a try/catch cannot see:
 * a Chromium spawn failure arrives as an 'error' EVENT on the child process,
 * and a broken or partially-synced checkout fails the require below at MODULE
 * LOAD. Both exit 1 unguarded — a code not in this tool's ladder at all, which
 * would leave a scheduled caller unable to tell a broken collector from a quiet
 * one. Measured both: a missing binary and a missing module each exited 1
 * before this moved above the require. */
process.on('uncaughtException', (err) => die(`driver fault: ${err && err.message ? err.message : err}`));
process.on('unhandledRejection', (err) => die(`driver fault: ${err && err.message ? err.message : err}`));

/* The CDP driver lives in tests/ because it was written to drive creel's UI
 * tests. It is creel's ONLY browser driver, it is deliberately dependency-free
 * (Node's WebSocket + a Chromium that is already on the machine), and copying
 * 150 lines of it in here to satisfy a directory convention would leave two
 * drivers to keep in step. Borrowed rather than duplicated, deliberately. */
const { Browser } = require(path.join(__dirname, '..', 'tests', 'browser.js'));

const APP = path.join(__dirname, '..', 'app');

function parseArgs(argv) {
  const o = { page: '/thread.html', timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--page') o.page = argv[++i] || die('--page needs a path');
    else if (a === '--timeout-ms') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) die('--timeout-ms needs a positive number');
      o.timeoutMs = v;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    } else die(`unknown flag ${a}`);
  }
  return o;
}

function usage() {
  return 'usage: node tools/creel-collect-metrics.js [--page /thread.html] [--timeout-ms N]\n'
    + '  0 collected (exposition on stdout) · 2 nothing collected · 3 could not run\n';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  /* No browser is NOT an error. It is the honest "I took no reading", and it
   * must stay distinguishable from both a reading and a fault. */
  if (!Browser.available()) {
    process.stderr.write('creel-collect-metrics: no Chromium found '
      + '(set CHROME_PATH) — NOTHING WAS COLLECTED\n');
    process.exit(2);
  }

  let browser = null;
  let text = null;
  try {
    browser = await Browser.launch({ root: APP });
    const page = await browser.newPage(o.page);
    await page.waitForFunction(() => typeof window.CreelMetrics !== 'undefined',
      { message: 'CreelMetrics to load', timeout: o.timeoutMs });
    text = await page.evaluate(async () => window.CreelMetrics.run());
  } catch (err) {
    /* A driver fault is a 3: the run is broken and wants fixing. Reporting it
     * as 2 would file a broken collector under "creel had nothing to say", and
     * the schedule would go on publishing a reassuring silence. */
    if (browser) { try { await browser.close(); } catch (_) { /* already gone */ } }
    die(`could not collect: ${err && err.message ? err.message : err}`);
  }
  try { await browser.close(); } catch (_) { /* already gone */ }

  const samples = String(text || '').split('\n')
    .filter((l) => l && !l.startsWith('#'));
  if (!samples.length) {
    process.stderr.write('creel-collect-metrics: the page rendered no samples '
      + '— NOTHING WAS COLLECTED\n');
    process.exit(2);
  }

  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.stderr.write(`creel-collect-metrics: collected ${samples.length} samples\n`);
  process.exit(0);
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
