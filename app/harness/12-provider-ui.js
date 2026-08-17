/* creel harness — part 12 of 26: provider-ui
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
 * Continues the previous part: Provider Profiles UI helpers
 */
// ── Provider Profiles UI helpers ───────────────────────────────
function renderProviderSelectInTopBar() {
  try { populateProviderSelect(); } catch {}
}

function renderProviderProfilesInSettings() {
  const sel = document.getElementById('setProviderProfile');
  if (!sel) return;
  const providers = getProvidersMap();
  const ids = Object.keys(providers);
  if (!ids.length) {
    sel.innerHTML = '<option value="">(none)</option>';
    return;
  }
  const activeId = (ACTIVE_PROVIDER && ACTIVE_PROVIDER.id) ? ACTIVE_PROVIDER.id : (getActiveProviderId() || ids[0]);
  sel.innerHTML = ids.map(id => `<option value="${esc(id)}"${id === activeId ? ' selected' : ''}>${esc(providers[id].name || id)}</option>`).join('');
}

function _applyProviderProfileToSettingsModal(p) {
  _settingsModelFetchSeq++;
  _settingsModelFetchController?.abort();
  _settingsModelFetchController = null;
  document.getElementById('setAvailableModels').innerHTML = '';
  document.getElementById('setProviderName').value = p.name || '';
  document.getElementById('setProvider').value = p.type || 'openai_compat';
  document.getElementById('setEndpoint').value = (p.endpoint || '').replace(/\/+$/, '');
  document.getElementById('setApiKey').value = p.apiKey || '';
  const models = Array.isArray(p.models) ? p.models : [];
  document.getElementById('setModels').value = models.join('\n');
  document.getElementById('setDefaultModel').value = p.defaultModel || '';
  document.getElementById('setImageModels').value = (Array.isArray(p.imageModels) ? p.imageModels : []).join('\n');
  document.getElementById('setVideoModels').value = (Array.isArray(p.videoModels) ? p.videoModels : []).join('\n');
  document.getElementById('setDefaultImageModel').value = p.defaultImageModel || '';
  document.getElementById('setDefaultVideoModel').value = p.defaultVideoModel || '';
  document.getElementById('setImageGenerationEndpoint').value = p.imageGenerationEndpoint || '';
  document.getElementById('setImageEditEndpoint').value = p.imageEditEndpoint || '';
  document.getElementById('setVideoGenerationEndpoint').value = p.videoGenerationEndpoint || '';
  document.getElementById('setVideoStatusEndpoint').value = p.videoStatusEndpoint || '';
  const ctxs = p.model_contexts || {};
  renderModelContextsList(ctxs);
  renderReasoningContentModelsList(p.reasoning_content_models || {});
}

function onProviderProfileSelect() {
  const id = document.getElementById('setProviderProfile').value;
  const providers = getProvidersMap();
  if (!id || !providers[id]) return;
  _applyProviderProfileToSettingsModal(providers[id]);
}

function newProviderProfile() {
  const name = prompt('Provider name:', 'My Provider');
  if (!name) return;
  const id = _genProviderId();
  const providers = getProvidersMap();
  providers[id] = {
    id,
    name,
    type: 'openai_compat',
    endpoint: 'https://api.openai.com',
    apiKey: '',
    models: [],
    defaultModel: '',
    imageModels: [],
    videoModels: [],
    defaultImageModel: '',
    defaultVideoModel: '',
    imageGenerationEndpoint: '',
    imageEditEndpoint: '',
    videoGenerationEndpoint: '',
    videoStatusEndpoint: '',
    model_contexts: {},
    reasoning_content_models: {}
  };
  _saveProviders({ providers });
  setActiveProviderId(id);
  ACTIVE_PROVIDER = providers[id];
  renderProviderProfilesInSettings();
  document.getElementById('setProviderProfile').value = id;
  _applyProviderProfileToSettingsModal(ACTIVE_PROVIDER);
  renderProviderSelectInTopBar();
}

function deleteCurrentProviderProfile() {
  const id = document.getElementById('setProviderProfile').value;
  const providers = getProvidersMap();
  if (!id || !providers[id]) return;
  if (!confirm('Delete provider "' + (providers[id].name || id) + '"?')) return;
  delete providers[id];
  _saveProviders({ providers });
  const ids = Object.keys(providers);
  const next = ids[0] || '';
  setActiveProviderId(next);
  ACTIVE_PROVIDER = next ? providers[next] : null;
  renderProviderProfilesInSettings();
  if (ACTIVE_PROVIDER) _applyProviderProfileToSettingsModal(ACTIVE_PROVIDER);
  else {
    renderModelContextsList({});
    renderReasoningContentModelsList({});
  }
  renderProviderSelectInTopBar();
}

