# Cross-harness handoff envelope

`window.CreelHandoff` (and `require('../app/creel-handoff.js')` in tests) defines the
versioned task/result value shared with Shantytown. The module validates, transitions,
and canonically serializes values. It does not transport or persist them.

That boundary matters in a browser: `BroadcastChannel` can wake another live tab, and
IndexedDB can retain local state, but neither is a durable cross-harness acknowledgement.
A durable bridge may carry the same envelope later without changing its meaning.

Version `crew-handoff-v1` carries:

- `origin`: `harness`, `agent`, `session`, `key_id`, `introducer`, and `binding` from
  the shared attestation contract;
- `target`: a harness plus an optional agent routing hint;
- `task`: stable task identity with optional title and pointer;
- `ownership`: a lease ID and complete attested owner for every non-queued state;
- `state`: `queued`, `claimed`, `succeeded`, or `failed`;
- terminal evidence: a required result pointer on success, or structured
  code/message/retryable fields on failure.

```js
const queued = CreelHandoff.validate(receivedValue);
const claimed = CreelHandoff.transition(queued, 'claimed', {
  ownership: { lease_id: queued.ownership.lease_id, owner: attestedTabIdentity },
});
const wireText = CreelHandoff.canonical(claimed);
```

Never derive `agent`, `session`, `key_id`, `introducer`, or `binding` from a tab label,
URL fragment, message body, or browser-channel sender. Those are routing/liveness
signals, not authentication. Missing attestation must remain missing rather than being
rendered as a successful owner claim.
