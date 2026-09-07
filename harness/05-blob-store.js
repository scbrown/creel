/* creel harness — part 5 of 26: blob-store
 *
 * Extracted verbatim from app/thread.html (creel-yny). These are CLASSIC
 * scripts, deliberately not modules: classic scripts share one global lexical
 * environment, so top-level const/let and function declarations stay visible
 * across every part and to the inline onclick= handlers in the markup. That
 * shared scope is what let the split be mechanical rather than a rewrite.
 *
 * THE LOAD ORDER IN thread.html IS PART OF THE SEMANTICS. Do not reorder
 * the tags, do not add defer or async, and do not move a declaration across a
 * file boundary without checking what reads it while the page is loading.
 *
 * Sections here:
 *   - BLOB STORE — content-addressed binary storage
 */
// ═══════════════════════════════════════════════════════════════════
// BLOB STORE — content-addressed binary storage
// vfs file nodes hold {hash,size}; bytes live in OPFS (preferred) or IDB.
// Refcounts live in IDB so unref can atomically delete orphan blobs.
// ═══════════════════════════════════════════════════════════════════
const BLOB_DB_NAME = 'ba_blobs';
const BLOB_DB_VER = 1;
const BLOB_STORE_NAME = 'blobs';
const BLOB_REFS_STORE = 'blob_refs';

function openBlobDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BLOB_DB_NAME, BLOB_DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) db.createObjectStore(BLOB_STORE_NAME);
      if (!db.objectStoreNames.contains(BLOB_REFS_STORE)) db.createObjectStore(BLOB_REFS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _blobSha256Hex(bytes) {
  // Guard: Chrome's crypto.subtle.digest has thrown EncodingError on views
  // whose underlying ArrayBuffer came straight from FileReader.readAsArrayBuffer
  // for certain large files. Copy to a fresh ArrayBuffer first.
  let input = bytes;
  if (!(bytes instanceof Uint8Array)) input = new Uint8Array(bytes);
  if (input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    input = copy;
  }
  const h = await crypto.subtle.digest('SHA-256', input);
  const arr = new Uint8Array(h);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

let _blobBackend = 'idb';
let _opfsBlobsDirPromise = null;
async function _opfsBlobsDir() {
  if (!_opfsBlobsDirPromise) {
    _opfsBlobsDirPromise = (async () => {
      if (!navigator?.storage?.getDirectory) throw new Error('OPFS unavailable');
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle('blobs', { create: true });
    })();
  }
  return _opfsBlobsDirPromise;
}

async function _initBlobBackend() {
  try {
    const dir = await _opfsBlobsDir();
    // Some file:// contexts hand out a handle but fail on actual writes; probe.
    // Dot-prefixed names have caused EncodingError on some Chrome builds, so
    // the probe uses a plain ASCII name.
    const probeName = 'ba_blob_probe';
    const probe = await dir.getFileHandle(probeName, { create: true });
    const writable = await probe.createWritable();
    await writable.write(new Uint8Array([1]));
    await writable.close();
    await dir.removeEntry(probeName).catch(() => {});
    _blobBackend = 'opfs';
  } catch (e) {
    console.warn('[blobStore] OPFS unavailable, falling back to IDB:', e?.message || e);
    _blobBackend = 'idb';
    _opfsBlobsDirPromise = null;
  }
}

// Flag set when an OPFS runtime error forces a permanent downgrade this session.
let _opfsDowngraded = false;
function _downgradeToIdb(reason) {
  if (_opfsDowngraded) return;
  _opfsDowngraded = true;
  _blobBackend = 'idb';
  _opfsBlobsDirPromise = null;
  console.warn('[blobStore] OPFS runtime error, switching to IDB backend:', reason);
}

async function _blobBackendHas(hash) {
  if (_blobBackend === 'opfs') {
    try { const dir = await _opfsBlobsDir(); await dir.getFileHandle(hash); return true; }
    catch (e) {
      // "not found" is expected; only downgrade on unexpected errors.
      if (e?.name && e.name !== 'NotFoundError') _downgradeToIdb(e.message);
      if (_blobBackend === 'opfs') return false;
    }
  }
  const db = await openBlobDB();
  return new Promise(res => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readonly');
    const req = tx.objectStore(BLOB_STORE_NAME).getKey(hash);
    req.onsuccess = () => res(req.result !== undefined);
    req.onerror = () => res(false);
  });
}

async function _blobBackendPut(hash, bytes) {
  if (_blobBackend === 'opfs') {
    try {
      const dir = await _opfsBlobsDir();
      const fh = await dir.getFileHandle(hash, { create: true });
      const writable = await fh.createWritable();
      await writable.write(bytes);
      await writable.close();
      return;
    } catch (e) {
      _downgradeToIdb(`put(${hash.slice(0, 8)}) — ${e?.message || e}`);
      // fall through to IDB
    }
  }
  const db = await openBlobDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readwrite');
    tx.objectStore(BLOB_STORE_NAME).put(bytes, hash);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function _blobBackendGet(hash) {
  if (_blobBackend === 'opfs') {
    try {
      const dir = await _opfsBlobsDir();
      const fh = await dir.getFileHandle(hash);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      if (e?.name === 'NotFoundError') return null;
      _downgradeToIdb(`get(${hash.slice(0, 8)}) — ${e?.message || e}`);
      // fall through to IDB
    }
  }
  const db = await openBlobDB();
  return new Promise(res => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readonly');
    const req = tx.objectStore(BLOB_STORE_NAME).get(hash);
    req.onsuccess = () => {
      const r = req.result;
      if (!r) return res(null);
      res(r instanceof Uint8Array ? r : new Uint8Array(r));
    };
    req.onerror = () => res(null);
  });
}

async function _blobBackendDelete(hash) {
  if (_blobBackend === 'opfs') {
    try { const dir = await _opfsBlobsDir(); await dir.removeEntry(hash); return; }
    catch (e) {
      if (e?.name === 'NotFoundError') return;
      _downgradeToIdb(`delete(${hash.slice(0, 8)}) — ${e?.message || e}`);
      // fall through to IDB
    }
  }
  const db = await openBlobDB();
  return new Promise(res => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readwrite');
    tx.objectStore(BLOB_STORE_NAME).delete(hash);
    tx.oncomplete = res;
    tx.onerror = res;
  });
}

