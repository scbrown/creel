/* creel harness — part 21 of 26: html-preview
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
 *   - HTML PREVIEW MODAL
 */
// ═══════════════════════════════════════════════════════════════════
// HTML PREVIEW MODAL
// ═══════════════════════════════════════════════════════════════════
let previewModalFilePath = null;
let previewModalContent = null;
let previewModalType = 'html'; // 'html' or 'md'

function openPreviewModal(filePath, content, type) {
  if (!content && filePath) {
    const node = vfsResolve(normPath(filePath));
    if (node && node.type === 'file' && node.content) content = node.content;
  }
  if (!content) return;
  if (!type) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    type = (ext === 'md' || ext === 'markdown') ? 'md' : 'html';
  }
  previewModalFilePath = filePath;
  previewModalContent = content;
  previewModalType = type;
  document.getElementById('htmlModalPath').textContent = filePath || (type === 'md' ? 'preview.md' : 'preview.html');

  const iframe = document.getElementById('htmlModalPreview');
  const mdDiv = document.getElementById('mdModalPreview');
  const srcEl = document.getElementById('htmlModalSource');

  if (type === 'md') {
    iframe.style.display = 'none';
    iframe.srcdoc = '';
    mdDiv.style.display = '';
    mdDiv.innerHTML = marked.parse(content, { breaks: true });
    mdDiv.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    // Source view
    let h; try { h = hljs.highlight(content, { language: 'markdown' }).value; } catch { h = esc(content); }
    srcEl.innerHTML = `<div class="fv-code">${h.split('\n').map((l,i) => `<div class="line"><span class="line-num">${i+1}</span><span class="line-content">${l || ' '}</span></div>`).join('')}</div>`;
  } else {
    mdDiv.style.display = 'none';
    iframe.style.display = '';
    iframe.srcdoc = content;
    let h; try { h = hljs.highlight(content, { language: 'html' }).value; } catch { h = esc(content); }
    srcEl.innerHTML = `<div class="fv-code">${h.split('\n').map((l,i) => `<div class="line"><span class="line-num">${i+1}</span><span class="line-content">${l || ' '}</span></div>`).join('')}</div>`;
  }
  srcEl.style.display = 'none';
  document.querySelectorAll('#htmlModal .html-modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('#htmlModal .html-modal-tab').classList.add('active');
  document.getElementById('htmlModal').classList.add('show');
}

// Keep backward compat alias
function openHtmlModal(filePath, content) { openPreviewModal(filePath, content, 'html'); }

function closeHtmlModal() {
  document.getElementById('htmlModal').classList.remove('show');
  document.getElementById('htmlModalPreview').srcdoc = '';
  document.getElementById('mdModalPreview').style.display = 'none';
  previewModalFilePath = null;
  previewModalContent = null;
}

function switchHtmlModalTab(mode, btn) {
  document.querySelectorAll('#htmlModal .html-modal-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const iframe = document.getElementById('htmlModalPreview');
  const mdDiv = document.getElementById('mdModalPreview');
  const source = document.getElementById('htmlModalSource');
  if (mode === 'preview') {
    if (previewModalType === 'md') { mdDiv.style.display = ''; iframe.style.display = 'none'; }
    else { iframe.style.display = ''; mdDiv.style.display = 'none'; }
    source.style.display = 'none';
  } else {
    iframe.style.display = 'none';
    mdDiv.style.display = 'none';
    source.style.display = '';
  }
}

function downloadHtmlModal() {
  if (!previewModalContent) return;
  const name = previewModalFilePath ? previewModalFilePath.split('/').pop() : (previewModalType === 'md' ? 'preview.md' : 'preview.html');
  const mime = previewModalType === 'md' ? 'text/markdown' : 'text/html';
  const blob = new Blob([previewModalContent], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('htmlModal').classList.contains('show')) {
    closeHtmlModal();
  }
});

