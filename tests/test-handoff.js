'use strict';

const assert = require('assert');
const H = require('../app/creel-handoff.js');

const identity = () => ({
  harness: 'shantytown', agent: 'worker-1', session: 'session-1',
  key_id: 'sha256:key-1', introducer: 'st', binding: 'binding-1',
});
const queued = () => ({
  version: 'crew-handoff-v1', id: 'handoff-1', origin: identity(),
  target: { harness: 'creel', agent: 'browser-worker' },
  task: { id: 'task-1', title: 'Measure parity', pointer: 'tracker:task-1' },
  ownership: { lease_id: 'lease-1', owner: null }, state: 'queued',
});

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

assert.strictEqual(H.canonical(queued()), '{"id":"handoff-1","origin":{"agent":"worker-1","binding":"binding-1","harness":"shantytown","introducer":"st","key_id":"sha256:key-1","session":"session-1"},"ownership":{"lease_id":"lease-1","owner":null},"state":"queued","target":{"agent":"browser-worker","harness":"creel"},"task":{"id":"task-1","pointer":"tracker:task-1","title":"Measure parity"},"version":"crew-handoff-v1"}');
ok('canonical bytes match the cross-language golden fixture');

const original = queued();
const reordered = Object.fromEntries(Object.entries(original).reverse());
const detached = H.validate(original);
detached.task.title = 'mutated detached copy';
assert.strictEqual(original.task.title, 'Measure parity');
assert.strictEqual(H.canonical(original), H.canonical(reordered));
assert.strictEqual(H.canonical(JSON.parse(H.canonical(original))), H.canonical(original));
ok('canonicalization is idempotent, key-order independent and detached');

const claimed = H.transition(queued(), 'claimed', { ownership: {
  lease_id: 'lease-1', owner: identity(), claimed_at: '2026-08-31T12:00:00Z', expires_at: '2026-08-31T12:05:00Z',
} });
const done = H.transition(claimed, 'succeeded', { result: { pointer: 'git:abc123', summary: 'landed' } });
assert.strictEqual(done.ownership.owner.session, 'session-1');
assert.strictEqual(done.result.pointer, 'git:abc123');
ok('claim and success preserve attested ownership and a result pointer');

for (const [name, mutate, message] of [
  ['missing key id', (e) => { delete e.origin.key_id; }, /origin.key_id/],
  ['queued owner', (e) => { e.ownership.owner = identity(); }, /queued envelope/],
  ['success without pointer', (e) => { e.ownership.owner = identity(); e.state = 'succeeded'; e.result = { summary: 'none' }; }, /result.pointer/],
  ['string retryable', (e) => { e.ownership.owner = identity(); e.state = 'failed'; e.failure = { code: 'x', message: 'bad', retryable: 'yes' }; }, /retryable/],
]) {
  const envelope = queued(); mutate(envelope);
  assert.throws(() => H.validate(envelope), message, name);
}
ok('identity and terminal-state ambiguity are rejected');

const failed = H.transition(claimed, 'failed', { failure: { code: 'blocked', message: 'no access', retryable: false } });
assert.throws(() => H.transition(failed, 'queued'), /illegal transition/);
ok('terminal envelopes cannot be reopened');

console.log(`\n${n} handoff envelope checks passed`);
