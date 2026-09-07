/* creel harness — part 26 of 26: layout
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
/* ── Progressive disclosure of the left panel (creel-ban) ─────────
 *
 * The panel used to stack eleven sections, so every operator saw the union of
 * every feature creel has whether they used it or not. Four are always there;
 * the rest are hidden until asked for, and stay once asked for.
 *
 * Hidden means the `hidden` attribute, which takes a section out of the
 * accessibility tree as well as the layout — so ui_snapshot describes the
 * panel an operator is actually looking at, and an agent is not offered
 * controls the human cannot see either. Nothing is removed: every section is
 * one click away in the chip list, and revealing one is the same operation for
 * an agent (ui_click on its chip) as for the operator.
 */
const PANEL_SHOWN_KEY = 'creel_panel_shown';

function _panelShown() {
  try { return new Set(JSON.parse(localStorage.getItem(PANEL_SHOWN_KEY) || '[]')); }
  catch { return new Set(); }
}
function _savePanelShown(set) {
  try { localStorage.setItem(PANEL_SHOWN_KEY, JSON.stringify([...set])); } catch {}
}

/** A section's human label — the same text the chip carries, so an agent that
 *  read the chip can find the section it revealed. */
function _sectionLabel(el) {
  const title = el.querySelector('.section-title');
  if (!title) return el.dataset.section || '';
  const named = title.querySelector('[data-i18n^="section."]');
  return (named ? named.textContent : title.textContent).trim().split('\n')[0];
}

function renderPanelMore() {
  const box = document.getElementById('panelMoreChips');
  if (!box) return;
  const shown = _panelShown();
  box.textContent = '';
  for (const el of document.querySelectorAll('.panel-section[data-tier="more"]')) {
    const key = el.dataset.section;
    const on = shown.has(key);
    el.hidden = !on;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'panel-more-chip' + (on ? ' on' : '');
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.textContent = _sectionLabel(el);
    chip.onclick = () => {
      const now = _panelShown();
      if (now.has(key)) now.delete(key); else now.add(key);
      _savePanelShown(now);
      renderPanelMore();
    };
    box.appendChild(chip);
  }
  const toggle = document.getElementById('panelMoreToggle');
  if (toggle) {
    const n = [...document.querySelectorAll('.panel-section[data-tier="more"]')]
      .filter((el) => el.hidden).length;
    toggle.textContent = n ? `${t('panel.more', 'More sections')} (${n})`
                           : t('panel.more', 'More sections');
  }
}

function togglePanelMore() {
  const box = document.getElementById('panelMoreChips');
  const toggle = document.getElementById('panelMoreToggle');
  if (!box || !toggle) return;
  const open = box.hidden;
  box.hidden = !open;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) renderPanelMore();
}

/* Settings groups remember themselves, keyed by the header's i18n id rather
 * than by position — inserting a group must not silently reopen a different
 * one. */
const SETTINGS_OPEN_KEY = 'creel_settings_open';

function _settingsGroupKey(details) {
  const named = details.querySelector('summary [data-i18n]');
  return named ? named.getAttribute('data-i18n') : (details.querySelector('summary')?.textContent || '').trim();
}

function initSettingsGroups() {
  let open = [];
  try { open = JSON.parse(localStorage.getItem(SETTINGS_OPEN_KEY) || '[]'); } catch { /* unreadable */ }
  const set = new Set(open);
  for (const d of document.querySelectorAll('details.settings-group')) {
    const key = _settingsGroupKey(d);
    d.open = set.has(key);
    if (d.dataset.wired) continue;
    d.dataset.wired = '1';
    d.addEventListener('toggle', () => {
      const now = new Set((() => {
        try { return JSON.parse(localStorage.getItem(SETTINGS_OPEN_KEY) || '[]'); } catch { return []; }
      })());
      if (d.open) now.add(key); else now.delete(key);
      try { localStorage.setItem(SETTINGS_OPEN_KEY, JSON.stringify([...now])); } catch { /* full */ }
    });
  }
}

