# Metrics: a standing producer without a server

creel ships three pieces of a metrics pipeline and, until this document, no
account of how they are meant to be run together:

| piece | what it does |
|---|---|
| `app/creel-metrics.js` | renders Prometheus exposition text **inside the page**, and deliberately stops there |
| `tools/creel-collect-metrics.js` | opens an ephemeral headless tab, asks it to render, writes the exposition to stdout |
| `tools/creel-push-metrics.js` | sends exposition to a Pushgateway, with the credential arriving at run time |

```
node tools/creel-collect-metrics.js | node tools/creel-push-metrics.js
```

## Why this does not delete `server-none`

The obvious way to make a page's metrics scrapable is to give the page a
server. That deletes the property the README calls the bet, so it is not what
this is. Nothing here listens. A scheduled caller opens a tab, takes one
reading, and the tab **exits** — which is creel's own thesis about tabs, not an
exception to it. The page stays static and address-less; the schedule and the
credential live with the operator, which is exactly where creel wants them. A
browser tab holding a gateway password is the third tax creel exists to delete.

A standing producer is therefore not an always-on creel component. It is a
periodic reader of an ephemeral one — the same shape as any other scheduled
probe.

## The absence question: publish two groups, not one

A gap in a pushed series has two very different causes: **the producer died**,
or **the producer ran and creel had nothing to say**. At the gateway they look
identical, and treating them alike is the `up=1`-while-dead class this pipeline
exists to close. So a scheduled caller should publish both facts, in two
groups:

| job | pushed | says |
|---|---|---|
| `creel_producer` | **every run, unconditionally** | the producer is alive; carries the collector's exit code as `creel_metrics_producer_collect_status` |
| `creel` | **only on a good collect** | the creel samples themselves |

Read together, every silent mode is distinguishable:

* producer dead → the `creel_producer` group goes stale
* producer alive, collect bad → `creel_producer` stays fresh with a non-zero
  status, while the `creel` group goes stale
* both healthy → both fresh

One group cannot say this. The push tool uses `PUT`, which **replaces** a
group, so folding liveness into `creel` would delete the samples on every
failed collect — turning "creel had nothing to say" into "creel was never
here".

## Status is a ladder, not a boolean

Both tools use creel's standard exit ladder, shared with `creel-doctor` and
`creel-admission`:

| code | collector | push tool |
|---|---|---|
| 0 | collected | pushed |
| 1 | — | refused: the gateway answered and rejected it |
| 2 | took no reading: no browser, or the page rendered nothing | unset: nothing configured, **nothing was pushed** |
| 3 | could not run: bad flags, no page, driver fault | could not run |

**2 and 3 must never collapse.** One is an honest silence; the other is a
broken producer that would otherwise publish a reassuring number. A caller that
maps a hung browser onto 2 files a fault under "creel had nothing to say".

Bound the collect. A headless browser can hang, and a heartbeat that outlives
its own interval is a lock rather than a heartbeat. A timeout is a 3, never a 2.

## The obligation this pipeline puts on the operator

The collector and the push tool run **from a creel checkout**. That checkout is
now part of the production path, and it inherits the oldest failure in
scheduled work: *committed is not live*.

Measured while building the first standing producer for creel: the checkout the
schedule executed from was three commits behind `origin/main`, with nothing
refreshing it — no cron, no timer. A durable schedule pointed at a checkout
nobody keeps current runs stale code indefinitely **and reports success doing
it**. Every dashboard is green; the code that produced the numbers is not the
code on main.

Two requirements, and the second is the one that gets skipped:

1. **Ownership-neutral.** Not a person's working tree. An uncommitted edit in
   somebody's checkout otherwise goes live for the schedule with no commit, no
   review and no push, and a stopped owner's tree quietly becomes the
   production source.
2. **Auto-refreshed.** A checkout nobody owns is a checkout nobody pulls.
   Relocating the rot is not fixing it. Refresh it on a timer, fast-forward
   only, and keep it read-only in between so an edit to the live path fails
   loudly instead of succeeding silently.

Never `--force` and never `reset --hard` that refresh. A refused fast-forward
means somebody changed the live source, which is a *finding* — a loud stale
tree preserves the only evidence of it, and a clobbered one destroys it.

**And publish the drift as a number**, so the guarantee is observable rather
than merely asserted:

```
# TYPE creel_metrics_producer_source_behind gauge
creel_metrics_producer_source_behind 0
```

Use `-1` for **cannot tell**, and never `0`. A stale remote-tracking ref
reports "0 behind" while genuinely behind, so an unfetchable answer that
renders as "current" is worse than no answer at all — it is the reassuring
reading of a broken instrument.

One caution if the scheduled producer measures its own drift: it is then a
second program fetching the same repository the refresher fetches and merges.
Have both parties take the same lock. A lock only one party takes is not a
lock, and two concurrent fetches can freeze a checkout behind main while every
`git log origin/main` shows the commit landed.
