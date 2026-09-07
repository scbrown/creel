/* creel harness — part 25 of 26: input
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
 *   - INPUT: Attached files, @ autocomplete, drag-to-input, upload
 */
// ═══════════════════════════════════════════════════════════════════
// INPUT: Attached files, @ autocomplete, drag-to-input, upload
// ═══════════════════════════════════════════════════════════════════
let attachedFiles = [];

function attachFile(path) {
  path = normPath(path);
  if (attachedFiles.includes(path)) return;
  const node = vfsResolve(path);
  if (!node || node.type !== 'file') return;
  attachedFiles.push(path);
  renderChips();
}

function detachFile(path) {
  attachedFiles = attachedFiles.filter(f => f !== path);
  renderChips();
}

function removeInvokedSkill(id) { invokedSkills = invokedSkills.filter(s => s.id !== id); renderChips(); }
function renderChips() {
  const el = document.getElementById('inputChips');
  let html = '';
  html += invokedSkills.map(s =>
    `<div class="input-chip" style="border-color:var(--accent-yellow);color:var(--accent-yellow)" title="Skill: ${esc(s.name)}"><span class="chip-name"><span style="display:inline-flex;align-items:center;gap:6px">${iconHtml(s.icon || 'i:bolt')}<span>/${esc(s.name)}</span></span></span><button class="chip-close" onclick="removeInvokedSkill('${esc(s.id)}')">&times;</button></div>`
  ).join('');
  html += attachedFiles.map(fp => {
    const name = fp.split('/').pop();
    return `<div class="input-chip" title="${esc(fp)}"><span class="chip-name">${esc(name)}</span><button class="chip-close" onclick="detachFile('${esc(fp)}')">&times;</button></div>`;
  }).join('');
  el.innerHTML = html;
}

