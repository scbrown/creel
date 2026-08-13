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

## Two independent axes: listen vs act

- **Listen (accept commands): creel origin ONLY.** The connector is injected
  solely on creel origins (manifest `matches`), it accepts postMessages only
  from its own window AND its own origin (`event.origin === location.origin`),
  and the background worker rejects any sender whose tab isn't a creel origin.
  A foreign origin, an iframe, or another extension cannot command the bridge.
- **Act (open/drive pages): any website.** `browser_open_tab` /
  `browser_navigate` accept any http/https URL (bare hosts get `https://`),
  and DOM actions run in the target tab via `chrome.scripting`. This is why
  `host_permissions` is `<all_urls>` — the two axes are independent.

## Other safety

- **Opt-in**: without the extension installed, creel has zero cross-origin
  reach. Installing it is the deliberate grant.
- The worker **refuses to act on creel's own origins**, so an agent can't
  puppet its own harness through the bridge.
- Only http/https targets are allowed (no `file:`, `chrome:`, etc.).
