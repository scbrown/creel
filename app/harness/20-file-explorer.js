/* creel harness — part 20 of 26: file-explorer
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
 *   - FILE EXPLORER UI
 */
// ═══════════════════════════════════════════════════════════════════
// FILE EXPLORER UI
// ═══════════════════════════════════════════════════════════════════
const collapsedDirs = new Set();
const seenDirs = new Set();

function shouldDefaultCollapseDir(path) {
  return normPath(path) === '/skills';
}

/* Every row carries role="button" and an aria-label. The FILES tree is where
 * an agent checks its own output before pushing it, and a `<div onclick=...>`
 * has the role `generic` — invisible to ui_snapshot, unresolvable by
 * ui_click. The checkbox is named for its path for the same reason: an
 * unnamed checkbox in a list of twenty is a coin flip. */
function renderFileTree() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const el = document.getElementById('fileTree');
  // Drop stale selections whose path no longer resolves.
  for (const sp of [...feSelected]) { if (!vfsResolve(sp)) feSelected.delete(sp); }
  const items = [];
  (function walk(n, p, d) {
    const es = Object.entries(n.children || {}).sort((a,b) => { const ad = a[1].type === 'dir' ? 0 : 1, bd = b[1].type === 'dir' ? 0 : 1; return ad - bd || a[0].localeCompare(b[0]); });
    for (const [nm, ch] of es) {
      const fp = p + '/' + nm;
      const indent = Math.min(d, 5);
      const sel = feSelected.has(fp) ? ' selected' : '';
      const checkedAttr = feSelected.has(fp) ? ' checked' : '';
      const checkbox = `<input type="checkbox" class="fe-check" data-path="${esc(fp)}" aria-label="Select ${esc(fp)}"${checkedAttr} onclick="feToggleSelect(event,'${esc(fp)}')">`;
      if (ch.type === 'dir') {
        if (!seenDirs.has(fp)) {
          if (shouldDefaultCollapseDir(fp)) collapsedDirs.add(fp);
          else collapsedDirs.delete(fp);
          seenDirs.add(fp);
        }
        const open = !collapsedDirs.has(fp);
        items.push(`<div class="fe-item dir indent-${indent}${sel}" data-path="${esc(fp)}" role="button" tabindex="0" aria-label="Folder ${esc(nm)}" onclick="feToggleDir('${esc(fp)}')" oncontextmenu="feCtx(event,'${esc(fp)}','dir')">${checkbox}<span class="arrow ${open ? 'open' : ''}">&#x25B6;</span><span class="icon">${open ? iconHtml('i:folder-open') : iconHtml('i:folder')}</span><span class="name">${esc(nm)}</span></div>`);
        if (open) walk(ch, fp, d + 1);
      } else {
        const act = currentViewFile === fp ? ' active' : '';
        items.push(`<div class="fe-item indent-${indent}${act}${sel}" data-path="${esc(fp)}" role="button" tabindex="0" aria-label="${esc(nm)}" onclick="openFileViewer('${esc(fp)}')" oncontextmenu="feCtx(event,'${esc(fp)}','file')" draggable="true" ondragstart="feStartDrag(event,'${esc(fp)}')">${checkbox}<span class="arrow"></span><span class="icon">${iconHtml(getFileIcon(nm))}</span><span class="name">${esc(nm)}</span></div>`);
      }
    }
  })(vfs, '', 0);
  el.innerHTML = items.length ? items.join('') : '<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:10px">No files. Upload to start.</div>';
  _feUpdateSelectBar();
}

function feToggleDir(path) { if (collapsedDirs.has(path)) collapsedDirs.delete(path); else collapsedDirs.add(path); renderFileTree(); }
function feExpandAll() { collapsedDirs.clear(); renderFileTree(); }
function feCollapseAll() { vfsWalk('/', (fp) => {}); /* collect dirs */ const dirs = []; (function w(n,p){ if(n.type==='dir'&&n.children){ for(const[nm,ch]of Object.entries(n.children)){const fp=p+'/'+nm; if(ch.type==='dir'){dirs.push(fp);w(ch,fp);}}}})(vfs,''); dirs.forEach(d=>collapsedDirs.add(d)); renderFileTree(); }