async function _refAdjust(hash, delta) {
  const db = await openBlobDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(BLOB_REFS_STORE, 'readwrite');
    const store = tx.objectStore(BLOB_REFS_STORE);
    const getReq = store.get(hash);
    getReq.onsuccess = () => {
      const cur = getReq.result || 0;
      const next = cur + delta;
      if (next <= 0) store.delete(hash);
      else store.put(next, hash);
    };
    tx.oncomplete = () => res((getReq.result || 0) + delta);
    tx.onerror = () => rej(tx.error);
  });
}

async function _refGet(hash) {
  const db = await openBlobDB();
  return new Promise(res => {
    const tx = db.transaction(BLOB_REFS_STORE, 'readonly');
    const req = tx.objectStore(BLOB_REFS_STORE).get(hash);
    req.onsuccess = () => res(req.result || 0);
    req.onerror = () => res(0);
  });
}

const blobStore = {
  get backend() { return _blobBackend; },
  async init() { await _initBlobBackend(); },
  // Hash + store bytes, increment refcount. Returns {hash,size}.
  async put(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let hash;
    try { hash = await _blobSha256Hex(arr); }
    catch (e) { console.error('[blobStore.put] hash step failed for', arr.length, 'bytes:', e); throw e; }
    try {
      if (!(await _blobBackendHas(hash))) await _blobBackendPut(hash, arr);
    } catch (e) { console.error('[blobStore.put] backend write failed (', _blobBackend, ') for', arr.length, 'bytes:', e); throw e; }
    try { await _refAdjust(hash, +1); }
    catch (e) { console.error('[blobStore.put] refcount bump failed:', e); throw e; }
    return { hash, size: arr.length };
  },
  // Store bytes under a known hash (from sync manifest), increment refcount.
  async putWithHash(hash, bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!(await _blobBackendHas(hash))) await _blobBackendPut(hash, arr);
    await _refAdjust(hash, +1);
    return { hash, size: arr.length };
  },
  async ref(hash) { await _refAdjust(hash, +1); },
  async unref(hash) {
    const next = await _refAdjust(hash, -1);
    if (next <= 0) await _blobBackendDelete(hash);
    return next;
  },
  async get(hash) { return _blobBackendGet(hash); },
  async has(hash) { return _blobBackendHas(hash); },
  async refGet(hash) { return _refGet(hash); },
};

