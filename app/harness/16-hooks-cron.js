/* creel harness — part 16 of 26: hooks-cron
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
 *   - HOOKS RUNTIME — user-defined JS handlers for agent lifecycle events
 *   - CRON SCHEDULER — periodic / one-shot prompt scheduling (tab-only)
 */
// ═══════════════════════════════════════════════════════════════════
// HOOKS RUNTIME — user-defined JS handlers for agent lifecycle events
// Events: pre_tool | post_tool | on_error | on_user_submit | on_assistant_response | on_stop | pre_swarm_spawn | post_swarm_spawn | pre_cron_fire | post_cron_fire
// Hook record: { id, name, event, code, enabled }
// ═══════════════════════════════════════════════════════════════════
const HOOKS_KEY = 'ba_hooks';
const HOOK_EVENTS = ['pre_tool', 'post_tool', 'on_error', 'on_user_submit', 'on_assistant_response', 'on_stop', 'pre_swarm_spawn', 'post_swarm_spawn', 'pre_cron_fire', 'post_cron_fire'];
let hooks = [];
try { const s = localStorage.getItem(HOOKS_KEY); if (s) hooks = JSON.parse(s) || []; } catch {}

function saveHooks() {
  try { localStorage.setItem(HOOKS_KEY, JSON.stringify(hooks)); } catch (e) { console.warn('saveHooks failed', e); }
}
function genHookId() { return 'hook_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function runHooks(event, ctx) {
  const matching = hooks.filter(h => h.event === event && h.enabled);
  for (const h of matching) {
    try {
      const fn = new Function('ctx', h.code || '');
      const ret = await fn(ctx);
      if (!ret || typeof ret !== 'object') continue;
      if (ret.note) { if (typeof logMemEntry === 'function') logMemEntry('hook', `[${h.name}] ${ret.note}`); }
      if (ret.block) { ctx._blocked = { by: h.name, reason: ret.reason || 'blocked by hook' }; return ctx; }
      if (ret.overrideInput && typeof ret.overrideInput === 'object') ctx.input = ret.overrideInput;
      if (Object.prototype.hasOwnProperty.call(ret, 'overrideOutput')) ctx.output = ret.overrideOutput;
      if (typeof ret.overrideText === 'string') ctx.text = ret.overrideText;
    } catch (e) {
      if (typeof logMemEntry === 'function') logMemEntry('hook-error', `[${h.name}] ${e.message}`);
      console.warn('Hook error', h.name, e);
    }
  }
  return ctx;
}

