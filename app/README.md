# creel v0 harness

The v0 ("one tab, many loops") harness is a vendored fork of
[OnePagent](https://github.com/sligter/OnePagent) — a single-file, fully
client-side agent workbench (MIT, © OnePagent contributors), vendored at
upstream commit `ec77e556137e414b9d0a1430c36ea1a8baa8ae76` (2026-08-13).
It already provides the parts v0 needs: the agentic tool-call loop, an MCP
client (streamable HTTP + SSE), Pyodide execution, sub-agent/swarm fanout,
and BYO-key storage in localStorage.

## creel modifications

- `quipu-backend.js` — the quipu transport switch. Adds an `inpage` MCP
  server type dispatching to an in-page provider, and boots
  `quipu-worker.js`, a dedicated worker hosting **quipu compiled to wasm32**
  (`wasm/pkg/`, built from `../wasm/quipu-provider/`). All 37 quipu tools —
  schemas straight from quipu's `tool_definitions()` — run in the page with
  zero network; the store lives on OPFS (falls back to memory where OPFS is
  unavailable), and `CreelQuipu.exportDb()`/`importDb()` move `.db` bytes in
  and out. If the wasm bundle is missing the server degrades to a
  `quipu_wasm_status` reporter. Bobbin's MCP server remains the network
  alternative (TOOLS → + MCP → `streamable_http`,
  `http://localhost:3031/mcp` with `bobbin serve --mcp-http`).
  Rebuild: `cd wasm/quipu-provider && cargo build --release && wasm-bindgen
  --target web --out-dir ../../app/wasm/pkg target/wasm32-unknown-unknown/release/creel_quipu_provider.wasm`.
- `github-backend.js` — a second in-page MCP server (`github`) that checks
  repositories out into the FILES panel and pushes the agent's edits back,
  entirely over the CORS-enabled GitHub REST/Git Data API — no git binary,
  no smart-HTTP proxy. Auth is a fine-grained PAT (Contents read/write on
  the repos you choose), entered via a browser prompt so it never passes
  through chat, held in localStorage. Tools: `github_connect`,
  `github_status` (diffs the VFS against checked-out blob sha1s),
  `github_checkout`, `github_push` (blobs → tree on base_tree → commit →
  fast-forward/create branch; pushes stack), `github_open_pr`,
  `github_branches`, and `github_merge`. **Per-agent workspaces**: the
  checkout state lives in per-tab `sessionStorage` (the token stays shared
  in localStorage), so fleet agents editing the same repo keep independent
  diff baselines — no clobbering. At burst end `github_merge` integrates
  each agent's branch into a base via GitHub's server-side three-way merge,
  reporting any conflicting branch explicitly (nothing is force-merged).
- `quipu-explorer.js` — visual explorer for the in-page store: a floating
  "◉ graph" button opens a full-screen overlay (Graph / SPARQL / Entity /
  Timeline / Schema) built from quipu's own UI, vendored at
  `vendor/quipu-ui/` (GraphCanvas force layout + the `<quipu-*>` web
  components, from scbrown/quipu@6cf8864). A fetch wrapper translates the
  components' REST dialect (`inpage://quipu/query|shapes|entity_history|graph`)
  into wasm tool calls, so the explorer reads the live OPFS store with zero
  network. Click a graph node for its entity view.
- `creel-fleet.js` — fleet mode (VISION v1, first cut): agents as browser
  tabs. `fleet_spawn` opens each agent in its own tab
  (`#creel-agent=<id>`), which inherits the operator's key/model/MCP
  servers via same-origin localStorage, injects its task, and runs. The
  platform does the scheduling: IndexedDB task queue, Web Locks liveness
  (a dead tab's lock releases → status `dead`), BroadcastChannel fleet
  bus. Completion is agent-driven via `fleet_report`; `fleet_status` /
  `fleet_abort` / `fleet_clear` round it out, and the 🧺 fleet button
  opens a dashboard (live agent list, results, manual spawn — also the
  user-gesture path when the popup blocker holds agent-initiated spawns;
  or allow popups for this origin once). **Device-aware caps**
  (`creel-device.js`): concurrent agent tabs are capped by device class —
  3 on phones, 4 on tablets, 8 on desktop (`maxConcurrent` overrides
  1..24) — because mobile browsers evict background tabs; spawns beyond
  the cap stay queued until a slot frees, `fleet_spawn` reports the cap
  in its result, `fleet_device` reports it on demand, and the dashboard
  shows a live `📱 mobile · 2/3 tabs` chip that flips amber at the cap.
  **The main tab sees every fleet event**: each task transition
  (claimed / done / failed / requeued / aborted) is appended to a shared
  work log (`meta:digest`), and the main tab's agent automatically
  receives a batched 🧺 FLEET DIGEST message in its conversation — plus
  `fleet_digest` returns the full log and `fleet_status` rows carry the
  task text and heartbeat age, so no burst work is invisible to the
  operator's agent.
  **The fleet shares one brain**:
  Web Locks elect a leader tab whose dedicated worker owns the single
  OPFS quipu store (sync access handles don't exist in SharedWorkers);
  every other tab RPCs to it over BroadcastChannel — an episode written
  in any tab is instantly queryable in all of them, and if the leader
  tab dies the next tab takes the lock and re-opens the same OPFS bytes.
  `quipu_wasm_status` shows the role (`fleet-host` / `fleet-client`).
  **Cross-tab comms**: `fleet_send({to, message})` delivers into the target
  agent's conversation (as mid-run guidance its LLM sees at the next loop
  step — task id, label, or `"dashboard"` as address); `fleet_send`
  without `to` broadcasts to every tab's inbox only (`fleet_inbox` reads
  it) — the asymmetry keeps agent pairs from auto-injection ping-pong.
  Messages always land in the inbox as well, so nothing is lost if the
  target is between runs; the dashboard shows a live comms log.
  **The weft** (burst synthesis, VISION v3): `fleet_synthesize` gathers
  every finished result into one payload; the dashboard's **Synthesize**
  button hands them to the operator's own agent to combine across the
  parallel threads; `fleet_writeback` records the takeaways as quipu
  episodes tagged to a Burst node, so what a burst learned outlives its
  tabs and appears in the ◉ graph.
- `creel-self.js` — the self-model. (a) **Root pane**: exactly one
  dispatcher tab, Web-Lock elected among non-agent tabs, takeover on
  death; every tab wears a role badge (⬢ root pane / 🧵 bobbin /
  standby). (b) **The world model lives in quipu**: the root pane seeds a
  versioned `creel-world-model-v1` episode describing roles, servers,
  surfaces, and conventions — agents learn their world by querying the
  graph (`quipu_cord {"name": "creel-world-model-v1"}`), which is how
  creel documents itself for agents. (c) **Self-configuration**: the `ui`
  in-page MCP server (ui_describe / ui_set_model / ui_configure_provider /
  ui_toggle_server / ui_open / ui_click / ui_fill) lets the agent operate
  creel's own interface from user demands — credential fields are refused
  by design. (d) **Visible hands**: every click and input flashes a
  highlight ring — cyan for the human, orange for the agent.
- `browser-backend.js` — the `browser` MCP server: drive cross-origin web
  pages (list/open tabs, navigate, read, query, click, fill) via the
  companion **creel bridge** Chrome extension (`../extension/`, MV3). The
  static page is CORS-bound and can't reach other origins; the extension's
  background worker can, and this server relays to it over postMessage
  through a content-script trust boundary. Without the extension the server
  offers only `browser_status` (graceful degradation); the extension refuses
  to act on creel's own origins so an agent can't puppet its harness.
- `measurement-backend.js` — the `bench` MCP server: VISION v2's bet made
  testable. A grounding-sensitive task suite (the synthetic "Kestrel" service
  fleet, whose entities exist only in the seed) run three ways —
  ungrounded-cheap / grounded-cheap / frontier — with `bench_seed` (load the
  graph), `bench_tasks` (enqueue as a burst), `bench_grade` (objective
  scoring), `bench_record` + `bench_report` (success rate and cost per
  completed task). Only the LLM calls cost tokens; seed/grade/cost-math are
  free and verified. Protocol: `../docs/measurement.md`.
- `vendor/` — marked + highlight.js vendored (from npm) instead of CDN, so
  the shell is fully static/offline. Pyodide still lazy-loads from jsdelivr
  on first Python execution.
- `sw.js` — cache list updated for the vendored files.

## Running

Any static file server works:

```bash
just serve          # from the repo root
```

Then open `http://localhost:8420/thread.html`, set a provider
(Settings → API Endpoint + key), and add MCP tools.

## DeepSeek

**Works directly**: endpoint `https://api.deepseek.com`, your key in
Settings, done — DeepSeek serves CORS headers to browser origins (verified
live 2026-08-13). No proxy, no server.

If that ever regresses, `../proxy/` keeps two fallbacks: the Cloudflare
Worker shim (BYOK passthrough, holds no secrets) and `just proxy` for local
development. OpenRouter (`https://openrouter.ai/api/v1`) also works as a
CORS-clean route to DeepSeek models.