// Walk a vfs subtree and unref every binary leaf's blob. Fire-and-forget.
function _unrefVfsSubtree(node) {
  if (!node) return;
  if (node.type === 'file' && node.binary && node.hash) {
    blobStore.unref(node.hash).catch(e => console.warn('blob unref failed:', e));
    return;
  }
  if (node.type === 'dir' && node.children) {
    for (const ch of Object.values(node.children)) _unrefVfsSubtree(ch);
  }
}

// Deep-clone a vfs node into destParent[destName], bumping blob refs for
// any binary leaves. Source is not mutated. Used by rename/duplicate.
async function _vfsGraftNode(sourceNode, destParent, destName) {
  if (sourceNode.type === 'file') {
    const copy = { ...sourceNode, modified: Date.now() };
    destParent.children[destName] = copy;
    if (copy.binary && copy.hash) await blobStore.ref(copy.hash);
    return;
  }
  const dir = { type: 'dir', children: {} };
  destParent.children[destName] = dir;
  for (const [k, ch] of Object.entries(sourceNode.children || {})) {
    await _vfsGraftNode(ch, dir, k);
  }
}

function openConvDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONV_DB_NAME, CONV_DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CONV_STORE)) db.createObjectStore(CONV_STORE);
      if (!db.objectStoreNames.contains(CONV_META_STORE)) db.createObjectStore(CONV_META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveConvDataToDB(id, data) {
  const _put = async (payload) => {
    const db = await openConvDB();
    const tx = db.transaction(CONV_STORE, 'readwrite');
    tx.objectStore(CONV_STORE).put(payload, id);
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
  };
  try {
    await _put(data);
    return true;
  } catch (e) {
    // Non-cloneable members (functions, DOM refs, exotic classes) make the
    // structured clone inside IDB put throw DataCloneError — which would
    // silently kill EVERY save. Retry once with a JSON-safe strip so the
    // plain parts (messages, tokens, vfs tree) still persist.
    try {
      const safe = JSON.parse(JSON.stringify(data));
      await _put(safe);
      console.warn('Conv DB save: non-cloneable state stripped before persisting:', e.message);
      return true;
    } catch (e2) {
      console.error('Conv DB save error (conversation will NOT persist):', e2);
      return false;
    }
  }
}

async function loadConvDataFromDB(id) {
  try { const db = await openConvDB(); const tx = db.transaction(CONV_STORE, 'readonly'); const req = tx.objectStore(CONV_STORE).get(id); return new Promise(r => { req.onsuccess = () => r(req.result || null); req.onerror = () => r(null); }); } catch { return null; }
}

async function deleteConvDataFromDB(id) {
  try {
    // Unref any blob-backed binary files this conv owned before dropping the record.
    const prior = await loadConvDataFromDB(id);
    if (prior?.vfs) _unrefVfsSubtree(prior.vfs);
    const db = await openConvDB();
    const tx = db.transaction(CONV_STORE, 'readwrite');
    tx.objectStore(CONV_STORE).delete(id);
  } catch {}
}

async function loadConvMetaFromDB() {
  try { const db = await openConvDB(); const tx = db.transaction(CONV_META_STORE, 'readonly'); const req = tx.objectStore(CONV_META_STORE).get(CONV_META_KEY); return new Promise(r => { req.onsuccess = () => r(req.result || null); req.onerror = () => r(null); }); } catch { return null; }
}

async function saveConvMetaToDB(list) {
  try { const db = await openConvDB(); const tx = db.transaction(CONV_META_STORE, 'readwrite'); tx.objectStore(CONV_META_STORE).put(list, CONV_META_KEY); } catch (e) { console.warn('Conv meta DB save error:', e); }
}

async function loadConvFoldersFromDB() {
  try { const db = await openConvDB(); const tx = db.transaction(CONV_META_STORE, 'readonly'); const req = tx.objectStore(CONV_META_STORE).get(CONV_FOLDERS_KEY); return new Promise(r => { req.onsuccess = () => r(Array.isArray(req.result) ? req.result : []); req.onerror = () => r([]); }); } catch { return []; }
}

async function saveConvFoldersToDB() {
  try { const db = await openConvDB(); const tx = db.transaction(CONV_META_STORE, 'readwrite'); tx.objectStore(CONV_META_STORE).put(convFolders, CONV_FOLDERS_KEY); } catch (e) { console.warn('Conv folders DB save error:', e); }
}

// Fleet agent/worker tabs (spawned via #creel-agent=/#creel-worker=) must NOT
// inherit the operator's active conversation — burst agents need isolated
// context, not the orchestrator's thread. loadConvHistory and newConversation
// both branch on this.
const IS_FLEET_TAB = /creel-(?:agent|worker)=/.test(location.hash);

async function loadConvHistory() {
  // Primary source: IndexedDB meta store (no localStorage size limit)
  const fromDB = await loadConvMetaFromDB();
  if (Array.isArray(fromDB) && fromDB.length) {
    convHistory = fromDB;
  } else {
    // One-time migration from legacy localStorage key
    try {
      const s = localStorage.getItem('ba_conv_meta');
      if (s) {
        convHistory = JSON.parse(s) || [];
        if (convHistory.length) {
          await saveConvMetaToDB(convHistory);
          localStorage.removeItem('ba_conv_meta');
        }
      }
    } catch {}
  }
  convFolders = await loadConvFoldersFromDB();
  const folderIds = new Set(convFolders.map(f => f.id));
  for (const c of convHistory) {
    if (c.folderId && !folderIds.has(c.folderId)) delete c.folderId;
  }
  if (convHistory.length && !IS_FLEET_TAB) {
    const lastId = localStorage.getItem('ba_active_conv') || convHistory[0].id;
    const found = convHistory.find(c => c.id === lastId);
    visibleConvId = found ? found.id : convHistory[0].id;
    switchConversation(visibleConvId, true);
  } else {
    newConversation(true);
  }
  renderConvList();
}

function saveConvMeta() {
  // Fire-and-forget write to IDB; no size cap — archive as much as the browser allows
  saveConvMetaToDB(convHistory);
}

function getFirstUserQuestionForTitle(conv = conversation) {
  const first = conv.find(m => m.role === 'user' && getUserTextFromContent(m.content));
  return first ? getUserTextFromContent(first.content).trim() : '';
}

function makeLocalConversationTitleFallback(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 40) + (clean.length > 40 ? '...' : '');
}

