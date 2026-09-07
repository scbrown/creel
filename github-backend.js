/* creel — GitHub connector: checkout and push repos, entirely in the page.
 *
 * An in-page MCP server ('inpage:github') giving the agent repo tools over
 * the GitHub REST/Git Data API, which serves CORS to browser origins — so
 * no git binary, no smart-HTTP proxy, no server.
 *
 * Auth is a fine-grained Personal Access Token (Contents: read/write on the
 * repos you choose). GitHub's OAuth flows can't run from a static page (the
 * web flow needs a client secret; the device flow's endpoints send no CORS),
 * so the PAT follows creel's BYOK model: entered via a browser prompt —
 * never through chat, so it never reaches the LLM — and held in
 * localStorage only. Tool results never include it.
 *
 * Checkout materializes a commit's tree into the harness VFS (the FILES
 * panel the agent's file tools edit). Push diffs the VFS against the
 * checked-out blob shas (real git blob sha1s, computed with WebCrypto),
 * uploads changed blobs, builds a tree on base_tree, commits with the
 * checkout as parent, and fast-forwards (or creates) the target branch.
 */
(function () {
  'use strict';

  const API = 'https://api.github.com';
  const TOKEN_KEY = 'creel_github_pat';
  const STATE_KEY = 'creel_github_checkout';
  const MAX_BLOB = 20 * 1024 * 1024;

  const enc = new TextEncoder();

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

  // The token is shared (localStorage) so every spawned agent inherits it,
  // but the CHECKOUT is per-tab (sessionStorage) — this is the per-agent work
  // dir: two agents editing the same repo in different tabs keep independent
  // diff baselines instead of clobbering one shared checkout state.
  function loadState() {
    try { return JSON.parse(sessionStorage.getItem(STATE_KEY)) || null; } catch { return null; }
  }
  function saveState(s) {
    if (s) sessionStorage.setItem(STATE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STATE_KEY);
  }

  async function gh(path, opts = {}) {
    const t = token();
    if (!t) throw new Error('not connected — run github_connect first');
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

  function b64ToBytes(b64) {
    const bin = atob(b64.replace(/\n/g, ''));
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

  /** git blob sha1: sha1("blob <len>\0" + bytes). */
  async function gitBlobSha(bytes) {
    const header = enc.encode(`blob ${bytes.length}\0`);
    const buf = new Uint8Array(header.length + bytes.length);
    buf.set(header); buf.set(bytes, header.length);
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function asText(bytes) {
    try {
      const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return s.includes('\0') ? null : s;
    } catch { return null; }
  }

  function parseRepo(input, fallback) {
    const m = String(input || fallback || '').match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (!m) throw new Error(`cannot parse repo from ${JSON.stringify(input)}`);
    return `${m[1]}/${m[2]}`;
  }

  /** Every VFS file under `dest`, as [relPath, node] pairs. */
  function walkVfs(dest) {
    const rootNode = vfsResolve(dest);
    if (!rootNode || rootNode.type !== 'dir') return [];
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.children || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.type === 'dir') walk(child, p);
        else out.push([p, child]);
      }
    };
    walk(rootNode, '');
    return out;
  }

  async function nodeBytes(dest, rel, node) {
    if (node.binary) {
      const bytes = await vfsGetBinary(`${dest}/${rel}`);
      if (!bytes) throw new Error(`binary blob missing for ${rel}`);
      return bytes;
    }
    return enc.encode(node.content ?? '');
  }

  /** Diff the VFS under the checkout root against the checked-out shas. */
  async function computeChanges(state) {
    const present = new Map(walkVfs(state.dest));
    const changed = [];
    const added = [];
    const removed = [];
    for (const [rel, node] of present) {
      const base = state.files[rel];
      const bytes = await nodeBytes(state.dest, rel, node);
      const sha = await gitBlobSha(bytes);
      if (!base) added.push({ rel, bytes, sha });
      else if (base.sha !== sha) changed.push({ rel, bytes, sha, mode: base.mode });
    }
    for (const rel of Object.keys(state.files)) {
      if (!present.has(rel)) removed.push(rel);
    }
    return { changed, added, removed };
  }

  const TOOLS = [
    {
      name: 'github_connect',
      description: 'Connect GitHub via a fine-grained Personal Access Token (Contents read/write on the repos to use). Opens a browser prompt — the token never passes through chat. Verifies and reports the authenticated login.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'github_status',
      description: 'Report GitHub connection state and, when a repo is checked out, which VFS files changed/added/removed relative to the checkout.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'github_checkout',
      description: 'Check a repository commit out into the VFS (the FILES panel) for editing. Overwrites the destination directory.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name or GitHub URL' },
          ref: { type: 'string', description: 'branch, tag, or commit sha (default: the default branch)' },
          dest: { type: 'string', description: 'VFS directory to write into (default: /<repo-name>)' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'path prefixes to skip (e.g. ["app/wasm/pkg"])' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'github_push',
      description: 'Commit the VFS changes since checkout and push them to a branch (created if absent, fast-forwarded if it is the checked-out lineage). Then treats the new commit as the checkout base, so pushes stack.',
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'target branch name' },
          message: { type: 'string', description: 'commit message' },
        },
        required: ['branch', 'message'],
      },
    },
    {
      name: 'github_open_pr',
      description: 'Open a pull request on the checked-out repository.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          head: { type: 'string', description: 'source branch (e.g. the branch just pushed)' },
          base: { type: 'string', description: 'target branch (default: the default branch)' },
        },
        required: ['title', 'head'],
      },
    },
    {
      name: 'github_branches',
      description: 'List the checked-out repository\'s branches (name + head sha) — e.g. to discover the branches a burst\'s agents pushed before merging them.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'github_merge',
      description: 'THE BURST MERGE: merge one or more head branches into a base branch on the server (real three-way git merge with conflict detection). Each head is merged in turn; a conflicting head is reported, never silently dropped. Use at burst end to integrate the branch-per-agent work. Creates the base branch from the checkout commit if it does not exist.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'integration branch to merge into (created from the checkout commit if absent)' },
          heads: { type: 'array', items: { type: 'string' }, description: 'branches to merge in, in order (e.g. the agents\' branches)' },
          message: { type: 'string', description: 'merge commit message prefix (optional)' },
        },
        required: ['base', 'heads'],
      },
    },
  ];

  const impl = {
    async github_connect() {
      let t = token();
      const fresh = window.prompt(
        'GitHub fine-grained Personal Access Token (Contents: read/write).\n'
        + 'Stored in this browser’s localStorage only.'
        + (t ? '\n\nLeave empty to keep the current token.' : ''),
      );
      if (fresh) { localStorage.setItem(TOKEN_KEY, fresh.trim()); t = fresh.trim(); }
      if (!t) return { connected: false, hint: 'no token entered' };
      const user = await gh('/user');
      return { connected: true, login: user.login };
    },

    async github_status() {
      const out = { connected: false };
      if (token()) {
        try { out.login = (await gh('/user')).login; out.connected = true; }
        catch (e) { out.error = e.message; }
      }
      const state = loadState();
      if (state) {
        out.checkout = {
          repo: state.repo, ref: state.ref, commit: state.commitSha,
          dest: state.dest, files: Object.keys(state.files).length,
          excluded: state.excluded,
        };
        if (out.connected) {
          const { changed, added, removed } = await computeChanges(state);
          out.changes = {
            changed: changed.map((c) => c.rel),
            added: added.map((a) => a.rel),
            removed,
          };
        }
      }
      return out;
    },

    async github_checkout(args) {
      const repo = parseRepo(args.repo);
      const meta = await gh(`/repos/${repo}`);
      const ref = args.ref || meta.default_branch;
      const commit = await gh(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
      const tree = await gh(`/repos/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
      const dest = normPath(args.dest || `/${repo.split('/')[1]}`);
      const exclude = args.exclude || [];
      vfsDelete(dest, true);

      const blobs = tree.tree.filter((t) => t.type === 'blob');
      const skipped = [];
      const files = {};
      let written = 0;
      const queue = blobs.slice();
      const worker = async () => {
        for (;;) {
          const entry = queue.shift();
          if (!entry) return;
          if (exclude.some((p) => entry.path === p || entry.path.startsWith(p + '/'))
            || entry.size > MAX_BLOB) {
            skipped.push(entry.path);
            continue;
          }
          const blob = await gh(`/repos/${repo}/git/blobs/${entry.sha}`);
          const bytes = b64ToBytes(blob.content);
          const text = asText(bytes);
          if (text !== null) vfsWrite(`${dest}/${entry.path}`, text, true);
          else await vfsWriteBinary(`${dest}/${entry.path}`, bytes, true);
          files[entry.path] = { sha: entry.sha, mode: entry.mode };
          written++;
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      renderFileTree();

      saveState({
        repo, ref, dest, files,
        commitSha: commit.sha,
        treeSha: commit.commit.tree.sha,
        excluded: skipped,
        truncated: !!tree.truncated,
      });
      return {
        repo, ref, dest, commit: commit.sha, files: written,
        skipped, truncated: !!tree.truncated,
      };
    },

    async github_push(args) {
      const state = loadState();
      if (!state) throw new Error('nothing checked out — run github_checkout first');
      const { changed, added, removed } = await computeChanges(state);
      if (!changed.length && !added.length && !removed.length) {
        return { pushed: false, reason: 'no changes since checkout' };
      }

      const treeEntries = [];
      for (const item of [...changed, ...added]) {
        const blob = await gh(`/repos/${state.repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: bytesToB64(item.bytes), encoding: 'base64' }),
        });
        treeEntries.push({ path: item.rel, mode: item.mode || '100644', type: 'blob', sha: blob.sha });
      }
      for (const rel of removed) {
        treeEntries.push({ path: rel, mode: state.files[rel].mode || '100644', type: 'blob', sha: null });
      }

      const newTree = await gh(`/repos/${state.repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: state.treeSha, tree: treeEntries }),
      });
      const newCommit = await gh(`/repos/${state.repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: args.message, tree: newTree.sha, parents: [state.commitSha] }),
      });

      const refPath = `/repos/${state.repo}/git/refs/heads/${args.branch}`;
      try {
        await gh(refPath, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
      } catch (e) {
        if (e.status === 404 || e.status === 422) {
          await gh(`/repos/${state.repo}/git/refs`, {
            method: 'POST',
            body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: newCommit.sha }),
          });
        } else throw e;
      }

      for (const item of [...changed, ...added]) {
        state.files[item.rel] = { sha: item.sha, mode: item.mode || '100644' };
      }
      for (const rel of removed) delete state.files[rel];
      state.commitSha = newCommit.sha;
      state.treeSha = newTree.sha;
      saveState(state);

      return {
        pushed: true, branch: args.branch, commit: newCommit.sha,
        changed: changed.map((c) => c.rel), added: added.map((a) => a.rel), removed,
      };
    },

    async github_branches() {
      const state = loadState();
      if (!state) throw new Error('nothing checked out — run github_checkout first');
      const branches = await gh(`/repos/${state.repo}/branches?per_page=100`);
      return { repo: state.repo, branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha })) };
    },

    async github_merge(args) {
      const state = loadState();
      if (!state) throw new Error('nothing checked out — run github_checkout first');
      const heads = Array.isArray(args.heads) ? args.heads : [];
      if (!heads.length) throw new Error('no head branches to merge');

      // Ensure the integration base exists; create it from the checkout commit.
      const baseRef = `/repos/${state.repo}/git/refs/heads/${args.base}`;
      let created = false;
      try {
        await gh(baseRef);
      } catch (e) {
        if (e.status === 404) {
          await gh(`/repos/${state.repo}/git/refs`, {
            method: 'POST',
            body: JSON.stringify({ ref: `refs/heads/${args.base}`, sha: state.commitSha }),
          });
          created = true;
        } else throw e;
      }

      const results = [];
      for (const head of heads) {
        try {
          const merged = await gh(`/repos/${state.repo}/merges`, {
            method: 'POST',
            body: JSON.stringify({
              base: args.base,
              head,
              commit_message: `${args.message ? args.message + ' — ' : ''}creel burst merge: ${head} into ${args.base}`,
            }),
          });
          // 201 → a merge commit; the tool layer returns null for 204 (nothing to do).
          results.push({ head, merged: true, upToDate: merged === null, sha: merged?.sha });
        } catch (e) {
          if (e.status === 409) results.push({ head, merged: false, conflict: true, message: e.message });
          else if (e.status === 404) results.push({ head, merged: false, missing: true, message: e.message });
          else results.push({ head, merged: false, error: e.message });
        }
      }
      const conflicts = results.filter((r) => r.conflict).map((r) => r.head);
      return {
        base: args.base, baseCreated: created, results,
        merged: results.filter((r) => r.merged).length,
        conflicts,
        hint: conflicts.length
          ? `conflicts on: ${conflicts.join(', ')} — resolve on the branch (or open a PR) before re-merging; nothing was force-merged`
          : 'all heads integrated cleanly',
      };
    },

    async github_open_pr(args) {
      const state = loadState();
      if (!state) throw new Error('nothing checked out — run github_checkout first');
      const meta = await gh(`/repos/${state.repo}`);
      const pr = await gh(`/repos/${state.repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          title: args.title,
          body: args.body || '',
          head: args.head,
          base: args.base || meta.default_branch,
        }),
      });
      return { number: pr.number, url: pr.html_url };
    },
  };

  const CreelGitHub = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({
              protocolVersion: body.params?.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'github', version: '0' },
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
    },

    registerDefaults() {
      window.CreelInpage.register('inpage:github', this);
      if (typeof mcpServers === 'undefined') return;
      if (!mcpServers.find((s) => s.id === 'mcp_github_inpage')) {
        mcpServers.push({
          id: 'mcp_github_inpage', name: 'github', type: 'inpage',
          url: 'inpage:github', token: '', corsProxy: '', enabled: true,
        });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = mcpServers.find((s) => s.id === 'mcp_github_inpage');
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) => console.warn('github in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };

  window.CreelGitHub = CreelGitHub;
  /* Shared with local-backend.js (content hashing + text sniffing). */
  CreelGitHub.util = { gitBlobSha, asText, walkVfs, nodeBytes };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelGitHub.registerDefaults());
  } else {
    CreelGitHub.registerDefaults();
  }
})();
