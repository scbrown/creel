# creel — vision

*2026-08-08. Status: concept.*

> **creel** (n.) — the frame that holds many bobbins at once, each paying out its
> thread in parallel onto the warp beam. The frame doesn't spin and doesn't weave;
> it holds the threads in tension while the work happens.

## One line

A static web page that runs a fleet of cheap, short-lived coding agents entirely
in the browser — remote LLM calls, WASM tools, a knowledge graph in the page —
with tabs as the unit of parallelism and zero server-side harness.

## Why this exists

Every server-side agent harness pays the same three taxes: **containment**
(sandboxes, guards, worktrees — and the residual incidents when they leak),
**operations** (a process that must stay up, be deployed, be watched), and
**secrets custody** (keys living on hosts). A durable fleet pays all three,
necessarily, because it does unattended work.

But a large class of work doesn't need durability — it needs *burst parallelism
with a human present*: "fan out five agents on this design for ten minutes,"
"generate and test three variants of this page," "sweep these files in parallel
while I watch." For that class, the browser is close to a strictly better
substrate:

- **The sandbox is the browser's.** Generated code runs in WASM inside the most
  adversarially hardened runtime in existence. Worst-case blast radius is one
  tab's origin storage. Containment is not built here; it is inherited.
- **There is nothing to operate.** The harness is a directory of static files.
  It cannot be down, cannot drift, cannot page anyone.
- **There are no secrets to custody.** Bring-your-own-key, entered in the UI,
  held in localStorage. The served bundle contains nothing sensitive.
- **Compute scales with users at zero marginal cost**, and the feedback loop
  (edit → run → render) is in-process — milliseconds, no execution service.

## The core bet: cheap agents + local knowledge

Frontier-model agents are expensive because each one must *reconstruct context* —
search, read, re-derive — before acting. The bet behind creel is that **small,
cheap models become viable agents when grounding is local and free**.

