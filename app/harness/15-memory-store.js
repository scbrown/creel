/* creel harness — part 15 of 26: memory-store
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
 *   - LONG-TERM MEMORY
 *   - TOOL DEFINITIONS (dynamic — includes skill tools)
 */
// ═══════════════════════════════════════════════════════════════════
// LONG-TERM MEMORY
// Memory = Information (content) + Time Label (createdAt) + Relationships (tags)
// Global pool, IndexedDB-backed, togglable in Settings (default OFF).
// Naming: everything prefixed `mem*` to avoid clashing with the existing
// context-compaction UI (memoryLog / logMemEntry / updateMemoryUI).
// ═══════════════════════════════════════════════════════════════════
const MEM_DB_NAME = 'ba_memories';
const MEM_DB_VER = 1;
const MEM_STORE = 'memories';
const MEM_META_STORE = 'meta';
const MEM_DEFAULTS = { enabled: false, autoExtract: true, maxRecall: 8, extractionModel: '' };
let _memDbPromise = null;
let _memCache = null;       // Array of all records, lazily loaded
const _memExtractInFlight = new Set(); // convIds currently extracting — prevent runaway parallel extractions PER conversation (not globally, which dropped concurrent conversations' extractions)

function memGetSettings() {
  const s = loadSettings() || {};
  return { ...MEM_DEFAULTS, ...(s.memory || {}) };
}
function memIsEnabled() { return memGetSettings().enabled === true; }
function genMemId() { return 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function openMemDB() {
  if (_memDbPromise) return _memDbPromise;
  _memDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(MEM_DB_NAME, MEM_DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MEM_STORE)) {
        const store = db.createObjectStore(MEM_STORE, { keyPath: 'id' });
        store.createIndex('byCreatedAt', 'createdAt');
        store.createIndex('byTag', 'tags', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains(MEM_META_STORE)) db.createObjectStore(MEM_META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _memDbPromise = null; reject(req.error); };
  });
  return _memDbPromise;
}

async function memLoadCache() {
  if (_memCache) return _memCache;
  try {
    const db = await openMemDB();
    const tx = db.transaction(MEM_STORE, 'readonly');
    const req = tx.objectStore(MEM_STORE).getAll();
    _memCache = await new Promise(r => { req.onsuccess = () => r(req.result || []); req.onerror = () => r([]); });
  } catch (e) { console.warn('memLoadCache failed', e); _memCache = []; }
  return _memCache;
}

async function memPutRaw(record) {
  const db = await openMemDB();
  const tx = db.transaction(MEM_STORE, 'readwrite');
  tx.objectStore(MEM_STORE).put(record);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  if (_memCache) {
    const i = _memCache.findIndex(m => m.id === record.id);
    if (i >= 0) _memCache[i] = record; else _memCache.push(record);
  }
  if (typeof schedulePush === 'function') schedulePush();
  return record;
}

