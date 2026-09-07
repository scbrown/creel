/* creel — app/creel-doctor.js: the preflight, analogous to `st doctor`.
 *
 * Requested on aegis-edp2n.4 (parity with shantytown's doctor) with a consumer
 * contract from CABOODLE on the same bead: a stable, versioned, machine-readable
 * result where every check carries a DURABLE ID, pass/fail/unknown, a
 * required-vs-advisory severity, REDACTED evidence and remediation text — and an
 * aggregate that is nonzero for a required failure or a required unknown.
 *
 * ── WHY THIS IS A PURE FUNCTION OVER COLLECTED EVIDENCE ─────────────────────
 *
 * `evaluate(evidence)` is total and pure: evidence in, record out, no clock, no
 * storage, no DOM. `collect()` is the only part that touches the browser. The
 * split is the same one `creel-setpoint.js` makes and for the same reason — it
 * is what lets every case be stated as a full world in `tests/test-doctor.js`
 * and run under plain node, including the cases you cannot conjure in a real
 * browser on demand (a dead lock, an evicted store, a stale service worker).
 *
 * ── A DOCTOR MUST NOT TREAT THE PATIENT ─────────────────────────────────────
 *
 * Nothing here mutates. That is a real constraint rather than a slogan: the
 * fleet's own staleness routine, `requeueStale()`, REQUEUES what it finds, so
 * calling it to report would have silently changed fleet state as a side effect
 * of being looked at. `creel-fleet.js` now exposes the PREDICATE
 * (`staleLeases`) separately from the action, and this module reads the
 * predicate. One rule, two readers — the doctor reports it, the fleet acts on
 * it — because a second copy of a staleness rule disagrees with the first
 * exactly when it matters.
 *
 * ── CANNOT-TELL IS NOT A FAILURE, AND IT IS NOT A PASS ──────────────────────
 *
 * Every check may answer `unknown`, and absent evidence always produces
 * `unknown` rather than `fail`. An instrument that could not look and a
 * condition that is genuinely broken need opposite responses from an operator,
 * and collapsing them is how a doctor starts lying in the reassuring direction.
 * The aggregate keeps them apart too: 1 is a diagnosed failure, 2 is a blind
 * gauge, matching `tools/creel-admission.js`, which already draws that line for
 * this codebase's other preflight.
 *
 * ── CREDENTIALS ARE NEVER IN THE RECORD ─────────────────────────────────────
 *
 * `creel-self.js` states the rule for the UI surface: credentials go in, never
 * out. The doctor obeys it at collection rather than at rendering — `collect()`
 * reads only the BOOLEAN "is something set", so no key is ever in the object
 * that gets serialised. A redaction applied on the way out can be forgotten by
 * one caller; evidence that never held the secret cannot leak it.
 *
 * ── AGGREGATE CODE ──────────────────────────────────────────────────────────
 *
 *   0  ok       every required check passes
 *   1  failed   a REQUIRED check failed — a diagnosed problem
 *   2  unknown  a REQUIRED check could not be determined — a blind instrument
 *   3  error    the doctor could not run at all (see tools/creel-doctor.js)
 *
 * Advisory checks never change the code. They are printed, and they are the
 * majority, because most of what makes creel pleasant is not what makes it work.
 */
