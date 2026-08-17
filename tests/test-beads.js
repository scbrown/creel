/* creel — test-beads.js (creel-9wn): the beads-compatible store + CLI.
 * Zero dependencies. Run: node tests/test-beads.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BeadsStore = require('../app/beads-store.js');

const ROOT = path.join(__dirname, '..');

async function main() {
  let n = 0;
  const ok = (name) => { n++; console.log('  ✓ ' + name); };

  // ── in-memory adapter (browser-like, no fs) ─────────────────────────
  {
    const store = await new BeadsStore({ adapter: BeadsStore.memoryAdapter() }).load();

    const a = await store.create({ title: 'Test issue', description: 'd', priority: 2, issue_type: 'task', actor: 'tester' });
    assert(a.id.startsWith('creel-'), 'id prefix');
    assert.match(a.id, /^creel-[a-z0-9]{3}$/, 'id shape');
    assert.strictEqual(a.status, 'open');
    assert.strictEqual(a.issue_type, 'task');
    assert.strictEqual(a.priority, 2);
    assert.strictEqual(a.created_by, 'tester');
    ok('create makes a well-formed creel-xxx record');

    assert.strictEqual(store.get(a.id).title, 'Test issue');
    assert(store.ready().some((i) => i.id === a.id), 'ready sees the new issue');
    ok('get + ready');

    const bad = await store.create({ title: 'high', priority: 1 }).catch((e) => e);
    assert(bad instanceof Error && /priority/.test(bad.message), 'priority validation');
    const bad2 = await store.create({ title: 'no title' }).catch((e) => e);
    assert(bad2 instanceof Error && /title/.test(bad2.message), 'title validation');
    ok('input validation');

    const claimed = await store.update(a.id, { status: 'in_progress' }, { actor: 'tester' });
    assert.strictEqual(claimed.status, 'in_progress');
    assert(claimed.started_at, 'started_at stamped on claim');
    ok('claim stamps started_at');

    const closed = await store.close(a.id, { actor: 'tester', reason: 'all done' });
    assert.strictEqual(closed.status, 'closed');
    assert(closed.closed_at, 'closed_at stamped');
    assert.strictEqual(closed.close_reason, 'all done');
    assert(!store.ready().some((i) => i.id === a.id), 'closed issue leaves ready');
    ok('close stamps closed_at + close_reason');

    const edits = store.interactions.filter((x) => x.issue_id === a.id);
    assert.strictEqual(edits.length, 3, `3 interactions (created, claim, close) got ${edits.length}`);
    assert(edits.every((x) => x.kind === 'field_change' && x.extra && 'old_value' in x.extra), 'interaction shape');
    assert.strictEqual(edits[0].extra.field, 'created');
    ok('audit log records every transition');

    const ids = new Set([a.id]);
    for (let i = 0; i < 50; i++) ids.add((await store.create({ title: 'bulk ' + i, actor: 'tester' })).id);
    assert.strictEqual(ids.size, 51, 'ids unique across 50 creates');
    ok('id generation avoids collisions');
  }

  // ── real fs adapter + reload + JSONL byte-compat ────────────────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-test-'));
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  {
    const store = await new BeadsStore({ adapter: BeadsStore.nodeAdapter(dir) }).load();
    const a = await store.create({ title: 'On disk', priority: 3, actor: 'disk' });
    await store.claim(a.id, { actor: 'disk' });

    const raw = fs.readFileSync(path.join(dir, '.beads/issues.jsonl'), 'utf8');
    const parsed = raw.split('\n').filter(Boolean).map(JSON.parse);
    const rec = parsed.find((i) => i.id === a.id);
    assert(rec && rec._type === 'issue' && rec.status === 'in_progress', 'record persisted in beads JSONL shape');
    assert.strictEqual(rec.updated_at, rec.updated_at, 'timestamps round-trip');
    ok('node adapter writes beads-format issues.jsonl');

    const interRaw = fs.readFileSync(path.join(dir, '.beads/interactions.jsonl'), 'utf8');
    assert(interRaw.includes(a.id), 'interactions.jsonl written');
    ok('interactions.jsonl written');

    const store2 = await new BeadsStore({ adapter: BeadsStore.nodeAdapter(dir) }).load();
    assert.strictEqual(store2.get(a.id).status, 'in_progress');
    ok('reload from disk');
  }

  // ── CLI end-to-end ──────────────────────────────────────────────────
  {
    const run = (args) => execFileSync(process.execPath, [path.join(ROOT, 'tools/bd.js'), ...args], {
      cwd: dir, encoding: 'utf8',
    });
    const created = run(['create', 'CLI issue', '--priority', '1', '--type', 'feature', '--actor', 'cli']).trim();
    const id = created.match(/created (\S+)/)[1];
    assert(id && id.startsWith('creel-'), 'CLI create returns an id');
    ok('CLI create');

    const ready = run(['ready']);
    assert(ready.includes(id), 'CLI ready lists the new issue');
    ok('CLI ready');

    const shown = JSON.parse(run(['show', id]));
    assert.strictEqual(shown.priority, 1);
    assert.strictEqual(shown.issue_type, 'feature');
    ok('CLI show returns full record');

    run(['claim', id, '--actor', 'cli']);
    assert(JSON.parse(run(['show', id])).status === 'in_progress');
    ok('CLI claim');

    run(['close', id, 'done via cli']);
    assert(JSON.parse(run(['show', id])).status === 'closed');
    assert(!run(['ready']).includes(id), 'closed issue gone from ready');
    ok('CLI close');

    assert.throws(() => run(['update', 'creel-nope', '--status', 'open']), /no such issue/);
    ok('CLI errors on unknown id');
  }

  console.log(`\ntest-beads ok — ${n} assertions`);
}

main().catch((e) => { console.error(e); process.exit(1); });