function hashTitlePrompt(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

function cleanGeneratedConversationTitle(raw) {
  let title = String(raw || '')
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  title = title.replace(/[.。！？!?,，;；:：]+$/g, '').trim();
  if (!title) return '';
  if (/^(new chat|untitled|conversation|chat)$/i.test(title)) return '';
  if (title.length > 60) title = title.slice(0, 57).trim() + '...';
  return title;
}

function buildConversationTitleRequestBody(firstQuestion) {
  const system = 'You generate concise chat titles. Use the same language as the user question. Return only the title, no quotes, no punctuation-only ending, no explanation.';
  const request = `Create a short title for this first user question. For Chinese, use 4-12 Chinese characters; otherwise use 3-8 words.\n\n${firstQuestion}`;
  return PROVIDER === 'anthropic_compat'
    ? { model: API_MODEL, system, messages: [{ role: 'user', content: request }] }
    : { model: API_MODEL, temperature: 0.2, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: request }] };
}

function extractTitleTextFromLLMResponse(data) {
  if (PROVIDER === 'anthropic_compat') {
    return Array.isArray(data.content)
      ? data.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
      : String(data.content || '');
  }
  return data.choices?.[0]?.message?.content || '';
}

async function generateConversationTitleWithAI(firstQuestion) {
  if (!String(firstQuestion || '').trim()) return '';
  try {
    const resp = await sendLLMRequestBody(buildConversationTitleRequestBody(firstQuestion));
    if (!resp.ok) {
      let errorText = '';
      try { errorText = await resp.text(); } catch {}
      console.warn('Conversation title generation failed:', `HTTP ${resp.status}`, errorText.slice(0, 300));
      return '';
    }
    const data = await resp.json();
    const rawTitle = extractTitleTextFromLLMResponse(data);
    const title = cleanGeneratedConversationTitle(rawTitle);
    if (!title) console.warn('Conversation title generation returned empty title:', rawTitle);
    return title;
  } catch (e) {
    console.warn('Conversation title generation failed:', e);
    return '';
  }
}
function scheduleConversationTitleGeneration(convId, firstQuestion) {
  maybeGenerateConversationTitle(convId, firstQuestion)
    .catch(e => console.warn('Conversation title generation failed:', e));
}