let _editingHookId = null;
function openHookModal(id) {
  _editingHookId = id || null;
  const h = id ? hooks.find(x => x.id === id) : null;
  const titleEl = document.getElementById('hookModalTitle');
  const titleKey = h ? 'hookModal.editTitle' : 'hookModal.addTitle';
  titleEl.setAttribute('data-i18n', titleKey);
  titleEl.textContent = t(titleKey);
  document.getElementById('hookName').value = h?.name || '';
  document.getElementById('hookEvent').value = h?.event || 'pre_tool';
  document.getElementById('hookCode').value = h?.code || '';
  document.getElementById('hookEnabled').checked = h ? !!h.enabled : true;
  document.getElementById('hookModalStatus').textContent = '';
  document.getElementById('hookModal').classList.add('show');
}
function closeHookModal() { document.getElementById('hookModal').classList.remove('show'); _editingHookId = null; }
function saveHookFromModal() {
  const name = document.getElementById('hookName').value.trim();
  const event = document.getElementById('hookEvent').value;
  const code = document.getElementById('hookCode').value;
  const enabled = document.getElementById('hookEnabled').checked;
  const status = document.getElementById('hookModalStatus');
  if (!name) { status.textContent = 'Name is required.'; return; }
  if (!HOOK_EVENTS.includes(event)) { status.textContent = 'Invalid event.'; return; }
  try { new Function('ctx', code); }
  catch (e) { status.textContent = 'Syntax error: ' + e.message; return; }
  if (_editingHookId) {
    const i = hooks.findIndex(h => h.id === _editingHookId);
    if (i >= 0) hooks[i] = { ...hooks[i], name, event, code, enabled };
  } else {
    hooks.push({ id: genHookId(), name, event, code, enabled });
  }
  saveHooks();
  renderHooks();
  closeHookModal();
}
function deleteHook(id) {
  if (!confirm('Delete this hook?')) return;
  hooks = hooks.filter(h => h.id !== id);
  saveHooks();
  renderHooks();
}
function toggleHookEnabled(id) {
  const h = hooks.find(x => x.id === id);
  if (!h) return;
  h.enabled = !h.enabled;
  saveHooks();
  renderHooks();
}
function renderHooks() {
  const el = document.getElementById('hooksArea');
  if (!el) return;
  if (!hooks.length) {
    el.innerHTML = '<div style="font-size:10px;color:var(--text-dim);padding:6px">No hooks yet. Click <b>+ Add</b> to create one.</div>';
    return;
  }
  el.innerHTML = hooks.map(h => `
    <div class="hook-item" style="display:flex;align-items:center;gap:6px;cursor:default">
      <input type="checkbox" ${h.enabled ? 'checked' : ''} onchange="toggleHookEnabled('${h.id}')" title="Enable/disable" style="margin:0;cursor:pointer">
      <span class="h-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-bolt"></use></svg></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;${h.enabled ? '' : 'opacity:0.5;'}" onclick="openHookModal('${h.id}')" title="Edit">${esc(h.name)} <span style="color:var(--text-dim);font-size:10px">${esc(h.event)}</span></span>
      <button class="skill-install-btn" style="flex:none;margin:0;padding:2px 6px;font-size:10px" onclick="deleteHook('${h.id}')" title="Delete">&times;</button>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════════
// CRON SCHEDULER — periodic / one-shot prompt scheduling (tab-only)
// Storage: ba_cron_tasks_v1 (task list), ba_cron_enabled (global flag)
// 5-field cron: minute hour day-of-month month day-of-week (local TZ)
// Each fire creates a fresh conversation. Mutually exclusive with Ralph Loop.
// ═══════════════════════════════════════════════════════════════════
const CronScheduler = (function () {
  const TASKS_KEY = 'ba_cron_tasks_v1';
  const ENABLED_KEY = 'ba_cron_enabled';
  const TICK_MS = 30000;
  const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]; // dow 0=Sunday
  let tasks = [];
  let tickHandle = null;
  let isFiring = false;

  function parseField(spec, range) {
    const [lo, hi] = range;
    if (spec === '*') return { all: true };
    const out = new Set();
    for (const part of String(spec).split(',')) {
      if (!part) return null;
      // "*/N"
      let m = part.match(/^\*\/(\d+)$/);
      if (m) {
        const step = parseInt(m[1], 10);
        if (!Number.isInteger(step) || step <= 0) return null;
        for (let v = lo; v <= hi; v++) if ((v - lo) % step === 0) out.add(v);
        continue;
      }
      // "A", "A-B", "A-B/C", "A/C"
      m = part.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/);
      if (!m) return null;
      const a = parseInt(m[1], 10);
      const b = m[2] !== undefined ? parseInt(m[2], 10) : (m[3] !== undefined ? hi : a);
      const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
      if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(step) || step <= 0) return null;
      if (a < lo || a > hi || b < lo || b > hi || a > b) return null;
      for (let v = a; v <= b; v += step) out.add(v);
    }
    if (!out.size) return null;
    return { all: false, vals: out };
  }

  function parseCron(expr) {
    if (typeof expr !== 'string') return null;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const fields = [];
    for (let i = 0; i < 5; i++) {
      const f = parseField(parts[i], FIELD_RANGES[i]);
      if (!f) return null;
      fields.push(f);
    }
    return fields;
  }

  function fieldMatches(f, val) { return f.all || f.vals.has(val); }

  function matchTime(fields, d) {
    return fieldMatches(fields[0], d.getMinutes())
      && fieldMatches(fields[1], d.getHours())
      && fieldMatches(fields[2], d.getDate())
      && fieldMatches(fields[3], d.getMonth() + 1)
      && fieldMatches(fields[4], d.getDay());
  }

  function nextFireTime(expr, fromMs) {
    const fields = parseCron(expr);
    if (!fields) return null;
    const start = new Date(typeof fromMs === 'number' ? fromMs : Date.now());
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1); // strictly after the given time
    const cap = start.getTime() + 366 * 24 * 60 * 60 * 1000; // 1 year horizon
    const d = new Date(start);
    while (d.getTime() <= cap) {
      if (matchTime(fields, d)) return d.getTime();
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }

  function loadTasks() {
    try { const s = localStorage.getItem(TASKS_KEY); tasks = s ? (JSON.parse(s) || []) : []; }
    catch { tasks = []; }
    if (!Array.isArray(tasks)) tasks = [];
    return tasks;
  }
  function saveTasks() {
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); }
    catch (e) { console.warn('cron saveTasks failed', e); }
  }
  function isEnabledGlobally() {
    try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
  }
  function setEnabledGlobally(v) {
    try { localStorage.setItem(ENABLED_KEY, v ? '1' : '0'); } catch {}
  }
  function genId() { return 'cron_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function listTasks() { return tasks.map(t => ({ ...t })); }
  function getTask(id) { const t = tasks.find(x => x.id === id); return t ? { ...t } : null; }

  function _validateOverride(model) {
    if (model == null || model === '') return null;
    const s = String(model).trim();
    return s || null;
  }

  function addTask(spec) {
    const name = String(spec?.name || '').trim();
    const cron = String(spec?.cron || '').trim();
    const prompt = String(spec?.prompt || '').trim();
    if (!name) throw new Error('name is required');
    if (!prompt) throw new Error('prompt is required');
    if (!parseCron(cron)) throw new Error('invalid cron expression');
    const next = nextFireTime(cron, Date.now());
    if (!next) throw new Error('cron has no future match within 1 year');
    const t = {
      id: genId(),
      name: name.slice(0, 80),
      cron,
      prompt: prompt.slice(0, 4000),
      recurring: spec.recurring !== false,
      enabled: spec.enabled !== false,
      createdAt: Date.now(),
      createdBy: spec.createdBy === 'agent' ? 'agent' : 'user',
      lastFiredAt: null,
      nextFireAt: next,
      fireCount: 0,
      folderId: spec.folderId || null,
      modelOverride: _validateOverride(spec.modelOverride),
      maxRunMinutes: Number.isFinite(spec.maxRunMinutes) ? Math.max(1, Math.min(120, spec.maxRunMinutes | 0)) : null
    };
    tasks.push(t);
    saveTasks();
    return { ...t };
  }

  function updateTask(id, patch) {
    const i = tasks.findIndex(x => x.id === id);
    if (i < 0) return null;
    const cur = tasks[i];
    const next = { ...cur };
    if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 80) || cur.name;
    if (patch.prompt !== undefined) next.prompt = String(patch.prompt).slice(0, 4000) || cur.prompt;
    if (patch.recurring !== undefined) next.recurring = !!patch.recurring;
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.folderId !== undefined) next.folderId = patch.folderId || null;
    if (patch.modelOverride !== undefined) next.modelOverride = _validateOverride(patch.modelOverride);
    if (patch.maxRunMinutes !== undefined) {
      next.maxRunMinutes = Number.isFinite(patch.maxRunMinutes) ? Math.max(1, Math.min(120, patch.maxRunMinutes | 0)) : null;
    }
    if (patch.cron !== undefined) {
      const c = String(patch.cron).trim();
      if (!parseCron(c)) throw new Error('invalid cron expression');
      next.cron = c;
      const nf = nextFireTime(c, Date.now());
      if (!nf) throw new Error('cron has no future match within 1 year');
      next.nextFireAt = nf;
    }
    tasks[i] = next;
    saveTasks();
    return { ...next };
  }

  function removeTask(id) {
    const i = tasks.findIndex(x => x.id === id);
    if (i < 0) return false;
    tasks.splice(i, 1);
    saveTasks();
    return true;
  }

  function setTaskEnabled(id, v) {
    return updateTask(id, { enabled: !!v });
  }

  async function tick() {
    if (isFiring) return;
    if (!isEnabledGlobally()) return;
    // Ralph mutex — push due tasks forward, do not fire
    if (typeof ralphRun !== 'undefined' && ralphRun && ralphRun.active) {
      const now = Date.now();
      let changed = false;
      for (const t of tasks) {
        if (!t.enabled || !t.nextFireAt) continue;
        if (t.nextFireAt <= now) {
          const n = nextFireTime(t.cron, now);
          if (n) { t.nextFireAt = n; changed = true; }
          else { t.enabled = false; changed = true; }
        }
      }
      if (changed) saveTasks();
      return;
    }
    if (typeof isGenerating !== 'undefined' && isGenerating) return;
    const now = Date.now();
    const due = tasks.filter(t => t.enabled && t.nextFireAt && t.nextFireAt <= now);
    if (!due.length) return;
    isFiring = true;
    try {
      for (const t of due) {
        try { await fireTask(t); }
        catch (e) { console.warn('cron fireTask failed', t.id, e); }
      }
    } finally {
      isFiring = false;
      try { if (typeof renderCronTasksList === 'function') renderCronTasksList(); } catch {}
    }
  }

  async function fireTask(t) {
    let ctx = { task: { ...t } };
    if (typeof runHooks === 'function') {
      try { ctx = await runHooks('pre_cron_fire', ctx) || ctx; } catch (e) { console.warn('pre_cron_fire hook error', e); }
    }
    if (ctx && ctx._blocked) {
      if (typeof appendSystemMsg === 'function') appendSystemMsg(`[Cron] ${t.name}: blocked by hook ${ctx._blocked.by}`);
      finalizeAfterFire(t, false);
      return;
    }
    let prevModel = null;
    let modelOverridden = false;
    let timeoutHandle = null;
    let success = false;
    let errorMsg = '';
    try {
      if (t.modelOverride && typeof API_MODEL !== 'undefined') {
        prevModel = API_MODEL;
        try { API_MODEL = t.modelOverride; modelOverridden = true; } catch {}
      }
      if (typeof newConversation === 'function') newConversation(true, t.folderId || null);
      try {
        const meta = (typeof convHistory !== 'undefined' && Array.isArray(convHistory))
          ? convHistory.find(c => c.id === activeConvId) : null;
        if (meta) {
          meta.title = `[Cron] ${t.name}`;
          meta.titleSource = 'cron';
          meta.titleStatus = 'done';
        }
        if (typeof renderConvList === 'function') renderConvList();
      } catch {}
      if (t.maxRunMinutes) {
        timeoutHandle = setTimeout(() => {
          try { if (typeof abortCtrl !== 'undefined' && abortCtrl) abortCtrl.abort(); } catch {}
        }, t.maxRunMinutes * 60 * 1000);
      }
      if (typeof appendSystemMsg === 'function') appendSystemMsg(`[Cron] Triggered: ${t.name}`);
      if (typeof agentLoop !== 'function') throw new Error('agentLoop unavailable');
      await agentLoop(t.prompt, t.prompt, [], [], {});
      success = true;
    } catch (e) {
      errorMsg = e?.message || String(e);
      console.warn('cron fireTask error', e);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (modelOverridden && typeof API_MODEL !== 'undefined') {
        try { API_MODEL = prevModel; } catch {}
      }
      finalizeAfterFire(t, success);
      if (typeof runHooks === 'function') {
        try { await runHooks('post_cron_fire', { task: { ...t }, success, error: errorMsg || undefined }); }
        catch (e) { console.warn('post_cron_fire hook error', e); }
      }
    }
  }

  function finalizeAfterFire(t, success) {
    const i = tasks.findIndex(x => x.id === t.id);
    if (i < 0) return;
    const cur = tasks[i];
    cur.lastFiredAt = Date.now();
    if (success) cur.fireCount = (cur.fireCount || 0) + 1;
    if (!cur.recurring) {
      tasks.splice(i, 1);
    } else {
      const n = nextFireTime(cur.cron, Date.now());
      if (n) cur.nextFireAt = n;
      else { cur.enabled = false; cur.nextFireAt = null; }
    }
    saveTasks();
  }

  async function _maybePromptMissed(missed) {
    for (const t of missed) {
      if (!isEnabledGlobally()) {
        // global off — keep them but roll forward (don't auto-delete user's data)
        const n = nextFireTime(t.cron, Date.now());
        if (n) t.nextFireAt = n;
        continue;
      }
      let ans = null;
      try {
        const text = (typeof window.t === 'function' ? window.t('cron.missedConfirm') : null)
          || `Scheduled task missed: "${t.name}".\n\n[OK] = run it now\n[Cancel] = skip this fire (keep the task)`;
        ans = window.confirm(text.replace('${name}', t.name).replace('"" ', `"${t.name}" `));
      } catch { ans = false; }
      if (ans) {
        try { await fireTask(t); } catch (e) { console.warn(e); }
      } else {
        // Skip this fire: roll forward for recurring; for one-shot, delete
        const idx = tasks.findIndex(x => x.id === t.id);
        if (idx < 0) continue;
        if (!t.recurring) { tasks.splice(idx, 1); }
        else {
          const n = nextFireTime(t.cron, Date.now());
          tasks[idx].nextFireAt = n || null;
          if (!n) tasks[idx].enabled = false;
        }
      }
    }
    saveTasks();
    try { if (typeof renderCronTasksList === 'function') renderCronTasksList(); } catch {}
  }

  function start() {
    loadTasks();
    const now = Date.now();
    const missedOneShot = [];
    let dirty = false;
    for (const t of tasks) {
      if (!t.enabled) continue;
      // self-heal stale nextFireAt
      if (!t.nextFireAt || typeof t.nextFireAt !== 'number') {
        const n = nextFireTime(t.cron, now);
        if (n) { t.nextFireAt = n; dirty = true; }
        else { t.enabled = false; dirty = true; }
        continue;
      }
      if (t.nextFireAt < now - 60000) {
        if (!t.recurring) {
          missedOneShot.push(t);
        } else {
          const n = nextFireTime(t.cron, now);
          if (n) { t.nextFireAt = n; dirty = true; }
          else { t.enabled = false; dirty = true; }
        }
      }
    }
    if (dirty) saveTasks();
    if (missedOneShot.length) {
      setTimeout(() => { _maybePromptMissed(missedOneShot); }, 2500);
    }
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  }

  return {
    start, stop, tick,
    parseCron, nextFireTime,
    listTasks, getTask, addTask, updateTask, removeTask, setTaskEnabled,
    isEnabledGlobally, setEnabledGlobally,
    _saveTasks: saveTasks, _loadTasks: loadTasks
  };
})();

// ───────── Cron UI: settings list + editor modal ─────────
let _editingCronTaskId = null;

function _formatCronTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  if (isTomorrow) return (typeof t === 'function' ? t('cron.tomorrow', 'tomorrow') : 'tomorrow') + ' ' + time;
  return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderCronTasksList() {
  const el = document.getElementById('cronTasksContainer');
  if (!el) return;
  const tasks = CronScheduler.listTasks();
  if (!tasks.length) {
    el.innerHTML = `<div style="font-size:10px;color:var(--text-dim);padding:6px 4px" data-i18n="cron.empty">No scheduled tasks.</div>`;
    if (typeof applyI18n === 'function') applyI18n(el);
    return;
  }
  // Sort by nextFireAt ascending (disabled / null go last)
  tasks.sort((a, b) => {
    const av = a.enabled && a.nextFireAt ? a.nextFireAt : Infinity;
    const bv = b.enabled && b.nextFireAt ? b.nextFireAt : Infinity;
    return av - bv;
  });
  el.innerHTML = tasks.map(t => {
    const idEsc = esc(t.id);
    const nameEsc = esc(t.name);
    const cronEsc = esc(t.cron);
    const next = t.enabled && t.nextFireAt ? esc(_formatCronTime(t.nextFireAt)) : '<span style="color:var(--text-dim)">—</span>';
    const last = t.lastFiredAt ? esc(_formatCronTime(t.lastFiredAt)) : '—';
    const badge = t.recurring ? '' : ` <span style="color:var(--accent-yellow,var(--text-dim));font-size:9px">[once]</span>`;
    const agentBadge = t.createdBy === 'agent' ? ` <span style="color:var(--accent-blue,#5b8af5);font-size:9px">[agent]</span>` : '';
    const opacity = t.enabled ? '1' : '0.55';
    return `
      <div class="cron-item" style="display:flex;align-items:center;gap:6px;padding:6px;border:1px solid var(--border);border-radius:5px;background:var(--bg-root);opacity:${opacity}">
        <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="_onCronTaskToggle('${idEsc}', this.checked)" title="Enable/disable" style="margin:0;cursor:pointer;flex:0 0 auto">
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${nameEsc}${badge}${agentBadge}</div>
          <div style="font-size:9px;color:var(--text-dim);font-family:'JetBrains Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><code>${cronEsc}</code> &middot; <span data-i18n="cron.next">next</span>: ${next} &middot; <span data-i18n="cron.fired">fired</span> ${t.fireCount || 0}×</div>
        </div>
        <button class="skill-install-btn" style="flex:0 0 auto;margin:0;padding:2px 6px;font-size:10px" onclick="openCronTaskModal('${idEsc}')" title="Edit"><svg class="ui-icon" aria-hidden="true"><use href="#i-pencil"></use></svg></button>
        <button class="skill-install-btn" style="flex:0 0 auto;margin:0;padding:2px 6px;font-size:10px" onclick="_onCronTaskDelete('${idEsc}')" title="Delete">&times;</button>
      </div>
    `;
  }).join('');
  if (typeof applyI18n === 'function') applyI18n(el);
}

function _onCronEnabledToggle() {
  // Live toggle (also persisted on Save). Provides immediate effect.
  try {
    const v = document.getElementById('setCronEnabled').checked;
    CronScheduler.setEnabledGlobally(v);
  } catch (e) { console.warn(e); }
}

function _onCronTaskToggle(id, enabled) {
  try { CronScheduler.setTaskEnabled(id, enabled); } catch (e) { console.warn(e); }
  renderCronTasksList();
}

function _onCronTaskDelete(id) {
  const cur = CronScheduler.getTask(id);
  if (!cur) return;
  const msg = (typeof t === 'function' ? t('cron.deleteConfirm', null) : null) || `Delete scheduled task "${cur.name}"?`;
  if (!window.confirm(msg.replace('{name}', cur.name))) return;
  CronScheduler.removeTask(id);
  renderCronTasksList();
}

function _onCronPresetChange() {
  const sel = document.getElementById('cronTaskPreset');
  const v = sel.value;
  if (v) {
    document.getElementById('cronTaskCron').value = v;
    _validateCronInput();
  }
  sel.value = '';
}

function _validateCronInput() {
  const expr = document.getElementById('cronTaskCron').value.trim();
  const out = document.getElementById('cronTaskValidate');
  if (!expr) { out.textContent = ''; return; }
  const fields = CronScheduler.parseCron(expr);
  if (!fields) {
    out.textContent = (typeof t === 'function' ? t('cron.invalidExpr', null) : null) || 'Invalid cron expression.';
    out.style.color = 'var(--accent-red,#ff6b6b)';
    return;
  }
  const next = CronScheduler.nextFireTime(expr, Date.now());
  if (!next) {
    out.textContent = (typeof t === 'function' ? t('cron.noFutureMatch', null) : null) || 'No future match within 1 year.';
    out.style.color = 'var(--accent-red,#ff6b6b)';
    return;
  }
  out.textContent = ((typeof t === 'function' ? t('cron.nextPreview', null) : null) || 'Next fire') + ': ' + new Date(next).toLocaleString();
  out.style.color = 'var(--text-dim)';
}

function openCronTaskModal(id) {
  _editingCronTaskId = id || null;
  const cur = id ? CronScheduler.getTask(id) : null;
  const titleEl = document.getElementById('cronTaskModalTitle');
  const titleKey = cur ? 'cronModal.editTitle' : 'cronModal.addTitle';
  titleEl.setAttribute('data-i18n', titleKey);
  titleEl.textContent = (typeof t === 'function' ? t(titleKey, null) : null) || (cur ? 'Edit Scheduled Task' : 'Add Scheduled Task');
  document.getElementById('cronTaskName').value = cur?.name || '';
  document.getElementById('cronTaskCron').value = cur?.cron || '';
  document.getElementById('cronTaskPrompt').value = cur?.prompt || '';
  document.getElementById('cronTaskRecurring').checked = cur ? !!cur.recurring : true;
  document.getElementById('cronTaskEnabled').checked = cur ? !!cur.enabled : true;
  document.getElementById('cronTaskModelOverride').value = cur?.modelOverride || '';
  document.getElementById('cronTaskMaxRunMinutes').value = cur?.maxRunMinutes ? String(cur.maxRunMinutes) : '';
  document.getElementById('cronTaskModalStatus').textContent = '';
  // wire validate-on-blur once
  const cronInput = document.getElementById('cronTaskCron');
  cronInput.oninput = _validateCronInput;
  _validateCronInput();
  document.getElementById('cronTaskModal').classList.add('show');
}

function closeCronTaskModal() {
  document.getElementById('cronTaskModal').classList.remove('show');
  _editingCronTaskId = null;
}

function saveCronTaskFromModal() {
  const status = document.getElementById('cronTaskModalStatus');
  const name = document.getElementById('cronTaskName').value.trim();
  const cron = document.getElementById('cronTaskCron').value.trim();
  const prompt = document.getElementById('cronTaskPrompt').value;
  const recurring = document.getElementById('cronTaskRecurring').checked;
  const enabled = document.getElementById('cronTaskEnabled').checked;
  const modelOverride = document.getElementById('cronTaskModelOverride').value.trim();
  const maxRunRaw = parseInt(document.getElementById('cronTaskMaxRunMinutes').value, 10);
  const maxRunMinutes = Number.isFinite(maxRunRaw) && maxRunRaw > 0 ? maxRunRaw : null;
  if (!name) { status.textContent = (typeof t === 'function' ? t('cron.errNameRequired', null) : null) || 'Name is required.'; return; }
  if (!cron || !CronScheduler.parseCron(cron)) { status.textContent = (typeof t === 'function' ? t('cron.invalidExpr', null) : null) || 'Invalid cron expression.'; return; }
  if (!prompt.trim()) { status.textContent = (typeof t === 'function' ? t('cron.errPromptRequired', null) : null) || 'Prompt is required.'; return; }
  try {
    if (_editingCronTaskId) {
      CronScheduler.updateTask(_editingCronTaskId, { name, cron, prompt, recurring, enabled, modelOverride: modelOverride || null, maxRunMinutes });
    } else {
      CronScheduler.addTask({ name, cron, prompt, recurring, enabled, modelOverride: modelOverride || null, maxRunMinutes, createdBy: 'user' });
    }
  } catch (e) {
    status.textContent = e?.message || String(e);
    return;
  }
  closeCronTaskModal();
  renderCronTasksList();
}