(function initPanelDisclosure() {
  const apply = () => { renderPanelMore(); initSettingsGroups(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();

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
/* Should closing, reloading, or navigating away be interrupted?
 *
 * Deliberately self-contained: this runs inside beforeunload, where nothing
 * may await, a throw silently cancels the warning, and other modules may
 * already be tearing down. It reads storage directly rather than calling
 * across files for that reason.
 *
 * It used to warn whenever the transcript held a message, which is the wrong
 * question — a conversation that has been pushed is not lost by closing the
 * tab, and a prompt that fires every time teaches people to dismiss the one
 * that matters. What is actually at stake is state that exists only here.
 */
window.creelShouldWarnOnLeave = function creelShouldWarnOnLeave() {
  try {
    const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

    // 1. Work in flight. A claimed fleet task outlives this tab's attention
    //    but not this tab, so leaving abandons it either way.
    if ((parseInt(ls('creel_fleet_live') || '0', 10) || 0) > 0) return true;

    // 2. Is there anywhere for state to go? A state repo, or S3 sync.
    let persists = false;
    try {
      const st = JSON.parse(ls('creel_state_repo') || 'null');
      persists = !!(st && st.enabled && st.owner && st.repo);
    } catch { /* unreadable config */ }
    if (!persists) {
      try {
        const s3 = JSON.parse(ls('ba_s3_sync') || 'null');
        persists = !!(s3 && s3.endpoint && s3.bucket && s3.accessKey && s3.secretKey);
      } catch { /* unreadable config */ }
    }

    // 3. With somewhere to push, the question is whether anything is unpushed.
    //    Warning about a pushed conversation is the false alarm that makes the
    //    real one worthless.
    if (persists) {
      const dirty = Number(ls('creel_state_dirty_at') || 0);
      const synced = Number(ls('ba_s3_last_sync') || 0);
      return dirty > synced;
    }

    // 4. With nowhere to push, nothing here can be saved, so anything real in
    //    the transcript is about to be lost.
    const chat = document.getElementById('chatMessages');
    if (chat && chat.querySelector('.msg:not(.msg-placeholder)')) return true;
  } catch { /* never let the guard itself break the unload */ }
  return false;
};
// END creelShouldWarnOnLeave
/* ── Header overflow (creel-ovp) ──────────────────────────────────
 *
 * The top bar carried sixteen controls, most of which an operator touches
 * once a month. The rarely-used ones MOVE into one menu rather than being
 * duplicated there: same element, same id, same handler, same accessible
 * name, so every ui_click that worked before still works — it just has to
 * open the menu first, exactly as a human does.
 *
 * Two things stay out regardless of this list: anything showing an ACTIVE
 * mode, because hiding a mode that is on is worse than showing a button that
 * is off (see docs/ui.md), and the primary actions the default surface is
 * built around.
 */
const HEADER_OVERFLOW = ['exportBtn', 'planBtn', 'ralphBtn', 'memBtn', 'syncBtn', 'langBtn', 'themeToggleBtn'];

/** A control that is announcing an active mode stays in the header. */
function _headerControlIsActive(el) {
  if (!el) return false;
  if (el.classList.contains('active') || el.getAttribute('aria-pressed') === 'true') return true;
  // The sync button grows a dot when state is unpushed — that is a live state,
  // not a dormant action.
  if (el.querySelector('.sync-dirty-dot')) return true;
  return false;
}

/* Each control's home, captured the first time it is seen — while everything
 * is still in the header. Recomputing it later walks up from inside the menu
 * and finds the menu's OWN wrapper, which then gets appended into itself. */
const _headerHomes = new Map();   // id -> { holder, parent, next }

function _headerHome(id, btn) {
  let home = _headerHomes.get(id);
  if (!home) {
    // A button with a dropdown lives in a positioned span; move the pair.
    const holder = btn.closest('.top-right > span') || btn;
    home = { holder, parent: holder.parentNode, next: holder.nextSibling };
    _headerHomes.set(id, home);
  }
  return home;
}

function renderHeaderOverflow() {
  const menu = document.getElementById('moreMenu');
  if (!menu) return;
  for (const id of HEADER_OVERFLOW) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const { holder } = _headerHome(id, btn);
    const active = _headerControlIsActive(btn);
    const inMenu = menu.contains(holder);
    if (active && inMenu) {
      const home = _headerHome(id, btn);
      home.parent.insertBefore(holder, home.next);
      btn.style.width = '';
      btn.style.textAlign = '';
    } else if (!active && !inMenu) {
      // Hidden controls (memBtn ships display:none until memory is on) stay
      // hidden — the menu must not resurrect them.
      menu.appendChild(holder);
      holder.style.display = '';
      btn.style.width = '100%';
      btn.style.textAlign = 'left';
      btn.style.marginBottom = 'var(--space-2)';
    }
  }
}

function toggleMoreMenu() {
  const menu = document.getElementById('moreMenu');
  const btn = document.getElementById('moreBtn');
  if (!menu || !btn) return;
  const open = menu.style.display !== 'block';
  menu.style.display = open ? 'block' : 'none';
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) return;
  const away = (e) => {
    if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      menu.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', away);
    }
  };
  setTimeout(() => document.addEventListener('click', away), 0);
}

/* Modals: announced as dialogs, and always closable.
 *
 * Nine modal overlays are written by hand in thread.html, each one a
 * `.modal-overlay > .modal > .modal-header > h3` with a `×` beside the
 * heading. Left alone that gives an agent a dialog with no role, no name and
 * a close button called "×" — nine of them, indistinguishable. And a
 * modal an agent can open but not close wedges the tab: every later click
 * lands on the overlay.
 *
 * So name them from the markup that is already there, rather than hand-writing
 * an aria-label onto each one and hoping the tenth modal remembers. The
 * heading is the name (by aria-labelledby, so it stays true when the language
 * switches or when the title changes between "Add Hook" and "Edit Hook"), and
 * the close control is named for what it closes. */
function nameModal(overlay) {
  const modal = overlay.querySelector('.modal');
  const h3 = overlay.querySelector('.modal-header h3');
  if (!modal || !h3) return;
  if (!h3.id) h3.id = (overlay.id || 'modal') + 'Heading';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', h3.id);
  const close = overlay.querySelector('.modal-close');
  // The heading leads with a decorative <svg> and some headings carry a
  // subtitle; the first few words are the part that identifies the dialog.
  const title = (h3.innerText || h3.textContent || '').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 4).join(' ');
  if (close && title) close.setAttribute('aria-label', 'Close ' + title);
}

