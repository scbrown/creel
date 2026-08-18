/* creel harness — part 6 of 26: conversation-store
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
 * Continues the previous part: BLOB STORE — content-addressed binary storage (cont. 2)
 */
function showConvCtxMenu(e, id) {
  e.preventDefault();
  e.stopPropagation();
  closeConvCtxMenu();
  const conv = convHistory.find(c => c.id === id);
  const menu = document.createElement('div');
  menu.className = 'fe-ctx';
  menu.id = 'convCtxMenu';
  const moveItems = [
    `<div class="fe-ctx-item" onclick="closeConvCtxMenu();moveConvToFolder('${esc(id)}', '')">${conv && !conv.folderId ? '<svg class="ui-icon" aria-hidden="true"><use href="#i-check"></use></svg> ' : ''}${esc(t('action.moveToRoot'))}</div>`,
    ...convFolders.map(f => `<div class="fe-ctx-item" onclick="closeConvCtxMenu();moveConvToFolder('${esc(id)}', '${esc(f.id)}')">${conv && conv.folderId === f.id ? '<svg class="ui-icon" aria-hidden="true"><use href="#i-check"></use></svg> ' : ''}<svg class="ui-icon" aria-hidden="true"><use href="#i-folder"></use></svg> ${esc(f.name)}</div>`)
  ].join('');
  menu.innerHTML = `<div class="fe-ctx-item" onclick="closeConvCtxMenu();renameConversation('${esc(id)}')"><svg class="ui-icon" aria-hidden="true"><use href="#i-pencil"></use></svg> Rename</div>` +
    `<div class="fe-ctx-sep"></div>` +
    `<div class="fe-ctx-item" style="color:var(--text-dim);cursor:default;pointer-events:none">${esc(t('action.moveToFolder'))}</div>` +
    moveItems +
    `<div class="fe-ctx-sep"></div>` +
    `<div class="fe-ctx-item danger" onclick="closeConvCtxMenu();deleteConversation('${esc(id)}')"><svg class="ui-icon" aria-hidden="true"><use href="#i-trash"></use></svg> Delete</div>`;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);
  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
  setTimeout(() => document.addEventListener('click', closeConvCtxMenu, { once: true }), 0);
}

function showFolderCtxMenu(e, id) {
  e.preventDefault();
  e.stopPropagation();
  closeConvCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'fe-ctx';
  menu.id = 'convCtxMenu';
  menu.innerHTML = `<div class="fe-ctx-item" onclick="closeConvCtxMenu();renameConvFolder('${esc(id)}')"><svg class="ui-icon" aria-hidden="true"><use href="#i-pencil"></use></svg> ${esc(t('action.renameFolder'))}</div>` +
    `<div class="fe-ctx-sep"></div>` +
    `<div class="fe-ctx-item danger" onclick="closeConvCtxMenu();deleteConvFolder('${esc(id)}')"><svg class="ui-icon" aria-hidden="true"><use href="#i-trash"></use></svg> ${esc(t('action.deleteFolder'))}</div>`;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
  setTimeout(() => document.addEventListener('click', closeConvCtxMenu, { once: true }), 0);
}

function closeConvCtxMenu() {
  const m = document.getElementById('convCtxMenu');
  if (m) m.remove();
}

function genFolderId() { return 'fld_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function newConvFolder() {
  const name = prompt(t('action.folderName'), t('action.newConvFolder'));
  if (!name || !name.trim()) return;
  convFolders.push({ id: genFolderId(), name: name.trim(), expanded: true });
  saveConvFoldersToDB();
  renderConvList();
}

function renameConvFolder(id) {
  const f = convFolders.find(x => x.id === id);
  if (!f) return;
  const name = prompt(t('action.folderName'), f.name);
  if (!name || !name.trim() || name.trim() === f.name) return;
  f.name = name.trim();
  saveConvFoldersToDB();
  renderConvList();
}

function deleteConvFolder(id) {
  if (!confirm(t('action.deleteFolderConfirm'))) return;
  convFolders = convFolders.filter(f => f.id !== id);
  for (const c of convHistory) { if (c.folderId === id) delete c.folderId; }
  saveConvFoldersToDB();
  saveConvMeta();
  renderConvList();
}

