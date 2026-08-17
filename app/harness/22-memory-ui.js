/* creel harness — part 22 of 26: memory-ui
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
 *   - MEMORY SYSTEM
 *   - MESSAGE CONSTRUCTION (multi-provider)
 */
// ═══════════════════════════════════════════════════════════════════
// MEMORY SYSTEM
// ═══════════════════════════════════════════════════════════════════
function formatTokenCount(n) {
  const value = Math.max(0, Number(n) || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}
function extractTokenDetailCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (!value || typeof value !== 'object') return 0;
  let total = 0;
  for (const v of Object.values(value)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) total += v;
    else if (v && typeof v === 'object') total += extractTokenDetailCount(v);
  }
  return total;
}
function extractUsageTotal(usage, options = {}) {
  if (!usage || typeof usage !== 'object') return 0;
  const cacheTokens = (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0);
  const deepSeekCacheTokens = (Number(usage.prompt_cache_hit_tokens) || 0) + (Number(usage.prompt_cache_miss_tokens) || 0);
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? deepSeekCacheTokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
  const promptDetailTokens = extractTokenDetailCount(usage.prompt_tokens_details) + extractTokenDetailCount(usage.input_tokens_details);
  const completionDetailTokens = extractTokenDetailCount(usage.completion_tokens_details) + extractTokenDetailCount(usage.output_tokens_details);
  const reasoningTokens = Math.max(
    Number(usage.reasoning_tokens) || 0,
    Number(usage.completion_tokens_details?.reasoning_tokens) || 0,
    Number(usage.output_tokens_details?.reasoning_tokens) || 0,
    Number(usage.completion_tokens_details?.reasoningTokens) || 0,
    Number(usage.output_tokens_details?.reasoningTokens) || 0
  );
  const providerTotal = Math.max(
    Number(usage.total_tokens) || 0,
    Number(usage.totalTokens) || 0,
    Number(usage.total_token_count) || 0,
    Number(usage.totalTokenCount) || 0
  );
  const inputTotal = Math.max(promptTokens + cacheTokens, promptDetailTokens, deepSeekCacheTokens);
  const outputTotal = Math.max(completionTokens, completionDetailTokens, options.includeReasoningDetails ? reasoningTokens : 0);
  return Math.max(providerTotal, inputTotal + outputTotal);
}
function estimateTokenCountFromText(text) {
  text = String(text || '');
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const ascii = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '');
  return Math.ceil(cjk * 1.35 + ascii.length / 4);
}
function estimateOpenAIRequestTokens(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let total = 0;
  for (const msg of body.messages) {
    total += 4 + estimateTokenCountFromText(msg.role || '');
    if (typeof msg.content === 'string') total += estimateTokenCountFromText(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'text') total += estimateTokenCountFromText(block.text || '');
        else if (block?.type === 'image_url' || block?.type === 'image') total += 255;
        else total += estimateTokenCountFromText(JSON.stringify(block || {}));
      }
    }
    if (msg.reasoning_content) total += estimateTokenCountFromText(msg.reasoning_content);
    if (Array.isArray(msg.tool_calls)) total += estimateTokenCountFromText(JSON.stringify(msg.tool_calls));
  }
  if (Array.isArray(body.tools)) total += estimateTokenCountFromText(JSON.stringify(body.tools));
  return total;
}
function estimateAnyTokenCount(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return estimateTokenCountFromText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return estimateTokenCountFromText(String(value));
  try { return estimateTokenCountFromText(JSON.stringify(value)); } catch { return 0; }
}
function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokenCountFromText(content);
  if (!Array.isArray(content)) return estimateAnyTokenCount(content);
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') total += estimateAnyTokenCount(block);
    else if (block.type === 'text') total += estimateTokenCountFromText(block.text || '');
    else if (block.type === 'tool_result') total += estimateTokenCountFromText(typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')) + 24;
    else if (block.type === 'tool_use') total += estimateAnyTokenCount(block.input) + estimateTokenCountFromText(block.name || '') + 24;
    else if (block.type === 'image' || block.type === 'image_url') total += 255;
    else if (block.type === 'reasoning') total += estimateTokenCountFromText(block.reasoning_content || block.text || '');
    else total += estimateAnyTokenCount(block);
  }
  return total;
}
function estimateMessageTokens(message) {
  if (!message) return 0;
  let total = 4 + estimateTokenCountFromText(message.role || '');
  total += estimateContentTokens(message.content);
  if (message.reasoning_content) total += estimateTokenCountFromText(message.reasoning_content);
  if (Array.isArray(message.tool_calls)) total += estimateAnyTokenCount(message.tool_calls);
  return total;
}
function estimateSessionEntryTokens(entry) {
  if (!entry) return 0;
  if (entry.type === 'tool_result') return estimateContentTokens(entry.content) + 8;
  return estimateMessageTokens(projectEntryToMessage(entry));
}
function estimateRequestBodyTokens(body) {
  if (!body || typeof body !== 'object') return 0;
  if (PROVIDER === 'anthropic_compat') {
    let total = estimateTokenCountFromText(body.system || '');
    if (Array.isArray(body.messages)) total += body.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    if (Array.isArray(body.tools)) total += estimateAnyTokenCount(body.tools);
    if (body.thinking) total += estimateAnyTokenCount(body.thinking);
    return total;
  }
  let total = estimateOpenAIRequestTokens(body);
  if (body.reasoning || body.reasoning_effort) total += estimateAnyTokenCount({ reasoning: body.reasoning, reasoning_effort: body.reasoning_effort });
  return total;
}
function extractUsageDetails(usage, options = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const cacheRead = Math.max(Number(usage.cache_read_input_tokens) || 0, Number(usage.prompt_cache_hit_tokens) || 0);
  const cacheWrite = Math.max(Number(usage.cache_creation_input_tokens) || 0, Number(usage.prompt_cache_miss_tokens) || 0);
  const basePromptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
  const promptTokens = Math.max(
    basePromptTokens + cacheRead + cacheWrite,
    extractTokenDetailCount(usage.prompt_tokens_details) + extractTokenDetailCount(usage.input_tokens_details),
    cacheRead + cacheWrite
  );
  const reasoningTokens = Math.max(
    Number(usage.reasoning_tokens) || 0,
    Number(usage.completion_tokens_details?.reasoning_tokens) || 0,
    Number(usage.output_tokens_details?.reasoning_tokens) || 0,
    Number(usage.completion_tokens_details?.reasoningTokens) || 0,
    Number(usage.output_tokens_details?.reasoningTokens) || 0
  );
  const outputTokens = Math.max(
    Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0) || 0,
    extractTokenDetailCount(usage.completion_tokens_details) + extractTokenDetailCount(usage.output_tokens_details),
    options.includeReasoningDetails ? reasoningTokens : 0
  );
  const total = Math.max(Number(usage.total_tokens) || 0, Number(usage.totalTokens) || 0, Number(usage.total_token_count) || 0, Number(usage.totalTokenCount) || 0, promptTokens + outputTokens);
  return { input: promptTokens, output: outputTokens, cacheRead, cacheWrite, reasoning: reasoningTokens, total };
}
function getContextOutputReserveTokens() {
  const thinkingBudget = PROVIDER === 'anthropic_compat' && THINK_LEVEL !== 'auto' ? (ANTHROPIC_THINK_BUDGET[THINK_LEVEL] || 0) : 0;
  const configured = PROVIDER === 'anthropic_compat' ? ANTHROPIC_MAX_TOKENS : 8192;
  return Math.max(1024, Math.min(currentMaxContextTokens * 0.25, configured + thinkingBudget));
}
function getEffectiveContextWindowTokens() {
  const limit = Math.max(1, Number(currentMaxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS);
  return Math.max(1, limit - getContextOutputReserveTokens());
}
function truncateMiddleText(text, maxChars = 1800) {
  text = String(text || '');
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.55);
  const tail = Math.max(0, maxChars - head - 80);
  return `${text.slice(0, head)}\n\n[... ${text.length - head - tail} chars compacted ...]\n\n${text.slice(-tail)}`;
}
function compactLargeToolResultContent(content, metadata = {}) {
  const text = typeof content === 'string' ? content : JSON.stringify(content || '');
  const before = estimateTokenCountFromText(text);
  const compacted = truncateMiddleText(text, metadata.maxChars || 1800);
  return `[Tool output compacted]\nOriginal size: ~${formatTokenCount(before)} tokens\n${compacted}`;
}
function microCompactProjectedMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return [];
  const protect = Number.isFinite(options.protectRecent) ? options.protectRecent : CONTEXT_RECENT_MESSAGE_PROTECT_COUNT;
  const minAgeFromEnd = Number.isFinite(options.minAgeFromEnd) ? options.minAgeFromEnd : Math.max(protect, CONTEXT_RECENT_MESSAGE_PROTECT_COUNT + 4);
  const minTokens = Number.isFinite(options.minTokens) ? options.minTokens : CONTEXT_MICRO_COMPACT_MIN_TOKENS;
  const maxChars = options.maxChars || 1800;
  return messages.map((message, index) => {
    const ageFromEnd = messages.length - index - 1;
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const content = message.content.map(block => {
      if (block?.type !== 'tool_result') return block;
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
      if (text.startsWith('[Tool output compacted]')) return block;
      // Once a tool_result has been compacted, keep it compacted forever — even if
      // ageFromEnd would now say "leave it raw". This prevents the byte sequence of
      // historical messages from shifting as the conversation grows, which is required
      // for messages-level prompt cache stability.
      const alreadyCompacted = block.tool_use_id && compactedToolUseIds.has(block.tool_use_id);
      if (!alreadyCompacted) {
        if (ageFromEnd < minAgeFromEnd) return block;
        const tokens = estimateTokenCountFromText(text);
        if (tokens < minTokens && !/^data:/i.test(text) && !/^[A-Za-z0-9+/=]{4000,}$/.test(text.slice(0, 5000))) return block;
      }
      const cacheKey = `${block.tool_use_id || ''}:${stableStringHash(text)}:${maxChars}`;
      let compacted = microCompactCache.get(cacheKey);
      if (!compacted) compacted = rememberBoundedMapValue(microCompactCache, cacheKey, compactLargeToolResultContent(block.content, { maxChars }), 200);
      if (block.tool_use_id) compactedToolUseIds.add(block.tool_use_id);
      changed = true;
      return { ...block, content: compacted };
    });
    return changed ? { ...message, content } : message;
  });
}
function normalizeProjectedMessages(messages, provider = PROVIDER, options = {}) {
  const normalized = [];
  const seenToolCalls = new Set();
  for (const original of microCompactProjectedMessages(messages || [], options.microCompact || {})) {
    if (!original || !original.role) continue;
    const message = { ...original };
    if (Array.isArray(message.content)) {
      const blocks = [];
      for (const block of message.content) {
        if (!block) continue;
        if (block.type === 'tool_use') {
          if (block.id) seenToolCalls.add(block.id);
          blocks.push(block);
        } else if (block.type === 'tool_result') {
          if (!block.tool_use_id || !seenToolCalls.has(block.tool_use_id)) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            blocks.push({ type: 'text', text: `[Orphan tool result omitted from structured tool history]\n${truncateMiddleText(text, 1200)}` });
          } else blocks.push(block);
        } else if ((block.type === 'image' || block.type === 'image_url') && provider !== 'anthropic_compat' && provider !== 'openai_compat' && provider !== 'openai') {
          blocks.push({ type: 'text', text: '[Image attachment omitted: provider may not support image input]' });
        } else blocks.push(block);
      }
      message.content = blocks;
      if (!blocks.length) continue;
    } else if (message.content == null || String(message.content).length === 0) continue;
    normalized.push(message);
  }
  return normalized;
}
async function collectRequestContextParts(messages = buildConversationFromEntries(), headId = activeEntryId, options = {}) {
  const run = options.run || currentRunContext || null;
  const projectedMessagesBase = normalizeProjectedMessages(messages, PROVIDER, { microCompact: options.microCompact || {} });
  const contextEditor = document.getElementById('contextEditor')?.value || '';
  const activeSkillMetadata = getActiveSkillMetadataPrompts();
  const triggeredSkillPrompts = getTriggeredSkillPrompts(headId);
  const projectedMessages = projectedMessagesBase;
  const beijingTimePrompt = getBeijingTimePrompt();
  const mediaToolPrompt = getMediaToolPrompt();
  const pyodideNativePrompt = getPyodideNativeToolPrompt();
  const planPrompt = planMode ? '\n\n[PLAN MODE ACTIVE]\nYou must not execute write-class tools (Write, Edit, Bash, PythonExec, VfsToPyodide, PyodideToVfs, JSExec, NodeExec, MCP tools, or SkillManager write actions). You may use read-only tools (Read, Glob, Grep, WebSearch, Fetch), SkillManager list/inspect, and TodoWrite to investigate. When your plan is complete, call the ExitPlanMode tool with the full plan as Markdown and wait for the user\'s approval. Do not proceed with execution until ExitPlanMode returns an approval message.' : '';
  const ralphPrompt = getRalphLoopPrompt();
  const sandboxPrompt = isRemoteSandbox() ? '\n\n[REMOTE SANDBOX]\nA real Linux container (Daytona) is attached. Your execution surface in this mode:\n- **Bash** is the ONLY code-execution tool. Run interpreters from the shell: `python3 script.py`, `python3 -c "..."`, `node script.js`, `pip install ...`, `npm install ...`. Pip/npm installs and /home/daytona changes persist across Bash calls within this conversation.\n- **Read / Write / Edit** target the Daytona filesystem first. You may pass either VFS-style `/foo/bar.py` or sandbox absolute `/home/daytona/foo/bar.py`; both refer to `/home/daytona/foo/bar.py`. Do not build paths like `/home/daytona/home/daytona/...`. Successful reads/writes/edits update the browser VFS shadow at `/foo/bar.py`.\n- **Glob / Grep** search the browser VFS shadow. Use Bash for live sandbox `find`/`grep` when you need the current container filesystem.\n- Before every Bash call, the VFS shadow is uploaded to /home/daytona so files are available in the sandbox. After Bash returns, files already mirrored from VFS are reconciled in both directions; new sandbox files are imported only from /home/daytona/outputs, while other new sandbox files stay remote. In Bash, write final result files, reports, exports, generated media, and artifacts under /home/daytona/outputs (or relative outputs/ from cwd) so the user can inspect or download them.\n- **PythonExec / JSExec / NodeExec / VfsToPyodide / PyodideToVfs are DISABLED.** Do not mention them in tool lists or attempt to call them — they are intentionally hidden because the sandbox is a full Linux container and Bash covers every case.\n- cwd for Bash defaults to /home/daytona. Do NOT pass cwd=/workspace — that directory does not exist in the Daytona default snapshot and the daemon will silently return exit -1 with an empty body.\nWhen the user asks "what tools do you have", list ONLY the tools that are actually exposed in this request — do not enumerate disabled tools.' : '';
  const memPrompt = await getCachedMemRecallForPrompt(projectedMessagesBase, { readOnly: !!options.readOnlyMemory, memoryRecallKey: options.memoryRecallKey });
  if (run) activateConversationRun(run);
  rebuildToolDefs(headId, { skipRender: !!options.skipToolRender });
  const anthropicTools = getEnabledToolsAnthropic();
  const openaiTools = getEnabledToolsOpenAI();
  const stableSystemPrompt = contextEditor;
  const volatileSystemPrompt = activeSkillMetadata + triggeredSkillPrompts + mediaToolPrompt + pyodideNativePrompt + planPrompt + ralphPrompt + sandboxPrompt + memPrompt + beijingTimePrompt;
  const systemPrompt = stableSystemPrompt + volatileSystemPrompt;
  return { projectedMessages, contextEditor, activeSkillMetadata, triggeredSkillPrompts, mediaToolPrompt, pyodideNativePrompt, planPrompt, ralphPrompt, sandboxPrompt, memPrompt, beijingTimePrompt, stableSystemPrompt, volatileSystemPrompt, systemPrompt, anthropicTools, openaiTools, headId };
}
function buildAnthropicSystemForCache(parts) {
  const blocks = [];
  const stable = parts.stableSystemPrompt || '';
  const volatile = parts.volatileSystemPrompt || '';
  if (stable) {
    const block = { type: 'text', text: stable };
    if (ANTHROPIC_PROMPT_CACHE_ENABLED) block.cache_control = { ...ANTHROPIC_PROMPT_CACHE_CONTROL };
    blocks.push(block);
  }
  if (volatile) blocks.push({ type: 'text', text: volatile });
  return blocks.length ? blocks : '';
}
function stripCacheControlDeep(value) {
  if (Array.isArray(value)) return value.map(stripCacheControlDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'cache_control') out[k] = stripCacheControlDeep(v);
    return out;
  }
  return value;
}
function downgradeAnthropicCompatBody(body) {
  const clone = stripCacheControlDeep(body);
  if (Array.isArray(clone.system)) clone.system = clone.system.map(block => typeof block === 'string' ? block : (block?.text || '')).filter(Boolean).join('');
  return clone;
}
function looksLikeCacheControlCompatError(status, text) {
  const s = String(text || '').toLowerCase();
  return status === 400 && (s.includes('cache_control') || s.includes('cache control') || (s.includes('system') && (s.includes('array') || s.includes('text block') || s.includes('object'))));
}
function applyAnthropicMessagesCacheBreakpoint(messages) {
  // Place one cache_control breakpoint on the final content block of the second-to-last
  // message. The combined effect with the stable-system-prompt breakpoint: on every new
  // user turn, tools + system + all prior assistant/user messages are cached, and only
  // the freshly added last message and the assistant's pending output are uncached.
  // If the server doesn't honor cache_control on messages, downgradeAnthropicCompatBody
  // strips it on retry.
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const targetIdx = messages.length - 2;
  return messages.map((m, i) => {
    if (i !== targetIdx) return m;
    let content = m.content;
    if (typeof content === 'string') content = [{ type: 'text', text: content }];
    if (!Array.isArray(content) || !content.length) return m;
    const last = content[content.length - 1];
    if (!last || typeof last !== 'object') return m;
    const newLast = { ...last, cache_control: { ...ANTHROPIC_PROMPT_CACHE_CONTROL } };
    return { ...m, content: [...content.slice(0, -1), newLast] };
  });
}
/* creel: strict OpenAI-compatible providers (DeepSeek among them) reject the
 * whole request unless every assistant `tool_calls` entry is immediately
 * followed by a `tool` message per id. Interrupted runs (stopped generations,
 * page reloads mid-tool, guidance injections) leave orphans that brick the
 * conversation with a permanent 400. Rebuild the pairing: results are moved
 * to sit directly after their call, missing results get a synthetic
 * "[interrupted]" stub, and results whose call vanished become user context. */