async function maybeGenerateConversationTitle(convId, firstQuestion) {
  const text = String(firstQuestion || '').trim();
  if (!convId || !text) return;
  const promptHash = hashTitlePrompt(text);
  const key = `${convId}:${promptHash}`;
  if (_titleGenInFlight.has(key)) return;

  const meta = convHistory.find(c => c.id === convId);
  if (!meta) return;
  const fallbackTitle = makeLocalConversationTitleFallback(text);
  const looksLikeAutoFallback = meta.title === fallbackTitle && (!meta.titlePromptHash || meta.titlePromptHash === promptHash);
  if (!meta.titleSource) {
    meta.titleSource = meta.title === 'New Chat' ? 'default' : (looksLikeAutoFallback ? 'fallback' : 'manual');
    meta.titleStatus = meta.title === 'New Chat' || looksLikeAutoFallback ? 'idle' : 'done';
  } else if (meta.titleSource === 'manual' && looksLikeAutoFallback) {
    meta.titleSource = 'fallback';
    meta.titleStatus = 'idle';
  }
  if (meta.titleSource === 'manual') return;
  if (meta.titleSource === 'ai' && meta.titlePromptHash === promptHash) return;
  if (meta.titleStatus === 'generating' && meta.titlePromptHash === promptHash) return;

  if (!meta.title || meta.title === 'New Chat' || meta.titleSource === 'default') {
    meta.title = makeLocalConversationTitleFallback(text);
    meta.titleSource = 'fallback';
  }
  meta.titleStatus = 'generating';
  meta.titlePromptHash = promptHash;
  saveConvMeta();
  renderConvList();

  _titleGenInFlight.add(key);
  try {
    const aiTitle = await generateConversationTitleWithAI(text);
    const latest = convHistory.find(c => c.id === convId);
    if (!latest || latest.titleSource === 'manual' || latest.titlePromptHash !== promptHash) return;
    if (aiTitle) {
      latest.title = aiTitle;
      latest.titleSource = 'ai';
      latest.titleStatus = 'done';
      latest.updated = Date.now();
    } else {
      latest.titleStatus = 'idle';
    }
    saveConvMeta();
    renderConvList();
    if (typeof schedulePush === 'function') schedulePush();
  } finally {
    _titleGenInFlight.delete(key);
  }
}

async function saveConversationState(convId, state, options = {}) {
  if (!convId || !state) return;
  const meta = convHistory.find(c => c.id === convId);
  if (!meta) return;
  const conv = Array.isArray(state.conversation) ? state.conversation : [];
  meta.loopCount = state.loopCount || 0;
  meta.totalTokens = state.totalTokens || 0;
  meta.contextTokens = state.contextTokens || 0;
  meta.messageCount = conv.filter(m => m.role === 'user').length;
  meta.updated = Date.now();
  const firstText = getFirstUserQuestionForTitle(conv);
  const firstHash = firstText ? hashTitlePrompt(firstText) : '';
  const fallbackTitle = firstText ? makeLocalConversationTitleFallback(firstText) : '';
  const looksLikeAutoFallback = firstText && meta.title === fallbackTitle && (!meta.titlePromptHash || meta.titlePromptHash === firstHash);
  if (!meta.titleSource) {
    meta.titleSource = meta.title === 'New Chat' ? 'default' : (looksLikeAutoFallback ? 'fallback' : 'manual');
    meta.titleStatus = meta.title === 'New Chat' || looksLikeAutoFallback ? 'idle' : 'done';
  } else if (meta.titleSource === 'manual' && looksLikeAutoFallback) {
    meta.titleSource = 'fallback';
    meta.titleStatus = 'idle';
  }
  if (firstText && meta.titleSource !== 'manual') {
    if (!meta.titlePromptHash) meta.titlePromptHash = hashTitlePrompt(firstText);
    if (meta.title === 'New Chat' || meta.titleSource === 'default') {
      meta.title = makeLocalConversationTitleFallback(firstText);
      meta.titleSource = 'fallback';
    }
    if (meta.titleSource !== 'ai' && meta.titleStatus !== 'generating') {
      scheduleConversationTitleGeneration(convId, firstText);
    }
  }
  saveConvMeta();
  const html = state.chatHTML || '';
  // v4: only persist agent-tier roles per-conversation when the user explicitly opted in.
  // `undefined` is dropped by structured clone, so disabling perConv stops polluting historical convs.
  const swarmAgentRoles = (swarmSettings.agentRolesPersist && swarmSettings.agentRolesPerConv) ? (state.agentSwarmRoles || []) : undefined;
  const ok = await saveConvDataToDB(convId, {
    conversation: conv,
    sessionEntries: state.sessionEntries || [],
    activeEntryId: state.activeEntryId || null,
    vfs: state.vfs || { type: 'dir', children: {} },
    chatHTML: html,
    totalTokens: state.totalTokens || 0,
    contextTokens: state.contextTokens || 0,
    loopCount: state.loopCount || 0,
    todos: state.todos || [],
    subAgentRuns: state.subAgentRuns || [],
    lastUsageInfo: state.lastUsageInfo || null,
    lastInputTokens: state.lastInputTokens || 0,
    lastOutputTokens: state.lastOutputTokens || 0,
    lastCacheReadTokens: state.lastCacheReadTokens || 0,
    lastCacheWriteTokens: state.lastCacheWriteTokens || 0,
    lastTurnTokens: state.lastTurnTokens || 0,
    planMode: !!state.planMode,
    ralphModeEnabled: !!state.ralphModeEnabled,
    swarmAgentRoles
  });
  if (ok) _convSaveFailures = 0;
  else _noteConvSaveFailure(convId);
  if (options.andRenderList) renderConvList();
  if (typeof schedulePush === 'function') schedulePush();
}

