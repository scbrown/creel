/* creel harness — part 23 of 26: sse-parsers
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
 *   - SSE PARSERS
 *   - AGENT LOOP
 */
// ═══════════════════════════════════════════════════════════════════
// SSE PARSERS
// ═══════════════════════════════════════════════════════════════════
function _collectTypedText(value, wantedTypes = null, out = []) {
  if (!value) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) {
    for (const item of value) _collectTypedText(item, wantedTypes, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  const type = typeof value.type === 'string' ? value.type : '';
  const typeAllowed = !wantedTypes || wantedTypes.has(type) || !type;
  if (typeAllowed) {
    if (typeof value.text === 'string') out.push(value.text);
    else if (typeof value.content === 'string') out.push(value.content);
    else if (typeof value.reasoning_content === 'string') out.push(value.reasoning_content);
    else if (typeof value.thinking === 'string') out.push(value.thinking);
    else if (typeof value.summary === 'string') out.push(value.summary);
  }
  if (value.text && typeof value.text === 'object') _collectTypedText(value.text, wantedTypes, out);
  if (value.delta && typeof value.delta === 'object') _collectTypedText(value.delta, wantedTypes, out);
  return out;
}
function extractReasoningChunkFromOpenAIDelta(dl) {
  if (!dl || typeof dl !== 'object') return '';
  if (typeof dl.reasoning_content === 'string') return dl.reasoning_content;
  if (typeof dl.reasoning === 'string') return dl.reasoning;
  if (typeof dl.thinking === 'string') return dl.thinking;
  if (typeof dl.reasoning_text === 'string') return dl.reasoning_text;
  const wantedTypes = new Set(['reasoning', 'reasoning_text', 'thinking', 'summary_text']);
  const parts = [];
  _collectTypedText(dl.reasoning_details, wantedTypes, parts);
  _collectTypedText(dl.reasoning, wantedTypes, parts);
  _collectTypedText(dl.thinking, wantedTypes, parts);
  if (!parts.length && Array.isArray(dl.content)) _collectTypedText(dl.content, wantedTypes, parts);
  return parts.join('');
}
function extractTextChunkFromOpenAIDelta(dl) {
  if (!dl || typeof dl !== 'object') return '';
  if (typeof dl.content === 'string') return dl.content;
  if (!Array.isArray(dl.content)) return '';
  const wantedTypes = new Set(['text', 'output_text', 'message', 'content']);
  return _collectTypedText(dl.content, wantedTypes, []).join('');
}

async function parseAnthropicStream(reader, onText, onReasoning, onToolStart, onToolDelta) {
  const dec = new TextDecoder(); let buf = ''; const blocks = []; let stop = null; const tjb = {}; let usageTotal = 0; let usageRaw = null;
  while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop(); let et = '';
    for (const line of lines) { if (line.startsWith('event: ')) { et = line.slice(7).trim(); } else if (line.startsWith('data: ')) { let d; try { d = JSON.parse(line.slice(6)); } catch { continue; }
      if (et === 'content_block_start') { blocks[d.index] = { ...d.content_block }; if (d.content_block.type === 'tool_use') { tjb[d.index] = ''; onToolStart({ ...d.content_block, index: d.index }); } }
      else if (et === 'content_block_delta') {
        const dx = d.delta;
        if (dx.type === 'text_delta') { if (!blocks[d.index]) blocks[d.index] = { type: 'text', text: '' }; blocks[d.index].text += dx.text; onText(dx.text); }
        else if (dx.type === 'thinking_delta') { const chunk = dx.thinking || dx.text || ''; if (chunk) onReasoning(chunk); }
        else if (dx.type === 'signature_delta') { /* ignore signatures */ }
        else if (dx.type === 'input_json_delta') { tjb[d.index] = (tjb[d.index] || '') + dx.partial_json; onToolDelta(d.index, dx.partial_json); }
      }
      else if (et === 'content_block_stop') { if (blocks[d.index]?.type === 'tool_use' && tjb[d.index] !== undefined) { try { blocks[d.index].input = JSON.parse(tjb[d.index]); } catch { blocks[d.index].input = {}; } } }
      else if (et === 'message_delta') {
        if (d.delta?.stop_reason) stop = d.delta.stop_reason;
        const msgUsage = extractUsageTotal(d.usage);
        if (msgUsage) { usageTotal = msgUsage; usageRaw = d.usage; }
      }
      else if (et === 'message_stop') {
        const finalUsage = d.message?.usage || d.usage;
        const msgUsage = extractUsageTotal(finalUsage);
        if (msgUsage) { usageTotal = msgUsage; usageRaw = finalUsage; }
      }
      else if (et === 'error') { throw new Error(d.error?.message || JSON.stringify(d)); }
      et = ''; } } }
  return { content: blocks, stop_reason: stop || 'end_turn', usage_total: usageTotal, usage: usageRaw };
}

