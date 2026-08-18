#!/usr/bin/env node
/* creel — tools/check-shell.js: every script the page loads must be known to
 * the service worker, and every file the page references must exist.
 *
 * The harness is 26 ordered parts (creel-yny). A part added, renamed or
 * reordered without updating app/sw.js produces the worst kind of bug: the
 * page works perfectly for whoever changed it — their network is up — and
 * breaks offline, or serves a stale part alongside fresh ones, for everyone
 * else. That failure never shows up in a test that loads the page over http.
 *
 * So this checks the two lists against each other, plus the obvious one: that
 * every src/href the page names is actually on disk.
 *
 * Usage: node tools/check-shell.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const html = fs.readFileSync(path.join(APP, 'thread.html'), 'utf8');
const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');

const problems = [];

/** The entries of one array literal in sw.js. Read the arrays separately, not
 *  the file as a whole: a path that appears only in NETWORK_FIRST is fetched
 *  fresh but never precached, so it is exactly as missing offline as one that
 *  is not there at all — and a whole-file search would call it present. */
function swList(name) {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(sw);
  if (!m) { problems.push(`app/sw.js has no ${name} array`); return new Set(); }
  return new Set([...m[1].matchAll(/'\.\/([^']*)'/g)].map((x) => x[1]));
}
const appShell = swList('APP_SHELL');
const networkFirst = swList('NETWORK_FIRST');

/** Local assets the page pulls in, in document order. */
const refs = [];
for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) refs.push(m[1]);
for (const m of html.matchAll(/<link[^>]*\bhref="([^"]+\.css)"/g)) refs.push(m[1]);

for (const ref of refs) {
  if (/^(https?:)?\/\//.test(ref)) continue;              // remote, not ours to cache
  if (!fs.existsSync(path.join(APP, ref))) {
    problems.push(`thread.html references ${ref}, which does not exist`);
    continue;
  }
  if (!appShell.has(ref)) {
    problems.push(`${ref} is loaded by the page but missing from APP_SHELL in app/sw.js — `
      + 'it will not be precached, so the app breaks offline');
  }
}

/** The reverse: a stale entry for a file that has been renamed or removed.
 *  A precache list with one bad URL fails the whole install, taking every
 *  other asset down with it. */
for (const rel of new Set([...appShell, ...networkFirst])) {
  if (rel === '' || rel.endsWith('/')) continue;          // './' is the page itself
  if (!fs.existsSync(path.join(APP, rel))) {
    problems.push(`app/sw.js lists ${rel}, which does not exist — precaching it fails the install`);
  }
}

/** The harness parts are ordered; the page must load them in that order. */
const loaded = refs.filter((r) => r.startsWith('harness/'));
const sorted = [...loaded].sort();
if (loaded.join() !== sorted.join()) {
  problems.push('the harness parts are not loaded in numeric order — the order is the semantics');
}
const onDisk = fs.readdirSync(path.join(APP, 'harness')).filter((f) => f.endsWith('.js')).sort();
const missing = onDisk.filter((f) => !loaded.includes(`harness/${f}`));
if (missing.length) problems.push(`harness parts on disk but never loaded: ${missing.join(', ')}`);

if (problems.length) {
  for (const p of problems) console.error('  ' + p);
  console.error(`check-shell: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`check-shell ok — ${refs.length} local assets, all present and cached`);
