/* creel harness — part 4 of 26: swarm
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
 *   - SWARM (Agent Swarm v1) — orchestrator-worker fanout on top of sub-agents
 */
// ═══════════════════════════════════════════════════════════════════
// SWARM (Agent Swarm v1) — orchestrator-worker fanout on top of sub-agents
// ═══════════════════════════════════════════════════════════════════
const SWARM_KEY = 'ba_swarm_v1';
const SWARM_TOOL_NAME = 'SwarmSpawn';
const SWARM_HANDOFF_TOOL_NAME = 'SwarmHandoff';
// Built-in role library. A role is a worker template: system prompt, tool whitelist, default budgets.
// Workers spawned via SwarmSpawn run a sub-agent loop scoped by the role.
// `allowedHandoffs` lists role ids this worker may pass control to via SwarmHandoff (v1.1, routine chains).
const SWARM_BUILTIN_ROLES = {
  researcher: { name: 'researcher', description: 'Gathers facts from VFS and the web. Read-only.', allowedTools: ['Read', 'Glob', 'Grep', 'Fetch', 'WebSearch', 'memory_search'], maxSteps: 8, tokenBudget: 80000, allowedHandoffs: ['critic', 'writer'], systemPrompt: 'You are a focused research worker. Investigate the delegated task using the allowed read-only tools. Cite specific sources (URLs, file paths with line numbers). Do not speculate beyond what tools return.' },
  critic: { name: 'critic', description: 'Reviews material for gaps, contradictions, weak evidence. Read-only.', allowedTools: ['Read', 'Glob', 'Grep', 'Fetch', 'memory_search'], maxSteps: 6, tokenBudget: 60000, allowedHandoffs: ['writer'], systemPrompt: 'You are a skeptical reviewer. Identify gaps, unsupported claims, contradictions, and missing evidence in the material referenced by the task. Quote the exact passages you challenge. Output a bullet list of concrete issues.' },
  writer: { name: 'writer', description: 'Synthesizes findings into a polished output. Read-only.', allowedTools: ['Read', 'Glob', 'Grep', 'memory_search'], maxSteps: 5, tokenBudget: 70000, allowedHandoffs: [], systemPrompt: 'You are a writing worker. Produce the requested output exactly to the requested format. No preamble, no meta-commentary. Pull facts only from material provided in the task and via Read/Grep on the VFS.' },
  coder: { name: 'coder', description: 'Read-only code analyst (no Write/Edit). Reports findings only.', allowedTools: ['Read', 'Glob', 'Grep', 'memory_search'], maxSteps: 8, tokenBudget: 80000, allowedHandoffs: ['critic', 'writer'], systemPrompt: 'You are a code analyst worker. Trace the requested behavior across files using Read/Glob/Grep. Cite findings as path:line ranges. Do not propose changes unless explicitly asked.' }
};
const SWARM_DEFAULTS = {
  enabled: false,
  maxConcurrency: 3,
  maxWorkersPerRun: 8,         // hard ceiling per user turn
  totalTokenBudget: 250000,    // sum across all workers in a run
  workerModel: '',             // empty = inherit lead's API_MODEL
  allowWriteRoles: false,      // if true, role.allowedTools may include Write/Edit/Bash etc.
  maxHandoffChain: 3,          // worker → handoff → handoff → ... cap (includes the originating worker)
  // v4 — RoleManager
  roleManagerEnabled: false,   // expose RoleManager tool to the lead agent
  agentRolesPersist: false,    // false = memory-only; true = save somewhere
  agentRolesPerConv: false     // when persist=true: false = global localStorage, true = per-conversation IndexedDB
};
const SWARM_WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash', 'PythonExec', 'JSExec', 'NodeExec', 'VfsToPyodide', 'PyodideToVfs', 'GenerateImage', 'GenerateVideo']);
// Tools that must NEVER be in a worker's allowed set, regardless of role configuration
// (would cause infinite recursion: workers spawning workers).
const SWARM_RECURSIVE_TOOLS = new Set(['SwarmSpawn', 'RunSubAgent', 'SwarmStatus', 'SwarmAbort']);
let swarmSettings = { ...SWARM_DEFAULTS };
try { const s = localStorage.getItem(SWARM_KEY); if (s) swarmSettings = { ...SWARM_DEFAULTS, ...(JSON.parse(s) || {}) }; } catch {}
function saveSwarmSettings() { try { localStorage.setItem(SWARM_KEY, JSON.stringify(swarmSettings)); } catch (e) { console.warn('saveSwarmSettings failed', e); } }

