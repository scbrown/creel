# The doctor: creel's preflight

> `app/creel-doctor.js` · CLI `tools/creel-doctor.js` · tool `doctor_status`
> Contract `creel.doctor/1` · bead `aegis-edp2n.4` (parity with shantytown's `st doctor`)

Creel had status tools and visible warnings, but no single answer to *is this
browser able to run a fleet, and is anything about to lose data?* Each surface
knew its own corner: the quipu store knew about eviction, the fleet knew about
leases, the state repo knew about its token. Nobody assembled them, so the
operator did it by hand, from memory, differently each time.

The doctor is that assembly. **One record, three readers** — the `doctor_status`
tool for agents and CABOODLE, `tools/creel-doctor.js` for an installer outside
the browser, and `explain()` for a human — all reading the *same object*, which
is the discipline `creel-admission` already follows.

## The contract

`creel.doctor/1`. Stable, versioned, and pinned by a test, because a consumer
keys on it:

```jsonc
{
  "contract": "creel.doctor/1",
  "at": "2026-08-30T03:14:00.000Z",
  "build": "creel-v17 (…)",
  "ok": false,
  "code": 1,
  "summary": { "pass": 7, "fail": 1, "unknown": 2, "required_fail": 1, "required_unknown": 0 },
  "checks": [
    {
      "id": "provider-credential",      // durable — renaming one breaks a consumer
      "title": "A provider credential is configured",
      "severity": "required",           // required | advisory
      "status": "fail",                 // pass | fail | unknown
      "evidence": "no API key set for provider 'anthropic'",
      "remediation": "Open settings and set a key. creel is BYO-key…"
    }
  ]
}
```

### Exit / aggregate ladder

| code | meaning |
|---|---|
| **0** | every required check passed |
| **1** | a **required** check FAILED |
| **2** | a **required** check could not be determined |
| **3** | the tool itself could not run (bad args, unparseable input) — CLI only |

**1 and 2 are deliberately distinct**, and 3 is distinct from both. "It is
broken", "I cannot see whether it is broken", and "I could not run" call for
three different actions, and collapsing them makes a blind probe look like an
outage — the confusion that produces a false all-clear.

## The ten checks

| id | severity | what it means |
|---|---|---|
| `secure-context` | **required** | OPFS, service workers and WebCrypto all refuse outside one. Also reports `crossOriginIsolated` as evidence (WebContainers/skills need it; nothing else does). |
| `quipu-wasm` | **required** | the graph is bound and usable. `persistence: 'memory'` is a **pass** — agent-tab fallback is by design. |
| `provider-credential` | **required** | a key is **set**. Never the key. |
| `storage-persistence` | advisory | origin storage is durable rather than evictable. |
| `unsynced-changes` | advisory | local state has changes not pushed. Ask this *before* a pull — an incoming sync REPLACES the local quipu store. |
| `service-worker-fresh` | advisory | a newer worker has taken over, so the page is running old code. |
| `popup-permission` | advisory | agent tabs can be spawned without a click. |
| `extension-bridge` | advisory | the creel bridge extension is present. |
| `state-repo` | advisory | a state repo and token are configured. |
| `fleet-leases` | advisory | leases whose tab died or stopped heartbeating. |

Only the first three are **required**, and that split is a judgement worth
stating: a blocked popup, a missing extension and an unconfigured state repo are
all *fleets that work*. Marking them required would fail an installer on a
healthy creel, and an installer that fails on healthy input stops being read.

## Three invariants

**1. Absence is `unknown`, never `fail`.** Every probe in `collect()` is wrapped
so a missing or throwing browser API leaves the field *absent*, and an absent
field yields `unknown`. A doctor that reports a missing API as a failure is
diagnosing itself.

**2. Looking does not treat.** Running the doctor mutates nothing. It reads the
fleet's own `staleLeases()` predicate rather than re-deriving staleness —
two copies of a staleness rule disagree exactly when it matters — and it
requeues nothing it finds. Pinned by a browser test that plants a stale lease,
runs the doctor, and asserts the task is untouched.

**3. Credentials go in, never out.** Redaction happens at **collection**, not at
render: `collect()` only ever reads `keyPresent` / `tokenPresent` booleans, so
no secret is ever in the record to leak. Tested twice — against a synthetic
secret in the evidence, and against a real key in `localStorage` read back
through the `doctor_status` tool path.

## Two things that are not what they look like

**Service-worker freshness is NOT a version-string compare.** `sw.js` counts
`CACHE_VERSION` (`creel-v26`); the page counts `CREEL_BUILD`
(`creel-v17 (2026-08-13, …)`). They are independent counters that have never
matched and were never meant to, so `activeVersion === pageBuild` reports STALE
on every healthy page. The verdict comes instead from `window.CREEL_UPDATE_READY`
— set by thread.html's registration when a newer worker installs over a
controlling one, which is the browser's own answer to "is this page older than
what is deployed". The version strings remain as *evidence*, because they are
what makes a real report actionable. There is a regression test on exactly this.

**Popup permission is never self-probed.** Opening a window to find out whether
windows open is treating the patient. The only honest evidence is what a real
spawn observed, so `spawnWindow()` records its outcome and the doctor reads it —
staying `unknown` until a spawn has actually been attempted, rather than
inventing a pass for a fleet that has never tried to open anything.

## Running it

```bash
# in a page (agent, or console)
await window.CreelDoctor.run()                    # the record
console.log(window.CreelDoctor.explain(record))   # the human block

# as a tool — the CABOODLE preflight boundary
doctor_status {}

# outside the browser, for an installer
node tools/creel-doctor.js --evidence evidence.json --json
node tools/creel-doctor.js --record record.json          # re-evaluate a captured record
echo '{"secureContext":true,…}' | node tools/creel-doctor.js
```

The CLI accepts either raw evidence or a full `creel.doctor/1` record and
re-evaluates through the **one** evaluator — a second copy of the judgement is
how a CLI and a page start disagreeing.

## Tests

- `tests/test-doctor.js` — the judgement, zero deps. Pins the durable id list,
  the unknown-vs-fail semantics, redaction on the serialized record, and the
  version-string regression above.
- `tests/test-doctor-browser.js` — the **wiring**, in real Chromium. That a
  module is loaded, correct and green proves nothing about whether anything
  calls it; on a sibling bead `creel-setpoint.js` was measured as "referenced
  only by its tests; nothing in `app/` loads it". These tests prove the doctor
  loads in `thread.html`, answers on the tool surface, reads the real page with
  no caller-supplied evidence, and leaks no credential through the tool path.
