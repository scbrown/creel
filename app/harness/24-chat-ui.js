/* creel harness — part 24 of 26: chat-ui
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
 *   - CHAT UI
 */
// ═══════════════════════════════════════════════════════════════════
// CHAT UI
// ═══════════════════════════════════════════════════════════════════
const chatEl = document.getElementById('chatMessages');
let _autoScrollChat = true;
chatEl.addEventListener('scroll', () => { _autoScrollChat = isNearBottom(chatEl, 48); });
function scrollBottom(force = false, run) {
  const target = getContextChatEl(run);
  if (target === chatEl && (force || _autoScrollChat)) chatEl.scrollTop = chatEl.scrollHeight;
}
function clearChatPlaceholder(run) {
  const ph = getContextChatEl(run)?.querySelector('.msg-placeholder');
  if (ph) ph.remove();
}
function appendUserBubble(t, fileList, usedSkills, promptIndex = null, promptEntryId = '', run) {
  clearChatPlaceholder(run);
  const d = document.createElement('div'); d.className = 'msg msg-user';
  if (Number.isInteger(promptIndex)) d.dataset.promptIndex = String(promptIndex);
  if (promptEntryId) d.dataset.promptEntryId = promptEntryId;
  d.dataset.userText = t || '';
  if (Number.isFinite(totalTokens)) d.dataset.tokenBase = String(totalTokens);
  if (Number.isFinite(loopCount)) d.dataset.loopBase = String(loopCount);
  let chips = '';
  const tags = [];
  if (usedSkills && usedSkills.length) {
    for (const sk of usedSkills) {
      tags.push(`<span style="font-size:10px;padding:2px 6px;background:rgba(255,215,0,0.1);border:1px solid var(--accent-yellow);border-radius:3px;color:var(--accent-yellow);font-family:JetBrains Mono,monospace">${iconHtml(sk.icon || 'i:bolt')} /${esc(sk.name)}</span>`);
    }
  }
  if (fileList && fileList.length) {
    for (const fp of fileList) {
      const name = fp.split('/').pop();
      tags.push(`<span style="font-size:10px;padding:2px 6px;background:var(--bg-root);border:1px solid var(--border);border-radius:3px;color:var(--accent-blue);font-family:JetBrains Mono,monospace;cursor:pointer" onclick="openFileViewer('${esc(fp)}')" title="${esc(fp)}">${iconHtml('i:paperclip')} ${esc(name)}</span>`);
    }
  }
  if (tags.length) chips = '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px">' + tags.join('') + '</div>';
  const actions =
    `<div class="msg-actions">` +
      `<button class="msg-action-btn" data-role="copy"  onclick="msgAction(this,'copy')"  title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` +
      `<button class="msg-action-btn" data-role="regen" onclick="msgAction(this,'regen')" title="Regenerate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>` +
    `</div>`;
  d.innerHTML = `<div class="msg-user-main"><div class="msg-body">${chips}${esc(t)}</div>${actions}</div>`;
  getContextChatEl(run).appendChild(d); scrollBottom(false, run);
}
function appendAssistantBubble(run) {
  clearChatPlaceholder(run);
  const d = document.createElement('div'); d.className = 'msg msg-assistant';
  const reasoningEl = document.createElement('div'); reasoningEl.className = 'reasoning-card'; reasoningEl.dataset.role = 'assistant-reasoning'; reasoningEl.style.display = 'none';
  reasoningEl.innerHTML = `<div class="reasoning-header" onclick="toggleReasoningCard(this.parentElement)"><span class="reasoning-title">Thinking</span><span class="reasoning-summary"></span><span class="tool-arrow open">\u25BC</span></div><div class="reasoning-body show"></div>`;
  reasoningEl.classList.add('show');
  const main = document.createElement('div'); main.className = 'msg-assistant-main';
  const b = document.createElement('div'); b.className = 'msg-body'; b.dataset.role = 'assistant-text'; b.innerHTML = '<span class="streaming-cursor"></span>';
  const acts = document.createElement('div'); acts.className = 'msg-actions';
  acts.innerHTML =
    `<button class="msg-action-btn" data-role="copy"    onclick="msgAction(this,'copy')"   title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` +
    `<button class="msg-action-btn" data-role="fmt"     onclick="msgAction(this,'fmt')"    title="Toggle raw / rendered" style="display:none"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></button>` +
    `<button class="msg-action-btn" data-role="regen"   onclick="msgAction(this,'regen')"  title="Regenerate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>` +
    `<button class="msg-action-btn" data-role="like"    onclick="msgAction(this,'like')"   title="Good response"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg></button>` +
    `<button class="msg-action-btn" data-role="dislike" onclick="msgAction(this,'dislike')" title="Poor response"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg></button>`;
  main.appendChild(b); main.appendChild(acts);
  d.appendChild(reasoningEl); d.appendChild(main);
  getContextChatEl(run).appendChild(d); scrollBottom(false, run);
  return { msgEl: d, textEl: b, reasoningEl };
}
function setToolCardCollapsed(card, collapsed) {
  if (!card) return;
  const body = card.querySelector('.tool-body');
  const arrow = card.querySelector('.tool-arrow');
  const toggleBtn = card.querySelector('.tool-toggle-btn');
  if (body) body.classList.toggle('show', !collapsed);
  if (arrow) arrow.classList.toggle('open', !collapsed);
  if (toggleBtn) toggleBtn.textContent = collapsed ? 'Expand' : 'Collapse';
}
function toggleReasoningCard(card) {
  if (!card) return;
  card.classList.toggle('show');
  const arrow = card.querySelector('.tool-arrow');
  if (arrow) arrow.classList.toggle('open', card.classList.contains('show'));
}
function appendReasoningChunk(reasoningEl, chunk) {
  if (!reasoningEl || !chunk) return;
  const body = reasoningEl.querySelector('.reasoning-body');
  const summary = reasoningEl.querySelector('.reasoning-summary');
  if (!body || !summary) return;
  reasoningEl.style.display = '';
  const shouldStick = isNearBottom(body, 16);
  const next = (body.dataset.raw || '') + chunk;
  body.dataset.raw = next;
  body.textContent = next;
  const compact = next.replace(/\s+/g, ' ').trim();
  summary.textContent = compact ? compact.slice(0, 120) : 'thinking…';
  if (shouldStick) body.scrollTop = body.scrollHeight;
}
function finalizeReasoning(reasoningEl) {
  if (!reasoningEl) return;
  const body = reasoningEl.querySelector('.reasoning-body');
  if (!body) return;
  const raw = body.dataset.raw || body.textContent || '';
  if (!raw.trim()) {
    reasoningEl.remove();
    return;
  }
  body.dataset.raw = raw;
  body.textContent = raw;
  reasoningEl.classList.remove('show');
  const arrow = reasoningEl.querySelector('.tool-arrow');
  if (arrow) arrow.classList.remove('open');
  body.style.display = 'none';
  requestAnimationFrame(() => {
    body.style.display = '';
  });
}
function toggleToolCard(card) {
  if (!card) return;
  const body = card.querySelector('.tool-body');
  setToolCardCollapsed(card, body?.classList.contains('show'));
}
function onToolToggleButtonClick(btn, ev) {
  ev.stopPropagation();
  toggleToolCard(btn.closest('.tool-card'));
}
async function renderMediaResultCards(container, { kind, mode, prompt, model, paths = [] }, options = {}) {
  const run = currentRunContext;
  const showMeta = options.showMeta !== false;
  container.dataset.mediaResult = JSON.stringify({ kind, mode, prompt, model, paths });
  container.innerHTML = `${showMeta ? `<div class="media-result-meta">${esc(model || '')} · ${esc(String(mode || '').replace('_', '→'))}</div><div style="margin-bottom:8px">${esc(t('media.saved') || 'Saved generated media:')}</div>` : ''}<div class="media-result-grid"></div>`;
  const grid = container.querySelector('.media-result-grid');
  for (const path of paths) {
    const node = vfsResolve(path);
    if (!node?.binary) continue;
    const bytes = await vfsGetBinary(path);
    if (run) activateConversationRun(run);
    if (!bytes) continue;
    const ext = path.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(new Blob([bytes], { type: getMimeType(ext) }));
    const card = document.createElement('div');
    card.className = 'media-result-card';
    const preview = kind === 'video'
      ? `<video src="${url}" controls></video>`
      : `<img src="${url}" alt="${esc(prompt || path)}">`;
    card.innerHTML = `<div class="media-result-preview">${preview}</div><div class="media-result-actions"><span title="${esc(path)}">${esc(path.split('/').pop())}</span><button class="top-btn" onclick="openFileViewer('${esc(path)}')">Open</button></div>`;
    grid.appendChild(card);
  }
}
async function appendMediaGenerationBubble({ mode, prompt, model, paths = [], error = '' }, run) {
  const { msgEl, textEl, reasoningEl } = appendAssistantBubble(run);
  if (reasoningEl) reasoningEl.remove();
  if (error) {
    textEl.innerHTML = `<div style="color:var(--accent-red)">${esc(error)}</div>`;
    return msgEl;
  }
  const kind = isVideoGenerationMode(mode) ? 'video' : 'image';
  await renderMediaResultCards(textEl, { kind, mode, prompt, model, paths });
  const title = t('media.saved') || 'Saved generated media:';
  appendSessionEntry('message', { role: 'assistant', content: [{ type: 'text', text: `${title}\n${paths.join('\n')}` }] });
  rebuildConversation();
  if (currentRunContext) snapshotConversationRunState(currentRunContext);
  updateMemoryUI();
  saveCurrentConv(true);
  return msgEl;
}