// Normalize a tag array: lowercase, trim, strip quotes/brackets/backslash, dedupe, cap.
function _memSanitizeTags(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = String(raw || '').toLowerCase().trim().replace(/['"`<>\\]/g, '').slice(0, 40);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

// Merge an incoming memory record into the store. Policy:
//   - no id on the incoming record → treat as a fresh add (legacy import)
//   - id exists locally → overwrite only when incoming updatedAt is newer
//   - id not in store → insert as-is
// Returns one of: 'added', 'updated', 'skipped'. Used by both import and S3 sync.
async function _memMergeIncoming(incoming) {
  if (!incoming || typeof incoming.content !== 'string') return 'skipped';
  const cache = await memLoadCache();
  const now = Date.now();
  const id = incoming.id || genMemId();
  const existing = cache.find(m => m.id === id);
  if (existing && (incoming.updatedAt || 0) <= (existing.updatedAt || 0)) return 'skipped';
  const rec = {
    id,
    content: String(incoming.content),
    type: ['fact','preference','event','skill','note'].includes(incoming.type) ? incoming.type : 'fact',
    tags: _memSanitizeTags(incoming.tags),
    createdAt: Number.isFinite(incoming.createdAt) ? incoming.createdAt : (existing?.createdAt || now),
    updatedAt: Number.isFinite(incoming.updatedAt) ? incoming.updatedAt : now,
    lastRecalledAt: incoming.lastRecalledAt || existing?.lastRecalledAt || null,
    recallCount: Number.isFinite(incoming.recallCount) ? incoming.recallCount : (existing?.recallCount || 0),
    pinned: !!incoming.pinned,
    convId: incoming.convId || existing?.convId || null,
    sourceTurn: incoming.sourceTurn ?? existing?.sourceTurn ?? null,
    source: incoming.source || existing?.source || 'manual',
    superseded: !!incoming.superseded,
    supersededBy: typeof incoming.supersededBy === 'string' ? incoming.supersededBy : null,
    supersedes: Array.isArray(incoming.supersedes) ? incoming.supersedes.filter(s => typeof s === 'string') : []
  };
  await memPutRaw(rec);
  return existing ? 'updated' : 'added';
}

async function memSave({ content, tags, type, source, convId, sourceTurn, pinned, supersedesIds }) {
  const c = (content || '').trim();
  if (!c) throw new Error('memSave: content required');
  const now = Date.now();
  const record = {
    id: genMemId(),
    content: c,
    type: type || 'fact',
    tags: _memSanitizeTags(tags),
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: null,
    recallCount: 0,
    pinned: !!pinned,
    convId: convId || activeConvId || null,
    sourceTurn: Number.isFinite(sourceTurn) ? sourceTurn : (typeof loopCount === 'number' ? loopCount : null),
    source: source || 'manual',
    // Phase 1: supersede bookkeeping.
    superseded: false,
    supersededBy: null,
    supersedes: []
  };
  // Resolve supersedes: validate each id exists and is not already superseded,
  // then mark those records retired with a pointer to the new record.
  if (Array.isArray(supersedesIds) && supersedesIds.length) {
    const cache = await memLoadCache();
    const validOldIds = [];
    for (const oldId of supersedesIds) {
      if (typeof oldId !== 'string' || oldId === record.id) continue;
      const old = cache.find(m => m.id === oldId);
      if (!old) continue;
      validOldIds.push(oldId);
    }
    record.supersedes = validOldIds.slice(0, 6);
    await memPutRaw(record);
    // Retire old records AFTER the new one is persisted so recall never sees a gap.
    for (const oldId of record.supersedes) {
      const old = _memCache?.find(m => m.id === oldId);
      if (!old || old.superseded) continue;
      old.superseded = true;
      old.supersededBy = record.id;
      old.updatedAt = now;
      await memPutRaw(old);
    }
    return record;
  }
  await memPutRaw(record);
  return record;
}

async function memUpdate(id, patch) {
  const cache = await memLoadCache();
  const rec = cache.find(m => m.id === id);
  if (!rec) return null;
  Object.assign(rec, patch, { updatedAt: Date.now() });
  await memPutRaw(rec);
  return rec;
}

async function memDelete(id) {
  const db = await openMemDB();
  const tx = db.transaction(MEM_STORE, 'readwrite');
  tx.objectStore(MEM_STORE).delete(id);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  if (_memCache) _memCache = _memCache.filter(m => m.id !== id);
  if (typeof schedulePush === 'function') schedulePush();
}

async function memClearStorage() {
  const db = await openMemDB();
  const tx = db.transaction(MEM_STORE, 'readwrite');
  tx.objectStore(MEM_STORE).clear();
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  _memCache = [];
  if (typeof schedulePush === 'function') schedulePush();
}

async function memListAll() { return (await memLoadCache()).slice(); }

// ── Tokenize text for keyword overlap — lowercase, 3+ chars, common stop words dropped.
const _MEM_STOP = new Set(['the','a','an','and','or','but','is','are','was','were','be','been','being','to','of','in','on','for','with','as','at','by','from','that','this','these','those','it','its','you','your','we','our','i','me','my','they','them','their','he','she','do','does','did','have','has','had','not','no','so','if','then','than','which','who','what','how','why','when','where','can','could','would','should','will','shall','may','might','just','also','too','very','into','about','over','out','up','down','off','over']);
function _memTokens(text) {
  if (!text) return [];
  const toks = String(text).toLowerCase().match(/[a-z0-9_\-]{3,}|[\u4e00-\u9fff]+/g) || [];
  return toks.filter(t => !_MEM_STOP.has(t));
}

function _memQueryFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  // Pull last 2 user messages' plain text — that's the current intent signal.
  const users = [];
  for (let i = messages.length - 1; i >= 0 && users.length < 2; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const t = getUserTextFromContent(m.content);
    if (t) users.push(t);
  }
  return users.reverse().join('\n');
}

function _memRelativeLabel(ts, now) {
  const diffMs = now - ts;
  const day = 86400000;
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
  if (diffMs < day) return Math.floor(diffMs / 3600000) + 'h ago';
  const days = Math.floor(diffMs / day);
  if (days === 1) return 'yesterday';
  if (days < 7) return days + ' days ago';
  if (days < 30) return Math.floor(days / 7) + 'w ago';
  if (days < 365) return Math.floor(days / 30) + 'mo ago';
  return Math.floor(days / 365) + 'y ago';
}
function _memDateLabel(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function memRank(records, queryText, { limit = 8, now = Date.now() } = {}) {
  const qTokens = new Set(_memTokens(queryText));
  const day = 86400000;
  const scored = records.map(rec => {
    const age = Math.max(0, now - (rec.createdAt || 0));
    // Recency: exp-decay with ~30d half-life, mapped to [0,1].
    const recency = Math.exp(-age / (30 * day));
    // Tag overlap: fraction of record tags matching query tokens.
    let tagHits = 0;
    for (const t of rec.tags || []) if (qTokens.has(String(t).toLowerCase())) tagHits++;
    const tagOverlap = rec.tags?.length ? tagHits / rec.tags.length : 0;
    // Keyword overlap: fraction of query tokens present in content.
    const cTokens = new Set(_memTokens(rec.content));
    let kwHits = 0;
    for (const q of qTokens) if (cTokens.has(q)) kwHits++;
    const kwOverlap = qTokens.size ? kwHits / qTokens.size : 0;
    const pinnedBoost = rec.pinned ? 0.25 : 0;
    const score = 0.5 * recency + 0.3 * tagOverlap + 0.2 * kwOverlap + pinnedBoost;
    return { rec, score, tagHits, kwHits };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

async function getCachedMemRecallForPrompt(messages, options = {}) {
  const key = String(options.memoryRecallKey || _memQueryFromMessages(messages) || 'default');
  if (memRecallPromptCache.has(key)) return memRecallPromptCache.get(key) || '';
  const prompt = await memRecallForPrompt(messages, { readOnly: !!options.readOnly });
  if (!options.readOnly) rememberBoundedMapValue(memRecallPromptCache, key, prompt || '', 50);
  return prompt || '';
}

async function memRecallForPrompt(messages, options = {}) {
  try {
    const cfg = memGetSettings();
    if (!cfg.enabled) return '';
    const all = await memLoadCache();
    if (!all.length) return '';
    // Skip retired memories entirely — they never go into the prompt.
    const live = all.filter(m => !m.superseded);
    if (!live.length) return '';
    const query = _memQueryFromMessages(messages);
    const ranked = memRank(live, query, { limit: Math.max(0, cfg.maxRecall | 0) });
    if (!ranked.length) return '';
    // Require some relevance unless pinned — keep first few pinned even at zero score.
    const meaningful = ranked.filter(r => r.score > 0.12 || r.rec.pinned);
    const picked = meaningful.length ? meaningful : ranked.slice(0, Math.min(3, ranked.length));
    if (!picked.length) return '';
    const now = Date.now();
    const lines = picked.map(({ rec }) => {
      const tagStr = (rec.tags || []).map(t => '#' + t).join(' ');
      const header = '[' + _memDateLabel(rec.createdAt) + (tagStr ? ', ' + tagStr : '') + (rec.pinned ? ', pinned' : '') + ']';
      return '- ' + header + ' ' + rec.content;
    });
    if (!options.readOnly) {
      for (const { rec } of picked) {
        rec.lastRecalledAt = now;
        rec.recallCount = (rec.recallCount || 0) + 1;
        memPutRaw(rec).catch(() => {});
      }
    }
    return '\n\n## Recalled Memories (from prior conversations)\nMemory = Information + Time Label + Relationships. Use these facts if relevant to the current request; ignore if stale or unrelated.\n' + lines.join('\n');
  } catch (e) { console.warn('memRecallForPrompt failed', e); return ''; }
}

function _memNormalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Skip obvious no-ops: very short turns, questions with no declarative user claim,
// or agent-continuation prompts. Saves an LLM call per turn.
function _memShouldSkipExchange(userText, assistantText) {
  const u = String(userText || '').trim();
  if (!u) return true;
  // Pure agent-continuation / short commands: skip. Covers both English and CJK.
  if (u.length < 12) return true;
  // Short directive openings — English + Chinese. Gated by length so longer
  // statements that happen to start with these words still reach the LLM.
  const shortDirectiveEn = /^(go|ok|continue|next|yes|no|run|test|stop|retry|again|more|done|fix|try|show|list|cat|ls|help|print|log|dump)\b/i;
  const shortDirectiveZh = /^(继续|好|好的|嗯|收到|明白|下一步|再试|再来|重试|试试|跑一下|跑吧|测一下|打印|列出|显示|看看|执行|帮我|请|请问|好了|结束|停|完)/;
  // Declarative signals — first-person / project / decisions. English + Chinese.
  const declarativeEn = /\b(i'?m|i am|i prefer|i use|i like|i don'?t|i'?ll|i will|my |we are|we use|we prefer|our |the project|this project|always|never|remember|note that|for the record|decision:|policy:)\b/i;
  const declarativeZh = /(我(喜欢|偏好|觉得|想|不想|讨厌|认为|使用|用|经常|通常|习惯|打算|决定)|我们(用|使用|偏好|有|约定|决定|遵循)|项目(是|要|需要|用|约定|使用|采用)|团队(用|使用|约定)|约定[:：]|决定[:：]|政策[:：]|规范[:：])/;
  const declarative = declarativeEn.test(u) || declarativeZh.test(u);
  const imperativeRemember = /\b(remember|note this)\b/i.test(u) || /(记住|记一下|记录一下|请记住|注意[:：]|请注意)/.test(u);
  if (u.length < 40 && (shortDirectiveEn.test(u) || shortDirectiveZh.test(u)) && !declarative && !imperativeRemember) return true;
  // Question with no declarative content and no explicit "remember": skip.
  const looksLikeQuestionEn = /\?$/.test(u) || /^(what|why|when|where|how|who|which|can|could|should|would|does|do|is|are|will)\b/i.test(u);
  const looksLikeQuestionZh = /[?？]$/.test(u) || /^(什么|为什么|怎么|怎样|如何|谁|哪|哪里|哪个|能不能|可不可以|是不是|有没有)/.test(u);
  if ((looksLikeQuestionEn || looksLikeQuestionZh) && !declarative && !imperativeRemember) return true;
  return false;
}

// Fuzzy dedup: any existing memory whose token set overlaps >= 65% with
// the candidate — treat as duplicate, even across arbitrary phrasing.
function _memIsDuplicateFuzzy(candidateContent, existingRecords) {
  const cand = _memNormalize(candidateContent);
  if (!cand) return true;
  const candTokens = new Set(_memTokens(cand));
  if (candTokens.size === 0) return false;
  for (const rec of existingRecords) {
    const norm = _memNormalize(rec.content);
    if (norm === cand) return true;
    const other = new Set(_memTokens(norm));
    if (other.size === 0) continue;
    let hits = 0;
    for (const t of candTokens) if (other.has(t)) hits++;
    const smaller = Math.min(candTokens.size, other.size);
    if (smaller >= 3 && hits / smaller >= 0.65) return true;
  }
  return false;
}

// Validate + normalize one extracted memory candidate. Returns a sanitized
// partial record (without id/timestamps) or null to reject.
function _memValidateExtracted(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.content !== 'string') return null;
  const content = item.content.trim();
  if (content.length < 8 || content.length > 400) return null;
  const salience = Number(item.salience);
  // Missing salience → treat as 3 (neutral); explicit sub-3 → reject.
  if (Number.isFinite(salience) && salience < 3) return null;
  // Reject items that describe ephemeral user actions (English + Chinese).
  const rejectPrefix = /^(user (asked|wondered|requested|wanted to|is trying to|is working on|is exploring|is debugging|ran|tried|tested|executed|fixed|wrote|created)\b|用户(询问|想知道|要求|请求|尝试|在尝试|在调试|在探索|运行|执行|跑|测试|修复|写|创建|做了|做过|查看|查询|检查))/i;
  if (rejectPrefix.test(content)) return null;
  const type = ['fact','preference','event','skill','note'].includes(item.type) ? item.type : 'fact';
  const tags = _memSanitizeTags(item.tags);
  const supersedesIds = Array.isArray(item.supersedesIds)
    ? item.supersedesIds.filter(s => typeof s === 'string' && s.startsWith('mem_')).slice(0, 6)
    : [];
  return { content, type, tags, supersedesIds };
}

async function memExtractAfterTurn({ userText, assistantContent, loopCount: lc, convId }) {
  // Concurrency guard — drop overlapping calls FOR THE SAME conversation rather
  // than pile them up; a different conversation finishing at the same moment must
  // still get its own extraction (a single global flag silently lost it).
  const memKey = convId || '__nomem_conv__';
  if (_memExtractInFlight.has(memKey)) return;
  _memExtractInFlight.add(memKey);
  try {
    const cfg = memGetSettings();
    if (!cfg.enabled || !cfg.autoExtract) return;
    if (!_keys?.api_key) return;
    const assistantText = Array.isArray(assistantContent)
      ? assistantContent.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      : String(assistantContent || '').trim();
    const userTrim = String(userText || '').trim();
    if (_memShouldSkipExchange(userTrim, assistantText)) return;
    const exchange = `[user] ${userTrim}\n\n[assistant] ${assistantText}`.slice(0, 8000);

    // Seed the prompt with up to 12 recent non-superseded memories so the
    // model can self-dedupe and propose supersedes candidates.
    const cache = await memLoadCache();
    const seedPool = cache.filter(m => !m.superseded)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 12);
    const recentSeed = seedPool
      .map(m => `- {${m.id}} [${m.type || 'fact'}${(m.tags && m.tags.length) ? ' ' + m.tags.map(t => '#' + t).join(' ') : ''}] ${m.content}`)
      .join('\n');

    const sys = [
      'You are a conservative memory curator. Extract durable long-term memories from the exchange below — or return an empty array if nothing durable was stated.',
      '',
      'SAVE only when the user EXPLICITLY stated ONE of these:',
      '  - a personal preference ("I prefer pytest over unittest")',
      '  - a project-specific fact / constraint ("Our API runs on Fastify", "Production DB is Postgres 15")',
      '  - a durable identity or role fact ("I\'m a backend engineer at Acme")',
      '  - an explicit decision / policy ("Going forward we\'ll use TypeScript strict mode")',
      '  - an explicit instruction to remember something ("remember that the staging URL is X")',
      '',
      'DO NOT save:',
      '  - questions the user asked or tasks they requested ("help me write a function", "what does X do")',
      '  - anything the assistant proposed, inferred, or planned (only what the USER actually stated)',
      '  - debugging steps, error messages, tool outputs, code snippets, file contents',
      '  - ephemeral session state ("I just ran the tests", "this loop is broken")',
      '  - restatements of common / public knowledge',
      '  - anything already represented in the EXISTING MEMORIES list below — skip duplicates and near-duplicates, even if the wording differs',
      '',
      'SUPERSEDES:',
      '  - If a new memory replaces an existing memory (user changed their mind, old fact is now stale, or the new fact is a strict superset), include "supersedesIds":["<id>",...] listing the ids of the retired EXISTING MEMORIES. The ids appear in braces like {mem_abc123} in the list below.',
      '  - Only supersede when you are confident. If unsure, omit supersedesIds.',
      '',
      'OUTPUT: strict JSON only, no prose, no markdown fence. Schema:',
      '{"memories":[{"content":"User prefers X over Y","type":"fact|preference|event|skill|note","tags":["lowercase","tokens"],"salience":1-5,"supersedesIds":["mem_..."]}]}',
      'Each content: self-contained, third-person ("User prefers X", never "I prefer X"), <= 220 chars.',
      'salience: 5 = must-remember long-term, 3 = probably useful, 1 = trivial. Only emit items with salience >= 3.',
      'If the exchange contains nothing that qualifies, return {"memories":[]}. Prefer emptiness over noise.'
    ].join('\n');

    const userMsg = (recentSeed
      ? `EXISTING MEMORIES (skip duplicates; supersede when the new fact replaces one):\n${recentSeed}\n\n`
      : '') + `EXCHANGE TO ANALYZE:\n${exchange}`;

    const model = cfg.extractionModel || API_MODEL;
    let body;
    let anthropicPrefilled = false;
    if (PROVIDER === 'anthropic_compat') {
      // Prefill "{" so Anthropic continues a JSON object instead of prose.
      body = {
        model,
        max_tokens: 800,
        system: sys,
        messages: [
          { role: 'user', content: userMsg },
          { role: 'assistant', content: '{' }
        ],
        stream: false
      };
      anthropicPrefilled = true;
    } else {
      body = {
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        response_format: { type: 'json_object' },
        stream: false
      };
    }
    const resp = await fetchWithRetry(getLLMUrl(), { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body) });
    if (!resp.ok) return;
    const data = await resp.json();
    let raw = '';
    if (PROVIDER === 'anthropic_compat') raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    else raw = data.choices?.[0]?.message?.content || '';
    if (!raw) return;
    // Reattach the prefilled "{" and try strict parse first; fall back to
    // regex-extract if the provider returned extra prose.
    if (anthropicPrefilled) raw = '{' + raw;
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch {
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      if (jsonStart < 0 || jsonEnd <= jsonStart) return;
      try { parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)); } catch { return; }
    }
    const memos = Array.isArray(parsed?.memories) ? parsed.memories : [];
    if (!memos.length) return;

    // Fuzzy dedup against the full pool (not just last 7 days).
    const existing = cache.slice();
    let added = 0;
    for (const m of memos) {
      const validated = _memValidateExtracted(m);
      if (!validated) continue;
      if (_memIsDuplicateFuzzy(validated.content, existing)) continue;
      const saved = await memSave({
        content: validated.content,
        tags: validated.tags,
        type: validated.type,
        source: 'auto',
        convId: convId || activeConvId || null,
        sourceTurn: Number.isFinite(lc) ? lc : null,
        supersedesIds: validated.supersedesIds
      });
      existing.push(saved);
      added++;
    }
    if (added > 0 && typeof logMemEntry === 'function') logMemEntry('read', `Extracted ${added} memory item${added === 1 ? '' : 's'}`);
    if (added > 0 && document.getElementById('memoryModal')?.classList.contains('show')) renderMemoryList();
  } catch (e) { console.warn('memExtract failed', e); }
  finally { _memExtractInFlight.delete(memKey); }
}

// ── UI ────────────────────────────────────────────────────────────────
function renderMemoryButton() {
  const btn = document.getElementById('memBtn');
  if (!btn) return;
  const enabled = memIsEnabled();
  btn.style.display = enabled ? '' : 'none';
}

async function openMemoryModal() {
  if (!memIsEnabled()) { appendSystemMsg(t('mem.disabledHint')); return; }
  await memLoadCache();
  document.getElementById('memSearchInput').value = '';
  document.getElementById('memFilterType').value = '';
  document.getElementById('memFilterSource').value = '';
  const retiredEl = document.getElementById('memShowRetired');
  if (retiredEl) retiredEl.checked = false;
  document.getElementById('memAddContent').value = '';
  document.getElementById('memAddTags').value = '';
  document.getElementById('memAddType').value = 'fact';
  renderMemoryList();
  document.getElementById('memoryModal').classList.add('show');
}
function closeMemoryModal() { document.getElementById('memoryModal').classList.remove('show'); }

function _memCollectTags(records) {
  const counts = new Map();
  for (const r of records) for (const t of (r.tags || [])) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 14);
}

let _memActiveTag = '';
function memFilterByTag(tag) {
  _memActiveTag = _memActiveTag === tag ? '' : tag;
  renderMemoryList();
}

function renderMemoryList() {
  const listEl = document.getElementById('memList');
  if (!listEl || !_memCache) return;
  const q = (document.getElementById('memSearchInput')?.value || '').toLowerCase().trim();
  const typeFilter = document.getElementById('memFilterType')?.value || '';
  const srcFilter = document.getElementById('memFilterSource')?.value || '';
  const showRetired = !!document.getElementById('memShowRetired')?.checked;
  const now = Date.now();

  let records = _memCache.slice().sort((a, b) => {
    // Retired records sink to the bottom; then pinned first; then by updatedAt desc.
    const ra = a.superseded ? 1 : 0, rb = b.superseded ? 1 : 0;
    if (ra !== rb) return ra - rb;
    if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  if (!showRetired) records = records.filter(r => !r.superseded);
  if (typeFilter) records = records.filter(r => r.type === typeFilter);
  if (srcFilter) records = records.filter(r => (r.source || 'manual') === srcFilter);
  if (_memActiveTag) records = records.filter(r => (r.tags || []).includes(_memActiveTag));
  if (q) records = records.filter(r => {
    if (r.content.toLowerCase().includes(q)) return true;
    if ((r.tags || []).some(t => t.toLowerCase().includes(q))) return true;
    if ((r.type || '').toLowerCase().includes(q)) return true;
    return false;
  });

  // Tag chip rail — computed over the visible pool (respects the show-retired toggle).
  const tagEl = document.getElementById('memTagChips');
  if (tagEl) {
    const tagPool = showRetired ? _memCache : _memCache.filter(r => !r.superseded);
    const pairs = _memCollectTags(tagPool);
    tagEl.innerHTML = pairs.map(([t, n]) => `<button type="button" onclick="memFilterByTag('${esc(t)}')" style="padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:${_memActiveTag === t ? 'var(--accent-orange)' : 'transparent'};color:${_memActiveTag === t ? '#fff' : 'var(--text-secondary)'};font-size:10px;cursor:pointer;font-family:'JetBrains Mono',monospace">#${esc(t)} <span style="opacity:.6">${n}</span></button>`).join('');
  }

  const retiredCount = _memCache.filter(r => r.superseded).length;
  const statsEl = document.getElementById('memStats');
  if (statsEl) statsEl.textContent = `${records.length} shown · ${_memCache.length} total${retiredCount ? ` · ${retiredCount} retired` : ''}${_memActiveTag ? ` · filter: #${_memActiveTag}` : ''}`;

  if (!records.length) {
    listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:11px">${_memCache.length ? 'No memories match current filters.' : 'No memories yet. Auto-extraction will save durable facts as you chat, or the agent can call memory_save.'}</div>`;
    return;
  }

  listEl.innerHTML = records.map(r => {
    const dateStr = _memDateLabel(r.createdAt);
    const relStr = _memRelativeLabel(r.createdAt, now);
    const tagHtml = (r.tags || []).map(t => `<span style="padding:1px 6px;background:var(--bg-root);border-radius:8px;font-size:10px;color:var(--text-secondary);font-family:'JetBrains Mono',monospace">#${esc(t)}</span>`).join(' ');
    const srcLabel = r.source || 'manual';
    const typeColor = r.type === 'preference' ? 'var(--accent-orange)' : r.type === 'event' ? 'var(--accent-cyan)' : r.type === 'skill' ? '#b388ff' : r.type === 'note' ? 'var(--text-dim)' : 'var(--text-secondary)';
    const retired = !!r.superseded;
    const replacedHint = retired && r.supersededBy ? `<span>\u00B7</span><span title="Replaced by" style="color:var(--accent-cyan)">\u21B3 ${esc(r.supersededBy.slice(0, 12))}</span>` : retired ? `<span>\u00B7</span><span style="color:var(--text-dim)">retired</span>` : '';
    const retiresHint = Array.isArray(r.supersedes) && r.supersedes.length ? `<span>\u00B7</span><span title="This memory retires ${r.supersedes.length} older one(s)">retires ${r.supersedes.length}</span>` : '';
    return `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--bg-panel);opacity:${retired ? '0.55' : '1'}">
      <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:4px">
        <div style="flex:1;font-size:12px;color:var(--text-primary);line-height:1.5;word-break:break-word;${retired ? 'text-decoration:line-through' : ''}">${esc(r.content)}</div>
        <button type="button" title="${r.pinned ? 'Unpin' : 'Pin'}" onclick="memTogglePin('${r.id}')" style="background:transparent;border:none;color:${r.pinned ? 'var(--accent-orange)' : 'var(--text-dim)'};cursor:pointer;font-size:14px;padding:0 4px">${iconHtml('i:pin')}</button>
        <button type="button" title="Delete" onclick="memDeleteFromUI('${r.id}')" style="background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:12px;padding:0 4px">${iconHtml('i:x')}</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:10px;color:var(--text-dim);font-family:'JetBrains Mono',monospace">
        <span style="color:${typeColor}">${esc(r.type || 'fact')}</span>
        <span>\u00B7</span>
        <span title="id">${esc(r.id.slice(0, 12))}</span>
        <span>\u00B7</span>
        <span>${esc(dateStr)} (${esc(relStr)})</span>
        <span>\u00B7</span>
        <span>${esc(srcLabel)}</span>
        ${r.recallCount ? `<span>\u00B7</span><span title="Times injected into prompt">recalled ${r.recallCount}\u00D7</span>` : ''}
        ${retiresHint}
        ${replacedHint}
        ${tagHtml ? `<span>\u00B7</span>${tagHtml}` : ''}
      </div>
    </div>`;
  }).join('');
}

async function memAddFromUI() {
  const content = document.getElementById('memAddContent').value.trim();
  if (!content) return;
  const tags = document.getElementById('memAddTags').value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const type = document.getElementById('memAddType').value || 'fact';
  await memSave({ content, tags, type, source: 'manual' });
  document.getElementById('memAddContent').value = '';
  document.getElementById('memAddTags').value = '';
  renderMemoryList();
}

async function memDeleteFromUI(id) {
  if (!confirm('Delete this memory?')) return;
  await memDelete(id);
  renderMemoryList();
}

async function memTogglePin(id) {
  const rec = _memCache?.find(m => m.id === id);
  if (!rec) return;
  await memUpdate(id, { pinned: !rec.pinned });
  renderMemoryList();
}

function memExport() {
  const all = _memCache || [];
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: Date.now(), memories: all }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'onepagent-memories-' + _memDateLabel(Date.now()) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function memImport() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const file = inp.files?.[0]; if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (Array.isArray(data.memories) ? data.memories : []);
      if (!list.length) { alert('No memories found in file.'); return; }
      let added = 0, updated = 0, skipped = 0;
      for (const m of list) {
        const result = await _memMergeIncoming(m);
        if (result === 'added') added++;
        else if (result === 'updated') updated++;
        else skipped++;
      }
      renderMemoryList();
      alert(`Import done — added ${added}, updated ${updated}, skipped ${skipped}.`);
    } catch (e) { alert('Import failed: ' + e.message); }
  };
  inp.click();
}

