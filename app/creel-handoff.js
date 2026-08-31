/* creel — the cross-harness task/result envelope.
 *
 * This module owns representation and state, never transport. BroadcastChannel
 * may announce an envelope, but it cannot make one durable. Identity fields are
 * the shared attestation references; a tab label is not accepted as a substitute.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CreelHandoff = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const VERSION = 'crew-handoff-v1';
  const HARNESSES = new Set(['shantytown', 'creel']);
  const STATES = ['queued', 'claimed', 'succeeded', 'failed'];
  const TRANSITIONS = {
    queued: new Set(['claimed', 'failed']),
    claimed: new Set(['queued', 'succeeded', 'failed']),
    succeeded: new Set(),
    failed: new Set(),
  };
  const IDENTITY_FIELDS = ['agent', 'session', 'key_id', 'introducer', 'binding'];

  class InvalidHandoff extends Error {}

  function object(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidHandoff(`${field} must be an object`);
    return value;
  }

  function text(value, field) {
    if (typeof value !== 'string' || !value.trim()) throw new InvalidHandoff(`${field} must be a non-empty string`);
    if ([...value].some((char) => char.charCodeAt(0) < 32)) throw new InvalidHandoff(`${field} contains a control character`);
    return value;
  }

  function rejectUnknown(value, allowed, field) {
    const unknown = Object.keys(value).filter((name) => !allowed.includes(name)).sort();
    if (unknown.length) throw new InvalidHandoff(`${field} has unknown field(s): ${unknown.join(', ')}`);
  }

  function validateIdentity(value, field = 'identity') {
    const identity = object(value, field);
    rejectUnknown(identity, [...IDENTITY_FIELDS, 'harness'], field);
    const out = {};
    for (const name of IDENTITY_FIELDS) out[name] = text(identity[name], `${field}.${name}`);
    out.harness = text(identity.harness, `${field}.harness`);
    if (!HARNESSES.has(out.harness)) throw new InvalidHandoff(`${field}.harness must be one of creel, shantytown`);
    return out;
  }

  function validate(envelope) {
    const src = object(envelope, 'envelope');
    rejectUnknown(src, ['version', 'id', 'origin', 'target', 'task', 'ownership', 'state', 'result', 'failure'], 'envelope');
    if (src.version !== VERSION) throw new InvalidHandoff(`version must be '${VERSION}'`);
    const out = { version: VERSION, id: text(src.id, 'id'), origin: validateIdentity(src.origin, 'origin') };

    const target = object(src.target, 'target');
    rejectUnknown(target, ['harness', 'agent'], 'target');
    out.target = { harness: text(target.harness, 'target.harness') };
    if (!HARNESSES.has(out.target.harness)) throw new InvalidHandoff('target.harness must be one of creel, shantytown');
    if (target.agent !== undefined) out.target.agent = text(target.agent, 'target.agent');

    const task = object(src.task, 'task');
    rejectUnknown(task, ['id', 'title', 'pointer'], 'task');
    out.task = { id: text(task.id, 'task.id') };
    for (const name of ['title', 'pointer']) if (task[name] !== undefined) out.task[name] = text(task[name], `task.${name}`);

    const ownership = object(src.ownership, 'ownership');
    rejectUnknown(ownership, ['lease_id', 'owner', 'claimed_at', 'expires_at'], 'ownership');
    out.ownership = { lease_id: text(ownership.lease_id, 'ownership.lease_id') };
    out.ownership.owner = ownership.owner == null ? null : validateIdentity(ownership.owner, 'ownership.owner');
    for (const name of ['claimed_at', 'expires_at']) if (ownership[name] !== undefined) out.ownership[name] = text(ownership[name], `ownership.${name}`);

    out.state = text(src.state, 'state');
    if (!STATES.includes(out.state)) throw new InvalidHandoff(`state must be one of ${STATES.join(', ')}`);
    if (out.state === 'queued' && out.ownership.owner !== null) throw new InvalidHandoff('queued envelope cannot have an owner');
    if (out.state !== 'queued' && out.ownership.owner === null) throw new InvalidHandoff(`${out.state} envelope requires an owner`);

    if (out.state === 'succeeded') {
      const result = object(src.result, 'result');
      rejectUnknown(result, ['pointer', 'summary'], 'result');
      out.result = { pointer: text(result.pointer, 'result.pointer') };
      if (result.summary !== undefined) out.result.summary = text(result.summary, 'result.summary');
      if (src.failure !== undefined) throw new InvalidHandoff('succeeded envelope cannot have failure');
    } else if (out.state === 'failed') {
      const failure = object(src.failure, 'failure');
      rejectUnknown(failure, ['code', 'message', 'retryable'], 'failure');
      if (typeof failure.retryable !== 'boolean') throw new InvalidHandoff('failure.retryable must be a boolean');
      out.failure = {
        code: text(failure.code, 'failure.code'), message: text(failure.message, 'failure.message'), retryable: failure.retryable,
      };
      if (src.result !== undefined) throw new InvalidHandoff('failed envelope cannot have result');
    } else if (src.result !== undefined || src.failure !== undefined) {
      throw new InvalidHandoff(`${out.state} envelope cannot have result or failure`);
    }
    return out;
  }

  function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }

  function canonical(envelope) { return JSON.stringify(sorted(validate(envelope))); }

  function transition(envelope, state, changes = {}) {
    const current = validate(envelope);
    if (!TRANSITIONS[current.state].has(state)) throw new InvalidHandoff(`illegal transition ${current.state} -> ${state}`);
    const next = structuredClone(current);
    next.state = state;
    for (const name of ['ownership', 'result', 'failure']) {
      if (!Object.prototype.hasOwnProperty.call(changes, name)) continue;
      if (changes[name] == null) delete next[name]; else next[name] = changes[name];
    }
    return validate(next);
  }

  return Object.freeze({ VERSION, STATES: Object.freeze([...STATES]), InvalidHandoff, validateIdentity, validate, canonical, transition });
});