function parseMediaToolResult(out) {
  if (typeof out !== 'string') return null;
  const m = out.match(/\[MEDIA_RESULT\s+({[\s\S]*?})\]\s*$/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    if (!Array.isArray(data.paths) || !data.paths.length) return null;
    return data;
  } catch { return null; }
}
function stripMediaToolMarker(out) {
  return String(out || '').replace(/\n?\[MEDIA_RESULT\s+{[\s\S]*?}\]\s*$/, '').trim();
}
function createMediaRenderProgress(kind = 'image') {
  const el = document.createElement('div');
  el.className = 'media-render-progress';
  el.innerHTML = `<div class="media-render-visual"></div><div class="media-render-title"><span class="streaming-cursor"></span>${esc(t('media.generating'))}</div>`;
  return el;
}
function removeMediaRenderProgress(el) {
  if (!el) return;
  if (el._timer) clearInterval(el._timer);
  el.remove();
}
async function hydrateMediaResultCards(root = document) {
  const nodes = Array.from(root.querySelectorAll('[data-media-result]'));
  for (const node of nodes) {
    try {
      const data = JSON.parse(node.dataset.mediaResult || '{}');
      if (Array.isArray(data.paths) && data.paths.length) await renderMediaResultCards(node, data, { showMeta: !!node.querySelector('.media-result-meta') });
    } catch {}
  }
}
async function appendMediaResultOnly(msgEl, out) {
  const mediaResult = parseMediaToolResult(out);
  if (!mediaResult) return false;
  const main = msgEl.querySelector('.msg-assistant-main');
  let body = msgEl.querySelector('[data-role="assistant-text"]');
  if (!body && main) {
    body = document.createElement('div');
    body.className = 'msg-body';
    body.dataset.role = 'assistant-text';
    main.insertBefore(body, main.firstChild);
  }
  if (!body) return false;
  await renderMediaResultCards(body, mediaResult, { showMeta: false });
  return true;
}
function appendToolCard(msgEl, tu, out, isErr, existingEl = null, run) {
  const c = existingEl || document.createElement('div');
  c.className = 'tool-card' + (isErr ? ' error' : '');
  const sum = { Read: tu.input.file_path, Write: tu.input.file_path, Edit: tu.input.file_path, Glob: tu.input.pattern, Grep: tu.input.pattern, Bash: tu.input.command, PythonExec: (tu.input.code||'').slice(0,60), JSExec: (tu.input.code||'').slice(0,60), NodeExec: tu.input.script_path || (tu.input.code||'').slice(0,60), RunSubAgent: tu.input.task, GenerateImage: tu.input.prompt, GenerateVideo: tu.input.prompt, AskUser: tu.input.prompt }[tu.name] || '';
  const supportsCollapse = tu.name === 'Write' || tu.name === 'Edit' || tu.name === 'PythonExec' || tu.name === 'JSExec' || tu.name === 'NodeExec';
  const mediaResult = !isErr && parseMediaToolResult(out);
  const displayOut = mediaResult ? stripMediaToolMarker(out) : out;
  c.innerHTML = `<div class="tool-header" onclick="toggleToolCard(this.parentElement)"><span class="tool-name">${esc(tu.name)}</span><span class="tool-summary">${esc(sum)}</span>${supportsCollapse ? '<button class="tool-toggle-btn" onclick="onToolToggleButtonClick(this,event)">Expand</button>' : ''}<span class="tool-arrow">\u25BC</span></div><div class="tool-body"><div class="tool-input"><div class="tool-label">Input</div><pre class="tool-pre">${esc(JSON.stringify(tu.input,null,2))}</pre></div><div class="tool-output"><div class="tool-label">Output</div><pre class="tool-pre">${esc(typeof displayOut==='string'?displayOut:JSON.stringify(displayOut,null,2))}</pre></div></div>`;
  if (!existingEl) msgEl.appendChild(c);
  if (supportsCollapse && !existingEl) setToolCardCollapsed(c, true);
  if (mediaResult) {
    const preview = document.createElement('div');
    preview.className = 'media-tool-preview';
    c.querySelector('.tool-body')?.appendChild(preview);
    renderMediaResultCards(preview, mediaResult);
  }
  // Show preview card after Write/Edit for HTML/MD files
  if (!isErr && (tu.name === 'Write' || tu.name === 'Edit') && tu.input.file_path) {
    const fp = normPath(tu.input.file_path);
    const ext = fp.split('.').pop().toLowerCase();
    if (ext === 'html' || ext === 'htm' || ext === 'md' || ext === 'markdown') {
      const node = vfsResolve(fp);
      if (node && node.type === 'file' && node.content) appendFilePreview(msgEl, node.content, fp, run);
    }
  }
  return c;
}

