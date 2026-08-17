/* creel harness — part 9 of 26: tools-remote
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
 *   - REMOTE TOOL WRAPPERS — route PythonExec/JSExec/Bash to Daytona
 */
// ═══════════════════════════════════════════════════════════════════
// REMOTE TOOL WRAPPERS — route PythonExec/JSExec/Bash to Daytona
// ═══════════════════════════════════════════════════════════════════
const _DAYTONA_MISSING_SHELL_RE = /fork\/exec\s+\S+:\s+no such file or directory/i;
function _daytonaShellHint(combined) {
  if (!_DAYTONA_MISSING_SHELL_RE.test(combined)) return '';
  return 'Daytona sandbox cannot spawn its login shell — the snapshot is missing the required binary (commonly /usr/bin/zsh). Fix: open Settings → Code Sandbox and clear DAYTONA_IMAGE so Daytona falls back to its working built-in snapshot, or pin an image that ships the required shell. Original error follows:\n';
}
function _appendDaytonaSyncWarnings(output, warnings) {
  const unique = [...new Set(warnings || [])];
  return unique.length ? output + '\n[sandbox sync warnings]\n- ' + unique.join('\n- ') : output;
}
async function _refreshDaytonaSyncUi(convId, root, result) {
  if (visibleConvId !== convId || vfs !== root || !result) return;
  const changed = new Set(result.changedPaths || []);
  const deleted = new Set(result.deletedPaths || []);
  if (changed.size || deleted.size) renderFileTree();
  const viewer = document.getElementById('fileViewer');
  if (!viewer?.classList.contains('show')) return;
  const path = normPath(document.getElementById('fvPath')?.textContent || '/');
  if (!changed.has(path) && !deleted.has(path)) return;
  const area = document.getElementById('feEditArea');
  if (area) {
    document.getElementById('fvRemoteSyncNotice')?.remove();
    const notice = document.createElement('div');
    notice.id = 'fvRemoteSyncNotice';
    notice.style.cssText = 'padding:7px 10px;background:var(--warning-bg,#4a3300);color:var(--text-primary);font-size:11px';
    notice.textContent = deleted.has(path)
      ? 'The sandbox deleted this file. Your editor text is unchanged; save to recreate it or close without saving.'
      : 'The sandbox has a newer version. Your editor text is unchanged; reopen the file to view the synced version.';
    document.getElementById('fvContent')?.prepend(notice);
  } else if (deleted.has(path)) {
    closeFileViewer(true);
  } else {
    await openFileViewer(path);
  }
}
async function _remoteWrap(input, exec) {
  const run = currentRunContext;
  const convId = run?.convId || activeConvId;
  if (!convId) return 'Error: no active conversation to bind a remote sandbox to.';
  const root = run?.state?.vfs || vfs;
  const syncWarnings = [];
  if (window._daytonaSessions[convId]) {
    let before;
    try { before = await syncVfsFromRemote(convId, root); }
    catch (e) { return 'Error (sandbox pre-sync): ' + (e.message || e); }
    syncWarnings.push(...before.warnings);
    if (run) activateConversationRun(run);
    await _refreshDaytonaSyncUi(convId, root, before);
    if (before.incomplete) return _appendDaytonaSyncWarnings('Error (sandbox pre-sync): remote file state was incomplete; no local files were uploaded.', syncWarnings);
  }
  try {
    const pushed = await syncVfsToRemote(convId, root);
    syncWarnings.push(...pushed.warnings);
    if (run) activateConversationRun(run);
  } catch (e) { return 'Error (sandbox syncIn): ' + (e.message || e); }
  let res;
  try { res = await exec(convId); if (run) activateConversationRun(run); }
  catch (e) { return 'Error (sandbox exec): ' + (e.message || e); }
  try {
    const after = await syncVfsFromRemote(convId, root);
    syncWarnings.push(...after.warnings);
    if (run) activateConversationRun(run);
    await _refreshDaytonaSyncUi(convId, root, after);
  } catch (e) { syncWarnings.push('Could not sync sandbox changes back to VFS: ' + (e?.message || e)); }
  const { stdout = '', stderr = '', exitCode = 0, _raw = null } = res || {};
  const hint = _daytonaShellHint(stdout + '\n' + stderr);
  const parts = [];
  if (exitCode && !stdout && !stderr) {
    let rawDump = '';
    try { rawDump = '\nraw response: ' + JSON.stringify(_raw).slice(0, 400); } catch {}
    parts.push((hint || '') + `Exit ${exitCode} (no stdout/stderr from Daytona — sandbox may still be warming up or the toolbox returned a bare error envelope).` + rawDump);
  } else {
    if (hint) parts.push(hint);
    if (stdout) parts.push(stdout);
    if (stderr) parts.push((stdout ? '\n' : '') + 'stderr:\n' + stderr);
    if (exitCode) parts.push(`\n[exit ${exitCode}]`);
  }
  return _appendDaytonaSyncWarnings(parts.join('') || '(no output)', syncWarnings);
}
async function toolPythonExecRemote(input) {
  const code = input?.code || '';
  if (!code) return 'Error: code is required.';
  const pkgs = Array.isArray(input?.packages) ? input.packages : [];
  return _remoteWrap(input, async (convId) => {
    if (pkgs.length) {
      const r = await daytonaClient.execShell(convId, 'pip install --quiet ' + pkgs.map(p => `'${String(p).replace(/'/g, "'\\''")}'`).join(' '));
      if (r.exitCode) return { stdout: r.stdout, stderr: 'pip install failed:\n' + r.stderr, exitCode: r.exitCode };
    }
    return daytonaClient.execPython(convId, code);
  });
}
async function toolJSExecRemote(input) {
  const code = input?.code || '';
  if (!code) return 'Error: code is required.';
  return _remoteWrap(input, (convId) => daytonaClient.execNode(convId, code));
}
async function toolBashRemote(input) {
  const cmd = (input?.command || '').trim();
  if (!cmd) return '';
  return _remoteWrap(input, (convId) => daytonaClient.execShell(convId, cmd));
}