// Multi-select state for bulk download
const feSelected = new Set();
function feToggleSelect(ev, path) {
  ev.stopPropagation();
  if (feSelected.has(path)) feSelected.delete(path); else feSelected.add(path);
  // Simplify: if a parent is selected, child individual selections are redundant.
  // We still keep them in the set for visual consistency and let the zip builder de-dup by path prefix.
  renderFileTree();
}
function feClearSelection() { feSelected.clear(); renderFileTree(); }
function feDeleteSelected() {
  ensureVisibleConversationStateActive();
  if (!feSelected.size) return;
  if (!confirm(t('fe.deleteSelectedConfirm') !== 'fe.deleteSelectedConfirm' ? t('fe.deleteSelectedConfirm').replace('{n}', feSelected.size) : `Delete ${feSelected.size} selected item(s)?`)) return;
  for (const sp of [...feSelected]) { vfsDelete(sp); }
  if (currentViewFile && !vfsResolve(currentViewFile)) closeFileViewer(true);
  feSelected.clear();
  renderFileTree();
}
function _feUpdateSelectBar() {
  const bar = document.getElementById('feSelectBar');
  const count = document.getElementById('feSelectCount');
  const dock = document.getElementById('feBottomStack');
  if (!bar || !count) return;
  const hasSelection = feSelected.size > 0;
  bar.style.display = hasSelection ? '' : 'none';
  dock?.classList.toggle('has-selection', hasSelection);
  count.textContent = String(feSelected.size);
}
async function feDownloadSelectedZip() {
  ensureVisibleConversationStateActive();
  if (!feSelected.size) { alert(t('fe.zipEmpty')); return; }
  // Resolve to list of files with their archive paths.
  // For a selected directory /foo, include everything beneath it at "foo/..." in the zip.
  // For a selected file /foo/bar.txt, include it at "foo/bar.txt".
  // Collect archive-relative paths without duplicates.
  const picks = [];
  const seen = new Set();
  for (const sp of feSelected) {
    const node = vfsResolve(sp);
    if (!node) continue;
    if (node.type === 'file') {
      const arcName = sp.replace(/^\/+/, '');
      if (!seen.has(arcName)) { seen.add(arcName); picks.push({ arcName, node, vfsPath: sp }); }
    } else {
      // Directory — recurse.
      const base = sp.replace(/\/+$/, '');
      vfsWalk(sp, (fp, nd) => {
        const arcName = fp.replace(/^\/+/, '');
        if (!seen.has(arcName)) { seen.add(arcName); picks.push({ arcName, node: nd, vfsPath: fp }); }
      });
    }
  }
  if (!picks.length) { alert(t('fe.zipEmpty')); return; }
  // Load bytes for each pick
  const entries = [];
  const enc = new TextEncoder();
  for (const p of picks) {
    let bytes;
    if (p.node.binary) {
      const b = await vfsGetBinary(p.vfsPath);
      bytes = b || new Uint8Array();
    } else {
      bytes = enc.encode(p.node.content || '');
    }
    entries.push({ path: p.arcName, bytes });
  }
  try {
    const zipBytes = await _buildZip(entries);
    const base = _feSelectionZipName();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));
    a.download = base + '.zip';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert(t('fe.zipFailed') + ' ' + (e.message || e));
  }
}
function _feSelectionZipName() {
  if (feSelected.size === 1) {
    const only = [...feSelected][0];
    const name = only.replace(/\/+$/, '').split('/').pop() || 'archive';
    return name;
  }
  const conv = convHistory.find(c => c.id === activeConvId);
  const base = (conv?.title || 'files').replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '') || 'files';
  return base;
}