function nameModals() {
  for (const overlay of document.querySelectorAll('.modal-overlay')) nameModal(overlay);
}

try {
  nameModals();
  // Headings are rewritten as a modal opens (Add Hook / Edit Hook) and when
  // the language toggles, so re-name on the class change that shows one.
  const modalNamer = new MutationObserver((records) => {
    for (const r of records) if (r.target.classList.contains('show')) nameModal(r.target);
  });
  for (const overlay of document.querySelectorAll('.modal-overlay')) {
    modalNamer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
} catch (e) { console.warn('modal naming failed', e); }

/* Escape closes the top-most open modal by pressing its own close control, so
 * Escape and the × mean exactly the same thing — including for the
 * modals where closing is a decision (rejecting a plan, cancelling a request
 * for input) rather than a dismissal. Skips an event another handler has
 * already claimed: the @-mention dropdown and the inline rename inputs both
 * take Escape first, and both preventDefault when they do. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const open = [...document.querySelectorAll('.modal-overlay.show')].pop();
  if (!open) return;
  const close = open.querySelector('.modal-close');
  if (!close) return;
  e.preventDefault();
  close.click();
});

/* Starting a new thread is the most common intent here, so it also gets a
 * keyboard route that does not depend on the left panel being open
 * (creel-jpi). Ctrl/Cmd+Shift+O — the same shape other tools use for it. */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
    e.preventDefault();
    if (typeof newConversation === 'function') newConversation();
  }
});

try {
  renderHeaderOverflow();
  /* Modes toggle at runtime, so this cannot be decided once at boot — but it
   * must not become a timer moving DOM around in every tab either, fleet
   * workers included. React to the things that actually change a mode: a
   * click in the header (that is how every one of them is toggled), and the
   * state-changed hook the sync marker already fires. The slow interval is
   * only a backstop for a mode flipped by an agent through some other path. */
  const bar = document.querySelector('.top-right');
  if (bar) bar.addEventListener('click', () => setTimeout(renderHeaderOverflow, 0));
  const prevHook = window.__creelStateChanged;
  window.__creelStateChanged = () => { try { prevHook?.(); } finally { renderHeaderOverflow(); } };
  setInterval(renderHeaderOverflow, 15000);
} catch (e) { console.warn('header overflow init failed', e); }

// Show the unpushed marker as soon as the page is up — a tab that reloads
// with state still unpushed should say so without being clicked first.
try { if (typeof _renderDirtyIndicator === 'function') _renderDirtyIndicator(); } catch { /* optional */ }

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
