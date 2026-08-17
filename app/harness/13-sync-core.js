/* creel harness — part 13 of 26: sync-core
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
 *   - CLOUD SYNC (S3-compatible): SigV4 signer + snapshot + UI
 */
// ═══════════════════════════════════════════════════════════════════
// CLOUD SYNC (S3-compatible): SigV4 signer + snapshot + UI
// ═══════════════════════════════════════════════════════════════════
const S3_SYNC_KEY = 'ba_s3_sync';
const S3_LAST_SYNC_KEY = 'ba_s3_last_sync';
const S3_LAST_PASS_HASH_KEY = 'ba_s3_last_pass_hash';
// v1 snapshot names (kept for backward-compat pull only)
const S3_V1_JSON = 'onepagent-snapshot.json';
const S3_V1_BIN = 'onepagent-snapshot.bin';
// v2 object layout: manifest at prefix root, content-addressed objects + blobs
const S3_MANIFEST_JSON = 'manifest.json';
const S3_MANIFEST_BIN = 'manifest.bin';
const S3_OBJ_DIR = 'objects/';
const S3_BLOB_DIR = 'blobs/';
const S3_POOL_CONCURRENCY = 4;
const _s3TE = new TextEncoder();
const _s3TD = new TextDecoder();

function _loadS3Cfg() {
  try { const s = localStorage.getItem(S3_SYNC_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
function _writeS3Cfg(cfg) {
  try { localStorage.setItem(S3_SYNC_KEY, JSON.stringify(cfg)); } catch {}
}
function _s3Configured(cfg) {
  const c = cfg || _loadS3Cfg();
  return !!(c && c.endpoint && c.bucket && c.accessKey && c.secretKey);
}
function _s3BytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
function _s3UriEncode(str, encodeSlash) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else {
      const bytes = _s3TE.encode(ch);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}
async function _s3Sha256Hex(data) {
  const buf = typeof data === 'string' ? _s3TE.encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return _s3BytesToHex(new Uint8Array(hash));
}
async function _s3Hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? _s3TE.encode(data) : data);
  return new Uint8Array(sig);
}
async function _s3SigningKey(secret, ymd, region) {
  let k = await _s3Hmac(_s3TE.encode('AWS4' + secret), ymd);
  k = await _s3Hmac(k, region);
  k = await _s3Hmac(k, 's3');
  return _s3Hmac(k, 'aws4_request');
}
function _s3AmzDate() {
  const d = new Date();
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function _s3BuildEndpoint(cfg) {
  // Returns { url, host } for the base — caller appends /bucket/key (path-style) or /key (virtual-host).
  const ep = (cfg.endpoint || '').replace(/\/+$/, '');
  const u = new URL(ep);
  const pathStyle = cfg.forcePathStyle !== false;
  if (pathStyle) return { origin: u.origin, host: u.host, pathPrefix: '/' + cfg.bucket };
  // Virtual-host: bucket.<host>
  return { origin: u.protocol + '//' + cfg.bucket + '.' + u.host, host: cfg.bucket + '.' + u.host, pathPrefix: '' };
}
async function _s3Request(cfg, method, keyPath, body, contentType) {
  // body: undefined|null for no body (GET/HEAD); otherwise Uint8Array
  const region = (cfg.region || 'us-east-1').trim();
  const { origin, host, pathPrefix } = _s3BuildEndpoint(cfg);
  const canonicalUri = _s3UriEncode(pathPrefix + '/' + keyPath.replace(/^\/+/, ''), false);
  const url = origin + canonicalUri;
  const amzDate = _s3AmzDate();
  const ymd = amzDate.slice(0, 8);
  const payloadBytes = body || new Uint8Array(0);
  const payloadHash = await _s3Sha256Hex(payloadBytes);

  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (body && contentType) headers['content-type'] = contentType;

  const signedHeaderNames = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map(h => `${h}:${String(headers[Object.keys(headers).find(k => k.toLowerCase() === h)]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${ymd}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await _s3Sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await _s3SigningKey(cfg.secretKey, ymd, region);
  const signature = _s3BytesToHex(await _s3Hmac(signingKey, stringToSign));

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const fetchOpts = { method, headers };
  if (body) fetchOpts.body = body;
  return fetch(url, fetchOpts);
}
function _s3Prefix(cfg) { return (cfg.prefix || 'onepagent/').replace(/^\/+|\/+$/g, ''); }
function _manifestKey(cfg) { const p = _s3Prefix(cfg); const n = cfg.passphrase ? S3_MANIFEST_BIN : S3_MANIFEST_JSON; return p ? p + '/' + n : n; }
function _objKey(cfg, hash) { const p = _s3Prefix(cfg); const n = S3_OBJ_DIR + hash + (cfg.passphrase ? '.bin' : '.json'); return p ? p + '/' + n : n; }
function _blobKey(cfg, hash) { const p = _s3Prefix(cfg); const n = S3_BLOB_DIR + hash; return p ? p + '/' + n : n; }
function _v1SnapshotKey(cfg, encrypted) { const p = _s3Prefix(cfg); const n = encrypted ? S3_V1_BIN : S3_V1_JSON; return p ? p + '/' + n : n; }
async function _s3Put(cfg, key, body, contentType) {
  const resp = await _s3Request(cfg, 'PUT', key, body, contentType);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`PUT failed: HTTP ${resp.status} ${_s3ErrHint(resp.status, text)}`);
  }
  return resp;
}
async function _s3Get(cfg, key) {
  const resp = await _s3Request(cfg, 'GET', key, null);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GET failed: HTTP ${resp.status} ${_s3ErrHint(resp.status, text)}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
async function _s3Head(cfg, key) {
  const resp = await _s3Request(cfg, 'HEAD', key, null);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HEAD failed: HTTP ${resp.status} ${_s3ErrHint(resp.status, text)}`);
  }
  return { lastModified: resp.headers.get('Last-Modified'), etag: resp.headers.get('ETag') };
}
/* ── Transport seam (creel-3ru) ───────────────────────────────────
 *
 * Everything below the manifest is already backend-agnostic: content-addressed
 * objects and blobs, hash dedup, an encryption envelope. Only getting bytes to
 * and from a remote was S3-shaped. These four functions are that seam, so a
 * second backend is a transport rather than a second sync engine.
 *
 * A backend is { get, put, head, commit }. `commit` exists because the two
 * remotes disagree about what a write IS: to S3 each PUT is final, while a git
 * remote wants one commit for the whole push — so `put` may stage and `commit`
 * flushes. S3's commit is a no-op; the GitHub backend's is the actual commit.
 */
function _syncCfg() {
  // The state repo wins when it is configured and selected — an operator who
  // set one up is telling us where their state lives.
  if (typeof CreelState !== 'undefined' && CreelState.isActive?.()) return CreelState.syncConfig();
  const cfg = _loadS3Cfg();
  return cfg ? { ...cfg, backend: 's3' } : null;
}
function _syncConfigured(cfg) {
  const c = cfg || _syncCfg();
  if (!c) return false;
  if (c.backend === 'github') return !!(typeof CreelState !== 'undefined' && CreelState.isConfigured());
  return _s3Configured(c);
}
function _syncBackend(cfg) {
  if (cfg && cfg.backend === 'github') return CreelState.transport(cfg);
  return {
    get: (key) => _s3Get(cfg, key),
    put: (key, body, contentType) => _s3Put(cfg, key, body, contentType),
    head: (key) => _s3Head(cfg, key),
    commit: async () => null,
  };
}
const _syncGet = (cfg, key) => _syncBackend(cfg).get(key);
const _syncPut = (cfg, key, body, ct) => _syncBackend(cfg).put(key, body, ct);
const _syncCommit = (cfg, message) => _syncBackend(cfg).commit(message);

function _s3ErrHint(status, text) {
  if (/RequestTimeTooSkewed/i.test(text)) return '\u2014 system clock is off by >15min; please sync it.';
  if (status === 403) return '\u2014 check access key / secret / bucket permissions.';
  if (status === 301 || status === 307) return '\u2014 wrong region for this bucket.';
  if (status === 404) return '\u2014 bucket or key not found.';
  return text ? '\u2014 ' + text.slice(0, 120) : '';
}

// ── Encryption (AES-256-GCM, PBKDF2-SHA256 key derivation) ────────
const _S3_MAGIC = new Uint8Array([0x4F, 0x50, 0x41, 0x31]); // 'OPA1'
const _S3_PBKDF2_ITER = 200000;
async function _s3DeriveKey(pass, salt) {
  const baseKey = await crypto.subtle.importKey('raw', _s3TE.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: _S3_PBKDF2_ITER, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function _s3EncryptBytes(plainBytes, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _s3DeriveKey(passphrase, salt);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes));
  const out = new Uint8Array(4 + 16 + 12 + cipher.length);
  out.set(_S3_MAGIC, 0);
  out.set(salt, 4);
  out.set(iv, 20);
  out.set(cipher, 32);
  return out;
}
async function _s3DecryptBytes(bytes, passphrase) {
  if (bytes.length < 32 || bytes[0] !== 0x4F || bytes[1] !== 0x50 || bytes[2] !== 0x41 || bytes[3] !== 0x31) {
    throw new Error('Not an OnePagent encrypted object (magic header missing).');
  }
  const salt = bytes.slice(4, 20);
  const iv = bytes.slice(20, 32);
  const cipher = bytes.slice(32);
  const key = await _s3DeriveKey(passphrase, salt);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher); }
  catch { throw new Error('Decryption failed \u2014 wrong passphrase?'); }
  return new Uint8Array(plain);
}
async function _s3Encrypt(jsonStr, passphrase) { return _s3EncryptBytes(_s3TE.encode(jsonStr), passphrase); }
async function _s3Decrypt(bytes, passphrase) { return _s3TD.decode(await _s3DecryptBytes(bytes, passphrase)); }
function _s3LooksEncrypted(bytes) {
  return bytes && bytes.length >= 4 && bytes[0] === 0x4F && bytes[1] === 0x50 && bytes[2] === 0x41 && bytes[3] === 0x31;
}