function _uniqueInputFilePath(file) {
  const raw = (file && file.name) ? file.name : `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const safe = raw.replace(/[\\/]+/g, '_') || 'pasted-file';
  let path = '/' + safe;
  if (!vfsResolve(path)) return path;
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    path = `/${base}-${i}${ext}`;
    if (!vfsResolve(path)) return path;
  }
  return `/${Date.now()}-${safe}`;
}
async function attachInputFile(file) {
  if (!file) return;
  const path = _uniqueInputFilePath(file);
  if (shouldTreatAsBinary(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await vfsWriteBinary(path, bytes);
  } else {
    const text = await file.text();
    vfsWrite(path, text);
  }
  attachFile(path);
}
async function attachInputFiles(files) {
  // Attachments must land in the visible conversation's vfs, not a background run's.
  ensureVisibleConversationStateActive();
  const list = Array.from(files || []).filter(Boolean);
  for (const file of list) await attachInputFile(file);
}
function handleInputUpload(ev) {
  attachInputFiles(ev.target.files).catch(e => appendErrorBubble('Attach failed: ' + e.message));
  ev.target.value = '';
}

// @ autocomplete and / skill commands
let atActive = false;
let atMode = ''; // 'file' or 'skill'
let atSelectedIdx = 0;
let atQuery = '';
let atStartPos = -1;
let invokedSkills = []; // skill objects invoked via /command

function getVfsFileList() {
  const files = [];
  (function walk(n, p) {
    for (const [nm, ch] of Object.entries(n.children || {})) {
      const fp = p + '/' + nm;
      if (ch.type === 'file') {
        const size = ch.binary ? (ch.size ?? (ch.bytes ? ch.bytes.length : 0)) : (ch.content ? ch.content.length : 0);
        files.push({ path: fp, name: nm, size, binary: !!ch.binary });
      }
      else if (ch.type === 'dir') walk(ch, fp);
    }
  })(vfs, '');
  return files;
}

function isSkillsVfsPath(path) {
  return /^\/skills(?:\/|$)/.test(normPath(path || ''));
}

function showAtDropdown(query) {
  // The @ file picker lists the visible conversation's files, not a background run's.
  ensureVisibleConversationStateActive();
  const dd = document.getElementById('atDropdown');
  const all = getVfsFileList().filter(f => !isSkillsVfsPath(f.path));
  const q = query.toLowerCase();
  const filtered = q ? all.filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) : all;
  if (!filtered.length) { dd.classList.remove('show'); atActive = false; return; }
  atMode = 'file';
  atSelectedIdx = 0;
  const items = filtered.slice(0, 20);
  dd.innerHTML = `<div class="at-dropdown-header">Files (${filtered.length}${filtered.length > 20 ? ', showing 20' : ''})</div>` +
    items.map((f, i) => {
      const sizeStr = f.size < 1024 ? f.size + 'B' : (f.size / 1024).toFixed(1) + 'K';
      const icon = f.binary ? 'i:paperclip' : getFileIcon(f.name);
      const already = attachedFiles.includes(f.path) ? ' style="opacity:0.4"' : '';
      return `<div class="at-item${i === 0 ? ' selected' : ''}" data-path="${esc(f.path)}" onclick="atSelect('${esc(f.path)}')"${already}><span class="at-icon">${iconHtml(icon)}</span><span class="at-path">${esc(f.path)}</span><span class="at-size">${sizeStr}</span></div>`;
    }).join('');
  dd.classList.add('show');
  atActive = true;
}

function showSlashDropdown(query) {
  const dd = document.getElementById('atDropdown');
  if (!skills.length) { dd.classList.remove('show'); atActive = false; return; }
  const q = query.toLowerCase();
  // Show all skills: active first, then inactive
  const sorted = [...skills].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  const filtered = q ? sorted.filter(s => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)) : sorted;
  if (!filtered.length) { dd.classList.remove('show'); atActive = false; return; }
  atMode = 'skill';
  atSelectedIdx = 0;
  dd.innerHTML = `<div class="at-dropdown-header">Skills (${filtered.length})</div>` +
    filtered.map((s, i) => {
      const sel = i === 0 ? ' selected' : '';
      const cur = invokedSkills.some(sk => sk.id === s.id) ? ' style="opacity:0.4"' : '';
      const inactive = !s.active ? ' style="opacity:0.5"' : '';
      const badge = s.active ? '' : ' <span style="font-size:8px;color:var(--text-dim)">(off)</span>';
      return `<div class="at-item${sel}" data-skill-id="${esc(s.id)}" onclick="slashSelect('${esc(s.id)}')"${cur || inactive}><span class="at-icon">${iconHtml(s.icon || 'i:bolt')}</span><span class="at-path">/${esc(s.name)}${badge}</span><span class="at-size">${esc((s.description || '').slice(0, 30))}</span></div>`;
    }).join('');
  dd.classList.add('show');
  atActive = true;
}

function slashSelect(skillId) {
  const s = skills.find(sk => sk.id === skillId);
  if (!s) return;
  if (!invokedSkills.some(sk => sk.id === s.id)) invokedSkills.push(s);
  renderChips();
  // Remove the /query text from textarea
  const inp = document.getElementById('userInput');
  const val = inp.value;
  if (atStartPos >= 0) {
    inp.value = val.slice(0, atStartPos) + val.slice(inp.selectionStart);
    inp.setSelectionRange(atStartPos, atStartPos);
  }
  hideAtDropdown();
  inp.focus();
}

function hideAtDropdown() {
  document.getElementById('atDropdown').classList.remove('show');
  atActive = false;
  atMode = '';
  atStartPos = -1;
}

function atSelect(path) {
  attachFile(path);
  // Remove the @query text from textarea
  const inp = document.getElementById('userInput');
  const val = inp.value;
  if (atStartPos >= 0) {
    inp.value = val.slice(0, atStartPos) + val.slice(inp.selectionStart);
    inp.setSelectionRange(atStartPos, atStartPos);
  }
  hideAtDropdown();
  inp.focus();
}

function atNavigate(dir) {
  const items = document.querySelectorAll('#atDropdown .at-item');
  if (!items.length) return;
  items[atSelectedIdx]?.classList.remove('selected');
  atSelectedIdx = (atSelectedIdx + dir + items.length) % items.length;
  items[atSelectedIdx]?.classList.add('selected');
  items[atSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

function handleInputChange(el) {
  autoResize(el);
  updateButtons();
  const val = el.value;
  const pos = el.selectionStart;
  const before = val.slice(0, pos);
  // Detect / at start or after whitespace for skill commands
  const slashMatch = before.match(/(?:^|\s)\/([^\s/]*)$/);
  if (slashMatch) {
    atStartPos = before.length - slashMatch[0].length + (slashMatch[0].startsWith('/') ? 0 : 1);
    atQuery = slashMatch[1];
    showSlashDropdown(atQuery);
    return;
  }
  // Detect @ for file attachment
  const atMatch = before.match(/@([^\s@]*)$/);
  if (atMatch) {
    atStartPos = before.length - atMatch[0].length;
    atQuery = atMatch[1];
    showAtDropdown(atQuery);
  } else {
    if (atActive) hideAtDropdown();
  }
}

function handleInputKey(e) {
  if (atActive) {
    if (e.key === 'ArrowDown') { e.preventDefault(); atNavigate(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); atNavigate(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const sel = document.querySelector('#atDropdown .at-item.selected');
      if (sel) {
        if (atMode === 'skill') slashSelect(sel.dataset.skillId);
        else atSelect(sel.dataset.path);
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hideAtDropdown(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
}

// Drag from file tree to input
function feStartDrag(ev, path) {
  ev.dataTransfer.setData('text/plain', path);
  ev.dataTransfer.setData('application/x-vfs-path', path);
  ev.dataTransfer.effectAllowed = 'copy';
}

(function initInputDrop() {
  const area = document.getElementById('chatInputArea');
  const wrap = area?.closest('.chat-input-wrap') || area;
  const typeList = dt => Array.from(dt?.types || []);
  const itemList = dt => Array.from(dt?.items || []);
  const hasInputPayload = e => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    const types = typeList(dt);
    return types.includes('application/x-vfs-path') || types.includes('Files') || itemList(dt).some(item => item.kind === 'file');
  };
  const droppedFiles = dt => {
    if (dt?.files?.length) return Array.from(dt.files);
    return itemList(dt).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  };
  const isInInputWrap = target => target instanceof Node && wrap && wrap.contains(target);
  const setDragState = on => area?.classList.toggle('dragover', !!on);
  const handleDrop = e => {
    if (!hasInputPayload(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragState(false);
    const vfsPath = e.dataTransfer.getData('application/x-vfs-path');
    if (vfsPath) {
      attachFile(vfsPath);
      return;
    }
    const files = droppedFiles(e.dataTransfer);
    if (files.length) attachInputFiles(files).catch(err => appendErrorBubble('Attach failed: ' + err.message));
  };
  wrap?.addEventListener('dragenter', e => {
    if (!hasInputPayload(e)) return;
    e.preventDefault();
    setDragState(true);
  });
  wrap?.addEventListener('dragover', e => {
    if (!hasInputPayload(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragState(true);
  });
  wrap?.addEventListener('dragleave', e => {
    if (!isInInputWrap(e.relatedTarget)) setDragState(false);
  });
  wrap?.addEventListener('drop', handleDrop);
  area?.addEventListener('drop', handleDrop);
  area?.addEventListener('paste', e => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    attachInputFiles(files).catch(err => appendErrorBubble('Attach failed: ' + err.message));
  });
  window.addEventListener('dragover', e => { if (hasInputPayload(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasInputPayload(e) && !isInInputWrap(e.target)) e.preventDefault(); });
})();

function getMediaPromptDisplay(mode, text) {
  return `[${(mode || '').replace('_', '→')}] ${text || ''}`.trim();
}
function addMediaModeHintToUserContent(content, mode, filePaths) {
  if (!isMediaGenerationMode(mode)) return content;
  const kind = isVideoGenerationMode(mode) ? 'video' : 'image';
  if (!hasConfiguredDefaultMediaModel(kind)) return content;
  const toolName = isVideoGenerationMode(mode) ? 'GenerateVideo' : 'GenerateImage';
  const inputHint = isImageInputGenerationMode(mode) && filePaths?.length ? ` Use attached image path(s) as input_image_paths: ${filePaths.join(', ')}` : '';
  const hint = `[Media generation mode selected: ${mode}. Use the ${toolName} tool to fulfill this request in the normal chat flow; do not answer with instructions only.${inputHint}]`;
  if (Array.isArray(content)) {
    const textBlock = content.find(b => b && b.type === 'text');
    if (textBlock) textBlock.text = hint + '\n\n' + textBlock.text;
    else content.unshift({ type: 'text', text: hint });
    return content;
  }
  return hint + (content ? '\n\n' + content : '');
}
function _mediaExtFromMime(mime, fallback) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('quicktime')) return 'mov';
  return fallback;
}
function _dataUrlToBytes(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!m) return null;
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { bytes, mime: m[1] || '' };
}
async function _fetchMediaBytes(url) {
  const resp = await fetchWithRetry(url);
  if (!resp.ok) throw new Error('Failed to fetch generated media: HTTP ' + resp.status);
  return { bytes: new Uint8Array(await resp.arrayBuffer()), mime: resp.headers.get('content-type') || '' };
}
function _extractMediaItems(data, kind) {
  const out = [];
  const visit = value => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === 'string') {
      if (/^data:/.test(value) || /^https?:\/\//i.test(value)) out.push({ url: value });
      return;
    }
    if (typeof value !== 'object') return;
    if (value.b64_json) out.push({ b64: value.b64_json, mime: value.mime_type || value.mime || '' });
    if (value.base64) out.push({ b64: value.base64, mime: value.mime_type || value.mime || '' });
    if (value.data && typeof value.data === 'string' && /^data:/.test(value.data)) out.push({ url: value.data });
    if (value.url) out.push({ url: value.url });
    if (kind === 'video') {
      if (value.video_url) out.push({ url: value.video_url });
      if (value.output_url) out.push({ url: value.output_url });
    }
    ['data','output','outputs','result','results','images','videos','content'].forEach(k => {
      if (value[k] && value[k] !== value) visit(value[k]);
    });
  };
  visit(data);
  return out;
}
async function saveGeneratedMediaItems(items, kind) {
  const run = currentRunContext;
  const paths = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let bytes, mime = item.mime || '';
    if (item.b64) {
      const raw = atob(item.b64);
      bytes = new Uint8Array(raw.length);
      for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j);
    } else if (item.url && item.url.startsWith('data:')) {
      const parsed = _dataUrlToBytes(item.url);
      if (!parsed) continue;
      bytes = parsed.bytes; mime = parsed.mime;
    } else if (item.url) {
      const fetched = await _fetchMediaBytes(item.url);
      if (run) activateConversationRun(run);
      bytes = fetched.bytes; mime = fetched.mime;
    }
    if (!bytes) continue;
    const ext = _mediaExtFromMime(mime, kind === 'video' ? 'mp4' : 'png');
    const path = `/generations/${kind}-${stamp}-${i + 1}.${ext}`;
    await vfsWriteBinary(path, bytes, true);
    if (run) activateConversationRun(run);
    paths.push(path);
  }
  renderFileTree();
  return paths;
}
async function serializeMediaInputImages(filePaths) {
  const images = [];
  for (const fp of filePaths) {
    const node = vfsResolve(fp);
    const ext = fp.split('.').pop().toLowerCase();
    if (!node?.binary || !IMAGE_EXTS.has(ext)) continue;
    const bytes = await vfsGetBinary(fp);
    const mime = getMimeTypeForPath(fp);
    if (bytes && mime) images.push({ path: fp, bytes, mime, b64: bytesToBase64(bytes), dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` });
  }
  return images;
}
function getMediaGenerationUrl(mode, provider = ACTIVE_PROVIDER) {
  const p = provider || {};
  if (isVideoGenerationMode(mode)) return buildProviderApiUrl(p.videoGenerationEndpoint || '/v1/videos', p);
  return buildProviderApiUrl(mode === 'image_image' ? (p.imageEditEndpoint || '/v1/images/edits') : (p.imageGenerationEndpoint || '/v1/images/generations'), p);
}
function buildMediaGenerationBody(mode, prompt, model, images, variant = 0) {
  const base = { model, prompt };
  if (isVideoGenerationMode(mode)) {
    if (images.length) base.image = images[0].dataUrl;
    return base;
  }
  if (mode === 'image_image' && images.length) {
    if (variant === 0) base.images = images.map(img => ({ image_url: { url: img.dataUrl } }));
    else if (variant === 1) base.images = images.map(img => ({ image_url: img.dataUrl }));
    else if (variant === 2) base.image = images.length === 1 ? images[0].dataUrl : images.map(img => img.dataUrl);
  }
  return base;
}
function getMediaGenerationBodyVariants(mode) {
  return mode === 'image_image' ? [0, 1, 2] : [0];
}
async function pollMediaGeneration(job, mode, provider = ACTIVE_PROVIDER) {
  const p = provider || {};
  const id = job.id || job.job_id || job.task_id;
  if (!id || !p.videoStatusEndpoint) return job;
  const url = buildProviderApiUrl(p.videoStatusEndpoint.replace('{id}', encodeURIComponent(id)), p);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const resp = await fetchWithRetry(url, { headers: getProviderAuthHeaders({ json: true, provider: p }) });
    if (!resp.ok) throw new Error('Video status failed: HTTP ' + resp.status);
    const data = await resp.json();
    const status = String(data.status || data.state || '').toLowerCase();
    if (['succeeded','completed','complete','done','success'].includes(status)) return data;
    if (['failed','error','cancelled','canceled'].includes(status)) throw new Error(data.error?.message || data.message || 'Video generation failed');
  }
  throw new Error('Video generation timed out');
}
async function runMediaGeneration(mode, prompt, filePaths, options = {}) {
  const run = currentRunContext;
  const kind = isVideoGenerationMode(mode) ? 'video' : 'image';
  const mediaCfg = resolveMediaModelConfig(kind, options.model || '');
  const model = mediaCfg.model;
  const mediaProvider = mediaCfg.provider || ACTIVE_PROVIDER || {};
  if (!model) throw new Error(t('media.noModel'));
  if (!prompt) throw new Error(t('media.needPrompt'));
  const images = await serializeMediaInputImages(filePaths);
  if (isImageInputGenerationMode(mode) && !images.length) throw new Error(t('media.needImage'));
  const url = getMediaGenerationUrl(mode, mediaProvider);
  let resp, errorText = '';
  for (const variant of getMediaGenerationBodyVariants(mode)) {
    const body = buildMediaGenerationBody(mode, prompt, model, images, variant);
    resp = await fetchWithRetry(url, { method: 'POST', headers: getProviderAuthHeaders({ json: true, provider: mediaProvider }), body: JSON.stringify(body), signal: (run?.abortCtrl || abortCtrl)?.signal });
    if (run) activateConversationRun(run);
    if (resp.ok) break;
    errorText = await resp.text();
    const msg = errorText.toLowerCase();
    if (!(mode === 'image_image' && resp.status === 400 && (msg.includes('image_url') || msg.includes('images') || msg.includes('image')))) break;
  }
  if (!resp.ok) throw new Error(`API Error (${resp.status}): ${errorText.slice(0, 300)}`);
  let data = await resp.json();
  if (run) activateConversationRun(run);
  if (kind === 'video' && !_extractMediaItems(data, kind).length) {
    data = await pollMediaGeneration(data, mode, mediaProvider);
    if (run) activateConversationRun(run);
  }
  const items = _extractMediaItems(data, kind);
  if (!items.length) throw new Error('No generated media returned.');
  const paths = await saveGeneratedMediaItems(items, kind);
  if (!paths.length) throw new Error('Generated media could not be saved.');
  return { mode, prompt, model, paths };
}
function normalizeMediaToolInput(input) {
  input = input && typeof input === 'object' ? input : {};
  const prompt = String(input.prompt || '').trim();
  const inputImagePaths = Array.isArray(input.input_image_paths) ? input.input_image_paths.map(p => normPath(String(p || ''))).filter(Boolean) : [];
  return { prompt, inputImagePaths, model: String(input.model || '').trim() };
}
function mediaToolResultText(result) {
  const label = isVideoGenerationMode(result.mode) ? 'Generated video' : 'Generated image';
  return [
    `${label} saved successfully.`,
    `Model: ${result.model}`,
    `Mode: ${result.mode}`,
    'Paths:',
    ...result.paths,
    '',
    `[MEDIA_RESULT ${JSON.stringify({ kind: isVideoGenerationMode(result.mode) ? 'video' : 'image', mode: result.mode, prompt: result.prompt, model: result.model, paths: result.paths })}]`
  ].join('\n');
}
async function toolGenerateImage(input) {
  const { prompt, inputImagePaths, model } = normalizeMediaToolInput(input);
  if (!prompt) return `Error: ${t('media.needPrompt')}`;
  const mode = inputImagePaths.length ? 'image_image' : 'text_image';
  const result = await runMediaGeneration(mode, prompt, inputImagePaths, { model });
  return mediaToolResultText(result);
}
async function toolGenerateVideo(input) {
  const { prompt, inputImagePaths, model } = normalizeMediaToolInput(input);
  if (!prompt) return `Error: ${t('media.needPrompt')}`;
  const mode = inputImagePaths.length ? 'image_video' : 'text_video';
  const result = await runMediaGeneration(mode, prompt, inputImagePaths, { model });
  return mediaToolResultText(result);
}
async function mediaGenerationLoop(text, filePaths, usedSkills) {
  ensureVisibleConversationStateActive();
  const convId = visibleConvId || activeConvId;
  if (!convId || isConversationRunning(convId)) return;
  const run = {
    convId,
    active: true,
    kind: 'media',
    abortCtrl: new AbortController(),
    startedAt: Date.now(),
    statusType: 'running',
    statusText: t('media.generating'),
    state: captureConversationState(chatEl.innerHTML),
    chatContainer: null,
    chatHTML: chatEl.innerHTML,
    cancelled: false,
    deleted: false
  };
  conversationRuns.set(convId, run);
  activateConversationRun(run);
  isGenerating = true; abortCtrl = run.abortCtrl; updateButtons(); renderConvList(); setStatus('running', t('media.generating'), run);
  const mode = MEDIA_MODE;
  const mediaDisplay = getMediaPromptDisplay(mode, text);
  const userEntry = appendSessionEntry('message', { role: 'user', content: mediaDisplay, usedSkillNames: (usedSkills || []).map(sk => sk.name).filter(Boolean) });
  rebuildConversation();
  snapshotConversationRunState(run);
  appendUserBubble(mediaDisplay, filePaths, usedSkills, findConversationIndexByEntryId(userEntry.id), userEntry.id, run);
  snapshotConversationRunState(run);
  const titleText = getUserTextFromContent(mediaDisplay) || text;
  if (conversation.filter(m => m.role === 'user').length === 1 && convId && titleText) {
    scheduleConversationTitleGeneration(convId, titleText);
  }
  let mediaOutcome = 'done';
  try {
    const result = await runMediaGeneration(mode, text, filePaths);
    activateConversationRun(run);
    await appendMediaGenerationBubble(result, run);
  } catch (e) {
    activateConversationRun(run);
    mediaOutcome = e.name === 'AbortError' ? 'abort' : 'error';
    appendErrorBubble(`Error: ${e.message}`, { userText: text, promptEntryId: userEntry.id }, run);
  }
  activateConversationRun(run);
  isGenerating = false; abortCtrl = null;
  run.active = false;
  run.finishedAt = Date.now();
  snapshotConversationRunState(run);
  if (!run.deleted) await saveConversationState(convId, run.state, { andRenderList: true });
  if (!run.deleted && mediaOutcome !== 'abort') notifyTaskFinished({ convId, kind: 'media', outcome: mediaOutcome });
  conversationRuns.delete(convId);
  if (visibleConvId === convId) {
    applyConversationState(run.state);
    activeConvId = convId;
    visibleConversationState = run.state;
  } else {
    ensureVisibleConversationStateActive();
  }
  currentRunContext = null;
  syncLegacyRunFlags(); updateButtons();
  const visibleRun = getActiveConversationRun();
  setStatus(visibleRun?.active ? 'running' : 'ready', visibleRun?.active ? (visibleRun.statusText || t('status.streaming')) : t('status.ready'));
  updateMemoryUI();
}