async function downloadCurrentFile() {
  if (!currentViewFile) return;
  const node = vfsResolve(currentViewFile);
  if (!node || node.type !== 'file') return;
  const name = currentViewFile.split('/').pop();
  if (node.binary) {
    const ext = name.split('.').pop().toLowerCase();
    const bytes = await vfsGetBinary(currentViewFile);
    if (!bytes) return;
    const blob = new Blob([bytes], { type: getMimeType(ext) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  } else {
    downloadBlob(node.content || '', name);
  }
}

function toggleExportMenu() {
  const menu = document.getElementById('exportMenu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}
function closeExportMenu() {
  const menu = document.getElementById('exportMenu');
  if (menu) menu.style.display = 'none';
}
document.addEventListener('click', e => {
  const menu = document.getElementById('exportMenu');
  const btn = document.getElementById('exportBtn');
  if (!menu || !btn || menu.style.display !== 'block') return;
  if (menu.contains(e.target) || btn.contains(e.target)) return;
  closeExportMenu();
});
function getExportDisplayTitle() {
  return convHistory.find(c => c.id === activeConvId)?.title || 'Conversation';
}
function getExportSafeTitle() {
  return (getExportDisplayTitle() || 'conversation').replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '') || 'conversation';
}
function escapeMarkdownAlt(text) {
  return String(text || '').replace(/[\[\]\\]/g, '\\$&').replace(/\n/g, ' ');
}
async function vfsImagePathToDataUrl(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return '';
  const node = vfsResolve(path);
  if (!node?.binary) return '';
  const bytes = await vfsGetBinary(path);
  if (!bytes) return '';
  return `data:${getMimeType(ext)};base64,${bytesToBase64(bytes)}`;
}
function formatUserImageBlockForMarkdown(block, alt = t('export.attachedImage')) {
  const src = block?.source;
  if (!src?.data || !src?.media_type) return '';
  return `![${escapeMarkdownAlt(alt)}](data:${src.media_type};base64,${src.data})`;
}
async function formatMediaResultImagesForMarkdown(mediaResult) {
  const out = [];
  for (const path of mediaResult?.paths || []) {
    const dataUrl = await vfsImagePathToDataUrl(path);
    if (!dataUrl) continue;
    const alt = `${t('export.generatedImage')} ${path.split('/').pop()}`;
    out.push(`![${escapeMarkdownAlt(alt)}](${dataUrl})`);
  }
  return out.join('\n\n');
}
function extractGenerationImagePaths(text) {
  const seen = new Set();
  const paths = [];
  for (const m of String(text || '').matchAll(/\/generations\/[^\s)\]"']+/g)) {
    const path = m[0].replace(/[.,;:]+$/g, '');
    const ext = path.split('.').pop().toLowerCase();
    if (IMAGE_EXTS.has(ext) && !seen.has(path)) { seen.add(path); paths.push(path); }
  }
  return paths;
}
async function appendGenerationPathImagesMarkdown(lines, text) {
  const paths = extractGenerationImagePaths(text);
  for (const path of paths) {
    const dataUrl = await vfsImagePathToDataUrl(path);
    if (dataUrl) lines.push(`![${escapeMarkdownAlt(`${t('export.generatedImage')} ${path.split('/').pop()}`)}](${dataUrl})`);
  }
}
async function appendToolResultMarkdown(lines, block, embedImages) {
  lines.push('## Tool Result');
  const id = `Tool Use ID: ${block.tool_use_id || ''}`.trim();
  if (id) lines.push(id);
  const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
  const mediaResult = parseMediaToolResult(raw);
  const text = mediaResult ? stripMediaToolMarker(raw) : raw;
  if (text) lines.push(text);
  if (embedImages && mediaResult) {
    const imageMd = await formatMediaResultImagesForMarkdown(mediaResult);
    if (imageMd) lines.push(imageMd);
  }
  lines.push('');
}
async function formatConversationForExport(options = {}) {
  const { embedImages = false } = options;
  const lines = [];
  lines.push(`# ${getExportDisplayTitle()}`);
  lines.push('');
  for (const msg of conversation) {
    if (msg.role === 'user') {
      lines.push('## User');
      if (typeof msg.content === 'string') {
        lines.push(msg.content);
        if (embedImages) await appendGenerationPathImagesMarkdown(lines, msg.content);
        lines.push('');
        continue;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') await appendToolResultMarkdown(lines, block, embedImages);
          else if (block.type === 'text') lines.push(block.text || '');
          else if (block.type === 'image') {
            if (embedImages) {
              const md = formatUserImageBlockForMarkdown(block);
              lines.push(md || t('export.imageUnavailable'));
            } else {
              lines.push(t('export.attachedImage'));
            }
          }
        }
        lines.push('');
      }
      continue;
    }
    if (msg.role === 'assistant') {
      lines.push('## Assistant');
      if (typeof msg.content === 'string') {
        const text = stripMediaToolMarker(msg.content);
        lines.push(text);
        if (embedImages) await appendGenerationPathImagesMarkdown(lines, text);
        lines.push('');
        continue;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            const text = stripMediaToolMarker(block.text || '');
            lines.push(text);
            if (embedImages) await appendGenerationPathImagesMarkdown(lines, text);
          }
          else if (block.type === 'reasoning') {
            lines.push('[Thinking]');
            lines.push(block.reasoning_content || block.text || '');
          }
          else if (block.type === 'tool_use') {
            lines.push('');
            lines.push(`### Tool Call: ${block.name}`);
            lines.push(JSON.stringify(block.input || {}, null, 2));
          }
          else if (block.type === 'tool_result') await appendToolResultMarkdown(lines, block, embedImages);
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n').trim() + '\n';
}
function markdownToExportHtml(text) {
  try {
    if (typeof marked !== 'undefined' && marked.parse) return marked.parse(String(text || ''), { breaks: true, gfm: true });
  } catch {}
  return `<pre>${esc(String(text || ''))}</pre>`;
}
function formatUserImageBlockForHtml(block, alt = t('export.attachedImage')) {
  const src = block?.source;
  if (!src?.data || !src?.media_type) return `<p>${esc(t('export.imageUnavailable'))}</p>`;
  return `<figure><img src="data:${esc(src.media_type)};base64,${src.data}" alt="${esc(alt)}"><figcaption>${esc(alt)}</figcaption></figure>`;
}
async function formatMediaResultImagesForHtml(mediaResult) {
  const parts = [];
  for (const path of mediaResult?.paths || []) {
    const dataUrl = await vfsImagePathToDataUrl(path);
    if (!dataUrl) continue;
    parts.push(`<figure><img src="${dataUrl}" alt="${esc(path.split('/').pop())}"><figcaption>${esc(path)}</figcaption></figure>`);
  }
  return parts.join('\n');
}
async function formatGenerationPathImagesForHtml(text) {
  const parts = [];
  for (const path of extractGenerationImagePaths(text)) {
    const dataUrl = await vfsImagePathToDataUrl(path);
    if (dataUrl) parts.push(`<figure><img src="${dataUrl}" alt="${esc(path.split('/').pop())}"><figcaption>${esc(path)}</figcaption></figure>`);
  }
  return parts.join('\n');
}
async function formatToolResultBlockForPdfHtml(block) {
  const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
  const mediaResult = parseMediaToolResult(raw);
  const text = mediaResult ? stripMediaToolMarker(raw) : raw;
  const parts = ['<h3>Tool Result</h3>'];
  if (block.tool_use_id) parts.push(`<div class="tool-id">Tool Use ID: ${esc(block.tool_use_id)}</div>`);
  if (text) parts.push(markdownToExportHtml(text));
  if (mediaResult) parts.push(await formatMediaResultImagesForHtml(mediaResult));
  return parts.join('\n');
}
async function formatMessageForPdfHtml(label, content) {
  const body = [];
  if (typeof content === 'string') {
    const text = stripMediaToolMarker(content);
    body.push(markdownToExportHtml(text));
    body.push(await formatGenerationPathImagesForHtml(text));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        const text = stripMediaToolMarker(block.text || '');
        body.push(markdownToExportHtml(text));
        body.push(await formatGenerationPathImagesForHtml(text));
      } else if (block.type === 'image') body.push(formatUserImageBlockForHtml(block));
      else if (block.type === 'reasoning') body.push(`<div class="thinking-block"><strong>${esc(t('thinking'))}</strong>${markdownToExportHtml(block.reasoning_content || block.text || '')}</div>`);
      else if (block.type === 'tool_use') body.push(`<h3>Tool Call: ${esc(block.name || '')}</h3><pre>${esc(JSON.stringify(block.input || {}, null, 2))}</pre>`);
      else if (block.type === 'tool_result') body.push(await formatToolResultBlockForPdfHtml(block));
    }
  }
  return `<section class="message ${label.toLowerCase()}"><h2>${esc(label)}</h2>${body.join('\n')}</section>`;
}
async function formatConversationForPdfHtml() {
  const parts = [`<h1>${esc(getExportDisplayTitle())}</h1>`];
  for (const msg of conversation) {
    if (msg.role === 'user') parts.push(await formatMessageForPdfHtml('User', msg.content));
    else if (msg.role === 'assistant') parts.push(await formatMessageForPdfHtml('Assistant', msg.content));
  }
  return buildPrintableHtmlDocument(getExportDisplayTitle(), parts.join('\n'));
}
function buildPrintableHtmlDocument(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;background:#fff;line-height:1.5;max-width:840px;margin:32px auto;padding:0 24px}h1{font-size:28px;border-bottom:1px solid #ddd;padding-bottom:12px}h2{font-size:18px;margin-top:0}h3{font-size:14px;margin-top:18px;color:#444}.message{page-break-inside:avoid;border:1px solid #ddd;border-radius:10px;padding:16px;margin:18px 0}.message.user{background:#f7faff}.message.assistant{background:#fafafa}pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f5;border:1px solid #e0e0e0;border-radius:6px;padding:10px;overflow-wrap:anywhere}code{overflow-wrap:anywhere}img{display:block;max-width:100%;max-height:720px;object-fit:contain;margin:12px auto;page-break-inside:avoid}figure{margin:16px 0;page-break-inside:avoid}figcaption{color:#666;font-size:12px;text-align:center;word-break:break-all}.tool-id{color:#666;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.thinking-block{border-left:3px solid #aaa;padding-left:12px;color:#555}@media print{body{margin:0;max-width:none}.message{page-break-inside:avoid}}
</style></head><body>${bodyHtml}<script>function waitForImages(){const imgs=Array.from(document.images||[]);return Promise.all(imgs.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;})));}window.addEventListener('load',()=>{waitForImages().then(()=>setTimeout(()=>window.print(),300));});<\/script></body></html>`;
}
async function exportConversationPdf(title) {
  const win = window.open('', '_blank');
  if (!win) { alert(t('export.pdfPrintHint')); return; }
  win.document.open();
  win.document.write(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:24px">${esc(t('export.pdfPreparing'))}</body>`);
  win.document.close();
  setStatus('running', t('export.pdfPreparing'));
  try {
    const html = await formatConversationForPdfHtml();
    win.document.open();
    win.document.write(html);
    win.document.close();
  } finally {
    setStatus('ready', t('status.ready'));
  }
}
async function downloadAll(format = 'markdown') {
  closeExportMenu();
  // Export the visible conversation, not whatever a background run left active.
  ensureVisibleConversationStateActive();
  if (!conversation.length) { alert(t('export.noConversation')); return; }
  const title = getExportSafeTitle();
  if (format === 'pdf') { await exportConversationPdf(title); return; }
  downloadBlob(await formatConversationForExport({ embedImages: false }), `${title}.md`, 'text/markdown;charset=utf-8');
}

