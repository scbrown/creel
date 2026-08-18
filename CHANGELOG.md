# Changelog

All notable changes land directly on `main`. Format: date, then grouped changes.

## 2026-08-18 (later)

### Compaction forks a thread instead of rewriting one (creel-7xu)
Compaction spliced its summary back into the SAME conversation, so the
transcript you were reading was rewritten underneath you — the detail gone,
the thread you returned to not the thread you left, and no way back to what
was actually said.

It now forks. The summary opens a new thread; the original is left whole as
the record. The new thread carries the VFS, because `newConversation()` resets
it and a fork that loses the FILES panel loses the agent's workspace. It is
titled `continued: <parent>` so the lineage is visible in the list. A
`compaction` session entry with no prior chain already projects to the leading
"[Conversation Summary] … continue from where we left off" message, so the
forked thread needs no special case anywhere else.

An auto-compaction fires from inside the agent loop, where a run owns its DOM
and abort controller and is keyed by conversation id. That run cannot be moved
mid-turn, so an auto-compaction still compacts in place — the model needs a
smaller context *now* or the turn cannot continue — and the fork is queued and
performed in the loop's teardown once nothing is running. Settings has an
opt-out; forking is the default.


### The interface stops shouting (creel-hkl, creel-d0d, creel-ovp, creel-jpi, creel-xeg)
- **Rules first** — `docs/ui.md`. Capability is not a button; an active mode is
  always visible; a destructive action is never more prominent than its
  constructive neighbour. Spacing, type, radius and colour tokens in
  `app/harness.css` so there is something to design against.
- **Dracula**, official values, for the dark theme. Four greys carry elevation;
  each accent has a fixed meaning (orange agent, cyan human, green healthy,
  red refusal, purple interactive, yellow attention).
- **Header: 16 controls → 5.** The rest *move* into one overflow menu — same
  element, id, handler and accessible name — so any `ui_click` that worked
  before still works. A control announcing an active mode comes back out.
- **New thread** is now a header action and `Ctrl/Cmd+Shift+O`, instead of a
  small `+` three levels inside a collapsible panel.
- **`onepagent.html` → `thread.html`**, and the page is creel rather than
  OnePagent. The old path stays as a redirect that preserves the hash, because
  it is what bookmarks and installed PWAs use and `#creel-agent=<id>` is what
  makes a spawned tab a fleet worker. The button linking to the upstream fork
  is gone; the MIT attribution in the prose stays, because that is what it is.

### The streaming renderer was eating the main thread (creel-z96)
Measured: `renderMd` re-renders the whole accumulated message (117ms at 40KB,
248ms at 80KB) and the throttle re-queued it 50ms after the last render
*started*. Streaming a 167KB answer spent 2545ms on the main thread at a 58%
duty cycle. The interval now follows measured cost: 683ms, 25% duty, bounded
by construction rather than degrading with length.

## 2026-08-18

### The leave guard now protects unpushed state, not activity
Closing, reloading or navigating away already raised a prompt — but it fired
whenever the transcript held a message, which is the wrong question. A pushed
conversation is not lost by closing the tab, and a prompt that fires every
time teaches people to dismiss the one that matters. Meanwhile a tab whose
only work was settings, skills, or facts an agent wrote to the graph left
silently.

`schedulePush()` — already called from every mutation path — now stamps a
dirty marker regardless of whether S3 auto-push is configured, quipu write
tools stamp it too (the graph lives in evictable OPFS and travels only via
`state_push`), and a successful push or pull clears it. The guard compares the
two timestamps: **synchronously**, reading storage directly, because it runs
inside `beforeunload` where nothing may await and a throw silently cancels the
warning.

So it warns when a fleet task is claimed, or when state is genuinely unpushed
and there is somewhere to push it — and stays quiet when everything is saved.
With no persistence configured it keeps the old behaviour, since then nothing
*can* be pushed and the transcript really is about to be lost.

`beforeunload` can only raise the browser's own generic dialog, so the Sync
button also carries an unpushed marker and tooltip: the state is legible
before you reach for the close button, not only in the prompt after.
`state_status` and `ui_update_status` report `unpushedChanges` from the same
signal, so an agent sees exactly what would interrupt the operator.

### An update now reaches the operator and the agent (creel-vup, creel-ick)
The service-worker fix below made a pending update *detectable*; nothing
consumed the signal. Now:

- **The operator** gets a dismissible notice when a newer bundle is deployed,
  whose primary action is *Save state and reload* — the same save-first path
  the agent tool takes, so the button is not the careless option.
- **An agent** gets `ui_update_status` (am I stale? can I save?) and
  `ui_reload`. The reload saves first and **refuses** rather than quietly
  discarding work: no state repo configured means nowhere to save, and a held
  fleet lease should end through `fleet_report` rather than by the tab
  vanishing, which reads to the fleet as a crash. `force` overrides both.
- **`scope: "all"`** reloads every live creel tab over the existing cross-tab
  bus — peers first and the caller last, staggered, since reloading the tab
  driving the fan-out first would end it.

Nothing reloads on its own. A creel tab may be mid-turn or holding a task, so
that decision stays with the operator or an agent that saved first.

### The service worker could strand users on an old build (deploy staleness)
`install` did `await cache.addAll(APP_SHELL)` and called `skipWaiting()` only
afterwards. `cache.addAll` is atomic across all 71 shell URLs — including a
3.3MB wasm — so one 404, one flaky response or one timeout rejected the whole
call, failed the install, and left the **previous** worker serving its old
cache. Reloading did not help, because a reload does not evict a controlling
worker: the deploy was green, the site correct, and the browser kept showing
the old build, silently.

`skipWaiting()` now runs first, before any await, and precaching is per entry
so one unreachable asset costs that asset rather than the entire update —
everything in the shell is reachable over the network anyway. An incomplete
precache is logged instead of being indistinguishable from "no update yet".

The page half was missing too: it registered once and never called
`registration.update()`, so a long-lived tab — creel's normal mode, since the
fleet lives in tabs — never checked again, and `sw.js` listened for
`SKIP_WAITING` that nothing ever sent, so an installed worker waited forever.
It now checks on load, on returning to the tab, and hourly, and promotes a
waiting worker. It deliberately does **not** reload: creel tabs run agents, and
reloading one mid-turn discards a conversation or abandons a claimed fleet
task. It sets `window.CREEL_UPDATE_READY` and fires `creel-update-ready`
instead, which is what creel-vup and creel-ick build on.

`tests/test-sw.js` runs the app against a shell list naming a file that does
not exist, and asserts the worker takes over anyway.


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
`app/thread.html`: 19134 → 1523 lines. The harness lives in `app/harness/`
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
- Wired into `thread.html` and `justfile`.

### Fleet context isolation fix
Spawned agent/worker tabs inherit the per-origin conversation store
(IndexedDB + `localStorage.ba_active_conv`), so a fleet tab used to boot
into the operator's active conversation and `injectTask` appended the task
brief at the end of the whole orchestrator thread.
- `thread.html` — `IS_FLEET_TAB` const; `loadConvHistory` boots fleet
  tabs into a fresh conversation; `newConversation` never writes the shared
  `ba_active_conv` from a fleet tab.
- `app/creel-fleet.js` — `isolateContext()` guard at `start()` so even a
  stale harness build starts a worker tab with an empty conversation.

### Workflow policy
All work goes directly to remote `main` — no feature branches, no merge
ceremony (unless the operator says otherwise). Older branch-per-agent
leftovers were folded into `main` in this change.