// Minimal ZIP writer (deflate-raw via CompressionStream; no-compression fallback)
const _ZIP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function _zipCrc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _ZIP_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function _zipDeflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes); writer.close();
    const rdr = cs.readable.getReader();
    const parts = [];
    while (true) { const { done, value } = await rdr.read(); if (done) break; parts.push(value); }
    const total = parts.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0; for (const c of parts) { out.set(c, p); p += c.length; }
    return out;
  } catch { return null; }
}
async function _buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const cdParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.path);
    const raw = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes || 0);
    const crc = _zipCrc32(raw);
    const uncompSize = raw.length;
    let compressed = await _zipDeflate(raw);
    let method = 8;
    if (!compressed || compressed.length >= raw.length) { compressed = raw; method = 0; }
    const compSize = compressed.length;
    const lh = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(lh);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, compSize, true); lv.setUint32(22, uncompSize, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    new Uint8Array(lh, 30).set(nameBytes);
    chunks.push(new Uint8Array(lh));
    chunks.push(compressed);
    const lhOffset = offset;
    offset += 30 + nameBytes.length + compSize;
    const cd = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cd);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, compSize, true); cv.setUint32(24, uncompSize, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
    cv.setUint32(42, lhOffset, true);
    new Uint8Array(cd, 46).set(nameBytes);
    cdParts.push(new Uint8Array(cd));
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of cdParts) { chunks.push(c); cdSize += c.length; offset += c.length; }
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, cdParts.length, true); ev.setUint16(10, cdParts.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(new Uint8Array(eocd));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// Context menu
let feCtxEl = null;
function feCtx(e, path, type) {
  e.preventDefault(); e.stopPropagation();
  feCloseCtx();
  const menu = document.createElement('div');
  menu.className = 'fe-ctx';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  const items = [];
  if (type === 'file') {
    items.push({ icon: iconHtml('i:file-text'), label: 'Open', action: () => openFileViewer(path) });
    items.push({ icon: iconHtml('i:pencil'), label: 'Edit', action: () => feEditFile(path) });
    items.push({ icon: '\u{2B07}', label: 'Download', action: () => feDownloadItem(path) });
    items.push('sep');
    items.push({ icon: iconHtml('i:pencil'), label: 'Rename', action: () => feRename(path) });
    items.push({ icon: iconHtml('i:clipboard-list'), label: 'Duplicate', action: () => feDuplicate(path) });
    items.push('sep');
    items.push({ icon: iconHtml('i:trash'), label: 'Delete', action: () => feDeleteItem(path), danger: true });
  } else {
    items.push({ icon: iconHtml('i:plus'), label: 'New File Here', action: () => feNewFileIn(path) });
    items.push({ icon: iconHtml('i:folder'), label: 'New Folder Here', action: () => feNewFolderIn(path) });
    items.push('sep');
    items.push({ icon: iconHtml('i:pencil'), label: 'Rename', action: () => feRename(path) });
    items.push({ icon: '\u{2B07}', label: 'Download', action: () => feDownloadItem(path) });
    items.push('sep');
    items.push({ icon: iconHtml('i:trash'), label: 'Delete', action: () => feDeleteItem(path), danger: true });
  }
  menu.innerHTML = items.map(it => it === 'sep' ? '<div class="fe-ctx-sep"></div>' : `<div class="fe-ctx-item${it.danger ? ' danger' : ''}" data-action="1">${it.icon} ${it.label}</div>`).join('');
  const actionItems = items.filter(it => it !== 'sep');
  menu.querySelectorAll('[data-action]').forEach((el, i) => { el.onclick = () => { feCloseCtx(); actionItems[i].action(); }; });
  document.body.appendChild(menu);
  feCtxEl = menu;
  // Adjust position if overflows
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
}
function feCloseCtx() { if (feCtxEl) { feCtxEl.remove(); feCtxEl = null; } }
document.addEventListener('click', feCloseCtx);
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.fe-item')) feCloseCtx(); });

// File operations
function feDeleteItem(path) {
  ensureVisibleConversationStateActive();
  const name = path.split('/').pop();
  if (!confirm(`Delete "${name}"?`)) return;
  vfsDelete(path);
  if (currentViewFile && (currentViewFile === path || currentViewFile.startsWith(path + '/'))) closeFileViewer();
}

function feRename(path) {
  ensureVisibleConversationStateActive();
  const oldName = path.split('/').pop();
  const el = document.querySelector(`.fe-item[data-path="${CSS.escape(path)}"] .name`);
  if (!el) { const name = prompt('Rename to:', oldName); if (name && name !== oldName) feDoRename(path, name); return; }
  const orig = el.textContent;
  el.innerHTML = `<input class="fe-rename" value="${esc(oldName)}" />`;
  const input = el.querySelector('input');
  input.focus();
  input.setSelectionRange(0, oldName.lastIndexOf('.') > 0 ? oldName.lastIndexOf('.') : oldName.length);
  const finish = () => {
    const newName = input.value.trim();
    if (newName && newName !== oldName) feDoRename(path, newName);
    else renderFileTree();
  };
  input.onblur = finish;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = oldName; input.blur(); } };
}