const PREVIEW_EXTS = new Set(['html', 'htm', 'md', 'markdown']);
function getFilePreviewType(fp) {
  const ext = (fp || '').split('.').pop().toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

function appendFilePreview(parentEl, content, filePath, run) {
  const type = getFilePreviewType(filePath);
  if (!type) return;
  // Deduplicate: skip if a preview card for this path already exists in the message
  const existing = parentEl.querySelectorAll('.html-preview-card');
  for (const card of existing) { if (card.dataset.previewPath === filePath) return; }
  const wrap = document.createElement('div');
  wrap.className = 'html-preview-card';
  wrap.dataset.previewPath = filePath;
  const borderColor = type === 'md' ? 'var(--accent-purple)' : 'var(--accent-green)';
  wrap.style.borderLeftColor = borderColor;
  wrap.onclick = () => openPreviewModal(filePath, content, type);
  const fname = filePath ? filePath.split('/').pop() : 'preview';
  const size = content ? (content.length / 1024).toFixed(1) : '0';
  const icon = type === 'md' ? iconHtml('i:pencil') : iconHtml('i:globe');
  const label = type === 'md' ? 'Markdown' : 'HTML';
  wrap.innerHTML = `<div class="html-preview-header">
    <span class="html-preview-icon">${icon}</span>
    <div class="html-preview-info">
      <span class="html-preview-label" style="color:${borderColor}">${esc(fname)}</span>
      <span class="html-preview-path">${label} &middot; ${esc(filePath || '')} &middot; ${size} KB</span>
    </div>
    <button class="html-preview-open" style="border-color:${borderColor};color:${borderColor}" onclick="event.stopPropagation();openPreviewModal('${esc(filePath)}',null,'${type}')">&#x25B6; Preview</button>
  </div>`;
  parentEl.appendChild(wrap);
  scrollBottom(false, run);
}
function appendSystemMsg(t, run) { const d = document.createElement('div'); d.className = 'msg msg-system'; d.innerHTML = `<div class="msg-body">${esc(t)}</div>`; getContextChatEl(run).appendChild(d); scrollBottom(false, run); const ctx = run || currentRunContext; if (ctx) snapshotConversationRunState(ctx); }
function appendErrorBubble(t, meta = {}, run) {
  const { msgEl, textEl, reasoningEl } = appendAssistantBubble(run);
  msgEl.classList.add('msg-error');
  if (meta.userText) msgEl.dataset.userText = meta.userText;
  if (Number.isInteger(meta.promptIndex)) msgEl.dataset.promptIndex = String(meta.promptIndex);
  if (meta.promptEntryId) msgEl.dataset.promptEntryId = meta.promptEntryId;
  if (Number.isFinite(meta.tokenBase)) msgEl.dataset.tokenBase = String(meta.tokenBase);
  if (Number.isFinite(meta.loopBase)) msgEl.dataset.loopBase = String(meta.loopBase);
  reasoningEl.remove();
  textEl.dataset.raw = t;
  textEl.dataset.fmt = 'markdown';
  textEl.textContent = t;
  textEl.querySelector('.streaming-cursor')?.remove();
  const fmtBtn = msgEl.querySelector('[data-role="fmt"]');
  if (fmtBtn) fmtBtn.style.display = 'none';
  scrollBottom(false, run);
  return msgEl;
}
function detectFormat(t) {
  const s = t.trimStart();
  if (/^<!DOCTYPE html/i.test(s) || /^<html[\s>]/i.test(s)) return 'html';
  const stripped = s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/```[\s\S]*$/, '')
    .replace(/~~~[\s\S]*$/, '')
    .replace(/`[^`\n]*`/g, '');
  if (/<\/body>/i.test(stripped) && /<\/html>/i.test(stripped)) return 'html';
  return 'markdown';
}

function normalizeTextForDisplay(text) {
  let t = String(text ?? '');
  // Fast path
  if (t.indexOf('&') === -1 && t.indexOf('\\u') === -1) return t;

  // Decode only a safe subset of entities/escapes (quotes) OUTSIDE code fences.
  // We intentionally avoid decoding &lt; / &gt; to prevent turning harmless text into HTML.
  const decodeSegment = (seg) => seg
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&ldquo;|&#8220;/g, '\u201c')
    .replace(/&rdquo;|&#8221;/g, '\u201d')
    .replace(/&lsquo;|&#8216;/g, '\u2018')
    .replace(/&rsquo;|&#8217;/g, '\u2019')
    // Turn literal escape sequences into real characters (common when LLM outputs \uXXXX)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch { return _; }
    });

  // Split by fenced code blocks: keep fences untouched.
  // This is conservative and cheap; inline code (`...`) is left as-is.
  const parts = t.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part.startsWith('```') || part.startsWith('~~~')) continue;
    parts[i] = decodeSegment(part);
  }
  return parts.join('');
}

