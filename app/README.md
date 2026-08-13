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
  fast-forward/create branch; pushes stack), `github_open_pr`.
- `quipu-explorer.js` — visual explorer for the in-page store: a floating
  "◉ graph" button opens a full-screen overlay (Graph / SPARQL / Entity /
  Timeline / Schema) built from quipu's own UI, vendored at
  `vendor/quipu-ui/` (GraphCanvas force layout + the `<quipu-*>` web
  components, from scbrown/quipu@6cf8864). A fetch wrapper translates the
  components' REST dialect (`inpage://quipu/query|shapes|entity_history|graph`)
  into wasm tool calls, so the explorer reads the live OPFS store with zero
  network. Click a graph node for its entity view.
- `vendor/` — marked + highlight.js vendored (from npm) instead of CDN, so
  the shell is fully static/offline. Pyodide still lazy-loads from jsdelivr
  on first Python execution.
- `sw.js` — cache list updated for the vendored files.

## Running

Any static file server works:

```bash
just serve          # from the repo root
```

Then open `http://localhost:8420/onepagent.html`, set a provider
(Settings → API Endpoint + key), and add MCP tools.

## DeepSeek

**Works directly**: endpoint `https://api.deepseek.com`, your key in
Settings, done — DeepSeek serves CORS headers to browser origins (verified
live 2026-08-13). No proxy, no server.

If that ever regresses, `../proxy/` keeps two fallbacks: the Cloudflare
Worker shim (BYOK passthrough, holds no secrets) and `just proxy` for local
development. OpenRouter (`https://openrouter.ai/api/v1`) also works as a
CORS-clean route to DeepSeek models.
