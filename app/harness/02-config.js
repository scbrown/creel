/* creel harness — part 2 of 26: config
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
 *   - THINKING / REASONING LEVEL — maps to provider-specific API params
 *   - CODE BLOCK ACTIONS — Preview (HTML) / Copy, rendered by pt-code-box
 *   - CONFIG
 */
// ═══════════════════════════════════════════════════════════════════
// THINKING / REASONING LEVEL — maps to provider-specific API params
// ═══════════════════════════════════════════════════════════════════
const THINK_KEY = 'ba_think_level';
// Thinking tiers aligned with OpenAI reasoning_effort:
//   none | low | medium | high | xhigh | max
// - 'auto' means: do not send any thinking/reasoning parameters (provider default).
// Legacy aliases: off→none, minimal→low (older UI values still load cleanly).
const THINK_LEVELS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
const THINK_LEVEL_ALIASES = { off: 'none', minimal: 'low' };
function normalizeThinkLevel(level) {
  let v = String(level || '');
  if (THINK_LEVEL_ALIASES[v]) v = THINK_LEVEL_ALIASES[v];
  return THINK_LEVELS.includes(v) ? v : null;
}
let THINK_LEVEL = (() => {
  try {
    const raw = localStorage.getItem(THINK_KEY);
    const v = normalizeThinkLevel(raw);
    if (v) {
      // Persist canonical name when upgrading from legacy off/minimal.
      if (raw !== v) try { localStorage.setItem(THINK_KEY, v); } catch {}
      return v;
    }
  } catch {}
  return 'auto';
})();
// Approximate token budgets for Anthropic extended thinking.
// 'none' / missing => do not enable thinking (budget 0).
const ANTHROPIC_THINK_BUDGET = { low: 2048, medium: 8000, high: 16000, xhigh: 32000, max: 64000 };
function setThinkingLevel(level) {
  level = normalizeThinkLevel(level) || 'auto';
  THINK_LEVEL = level;
  try { localStorage.setItem(THINK_KEY, level); } catch {}
  const badge = document.getElementById('thinkBadge');
  if (badge) badge.classList.toggle('on', level !== 'auto');
  const sel = document.getElementById('thinkSelect');
  if (sel && sel.value !== level) sel.value = level;
}
function initThinkingControl() {
  const sel = document.getElementById('thinkSelect');
  if (sel) sel.value = THINK_LEVEL;
  const badge = document.getElementById('thinkBadge');
  if (badge) badge.classList.toggle('on', THINK_LEVEL !== 'auto');
}
function applyThinkingToRequestBody(body, provider) {
  // 'auto' => do not send any thinking/reasoning params
  if (!body || THINK_LEVEL === 'auto') return body;
  if (provider === 'anthropic_compat') {
    const budget = ANTHROPIC_THINK_BUDGET[THINK_LEVEL] || 0;
    if (budget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic requires max_tokens > budget_tokens; give at least 2k headroom.
      const needed = budget + 2048;
      if (!Number.isFinite(body.max_tokens) || body.max_tokens < needed) body.max_tokens = needed;
      // Extended-thinking requires temperature to be unset/1; let the server default it.
      delete body.temperature;
    }
    // 'none' => leave thinking disabled (no thinking field).
  } else {
    // OpenAI-compatible: reasoning_effort values none|low|medium|high|xhigh|max
    body.reasoning_effort = THINK_LEVEL;
    // Also send the nested form used by Responses API; chat-completions ignores unknown keys.
    body.reasoning = { effort: THINK_LEVEL };
  }
  return body;
}

