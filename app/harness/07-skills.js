/* creel harness — part 7 of 26: skills
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
 *   - SKILL SYSTEM (SkillLite-compatible SKILL.md format)
 *   - PYODIDE RUNTIME (lazy-loaded browser Python)
 *   - WEBCONTAINER RUNTIME (lazy-loaded browser Node)
 */
// ═══════════════════════════════════════════════════════════════════
// SKILL SYSTEM (SkillLite-compatible SKILL.md format)
// ═══════════════════════════════════════════════════════════════════
// Skill object: {
//   id, name, icon, description,        ← L1: always in context (metadata)
//   body,                                ← L2: loaded when triggered (SKILL.md markdown body)
//   references: { "name.md": content },  ← L3: loaded on demand by agent
//   scripts: { "main.py": code },        ← executable code
//   tools: [],                           ← custom tool definitions
//   trigger, active, source, version, author, license
// }
let skills = [];
const SESSION_ID = 'sess_' + Math.random().toString(36).slice(2, 10); // Per-tab isolation key

// ═══════════════════════════════════════════════════════════════════
// PYODIDE RUNTIME (lazy-loaded browser Python)
// ═══════════════════════════════════════════════════════════════════
let pyodideInstance = null;
let pyodideLoading = false;
let pyodideProgressEl = null;
const PYODIDE_PRELOAD_PACKAGES = ['micropip', 'numpy', 'pandas', 'lxml'];
const PYODIDE_MICROPIP_PRELOAD_PACKAGES = ['python-pptx'];

function updatePyodideProgress(text, pct, run) {
  if (!pyodideProgressEl || !pyodideProgressEl.isConnected) {
    pyodideProgressEl = document.createElement('div');
    pyodideProgressEl.className = 'msg msg-system';
    pyodideProgressEl.innerHTML = '<div class="msg-body"></div>';
    // Route to the run that initiated the load (passed explicitly). Loading is a
    // long async sequence, so the live currentRunContext drifts to other runs
    // between progress callbacks — using it here is what made the bar bleed.
    getContextChatEl(run).appendChild(pyodideProgressEl);
  }
  const body = pyodideProgressEl.querySelector('.msg-body');
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  body.innerHTML = `${esc(text)}<div class="install-progress show" style="margin:8px 0 0"><div class="bar"><div class="fill" style="width:${safePct}%"></div></div></div>`;
  scrollBottom(false, run);
}

// creel-sbx: Pyodide is served from several CDNs because the primary jsdelivr
// endpoint is slow or blocked on some networks (notably mainland China — the
// small loader <script> often arrives while the ~10-15MB wasm download stalls,
// which used to time out after 120s and fail every Python tool call).
// Each host entry is an indexURL for a directory that contains a valid Pyodide
// distribution; the loader lives at indexURL + 'pyodide.js'. The loader is
// fetched with a bounded 30s timeout per host, in order, and the runtime wasm
// is then pinned to whichever host delivered the loader.
// v314.0.3 is the latest release (checked via data.jsdelivr.com/v1/packages/npm/pyodide/resolved).
const PYODIDE_VERSION = '314.0.3';
const PYODIDE_CDN_HOSTS = [
  { name: 'npmmirror (China-friendly)', indexURL: `https://registry.npmmirror.com/pyodide/${PYODIDE_VERSION}/files/` },
  { name: 'jsDelivr',                   indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` },
  { name: 'jsDelivr fastly mirror',     indexURL: `https://fastly.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` },
  { name: 'jsDelivr gcore mirror',      indexURL: `https://gcore.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` },
];
function loadPyodideScriptFrom(indexURL) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = indexURL + 'pyodide.js';
    // No crossorigin attribute: classic scripts execute without CORS, so this
    // works even on hosts that don't send Access-Control-Allow-Origin (some
    // mirrors, e.g. npmmirror, serve the file but omit the header).
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('failed to load Pyodide loader from ' + indexURL));
    document.head.appendChild(el);
  });
}
async function ensurePyodideLoaders(withTimeout, initRun) {
  // Returns an ORDERED list of indexURLs that delivered the small loader JS,
  // so the caller can fall through them for the heavy runtime download: a
  // host can serve the loader fine yet throttle or CORS-block the ~10-15MB
  // wasm, so "first loader that loads" is not enough on its own.
  if (typeof loadPyodide !== 'undefined') return [`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`];
  const ok = [];
  let lastErr = null;
  for (const h of PYODIDE_CDN_HOSTS) {
    updatePyodideProgress(`Loading Python runtime from ${h.name}...`, 5, initRun);
    try {
      await withTimeout(loadPyodideScriptFrom(h.indexURL), 30000, `Pyodide loader download (${h.name})`);
      if (typeof loadPyodide !== 'undefined') ok.push(h.indexURL);
    } catch (e) {
      lastErr = e;
      console.warn('[pyodide] loader fallback:', h.name, e?.message || e);
    }
  }
  if (!ok.length && lastErr) console.warn('[pyodide] all CDN hosts failed:', lastErr?.message || lastErr);
  return ok;
}