function openSettingsModal() {
  // Load active provider profile into the settings modal
  const p = getActiveProviderProfile();
  renderProviderProfilesInSettings();
  renderModelContextsList({}); // reset; overridden below if a profile is active
  renderReasoningContentModelsList({});
  if (p) {
    document.getElementById('setProviderProfile').value = p.id;
    _applyProviderProfileToSettingsModal(p);
  }
  const s = loadSettings();
  // Non-provider settings (tavily/memory/s3/etc.) remain in SETTINGS_KEY storage
  document.getElementById('setTavilyKey').value = s.tavily_api_key || (_keys && _keys.tavily_api_key) || '';
  document.getElementById('setStatus').textContent = '';
  const ralph = getRalphSettings();
  document.getElementById('setRalphEnabled').checked = !!ralph.enabled;
  document.getElementById('setRalphUnlimited').checked = !!ralph.unlimited;
  document.getElementById('setRalphMaxIterations').value = String(Number.isFinite(ralph.maxIterations) ? ralph.maxIterations : RALPH_DEFAULTS.maxIterations);
  document.getElementById('setRalphMaxIterations').disabled = !!ralph.unlimited;
  document.getElementById('setRalphCompletionMarker').value = ralph.completionMarker;
  document.getElementById('setTaskNotifications').checked = !!getTaskNotificationSettings().enabled;
  // Swarm settings
  document.getElementById('setSwarmEnabled').checked = !!swarmSettings.enabled;
  document.getElementById('setSwarmConcurrency').value = String(swarmSettings.maxConcurrency || SWARM_DEFAULTS.maxConcurrency);
  document.getElementById('setSwarmMaxWorkers').value = String(swarmSettings.maxWorkersPerRun || SWARM_DEFAULTS.maxWorkersPerRun);
  document.getElementById('setSwarmTotalBudget').value = String(swarmSettings.totalTokenBudget || SWARM_DEFAULTS.totalTokenBudget);
  document.getElementById('setSwarmWorkerModel').value = swarmSettings.workerModel || '';
  document.getElementById('setSwarmAllowWrite').checked = !!swarmSettings.allowWriteRoles;
  document.getElementById('setSwarmMaxHandoffChain').value = String(swarmSettings.maxHandoffChain || SWARM_DEFAULTS.maxHandoffChain);
  // v4 RoleManager fields
  document.getElementById('setSwarmRoleManagerEnabled').checked = !!swarmSettings.roleManagerEnabled;
  document.getElementById('setSwarmAgentRolesPersist').checked = !!swarmSettings.agentRolesPersist;
  document.getElementById('setSwarmAgentRolesPerConv').checked = !!swarmSettings.agentRolesPerConv;
  document.getElementById('setSwarmAgentRolesPerConv').disabled = !swarmSettings.agentRolesPersist;
  // Cron Scheduler
  try { document.getElementById('setCronEnabled').checked = CronScheduler.isEnabledGlobally(); } catch {}
  try { renderCronTasksList(); } catch {}
  const mem = { ...MEM_DEFAULTS, ...(s.memory || {}) };
  document.getElementById('setMemEnabled').checked = !!mem.enabled;
  document.getElementById('setMemAutoExtract').checked = !!mem.autoExtract;
  document.getElementById('setMemMaxRecall').value = String(Math.max(0, mem.maxRecall | 0) || MEM_DEFAULTS.maxRecall);
  const st = (typeof CreelState !== 'undefined' ? CreelState.loadCfg() : null) || {};
  document.getElementById('setStateEnabled').checked = !!st.enabled;
  document.getElementById('setStateOwner').value = st.owner || '';
  document.getElementById('setStateRepo').value = st.repo || 'creel-state';
  document.getElementById('setStateBranch').value = st.branch || 'main';
  document.getElementById('setStatePrefix').value = st.prefix || 'state';
  document.getElementById('setStatePassphrase').value = st.passphrase || '';
  document.getElementById('setStateSecrets').checked = !!st.includeSecrets;
  document.getElementById('stateRepoStatus').textContent = '';
  const s3 = _loadS3Cfg() || {};
  document.getElementById('setS3Endpoint').value = s3.endpoint || '';
  document.getElementById('setS3Region').value = s3.region || 'us-east-1';
  document.getElementById('setS3Bucket').value = s3.bucket || '';
  document.getElementById('setS3Prefix').value = s3.prefix || 'onepagent/';
  document.getElementById('setS3AccessKey').value = s3.accessKey || '';
  document.getElementById('setS3SecretKey').value = s3.secretKey || '';
  document.getElementById('setS3Passphrase').value = s3.passphrase || '';
  document.getElementById('setS3AutoPush').checked = !!s3.autoPush;
  document.getElementById('setS3PathStyle').checked = s3.forcePathStyle !== false;
  document.getElementById('s3Status').textContent = '';
  // Sandbox
  const sb = getSandboxConfig();
  document.getElementById('setSandboxEnabled').checked = !!sb.enabled;
  document.getElementById('setSandboxPlatform').value = sb.platform || 'daytona';
  document.getElementById('setDaytonaApiKey').value = sb.daytonaApiKey || '';
  document.getElementById('setDaytonaServerUrl').value = sb.daytonaServerUrl || SANDBOX_DEFAULTS.daytonaServerUrl;
  document.getElementById('setDaytonaTimeout').value = sb.daytonaTimeout ?? SANDBOX_DEFAULTS.daytonaTimeout;
  document.getElementById('setDaytonaImage').value = sb.daytonaImage || '';
  document.getElementById('setDaytonaAutoStop').value = sb.daytonaAutoStopInterval ?? SANDBOX_DEFAULTS.daytonaAutoStopInterval;
  document.getElementById('setDaytonaAutoArchive').value = sb.daytonaAutoArchiveInterval ?? SANDBOX_DEFAULTS.daytonaAutoArchiveInterval;
  document.getElementById('setDaytonaAutoDelete').value = sb.daytonaAutoDeleteInterval ?? SANDBOX_DEFAULTS.daytonaAutoDeleteInterval;
  onSandboxProviderChange();
  document.getElementById('settingsModal').classList.add('show');
}
function onSandboxProviderChange() {
  const enabled = document.getElementById('setSandboxEnabled').checked;
  const platform = document.getElementById('setSandboxPlatform').value;
  document.getElementById('setSandboxDaytonaBox').style.display = (enabled && platform === 'daytona') ? '' : 'none';
}
async function testDaytonaSandbox() {
  const btn = document.getElementById('setSandboxTestBtn');
  const status = document.getElementById('setSandboxTestStatus');
  if (!btn || !status) return;
  const cfg = {
    daytonaApiKey: document.getElementById('setDaytonaApiKey').value.trim(),
    daytonaServerUrl: document.getElementById('setDaytonaServerUrl').value.trim() || SANDBOX_DEFAULTS.daytonaServerUrl,
    daytonaToolboxUrl: '',
    daytonaImage: document.getElementById('setDaytonaImage').value.trim(),
  };
  if (!cfg.daytonaApiKey) { status.textContent = 'DAYTONA_API_KEY is required.'; return; }
  btn.disabled = true;
  status.style.color = 'var(--text-dim)';
  status.textContent = t('settings.sandboxTestRunning', 'Creating sandbox and running echo + uname …');
  let sandboxId = '';
  let lastState = '';
  try {
    const createBody = { language: 'python' };
    if (cfg.daytonaImage) createBody.snapshot = cfg.daytonaImage;
    const created = await _daytonaApiFetch(cfg, '/sandbox', { method: 'POST', body: JSON.stringify(createBody) });
    sandboxId = created?.id || created?.sandboxId || created?.sandbox?.id || '';
    if (!sandboxId) throw new Error('Daytona create response missing sandbox id.');
    lastState = String(created?.state || '').toLowerCase();
    if (lastState !== 'started') {
      status.textContent = t('settings.sandboxTestRunning', 'Creating sandbox and running echo + uname …') + ` (waiting for state: ${lastState || 'unknown'} → started)`;
      const ready = await _daytonaWaitForSandboxReady(cfg, sandboxId);
      lastState = String(ready?.state || '').toLowerCase();
    }
    const exec = await _daytonaToolboxFetch(cfg, sandboxId, '/process/execute',
      { method: 'POST', body: JSON.stringify({ command: 'echo ok && uname -a', cwd: DAYTONA_WORKSPACE, timeout: 30 }) });
    const norm = _normalizeExecResult(exec);
    const combined = (norm.stdout || '') + '\n' + (norm.stderr || '');
    const hint = _daytonaShellHint(combined);
    if (hint || norm.exitCode !== 0) {
      status.style.color = 'var(--accent-red, #ff6b6b)';
      const detail = combined.trim() || '(empty response — raw: ' + JSON.stringify(exec).slice(0, 200) + ')';
      status.textContent = '❌ ' + t('settings.sandboxTestFail', 'Sandbox check failed') + ` (sandbox ${sandboxId}, state ${lastState || 'unknown'}, exit ${norm.exitCode}):\n` + hint + detail;
    } else {
      status.style.color = 'var(--accent-green, #51cf66)';
      const firstLine = (norm.stdout || '').split('\n').filter(Boolean).slice(0, 3).join('\n');
      status.textContent = '✅ ' + t('settings.sandboxTestOk', 'Sandbox OK') + ` (sandbox ${sandboxId}):\n` + firstLine;
    }
  } catch (e) {
    status.style.color = 'var(--accent-red, #ff6b6b)';
    status.textContent = '❌ ' + t('settings.sandboxTestFail', 'Sandbox check failed') + (lastState ? ` (state ${lastState})` : '') + ': ' + (e?.message || e);
  } finally {
    if (sandboxId) {
      try { await _daytonaApiFetch(cfg, '/sandbox/' + encodeURIComponent(sandboxId), { method: 'DELETE' }); }
      catch (e) { console.warn('Daytona test sandbox cleanup failed:', e?.message || e); }
    }
    btn.disabled = false;
  }
}
function closeSettingsModal() { document.getElementById('settingsModal').classList.remove('show'); }