async function parseOpenAIStream(reader, onText, onReasoning, onToolStart, onToolDelta, options = {}) {
  const keepReasoning = !!options.keepReasoning;
  const includeReasoningUsage = !!options.includeReasoningUsage;
  const dec = new TextDecoder(); let buf = '', txt = '', reasoning = ''; const tcs = {}; let stop = null; let usageTotal = 0; let usageRaw = null; let streamError = '';
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) { if (!line.startsWith('data: ')) continue; const ds = line.slice(6).trim(); if (ds === '[DONE]') { stop = stop || 'end_turn'; continue; } let d; try { d = JSON.parse(ds); } catch { continue; } const usage = extractUsageTotal(d.usage, { includeReasoningDetails: includeReasoningUsage }); if (usage) { usageTotal = usage; usageRaw = d.usage; } const ch = d.choices?.[0]; if (!ch) continue;
        if (ch.finish_reason) stop = ch.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
        const dl = ch.delta; if (!dl) continue;
        const reasoningChunk = extractReasoningChunkFromOpenAIDelta(dl);
        if (reasoningChunk) { if (keepReasoning) reasoning += reasoningChunk; onReasoning(reasoningChunk); }
        const textChunk = extractTextChunkFromOpenAIDelta(dl);
        if (textChunk) { txt += textChunk; onText(textChunk); }
        if (dl.tool_calls) {
          for (const tc of dl.tool_calls) {
            const i = tc.index;
            if (!tcs[i]) tcs[i] = { id: tc.id || `call_${i}`, name: '', arguments: '', started: false };
            if (tc.id) tcs[i].id = tc.id;
            if (tc.function?.name) tcs[i].name = tc.function.name;
            if (!tcs[i].started && tcs[i].name) {
              tcs[i].started = true;
              onToolStart({ type: 'tool_use', id: tcs[i].id, name: tcs[i].name, index: i });
            }
            if (tc.function?.arguments) {
              tcs[i].arguments += tc.function.arguments;
              if (!tcs[i].started && tcs[i].name) {
                tcs[i].started = true;
                onToolStart({ type: 'tool_use', id: tcs[i].id, name: tcs[i].name, index: i });
              }
              onToolDelta(i, tc.function.arguments);
            }
          }
        }
      }
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    streamError = e?.message || String(e || 'Network error');
  }
  const blocks = []; if (keepReasoning && reasoning) blocks.push({ type: 'reasoning', reasoning_content: reasoning }); if (txt) blocks.push({ type: 'text', text: txt });
  for (const i of Object.keys(tcs).sort((a,b) => a-b)) { let inp = {}; try { inp = JSON.parse(tcs[i].arguments); } catch {} blocks.push({ type: 'tool_use', id: tcs[i].id, name: tcs[i].name, index: Number(i), input: inp }); }
  return { content: blocks, stop_reason: streamError ? 'interrupted' : (stop || 'end_turn'), usage_total: usageTotal, usage: usageRaw, stream_error: streamError };
}