function _truncateNodeOutput(text) {
  text = String(text || '');
  if (text.length <= NODEEXEC_MAX_OUTPUT_CHARS) return text;
  return text.slice(0, NODEEXEC_MAX_OUTPUT_CHARS) + `\n... output truncated after ${NODEEXEC_MAX_OUTPUT_CHARS} characters ...`;
}

function _nodeExecSummary(label, sync) {
  if (!sync || !sync.files?.length) return `${label}: 0 file(s)`;
  const shown = sync.files.slice(0, 20).map(p => `- ${p}`).join('\n');
  const more = sync.files.length > 20 ? `\n- ... ${sync.files.length - 20} more` : '';
  return `${label}: ${sync.files.length} file(s), ${_formatBytes(sync.bytes)}\n${shown}${more}`;
}

async function _collectWebContainerProcessOutput(proc) {
  const chunks = [];
  if (!proc.output || typeof proc.output.pipeTo !== 'function') return chunks;
  await proc.output.pipeTo(new WritableStream({
    write(data) { chunks.push(String(data)); }
  })).catch(() => {});
  return chunks;
}

async function toolNodeExec(input) {
  input = input && typeof input === 'object' ? input : {};
  const hasCode = typeof input.code === 'string' && input.code.length > 0;
  const hasScript = typeof input.script_path === 'string' && input.script_path.trim().length > 0;
  if (hasCode === hasScript) return 'Error: NodeExec requires exactly one of code or script_path.';
  try {
    const wc = await ensureWebContainer();
    const timeoutMs = Math.max(1, Math.min(Number(input.timeout_ms) || NODEEXEC_DEFAULT_TIMEOUT_MS, NODEEXEC_MAX_TIMEOUT_MS));
    const allowRootSync = input.allow_root_sync === true;
    const syncIn = Array.isArray(input.sync_in) ? [...input.sync_in] : [];
    const syncOut = Array.isArray(input.sync_out) ? input.sync_out : [];
    let scriptPath;
    if (hasScript) {
      const vfsScript = normPath(input.script_path);
      if (!vfsResolve(vfsScript)) return `Error: script_path not found in VFS: ${vfsScript}`;
      if (!syncIn.some(e => normPath((e && typeof e === 'object' ? e.source_path || e.vfs_path : e) || '') === vfsScript)) syncIn.push({ source_path: vfsScript, target_path: vfsScript });
      scriptPath = _wcNativePath(vfsScript, '/script.js');
    }
    const syncInResult = await _syncVfsToWebContainer(wc, syncIn, { allowRootSync, maxFiles: NODEEXEC_MAX_SYNC_FILES, maxBytes: NODEEXEC_MAX_SYNC_BYTES });
    if (hasCode) {
      const moduleType = input.module_type === 'commonjs' ? 'commonjs' : 'module';
      scriptPath = `${NODEEXEC_RUN_DIR}/run-${Date.now()}-${Math.random().toString(36).slice(2)}.${moduleType === 'commonjs' ? 'cjs' : 'mjs'}`;
      await _wcWriteFile(wc, scriptPath, { binary: false, content: input.code }, true);
    }
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const cwdPath = _wcNativePath(input.cwd || '/', '/');
    const cwd = _wcProjectPath(cwdPath);
    const scriptArg = _wcRelativePath(cwdPath, scriptPath);
    const env = input.env && typeof input.env === 'object' ? Object.fromEntries(Object.entries(input.env).map(([k, v]) => [String(k), String(v)])) : undefined;
    const command = ['node', scriptArg, ...args];
    const proc = await wc.spawn('node', [scriptArg, ...args], { cwd, ...(env ? { env } : {}) });
    const outputPromise = _collectWebContainerProcessOutput(proc);
    let timedOut = false;
    const exitPromise = proc.exit;
    let timeoutId = null;
    const timeoutPromise = new Promise(resolve => { timeoutId = setTimeout(() => { timedOut = true; try { proc.kill?.(); } catch {} resolve('timeout'); }, timeoutMs); });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    const output = _truncateNodeOutput((await outputPromise).join(''));
    if (timedOut || exitCode === 'timeout') return `Error: NodeExec timed out after ${timeoutMs}ms.\n\n${_nodeExecSummary('Synced into WebContainer', syncInResult)}\n\nCommand:\n${command.join(' ')}\n\nOutput:\n${output || '(no output)'}`;
    const syncOutResult = await _syncWebContainerToVfs(wc, syncOut, { allowRootSync, maxFiles: NODEEXEC_MAX_SYNC_FILES, maxBytes: NODEEXEC_MAX_SYNC_BYTES });
    const header = exitCode === 0 ? `NodeExec completed with exit code ${exitCode}.` : `Error: NodeExec exited with code ${exitCode}.`;
    return `${header}\n\n${_nodeExecSummary('Synced into WebContainer', syncInResult)}\n\nCommand:\n${command.join(' ')}\n\nOutput:\n${output || '(no output)'}\n\n${_nodeExecSummary('Synced back to VFS', syncOutResult)}`;
  } catch (e) {
    return `Error: ${e.message || e}`;
  }
}

