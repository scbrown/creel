/* creel — state persistence to a private GitHub repo (creel-3ru).
 *
 * creel keeps everything in localStorage, IndexedDB and OPFS. All three are
 * evictable, none of them follow the operator to another machine, and OPFS in
 * particular is the only home the quipu graph has. This module gives that
 * state somewhere durable that the operator owns: a private repo, theirs, one
 * commit per push.
 *
 * It is not a second sync engine. The v2 engine in onepagent.html is already
 * the right shape — a manifest naming content-addressed objects and blobs, an
 * AES-GCM envelope, hash dedup so a push uploads only what changed — and only
 * its transport was S3-shaped. This module is the other transport, plugged in
 * at the seam (_syncBackend), plus the config, the connection, and a state_*
 * tool surface so an agent can drive it.
 *
 * WHAT MAKES THIS ONE ALLOWED TO CARRY KEYS. The S3 path strips credentials
 * unconditionally, and rightly: a bucket is a shared surface. A private repo
 * the operator administers is a different destination, and "my keys follow me
 * to a new browser" is the thing this feature exists for. It is still not a
 * default — _syncCarriesSecrets demands both an explicit opt-in and a
 * passphrase, and this module refuses outright to push to a repo GitHub
 * reports as public. The passphrase lives in localStorage next to the keys it
 * protects: it defends the bytes at rest in the repo, not against someone who
 * already has the browser profile, and nothing here pretends otherwise.
 *
 * ONE PUSH, ONE COMMIT. A push writes hundreds of objects. The Contents API
 * would make that hundreds of commits, which turns the repo's history into
 * noise and the operator's ability to read it into nothing. So `put` stages
 * into a tree and `commit` flushes it through the Git Data API — blobs, one
 * tree on base_tree, one commit, one ref update.
 */