// ── Progress tracking (rendered in the sync menu) ─────────────────
let _s3Progress = null;
let _s3OpActive = false;
function _setProgress(phase, current, total, note) {
  if (phase == null) { _s3Progress = null; _s3OpActive = false; }
  else { _s3Progress = { phase, current: current || 0, total: Math.max(1, total || 1), note: note || '', ts: Date.now() }; _s3OpActive = true; }
  _renderProgress();
}
function _renderProgress() {
  const el = document.getElementById('syncProgress');
  if (!el) return;
  if (!_s3Progress) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const { phase, current, total, note } = _s3Progress;
  const pct = Math.min(100, Math.round(100 * current / total));
  el.style.display = 'block';
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-secondary);margin-bottom:3px">' +
    '<span>' + esc(phase) + '</span><span>' + current + '/' + total + ' \u00b7 ' + pct + '%</span></div>' +
    '<div style="background:var(--border);height:4px;border-radius:2px;overflow:hidden">' +
    '<div style="background:var(--accent-orange);height:100%;width:' + pct + '%;transition:width 0.15s"></div></div>' +
    (note ? '<div style="font-size:10px;color:var(--text-dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(note) + '</div>' : '');
  const m = document.getElementById('syncMenu');
  if (m && m.style.display !== 'block') { m.style.display = 'block'; }
  const pushBtn = document.getElementById('syncPushBtn');
  const pullBtn = document.getElementById('syncPullBtn');
  if (pushBtn) pushBtn.disabled = true;
  if (pullBtn) pullBtn.disabled = true;
  if (!_s3Progress) { if (pushBtn) pushBtn.disabled = false; if (pullBtn) pullBtn.disabled = false; }
}
function _clearProgress() {
  _s3Progress = null; _s3OpActive = false;
  const el = document.getElementById('syncProgress');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  const pushBtn = document.getElementById('syncPushBtn');
  const pullBtn = document.getElementById('syncPullBtn');
  if (pushBtn) pushBtn.disabled = false;
  if (pullBtn) pullBtn.disabled = false;
}