async function clearAllAppData() {
  const first = t('settings.clearAllConfirm1', 'Delete ALL local data on this device?');
  const second = t('settings.clearAllConfirm2', 'Final confirmation: this will permanently erase settings, conversations, memories, skills, local files, sync config, and cached blobs. Continue?');
  if (!confirm(first)) return;
  if (!confirm(second)) return;
  try {
    closeSettingsModal();
    try {
      if (navigator?.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry('blobs', { recursive: true }).catch(() => {});
      }
    } catch {}
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map(name => caches.delete(name)));
      }
    } catch {}
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch {}
    const dbs = [CONV_DB_NAME, BLOB_DB_NAME, SKILL_DB_NAME, MEM_DB_NAME];
    await Promise.all(dbs.map(name => new Promise(resolve => {
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      } catch { resolve(); }
    })));
    try {
      Object.keys(localStorage).forEach(k => { if (k.startsWith('ba_')) localStorage.removeItem(k); });
    } catch {}
    try { sessionStorage.clear(); } catch {}
    window.location.reload();
  } catch (e) {
    alert((t('settings.clearAllFailed', 'Failed to clear local data: ') || 'Failed to clear local data: ') + (e?.message || e));
  }
}

async function fetchModelsIntoSettings() {
  const status = document.getElementById('setStatus');
  const provider = document.getElementById('setProvider').value.trim() || 'anthropic_compat';
  const endpoint = document.getElementById('setEndpoint').value.trim().replace(/\/+$/, '');
  const apiKey = document.getElementById('setApiKey').value.trim();
  const seq = ++_settingsModelFetchSeq;
  _settingsModelFetchController?.abort();
  _settingsModelFetchController = null;
  if (!apiKey) { status.textContent = 'API key required to fetch models'; return; }
  if (!endpoint) { status.textContent = 'API endpoint required to fetch models'; return; }
  const controller = new AbortController();
  _settingsModelFetchController = controller;
  status.textContent = 'Fetching model list...';
  try {
    const models = await requestProviderModelList({ type: provider, endpoint, apiKey }, { signal: controller.signal });
    if (seq !== _settingsModelFetchSeq
      || provider !== (document.getElementById('setProvider').value.trim() || 'anthropic_compat')
      || endpoint !== document.getElementById('setEndpoint').value.trim().replace(/\/+$/, '')
      || apiKey !== document.getElementById('setApiKey').value.trim()) return;
    if (!models.length) { status.textContent = 'No models returned'; return; }
    const sel = document.getElementById('setAvailableModels');
    const selected = new Set(getCurrentSelectedModels());
    sel.innerHTML = models.map(m => `<option value="${esc(m)}"${selected.has(m) ? ' selected' : ''}>${esc(m)}</option>`).join('');
    status.textContent = `Fetched ${models.length} models — select one or more, then click "Add Selected"`;
  } catch (e) {
    if (seq === _settingsModelFetchSeq && !isAbortError(e)) status.textContent = 'Fetch failed: ' + e.message;
  } finally {
    if (_settingsModelFetchController === controller) _settingsModelFetchController = null;
  }
}

