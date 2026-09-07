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

## Optional durable inbox transport

`CreelDurableInbox` sends these envelopes to Shantytown's optional authenticated
inbox bridge. A trusted launcher configures the current tab using
`CreelDurableInbox.configure({endpoint, token})`, with an HTTPS bridge origin
(HTTP is accepted only on loopback). Configuration is write-only, held in memory,
and never included in fleet results. `configure(null)` clears it. Provision a new
configuration for a new session; do not place bearer secrets in model prompts.

The bridge operator binds that bearer to the complete attested Creel identity and
an explicit recipient allowlist. A tab label or a self-asserted identity cannot
create that authority. See Shantytown's `docs/inbox-bridge.md` for its configuration,
`python -m shantytown.inbox_bridge` server and persistent spool requirements.

The fleet tools provide two explicit operations:

- `fleet_handoff({envelope})`: send the immutable shared envelope. Supply an
  authorized Shantytown target agent and a short `task.pointer`. A successful
  response contains `receipt_id`, the actual `inbox_id`, `envelope_sha256`, and
  `delivery: "persisted"`. The client checks that hash against the submitted bytes.
- `fleet_handoff_status({receipt_id})`: read the host's receipt again, including
  after a tab or bridge restart. `acknowledged: true` means the recipient marked
  the inbox entry **read**, not that ownership transferred or work completed.

Save the receipt ID with the originating task outside the browser if it must be
recoverable after browser loss. The host also retains the full envelope for its
recipient. When a response is lost, retry the identical envelope and ID; changing
an already-used ID's payload is rejected. Use a new ID for a later state snapshot.
An unconfigured bridge, failed HTTP request or invalid receipt is an explicit
failure, with no fallback to browser-local messaging.

`fleet_send` remains burst-local. IndexedDB, BroadcastChannel and localStorage
provide no evidence of durable infrastructure delivery or acknowledgement.