(function () {
  'use strict';

  const CONTRACT = 'creel.doctor/1';

  const PASS = 'pass', FAIL = 'fail', UNKNOWN = 'unknown';
  const REQUIRED = 'required', ADVISORY = 'advisory';

  /* A check answers from evidence alone. Returning undefined/null means the
   * evidence for it was absent, which the runner turns into `unknown` with a
   * uniform reason — so a new check cannot accidentally report a pass by
   * forgetting to handle missing input. */
  const CHECKS = [
    {
      id: 'secure-context',
      title: 'Page is a secure context',
      severity: REQUIRED,
      /* REQUIRED because it is load-bearing three times over: OPFS, service
       * workers and WebCrypto all refuse outside one. A creel served over plain
       * http is not a degraded creel, it is a different and much smaller one. */
      /* Cross-origin isolation rides along as EVIDENCE, not as its own check.
       * It gates only WebContainers (app/harness/07-skills.js), so a creel
       * without it is fully working for everything else — a required check
       * would fail a healthy fleet, and a tenth advisory would change the id
       * list that CABOODLE pins as a contract. Reporting it here costs nothing
       * and answers the "why did skills refuse?" question at the point someone
       * is already reading the preflight. */
      run: (e) => (typeof e.secureContext !== 'boolean' ? null
        : e.secureContext
          ? {
            status: PASS,
            evidence: 'window.isSecureContext = true'
              + (typeof e.crossOriginIsolated === 'boolean'
                ? `; crossOriginIsolated = ${e.crossOriginIsolated}`
                  + (e.crossOriginIsolated ? '' : ' (WebContainers/skills unavailable — COOP/COEP headers absent)')
                : ''),
          }
          : {
            status: FAIL,
            evidence: 'window.isSecureContext = false',
            remediation: 'Serve creel over https, or from http://localhost. '
              + 'OPFS, the service worker and WebCrypto are all unavailable here.',
          }),
    },
    {
      id: 'quipu-wasm',
      title: 'quipu (wasm) is bound and usable',
      severity: REQUIRED,
      /* REQUIRED because the knowledge graph is not an accessory here — agents
       * learn their world by querying it (creel-self.js), so an unbound quipu
       * leaves them with no world model at all. */
      run: (e) => {
        const q = e.quipu;
        if (!q || typeof q.bound !== 'boolean') return null;
        if (!q.bound) {
          return {
            status: FAIL,
            evidence: q.bootError ? `not bound: ${q.bootError}` : 'not bound',
            remediation: 'Reload the page. If it persists, the wasm bundle under '
              + 'app/wasm/pkg/ failed to fetch — check the service worker cache '
              + 'and that the build shipped the .wasm file.',
          };
        }
        /* memory persistence is a PASS, not a warning: only the first tab gets
         * the OPFS store (the VFS pool is single-owner) and agent tabs fall back
         * by design. Flagging the designed case would train operators to ignore
         * this check in exactly the tabs that are working correctly. */
        return { status: PASS, evidence: `bound (${q.persistence || 'unknown store'})` };
      },
    },
    {
      id: 'provider-credential',
      title: 'A model provider is configured',
      severity: REQUIRED,
      /* REQUIRED because without it no agent can take a turn. The evidence is a
       * boolean and the provider's NAME; the key is never collected. */
      run: (e) => {
        const p = e.provider;
        if (!p || typeof p.keyPresent !== 'boolean') return null;
        return p.keyPresent
          ? { status: PASS, evidence: `${p.id || 'provider'} configured (key present, not read)` }
          : {
            status: FAIL,
            evidence: `${p.id || 'provider'} has no key set`,
            remediation: 'Open the provider panel and paste an API key, or ask the '
              + 'agent to set one — ui_set_credential writes it without reading it back.',
          };
      },
    },
    {
      id: 'storage-persistence',
      title: 'Origin storage is durable (not evictable)',
      severity: ADVISORY,
      /* ADVISORY: creel runs fine on evictable storage, and the store already
       * tells you to export anything worth keeping. It is the difference between
       * "this will break" and "this can lose data quietly", and only the first
       * should stop an installer. */
      run: (e) => {
        const s = e.storage;
        if (!s || typeof s.persisted !== 'boolean') return null;
        const size = (s.usageMB != null && s.quotaMB != null)
          ? ` (${s.usageMB}MB of ${s.quotaMB}MB)` : '';
        return s.persisted
          ? { status: PASS, evidence: `navigator.storage.persisted() = true${size}` }
          : {
            status: FAIL,
            evidence: `storage is EVICTABLE${size}`,
            remediation: 'The browser may reclaim the quipu store under pressure. '
              + 'Export with quipu_export_db, or push to the state repo, before '
              + 'anything you care about only exists here.',
          };
      },
    },
    {
      id: 'unsynced-changes',
      title: 'Local state is synced',
      severity: ADVISORY,
      /* ADVISORY, and reported even at zero. This is the number an operator
       * wants BEFORE a pull that replaces the local store — 14-sync-push-pull
       * says the incoming quipu blob REPLACES the local one, so "how much have I
       * got that is only here" is the question worth answering first. */
      /* ACCEPTS A BOOLEAN AS WELL AS A COUNT, and the boolean is the real case.
       * This check was written expecting `unsynced` to be a number, but creel
       * has no producer of that number: the only dirty-state predicate in the
       * codebase is 13-sync-core's `stateIsDirty()`, which compares two
       * timestamps (`dirty > synced`) and returns a boolean. Coercing that to
       * 1/0 would be a lie with a plausible shape — "1 unsynced change" when the
       * true answer is "some". So the check reports what is actually known, and
       * a count is used only where a real count is supplied. */
      run: (e) => {
        const d = e.dirty;
        if (!d) return null;
        const n = d.unsynced;
        if (typeof n === 'boolean') {
          return n
            ? {
              status: FAIL,
              evidence: 'local state has unsynced changes (stateIsDirty)',
              remediation: 'Push before you pull. An incoming sync REPLACES the local '
                + 'quipu store rather than merging into it.',
            }
            : { status: PASS, evidence: 'no unsynced local changes' };
        }
        if (typeof n !== 'number') return null;
        return n === 0
          ? { status: PASS, evidence: 'no unsynced local changes' }
          : {
            status: FAIL,
            evidence: `${n} unsynced local change(s)`,
            remediation: 'Push before you pull. An incoming sync REPLACES the local '
              + 'quipu store rather than merging into it.',
          };
      },
    },
    {
      id: 'service-worker-fresh',
      title: 'Service worker is serving this build',
      severity: ADVISORY,
      /* ADVISORY but disproportionately worth printing: a stale SW serves old
       * code that looks current, which is the failure CREEL_BUILD was added to
       * make debuggable in the first place. */
      run: (e) => {
        const sw = e.serviceWorker;
        if (!sw || typeof sw.supported !== 'boolean') return null;
        if (!sw.supported) {
          return {
            status: FAIL,
            evidence: 'serviceWorker unsupported in this browser',
            remediation: 'creel still runs, but loses offline start and cache control.',
          };
        }
        if (!sw.controlled) {
          return {
            status: PASS,
            evidence: 'no service worker controlling this page (first load, or bypassed)',
          };
        }
        /* THE VERDICT COMES FROM THE BROWSER'S OWN UPDATE LIFECYCLE, NOT FROM
         * COMPARING TWO VERSION STRINGS.
         *
         * The obvious implementation — activeVersion === pageBuild — is wrong
         * here, and wrong in the direction that destroys the check's value.
         * `sw.js` counts in CACHE_VERSION ('creel-v26') and the page counts in
         * CREEL_BUILD ('creel-v17 (2026-08-13, measurement harness)'). They are
         * two independent counters that were never the same value or even the
         * same FORMAT, so string equality reports STALE on a perfectly fresh
         * install, every time. An advisory that cries wolf on every healthy page
         * is worse than no advisory: it teaches the operator to skip the one
         * line that would have mattered.
         *
         * `updateReady` is the real condition. thread.html's registration sets
         * it when a NEWER worker has installed while an older one still controls
         * this page — which is exactly "the running page is older than what is
         * deployed", measured by the browser rather than inferred by us. The
         * version strings stay as EVIDENCE, because they are what makes a real
         * staleness report actionable. */
        if (typeof sw.updateReady !== 'boolean') return null;
        const serving = sw.activeVersion ? `sw ${sw.activeVersion}` : 'sw version unreported';
        const expects = sw.pageBuild ? `page ${sw.pageBuild}` : 'page build unreported';
        return !sw.updateReady
          ? { status: PASS, evidence: `no newer worker waiting (${serving}, ${expects})` }
          : {
            status: FAIL,
            evidence: `a newer service worker has installed and taken over (${serving}, ${expects})`,
            remediation: 'A STALE page is running old code while the new worker serves '
              + 'everything else. Save or push anything unsaved, then reload. creel '
              + 'deliberately does NOT reload for you — a fleet tab would abandon its task.',
          };
      },
    },
    {
      id: 'popup-permission',
      title: 'Agent tabs can be spawned without a click',
      severity: ADVISORY,
      /* ADVISORY, deliberately, and this one is a judgement worth stating: a
       * blocked popup does NOT break the fleet. creel already treats it as a
       * first-class case — spawn tools report it, tasks stay `queued`, and the
       * dashboard's Launch button opens them with a real click. So this is a
       * convenience, and marking it required would fail an installer on a fleet
       * that works.
       *
       * It is also never PROBED. Opening a window to find out whether windows
       * open is treating the patient; the evidence is whatever a real spawn last
       * observed, and `unknown` until one has. */
      run: (e) => {
        const p = e.popups;
        if (!p || typeof p.allowed !== 'boolean') return null;
        return p.allowed
          ? { status: PASS, evidence: 'last spawn opened a window' }
          : {
            status: FAIL,
            evidence: 'a spawn was blocked by the popup blocker',
            remediation: 'Allow popups for this origin, or use the Launch button on '
              + 'the fleet dashboard — queued tasks are not lost either way.',
          };
      },
    },
    {
      id: 'extension-bridge',
      title: 'creel bridge extension is present',
      severity: ADVISORY,
      /* ADVISORY because the extension describes itself as the OPT-IN capability
       * for cross-origin work. Its absence removes creel's outward-facing hands
       * and nothing else. */
      run: (e) => {
        const x = e.extension;
        if (!x || typeof x.present !== 'boolean') return null;
        return x.present
          ? { status: PASS, evidence: `bridge present${x.version ? ' v' + x.version : ''}` }
          : {
            status: FAIL,
            evidence: 'no bridge detected on this origin',
            remediation: 'Install the extension in creel/extension to let agents drive '
              + 'cross-origin pages. Everything in-page works without it.',
          };
      },
    },
    {
      id: 'state-repo',
      title: 'A state repo is configured for sync',
      severity: ADVISORY,
      run: (e) => {
        const s = e.stateRepo;
        if (!s || typeof s.configured !== 'boolean') return null;
        if (!s.configured) {
          return {
            status: FAIL,
            evidence: 'no state repo configured',
            remediation: 'Without one there is nowhere to push; the store lives only in '
              + 'this browser profile. Configure it in the sync panel.',
          };
        }
        return typeof s.tokenPresent === 'boolean' && !s.tokenPresent
          ? {
            status: FAIL,
            evidence: `state repo set${s.repo ? ` (${s.repo})` : ''} but no token`,
            remediation: 'Pushes will fail. Add a token with write access in the sync panel.',
          }
          : { status: PASS, evidence: `state repo ready${s.repo ? ` (${s.repo})` : ''}` };
      },
    },
    {
      id: 'fleet-leases',
      title: 'No abandoned fleet leases',
      severity: ADVISORY,
      /* Reads the fleet's OWN staleness predicate rather than re-deriving it.
       * Advisory because the fleet self-heals — `requeueStale` puts these back on
       * the queue — so this reports a condition that is already being handled,
       * which is worth SEEING and not worth failing an installer over. */
      run: (e) => {
        const f = e.fleet;
        if (!f || !Array.isArray(f.staleLeases)) return null;
        if (!f.staleLeases.length) {
          const n = typeof f.liveLeases === 'number' ? f.liveLeases : null;
          return { status: PASS, evidence: n === null ? 'no abandoned leases' : `${n} live lease(s), none abandoned` };
        }
        return {
          status: FAIL,
          evidence: `${f.staleLeases.length} abandoned lease(s): `
            + f.staleLeases.map((s) => `${s.id}(${s.reason})`).join(', '),
          remediation: 'These are tasks that look running with no live tab. The fleet '
            + 'requeues them on its next pass; no action needed unless they recur.',
        };
      },
    },
  ];

  const UNKNOWN_RESULT = {
    status: UNKNOWN,
    evidence: 'not determined — the evidence for this check was not collected',
    remediation: 'Run the doctor in a creel tab; a headless caller can only report '
      + 'what the tab exported.',
  };

  /** Evaluate collected evidence into a `creel.doctor/1` record. PURE. */
  function evaluate(evidence) {
    const e = evidence || {};
    const checks = CHECKS.map((c) => {
      let r = null;
      try {
        r = c.run(e);
      } catch (err) {
        /* A check that throws is a BROKEN INSTRUMENT, never a failing subject.
         * Reporting it as `fail` would invent a diagnosis out of our own bug. */
        r = {
          status: UNKNOWN,
          evidence: `check raised: ${err && err.message ? err.message : String(err)}`,
          remediation: 'This is a defect in the doctor, not in what it inspects.',
        };
      }
      const out = r || UNKNOWN_RESULT;
      return {
        id: c.id,
        title: c.title,
        severity: c.severity,
        status: out.status,
        evidence: out.evidence,
        remediation: out.remediation || null,
      };
    });

    const counted = (sev, st) => checks.filter((c) => c.severity === sev && c.status === st).length;
    const requiredFail = counted(REQUIRED, FAIL);
    const requiredUnknown = counted(REQUIRED, UNKNOWN);
    /* FAILURE OUTRANKS UNKNOWN. Both are nonzero, and when a run has one of
     * each the operator should be sent to the thing that is definitely broken
     * before the thing we could not see. */
    const code = requiredFail ? 1 : requiredUnknown ? 2 : 0;

    return {
      contract: CONTRACT,
      at: e.at || null,
      build: e.build || null,
      ok: code === 0,
      code,
      summary: {
        pass: checks.filter((c) => c.status === PASS).length,
        fail: checks.filter((c) => c.status === FAIL).length,
        unknown: checks.filter((c) => c.status === UNKNOWN).length,
        required_fail: requiredFail,
        required_unknown: requiredUnknown,
      },
      checks,
    };
  }

  /** One operator-readable block. The machine record is what CABOODLE reads. */
  function explain(record) {
    const mark = { pass: 'ok  ', fail: 'FAIL', unknown: '??  ' };
    const lines = [
      `creel doctor — ${record.ok ? 'OK' : 'NOT OK'} (code ${record.code})`
      + `${record.build ? `  build ${record.build}` : ''}`,
    ];
    for (const c of record.checks) {
      const sev = c.severity === REQUIRED ? 'required' : 'advisory';
      lines.push(`  ${mark[c.status] || c.status}  ${c.id} [${sev}] — ${c.evidence}`);
      if (c.status !== PASS && c.remediation) lines.push(`        → ${c.remediation}`);
    }
    const s = record.summary;
    lines.push(`  ${s.pass} pass, ${s.fail} fail, ${s.unknown} unknown`
      + ` (required: ${s.required_fail} failing, ${s.required_unknown} unknown)`);
    return lines.join('\n');
  }

  /* ── COLLECTION (browser only) ───────────────────────────────────────────
   * Every field is optional and every probe is wrapped: a probe that throws
   * leaves its field absent, which `evaluate` reports as `unknown`. That is the
   * whole reason collection and evaluation are separate — a browser API that
   * does not exist must not be able to take the doctor down with it.
   */
  /* Both the extension bridge and the state repo expose their status ONLY
   * through their MCP JSON-RPC surface — there is no synchronous getter for
   * `bridge.present` or `hasToken`. Rather than reach into either module's
   * privates (which would give the doctor a second copy of a fact that already
   * has an owner, the thing the fleet-leases check exists to avoid), ask the
   * documented tool and unwrap the envelope here, once. Any malformed or failed
   * reply yields undefined, which the evaluator reads as `unknown` — never as a
   * pass and never as a fail. */
  async function callTool(mod, name) {
    if (!mod || typeof mod.handle !== 'function') return undefined;
    const res = await mod.handle({
      jsonrpc: '2.0', id: 'doctor', method: 'tools/call', params: { name, arguments: {} },
    });
    const text = res && res.result && res.result.content
      && res.result.content[0] && res.result.content[0].text;
    if (typeof text !== 'string') return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
  }

  /* The SW's CACHE_VERSION, for EVIDENCE only — the verdict comes from
   * updateReady (see the service-worker check). sw.js answers a 'VERSION'
   * message; nothing in creel had ever sent one, so this is the first caller.
   * Bounded, because an unanswered postMessage otherwise hangs collection
   * forever: a doctor that never returns is worse than one that reports
   * `unknown`, since nothing downstream can even time it out. */
  function askServiceWorker(timeoutMs) {
    return new Promise((resolve) => {
      const sw = navigator.serviceWorker;
      if (!sw || !sw.controller) return resolve(undefined);
      let done = false;
      const finish = (v) => { if (!done) { done = true; sw.removeEventListener('message', onMsg); resolve(v); } };
      const onMsg = (e) => {
        if (e && e.data && e.data.type === 'sw-version') finish(e.data.version);
      };
      try {
        sw.addEventListener('message', onMsg);
        sw.controller.postMessage('VERSION');
        setTimeout(() => finish(undefined), timeoutMs || 1500);
      } catch { finish(undefined); }
    });
  }

  async function collect(opts) {
    const o = opts || {};
    const ev = { at: new Date().toISOString(), build: (typeof window !== 'undefined' && window.CREEL_BUILD) || null };
    const tryIt = async (fn) => { try { return await fn(); } catch { return undefined; } };

    ev.secureContext = await tryIt(() => window.isSecureContext);
    ev.crossOriginIsolated = await tryIt(() => !!window.crossOriginIsolated);

    ev.storage = await tryIt(async () => {
      const info = window.CreelQuipu && window.CreelQuipu.storageInfo;
      if (info) return { persisted: !!info.persisted, usageMB: info.usageMB, quotaMB: info.quotaMB };
      const persisted = await navigator.storage.persisted();
      const est = await navigator.storage.estimate();
      return {
        persisted: !!persisted,
        usageMB: est ? Math.round(est.usage / 1e6) : undefined,
        quotaMB: est ? Math.round(est.quota / 1e6) : undefined,
      };
    });

    ev.quipu = await tryIt(() => {
      const Q = window.CreelQuipu;
      if (!Q) return undefined;
      return {
        bound: !!Q.bound || typeof Q.exportDb === 'function',
        persistence: Q.persistence || (Q.storageInfo ? 'opfs' : undefined),
        bootError: Q.lastBootError || null,
      };
    });

    ev.serviceWorker = await tryIt(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const controlled = !!navigator.serviceWorker.controller;
      return {
        supported: true,
        controlled,
        /* The verdict rung. thread.html's registration sets this when a newer
         * worker installs over a controlling one. Absent until then, which is
         * the healthy case, so treat "not true" as false rather than unknown —
         * an uncontrolled page is handled above and never reaches here. */
        updateReady: !!window.CREEL_UPDATE_READY,
        activeVersion: o.swVersion !== undefined ? o.swVersion : await askServiceWorker(),
        pageBuild: window.CREEL_BUILD,
      };
    });

    /* NEVER the key itself — only whether one is set. See the header.
     * Reads the live provider store when the caller supplies nothing, so the
     * REQUIRED credential check reports a real verdict rather than `unknown`. */
    ev.provider = await tryIt(() => {
      if (o.provider) return { id: o.provider.id, keyPresent: !!o.provider.keyPresent };
      const store = typeof window._loadProviders === 'function' ? window._loadProviders() : null;
      const id = (typeof window.getActiveProviderId === 'function' && window.getActiveProviderId())
        || localStorage.getItem('ba_active_provider_id') || '';
      const list = (store && store.providers) || store || [];
      const arr = Array.isArray(list) ? list : Object.values(list);
      const profile = arr.find((p) => p && p.id === id);
      if (!profile && !id) return undefined;          // nothing configured yet: unknown, not fail
      return { id: id || undefined, keyPresent: !!(profile && profile.apiKey) };
    });

    ev.stateRepo = await tryIt(async () => {
      if (o.stateRepo) {
        return {
          configured: !!o.stateRepo.configured,
          repo: o.stateRepo.repo,
          tokenPresent: o.stateRepo.tokenPresent,
        };
      }
      const s = await callTool(window.CreelState, 'state_status');
      if (!s) return undefined;
      return { configured: !!s.configured, repo: s.repo, tokenPresent: !!s.hasToken };
    });

    ev.extension = await tryIt(async () => {
      if (o.extension) return { present: !!o.extension.present, version: o.extension.version };
      const s = await callTool(window.CreelBrowser, 'browser_status');
      if (!s) return undefined;
      return { present: !!s.bridge_installed, version: s.version };
    });

    ev.popups = await tryIt(() => {
      if (o.popups) return { allowed: !!o.popups.allowed };
      const F = window.CreelFleetInternal;
      const last = F && typeof F.lastSpawnOutcome === 'function' ? F.lastSpawnOutcome() : null;
      /* `null` means no spawn has been attempted, which is genuinely unknown —
       * and must stay unknown. This check is never self-probed; see its note. */
      return (last && typeof last.allowed === 'boolean') ? { allowed: last.allowed } : undefined;
    });

    ev.dirty = await tryIt(() => {
      if (o.dirty) return { unsynced: o.dirty.unsynced };
      if (typeof window.stateIsDirty !== 'function') return undefined;
      return { unsynced: !!window.stateIsDirty() };      // boolean: the only real producer
    });

    ev.fleet = await tryIt(async () => {
      const F = window.CreelFleetInternal;
      if (!F || typeof F.staleLeases !== 'function') return undefined;
      const [tasks, locks] = await Promise.all([F.allTasks(), F.heldTaskLocks()]);
      const stale = F.staleLeases(tasks, locks, Date.now());
      const live = tasks.filter((t) => t && t.kind === 'lease' && t.status === 'running').length;
      return {
        liveLeases: live - stale.length,
        staleLeases: stale.map((s) => ({ id: s.id, reason: s.reason })),
      };
    });

    for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
    return ev;
  }

  async function run(opts) { return evaluate(await collect(opts)); }

  const api = {
    CONTRACT, CHECKS, PASS, FAIL, UNKNOWN, REQUIRED, ADVISORY,
    evaluate, explain, collect, run,
  };

  /* ── the in-page MCP surface: `doctor_status` ──────────────────────
   *
   * A DOCTOR NOTHING CALLS IS NOT A DOCTOR. Until this existed, every one of
   * the ten checks was reachable only from its own tests: the module was loaded
   * by thread.html, exported on `window`, fully correct — and never once run
   * against the live page. That is the same shape as the failures this fleet
   * measured on 2026-08-29, where every component was healthy and no handler
   * ran; a check that is never invoked reports nothing, and reporting nothing
   * is indistinguishable from reporting health.
   *
   * It is exposed as a tool rather than only a button because the consumer that
   * asked for it (CABOODLE, aegis-edp2n.4) needs the machine-readable record as
   * a preflight boundary: durable per-check ids, pass/fail/unknown, required vs
   * advisory, redacted evidence, remediation, and an aggregate that is nonzero
   * for any required failure OR unknown. That is exactly the `creel.doctor/1`
   * record, returned verbatim — one contract, three readers (this tool, the
   * `tools/creel-doctor.js` CLI, and `explain()` for a human), the same
   * discipline creel-admission already follows. */
  const TOOLS = [{
    name: 'doctor_status',
    description: 'Run the creel preflight: secure context, quipu WASM, provider credential, '
      + 'storage persistence, unsynced state, service-worker freshness, popup permission, '
      + 'extension bridge, state repo, and abandoned fleet leases. Returns the versioned '
      + 'creel.doctor/1 record. Never returns a credential — only whether one is set. '
      + 'ok=false and a nonzero code mean a REQUIRED check failed or could not be determined.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }];

  api.handle = async function handle(body) {
    const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
    const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
    try {
      switch (body.method) {
        case 'initialize':
          return reply({
            protocolVersion: (body.params && body.params.protocolVersion) || '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'doctor', version: '0' },
          });
        case 'notifications/initialized':
          return null;
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call': {
          const name = body.params && body.params.name;
          if (name !== 'doctor_status') return fail(`unknown tool: ${name}`);
          const record = await run();
          return reply({ content: [{ type: 'text', text: JSON.stringify(record) }] });
        }
        default:
          return fail(`method not supported in-page: ${body.method}`);
      }
    } catch (e) {
      return fail(e && e.message ? e.message : String(e));
    }
  };

  api.registerDefaults = function registerDefaults() {
    if (typeof window === 'undefined' || !window.CreelInpage) return;
    window.CreelInpage.register('inpage:doctor', api);
    if (typeof mcpServers === 'undefined') return;
    if (!mcpServers.find((s) => s.id === 'mcp_doctor_inpage')) {
      mcpServers.push({
        id: 'mcp_doctor_inpage', name: 'doctor', type: 'inpage',
        url: 'inpage:doctor', token: '', corsProxy: '', enabled: true,
      });
      if (typeof saveMcpServers === 'function') saveMcpServers();
    }
    const server = mcpServers.find((s) => s.id === 'mcp_doctor_inpage');
    if (server && typeof mcpConnectServer === 'function') {
      mcpConnectServer(server).catch((e) => console.warn('doctor in-page MCP connect failed', e));
    }
    if (typeof renderMcpServerList === 'function') renderMcpServerList();
  };

  if (typeof window !== 'undefined') window.CreelDoctor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => api.registerDefaults());
    } else {
      api.registerDefaults();
    }
  }
})();
