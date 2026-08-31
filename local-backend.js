/* creel — local folder mode: edit a real directory on your machine.
 *
 * Uses the File System Access API (desktop Chromium — Chrome/Edge; Firefox
 * and Safari don't ship it), so the page itself can read/write a folder you
 * explicitly pick. The pick MUST happen from a user gesture, so this module
 * injects a "Local" button into the FILES panel; everything after the pick
 * is agent tools on the in-page MCP server 'inpage:local':
 *
 *   local_status    — support/permission/folder/sync state
 *   local_sync_in   — copy the folder into the VFS for the agent to edit
 *   local_sync_out  — write changed/new VFS files back to the real folder
 *   local_forget    — drop the folder handle and sync state
 *
 * Sync model (matches the harness's Pyodide/NodeExec conventions): explicit
 * in/out with change detection by content hash, never a live mount. Nothing
 * on disk is deleted unless local_sync_out is called with delete_missing.
 * The folder handle persists in IndexedDB; re-granting permission after a
 * reload is the same "Local" button (browsers require a gesture for that
 * too).
 */
(function () {
  'use strict';

  const DB_NAME = 'creel_local';
  const DEFAULT_EXCLUDE = ['.git', 'node_modules', '__pycache__', 'target', '.venv'];
  const MAX_FILE = 20 * 1024 * 1024;

  let dirHandle = null;
  let syncState = null; // { dest, files: { rel: sha } }

  const util = () => window.CreelGitHub.util;

  // ── tiny IndexedDB k/v for the directory handle ─────────────────
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv').objectStore('kv').get(key);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const supported = typeof window.showDirectoryPicker === 'function';

  async function permissionOf(handle) {
    try { return await handle.queryPermission({ mode: 'readwrite' }); }
    catch { return 'unknown'; }
  }

  /** The user-gesture entry point: pick a folder, or re-grant the stored one. */
  async function pickOrRegrant() {
    if (!supported) { alert('Local folder mode needs desktop Chrome/Edge (File System Access API).'); return; }
    let handle = dirHandle || await idbGet('dir').catch(() => null);
    if (handle && (await permissionOf(handle)) !== 'granted') {
      try { await handle.requestPermission({ mode: 'readwrite' }); } catch { /* fall through */ }
    }
    if (!handle || (await permissionOf(handle)) !== 'granted') {
      try { handle = await window.showDirectoryPicker({ mode: 'readwrite' }); }
      catch (e) { if (e.name !== 'AbortError') console.warn('local: pick failed', e); return; }
    }
    dirHandle = handle;
    await idbSet('dir', handle).catch(() => {});
    console.log(`creel: local folder connected — ${handle.name}`);
    alert(`Local folder connected: ${handle.name}\nAsk the agent to run local_sync_in to load it.`);
  }

  async function requireDir() {
    if (!dirHandle) {
      const stored = await idbGet('dir').catch(() => null);
      if (stored && (await permissionOf(stored)) === 'granted') dirHandle = stored;
    }
    if (!dirHandle) throw new Error('no local folder connected — click the "Local" button in the FILES panel');
    if ((await permissionOf(dirHandle)) !== 'granted') {
      throw new Error('permission for the local folder lapsed — click the "Local" button to re-grant');
    }
    return dirHandle;
  }

  async function walkDir(handle, prefix, excluded, out) {
    for await (const [name, child] of handle.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (excluded.includes(name)) continue;
      if (child.kind === 'directory') await walkDir(child, rel, excluded, out);
      else out.push([rel, child]);
    }
  }

  async function dirFor(root, rel, create) {
    const parts = rel.split('/');
    parts.pop();
    let h = root;
    for (const p of parts) h = await h.getDirectoryHandle(p, { create });
    return h;
  }

  const TOOLS = [
    {
      name: 'local_status',
      description: 'Report local-folder mode state: browser support, connected folder, permission, and (after local_sync_in) which VFS files changed vs the folder.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'local_sync_in',
      description: 'Copy the connected local folder into the VFS for editing. The user must first connect a folder via the "Local" button in the FILES panel.',
      inputSchema: {
        type: 'object',
        properties: {
          dest: { type: 'string', description: 'VFS directory to write into (default: /<folder-name>)' },
          exclude: { type: 'array', items: { type: 'string' }, description: `directory/file names to skip (default: ${JSON.stringify(DEFAULT_EXCLUDE)})` },
        },
        required: [],
      },
    },
    {
      name: 'local_sync_out',
      description: 'Write VFS changes since local_sync_in back to the real local folder (changed and new files; nothing is deleted unless delete_missing is true).',
      inputSchema: {
        type: 'object',
        properties: {
          delete_missing: { type: 'boolean', description: 'also delete files that were synced in but no longer exist in the VFS (default false)' },
        },
        required: [],
      },
    },
    {
      name: 'local_forget',
      description: 'Disconnect the local folder and clear sync state (does not touch the folder contents).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ];

  const impl = {
    async local_status() {
      const out = { supported };
      if (!supported) { out.hint = 'needs desktop Chrome/Edge'; return out; }
      const handle = dirHandle || await idbGet('dir').catch(() => null);
      if (!handle) { out.connected = false; out.hint = 'click the "Local" button in the FILES panel to pick a folder'; return out; }
      out.connected = true;
      out.folder = handle.name;
      out.permission = await permissionOf(handle);
      if (syncState) {
        out.synced = { dest: syncState.dest, files: Object.keys(syncState.files).length };
        const { changed, added, removed } = await diff();
        out.changes = { changed: changed.map((c) => c.rel), added: added.map((a) => a.rel), removed };
      }
      return out;
    },

    async local_sync_in(args) {
      const root = await requireDir();
      const exclude = args.exclude || DEFAULT_EXCLUDE;
      const dest = normPath(args.dest || `/${root.name}`);
      const entries = [];
      await walkDir(root, '', exclude, entries);
      vfsDelete(dest, true);
      const files = {};
      const skipped = [];
      let written = 0;
      for (const [rel, fh] of entries) {
        const file = await fh.getFile();
        if (file.size > MAX_FILE) { skipped.push(rel); continue; }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = util().asText(bytes);
        if (text !== null) vfsWrite(`${dest}/${rel}`, text, true);
        else await vfsWriteBinary(`${dest}/${rel}`, bytes, true);
        files[rel] = await util().gitBlobSha(bytes);
        written++;
      }
      renderFileTree();
      syncState = { dest, files };
      return { folder: root.name, dest, files: written, skipped };
    },

    async local_sync_out(args) {
      const root = await requireDir();
      if (!syncState) throw new Error('nothing synced in — run local_sync_in first');
      const { changed, added, removed } = await diff();
      for (const item of [...changed, ...added]) {
        const parent = await dirFor(root, item.rel, true);
        const fh = await parent.getFileHandle(item.rel.split('/').pop(), { create: true });
        const w = await fh.createWritable();
        await w.write(item.bytes);
        await w.close();
        syncState.files[item.rel] = item.sha;
      }
      const deleted = [];
      if (args.delete_missing) {
        for (const rel of removed) {
          try {
            const parent = await dirFor(root, rel, false);
            await parent.removeEntry(rel.split('/').pop());
            delete syncState.files[rel];
            deleted.push(rel);
          } catch (e) { /* already gone or blocked; leave in state */ }
        }
      }
      return {
        wrote: [...changed, ...added].map((i) => i.rel),
        deleted,
        skipped_deletes: args.delete_missing ? [] : removed,
      };
    },

    async local_forget() {
      dirHandle = null;
      syncState = null;
      await idbSet('dir', null).catch(() => {});
      return { ok: true };
    },
  };

  async function diff() {
    const present = new Map(util().walkVfs(syncState.dest));
    const changed = [];
    const added = [];
    const removed = [];
    for (const [rel, node] of present) {
      const bytes = await util().nodeBytes(syncState.dest, rel, node);
      const sha = await util().gitBlobSha(bytes);
      if (!(rel in syncState.files)) added.push({ rel, bytes, sha });
      else if (syncState.files[rel] !== sha) changed.push({ rel, bytes, sha });
    }
    for (const rel of Object.keys(syncState.files)) {
      if (!present.has(rel)) removed.push(rel);
    }
    return { changed, added, removed };
  }

  const CreelLocal = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({
              protocolVersion: body.params?.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'local-folder', version: '0' },
            });
          case 'notifications/initialized':
            return null;
          case 'tools/list':
            return reply({ tools: TOOLS });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!impl[name]) return fail(`unknown tool: ${name}`);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await impl[name](args || {})) }] });
          }
          default:
            return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },

    registerDefaults() {
      window.CreelInpage.register('inpage:local', this);
      if (typeof mcpServers !== 'undefined' && !mcpServers.find((s) => s.id === 'mcp_local_inpage')) {
        mcpServers.push({
          id: 'mcp_local_inpage', name: 'local', type: 'inpage',
          url: 'inpage:local', token: '', corsProxy: '', enabled: true,
        });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = (typeof mcpServers !== 'undefined')
        && mcpServers.find((s) => s.id === 'mcp_local_inpage');
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) => console.warn('local in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
      this.injectButton();
    },

    /** The user-gesture surface: a "Local" button beside the Folder upload. */
    injectButton() {
      const anchor = document.querySelector('.fe-upload-folder-btn');
      if (!anchor || document.getElementById('creelLocalBtn')) return;
      const btn = document.createElement('button');
      btn.id = 'creelLocalBtn';
      btn.className = anchor.className;
      btn.textContent = supported ? 'Local' : 'Local (Chrome/Edge)';
      btn.title = 'Connect a real local folder (File System Access API)';
      btn.onclick = (e) => { e.stopPropagation(); pickOrRegrant(); };
      anchor.after(btn);
    },
  };

  window.CreelLocal = CreelLocal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelLocal.registerDefaults());
  } else {
    CreelLocal.registerDefaults();
  }
})();
