/* creel harness — part 3 of 26: sandbox-daytona
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
 *   - REMOTE SANDBOX (Daytona) — one sandbox per conversation, lazy-created
 *   - STATE + CONVERSATION HISTORY + PERSISTENCE
 */
// ═══════════════════════════════════════════════════════════════════
// REMOTE SANDBOX (Daytona) — one sandbox per conversation, lazy-created
// ═══════════════════════════════════════════════════════════════════
window._daytonaSessions = window._daytonaSessions || {}; // convId -> { sandboxId, createdAt, lastUsed, image, syncedIn:Map, syncedOut:Map }
const _daytonaPending = {};                              // convId -> Promise<sandboxId>
// Daytona's default snapshot runs as user `daytona` whose HOME is /home/daytona.
// /workspace does NOT exist — passing it as cwd makes the daemon silently
// return { exitCode: -1, result: "" }. Anchor all paths in /home/daytona instead.
const DAYTONA_WORKSPACE = '/home/daytona';
const DAYTONA_OUTPUTS_VFS_PREFIX = '/outputs';
const DAYTONA_OUTPUTS_REMOTE_PREFIX = DAYTONA_WORKSPACE + DAYTONA_OUTPUTS_VFS_PREFIX;
// Safety caps for each VFS/sandbox reconciliation.
const DAYTONA_SYNC_MAX_FILES = 2000;
const DAYTONA_SYNC_MAX_BYTES = 100 * 1024 * 1024;
// Paths excluded from sync (large or session-local).
const DAYTONA_SYNC_SKIP_PREFIXES = ['/skills/', '/.git/', '/node_modules/', '/.cache/'];
function _shouldSkipSyncPath(p) {
  if (!p || p === '/') return true;
  for (const pre of DAYTONA_SYNC_SKIP_PREFIXES) if (p.startsWith(pre)) return true;
  return false;
}
function _isDaytonaOutputsPath(p) {
  return p === DAYTONA_OUTPUTS_VFS_PREFIX || p.startsWith(DAYTONA_OUTPUTS_VFS_PREFIX + '/');
}
function _daytonaShellQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function _daytonaAncestorPaths(paths) {
  const out = new Set();
  for (const path of paths) {
    let parent = String(path || '').replace(/\/[^/]+$/, '');
    while (parent && parent !== '/') {
      out.add(parent);
      parent = parent.replace(/\/[^/]+$/, '');
    }
  }
  return out;
}

function _daytonaHeaders(cfg, extra) {
  return Object.assign({ 'Authorization': 'Bearer ' + (cfg.daytonaApiKey || '') }, extra || {});
}
function _daytonaApiBase(cfg) { return (cfg.daytonaServerUrl || SANDBOX_DEFAULTS.daytonaServerUrl).replace(/\/+$/, ''); }
function _daytonaToolboxBase(cfg) {
  if (cfg.daytonaToolboxUrl) return cfg.daytonaToolboxUrl.replace(/\/+$/, '');
  // Daytona Cloud: lifecycle is app.daytona.io/api, toolbox is proxy.app.daytona.io.
  // For self-hosted, default to <server>/proxy if not overridden.
  const api = _daytonaApiBase(cfg);
  const m = api.match(/^(https?:\/\/)app\.daytona\.io(?::\d+)?\/api$/);
  if (m) return m[1] + 'proxy.app.daytona.io';
  return api.replace(/\/api$/, '');
}