async function buildUserMessageContent(text, filePaths, usedSkills) {
  const content = [];
  const textParts = [];
  if (filePaths.length) {
    const fileTextParts = [];
    for (const fp of filePaths) {
      const node = vfsResolve(fp);
      if (!node || node.type !== 'file') continue;
      const ext = fp.split('.').pop().toLowerCase();
      if (node.binary && IMAGE_EXTS.has(ext)) {
        const mediaType = getMimeTypeForPath(fp);
        const bytes = mediaType ? await vfsGetBinary(fp) : null;
        const data = bytes ? bytesToBase64(bytes) : '';
        if (data) {
          content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
          console.info('Attached image included in vision request:', fp, mediaType);
          fileTextParts.push(`--- ${fp} ---\n[Attached image for visual analysis]`);
          continue;
        }
      }
      if (node.binary) {
        const size = node.size ?? (node.bytes ? node.bytes.length : 0);
        fileTextParts.push(`--- ${fp} ---\n[Binary file, ${size} bytes]`);
      } else fileTextParts.push(`--- ${fp} ---\n${node.content || ''}`);
    }
    if (fileTextParts.length) textParts.push('<attached_files>\n' + fileTextParts.join('\n\n') + '\n</attached_files>');
  }
  for (const sk of usedSkills) {
    if (!sk.active && sk.body) {
      textParts.push(`<skill_instruction>\nYou MUST use the following skill to complete this task.\n\n## Skill: ${sk.name}\n${sk.body}\n</skill_instruction>`);
    } else {
      textParts.push(`[IMPORTANT: The "${sk.name}" skill has been invoked for this request. Use its loaded instructions and any files/tools under /skills/${sk.name}/.]`);
    }
  }
  if (text) textParts.push(text);
  const finalText = textParts.filter(Boolean).join('\n\n');
  if (!content.length) return finalText;
  if (finalText) content.unshift({ type: 'text', text: finalText });
  return content;
}