// ── Promise pool (bounded concurrency) ────────────────────────────
async function _s3Pool(items, worker, concurrency) {
  concurrency = concurrency || S3_POOL_CONCURRENCY;
  let idx = 0;
  const errors = [];
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try { await worker(items[i], i); }
      catch (e) { errors.push(e); throw e; }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) runners.push(run());
  await Promise.all(runners);
  if (errors.length) throw errors[0];
}

// ── Content-hash helpers ──────────────────────────────────────────
async function _hashBytes(bytes) { return _s3Sha256Hex(bytes); }
async function _hashString(str) { return _s3Sha256Hex(str); }

// ── Blob extraction / inlining ────────────────────────────────────
// Walks an object tree, replaces binary data (Uint8Array) with {$blob,size} refs,
// and collects bytes into the `blobs` Map<hash, Uint8Array>.
async function _extractBlobs(obj, blobs) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (obj instanceof Uint8Array) {
    const hash = await _hashBytes(obj);
    if (!blobs.has(hash)) blobs.set(hash, obj);
    return { $blob: hash, size: obj.length };
  }
  if (Array.isArray(obj)) {
    const out = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) out[i] = await _extractBlobs(obj[i], blobs);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = await _extractBlobs(v, blobs);
  return out;
}
// Reverse: replace every {$blob,size} ref with the corresponding Uint8Array from blobMap.
function _inlineBlobs(obj, blobMap) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (typeof obj.$blob === 'string') {
    const b = blobMap.get(obj.$blob);
    if (!b) throw new Error('Missing blob ' + obj.$blob.slice(0, 12));
    return b;
  }
  if (Array.isArray(obj)) return obj.map(v => _inlineBlobs(v, blobMap));
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = _inlineBlobs(v, blobMap);
  return out;
}
// Walk object and collect all referenced blob hashes.
function _collectBlobRefs(obj, set) {
  if (obj == null || typeof obj !== 'object') return;
  if (typeof obj.$blob === 'string') { set.add(obj.$blob); return; }
  if (Array.isArray(obj)) { for (const x of obj) _collectBlobRefs(x, set); return; }
  for (const v of Object.values(obj)) _collectBlobRefs(v, set);
}