// ── Skill persistence: metadata in localStorage, files in IndexedDB ──
const SKILL_DB_NAME = 'ba_skill_files';
const SKILL_DB_VER = 1;
const SKILL_STORE = 'files';

function openSkillDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SKILL_DB_NAME, SKILL_DB_VER);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(SKILL_STORE)) db.createObjectStore(SKILL_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSkillFilesToDB(skillName, payload) {
  try {
    const db = await openSkillDB();
    const tx = db.transaction(SKILL_STORE, 'readwrite');
    tx.objectStore(SKILL_STORE).put(payload || { files: {}, binaryFiles: {} }, skillName);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) { console.warn('Failed to save skill files to IndexedDB:', e); }
}

async function loadSkillFilesFromDB(skillName) {
  try {
    const db = await openSkillDB();
    const tx = db.transaction(SKILL_STORE, 'readonly');
    const req = tx.objectStore(SKILL_STORE).get(skillName);
    return new Promise((res) => {
      req.onsuccess = () => {
        const result = req.result;
        if (!result) return res({ files: {}, binaryFiles: {} });
        if (result.files || result.binaryFiles) return res({ files: result.files || {}, binaryFiles: result.binaryFiles || {} });
        return res({ files: result, binaryFiles: {} });
      };
      req.onerror = () => res({ files: {}, binaryFiles: {} });
    });
  } catch { return { files: {}, binaryFiles: {} }; }
}

async function deleteSkillFilesFromDB(skillName) {
  try {
    const db = await openSkillDB();
    const tx = db.transaction(SKILL_STORE, 'readwrite');
    tx.objectStore(SKILL_STORE).delete(skillName);
  } catch {}
}

async function loadSkills() {
  try {
    const saved = localStorage.getItem('ba_skills');
    if (saved) skills = JSON.parse(saved);
  } catch {}
  // Restore files from IndexedDB
  for (const s of skills) {
    const needsFiles = !s.files || Object.keys(s.files).length === 0;
    const needsBinary = !s.binaryFiles || Object.keys(s.binaryFiles).length === 0;
    if (needsFiles || needsBinary) {
      const stored = await loadSkillFilesFromDB(s.name);
      s.files = stored.files || s.files || {};
      s.binaryFiles = stored.binaryFiles || s.binaryFiles || {};
    }
    if (!s.files) s.files = {};
    if (!s.binaryFiles) s.binaryFiles = {};
    if (s.active) mountSkillToVfs(s);
  }
  renderSkills();
}

function saveSkills() {
  // Save metadata to localStorage (strip large files to fit 5MB limit)
  const lite = skills.map(s => {
    const { files, binaryFiles, ...meta } = s;
    return meta;
  });
  try { localStorage.setItem('ba_skills', JSON.stringify(lite)); } catch (e) { console.warn('localStorage save failed:', e); }
  // Save files to IndexedDB (no size limit)
  for (const s of skills) {
    if ((s.files && Object.keys(s.files).length > 0) || (s.binaryFiles && Object.keys(s.binaryFiles).length > 0)) {
      saveSkillFilesToDB(s.name, { files: s.files || {}, binaryFiles: s.binaryFiles || {} });
    }
  }
  if (typeof schedulePush === 'function') schedulePush();
}

// Parse SKILL.md: YAML frontmatter (---...---) + Markdown body
function parseSkillMd(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const yamlStr = m[1], body = m[2].trim();
  // Minimal YAML parser for flat/shallow keys
  const meta = {};
  let currentKey = null;
  for (const line of yamlStr.split('\n')) {
    const kv = line.match(/^(\w[\w.-]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1], val = kv[2].replace(/^["']|["']$/g, '').trim();
      if (val === '' || val === '|' || val === '>') { currentKey = key; meta[key] = ''; }
      else if (val.startsWith('[')) { try { meta[key] = JSON.parse(val); } catch { meta[key] = val; } }
      else if (val.startsWith('{')) { try { meta[key] = JSON.parse(val); } catch { meta[key] = val; } }
      else meta[key] = val;
      if (val) currentKey = null;
    } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      meta[currentKey] += (meta[currentKey] ? '\n' : '') + line.trim();
    } else if (line.match(/^\s+-\s/)) {
      // Array items under current key
      if (currentKey && !Array.isArray(meta[currentKey])) meta[currentKey] = [];
      if (currentKey) meta[currentKey].push(line.replace(/^\s+-\s*/, '').trim());
    } else {
      // Nested key like metadata.author
      const nested = line.match(/^\s+(\w+):\s*(.+)$/);
      if (nested && currentKey) {
        if (typeof meta[currentKey] !== 'object' || Array.isArray(meta[currentKey])) meta[currentKey] = {};
        meta[currentKey][nested[1]] = nested[2].replace(/^["']|["']$/g, '').trim();
      }
    }
  }
  return { meta, body };
}

let skillInstallInProgress = false;

function setSkillInstallProgress(text, pct = 0, show = true) {
  const box = document.getElementById('skillInstallProgress');
  const label = document.getElementById('skillInstallProgressText');
  const fill = document.getElementById('skillInstallProgressFill');
  if (box) box.classList.toggle('show', !!show);
  if (label) label.textContent = text || '';
  if (fill) fill.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
  const disabled = !!show && skillInstallInProgress;
  document.querySelectorAll('#skillModal button, #skillModal input, #skillModal textarea').forEach(el => {
    if (el.classList.contains('modal-close')) return;
    if (disabled) {
      if (el.dataset.installDisabled !== '1') el.dataset.installWasDisabled = el.disabled ? '1' : '0';
      el.dataset.installDisabled = '1';
      el.disabled = true;
    } else if (el.dataset.installDisabled === '1') {
      const wasDisabled = el.dataset.installWasDisabled === '1';
      delete el.dataset.installDisabled;
      delete el.dataset.installWasDisabled;
      el.disabled = wasDisabled;
    }
  });
}

async function runSkillInstallTask(label, task, options = {}) {
  if (skillInstallInProgress) return null;
  skillInstallInProgress = true;
  const button = options.button || null;
  const oldText = button ? button.innerHTML : '';
  let success = false;
  try {
    setSkillInstallProgress(label || 'Installing skill...', 8, true);
    const result = await task((text, pct) => setSkillInstallProgress(text, pct, true));
    success = true;
    setSkillInstallProgress('Skill installed.', 100, true);
    return result;
  } catch (e) {
    const message = e?.message || String(e);
    setSkillInstallProgress('Skill install failed: ' + message, 100, true);
    if (!options.silentError) alert('Skill install failed: ' + message);
    if (options.rethrow) throw e;
    return null;
  } finally {
    skillInstallInProgress = false;
    setTimeout(() => setSkillInstallProgress('', 0, false), success ? 700 : 1800);
    if (button) { button.disabled = false; button.innerHTML = oldText; }
  }
}

const SKILL_MANAGER_READ_ACTIONS = new Set(['list', 'inspect']);
const SKILL_MANAGER_WRITE_ACTIONS = new Set(['create', 'install_from_markdown', 'install_from_json', 'install_from_github', 'install_from_workspace', 'update', 'set_active', 'remove']);
const SKILL_MANAGER_ALLOWED_UPDATE_FIELDS = new Set(['description', 'icon', 'body', 'trigger', 'version', 'author', 'license', 'tools', 'references', 'scripts', 'files', 'binaryFiles', 'active']);

function skillManagerResult(payload) {
  return JSON.stringify(payload, null, 2);
}

function skillManagerError(action, error, extra = {}) {
  return skillManagerResult({ ok: false, action, error, ...extra });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeSkillName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 80 && !/[\\/\x00-\x1F\x7F]/.test(name) && !name.includes('..');
}

function isSafeSkillRelPath(path) {
  return typeof path === 'string' && path.trim().length > 0 && !path.startsWith('/') && !path.includes('..') && !path.includes('\\') && !/[\x00-\x1F\x7F]/.test(path);
}

function findSkillByIdOrName(ref = {}) {
  const id = String(ref.id || '').trim();
  const name = String(ref.name || '').trim();
  if (id) return skills.find(s => s.id === id) || null;
  if (name) return skills.find(s => s.name === name) || null;
  return null;
}

function normalizeSkill(skill, options = {}) {
  const s = isPlainObject(skill) ? skill : {};
  if (!s.id) s.id = 'skill_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!s.name && options.name) s.name = options.name;
  if (!s.icon) s.icon = 'i:bolt';
  s.name = String(s.name || '').trim();
  s.description = String(s.description || '');
  s.body = String(s.body || '');
  s.trigger = String(s.trigger || '');
  s.version = String(s.version || '');
  s.author = String(s.author || '');
  s.license = String(s.license || '');
  if (!s.source) s.source = options.source || 'ai';
  s.active = s.active !== false;
  if (!Array.isArray(s.tools)) s.tools = [];
  if (!isPlainObject(s.references)) s.references = {};
  if (!isPlainObject(s.scripts)) s.scripts = {};
  if (!isPlainObject(s.files)) s.files = {};
  if (!isPlainObject(s.binaryFiles)) s.binaryFiles = {};
  return s;
}

function getBuiltInToolNames() {
  return new Set([
    ...BASE_TOOLS_ANTHROPIC.map(t => t.name),
    ...PYODIDE_NATIVE_TOOLS.map(t => t.name),
    'SkillManager',
    'memory_save',
    'memory_search',
    'memory_update',
    'memory_forget'
  ]);
}

function validateSkillInput(skill, context = {}) {
  const errors = [];
  if (!isSafeSkillName(skill.name)) errors.push('Skill name must be 1-80 characters and cannot contain /, \\, .., or control characters.');
  for (const group of ['files', 'references', 'scripts', 'binaryFiles']) {
    if (!isPlainObject(skill[group])) { errors.push(`${group} must be an object.`); continue; }
    for (const key of Object.keys(skill[group])) {
      const path = group === 'references' ? `references/${key}` : group === 'scripts' ? `scripts/${key}` : key;
      if (!isSafeSkillRelPath(path)) errors.push(`Invalid ${group} path: ${key}`);
    }
  }
  if (!Array.isArray(skill.tools)) errors.push('tools must be an array.');
  const builtIns = getBuiltInToolNames();
  const toolNames = new Set();
  for (const tool of skill.tools || []) {
    if (!isPlainObject(tool)) { errors.push('Each tool must be an object.'); continue; }
    const name = String(tool.name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) errors.push(`Invalid tool name: ${name || '(empty)'}`);
    if (builtIns.has(name)) errors.push(`Tool name conflicts with built-in tool: ${name}`);
    if (toolNames.has(name)) errors.push(`Duplicate tool name in skill: ${name}`);
    const conflictingSkill = skills.find(s => s.id !== skill.id && s.name !== skill.name && (s.tools || []).some(t => t?.name === name));
    if (conflictingSkill) errors.push(`Tool name conflicts with skill "${conflictingSkill.name}": ${name}`);
    toolNames.add(name);
    if (tool.parameters !== undefined && !isPlainObject(tool.parameters)) errors.push(`Tool parameters must be an object: ${name}`);
  }
  if (context.operation === 'update' && context.updates && Object.prototype.hasOwnProperty.call(context.updates, 'name')) {
    errors.push('Renaming skills is not supported by SkillManager update yet. Create a new skill and remove the old one instead.');
  }
  return errors;
}

function skillHasExecutableHandlers(skill) {
  return (skill.tools || []).some(t => typeof t?.handler === 'string' && t.handler.trim());
}

function assessSkillRisk(skill, operation, oldSkill = null, options = {}) {
  const reasons = [];
  if (operation === 'remove') reasons.push('This deletes the skill metadata and stored files.');
  if (operation === 'install' && oldSkill) reasons.push(`This overwrites existing skill "${oldSkill.name}".`);
  if (operation === 'install_github') reasons.push('This installs skill files from a remote GitHub repository.');
  if ((operation === 'install' || operation === 'install_github' || operation === 'create') && Object.keys(skill.scripts || {}).length) reasons.push('Skill defines executable skill scripts.');
  if ((operation === 'install' || operation === 'install_github' || operation === 'create' || operation === 'update') && skillHasExecutableHandlers(skill)) reasons.push('Skill defines executable tool handlers.');
  if (operation === 'set_active' && options.active === true && skillHasExecutableHandlers(skill)) reasons.push('Activating this skill can expose executable handlers to the agent.');
  if (operation === 'update') {
    const updates = options.updates || {};
    if (Object.prototype.hasOwnProperty.call(updates, 'tools')) reasons.push('This changes skill tool definitions.');
    if (Object.prototype.hasOwnProperty.call(updates, 'scripts')) reasons.push('This changes executable skill scripts.');
    const fileGroupsChanged = ['files', 'references', 'scripts'].filter(k => Object.prototype.hasOwnProperty.call(updates, k));
    const changedCount = fileGroupsChanged.reduce((n, k) => n + Object.keys(updates[k] || {}).length, 0);
    if (changedCount > 10) reasons.push('This changes many skill resource files.');
  }
  const level = reasons.some(r => r.includes('executable') || r.includes('handlers') || r.includes('scripts')) ? 'high' : reasons.length ? 'medium' : 'low';
  return { level, reasons };
}

function requiresSkillManagerConfirmation(risk, operation) {
  return operation === 'remove' || risk.level === 'high' || risk.reasons.some(r => r.includes('overwrites'));
}

function serializeSkillForTool(skill, options = {}) {
  const body = options.includeBody ? truncateMiddleText(skill.body || '', options.maxBodyChars || 8000) : undefined;
  const tools = (skill.tools || []).map(t => ({ name: t.name, description: t.description || '', parameters: t.parameters || {}, hasHandler: !!(typeof t.handler === 'string' && t.handler.trim()), handlerLength: typeof t.handler === 'string' ? t.handler.length : 0 }));
  const risk = assessSkillRisk(skill, 'inspect');
  const data = {
    id: skill.id,
    name: skill.name,
    description: skill.description || '',
    icon: skill.icon || 'i:bolt',
    active: skill.active !== false,
    source: skill.source || '',
    version: skill.version || '',
    author: skill.author || '',
    license: skill.license || '',
    trigger: skill.trigger || '',
    toolNames: tools.map(t => t.name).filter(Boolean),
    hasExecutableHandlers: skillHasExecutableHandlers(skill),
    referenceCount: Object.keys(skill.references || {}).length,
    scriptCount: Object.keys(skill.scripts || {}).length,
    fileCount: Object.keys(skill.files || {}).length,
    binaryFileCount: Object.keys(skill.binaryFiles || {}).length,
    riskLevel: risk.level
  };
  if (options.detail) {
    data.body = body;
    data.references = Object.keys(skill.references || {});
    data.scripts = Object.keys(skill.scripts || {});
    data.files = Object.keys(skill.files || {});
    data.binaryFiles = Object.keys(skill.binaryFiles || {});
    data.tools = tools;
  }
  return data;
}

function isSkillManagerWriteAction(input = {}) {
  return SKILL_MANAGER_WRITE_ACTIONS.has(String(input.action || '').trim());
}

function setSkillActiveByIdOrName(ref, active) {
  const skill = findSkillByIdOrName(ref);
  if (!skill) return { skill: null, changed: false };
  const desired = active !== false;
  if ((skill.active !== false) === desired) return { skill, changed: false };
  skill.active = desired;
  if (skill.active) mountSkillToVfs(skill); else unmountSkillFromVfs(skill);
  saveSkills(); renderSkills(); rebuildToolDefs();
  return { skill, changed: true };
}

function applySkillUpdates(existing, updates = {}) {
  const next = { ...existing };
  for (const key of Object.keys(updates || {})) {
    if (!SKILL_MANAGER_ALLOWED_UPDATE_FIELDS.has(key)) continue;
    next[key] = updates[key];
  }
  return normalizeSkill(next, { source: existing.source || 'ai:update' });
}

function updateSkillByIdOrName(ref, updates = {}) {
  const existing = findSkillByIdOrName(ref);
  if (!existing) return { skill: null, oldSkill: null, changedFields: [] };
  const next = applySkillUpdates(existing, updates);
  const changedFields = Object.keys(updates || {}).filter(k => SKILL_MANAGER_ALLOWED_UPDATE_FIELDS.has(k));
  const wasActive = existing.active !== false;
  const willBeActive = next.active !== false;
  if (wasActive) unmountSkillFromVfs(existing, true);
  const idx = skills.findIndex(s => s.id === existing.id);
  if (idx >= 0) skills[idx] = next;
  if (willBeActive) mountSkillToVfs(next); else if (wasActive) renderFileTree();
  saveSkills(); renderSkills(); rebuildToolDefs();
  return { skill: next, oldSkill: existing, changedFields };
}

function installSkill(skill) {
  skill = normalizeSkill(skill);
  // Remove old version
  const old = skills.find(s => s.name === skill.name);
  if (old) unmountSkillFromVfs(old);
  skills = skills.filter(s => s.name !== skill.name);
  skills.push(skill);
  if (skill.active) mountSkillToVfs(skill);
  saveSkills(); renderSkills(); rebuildToolDefs();
  logMemEntry('write', `Skill installed: ${skill.name} (${skill.source || 'unknown'})`);
}

function removeSkill(id) {
  const s = skills.find(s => s.id === id);
  if (s) { unmountSkillFromVfs(s); deleteSkillFilesFromDB(s.name); }
  skills = skills.filter(s => s.id !== id);
  saveSkills(); renderSkills(); rebuildToolDefs();
}

function toggleSkill(id) {
  const s = skills.find(s => s.id === id);
  if (!s) return;
  s.active = !s.active;
  if (s.active) mountSkillToVfs(s); else unmountSkillFromVfs(s);
  saveSkills(); renderSkills(); rebuildToolDefs();
}

// Mount skill files into VFS at /skills/<name>/
async function mountSkillToVfs(skill, skipRender) {
  const base = `/skills/${skill.name}`;
  const batch = true;
  if (skill.body) vfsWrite(`${base}/SKILL.md`, `---\nname: ${skill.name}\ndescription: ${skill.description || ''}\n---\n\n${skill.body}`, batch);
  for (const [rel, content] of Object.entries(skill.files || {})) {
    vfsWrite(`${base}/${rel}`, content, batch);
  }
  for (const [rel, bytesArr] of Object.entries(skill.binaryFiles || {})) {
    await vfsWriteBinary(`${base}/${rel}`, new Uint8Array(bytesArr), batch);
  }
  for (const [name, content] of Object.entries(skill.references || {})) {
    if (!(skill.files || {})[`references/${name}`]) vfsWrite(`${base}/references/${name}`, content, batch);
  }
  for (const [name, content] of Object.entries(skill.scripts || {})) {
    if (!(skill.files || {})[`scripts/${name}`]) vfsWrite(`${base}/scripts/${name}`, content, batch);
  }
  if (!skipRender) renderFileTree();
}

function unmountSkillFromVfs(skill, skipRender) {
  vfsDelete(`/skills/${skill.name}`);
  if (!skipRender) renderFileTree();
}

function renderSkills() {
  const el = document.getElementById('skillsList');
  if (!skills.length) { el.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:4px">No skills installed</div>'; return; }
  el.innerHTML = skills.map(s => {
    const ver = s.version ? ` <span style="color:var(--text-dim);font-size:9px">v${esc(s.version)}</span>` : '';
    const refs = Object.keys(s.references || {}).length;
    const badge = refs ? ` <span style="color:var(--accent-cyan);font-size:9px">${refs}ref</span>` : '';
    return `<div class="skill-item ${s.active ? 'active' : 'off'}" onclick="toggleSkill('${s.id}')" title="${esc(s.description || '')}">
      <span class="s-toggle">${s.active ? iconHtml('i:check-circle') : iconHtml('i:circle')}</span>
      <span class="s-icon">${iconHtml(s.icon)}</span>
      <span class="s-name">${esc(s.name)}${ver}${badge}</span>
      <span class="s-remove" onclick="event.stopPropagation();removeSkill('${s.id}')" title="Remove">&times;</span>
    </div>`;
  }).join('');
}

function renderTodos() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const el = document.getElementById('todosArea');
  const counts = document.getElementById('todoCounts');
  if (!el) return;
  if (!todos || !todos.length) {
    el.innerHTML = '<div style="font-size:10px;color:var(--text-dim);padding:6px">No tasks yet. The agent will populate this when working on multi-step requests.</div>';
    if (counts) counts.textContent = '';
    return;
  }
  const done = todos.filter(t => t.status === 'completed').length;
  if (counts) counts.textContent = done + '/' + todos.length;
  el.innerHTML = todos.map(t => {
    const icon = t.status === 'completed' ? '<svg class="ui-icon" aria-hidden="true"><use href="#i-check"></use></svg>' : t.status === 'in_progress' ? '&#x25B6;' : '&#x25CB;';
    const color = t.status === 'completed' ? 'var(--accent-green,#00ff88)' : t.status === 'in_progress' ? 'var(--accent-orange)' : 'var(--text-dim)';
    const textStyle = t.status === 'completed' ? 'text-decoration:line-through;color:var(--text-dim)' : t.status === 'in_progress' ? 'color:var(--text-primary);font-weight:600' : 'color:var(--text-secondary)';
    const label = t.status === 'in_progress' ? (t.activeForm || t.content) : t.content;
    return `<div class="todo-item" style="display:flex;align-items:flex-start;gap:6px;padding:4px 6px;font-size:11px;border-bottom:1px solid var(--border)">
      <span style="color:${color};flex:none;margin-top:1px">${icon}</span>
      <span style="flex:1;${textStyle};word-break:break-word">${esc(label)}</span>
    </div>`;
  }).join('');
}

function renderSubAgents() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const el = document.getElementById('subAgentsArea');
  const counts = document.getElementById('subAgentCounts');
  if (!el) return;
  // Blackboard one-line summary (only when swarm enabled and there's something to show)
  const bb = _bbGet();
  const bbBanner = (swarmSettings.enabled && bb && bb.entries.length)
    ? `<div style="font-size:10px;color:var(--accent-blue,#5b8af5);padding:4px 6px;border-bottom:1px solid var(--border)">Blackboard: ${bb.entries.length} entries (` + ['note','result','task'].map(t => `${t}=${bb.entries.filter(e=>e.type===t).length}`).join(', ') + ')</div>'
    : '';
  if (!subAgentRuns || !subAgentRuns.length) {
    el.innerHTML = bbBanner + '<div style="font-size:10px;color:var(--text-dim);padding:6px">No sub-agent runs yet.</div>';
    if (counts) counts.textContent = '';
    return;
  }
  const running = subAgentRuns.filter(r => r.status === 'running').length;
  if (counts) counts.textContent = running ? `${running} running` : String(subAgentRuns.length);
  el.innerHTML = bbBanner + subAgentRuns.slice(-8).reverse().map(r => {
    const color = r.status === 'completed' ? 'var(--accent-green,#00ff88)' : r.status === 'error' ? 'var(--accent-red)' : r.status === 'aborted' ? 'var(--text-dim)' : r.status === 'handoff' ? 'var(--accent-blue,#5b8af5)' : 'var(--accent-orange)';
    const task = truncateMiddleText(r.task || 'Sub-agent', 80).replace(/\s+/g, ' ').trim();
    const result = truncateMiddleText(r.resultPreview || r.error || '', 120).replace(/\s+/g, ' ').trim();
    const badge = r.kind === 'swarm' ? `<span style="background:var(--accent-orange);color:#1a1a1a;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px">${esc(r.role || 'worker')}</span>` : '';
    const chainBadge = r.kind === 'swarm' && Array.isArray(r.chainHistory) && r.chainHistory.length ? `<span style="background:var(--accent-blue,#5b8af5);color:#1a1a1a;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px">step ${r.chainHistory.length + 1}</span>` : '';
    return `<div class="todo-item" style="padding:5px 6px;font-size:11px;border-bottom:1px solid var(--border)">
      <div style="display:flex;gap:6px;align-items:flex-start">
        <span style="color:${color};flex:none;margin-top:1px">&#x25CF;</span>
        <span style="flex:1;word-break:break-word;color:var(--text-primary)">${esc(task)}${badge}${chainBadge}</span>
      </div>
      <div style="color:var(--text-dim);font-size:10px;margin-left:14px">${esc(r.status || 'unknown')} · ${Number(r.steps || 0)} steps</div>
      ${result ? `<div style="color:var(--text-secondary);font-size:10px;margin-left:14px;margin-top:3px;word-break:break-word">${esc(result)}</div>` : ''}
    </div>`;
  }).join('');
}

// Progressive loading: L1 = metadata (always), L2 = body (only for triggered skills), L3 = references (on demand)
function getActiveSkillMetadataPrompts() {
  const activeSkills = skills.filter(s => s.active);
  if (!activeSkills.length) return '';
  const lines = activeSkills.map(s => {
    const parts = [`- /${s.name}: ${s.description || 'No description provided.'}`];
    if (s.trigger) parts.push(`  Trigger: ${s.trigger}`);
    parts.push(`  Files: /skills/${s.name}/`);
    const toolNames = (s.tools || []).map(t => t.name).filter(Boolean);
    if (toolNames.length) parts.push(`  Tools on invocation: ${toolNames.join(', ')}`);
    return parts.join('\n');
  });
  return `\n\n## Available skills (metadata only)\nThe following installed skills are available. Their full instructions are only loaded when that skill is explicitly invoked for the current request.\n\n${lines.join('\n')}`;
}
function getTriggeredSkillNames(headId = activeEntryId) {
  const byId = new Map(sessionEntries.map(entry => [entry.id, entry]));
  const names = [];
  for (const item of buildProjectedConversation(headId)) {
    const entry = byId.get(item.entryId);
    if (!entry) continue;
    if (Array.isArray(entry.usedSkillNames)) {
      for (const name of entry.usedSkillNames) {
        if (typeof name === 'string' && !names.includes(name)) names.push(name);
      }
      continue;
    }
    const text = getUserTextFromContent(entry.content || '');
    const matches = [...text.matchAll(/\[IMPORTANT: The "([^"]+)" skill has been invoked for this request\./g)];
    for (const match of matches) {
      const name = match[1];
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}
function getTriggeredSkills(headId = activeEntryId) {
  return getTriggeredSkillNames(headId).map(name => skills.find(s => s.name === name)).filter(Boolean);
}
function getTriggeredSkillPrompts(headId = activeEntryId) {
  return getTriggeredSkills(headId).filter(s => s.body).map(s => {
    let prompt = `\n\n## Skill: ${s.name}\n`;
    prompt += s.active ? `Files at: /skills/${s.name}/\n\n` : 'Loaded for this request only.\n\n';
    prompt += s.body;
    const allFiles = s.active ? Object.keys(s.files || {}) : [];
    if (allFiles.length) {
      const dirs = [...new Set(allFiles.map(f => f.split('/')[0]))].filter(Boolean);
      prompt += `\n\n**Skill contents** (\`/skills/${s.name}/\`): ${dirs.join(', ')} (${allFiles.length} files)`;
    }
    return prompt;
  }).join('');
}
function getTriggeredSkillTools(headId = activeEntryId) {
  const tools = [];
  for (const s of getTriggeredSkills(headId)) {
    if (!s.tools) continue;
    for (const t of s.tools) tools.push({ ...t, _skillId: s.id });
  }
  return tools;
}
function getAllSkillTools() {
  const tools = [];
  for (const s of skills) {
    if (!s.tools) continue;
    for (const t of s.tools) tools.push({ ...t, _skillId: s.id, _skillActive: s.active });
  }
  return tools;
}
// L3: On-demand reference loading (called by Read tool when path starts with @skill:)
function resolveSkillReference(path) {
  // @skill:skill-name/references/filename.md
  const m = path.match(/@skill:([^/]+)\/references\/(.+)/);
  if (!m) return null;
  const s = skills.find(s => s.name === m[1]);
  if (!s || !s.references) return null;
  return s.references[m[2]] || null;
}
// L3: On-demand script loading
function resolveSkillScript(path) {
  const m = path.match(/@skill:([^/]+)\/scripts\/(.+)/);
  if (!m) return null;
  const s = skills.find(s => s.name === m[1]);
  if (!s || !s.scripts) return null;
  return s.scripts[m[2]] || null;
}