function downloadBlob(c, fn, type = 'text/plain;charset=utf-8') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([c], { type })); a.download = fn; a.click(); URL.revokeObjectURL(a.href); }

// Upload
const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', async e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  try {
    // Only use the webkitEntry path when a directory was dropped (it's the
    // only way to traverse folder contents). For plain file drops, go straight
    // through dataTransfer.files — entry.file() chokes with EncodingError on
    // non-ASCII filenames in current Chrome.
    const entries = [];
    let hasDir = false;
    if (e.dataTransfer.items?.length) {
      for (const it of e.dataTransfer.items) {
        const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (!en) continue;
        entries.push(en);
        if (en.isDirectory) hasDir = true;
      }
    }
    if (hasDir && entries.length) {
      try {
        await importEntries(entries);
        return;
      } catch (entryErr) {
        console.warn('[drop] entries path failed, falling back to dataTransfer.files:', entryErr);
      }
    }
    if (e.dataTransfer.files?.length) await handleFiles(e.dataTransfer.files);
  } catch (err) {
    console.error('Upload failed:', err, err?.stack);
    if (typeof appendSystemMsg === 'function') appendSystemMsg(`Upload failed: ${err?.name || 'Error'}: ${err?.message || err}`);
  }
});
function isBinaryFile(name) { const ext = name.split('.').pop().toLowerCase(); return BINARY_EXTS.has(ext); }
// A file should go down the binary path whenever its extension says so OR it's
// simply too big to reasonably hold as a JS string.
function shouldTreatAsBinary(file) {
  return isBinaryFile(file.name) || (file.size && file.size > MAX_TEXT_UPLOAD_BYTES);
}
function readFileToVfs(path, file) {
  return new Promise(resolve => {
    const done = result => { resolve(result); };
    if (shouldTreatAsBinary(file)) {
      const rd = new FileReader();
      rd.onload = async () => {
        try { done(await vfsWriteBinary(path, new Uint8Array(rd.result), true)); }
        catch (e) { done({ error: `Failed to write ${path}: ${e.message}` }); }
      };
      rd.onerror = () => done({ error: `Failed to read ${path}` });
      rd.readAsArrayBuffer(file);
    } else {
      const rd = new FileReader();
      rd.onload = () => done(vfsWrite(path, rd.result, true));
      rd.onerror = () => done({ error: `Failed to read ${path}` });
      rd.readAsText(file);
    }
  });
}
async function readEntryRecursive(entry, basePath = '') {
  if (!entry) return [];
  if (entry.isFile) {
    let file;
    try { file = await new Promise((resolve, reject) => entry.file(resolve, reject)); }
    catch (e) {
      // Chrome's entry.file() rejects with EncodingError for some filenames
      // (non-ASCII in particular). Skip the entry so sibling files can still
      // import; the caller may fall back to dataTransfer.files for top-level
      // drops.
      console.warn('[readEntryRecursive] skipping', entry.fullPath || entry.name, '-', e?.name || 'error', ':', e?.message || e);
      return [];
    }
    return [{ path: '/' + (basePath ? basePath + '/' : '') + entry.name, file }];
  }
  if (!entry.isDirectory) return [];
  const dirPath = basePath ? basePath + '/' + entry.name : entry.name;
  const dirEntry = { path: '/' + dirPath, dir: true };
  const reader = entry.createReader();
  const children = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  const nested = await Promise.all(children.map(child => readEntryRecursive(child, dirPath)));
  return [dirEntry, ...nested.flat()];
}
async function importEntries(entries) {
  const flattened = (await Promise.all(entries.map(entry => readEntryRecursive(entry)))).flat();
  for (const item of flattened) {
    if (item.dir) vfsMkdir(item.path);
  }
  for (const item of flattened) {
    if (!item.file) continue;
    try {
      const r = await readFileToVfs(item.path, item.file);
      if (r?.error) console.warn('[importEntries] readFileToVfs error for', item.path, '-', r.error);
    } catch (e) {
      console.error('[importEntries] throw for', item.path, 'size=', item.file?.size, 'type=', item.file?.type, 'err=', e);
      throw e;
    }
  }
  renderFileTree();
}
async function handleUpload(ev) {
  await handleFiles(ev.target.files);
  ev.target.value = '';
}
async function handleFolderUpload(ev) {
  await handleFiles(ev.target.files);
  ev.target.value = '';
}
async function handleFiles(files) {
  const list = Array.from(files || []);
  for (const f of list) {
    const relPath = (f.webkitRelativePath || f.name || '').replace(/^\/+/, '');
    if (!relPath) continue;
    const path = '/' + relPath;
    const parts = relPath.split('/');
    if (parts.length > 1) vfsMkdir('/' + parts.slice(0, -1).join('/'));
    await readFileToVfs(path, f);
  }
  renderFileTree();
}

renderFileTree();

