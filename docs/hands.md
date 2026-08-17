# creel's hands

*2026-08-17. Status: implemented — `app/creel-locator.js`, `app/creel-self.js`,
`app/browser-backend.js`, `extension/`. Verified by `just test` (68 assertions,
29 + 13 of them against real Chromium).*

An agent harness is defined less by what its agents can *think* than by what
they can *touch*. creel gives its agents two sets of hands, split by which side
of the origin boundary they work on — and, since 2026-08-17, one shared
vocabulary across both.

| | `ui` server | `browser` server |
|---|---|---|
| **reaches** | creel's own surfaces, in any creel tab | any cross-origin website |
| **needs** | nothing — it ships with the page | the creel bridge extension |
| **mechanism** | same-origin DOM + a `creel-ui` BroadcastChannel | `chrome.scripting` in the target tab's MAIN world |
| **locators** | `app/creel-locator.js`, in the page | the same file, injected into the far page |
| **refuses** | a tab prompting itself | acting on any creel origin |

The split is not decoration. The bridge holds `<all_urls>` and could trivially
drive creel too — it refuses, so that "an agent operated creel" always means
the in-origin, highlight-flashing `ui` path and never the privileged side
door. And the `ui` server cannot reach off-origin at all, so its authority
stops exactly where creel stops.

## Locators: Playwright's model, in the page

An agent driving a UI fails in one of two ways: it cannot *name* the thing it
wants, or it acts before the thing is ready. Playwright solved both, and
`app/creel-locator.js` is that solution small enough to live in a static page.

A locator is a plain JSON object, so it survives a tool call and the trip
across the BroadcastChannel to another tab:

```jsonc
{"ref": "e12"}                        // a handle from the last snapshot
{"role": "button", "name": "Send"}    // getByRole — the preferred form
{"label": "API key"}                  // getByLabel
{"placeholder": "Type message..."}    // getByPlaceholder
{"text": "Settings"}                  // getByText
{"testId": "send"}                    // getByTestId
{"selector": "#sendBtn"}              // the CSS escape hatch
```

plus `exact` (name matching is otherwise a trimmed, case-insensitive
substring, as Playwright's is), `nth` to disambiguate, and `timeout`.

Three properties matter more than the syntax:

- **Snapshot first.** `ui_snapshot` / `browser_snapshot` return the
  accessibility tree — role, accessible name, `[ref]`, value, checked and
  disabled state — as indented text that costs a fraction of JSON. Guessing a
  CSS selector is never necessary and rarely works.
- **Every action auto-waits.** Click, fill, type, press, hover, check and
  select all wait for the target to be visible *and* enabled before touching
  it. There is no reason for an agent to sleep. Acting on an invisible
  control is refused, because it is not something the user could have done.
- **Ambiguity is an error, not a coin flip.** A locator matching several
  elements fails with a list of the candidates and a suggestion, rather than
  silently picking the first.

### The tools

Actions (both servers, same shape): `click`, `fill`, `type`, `press`,
`hover`, `check`, `select_option`, `wait_for`, `text`, `snapshot`.

creel-specific: `ui_tabs`, `ui_describe`, `ui_open`, `ui_set_model`,
`ui_configure_provider`, `ui_toggle_server`, `ui_transcript`, `ui_prompt`,
`ui_stop`, `ui_set_credential`.

Web-specific: `browser_list_tabs`, `browser_open_tab`, `browser_navigate`,
`browser_close_tab`, `browser_history`, `browser_read`, `browser_query`,
`browser_scroll`, `browser_status`.

## Parity with the operator, across tabs

The human's advantage was never authority; it was *reach* — they can switch to
any tab and act there. So every `ui_` tool takes an optional `tab`:

```jsonc
ui_tabs()                                            // the map
ui_describe({tab: "bob1"})                           // how is that bobbin configured?
ui_transcript({tab: "bob1", limit: 20})              // what has it been doing?
ui_snapshot({tab: "bob1"})                           // what can be clicked there?
ui_click({tab: "bob1", role: "button", name: "Stop"})
ui_prompt({tab: "bob1", text: "stop at 20 links"})   // type into its chat
```

A `tab` may be a tab id, an agent/task id, a fleet label, or `"root"` for the
dispatcher. Omit it and the call runs locally. The call is carried on a
`creel-ui` BroadcastChannel to the addressed tab and executed *there*, against
that tab's own DOM, by the same implementation — so there is no registry to go
stale: a tab that does not answer is not there.

### `ui_prompt` vs `fleet_send`

Both put words into another agent's conversation, and the difference is whose
words they are. `fleet_send` prefixes `[fleet message from …]` — it is
agent-to-agent traffic, and the receiving agent knows it. `ui_prompt` is
indistinguishable from the operator typing. Use `fleet_send` to coordinate
peers; use `ui_prompt` when you are genuinely standing in for the human.

## Credentials go in, never out

The rule used to be a blanket refusal: agents could not touch a credential
field at all. That blocked the case that actually happens — the operator
pastes an API key and says "set this up" — while doing nothing about the real
risk, which is a key *leaving*.

So the rule is now an asymmetry:

- **Write is open.** `ui_fill` writes credential fields. `ui_set_credential`
  persists the active provider's API key directly, or writes a named settings
  field. Over the bridge, password inputs on foreign sites are writable too.
- **Read is closed at every exit.** Snapshots list the field but mark it
  `write-only` instead of showing a value. Action results report a character
  count, never the value. `ui_describe` reports `hasKey: true` and nothing
  more. `ui_text` and `browser_read` mask it.

Detection is structural — `input[type=password]`, plus id/name/placeholder/
aria-label matching key, token, secret, password, passphrase, credential, auth
— so it does not depend on a field being politely named. The browser tests
write three distinct secrets and then assert that no tool anywhere echoes
them, in-tab, cross-tab, and cross-origin.

This is not a sandbox, and is not claimed to be one: an agent that can read
the chat transcript can see a key the operator pasted *into the chat*. What it
cannot do is pull one back out of storage or off a form it did not just fill.

## Visible hands

Every input creel touches flashes a highlight ring: **orange for agent hands,
cyan for human hands**. Nothing an agent does to the interface is invisible,
including across tabs — a routed call flashes in the tab where it lands, not
the one that sent it.

## The bridge, and the one origin rule that matters

`browser_*` is documented in [`extension/README.md`](../extension/README.md).
Two things are worth repeating here:

- The extension **injects `creel-locator.js` as a file**, never as evaluated
  source, because the MAIN world inherits the page's CSP and most serious
  sites ban `eval`. The test fixture sets `script-src 'self'` precisely so
  that an eval-based implementation would fail there and nowhere else.
- **Which origins may command the bridge is decided by origin *including
  port*.** Chrome match patterns cannot express a port, so the manifest
  necessarily injects the connector into every `localhost` page; the real gate
  is `creelOrigins` in `background.js` (default `:8420`). A dev server on
  another port is a stranger — which is both why it cannot command the bridge
  and why the bridge is willing to drive it.

## What is still missing

- **No vision.** Snapshots give structure, not pixels; a page whose meaning is
  in its layout is opaque. Tool results are text-only in the vendored harness,
  so a screenshot op would have nowhere to land (`creel-hty`).
- **No drag, no file pickers, no iframe traversal** in either set of hands.
- **`ui_snapshot` does not cross shadow roots.** creel does not use them
  today, so this is a latent gap rather than a current one.