// ═══════════════════════════════════════════════════════════════════
// CODE BLOCK ACTIONS — Preview (HTML) / Copy, rendered by pt-code-box
// ═══════════════════════════════════════════════════════════════════
window.isHtmlCodeBlock = function(lang, rawText) {
  const L = String(lang || '').toLowerCase();
  if (L === 'html' || L === 'htm' || L === 'xhtml') return true;
  if (L) return false;
  // Heuristic when language is not specified: tag-like content.
  const s = String(rawText || '').trim();
  return /^<!doctype html/i.test(s) || /^<html[\s>]/i.test(s);
};
const _CODE_ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const _CODE_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const _CODE_ICON_PREVIEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
window.makeCodeActionBtn = function(kind, wrap) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pt-code-btn pt-code-btn-' + kind;
  if (kind === 'preview') {
    btn.innerHTML = _CODE_ICON_PREVIEW + '<span>' + t('code.preview') + '</span>';
    btn.title = t('code.previewTitle');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const html = (wrap && wrap.dataset && wrap.dataset.raw) || '';
      if (!html) return;
      if (typeof openPreviewModal === 'function') openPreviewModal(null, html, 'html');
    });
  } else {
    btn.innerHTML = _CODE_ICON_COPY + '<span>' + t('code.copy') + '</span>';
    btn.title = t('code.copyTitle');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const raw = (wrap && wrap.dataset && wrap.dataset.raw) || '';
      if (!raw) return;
      (navigator.clipboard?.writeText(raw) || Promise.reject()).then(() => {
        const label = btn.querySelector('span');
        const origIcon = btn.querySelector('svg');
        btn.classList.add('ok');
        if (origIcon) origIcon.outerHTML = _CODE_ICON_CHECK;
        if (label) label.textContent = t('code.copied');
        setTimeout(() => {
          btn.classList.remove('ok');
          btn.innerHTML = _CODE_ICON_COPY + '<span>' + t('code.copy') + '</span>';
        }, 1400);
      }).catch(() => {
        // Fallback: select + execCommand
        try {
          const ta = document.createElement('textarea'); ta.value = raw; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        } catch {}
      });
    });
  }
  return btn;
};

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const BINARY_EXTS = new Set(['pptx','xlsx','xls','docx','doc','pdf','png','jpg','jpeg','gif','bmp','ico','webp','svg','zip','gz','tar','whl','pyc','so','dll','exe','bin','dat','sqlite','db','mp3','mp4','wav','ogg','flac','aac','m4a','opus','webm','mov','avi','mkv','ttf','otf','woff','woff2','rar','7z','bz2','xz','iso','dmg','deb','rpm','jar','class','o','a','lib','obj','psd','ai','sketch','fig','raw','tiff','heic','heif','apk','ipa']);
// Any file above this threshold is treated as binary regardless of extension
// — avoids loading multi-MB "text" strings that freeze the renderer.
const MAX_TEXT_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 1 * 1024 * 1024;
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','bmp','webp','svg','ico']);
const OFFICE_EXTS = new Set(['pptx','xlsx','xls','docx','doc']);
const CFG = window.__DIFY_PLUGIN_CONFIG__ || {};
const SETTINGS_KEY = 'ba_settings';
function loadSettings() {
  try { const s = localStorage.getItem(SETTINGS_KEY); if (s) return JSON.parse(s); } catch {}
  return {};
}
function saveSettingsToStorage(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}
const _userSettings = loadSettings();
const RALPH_DEFAULTS = { enabled: false, maxIterations: 5, hardMaxIterations: 20, completionMarker: 'RALPH_DONE', unlimited: false };
function getRalphSettings() {
  const raw = loadSettings()?.ralph || {};
  const maxRaw = parseInt(raw.maxIterations, 10);
  const unlimited = raw.unlimited === true;
  const marker = String(raw.completionMarker || RALPH_DEFAULTS.completionMarker).trim() || RALPH_DEFAULTS.completionMarker;
  return {
    enabled: raw.enabled === true,
    unlimited,
    maxIterations: unlimited ? Infinity : (Number.isFinite(maxRaw) ? Math.min(RALPH_DEFAULTS.hardMaxIterations, Math.max(1, maxRaw)) : RALPH_DEFAULTS.maxIterations),
    completionMarker: marker
  };
}
const TASK_NOTIFICATION_DEFAULTS = { enabled: false };
function getTaskNotificationSettings() {
  const raw = loadSettings()?.taskNotifications || {};
  return { ...TASK_NOTIFICATION_DEFAULTS, enabled: raw.enabled === true };
}
function taskNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}
async function requestTaskNotificationPermissionIfNeeded() {
  if (!taskNotificationsSupported()) return 'unsupported';
  if (Notification.permission === 'default') {
    try { return await Notification.requestPermission(); }
    catch { return Notification.permission || 'denied'; }
  }
  return Notification.permission;
}
function getConversationTitleForNotification(convId) {
  const meta = convHistory.find(c => c.id === convId);
  const title = String(meta?.title || '').trim();
  return title && title !== 'New Chat' ? title : t('notify.untitledConversation', 'Untitled conversation');
}
function notifyTaskFinished({ convId, kind = 'chat', outcome = 'done' } = {}) {
  if (!getTaskNotificationSettings().enabled) return;
  if (!taskNotificationsSupported() || Notification.permission !== 'granted') return;
  const title = outcome === 'error'
    ? t('notify.taskFailedTitle', 'OnePagent task failed')
    : t('notify.taskFinishedTitle', 'OnePagent task finished');
  const convTitle = getConversationTitleForNotification(convId);
  const bodyKey = outcome === 'error'
    ? 'notify.bodyError'
    : (kind === 'media' ? 'notify.bodyMediaDone' : 'notify.bodyChatDone');
  const bodyFallback = outcome === 'error' ? 'Task stopped with an error: {title}' : (kind === 'media' ? 'Media generation finished: {title}' : 'Conversation finished: {title}');
  const body = _convTemplate(bodyKey, bodyFallback, { title: convTitle });
  try {
    const notification = new Notification(title, { body, tag: convId ? `onepagent-run-${convId}` : 'onepagent-run', renotify: true });
    notification.onclick = () => {
      try {
        window.focus();
        if (convId) switchConversation(convId);
      } catch {}
      try { notification.close(); } catch {}
    };
    setTimeout(() => { try { notification.close(); } catch {} }, 12000);
  } catch {}
}
// Provider profiles (user-defined). Each provider is either anthropic-compatible or openai-compatible.
const PROVIDERS_KEY = 'ba_providers_v1';
const ACTIVE_PROVIDER_KEY = 'ba_active_provider_id';
function _loadProviders() {
  try { const raw = localStorage.getItem(PROVIDERS_KEY); if (raw) return JSON.parse(raw); } catch {}
  return null;
}
function _saveProviders(obj) { try { localStorage.setItem(PROVIDERS_KEY, JSON.stringify(obj)); } catch {} }
function _genProviderId() { return 'prov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Sandbox config (local Pyodide/JS vs remote Daytona) ──────────
const SANDBOX_CFG_KEY = 'ba_sandbox_config';
const SANDBOX_DEFAULTS = Object.freeze({
  enabled: false,                                  // ENABLE_SANDBOX
  platform: 'daytona',                             // SANDBOX_PLATFORM
  daytonaApiKey: '',                               // DAYTONA_API_KEY
  daytonaServerUrl: 'https://app.daytona.io/api',  // DAYTONA_SERVER_URL  (sandbox lifecycle)
  daytonaToolboxUrl: '',                           // optional explicit toolbox URL; auto-derived when blank
  daytonaTimeout: 180,                             // DAYTONA_TIMEOUT  (seconds)
  daytonaImage: '',                                // DAYTONA_IMAGE  (sent as `snapshot` to REST; empty → Daytona uses its built-in default snapshot)
  daytonaAutoStopInterval: 5,                      // DAYTONA_AUTO_STOP_INTERVAL    (minutes)
  daytonaAutoArchiveInterval: 5,                   // DAYTONA_AUTO_ARCHIVE_INTERVAL (minutes)
  daytonaAutoDeleteInterval: 1440,                 // DAYTONA_AUTO_DELETE_INTERVAL  (minutes)
});
// One-shot migration: an earlier build hard-coded `daytonaio/sandbox:0.6.0`
// as the default Daytona snapshot. That image is missing /usr/bin/zsh, which
// Daytona's daemon hard-codes as the login shell, so every Bash call fails
// with "fork/exec /usr/bin/zsh: no such file or directory". Rewrite that
// exact legacy default to empty so Daytona falls back to its working built-in.
const _LEGACY_BROKEN_DAYTONA_IMAGE = 'daytonaio/sandbox:0.6.0';
function getSandboxConfig() {
  try {
    const raw = localStorage.getItem(SANDBOX_CFG_KEY);
    if (raw) {
      const cfg = Object.assign({}, SANDBOX_DEFAULTS, JSON.parse(raw));
      if (cfg.daytonaImage === _LEGACY_BROKEN_DAYTONA_IMAGE) cfg.daytonaImage = '';
      return cfg;
    }
  } catch {}
  return { ...SANDBOX_DEFAULTS };
}
function saveSandboxConfig(cfg) {
  try { localStorage.setItem(SANDBOX_CFG_KEY, JSON.stringify(cfg || {})); } catch {}
}
function isRemoteSandbox() {
  const c = getSandboxConfig();
  return !!c.enabled && c.platform === 'daytona';
}

const REASONING_CONTENT_MODES = new Set(['auto', 'on', 'off']);
function normalizeReasoningContentMode(mode) {
  const m = String(mode || 'auto').trim().toLowerCase();
  return REASONING_CONTENT_MODES.has(m) ? m : 'auto';
}
function normalizeReasoningContentModelsMap(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  Object.entries(map).forEach(([model, mode]) => {
    const key = String(model || '').trim();
    if (key) out[key] = normalizeReasoningContentMode(mode);
  });
  return out;
}
function isMimoReasoningModel(model = API_MODEL) {
  const normalized = String(model || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized.includes('xiaomimimo') || normalized.includes('mimo');
}
function isDefaultReasoningContentModel(model = API_MODEL) {
  const p = ACTIVE_PROVIDER || {};
  const haystack = [p.name, p.endpoint, p.defaultModel, model, _keys?.api_endpoint, CFG.api_endpoint].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes('deepseek') || isMimoReasoningModel(model);
}
function getReasoningContentModeForModel(model = API_MODEL) {
  const key = String(model || '').trim();
  return normalizeReasoningContentMode(key ? MODEL_REASONING_CONTENT[key] : 'auto');
}
function shouldKeepReasoningForModel(model = API_MODEL) {
  const mode = getReasoningContentModeForModel(model);
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return isDefaultReasoningContentModel(model);
}

function getActiveProviderId() {
  try { return localStorage.getItem(ACTIVE_PROVIDER_KEY) || ''; } catch { return ''; }
}
function setActiveProviderId(id) {
  try { localStorage.setItem(ACTIVE_PROVIDER_KEY, id); } catch {}
}
function getProvidersMap() {
  const obj = _loadProviders();
  return (obj && obj.providers && typeof obj.providers === 'object') ? obj.providers : {};
}
function getActiveProviderProfile() {
  const m = getProvidersMap();
  const ids = Object.keys(m);
  if (!ids.length) return null;
  const active = getActiveProviderId();
  if (active && m[active]) return m[active];
  // fallback: first provider
  return m[ids[0]];
}

let ACTIVE_PROVIDER = getActiveProviderProfile();
let PROVIDER = (ACTIVE_PROVIDER && ACTIVE_PROVIDER.type) ? ACTIVE_PROVIDER.type : 'anthropic_compat';
let API_MODEL = localStorage.getItem('ba_selected_model') || (ACTIVE_PROVIDER && ACTIVE_PROVIDER.defaultModel) || _userSettings.api_model || CFG.api_model || 'claude-sonnet-4-20250514';
const BASE_URL = window.location.href.split('?')[0].replace(/\/$/, '');
const CONFIG_URL = BASE_URL + '/config';
const ANTHROPIC_MAX_TOKENS = 16000;
const ANTHROPIC_SUMMARY_MAX_TOKENS = 2000;
const CUSTOM_SYSTEM = CFG.system_prompt || '';
const DEFAULT_MAX_CONTEXT_TOKENS = 128000;
const CONTEXT_WARNING_RATIO = 0.60;
const CONTEXT_AUTO_COMPACT_RATIO = 0.75;
const CONTEXT_CRITICAL_RATIO = 0.90;
const CONTEXT_MICRO_COMPACT_MIN_TOKENS = 2400;
const CONTEXT_RECENT_MESSAGE_PROTECT_COUNT = 6;
const MODEL_CONTEXTS = { ...(((ACTIVE_PROVIDER && ACTIVE_PROVIDER.model_contexts) || CFG.model_contexts || {})) };
const MODEL_REASONING_CONTENT = { ...normalizeReasoningContentModelsMap((ACTIVE_PROVIDER && ACTIVE_PROVIDER.reasoning_content_models) || CFG.reasoning_content_models || {}) };
let currentMaxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS;

// API credentials are loaded from local settings/provider profiles and used by direct browser fetches.
let _keys = null;

function getMaxContextTokensForModel(model) {
  const configured = Number(MODEL_CONTEXTS[model]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_CONTEXT_TOKENS;
}
function applyModelContextLimit() {
  currentMaxContextTokens = getMaxContextTokensForModel(API_MODEL);
  updateMemoryUI();
}

// Provider select populated at init

// Populate provider + model dropdowns from provider profiles (immediate)
function populateProviderSelect() {
  const sel = document.getElementById('providerSelect');
  if (!sel) return;
  const providers = getProvidersMap();
  const ids = Object.keys(providers);
  if (!ids.length) {
    sel.innerHTML = '<option value=>(no provider)</option>';
    return;
  }
  const active = (ACTIVE_PROVIDER && ACTIVE_PROVIDER.id) ? ACTIVE_PROVIDER.id : (ids[0]);
  sel.innerHTML = ids.map(id => `<option value="${esc(id)}"${id === active ? ' selected' : ''}>${esc(providers[id].name || id)}</option>`).join('');
}

const MEDIA_MODE_KEY = 'ba_media_generation_mode';
const MEDIA_MODEL_KEY = 'ba_media_generation_models';
const MEDIA_GENERATION_MODES = new Set(['chat', 'text_image', 'image_image', 'text_video', 'image_video']);
let MEDIA_MODE = (() => {
  try { const v = localStorage.getItem(MEDIA_MODE_KEY); if (MEDIA_GENERATION_MODES.has(v)) return v; } catch {}
  return 'chat';
})();
let MEDIA_MODELS = (() => {
  try { const raw = localStorage.getItem(MEDIA_MODEL_KEY); return raw ? JSON.parse(raw) : {}; } catch {}
  return {};
})();

function isMediaGenerationMode(mode = MEDIA_MODE) { return mode && mode !== 'chat'; }
function isVideoGenerationMode(mode = MEDIA_MODE) { return mode === 'text_video' || mode === 'image_video'; }
function isImageInputGenerationMode(mode = MEDIA_MODE) { return mode === 'image_image' || mode === 'image_video'; }
function getProviderMediaModels(kind, provider = ACTIVE_PROVIDER) {
  const p = provider || {};
  const key = kind === 'video' ? 'videoModels' : 'imageModels';
  return Array.isArray(p[key]) ? p[key].filter(Boolean) : [];
}
function getProviderDefaultMediaModel(kind, provider = ACTIVE_PROVIDER) {
  const p = provider || {};
  return String(kind === 'video' ? (p.defaultVideoModel || '') : (p.defaultImageModel || '')).trim();
}
function getAllProviderProfiles(activeFirst = true) {
  const providers = getProvidersMap();
  const list = Object.values(providers).filter(Boolean);
  if (!activeFirst || !ACTIVE_PROVIDER?.id) return list;
  return list.sort((a, b) => (a.id === ACTIVE_PROVIDER.id ? -1 : b.id === ACTIVE_PROVIDER.id ? 1 : 0));
}
function findMediaProviderByModel(kind, model) {
  const target = String(model || '').trim();
  if (!target) return null;
  return getAllProviderProfiles().find(p => {
    const def = getProviderDefaultMediaModel(kind, p);
    const models = getProviderMediaModels(kind, p);
    return def === target || models.includes(target);
  }) || ACTIVE_PROVIDER || null;
}
function getConfiguredDefaultMedia(kind) {
  for (const p of getAllProviderProfiles()) {
    const model = getProviderDefaultMediaModel(kind, p);
    if (model) return { provider: p, model };
  }
  return { provider: ACTIVE_PROVIDER || null, model: '' };
}
function hasConfiguredDefaultMediaModel(kind) {
  return !!getConfiguredDefaultMedia(kind).model;
}
function resolveMediaModelConfig(kind, override = '') {
  const explicit = String(override || '').trim();
  if (explicit) return { provider: findMediaProviderByModel(kind, explicit), model: explicit };
  const configured = getConfiguredDefaultMedia(kind);
  if (!configured.model) return configured;
  const stored = MEDIA_MODELS[(configured.provider?.id || 'default') + ':' + kind];
  if (stored) return { provider: findMediaProviderByModel(kind, stored) || configured.provider, model: stored };
  return configured;
}
function getDefaultMediaModel(kind, override = '') {
  return resolveMediaModelConfig(kind, override).model || '';
}
function setMediaGenerationMode(mode) {
  if (!MEDIA_GENERATION_MODES.has(mode)) mode = 'chat';
  MEDIA_MODE = mode;
  try { localStorage.setItem(MEDIA_MODE_KEY, mode); } catch {}
  populateMediaModelSelect();
}
function setMediaGenerationModel(model) {
  const kind = isVideoGenerationMode() ? 'video' : 'image';
  const providerId = (resolveMediaModelConfig(kind, model).provider?.id) || (ACTIVE_PROVIDER && ACTIVE_PROVIDER.id) || 'default';
  MEDIA_MODELS[providerId + ':' + kind] = model;
  try { localStorage.setItem(MEDIA_MODEL_KEY, JSON.stringify(MEDIA_MODELS)); } catch {}
}
function initMediaGenerationControls() {
  const modeSel = document.getElementById('mediaModeSelect');
  if (modeSel) modeSel.value = MEDIA_MODE;
  populateMediaModelSelect();
}
function populateMediaModelSelect() {
  const modeSel = document.getElementById('mediaModeSelect');
  const modelSel = document.getElementById('mediaModelSelect');
  if (!modelSel) return;
  if (modeSel) {
    modeSel.value = MEDIA_MODE;
    modeSel.classList.toggle('active', isMediaGenerationMode());
  }
  if (!isMediaGenerationMode()) {
    modelSel.style.display = 'none';
    modelSel.innerHTML = '';
    return;
  }
  const kind = isVideoGenerationMode() ? 'video' : 'image';
  const mediaCfg = getConfiguredDefaultMedia(kind);
  const list = mediaCfg.provider ? getProviderMediaModels(kind, mediaCfg.provider) : [];
  const current = getDefaultMediaModel(kind);
  const options = list.length ? list.slice() : (current ? [current] : []);
  if (current && !options.includes(current)) options.unshift(current);
  modelSel.innerHTML = options.length
    ? options.map(m => `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${esc(m)}</option>`).join('')
    : `<option value="">${esc(t('media.noModel'))}</option>`;
  modelSel.style.display = '';
}

function populateModelSelectFromActiveProvider() {
  const modelSel = document.getElementById('modelSelect');
  if (!modelSel) return;
  const p = ACTIVE_PROVIDER;
  const models = (p && Array.isArray(p.models)) ? p.models : [];
  const list = models.length ? models.slice() : [API_MODEL];
  // Ensure current model is present
  if (API_MODEL && !list.includes(API_MODEL)) list.unshift(API_MODEL);
  modelSel.innerHTML = list.map(m => `<option value="${esc(m)}"${m === API_MODEL ? ' selected' : ''}>${esc(m)}</option>`).join('');
  populateMediaModelSelect();
}

document.getElementById('providerSelect').addEventListener('change', e => {
  const id = e.target.value;
  const providers = getProvidersMap();
  if (!id || !providers[id]) return;
  ACTIVE_PROVIDER = providers[id];
  setActiveProviderId(id);
  PROVIDER = ACTIVE_PROVIDER.type || 'openai_compat';
  // Switch model to provider default if available
  API_MODEL = ACTIVE_PROVIDER.defaultModel || (Array.isArray(ACTIVE_PROVIDER.models) && ACTIVE_PROVIDER.models[0]) || API_MODEL;
  localStorage.setItem('ba_selected_model', API_MODEL);
  // Update endpoint/key in runtime keys
  _keys = Object.assign(_keys || {}, {
    api_key: (ACTIVE_PROVIDER.apiKey || ''),
    api_endpoint: (ACTIVE_PROVIDER.endpoint || ''),
    api_models: (ACTIVE_PROVIDER.models || []),
    api_model: API_MODEL,
    model_contexts: (ACTIVE_PROVIDER.model_contexts || {}),
    reasoning_content_models: normalizeReasoningContentModelsMap(ACTIVE_PROVIDER.reasoning_content_models || {})
  });
  CFG.api_endpoint = _keys.api_endpoint;
  // Update MODEL_CONTEXTS in place
  Object.keys(MODEL_CONTEXTS).forEach(k => delete MODEL_CONTEXTS[k]);
  if (_keys.model_contexts && typeof _keys.model_contexts === 'object') Object.assign(MODEL_CONTEXTS, _keys.model_contexts);
  Object.keys(MODEL_REASONING_CONTENT).forEach(k => delete MODEL_REASONING_CONTENT[k]);
  Object.assign(MODEL_REASONING_CONTENT, _keys.reasoning_content_models || {});
  applyModelContextLimit();
  populateModelSelectFromActiveProvider();
  updateWsStatus();
});

document.getElementById('modelSelect').addEventListener('change', e => {
  API_MODEL = e.target.value;
  localStorage.setItem('ba_selected_model', API_MODEL);
  applyModelContextLimit();
});

populateProviderSelect();
populateModelSelectFromActiveProvider();

// ── LLM URL + auth helpers ──────────────────────────────────────
function getLLMUrl() {
  const ep = (_keys?.api_endpoint || CFG.api_endpoint || '').replace(/\/+$/, '');
  if (PROVIDER === 'anthropic_compat') {
    return ep.includes('/messages') ? ep : ep + '/v1/messages';
  }
  if (ep.includes('/chat/completions')) return ep;
  if (/\/v\d+$/.test(ep)) return ep + '/chat/completions';
  return ep + '/v1/chat/completions';
}

function getAuthHeaders() {
  return getProviderAuthHeaders({ json: true });
}
function getProviderAuthHeaders(options = {}) {
  const h = {};
  if (options.json !== false) h['Content-Type'] = 'application/json';
  const provider = options.provider || ACTIVE_PROVIDER || {};
  const providerType = provider.type || PROVIDER;
  const apiKey = provider.apiKey || _keys?.api_key || '';
  if (apiKey) {
    if (providerType === 'anthropic_compat') {
      h['x-api-key'] = apiKey;
      h['anthropic-version'] = '2023-06-01';
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
      h['Authorization'] = `Bearer ${apiKey}`;
    }
  }
  return h;
}
function buildProviderApiUrl(pathOrUrl, provider = ACTIVE_PROVIDER) {
  const raw = String(pathOrUrl || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const ep = ((provider && provider.endpoint) || _keys?.api_endpoint || CFG.api_endpoint || '').replace(/\/+$/, '');
  const path = raw.startsWith('/') ? raw : '/' + raw;
  if (/\/v\d+$/i.test(ep) && /^\/v\d+\//i.test(path)) return ep.replace(/\/v\d+$/i, '') + path;
  return ep + path;
}
function isAbortError(e) {
  return e?.name === 'AbortError';
}
function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
async function waitForRetryDelay(ms, signal) {
  if (!ms || ms <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const retries = Math.max(0, Number(retryOptions.retries ?? 5) || 0);
  const baseDelay = Math.max(0, Number(retryOptions.baseDelay ?? 500) || 0);
  const maxDelay = Math.max(baseDelay, Number(retryOptions.maxDelay ?? 8000) || 8000);
  const signal = options.signal;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (!isRetryableStatus(resp.status) || attempt >= retries) return resp;
      lastError = new Error(`HTTP ${resp.status}`);
      try { await resp.arrayBuffer(); } catch {}
    } catch (e) {
      if (isAbortError(e) || attempt >= retries) throw e;
      lastError = e;
    }
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) * jitter;
    await waitForRetryDelay(delay, signal);
  }
  throw lastError || new Error('Network request failed');
}