// Failed saves are usually invisible (the old code swallowed them) — track
// them and surface a one-time warning so "conversations aren't getting saved"
// is never a silent data-loss mystery again.
let _convSaveFailures = 0;
let _convSaveWarned = false;
function _noteConvSaveFailure(convId) {
  _convSaveFailures++;
  if (_convSaveFailures >= 2 && !_convSaveWarned) {
    _convSaveWarned = true;
    try {
      appendSystemMsg('⚠️ Conversations are NOT being saved in this browser — IndexedDB writes are failing (see console). Reloading will lose this session. Export the conversation, or open creel in a normal browser tab with storage enabled.');
    } catch {}
  }
}

async function saveCurrentConv(andRenderList) {
  if (currentRunContext) {
    snapshotConversationRunState(currentRunContext);
    return saveConversationState(currentRunContext.convId, currentRunContext.state, { andRenderList });
  }
  if (!activeConvId) return;
  const run = conversationRuns.get(activeConvId);
  if (run) {
    snapshotConversationRunState(run);
    return saveConversationState(activeConvId, run.state, { andRenderList });
  }
  rebuildConversation();
  return saveConversationState(activeConvId, captureConversationState(chatEl.innerHTML), { andRenderList });
}

function newConversation(skipSave, folderId) {
  ensureVisibleConversationStateActive();
  const fromRun = visibleConvId ? conversationRuns.get(visibleConvId) : null;
  if (fromRun) {
    detachConversationRunDom(fromRun);
    snapshotConversationRunState(fromRun);
    if (!skipSave) saveConversationState(fromRun.convId, fromRun.state);
  } else if (!skipSave) saveCurrentConv();
  const visibleBefore = visibleConvId || activeConvId;
  if (visibleBefore && !isConversationRunning(visibleBefore) && window._daytonaSessions && window._daytonaSessions[visibleBefore]) {
    daytonaClient.destroy(visibleBefore).catch(() => {});
  }
  const id = genConvId();
  const meta = { id, title: 'New Chat', titleSource: 'default', titleStatus: 'idle', titlePromptHash: '', created: Date.now(), updated: Date.now(), loopCount: 0, totalTokens: 0, contextTokens: 0, messageCount: 0 };
  if (folderId && convFolders.some(f => f.id === folderId)) {
    meta.folderId = folderId;
    const f = convFolders.find(x => x.id === folderId);
    if (f && !f.expanded) { f.expanded = true; saveConvFoldersToDB(); }
  }
  convHistory.unshift(meta);
  activeConvId = id;
  visibleConvId = id;
  currentRunContext = null;
  conversation = [];
  sessionEntries = [];
  activeEntryId = null;
  vfs = { type: 'dir', children: {} };
  collapsedDirs.clear();
  seenDirs.clear();
  cwd = '/';
  loopCount = 0;
  totalTokens = 0;
  contextTokens = 0;
  lastUsageInfo = null;
  lastInputTokens = 0;
  lastOutputTokens = 0;
  lastCacheReadTokens = 0;
  lastCacheWriteTokens = 0;
  lastRequestContextSnapshot = null;
  lastContextBreakdown = null;
  lastTurnTokens = 0;
  contextBreakdownExpanded = false;
  currentViewFile = null;
  todos = [];
  subAgentRuns = [];
  planMode = false;
  ralphModeEnabled = getRalphSettings().enabled;
  ralphRun = null;
  swarmRunActive = null;
  if (typeof renderTodos === 'function') renderTodos();
  if (typeof renderSubAgents === 'function') renderSubAgents();
  if (typeof renderPlanButton === 'function') renderPlanButton();
  if (typeof renderRalphButton === 'function') renderRalphButton();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  chatEl.innerHTML = '<div class="msg msg-system msg-placeholder"><div class="msg-body">New conversation. Upload files and type a task to begin.</div></div>';
  visibleConversationState = captureConversationState(chatEl.innerHTML);
  // Remount active skills
  for (const s of skills) { if (s.active) mountSkillToVfs(s); }
  renderFileTree();
  updateMemoryUI();
  document.getElementById('memoryLog').innerHTML = '';
  closeFileViewer(true);
  visibleConversationState = captureConversationState(chatEl.innerHTML);
  // Fleet tabs keep their active-conv pointer tab-local (never written to the
  // shared per-origin localStorage) so a worker can never clobber the
  // operator's active conversation; they always boot fresh anyway.
  if (!IS_FLEET_TAB) { try { localStorage.setItem('ba_active_conv', id); } catch {} }
  syncLegacyRunFlags();
  updateButtons();
  setStatus('ready', t('status.ready'));
  if (!skipSave) { saveConvMeta(); renderConvList(); }
}