// ═══════════════════════════════════════════════════════════════════
// AGENT LOOP
// ═══════════════════════════════════════════════════════════════════
async function agentLoop(userContent, displayText, fileList, usedSkills, options = {}) {
  ensureVisibleConversationStateActive();
  const convId = visibleConvId || activeConvId;
  if (!convId || isConversationRunning(convId)) return;
  const run = {
    convId,
    active: true,
    kind: 'chat',
    abortCtrl: new AbortController(),
    startedAt: Date.now(),
    statusType: 'running',
    statusText: t('status.thinking'),
    state: captureConversationState(chatEl.innerHTML),
    chatContainer: null,
    chatHTML: chatEl.innerHTML,
    cancelled: false,
    deleted: false
  };
  conversationRuns.set(convId, run);
  activateConversationRun(run);
  updateButtons();
  renderConvList();
  const usedSkillNames = (usedSkills || []).map(sk => sk.name).filter(Boolean);
  // on_user_submit hook: may block or rewrite the user's text
  const userTextPre = getUserTextFromContent(userContent) || displayText || '';
  const submitCtx = await runHooks('on_user_submit', { text: userTextPre, files: fileList || [], usedSkills: usedSkillNames });
  activateConversationRun(run);
  if (submitCtx._blocked) {
    appendSystemMsg(`Blocked by hook [${submitCtx._blocked.by}]: ${submitCtx._blocked.reason}`, run);
    snapshotConversationRunState(run);
    run.active = false;
    conversationRuns.delete(convId);
    await saveConversationState(convId, run.state, { andRenderList: true });
    currentRunContext = null;
    syncLegacyRunFlags();
    updateButtons();
    return;
  }
  if (typeof submitCtx.text === 'string' && submitCtx.text !== userTextPre) {
    // Replace the first text block in userContent with the rewritten text.
    if (Array.isArray(userContent)) {
      const textBlock = userContent.find(b => b && b.type === 'text');
      if (textBlock) textBlock.text = submitCtx.text;
      else userContent.unshift({ type: 'text', text: submitCtx.text });
    } else if (typeof userContent === 'string') {
      userContent = submitCtx.text;
    }
  }
  const userEntry = appendSessionEntry('message', { role: 'user', content: userContent, usedSkillNames });
  rebuildConversation();
  const promptIndex = findConversationIndexByEntryId(userEntry.id);
  const userText = getUserTextFromContent(userContent) || displayText || '';
  appendUserBubble(displayText || userText, fileList, usedSkills, promptIndex, userEntry.id, run);
  if (conversation.filter(m => m.role === 'user').length === 1 && convId && userText) {
    scheduleConversationTitleGeneration(convId, userText);
  }
  snapshotConversationRunState(run);
  await _runAgentLoop(userText, { promptIndex, promptEntryId: userEntry.id, fileList, ralph: options.ralph, convId, run });
}

// Extract readable content from partial tool JSON for live preview
function _extractToolContent(toolName, partialJson) {
  const extractPartialStringField = (fieldName) => {
    const key = `"${fieldName}"`;
    const idx = partialJson.indexOf(key);
    if (idx < 0) return null;
    const colon = partialJson.indexOf(':', idx + key.length);
    if (colon < 0) return null;
    const quote = partialJson.indexOf('"', colon + 1);
    if (quote < 0) return null;
    let out = '', escaped = false;
    for (let i = quote + 1; i < partialJson.length; i++) {
      const ch = partialJson[i];
      if (escaped) {
        if (ch === 'n') out += '\n';
        else if (ch === 't') out += '\t';
        else if (ch === 'r') out += '\r';
        else if (ch === 'b') out += '\b';
        else if (ch === 'f') out += '\f';
        else if (ch === '"' || ch === '\\' || ch === '/') out += ch;
        else if (ch === 'u') {
          const hex = partialJson.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          else { out += '\\u'; }
        } else {
          out += ch;
        }
        escaped = false;
        continue;
      }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') return out;
      out += ch;
    }
    return out;
  };

  if (toolName === 'Write' || toolName === 'Edit') {
    const val = extractPartialStringField(toolName === 'Write' ? 'content' : 'new_string');
    if (val != null) {
      const fpMatch = partialJson.match(/"file_path"\s*:\s*"([^"]+)"/);
      const header = fpMatch ? fpMatch[1] + '\n' + '─'.repeat(Math.min(fpMatch[1].length, 40)) + '\n' : '';
      return header + val;
    }
  }

  if (toolName === 'PythonExec' || toolName === 'JSExec' || toolName === 'NodeExec') {
    const val = extractPartialStringField('code');
    if (val != null) return val;
    if (toolName === 'NodeExec') {
      const script = extractPartialStringField('script_path');
      if (script != null) return script;
    }
  }

  if (toolName === 'Bash') {
    const val = extractPartialStringField('command');
    if (val != null) return val;
  }

  return partialJson.length > 2000 ? partialJson.slice(-2000) : partialJson;
}
function isNearBottom(el, threshold = 24) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