async function feDoRename(oldPath, newName) {
  ensureVisibleConversationStateActive();
  const parts = oldPath.split('/');
  parts.pop();
  const newPath = parts.join('/') + '/' + newName;
  const node = vfsResolve(oldPath);
  if (!node) return;
  // Graft a metadata copy at the new path (bumping blob refcounts for binary
  // leaves), then delete the original (which unrefs what we just copied).
  const newParts = newPath.slice(1).split('/'); const newName2 = newParts.pop();
  let parent = vfs;
  for (const p of newParts) { if (!parent.children[p]) parent.children[p] = { type: 'dir', children: {} }; parent = parent.children[p]; }
  await _vfsGraftNode(node, parent, newName2);
  vfsDelete(oldPath);
  if (currentViewFile && currentViewFile.startsWith(oldPath)) closeFileViewer();
}

async function feDuplicate(path) {
  ensureVisibleConversationStateActive();
  const node = vfsResolve(path);
  if (!node || node.type !== 'file') return;
  const ext = path.lastIndexOf('.');
  const newPath = ext > 0 ? path.slice(0, ext) + '-copy' + path.slice(ext) : path + '-copy';
  const newParts = newPath.slice(1).split('/'); const newName = newParts.pop();
  let parent = vfs;
  for (const p of newParts) { if (!parent.children[p]) parent.children[p] = { type: 'dir', children: {} }; parent = parent.children[p]; }
  await _vfsGraftNode(node, parent, newName);
  renderFileTree();
}

async function feDownloadItem(path) {
  ensureVisibleConversationStateActive();
  const node = vfsResolve(path);
  if (!node) return;
  if (node.type === 'file') {
    const name = path.split('/').pop();
    if (node.binary) {
      const ext = name.split('.').pop().toLowerCase();
      const bytes = await vfsGetBinary(path);
      if (!bytes) return;
      const blob = new Blob([bytes], { type: getMimeType(ext) });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
    } else downloadBlob(node.content || '', name);
  } else {
    // Download a directory as a real .zip archive.
    const enc = new TextEncoder();
    const entries = [];
    const collected = [];
    vfsWalk(path, (fp, nd) => collected.push({ fp, nd }));
    for (const { fp, nd } of collected) {
      let bytes;
      if (nd.binary) bytes = (await vfsGetBinary(fp)) || new Uint8Array();
      else bytes = enc.encode(nd.content || '');
      entries.push({ path: fp.replace(/^\/+/, ''), bytes });
    }
    const folderName = path.replace(/\/+$/, '').split('/').pop() || 'archive';
    try {
      const zipBytes = await _buildZip(entries);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));
      a.download = folderName + '.zip';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert(t('fe.zipFailed') + ' ' + (e.message || e));
    }
  }
}

