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

DeepSeek's API sends no CORS headers, so a direct browser call fails. Use
one of:

1. **Worker shim** — deploy `../proxy/deepseek-cors-worker.js` (Cloudflare
   Worker); set the worker URL as the API Endpoint, keep your key in the
   browser (BYOK passthrough — the worker holds no secrets).
2. **OpenRouter** — endpoint `https://openrouter.ai/api/v1` with a DeepSeek
   model; OpenRouter sends CORS headers, no shim needed.
3. **Local proxy** — `just proxy` runs the same shim shape locally for
   development.
