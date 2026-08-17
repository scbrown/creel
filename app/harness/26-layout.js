/* creel harness — part 26 of 26: layout
 *
 * Extracted verbatim from app/onepagent.html (creel-yny). These are CLASSIC
 * scripts, deliberately not modules: classic scripts share one global lexical
 * environment, so top-level const/let and function declarations stay visible
 * across every part and to the inline onclick= handlers in the markup. That
 * shared scope is what let the split be mechanical rather than a rewrite.
 *
 * THE LOAD ORDER IN onepagent.html IS PART OF THE SEMANTICS. Do not reorder
 * the tags, do not add defer or async, and do not move a declaration across a
 * file boundary without checking what reads it while the page is loading.
 *
 * Sections here:
 *   - PANEL RESIZE (drag handles)
 *   - COLLAPSIBLE SECTIONS
 */
// ═══════════════════════════════════════════════════════════════════
// PANEL RESIZE (drag handles)
// ═══════════════════════════════════════════════════════════════════
(function initResize() {
  const app = document.querySelector('.app');
  const leftHandle = document.getElementById('resizeLeft');
  const rightHandle = document.getElementById('resizeRight');
  const MIN_W = 160, MAX_W = 500;
  let leftW = parseInt(localStorage.getItem('ba_left_w')) || 260;
  let rightW = parseInt(localStorage.getItem('ba_right_w')) || 300;
  let leftCollapsed = localStorage.getItem('ba_left_col') === '1';
  let rightCollapsed = localStorage.getItem('ba_right_col') === '1';

  function applyWidths() {
    app.style.setProperty('--left-w',  leftCollapsed  ? '0px' : leftW  + 'px');
    app.style.setProperty('--right-w', rightCollapsed ? '0px' : rightW + 'px');
    app.style.setProperty('--left-handle-w',  leftCollapsed  ? '0px' : '4px');
    app.style.setProperty('--right-handle-w', rightCollapsed ? '0px' : '4px');
    leftHandle.style.visibility  = leftCollapsed  ? 'hidden' : '';
    leftHandle.style.pointerEvents = leftCollapsed ? 'none' : '';
    rightHandle.style.visibility = rightCollapsed ? 'hidden' : '';
    rightHandle.style.pointerEvents = rightCollapsed ? 'none' : '';
    const lp = document.querySelector('.left-panel');
    const rp = document.querySelector('.right-panel');
    if (lp) { lp.style.overflow = leftCollapsed ? 'hidden' : ''; lp.style.visibility = leftCollapsed ? 'hidden' : ''; }
    if (rp) { rp.style.overflow = rightCollapsed ? 'hidden' : ''; rp.style.visibility = rightCollapsed ? 'hidden' : ''; }
    const tl = document.getElementById('toggleLeft');
    const tr = document.getElementById('toggleRight');
    if (tl) tl.textContent = leftCollapsed  ? '\u203A' : '\u2039';
    if (tr) tr.textContent = rightCollapsed ? '\u2039' : '\u203A';
  }
  applyWidths();

  // Exposed globally for toggle buttons
  window.isMobileLayout = function() { return window.matchMedia('(max-width:1024px)').matches; };
  window.closeMobileDrawers = function() {
    document.querySelector('.left-panel')?.classList.remove('mobile-open');
    document.querySelector('.right-panel')?.classList.remove('mobile-open');
    document.getElementById('mobileBackdrop')?.classList.remove('show');
  };
  window.addEventListener('resize', () => { if (!window.isMobileLayout()) window.closeMobileDrawers(); });
  window.togglePanel = function(side) {
    if (window.isMobileLayout()) {
      const lp = document.querySelector('.left-panel');
      const rp = document.querySelector('.right-panel');
      const bd = document.getElementById('mobileBackdrop');
      const target = side === 'left' ? lp : rp;
      const other = side === 'left' ? rp : lp;
      other?.classList.remove('mobile-open');
      target?.classList.toggle('mobile-open');
      if (bd) bd.classList.toggle('show', !!(lp?.classList.contains('mobile-open') || rp?.classList.contains('mobile-open')));
      return;
    }
    if (side === 'left') {
      leftCollapsed = !leftCollapsed;
      try { localStorage.setItem('ba_left_col', leftCollapsed ? '1' : '0'); } catch {}
    } else {
      rightCollapsed = !rightCollapsed;
      try { localStorage.setItem('ba_right_col', rightCollapsed ? '1' : '0'); } catch {}
    }
    applyWidths();
  };

  function startDrag(handle, side) {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      handle.classList.add('dragging');
      const startX = e.clientX;
      const startW = side === 'left' ? leftW : rightW;
      function onMove(e) {
        const delta = e.clientX - startX;
        let newW = side === 'left' ? startW + delta : startW - delta;
        newW = Math.max(MIN_W, Math.min(MAX_W, newW));
        if (side === 'left') leftW = newW; else rightW = newW;
        applyWidths();
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem('ba_left_w', leftW); localStorage.setItem('ba_right_w', rightW); } catch {}
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  startDrag(leftHandle, 'left');
  startDrag(rightHandle, 'right');
})();

// ═══════════════════════════════════════════════════════════════════
// COLLAPSIBLE SECTIONS
// ═══════════════════════════════════════════════════════════════════
function toggleSection(titleEl) {
  const section = titleEl.closest('.panel-section');
  if (!section) return;
  section.classList.toggle('collapsed');
  const key = section.dataset.section;
  if (key) {
    try {
      const collapsed = JSON.parse(localStorage.getItem('ba_sections_col') || '{}');
      collapsed[key] = section.classList.contains('collapsed');
      localStorage.setItem('ba_sections_col', JSON.stringify(collapsed));
    } catch {}
  }
}
(function restoreSectionState() {
  try {
    const collapsed = JSON.parse(localStorage.getItem('ba_sections_col') || '{}');
    for (const [key, val] of Object.entries(collapsed)) {
      if (val) {
        const el = document.querySelector(`.panel-section[data-section="${key}"]`);
        if (el) el.classList.add('collapsed');
      }
    }
  } catch {}
})();

// ── Legacy migration ──────────────────────────────────────────────
// Older conversation records stored binary bytes inline as
// `bytes: Uint8Array` on vfs file nodes. Rewrite them to `{hash,size}` and
// stash bytes into the blob store. Idempotent: records are stamped with a
// `_schema: 'v3-hashed'` marker so we don't re-ref blobs on subsequent boots.
async function _migrateLegacyVfsBytes() {
  try {
    const db = await openConvDB();
    const keys = await new Promise((res, rej) => {
      const tx = db.transaction(CONV_STORE, 'readonly');
      const r = tx.objectStore(CONV_STORE).getAllKeys();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
    let migratedCount = 0;
    for (const key of keys) {
      const record = await loadConvDataFromDB(key);
      if (!record) continue;
      if (record._schema === 'v3-hashed') continue;
      const hadBytes = await _migrateVfsTree(record.vfs);
      record._schema = 'v3-hashed';
      await saveConvDataToDB(key, record);
      if (hadBytes) migratedCount++;
    }
    if (migratedCount) console.log(`[blob migration] Rewrote ${migratedCount} conversation record(s).`);
  } catch (e) {
    console.warn('[blob migration] failed:', e);
  }
}

async function _migrateVfsTree(node) {
  if (!node || typeof node !== 'object') return false;
  let hadBytes = false;
  if (node.type === 'file' && node.binary && node.bytes instanceof Uint8Array && !node.hash) {
    const { hash, size } = await blobStore.put(node.bytes);
    node.hash = hash;
    node.size = size;
    delete node.bytes;
    if (!node.content) node.content = `[Binary: ${size} bytes]`;
    hadBytes = true;
  }
  if (node.type === 'dir' && node.children) {
    for (const ch of Object.values(node.children)) {
      if (await _migrateVfsTree(ch)) hadBytes = true;
    }
  }
  return hadBytes;
}

// Init
marked.setOptions({ gfm: true, breaks: true });
(async function init() {
  applyI18n();
  // Ask the browser to make this origin's storage non-evictable: on mobile
  // especially, IndexedDB/OPFS can be purged under storage pressure, which
  // looks exactly like "conversations aren't getting saved". No-op when
  // unsupported or denied — saves still work, just evictable.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch {}
  // Autosave while any agent run is active: mobile browsers rarely fire
  // beforeunload when they evict a background tab, so a long run used to be
  // recoverable only from the last run-completion save. Now the worst case is
  // losing the last 20 seconds, not the whole session.
  setInterval(() => {
    if (conversationRuns.size > 0 || currentRunContext) saveCurrentConv();
  }, 20000);
  updateLangButton();
  initThinkingControl();
  initMediaGenerationControls();
  await blobStore.init();
  await _migrateLegacyVfsBytes();
  await loadSkills();
  rebuildToolDefs();
  await loadConvHistory();
  updateMemoryUI();
  loadWsConfig();
  renderHooks();
  renderSwarmRoles();
  renderTodos();
  renderSubAgents();
  renderRalphButton();
  renderMemoryButton();
  if (memIsEnabled()) { memLoadCache().catch(e => console.warn('Memory cache preload failed', e)); }
  // Connect MCP servers in the background — don't block UI startup on a slow
  // or unreachable server.
  initAllMcpServers().catch(e => console.warn('MCP auto-connect failed:', e));

  // Load API keys from active provider profile + local settings
  try {
    const p = getActiveProviderProfile();
    if (p) { ACTIVE_PROVIDER = p; setActiveProviderId(p.id); PROVIDER = p.type || 'openai_compat'; }
    _keys = {
      api_key: (ACTIVE_PROVIDER && ACTIVE_PROVIDER.apiKey) ? ACTIVE_PROVIDER.apiKey : (_userSettings.api_key || CFG.api_key || ''),
      tavily_api_key: _userSettings.tavily_api_key || CFG.tavily_api_key || '',
      api_endpoint: (ACTIVE_PROVIDER && ACTIVE_PROVIDER.endpoint) ? ACTIVE_PROVIDER.endpoint : (_userSettings.api_endpoint || CFG.api_endpoint || (PROVIDER === 'anthropic_compat' ? 'https://api.anthropic.com' : 'https://api.openai.com')),
      api_model: API_MODEL,
      api_models: (ACTIVE_PROVIDER && Array.isArray(ACTIVE_PROVIDER.models)) ? ACTIVE_PROVIDER.models : (_userSettings.api_models || CFG.api_models || []),
      model_contexts: (ACTIVE_PROVIDER && ACTIVE_PROVIDER.model_contexts) ? ACTIVE_PROVIDER.model_contexts : (_userSettings.model_contexts || CFG.model_contexts || {})
    };
    CFG.api_endpoint = _keys.api_endpoint;
    if (_keys.model_contexts && typeof _keys.model_contexts === 'object') Object.assign(MODEL_CONTEXTS, _keys.model_contexts);
    applyModelContextLimit();
    updateWsStatus();
    populateProviderSelect();
    populateModelSelectFromActiveProvider();
    if (!_keys.api_key) {
      appendSystemMsg('No LLM API key configured. Click Settings in the top bar to add one.');
    }
    let models = _keys.api_models || [];
    if (!models.length && _keys.api_key) models = await fetchModelList();
    // Persist fetched models into active provider profile for convenience
    try {
      if (ACTIVE_PROVIDER && models.length) {
        const providers = getProvidersMap();
        const cur = providers[ACTIVE_PROVIDER.id];
        if (cur) { cur.models = models; providers[ACTIVE_PROVIDER.id] = cur; _saveProviders({ providers }); ACTIVE_PROVIDER = cur; }
      }
    } catch {}
    if (models.length) { populateModelSelectFromActiveProvider(); }
  } catch (e) {
    console.error('Init error:', e);
    appendSystemMsg('Init failed: ' + e.message);
  }
})();

// Auto-save on page unload (pagehide fires more reliably than beforeunload on
// mobile tab eviction; the double listener is idempotent — same state saved).
window.addEventListener('beforeunload', () => { saveCurrentConv(); });
window.addEventListener('pagehide', () => { saveCurrentConv(); });

// ── Leave warning ─────────────────────────────────────────────────
// Closing or navigating away from a creel tab is destructive: a live agent
// loop dies with it and unsent work is lost. Pop the browser's native
// beforeunload dialog whenever there is anything to lose — a conversation
// with real content, or live fleet activity in any tab (mirrored to
// localStorage by creel-fleet.js, since unload handlers must be sync).
// The predicate is pure and synchronous, fenced below so the unit test
// evaluates this exact source (tests/test-leave-warning.js). The app's own
// programmatic closes (fleet abort) set window.__creelSuppressLeaveWarn.
// BEGIN creelShouldWarnOnLeave
window.creelShouldWarnOnLeave = function creelShouldWarnOnLeave() {
  try {
    const chat = document.getElementById('chatMessages');
    if (chat && chat.querySelector('.msg:not(.msg-placeholder)')) return true;
    try {
      const live = parseInt(localStorage.getItem('creel_fleet_live') || '0', 10) || 0;
      if (live > 0) return true;
    } catch {}
  } catch {}
  return false;
};
// END creelShouldWarnOnLeave
window.addEventListener('beforeunload', (e) => {
  if (window.__creelSuppressLeaveWarn) return;
  if (!window.creelShouldWarnOnLeave()) return;
  e.preventDefault();
  e.returnValue = '';
});

// Boot the cron scheduler (tab-only — clears on unload)
try {
  if (typeof CronScheduler !== 'undefined' && CronScheduler && typeof CronScheduler.start === 'function') {
    CronScheduler.start();
  }
} catch (e) { console.warn('CronScheduler.start failed', e); }
