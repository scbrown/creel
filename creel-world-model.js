/* creel — seeding the world model, and booting the self layer (creel-hun).
 *
 * Split out of creel-self.js. The root pane writes creel's own description
 * into the shared quipu graph, so an agent learns what it is running inside
 * by querying the same store it uses for everything else, rather than by
 * being told in a prompt that then has to be kept in sync.
 *
 * This part also owns boot, because it is the last of the three to load:
 * registerDefaults needs the tool surface from creel-ui-tools.js, and
 * electRoot can seed only once seedWorldModel below exists.
 */
(function () {
  'use strict';

  const SELF = window.CreelSelfInternal;
  if (!SELF) throw new Error('creel-world-model.js loaded before creel-self.js — check the script order in thread.html');
  const { CreelSelf, CreelUi, electRoot } = SELF;

  // ── 2. seed the world model into the shared quipu store ──────────
  /** Seed the world model, unless this version is already in the store.
   *  `version` is a parameter rather than a closed-over constant so a test
   *  can seed a later version against a store that already holds earlier
   *  ones — which is the only way to exercise the supersedes path. */
  async function seedWorldModel(version) {
    // Shadowing the module constant deliberately, so the body below reads the
    // same whether it is seeding the real version or a test's. (A default
    // parameter would resolve against the outer constant, which works but
    // reads like a bug.)
    const WORLD_VERSION = version || CreelSelf.worldVersion;
    try {
      await window.CreelQuipu.ensureWasm();
      const call = (name, args) => window.CreelQuipu.provider.callTool(name, args);
      const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
      const existing = await call('quipu_query', {
        query: `SELECT ?s WHERE { ?s <${RDFS_LABEL}> "${WORLD_VERSION}" } LIMIT 1`,
      });
      if (existing.count > 0) return;

      // A store seeded at an earlier version keeps that version's nodes — the
      // graph is append-only and facts stay true at write time, so we do not
      // rewrite them. But an agent that finds v1 must not read it as current,
      // so the new episode declares what it supersedes and edges point
      // forward. Following `supersedes` backwards from any version reaches
      // the newest one. (creel-b8b)
      const priorVersions = [];
      const currentN = Number((WORLD_VERSION.match(/v(\d+)$/) || [])[1] || 0);
      for (let v = 1; v < currentN; v++) {
        const label = WORLD_VERSION.replace(/v\d+$/, `v${v}`);
        const hit = await call('quipu_query', {
          query: `SELECT ?s WHERE { ?s <${RDFS_LABEL}> "${label}" } LIMIT 1`,
        }).catch(() => ({ count: 0 }));
        if (hit.count > 0) priorVersions.push(label);
      }

      const servers = (typeof mcpServers !== 'undefined' ? mcpServers : [])
        .filter((s) => s.type === 'inpage');
      const serverNodes = servers.map((s) => ({
        name: `server:${s.name}`,
        type: 'ToolServer',
        description: {
          quipu: 'knowledge graph tools (37): episodes, SPARQL query, search, impact, export — the shared brain, one OPFS store for all tabs',
          github: 'repo checkout into FILES and push back over the GitHub API (github_checkout/push/open_pr)',
          local: 'sync a real local folder in/out of FILES (desktop Chrome/Edge)',
          fleet: 'spawn agent tabs, message them (fleet_send/inbox), collect results (fleet_status/report)',
          ui: 'operate creel itself, in ANY tab: ui_tabs lists the live tabs; every other ui_ tool takes `tab` to act on one of them. Locate controls the Playwright way — {ref} from ui_snapshot, or {role,name} — and every action auto-waits for its target. Describe, snapshot, switch model/provider, toggle servers, open panels, read the transcript, prompt the chat, stop the run, click/fill/type/press/hover/check/select',
          browser: 'drive cross-origin websites through the creel bridge extension, with the SAME locator vocabulary the ui tools use — the bridge injects the same engine into the far page. Absent the extension only browser_status exists',
          state: 'creel\'s own durable state in a private GitHub repo the operator owns: state_push writes config, conversations, skills, memory and the quipu .db as ONE commit (content-addressed, only what changed); state_pull restores them. Refuses a public repo; carries API keys only on an explicit opt-in WITH a passphrase',
          bd: 'the issue tracker, byte-compatible with the .beads/ JSONL tracker in the repo (bd_ready/list/show/create/update/close)',
          measurement: 'the grounding measurement suite: does local knowledge make a cheap model a viable agent (bench_tasks/grade/record/report)',
        }[s.name] || 'in-page tool server',
      }));

      await call('quipu_episode', {
        name: WORLD_VERSION,
        episode_body: `The creel world model (${WORLD_VERSION}${priorVersions.length ? `, superseding ${priorVersions.join(', ')}` : ''}): how this system is organized, written for its own agents. `
          + 'creel is a static browser page running agent loops. There is always exactly ONE root pane '
          + '(the dispatcher, elected by Web Lock, badge ⬢): it spawns bobbins (agent tabs), seeds and owns this '
          + 'world model, and synthesizes results. Bobbins work one task, coordinate via fleet_send, and MUST '
          + 'finish by calling fleet_report. All tabs share one quipu store (leader-elected OPFS host) — '
          + 'knowledge written anywhere is instantly visible everywhere; record durable findings as quipu episodes. '
          + 'creel is operable by its agents to the same depth as by its operator. The ui tools drive the interface '
          + 'of ANY creel tab, not just your own: ui_tabs lists the live tabs, and every other ui_ tool takes a `tab` '
          + 'argument (tab id, agent id, label, or "root") — so you can inspect a peer bobbin, read its transcript, '
          + 're-point its provider, type into its chat (ui_prompt) or stop it, exactly as the human could by '
          + 'switching windows. Beyond creel, the browser tools drive real cross-origin websites when the creel '
          + 'bridge extension is installed (browser_status says whether it is). Every click and input flashes a '
          + 'highlight (orange = agent hands, cyan = human hands), so nothing an agent touches is invisible. '
          + 'Never guess a CSS selector: call ui_snapshot for the accessibility tree and act by {ref} or '
          + '{role, name}. Actions auto-wait for their target to be visible and enabled, so never sleep first; '
          + 'an ambiguous locator is an error listing the candidates, not a coin flip. '
          + 'CREDENTIALS ARE WRITE-ONLY: you CAN put an API key the operator gives you into the field that '
          + 'needs it (ui_fill, or ui_set_credential to persist a provider key), and you can never read one '
          + 'back — every snapshot and text read masks them. The other permanent limit is that a tab cannot '
          + 'prompt itself. Query this graph, not documentation, to understand the world.',
        source: 'creel-self',
        nodes: [
          { name: WORLD_VERSION, type: 'WorldModel', description: `versioned self-description marker; re-seeded only when the version bumps. THIS IS THE CURRENT VERSION${priorVersions.length ? `, superseding ${priorVersions.join(', ')} — those remain in the graph as history, and are not current` : ''}` },
          ...priorVersions.map((label) => ({ name: label, type: 'WorldModel', description: `superseded by ${WORLD_VERSION}; kept as history. Do not read it as current — follow supersedes forward` })),
          { name: 'root-pane', type: 'Role', description: 'the dispatcher: exactly one, Web-Lock elected among non-agent tabs, survives tab death by takeover; spawns and synthesizes' },
          { name: 'bobbin', type: 'Role', description: 'a spawned agent tab: one task, autonomous, reports via fleet_report, coordinates via fleet_send' },
          { name: 'shared-brain', type: 'Subsystem', description: 'one OPFS quipu store for all tabs; leader tab hosts, others RPC over BroadcastChannel; leader death → takeover with data intact' },
          { name: 'files-panel', type: 'Surface', description: 'the VFS workspace agents edit; github/local servers move it to durable storage' },
          { name: 'graph-explorer', type: 'Surface', description: '◉ graph button: visual view of this very store (force layout, SPARQL, entity history)' },
          { name: 'fleet-dashboard', type: 'Surface', description: '🧺 fleet button: live agent list, results, comms log, manual spawn' },
          { name: 'cross-tab-hands', type: 'Capability', description: 'the ui_ tools take a `tab` argument and route over the creel-ui BroadcastChannel, so any tab can operate any other tab\'s interface — parity with the operator, who could just switch windows' },
          { name: 'locator-engine', type: 'Subsystem', description: 'creel-locator.js: Playwright\'s model in the page — ARIA roles, accessible names, [ref] handles, strict resolution (ambiguity is an error), and auto-waiting on every action. The same file is injected into cross-origin pages by the bridge, so one vocabulary drives both' },
          { name: 'durability', type: 'Policy', description: 'NOTHING in creel is durable by default. The VFS, conversations and this very graph live in browser storage, which is evictable and exists on no other machine. Work leaves by exactly three doors: github_push for code, state_push for creel\'s own state (one commit to a private repo the operator owns — config, conversations, skills, memory, and this graph as .db bytes), and quipu episodes for durable facts. A result that went through none of them is not saved, however finished it looks' },
          { name: 'state-repo', type: 'Subsystem', description: 'the durable home: a PRIVATE GitHub repo (default <login>/creel-state) holding a manifest plus content-addressed objects and blobs. Reuses the v2 sync engine — hash dedup, AES-GCM envelope — over a GitHub transport that stages writes and flushes them as one commit. Refuses a repo GitHub reports as public, re-checked on every push, because this data can include keys' },
          { name: 'credential-asymmetry', type: 'Policy', description: 'an agent may WRITE a credential the operator hands it (ui_fill, ui_set_credential) and may never READ one: snapshots mark such fields write-only, results report a length not a value, ui_describe reports only whether a key exists' },
          { name: 'device-awareness', type: 'Capability', description: 'the harness classifies the device (creel-device.js) and caps concurrent agent tabs at 3 mobile / 4 tablet / 8 desktop — mobile browsers evict background tabs; fleet_device reports the class and free slots, fleet_spawn/fleet_spawn_workers clamp to free slots and report the rest `capped`, the 🧺 fleet dashboard shows a live `📱 mobile · 2/3 tabs` chip' },
          { name: 'fleet-visibility', type: 'Capability', description: 'every fleet transition (claimed/done/failed/requeued/aborted) is appended to a shared work log (meta:digest) and the main tab automatically receives a batched 🧺 FLEET DIGEST message in its conversation; fleet_digest returns the full log, fleet_status rows carry task text + heartbeat age — all fleet work is visible to the operator\'s agent without polling' },
          { name: 'web-hands', type: 'Capability', description: 'the browser_ tools drive cross-origin websites via the creel bridge Chrome extension (MV3). Opt-in: without the extension only browser_status exists. The bridge refuses to act on creel\'s own origins — that is the ui server\'s job' },
          ...serverNodes,
        ],
        edges: [
          { source: 'root-pane', target: 'bobbin', relation: 'dispatches' },
          { source: 'bobbin', target: 'cross-tab-hands', relation: 'wields' },
          { source: 'root-pane', target: 'cross-tab-hands', relation: 'wields' },
          { source: 'bobbin', target: 'web-hands', relation: 'wields' },
          { source: 'cross-tab-hands', target: 'locator-engine', relation: 'built_on' },
          { source: 'web-hands', target: 'locator-engine', relation: 'built_on' },
          { source: 'locator-engine', target: 'credential-asymmetry', relation: 'enforces' },
          { source: 'state-repo', target: 'durability', relation: 'enforces' },
          { source: 'shared-brain', target: 'state-repo', relation: 'persists_to' },
          { source: 'files-panel', target: 'state-repo', relation: 'persists_to' },
          { source: 'bobbin', target: 'durability', relation: 'bound_by' },
          { source: 'root-pane', target: 'durability', relation: 'bound_by' },
          { source: 'root-pane', target: WORLD_VERSION, relation: 'maintains' },
          ...priorVersions.map((label) => ({ source: WORLD_VERSION, target: label, relation: 'supersedes' })),
          { source: 'bobbin', target: 'shared-brain', relation: 'grounds_in' },
          { source: 'root-pane', target: 'shared-brain', relation: 'grounds_in' },
          { source: 'graph-explorer', target: 'shared-brain', relation: 'renders' },
          ...serverNodes.map((n) => ({ source: n.name, target: 'root-pane', relation: 'serves' })),
        ],
      });
      console.log('creel: world model seeded into quipu', WORLD_VERSION);
    } catch (e) {
      console.warn('creel: world model seeding failed (will retry next root election)', e);
    }
  }

  // Exposed for tests and for an operator re-seeding after clearing a store.
  CreelSelf.seedWorldModel = seedWorldModel;

  function start() {
    CreelUi.registerDefaults();
    electRoot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();