// v3: user-defined custom roles (in addition to SWARM_BUILTIN_ROLES). Persisted to localStorage.
const SWARM_ROLES_KEY = 'ba_swarm_roles_v1';
let userSwarmRoles = [];
try { const s = localStorage.getItem(SWARM_ROLES_KEY); if (s) { const arr = JSON.parse(s); if (Array.isArray(arr)) userSwarmRoles = arr; } } catch {}
function saveUserSwarmRoles() { try { localStorage.setItem(SWARM_ROLES_KEY, JSON.stringify(userSwarmRoles)); } catch (e) { console.warn('saveUserSwarmRoles failed', e); } }

// v4: agent-created custom roles (via the RoleManager tool). Storage depends on swarmSettings:
//   persist=false               → memory-only (lost on reload)
//   persist=true,  perConv=false → localStorage 'ba_swarm_agent_roles_v1' (global)
//   persist=true,  perConv=true  → conversation IndexedDB record (saveCurrentConv)
const SWARM_AGENT_ROLES_KEY = 'ba_swarm_agent_roles_v1';
let agentSwarmRoles = [];
function _loadAgentSwarmRolesAtBoot() {
  if (!swarmSettings.agentRolesPersist || swarmSettings.agentRolesPerConv) return;
  try {
    const s = localStorage.getItem(SWARM_AGENT_ROLES_KEY);
    if (s) { const arr = JSON.parse(s); if (Array.isArray(arr)) agentSwarmRoles = arr; }
  } catch {}
}
_loadAgentSwarmRolesAtBoot();
function saveAgentSwarmRoles() {
  if (!swarmSettings.agentRolesPersist) return; // memory-only mode is a no-op
  if (swarmSettings.agentRolesPerConv) {
    if (typeof saveCurrentConv === 'function') saveCurrentConv();
    return;
  }
  try { localStorage.setItem(SWARM_AGENT_ROLES_KEY, JSON.stringify(agentSwarmRoles)); }
  catch (e) { console.warn('saveAgentSwarmRoles failed', e); }
}
// Returns the merged role list — three tiers, builtins always win on id collisions, then user, then agent.
function getAllSwarmRoles() {
  const builtins = Object.entries(SWARM_BUILTIN_ROLES).map(([id, r]) => ({ id, builtin: true, enabled: true, ...r }));
  const userVisible = userSwarmRoles.filter(r => r && r.enabled !== false && !SWARM_BUILTIN_ROLES[r.id]);
  const reserved = new Set([...Object.keys(SWARM_BUILTIN_ROLES), ...userVisible.map(r => r.id)]);
  const agentVisible = agentSwarmRoles.filter(r => r && r.enabled !== false && !reserved.has(r.id));
  return [...builtins, ...userVisible, ...agentVisible];
}
function findSwarmRoleAny(roleId) {
  // Returns even disabled custom roles — used by the editor.
  if (SWARM_BUILTIN_ROLES[roleId]) return { id: roleId, builtin: true, enabled: true, ...SWARM_BUILTIN_ROLES[roleId] };
  const u = userSwarmRoles.find(r => r.id === roleId);
  if (u) return u;
  const a = agentSwarmRoles.find(r => r.id === roleId);
  if (a) return a;
  return null;
}
// Helper: which tier owns a given role id?
function _swarmRoleTier(roleId) {
  if (SWARM_BUILTIN_ROLES[roleId]) return 'builtin';
  if (userSwarmRoles.some(r => r.id === roleId)) return 'user';
  if (agentSwarmRoles.some(r => r.id === roleId)) return 'agent';
  return null;
}
function getSwarmRole(roleId) {
  const r = getAllSwarmRoles().find(x => x.id === roleId);
  if (!r) return null;
  // Clone and normalize. Strip write tools unless explicitly enabled.
  const out = { ...r, allowedTools: [...(r.allowedTools || [])], allowedHandoffs: [...(r.allowedHandoffs || [])] };
  // v3: bindSkills → fold each bound skill's tool names into the worker's allowed set.
  // Skill objects are looked up by id; missing skills are silently skipped (the role survives a
  // skill being removed). `skillToolHandlers` is built from getAllSkillTools() regardless of
  // .active, so workers can use bound-skill tools even when the skill isn't globally active.
  if (Array.isArray(r.bindSkills) && r.bindSkills.length && Array.isArray(skills)) {
    for (const sid of r.bindSkills) {
      const sk = skills.find(s => s && s.id === sid);
      if (!sk || !Array.isArray(sk.tools)) continue;
      for (const t of sk.tools) {
        if (t && t.name && !out.allowedTools.includes(t.name)) out.allowedTools.push(t.name);
      }
    }
  }
  // Defense-in-depth: even if a custom role's allowedTools accidentally lists a recursive tool,
  // strip it. (UI prevents this; this guards against hand-edited JSON imports.)
  out.allowedTools = out.allowedTools.filter(t => !SWARM_RECURSIVE_TOOLS.has(t));
  if (!swarmSettings.allowWriteRoles) {
    out.allowedTools = out.allowedTools.filter(t => !SWARM_WRITE_TOOLS.has(t));
  }
  // Auto-grant SwarmHandoff to roles that have any handoff target — keeps role JSON honest.
  if (out.allowedHandoffs.length && !out.allowedTools.includes(SWARM_HANDOFF_TOOL_NAME)) {
    out.allowedTools.push(SWARM_HANDOFF_TOOL_NAME);
  }
  // Auto-grant blackboard tools to every swarm worker — the digest mechanism only pays off if workers
  // can actually read/write. Lead also has these via the regular tool registry.
  for (const bbTool of ['bb_write', 'bb_read', 'bb_list', 'bb_post_task', 'bb_claim']) {
    if (!out.allowedTools.includes(bbTool)) out.allowedTools.push(bbTool);
  }
  return out;
}
function listSwarmRoles() { return getAllSwarmRoles().map(r => r.id); }
// Per-run accounting + blackboard (lives only for the duration of a user turn)
const SWARM_BB_MAX_ENTRIES = 200;
const SWARM_BB_MAX_CONTENT_CHARS = 4000;
const SWARM_BB_DIGEST_LIMIT = 20;       // entries injected into worker system prompt
const SWARM_BB_DIGEST_CONTENT_PREVIEW = 200;
let swarmRunActive = null;
function startSwarmRun() {
  swarmRunActive = {
    id: 'swarm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    startedAt: Date.now(),
    totalTokens: 0,
    workerCount: 0,
    aborted: false,
    abortedReason: '',
    blackboard: { entries: [], seq: 0 },
  };
  return swarmRunActive;
}
function endSwarmRun() { swarmRunActive = null; }
function _bbGet() { return swarmRunActive?.blackboard || null; }
function _bbAddEntry({ type, key, content, tags, source, sourceRole }) {
  const bb = _bbGet();
  if (!bb) return { error: 'No active swarm run.' };
  if (bb.entries.length >= SWARM_BB_MAX_ENTRIES) return { error: `Blackboard full (${SWARM_BB_MAX_ENTRIES} entries cap).` };
  const safeContent = (content == null ? '' : String(content)).slice(0, SWARM_BB_MAX_CONTENT_CHARS);
  bb.seq += 1;
  const entry = {
    id: 'bb_' + bb.seq.toString(36),
    type: type || 'note',
    key: (key || '').slice(0, 80),
    content: safeContent,
    tags: Array.isArray(tags) ? tags.map(t => String(t).slice(0, 40)).slice(0, 8) : [],
    source: source || null,
    sourceRole: sourceRole || null,
    ts: Date.now(),
    claimedBy: null,
    claimedRole: null,
  };
  bb.entries.push(entry);
  return { entry };
}
function _bbCurrentSourceLabel() {
  // In a worker context this gets called via executeSubAgentTool which doesn't pass the run object
  // through global state, so we tag entries with the most recently spawned worker as a best-effort.
  // For lead-side writes we tag with 'lead'.
  const lastWorker = [...subAgentRuns].reverse().find(r => r.kind === 'swarm' && r.status === 'running');
  if (lastWorker) return { source: lastWorker.id, sourceRole: lastWorker.role };
  return { source: 'lead', sourceRole: 'lead' };
}
function _bbFilter({ query, key, tags, type, since, limit }) {
  const bb = _bbGet();
  if (!bb) return [];
  const q = (query || '').toLowerCase().trim();
  const wantTags = Array.isArray(tags) ? tags.map(t => String(t).toLowerCase()) : [];
  let out = bb.entries.slice();
  if (key) out = out.filter(e => e.key === key);
  if (type) out = out.filter(e => e.type === type);
  if (since) out = out.filter(e => e.ts >= Number(since));
  if (wantTags.length) out = out.filter(e => wantTags.every(t => e.tags.includes(t)));
  if (q) out = out.filter(e => (e.key + ' ' + e.content + ' ' + e.tags.join(' ')).toLowerCase().includes(q));
  out.sort((a, b) => b.ts - a.ts);
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, Math.min(limit, 50));
  return out;
}
function getBlackboardDigestForWorker() {
  const bb = _bbGet();
  if (!bb || !bb.entries.length) return '';
  const recent = bb.entries.slice(-SWARM_BB_DIGEST_LIMIT);
  const lines = recent.map(e => {
    const claimed = e.claimedBy ? ` [claimed by ${e.claimedRole || e.claimedBy}]` : '';
    const tags = e.tags.length ? ' ' + e.tags.map(t => '#' + t).join(' ') : '';
    const preview = e.content.length > SWARM_BB_DIGEST_CONTENT_PREVIEW ? e.content.slice(0, SWARM_BB_DIGEST_CONTENT_PREVIEW) + '…' : e.content;
    return `  - [${e.id}] (${e.type}) ${e.key || '(no key)'}${tags}${claimed} :: ${preview.replace(/\s+/g, ' ').trim()}`;
  });
  return `\n\n[BLACKBOARD DIGEST — ${recent.length}/${bb.entries.length} most recent entries]\n` + lines.join('\n') + `\n\nUse bb_read / bb_list to fetch full content. Use bb_write to add new findings (use clear keys + tags). Use bb_post_task to broadcast a task other workers in this run can claim. Use bb_claim before working on a posted task to avoid duplication.`;
}
let totalTokens = 0;
let contextTokens = 0;
let lastUsageInfo = null;
let lastInputTokens = 0;
let lastOutputTokens = 0;
let totalInputTokens = 0;   // creel-sbx: cumulative input tokens for the session (bench token accounting)
let totalOutputTokens = 0;  // creel-sbx: cumulative output tokens for the session (bench token accounting)
let lastCacheReadTokens = 0;
let lastCacheWriteTokens = 0;
let lastRequestContextSnapshot = null;
let lastContextBreakdown = null;
let lastTurnTokens = 0;
let contextBreakdownExpanded = false;
let _contextSnapshotSeq = 0;
let _contextUiRefreshTimer = null;
let currentViewFile = null;
const ANTHROPIC_PROMPT_CACHE_ENABLED = true;
const ANTHROPIC_PROMPT_CACHE_CONTROL = { type: 'ephemeral' };
const memRecallPromptCache = new Map();
const microCompactCache = new Map();
const compactedToolUseIds = new Set();
function stableStringHash(value) {
  const text = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function rememberBoundedMapValue(map, key, value, maxEntries = 50) {
  const k = String(key || 'default');
  map.set(k, value);
  while (map.size > maxEntries) map.delete(map.keys().next().value);
  return value;
}

function genEntryId() { return 'entry_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function appendSessionEntry(type, payload = {}) {
  const entry = { id: genEntryId(), parentId: activeEntryId, type, created: Date.now(), ...payload };
  sessionEntries.push(entry);
  activeEntryId = entry.id;
  return entry;
}
function projectEntryToMessage(entry) {
  if (!entry) return null;
  if (entry.type === 'message') return { role: entry.role, content: entry.content };
  if (entry.type === 'tool_result') return { role: 'user', content: entry.content };
  if (entry.type === 'branch_summary' && entry.summary) return { role: 'user', content: `[Branch Summary]\n${entry.summary}` };
  return null;
}
function getEntryChain(headId = activeEntryId) {
  if (!headId || !sessionEntries.length) return [];
  const byId = new Map(sessionEntries.map(entry => [entry.id, entry]));
  const chain = [];
  let cursor = headId;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry) break;
    chain.push(entry);
    cursor = entry.parentId || null;
  }
  return chain.reverse();
}
function buildProjectedConversation(headId = activeEntryId) {
  const chain = getEntryChain(headId);
  if (!chain.length) return [];
  const projected = [];
  const pushProjected = entry => {
    const message = projectEntryToMessage(entry);
    if (message) projected.push({ entryId: entry.id, message });
  };
  const lastCompactionIndex = (() => {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].type === 'compaction') return i;
    }
    return -1;
  })();
  if (lastCompactionIndex < 0) {
    for (const entry of chain) pushProjected(entry);
    return projected;
  }
  const compaction = chain[lastCompactionIndex];
  projected.push({
    entryId: compaction.id,
    message: { role: 'user', content: `[Conversation Summary]\n${compaction.summary}\n\nPlease continue from where we left off.` }
  });
  const firstKeptIndex = compaction.firstKeptEntryId
    ? chain.findIndex((entry, index) => index < lastCompactionIndex && entry.id === compaction.firstKeptEntryId)
    : -1;
  const keptStart = firstKeptIndex >= 0 ? firstKeptIndex : lastCompactionIndex + 1;
  for (const entry of chain.slice(keptStart, lastCompactionIndex)) pushProjected(entry);
  for (const entry of chain.slice(lastCompactionIndex + 1)) pushProjected(entry);
  return projected;
}
function buildConversationFromEntries(headId = activeEntryId) {
  return buildProjectedConversation(headId).map(item => item.message);
}
function rebuildConversation(headId = activeEntryId) {
  conversation = buildConversationFromEntries(headId);
  return conversation;
}
function ensureSessionEntries() {
  if (sessionEntries.length) return;
  let parentId = null;
  for (const msg of conversation) {
    const entry = { id: genEntryId(), parentId, type: msg.role === 'user' && Array.isArray(msg.content) && msg.content.every(block => block.type === 'tool_result') ? 'tool_result' : 'message', role: msg.role, content: msg.content, created: Date.now() };
    sessionEntries.push(entry);
    parentId = entry.id;
  }
  activeEntryId = parentId;
}
function findConversationIndexByEntryId(entryId, headId = activeEntryId) {
  if (!entryId) return -1;
  return buildProjectedConversation(headId).findIndex(item => item.entryId === entryId);
}
function isConversationRunning(convId = visibleConvId || activeConvId) {
  const run = convId ? conversationRuns.get(convId) : null;
  return !!(run && run.active && !run.deleted);
}
function hasAnyConversationRunning() {
  for (const run of conversationRuns.values()) if (run.active && !run.deleted) return true;
  return false;
}
function getActiveConversationRun() {
  return visibleConvId ? (conversationRuns.get(visibleConvId) || null) : null;
}
function getCurrentRunAbortSignal() {
  return currentRunContext?.abortCtrl?.signal || abortCtrl?.signal;
}
function syncLegacyRunFlags() {
  const run = getActiveConversationRun();
  isGenerating = !!(run && run.active && !run.deleted);
  abortCtrl = isGenerating ? run.abortCtrl : null;
  if (!isGenerating && !hasAnyConversationRunning()) abortCtrl = null;
}
function captureConversationState(chatHTML) {
  return {
    convId: activeConvId,
    conversation,
    sessionEntries,
    activeEntryId,
    vfs,
    cwd,
    loopCount,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    contextTokens,
    todos,
    subAgentRuns,
    planMode,
    ralphModeEnabled,
    ralphRun,
    swarmRunActive,
    lastUsageInfo,
    lastInputTokens,
    lastOutputTokens,
    lastCacheReadTokens,
    lastCacheWriteTokens,
    lastTurnTokens,
    lastRequestContextSnapshot,
    lastContextBreakdown,
    contextBreakdownExpanded,
    currentViewFile,
    agentSwarmRoles,
    chatHTML: typeof chatHTML === 'string' ? chatHTML : (activeConvId === visibleConvId ? chatEl?.innerHTML || '' : '')
  };
}
function applyConversationState(state = {}) {
  activeConvId = state.convId || activeConvId;
  conversation = Array.isArray(state.conversation) ? state.conversation : [];
  sessionEntries = Array.isArray(state.sessionEntries) ? state.sessionEntries : [];
  activeEntryId = state.activeEntryId || null;
  vfs = state.vfs || { type: 'dir', children: {} };
  cwd = state.cwd || '/';
  loopCount = state.loopCount || 0;
  totalTokens = state.totalTokens || 0;
  totalInputTokens = state.totalInputTokens || 0;
  totalOutputTokens = state.totalOutputTokens || 0;
  contextTokens = state.contextTokens || 0;
  todos = Array.isArray(state.todos) ? state.todos : [];
  subAgentRuns = Array.isArray(state.subAgentRuns) ? state.subAgentRuns : [];
  planMode = !!state.planMode;
  ralphModeEnabled = !!state.ralphModeEnabled;
  ralphRun = state.ralphRun || null;
  swarmRunActive = state.swarmRunActive || null;
  lastUsageInfo = state.lastUsageInfo || null;
  lastInputTokens = state.lastInputTokens || 0;
  lastOutputTokens = state.lastOutputTokens || 0;
  lastCacheReadTokens = state.lastCacheReadTokens || 0;
  lastCacheWriteTokens = state.lastCacheWriteTokens || 0;
  lastTurnTokens = state.lastTurnTokens || 0;
  lastRequestContextSnapshot = state.lastRequestContextSnapshot || null;
  lastContextBreakdown = state.lastContextBreakdown || null;
  contextBreakdownExpanded = !!state.contextBreakdownExpanded;
  currentViewFile = state.currentViewFile || null;
  if (swarmSettings.agentRolesPersist && swarmSettings.agentRolesPerConv) {
    agentSwarmRoles = Array.isArray(state.agentSwarmRoles) ? state.agentSwarmRoles : [];
  }
}
function ensureRunChatContainer(run) {
  if (!run) return null;
  if (!run.chatContainer) {
    run.chatContainer = document.createElement('div');
    if (run.state?.chatHTML) run.chatContainer.innerHTML = run.state.chatHTML;
  }
  return run.chatContainer;
}
function isRunVisible(run) {
  return !!(run && run.convId && run.convId === visibleConvId);
}
function getContextChatEl(run) {
  // Route by the run that OWNS the content (passed explicitly by the engine),
  // not by the mutable global currentRunContext which can be null/stale while a
  // background run renders — that fallback is what caused output to bleed into
  // the visible conversation. Only fall back to currentRunContext for legacy
  // UI callers that don't pass a run.
  const ctx = run || currentRunContext;
  if (ctx && !isRunVisible(ctx)) {
    return ensureRunChatContainer(ctx);
  }
  return chatEl;
}
function getRunChatHTML(run) {
  if (!run) return '';
  if (isRunVisible(run) && chatEl) return chatEl.innerHTML;
  if (run.chatContainer) return run.chatContainer.innerHTML;
  return run.state?.chatHTML || '';
}
function snapshotConversationRunState(run) {
  if (!run) return;
  run.state = captureConversationState(getRunChatHTML(run));
  run.state.convId = run.convId;
  run.chatHTML = run.state.chatHTML;
}
function detachConversationRunDom(run) {
  if (!run || !isRunVisible(run) || run.chatContainer || !chatEl) return;
  const box = document.createElement('div');
  while (chatEl.firstChild) box.appendChild(chatEl.firstChild);
  run.chatContainer = box;
  run.state = run.state || {};
  run.state.chatHTML = box.innerHTML;
  run.chatHTML = box.innerHTML;
}
function attachConversationRunDom(run) {
  if (!run || !chatEl) return false;
  if (run.chatContainer) {
    chatEl.innerHTML = '';
    while (run.chatContainer.firstChild) chatEl.appendChild(run.chatContainer.firstChild);
    run.chatContainer = null;
    return true;
  }
  if (run.state?.chatHTML) {
    chatEl.innerHTML = run.state.chatHTML;
    return true;
  }
  return false;
}
function activateConversationRun(run) {
  if (!run) return;
  // A finished run that has already been unregistered from conversationRuns must
  // NOT re-apply its snapshot: late fire-and-forget callbacks (media render, a
  // tool await that resolved after teardown) would otherwise resurrect the dead
  // run's globals over whatever conversation is now visible. A deleted-but-still-
  // active run is intentionally allowed through so its remaining loop steps mutate
  // ITS OWN globals (never persisted — see the finally guard) instead of silently
  // no-oping and splicing content into the visible conversation.
  if (!run.active && conversationRuns.get(run.convId) !== run) return;
  const prevRun = activeConvId ? conversationRuns.get(activeConvId) : null;
  if (prevRun && prevRun !== run) snapshotConversationRunState(prevRun);
  else if (activeConvId && activeConvId !== run.convId && activeConvId === visibleConvId) {
    visibleConversationState = captureConversationState(chatEl?.innerHTML || '');
  }
  currentRunContext = run;
  applyConversationState(run.state || {});
  activeConvId = run.convId;
  if (!run.abortCtrl) run.abortCtrl = new AbortController();
  isGenerating = isRunVisible(run);
  abortCtrl = run.abortCtrl;
}
function ensureVisibleConversationStateActive() {
  if (!visibleConvId || activeConvId === visibleConvId) return;
  const run = conversationRuns.get(visibleConvId);
  currentRunContext = null;
  if (run) {
    applyConversationState(run.state || {});
    activeConvId = visibleConvId;
    return;
  }
  if (visibleConversationState?.convId === visibleConvId) {
    applyConversationState(visibleConversationState);
    activeConvId = visibleConvId;
  }
}
function stopConversationRun(convId = visibleConvId || activeConvId) {
  const run = convId ? conversationRuns.get(convId) : null;
  if (!run) return false;
  run.cancelled = true;
  if (run.state?.ralphRun?.active) run.state.ralphRun.cancelled = true;
  if (run.abortCtrl) run.abortCtrl.abort();
  syncLegacyRunFlags();
  updateButtons();
  renderConvList();
  return true;
}

// Conversation history — metadata in localStorage, heavy data in IndexedDB
// Metadata: { id, title, created, updated, loopCount, totalTokens, contextTokens }
// Heavy (IndexedDB): { conversation, sessionEntries, activeEntryId, vfs, chatHTML, totalTokens, contextTokens, loopCount, token usage details }
let convHistory = [];
let convFolders = []; // [{id, name, expanded}]
let activeConvId = null;
const _titleGenInFlight = new Set();
const CONV_DB_NAME = 'ba_conversations';
const CONV_DB_VER = 2;
const CONV_STORE = 'data';
const CONV_META_STORE = 'meta';
const CONV_META_KEY = 'list';
const CONV_FOLDERS_KEY = 'folders';

function genConvId() { return 'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