// Send with attached files and /skill
async function handleSend() {
  ensureVisibleConversationStateActive();
  const inp = document.getElementById('userInput');
  const text = inp.value.trim();
  const convId = visibleConvId || activeConvId;
  if (!text && !attachedFiles.length) return;
  if (isConversationRunning(convId)) {
    const run = conversationRuns.get(convId);
    if (!run) return;
    run.pendingGuidance = run.pendingGuidance || [];
    const guidedFiles = [...attachedFiles];
    run.pendingGuidance.push({ text, fileList: guidedFiles });
    inp.value = '';
    attachedFiles = [];
    autoResize(inp);
    hideAtDropdown();
    renderChips();
    updateButtons();
    return;
  }
  inp.value = '';
  autoResize(inp);
  hideAtDropdown();

  const usedSkills = [...invokedSkills];
  const sentFiles = [...attachedFiles];
  attachedFiles = [];
  invokedSkills = [];
  renderChips();
  const msgContent = await buildUserMessageContent(text, sentFiles, usedSkills);
  const ralphSettings = getRalphSettings();
  const ralph = ralphModeEnabled ? { enabled: true, unlimited: ralphSettings.unlimited, maxIterations: ralphSettings.maxIterations, completionMarker: ralphSettings.completionMarker } : null;
  agentLoop(msgContent, text, sentFiles, usedSkills, { ralph });
}