function getCurrentSelectedModels() {
  return document.getElementById('setModels').value.split(/[\n,]/).map(m => m.trim()).filter(Boolean);
}
function setSelectedModels(list) {
  const uniq = Array.from(new Set(list.filter(Boolean)));
  document.getElementById('setModels').value = uniq.join('\n');
  _mcUpdateModelDatalist();
  _rcUpdateModelDatalist();
}
function addSelectedModelsToList() {
  const sel = document.getElementById('setAvailableModels');
  const chosen = Array.from(sel.selectedOptions).map(o => o.value);
  if (!chosen.length) { document.getElementById('setStatus').textContent = 'No models selected in the list above'; return; }
  setSelectedModels(getCurrentSelectedModels().concat(chosen));
  document.getElementById('setStatus').textContent = `Added ${chosen.length} model(s)`;
}
function addCustomModelToList() {
  const input = document.getElementById('setCustomModel');
  const val = input.value.trim();
  if (!val) return;
  setSelectedModels(getCurrentSelectedModels().concat([val]));
  input.value = '';
  document.getElementById('setStatus').textContent = `Added "${val}"`;
}

function parseModelContexts(raw) {
  const out = {};
  raw.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([^=:\s]+)\s*[=:]\s*(\d+)\s*$/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  });
  return out;
}

// Model-context list UI (Settings modal)
const _MC_PRESETS = [
  { label: '32K', value: 32000 },
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
  { label: '1M', value: 1000000 }
];

function _mcEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _mcSyncPresetActive(row) {
  const v = parseInt(row.querySelector('.mc-value').value, 10);
  row.querySelectorAll('.mc-preset-btn').forEach(btn => {
    btn.classList.toggle('is-active', parseInt(btn.dataset.v, 10) === v);
  });
}