function feEditFile(path) {
  ensureVisibleConversationStateActive();
  const node = vfsResolve(path);
  if (!node || node.type !== 'file' || node.binary) { openFileViewer(path); return; }
  currentViewFile = path;
  document.getElementById('fvPath').textContent = path;
  const fvContent = document.getElementById('fvContent');
  fvContent.innerHTML = `<textarea style="width:100%;height:100%;background:var(--bg-root);color:var(--text-primary);border:none;padding:10px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;resize:none;outline:none" id="feEditArea">${esc(node.content || '')}</textarea><div style="padding:6px 10px;border-top:1px solid var(--border);display:flex;gap:6px;justify-content:flex-end"><button class="top-btn" onclick="feSaveEdit()">Save</button><button class="top-btn" onclick="openFileViewer(currentViewFile)">Cancel</button></div>`;
  document.getElementById('fileViewer').classList.add('show');
  document.getElementById('feEditArea').focus();
}

function feSaveEdit() {
  ensureVisibleConversationStateActive();
  if (!currentViewFile) return;
  const area = document.getElementById('feEditArea');
  if (!area) return;
  vfsWrite(currentViewFile, area.value);
  openFileViewer(currentViewFile);
}

function feNewFileIn(dirPath) {
  ensureVisibleConversationStateActive();
  const name = prompt('File name:', 'untitled.txt');
  if (name) vfsWrite(dirPath + '/' + name, '');
}
function feNewFolderIn(dirPath) {
  ensureVisibleConversationStateActive();
  const name = prompt('Folder name:', 'new-folder');
  if (name) { vfsMkdir(dirPath + '/' + name); renderFileTree(); }
}
function getFileIcon(n) { const e = n.split('.').pop().toLowerCase(); return { py:'i:code', js:'i:code', ts:'i:code', html:'i:globe', css:'i:palette', json:'i:braces', md:'i:file-text', yaml:'i:settings', yml:'i:settings', txt:'i:file-text', png:'i:image', jpg:'i:image', jpeg:'i:image', gif:'i:image', webp:'i:image', svg:'i:image', pdf:'i:file', pptx:'i:chart', xlsx:'i:sheet', xls:'i:sheet', docx:'i:file-text', doc:'i:file-text', zip:'i:archive', mp3:'i:music', mp4:'i:film' }[e] || 'i:file-text'; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function iconHtml(icon, cls='ui-icon') {
  const v = (icon == null) ? '' : String(icon).trim();
  const m = v.match(/^i:([a-z0-9-]+)$/i);
  if (m) {
    const id = `i-${m[1].toLowerCase()}`;
    // Note: some browsers/WebViews (notably older Safari/iOS in-app browsers)
    // still require xlink:href for <use>. Provide both for compatibility.
    return `<svg class="${cls}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use href="#${id}" xlink:href="#${id}"></use></svg>`;
  }
  // Fallback: render whatever string was stored (escaped).
  return `<span class="emoji-icon">${esc(v || '')}</span>`;
}


function getMimeType(ext) {
  const m = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', bmp:'image/bmp', webp:'image/webp', svg:'image/svg+xml', ico:'image/x-icon', pdf:'application/pdf', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls:'application/vnd.ms-excel', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc:'application/msword', mp3:'audio/mpeg', mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', avi:'video/x-msvideo', mkv:'video/x-matroska', wav:'audio/wav' };
  return m[ext] || 'application/octet-stream';
}
function isVideoExt(ext) { return ['mp4','webm','mov','avi','mkv'].includes(String(ext || '').toLowerCase()); }