async function memClearAll() {
  if (!confirm('Delete ALL long-term memories? This cannot be undone.')) return;
  await memClearStorage();
  renderMemoryList();
}

// ── Tool handlers ─────────────────────────────────────────────────────
async function toolMemorySave(input) {
  if (!memIsEnabled()) return 'Error: long-term memory is disabled in Settings.';
  const content = (input?.content || '').trim();
  if (!content) return 'Error: content is required.';
  const tags = Array.isArray(input?.tags) ? input.tags : [];
  const type = ['fact','preference','event','skill','note'].includes(input?.type) ? input.type : 'fact';
  const supersedesIds = Array.isArray(input?.supersedes_ids)
    ? input.supersedes_ids.filter(s => typeof s === 'string' && s.startsWith('mem_'))
    : [];
  const rec = await memSave({ content, tags, type, source: 'tool', supersedesIds });
  if (document.getElementById('memoryModal')?.classList.contains('show')) renderMemoryList();
  const supersedesHint = rec.supersedes.length ? `, retired ${rec.supersedes.length} old memor${rec.supersedes.length === 1 ? 'y' : 'ies'}` : '';
  return `Saved memory ${rec.id} (${rec.type}${rec.tags.length ? ', tags: ' + rec.tags.map(t => '#' + t).join(' ') : ''}${supersedesHint}).`;
}

