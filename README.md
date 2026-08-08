<h1 align="center">creel</h1>

<p align="center">
  <em>🧺 Parallel agent bursts, entirely in the browser</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/status-vision-8C98A8.svg" alt="Status: vision"/>
  <img src="https://img.shields.io/badge/server-none-3E9E9A.svg" alt="No server"/>
  <img src="https://img.shields.io/badge/sandbox-the%20browser's-E39A4E.svg" alt="Sandbox: the browser's"/>
  <img src="https://img.shields.io/badge/grounding-quipu%20·%20wasm-6C7A89.svg" alt="Grounded by quipu in WASM"/>
</p>

> *A creel is the frame that holds many bobbins at once, each paying out its thread in
> parallel onto the warp. The frame doesn't spin and it doesn't weave — it holds the
> threads in tension while the work happens.* 🧵

**A static web page that runs a fleet of cheap, short-lived coding agents in browser
tabs** — remote LLM calls, WASM tools, a knowledge graph in the page. No server-side
harness, no sandbox to build, no secrets to hold.

Every server-side agent harness pays three taxes: **containment** (sandboxes, guards,
isolation — and the incidents when they leak), **operations** (a process that must stay
up), and **secrets custody** (keys on hosts). creel deletes all three by running where
those problems are already solved:

- **The sandbox is the browser's** — agent-generated code runs in WASM inside the most
  adversarially hardened runtime in existence. Worst-case blast radius: one tab.
- **There is nothing to operate** — the harness is a directory of static files.
- **There are no secrets anywhere you administer** — bring your own API key, held in
  localStorage, never in the served bundle.

## The bet: cheap agents + local knowledge

Frontier-model agents are expensive because each one must *reconstruct context* before
acting. creel bets that **small, cheap models become viable agents when grounding is
local and free**: a [quipu](https://github.com/scbrown/quipu) knowledge graph compiled
to WASM lives in the page, so every agent gets sub-millisecond, zero-token access to
what you already know — entities, constraints, prior decisions — before it acts. Ten
cheap grounded agents for the price of one frontier ungrounded one is the economic
shape of a burst.

## How it works

Tabs are the unit of parallelism — bobbins on the creel. A dashboard tab owns the
queue; each agent tab boots its own WASM toolchain and LLM loop, claims work, and
merges its results back with git. The browser platform does the scheduler's hard parts:

| scheduler concern | browser primitive |
|---|---|
| work leasing | Web Locks — a lock auto-releases when its tab dies |
| crash detection | the same release, delivered synchronously |
| fleet event bus | BroadcastChannel |
| coordinator lifetime | SharedWorker |
| durable queue | IndexedDB |
| agent isolation | per-tab processes + per-agent OPFS directories |
| merge discipline | isomorphic-git — branch per agent, merge at burst end |
| spawning | `window.open()` from the dashboard |

Leasing, liveness, isolation, and the event bus are the parts a server-side fleet has
to build and debug. Here they are platform features.

## What creel is not

creel is for **interactive burst parallelism with a human present** — fan out five
agents on a design for ten minutes, generate and test three variants, sweep a repo in
parallel while you watch. It is deliberately **not durable infrastructure**: the fleet
dies with the browser, there is no cron, and nothing runs unattended. Work that must
outlive your attention belongs to a durable harness like
[shantytown](https://github.com/scbrown/shantytown); creel and a durable fleet
complement, not compete.

## The stack

```text
        interactive bursts                     durable work
   ┌──────────────────────────┐        ┌──────────────────────────┐
   │  creel — this repo       │        │  shantytown — the crew   │
   │  tabs · WASM · BYO key   │        │  sessions · queues · ops │
   └──────┬───────────┬───────┘        └────────────┬─────────────┘
          │           │                             │
   ┌──────▼─────┐ ┌───▼──────────┐          ┌───────▼────────┐
   │ quipu-wasm │ │ WASM tools   │          │ bobbin · hank  │
   │ knowledge  │ │ node · py ·  │          │ code · struct  │
   │ in-page    │ │ git · sqlite │          │ context        │
   └────────────┘ └──────────────┘          └────────────────┘
```

## Status

Vision stage — see [docs/VISION.md](docs/VISION.md) for the full architecture,
constraints, and phasing (v0: one tab, many loops → v1: the multi-tab creel →
v2: grounded cheap agents → v3: burst ergonomics).

## License

[MIT](LICENSE)