async function openFileViewer(path) {
  // A background run may have left the global vfs/cwd pointed at its own
  // conversation; make sure file reads resolve against the visible one.
  ensureVisibleConversationStateActive();
  path = normPath(path);
  const node = vfsResolve(path);
  if (!node || node.type !== 'file') return;
  currentViewFile = path;
  const viewer = document.getElementById('fileViewer');
  viewer.classList.remove('image-mode');
  document.getElementById('fvPath').textContent = path;
  const ext = path.split('.').pop().toLowerCase();
  const fvContent = document.getElementById('fvContent');
  if (node.binary) {
    const bytes = await vfsGetBinary(path);
    if (!bytes) {
      fvContent.innerHTML = `<div style="padding:20px;color:var(--text-dim)">Binary data unavailable.</div>`;
      document.getElementById('fileViewer').classList.add('show');
      return;
    }
    const size = bytes.length;
    const blob = new Blob([bytes], { type: getMimeType(ext) });
    const url = URL.createObjectURL(blob);

    if (IMAGE_EXTS.has(ext)) {
      viewer.classList.add('image-mode');
      openImageZoomViewer(url, path);
    } else if (isVideoExt(ext)) {
      fvContent.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:16px"><video src="${url}" controls style="max-width:100%;max-height:100%;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,0.3)"></video></div>`;
    } else if (ext === 'pdf') {
      // PDF preview via iframe
      fvContent.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none;border-radius:4px" onload="URL.revokeObjectURL('${url}')"></iframe>`;
    } else if (ext === 'svg') {
      fvContent.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:16px"><img src="${url}" style="max-width:100%;max-height:100%"></div>`;
    } else if (OFFICE_EXTS.has(ext)) {
      // Office files: show info + download button. Try Google Docs Viewer for online preview.
      const sizeKB = (size / 1024).toFixed(1);
      fvContent.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:20px">
        <div style="font-size:48px">${iconHtml({pptx:'i:chart',xlsx:'i:sheet',xls:'i:sheet',docx:'i:file-text',doc:'i:file-text'}[ext] || 'i:folder','ui-icon')}</div>
        <div style="font-size:14px;font-weight:600">${esc(path.split('/').pop())}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${sizeKB} KB &middot; ${ext.toUpperCase()}</div>
        <button class="top-btn" onclick="downloadCurrentFile()" style="padding:8px 20px;font-size:13px">\u{2B07} Download to preview</button>
      </div>`;
    } else {
      // Generic binary
      const sizeKB = (size / 1024).toFixed(1);
      fvContent.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px">
        <div style="font-size:48px">${iconHtml('i:folder','ui-icon')}</div>
        <div style="font-size:13px">${esc(path.split('/').pop())}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${sizeKB} KB</div>
        <button class="top-btn" onclick="downloadCurrentFile()" style="padding:8px 20px">\u{2B07} Download</button>
      </div>`;
    }
  } else if (ext === 'html' || ext === 'htm') {
    openPreviewModal(path, node.content || '', 'html');
    return;
  } else if (ext === 'md' || ext === 'markdown') {
    openPreviewModal(path, node.content || '', 'md');
    return;
  } else {
    // Text file: syntax-highlighted code view.
    // Guard against massive "text" content (e.g. a binary mis-ingested as text)
    // — highlighting + per-line DOM construction for megabytes freezes the page.
    const content = node.content || '';
    if (content.length > MAX_TEXT_PREVIEW_BYTES) {
      const name = path.split('/').pop();
      const sizeKB = (content.length / 1024).toFixed(1);
      const head = esc(content.slice(0, 4000));
      fvContent.innerHTML = `<div style="padding:14px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box">
        <div style="font-size:12px;color:var(--text-secondary)">${esc(name)} is ${sizeKB} KB — preview truncated to first 4 KB to keep the UI responsive. Use Download to get the full file, or Edit to open the raw text.</div>
        <pre style="flex:1;overflow:auto;background:var(--bg-root);padding:10px;border-radius:4px;white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:12px;margin:0">${head}${content.length > 4000 ? '\n\n\u2026 [truncated]' : ''}</pre>
        <div style="display:flex;gap:6px"><button class="top-btn" onclick="downloadCurrentFile()">\u{2B07} Download</button><button class="top-btn" onclick="feEditFile(currentViewFile)">Edit raw</button></div>
      </div>`;
    } else {
      let h;
      try { const lang = hljs.getLanguage(ext) ? ext : 'plaintext'; h = hljs.highlight(content, { language: lang }).value; }
      catch { h = esc(content); }
      fvContent.innerHTML = `<div class="fv-code">${h.split('\n').map((l,i) => `<div class="line"><span class="line-num">${i+1}</span><span class="line-content">${l || ' '}</span></div>`).join('')}</div>`;
    }
  }
  document.getElementById('fileViewer').classList.add('show');
  renderFileTree();
}