function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }
function updateButtons() {
  syncLegacyRunFlags();
  const btn = document.getElementById('sendBtn');
  const inp = document.getElementById('userInput');
  const run = getActiveConversationRun();
  const running = !!run?.active;
  const hasText = !!(inp && (inp.value.trim().length > 0 || attachedFiles.length > 0));
  if (inp) {
    inp.disabled = false;
    inp.placeholder = running ? (t('input.placeholderRunning') || 'Type to guide the agent') : (t('input.placeholder') || 'Type message...');
  }
  // The glyph is the only visible content, so aria-label carries the button's
  // meaning \u2014 and it has to track the state, or an agent locating
  // {role:'button', name:'Stop'} will click Send instead.
  if (running && hasText) {
    btn.innerHTML = '\u21AA';
    btn.classList.remove('stop'); btn.classList.add('guide');
    btn.title = 'Send to guide the agent (won\u2019t interrupt)';
    btn.setAttribute('aria-label', 'Guide the running agent');
    btn.onclick = handleSend;
  } else if (running) {
    btn.innerHTML = '\u25A0';
    btn.classList.add('stop'); btn.classList.remove('guide');
    btn.title = 'Stop';
    btn.setAttribute('aria-label', 'Stop the running agent');
    btn.onclick = () => { if (run.state?.ralphRun?.active) run.state.ralphRun.cancelled = true; stopConversationRun(run.convId); };
  } else {
    btn.innerHTML = '\u25B6';
    btn.classList.remove('stop'); btn.classList.remove('guide');
    btn.title = 'Send';
    btn.setAttribute('aria-label', 'Send message');
    btn.onclick = handleSend;
  }
}
function setStatus(type, text, run) {
  // Route by the owning run when provided; a background run must update its own
  // status (and the conv list), never the visible status bar.
  const ctx = run || currentRunContext;
  if (ctx && !isRunVisible(ctx)) {
    ctx.statusType = type;
    ctx.statusText = text;
    renderConvList();
    return;
  }
  document.getElementById('statusText').textContent = text;
  const d = document.getElementById('statusDot');
  d.classList.toggle('running', type === 'running');
}

