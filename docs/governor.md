# The budget governor

*What the provider's budget and this device's tab cap, together, will admit.*

Creel caps concurrent agent tabs by device class — 3 on a phone, 4 on a tablet,
8 on desktop — because mobile browsers evict background tabs. That is one of the
two walls a burst hits. The other is the provider's usage window, and until
`aegis-edp2n.3` creel could not see it at all: a key 96% through its weekly
budget and a phone that can hold three tabs are different reasons not to spawn,
and only one of them was being checked.

The governor composes both into one verdict.

```
fleet_governor  →  { verdict: "admit" | "refuse" | "unknown", ... }
```

## Setpoint advisory

The tier governor is a brake. `creel-setpoint.js` adds the other half: a
source-attributed PID-like advisory that compares actual utilisation with the
trajectory needed to reach a target at reset. It is wired through
`resolveCaps()`, so `fleet_governor`, `fleet_device`, every spawn path, and the
dashboard consume the same recommendation under `controller`.

The repository declaration currently names `codex_app_server`, targets 100%
through the declared 2026-09-01 reset, and automatically returns to a steady
90% target afterward. Its `maxAgents: 9` is an outer fence; the device cap,
provider tiers, and provider drain can only tighten it. The controller never
raises any of those limits and never changes `admission.free`.

`fleet_governor` accepts a replacement `setpoint` declaration. A
source-attributed reading supplies `pct`, `window`, `resetAt`, and `source`:

```js
fleet_governor({
  window: 'seven_day',
  pct: 19,
  resetAt: 1788303600,
  source: 'codex_app_server',
})
```

Recommendations use contract `creel.setpoint/1`, persist their I/D state, and
log only when the recommendation changes. Re-reading one provider sample does
not advance the integrator: dashboard refresh frequency is not a control input.
Signal loss, lower-bound-only readings, burndown, the device cap, `max_agents`,
and provider drain all freeze or clamp growth with the reason carried in the
record.

That record is the same object for all three readers — the operator (the 🧺
dashboard), agents (`fleet_governor`, and every `fleet_*` refusal), and anything
outside the browser (`tools/creel-admission.js`). One contract, three readers: a
governor whose operator view and agent view can disagree is worse than none.

## Two answers, not one

| field | question it answers |
|---|---|
| `verdict` | what is TRUE about the budget — `admit`, `refuse`, `unknown` |
| `enforced` | what creel DOES about it — `allow`, `block` |

They differ in exactly one situation: the signal is lost and `onSignalLost` is
`warn` (the default). The honest answer is *I cannot tell*; the applied
consequence is *run anyway, loudly*, because no probe failure may be able to
stop a fleet. A single field would have to lie about one of them, and which one
a caller wants is not the same for a dashboard, an agent, and a preflight gate.

## Declaring a budget

**The governor is inert until you declare one.** With no policy it admits on the
device cap alone and says so (`governed: false`) — it does not alarm. A default
policy with example tiers would put every fresh install into SIGNAL LOST on its
first pass, and an alarm that fires on a clean install is an alarm people learn
to close.

```js
fleet_governor({ policy: {
  windows: {
    five_hour: { tiers: [{ at: 50, maxTabs: 4 }, { at: 70, maxTabs: 2 }, { at: 95, drain: true }] },
    seven_day: { tiers: [{ at: 45, maxTabs: 4 }, { at: 65, maxTabs: 1 }, { at: 90, drain: true }] },
  },
  onSignalLost: 'warn',        // 'freeze' to block while blind
  tokenBudgets: {},            // {window: tokens} — a denominator for the local ledger
  ledgerExclusive: false,      // see "the ledger is a lower bound"
}})
```

A tier is a threshold on **one** window plus what holds while it is engaged:
`maxTabs`, or `drain: true` for the full stop. The two budgets exhaust
independently and refill days apart, so they are governed separately and the
**strictest engaged tier wins** — never an average, which would let a fresh
five-hour reading mask an exhausted week.

Malformed policy is refused with the offending key named. A governor that
silently drops a bad tier governs less than you think it does, and that failure
has no symptom until it matters.

## Where the numbers come from

Three sources, most authoritative first. A window with no source at all is
**signal lost**, never zero — *we cannot see the budget* must not become *the
budget is empty*.

