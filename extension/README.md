# creel bridge — Chrome extension

The static creel page is CORS-bound: it cannot read or drive web pages on
other origins. This MV3 extension is the opt-in capability that lets creel
agents **control cross-origin websites** — open tabs, read pages, snapshot
what's clickable, click, fill forms, press keys, wait for content — through
the `browser` in-page tool server.

It is the outward-facing half of creel's hands. The inward-facing half — an
agent operating creel's *own* interface, in its tab or any other — is the
`ui` server, which needs no extension. See [`docs/hands.md`](../docs/hands.md).

## Architecture

```
creel page  ──postMessage──▶  creel-connector.js  ──chrome.runtime──▶  background.js
(browser-backend.js,          (content script,                        (service worker,
 'browser' MCP server)         trust boundary,                         tabs + scripting,
                               creel origins only)                     acts on real tabs)
```

- **`browser-backend.js`** (in the app) exposes the `browser` MCP server. With
  no extension it offers only `browser_status`; once the bridge answers, the
  toolset expands to whatever ops that bridge advertises.
- **`creel-connector.js`** is injected only into creel origins and relays the
  page's `creel-bridge:req` messages to the background worker. It is the trust
  boundary — the page never talks to the extension directly.
- **`background.js`** holds `tabs`/`scripting` permissions and performs each
  action via `chrome.scripting.executeScript` in the target tab's MAIN world.

### Discovery is a ping, not an announcement

The connector runs at `document_start`. `browser-backend.js` is the **last**
script tag in an 18k-line document. A design where the page must already be
listening when the extension announces itself loses that race nearly every
time — and the symptom is silent: the bridge looks uninstalled forever.

So the page **pings** (`creel-bridge:ping`) on a short backoff for ~8s after
load, and the connector answers with a hello. The connector also announces
unprompted at `document_start`, `DOMContentLoaded` and `load`, but those are
advisory; the ping is the contract. `tests/test-bridge.js` drives exactly the
hostile order — connector announcing into an empty window before the page
exists — and asserts the page still finds it.

### Version skew is negotiated

The hello carries the worker's op list (`__ops`). The page offers only tools
whose op the *installed* extension implements, so an older extension against a
newer creel yields a smaller toolset rather than a wall of `unknown op`
failures discovered mid-task. `browser_status` reports the version and ops.

## Tools (once installed)

| tool | what it does |
|---|---|
| `browser_status` | is the bridge installed, which version, which ops |
| `browser_list_tabs` | the user's open tabs (creel's own excluded) |
| `browser_open_tab` | open any site; becomes the default target for later calls |
| `browser_navigate` | point a tab at a URL |
| `browser_close_tab` | clean up when done |
| `browser_history` | back / forward / reload |
| `browser_snapshot` | **every visible control with a verified CSS selector** |
| `browser_read` | visible text of the page or a region |
| `browser_query` | elements matching a selector, each with its own selector |
| `browser_click` | click |
| `browser_fill` | fill an input/textarea/contenteditable, optionally submit |
| `browser_select_option` | choose in a `<select>`, by value or label |
| `browser_press` | press a key (Enter submits forms) |
| `browser_scroll` | top / bottom / delta / bring a selector into view |
| `browser_wait_for` | wait for a selector to appear or vanish, or for text |

`browser_snapshot` is the one that changes how well the rest work: an agent
that guesses CSS selectors fails constantly, and an agent handed labelled,
uniqueness-verified selectors does not. Call it after every navigation.

`browser_fill` writes through the prototype's `value` setter, so React and
other frameworks that patch the element's own setter actually observe the
change instead of reverting it.

Ops that miss softly in the page (selector not found, wait timed out) are
surfaced as **tool errors**, not as an `ok` result with an `error` field
inside — an agent must not be able to read a miss as a success.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` directory.
3. Open creel (https://scbrown.github.io/creel/ or your localhost). The
   `browser` server's toolset expands automatically within a second or two
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
- The worker **refuses to act on creel's own origins** — every op, not just
  the obvious ones — so an agent can't puppet its own harness through the
  bridge. Driving creel is the `ui` server's job, in-origin and visible.
  `tests/test-bridge.js` asserts this per op.
- Only http/https targets are allowed (no `file:`, `chrome:`, etc.).
- Injected code never uses `eval`/`new Function`: the MAIN world inherits the
  page's CSP, and most serious sites ban it.