// Transform a hash-backed vfs tree into the wire format: binary file nodes'
// {hash,size} fields become {bytes:{$blob,size}} refs. Collects each hash into
// hashSet so the push step knows what's referenced.
function _vfsToWireRefs(node, hashSet) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(x => _vfsToWireRefs(x, hashSet));
  if (node.type === 'file' && node.binary && typeof node.hash === 'string') {
    hashSet.add(node.hash);
    const { hash, size, bytes, ...rest } = node;
    return { ...rest, bytes: { $blob: hash, size: size ?? 0 } };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = _vfsToWireRefs(v, hashSet);
  return out;
}

// ── Manifest / object / blob transport (encrypted when cfg.passphrase is set) ──
async function _getManifest(cfg) {
  // Try the preferred key first (based on current passphrase), fall back to the other.
  const keys = cfg.passphrase ? [_manifestKey(cfg), _manifestKey({ ...cfg, passphrase: '' })]
                              : [_manifestKey(cfg), _manifestKey({ ...cfg, passphrase: 'x' })];
  for (const k of keys) {
    const bytes = await _syncGet(cfg, k);
    if (!bytes) continue;
    let jsonStr;
    if (_s3LooksEncrypted(bytes)) {
      if (!cfg.passphrase) throw new Error('Remote manifest is encrypted \u2014 passphrase required.');
      jsonStr = await _s3Decrypt(bytes, cfg.passphrase);
    } else {
      jsonStr = _s3TD.decode(bytes);
    }
    return JSON.parse(jsonStr);
  }
  return null;
}
async function _putManifest(cfg, manifest) {
  const jsonStr = JSON.stringify(manifest);
  const body = cfg.passphrase ? await _s3Encrypt(jsonStr, cfg.passphrase) : _s3TE.encode(jsonStr);
  const contentType = cfg.passphrase ? 'application/octet-stream' : 'application/json';
  await _syncPut(cfg, _manifestKey(cfg), body, contentType);
}
async function _putJsonObject(cfg, hash, jsonStr) {
  const body = cfg.passphrase ? await _s3Encrypt(jsonStr, cfg.passphrase) : _s3TE.encode(jsonStr);
  const contentType = cfg.passphrase ? 'application/octet-stream' : 'application/json';
  await _syncPut(cfg, _objKey(cfg, hash), body, contentType);
}
async function _getJsonObject(cfg, hash) {
  const bytes = await _syncGet(cfg, _objKey(cfg, hash));
  if (!bytes) return null;
  const jsonStr = _s3LooksEncrypted(bytes) ? await _s3Decrypt(bytes, cfg.passphrase) : _s3TD.decode(bytes);
  return JSON.parse(jsonStr);
}
async function _putBlob(cfg, hash, bytes) {
  const body = cfg.passphrase ? await _s3EncryptBytes(bytes, cfg.passphrase) : bytes;
  await _syncPut(cfg, _blobKey(cfg, hash), body, 'application/octet-stream');
}
async function _getBlob(cfg, hash) {
  const bytes = await _syncGet(cfg, _blobKey(cfg, hash));
  if (!bytes) return null;
  return _s3LooksEncrypted(bytes) ? _s3DecryptBytes(bytes, cfg.passphrase) : bytes;
}

// ── Build local state for v2 sync ─────────────────────────────────
// Returns { manifest, objects: Map<hash,jsonStr>, blobs: Map<hash,Uint8Array> }.
/* Whether this sync may carry credentials.
 *
 * Two conditions, both required, neither inferable. The operator must have
 * asked for it (a key leaving the browser is a decision, never a default), and
 * a passphrase must be set (the destination is a repo — private today, one
 * settings change from not). Absent either, keys stay local and everything
 * else still syncs; that is the S3 behaviour and it remains the default. */
function _syncCarriesSecrets(cfg) {
  const c = cfg || _syncCfg();
  return !!(c && c.includeSecrets && c.passphrase);
}