async function ensurePyodide() {
  // Refuse before the loader is injected — a disabled runtime must cost zero
  // network, not a cancelled 10MB download.
  if (!CREEL_FEATURES.python) throw new Error(featureDisabledError('PythonExec'));
  // Capture the run that triggered this load up front; all progress updates route
  // to it so the bar stays in the initiating conversation across the long awaits.
  const initRun = currentRunContext;
  if (pyodideInstance) return pyodideInstance;
  if (pyodideLoading) { updatePyodideProgress('Python runtime is already loading...', 10, initRun); while (pyodideLoading) await new Promise(r => setTimeout(r, 100)); return pyodideInstance; }
  pyodideLoading = true;
  updatePyodideProgress('Loading Python runtime (Pyodide WASM)...', 5, initRun);
  // creel: a stalled CDN download used to hang here forever (and the
  // interrupted tool call then poisoned strict providers' history). Fail
  // loudly instead: bounded waits, host fallback, and a clear error when no
  // CDN host delivers the loader at all.
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s — the Pyodide CDN may be slow or blocked on this network; retry, or check connectivity`)), ms))]);
  try {
    // Collect hosts that delivered the loader, then try them in order for the
    // ~10-15MB runtime download (wasm + lock file), so a host that throttles
    // the big files after serving the tiny loader doesn't sink the whole load.
    const hosts = await ensurePyodideLoaders(withTimeout, initRun);
    if (!hosts.length) {
      throw new Error('the Pyodide loader could not be fetched from any CDN host (tried: ' + PYODIDE_CDN_HOSTS.map(h => h.name).join(', ') + ')');
    }
    let lastRuntimeErr = null;
    for (const indexURL of hosts) {
      try {
        updatePyodideProgress('Downloading and initializing Pyodide...', 15, initRun);
        pyodideInstance = await withTimeout(
          loadPyodide({ indexURL, stdout: msg => console.log('[pyodide]', msg), stderr: msg => console.warn('[pyodide]', msg) }),
          120000, 'Pyodide runtime download');
        break;
      } catch (e) {
        lastRuntimeErr = e;
        pyodideInstance = null;   // discard the half-loaded runtime, try next host
        console.warn('[pyodide] runtime download failed from', indexURL, e?.message || e);
      }
    }
    if (!pyodideInstance) throw lastRuntimeErr || new Error('Pyodide runtime download failed from all CDN hosts');
    updatePyodideProgress(`Loading packages: ${PYODIDE_PRELOAD_PACKAGES.join(', ')}...`, 35, initRun);
    await withTimeout(
      pyodideInstance.loadPackage(PYODIDE_PRELOAD_PACKAGES, msg => updatePyodideProgress(String(msg || 'Loading Pyodide packages...'), 55, initRun)),
      120000, 'Pyodide package download');
    const totalPip = PYODIDE_MICROPIP_PRELOAD_PACKAGES.length || 1;
    for (const [idx, pkg] of PYODIDE_MICROPIP_PRELOAD_PACKAGES.entries()) {
      const pct = 70 + Math.round((idx / totalPip) * 20);
      updatePyodideProgress(`Installing Python package ${idx + 1}/${totalPip}: ${pkg}...`, pct, initRun);
      // Optional preinstall — a PyPI/network failure here must not abort the whole
      // runtime. Pyodide is already usable; the package can be installed on demand.
      try {
        await pyodideInstance.runPythonAsync(`import micropip; await micropip.install("${pkg}")`);
      } catch (e) {
        console.warn(`[pyodide] optional preinstall of "${pkg}" failed:`, e?.message || e);
        updatePyodideProgress(`Skipped optional package ${pkg} (install on demand later).`, pct, initRun);
      }
    }
    pyodideLoading = false;
    updatePyodideProgress('Python runtime ready (Pyodide).', 100, initRun);
    if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
    return pyodideInstance;
  } catch (e) {
    pyodideLoading = false;
    pyodideInstance = null;   // a later attempt starts clean instead of half-loaded
    updatePyodideProgress('Failed to load Pyodide: ' + e.message, 100, initRun);
    throw new Error('Failed to load Pyodide: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// WEBCONTAINER RUNTIME (lazy-loaded browser Node)
// ═══════════════════════════════════════════════════════════════════
let webcontainerInstance = null;
let webcontainerLoading = false;
let webcontainerApiModule = null;
const WEBCONTAINER_API_URL = 'https://esm.sh/@webcontainer/api';
const NODEEXEC_RUN_DIR = '/__nodeexec__';
const NODEEXEC_DEFAULT_TIMEOUT_MS = 10000;
const NODEEXEC_MAX_TIMEOUT_MS = 1200000;
const NODEEXEC_MAX_SYNC_FILES = 500;
const NODEEXEC_MAX_SYNC_BYTES = 25 * 1024 * 1024;
const NODEEXEC_MAX_OUTPUT_CHARS = 200000;

function _getWebContainerEnvironmentProblem() {
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
  if (!window.isSecureContext || (location.protocol !== 'https:' && !isLocalhost)) return 'WebContainers require HTTPS or localhost.';
  if (typeof SharedArrayBuffer === 'undefined') return 'WebContainers require SharedArrayBuffer support.';
  if (!window.crossOriginIsolated) return 'WebContainers require cross-origin isolation. Serve this page with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp, then reload.';
  return '';
}

async function ensureWebContainer() {
  if (webcontainerInstance) return webcontainerInstance;
  if (webcontainerLoading) {
    while (webcontainerLoading) await new Promise(r => setTimeout(r, 100));
    if (webcontainerInstance) return webcontainerInstance;
    throw new Error('Failed to load WebContainer.');
  }
  const problem = _getWebContainerEnvironmentProblem();
  if (problem) throw new Error(`${problem}\n\nNodeExec needs WebContainers, which require:\n- HTTPS or localhost\n- SharedArrayBuffer\n- Cross-Origin-Opener-Policy: same-origin\n- Cross-Origin-Embedder-Policy: require-corp\n\nA single static HTML file cannot set these response headers by itself. Serve onepagent.html through a local/static server that sends them, then reload.`);
  webcontainerLoading = true;
  appendSystemMsg('Loading Node runtime (WebContainers)...');
  try {
    webcontainerApiModule = webcontainerApiModule || await import(WEBCONTAINER_API_URL);
    webcontainerInstance = await webcontainerApiModule.WebContainer.boot();
    await _wcEnsureDir(webcontainerInstance, NODEEXEC_RUN_DIR);
    webcontainerLoading = false;
    appendSystemMsg('Node runtime ready (WebContainers).');
    if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
    return webcontainerInstance;
  } catch (e) {
    webcontainerLoading = false;
    throw new Error('Failed to load WebContainer: ' + (e.message || e));
  }
}

function _wcNativePath(path, fallback = '/') {
  let p = String(path || fallback || '').trim();
  if (!p) p = fallback || '/';
  p = p.replace(/\\+/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+/g, '/');
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}
function _wcProjectPath(path) {
  const p = _wcNativePath(path, '/');
  return p === '/' ? '.' : p.slice(1);
}
function _wcRelativePath(fromDir, toPath) {
  const from = _wcNativePath(fromDir, '/').split('/').filter(Boolean);
  const to = _wcNativePath(toPath, '/').split('/').filter(Boolean);
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  const rel = [...from.map(() => '..'), ...to].join('/') || '.';
  return rel.startsWith('.') ? rel : './' + rel;
}

async function _wcEnsureDir(wc, path) {
  path = _wcNativePath(path, '/');
  if (path === '/') return;
  try { await wc.fs.mkdir(_wcProjectPath(path), { recursive: true }); } catch (e) {
    if (!/exist|EEXIST/i.test(String(e?.message || e))) throw e;
  }
}

async function _wcExists(wc, path) {
  path = _wcNativePath(path, '/');
  try { await wc.fs.readdir(_wcProjectPath(path)); return { exists: true, type: 'dir' }; } catch {}
  try { await wc.fs.readFile(_wcProjectPath(path)); return { exists: true, type: 'file' }; } catch {}
  return { exists: false, type: null };
}

async function _wcWriteFile(wc, path, file, overwrite = true) {
  path = _wcNativePath(path, '/');
  const existing = await _wcExists(wc, path);
  if (existing.exists && !overwrite) throw new Error(`WebContainer path exists: ${path}`);
  await _wcEnsureDir(wc, _pathDirName(path));
  await wc.fs.writeFile(_wcProjectPath(path), file.binary ? file.bytes : file.content);
}

async function _wcReadFile(wc, path, binary) {
  path = _wcNativePath(path, '/');
  const data = await wc.fs.readFile(_wcProjectPath(path), binary ? undefined : 'utf-8');
  if (binary) return data instanceof Uint8Array ? data : new Uint8Array(data);
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

function _asArray(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
function _matchesAnyGlob(path, patterns) { return _asArray(patterns).some(p => globMatch(String(p), path)); }
function _passesSyncFilters(file, entry) {
  const rel = file.rel || _pathBaseName(file.path);
  if (entry.include && !globMatch(String(entry.include), rel) && !globMatch(String(entry.include), file.path)) return false;
  if (entry.exclude && (_matchesAnyGlob(rel, entry.exclude) || _matchesAnyGlob(file.path, entry.exclude))) return false;
  return true;
}

function _formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function _checkSyncLimits(files, maxFiles = NODEEXEC_MAX_SYNC_FILES, maxBytes = NODEEXEC_MAX_SYNC_BYTES) {
  const totalBytes = files.reduce((sum, f) => sum + (f.binary ? (f.bytes?.length || f.size || 0) : (f.content || '').length), 0);
  if (files.length > maxFiles) throw new Error(`sync exceeded file limit: ${files.length} > ${maxFiles}`);
  if (totalBytes > maxBytes) throw new Error(`sync exceeded byte limit: ${_formatBytes(totalBytes)} > ${_formatBytes(maxBytes)}`);
  return totalBytes;
}

function _rejectUnsafeRootSync(source, allowRootSync) {
  if (_wcNativePath(source, '/') === '/' && !allowRootSync) throw new Error('Refusing to sync / by default. Pass allow_root_sync: true and a focused include pattern if you really need it.');
}

async function _collectWebContainerFiles(wc, source, binaryOverride = null, options = {}) {
  source = _wcNativePath(source, '/');
  const sourceBase = source.replace(/\/+$/, '') || '/';
  const explicitSpecial = /(^|\/)node_modules($|\/)|^\/__nodeexec__($|\/)/.test(sourceBase);
  const out = [];
  async function walk(path, rel) {
    let entries;
    try { entries = await wc.fs.readdir(_wcProjectPath(path), { withFileTypes: true }); } catch {
      const binary = binaryOverride == null ? _isBinaryPathByExt(path) : !!binaryOverride;
      const data = await _wcReadFile(wc, path, binary);
      out.push({ path, rel: rel || _pathBaseName(path), binary, bytes: binary ? data : undefined, content: binary ? undefined : data, size: binary ? data.length : data.length });
      return;
    }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!name || name === '.' || name === '..') continue;
      const child = (path === '/' ? '' : path) + '/' + name;
      const childRel = rel ? rel + '/' + name : name;
      if (!explicitSpecial && !options.includeSpecial && (/^node_modules($|\/)/.test(childRel) || /^__nodeexec__($|\/)/.test(childRel))) continue;
      const isDir = typeof entry !== 'string' && typeof entry.isDirectory === 'function' ? entry.isDirectory() : null;
      if (isDir === true) await walk(child, childRel);
      else if (isDir === false) {
        const binary = binaryOverride == null ? _isBinaryPathByExt(child) : !!binaryOverride;
        const data = await _wcReadFile(wc, child, binary);
        out.push({ path: child, rel: childRel, binary, bytes: binary ? data : undefined, content: binary ? undefined : data, size: binary ? data.length : data.length });
      } else {
        await walk(child, childRel);
      }
    }
  }
  await walk(sourceBase, '');
  return { isDir: out.length !== 1 || out[0].path !== sourceBase, files: out };
}

function _resolveWcCopyDest(targetRaw, target, srcName) {
  if (String(targetRaw || '').trim().endsWith('/')) return (target.replace(/\/+$/, '') || '/') + '/' + srcName;
  return target;
}

async function _syncVfsToWebContainer(wc, entries, options = {}) {
  const written = [];
  let totalBytes = 0;
  for (const entryRaw of entries || []) {
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : { source_path: entryRaw };
    const sourceRaw = String(entry.source_path || entry.vfs_path || '').trim();
    if (!sourceRaw) throw new Error('sync_in source_path is required.');
    const source = normPath(sourceRaw);
    _rejectUnsafeRootSync(source, options.allowRootSync);
    const { root, files } = await _collectVfsFiles(source);
    const filtered = files.filter(f => _passesSyncFilters(f, entry));
    totalBytes += _checkSyncLimits(filtered, entry.max_files || options.maxFiles, entry.max_bytes || options.maxBytes);
    const targetRaw = String(entry.target_path || '').trim();
    const target = _wcNativePath(targetRaw, source);
    if (root.type === 'dir') await _wcEnsureDir(wc, target);
    for (const file of filtered) {
      const dest = root.type === 'dir'
        ? (target.replace(/\/+$/, '') || '/') + '/' + file.rel
        : _resolveWcCopyDest(targetRaw, target, _pathBaseName(source));
      await _wcWriteFile(wc, dest, file, entry.overwrite !== false);
      written.push(dest);
    }
  }
  return { files: written, bytes: totalBytes };
}

async function _syncWebContainerToVfs(wc, entries, options = {}) {
  const written = [];
  let totalBytes = 0;
  for (const entryRaw of entries || []) {
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : { source_path: entryRaw };
    const sourceRaw = String(entry.source_path || entry.webcontainer_path || '').trim();
    if (!sourceRaw) throw new Error('sync_out source_path is required.');
    const source = _wcNativePath(sourceRaw, '/');
    _rejectUnsafeRootSync(source, options.allowRootSync);
    const { files } = await _collectWebContainerFiles(wc, source, Object.prototype.hasOwnProperty.call(entry, 'binary') ? !!entry.binary : null);
    const filtered = files.filter(f => _passesSyncFilters(f, entry));
    totalBytes += _checkSyncLimits(filtered, entry.max_files || options.maxFiles, entry.max_bytes || options.maxBytes);
    const targetRaw = String(entry.target_path || '').trim();
    const target = normPath(targetRaw || source);
    const sourceIsSingleFile = filtered.length === 1 && filtered[0].path === source;
    for (const file of filtered) {
      const dest = sourceIsSingleFile
        ? _resolveVfsCopyFileDest(targetRaw, target, _pathBaseName(source))
        : normPath((target.replace(/\/+$/, '') || '/') + '/' + file.rel);
      if (vfsResolve(dest) && entry.overwrite === false) throw new Error(`VFS path exists: ${dest}`);
      if (file.binary) await vfsWriteBinary(dest, file.bytes, true);
      else vfsWrite(dest, file.content || '', true);
      written.push(dest);
    }
  }
  if (written.length) renderFileTree();
  return { files: written, bytes: totalBytes };
}

function vfsStat(path, root = vfs) {
  const node = vfsResolve(path, root);
  if (!node) return null;
  if (node.type === 'dir') return { path: normPath(path), type: 'dir', size: 0, binary: false };
  const size = node.binary ? (node.size ?? (node.bytes ? node.bytes.length : 0)) : (node.content || '').length;
  return { path: normPath(path), type: 'file', binary: !!node.binary, size };
}

// Write binary bytes to the VFS. Bytes go to the content-addressed blob store;
// the vfs node only carries {hash,size}. Async — callers must await.
async function vfsWriteBinary(path, bytes, skipRender = false, root = vfs) {
  path = normPath(path);
  const parts = path.slice(1).split('/'); const fn = parts.pop(); let n = root;
  for (const p of parts) { if (!n.children[p]) n.children[p] = { type: 'dir', children: {} }; n = n.children[p]; }
  const existing = n.children[fn];
  const { hash, size } = await blobStore.put(bytes);
  // Balance refcount when overwriting: drop the ref held by the old node,
  // or if same hash, drop the duplicate ref we just added.
  if (existing?.type === 'file' && existing.binary && existing.hash) {
    await blobStore.unref(existing.hash);
  } else if (existing?.type === 'file' && existing.binary && existing.bytes && !existing.hash) {
    // Legacy in-memory node with raw bytes — no blob ref to drop.
  }
  n.children[fn] = {
    type: 'file',
    content: `[Binary: ${fn}, ${size} bytes]`,
    binary: true,
    hash,
    size,
    modified: Date.now(),
  };
  if (!skipRender && root === vfs) renderFileTree();
  return { ok: true, path, bytes: size, hash };
}

// Fetch binary bytes for a path. Async — returns Uint8Array or null.
async function vfsGetBinary(path, root = vfs) {
  const node = vfsResolve(path, root);
  if (!node || node.type !== 'file') return null;
  if (!node.binary) return null;
  // Preferred path: node carries a blob hash.
  if (node.hash) return blobStore.get(node.hash);
  // Legacy path: unmigrated in-memory bytes.
  if (node.bytes) return node.bytes;
  return null;
}

function getPythonNativePathHint(msg) {
  const text = String(msg || '').toLowerCase();
  const patterns = [
    'fileno',
    'bad file descriptor',
    'embedded null byte',
    'invalid argument',
    'operation not permitted',
    'permission denied',
    'no such file or directory',
    'not a regular file',
    'expects a path-like object',
    'path-like object',
    'stat: path should be string',
    'mmap',
    'native path',
    '/tmp/',
  ];
  if (!patterns.some(p => text.includes(p))) return '';
  return '\nHint: this library may require a real native temp path. Try workspacefs.materialize_to_tmp("/path/in.ext", binary=True), run the library on the returned /tmp path, then write results back with workspacefs.persist_tmp_file("/tmp/out.ext", "/outputs/out.ext", binary=True).';
}