function renderMd(el, t) {
  el.dataset.raw = t;
  const fmt = detectFormat(t);
  const displayText = normalizeTextForDisplay(t);
  el.dataset.fmt = fmt;
  const msgEl = el.closest('.msg-assistant');

  if (fmt === 'html') {
    _renderHtmlFrame(el, t);
    if (msgEl) { const fb = msgEl.querySelector('[data-role="fmt"]'); if (fb) { fb.style.display = ''; } }
    el.appendChild(Object.assign(document.createElement('span'), { className: 'streaming-cursor' }));
    return;
  }

  // Prefer Pretext renderer; if it fails, fall back to marked; only then fall back to plain text.
  let rendered = false;

  if (typeof ptParseBlocks === 'function' && typeof ptLayout === 'function' && typeof ptRender === 'function') {
    try {
      const blocks = ptParseBlocks(displayText);
      const chat = el.closest('.chat-messages');
      const bodyPad = 28; // .msg-body horizontal padding (10+14)*2 ~ 28
      const containerPad = 28; // .chat-messages padding
      const avail = chat ? chat.clientWidth - containerPad - bodyPad : 0;
      const w = Math.max(320, Math.min(820 - bodyPad, avail || 600));
      const { layouts } = ptLayout(blocks, w);
      ptRender(el, layouts);
      rendered = true;
    } catch (e) {
      console.warn('renderMd pretext failed; falling back to marked:', e);
    }
  }

  if (!rendered) {
    try {
      el.innerHTML = marked.parse(displayText, { breaks: true, gfm: true });
      try { el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b)); } catch {}
      rendered = true;
    } catch (e) {
      console.warn('renderMd marked failed; falling back to plain text:', e);
      el.textContent = displayText;
      el.style.whiteSpace = 'pre-wrap';
      rendered = true;
    }
  }

  el.appendChild(Object.assign(document.createElement('span'), { className: 'streaming-cursor' }));
}
function _renderHtmlFrame(el, html) {
  const iframe = document.createElement('iframe');
  iframe.className = 'msg-html-frame';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.srcdoc = html;
  iframe.onload = () => { try { const h = iframe.contentDocument.documentElement.scrollHeight; iframe.style.height = Math.min(Math.max(h + 4, 220), 700) + 'px'; } catch {} };
  el.innerHTML = '';
  el.appendChild(iframe);
}