function _mcBuildRow(model, value) {
  const row = document.createElement('div');
  row.className = 'mc-row';
  row.dataset.model = model;
  const valAttr = Number.isFinite(value) && value > 0 ? ' value="' + value + '"' : '';
  row.innerHTML =
    '<span class="mc-model" title="' + _mcEsc(model) + '">' + _mcEsc(model) + '</span>' +
    '<input type="number" class="mc-value" min="1" placeholder="tokens"' + valAttr + '>' +
    '<div class="mc-presets">' + _MC_PRESETS.map(p => '<button type="button" class="mc-preset-btn" data-v="' + p.value + '">' + p.label + '</button>').join('') + '</div>' +
    '<button type="button" class="mc-remove" title="Remove" aria-label="Remove">&times;</button>';
  const input = row.querySelector('.mc-value');
  row.querySelectorAll('.mc-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => { input.value = btn.dataset.v; _mcSyncPresetActive(row); });
  });
  input.addEventListener('input', () => _mcSyncPresetActive(row));
  row.querySelector('.mc-remove').addEventListener('click', () => {
    row.remove();
    _mcUpdateEmptyState();
    _mcUpdateModelDatalist();
  });
  _mcSyncPresetActive(row);
  return row;
}

function _mcUpdateEmptyState() {
  const list = document.getElementById('setModelContextsList');
  const empty = document.getElementById('setModelContextsEmpty');
  if (!list || !empty) return;
  const hasRows = list.children.length > 0;
  empty.style.display = hasRows ? 'none' : 'block';
  list.style.display = hasRows ? '' : 'none';
}

function _mcUpdateModelDatalist() {
  const dl = document.getElementById('setMcModelList');
  if (!dl) return;
  const selected = getCurrentSelectedModels();
  const have = new Set(Array.from(document.querySelectorAll('#setModelContextsList .mc-row')).map(r => r.dataset.model));
  dl.innerHTML = selected.filter(m => !have.has(m)).map(m => '<option value="' + _mcEsc(m) + '"></option>').join('');
}

function renderModelContextsList(contexts) {
  const list = document.getElementById('setModelContextsList');
  if (!list) return;
  list.innerHTML = '';
  Object.entries(contexts || {}).forEach(([model, value]) => {
    list.appendChild(_mcBuildRow(model, parseInt(value, 10)));
  });
  _mcUpdateEmptyState();
  _mcUpdateModelDatalist();
}

function readModelContextsFromUI() {
  const out = {};
  document.querySelectorAll('#setModelContextsList .mc-row').forEach(row => {
    const model = row.dataset.model;
    const value = parseInt(row.querySelector('.mc-value').value, 10);
    if (model && Number.isFinite(value) && value > 0) out[model] = value;
  });
  return out;
}

function _rcEffectiveLabel(model, mode) {
  const effective = mode === 'on' || (mode === 'auto' && isDefaultReasoningContentModel(model));
  return mode === 'auto' ? (effective ? 'Auto: On' : 'Auto: Off') : (effective ? 'On' : 'Off');
}
function _rcBuildRow(model, mode = 'auto') {
  const normalizedMode = normalizeReasoningContentMode(mode);
  const row = document.createElement('div');
  row.className = 'rc-row';
  row.dataset.model = model;
  row.innerHTML =
    '<span class="rc-model" title="' + _mcEsc(model) + '">' + _mcEsc(model) + '</span>' +
    '<select class="rc-mode" aria-label="Reasoning content mode"><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select>' +
    '<span class="rc-effective"></span>' +
    '<button type="button" class="rc-remove" title="Remove" aria-label="Remove">&times;</button>';
  const select = row.querySelector('.rc-mode');
  const effective = row.querySelector('.rc-effective');
  const refresh = () => { effective.textContent = _rcEffectiveLabel(model, normalizeReasoningContentMode(select.value)); };
  select.value = normalizedMode;
  select.addEventListener('change', refresh);
  row.querySelector('.rc-remove').addEventListener('click', () => {
    row.remove();
    _rcUpdateEmptyState();
    _rcUpdateModelDatalist();
  });
  refresh();
  return row;
}
function _rcUpdateEmptyState() {
  const list = document.getElementById('setReasoningContentList');
  const empty = document.getElementById('setReasoningContentEmpty');
  if (!list || !empty) return;
  const hasRows = list.children.length > 0;
  empty.style.display = hasRows ? 'none' : 'block';
  list.style.display = hasRows ? '' : 'none';
}
function _rcUpdateModelDatalist() {
  const dl = document.getElementById('setRcModelList');
  if (!dl) return;
  const selected = getCurrentSelectedModels();
  const have = new Set(Array.from(document.querySelectorAll('#setReasoningContentList .rc-row')).map(r => r.dataset.model));
  dl.innerHTML = selected.filter(m => !have.has(m)).map(m => '<option value="' + _mcEsc(m) + '"></option>').join('');
}
function renderReasoningContentModelsList(configs) {
  const list = document.getElementById('setReasoningContentList');
  if (!list) return;
  list.innerHTML = '';
  Object.entries(normalizeReasoningContentModelsMap(configs || {})).forEach(([model, mode]) => {
    list.appendChild(_rcBuildRow(model, mode));
  });
  _rcUpdateEmptyState();
  _rcUpdateModelDatalist();
}
function readReasoningContentModelsFromUI() {
  const out = {};
  document.querySelectorAll('#setReasoningContentList .rc-row').forEach(row => {
    const model = String(row.dataset.model || '').trim();
    const mode = normalizeReasoningContentMode(row.querySelector('.rc-mode')?.value || 'auto');
    if (model) out[model] = mode;
  });
  return out;
}