async function toolMemoryUpdate(input) {
  if (!memIsEnabled()) return 'Error: long-term memory is disabled in Settings.';
  const id = String(input?.id || '').trim();
  if (!id) return 'Error: id is required.';
  const cache = await memLoadCache();
  const rec = cache.find(m => m.id === id);
  if (!rec) return `Error: memory ${id} not found.`;
  const patch = {};
  if (typeof input.content === 'string') {
    const t = input.content.trim();
    if (t.length < 4 || t.length > 400) return 'Error: content must be 4-400 chars.';
    patch.content = t;
  }
  if (Array.isArray(input.tags)) patch.tags = _memSanitizeTags(input.tags);
  if (['fact','preference','event','skill','note'].includes(input.type)) patch.type = input.type;
  if (typeof input.pinned === 'boolean') patch.pinned = input.pinned;
  if (!Object.keys(patch).length) return 'Error: provide at least one of content / tags / type / pinned.';
  const updated = await memUpdate(id, patch);
  if (document.getElementById('memoryModal')?.classList.contains('show')) renderMemoryList();
  return `Updated memory ${id} (${Object.keys(patch).join(', ')}).`;
}

async function toolMemoryForget(input) {
  if (!memIsEnabled()) return 'Error: long-term memory is disabled in Settings.';
  const id = String(input?.id || '').trim();
  if (!id) return 'Error: id is required.';
  const cache = await memLoadCache();
  const rec = cache.find(m => m.id === id);
  if (!rec) return `Error: memory ${id} not found.`;
  if (rec.superseded) return `Memory ${id} was already retired.`;
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  const newTags = _memSanitizeTags([...(rec.tags || []), reason ? 'forgotten:' + reason.slice(0, 30).replace(/\s+/g, '-') : 'forgotten']);
  await memUpdate(id, { tags: newTags });
  // Then mark superseded without a replacement (supersededBy stays null).
  await memUpdate(id, { superseded: true, supersededBy: null });
  if (document.getElementById('memoryModal')?.classList.contains('show')) renderMemoryList();
  return `Forgot memory ${id}${reason ? ` (reason: ${reason})` : ''}. It will no longer be recalled.`;
}