This is where [quipu](https://github.com/scbrown/quipu) compiled to WASM lands.
Quipu (RDF/SPARQL knowledge graph on SQLite, Rust) in the page gives every agent
thread sub-millisecond, zero-network, zero-token access to what you already
know — entities, constraints, prior decisions, blast radii. A small-model agent
that can ask the graph "what depends on X, what broke last time" before acting
doesn't need to be smart enough to re-derive those facts; it needs to be smart
enough to use them. Ten cheap grounded agents for the price of one frontier
ungrounded one is the economic shape of the burst.

The graph snapshot ships to the browser read-only (fetched at session start);
writes flow back through the graph server's existing authenticated write path.
The page never becomes a second source of truth.

## Architecture

```
┌─ dashboard tab (the creel) ────────────────────┐
│  queue (IndexedDB) · dispatch · burst controls │
│  SharedWorker: coordinator, event log          │
└───────────────┬────────────────────────────────┘
                │ BroadcastChannel (fleet bus)
   ┌────────────┼────────────┬─ ─ ─ ─ ─┐
┌──▼─────┐ ┌────▼───┐ ┌──────▼─┐
│ agent  │ │ agent  │ │ agent  │   … window.open() per bobbin
│ tab 1  │ │ tab 2  │ │ tab 3  │
│ LLM    │ │ LLM    │ │ LLM    │   direct LLM API calls from the
│ loop   │ │ loop   │ │ loop   │   browser (CORS + BYO key)
│ WASM   │ │ WASM   │ │ WASM   │   WebContainer / Pyodide / esbuild
│ tools  │ │ tools  │ │ tools  │   quipu-wasm (shared snapshot)
└──┬─────┘ └──┬─────┘ └──┬─────┘
   └──────────┴──────────┴── OPFS: per-agent dirs, isomorphic-git merge
```

**The platform does the scheduler's hard parts:**

| scheduler concern | browser primitive |
|---|---|
| work leasing | Web Locks API — lock auto-releases when the tab dies |
| crash detection | same lock release, delivered synchronously |
| fleet event bus | BroadcastChannel |
| coordinator lifetime | SharedWorker (lives while any tab does) |
| durable queue | IndexedDB (survives browser restart) |
| isolation between agents | per-tab processes + per-agent OPFS dirs |
| merge discipline | isomorphic-git: branch per agent, merge at burst end |
| spawning | `window.open()` from the dashboard |

Leasing, liveness, isolation, and the event bus are the parts a server-side
fleet has to build and debug; here they are platform features. Notably, tab
death is *better* signalled than a dead terminal session: the coordinator is
told synchronously via lock release, rather than inferring it from heuristics.

**Tool surface per agent (v1):** filesystem (OPFS), Node runtime + npm + dev
server (WebContainer, one per tab), Python (Pyodide, many per tab), bundling
(esbuild-wasm), git (isomorphic-git), knowledge (quipu-wasm), and fetch-based
tools against any local services whose CORS allows it.

**LLM access:** direct from the browser. Anthropic's API supports CORS via the
`anthropic-dangerous-direct-browser-access` header — the sanctioned pattern for
exactly this: a trusted-user tool where each user supplies their own key. No
proxy, no server-held credentials. Cheap fast models are the default for agent
threads; a frontier model is a per-thread choice, not an architecture change.

## What creel is not (non-goals)

- **Not durable infrastructure.** The fleet dies with the browser, by design.
  No cron, no overnight runs, no headless-browser resurrection. Work that must
  outlive a human's attention belongs to a durable harness (e.g.
  [shantytown](https://github.com/scbrown/shantytown)). creel and a durable
  fleet complement; they do not compete.
- **Not agent-drivable.** It is a human-in-the-loop tool. Headless agents
  cannot and should not puppet it.
- **Not a second knowledge store.** quipu-wasm is a read replica; writes go
  through the graph server's authenticated path with its schema enforcement.
- **Not multi-user-stateful.** Projects live in the operator's own browser
  storage; export-to-git is the escape hatch, not server sync.

## Constraints, stated up front

1. **Secure context required.** SharedArrayBuffer (WebContainers) needs HTTPS
   plus COOP/COEP cross-origin-isolation headers. A plain-HTTP origin will not
   boot it. Wherever the static bundle is served from must have TLS and set two
   response headers (or use the coi-serviceworker shim). This is the only real
   deployment requirement in the project.
2. **WebContainers is proprietary** (free for personal/open-source use; N
   concurrent instances stretches the spirit — re-read the license before
   multi-tab). Pyodide/esbuild/PGlite are fully open; a Python-first v1 avoids
   the question entirely.
3. **One WebContainer per tab** — which is *why* tabs are the parallelism unit
   for Node work.
4. **Background-tab throttling.** `await fetch()` loops are largely immune;
   CPU-heavy tool work in unfocused tabs is not. Mitigate with in-tab Workers,
   tiled windows, or a dedicated browser profile with throttling disabled.
5. **OPFS is evictable.** Anything worth keeping leaves via git push before the
   burst ends.

## Phases

- **v0 — one tab, many loops.** Single page, BYO key, direct LLM calls, one
  WebContainer, 2–3 concurrent LLM loops sharing its filesystem ("multiple
  agents, one box"). Proves the tool loop and the economics. No cross-tab
  machinery at all.
- **v1 — the creel.** Dashboard + agent tabs, Web Locks leasing, IndexedDB
  queue, BroadcastChannel bus, per-agent OPFS dirs with git merge. Burst
  controls: spawn N, drain, abort.
- **v2 — grounded cheap agents.** quipu-wasm snapshot loaded per burst;
  graph-query as a first-class tool; measure the thing the bet stands on —
  task success rate of small-model agents with vs. without the graph, and cost
  per completed task vs. one frontier agent.
- **v3 — burst ergonomics.** Result synthesis view (the *weft* — the pass that
  runs across the parallel threads at burst end), diff review across agents,
  one-click write-back of what the burst learned to the graph.

## Open questions

- Node-first (WebContainers, licensing caveat) vs. Python-first (fully open)
  for v1's execution tool.
- Whether the quipu snapshot is fetched whole (fine at modest graph sizes) or
  windowed by the burst's topic via one server-side search first.
- Fork-vs-greenfield was considered and settled: greenfield. bolt.diy's value
  is its server-shaped scaffolding and UI, which creel deletes; specific proven
  pieces (WebContainer wiring, streamed-artifact parsing) can be lifted with
  attribution under MIT when needed.