function addModelContextFromInputs() {
  const mi = document.getElementById('setMcNewModel');
  const vi = document.getElementById('setMcNewValue');
  const status = document.getElementById('setStatus');
  const model = (mi.value || '').trim();
  const value = parseInt(vi.value, 10);
  if (!model) { status.textContent = 'Enter a model id'; mi.focus(); return; }
  if (!Number.isFinite(value) || value <= 0) { status.textContent = 'Enter a positive token count'; vi.focus(); return; }
  const list = document.getElementById('setModelContextsList');
  const existing = Array.from(list.querySelectorAll('.mc-row')).find(r => r.dataset.model === model);
  if (existing) {
    existing.querySelector('.mc-value').value = value;
    _mcSyncPresetActive(existing);
    existing.scrollIntoView({ block: 'nearest' });
  } else {
    list.appendChild(_mcBuildRow(model, value));
  }
  mi.value = '';
  vi.value = '';
  status.textContent = existing ? ('Updated "' + model + '"') : ('Added "' + model + '"');
  _mcUpdateEmptyState();
  _mcUpdateModelDatalist();
  mi.focus();
}

function syncModelContextsFromSelected() {
  const selected = getCurrentSelectedModels();
  const status = document.getElementById('setStatus');
  if (!selected.length) { status.textContent = 'No selected models to import'; return; }
  const list = document.getElementById('setModelContextsList');
  const have = new Set(Array.from(list.querySelectorAll('.mc-row')).map(r => r.dataset.model));
  let added = 0;
  selected.forEach(m => { if (!have.has(m)) { list.appendChild(_mcBuildRow(m, NaN)); added++; } });
  status.textContent = added ? ('Added ' + added + ' model row(s) — set a value for each') : 'All selected models already listed';
  _mcUpdateEmptyState();
  _mcUpdateModelDatalist();
}

function addReasoningContentModelFromInputs() {
  const mi = document.getElementById('setRcNewModel');
  const si = document.getElementById('setRcNewMode');
  const status = document.getElementById('setStatus');
  const model = (mi.value || '').trim();
  const mode = normalizeReasoningContentMode(si.value || 'auto');
  if (!model) { status.textContent = 'Enter a model id'; mi.focus(); return; }
  const list = document.getElementById('setReasoningContentList');
  const existing = Array.from(list.querySelectorAll('.rc-row')).find(r => r.dataset.model === model);
  if (existing) {
    existing.querySelector('.rc-mode').value = mode;
    existing.querySelector('.rc-mode').dispatchEvent(new Event('change'));
    existing.scrollIntoView({ block: 'nearest' });
  } else {
    list.appendChild(_rcBuildRow(model, mode));
  }
  mi.value = '';
  si.value = 'auto';
  status.textContent = existing ? ('Updated reasoning mode for "' + model + '"') : ('Added reasoning mode for "' + model + '"');
  _rcUpdateEmptyState();
  _rcUpdateModelDatalist();
  mi.focus();
}

function syncReasoningContentFromSelected() {
  const selected = getCurrentSelectedModels();
  const status = document.getElementById('setStatus');
  if (!selected.length) { status.textContent = 'No selected models to import'; return; }
  const list = document.getElementById('setReasoningContentList');
  const have = new Set(Array.from(list.querySelectorAll('.rc-row')).map(r => r.dataset.model));
  let added = 0;
  selected.forEach(m => { if (!have.has(m)) { list.appendChild(_rcBuildRow(m, 'auto')); added++; } });
  status.textContent = added ? ('Added ' + added + ' reasoning mode row(s)') : 'All selected models already listed';
  _rcUpdateEmptyState();
  _rcUpdateModelDatalist();
}

