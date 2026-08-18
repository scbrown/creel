# Changelog

All notable changes land directly on `main`. Format: date, then grouped changes.

## 2026-08-18

### Fleet leasing has a test, and it found a bug (creel-psr)
`tests/test-fleet.js` opens real tabs and lets them race — real Web Locks,
real IndexedDB, real BroadcastChannel, only `handleSend` stubbed. It pins
claim exclusivity, death-releases-lease with the survivor picking it up,
heartbeat-stale requeue while the lock is still held, drain, and the work log.

On its first run it found that the task store's `tx()` helper resolved a
**missing** `get` to the `IDBRequest` object instead of `undefined`, so every
`(await getTask(id)) || {default}` skipped its fallback. The fleet work log
was the casualty: its record could never be created, and `fleet_digest` had
never returned a single entry — silently, because each failure was an
unawaited rejection.

### The oversized modules are split (creel-hun)
`creel-self.js` (805) → `creel-self.js` 301 + `creel-ui-tools.js` 423 +
`creel-world-model.js` 155. `creel-fleet.js` (1150) → 562 +
`creel-fleet-tools.js` 422 + `creel-fleet-dashboard.js` 207 +
`creel-fleet-log.js` 82. No file in `app/` now exceeds 600 lines.

Unlike the harness split, these were IIFEs, so this is a restructure rather
than a move: each group shares one documented internal namespace
(`CreelSelfInternal`, `CreelFleetInternal`) instead of dropping ~40 names into
the global scope. What deliberately does *not* cross the fleet seam is the
lease state — `currentLeaseTaskId` and its lock resolver only stay in
agreement if one place changes them, so the seam carries `heldLease()` and
`releaseLease()` and the variables stay in the claim loop.

## 2026-08-17 (later)

### Python disabled behind a feature flag (creel-yon)
`app/creel-features.js` holds `CREEL_FEATURES`, read before the harness so tool
lists and the system prompt are composed from it rather than patched after.
With `python: false` (the default) PythonExec / VfsToPyodide / PyodideToVfs
leave the tool list, an invented call is refused with the alternatives named,
`ensurePyodide` throws before injecting a loader, and no CDN is touched.
Nothing is deleted — `#creel-features={"python":true}` restores all of it.

### State persistence to a private GitHub repo (creel-3ru, creel-hk3)
`app/state-backend.js` adds a GitHub transport at a new seam (`_syncBackend`)
in the existing v2 sync engine, so the state repo reuses the manifest /
content-addressed objects / blobs design instead of duplicating it. One push
is one commit via the Git Data API. The repo must be private, re-checked every
push. Keys travel only on an explicit opt-in **and** a passphrase; a pull never
overwrites a local key. The quipu `.db` syncs as a manifest-named blob.
Configurable in Settings → State Repo and over MCP (`state_configure`,
`state_push`, `state_pull`, `state_status`). Layout specified in
[creel-state](https://github.com/scbrown/creel-state).

### Per-tab state slices and graph attribution (creel-age)
`state_push {scope: "agent"}` writes under `state/agents/<id>/`, a sibling of
the shared tree, so two tabs hold divergent state without clobbering each
other. The graph stays shared — a fleet that cannot see what its agents
learned is not worth running — and gains attribution instead: each tab stamps
`group_id: agent:<id>` on episodes that do not name one, while reads stay
fleet-wide.

### The 16.7k-line inline script is 26 ordered parts (creel-yny)
`app/onepagent.html`: 19134 → 1523 lines. The harness lives in `app/harness/`
as classic scripts sharing one global scope; the stylesheet is
`app/harness.css`. Cuts were made only at banner comments, each part verified
to parse alone, and the set verified to concatenate back byte for byte.
`just check` now parses the page's inline blocks (`tools/check-html.js`) and
`tools/check-shell.js` fails the gate when a part is missing from the service
worker or loaded out of order.

### A calm default panel (creel-ban)
The left panel shows four sections instead of eleven; the rest are hidden with
the `hidden` attribute — out of the accessibility tree too, so an agent's
snapshot matches what the operator sees — and listed as chips that reveal them
in one click. Settings' ten groups are collapsed `<details>`, remembered per
group.

### System prompt rewritten for the live surface (creel-l3k)
500 words (was 508) covering more: every tool family including `state_*`, the
durability rule (three doors: `github_push`, `state_push`, a quipu fact), and
the credential asymmetry. World model bumped to `creel-world-model-v4`.

### Gate repairs
`just test-unit` was red on `main` before any of this. `tests/test-beads.js`
asserted P1 was invalid when the store accepts 1..3; `tools/bd.js` derived
issue ids from the checkout directory name instead of `.beads/metadata.json`;
`extension/background.js` sorted the origins list on some paths and not
others, so a caller comparing `origins` to `defaults` saw a difference that
was only ordering.

## 2026-08-17

### Bead-compatible issue API inside the harness (creel-9wn)
- `app/beads-store.js` — shared store module (VFS adapter, validation, priorities).
- `app/beads-backend.js` — in-page MCP server `inpage:bd`
  (`bd_ready` / `bd_list` / `bd_show` / `bd_create` / `bd_update` / `bd_close`).
- `tools/bd.js` — Node CLI mirror of the in-page API.
- `tests/test-beads.js` — lifecycle + validation tests.
- Wired into `onepagent.html` and `justfile`.

### Fleet context isolation fix
Spawned agent/worker tabs inherit the per-origin conversation store
(IndexedDB + `localStorage.ba_active_conv`), so a fleet tab used to boot
into the operator's active conversation and `injectTask` appended the task
brief at the end of the whole orchestrator thread.
- `onepagent.html` — `IS_FLEET_TAB` const; `loadConvHistory` boots fleet
  tabs into a fresh conversation; `newConversation` never writes the shared
  `ba_active_conv` from a fleet tab.
- `app/creel-fleet.js` — `isolateContext()` guard at `start()` so even a
  stale harness build starts a worker tab with an empty conversation.

### Workflow policy
All work goes directly to remote `main` — no feature branches, no merge
ceremony (unless the operator says otherwise). Older branch-per-agent
leftovers were folded into `main` in this change.
