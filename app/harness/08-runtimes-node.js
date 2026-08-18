/* creel harness — part 8 of 26: runtimes-node
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
 * Continues the previous part: Pyodide binary hydration bridge
 */
// ── Pyodide binary hydration bridge ───────────────────────────────
// Pyodide runs on the main thread so Python's sync read_bytes can't await.
// Before each exec we scan the code for literal binary paths, pull their bytes
// out of the blob store into _pyHydratedBytes, and have the JS bridge read
// from that cache. write_bytes writes into _pyDirtyWrites (sync), and _pyFlush
// persists them to the blob store after runPythonAsync returns.
const _pyHydratedBytes = new Map(); // path → Uint8Array
const _pyDirtyWrites = new Map();   // path → Uint8Array
const _pyPendingUnrefs = [];        // hashes to drop after runPythonAsync

const _PY_BIN_PATH_PATTERNS = [
  /(?:workspacefs\.)?read_bytes\s*\(\s*(['"])([^'"]+)\1/g,
  /materialize_to_tmp\s*\(\s*(['"])([^'"]+)\1/g,
  /open\s*\(\s*(['"])([^'"]+)\1\s*,\s*['"][rab+]*b[rab+]*['"]/g,
  /(?:Path|pathlib\.Path|WorkspacePath)\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*(?:read_bytes|open)/g,
];

function _pathBaseName(path) {
  return String(path || '').replace(/\/+$/, '').split('/').pop() || 'file';
}
function _pathDirName(path) {
  const p = String(path || '').replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}
function _isBinaryPathByExt(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  return BINARY_EXTS.has(ext);
}
function _pyNativePath(path, fallback) {
  let p = String(path || fallback || '').trim();
  if (!p) p = '/tmp';
  if (!p.startsWith('/')) p = '/tmp/' + p;
  return p.replace(/\/+/g, '/');
}
function _pyExists(pyodide, path) {
  try { return !!pyodide.FS.analyzePath(path).exists; } catch { return false; }
}
function _pyStat(pyodide, path) {
  try { return pyodide.FS.stat(path); } catch { return null; }
}
function _pyIsDir(pyodide, path) {
  const st = _pyStat(pyodide, path);
  return !!st && pyodide.FS.isDir(st.mode);
}
function _pyIsFile(pyodide, path) {
  const st = _pyStat(pyodide, path);
  return !!st && pyodide.FS.isFile(st.mode);
}
function _pyEnsureDir(pyodide, path) {
  path = _pyNativePath(path, '/tmp');
  if (path === '/') return;
  if (_pyExists(pyodide, path)) {
    if (!_pyIsDir(pyodide, path)) throw new Error(`Native path is not a directory: ${path}`);
    return;
  }
  pyodide.FS.mkdirTree(path);
}
function _resolveCopyFileDest(pyodide, dest, srcName) {
  dest = _pyNativePath(dest, '/tmp/' + srcName);
  if (dest.endsWith('/') || _pyIsDir(pyodide, dest)) return (dest.replace(/\/+$/, '') || '/') + '/' + srcName;
  return dest;
}
function _resolveVfsCopyFileDest(destRaw, dest, srcName) {
  const existing = vfsResolve(dest);
  if (String(destRaw || '').trim().endsWith('/') || existing?.type === 'dir') return normPath(dest + '/' + srcName);
  return dest;
}
async function _collectVfsFiles(srcPath) {
  srcPath = normPath(srcPath);
  const root = vfsResolve(srcPath);
  if (!root) throw new Error(`VFS path not found: ${srcPath}`);
  const out = [];
  async function walk(path, node, rel) {
    if (node.type === 'dir') {
      for (const [name, child] of Object.entries(node.children || {})) {
        await walk((path === '/' ? '' : path) + '/' + name, child, rel ? rel + '/' + name : name);
      }
      return;
    }
    if (node.binary) {
      const bytes = await vfsGetBinary(path);
      if (!bytes) throw new Error(`Binary bytes unavailable: ${path}`);
      out.push({ path, rel, binary: true, bytes });
    } else {
      out.push({ path, rel, binary: false, content: node.content || '' });
    }
  }
  await walk(srcPath, root, root.type === 'file' ? _pathBaseName(srcPath) : '');
  return { root, files: out };
}
async function toolVfsToPyodide(input) {
  input = input && typeof input === 'object' ? input : {};
  const sourceRaw = String(input.source_path || input.vfs_path || '').trim();
  if (!sourceRaw) return 'Error: source_path is required.';
  const source = normPath(sourceRaw);
  const overwrite = input.overwrite !== false;
  const pyodide = await ensurePyodide();
  const { root, files } = await _collectVfsFiles(source);
  const targetRaw = String(input.target_path || input.pyodide_path || '').trim();
  const target = _pyNativePath(targetRaw, root.type === 'dir' ? `/tmp/${_pathBaseName(source)}` : `/tmp/${_pathBaseName(source)}`);
  const written = [];
  if (root.type === 'dir') _pyEnsureDir(pyodide, target);
  for (const file of files) {
    const dest = root.type === 'dir'
      ? (target.replace(/\/+$/, '') || '/') + '/' + file.rel
      : _resolveCopyFileDest(pyodide, target, _pathBaseName(source));
    if (_pyExists(pyodide, dest) && !overwrite) throw new Error(`Native path exists: ${dest}`);
    _pyEnsureDir(pyodide, _pathDirName(dest));
    pyodide.FS.writeFile(dest, file.binary ? file.bytes : file.content, file.binary ? undefined : { encoding: 'utf8' });
    written.push(dest);
  }
  return `Copied ${written.length} file(s) from VFS to Pyodide native FS:\n` + written.join('\n');
}
function _collectPyodideFiles(pyodide, source, binaryOverride = null) {
  source = _pyNativePath(source, '/tmp');
  if (!_pyExists(pyodide, source)) throw new Error(`Pyodide path not found: ${source}`);
  const out = [];
  function walk(path, rel) {
    if (_pyIsDir(pyodide, path)) {
      for (const name of pyodide.FS.readdir(path)) {
        if (name === '.' || name === '..') continue;
        walk((path.replace(/\/+$/, '') || '/') + '/' + name, rel ? rel + '/' + name : name);
      }
      return;
    }
    if (!_pyIsFile(pyodide, path)) return;
    out.push({ path, rel: rel || _pathBaseName(path), binary: typeof binaryOverride === 'boolean' ? binaryOverride : _isBinaryPathByExt(path) });
  }
  walk(source, _pyIsFile(pyodide, source) ? _pathBaseName(source) : '');
  return { isDir: _pyIsDir(pyodide, source), files: out };
}
async function toolPyodideToVfs(input) {
  input = input && typeof input === 'object' ? input : {};
  const sourceRaw = String(input.source_path || input.pyodide_path || '').trim();
  if (!sourceRaw) return 'Error: source_path is required.';
  const source = _pyNativePath(sourceRaw, '');
  const pyodide = await ensurePyodide();
  const overwrite = input.overwrite !== false;
  const binaryOverride = typeof input.binary === 'boolean' ? input.binary : null;
  const { isDir, files } = _collectPyodideFiles(pyodide, source, binaryOverride);
  const targetRaw = String(input.target_path || input.vfs_path || '').trim();
  const target = normPath(targetRaw || (isDir ? `/outputs/${_pathBaseName(source)}` : `/outputs/${_pathBaseName(source)}`));
  const written = [];
  for (const file of files) {
    const dest = isDir ? normPath(target + '/' + file.rel) : _resolveVfsCopyFileDest(targetRaw, target, _pathBaseName(source));
    if (vfsResolve(dest) && !overwrite) throw new Error(`VFS path exists: ${dest}`);
    if (file.binary) {
      const bytes = pyodide.FS.readFile(file.path);
      await vfsWriteBinary(dest, bytes, true);
    } else {
      const text = pyodide.FS.readFile(file.path, { encoding: 'utf8' });
      vfsWrite(dest, text, true);
    }
    written.push(dest);
  }
  if (written.length) renderFileTree();
  return `Copied ${written.length} file(s) from Pyodide native FS to VFS:\n` + written.join('\n');
}

function _pyScanBinaryPaths(code) {
  const paths = new Set();
  for (const re of _PY_BIN_PATH_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) paths.add(m[2]);
  }
  return [...paths];
}

async function _pyHydrate(paths) {
  _pyHydratedBytes.clear();
  _pyDirtyWrites.clear();
  for (const p of paths) {
    const np = normPath(p);
    const node = vfsResolve(np);
    if (!node || node.type !== 'file' || !node.binary) continue;
    if (node.hash) {
      const bytes = await blobStore.get(node.hash);
      if (bytes) _pyHydratedBytes.set(np, bytes);
    } else if (node.bytes) {
      _pyHydratedBytes.set(np, node.bytes);
    }
  }
}

async function _pyFlush() {
  const writes = [..._pyDirtyWrites.entries()];
  const unrefs = _pyPendingUnrefs.slice();
  _pyDirtyWrites.clear();
  _pyPendingUnrefs.length = 0;
  _pyHydratedBytes.clear();
  // Drop ref on any blob whose vfs node we replaced with a pending placeholder
  // during this exec — vfsWriteBinary below can't see the original hash because
  // the placeholder overwrote it synchronously.
  for (const h of unrefs) {
    try { await blobStore.unref(h); } catch (e) { console.warn('pyFlush unref failed:', e); }
  }
  for (const [path, bytes] of writes) {
    try { await vfsWriteBinary(path, bytes, true); }
    catch (e) { console.warn('pyFlush write failed for', path, e); }
  }
  if (writes.length) renderFileTree();
}

async function toolPythonExec(input) {
  const code = input.code || '';
  const packages = input.packages || [];
  try {
    const pyodide = await ensurePyodide();
    if (packages.length) {
      for (const pkg of packages) {
        try { await pyodide.runPythonAsync(`import micropip; await micropip.install("${pkg.replace(/"/g, '')}")`); }
        catch (e) { return `Error installing ${pkg}: ${e.message}. This package may require C extensions not available in browser Python.`; }
      }
    }

    // Hydrate binary bytes for paths referenced by the code, so Python's sync
    // read_bytes/materialize_to_tmp can serve bytes without an await round-trip.
    await _pyHydrate(_pyScanBinaryPaths(code));

    if (!pyodide.__workspacefsRegistered) {
      pyodide.registerJsModule('workspacefs_js', {
        read_text(path) {
          const st = vfsStat(path);
          if (!st) throw new Error(`File not found: ${path}`);
          if (st.type !== 'file') throw new Error(`Not a file: ${path}`);
          if (st.binary) throw new Error(`Binary file: ${path}`);
          const r = vfsRead(path);
          if (r.error) throw new Error(r.error);
          return r.content;
        },
        write_text(path, content) {
          const r = vfsWrite(path, String(content));
          if (r.error) throw new Error(r.error);
          return true;
        },
        read_bytes(path) {
          const p = normPath(path);
          // Read-after-write within this exec: check staged writes first.
          if (_pyDirtyWrites.has(p)) return new Uint8Array(_pyDirtyWrites.get(p));
          // Pre-hydrated binary: serve from cache.
          if (_pyHydratedBytes.has(p)) return new Uint8Array(_pyHydratedBytes.get(p));
          const st = vfsStat(p);
          if (!st) throw new Error(`File not found: ${p}`);
          if (st.type !== 'file') throw new Error(`Not a file: ${p}`);
          if (!st.binary) {
            // Text file: encode on the fly (same semantics as before).
            const r = vfsRead(p);
            if (r.error) throw new Error(r.error);
            return new TextEncoder().encode(r.content);
          }
          // Binary but not pre-hydrated. Tell the caller to hydrate.
          throw new Error(`[workspacefs] Binary bytes for ${p} are not pre-hydrated. ` +
            `Use a literal path in read_bytes/open(..., 'rb'), or call 'await workspacefs.hydrate("${p}")' before reading.`);
        },
        async hydrate_bytes(path) {
          const p = normPath(path);
          const node = vfsResolve(p);
          if (!node || node.type !== 'file' || !node.binary) return false;
          if (node.hash) {
            const bytes = await blobStore.get(node.hash);
            if (!bytes) return false;
            _pyHydratedBytes.set(p, bytes);
            return true;
          }
          if (node.bytes) {
            _pyHydratedBytes.set(p, node.bytes);
            return true;
          }
          return false;
        },
        write_bytes(path, data) {
          const p = normPath(path);
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
          // Stage the write; flushed to blob store after runPythonAsync returns.
          _pyDirtyWrites.set(p, bytes);
          // Also stamp a synchronous placeholder in the vfs tree so subsequent
          // exists/stat/listdir calls inside the same exec see the new file
          // even though hashing + blob put is deferred until flush.
          const parts = p.slice(1).split('/'); const fn = parts.pop(); let n = vfs;
          for (const q of parts) { if (!n.children[q]) n.children[q] = { type: 'dir', children: {} }; n = n.children[q]; }
          const prior = n.children[fn];
          if (prior?.type === 'file' && prior.binary && prior.hash) {
            _pyPendingUnrefs.push(prior.hash);
          }
          n.children[fn] = {
            type: 'file', binary: true, size: bytes.length,
            content: `[Binary: ${fn}, ${bytes.length} bytes]`,
            _pyPending: true, modified: Date.now(),
          };
          return true;
        },
        exists(path) {
          return !!vfsStat(path);
        },
        is_file(path) {
          const st = vfsStat(path);
          return !!st && st.type === 'file';
        },
        is_dir(path) {
          const st = vfsStat(path);
          return !!st && st.type === 'dir';
        },
        listdir(path) {
          const node = vfsResolve(path);
          if (!node) throw new Error(`Not found: ${path}`);
          if (node.type !== 'dir') throw new Error(`Not a directory: ${path}`);
          return Object.keys(node.children || {}).sort();
        },
        mkdir(path, recursive) {
          path = normPath(path);
          const existing = vfsResolve(path);
          if (existing) throw new Error(`Path already exists: ${path}`);
          if (recursive) {
            const r = vfsMkdir(path);
            if (r.error) throw new Error(r.error);
            return true;
          }
          const parent = path.substring(0, path.lastIndexOf('/')) || '/';
          const parentNode = vfsResolve(parent);
          if (!parentNode || parentNode.type !== 'dir') throw new Error(`Parent directory not found: ${parent}`);
          const name = path.split('/').pop();
          parentNode.children[name] = { type: 'dir', children: {}, modified: Date.now() };
          renderFileTree();
          return true;
        },
        remove(path) {
          const st = vfsStat(path);
          if (!st) throw new Error(`Not found: ${path}`);
          if (st.type !== 'file') throw new Error(`Not a file: ${path}`);
          const r = vfsDelete(path);
          if (r.error) throw new Error(r.error);
          return true;
        },
        rmdir(path) {
          const node = vfsResolve(path);
          if (!node) throw new Error(`Not found: ${path}`);
          if (node.type !== 'dir') throw new Error(`Not a directory: ${path}`);
          if (Object.keys(node.children || {}).length) throw new Error(`Directory not empty: ${path}`);
          const r = vfsDelete(path);
          if (r.error) throw new Error(r.error);
          return true;
        },
        glob(pattern) {
          return vfsGlob(pattern, '/');
        },
        stat(path) {
          const st = vfsStat(path);
          return st ? { path: st.path, type: st.type, size: st.size, binary: st.binary } : null;
        },
      });
      pyodide.__workspacefsRegistered = true;
    }

    pyodide.runPython(`
import sys, io, os, builtins, glob as _glob, pathlib, posixpath, types, time, stat as _stat
import workspacefs_js as _jsfs

sys.stdout = io.StringIO()
sys.stderr = io.StringIO()

_orig_open = builtins.open
_orig_getcwd = os.getcwd
_orig_chdir = os.chdir
_orig_exists = os.path.exists
_orig_isfile = os.path.isfile
_orig_isdir = os.path.isdir
_orig_listdir = os.listdir
_orig_mkdir = os.mkdir
_orig_makedirs = os.makedirs
_orig_remove = os.remove
_orig_unlink = os.unlink
_orig_rmdir = os.rmdir
_orig_stat = os.stat
_orig_glob = _glob.glob
_orig_iglob = _glob.iglob
_orig_path_class = pathlib.Path
_workspace_cwd = '/'


def _to_py(val):
    return val.to_py() if hasattr(val, 'to_py') else val


def _is_native_path(path):
    p = str(path)
    return p.startswith('/tmp') or p.startswith('/dev') or p.startswith('/lib')


def _norm_workspace_path(path):
    p = str(path or '.')
    if _is_native_path(p):
        return p
    if not p.startswith('/'):
        p = posixpath.join(_workspace_cwd, p)
    p = posixpath.normpath(p)
    if not p.startswith('/'):
        p = '/' + p
    return p


def _js_exists(path):
    return bool(_to_py(_jsfs.exists(path)))


def _js_is_file(path):
    return bool(_to_py(_jsfs.is_file(path)))


def _js_is_dir(path):
    return bool(_to_py(_jsfs.is_dir(path)))


def _js_read_text(path):
    return _to_py(_jsfs.read_text(path))


def _js_write_text(path, content):
    _jsfs.write_text(path, content)


def _js_read_bytes(path):
    return bytes(_to_py(_jsfs.read_bytes(path)))


def _js_write_bytes(path, data):
    _jsfs.write_bytes(path, data)


def _js_listdir(path):
    return list(_to_py(_jsfs.listdir(path)))


def _js_glob(pattern):
    return list(_to_py(_jsfs.glob(pattern)))


def _js_stat(path):
    val = _jsfs.stat(path)
    return _to_py(val) if val is not None else None


class _WorkspaceTextIO(io.StringIO):
    def __init__(self, path, mode='r', encoding='utf-8', newline=None):
        self._path = _norm_workspace_path(path)
        self._mode = mode
        self._encoding = encoding or 'utf-8'
        self._writable = any(flag in mode for flag in ('w', 'a', 'x', '+'))
        exists = _js_exists(self._path)
        if 'x' in mode and exists:
            raise FileExistsError(self._path)
        if not exists and 'r' in mode and 'w' not in mode and 'a' not in mode and 'x' not in mode:
            raise FileNotFoundError(self._path)
        initial = ''
        if exists and ('r' in mode or 'a' in mode or '+' in mode):
            initial = _js_read_text(self._path)
        super().__init__(initial)
        if 'w' in mode:
            self.seek(0)
            self.truncate(0)
        elif 'a' in mode:
            self.seek(0, io.SEEK_END)
    @property
    def name(self):
        return self._path
    @property
    def mode(self):
        return self._mode
    @property
    def encoding(self):
        return self._encoding
    def flush(self):
        if not self.closed and self._writable:
            _js_write_text(self._path, self.getvalue())
    def close(self):
        if not self.closed:
            self.flush()
        super().close()


class _WorkspaceBinaryIO(io.BytesIO):
    def __init__(self, path, mode='rb'):
        self._path = _norm_workspace_path(path)
        self._mode = mode
        self._writable = any(flag in mode for flag in ('w', 'a', 'x', '+'))
        exists = _js_exists(self._path)
        if 'x' in mode and exists:
            raise FileExistsError(self._path)
        if not exists and 'r' in mode and 'w' not in mode and 'a' not in mode and 'x' not in mode:
            raise FileNotFoundError(self._path)
        initial = b''
        if exists and ('r' in mode or 'a' in mode or '+' in mode):
            initial = _js_read_bytes(self._path)
        super().__init__(initial)
        if 'w' in mode:
            self.seek(0)
            self.truncate(0)
        elif 'a' in mode:
            self.seek(0, io.SEEK_END)
    @property
    def name(self):
        return self._path
    @property
    def mode(self):
        return self._mode
    def flush(self):
        if not self.closed and self._writable:
            _js_write_bytes(self._path, self.getvalue())
    def close(self):
        if not self.closed:
            self.flush()
        super().close()


def _patched_open(path, mode='r', buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
    mapped = _norm_workspace_path(path)
    if _is_native_path(mapped):
        return _orig_open(mapped, mode, buffering=buffering, encoding=encoding, errors=errors, newline=newline, closefd=closefd, opener=opener)
    if 'b' in mode:
        return _WorkspaceBinaryIO(mapped, mode)
    return _WorkspaceTextIO(mapped, mode, encoding=encoding, newline=newline)


def _patched_getcwd():
    return _workspace_cwd


def _patched_chdir(path):
    global _workspace_cwd
    mapped = _norm_workspace_path(path)
    if _is_native_path(mapped):
        _orig_chdir(mapped)
        _workspace_cwd = mapped
        return
    if not _js_is_dir(mapped):
        raise NotADirectoryError(mapped)
    _workspace_cwd = mapped


def _patched_exists(path):
    mapped = _norm_workspace_path(path)
    return _orig_exists(mapped) if _is_native_path(mapped) else _js_exists(mapped)


def _patched_isfile(path):
    mapped = _norm_workspace_path(path)
    return _orig_isfile(mapped) if _is_native_path(mapped) else _js_is_file(mapped)


def _patched_isdir(path):
    mapped = _norm_workspace_path(path)
    return _orig_isdir(mapped) if _is_native_path(mapped) else _js_is_dir(mapped)


def _patched_listdir(path='.'):
    mapped = _norm_workspace_path(path)
    return _orig_listdir(mapped) if _is_native_path(mapped) else _js_listdir(mapped)


def _patched_mkdir(path, mode=0o777):
    mapped = _norm_workspace_path(path)
    if _is_native_path(mapped):
        return _orig_mkdir(mapped, mode)
    return _jsfs.mkdir(mapped, False)


def _patched_makedirs(name, mode=0o777, exist_ok=False):
    mapped = _norm_workspace_path(name)
    if _is_native_path(mapped):
        return _orig_makedirs(mapped, mode=mode, exist_ok=exist_ok)
    if _js_exists(mapped):
        if exist_ok:
            return None
        raise FileExistsError(mapped)
    return _jsfs.mkdir(mapped, True)


def _patched_remove(path):
    mapped = _norm_workspace_path(path)
    if _is_native_path(mapped):
        return _orig_remove(mapped)
    return _jsfs.remove(mapped)


def _patched_unlink(path):
    return _patched_remove(path)


def _patched_rmdir(path):
    mapped = _norm_workspace_path(path)
    if _is_native_path(mapped):
        return _orig_rmdir(mapped)
    return _jsfs.rmdir(mapped)


def _patched_stat(path, *args, **kwargs):
    mapped = _norm_workspace_path(path)
    if _is_native_path(mapped):
        return _orig_stat(mapped, *args, **kwargs)
    st = _js_stat(mapped)
    if not st:
        raise FileNotFoundError(mapped)
    mode = (_stat.S_IFDIR | 0o777) if st['type'] == 'dir' else (_stat.S_IFREG | 0o666)
    size = int(st.get('size', 0) or 0)
    now = int(time.time())
    return os.stat_result((mode, 0, 0, 0, 0, 0, size, now, now, now))


def _patched_glob(pathname, *args, **kwargs):
    pattern = str(pathname or '')
    mapped = _norm_workspace_path(pattern)
    if _is_native_path(mapped):
        return _orig_glob(mapped, *args, **kwargs)
    return _js_glob(mapped)


def _patched_iglob(pathname, *args, **kwargs):
    for p in _patched_glob(pathname, *args, **kwargs):
        yield p


class WorkspacePath:
    def __init__(self, *parts):
        joined = posixpath.join(*(str(p) for p in parts)) if parts else '.'
        self._path = _norm_workspace_path(joined)
    def __str__(self):
        return self._path
    def __repr__(self):
        return f"WorkspacePath({self._path!r})"
    def __fspath__(self):
        return self._path
    def as_posix(self):
        return self._path
    @property
    def name(self):
        return posixpath.basename(self._path)
    @property
    def parent(self):
        parent = posixpath.dirname(self._path) or '/'
        return WorkspacePath(parent)
    def joinpath(self, *other):
        return WorkspacePath(self._path, *(str(x) for x in other))
    def __truediv__(self, other):
        return self.joinpath(other)
    def exists(self):
        return _patched_exists(self._path)
    def is_file(self):
        return _patched_isfile(self._path)
    def is_dir(self):
        return _patched_isdir(self._path)
    def open(self, mode='r', encoding=None, newline=None):
        return _patched_open(self._path, mode=mode, encoding=encoding, newline=newline)
    def read_text(self, encoding='utf-8'):
        with self.open('r', encoding=encoding) as f:
            return f.read()
    def write_text(self, data, encoding='utf-8'):
        with self.open('w', encoding=encoding) as f:
            return f.write(data)
    def read_bytes(self):
        with self.open('rb') as f:
            return f.read()
    def write_bytes(self, data):
        with self.open('wb') as f:
            return f.write(data)
    def iterdir(self):
        for name in _patched_listdir(self._path):
            yield self / name
    def glob(self, pattern):
        return [WorkspacePath(p) for p in _patched_glob(posixpath.join(self._path, str(pattern)))]
    def rglob(self, pattern):
        pat = str(pattern)
        pat = ('**/' + pat.lstrip('/')) if not pat.startswith('**/') else pat
        return [WorkspacePath(p) for p in _patched_glob(posixpath.join(self._path, pat))]
    def mkdir(self, mode=0o777, parents=False, exist_ok=False):
        if self.exists():
            if exist_ok:
                return None
            raise FileExistsError(self._path)
        return _patched_makedirs(self._path, mode=mode, exist_ok=exist_ok) if parents else _patched_mkdir(self._path, mode=mode)
    def unlink(self):
        return _patched_unlink(self._path)
    def stat(self, *args, **kwargs):
        return _patched_stat(self._path, *args, **kwargs)
    @classmethod
    def cwd(cls):
        return cls(_workspace_cwd)
    @classmethod
    def home(cls):
        return cls('/')


def _materialize_to_tmp(path, binary=None):
    src = _norm_workspace_path(path)
    if _is_native_path(src):
        return src
    if not _js_is_file(src):
        raise FileNotFoundError(src)
    name = posixpath.basename(src) or 'materialized'
    tmp_path = f"/tmp/cc_materialized_{name}"
    if binary is None:
        st = _js_stat(src)
        binary = bool(st and st.get('binary'))
    if binary:
        with _orig_open(tmp_path, 'wb') as f:
            f.write(_js_read_bytes(src))
    else:
        with _orig_open(tmp_path, 'w', encoding='utf-8') as f:
            f.write(_js_read_text(src))
    return tmp_path


def _persist_tmp_file(tmp_path, dest_path, binary=None):
    dest = _norm_workspace_path(dest_path)
    if _is_native_path(dest):
        raise ValueError('Destination must be a workspace path, not a native path')
    if binary is None:
        st = _js_stat(dest)
        if st is not None:
            binary = bool(st.get('binary'))
        else:
            binary = dest.lower().split('.')[-1] in ('pptx','xlsx','xls','docx','doc','pdf','png','jpg','jpeg','gif','bmp','ico','webp','svg','zip','gz','tar','whl','pyc','so','dll','exe','bin','dat','sqlite','db','mp3','mp4','wav','ogg','ttf','otf','woff','woff2')
    if binary:
        with _orig_open(tmp_path, 'rb') as f:
            _js_write_bytes(dest, f.read())
    else:
        with _orig_open(tmp_path, 'r', encoding='utf-8') as f:
            _js_write_text(dest, f.read())
    return dest


workspacefs = types.ModuleType('workspacefs')
workspacefs.read_text = lambda path: _js_read_text(_norm_workspace_path(path))
workspacefs.write_text = lambda path, content: _js_write_text(_norm_workspace_path(path), content)
workspacefs.read_bytes = lambda path: _js_read_bytes(_norm_workspace_path(path))
workspacefs.write_bytes = lambda path, data: _js_write_bytes(_norm_workspace_path(path), data)
workspacefs.exists = lambda path: _patched_exists(path)
workspacefs.isfile = lambda path: _patched_isfile(path)
workspacefs.isdir = lambda path: _patched_isdir(path)
workspacefs.listdir = lambda path='/': _patched_listdir(path)
workspacefs.glob = lambda pattern: _patched_glob(pattern)
workspacefs.stat = lambda path: _js_stat(_norm_workspace_path(path))
workspacefs.materialize_to_tmp = lambda path, binary=None: _materialize_to_tmp(path, binary)
workspacefs.persist_tmp_file = lambda tmp_path, dest_path, binary=None: _persist_tmp_file(tmp_path, dest_path, binary)
workspacefs.Path = WorkspacePath


async def _workspacefs_hydrate(path):
    return bool(await _jsfs.hydrate_bytes(_norm_workspace_path(path)))


workspacefs.hydrate = _workspacefs_hydrate
sys.modules['workspacefs'] = workspacefs

workspace_cli = types.ModuleType('workspace_cli')


def _workspace_cli_result(**data):
    return data


def _workspace_cli_read(path, binary=False):
    target = _norm_workspace_path(path)
    if binary:
        data = _js_read_bytes(target)
        return _workspace_cli_result(ok=True, path=target, binary=True, bytes=list(data), size=len(data))
    text = _js_read_text(target)
    return _workspace_cli_result(ok=True, path=target, binary=False, text=text, size=len(text))


def _workspace_cli_write(path, content=None, binary=False, bytes_data=None, mkdir=False):
    target = _norm_workspace_path(path)
    parent = posixpath.dirname(target) or '/'
    if mkdir and not _patched_exists(parent):
        _patched_makedirs(parent, exist_ok=True)
    if binary:
        data = bytes(bytes_data or [])
        _js_write_bytes(target, data)
        return _workspace_cli_result(ok=True, path=target, binary=True, size=len(data))
    text = '' if content is None else str(content)
    _js_write_text(target, text)
    return _workspace_cli_result(ok=True, path=target, binary=False, size=len(text))


def _workspace_cli_listdir(path='/', recursive=False):
    target = _norm_workspace_path(path)
    if not recursive:
        return _workspace_cli_result(ok=True, path=target, entries=_patched_listdir(target))
    entries = []
    def _walk(cur):
        for name in _patched_listdir(cur):
            child = posixpath.join(cur, name) if cur != '/' else '/' + name
            st = _js_stat(child)
            entries.append({'path': child, 'type': st['type'] if st else 'unknown', 'size': (st or {}).get('size', 0), 'binary': bool((st or {}).get('binary'))})
            if st and st['type'] == 'dir':
                _walk(child)
    _walk(target)
    return _workspace_cli_result(ok=True, path=target, entries=entries)


def _workspace_cli_glob(pattern):
    return _workspace_cli_result(ok=True, pattern=str(pattern), entries=_patched_glob(pattern))


def _workspace_cli_stat(path):
    target = _norm_workspace_path(path)
    st = _js_stat(target)
    if not st:
        return _workspace_cli_result(ok=False, path=target, error='not found')
    return _workspace_cli_result(ok=True, **st)


def _workspace_cli_mkdir(path, parents=True, exist_ok=True):
    target = _norm_workspace_path(path)
    if parents:
        _patched_makedirs(target, exist_ok=exist_ok)
    else:
        _patched_mkdir(target)
    return _workspace_cli_result(ok=True, path=target)


def _workspace_cli_remove(path, recursive=False):
    target = _norm_workspace_path(path)
    st = _js_stat(target)
    if not st:
        return _workspace_cli_result(ok=False, path=target, error='not found')
    if st['type'] == 'file':
        _patched_remove(target)
        return _workspace_cli_result(ok=True, path=target)
    if not recursive and _patched_listdir(target):
        return _workspace_cli_result(ok=False, path=target, error='directory not empty')
    if recursive:
        for name in list(_patched_listdir(target)):
            child = posixpath.join(target, name) if target != '/' else '/' + name
            _workspace_cli_remove(child, recursive=True)
    _patched_rmdir(target)
    return _workspace_cli_result(ok=True, path=target)


def _workspace_cli_copy(src, dest, mkdir=False):
    src_path = _norm_workspace_path(src)
    dest_path = _norm_workspace_path(dest)
    st = _js_stat(src_path)
    if not st:
        return _workspace_cli_result(ok=False, src=src_path, dest=dest_path, error='source not found')
    parent = posixpath.dirname(dest_path) or '/'
    if mkdir and not _patched_exists(parent):
        _patched_makedirs(parent, exist_ok=True)
    if st['type'] == 'dir':
        if not _patched_exists(dest_path):
            _patched_makedirs(dest_path, exist_ok=True)
        for name in _patched_listdir(src_path):
            child_src = posixpath.join(src_path, name) if src_path != '/' else '/' + name
            child_dest = posixpath.join(dest_path, name) if dest_path != '/' else '/' + name
            _workspace_cli_copy(child_src, child_dest, mkdir=True)
        return _workspace_cli_result(ok=True, src=src_path, dest=dest_path, type='dir')
    if st.get('binary'):
        _js_write_bytes(dest_path, _js_read_bytes(src_path))
    else:
        _js_write_text(dest_path, _js_read_text(src_path))
    return _workspace_cli_result(ok=True, src=src_path, dest=dest_path, type='file')


def _workspace_cli_move(src, dest, mkdir=False):
    result = _workspace_cli_copy(src, dest, mkdir=mkdir)
    if result.get('ok'):
        _workspace_cli_remove(src, recursive=True)
    return result


def _workspace_cli_run(command, **kwargs):
    cmd = str(command or '').strip().lower().replace('-', '_')
    if cmd == 'read':
        return _workspace_cli_read(kwargs.get('path'), binary=bool(kwargs.get('binary')))
    if cmd == 'write':
        return _workspace_cli_write(kwargs.get('path'), content=kwargs.get('content'), binary=bool(kwargs.get('binary')), bytes_data=kwargs.get('bytes'), mkdir=bool(kwargs.get('mkdir')))
    if cmd == 'listdir':
        return _workspace_cli_listdir(kwargs.get('path', '/'), recursive=bool(kwargs.get('recursive')))
    if cmd == 'glob':
        return _workspace_cli_glob(kwargs.get('pattern', ''))
    if cmd == 'stat':
        return _workspace_cli_stat(kwargs.get('path'))
    if cmd == 'mkdir':
        return _workspace_cli_mkdir(kwargs.get('path'), parents=kwargs.get('parents', True), exist_ok=kwargs.get('exist_ok', True))
    if cmd == 'remove':
        return _workspace_cli_remove(kwargs.get('path'), recursive=bool(kwargs.get('recursive')))
    if cmd == 'copy':
        return _workspace_cli_copy(kwargs.get('src'), kwargs.get('dest'), mkdir=bool(kwargs.get('mkdir')))
    if cmd == 'move':
        return _workspace_cli_move(kwargs.get('src'), kwargs.get('dest'), mkdir=bool(kwargs.get('mkdir')))
    raise ValueError(f'Unsupported workspace_cli command: {command}')


workspace_cli.run = _workspace_cli_run
workspace_cli.read = _workspace_cli_read
workspace_cli.write = _workspace_cli_write
workspace_cli.listdir = _workspace_cli_listdir
workspace_cli.glob = _workspace_cli_glob
workspace_cli.stat = _workspace_cli_stat
workspace_cli.mkdir = _workspace_cli_mkdir
workspace_cli.remove = _workspace_cli_remove
workspace_cli.copy = _workspace_cli_copy
workspace_cli.move = _workspace_cli_move
sys.modules['workspace_cli'] = workspace_cli

builtins.open = _patched_open
os.getcwd = _patched_getcwd
os.chdir = _patched_chdir
os.path.exists = _patched_exists
os.path.isfile = _patched_isfile
os.path.isdir = _patched_isdir
os.listdir = _patched_listdir
os.mkdir = _patched_mkdir
os.makedirs = _patched_makedirs
os.remove = _patched_remove
os.unlink = _patched_unlink
os.rmdir = _patched_rmdir
os.stat = _patched_stat
_glob.glob = _patched_glob
_glob.iglob = _patched_iglob
pathlib.Path = WorkspacePath
`);

    if (!vfsResolve('/__internal__/workspace_cli.py')) {
      vfsWrite('/__internal__/workspace_cli.py', String.raw`import json
import sys

import workspace_cli


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(json.dumps({"ok": False, "error": "missing command"}, ensure_ascii=False))
        return 1
    command = argv.pop(0)
    payload = {}
    if argv:
        try:
            payload = json.loads(argv[0]) if argv[0] else {}
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"invalid json payload: {e}"}, ensure_ascii=False))
            return 1
    try:
        result = workspace_cli.run(command, **payload)
    except Exception as e:
        print(json.dumps({"ok": False, "command": command, "error": str(e)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`, true);
    }

    try {
      await pyodide.runPythonAsync(code);
    } catch (pyErr) {
      const stderr = pyodide.runPython('sys.stderr.getvalue()');
      pyodide.runPython(`
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
builtins.open = _orig_open
os.getcwd = _orig_getcwd
os.chdir = _orig_chdir
os.path.exists = _orig_exists
os.path.isfile = _orig_isfile
os.path.isdir = _orig_isdir
os.listdir = _orig_listdir
os.mkdir = _orig_mkdir
os.makedirs = _orig_makedirs
os.remove = _orig_remove
os.unlink = _orig_unlink
os.rmdir = _orig_rmdir
os.stat = _orig_stat
_glob.glob = _orig_glob
_glob.iglob = _orig_iglob
pathlib.Path = _orig_path_class
`);
      const detail = `${pyErr.message}${stderr ? '\nstderr: ' + stderr : ''}`;
      return `Error:\n${detail}${getPythonNativePathHint(detail)}`;
    }

    const stdout = pyodide.runPython('sys.stdout.getvalue()');
    const stderr = pyodide.runPython('sys.stderr.getvalue()');
    pyodide.runPython(`
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
builtins.open = _orig_open
os.getcwd = _orig_getcwd
os.chdir = _orig_chdir
os.path.exists = _orig_exists
os.path.isfile = _orig_isfile
os.path.isdir = _orig_isdir
os.listdir = _orig_listdir
os.mkdir = _orig_mkdir
os.makedirs = _orig_makedirs
os.remove = _orig_remove
os.unlink = _orig_unlink
os.rmdir = _orig_rmdir
os.stat = _orig_stat
_glob.glob = _orig_glob
_glob.iglob = _orig_iglob
pathlib.Path = _orig_path_class
`);
    let result = stdout || '(no output)';
    if (stderr) result += '\nstderr: ' + stderr;
    return result;
  } catch (e) {
    const detail = `${e.message}`;
    return `PythonExec error: ${detail}. Try JSExec or a different approach.${getPythonNativePathHint(detail)}`;
  } finally {
    await _pyFlush();
  }
}


async function toolJSExec(input) {
  const code = input.code || '';
  const logs = [];
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.map(v => typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)).join(' ')),
      error: (...a) => logs.push('ERROR: ' + a.map(String).join(' ')),
      warn: (...a) => logs.push('WARN: ' + a.map(String).join(' ')),
      info: (...a) => logs.push(a.map(v => typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)).join(' ')),
    },
    vfsRead: (p) => { const r = vfsRead(p); return r.error ? r.error : r.content; },
    vfsWrite: (p, c) => { const r = vfsWrite(p, c); return r.error ? r.error : `Written ${r.bytes} bytes to ${r.path}`; },
    vfsReadBinary: async (p) => {
      const b = await vfsGetBinary(p);
      if (!b) throw new Error(`Binary file not found: ${p}`);
      return new Uint8Array(b);
    },
    vfsWriteBinary: async (p, bytes) => {
      const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const r = await vfsWriteBinary(p, arr);
      return r.error ? r.error : `Written ${r.bytes} bytes to ${r.path}`;
    },
    vfsStat: (p) => vfsStat(p),
    vfsGlob: (pat, base) => vfsGlob(pat, base),
    vfsGrep: (pat, base, inc) => vfsGrep(pat, base, inc),
    fetch: fetch.bind(window),
    JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    atob, btoa,
    setTimeout: undefined, setInterval: undefined, // blocked
  };
  try {
    const argNames = Object.keys(sandbox);
    const argValues = Object.values(sandbox);
    const fn = new Function(...argNames, `"use strict";\n${code}`);
    const result = fn(...argValues);
    // Handle async results (fetch, etc.)
    const resolved = result instanceof Promise ? await result : result;
    const output = logs.length ? logs.join('\n') : '';
    const retStr = resolved !== undefined ? (typeof resolved === 'object' ? JSON.stringify(resolved, null, 2) : String(resolved)) : '';
    return (output + (output && retStr ? '\n' : '') + retStr) || '(no output)';
  } catch (e) {
    const output = logs.length ? logs.join('\n') + '\n' : '';
    return `${output}Error: ${e.message}`;
  }
}