| source | what it is | caveat |
|---|---|---|
| `headers` | the provider's own `*-ratelimit-*` response headers, read on every model call | only if the endpoint lists them in `Access-Control-Expose-Headers`; when it does not, that absence is recorded as a named error, not as silence |
| `manual` | a reading you typed after looking at your console | ages out like any other |
| `ledger` | creel counting its own token spend against `tokenBudgets` | **a lower bound** — see below |

A reading older than `maxAgeS` (default 900s) is SIGNAL LOST, not a number. The
last percentage of a dead probe reads green forever, which holds a spending
fleet wide open at a figure from last week.

### The ledger is a lower bound, never a measurement

Creel can count what creel spent. It cannot see the same key used by a CLI, a
second browser profile, or a colleague. So a ledger reading of 20% is entirely
consistent with the provider being at 95%.

That gives it an asymmetric authority, and the governor enforces it:

- **above a threshold it may refuse** — a lower bound above a wall is still
  above it;
- **below every threshold it may not admit** — the window reports
  `lowerBoundOnly` and the verdict is `unknown`.

`ledgerExclusive: true` promotes it to a measurement. Only the person holding
the key can know that, which is why it is a declaration and not a heuristic.

## What a refusal governs — and what it never touches

A refusal governs **new agent tabs**. Nothing else.

`fleet_drain`, `fleet_report`, `state_push` and `github_push` are never
governed, under any verdict, including a full provider drain. Getting finished
work out costs the budget nothing, and the running tabs hold the only copy of
what they have done — a budget guard that stranded them would be a work-loss
event wearing a safety costume. Refused tasks stay **queued**, launchable from
the dashboard once slots free; they are not discarded.

## Reading a refusal

Every refusal names the wall it hit, because the two have different remedies:

```
✕ REFUSE — provider budget throttled to 1 tab, 1 already running
           — at most 1 agent tab [seven_day >= 65%]        ← wait, or raise the budget
✕ REFUSE — at the 3-tab mobile cap with 3 running          ← close a tab
```

`admission.capSource` says the same thing in a field: `device-cap`,
`provider-tier`, or `provider-drain`. "No free slots" when the week is spent
sends an operator to close tabs that are not the problem.

## Preflighting from outside the browser

`tools/creel-admission.js` is the probe CABOODLE runs before installing or
launching creel (requested on `aegis-7k8xn.4`). It prints the same record and
exits on it:

| exit | meaning |
|---|---|
| 0 | `admit` |
| 1 | `refuse` — a **policy** decision |
| 2 | `unknown` — an **instrument** decision: signal missing, stale, or a lower bound |
| 3 | the probe could not run — bad flags, unreadable policy |

1 and 2 are separate on purpose: *the budget is spent* and *I cannot see the
budget* call for opposite responses from an installer. 3 is separate again,
because a typo in a config file must not read as an exhausted account.

```bash
node tools/creel-admission.js --policy creel-governor.json --pct five_hour=72
node tools/creel-admission.js --state exported.json --want 4 --quiet
```

It evaluates a policy against the evidence it is **given** — it does not talk to
a provider and cannot read a browser's storage. So there are two ways to get
`admit` out of it and they are not the same fact: a declared budget reading
healthy, and no declared budget at all. The record separates them with
`governed`; a shell gate that reads only the exit code should pass
`--require-governed`, which turns the second case into 2.

stdout is the JSON record alone under every outcome, so `| jq` always works; the
human line goes to stderr.

## Tests

| file | subject |
|---|---|
| `tests/test-governor.js` | the policy — composition, signal loss, hysteresis, the lower bound, header parsing |
| `tests/test-admission-probe.js` | the probe's exit-code contract, as real subprocesses |
| `tests/test-governor-browser.js` | the **wiring**, in real Chromium |

The third is not redundant. A governor that is correct and not connected refuses
nothing, and that is a failure with no symptom: every unit test green, every
spawn ungoverned. It asserts that `creel-governor.js` loads in the right order,
that `resolveCaps` composes both walls so every spawn path is governed by
construction rather than by remembering, that a budget actually stops a
`fleet_spawn`, that draining survives a drain, and that the dashboard caption is
the same string the agent's verdict carries.