async function toolMemorySearch(input) {
  if (!memIsEnabled()) return 'Error: long-term memory is disabled in Settings.';
  const q = (input?.query || '').trim();
  const limit = Math.min(25, Math.max(1, Number(input?.limit) || 8));
  const includeSuperseded = !!input?.include_superseded;
  const all = await memLoadCache();
  let pool = includeSuperseded ? all : all.filter(r => !r.superseded);
  if (Array.isArray(input?.tags) && input.tags.length) {
    const want = new Set(input.tags.map(t => String(t).toLowerCase()));
    pool = pool.filter(r => (r.tags || []).some(t => want.has(t)));
  }
  if (!pool.length) return 'No memories match the tag filter.';
  const ranked = memRank(pool, q, { limit });
  if (!ranked.length) return 'No memories found.';
  const now = Date.now();
  return ranked.map(({ rec, score }) => {
    const tagStr = (rec.tags || []).map(t => '#' + t).join(' ');
    const retiredHint = rec.superseded ? ', retired' : '';
    return `- {${rec.id}} [${_memDateLabel(rec.createdAt)}, ${_memRelativeLabel(rec.createdAt, now)}${tagStr ? ', ' + tagStr : ''}${rec.pinned ? ', pinned' : ''}${retiredHint}] (score ${score.toFixed(2)}) ${rec.content}`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (dynamic — includes skill tools)
// ═══════════════════════════════════════════════════════════════════
const BASE_TOOLS_ANTHROPIC = [
  { name: 'Read', description: 'Read file contents from the virtual filesystem (returns with line numbers), or load a skill resource on demand using @skill:name/references/file.md or @skill:name/scripts/file.py.', input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Path to file, or @skill:<name>/references/<file> for skill resources' }, offset: { type: 'integer', description: 'Start line (0-based)' }, limit: { type: 'integer', description: 'Number of lines' } }, required: ['file_path'] } },
  { name: 'Write', description: 'Write content to a file. Creates parent directories as needed.', input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Path to the file' }, content: { type: 'string', description: 'Content to write' } }, required: ['file_path', 'content'] } },
  { name: 'Edit', description: 'Replace an exact string match in a file. old_str must match exactly once.', input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Path to the file' }, old_str: { type: 'string', description: 'Exact string to find' }, new_str: { type: 'string', description: 'Replacement string' } }, required: ['file_path', 'old_str', 'new_str'] } },
  { name: 'Glob', description: 'Find files matching a glob pattern. Returns list of paths.', input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern' }, path: { type: 'string', description: 'Base directory' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents with regex. Returns matching lines with paths.', input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' }, path: { type: 'string', description: 'File or directory' }, include: { type: 'string', description: 'Glob filter for files' } }, required: ['pattern'] } },
  { name: 'Bash', description: 'Execute a simulated bash command against the virtual filesystem. Supports: ls, cat, find, echo, mkdir, rm, pwd, cd, tree, head, tail, wc, cp, mv, touch, grep.', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'Bash command' } }, required: ['command'] } },
  { name: 'PythonExec', description: 'Execute Python code in an in-browser Pyodide WASM runtime. Use normal shared paths directly (for example /src/main.py, /skills/name/SKILL.md, /outputs/result.txt). Python file access is bridged through workspacefs to the shared browser filesystem — there is no separate project copy to sync later. For text and ordinary path-based APIs, use open(...), pathlib.Path(...), os.path.exists(...), glob.glob(...). For binary files, prefer workspacefs.read_bytes(...) and workspacefs.write_bytes(...). If a library requires a real native temp path, first call workspacefs.materialize_to_tmp(...), then write results back with workspacefs.persist_tmp_file(...). Examples: pathlib.Path("/out.txt").write_text("ok"); data = workspacefs.read_bytes("/in.bin"); workspacefs.write_bytes("/out.bin", data); tmp_in = workspacefs.materialize_to_tmp("/in.pptx", binary=True); workspacefs.persist_tmp_file("/tmp/out.pptx", "/outputs/out.pptx", binary=True).', input_schema: { type: 'object', properties: { code: { type: 'string', description: 'Python code to execute. Preferred file strategy: use normal shared paths directly; use workspacefs.read_bytes/write_bytes for binary data; use workspacefs.materialize_to_tmp(...) and workspacefs.persist_tmp_file(...) only when a library requires a native /tmp path. Minimal examples: pathlib.Path("/out.txt").write_text("ok"), workspacefs.write_bytes("/out.bin", workspacefs.read_bytes("/in.bin")), tmp = workspacefs.materialize_to_tmp("/in.pptx", binary=True).' }, packages: { type: 'array', items: { type: 'string' }, description: 'Pure-Python packages to install via micropip' } }, required: ['code'] } },
  { name: 'JSExec', description: 'Execute JavaScript code in an in-browser sandbox. Has direct access to the virtual filesystem via vfsRead/vfsWrite for text, async vfsReadBinary/vfsWriteBinary for binary data (use await), vfsStat for metadata, plus vfsGlob/vfsGrep. Can use fetch() for HTTP requests and console.log for output.', input_schema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript code to execute. Wrap top-level awaits by returning an async IIFE or a Promise. Available APIs: vfsRead(path), vfsWrite(path,content), await vfsReadBinary(path), await vfsWriteBinary(path,bytes), vfsStat(path), vfsGlob(pattern), vfsGrep(pattern,path), fetch().' } }, required: ['code'] } },
  { name: 'NodeExec', description: 'Execute Node.js-compatible JavaScript in a browser WebContainer. Unlike JSExec, this runs in a Node-like runtime with Node APIs. Requires HTTPS/localhost and cross-origin isolation. The WebContainer filesystem is separate from the VFS: use sync_in to copy selected VFS files/directories before execution and sync_out to copy selected outputs back. Inline code defaults to module_type: "module"; use ESM import syntax in module mode, not require().', input_schema: { type: 'object', properties: { code: { type: 'string', description: 'Inline Node.js code to execute. Mutually exclusive with script_path. Defaults to ESM module mode, so use import syntax unless module_type is commonjs.' }, script_path: { type: 'string', description: 'VFS path to a JavaScript file to run with node. The script file is synced automatically if not already included in sync_in.' }, module_type: { type: 'string', enum: ['module', 'commonjs'], description: 'For inline code only. Defaults to module. module requires import syntax; commonjs allows require().' }, args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the Node script.' }, cwd: { type: 'string', description: 'Working directory inside the WebContainer. Defaults to /.' }, env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables for the process.' }, timeout_ms: { type: 'integer', description: 'Execution timeout in milliseconds. Defaults to 10000 and is capped at 1200000 (1200s).' }, sync_in: { type: 'array', items: { type: 'object', properties: { source_path: { type: 'string' }, target_path: { type: 'string' }, overwrite: { type: 'boolean' }, include: { type: 'string' }, exclude: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, max_files: { type: 'integer' }, max_bytes: { type: 'integer' } }, required: ['source_path'] }, description: 'Explicit VFS files/directories to copy into WebContainer before execution.' }, sync_out: { type: 'array', items: { type: 'object', properties: { source_path: { type: 'string' }, target_path: { type: 'string' }, overwrite: { type: 'boolean' }, binary: { type: 'boolean' }, include: { type: 'string' }, exclude: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, max_files: { type: 'integer' }, max_bytes: { type: 'integer' } }, required: ['source_path'] }, description: 'Explicit WebContainer files/directories to copy back into VFS after execution.' }, allow_root_sync: { type: 'boolean', description: 'Allow syncing / as a source. Defaults to false for safety.' } } } },
  { name: 'WebSearch', description: 'Search the web using Tavily AI. Returns titles, URLs, and content snippets for relevant results. Requires a Tavily API key configured in the Web Search panel on the right sidebar.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Search depth: basic (fast) or advanced (thorough). Defaults to panel setting.' }, max_results: { type: 'integer', description: 'Maximum results to return (1-10). Defaults to panel setting.' }, include_domains: { type: 'array', items: { type: 'string' }, description: 'Restrict results to these domains (optional).' }, exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains from results (optional).' } }, required: ['query'] } },
  { name: 'Fetch', description: 'Fetch a webpage by URL and return readable page content. Useful for retrieving the contents of a specific web page.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' }, max_chars: { type: 'integer', description: 'Maximum number of characters to return from the cleaned page text. Default 12000.' } }, required: ['url'] } },
  { name: 'RunSubAgent', description: 'Delegate a bounded read-only research task to a nested sub-agent. The sub-agent can inspect files, search, fetch, and summarize, but cannot edit files, execute code, ask the user, use MCP tools, or spawn more sub-agents.', input_schema: { type: 'object', properties: { task: { type: 'string', description: 'Specific task for the sub-agent to perform.' }, context: { type: 'string', description: 'Optional background, constraints, or expected output format.' }, max_steps: { type: 'integer', description: 'Maximum model/tool iterations. Defaults to 4 and is capped at 8.' } }, required: ['task'] } },
  { name: 'SwarmSpawn', description: 'Delegate a focused task to a role-scoped swarm worker (e.g. researcher, critic, writer, coder). Issuing multiple SwarmSpawn tool_use blocks in a single turn runs them in PARALLEL up to the configured concurrency cap — prefer this over sequential RunSubAgent calls for breadth-first work. Each worker has its own role contract, tool whitelist, and token budget. Workers cannot spawn workers, ask the user, or use MCP. Available only when Agent Swarm is enabled in Settings.', input_schema: { type: 'object', properties: { role: { type: 'string', description: 'Worker role id. Built-ins: researcher, critic, writer, coder.' }, task: { type: 'string', description: 'Specific objective for this worker (one focused sub-question or sub-task).' }, output_format: { type: 'string', description: 'Required shape of the final answer (e.g. "bulleted list with URL citations", "markdown table with columns X/Y/Z").' }, context: { type: 'string', description: 'Optional background passed to the worker.' } }, required: ['role', 'task'] } },
  { name: 'SwarmStatus', description: 'Inspect the current swarm run: active workers, token usage, recent results. Use when a previous SwarmSpawn batch returned errors and you need to decide whether to retry or stop.', input_schema: { type: 'object', properties: {} } },
  { name: 'SwarmAbort', description: 'Mark the current swarm run as aborted; in-flight workers will exit at their next budget check. Use only when the user signals to stop, or when the task is clearly off-track.', input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'Short reason shown to the user.' } } } },
  { name: 'RoleManager', description: 'Lead-only tool: create, edit, or remove custom Swarm worker roles for the current task. Roles created here become callable via SwarmSpawn immediately. Built-in roles (researcher / critic / writer / coder) and user-authored UI roles cannot be modified or deleted by this tool — only roles you (the agent) create. Persistence and per-conversation isolation are user-controlled in Settings; call list first to inspect what already exists. Risky operations (delete, large-prompt overwrite) require confirmed=true. Available only when both Agent Swarm and "Allow agent to manage roles" are enabled.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'inspect', 'create', 'update', 'delete', 'duplicate'], description: 'list = summarize all roles across tiers; inspect = full role JSON; create = add a new agent-owned role; update = change one of your agent-owned roles; delete = remove an agent-owned role; duplicate = copy any role into the agent tier under a new id.' }, id: { type: 'string', description: 'Target role id for inspect/update/delete/duplicate.' }, role: { type: 'object', description: 'Role definition for create / update. Required fields: id (kebab-case), name, systemPrompt. Optional: description, allowedTools[], allowedHandoffs[], bindSkills[] (skill ids), maxSteps (1-30), tokenBudget (5000-200000), defaultModel, enabled.', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, systemPrompt: { type: 'string' }, allowedTools: { type: 'array', items: { type: 'string' } }, allowedHandoffs: { type: 'array', items: { type: 'string' } }, bindSkills: { type: 'array', items: { type: 'string' } }, maxSteps: { type: 'integer' }, tokenBudget: { type: 'integer' }, defaultModel: { type: 'string' }, enabled: { type: 'boolean' } } }, newId: { type: 'string', description: 'For duplicate: id of the new copy. Defaults to <id>-copy or -copy-N to avoid collision.' }, confirmed: { type: 'boolean', description: 'Set true to acknowledge a risky operation: delete, or update that overwrites a substantially different role.' }, dry_run: { type: 'boolean', description: 'Validate and report what would change without applying.' } }, required: ['action'] } },
  { name: 'SwarmHandoff', description: 'Worker-only routine handoff: pass control to the next role in the chain (OpenAI Swarm-style). Available ONLY inside a swarm worker — the lead agent must use SwarmSpawn instead. After a successful handoff, this worker stops; the next worker receives your final text plus the brief and produces the next link of the chain. The originating SwarmSpawn returns the merged chain output to the lead.', input_schema: { type: 'object', properties: { target_role: { type: 'string', description: 'Next role id. Must be in this role\'s allowedHandoffs list and not already in the current chain.' }, brief: { type: 'string', description: 'What the next worker must do. Be specific and self-contained — assume they only read your final text + this brief.' }, output_format: { type: 'string', description: 'Optional override of the output format requested for the next worker.' } }, required: ['target_role', 'brief'] } },
  { name: 'bb_write', description: 'Write a note / result to the swarm blackboard (a per-turn shared workspace). Use clear keys (e.g. "tradeoffs/langgraph") and tags so other workers can find it. Append-only — entries are not deleted. Cap: 200 entries per turn, 4000 chars per entry.', input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Short label, e.g. "summary/openai-swarm".' }, content: { type: 'string', description: 'The note or result text.' }, type: { type: 'string', enum: ['note', 'result', 'task'], description: 'Default note. Use result for finished outputs that consumers should pick up; use task only via bb_post_task.' }, tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags for retrieval.' } }, required: ['content'] } },
  { name: 'bb_read', description: 'Read full content of matching blackboard entries (newest first). Filter by query (substring), key, type, or tags. Returns up to 20.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Substring filter against key + content + tags.' }, key: { type: 'string', description: 'Exact key match.' }, type: { type: 'string', enum: ['note', 'result', 'task'] }, tags: { type: 'array', items: { type: 'string' }, description: 'All tags must be present.' }, since: { type: 'integer', description: 'Unix ms; only entries newer than this.' }, limit: { type: 'integer', description: 'Max entries (default 8, max 20).' } } } },
  { name: 'bb_list', description: 'List blackboard entries (key, type, source, claim status) without expanding content. Cheap way to survey what other workers have produced before deciding to bb_read.', input_schema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string', enum: ['note', 'result', 'task'] }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'bb_post_task', description: 'Broadcast a task on the blackboard for another worker in this run to claim. Use when work could be done in parallel by another role and you don\'t want to spawn it directly. Returns the task id; consumers call bb_claim(id).', input_schema: { type: 'object', properties: { brief: { type: 'string', description: 'What the task is.' }, key: { type: 'string', description: 'Optional key; auto-generated if omitted.' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['brief'] } },
  { name: 'bb_claim', description: 'Claim a posted task before working on it. Prevents duplicate work. Returns the brief; write your result back via bb_write({type:"result", key:<task key>, ...}) when done.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Blackboard entry id (e.g. bb_a1).' } }, required: ['id'] } },
  { name: 'GenerateImage', description: 'Generate an image from a text prompt, or edit/transform attached images when input_image_paths is provided. Use this directly in normal chat when the user asks for image generation; no special mode switch is required. The prompt must be a complete, polished generation prompt synthesized from the user\'s latest request plus relevant conversation history, not just a verbatim copy of the last message. Saves outputs under /generations and returns generated file paths.', input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'Complete image prompt or edit instruction, incorporating relevant user requirements and conversation context.' }, input_image_paths: { type: 'array', items: { type: 'string' }, description: 'Optional VFS image paths to use for image-to-image editing or variation.' }, model: { type: 'string', description: 'Optional image model override. Defaults to the provider default image model.' } }, required: ['prompt'] } },
  { name: 'GenerateVideo', description: 'Generate a video from a text prompt, or from an attached image plus prompt when input_image_paths is provided. Use this directly in normal chat when the user asks for video generation; no special mode switch is required. The prompt must be a complete, polished generation prompt synthesized from the user\'s latest request plus relevant conversation history, not just a verbatim copy of the last message. Saves outputs under /generations and returns generated file paths.', input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'Complete video prompt or animation instruction, incorporating relevant user requirements and conversation context.' }, input_image_paths: { type: 'array', items: { type: 'string' }, description: 'Optional VFS image paths; the first valid image is used for image-to-video.' }, model: { type: 'string', description: 'Optional video model override. Defaults to the provider default video model.' } }, required: ['prompt'] } },
  { name: 'SkillManager', description: 'Manage installed skills in the left Skills panel. Supports listing, inspecting, creating, installing from SKILL.md text, JSON, GitHub skill folder URLs, or current workspace VFS paths, updating, enabling/disabling, and removing skills. Write actions modify persisted skills and may require confirmed=true for risky operations such as delete, overwrite, executable handlers, tools, scripts, remote install, or workspace install.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'inspect', 'create', 'install_from_markdown', 'install_from_json', 'install_from_github', 'install_from_workspace', 'update', 'set_active', 'remove'], description: 'Skill management action.' }, id: { type: 'string', description: 'Skill id for inspect/update/set_active/remove.' }, name: { type: 'string', description: 'Skill name for inspect/update/set_active/remove.' }, markdown: { type: 'string', description: 'Full SKILL.md content for install_from_markdown.' }, skill: { type: 'object', description: 'Skill object for create or install_from_json.' }, url: { type: 'string', description: 'GitHub repository or folder URL for install_from_github, e.g. https://github.com/owner/repo/tree/main/path/to/skill.' }, repoUrl: { type: 'string', description: 'Alternative GitHub URL field for install_from_github.' }, branch: { type: 'string', description: 'GitHub branch or tag. Optional when the URL includes /tree/<branch>/.' }, path: { type: 'string', description: 'For install_from_github: path to the skill folder in the repository. For install_from_workspace: VFS path to a skill directory or its SKILL.md file.' }, updates: { type: 'object', description: 'Partial fields to update. Renaming is not supported.' }, active: { type: 'boolean', description: 'Desired active state for set_active.' }, dry_run: { type: 'boolean', description: 'Validate and summarize without applying changes.' }, confirmed: { type: 'boolean', description: 'Set true only after explicit user confirmation for risky write operations.' } }, required: ['action'] } },
  { name: 'TodoWrite', description: 'Maintain a user-visible task list for the current session. Use this proactively on multi-step work so the user can track progress. Each todo has: content (imperative form, e.g. "Run tests"), activeForm (present continuous, e.g. "Running tests"), status (pending | in_progress | completed). Exactly one task should be in_progress at a time. Update the full list on every change; this tool overwrites the prior list.', input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string', description: 'Imperative description of the task.' }, activeForm: { type: 'string', description: 'Present-continuous description shown while in progress.' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status.' } }, required: ['content', 'activeForm', 'status'] } } }, required: ['todos'] } },
  { name: 'AskUser', description: 'Ask the user for clarification, suggestions, confirmation, or a choice before continuing. Use this when user input is needed to make a decision, resolve ambiguity, or get approval for a non-plan-mode step. This pauses the agent loop until the user responds.', input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'The question or request to show to the user. Be concise and include enough context for the user to answer.' }, mode: { type: 'string', enum: ['text', 'choice', 'confirm'], description: 'Input mode. text asks for freeform input, choice asks the user to select one option, confirm asks for yes/no. Defaults to text.' }, choices: { type: 'array', items: { type: 'string' }, description: 'Options to show when mode is choice. Use short, distinct labels.' }, default_choice: { type: 'string', description: 'Optional default choice or suggested answer.' }, allow_custom: { type: 'boolean', description: 'For choice mode, whether the user may provide a custom response instead of selecting one of the choices. Defaults to false.' }, context: { type: 'string', description: 'Optional additional background to display below the main prompt.' } }, required: ['prompt'] } },
  { name: 'CronCreate', description: 'Create a scheduled task that fires a prompt at cron-matched times. Each fire opens a fresh conversation. Standard 5-field cron in local timezone: "minute hour day-of-month month day-of-week" (e.g. "0 9 * * 1-5" = weekdays at 9am). Use recurring=false for one-shot reminders. The task runs only while this browser tab is open. Risky write — set confirmed=true only after explicit user approval, otherwise the user is prompted via AskUser.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Short human-readable label (<=80 chars).' }, cron: { type: 'string', description: '5-field cron expression. Avoid minute=0 / 30 unless the user explicitly named that exact time — pick a 1-59 minute to spread load.' }, prompt: { type: 'string', description: 'The user message that will be sent into the new conversation when the task fires.' }, recurring: { type: 'boolean', description: 'true = fire on every cron match; false = fire once then auto-delete.' }, modelOverride: { type: 'string', description: 'Optional model id to use for this task (e.g. claude-haiku-4-5 to keep cost low).' }, maxRunMinutes: { type: 'integer', description: 'Optional hard cap on a single fire\'s wall-clock duration. 1-120.' }, folderId: { type: 'string', description: 'Optional conversation folder id; created conversation will be placed in that folder.' }, confirmed: { type: 'boolean', description: 'Set true only after the user explicitly approved creation. Otherwise the tool will surface an AskUser confirmation.' } }, required: ['name', 'cron', 'prompt', 'recurring'] } },
  { name: 'CronDelete', description: 'Delete a scheduled task by id. Risky write — set confirmed=true only after the user explicitly approved deletion.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Task id (e.g. cron_xxx). Use CronList to look it up.' }, confirmed: { type: 'boolean', description: 'Set true only after the user explicitly approved deletion.' } }, required: ['id'] } },
  { name: 'CronList', description: 'List all scheduled tasks (id, name, cron, recurring, enabled, next fire time, last fire time, fire count). Read-only.', input_schema: { type: 'object', properties: {} } },
  { name: 'ExitPlanMode', description: 'Call this ONLY while Plan Mode is active and your plan is ready for user approval. Pass the full plan as Markdown. The user gets an Approve/Reject dialog. If approved, Plan Mode exits and you may execute write tools on the next turn. If rejected, you receive the user\'s feedback and must revise the plan while staying in Plan Mode.', input_schema: { type: 'object', properties: { plan: { type: 'string', description: 'Complete, reviewable plan in Markdown.' } }, required: ['plan'] } },
];

