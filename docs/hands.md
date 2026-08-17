# creel's hands

*2026-08-17. Status: implemented — `app/creel-self.js`, `app/browser-backend.js`,
`extension/`. Verified by `just test`.*

An agent harness is defined less by what its agents can *think* than by what
they can *touch*. creel gives its agents two sets of hands, deliberately
separated by which side of the origin boundary they work on.

| | `ui` server | `browser` server |
|---|---|---|
| **reaches** | creel's own surfaces, in any creel tab | any cross-origin website |
| **needs** | nothing — it ships with the page | the creel bridge extension |
| **mechanism** | same-origin DOM + a `creel-ui` BroadcastChannel | `chrome.scripting` in the target tab's MAIN world |
| **refuses** | credential fields; a tab prompting itself | acting on any creel origin |

The split is not decoration. The bridge holds `<all_urls>` and could trivially
drive creel too — it refuses, so that "an agent operated creel" always means
the in-origin, highlight-flashing `ui` path and never the privileged side
door. And the `ui` server cannot reach off-origin at all, so its authority
stops exactly where creel stops.

## The claim: parity with the operator

The goal for `ui` is a specific one — **an agent should be able to do
anything the human sitting at the browser could do**. The human's advantage
was never authority; it was *reach*: they can switch to any tab and act
there. So every `ui_` tool takes an optional `tab`:

```jsonc
ui_tabs()                                   // the map: tab ids, roles, models, who's running
ui_describe({tab: "bob1"})                  // what is that bobbin configured as?
ui_transcript({tab: "bob1", limit: 20})     // what has it been doing?
ui_prompt({tab: "bob1", text: "stop at 20 links"})   // type into its chat, as the operator would
ui_stop({tab: "bob1"})                      // its stop button
```

A `tab` may be a tab id, an agent/task id, a fleet label, or `"root"` for the
dispatcher. Omit it and the call runs locally. Under the hood the call is
carried on a `creel-ui` BroadcastChannel to the addressed tab, executed there
against *that tab's* DOM by the same implementation, and answered — so there
is no registry to go stale: a tab that does not answer is not there.

### The tools

- `ui_tabs` — every live creel tab: id, role, agent id, label, title, model,
  whether it's mid-run.
- `ui_describe` — a tab's role, provider endpoint, model, tool servers and
  their enabled state, open panels, run state.
- `ui_snapshot` — a tab's interactive controls, each with a **uniqueness-
  verified CSS selector**. Call this instead of guessing selectors.
- `ui_set_model`, `ui_configure_provider`, `ui_toggle_server` — reconfigure a
  tab: model, endpoint, which tool servers are on.
- `ui_open` — open the graph explorer, fleet dashboard, or settings.
- `ui_transcript` — read a tab's recent chat.
- `ui_prompt` — type into a tab's chat box and send. The harness routes it as
  a new turn when that tab is idle and as non-interrupting guidance when it is
  mid-run, which is precisely what a human typing gets.
- `ui_stop` — stop a tab's run.
- `ui_click`, `ui_fill` — anything the above doesn't name.

### `ui_prompt` vs `fleet_send`

Both put words into another agent's conversation, and the difference is
whose words they are. `fleet_send` prefixes `[fleet message from …]` — it is
agent-to-agent traffic, and the receiving agent knows it. `ui_prompt` is
indistinguishable from the operator typing. Use `fleet_send` to coordinate
peers; use `ui_prompt` when you are genuinely standing in for the human —
redirecting a bobbin that has gone wrong, or handing it a new task.

### The two refusals

Parity with the operator is the goal, not a slogan, so where it stops is
stated rather than left to be discovered:

1. **API-key fields are never fillable by an agent** — `ui_fill` refuses any
   input whose id, name, or placeholder looks like a credential, in the local
   tab and in a remote one, and `ui_snapshot` masks their values rather than
   echoing them. The operator sets keys in Settings, by hand.
2. **A tab cannot prompt itself.** `ui_prompt` without `tab` (or aimed at
   your own tab id) is refused. Self-prompting is a token-burning loop, not a
   capability.

Neither is a sandbox — an agent that can `ui_click` can reach a great deal —
and neither is claimed to be one. They are the two cases where the obvious
capability is a footgun rather than a power.

### Visible hands

Every input creel touches flashes a highlight ring: **orange for agent hands,
cyan for human hands**. Nothing an agent does to the interface is invisible,
including across tabs — a routed call flashes in the tab where it lands, not
the one that sent it. That is the honest version of "the agent can do what
you can": it can, and you can watch it.

## The web hands

`browser_*` is documented in [`extension/README.md`](../extension/README.md).
The short version: install the bridge and an agent gets `browser_snapshot` →
`browser_click` / `browser_fill` / `browser_press` / `browser_wait_for` over
any website, with the whole surface degrading to a single `browser_status`
tool when the extension is absent. Nothing in the served bundle can reach
another origin; installing the extension *is* the grant.

## What is still missing

- **No vision.** `browser_snapshot` gives structure, not pixels; a page whose
  meaning is in its layout is opaque. Tool results are text-only in the
  vendored harness, so a screenshot op would have nowhere to land.
- **No `ui_spawn`.** Creating tabs is `fleet_spawn`'s job, and it is still
  subject to the popup blocker outside a user gesture.
- **No cross-window drag, hover, or file-picker interaction** in either set of
  hands.