async function _daytonaApiFetch(cfg, path, opts = {}) {
  const url = _daytonaApiBase(cfg) + path;
  const headers = _daytonaHeaders(cfg, Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}));
  return _daytonaDoFetch(url, Object.assign({}, opts, { headers }));
}
async function _daytonaToolboxFetch(cfg, sandboxId, path, opts = {}) {
  const url = _daytonaToolboxBase(cfg) + '/toolbox/' + encodeURIComponent(sandboxId) + path;
  const headers = _daytonaHeaders(cfg, opts.headers || {});
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return _daytonaDoFetch(url, Object.assign({}, opts, { headers }));
}
async function _daytonaDoFetch(url, opts) {
  const resp = await fetchWithRetry(url, opts, { retries: 2 });
  if (!resp.ok) {
    let body = '';
    try { body = await resp.text(); } catch {}
    throw new Error(`Daytona ${url.replace(/^https?:\/\/[^/]+/, '')}: HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (opts && opts._raw) return resp;
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

// Poll GET /sandbox/{id} until state is 'started' (or fail fast on 'error').
// Daytona transitions Creating → Starting → Started; calls to /process/execute
// before that return exit -1 with an empty body, which makes the failure look
// like a shell problem when it's really just a race.
async function _daytonaWaitForSandboxReady(cfg, sandboxId, timeoutMs = 90000) {
  const start = Date.now();
  const intervalMs = 1500;
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await _daytonaApiFetch(cfg, '/sandbox/' + encodeURIComponent(sandboxId), { method: 'GET' });
    } catch (e) {
      // Transient fetch error — wait and retry until timeout.
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }
    const state = String(last?.state || '').toLowerCase();
    if (state === 'started') return last;
    if (state === 'error') {
      const reason = last?.errorReason || last?.error_reason || '(no errorReason field)';
      throw new Error(`Daytona sandbox ${sandboxId} entered error state: ${reason}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  const finalState = String(last?.state || 'unknown');
  throw new Error(`Daytona sandbox ${sandboxId} did not reach 'started' within ${Math.round(timeoutMs/1000)}s (last state: ${finalState}).`);
}

// After state=started the toolbox daemon needs a brief warmup before exec
// returns a real response. Probe with `echo __dt_ready__` until the response
// has a non-empty body OR an exitCode of 0; bail out on real shell errors
// (matched by the existing fork/exec hint regex) so we don't loop forever.
async function _daytonaWaitForToolboxReady(cfg, sandboxId, timeoutMs = 45000) {
  const start = Date.now();
  const intervalMs = 1500;
  let lastRaw = null;
  while (Date.now() - start < timeoutMs) {
    let resp;
    try {
      resp = await _daytonaToolboxFetch(cfg, sandboxId, '/process/execute',
        { method: 'POST', body: JSON.stringify({ command: 'echo __dt_ready__', cwd: '/', timeout: 10 }) });
    } catch (e) {
      // Toolbox 404 / 5xx during warmup — just keep trying.
      lastRaw = { _fetchError: e?.message || String(e) };
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }
    lastRaw = resp;
    const norm = _normalizeExecResult(resp);
    const combined = (norm.stdout || '') + (norm.stderr || '');
    // Real shell error (e.g. missing zsh) — surface immediately, don't keep polling.
    if (_daytonaShellHint(combined)) return resp;
    // Got an actual answer.
    if (norm.exitCode === 0 || combined.trim()) return resp;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.warn('Daytona toolbox warmup timed out; last response:', lastRaw);
  // Don't throw — let the caller's first real exec attempt run and surface
  // whatever Daytona returns. The improved _remoteWrap diagnostics below
  // will dump the raw response so the failure isn't a black box.
}

const daytonaClient = {
  async ensureSandbox(convId) {
    const cfg = getSandboxConfig();
    if (!cfg.daytonaApiKey) throw new Error('Daytona API key is not configured (Settings → Sandbox).');
    const sess = window._daytonaSessions[convId];
    if (sess && sess.sandboxId) { sess.lastUsed = Date.now(); return sess.sandboxId; }
    if (_daytonaPending[convId]) return _daytonaPending[convId];
    _daytonaPending[convId] = (async () => {
      const body = { language: 'python' };
      if (cfg.daytonaImage) body.snapshot = cfg.daytonaImage;
      if (cfg.daytonaAutoStopInterval != null) body.autoStopInterval = Number(cfg.daytonaAutoStopInterval) || 0;
      if (cfg.daytonaAutoArchiveInterval != null) body.autoArchiveInterval = Number(cfg.daytonaAutoArchiveInterval) || 0;
      if (cfg.daytonaAutoDeleteInterval != null) body.autoDeleteInterval = Number(cfg.daytonaAutoDeleteInterval) || 0;
      const r = await _daytonaApiFetch(cfg, '/sandbox', { method: 'POST', body: JSON.stringify(body) });
      const sandboxId = r?.id || r?.sandboxId || r?.sandbox?.id;
      if (!sandboxId) throw new Error('Daytona: missing sandbox id in create response');
      // Poll until the sandbox is actually running; otherwise the first
      // /process/execute returns exit -1 with an empty body.
      if (String(r?.state || '').toLowerCase() !== 'started') {
        await _daytonaWaitForSandboxReady(cfg, sandboxId);
      }
      // Even after state=started, the toolbox daemon needs a few more seconds
      // before /process/execute returns a usable response — calls land but
      // come back with { exitCode: -1, result: '' }. Probe with a no-op until
      // we see a real response, otherwise the first real tool call still races.
      await _daytonaWaitForToolboxReady(cfg, sandboxId);
      window._daytonaSessions[convId] = { sandboxId, createdAt: Date.now(), lastUsed: Date.now(), image: cfg.daytonaImage || '' };
      return sandboxId;
    })().finally(() => { delete _daytonaPending[convId]; });
    return _daytonaPending[convId];
  },

  async destroy(convId) {
    const sess = window._daytonaSessions[convId];
    if (!sess) return;
    delete window._daytonaSessions[convId];
    const cfg = getSandboxConfig();
    if (!cfg.daytonaApiKey) return;
    try { await _daytonaApiFetch(cfg, '/sandbox/' + encodeURIComponent(sess.sandboxId), { method: 'DELETE' }); }
    catch (e) { console.warn('Daytona destroy failed:', e?.message || e); }
  },

  async writeFile(convId, path, content) {
    const sandboxId = await this.ensureSandbox(convId);
    const cfg = getSandboxConfig();
    const bytes = content instanceof Uint8Array
      ? content
      : new TextEncoder().encode(String(content || ''));
    const form = new FormData();
    form.append('file', new Blob([bytes]), (path.split('/').pop() || 'file'));
    await _daytonaToolboxFetch(cfg, sandboxId, '/files/upload?path=' + encodeURIComponent(path),
      { method: 'POST', body: form });
  },

  async readFile(convId, path, asBytes = false) {
    const sandboxId = await this.ensureSandbox(convId);
    const cfg = getSandboxConfig();
    const resp = await _daytonaToolboxFetch(cfg, sandboxId, '/files/download?path=' + encodeURIComponent(path),
      { method: 'GET', cache: 'no-store', _raw: true });
    const buf = new Uint8Array(await resp.arrayBuffer());
    return asBytes ? buf : new TextDecoder().decode(buf);
  },

  // List tracked VFS files plus the outputs tree. New non-output sandbox files
  // stay remote until the user explicitly exposes them through /outputs.
  async listFiles(convId, trackedVfsPaths = []) {
    const sandboxId = await this.ensureSandbox(convId);
    const cfg = getSandboxConfig();
    const candidates = [...new Set([...trackedVfsPaths, ..._daytonaAncestorPaths(trackedVfsPaths)])]
      .filter(path => path && path !== '/' && !_isDaytonaOutputsPath(path) && !_shouldSkipSyncPath(path));
    const queryPaths = candidates.slice(0, DAYTONA_SYNC_MAX_FILES);
    const sentinel = '__ONEPAGENT_VFS_LIST_COMPLETE_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '__';
    const trackedFind = queryPaths.map(path => {
      const remotePath = _daytonaShellQuote(DAYTONA_WORKSPACE + path);
      const parentPath = _daytonaShellQuote((DAYTONA_WORKSPACE + path).replace(/\/[^/]+$/, '') || '/');
      // Missing tracked files are valid deletions. An existing but unreadable
      // parent is not: fail the listing so it cannot masquerade as a deletion.
      return 'if [ -f ' + remotePath + ' ]; then find ' + remotePath
        + " -maxdepth 0 -type f -printf '%T@ %s %p\\n' >> \"$onepagent_list\" || exit 12; "
        + 'elif [ ! -e ' + remotePath + ' ] && [ -e ' + parentPath + ' ] && [ ! -x ' + parentPath + ' ]; then exit 12; fi; ';
    }).join('');
    // Build the complete result in a temporary file before capping stdout. The
    // sentinel is emitted only when every scan succeeds and the cap is not hit.
    const cmd = 'onepagent_list=$(mktemp /tmp/onepagent-vfs-list.XXXXXX) || exit 10; '
      + 'trap \'rm -f -- "$onepagent_list"\' EXIT; '
      + 'mkdir -p -- ' + _daytonaShellQuote(DAYTONA_OUTPUTS_REMOTE_PREFIX) + ' || exit 11; '
      + 'find ' + _daytonaShellQuote(DAYTONA_OUTPUTS_REMOTE_PREFIX)
      + " -type f -printf '%T@ %s %p\\n' > \"$onepagent_list\" || exit 12; "
      + trackedFind
      + 'onepagent_count=$(wc -l < "$onepagent_list") || exit 13; '
      + 'head -n ' + (DAYTONA_SYNC_MAX_FILES + 1) + ' "$onepagent_list" || exit 14; '
      + 'if [ "$onepagent_count" -le ' + DAYTONA_SYNC_MAX_FILES + ' ]; then printf \'%s\\n\' '
      + _daytonaShellQuote(sentinel) + ' || exit 15; fi';
    const r = await _daytonaToolboxFetch(cfg, sandboxId, '/process/execute',
      { method: 'POST', body: JSON.stringify({ command: cmd, cwd: DAYTONA_WORKSPACE, timeout: 30 }) });
    const result = _normalizeExecResult(r);
    const lines = String(result.stdout || '').split(/\r?\n/);
    const complete = !result.exitCode && lines.some(line => line === sentinel);
    const out = [];
    for (const line of lines) {
      const m = line.match(/^(\d+(?:\.\d+)?)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const mtime = Math.round(parseFloat(m[1]) * 1000);
      out.push({ path: m[3], size: parseInt(m[2], 10) || 0, mtime });
    }
    const queryTruncated = candidates.length > queryPaths.length || out.length > DAYTONA_SYNC_MAX_FILES;
    const error = result.exitCode
      ? (result.stderr || ('sandbox file listing exited ' + result.exitCode))
      : (!complete && !queryTruncated ? 'sandbox file listing did not finish' : '');
    return { files: out, incomplete: !complete || queryTruncated, queryTruncated, error };
  },

  // /process/execute uses timeout in SECONDS
  async execShell(convId, command, opts = {}) {
    const sandboxId = await this.ensureSandbox(convId);
    const cfg = getSandboxConfig();
    const timeoutSec = opts.timeout || Number(cfg.daytonaTimeout) || SANDBOX_DEFAULTS.daytonaTimeout;
    const r = await _daytonaToolboxFetch(cfg, sandboxId, '/process/execute',
      { method: 'POST', body: JSON.stringify({ command, cwd: opts.cwd || DAYTONA_WORKSPACE, timeout: timeoutSec }) });
    return _normalizeExecResult(r);
  },

  // /process/code-run uses timeout in MILLISECONDS and requires `language`
  async execPython(convId, code, opts = {}) {
    const sandboxId = await this.ensureSandbox(convId);
    const cfg = getSandboxConfig();
    const timeoutMs = (opts.timeout || Number(cfg.daytonaTimeout) || SANDBOX_DEFAULTS.daytonaTimeout) * 1000;
    const body = { code, language: opts.language || 'python', timeout: timeoutMs };
    if (opts.env && typeof opts.env === 'object') body.env = opts.env;
    const r = await _daytonaToolboxFetch(cfg, sandboxId, '/process/code-run',
      { method: 'POST', body: JSON.stringify(body) });
    return _normalizeExecResult(r);
  },

  async execNode(convId, code, opts = {}) {
    const sandboxId = await this.ensureSandbox(convId);
    const cfg = getSandboxConfig();
    const tmp = '/tmp/__onepagent_snippet_' + Date.now() + '.js';
    await this.writeFile(convId, tmp, code);
    const timeoutSec = opts.timeout || Number(cfg.daytonaTimeout) || SANDBOX_DEFAULTS.daytonaTimeout;
    const r = await _daytonaToolboxFetch(cfg, sandboxId, '/process/execute',
      { method: 'POST', body: JSON.stringify({ command: 'node ' + tmp, cwd: opts.cwd || DAYTONA_WORKSPACE, timeout: timeoutSec }) });
    return _normalizeExecResult(r);
  },
};

function _normalizeExecResult(r) {
  if (!r || typeof r !== 'object') return { stdout: String(r ?? ''), stderr: '', exitCode: 0, _raw: r };
  // Daytona REST uses { result, exitCode }; some toolbox responses use stdout/stderr.
  const stdout = r.stdout ?? r.result ?? r.output ?? '';
  const stderr = r.stderr ?? r.error ?? '';
  const exitCode = (r.exitCode ?? r.exit_code ?? r.code ?? 0) | 0;
  return { stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode, _raw: r };
}

function _u8ToBase64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}
function _base64ToU8(b64) {
  try {
    const bin = atob(b64 || '');
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch { return new Uint8Array(0); }
}

// Per-conversation sync state lives on the Daytona session. syncedIn is the
// last reconciled VFS fingerprint; syncedOut is the last observed remote mtime.
function markVfsTouched() {}

function _vfsFingerprint(node) {
  if (!node || node.type !== 'file') return null;
  if (node.binary) return 'b:' + (node.hash || ('s' + (node.size || 0)));
  const size = (node.content || '').length;
  return 't:' + size + ':' + (node.modified || 0);
}

function _walkAllVfsFiles(root = vfs) {
  const out = [];
  vfsWalk('/', (path, node) => {
    if (node.type === 'file') out.push({ path, node });
  }, root);
  return out;
}

function _daytonaEditorState(convId, root, path) {
  if (visibleConvId !== convId) return null;
  const viewer = document.getElementById('fileViewer');
  const shownPath = document.getElementById('fvPath')?.textContent || '';
  if (!viewer?.classList.contains('show') || normPath(shownPath) !== path) return null;
  const area = document.getElementById('feEditArea');
  const node = vfsResolve(path, root);
  return {
    editing: !!area,
    dirty: !!area && node?.type === 'file' && !node.binary && area.value !== (node.content || ''),
    text: area?.value,
  };
}

function _daytonaConflictPath(root, path, side = 'local') {
  let candidate = path + '.' + side + '-conflict-' + Date.now();
  while (vfsResolve(candidate, root)) candidate += '-1';
  return candidate;
}

async function _preserveLocalConflict(root, path, node, editor) {
  if (node?.type !== 'file' && !editor?.dirty) return '';
  const conflictPath = _daytonaConflictPath(root, path);
  if (editor?.dirty) {
    const result = vfsWrite(conflictPath, editor.text || '', true, root);
    if (result.error) throw new Error(result.error);
  } else if (node.binary) {
    const bytes = await vfsGetBinary(path, root);
    if (!bytes) throw new Error('binary data unavailable');
    await vfsWriteBinary(conflictPath, bytes, true, root);
  } else {
    const result = vfsWrite(conflictPath, node.content || '', true, root);
    if (result.error) throw new Error(result.error);
  }
  return conflictPath;
}

async function _writeRemoteBytesToVfs(root, path, bytes) {
  if (vfsResolve(path, root)?.type === 'dir') throw new Error('refusing to replace a VFS directory with a file');
  if (_looksLikeText(bytes)) {
    const result = vfsWrite(path, new TextDecoder('utf-8', { fatal: false }).decode(bytes), true, root);
    if (result.error) throw new Error(result.error);
  } else {
    await vfsWriteBinary(path, bytes, true, root);
  }
}

async function _daytonaSyncExec(convId, command) {
  const result = await daytonaClient.execShell(convId, command);
  if (result.exitCode) throw new Error(result.stderr || result.stdout || ('exit ' + result.exitCode));
  return result;
}

// Upload local-only changes after syncVfsFromRemote has reconciled remote-only
// changes and conflicts. This ordering prevents a stale VFS write from winning.
async function syncVfsToRemote(convId, root = vfs) {
  await daytonaClient.ensureSandbox(convId);
  const sess = window._daytonaSessions[convId];
  if (!sess.syncedIn) sess.syncedIn = new Map();
  if (!sess.syncedOut) sess.syncedOut = new Map();
  const warnings = [];
  const allFiles = _walkAllVfsFiles(root);
  const presentPaths = new Set();
  const uploadCandidates = [];
  const dirsToCreate = new Set();
  let skipped = 0;
  for (const { path, node } of allFiles) {
    if (_shouldSkipSyncPath(path)) continue;
    presentPaths.add(path);
    const fp = _vfsFingerprint(node);
    if (sess.syncedIn.has(path) && sess.syncedIn.get(path) === fp) { skipped++; continue; }
    uploadCandidates.push({ path, node, fp });
    const parent = path.replace(/\/[^/]+$/, '');
    if (parent && parent !== '/') dirsToCreate.add(parent);
  }
  const deletedLocally = [...sess.syncedIn.keys()]
    .filter(path => !presentPaths.has(path) && !_shouldSkipSyncPath(path) && path !== '/');
  if (deletedLocally.length) {
    try {
      await _daytonaSyncExec(convId, 'rm -f -- ' + deletedLocally.map(path => _daytonaShellQuote(DAYTONA_WORKSPACE + path)).join(' '));
      for (const path of deletedLocally) {
        sess.syncedIn.delete(path);
        sess.syncedOut.delete(DAYTONA_WORKSPACE + path);
      }
    } catch (e) { warnings.push('Could not apply VFS deletions in the sandbox: ' + (e?.message || e)); }
  }
  if (dirsToCreate.size) {
    try {
      await _daytonaSyncExec(convId, 'mkdir -p -- ' + [...dirsToCreate].map(p => _daytonaShellQuote(DAYTONA_WORKSPACE + p)).join(' '));
    } catch (e) { warnings.push('Could not create sandbox directories: ' + (e?.message || e)); }
  }
  let pushed = 0, bytesPushed = 0;
  for (const { path, node, fp } of uploadCandidates) {
    if (pushed >= DAYTONA_SYNC_MAX_FILES) {
      warnings.push('VFS upload stopped at the ' + DAYTONA_SYNC_MAX_FILES + '-file safety limit.');
      break;
    }
    try {
      let content, byteLen;
      if (node.binary) {
        content = await vfsGetBinary(path, root);
        if (!content) throw new Error('binary data unavailable');
        byteLen = content.length;
      } else {
        content = node.content || '';
        byteLen = new TextEncoder().encode(content).length;
      }
      if (bytesPushed + byteLen > DAYTONA_SYNC_MAX_BYTES) {
        warnings.push('Skipped ' + path + ': VFS upload reached the 100 MiB safety limit.');
        continue;
      }
      await daytonaClient.writeFile(convId, DAYTONA_WORKSPACE + path, content);
      sess.syncedIn.set(path, fp);
      bytesPushed += byteLen;
      pushed++;
    } catch (e) { warnings.push('Could not upload ' + path + ': ' + (e?.message || e)); }
  }
  return { pushed, skipped, bytesPushed, warnings };
}

// Reconcile every previously synced file, while importing new files only from
// /outputs. Remote wins the original path on a conflict; the local version is
// first saved beside it as *.local-conflict-<timestamp>.
async function syncVfsFromRemote(convId, root = vfs) {
  const sess = window._daytonaSessions[convId];
  if (!sess) return { pulled: 0, skipped: 0, warnings: [], conflicts: [], changedPaths: [], deletedPaths: [], incomplete: false };
  if (!sess.syncedIn) sess.syncedIn = new Map();
  if (!sess.syncedOut) sess.syncedOut = new Map();
  const tracked = new Set([
    ...sess.syncedIn.keys(),
    ...[...sess.syncedOut.keys()].map(path => path.startsWith(DAYTONA_WORKSPACE) ? path.slice(DAYTONA_WORKSPACE.length) : ''),
  ].filter(path => path && path !== '/' && !_shouldSkipSyncPath(path)));
  const trackedAncestors = _daytonaAncestorPaths(tracked);
  const listing = await daytonaClient.listFiles(convId, [...tracked]);
  const listed = listing.files || [];
  const incomplete = !!listing.incomplete || !!listing.queryTruncated || listed.length > DAYTONA_SYNC_MAX_FILES;
  const warnings = incomplete
    ? ['Sandbox file listing was incomplete'
      + (listing.error ? ': ' + listing.error : ' or exceeded the ' + DAYTONA_SYNC_MAX_FILES + '-file safety limit')
      + '; remote deletions and local uploads were not applied.']
    : [];
  if (incomplete) {
    return { pulled: 0, skipped: 0, bytesPulled: 0, warnings, conflicts: [], changedPaths: [], deletedPaths: [], incomplete: true };
  }
  const remoteFiles = new Map();
  for (const file of listed.slice(0, DAYTONA_SYNC_MAX_FILES)) {
    if (!file.path?.startsWith(DAYTONA_WORKSPACE + '/')) continue;
    const localPath = file.path.slice(DAYTONA_WORKSPACE.length) || '/';
    if (_shouldSkipSyncPath(localPath)
      || (!_isDaytonaOutputsPath(localPath) && !tracked.has(localPath) && !trackedAncestors.has(localPath))) continue;
    const previous = remoteFiles.get(localPath);
    if (!previous || file.mtime >= previous.mtime) remoteFiles.set(localPath, file);
  }
  let pulled = 0, skipped = 0, bytesPulled = 0;
  const conflicts = [], changedPaths = [], deletedPaths = [];
  const remoteLocalPaths = [...remoteFiles.keys()];
  // A tracked file can become a remote directory whose descendants appear in
  // the same listing. Remove/preserve that file before writing those children.
  // ponytail: both path sets are capped at 2,000; use a prefix index if that cap grows.
  for (const localPath of tracked) {
    const node = vfsResolve(localPath, root);
    if (node?.type !== 'file' || remoteFiles.has(localPath)
      || !remoteLocalPaths.some(path => path.startsWith(localPath + '/'))) continue;
    const editor = _daytonaEditorState(convId, root, localPath);
    const localBaseKnown = sess.syncedIn.has(localPath);
    const localDirty = !!editor?.dirty
      || (localBaseKnown ? _vfsFingerprint(node) !== sess.syncedIn.get(localPath) : true);
    try {
      let conflictPath = '';
      if (localDirty) {
        conflictPath = await _preserveLocalConflict(root, localPath, node, editor);
        conflicts.push({ path: localPath, localCopy: conflictPath, remoteDirectory: true });
        if (conflictPath) changedPaths.push(conflictPath);
      }
      const result = vfsDelete(localPath, true, root);
      if (result.error) throw new Error(result.error);
      sess.syncedIn.delete(localPath);
      sess.syncedOut.delete(DAYTONA_WORKSPACE + localPath);
      deletedPaths.push(localPath);
      warnings.push('The sandbox replaced tracked file ' + localPath + ' with a directory'
        + (conflictPath ? '; saved the local version as ' + conflictPath + '.' : '.'));
      if (editor?.editing) warnings.push('The sandbox replaced open editor ' + localPath + ' with a directory; unsaved editor text was preserved separately.');
    } catch (e) { warnings.push('Could not prepare sandbox directory ' + localPath + ' in VFS: ' + (e?.message || e)); }
  }
  const protectedLocalDirs = new Set([...tracked].filter(path => vfsResolve(path, root)?.type === 'dir'));
  for (const [localPath, file] of remoteFiles) {
    const remotePath = file.path;
    const previousRemoteKnown = sess.syncedOut.has(remotePath);
    const previousMtime = sess.syncedOut.get(remotePath);
    const remoteChanged = !previousRemoteKnown || previousMtime == null || !file.mtime || file.mtime !== previousMtime;
    const node = vfsResolve(localPath, root);
    const localFingerprint = _vfsFingerprint(node);
    const localBaseKnown = sess.syncedIn.has(localPath);
    const editor = _daytonaEditorState(convId, root, localPath);
    const localDirty = !!editor?.dirty || (localBaseKnown ? localFingerprint !== sess.syncedIn.get(localPath) : !!node);
    if (node?.type === 'dir') protectedLocalDirs.add(localPath);
    if (!remoteChanged) {
      sess.syncedOut.set(remotePath, file.mtime || previousMtime || Date.now());
      skipped++;
      continue;
    }
    if (bytesPulled + (file.size || 0) > DAYTONA_SYNC_MAX_BYTES) {
      warnings.push('Could not pull ' + localPath + ': download reached the 100 MiB safety limit.');
      continue;
    }
    try {
      const bytes = await daytonaClient.readFile(convId, remotePath, true);
      if (bytesPulled + bytes.length > DAYTONA_SYNC_MAX_BYTES) {
        warnings.push('Could not pull ' + localPath + ': download reached the 100 MiB safety limit.');
        continue;
      }
      if (node?.type === 'dir') {
        const remoteCopy = _daytonaConflictPath(root, localPath, 'remote');
        await _writeRemoteBytesToVfs(root, remoteCopy, bytes);
        try {
          await _daytonaSyncExec(convId, 'rm -f -- ' + _daytonaShellQuote(remotePath));
          sess.syncedIn.delete(localPath);
          sess.syncedOut.delete(remotePath);
        } catch (deleteError) {
          sess.syncedIn.set(localPath, sess.syncedIn.get(localPath) ?? null);
          sess.syncedOut.set(remotePath, file.mtime || Date.now());
          warnings.push('Could not remove the conflicting sandbox file ' + localPath + ': ' + (deleteError?.message || deleteError));
        }
        conflicts.push({ path: localPath, remoteCopy, typeConflict: true });
        warnings.push('Type conflict at ' + localPath + ': kept the local directory and saved the sandbox file as ' + remoteCopy + '.');
        changedPaths.push(remoteCopy);
        bytesPulled += bytes.length;
        pulled++;
        continue;
      }
      if (localDirty) {
        const conflictPath = await _preserveLocalConflict(root, localPath, node, editor);
        conflicts.push({ path: localPath, localCopy: conflictPath });
        warnings.push('Conflict at ' + localPath + ': kept the sandbox version at the original path'
          + (conflictPath ? ' and saved the local version as ' + conflictPath + '.' : '.'));
        if (conflictPath) changedPaths.push(conflictPath);
      }
      await _writeRemoteBytesToVfs(root, localPath, bytes);
      const nextNode = vfsResolve(localPath, root);
      sess.syncedIn.set(localPath, _vfsFingerprint(nextNode));
      sess.syncedOut.set(remotePath, file.mtime || Date.now());
      bytesPulled += bytes.length;
      pulled++;
      changedPaths.push(localPath);
      if (editor?.editing) warnings.push('Remote update for open editor ' + localPath + ' is available; unsaved editor text was left untouched.');
    } catch (e) { warnings.push('Could not pull ' + localPath + ': ' + (e?.message || e)); }
  }
  if (!incomplete) {
    for (const localPath of tracked) {
      if (remoteFiles.has(localPath)) continue;
      // ponytail: prefix scan is bounded by the 2,000-file sync cap; index paths if that cap grows.
      const remotePath = DAYTONA_WORKSPACE + localPath;
      if ([...protectedLocalDirs].some(path => localPath.startsWith(path + '/'))) {
        sess.syncedIn.delete(localPath);
        sess.syncedOut.delete(remotePath);
        continue;
      }
      const remoteWasPresent = sess.syncedOut.has(remotePath)
        ? sess.syncedOut.get(remotePath) != null
        : sess.syncedIn.has(localPath) && sess.syncedIn.get(localPath) != null;
      if (!remoteWasPresent) continue;
      const node = vfsResolve(localPath, root);
      const editor = _daytonaEditorState(convId, root, localPath);
      const localBaseKnown = sess.syncedIn.has(localPath);
      const localDirty = !!editor?.dirty || (localBaseKnown ? _vfsFingerprint(node) !== sess.syncedIn.get(localPath) : !!node);
      try {
        if (node?.type === 'dir') {
          conflicts.push({ path: localPath, localDirectory: true, remoteDeleted: true });
          warnings.push('The sandbox deleted tracked file ' + localPath + ', but the local path is now a directory; kept the directory.');
          sess.syncedIn.delete(localPath);
          sess.syncedOut.delete(remotePath);
          continue;
        }
        if (localDirty) {
          const conflictPath = await _preserveLocalConflict(root, localPath, node, editor);
          conflicts.push({ path: localPath, localCopy: conflictPath, remoteDeleted: true });
          warnings.push('Conflict at ' + localPath + ': the sandbox deleted it'
            + (conflictPath ? '; saved the local version as ' + conflictPath + '.' : '.'));
          if (conflictPath) changedPaths.push(conflictPath);
        }
        const currentNode = vfsResolve(localPath, root);
        if (currentNode?.type === 'file') {
          const result = vfsDelete(localPath, true, root);
          if (result.error) throw new Error(result.error);
          deletedPaths.push(localPath);
        } else if (currentNode) {
          warnings.push('Kept ' + localPath + ' because it changed from a file into a directory during sandbox sync.');
        }
        sess.syncedIn.delete(localPath);
        sess.syncedOut.delete(remotePath);
        if (editor?.editing) warnings.push('The sandbox deleted open editor ' + localPath + '; unsaved editor text was left untouched.');
      } catch (e) { warnings.push('Could not apply sandbox deletion for ' + localPath + ': ' + (e?.message || e)); }
    }
  }
  return { pulled, skipped, bytesPulled, warnings, conflicts, changedPaths, deletedPaths, incomplete };
}

function _looksLikeText(bytes) {
  if (!bytes || !bytes.length) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
  let nonText = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) nonText++;
  }
  return nonText / sample.length < 0.05;
}

// Best-effort cleanup of all live remote sandboxes on tab close.
window.addEventListener('beforeunload', () => {
  const cfg = getSandboxConfig();
  if (!cfg.enabled || cfg.platform !== 'daytona' || !cfg.daytonaApiKey) return;
  const base = (cfg.daytonaServerUrl || SANDBOX_DEFAULTS.daytonaServerUrl).replace(/\/+$/, '');
  for (const sess of Object.values(window._daytonaSessions || {})) {
    if (!sess?.sandboxId) continue;
    try {
      fetch(base + '/sandbox/' + encodeURIComponent(sess.sandboxId), {
        method: 'DELETE',
        keepalive: true,
        headers: { 'Authorization': 'Bearer ' + cfg.daytonaApiKey },
      });
    } catch {}
  }
});

// ── Model list fetching ─────────────────────────────────────────
let _settingsModelFetchSeq = 0;
let _settingsModelFetchController = null;
async function requestProviderModelList(provider, options = {}) {
  const resp = await fetchWithRetry(buildProviderApiUrl('/v1/models', provider), {
    headers: getProviderAuthHeaders({ provider, json: false }),
    cache: 'no-store',
    ...(options.signal ? { signal: options.signal } : {}),
  }, { retries: options.retries ?? 0 });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  let models = (Array.isArray(data?.data) ? data.data : [])
    .map(m => typeof m?.id === 'string' ? m.id.trim() : '')
    .filter(Boolean);
  if (options.filterOpenAiChat && provider.type === 'openai_compat') {
    models = models.filter(m => /gpt|o1|o3|o4|chatgpt|deepseek/i.test(m));
  }
  return [...new Set(models)].sort();
}

async function fetchModelList() {
  const provider = {
    ...(ACTIVE_PROVIDER || {}),
    type: PROVIDER,
    endpoint: _keys?.api_endpoint || CFG.api_endpoint || '',
    apiKey: _keys?.api_key || '',
  };
  try {
    return await requestProviderModelList(provider, { retries: 5, filterOpenAiChat: true });
  } catch { return []; }
}

function populateModelDropdown(models) {
  const sel = document.getElementById('modelSelect');
  if (!models.length) {
    sel.innerHTML = `<option value="${esc(API_MODEL)}">${esc(API_MODEL)}</option>`;
    return;
  }
  // Ensure current model is in the list
  if (!models.includes(API_MODEL)) models.unshift(API_MODEL);
  sel.innerHTML = models.map(m => `<option value="${esc(m)}"${m === API_MODEL ? ' selected' : ''}>${esc(m)}</option>`).join('');
}

// ── Streaming render throttle ───────────────────────────────────
// Keyed per target element so concurrent conversation streams don't overwrite
// each other's pending render (a single global slot let run B's chunk drop
// run A's pending text).
const _renderPendingMap = new Map(); // el -> { text, timer }
function renderMdThrottled(el, text) {
  let p = _renderPendingMap.get(el);
  if (!p) { p = { text, timer: null }; _renderPendingMap.set(el, p); }
  p.text = text;
  if (p.timer) return;
  p.timer = setTimeout(() => {
    p.timer = null;
    const cur = _renderPendingMap.get(el);
    if (cur) { renderMd(el, cur.text); _renderPendingMap.delete(el); }
  }, 50);
}
function flushRender(el) {
  if (el) {
    const p = _renderPendingMap.get(el);
    if (p) { if (p.timer) clearTimeout(p.timer); renderMd(el, p.text); _renderPendingMap.delete(el); }
    return;
  }
  for (const [e, p] of _renderPendingMap) { if (p.timer) clearTimeout(p.timer); renderMd(e, p.text); }
  _renderPendingMap.clear();
}

// The Python paragraph is composed, not written inline: with the python flag
// off there is no PythonExec to describe, and a prompt that describes a tool
// the model cannot call spends context teaching it a dead path.
const PYTHON_EXEC_SEMANTICS = `- PythonExec runs Python in-browser (Pyodide WASM) against the shared filesystem — use normal paths directly (open(), pathlib, glob). For binary data use workspacefs.read_bytes/write_bytes. Only libraries that require a real native /tmp path need workspacefs.materialize_to_tmp(...) and workspacefs.persist_tmp_file(...). micropip installs pure-Python packages only. A helper module workspace_cli (and /__internal__/workspace_cli.py) covers higher-level file operations. Writes target the shared filesystem directly — there is no separate project copy to sync later.
`;

const DEFAULT_SYSTEM = `You are a coding agent running inside creel: a static web page, in a browser tab, with no server behind it. The tab is the process. Everything below is what that costs you and what it buys you.

EXECUTION SEMANTICS (sandbox-specific behavior the schemas do not tell you):
${CREEL_FEATURES.python ? PYTHON_EXEC_SEMANTICS : '- There is no Python runtime in this harness. PythonExec does not exist — do not plan around it.\n'}- JSExec is browser JavaScript, NOT Node: vfsRead/vfsWrite (text), vfsReadBinary/vfsWriteBinary (binary), vfsStat, console.log(), fetch(). Node APIs and package scripts belong in NodeExec.
- NodeExec is a separate Node WebContainer that CANNOT see VFS files: pass sync_in paths to copy files in, sync_out to copy results back. ESM by default; module_type "commonjs" for require(). No npm packages exist until you install them there. Set timeout_ms (up to 1200000) for installs and builds.
- Routing: ${CREEL_FEATURES.python ? 'PythonExec for data work; ' : ''}JSExec for data work and page-side scripts; NodeExec for Node APIs and package scripts; Read/Write/Edit/Glob/Grep for files; Bash only when a real shell is exposed. Keep anything reusable as a file under /outputs/scripts rather than a long inline one-off.
- Filesystem: /src, /outputs and /skills/<name> are the single source of truth. Read returns placeholder text for binaries, not content; Grep skips them. Do not put scratch files in /skills/ — those directories belong to installed skills.

TOOL FAMILIES — all live in your tool list already; the schemas are there, so this is the map, not the index:
- ui_* — operate creel's own interface, in this tab or any other
- fleet_* — spawn and coordinate parallel agent tabs
- browser_* — drive cross-origin websites, via the creel bridge extension; without it only browser_status exists
- github_* — check repos out into FILES and push edits back
- state_* — creel's own durable state, in a private GitHub repo
- quipu_* — the knowledge graph: query and record durable facts
- bd_* — issue tracker, compatible with the .beads/ JSONL tracker
- bench_* — the grounding measurement suite
- local_* — sync a real local folder in/out of FILES (desktop Chrome/Edge only)
- Skills mount at /skills/<skill-name>/ (SKILL.md plus assets/, references/, scripts/).

WHAT IS DURABLE. Your VFS, conversation and graph live in browser storage, which is evictable and exists on no other machine. Nothing here survives on its own. Work worth keeping leaves by one of three doors: github_push for code, state_push for creel's own state (config, conversations, skills, memory, the graph — one commit to a private repo), quipu_cord/quipu_knot for a durable fact. A task whose result went through none of them is not finished.

Credentials go in, never out. You can be handed a key and asked to set one up; you cannot read one back — snapshots mask them and results report a length. Never put a key in chat, a commit, or a graph fact.

The full capabilities index is in the graph itself — quipu_ask (name "labeled_like", text "creel-world-model"), mirrored in docs/hands.md. Query it rather than guessing at roles, servers and policies.

WORKFLOW: explore first, read before editing, edit via Write/Edit, verify, then say plainly what changed and what you checked. Be concise.`;

document.getElementById('contextEditor').value = CUSTOM_SYSTEM || DEFAULT_SYSTEM;

function toggleSysPromptEdit() {
  const editor = document.getElementById('contextEditor');
  const btn = document.getElementById('spEditBtn');
  if (editor.readOnly) {
    editor.readOnly = false;
    editor.classList.add('editing');
    btn.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#i-check"></use></svg> Done';
    btn.style.color = 'var(--accent-green)';
    btn.style.borderColor = 'var(--accent-green)';
    editor.focus();
  } else {
    editor.readOnly = true;
    editor.classList.remove('editing');
    btn.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#i-pencil"></use></svg> Edit';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}

function resetSysPrompt() {
  const editor = document.getElementById('contextEditor');
  editor.value = DEFAULT_SYSTEM;
  editor.readOnly = true;
  editor.classList.remove('editing');
  const btn = document.getElementById('spEditBtn');
  btn.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#i-pencil"></use></svg> Edit';
  btn.style.color = '';
  btn.style.borderColor = '';
}

// ═══════════════════════════════════════════════════════════════════
// STATE + CONVERSATION HISTORY + PERSISTENCE
// ═══════════════════════════════════════════════════════════════════
let vfs = { type: 'dir', children: {} };
let cwd = '/';
let conversation = [];
let sessionEntries = [];
let activeEntryId = null;
let isGenerating = false;
let abortCtrl = null;
let visibleConvId = null;
let currentRunContext = null;
let visibleConversationState = null;
const conversationRuns = new Map();
let loopCount = 0;
// Per-conversation todos (TodoWrite tool), sub-agent run metadata, and session-only plan mode flag.
let todos = [];
let subAgentRuns = [];
let planMode = false;
let ralphModeEnabled = getRalphSettings().enabled;
let ralphRun = null;
const SUB_AGENT_TOOL_NAME = 'RunSubAgent';
const SUB_AGENT_DEFAULT_MAX_STEPS = 4;
const SUB_AGENT_MAX_STEPS = 8;
const SUB_AGENT_RESULT_MAX_CHARS = 6000;
const SUB_AGENT_TOOL_OUTPUT_MAX_CHARS = 12000;
const SUB_AGENT_ALLOWED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Fetch', 'WebSearch', 'memory_search']);