function toggleConvFolder(id) {
  const f = convFolders.find(x => x.id === id);
  if (!f) return;
  f.expanded = !f.expanded;
  saveConvFoldersToDB();
  renderConvList();
}

function moveConvToFolder(convId, folderId) {
  const c = convHistory.find(x => x.id === convId);
  if (!c) return;
  if (folderId) {
    if (!convFolders.some(f => f.id === folderId)) return;
    if (c.folderId === folderId) return;
    c.folderId = folderId;
  } else {
    if (!c.folderId) return;
    delete c.folderId;
  }
  saveConvMeta();
  renderConvList();
}

let _convDragId = null;
function onConvDragStart(e, id) {
  _convDragId = id;
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch {}
  const el = e.currentTarget;
  if (el && el.classList) el.classList.add('dragging');
}
function onConvDragEnd(e) {
  _convDragId = null;
  document.querySelectorAll('.conv-folder.drop-target, .conv-list.drop-target, .conv-item.dragging').forEach(n => n.classList.remove('drop-target', 'dragging'));
}
function onConvDragOver(e, el) {
  if (!_convDragId) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch {}
  if (el && el.classList) el.classList.add('drop-target');
}
function onConvDragLeave(e, el) {
  if (el && el.classList) el.classList.remove('drop-target');
}
function onConvDropToFolder(e, folderId) {
  e.preventDefault(); e.stopPropagation();
  const id = _convDragId;
  const el = e.currentTarget;
  if (el && el.classList) el.classList.remove('drop-target');
  if (!id) return;
  moveConvToFolder(id, folderId);
}
function onConvDropToRoot(e) {
  const tgt = e.target.closest ? e.target.closest('.conv-folder, .conv-item') : null;
  if (tgt && tgt.classList.contains('conv-folder')) return; // let folder handler run
  e.preventDefault();
  const list = document.getElementById('convList');
  if (list) list.classList.remove('drop-target');
  const id = _convDragId;
  if (!id) return;
  moveConvToFolder(id, '');
}
function onConvListDragOver(e) {
  if (!_convDragId) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch {}
  const list = document.getElementById('convList');
  if (list) list.classList.add('drop-target');
}
function onConvListDragLeave(e) {
  const list = document.getElementById('convList');
  if (!list) return;
  if (!list.contains(e.relatedTarget)) list.classList.remove('drop-target');
}

const CONV_RENDER_BATCH_SIZE = 80;
let convRenderLimit = CONV_RENDER_BATCH_SIZE;
let convSearchQuery = '';
let _convRenderedCount = 0;
let _convTotalCount = 0;

function _convTemplate(key, fallback, data = {}) {
  let text = t(key, fallback);
  for (const [k, v] of Object.entries(data)) text = text.replaceAll('{' + k + '}', String(v));
  return text;
}

function _convSearchText(c, folder) {
  const shortDate = new Date(c.updated || c.created || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fullDate = new Date(c.updated || c.created || Date.now()).toLocaleDateString();
  return [
    c.title || '',
    c.id || '',
    shortDate,
    fullDate,
    String(c.messageCount || 0) + 'msg',
    folder?.name || ''
  ].join(' ').toLowerCase();
}

function onConvSearchInput(value) {
  convSearchQuery = String(value || '');
  convRenderLimit = CONV_RENDER_BATCH_SIZE;
  renderConvList();
}

function toggleConvSearch() {
  const row = document.getElementById('convSearchRow');
  const input = document.getElementById('convSearchInput');
  const btn = document.getElementById('convSearchToggle');
  if (!row) return;
  const hasQuery = !!String(input?.value || '').trim();
  const show = !row.classList.contains('show') || hasQuery;
  row.classList.toggle('show', show);
  btn?.classList.toggle('active', show);
  if (show) setTimeout(() => { input?.focus(); if (hasQuery) input?.select(); }, 0);
}

function clearConvSearch() {
  const input = document.getElementById('convSearchInput');
  if (input) input.value = '';
  convSearchQuery = '';
  document.getElementById('convSearchRow')?.classList.remove('show');
  document.getElementById('convSearchToggle')?.classList.remove('active');
  onConvSearchInput('');
}

function loadMoreConversations(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  if (_convRenderedCount >= _convTotalCount) return;
  convRenderLimit += CONV_RENDER_BATCH_SIZE;
  renderConvList({ preserveScroll: true });
}

function onConvListScroll() {
  const el = document.getElementById('convList');
  if (!el || _convRenderedCount >= _convTotalCount) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 32) loadMoreConversations();
}

