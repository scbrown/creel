/* creel — beads-compatible issue store (creel-9wn).
 *
 * A tiny, zero-dependency implementation of the beads JSONL wire format so
 * creel agents and sandboxes can track work with the same semantics as the
 * `bd` CLI, without Dolt: ids `creel-xxx`, statuses open/in_progress/closed,
 * priorities, and a field_change audit log in interactions.jsonl.
 *
 * The store is deliberately environment-agnostic. I/O goes through an
 * adapter with readText(path) / writeText(path, text) — the in-page backend
 * passes one backed by the harness VFS (localStorage fallback), the Node CLI
 * and tests pass one backed by real fs. Files written are byte-compatible
 * with beads' passive export, so `bd dolt push/pull` remains the sync path
 * wherever the real CLI is available.
 *
 * UMD: `window.BeadsStore` in the browser, `module.exports` in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BeadsStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ID_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const STATUSES = ['open', 'in_progress', 'closed'];
  const ISSUE_TYPES = ['bug', 'feature', 'task'];
  const DEFAULT_ACTOR = 'Claude';

  function nowIso(ms = false) {
    const s = new Date().toISOString();
    return ms ? s : s.replace(/\.\d{3}Z$/, 'Z');
  }
  function randHex(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  /** Generate a fresh `<prefix>-xxx` id, avoiding collisions with existing ones. */
  function nextId(prefix, existing) {
    const taken = new Set(existing);
    let id;
    do {
      let suffix = '';
      for (let i = 0; i < 3; i++) suffix += ID_CHARSET[Math.floor(Math.random() * ID_CHARSET.length)];
      id = `${prefix}-${suffix}`;
    } while (taken.has(id));
    return id;
  }

  function parseJsonl(text) {
    if (!text) return [];
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    return out;
  }
  function serializeJsonl(records) {
    return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  }

  class BeadsStore {
    /**
     * @param {object} opts
     * @param {{readText(path): Promise<string>, writeText(path, text): Promise<void>}} opts.adapter
     * @param {string} [opts.prefix='creel']  issue id prefix
     * @param {string} [opts.actor]           default audit actor (BEADS_ACTOR / --actor override)
     */
    constructor({ adapter, prefix = 'creel', actor = DEFAULT_ACTOR }) {
      if (!adapter || typeof adapter.readText !== 'function') {
        throw new Error('BeadsStore requires an adapter with readText/writeText');
      }
      this.adapter = adapter;
      this.prefix = prefix;
      this.defaultActor = actor || DEFAULT_ACTOR;
      this.issues = [];
      this.interactions = [];
      this.issuesPath = '.beads/issues.jsonl';
      this.interactionsPath = '.beads/interactions.jsonl';
    }

    async load() {
      const [issuesText, interText] = await Promise.all([
        this.adapter.readText(this.issuesPath),
        this.adapter.readText(this.interactionsPath),
      ]);
      this.issues = parseJsonl(issuesText);
      this.interactions = parseJsonl(interText);
      return this;
    }

    async save() {
      await Promise.all([
        this.adapter.writeText(this.issuesPath, serializeJsonl(this.issues)),
        this.adapter.writeText(this.interactionsPath, serializeJsonl(this.interactions)),
      ]);
    }

    // ── reads ─────────────────────────────────────────────────────────
    get(id) { return this.issues.find((i) => i.id === id) || null; }

    list({ status, type, priority, limit } = {}) {
      let out = this.issues.slice();
      if (status) out = out.filter((i) => i.status === status);
      if (type) out = out.filter((i) => i.issue_type === type);
      if (priority != null) out = out.filter((i) => i.priority === Number(priority));
      out = out.sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (limit != null) out = out.slice(0, Number(limit));
      return out;
    }

    /** bd ready: open issues, highest priority (1) first, then oldest. */
    ready({ limit } = {}) {
      let out = this.issues
        .filter((i) => i.status === 'open')
        .sort((a, b) => (a.priority - b.priority) || a.created_at.localeCompare(b.created_at));
      if (limit != null) out = out.slice(0, Number(limit));
      return out;
    }

    // ── writes ────────────────────────────────────────────────────────
    async create({ title, description = '', acceptance_criteria = '', priority = 2, issue_type = 'task', actor } = {}) {
      if (!title || !String(title).trim()) throw new Error('title is required');
      const p = Number(priority);
      if (![1, 2, 3].includes(p)) throw new Error(`priority must be 1..3, got ${priority}`);
      if (!ISSUE_TYPES.includes(issue_type)) throw new Error(`issue_type must be one of ${ISSUE_TYPES.join('/')}, got ${issue_type}`);
      const who = actor || this.defaultActor;
      const now = nowIso();
      const id = nextId(this.prefix, this.issues.map((i) => i.id));
      const rec = {
        _type: 'issue',
        id,
        title: String(title).trim(),
        description,
        acceptance_criteria,
        status: 'open',
        priority: p,
        issue_type,
        owner: 'noreply@anthropic.com',
        created_at: now,
        created_by: who,
        updated_at: now,
        dependency_count: 0,
        dependent_count: 0,
        comment_count: 0,
      };
      this.issues.push(rec);
      this._log(rec.id, 'created', null, rec.title, who);
      await this.save();
      return rec;
    }

    /**
     * Patch an issue. Records one field_change interaction per changed field.
     * status transitions: open→in_progress stamps started_at; →closed stamps
     * closed_at + close_reason (from `reason`).
     */
    async update(id, patch = {}, { actor, reason } = {}) {
      const rec = this.get(id);
      if (!rec) throw new Error(`no such issue: ${id}`);
      const who = actor || this.defaultActor;
      let changed = false;

      const set = (field, value) => {
        const old = rec[field];
        if (old === value) return;
        rec[field] = value;
        this._log(id, field, old, value, who, reason);
        changed = true;
      };

      if (patch.status != null) {
        if (!STATUSES.includes(patch.status)) throw new Error(`status must be one of ${STATUSES.join('/')}, got ${patch.status}`);
        set('status', patch.status);
        if (patch.status === 'in_progress' && !rec.started_at) rec.started_at = nowIso();
        if (patch.status === 'closed') {
          rec.closed_at = nowIso();
          if (reason) rec.close_reason = reason;
        }
        if (patch.status !== 'closed' && rec.closed_at) { delete rec.closed_at; delete rec.close_reason; }
      }
      if (patch.priority != null) {
        const p = Number(patch.priority);
        if (![1, 2, 3].includes(p)) throw new Error(`priority must be 1..3, got ${patch.priority}`);
        set('priority', p);
      }
      if (patch.title != null) set('title', String(patch.title).trim());
      if (patch.description != null) set('description', String(patch.description));
      if (patch.acceptance_criteria != null) set('acceptance_criteria', String(patch.acceptance_criteria));
      if (patch.issue_type != null) {
        if (!ISSUE_TYPES.includes(patch.issue_type)) throw new Error(`issue_type must be one of ${ISSUE_TYPES.join('/')}`);
        set('issue_type', patch.issue_type);
      }
      if (patch.owner != null) set('owner', String(patch.owner));

      if (!changed) return rec;
      rec.updated_at = nowIso();
      await this.save();
      return rec;
    }

    async claim(id, { actor } = {}) {
      return this.update(id, { status: 'in_progress' }, { actor });
    }

    async close(id, { actor, reason = '' } = {}) {
      return this.update(id, { status: 'closed' }, { actor, reason });
    }

    // ── audit ─────────────────────────────────────────────────────────
    _log(issueId, field, oldValue, newValue, actor, reason) {
      const extra = { field, new_value: newValue, old_value: oldValue === undefined ? null : oldValue };
      if (reason) extra.reason = reason;
      this.interactions.push({
        id: 'int-' + randHex(32),
        kind: 'field_change',
        created_at: nowIso(true),
        actor: actor || this.defaultActor,
        issue_id: issueId,
        extra,
      });
    }
  }

  // ── adapters ────────────────────────────────────────────────────────
  /** In-memory adapter — for tests and browsers without a checkout. */
  BeadsStore.memoryAdapter = function () {
    const files = new Map();
    return {
      async readText(p) { return files.get(p) || ''; },
      async writeText(p, t) { files.set(p, t); },
    };
  };

  /** Real-fs adapter — for the CLI and tests. `dir` is the repo root (parent of .beads/). */
  BeadsStore.nodeAdapter = function (dir) {
    const fs = require('fs');
    const path = require('path');
    return {
      async readText(p) {
        const full = path.join(dir, p);
        try { return fs.readFileSync(full, 'utf8'); } catch { return ''; }
      },
      async writeText(p, t) {
        const full = path.join(dir, p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, t, 'utf8');
      },
    };
  };

  BeadsStore.STATUSES = STATUSES;
  BeadsStore.ISSUE_TYPES = ISSUE_TYPES;
  return BeadsStore;
});