function _syncSafeProviders(cfg) {
  const raw = _loadProviders();
  const out = { providers: {} };
  const providers = raw?.providers || {};
  const withKeys = _syncCarriesSecrets(cfg);
  for (const [id, p] of Object.entries(providers)) {
    const { apiKey, ...safe } = p || {};
    out.providers[id] = withKeys && apiKey ? { ...safe, apiKey } : safe;
  }
  return out;
}
function _applySyncedProviders(incoming) {
  if (!incoming?.providers || typeof incoming.providers !== 'object') return;
  const local = getProvidersMap();
  const merged = { providers: {} };
  for (const [id, p] of Object.entries(incoming.providers)) {
    // The local key wins when there is one: a machine that already works must
    // not be broken by a pull carrying an older or rotated key. A synced key
    // only fills a slot that is empty — which is the case this feature exists
    // for, a fresh browser adopting the operator's setup.
    merged.providers[id] = { ...(p || {}), apiKey: local[id]?.apiKey || (p && p.apiKey) || '' };
  }
  for (const [id, p] of Object.entries(local)) {
    if (!merged.providers[id]) merged.providers[id] = p;
  }
  _saveProviders(merged);
}
async function _buildLocalState() {
  const cfg = _syncCfg() || {};
  const convMeta = (await loadConvMetaFromDB()) || [];
  const convFolderEntries = await loadConvFoldersFromDB();
  const objects = new Map();
  const blobs = new Map();
  const _vfsHashRefs = new Set();

  const convEntries = [];
  for (const c of convMeta) {
    const d = await loadConvDataFromDB(c.id);
    if (!d) continue;
    // Binary file nodes now carry {hash,size}; convert to wire refs and mark
    // each hash for upload. _extractBlobs is still called afterwards to catch
    // any legacy Uint8Array leaves from pre-migration records.
    const vfsWire = _vfsToWireRefs(d.vfs, _vfsHashRefs);
    const vfsRefs = await _extractBlobs(vfsWire, blobs);
    const convObj = { ...d, vfs: vfsRefs };
    const jsonStr = JSON.stringify(convObj);
    const hash = await _hashString(jsonStr);
    objects.set(hash, jsonStr);
    convEntries.push({
      id: c.id, title: c.title, created: c.created, updated: c.updated,
      loopCount: c.loopCount, totalTokens: c.totalTokens, contextTokens: c.contextTokens,
      messageCount: c.messageCount, folderId: c.folderId, hash
    });
  }
  // Register vfs hashes into the blobs Map so the upload step sees them; bytes
  // stay null and are pulled from blobStore.get() lazily during upload.
  for (const h of _vfsHashRefs) {
    if (!blobs.has(h)) blobs.set(h, null);
  }

  const skillEntries = [];
  for (const s of skills) {
    const payload = await loadSkillFilesFromDB(s.name);
    // Skill binaryFiles are plain number arrays in storage; convert to Uint8Array for content-addressing.
    const bfRefs = {};
    for (const [fn, arr] of Object.entries(payload.binaryFiles || {})) {
      const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
      const hash = await _hashBytes(bytes);
      if (!blobs.has(hash)) blobs.set(hash, bytes);
      bfRefs[fn] = { $blob: hash, size: bytes.length };
    }
    const { files, binaryFiles, ...meta } = s;
    const skillObj = { metadata: meta, files: payload.files || {}, binaryFiles: bfRefs };
    const jsonStr = JSON.stringify(skillObj);
    const hash = await _hashString(jsonStr);
    objects.set(hash, jsonStr);
    skillEntries.push({ name: s.name, hash });
  }

  const baseSettings = { ...(loadSettings() || {}) };
  if (!_syncCarriesSecrets(cfg)) {
    delete baseSettings.api_key;
    delete baseSettings.tavily_api_key;
  }
  const settingsObj = {
    settings: baseSettings,
    providers: _syncSafeProviders(cfg),
    activeProviderId: getActiveProviderId(),
    mcpTools: Array.isArray(mcpTools) ? mcpTools.filter(t => !t.serverId) : [],
    mcpServers: Array.isArray(mcpServers) ? mcpServers.map(s => ({ id: s.id, name: s.name, type: s.type, url: s.url, token: s.token, enabled: s.enabled !== false, corsProxy: s.corsProxy || '' })) : [],
    mcpCorsProxy,
    disabledTools: disabledTools instanceof Set ? [...disabledTools] : [],
    hooks: Array.isArray(hooks) ? hooks : [],
    swarmRoles: Array.isArray(userSwarmRoles) ? userSwarmRoles : [],
    // v4: agent-tier roles only sync in global persistence mode (per-conv lives in conv records).
    swarmAgentRoles: (swarmSettings.agentRolesPersist && !swarmSettings.agentRolesPerConv && Array.isArray(agentSwarmRoles)) ? agentSwarmRoles : [],
    wsConfig: { ...(wsConfig || {}) },
    theme: localStorage.getItem('ba_theme') || 'dark',
    language: CURRENT_LANG,
    thinkLevel: THINK_LEVEL,
    mediaMode: MEDIA_MODE,
    mediaModels: { ...(MEDIA_MODELS || {}) },
    marketplaceRegistry: localStorage.getItem('ba_mp_registry') || '',
    selectedModel: localStorage.getItem('ba_selected_model') || '',
    activeConvId: activeConvId || ''
  };
  const settingsJson = JSON.stringify(settingsObj);
  const settingsHash = await _hashString(settingsJson);
  objects.set(settingsHash, settingsJson);

  // Long-term memory: one content-hashed JSON blob with all records.
  let memoriesEntry = null;
  try {
    const allMems = await memListAll();
    if (allMems && allMems.length) {
      const memsJson = JSON.stringify({ memories: allMems });
      const memsHash = await _hashString(memsJson);
      objects.set(memsHash, memsJson);
      memoriesEntry = { hash: memsHash, count: allMems.length };
    }
  } catch (e) { console.warn('memory sync build failed', e); }

  // The quipu store, as the same .db bytes the CLI and quipu-server open.
  // Only when the graph is already booted in this tab: pushing state is not a
  // reason to spin up a wasm runtime the operator never asked for, and a tab
  // that never touched the graph has nothing of its own to contribute.
  let quipuEntry = null;
  try {
    if (typeof CreelQuipu !== 'undefined' && typeof CreelQuipu.exportDb === 'function') {
      const raw = await CreelQuipu.exportDb();
      const bytes = raw instanceof Uint8Array ? raw : (raw ? new Uint8Array(raw) : null);
      if (bytes && bytes.length) {
        const quipuHash = await _hashBytes(bytes);
        if (!blobs.has(quipuHash)) blobs.set(quipuHash, bytes);
        quipuEntry = { hash: quipuHash, size: bytes.length };
      }
    }
  } catch (e) { console.warn('quipu state sync build failed', e); }

  const manifest = {
    version: 2,
    updatedAt: Date.now(),
    encrypted: !!cfg.passphrase,
    conversations: convEntries,
    conversationFolders: convFolderEntries,
    skills: skillEntries,
    settings: { hash: settingsHash },
    memories: memoriesEntry,
    quipu: quipuEntry,
    blobs: [...blobs.keys()].sort()
  };
  return { manifest, objects, blobs };
}