async function saveSettings() {
  // Save provider profile
  const profId = document.getElementById('setProviderProfile').value || _genProviderId();
  const name = document.getElementById('setProviderName').value.trim() || ('Provider ' + profId.slice(-4));
  const type = document.getElementById('setProvider').value.trim() || 'openai_compat';
  const endpoint = document.getElementById('setEndpoint').value.trim().replace(/\/+$/, '');
  const apiKey = document.getElementById('setApiKey').value.trim();
  const models = document.getElementById('setModels').value.split(/[\n,]/).map(m => m.trim()).filter(Boolean);
  const defaultModel = document.getElementById('setDefaultModel').value.trim();
  const imageModels = document.getElementById('setImageModels').value.split(/[\n,]/).map(m => m.trim()).filter(Boolean);
  const videoModels = document.getElementById('setVideoModels').value.split(/[\n,]/).map(m => m.trim()).filter(Boolean);
  const defaultImageModel = document.getElementById('setDefaultImageModel').value.trim();
  const defaultVideoModel = document.getElementById('setDefaultVideoModel').value.trim();
  const imageGenerationEndpoint = document.getElementById('setImageGenerationEndpoint').value.trim();
  const imageEditEndpoint = document.getElementById('setImageEditEndpoint').value.trim();
  const videoGenerationEndpoint = document.getElementById('setVideoGenerationEndpoint').value.trim();
  const videoStatusEndpoint = document.getElementById('setVideoStatusEndpoint').value.trim();
  const model_contexts = readModelContextsFromUI();
  const reasoning_content_models = readReasoningContentModelsFromUI();

  const providers = getProvidersMap();
  providers[profId] = { id: profId, name, type, endpoint, apiKey, models, defaultModel: defaultModel || models[0] || '', imageModels, videoModels, defaultImageModel, defaultVideoModel, imageGenerationEndpoint, imageEditEndpoint, videoGenerationEndpoint, videoStatusEndpoint, model_contexts, reasoning_content_models };
  _saveProviders({ providers });
  setActiveProviderId(profId);
  ACTIVE_PROVIDER = providers[profId];
  PROVIDER = ACTIVE_PROVIDER.type;

  // Save non-provider settings
  const tavilyKey = document.getElementById('setTavilyKey').value.trim();
  const memEnabled = document.getElementById('setMemEnabled').checked;
  const memAutoExtract = document.getElementById('setMemAutoExtract').checked;
  const memMaxRecallRaw = parseInt(document.getElementById('setMemMaxRecall').value, 10);
  const memMaxRecall = Number.isFinite(memMaxRecallRaw) && memMaxRecallRaw >= 0 ? Math.min(40, memMaxRecallRaw) : MEM_DEFAULTS.maxRecall;
  const ralphMaxRaw = parseInt(document.getElementById('setRalphMaxIterations').value, 10);
  const ralphUnlimited = document.getElementById('setRalphUnlimited').checked;
  const ralphMaxIterations = Number.isFinite(ralphMaxRaw) ? Math.min(RALPH_DEFAULTS.hardMaxIterations, Math.max(1, ralphMaxRaw)) : RALPH_DEFAULTS.maxIterations;
  const ralphCompletionMarker = document.getElementById('setRalphCompletionMarker').value.trim() || RALPH_DEFAULTS.completionMarker;
  const taskNotificationsEnabled = document.getElementById('setTaskNotifications').checked;
  const taskNotificationPermission = taskNotificationsEnabled ? await requestTaskNotificationPermissionIfNeeded() : '';
  const prevSettings = loadSettings() || {};
  const prevMem = prevSettings.memory || {};
  const settings = {
    ...prevSettings,
    tavily_api_key: tavilyKey,
    ralph: { enabled: document.getElementById('setRalphEnabled').checked, unlimited: ralphUnlimited, maxIterations: ralphMaxIterations, completionMarker: ralphCompletionMarker },
    taskNotifications: { enabled: taskNotificationsEnabled },
    memory: { enabled: memEnabled, autoExtract: memAutoExtract, maxRecall: memMaxRecall, extractionModel: prevMem.extractionModel || '' }
  };
  saveSettingsToStorage(settings);
  ralphModeEnabled = settings.ralph.enabled;
  renderRalphButton();
  // Swarm settings (stored in their own localStorage key)
  const swConcRaw = parseInt(document.getElementById('setSwarmConcurrency').value, 10);
  const swMaxRaw = parseInt(document.getElementById('setSwarmMaxWorkers').value, 10);
  const swBudRaw = parseInt(document.getElementById('setSwarmTotalBudget').value, 10);
  const swChainRaw = parseInt(document.getElementById('setSwarmMaxHandoffChain').value, 10);
  const prevAgentRolesPersist = !!swarmSettings.agentRolesPersist;
  const prevAgentRolesPerConv = !!swarmSettings.agentRolesPerConv;
  const newAgentRolesPersist = document.getElementById('setSwarmAgentRolesPersist').checked;
  const newAgentRolesPerConv = newAgentRolesPersist && document.getElementById('setSwarmAgentRolesPerConv').checked;
  swarmSettings = {
    ...SWARM_DEFAULTS,
    ...swarmSettings,
    enabled: document.getElementById('setSwarmEnabled').checked,
    maxConcurrency: Number.isFinite(swConcRaw) ? Math.min(8, Math.max(1, swConcRaw)) : SWARM_DEFAULTS.maxConcurrency,
    maxWorkersPerRun: Number.isFinite(swMaxRaw) ? Math.min(32, Math.max(1, swMaxRaw)) : SWARM_DEFAULTS.maxWorkersPerRun,
    totalTokenBudget: Number.isFinite(swBudRaw) ? Math.min(2000000, Math.max(10000, swBudRaw)) : SWARM_DEFAULTS.totalTokenBudget,
    workerModel: (document.getElementById('setSwarmWorkerModel').value || '').trim(),
    allowWriteRoles: document.getElementById('setSwarmAllowWrite').checked,
    maxHandoffChain: Number.isFinite(swChainRaw) ? Math.min(8, Math.max(1, swChainRaw)) : SWARM_DEFAULTS.maxHandoffChain,
    roleManagerEnabled: document.getElementById('setSwarmRoleManagerEnabled').checked,
    agentRolesPersist: newAgentRolesPersist,
    agentRolesPerConv: newAgentRolesPerConv,
  };
  saveSwarmSettings();
  // v4: react to persistence-mode flips. Goal — keep the agent's currently-known roles
  // visible after the switch by writing them to whichever store is now active. Do not
  // touch the alternate store, so user can flip back to recover prior state.
  if (newAgentRolesPersist && !prevAgentRolesPersist) {
    // memory → persisted: snapshot current memory list into the chosen store.
    saveAgentSwarmRoles();
  } else if (!newAgentRolesPersist && prevAgentRolesPersist) {
    // persisted → memory: leave existing stored copy intact (user can flip back), just stop autosaving.
  } else if (newAgentRolesPersist && (newAgentRolesPerConv !== prevAgentRolesPerConv)) {
    // perConv flip: write to the new destination so the in-memory list survives the change.
    saveAgentSwarmRoles();
  }
  if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();

  // Cron Scheduler global enabled toggle
  try {
    const wasOn = CronScheduler.isEnabledGlobally();
    const nowOn = document.getElementById('setCronEnabled').checked;
    if (wasOn !== nowOn) CronScheduler.setEnabledGlobally(nowOn);
  } catch (e) { console.warn('cron toggle save failed', e); }

  if (memEnabled && !prevMem.enabled) { openMemDB().catch(e => console.warn('Memory DB open failed', e)); memLoadCache().catch(() => {}); }
  renderMemoryButton();
  rebuildToolDefs();

  // Update runtime keys
  _keys = Object.assign(_keys || {}, {
    api_key: apiKey,
    tavily_api_key: tavilyKey,
    api_endpoint: endpoint,
    api_models: models,
    api_model: ACTIVE_PROVIDER.defaultModel || '',
    model_contexts,
    reasoning_content_models
  });
  CFG.api_endpoint = endpoint;
  Object.keys(MODEL_CONTEXTS).forEach(k => delete MODEL_CONTEXTS[k]);
  Object.assign(MODEL_CONTEXTS, model_contexts);
  Object.keys(MODEL_REASONING_CONTENT).forEach(k => delete MODEL_REASONING_CONTENT[k]);
  Object.assign(MODEL_REASONING_CONTENT, reasoning_content_models);

  // Choose active model
  const desired = (defaultModel && models.includes(defaultModel)) ? defaultModel : (models.includes(API_MODEL) ? API_MODEL : (models[0] || API_MODEL));
  API_MODEL = desired;
  localStorage.setItem('ba_selected_model', API_MODEL);

  // Refresh top bar selects
  populateProviderSelect();
  populateModelSelectFromActiveProvider();
  populateMediaModelSelect();
  applyModelContextLimit();
  updateWsStatus();

  _saveS3CfgFromModal();
  _saveStateCfgFromModal();
  // Sandbox config
  const prevSandbox = getSandboxConfig();
  const _numOr = (id, def) => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? v : def; };
  const newSandbox = {
    enabled: document.getElementById('setSandboxEnabled').checked,
    platform: document.getElementById('setSandboxPlatform').value || 'daytona',
    daytonaApiKey: document.getElementById('setDaytonaApiKey').value.trim(),
    daytonaServerUrl: document.getElementById('setDaytonaServerUrl').value.trim() || SANDBOX_DEFAULTS.daytonaServerUrl,
    daytonaTimeout: _numOr('setDaytonaTimeout', SANDBOX_DEFAULTS.daytonaTimeout),
    daytonaImage: document.getElementById('setDaytonaImage').value.trim(),
    daytonaAutoStopInterval: _numOr('setDaytonaAutoStop', SANDBOX_DEFAULTS.daytonaAutoStopInterval),
    daytonaAutoArchiveInterval: _numOr('setDaytonaAutoArchive', SANDBOX_DEFAULTS.daytonaAutoArchiveInterval),
    daytonaAutoDeleteInterval: _numOr('setDaytonaAutoDelete', SANDBOX_DEFAULTS.daytonaAutoDeleteInterval),
  };
  saveSandboxConfig(newSandbox);
  const wasRemote = !!prevSandbox.enabled && prevSandbox.platform === 'daytona';
  const nowRemote = newSandbox.enabled && newSandbox.platform === 'daytona';
  if (wasRemote && !nowRemote && activeConvId) {
    daytonaClient.destroy(activeConvId).catch(() => {});
  }
  rebuildToolDefs();
  closeSettingsModal();
  appendSystemMsg('Settings saved.');
  if (taskNotificationsEnabled && taskNotificationPermission === 'denied') appendSystemMsg(t('settings.taskNotificationsBlocked', 'Task notifications are enabled, but browser notification permission is blocked.'));
  else if (taskNotificationsEnabled && taskNotificationPermission === 'unsupported') appendSystemMsg(t('settings.taskNotificationsUnsupported', 'Task notifications are enabled, but this browser context does not support notifications.'));
}