(function () {
  'use strict';

  const API = 'https://api.github.com';
  const CFG_KEY = 'creel_state_repo';
  /* The same fine-grained PAT github-backend.js holds: one GitHub identity per
   * browser, entered once. That backend owns the entry path (a prompt, never
   * chat, never the model); this one reads the result. */
  const TOKEN_KEY = 'creel_github_pat';
  const DEFAULT_REPO = 'creel-state';
  const DEFAULT_BRANCH = 'main';
  const DEFAULT_PREFIX = 'state';

  const enc = new TextEncoder();

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; }
  }
  function saveCfg(cfg) {
    if (cfg) localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CFG_KEY);
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || '').replace(/\s/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  async function gh(path, opts = {}) {
    const t = token();
    if (!t) throw new Error('no GitHub token — run github_connect (the state repo uses the same PAT)');
    const resp = await fetch(API + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${t}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json()).message || ''; } catch { /* opaque */ }
      const err = new Error(`GitHub ${opts.method || 'GET'} ${path}: ${resp.status} ${detail}`);
      err.status = resp.status;
      throw err;
    }
    return resp.status === 204 ? null : resp.json();
  }

  function repoSlug(cfg) { return `${cfg.owner}/${cfg.repo}`; }

  /** The prefix a given scope writes under. The shared scope is the operator's
   *  own state; an agent scope is one tab's slice, addressed by its id so two
   *  tabs cannot overwrite each other (creel-age builds on this). */
  function scopePrefix(cfg, scope) {
    const base = (cfg.prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');
    if (!scope || scope === 'shared') return base;
    return `${base}/agents/${String(scope).replace(/[^A-Za-z0-9_-]/g, '')}`;
  }

  /* ── Repository facts ──────────────────────────────────────────── */

  /** Verify the destination before anything is written to it: it must exist,
   *  we must be able to push to it, and it must be private. The last check is
   *  the one that matters — this repo may hold credentials, and a repo that
   *  flipped to public should stop the push, not discover it afterwards. */
  async function verifyRepo(cfg) {
    let meta;
    try {
      meta = await gh(`/repos/${repoSlug(cfg)}`);
    } catch (e) {
      if (e.status === 404) {
        throw new Error(`state repo ${repoSlug(cfg)} not found (or the token cannot see it). `
          + 'Create it as a PRIVATE repo, or grant the token access to it, then retry.');
      }
      throw e;
    }
    if (meta.private !== true) {
      throw new Error(`refusing to use ${repoSlug(cfg)} as a state repo: GitHub reports it as PUBLIC. `
        + 'creel state can contain API keys and your whole conversation history. '
        + 'Make the repository private, or point creel at one that is.');
    }
    if (meta.permissions && meta.permissions.push === false) {
      throw new Error(`the token cannot push to ${repoSlug(cfg)} — it needs Contents: read/write on that repo.`);
    }
    return {
      slug: meta.full_name,
      private: true,
      defaultBranch: meta.default_branch || DEFAULT_BRANCH,
    };
  }

  /* ── The transport ─────────────────────────────────────────────── */

  /* One live transport per push/pull, memoized: the engine asks for a backend
   * on every get and put, and a fresh object each time would throw away the
   * staged tree between the first object and the commit. */
  let live = null;

  /* The scope the CURRENT operation is running under (creel-age). The sync
   * engine reads its config through syncConfig() with no arguments, from deep
   * inside a push, so the scope cannot be threaded through as a parameter —
   * it is set for the duration of one operation and cleared after. */
  let activeScope = null;

  /** This tab's own slice id. A spawned bobbin keeps its fleet agent id across
   *  reloads; an ordinary tab uses the id creel-self.js holds in
   *  sessionStorage. Either way it is stable for the life of the tab, which is
   *  what makes the slice worth writing. */
  function tabScope() {
    const self = window.CreelSelf;
    if (self && (self.agentId || self.tabId)) return self.agentId || self.tabId;
    try { return sessionStorage.getItem('creel_tab_id') || null; } catch { return null; }
  }

  function makeTransport(cfg) {
    const slug = repoSlug(cfg);
    const branch = cfg.branch || DEFAULT_BRANCH;
    const staged = new Map();      // path -> Uint8Array
    let headPromise = null;        // { commitSha, treeSha } | null for an empty repo
    let treePromise = null;        // path -> blob sha

    async function headCommit() {
      if (!headPromise) {
        headPromise = (async () => {
          try {
            const ref = await gh(`/repos/${slug}/git/ref/heads/${branch}`);
            const commit = await gh(`/repos/${slug}/git/commits/${ref.object.sha}`);
            return { commitSha: commit.sha, treeSha: commit.tree.sha };
          } catch (e) {
            // A repo with no commits on this branch yet: the first push
            // creates it, so there is no head and no base tree.
            if (e.status === 404 || e.status === 409) return null;
            throw e;
          }
        })();
      }
      return headPromise;
    }

    /* One recursive tree listing per operation instead of a 404-probe per key.
     * A pull asks after hundreds of hashes it may not have; asking GitHub once
     * what the repo contains is both faster and kinder to the rate limit. */
    async function tree() {
      if (!treePromise) {
        treePromise = (async () => {
          const h = await headCommit();
          const map = new Map();
          if (!h) return map;
          const t = await gh(`/repos/${slug}/git/trees/${h.treeSha}?recursive=1`);
          for (const e of t.tree || []) if (e.type === 'blob') map.set(e.path, e.sha);
          if (t.truncated) {
            console.warn('creel state: the repo tree listing was truncated by GitHub — '
              + 'some objects may re-upload. State stays correct; the push is just larger.');
          }
          return map;
        })();
      }
      return treePromise;
    }

    return {
      async get(key) {
        // A key written earlier in this same operation reads back from the
        // staging area: the engine must see its own writes even though the
        // commit has not happened yet.
        if (staged.has(key)) return staged.get(key);
        const map = await tree();
        const sha = map.get(key);
        if (!sha) return null;
        const blob = await gh(`/repos/${slug}/git/blobs/${sha}`);
        return blob.encoding === 'base64' ? b64ToBytes(blob.content) : enc.encode(blob.content || '');
      },

      async put(key, body) {
        staged.set(key, body instanceof Uint8Array ? body : enc.encode(String(body)));
      },

      async head(key) {
        if (staged.has(key)) return { etag: null, lastModified: null };
        const map = await tree();
        return map.has(key) ? { etag: map.get(key), lastModified: null } : null;
      },

      /** Flush every staged write as one commit. Returns the commit sha, or
       *  null when there was nothing to write. */
      async commit(message) {
        if (!staged.size) { headPromise = null; treePromise = null; return null; }
        const base = await headCommit();

        const treeEntries = [];
        for (const [path, bytes] of staged) {
          const blob = await gh(`/repos/${slug}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({ content: bytesToB64(bytes), encoding: 'base64' }),
          });
          treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
        }

        const newTree = await gh(`/repos/${slug}/git/trees`, {
          method: 'POST',
          body: JSON.stringify(base
            ? { base_tree: base.treeSha, tree: treeEntries }
            : { tree: treeEntries }),
        });
        const newCommit = await gh(`/repos/${slug}/git/commits`, {
          method: 'POST',
          body: JSON.stringify({
            message: message || 'creel state',
            tree: newTree.sha,
            parents: base ? [base.commitSha] : [],
          }),
        });

        const refPath = `/repos/${slug}/git/refs/heads/${branch}`;
        try {
          await gh(refPath, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
        } catch (e) {
          if (e.status === 404 || e.status === 422) {
            await gh(`/repos/${slug}/git/refs`, {
              method: 'POST',
              body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
            });
          } else if (e.status === 409) {
            throw new Error('the state branch moved under this push (another tab or machine pushed first). '
              + 'Pull, then push again.');
          } else throw e;
        }

        // The next operation must not reuse this one's view of the repo.
        staged.clear();
        headPromise = null;
        treePromise = null;
        return newCommit.sha;
      },
    };
  }

  /* ── The module surface ────────────────────────────────────────── */

  const CreelState = {
    /** Configured enough to attempt a sync. */
    isConfigured() {
      const c = loadCfg();
      return !!(c && c.owner && c.repo && token());
    },

    /** Configured AND chosen as the destination. The S3 backend stays the
     *  default for anyone who already uses it; this one takes over only when
     *  the operator turned it on. */
    isActive() {
      const c = loadCfg();
      return !!(c && c.enabled && c.owner && c.repo);
    },

    /** The config the sync engine reads: prefix and passphrase like the S3
     *  one, plus the backend tag that selects this transport. */
    syncConfig(scope) {
      const c = loadCfg() || {};
      const want = scope || activeScope || c.scope;
      return {
        backend: 'github',
        owner: c.owner || '',
        repo: c.repo || DEFAULT_REPO,
        branch: c.branch || DEFAULT_BRANCH,
        prefix: scopePrefix(c, want),
        passphrase: c.passphrase || '',
        includeSecrets: !!c.includeSecrets,
      };
    },

    transport(cfg) {
      const want = `${cfg.owner}/${cfg.repo}@${cfg.branch}`;
      if (!live || live.key !== want) live = { key: want, t: makeTransport(cfg) };
      return live.t;
    },

    /** Drop the memoized transport so the next operation re-reads the repo. */
    reset() { live = null; },

    /** This tab's slice id, or null when there is no stable identity yet. */
    tabScope,

    /** Run one operation under a scope. 'shared' (default) is the operator's
     *  own state; 'agent' is this tab's slice, so two tabs can hold divergent
     *  state without either clobbering the other. */
    async withScope(scope, fn) {
      const resolved = scope === 'agent' ? tabScope() : (scope === 'shared' ? null : scope);
      if (scope === 'agent' && !resolved) {
        throw new Error('this tab has no stable id yet, so it has no slice to write — retry once the page has finished loading');
      }
      const prev = activeScope;
      activeScope = resolved;
      live = null;                    // a different prefix is a different tree
      try { return await fn(); } finally { activeScope = prev; live = null; }
    },

    /** The authenticated login — used to fill in an owner the operator left
     *  blank rather than refusing over a field only GitHub can answer. */
    async verifyLogin() {
      const me = await gh('/user');
      return me.login;
    },

    loadCfg,
    saveCfg,
    verifyRepo,
    defaults: { repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, prefix: DEFAULT_PREFIX },
  };

  /* ── Tools ─────────────────────────────────────────────────────── */

  const TOOLS = [
    {
      name: 'state_status',
      description: 'Report where creel persists its state: whether a state repo is configured and active, '
        + 'which repo and branch, whether credentials are included, and when the last sync happened. '
        + 'Never reveals the token or the passphrase.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'state_configure',
      description: 'Point creel at a PRIVATE GitHub repo for durable state (config, provider settings, '
        + 'conversations, skills, memory, and the quipu knowledge graph). Verifies the repo exists, is '
        + 'private, and is pushable before saving. Does not push — call state_push after.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'GitHub owner. Defaults to the authenticated login.' },
          repo: { type: 'string', description: `Repository name (default: ${DEFAULT_REPO}). Must be private.` },
          branch: { type: 'string', description: `Branch to keep state on (default: ${DEFAULT_BRANCH}).` },
          prefix: { type: 'string', description: `Path prefix inside the repo (default: ${DEFAULT_PREFIX}).` },
          enabled: { type: 'boolean', description: 'Make this the active state destination. Default true.' },
          include_secrets: {
            type: 'boolean',
            description: 'Sync API keys as well. Requires a passphrase to be set. Off by default — '
              + 'this sends credentials to the repo, so the operator must ask for it.',
          },
        },
        required: [],
      },
    },
    {
      name: 'state_push',
      description: 'Push the current state to the configured state repo as a single commit. '
        + 'Incremental: only objects and blobs the repo does not already have are uploaded.',
      inputSchema: { type: 'object', properties: {
          scope: {
            type: 'string',
            enum: ['shared', 'agent'],
            description: "shared (default) = the operator's own state. agent = THIS TAB's slice, "
              + 'kept under agents/<tab-id>/ so two agent tabs can hold divergent state without '
              + 'overwriting each other or the shared store.',
          },
      }, required: [] },
    },
    {
      name: 'state_pull',
      description: 'Restore state from the state repo, replacing local conversations, skills, settings and '
        + 'the quipu graph with the pushed ones. Local API keys are never overwritten by a pull.',
      inputSchema: { type: 'object', properties: {
          scope: {
            type: 'string',
            enum: ['shared', 'agent'],
            description: "shared (default) = the operator's own state. agent = THIS TAB's slice, "
              + 'kept under agents/<tab-id>/ so two agent tabs can hold divergent state without '
              + 'overwriting each other or the shared store.',
          },
      }, required: [] },
    },
  ];

  const impl = {
    async state_status() {
      const c = loadCfg();
      const last = Number(localStorage.getItem('ba_s3_last_sync') || 0);
      if (!c || !c.owner || !c.repo) {
        return {
          configured: false,
          hasToken: !!token(),
          hint: `no state repo configured — call state_configure (default repo name: ${DEFAULT_REPO}). `
            + (token() ? '' : 'A GitHub PAT is needed first: run github_connect.'),
        };
      }
      return {
        configured: true,
        active: CreelState.isActive(),
        repo: repoSlug(c),
        branch: c.branch || DEFAULT_BRANCH,
        prefix: scopePrefix(c, c.scope),
        encrypted: !!c.passphrase,
        includesSecrets: !!(c.includeSecrets && c.passphrase),
        // Say plainly why an opt-in that was asked for is not in force.
        secretsBlockedReason: c.includeSecrets && !c.passphrase
          ? 'include_secrets is on but no passphrase is set, so keys are NOT being synced'
          : undefined,
        hasToken: !!token(),
        lastSync: last ? new Date(last).toISOString() : null,
        // What `scope: "agent"` would resolve to from THIS tab.
        agentSlice: tabScope() ? scopePrefix(c, tabScope()) : null,
      };
    },

    async state_configure(args) {
      if (!token()) throw new Error('connect GitHub first (github_connect) — the state repo uses the same PAT');
      const prev = loadCfg() || {};
      let owner = args.owner || prev.owner;
      if (!owner) {
        const me = await gh('/user');
        owner = me.login;
      }
      const cfg = {
        ...prev,
        owner,
        repo: args.repo || prev.repo || DEFAULT_REPO,
        branch: args.branch || prev.branch || DEFAULT_BRANCH,
        prefix: args.prefix || prev.prefix || DEFAULT_PREFIX,
        enabled: args.enabled !== false,
        includeSecrets: args.include_secrets === undefined ? !!prev.includeSecrets : !!args.include_secrets,
      };
      const facts = await verifyRepo(cfg);
      saveCfg(cfg);
      CreelState.reset();
      return {
        configured: true,
        repo: facts.slug,
        branch: cfg.branch,
        prefix: scopePrefix(cfg, cfg.scope),
        private: true,
        active: cfg.enabled,
        includesSecrets: !!(cfg.includeSecrets && cfg.passphrase),
        note: cfg.includeSecrets && !cfg.passphrase
          ? 'include_secrets is set but no passphrase is configured, so keys will NOT be pushed. '
            + 'Set a sync passphrase in Settings to enable it.'
          : undefined,
      };
    },

    async state_push(args) {
      if (!CreelState.isConfigured()) throw new Error('no state repo configured — call state_configure first');
      return CreelState.withScope(args.scope, async () => {
        const cfg = CreelState.syncConfig();
        // Re-verify every push: a repo can be flipped to public after setup,
        // and the check is worth nothing if it only runs once.
        await verifyRepo(cfg);
        const manifest = await pushSnapshotToS3(true);
        return {
          pushed: true,
          repo: repoSlug(cfg),
          branch: cfg.branch,
          scope: args.scope || 'shared',
          prefix: cfg.prefix,
          conversations: (manifest.conversations || []).length,
          skills: (manifest.skills || []).length,
          blobs: (manifest.blobs || []).length,
          quipu: manifest.quipu ? { bytes: manifest.quipu.size } : null,
          encrypted: !!manifest.encrypted,
        };
      });
    },

    async state_pull(args) {
      if (!CreelState.isConfigured()) throw new Error('no state repo configured — call state_configure first');
      return CreelState.withScope(args.scope, async () => {
        await pullSnapshotFromS3();
        return { pulled: true, repo: repoSlug(loadCfg()), scope: args.scope || 'shared',
                 prefix: CreelState.syncConfig().prefix };
      });
    },
  };

  CreelState.handle = async function handle(body) {
    const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
    const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
    try {
      switch (body.method) {
        case 'initialize':
          return reply({
            protocolVersion: body.params?.protocolVersion || '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'state', version: '0' },
          });
        case 'notifications/initialized':
          return null;
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call': {
          const { name, arguments: args } = body.params || {};
          if (!impl[name]) return fail(`unknown tool: ${name}`);
          const result = await impl[name](args || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
        }
        default:
          return fail(`method not supported in-page: ${body.method}`);
      }
    } catch (e) {
      return fail(e && e.message ? e.message : String(e));
    }
  };

  CreelState.registerDefaults = function registerDefaults() {
    if (!window.CreelInpage) return;
    window.CreelInpage.register('inpage:state', CreelState);
    if (typeof mcpServers === 'undefined') return;
    if (!mcpServers.find((s) => s.id === 'mcp_state_inpage')) {
      mcpServers.push({
        id: 'mcp_state_inpage', name: 'state', type: 'inpage',
        url: 'inpage:state', token: '', corsProxy: '', enabled: true,
      });
      if (typeof saveMcpServers === 'function') saveMcpServers();
    }
    const server = mcpServers.find((s) => s.id === 'mcp_state_inpage');
    if (server && typeof mcpConnectServer === 'function') {
      mcpConnectServer(server).catch((e) => console.warn('state in-page MCP connect failed', e));
    }
    if (typeof renderMcpServerList === 'function') renderMcpServerList();
  };

  window.CreelState = CreelState;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelState.registerDefaults());
  } else {
    CreelState.registerDefaults();
  }
})();
