# creel bridge — Chrome extension

The static creel page is CORS-bound: it cannot read or drive web pages on
other origins. This MV3 extension is the opt-in capability that lets creel
agents **control cross-origin websites** — open tabs, read pages, click, fill
forms, query the DOM — through the `browser` in-page tool server.

## Architecture

```
creel page  ──postMessage──▶  creel-connector.js  ──chrome.runtime──▶  background.js
(browser-backend.js,          (content script,                        (service worker,
 'browser' MCP server)         trust boundary,                         tabs + scripting,
                               creel origins only)                     acts on real tabs)
```

- **`browser-backend.js`** (in the app) exposes the `browser` MCP server. With
  no extension it offers only `browser_status`; once the connector announces
  itself, the full toolset appears.
- **`creel-connector.js`** is injected only into creel origins and relays the
  page's `creel-bridge:req` messages to the background worker. It is the trust
  boundary — the page never talks to the extension directly.
- **`background.js`** holds `tabs`/`scripting` permissions and performs each
  action via `chrome.scripting.executeScript` in the target tab's MAIN world.

## Tools (once installed)

`browser_list_tabs`, `browser_open_tab`, `browser_navigate`, `browser_read`,
`browser_query`, `browser_click`, `browser_fill`.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` directory.
3. Open creel (https://scbrown.github.io/creel/ or your localhost). The
   `browser` server's toolset expands automatically once the bridge connects
   — verify with the `browser_status` tool.

To point the bridge at another creel origin, add it to `content_scripts.matches`
and the `CREEL_ORIGINS` list in `background.js`.

## Safety model

- The extension is **opt-in**: without it installed, creel has no cross-origin
  reach at all. Installing it is the deliberate grant.
- The background worker **refuses to act on creel's own origins**, so an agent
  cannot puppet its own harness through the bridge.
- Only the connector content script (running on a creel origin) is an accepted
  caller; messages from other senders are rejected.
- `host_permissions: <all_urls>` is broad by necessity (agents choose the
  target at runtime). Narrow it to specific origins if your use is bounded.
