#!/usr/bin/env node
/* creel — tools/bd.js: a beads-compatible tracker CLI (creel-9wn).
 *
 * The same store as the in-page bd server, driven from the shell against a
 * real .beads/ directory — no Dolt, no dependencies. Issue ids, statuses,
 * priorities, and the field_change audit log are byte-compatible with beads'
 * passive export, so wherever the real `bd` CLI exists, `bd dolt push/pull`
 * can still own sync.
 *
 * Usage:
 *   node tools/bd.js ready [--limit N] [--json]
 *   node tools/bd.js list [--status open|in_progress|closed] [--type bug|feature|task] [--priority N] [--json]
 *   node tools/bd.js show <id> [--json]
 *   node tools/bd.js create <title> [--description ...] [--acceptance ...] [--priority N] [--type bug|feature|task]
 *   node tools/bd.js update <id> [--status ...] [--priority N] [--title ...] [--description ...] [--acceptance ...] [--type ...] [--reason ...]
 *   node tools/bd.js claim <id> [--reason ...]
 *   node tools/bd.js close <id> [reason words... | --reason ...]
 *
 * Common: --dir <repo-root> (default: nearest ancestor of cwd containing
 * .beads/), --actor <name> (default: BEADS_ACTOR or Claude), --json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const BeadsStore = require('../app/beads-store.js');

function findRepoDir(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.beads'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function renderRow(i, width) {
  const p = 'P' + i.priority;
  const t = (i.issue_type || '').padEnd(7);
  const title = i.title || '(untitled)';
  return `${i.id.padEnd(9)} ${p} ${t} ${title}`;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const repoDir = findRepoDir(flags.dir || process.cwd());
  if (!repoDir) {
    console.error('bd: no .beads/ found from cwd (pass --dir <repo-root>)');
    process.exit(1);
  }
  const actor = flags.actor || process.env.BEADS_ACTOR || 'Claude';
  const store = await new BeadsStore({
    adapter: BeadsStore.nodeAdapter(repoDir),
    prefix: path.basename(repoDir),
    actor,
  }).load();
  const json = !!flags.json;

  switch (cmd) {
    case 'ready': {
      const rows = store.ready({ limit: flags.limit });
      if (json) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return console.log('bd ready: no open issues 🎉');
      console.log(`bd ready — ${rows.length} open issue(s):`);
      for (const r of rows) console.log('  ' + renderRow(r));
      return;
    }
    case 'list': {
      const rows = store.list({
        status: flags.status, type: flags.type, priority: flags.priority, limit: flags.limit,
      });
      if (json) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return console.log('bd list: no matching issues');
      for (const r of rows) console.log(renderRow(r));
      return;
    }
    case 'show': {
      const id = rest[0];
      if (!id) return usage('show <id>');
      const rec = store.get(id);
      if (!rec) { console.error(`bd: no such issue: ${id}`); process.exit(1); }
      return console.log(JSON.stringify(rec, null, 2));
    }
    case 'create': {
      const title = rest.join(' ');
      if (!title) return usage('create "<title>"');
      const rec = await store.create({
        title,
        description: flags.description || '',
        acceptance_criteria: flags.acceptance || '',
        priority: flags.priority != null ? Number(flags.priority) : 2,
        issue_type: flags.type || 'task',
        actor,
      });
      console.log(json ? JSON.stringify(rec) : `created ${rec.id} — ${rec.title}`);
      return;
    }
    case 'claim': {
      const id = rest[0];
      if (!id) return usage('claim <id>');
      const rec = await store.claim(id, { actor, reason: flags.reason });
      console.log(json ? JSON.stringify(rec) : `${id} → in_progress (claimed by ${actor})`);
      return;
    }
    case 'close': {
      const id = rest[0];
      if (!id) return usage('close <id> [reason]');
      const reason = flags.reason || rest.slice(1).join(' ') || '';
      const rec = await store.close(id, { actor, reason });
      console.log(json ? JSON.stringify(rec) : `${id} → closed${reason ? ` — ${reason}` : ''}`);
      return;
    }
    case 'update': {
      const id = rest[0];
      if (!id) return usage('update <id> [--status ...] [--priority N] ...');
      const patch = {};
      for (const k of ['status', 'priority', 'title', 'description', 'acceptance', 'type']) {
        if (flags[k] !== undefined) patch[k === 'acceptance' ? 'acceptance_criteria' : k === 'type' ? 'issue_type' : k] =
          k === 'priority' ? Number(flags[k]) : flags[k];
      }
      const rec = await store.update(id, patch, { actor, reason: flags.reason });
      console.log(json ? JSON.stringify(rec) : `${id} updated → ${rec.status}`);
      return;
    }
    default:
      return usage();
  }

  function usage(hint) {
    console.error(hint ? `bd: ${hint}` : 'bd: unknown command');
    console.error('commands: ready | list | show <id> | create <title> | update <id> | claim <id> | close <id> [reason]');
    console.error('options: --dir <repo-root> --actor <name> --json  (see header comment)');
    process.exit(1);
  }
}

main().catch((e) => { console.error('bd:', e && e.message ? e.message : e); process.exit(1); });