let _switchSeq = 0;            // monotonically bumped per switchConversation call
let _switchLoadInFlight = false; // true while a switch awaits its IndexedDB load (globals are stale)
async function switchConversation(id, skipSave) {
  const mySwitchSeq = ++_switchSeq;
  ensureVisibleConversationStateActive();
  if ((visibleConvId || activeConvId) === id && !skipSave) return;
  if (typeof closeMobileDrawers === 'function') closeMobileDrawers();
  const fromRun = visibleConvId ? conversationRuns.get(visibleConvId) : null;
  if (fromRun) {
    detachConversationRunDom(fromRun);
    snapshotConversationRunState(fromRun);
    if (!skipSave) saveConversationState(fromRun.convId, fromRun.state);
  } else if (!skipSave && activeConvId && !_switchLoadInFlight) saveCurrentConv();
  const meta = convHistory.find(c => c.id === id);
  if (!meta) return;
  activeConvId = id;
  visibleConvId = id;
  currentRunContext = null;
  // Fleet tabs keep their own active-conversation pointer; only the operator's
  // root tab may claim ba_active_conv (mirrors the guard in newConversation).
  if (!IS_FLEET_TAB) { try { localStorage.setItem('ba_active_conv', id); } catch {} }
  // Update UI immediately (mark active in list)
  renderConvList();
  const targetRun = conversationRuns.get(id);
  if (targetRun) {
    applyConversationState(targetRun.state || {});
    activeConvId = id;
    if (!attachConversationRunDom(targetRun)) {
      chatEl.innerHTML = targetRun.state?.chatHTML || '<div class="msg msg-system msg-placeholder"><div class="msg-body">Conversation running...</div></div>';
    }
    await hydrateMediaResultCards(chatEl);
    renderFileTree();
    updateMemoryUI();
    renderTodos();
    renderSubAgents();
    renderPlanButton();
    renderRalphButton();
    rebuildToolDefs();
    closeFileViewer(true);
    syncLegacyRunFlags();
    updateButtons();
    setStatus('running', targetRun.statusText || t('status.streaming'));
    _switchLoadInFlight = false;
    return;
  }
  // Load heavy data from IndexedDB
  _switchLoadInFlight = true;
  const data = await loadConvDataFromDB(id);
  // A newer switchConversation started while we awaited: bail before touching the
  // globals so we don't overwrite the newer target's state (and leave the in-flight
  // flag set — the newer switch owns it and will clear it).
  if (mySwitchSeq !== _switchSeq) return;
  sessionEntries = data?.sessionEntries || [];
  activeEntryId = data?.activeEntryId || null;
  conversation = data?.conversation || [];
  if (!sessionEntries.length && conversation.length) ensureSessionEntries();
  rebuildConversation();
  vfs = data?.vfs || { type: 'dir', children: {} };
  collapsedDirs.clear();
  seenDirs.clear();
  cwd = '/';
  loopCount = meta.loopCount || 0;
  totalTokens = data?.totalTokens ?? meta.totalTokens ?? 0;
  contextTokens = data?.contextTokens ?? meta.contextTokens ?? 0;
  lastUsageInfo = data?.lastUsageInfo || null;
  lastInputTokens = data?.lastInputTokens || 0;
  lastOutputTokens = data?.lastOutputTokens || 0;
  lastCacheReadTokens = data?.lastCacheReadTokens || 0;
  lastCacheWriteTokens = data?.lastCacheWriteTokens || 0;
  lastRequestContextSnapshot = null;
  lastContextBreakdown = null;
  lastTurnTokens = data?.lastTurnTokens || 0;
  contextBreakdownExpanded = false;
  currentViewFile = null;
  todos = Array.isArray(data?.todos) ? data.todos : [];
  subAgentRuns = Array.isArray(data?.subAgentRuns) ? data.subAgentRuns : [];
  planMode = !!data?.planMode;
  ralphModeEnabled = data?.ralphModeEnabled ?? getRalphSettings().enabled;
  ralphRun = null;
  swarmRunActive = null;
  // v4: agent-tier roles per-conversation. Memory-only and global-persist modes are unaffected here.
  if (swarmSettings.agentRolesPersist && swarmSettings.agentRolesPerConv) {
    agentSwarmRoles = Array.isArray(data?.swarmAgentRoles) ? data.swarmAgentRoles : [];
  } else if (!swarmSettings.agentRolesPersist) {
    // Memory-only: don't carry agent roles across conversations.
    agentSwarmRoles = [];
  }
  if (typeof renderTodos === 'function') renderTodos();
  if (typeof renderSubAgents === 'function') renderSubAgents();
  if (typeof renderPlanButton === 'function') renderPlanButton();
  if (typeof renderRalphButton === 'function') renderRalphButton();
  if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  if (data?.chatHTML) chatEl.innerHTML = data.chatHTML;
  else chatEl.innerHTML = '<div class="msg msg-system msg-placeholder"><div class="msg-body">Conversation loaded.</div></div>';
  await hydrateMediaResultCards(chatEl);
  // Batch remount skills — single renderFileTree at the end
  for (const s of skills) { if (s.active) await mountSkillToVfs(s, true); }
  renderFileTree();
  updateMemoryUI();
  closeFileViewer(true);
  visibleConversationState = captureConversationState(chatEl.innerHTML);
  _switchLoadInFlight = false;
  syncLegacyRunFlags();
  updateButtons();
  setStatus('ready', t('status.ready'));
}

