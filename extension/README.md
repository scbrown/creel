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

### Injection is by file, never by eval

The locator engine is installed with `chrome.scripting.executeScript({files})`.
It is never shipped as source and evaluated in the page, because the MAIN
world inherits the page's **CSP** and most serious sites forbid `eval`. The
test fixture (`tests/fixtures/site.html`) sets `script-src 'self'` for exactly
this reason: an eval-based implementation passes every other test and fails on
any real website.

### Version skew is negotiated

The hello carries the worker's op list (`__ops`). The page offers only tools
whose op the *installed* extension implements, so an older extension against a
newer creel yields a smaller toolset rather than a wall of `unknown op`
failures discovered mid-task. `browser_status` reports the version and ops.

## Tools (once installed)

The action tools speak **the same locator vocabulary as creel's own `ui_`
tools**, because the bridge injects the very same engine
(`creel-locator.js`, kept byte-identical to `app/`'s copy by `just check`)
into the target page. One mental model drives a creel tab and a stranger's
website alike: snapshot, then act by `{ref}` or `{role, name}`.

| tool | what it does |
|---|---|
| `browser_status` | is the bridge installed, which version, which ops |
| `browser_snapshot` | **the page's accessibility tree with [ref] handles** |
| `browser_click` / `fill` / `type` / `press` | act on a control; all auto-wait |
| `browser_hover` / `check` / `select_option` | menus, checkboxes, dropdowns |
| `browser_attach_file` | attach files to an `<input type="file">` via a real `DataTransfer` in the page — the change handler sees genuine `File` objects, indistinguishable from a user's picker |
| `browser_wait_for` | wait for visible / hidden / attached / detached / enabled |
| `browser_text` | read one located region |
| `browser_list_tabs` | the user's open tabs (creel's own excluded) |
| `browser_open_tab` | open any site; becomes the default target |
| `browser_navigate` / `close_tab` / `history` | move around, clean up |
| `browser_read` / `query` / `scroll` | bulk text, CSS escape hatch, scrolling |

The locator engine also walks structures a naive crawler misses, using the
same vocabulary everywhere: **shadow roots** (open ones — as shipped by real
frameworks) and **same-origin iframes** are pierced during snapshotting,
locator resolution, and action — `snapshot`, `queryAll`, `actionable`, the
whole family. A control inside a widget's shadow tree or inside the site's own
iframe is located and acted on exactly like a top-level element. Cross-origin
iframes stay opaque (the platform enforces that); `browser_text`/`snapshot`
report them by frame only.

Three properties carry most of the value:

- **Snapshot instead of guessing.** An agent handed roles and accessible
  names succeeds where one guessing at CSS fails constantly.
- **Auto-waiting.** Every action waits for its target to be visible and
  enabled, so a click after a navigation needs no sleep. Acting on an
  invisible control is refused — it is not something a user could have done.
- **Ambiguity errors.** A locator matching several elements fails with the
  candidates listed, rather than silently picking one.

`browser_fill` writes through the prototype's `value` setter, so React and
friends observe the change instead of reverting it. Password fields are
writable — an operator may need an agent to enter one — but no read path
returns their value.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` directory.
3. Open creel (https://scbrown.github.io/creel/ or your localhost). The
   `browser` server's toolset expands automatically within a second or two
   — verify with the `browser_status` tool.

### Running creel on a different origin or port

Chrome match patterns **cannot express a port**, so `content_scripts.matches`
necessarily injects the connector into *every* `localhost` page. The real gate
is therefore the port-aware check in `background.js`, whose default is:

```
https://scbrown.github.io/creel   ·   http://localhost:8420   ·   http://127.0.0.1:8420
```

For any other deployment, set it at runtime — this is the supported path, and
what the tests themselves use:

```js
chrome.storage.local.set({ creelOrigins: ['http://localhost:1234'] })
```

Or use the **popup** (click the extension's toolbar icon): it lists the
current origins, adds new ones, and resets to the defaults — no console needed.
The popup can only *manage the boundary*; it has no path to command a tab.
Every entry is normalized to an exact origin (scheme + host + port) before it
is persisted, the same normalization the boundary itself applies.

Getting this wrong in the permissive direction is the interesting failure: a
port-blind check makes every dev server on `localhost` *both* undriveable by
the bridge *and* able to command it.

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
- **Origin checks include the port.** See "Running creel on a different origin
  or port" above; this is what keeps an unrelated `localhost` page from
  commanding the bridge.
- Only http/https targets are allowed (no `file:`, `chrome:`, etc.).
- Injected code never uses `eval`/`new Function`, and the engine arrives as a
  file, so a page's CSP neither blocks the bridge nor is weakened by it.

## Tests

`tests/test-bridge.js` covers the handshake and the guards against stubs.
`tests/test-bridge-browser.js` loads **this extension into real headless
Chromium**, serves creel and a CSP-strict fixture site on two different ports,
and drives the fixture end to end — proving the extension loads, the connector
reaches the worker, the engine installs under a strict CSP, and a password
written into the far page cannot be read back. Run both with `just test`, or
just the browser ones with `just test-ui`.