function openImageZoomViewer(url, path) {
  const fvContent = document.getElementById('fvContent');
  fvContent.innerHTML = `<div class="image-zoom-stage" id="imageZoomStage"><div class="image-zoom-inner" id="imageZoomInner"><img class="image-zoom-img" id="imageZoomImg" src="${url}" alt="${esc(path)}" draggable="false"></div></div>`;
  const stage = document.getElementById('imageZoomStage');
  const inner = document.getElementById('imageZoomInner');
  const img = document.getElementById('imageZoomImg');
  let scale = 1;
  let dragging = false;
  let dragStartX = 0, dragStartY = 0, scrollStartX = 0, scrollStartY = 0;
  const apply = () => {
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    inner.style.width = Math.max(stage.clientWidth, w) + 'px';
    inner.style.height = Math.max(stage.clientHeight, h) + 'px';
    const panX = w > stage.clientWidth;
    const panY = h > stage.clientHeight;
    stage.classList.toggle('pan-x', panX);
    stage.classList.toggle('pan-y', panY);
    stage.classList.toggle('pannable', panX || panY);
  };
  img.onload = () => {
    const fit = Math.min((stage.clientWidth - 48) / img.naturalWidth, (stage.clientHeight - 48) / img.naturalHeight, 1);
    scale = Math.max(0.05, fit || 1);
    apply();
  };
  stage.onwheel = e => {
    e.preventDefault();
    const before = scale;
    const stageRect = stage.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const anchorX = (e.clientX - imgRect.left) / before;
    const anchorY = (e.clientY - imgRect.top) / before;
    const pointerX = e.clientX - stageRect.left;
    const pointerY = e.clientY - stageRect.top;
    scale = Math.min(8, Math.max(0.05, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    apply();
    const maxScrollLeft = Math.max(0, stage.scrollWidth - stage.clientWidth);
    const maxScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
    stage.scrollLeft = Math.min(maxScrollLeft, Math.max(0, anchorX * scale - pointerX));
    stage.scrollTop = Math.min(maxScrollTop, Math.max(0, anchorY * scale - pointerY));
  };
  stage.onmousedown = e => {
    if (!stage.classList.contains('pannable')) return;
    dragging = true;
    stage.classList.add('panning');
    dragStartX = e.clientX; dragStartY = e.clientY;
    scrollStartX = stage.scrollLeft; scrollStartY = stage.scrollTop;
  };
  window.onmousemove = e => {
    if (!dragging) return;
    stage.scrollLeft = scrollStartX - (e.clientX - dragStartX);
    stage.scrollTop = scrollStartY - (e.clientY - dragStartY);
  };
  window.onmouseup = () => {
    dragging = false;
    stage.classList.remove('panning');
  };
}
function closeFileViewer(skipRender = false) {
  document.getElementById('fileViewer').classList.remove('show', 'image-mode');
  document.getElementById('fvContent').innerHTML = '';
  window.onmousemove = null;
  window.onmouseup = null;
  currentViewFile = null;
  if (!skipRender) renderFileTree();
}

// File viewer resize
(function initFvResize() {
  const fv = document.getElementById('fileViewer');
  const handle = document.getElementById('fvResizeHandle');
  const MIN_FV = 280, MAX_FV = Math.min(1200, window.innerWidth * 0.8);
  let fvW = parseInt(localStorage.getItem('ba_fv_w')) || 420;
  fv.style.setProperty('--fv-w', fvW + 'px');

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startX = e.clientX;
    const startW = fvW;
    function onMove(e) {
      let newW = startW + (startX - e.clientX);
      newW = Math.max(MIN_FV, Math.min(MAX_FV, newW));
      fvW = newW;
      fv.style.setProperty('--fv-w', fvW + 'px');
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('ba_fv_w', fvW); } catch {}
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