function sanitizeOpenAIToolPairs(messages) {
  const toolById = new Map();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id && !toolById.has(m.tool_call_id)) toolById.set(m.tool_call_id, m);
  }
  const used = new Set();
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.tool_call_id && used.has(m.tool_call_id)) continue;   // re-homed below its call
      out.push({ role: 'user', content: `[Earlier tool result]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}` });
      continue;
    }
    out.push(m);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        const r = toolById.get(tc.id);
        if (r && !used.has(tc.id)) { out.push(r); used.add(tc.id); }
        else if (!r) out.push({ role: 'tool', tool_call_id: tc.id, content: '[tool call was interrupted before a result was recorded]' });
      }
    }
  }
  return out;
}
function assembleRequestBodyFromParts(parts, options = {}) {
  const requestModel = String(options.model || API_MODEL || '').trim() || API_MODEL;
  if (PROVIDER === 'anthropic_compat') {
    const messages = parts.projectedMessages.map(m => m.role === 'user' ? { ...m, content: buildAnthropicUserContent(m.content) } : m);
    const body = {
      model: requestModel,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: buildAnthropicSystemForCache(parts),
      messages: ANTHROPIC_PROMPT_CACHE_ENABLED ? applyAnthropicMessagesCacheBreakpoint(messages) : messages,
      tools: parts.anthropicTools
    };
    return applyThinkingToRequestBody(body, 'anthropic');
  }
  const oai = [{ role: 'system', content: parts.systemPrompt }];
  const keepReasoning = shouldKeepReasoningForModel(requestModel);
  for (const m of parts.projectedMessages) {
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        const userContent = buildOpenAIUserContent(m.content);
        for (const b of m.content) {
          if (b.type === 'tool_result') {
            oai.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
          }
        }
        if (userContent) oai.push({ role: 'user', content: userContent });
      } else oai.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.content)) {
        let t = '', reasoning = '';
        const tc = [];
        for (const b of m.content) {
          if (b.type === 'text') t += b.text;
          else if (keepReasoning && b.type === 'reasoning') reasoning += b.reasoning_content || b.text || '';
          else if (b.type === 'tool_use') tc.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } });
        }
        if (keepReasoning && !reasoning && !tc.length) {
          if (t.trim()) oai.push({ role: 'user', content: `[Previous assistant response]\n${t}` });
          continue;
        }
        const msg = { role: 'assistant' };
        if (t) msg.content = t;
        if (reasoning) msg.reasoning_content = reasoning;
        if (tc.length) msg.tool_calls = tc;
        if (!t && !tc.length) msg.content = '';
        oai.push(msg);
      } else if (keepReasoning) {
        const text = String(m.content || '').trim();
        if (text) oai.push({ role: 'user', content: `[Previous assistant response]\n${text}` });
      } else oai.push({ role: 'assistant', content: m.content });
    }
  }
  return applyThinkingToRequestBody({ model: requestModel, messages: sanitizeOpenAIToolPairs(oai), tools: parts.openaiTools }, PROVIDER);
}
function estimateContextPartTokens(parts, body) {
  const breakdown = {
    stableSystem: estimateTokenCountFromText(parts.stableSystemPrompt || ''),
    volatileSystem: estimateTokenCountFromText(parts.volatileSystemPrompt || ''),
    messages: (parts.projectedMessages || []).reduce((sum, msg) => sum + estimateMessageTokens(msg), 0),
    tools: estimateAnyTokenCount(PROVIDER === 'anthropic_compat' ? parts.anthropicTools : parts.openaiTools)
  };
  const totalFromParts = Object.values(breakdown).reduce((sum, n) => sum + n, 0);
  const totalFromBody = estimateRequestBodyTokens(body);
  breakdown.other = Math.max(0, totalFromBody - totalFromParts);
  return { breakdown, total: Math.max(totalFromBody, totalFromParts) };
}
async function buildContextSnapshot(messages = buildConversationFromEntries(), headId = activeEntryId, options = {}) {
  const run = options.run || currentRunContext || null;
  const parts = await collectRequestContextParts(messages, headId, { readOnlyMemory: true, skipToolRender: true, memoryRecallKey: options.memoryRecallKey, run });
  if (run) activateConversationRun(run);
  const body = assembleRequestBodyFromParts(parts);
  const estimated = estimateContextPartTokens(parts, body);
  const maxContextTokens = Math.max(1, Number(currentMaxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS);
  const outputReserveTokens = getContextOutputReserveTokens();
  const effectiveContextTokens = Math.max(1, maxContextTokens - outputReserveTokens);
  const totalEstimatedTokens = estimated.total;
  const fillRatio = totalEstimatedTokens / effectiveContextTokens;
  const state = fillRatio >= CONTEXT_CRITICAL_RATIO ? 'critical' : fillRatio >= CONTEXT_AUTO_COMPACT_RATIO ? 'auto' : fillRatio >= CONTEXT_WARNING_RATIO ? 'warning' : 'ok';
  return { body, parts, breakdown: estimated.breakdown, totalEstimatedTokens, projectedMessageCount: parts.projectedMessages.length, maxContextTokens, outputReserveTokens, effectiveContextTokens, fillRatio, state, provider: PROVIDER, model: API_MODEL, lastUsageInfo, lastInputTokens, lastOutputTokens, lastCacheReadTokens, lastCacheWriteTokens, totalTokens, lastTurnTokens };
}
function applyContextSnapshot(snapshot) {
  if (!snapshot) return;
  lastRequestContextSnapshot = snapshot;
  lastContextBreakdown = snapshot.breakdown || null;
  contextTokens = Math.max(0, Number(snapshot.totalEstimatedTokens) || 0);
  if (currentRunContext) snapshotConversationRunState(currentRunContext);
}
function scheduleContextSnapshotRefresh() {
  if (_contextUiRefreshTimer) return;
  _contextUiRefreshTimer = setTimeout(async () => {
    _contextUiRefreshTimer = null;
    const seq = ++_contextSnapshotSeq;
    try {
      const snapshot = await buildContextSnapshot();
      if (seq === _contextSnapshotSeq) {
        applyContextSnapshot(snapshot);
        renderContextSnapshotUI(snapshot);
      }
    } catch (e) { console.warn('context snapshot failed', e); }
  }, 120);
}
function renderContextSnapshotUI(snapshot = lastRequestContextSnapshot) {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const mc = snapshot?.projectedMessageCount ?? conversation.length;
  const currentContext = Math.max(0, Number(snapshot?.totalEstimatedTokens ?? contextTokens) || 0);
  const limit = Math.max(1, Number(snapshot?.effectiveContextTokens ?? currentMaxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS);
  const rawLimit = Math.max(1, Number(snapshot?.maxContextTokens ?? currentMaxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS);
  const pct = Math.min(100, (currentContext / limit) * 100);
  const msgEl = document.getElementById('memMsgCount');
  const tokenEl = document.getElementById('memTokenCount');
  const fillEl = document.getElementById('memoryFill');
  if (msgEl) msgEl.textContent = mc;
  if (tokenEl) tokenEl.textContent = `${formatTokenCount(currentContext)}/${formatTokenCount(rawLimit)}`;
  if (fillEl) fillEl.style.width = pct + '%';
  const loopEl = document.getElementById('loopBadge');
  const tokenBadge = document.getElementById('tokenBadge');
  if (loopEl) loopEl.textContent = ralphRun?.active ? `${t('badge.loop')}: ${loopCount} · Ralph: ${ralphRun.iteration}/${ralphRun.unlimited ? '∞' : ralphRun.maxIterations}` : `${t('badge.loop')}: ${loopCount}`;
  if (tokenBadge) tokenBadge.textContent = `Context: ${pct.toFixed(0)}% · Session: ${formatTokenCount(totalTokens)}`;
  renderContextBreakdown(snapshot);
}
function updateMemoryUI() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  renderContextSnapshotUI(lastRequestContextSnapshot);
  scheduleContextSnapshotRefresh();
}
function renderContextBreakdown(snapshot = lastRequestContextSnapshot) {
  const el = document.getElementById('memoryLog');
  if (!el || !snapshot) return;
  const b = snapshot.breakdown || {};
  const pct = Math.min(999, Math.max(0, snapshot.fillRatio * 100));
  const summary = `Context: ${pct.toFixed(0)}% · ${formatTokenCount(snapshot.totalEstimatedTokens)} / ${formatTokenCount(snapshot.maxContextTokens)}`;
  const detailLines = [
    `Messages: ${formatTokenCount(b.messages)} · Stable system: ${formatTokenCount(b.stableSystem)} · Volatile system: ${formatTokenCount(b.volatileSystem)}`,
    `Tools: ${formatTokenCount(b.tools)} · Other: ${formatTokenCount(b.other)}`,
    `Session: ${formatTokenCount(totalTokens)} · Last turn: ${formatTokenCount(lastTurnTokens)}`
  ];
  let box = el.querySelector('[data-context-breakdown]');
  if (!box) {
    box = document.createElement('div');
    box.className = 'mem-entry read';
    box.dataset.contextBreakdown = '1';
    box.title = 'Click to expand/collapse context details';
    box.style.cursor = 'pointer';
    box.onclick = () => {
      contextBreakdownExpanded = !contextBreakdownExpanded;
      renderContextBreakdown(lastRequestContextSnapshot);
    };
    el.prepend(box);
  }
  box.textContent = contextBreakdownExpanded ? `${summary}\n${detailLines.join('\n')}` : `${summary}  ▸`;
}

function logMemEntry(type, text, run) {
  const ctx = run || currentRunContext;
  if (ctx && !isRunVisible(ctx)) return;
  const el = document.getElementById('memoryLog');
  const d = document.createElement('div');
  d.className = `mem-entry ${type}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
  renderContextBreakdown();
}

function isContextLengthError(status, text, error) {
  const haystack = `${status || ''} ${text || ''} ${error?.message || error || ''}`.toLowerCase();
  return /context_length|context length|prompt too long|maximum context|context window|token limit|too many tokens|max.*tokens|input.*too long/.test(haystack);
}

async function checkAndCompact() {
  const run = currentRunContext;
  const snapshot = await buildContextSnapshot(undefined, undefined, { run });
  if (run) activateConversationRun(run);
  applyContextSnapshot(snapshot);
  renderContextSnapshotUI(snapshot);
  if (snapshot.fillRatio >= CONTEXT_AUTO_COMPACT_RATIO) {
    appendSystemMsg(`Context approaching limit (${Math.round(snapshot.fillRatio * 100)}%). Auto-compacting...`, run);
    await compactMemory({ trigger: 'auto', snapshot });
    if (run) activateConversationRun(run);
  } else if (snapshot.fillRatio >= CONTEXT_WARNING_RATIO) {
    logMemEntry(snapshot.fillRatio >= CONTEXT_CRITICAL_RATIO ? 'compact' : 'read', `Context ${Math.round(snapshot.fillRatio * 100)}% full; output reserve ${formatTokenCount(snapshot.outputReserveTokens)}`);
  }
  updateMemoryUI();
}

function selectRecentEntriesByTokenBudget(entries, budgetTokens) {
  const selected = new Set();
  const toolCallToEntry = new Map();
  const toolResultToEntry = new Map();
  for (const entry of entries) {
    const content = entry.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && block.id) toolCallToEntry.set(block.id, entry);
      if (block?.type === 'tool_result' && block.tool_use_id) toolResultToEntry.set(block.tool_use_id, entry);
    }
  }
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const cost = Math.max(1, estimateSessionEntryTokens(entry));
    if (selected.size && used + cost > budgetTokens) break;
    selected.add(entry);
    used += cost;
    const blocks = Array.isArray(entry.content) ? entry.content : [];
    for (const block of blocks) {
      const pair = block?.type === 'tool_result' ? toolCallToEntry.get(block.tool_use_id) : block?.type === 'tool_use' ? toolResultToEntry.get(block.id) : null;
      if (pair && !selected.has(pair)) {
        selected.add(pair);
        used += Math.max(1, estimateSessionEntryTokens(pair));
      }
    }
  }
  return { keptEntries: entries.filter(entry => selected.has(entry)), usedTokens: used };
}

async function compactMemory(options = {}) {
  const run = currentRunContext;
  rebuildConversation();
  if (conversation.length <= 6 || !activeEntryId || !sessionEntries.length) return;
  logMemEntry('compact', 'Compacting via LLM...');
  appendSystemMsg('Summarizing conversation history via LLM...', run);
  const chain = getEntryChain(activeEntryId);
  const messageEntries = chain.filter(entry => entry.type === 'message' || entry.type === 'tool_result');
  const keepBudget = Math.max(2000, Math.min(20000, Math.floor((currentMaxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS) * 0.25)));
  const { keptEntries } = selectRecentEntriesByTokenBudget(messageEntries, keepBudget);
  if (messageEntries.length <= keptEntries.length + 1) return;
  const keptSet = new Set(keptEntries);
  const firstKeptEntryId = keptEntries[0]?.id;
  const toCompactEntries = messageEntries.filter(entry => entry.id !== firstKeptEntryId && !keptSet.has(entry));
  const toCompact = toCompactEntries.map(entry => entry.type === 'message' ? { role: entry.role, content: entry.content } : { role: 'user', content: entry.content });
  const summaryMessages = toCompact.map(m => {
    const role = m.role;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) {
      content = m.content.map(b => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return `[Tool: ${b.name}]`;
        if (b.type === 'tool_result') return `[Result: ${(typeof b.content === 'string' ? b.content : '').slice(0, 200)}]`;
        return '[data]';
      }).join('\n');
    } else content = '[data]';
    return `[${role}] ${content}`;
  }).join('\n\n');

  const systemPrompt = document.getElementById('contextEditor').value;
  let summaryBody;
  if (PROVIDER === 'anthropic_compat') {
    summaryBody = { model: API_MODEL, max_tokens: ANTHROPIC_SUMMARY_MAX_TOKENS, system: 'You are a conversation summarizer. Produce a concise summary of the conversation below, preserving key decisions, code changes, file operations, and important context. Output ONLY the summary, no preamble.', messages: [{ role: 'user', content: `Summarize this conversation:\n\n${summaryMessages}` }] };
  } else {
    summaryBody = { model: API_MODEL, messages: [{ role: 'system', content: 'You are a conversation summarizer. Produce a concise summary preserving key decisions, code changes, file operations, and important context. Output ONLY the summary.' }, { role: 'user', content: `Summarize this conversation:\n\n${summaryMessages}` }] };
  }

  let summary;
  try {
    summaryBody.stream = false;
    const resp = await fetchWithRetry(getLLMUrl(), { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(summaryBody) });
    if (run) activateConversationRun(run);
    if (resp.ok) {
      const data = await resp.json();
      if (run) activateConversationRun(run);
      totalTokens += extractUsageTotal(data.usage);
      if (PROVIDER === 'anthropic_compat') summary = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      else summary = data.choices?.[0]?.message?.content || '';
    }
  } catch (e) { console.warn('LLM compact failed:', e); }

  if (!summary) {
    summary = toCompact.map(m => { const r = m.role; const c = typeof m.content === 'string' ? m.content.substring(0, 100) : '[tool data]'; return `[${r}] ${c}`; }).join('\n');
    logMemEntry('compact', 'LLM summary failed, using simple truncation');
  } else {
    logMemEntry('compact', 'LLM summary generated');
  }

  appendSessionEntry('compaction', {
    summary,
    firstKeptEntryId,
    tokensBefore: options.snapshot?.totalEstimatedTokens ?? contextTokens,
    trigger: options.trigger || 'manual',
    retainedEntryCount: keptEntries.length,
    compactedEntryCount: toCompact.length
  });
  rebuildConversation();
  if (run) snapshotConversationRunState(run);
  const afterSnapshot = await buildContextSnapshot(undefined, undefined, { run });
  if (run) activateConversationRun(run);
  applyContextSnapshot(afterSnapshot);
  logMemEntry('compact', `Compacted ${toCompact.length} messages → summary; kept ${keptEntries.length}`);
  appendSystemMsg(`Compacted ${toCompact.length} messages.`, run);
  updateMemoryUI();
}

function flashTool(name, run = currentRunContext) {
  if (run && !isRunVisible(run)) return;
  const c = [...document.querySelectorAll('.tg-card[data-tool]')].find(card => card.dataset.tool === name);
  if (!c) return;
  clearTimeout(c._flashTimer);
  c.classList.add('active');
  c._flashTimer = setTimeout(() => { c.classList.remove('active'); c._flashTimer = null; }, 1200);
}

// ═══════════════════════════════════════════════════════════════════
// MESSAGE CONSTRUCTION (multi-provider)
// ═══════════════════════════════════════════════════════════════════
function getBeijingTimePrompt() {
  const now = new Date();
  const bjStr = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  });
  return `\n\n[CURRENT TIME]\n当前北京时间 (UTC+8): ${bjStr}`;
}

function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return '';
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
function getMimeTypeForPath(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  return {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  }[ext] || '';
}
function buildAnthropicUserContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const content = [];
  for (const block of value) {
    if (block.type === 'tool_result') content.push(block);
    else if (block.type === 'text' && typeof block.text === 'string' && block.text) content.push({ type: 'text', text: block.text });
    else if (block.type === 'image' && block.source?.data && block.source?.media_type) content.push(block);
  }
  return content.length ? content : '';
}
function buildOpenAIUserContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const content = [];
  for (const block of value) {
    if (block.type === 'tool_result') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) content.push({ type: 'text', text: block.text });
    else if (block.type === 'image' && block.source?.data && block.source?.media_type) {
      content.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
    }
  }
  return content.length ? content : '';
}
function getUserTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n').trim();
}
function getMediaToolPrompt() {
  const hasImage = hasConfiguredDefaultMediaModel('image');
  const hasVideo = hasConfiguredDefaultMediaModel('video');
  if (!hasImage && !hasVideo) return '';
  const parts = [];
  if (hasImage) parts.push('If the user asks to generate, draw, create, design, or edit an image, call GenerateImage in this normal chat turn.');
  if (hasVideo) parts.push('If the user asks to generate, create, animate, or edit a video, call GenerateVideo.');
  parts.push('Omit the model argument unless the user explicitly names one so the configured default image/video model is used. The tool prompt must be a complete generation prompt synthesized from the latest user request and relevant conversation history (style, subject, constraints, prior revisions), not just a verbatim copy of the last user message. Do not merely describe requested media when the matching generation tool is available.');
  return '\n\n[MEDIA GENERATION]\n' + parts.join(' ');
}
function getPyodideNativeToolPrompt() {
  if (!pyodideInstance) return '';
  return '\n\n[PYODIDE NATIVE FILES]\nPyodide is loaded. When a Python library needs a real native path under /tmp, use VfsToPyodide to copy VFS files into Pyodide native FS, run PythonExec against the /tmp path, then use PyodideToVfs to copy outputs back to VFS.';
}
function shouldAutoGenerateMedia(text) {
  text = String(text || '').toLowerCase();
  if (!text) return null;
  const imageWords = ['图片', '图像', '画一张', '生成一张', '生成图片', '生图', '绘制', '海报', '插画', '照片', 'image', 'picture', 'illustration', 'poster'];
  const videoWords = ['视频', '动画', '影片', '短片', 'video', 'animation'];
  const actionWords = ['生成', '创建', '制作', '画', '绘制', '设计', 'create', 'generate', 'draw', 'design', 'make'];
  const hasAction = actionWords.some(w => text.includes(w));
  if (hasAction && videoWords.some(w => text.includes(w)) && hasConfiguredDefaultMediaModel('video')) return 'video';
  if (hasAction && imageWords.some(w => text.includes(w)) && hasConfiguredDefaultMediaModel('image')) return 'image';
  return null;
}
function makeToolUseBlock(name, input) {
  return { type: 'tool_use', id: 'toolu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name, input, index: 0 };
}
function getRecentConversationTextForMediaPrompt(headId = activeEntryId, limit = 8) {
  const chain = getEntryChain(headId).filter(entry => entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'));
  const lines = [];
  for (const entry of chain.slice(-limit)) {
    const text = getUserTextFromContent(entry.content);
    if (!text) continue;
    lines.push(`${entry.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return lines.join('\n');
}
function buildContextualMediaPrompt(userText, kind, headId = activeEntryId) {
  const history = getRecentConversationTextForMediaPrompt(headId);
  const type = kind === 'video' ? 'video' : 'image';
  if (!history) return userText;
  return [
    `Create a ${type} based on the full conversation context below.`,
    '',
    'Relevant conversation:',
    history,
    '',
    'Latest user request:',
    userText,
    '',
    `Synthesize these into one complete ${type} generation prompt. Preserve all explicit visual requirements, style choices, subject details, constraints, and revisions from the conversation. Do not include meta commentary.`
  ].join('\n');
}
function cleanGeneratedMediaPrompt(text) {
  return String(text || '')
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^prompt\s*:\s*/i, '')
    .trim();
}
async function generateMediaPromptWithAI(userText, kind, headId = activeEntryId) {
  const run = currentRunContext; // pin the owning run so the abort signal can't drift to a concurrent conversation
  const fallback = buildContextualMediaPrompt(userText, kind, headId);
  const type = kind === 'video' ? 'video' : 'image';
  const history = getRecentConversationTextForMediaPrompt(headId) || '(none)';
  const system = `You are a ${type} prompt engineer. Write exactly one polished ${type} generation prompt using the latest user request and the relevant conversation history. Preserve concrete subject, style, layout, text, constraints, and revision details. Return only the prompt, with no explanation.`;
  const request = [
    'Relevant conversation:',
    history,
    '',
    'Latest user request:',
    userText,
    '',
    `Write the final ${type} generation prompt.`
  ].join('\n');
  try {
    const body = PROVIDER === 'anthropic_compat'
      ? { model: API_MODEL, max_tokens: 900, system, messages: [{ role: 'user', content: request }] }
      : { model: API_MODEL, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: request }] };
    const resp = await fetchWithRetry(getLLMUrl(), { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body), signal: (run?.abortCtrl || abortCtrl)?.signal });
    if (!resp.ok) return fallback;
    const data = await resp.json();
    const text = PROVIDER === 'anthropic_compat'
      ? (Array.isArray(data.content) ? data.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n') : data.content)
      : data.choices?.[0]?.message?.content;
    return cleanGeneratedMediaPrompt(text) || fallback;
  } catch {
    return fallback;
  }
}
async function buildRequestBody(messages = buildConversationFromEntries(), headId = activeEntryId, options = {}) {
  const run = options.run || currentRunContext || null;
  const parts = await collectRequestContextParts(messages, headId, { readOnlyMemory: false, memoryRecallKey: options.memoryRecallKey, run });
  if (run) activateConversationRun(run);
  return assembleRequestBodyFromParts(parts);
}
async function sendLLMRequestBody(body, signal) {
  const makeOptions = requestBody => ({ method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(requestBody), ...(signal ? { signal } : {}) });
  const resp = await fetchWithRetry(getLLMUrl(), makeOptions(body));
  if (PROVIDER !== 'anthropic_compat' || resp.ok) return resp;
  let errorText = '';
  try { errorText = await resp.clone().text(); } catch {}
  if (!looksLikeCacheControlCompatError(resp.status, errorText)) return resp;
  return await fetchWithRetry(getLLMUrl(), makeOptions(downgradeAnthropicCompatBody(body)));
}

