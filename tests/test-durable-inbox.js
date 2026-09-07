'use strict';
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const H = require('../app/creel-handoff.js');
const B = require('../app/creel-durable-inbox.js');
const envelope = {
  version: 'crew-handoff-v1', id: 'handoff-1',
  origin: { harness: 'creel', agent: 'tab-1', session: 'session-1', key_id: 'key-1', introducer: 'launcher', binding: 'binding-1' },
  target: { harness: 'shantytown', agent: 'worker' },
  task: { id: 'task-1', pointer: 'https://example.org/tasks/1' },
  ownership: { lease_id: 'lease-1', owner: null }, state: 'queued',
};
const receipt = {
  version: 'crew-inbox-receipt-v1', receipt_id: 'a'.repeat(64), handoff_id: envelope.id,
  task_id: envelope.task.id, envelope_sha256: createHash('sha256').update(H.canonical(envelope)).digest('hex'),
  inbox_id: 'test-1', backend: 'br', delivery: 'persisted', acknowledged: false,
};
(async () => {
  await assert.rejects(B.send(envelope), /not configured/);
  for (const endpoint of ['http://example.org', 'https://user:pass@example.org', 'https://example.org/path', 'https://example.org/#secret']) {
    assert.throws(() => B.configure({ endpoint, token: 'x'.repeat(32) }));
  }
  const configured = B.configure({ endpoint: 'https://example.org', token: 'x'.repeat(32) });
  assert.deepEqual(configured, { configured: true });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer ' + 'x'.repeat(32));
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (options.method === 'POST') {
      assert.equal(url, 'https://example.org/handoffs');
      assert.equal(options.body, H.canonical(envelope));
    } else assert.equal(url, 'https://example.org/handoffs/' + receipt.receipt_id);
    return { ok: true, json: async () => ({ ...receipt }) };
  };
  assert.deepEqual(await B.send(envelope), receipt);
  receipt.acknowledged = true;
  assert.deepEqual(await B.status(receipt.receipt_id), receipt);
  assert.equal(calls, 2);
  for (const change of [ { envelope_sha256: 'b'.repeat(64) }, { handoff_id: 'wrong' }, { inbox_id: '' }, { acknowledged: 'yes' }, { delivery: 'queued' } ]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...receipt, ...change }) });
    await assert.rejects(B.send(envelope), /unproven/);
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...receipt, receipt_id: 'b'.repeat(64) }) });
  await assert.rejects(B.status(receipt.receipt_id), /identity mismatch/);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(B.send(envelope), /unproven/);
  assert.deepEqual(B.configure(null), { configured: false });
  await assert.rejects(B.status(receipt.receipt_id), /not configured/);
  console.log('durable inbox: authentication, binding, explicit failure and host acknowledgement passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