// ── Message actions ────────────────────────────────────────────────
function msgAction(btn, role) {
  const userMsgEl = btn.closest('.msg-user');
  const msgEl = userMsgEl || btn.closest('.msg-assistant');
  const isUser = !!userMsgEl;
  const textEl = isUser ? msgEl?.querySelector('.msg-body') : msgEl?.querySelector('[data-role="assistant-text"]');
  if (role === 'copy') {
    let raw;
    if (isUser) {
      raw = msgEl?.dataset.userText || textEl?.innerText || '';
    } else {
      const reasoningRaw = msgEl?.querySelector('[data-role="assistant-reasoning"] .reasoning-body')?.dataset.raw || msgEl?.querySelector('[data-role="assistant-reasoning"] .reasoning-body')?.innerText || '';
      const textRaw = textEl?.dataset.raw || textEl?.innerText || '';
      raw = reasoningRaw ? `[Thinking]\n${reasoningRaw}\n\n[Answer]\n${textRaw}` : textRaw;
    }
    navigator.clipboard.writeText(raw).then(() => {
      const prev = btn.innerHTML; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'; btn.classList.add('ok');
      setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('ok'); }, 1500);
    }).catch(() => {});
  } else if (role === 'fmt') {
    const el = textEl;
    if (!el) return;
    if (el.dataset.fmt === 'html') {
      if (btn.classList.contains('fmt-active')) {
        btn.classList.remove('fmt-active');
        _renderHtmlFrame(el, el.dataset.raw);
      } else {
        btn.classList.add('fmt-active');
        el.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;line-height:1.5;color:var(--text-secondary)">${esc(el.dataset.raw)}</pre>`;
      }
    } else {
      if (btn.classList.contains('fmt-active')) {
        btn.classList.remove('fmt-active');
        renderMd(el, el.dataset.raw);
        el.querySelector('.streaming-cursor')?.remove();
      } else {
        btn.classList.add('fmt-active');
        el.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;line-height:1.5;color:var(--text-secondary)">${esc(el.dataset.raw)}</pre>`;
        if (!msgEl.querySelector('[data-role="fmt"]')?.style.display) {
          msgEl.querySelector('[data-role="fmt"]').style.display = '';
        }
      }
    }
  } else if (role === 'regen') {
    ensureVisibleConversationStateActive();
    if (isConversationRunning(visibleConvId || activeConvId)) return;
    const promptEntryId = msgEl?.dataset.promptEntryId || '';
    const tokenBase = Number(msgEl?.dataset.tokenBase);
    const loopBase = Number(msgEl?.dataset.loopBase);
    if (!promptEntryId) return;
    activeEntryId = promptEntryId;
    rebuildConversation();
    const promptIndex = findConversationIndexByEntryId(promptEntryId);
    if (!Number.isInteger(promptIndex) || promptIndex < 0) return;
    const userMsg = conversation[promptIndex];
    const userText = getUserTextFromContent(userMsg?.content) || msgEl?.dataset.userText;
    if (!userText) return;
    totalTokens = Number.isFinite(tokenBase) && tokenBase >= 0 ? tokenBase : 0;
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
    loopCount = Number.isFinite(loopBase) && loopBase >= 0 ? loopBase : Math.max(0, loopCount - 1);
    let userBubble;
    if (isUser) {
      userBubble = msgEl;
    } else {
      userBubble = msgEl.previousElementSibling;
      while (userBubble && !userBubble.classList.contains('msg-user')) userBubble = userBubble.previousElementSibling;
      if (!userBubble) {
        userBubble = Array.from(chatEl.querySelectorAll('.msg-user')).find(el => el.dataset.promptEntryId === promptEntryId) || null;
      }
    }
    const startNode = userBubble ? userBubble.nextSibling : msgEl;
    let node = startNode;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    updateMemoryUI();
    const fileList = Array.from(userBubble?.querySelectorAll('[title]') || []).map(el => el.getAttribute('title')).filter(v => v && v.startsWith('/'));
    saveCurrentConv(true);
    const convId = visibleConvId || activeConvId;
    const run = {
      convId, active: true, kind: 'chat',
      abortCtrl: new AbortController(),
      startedAt: Date.now(),
      statusType: 'running',
      statusText: t('status.thinking'),
      state: captureConversationState(chatEl.innerHTML),
      chatContainer: null,
      chatHTML: chatEl.innerHTML,
      cancelled: false,
      deleted: false,
      pendingGuidance: []
    };
    conversationRuns.set(convId, run);
    activateConversationRun(run);
    updateButtons();
    renderConvList();
    _runAgentLoop(userText, { promptIndex, promptEntryId, tokenBase: totalTokens, loopBase: loopCount, fileList, run, convId });
  } else if (role === 'like') {
    btn.classList.toggle('ok');
    msgEl?.querySelector('[data-role="dislike"]')?.classList.remove('bad');
  } else if (role === 'dislike') {
    btn.classList.toggle('bad');
    msgEl?.querySelector('[data-role="like"]')?.classList.remove('ok');
  }
}