async function _runAgentLoop(userText, options = {}) {
  const run = options.run || (options.convId ? conversationRuns.get(options.convId) : null);
  if (run) activateConversationRun(run);
  isGenerating = isRunVisible(run); updateButtons(); setStatus('running', t('status.thinking'), run);
  rebuildConversation();
  // Reset per-turn swarm accounting (workers from a prior turn don't carry budget over).
  if (swarmRunActive) endSwarmRun();
  const promptEntryId = options.promptEntryId || activeEntryId;
  const promptIndex = Number.isInteger(options.promptIndex) ? options.promptIndex : findConversationIndexByEntryId(promptEntryId);
  const tokenBase = Number.isFinite(options.tokenBase) ? options.tokenBase : totalTokens;
  const loopBase = Number.isFinite(options.loopBase) ? options.loopBase : loopCount;
  const memoryRecallKey = String(promptEntryId || stableStringHash(userText || ''));
  const ralphOptions = normalizeRalphOptions(options.ralph);
  if (ralphOptions.enabled) {
    ralphRun = { active: true, originalTask: userText, promptEntryId, iteration: 0, unlimited: ralphOptions.unlimited, maxIterations: ralphOptions.maxIterations, completionMarker: ralphOptions.completionMarker, cancelled: false, stopReason: '', seenSignatures: new Map() };
    appendSystemMsg(`Ralph Loop started: max ${ralphRun.unlimited ? '∞' : ralphRun.maxIterations} iterations, marker "${ralphRun.completionMarker}".`, run);
    renderRalphButton();
  }
  let stoppedBy = 'done';
  if (run && !run.abortCtrl) run.abortCtrl = new AbortController();
  abortCtrl = run?.abortCtrl || new AbortController();
  try {
    while (true) {
      if (run) activateConversationRun(run);
      if (run?.pendingGuidance?.length) {
        const queued = run.pendingGuidance.splice(0);
        for (const g of queued) {
          const entry = appendSessionEntry('message', { role: 'user', content: g.text, guidance: true });
          appendUserBubble(g.text, g.fileList || [], [], findConversationIndexByEntryId(entry.id), entry.id, run);
        }
        rebuildConversation();
        snapshotConversationRunState(run);
      }
      loopCount++; updateMemoryUI();
      await checkAndCompact();
      if (run) activateConversationRun(run);
      const requestMessages = buildConversationFromEntries();
      const requestSnapshot = await buildContextSnapshot(requestMessages, promptEntryId, { memoryRecallKey, run });
      if (run) activateConversationRun(run);
      applyContextSnapshot(requestSnapshot);
      const body = await buildRequestBody(requestMessages, promptEntryId, { memoryRecallKey, run });
      if (run) activateConversationRun(run);
      const keepReasoning = shouldKeepReasoningForModel(body.model || API_MODEL);
      let estimatedRequestTokens = requestSnapshot.totalEstimatedTokens || estimateRequestBodyTokens(body);
      body.stream = true;
      if (PROVIDER !== 'anthropic_compat') {
        body.stream_options = { ...(body.stream_options || {}), include_usage: true };
      }
      // Show pending "thinking" bubble BEFORE fetch so users see immediate feedback.
      const { msgEl, textEl, reasoningEl } = appendAssistantBubble(run);
      textEl.dataset.pending = '1';
      textEl.innerHTML = `<div class="thinking" aria-label="${t('thinking')}"><span></span><span></span><span></span></div>`;
      msgEl.dataset.userText = userText;
      msgEl.dataset.promptIndex = String(promptIndex);
      msgEl.dataset.promptEntryId = promptEntryId || '';
      msgEl.dataset.tokenBase = String(tokenBase);
      msgEl.dataset.loopBase = String(loopBase);
      let resp;
      let retriedAfterContextCompact = false;
      try { resp = await sendLLMRequestBody(body, (run?.abortCtrl || abortCtrl).signal); }
      catch (e) { msgEl.remove(); throw e; }
      if (run) activateConversationRun(run);
      if (!resp.ok) {
        const errorText = await resp.text();
        if (run) activateConversationRun(run);
        if (isContextLengthError(resp.status, errorText) && !retriedAfterContextCompact) {
          appendSystemMsg('Context length exceeded. Compacting context and retrying once...', run);
          await compactMemory({ trigger: 'context_error', snapshot: requestSnapshot });
          if (run) activateConversationRun(run);
          const retryMessages = buildConversationFromEntries();
          const retrySnapshot = await buildContextSnapshot(retryMessages, promptEntryId, { memoryRecallKey, run });
          applyContextSnapshot(retrySnapshot);
          const retryBody = await buildRequestBody(retryMessages, promptEntryId, { memoryRecallKey, run });
          retryBody.stream = true;
          estimatedRequestTokens = retrySnapshot.totalEstimatedTokens || estimateRequestBodyTokens(retryBody);
          retriedAfterContextCompact = true;
          if (PROVIDER !== 'anthropic_compat') retryBody.stream_options = { ...(retryBody.stream_options || {}), include_usage: true };
          resp = await sendLLMRequestBody(retryBody, (run?.abortCtrl || abortCtrl).signal);
          if (run) activateConversationRun(run);
          if (!resp.ok) { stoppedBy = 'error'; msgEl.remove(); appendErrorBubble(`API Error (${resp.status}): ${(await resp.text()).slice(0, 300)}`, { userText, promptIndex, promptEntryId, tokenBase, loopBase }, run); break; }
        } else {
          stoppedBy = 'error';
          msgEl.remove();
          appendErrorBubble(`API Error (${resp.status}): ${errorText.slice(0, 300)}`, { userText, promptIndex, promptEntryId, tokenBase, loopBase }, run);
          break;
        }
      }
      const reader = resp.body.getReader();
      // Replace thinking dots with streaming cursor now that response is flowing.
      delete textEl.dataset.pending;
      textEl.innerHTML = '<span class="streaming-cursor"></span>';
      setStatus('running', t('status.streaming'), run);
      let fullText = '';
      const onText = chunk => { if (run) activateConversationRun(run); fullText += chunk; renderMdThrottled(textEl, fullText); scrollBottom(false, run); if (run) snapshotConversationRunState(run); };
      const onReasoning = chunk => { if (run) activateConversationRun(run); appendReasoningChunk(reasoningEl, chunk); scrollBottom(false, run); if (run) snapshotConversationRunState(run); };
      // Live tool generation preview
      const _toolEls = []; // all live tool cards for cleanup
      const _toolMap = {}; // index -> { el, name, json }
      let _toolRenderTimer = null;
      const onToolStart = (block) => {
        if (run) activateConversationRun(run);
        const toolIndex = block.index ?? Object.keys(_toolMap).length;
        if (_toolMap[toolIndex]) return;
        const entry = { name: block.name, json: '', el: null };
        const el = document.createElement('div'); el.className = 'tool-card streaming';
        const supportsCollapse = block.name === 'Write' || block.name === 'Edit' || block.name === 'PythonExec' || block.name === 'JSExec' || block.name === 'NodeExec';
        const summaryText = block.name === 'PythonExec' ? 'generating python code…' : block.name === 'JSExec' ? 'generating javascript code…' : block.name === 'NodeExec' ? 'generating node code…' : block.name === 'Write' ? 'generating file content…' : block.name === 'Edit' ? 'generating replacement content…' : 'generating…';
        el.innerHTML = `<div class="tool-header" onclick="toggleToolCard(this.parentElement)"><span class="tool-name">${esc(block.name)}</span><span class="tool-summary" style="color:var(--accent-orange)">${summaryText}</span>${supportsCollapse ? '<button class="tool-toggle-btn" onclick="onToolToggleButtonClick(this,event)">Collapse</button>' : ''}<span class="tool-arrow open">\u25BC</span><span class="streaming-cursor" style="margin-left:4px"></span></div><div class="tool-body show"><div class="tool-output"><pre class="tool-pre" style="max-height:300px;overflow-y:auto"></pre></div></div>`;
        msgEl.appendChild(el); scrollBottom(false, run);
        entry.el = el;
        _toolMap[toolIndex] = entry;
        _toolEls.push(el);
        setStatus('running', `${block.name}...`, run);
      };
      const onToolDelta = (idx, partial) => {
        if (run) activateConversationRun(run);
        const entry = _toolMap[idx];
        if (!entry) return;
        entry.json += partial;
        if (_toolRenderTimer) return;
        _toolRenderTimer = setTimeout(() => {
          _toolRenderTimer = null;
          for (const key of Object.keys(_toolMap)) {
            const tool = _toolMap[key];
            if (!tool?.el) continue;
            const pre = tool.el.querySelector('.tool-pre');
            if (!pre) continue;
            const shouldStickToolScroll = isNearBottom(pre, 16);
            pre.textContent = _extractToolContent(tool.name, tool.json);
            if (shouldStickToolScroll) pre.scrollTop = pre.scrollHeight;
          }
          scrollBottom(false, run);
        }, 80);
      };
      let result;
      try {
        result = PROVIDER === 'anthropic_compat'
          ? await parseAnthropicStream(reader, onText, onReasoning, onToolStart, onToolDelta)
          : await parseOpenAIStream(reader, onText, onReasoning, onToolStart, onToolDelta, { keepReasoning, includeReasoningUsage: keepReasoning });
      } catch (e) {
        if (isAbortError(e)) throw e;
        const bgHint = window.CreelReconnect?.wasRecentlyHidden() ? ' (tab was in background — resend to retry)' : '';
        result = { content: fullText ? [{ type: 'text', text: fullText }] : [], stop_reason: 'interrupted', usage_total: 0, stream_error: (e?.message || String(e || 'Network error')) + bgHint };
      }
      if (run) activateConversationRun(run);
      if (result.stream_error) {
        const partialToolText = Object.values(_toolMap).map(tool => {
          const content = _extractToolContent(tool.name, tool.json).trim();
          return content ? `Partial ${tool.name} content:\n\`\`\`\n${content}\n\`\`\`` : '';
        }).filter(Boolean).join('\n\n');
        const safeContent = result.content.filter(b => b.type === 'reasoning' || b.type === 'text');
        if (!safeContent.some(b => b.type === 'text') && partialToolText) safeContent.push({ type: 'text', text: partialToolText });
        else if (partialToolText) safeContent.push({ type: 'text', text: '\n\n' + partialToolText });
        result.content = safeContent;
      }
      const reportedUsage = Number(result.usage_total) || 0;
      const estimatedOutputTokens = estimateTokenCountFromText(fullText);
      const turnTokens = reportedUsage || (estimatedRequestTokens + estimatedOutputTokens);
      totalTokens += turnTokens;
      lastTurnTokens = turnTokens;
      lastUsageInfo = result.usage || null;
      const usageDetails = extractUsageDetails(result.usage, { includeReasoningDetails: keepReasoning });
      lastInputTokens = usageDetails?.input || estimatedRequestTokens;
      lastOutputTokens = usageDetails?.output || estimatedOutputTokens;
      totalInputTokens += lastInputTokens;
      totalOutputTokens += lastOutputTokens;
      lastCacheReadTokens = usageDetails?.cacheRead || 0;
      lastCacheWriteTokens = usageDetails?.cacheWrite || 0;
      // Flush pending tool render before finalizing tool cards
      if (_toolRenderTimer) {
        clearTimeout(_toolRenderTimer);
        _toolRenderTimer = null;
        for (const key of Object.keys(_toolMap)) {
          const tool = _toolMap[key];
          if (!tool?.el) continue;
          const pre = tool.el.querySelector('.tool-pre');
          if (!pre) continue;
          const shouldStickToolScroll = isNearBottom(pre, 16);
          pre.textContent = _extractToolContent(tool.name, tool.json);
          if (shouldStickToolScroll) pre.scrollTop = pre.scrollHeight;
        }
      }
      // Flush any pending throttled render
      flushRender(textEl);
      if (fullText) {
        renderMd(textEl, fullText);
        const fb = msgEl.querySelector('[data-role="fmt"]');
        if (fb && textEl.dataset.fmt === 'markdown') { fb.style.display = ''; }
      }
      textEl.querySelector('.streaming-cursor')?.remove();
      finalizeReasoning(reasoningEl);
      if (result.stream_error) {
        const interrupted = document.createElement('div');
        interrupted.className = 'tool-card error';
        interrupted.innerHTML = `<div class="tool-header"><span class="tool-name">Network interrupted</span><span class="tool-summary">Partial output preserved. Click regenerate to continue if needed.</span></div><div class="tool-body show"><div class="tool-output">${esc(result.stream_error)}</div></div>`;
        msgEl.appendChild(interrupted);
      }
      if (!fullText && result.content.some(b => b.type === 'tool_use') && result.content.every(b => b.type === 'tool_use' || b.type === 'reasoning')) msgEl.querySelector('[data-role="assistant-text"]')?.remove();
      const assistantEntry = appendSessionEntry('message', { role: 'assistant', content: result.content, promptEntryId, streamError: result.stream_error || undefined });
      rebuildConversation();
      if (run) snapshotConversationRunState(run);
      msgEl.dataset.assistantEntryId = assistantEntry.id;
      const postAssistantSnapshot = await buildContextSnapshot(undefined, undefined, { run });
      if (run) activateConversationRun(run);
      applyContextSnapshot(postAssistantSnapshot);
      updateMemoryUI();
      await runHooks('on_assistant_response', { content: result.content, loopCount, stopReason: result.stop_reason });
      if (run) activateConversationRun(run);
      let ralphDecision = null;
      const tus = result.stream_error ? [] : result.content.filter(b => b.type === 'tool_use');
      if (tus.length) {
        // Per-tool execution closure: runs hooks, executes the tool, appends the UI card,
        // and returns the tool_result block. Used both sequentially and via Promise.all (for SwarmSpawn batches).
        const processOneTu = async (tu, toolOrder) => {
          if (run) activateConversationRun(run);
          const liveEntry = _toolMap[tu.index ?? toolOrder];
          let effectiveInput = tu.input;
          const preCtx = await runHooks('pre_tool', { name: tu.name, input: tu.input, toolUseId: tu.id });
          if (run) activateConversationRun(run);
          if (preCtx._blocked) {
            const blocked = `Error: blocked by hook [${preCtx._blocked.by}]: ${preCtx._blocked.reason}`;
            appendToolCard(msgEl, tu, blocked, true, liveEntry?.el || null, run);
            return PROVIDER === 'anthropic_compat' ? { type: 'tool_result', tool_use_id: tu.id, content: blocked, is_error: true } : { type: 'tool_result', tool_use_id: tu.id, content: blocked };
          }
          if (preCtx.input && typeof preCtx.input === 'object') effectiveInput = preCtx.input;
          const mediaProgressEl = (tu.name === 'GenerateImage' || tu.name === 'GenerateVideo') ? createMediaRenderProgress(tu.name === 'GenerateVideo' ? 'video' : 'image') : null;
          if (mediaProgressEl) {
            msgEl.insertBefore(mediaProgressEl, liveEntry?.el?.nextSibling || null);
            setStatus('running', t('media.generating'), run);
            scrollBottom(false, run);
          }
          let out;
          try {
            out = await executeTool(tu.name, effectiveInput);
            if (run) activateConversationRun(run);
          } finally {
            removeMediaRenderProgress(mediaProgressEl);
          }
          let isErr = typeof out === 'string' && out.startsWith('Error:');
          if (isErr) {
            const errCtx = await runHooks('on_error', { name: tu.name, input: effectiveInput, output: out, toolUseId: tu.id, error: out });
            if (run) activateConversationRun(run);
            if (Object.prototype.hasOwnProperty.call(errCtx, 'output') && errCtx.output !== out) { out = errCtx.output; isErr = typeof out === 'string' && out.startsWith('Error:'); }
          } else {
            const postCtx = await runHooks('post_tool', { name: tu.name, input: effectiveInput, output: out, toolUseId: tu.id, isError: false });
            if (run) activateConversationRun(run);
            if (Object.prototype.hasOwnProperty.call(postCtx, 'output') && postCtx.output !== out) { out = postCtx.output; isErr = typeof out === 'string' && out.startsWith('Error:'); }
          }
          const isMediaTool = tu.name === 'GenerateImage' || tu.name === 'GenerateVideo';
          if (isMediaTool && !isErr) {
            if (liveEntry?.el?.isConnected) liveEntry.el.remove();
            if (!(await appendMediaResultOnly(msgEl, out))) appendToolCard(msgEl, tu, out, isErr, liveEntry?.el || null, run);
            if (run) activateConversationRun(run);
          } else {
            appendToolCard(msgEl, tu, out, isErr, liveEntry?.el || null, run);
          }
          return PROVIDER === 'anthropic_compat' ? { type: 'tool_result', tool_use_id: tu.id, content: out, is_error: isErr || undefined } : { type: 'tool_result', tool_use_id: tu.id, content: out };
        };
        // Walk the tool_use blocks in order. Contiguous SwarmSpawn calls are executed in PARALLEL
        // (chunked by swarmSettings.maxConcurrency) — this is the key swarm fanout primitive.
        // Other tools run sequentially as before.
        const trsByIndex = new Array(tus.length);
        let i = 0;
        while (i < tus.length) {
          if (swarmSettings.enabled && tus[i].name === 'SwarmSpawn') {
            let j = i;
            const group = [];
            while (j < tus.length && tus[j].name === 'SwarmSpawn') { group.push({ tu: tus[j], order: j }); j++; }
            const cap = Math.max(1, Math.min(Number(swarmSettings.maxConcurrency) || 3, 16));
            let k = 0;
            if (!swarmRunActive) startSwarmRun();
            while (k < group.length) {
              const slice = group.slice(k, k + cap);
              const results = await Promise.all(slice.map(g => processOneTu(g.tu, g.order)));
              if (run) activateConversationRun(run);
              for (let m = 0; m < slice.length; m++) trsByIndex[slice[m].order] = results[m];
              k += cap;
            }
            i = j;
          } else {
            trsByIndex[i] = await processOneTu(tus[i], i);
            if (run) activateConversationRun(run);
            i++;
          }
        }
        const trs = trsByIndex;
        for (const el of _toolEls) {
          if (el.isConnected && !el.querySelector('.tool-input')) el.remove();
        }
        appendSessionEntry('tool_result', { content: trs, promptEntryId });
        rebuildConversation();
        if (run) snapshotConversationRunState(run);
        const postToolSnapshot = await buildContextSnapshot(undefined, undefined, { run });
        if (run) activateConversationRun(run);
        applyContextSnapshot(postToolSnapshot);
        setStatus('running', t('status.processing'), run);
        scrollBottom(false, run);
      }
      if (!result.stream_error && result.stop_reason !== 'tool_use' && ralphRun?.active) {
        ralphDecision = shouldContinueRalphLoop({ result, fullText, todos, ralphRun });
      }
      const willRalphContinue = !!ralphDecision?.continue;
      // Fire memory extraction ONCE per user turn — on the final response,
      // not after every tool-use or Ralph continuation iteration. Cuts both cost and noise.
      if (!willRalphContinue && result.stop_reason !== 'tool_use' && memIsEnabled() && memGetSettings().autoExtract) {
        memExtractAfterTurn({ userText, assistantContent: result.content, loopCount, convId: activeConvId })
          .catch(e => console.warn('memExtractAfterTurn failed', e));
      }
      if (result.stream_error) {
        stoppedBy = 'error';
        if (ralphRun?.active) ralphRun.stopReason = 'stream error';
        break;
      }
      if (result.stop_reason === 'tool_use') continue;
      if (ralphRun?.active) {
        if (!ralphDecision) ralphDecision = shouldContinueRalphLoop({ result, fullText, todos, ralphRun });
        if (!ralphDecision.continue) {
          ralphRun.stopReason = ralphDecision.reason;
          appendSystemMsg(`Ralph Loop stopped: ${ralphDecision.reason}.`, run);
          break;
        }
        ralphRun.iteration++;
        appendRalphContinuationMessage({ ralphRun, lastAssistantText: fullText });
        renderRalphButton();
        updateMemoryUI();
        setStatus('running', `Ralph ${ralphRun.iteration}/${ralphRun.unlimited ? '∞' : ralphRun.maxIterations}`, run);
        scrollBottom(false, run);
        continue;
      }
      if (run?.pendingGuidance?.length) continue;
      break;
    }
  } catch (e) {
    if (run) activateConversationRun(run);
    if (e.name === 'AbortError') stoppedBy = 'abort';
    else { stoppedBy = 'error'; appendErrorBubble(`Error: ${e.message}`, { userText, promptIndex, promptEntryId, tokenBase, loopBase }, run); }
  }
  finally {
    if (run) activateConversationRun(run);
    const ralphSummary = ralphRun?.active ? { active: true, iteration: ralphRun.iteration, unlimited: ralphRun.unlimited, maxIterations: ralphRun.maxIterations, completionMarker: ralphRun.completionMarker, stopReason: ralphRun.stopReason || (stoppedBy === 'abort' ? 'abort' : 'done') } : undefined;
    ralphRun = null;
    if (swarmRunActive) endSwarmRun();
    isGenerating = false; abortCtrl = null;
    if (run) {
      run.active = false;
      run.finishedAt = Date.now();
      run.statusType = 'ready';
      run.statusText = stoppedBy === 'abort' ? 'Stopped' : t('status.ready');
      snapshotConversationRunState(run);
      if (!run.deleted) await saveConversationState(run.convId, run.state, { andRenderList: true });
      if (!run.deleted && stoppedBy !== 'abort') notifyTaskFinished({ convId: run.convId, kind: 'chat', outcome: stoppedBy === 'error' ? 'error' : 'done' });
      // Only unregister if we're still the registered run: a new run may have been
      // started for this same conversation during the await above (run.active was
      // already false, so isConversationRunning let a fresh submit through). Deleting
      // unconditionally would orphan that live run — unstoppable and duplicable.
      if (conversationRuns.get(run.convId) === run) conversationRuns.delete(run.convId);
      if (visibleConvId === run.convId) {
        applyConversationState(run.state);
        activeConvId = run.convId;
        visibleConversationState = run.state;
      }
      currentRunContext = null;
      if (visibleConvId && visibleConvId !== run.convId) ensureVisibleConversationStateActive();
    } else {
      saveCurrentConv(true);
    }
    syncLegacyRunFlags(); updateButtons();
    // An auto-compaction during this turn compacted in place, because the
    // model needed a smaller context to continue. Now that nothing is running,
    // the fork it queued can happen (creel-7xu).
    try { if (typeof forkAfterRunIfPending === 'function') forkAfterRunIfPending(); }
    catch (e) { console.warn('compaction fork failed', e); }
    const visibleRun = getActiveConversationRun();
    setStatus(visibleRun?.active ? 'running' : 'ready', visibleRun?.active ? (visibleRun.statusText || t('status.streaming')) : t('status.ready'));
    renderRalphButton(); updateMemoryUI();
    try { await runHooks('on_stop', { loopCount, totalTokens, stoppedBy, ralph: ralphSummary }); } catch {}
  }
}