// ── Apply a pulled remote state to local storage ──────────────────
// Transform a wire-format vfs tree back into a hash-backed tree. For each
// binary file node with a {bytes: {$blob,size}} ref, stashes the bytes into
// the local blob store (incrementing refcount once per vfs reference) and
// rewrites the node with top-level {hash,size} fields.
async function _vfsFromWireRefs(node, blobMap) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    const out = new Array(node.length);
    for (let i = 0; i < node.length; i++) out[i] = await _vfsFromWireRefs(node[i], blobMap);
    return out;
  }
  if (node.type === 'file' && node.binary && node.bytes && typeof node.bytes.$blob === 'string') {
    const hash = node.bytes.$blob;
    const size = node.bytes.size ?? 0;
    const bytes = blobMap.get(hash);
    if (bytes) await blobStore.putWithHash(hash, bytes);
    const { bytes: _drop, ...rest } = node;
    return { ...rest, hash, size };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = await _vfsFromWireRefs(v, blobMap);
  return out;
}

async function _applyRemoteState(remote, objs, blobMap) {
  // 1. Settings (preserve local LLM / Tavily keys).
  if (remote.settings?.hash) {
    const s = objs.get(remote.settings.hash);
    if (s) {
      const local = loadSettings() || {};
      const merged = { ...(s.settings || {}) };
      if (local.api_key) merged.api_key = local.api_key;
      if (local.tavily_api_key) merged.tavily_api_key = local.tavily_api_key;
      saveSettingsToStorage(merged);
      _applySyncedProviders(s.providers);
      if (s.activeProviderId) setActiveProviderId(s.activeProviderId);
      if (Array.isArray(s.mcpTools)) {
        const serverSourced = mcpTools.filter(t => t.serverId);
        mcpTools = s.mcpTools.filter(t => !t.serverId).concat(serverSourced);
        try { localStorage.setItem('ba_mcp_tools', JSON.stringify(mcpTools.filter(t => !t.serverId))); } catch {}
      }
      if (typeof s.mcpCorsProxy === 'string') {
        mcpCorsProxy = s.mcpCorsProxy;
        saveMcpCorsProxy();
      }
      if (Array.isArray(s.mcpServers)) {
        // Disconnect any servers not present in the pull.
        const keepIds = new Set(s.mcpServers.map(x => x.id));
        for (const srv of mcpServers.slice()) {
          if (!keepIds.has(srv.id)) { await mcpDisconnectServer(srv); _mcpRuntime.delete(srv.id); }
        }
        mcpServers = s.mcpServers.slice();
        saveMcpServers();
        // Auto-connect fresh set in the background.
        initAllMcpServers().catch(() => {});
      }
      if (Array.isArray(s.disabledTools)) {
        disabledTools = new Set(s.disabledTools);
        try { localStorage.setItem('ba_disabled_tools', JSON.stringify([...disabledTools])); } catch {}
      }
      if (Array.isArray(s.hooks)) {
        hooks = s.hooks;
        saveHooks();
      }
      if (Array.isArray(s.swarmRoles)) {
        userSwarmRoles = s.swarmRoles;
        saveUserSwarmRoles();
        if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
      }
      // v4: agent-tier roles only round-trip via cloud sync in global mode.
      if (Array.isArray(s.swarmAgentRoles) && swarmSettings.agentRolesPersist && !swarmSettings.agentRolesPerConv) {
        agentSwarmRoles = s.swarmAgentRoles;
        saveAgentSwarmRoles();
        if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
      }
      if (s.wsConfig) {
        Object.assign(wsConfig, s.wsConfig);
        try { localStorage.setItem('ba_ws_config', JSON.stringify(wsConfig)); } catch {}
      }
      if (s.theme) try { localStorage.setItem('ba_theme', s.theme); } catch {}
      if (s.language === 'zh' || s.language === 'en') try { localStorage.setItem(I18N_KEY, s.language); CURRENT_LANG = s.language; } catch {}
      {
        const tl = normalizeThinkLevel(s.thinkLevel);
        if (tl) try { localStorage.setItem(THINK_KEY, tl); THINK_LEVEL = tl; } catch {}
      }
      if (MEDIA_GENERATION_MODES.has(s.mediaMode)) try { localStorage.setItem(MEDIA_MODE_KEY, s.mediaMode); MEDIA_MODE = s.mediaMode; } catch {}
      if (s.mediaModels && typeof s.mediaModels === 'object') try { localStorage.setItem(MEDIA_MODEL_KEY, JSON.stringify(s.mediaModels)); MEDIA_MODELS = { ...s.mediaModels }; } catch {}
      if (typeof s.marketplaceRegistry === 'string' && s.marketplaceRegistry) try { localStorage.setItem('ba_mp_registry', s.marketplaceRegistry); } catch {}
      if (s.selectedModel) try { localStorage.setItem('ba_selected_model', s.selectedModel); } catch {}
      if (s.activeConvId) try { localStorage.setItem('ba_active_conv', s.activeConvId); } catch {}
      ACTIVE_PROVIDER = getActiveProviderProfile();
      PROVIDER = (ACTIVE_PROVIDER && ACTIVE_PROVIDER.type) ? ACTIVE_PROVIDER.type : PROVIDER;
      API_MODEL = localStorage.getItem('ba_selected_model') || (ACTIVE_PROVIDER && ACTIVE_PROVIDER.defaultModel) || API_MODEL;
    }
  }

  // 2. Conversations — strip hash from meta before persisting.
  const convMeta = (remote.conversations || []).map(c => {
    const { hash, ...rest } = c;
    return rest;
  });
  await saveConvMetaToDB(convMeta);
  if (Array.isArray(remote.conversationFolders)) {
    convFolders = remote.conversationFolders;
    await saveConvFoldersToDB();
  }
  for (const c of (remote.conversations || [])) {
    const obj = objs.get(c.hash);
    if (!obj) continue;
    // Push binary bytes into the local blob store; the saved record keeps only
    // {hash,size} on binary nodes so IDB rows stay small.
    const vfsRestored = await _vfsFromWireRefs(obj.vfs, blobMap);
    await saveConvDataToDB(c.id, { ...obj, vfs: vfsRestored });
  }

  // 3. Skills — metadata to localStorage (without files), files+binaryFiles to IDB.
  const skillsMeta = [];
  for (const s of (remote.skills || [])) {
    const obj = objs.get(s.hash);
    if (!obj) continue;
    skillsMeta.push(obj.metadata || { name: s.name });
    const bfNumArrays = {};
    for (const [fn, ref] of Object.entries(obj.binaryFiles || {})) {
      if (ref && typeof ref === 'object' && ref.$blob && blobMap.has(ref.$blob)) {
        bfNumArrays[fn] = Array.from(blobMap.get(ref.$blob));
      }
    }
    await saveSkillFilesToDB(s.name, { files: obj.files || {}, binaryFiles: bfNumArrays });
  }
  try { localStorage.setItem('ba_skills', JSON.stringify(skillsMeta)); } catch {}

  // 3b. Long-term memory — merge on id, prefer higher updatedAt.
  if (remote.memories?.hash) {
    const memObj = objs.get(remote.memories.hash);
    const incoming = Array.isArray(memObj?.memories) ? memObj.memories : [];
    if (incoming.length) {
      try {
        for (const m of incoming) {
          if (!m || !m.id || typeof m.content !== 'string') continue;
          await _memMergeIncoming(m);
        }
      } catch (e) { console.warn('memory sync apply failed', e); }
    }
  }

  // 3c. The quipu store — replace the local graph with the pulled one.
  //
  // Wholesale, like every other section of a pull: the .db is one artefact and
  // there is no merge for a bitemporal graph that would not silently invent
  // history. Only when the graph is booted in this tab — a tab that never
  // opened the store has nothing to replace, and booting one mid-pull to
  // overwrite it immediately helps nobody.
  if (remote.quipu?.hash) {
    const bytes = blobMap.get(remote.quipu.hash);
    if (bytes && typeof CreelQuipu !== 'undefined' && typeof CreelQuipu.importDb === 'function') {
      try {
        await CreelQuipu.importDb(bytes);
      } catch (e) {
        console.warn('quipu state apply failed', e);
        appendSystemMsg('Pull: the knowledge graph could not be restored — ' + (e?.message || e));
      }
    }
  }

  // 4. Reload in-memory UI state from the freshly-written stores.
  skills = [];
  await loadSkills();
  await loadConvHistory();
  if (typeof renderToolsGrid === 'function') renderToolsGrid();
  if (typeof updateWsStatus === 'function') updateWsStatus();
  applyModelContextLimit();
  // React to pulled memory settings (enabled flag, pulled records).
  if (typeof renderMemoryButton === 'function') renderMemoryButton();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  if (document.getElementById('memoryModal')?.classList.contains('show') && typeof renderMemoryList === 'function') renderMemoryList();
}