function renderConvList(options = {}) {
  const el = document.getElementById('convList');
  if (!el) return;
  const meta = document.getElementById('convListMeta');
  const input = document.getElementById('convSearchInput');
  const clearBtn = document.getElementById('convSearchClear');
  const searchRow = document.getElementById('convSearchRow');
  const searchToggle = document.getElementById('convSearchToggle');
  if (input && input.value !== convSearchQuery) input.value = convSearchQuery;
  const q = String(convSearchQuery || '').trim().toLowerCase();
  if (clearBtn) clearBtn.classList.toggle('show', !!q);
  if (q) {
    searchRow?.classList.add('show');
    searchToggle?.classList.add('active');
  }
  const prevScroll = options.preserveScroll ? el.scrollTop : 0;
  if (!convHistory.length && !convFolders.length) {
    el.innerHTML = '<div class="conv-list-empty">No conversations</div>';
    if (meta) meta.textContent = '';
    _convRenderedCount = 0; _convTotalCount = 0;
    return;
  }
  const convItemHtml = (c, opts = {}) => {
    const active = c.id === (visibleConvId || activeConvId) ? ' active' : '';
    const running = isConversationRunning(c.id) ? ' running' : '';
    const inFolder = opts.inFolder ? ' in-folder' : '';
    const time = new Date(c.updated || c.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const msgs = Number(c.messageCount || 0);
    const dragAttrs = opts.searchMode ? 'draggable="false"' : `draggable="true" ondragstart="onConvDragStart(event,'${esc(c.id)}')" ondragend="onConvDragEnd(event)"`;
    const runDot = running ? '<span class="c-run" title="Running"></span>' : '';
    return `<div class="conv-item${active}${running}${inFolder}" data-id="${esc(c.id)}" ${dragAttrs} onclick="switchConversation('${esc(c.id)}')" oncontextmenu="showConvCtxMenu(event,'${esc(c.id)}')">
      ${runDot}
      <span class="c-title">${esc(c.title || 'New Chat')}</span>
      <span class="c-time">${msgs}msg ${time}</span>
      <span class="c-del" onclick="event.stopPropagation();deleteConversation('${esc(c.id)}')" title="Delete">&times;</span>
    </div>`;
  };
  const folderIds = new Set(convFolders.map(f => f.id));
  const folderById = new Map(convFolders.map(f => [f.id, f]));
  const parts = [];
  let shown = 0;
  let total = 0;
  const pushMore = () => {
    if (shown >= total) return;
    const n = Math.min(CONV_RENDER_BATCH_SIZE, total - shown);
    parts.push(`<button type="button" class="conv-list-more" onclick="loadMoreConversations(event)">${esc(_convTemplate('conv.loadMore', 'Load {n} more', { n }))}</button>`);
  };
  if (q) {
    for (const f of convFolders) {
      const folderHit = String(f.name || '').toLowerCase().includes(q);
      const children = convHistory.filter(c => c.folderId === f.id && (folderHit || _convSearchText(c, f).includes(q)));
      if (!children.length) continue;
      total += children.length;
      const visible = children.slice(0, Math.max(0, convRenderLimit - shown));
      if (!visible.length) continue;
      parts.push(`<div class="conv-folder open" data-folder-id="${esc(f.id)}" oncontextmenu="showFolderCtxMenu(event,'${esc(f.id)}')">
        <span class="cf-arrow">&#x25B6;</span>
        <span class="cf-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-folder"></use></svg></span>
        <span class="cf-name">${esc(f.name)}</span>
        <span class="cf-count">${children.length}</span>
      </div>`);
      for (const c of visible) { parts.push(convItemHtml(c, { inFolder: true, searchMode: true })); shown++; }
    }
    const rootMatches = convHistory.filter(c => (!c.folderId || !folderIds.has(c.folderId)) && _convSearchText(c, folderById.get(c.folderId)).includes(q));
    total += rootMatches.length;
    for (const c of rootMatches.slice(0, Math.max(0, convRenderLimit - shown))) {
      parts.push(convItemHtml(c, { searchMode: true }));
      shown++;
    }
  } else {
    const expandedFolderIds = new Set(convFolders.filter(f => f.expanded).map(f => f.id));
    total = convHistory.filter(c => !c.folderId || !folderIds.has(c.folderId) || expandedFolderIds.has(c.folderId)).length;
    for (const f of convFolders) {
      const children = convHistory.filter(c => c.folderId === f.id);
      const openCls = f.expanded ? ' open' : '';
      parts.push(`<div class="conv-folder${openCls}" data-folder-id="${esc(f.id)}" onclick="toggleConvFolder('${esc(f.id)}')" oncontextmenu="showFolderCtxMenu(event,'${esc(f.id)}')" ondragover="onConvDragOver(event,this)" ondragleave="onConvDragLeave(event,this)" ondrop="onConvDropToFolder(event,'${esc(f.id)}')">
        <span class="cf-arrow">&#x25B6;</span>
        <span class="cf-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-folder"></use></svg></span>
        <span class="cf-name">${esc(f.name)}</span>
        <span class="cf-count">${children.length}</span>
        <span class="cf-add" title="${esc(t('action.newConv'))}" onclick="event.stopPropagation();newConversation(false,'${esc(f.id)}')"><svg class="ui-icon" aria-hidden="true"><use href="#i-plus"></use></svg></span>
      </div>`);
      if (f.expanded && shown < convRenderLimit) {
        const visible = children.slice(0, convRenderLimit - shown);
        for (const c of visible) { parts.push(convItemHtml(c, { inFolder: true })); shown++; }
      }
    }
    if (shown < convRenderLimit) {
      for (const c of convHistory) {
        if (c.folderId && folderIds.has(c.folderId)) continue;
        if (shown >= convRenderLimit) break;
        parts.push(convItemHtml(c));
        shown++;
      }
    }
  }
  if (!parts.length) parts.push(`<div class="conv-list-empty">${esc(t(q ? 'conv.noMatches' : 'status.empty', q ? 'No conversations matched.' : 'No conversations'))}</div>`);
  else pushMore();
  _convRenderedCount = shown;
  _convTotalCount = total;
  if (meta) {
    const key = q ? 'conv.matching' : 'conv.showing';
    const fallback = q ? 'Matches {shown} / {total}' : 'Showing {shown} / {total}';
    meta.innerHTML = `<span class="${q ? 'hot' : ''}">${esc(_convTemplate(key, fallback, { shown, total }))}</span>`;
  }
  el.innerHTML = parts.join('');
  if (options.preserveScroll) el.scrollTop = prevScroll;
}

function resetConversationContext() {
  ensureVisibleConversationStateActive();
  if (!activeConvId || !sessionEntries.length) return;
  appendSessionEntry('compaction', {
    summary: 'Context reset. Previous visible conversation history was intentionally excluded from future model context.',
    firstKeptEntryId: null,
    tokensBefore: contextTokens,
    trigger: 'manual_reset',
    retainedEntryCount: 0
  });
  rebuildConversation();
  contextTokens = 0;
  lastRequestContextSnapshot = null;
  lastContextBreakdown = null;
  lastTurnTokens = 0;
  contextBreakdownExpanded = false;
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  updateMemoryUI();
  document.getElementById('memoryLog').innerHTML = '';
  appendSystemMsg('Context reset. Previous messages remain visible but will be excluded from future model context.');
  saveCurrentConv(true);
}

function clearConversation() {
  ensureVisibleConversationStateActive();
  conversation = [];
  sessionEntries = [];
  activeEntryId = null;
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
  chatEl.innerHTML = '<div class="msg msg-system msg-placeholder"><div class="msg-body">Conversation cleared. Type a task to begin.</div></div>';
  todos = [];
  if (typeof renderTodos === 'function') renderTodos();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  updateMemoryUI();
  document.getElementById('memoryLog').innerHTML = '';
  saveCurrentConv(true);
}