async function deleteConversation(id) {
  ensureVisibleConversationStateActive();
  const run = conversationRuns.get(id);
  if (run) {
    run.deleted = true;
    stopConversationRun(id);
    conversationRuns.delete(id);
  }
  if (window._daytonaSessions && window._daytonaSessions[id]) {
    daytonaClient.destroy(id).catch(() => {});
  }
  convHistory = convHistory.filter(c => c.id !== id);
  await deleteConvDataFromDB(id);
  if ((visibleConvId || activeConvId) === id) {
    if (convHistory.length) await switchConversation(convHistory[0].id, true);
    else newConversation(true);
  }
  saveConvMeta();
  renderConvList();
}

function renameConversation(id) {
  const conv = convHistory.find(c => c.id === id);
  if (!conv) return;
  const item = document.querySelector(`.conv-item[data-id="${id}"]`);
  if (!item) return;
  const titleEl = item.querySelector('.c-title');
  const oldTitle = conv.title;
  const input = document.createElement('input');
  input.className = 'fe-rename';
  input.value = oldTitle;
  input.style.cssText = 'width:100%;font-size:11px';
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  function commit() {
    const val = input.value.trim();
    if (val && val !== oldTitle) {
      conv.title = val;
      conv.titleSource = 'manual';
      conv.titleStatus = 'done';
      saveConvMeta();
    }
    renderConvList();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.value = oldTitle; input.blur(); }
  });
}