async function runFsDiagnostics() {
  const diagPath = '/__fs_diag__.txt';
  const binaryPath = '/__fs_diag__.bin';
  const text = 'fs-diag-ok\nline-2';
  const bytes = new Uint8Array([0, 1, 2, 3, 255, 42]);
  const lines = [];
  const prevStatus = document.getElementById('statusText').textContent;
  setStatus('running', 'Running FS diagnostics');
  try {
    vfsWrite(diagPath, text);
    await vfsWriteBinary(binaryPath, bytes);

    const bashLs = await execBash(`ls -l / | grep __fs_diag__`);
    const bashCat = await execBash(`cat ${diagPath}`);
    const bashCatBin = await execBash(`cat ${binaryPath}`);
    const jsText = vfsRead(diagPath).content;
    const jsBin = Array.from((await vfsGetBinary(binaryPath)) || []);
    const jsStatText = vfsStat(diagPath);
    const jsStatBin = vfsStat(binaryPath);
    const grepText = vfsGrep('fs-diag-ok', '/', '*');
    const grepBinary = vfsGrep('__fs_diag__', '/', '*.bin');

    let pythonResult = '(skipped)';
    try {
      pythonResult = await toolPythonExec({
        code: `import os, glob, pathlib, workspacefs\nprint(open("/__fs_diag__.txt").read().strip())\nprint(os.path.exists("/__fs_diag__.txt"))\nprint(pathlib.Path("/__fs_diag__.txt").exists())\nprint(sorted(glob.glob("/__fs_diag__.*")))\nprint(list(workspacefs.read_bytes("/__fs_diag__.bin")))\ntmp_in = workspacefs.materialize_to_tmp("/__fs_diag__.bin", binary=True)\nprint(tmp_in.startswith("/tmp/"))\nwith open(tmp_in, "rb") as f:\n    data = f.read()\nprint(list(data))\ntmp_out = "/tmp/__fs_diag_roundtrip.bin"\nwith open(tmp_out, "wb") as f:\n    f.write(data + bytes([7, 8]))\nworkspacefs.persist_tmp_file(tmp_out, "/__fs_diag_roundtrip.bin", binary=True)\nprint(list(workspacefs.read_bytes("/__fs_diag_roundtrip.bin")))`
      });
    } catch (e) {
      pythonResult = 'PythonExec failed: ' + e.message;
    }

    lines.push('FS diagnostics');
    lines.push('');
    lines.push('[VFS]');
    lines.push(`text read: ${JSON.stringify(jsText)}`);
    lines.push(`binary bytes: ${JSON.stringify(jsBin)}`);
    lines.push(`text stat: ${JSON.stringify(jsStatText)}`);
    lines.push(`binary stat: ${JSON.stringify(jsStatBin)}`);
    lines.push('');
    lines.push('[Bash]');
    lines.push(`ls -l: ${bashLs}`);
    lines.push(`cat text: ${bashCat}`);
    lines.push(`cat binary: ${bashCatBin}`);
    lines.push('');
    lines.push('[Grep]');
    lines.push(`text matches: ${JSON.stringify(grepText)}`);
    lines.push(`binary matches (should be []): ${JSON.stringify(grepBinary)}`);
    lines.push('');
    lines.push('[PythonExec]');
    lines.push(pythonResult);
    const roundtripStat = vfsStat('/__fs_diag_roundtrip.bin');
    if (roundtripStat) {
      lines.push('');
      lines.push('[Materialize /tmp]');
      lines.push(`roundtrip stat: ${JSON.stringify(roundtripStat)}`);
      lines.push(`roundtrip bytes: ${JSON.stringify(Array.from((await vfsGetBinary('/__fs_diag_roundtrip.bin')) || []))}`);
    }

    appendSystemMsg(lines.join('\n'));
    setStatus('idle', 'FS diagnostics complete');
  } catch (e) {
    appendErrorBubble('FS diagnostics failed: ' + e.message);
    setStatus('idle', 'FS diagnostics failed');
  }
}
// clearConversation defined above

