# Changelog

All notable changes land directly on `main`. Format: date, then grouped changes.

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