// ── v1 legacy pull (single-blob snapshot from before the v2 split) ─
async function _tryPullV1(cfg) {
  const keys = cfg.passphrase
    ? [_v1SnapshotKey(cfg, true), _v1SnapshotKey(cfg, false)]
    : [_v1SnapshotKey(cfg, false), _v1SnapshotKey(cfg, true)];
  for (const k of keys) {
    const bytes = await _syncGet(cfg, k);
    if (!bytes) continue;
    const jsonStr = _s3LooksEncrypted(bytes) ? await _s3Decrypt(bytes, cfg.passphrase) : _s3TD.decode(bytes);
    return JSON.parse(jsonStr);
  }
  return null;
}
async function _applyV1Snapshot(snap) {
  if (!snap || snap.version !== 1) throw new Error('Unsupported v1 snapshot');
  const local = loadSettings() || {};
  const merged = { ...(snap.settings || {}) };
  if (local.api_key) merged.api_key = local.api_key;
  if (local.tavily_api_key) merged.tavily_api_key = local.tavily_api_key;
  saveSettingsToStorage(merged);
  const convMeta = snap.conversations?.meta || [];
  const convData = snap.conversations?.data || {};
  await saveConvMetaToDB(convMeta);
  if (Array.isArray(snap.conversations?.folders)) {
    convFolders = snap.conversations.folders;
    await saveConvFoldersToDB();
  }
  for (const c of convMeta) { if (convData[c.id]) await saveConvDataToDB(c.id, convData[c.id]); }
  const sMeta = snap.skills?.metadata || [];
  const sFiles = snap.skills?.files || {};
  try { localStorage.setItem('ba_skills', JSON.stringify(sMeta)); } catch {}
  for (const s of sMeta) { await saveSkillFilesToDB(s.name, sFiles[s.name] || { files: {}, binaryFiles: {} }); }
  if (Array.isArray(snap.mcpTools)) {
    const serverSourced = mcpTools.filter(t => t.serverId);
    mcpTools = snap.mcpTools.filter(t => !t.serverId).concat(serverSourced);
    try { localStorage.setItem('ba_mcp_tools', JSON.stringify(mcpTools.filter(t => !t.serverId))); } catch {}
  }
  if (Array.isArray(snap.mcpServers)) {
    const keepIds = new Set(snap.mcpServers.map(x => x.id));
    for (const srv of mcpServers.slice()) {
      if (!keepIds.has(srv.id)) { await mcpDisconnectServer(srv); _mcpRuntime.delete(srv.id); }
    }
    mcpServers = snap.mcpServers.slice();
    saveMcpServers();
    initAllMcpServers().catch(() => {});
  }
  if (Array.isArray(snap.disabledTools)) { disabledTools = new Set(snap.disabledTools); try { localStorage.setItem('ba_disabled_tools', JSON.stringify([...disabledTools])); } catch {} }
  if (snap.wsConfig) { Object.assign(wsConfig, snap.wsConfig); try { localStorage.setItem('ba_ws_config', JSON.stringify(wsConfig)); } catch {} }
  if (snap.theme) try { localStorage.setItem('ba_theme', snap.theme); } catch {}
  if (snap.selectedModel) try { localStorage.setItem('ba_selected_model', snap.selectedModel); } catch {}
  skills = [];
  await loadSkills();
  await loadConvHistory();
  if (typeof renderToolsGrid === 'function') renderToolsGrid();
  if (typeof updateWsStatus === 'function') updateWsStatus();
  applyModelContextLimit();
  // React to pulled memory settings (enabled flag, pulled records).
  if (typeof renderMemoryButton === 'function') renderMemoryButton();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  if (document.getElementById('memoryModal')?.classList.contains('show') && typeof renderMemoryList === 'function') renderMemoryList();
}