const PYODIDE_NATIVE_TOOLS = [
  { name: 'VfsToPyodide', description: 'Copy a file or directory from the virtual filesystem into Pyodide native filesystem, usually under /tmp, for Python libraries that require a real native path. Available only after Pyodide has loaded.', input_schema: { type: 'object', properties: { source_path: { type: 'string', description: 'Source path in VFS, e.g. /assets/input.xlsx or /work/data.' }, target_path: { type: 'string', description: 'Destination path in Pyodide native FS. Defaults to /tmp/<source name>. If a directory is given for a file source, the original filename is used inside it.' }, overwrite: { type: 'boolean', description: 'Overwrite existing Pyodide native files. Defaults to true.' } }, required: ['source_path'] } },
  { name: 'PyodideToVfs', description: 'Copy a file or directory from Pyodide native filesystem back into the virtual filesystem. Use after a Python library writes outputs under /tmp. Available only after Pyodide has loaded.', input_schema: { type: 'object', properties: { source_path: { type: 'string', description: 'Source path in Pyodide native FS, e.g. /tmp/output.xlsx or /tmp/results.' }, target_path: { type: 'string', description: 'Destination path in VFS. Defaults to /outputs/<source name>. If a directory is given for a file source, the original filename is used inside it.' }, overwrite: { type: 'boolean', description: 'Overwrite existing VFS files. Defaults to true.' }, binary: { type: 'boolean', description: 'Optional override for file encoding. Defaults to binary detection by extension.' } }, required: ['source_path'] } },
];

let allToolsAnthropic = [...BASE_TOOLS_ANTHROPIC];
let allToolsOpenAI = [];
let skillToolHandlers = {};
let disabledTools = new Set();
try { const dt = localStorage.getItem('ba_disabled_tools'); if (dt) disabledTools = new Set(JSON.parse(dt)); } catch {}

