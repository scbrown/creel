/* creel harness — part 14 of 26: sync-push-pull
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
 *   - PLAN MODE — writes blocked; model plans first, user approves via ExitPlanMode
 *   - VIRTUAL FILESYSTEM
 */
// ── Push (v2 incremental, hash-dedup, progress) ───────────────────
async function pushSnapshotToS3(silent) {
  const cfg = _syncCfg();
  if (!_syncConfigured(cfg)) throw new Error('State sync not configured \u2014 open Settings.');
  // Start from a fresh view of the remote: a staging transport left over from
  // the previous operation would answer reads from a repo state that has since
  // moved, and stage writes onto a base tree that is no longer the head.
  if (cfg.backend === 'github') CreelState.reset();
  if (_s3OpActive) throw new Error('A sync operation is already in progress.');
  _s3PushInFlight = true;
  try {
    _setProgress('Preparing', 0, 1, 'Persisting current conversation...');
    if (activeConvId) try { await saveCurrentConv(false); } catch {}

    _setProgress('Scanning local state', 0, 1, 'Hashing conversations, skills, blobs...');
    const { manifest, objects, blobs } = await _buildLocalState();

    _setProgress('Checking remote', 0, 1, 'Fetching current manifest...');
    const remote = await _getManifest(cfg).catch(() => null);

    // If passphrase changed since last successful push, force re-upload of everything.
    const passHash = cfg.passphrase ? await _hashString(cfg.passphrase) : '';
    const lastPassHash = localStorage.getItem(S3_LAST_PASS_HASH_KEY) || '';
    const passChanged = passHash !== lastPassHash;

    const remoteObjHashes = new Set();
    const remoteBlobHashes = new Set();
    if (remote && remote.version === 2 && !passChanged) {
      for (const c of remote.conversations || []) remoteObjHashes.add(c.hash);
      for (const s of remote.skills || []) remoteObjHashes.add(s.hash);
      if (remote.settings?.hash) remoteObjHashes.add(remote.settings.hash);
      if (remote.memories?.hash) remoteObjHashes.add(remote.memories.hash);
      for (const h of remote.blobs || []) remoteBlobHashes.add(h);
    }

    const blobsToUpload = [...blobs.keys()].filter(h => !remoteBlobHashes.has(h));
    const objectsToUpload = [...objects.keys()].filter(h => !remoteObjHashes.has(h));

    let newBytes = 0;
    if (blobsToUpload.length) {
      _setProgress('Uploading blobs', 0, blobsToUpload.length, '');
      let done = 0;
      await _s3Pool(blobsToUpload, async (h) => {
        // vfs-referenced hashes are registered with null values; fetch their
        // bytes lazily from the content-addressed blob store at upload time.
        let bytes = blobs.get(h);
        if (!bytes) {
          bytes = await blobStore.get(h);
          if (!bytes) { done++; return; }
          blobs.set(h, bytes);
        }
        await _putBlob(cfg, h, bytes);
        newBytes += bytes.length;
        done++;
        _setProgress('Uploading blobs', done, blobsToUpload.length, h.slice(0, 12) + '\u2026 (' + (bytes.length / 1024).toFixed(1) + ' KB)');
      });
    }
    if (objectsToUpload.length) {
      _setProgress('Uploading objects', 0, objectsToUpload.length, '');
      let done = 0;
      await _s3Pool(objectsToUpload, async (h) => {
        const json = objects.get(h);
        await _putJsonObject(cfg, h, json);
        newBytes += json.length;
        done++;
        _setProgress('Uploading objects', done, objectsToUpload.length, h.slice(0, 12) + '\u2026');
      });
    }

    _setProgress('Updating manifest', 0, 1, '');
    await _putManifest(cfg, manifest);
    // One push, one remote write: backends that stage (the state repo) flush
    // here, so the history reads as one entry per push rather than one per
    // object. S3 has already written and does nothing.
    _setProgress('Committing', 0, 1, '');
    const committed = await _syncCommit(cfg,
      `creel state: ${objectsToUpload.length} object(s), ${blobsToUpload.length} blob(s)`);
    _setProgress('Committing', 1, 1, committed ? String(committed).slice(0, 12) : '');

    markStateClean();
    try { localStorage.setItem(S3_LAST_PASS_HASH_KEY, passHash); } catch {}
    _updateSyncStatus();
    const totalObjs = objects.size, totalBlobs = blobs.size;
    const kb = (newBytes / 1024).toFixed(1);
    if (!silent) appendSystemMsg(
      'Push: ' + objectsToUpload.length + '/' + totalObjs + ' object(s), '
      + blobsToUpload.length + '/' + totalBlobs + ' blob(s) uploaded, '
      + kb + ' KB new'
      + (cfg.passphrase ? ' \u2014 encrypted' : '')
      + ((!objectsToUpload.length && !blobsToUpload.length) ? ' \u2014 already up to date' : '')
      + '.'
    );
    _clearProgress();
    return manifest;
  } catch (e) {
    _clearProgress();
    throw e;
  } finally {
    _s3PushInFlight = false;
  }
}

// ── Pull (v2 incremental, hash-dedup, progress; v1 fallback) ──────
async function pullSnapshotFromS3() {
  const cfg = _syncCfg();
  if (!_syncConfigured(cfg)) throw new Error('State sync not configured \u2014 open Settings.');
  // Start from a fresh view of the remote: a staging transport left over from
  // the previous operation would answer reads from a repo state that has since
  // moved, and stage writes onto a base tree that is no longer the head.
  if (cfg.backend === 'github') CreelState.reset();
  if (_s3OpActive) throw new Error('A sync operation is already in progress.');
  try {
    _setProgress('Fetching manifest', 0, 1, '');
    const remote = await _getManifest(cfg);

    // v1 legacy fallback — migrate on the fly.
    if (!remote) {
      _setProgress('Fetching manifest', 0, 1, 'v2 manifest not found, trying v1 snapshot...');
      const v1 = await _tryPullV1(cfg);
      if (!v1) throw new Error('No snapshot found in bucket. Push first.');
      const date = new Date(v1.exportedAt || Date.now()).toLocaleString();
      if (!confirm('Pull legacy v1 snapshot from ' + date + '?\nWill be migrated to v2 on next push.')) {
        _clearProgress(); return;
      }
      _setProgress('Applying v1 snapshot', 0, 1, '');
      await _applyV1Snapshot(v1);
      markStateClean();
      _updateSyncStatus();
      appendSystemMsg('Pulled v1 snapshot (' + (v1.conversations?.meta?.length || 0) + ' conv, ' + (v1.skills?.metadata?.length || 0) + ' skills). Push to migrate to v2.');
      _clearProgress();
      return;
    }

    if (remote.version !== 2) throw new Error('Unsupported manifest version: ' + remote.version);

    const date = new Date(remote.updatedAt || Date.now()).toLocaleString();
    if (!confirm(
      'Pull snapshot from ' + date + '?\n\n' +
      '  \u2022 ' + (remote.conversations || []).length + ' conversation(s)\n' +
      '  \u2022 ' + (remote.skills || []).length + ' skill(s)\n' +
      (remote.quipu ? '  \u2022 the quipu knowledge graph (' + (remote.quipu.size / 1024).toFixed(0) + ' KB) \u2014 REPLACES the local one\n' : '') +
      '\nLocal changes not yet pushed will be lost. LLM / Tavily keys are preserved.'
    )) { _clearProgress(); return; }

    // Build local state to figure out which objects/blobs we already have (dedup on pull too).
    _setProgress('Scanning local state', 0, 1, '');
    const local = await _buildLocalState();

    const neededObjHashes = [];
    for (const c of remote.conversations || []) if (!local.objects.has(c.hash)) neededObjHashes.push(c.hash);
    for (const s of remote.skills || []) if (!local.objects.has(s.hash)) neededObjHashes.push(s.hash);
    if (remote.settings?.hash && !local.objects.has(remote.settings.hash)) neededObjHashes.push(remote.settings.hash);
    if (remote.memories?.hash && !local.objects.has(remote.memories.hash)) neededObjHashes.push(remote.memories.hash);

    const objs = new Map();
    // Reuse local copies for hashes we already have.
    for (const c of remote.conversations || []) if (local.objects.has(c.hash)) objs.set(c.hash, JSON.parse(local.objects.get(c.hash)));
    for (const s of remote.skills || []) if (local.objects.has(s.hash)) objs.set(s.hash, JSON.parse(local.objects.get(s.hash)));
    if (remote.settings?.hash && local.objects.has(remote.settings.hash)) objs.set(remote.settings.hash, JSON.parse(local.objects.get(remote.settings.hash)));
    if (remote.memories?.hash && local.objects.has(remote.memories.hash)) objs.set(remote.memories.hash, JSON.parse(local.objects.get(remote.memories.hash)));

    if (neededObjHashes.length) {
      _setProgress('Downloading objects', 0, neededObjHashes.length, '');
      let done = 0;
      await _s3Pool(neededObjHashes, async (h) => {
        const o = await _getJsonObject(cfg, h);
        if (o) objs.set(h, o);
        done++;
        _setProgress('Downloading objects', done, neededObjHashes.length, h.slice(0, 12) + '\u2026');
      });
    }

    // Collect blobs referenced by the downloaded object set.
    const refSet = new Set();
    for (const o of objs.values()) _collectBlobRefs(o, refSet);
    const blobMap = new Map();
    // Reuse local blobs where possible.
    for (const h of refSet) if (local.blobs.has(h)) blobMap.set(h, local.blobs.get(h));
    const blobsNeeded = [...refSet].filter(h => !blobMap.has(h));

    if (blobsNeeded.length) {
      _setProgress('Downloading blobs', 0, blobsNeeded.length, '');
      let done = 0;
      await _s3Pool(blobsNeeded, async (h) => {
        const b = await _getBlob(cfg, h);
        if (b) blobMap.set(h, b);
        done++;
        _setProgress('Downloading blobs', done, blobsNeeded.length, h.slice(0, 12) + '\u2026 (' + (b ? (b.length / 1024).toFixed(1) + ' KB' : '?') + ')');
      });
    }

    // The quipu store is referenced by the manifest itself rather than by any
    // synced object, so _collectBlobRefs never sees it — fetch it by name.
    if (remote.quipu?.hash && !blobMap.has(remote.quipu.hash)) {
      _setProgress('Downloading knowledge graph', 0, 1,
        ((remote.quipu.size || 0) / 1024).toFixed(1) + ' KB');
      const qb = local.blobs.get(remote.quipu.hash) || await _getBlob(cfg, remote.quipu.hash);
      if (qb) blobMap.set(remote.quipu.hash, qb);
      _setProgress('Downloading knowledge graph', 1, 1, '');
    }

    _setProgress('Applying changes', 0, 1, '');
    await _applyRemoteState(remote, objs, blobMap);
    _setProgress('Applying changes', 1, 1, '');

    markStateClean();
    const passHash = cfg.passphrase ? await _hashString(cfg.passphrase) : '';
    try { localStorage.setItem(S3_LAST_PASS_HASH_KEY, passHash); } catch {}
    _updateSyncStatus();
    appendSystemMsg(
      'Pull: ' + neededObjHashes.length + ' object(s) downloaded, '
      + blobsNeeded.length + ' blob(s) downloaded, rest reused locally.'
    );
    _clearProgress();
  } catch (e) {
    _clearProgress();
    throw e;
  }
}

async function testS3Connection() {
  const status = document.getElementById('s3Status');
  if (status) status.textContent = 'Testing connection...';
  const cfg = _readS3CfgFromModal();
  if (!_s3Configured(cfg)) {
    if (status) status.textContent = 'Fill endpoint / bucket / access key / secret first.';
    return;
  }
  try {
    // HEAD on snapshot key — 404 is OK (means the bucket is reachable and auth works).
    await _s3Head(cfg, _manifestKey(cfg));
    if (status) status.textContent = 'Connection OK — bucket is reachable.';
  } catch (e) {
    const msg = String(e.message || e);
    if (status) {
      if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
        status.textContent = 'Network/CORS error. Click "Show CORS config" and apply it to the bucket.';
      } else {
        status.textContent = msg;
      }
    }
  }
}

function showCorsHint() {
  const cors = [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'] }];
  const json = JSON.stringify(cors, null, 2);
  const w = window.open('', '_blank');
  if (w) {
    w.document.write(`<pre style="font:12px monospace;white-space:pre-wrap;padding:16px">${esc(json)}</pre>`);
    w.document.title = 'OnePagent \u2014 CORS config for S3 bucket';
  } else {
    prompt('Copy this JSON into your bucket CORS policy:', json);
  }
}

function _readS3CfgFromModal() {
  const g = id => (document.getElementById(id)?.value || '').trim();
  const gc = id => !!document.getElementById(id)?.checked;
  return {
    endpoint: g('setS3Endpoint').replace(/\/+$/, ''),
    region: g('setS3Region') || 'us-east-1',
    bucket: g('setS3Bucket'),
    prefix: g('setS3Prefix') || 'onepagent/',
    accessKey: g('setS3AccessKey'),
    secretKey: g('setS3SecretKey'),
    passphrase: g('setS3Passphrase'),
    autoPush: gc('setS3AutoPush'),
    forcePathStyle: gc('setS3PathStyle')
  };
}
function _saveS3CfgFromModal() {
  // Only called if the section exists in the DOM.
  if (!document.getElementById('setS3Endpoint')) return;
  _writeS3Cfg(_readS3CfgFromModal());
}

function _readStateCfgFromModal() {
  const g = id => (document.getElementById(id)?.value || '').trim();
  const gc = id => !!document.getElementById(id)?.checked;
  const prev = (typeof CreelState !== 'undefined' ? CreelState.loadCfg() : null) || {};
  return {
    ...prev,
    owner: g('setStateOwner'),
    repo: g('setStateRepo') || 'creel-state',
    branch: g('setStateBranch') || 'main',
    prefix: g('setStatePrefix') || 'state',
    passphrase: g('setStatePassphrase'),
    includeSecrets: gc('setStateSecrets'),
    enabled: gc('setStateEnabled'),
  };
}
function _saveStateCfgFromModal() {
  if (typeof CreelState === 'undefined' || !document.getElementById('setStateOwner')) return;
  const cfg = _readStateCfgFromModal();
  // An owner is the one field with no sensible default (the login is only
  // known once GitHub answers), so an empty one means "not set up yet" rather
  // than "set up wrongly" — leave any existing config alone.
  if (!cfg.owner && !cfg.enabled) { CreelState.saveCfg(cfg.repo || cfg.passphrase ? cfg : null); CreelState.reset(); return; }
  CreelState.saveCfg(cfg);
  CreelState.reset();
}

/** Settings' "Check repo" button: prove the destination is reachable, ours,
 *  and private BEFORE the operator trusts it with anything. */
async function testStateRepo() {
  const el = document.getElementById('stateRepoStatus');
  const say = (msg, color) => { if (el) { el.textContent = msg; el.style.color = color || 'var(--text-dim)'; } };
  try {
    _saveStateCfgFromModal();
    const cfg = _readStateCfgFromModal();
    if (!cfg.owner) {
      // Fill the owner in for them rather than refusing over a blank field.
      const me = await CreelState.verifyLogin();
      cfg.owner = me;
      document.getElementById('setStateOwner').value = me;
      CreelState.saveCfg(cfg);
    }
    say('Checking ' + cfg.owner + '/' + cfg.repo + '\u2026');
    const facts = await CreelState.verifyRepo(cfg);
    const secrets = cfg.includeSecrets && cfg.passphrase
      ? ' \u2014 API keys included, encrypted'
      : (cfg.includeSecrets ? ' \u2014 API keys NOT included (no passphrase set)' : '');
    say('OK: ' + facts.slug + ' is private and pushable' + secrets, 'var(--accent-green, var(--text-dim))');
  } catch (e) {
    say(String(e?.message || e), 'var(--accent-red)');
  }
}

// ── Sync button UI ────────────────────────────────────────────────
function toggleSyncMenu() {
  const m = document.getElementById('syncMenu');
  if (!m) return;
  if (m.style.display === 'block') {
    if (_s3OpActive) return;  // don't allow closing mid-operation
    m.style.display = 'none';
    return;
  }
  _updateSyncStatus();
  m.style.display = 'block';
  setTimeout(() => {
    const h = e => {
      if (_s3OpActive) return;  // block outside-click close while syncing
      if (!m.contains(e.target) && e.target.id !== 'syncBtn') { m.style.display = 'none'; document.removeEventListener('click', h); }
    };
    document.addEventListener('click', h);
  }, 0);
}
/* The unpushed marker on the Sync button.
 *
 * beforeunload can only raise the browser's own generic dialog — the text is
 * not ours to write — so "you have unsaved work" has to be legible BEFORE
 * someone reaches for the close button, not only in the prompt after. */
function _renderDirtyIndicator() {
  const btn = document.getElementById('syncBtn');
  if (!btn) return;
  const dirty = typeof stateIsDirty === 'function' && stateIsDirty();
  let dot = btn.querySelector('.sync-dirty-dot');
  if (dirty && !dot) {
    dot = document.createElement('span');
    dot.className = 'sync-dirty-dot';
    dot.setAttribute('aria-hidden', 'true');   // the title carries the meaning
    dot.textContent = '\u25CF';
    dot.style.cssText = 'color:var(--accent-orange,#e39a4e);margin-left:4px;font-size:9px;line-height:1';
    btn.appendChild(dot);
  } else if (!dirty && dot) {
    dot.remove();
  }
  btn.title = dirty
    ? t('sync.unpushed', 'Unpushed changes — this tab holds state that has not been saved')
    : t('btn.syncTitle', 'Cloud sync to S3-compatible bucket');
}
window.__creelStateChanged = _renderDirtyIndicator;

function _updateSyncStatus() {
  _renderDirtyIndicator();
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const cfg = _loadS3Cfg();
  if (!_s3Configured(cfg)) { el.textContent = t('sync.notConfigured'); return; }
  const last = Number(localStorage.getItem(S3_LAST_SYNC_KEY) || 0);
  if (!last) { el.textContent = t('sync.neverSynced'); return; }
  const diff = Date.now() - last;
  const mins = Math.round(diff / 60000);
  const hours = Math.round(diff / 3600000);
  const days = Math.round(diff / 86400000);
  let ago;
  if (diff < 60000) ago = t('sync.justNow');
  else if (mins < 60) ago = mins + ' ' + t('sync.minAgo');
  else if (hours < 24) ago = hours + ' ' + t('sync.hourAgo');
  else ago = days + ' ' + t('sync.dayAgo');
  el.textContent = t('sync.lastSynced') + ' ' + ago + (cfg.passphrase ? ' \u2014 ' + t('sync.encrypted') : '');
}
async function onSyncPushClick() {
  try { await pushSnapshotToS3(); } catch (e) { appendSystemMsg('Push failed: ' + (e.message || e)); }
}
async function onSyncPullClick() {
  try { await pullSnapshotFromS3(); } catch (e) { appendSystemMsg('Pull failed: ' + (e.message || e)); }
}

// ── Auto-push debouncer (called from saveCurrentConv / saveSkills) ─
let _s3PushTimer = null;
let _s3PushInFlight = false;
function schedulePush() {
  // Called from every path that mutates local state (conversations, skills,
  // memory), so this is where "something changed" is known — regardless of
  // whether any auto-push is configured to act on it. Stamp first, before the
  // early returns below, or the leave guard only ever sees changes made by
  // operators who happen to use S3 auto-push.
  markStateDirty();
  if (_s3PushInFlight) return;
  const cfg = _loadS3Cfg();
  if (!cfg || !cfg.autoPush || !_s3Configured(cfg)) return;
  clearTimeout(_s3PushTimer);
  _s3PushTimer = setTimeout(() => {
    pushSnapshotToS3(true).catch(e => { console.warn('Auto-push failed:', e); appendSystemMsg('Auto-push failed: ' + (e.message || e)); });
  }, 10000);
}

// ═══════════════════════════════════════════════════════════════════
// PLAN MODE — writes blocked; model plans first, user approves via ExitPlanMode
// ═══════════════════════════════════════════════════════════════════
function togglePlanMode() {
  ensureVisibleConversationStateActive();
  const run = getActiveConversationRun();
  planMode = !planMode;
  renderPlanButton();
  rebuildToolDefs();
  appendSystemMsg(planMode
    ? 'Plan Mode ON — write tools blocked. The agent should explore, then call ExitPlanMode with a plan for your approval.'
    : 'Plan Mode OFF — all tools available.', run);
}
function renderPlanButton() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const btn = document.getElementById('planBtn');
  if (!btn) return;
  if (planMode) {
    btn.style.background = 'var(--accent-orange)';
    btn.style.color = '#fff';
    btn.style.borderColor = 'var(--accent-orange)';
  } else {
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}
function toggleRalphMode() {
  ensureVisibleConversationStateActive();
  if (isConversationRunning(visibleConvId || activeConvId)) return;
  ralphModeEnabled = !ralphModeEnabled;
  renderRalphButton();
  appendSystemMsg(ralphModeEnabled
    ? 'Ralph Loop ON — the agent will continue unattended until done or a guard stops it.'
    : 'Ralph Loop OFF.');
}
function renderRalphButton() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const btn = document.getElementById('ralphBtn');
  if (!btn) return;
  const active = ralphModeEnabled || !!ralphRun?.active;
  const label = ralphRun?.active ? `Ralph ${ralphRun.iteration}/${ralphRun.unlimited ? '∞' : ralphRun.maxIterations}` : 'Ralph';
  const span = btn.querySelector('span');
  if (span) span.textContent = label;
  btn.title = ralphRun?.active ? `Ralph Loop running: ${ralphRun.iteration}/${ralphRun.unlimited ? '∞' : ralphRun.maxIterations}` : 'Ralph Loop: unattended continue-until-done mode';
  if (active) {
    btn.style.background = 'var(--accent-orange)';
    btn.style.color = '#fff';
    btn.style.borderColor = 'var(--accent-orange)';
  } else {
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}
function normalizeRalphOptions(raw) {
  if (!raw?.enabled) return { enabled: false };
  const maxRaw = parseInt(raw.maxIterations, 10);
  const unlimited = raw.unlimited === true;
  return {
    enabled: true,
    unlimited,
    maxIterations: unlimited ? Infinity : (Number.isFinite(maxRaw) ? Math.min(RALPH_DEFAULTS.hardMaxIterations, Math.max(1, maxRaw)) : RALPH_DEFAULTS.maxIterations),
    completionMarker: String(raw.completionMarker || RALPH_DEFAULTS.completionMarker).trim() || RALPH_DEFAULTS.completionMarker
  };
}
function getRalphLoopPrompt() {
  if (!ralphRun?.active) return '';
  return `\n\n[RALPH LOOP ACTIVE]\nYou are running unattended on the original task:\n<task>\n${ralphRun.originalTask}\n</task>\n\nDo not ask the user for input. Use available tools to make progress. If you need a human decision, secret, approval, or unsafe/destructive action, stop with a clear blocker. When the task is fully complete, include the marker ${ralphRun.completionMarker} in your final response. If more work remains after a normal assistant response, the system may re-enter you for another unattended iteration.`;
}
function ralphSignature({ fullText, todos }) {
  const text = String(fullText || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 1200);
  const counts = (todos || []).reduce((acc, todo) => { acc[todo.status] = (acc[todo.status] || 0) + 1; return acc; }, {});
  return `${text}|todo:${counts.completed || 0}/${counts.in_progress || 0}/${counts.pending || 0}`;
}
function shouldContinueRalphLoop({ result, fullText, todos, ralphRun }) {
  if (!ralphRun?.active) return { continue: false, reason: 'inactive' };
  if (ralphRun.cancelled) return { continue: false, reason: 'cancelled' };
  if (result?.stream_error) return { continue: false, reason: 'stream error' };
  if (String(fullText || '').toLowerCase().includes(String(ralphRun.completionMarker || RALPH_DEFAULTS.completionMarker).toLowerCase())) return { continue: false, reason: 'completed' };
  if (!ralphRun.unlimited && ralphRun.iteration >= ralphRun.maxIterations) return { continue: false, reason: 'max iterations reached' };
  const sig = ralphSignature({ fullText, todos });
  const seen = (ralphRun.seenSignatures.get(sig) || 0) + 1;
  ralphRun.seenSignatures.set(sig, seen);
  if (seen >= 2) return { continue: false, reason: 'no progress detected' };
  return { continue: true, reason: 'continuing unattended' };
}
function buildRalphContinuationText({ ralphRun, lastAssistantText }) {
  return `[Ralph Loop iteration ${ralphRun.iteration}/${ralphRun.unlimited ? '∞' : ralphRun.maxIterations}]\n\nContinue the same original task without waiting for the user.\n\nOriginal task:\n${ralphRun.originalTask}\n\nPrevious assistant response:\n${truncateMiddleText(lastAssistantText || '(no text response)', 3000)}\n\nInstructions:\n- If all requirements are complete, respond with ${ralphRun.completionMarker} and a concise final summary.\n- If work remains, continue autonomously.\n- Do not ask the user for input.\n- If blocked, state the blocker and stop.`;
}
function appendRalphContinuationMessage({ ralphRun, lastAssistantText }) {
  const text = buildRalphContinuationText({ ralphRun, lastAssistantText });
  appendSessionEntry('message', { role: 'user', content: [{ type: 'text', text }], ralphSynthetic: true, promptEntryId: ralphRun.promptEntryId });
  rebuildConversation();
  if (currentRunContext) snapshotConversationRunState(currentRunContext);
  appendSystemMsg(`Ralph Loop continuing: iteration ${ralphRun.iteration}/${ralphRun.unlimited ? '∞' : ralphRun.maxIterations}.`);
}

let _planModalResolver = null;
function showPlanApprovalModal(plan) {
  if (_planModalResolver) return Promise.resolve({ approved: false, feedback: 'Another conversation is already awaiting plan review.' });
  return new Promise(resolve => {
    _planModalResolver = resolve;
    const overlay = document.getElementById('planModal');
    const body = document.getElementById('planModalBody');
    const fb = document.getElementById('planModalFeedback');
    if (fb) fb.value = '';
    if (body) {
      // Render plan text as markdown if marked is available, else escape.
      if (typeof marked !== 'undefined' && marked.parse) {
        try { body.innerHTML = marked.parse(plan); }
        catch { body.textContent = plan; }
      } else {
        body.textContent = plan;
      }
    }
    overlay.classList.add('show');
  });
}
function _closePlanModal(result) {
  document.getElementById('planModal').classList.remove('show');
  if (_planModalResolver) { _planModalResolver(result); _planModalResolver = null; }
}
function approvePlan() { _closePlanModal({ approved: true }); }
function rejectPlan() {
  const fb = document.getElementById('planModalFeedback');
  _closePlanModal({ approved: false, feedback: (fb?.value || '').trim() });
}

let _hitlModalResolver = null;
let _hitlModalState = null;

function _normalizeHitlInput(input) {
  input = input && typeof input === 'object' ? input : {};
  let mode = ['text', 'choice', 'confirm'].includes(input.mode) ? input.mode : 'text';
  const choices = Array.isArray(input.choices) ? input.choices.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12) : [];
  if (mode === 'choice' && !choices.length) mode = 'text';
  return {
    mode,
    prompt: String(input.prompt || '').trim(),
    context: String(input.context || '').trim(),
    choices,
    defaultChoice: String(input.default_choice || '').trim(),
    allowCustom: input.allow_custom === true
  };
}

function showHitlModal(input) {
  const state = _normalizeHitlInput(input);
  if (_hitlModalResolver) return Promise.resolve({ status: 'busy', mode: state.mode, answer: '', reason: 'Another conversation is already awaiting user input.' });
  return new Promise(resolve => {
    _hitlModalResolver = resolve;
    _hitlModalState = state;
    const overlay = document.getElementById('hitlModal');
    const promptEl = document.getElementById('hitlModalPrompt');
    const contextEl = document.getElementById('hitlModalContext');
    const choicesEl = document.getElementById('hitlModalChoices');
    const responseEl = document.getElementById('hitlModalResponse');
    const labelEl = document.getElementById('hitlModalResponseLabel');
    const submitEl = document.getElementById('hitlModalSubmit');
    const statusEl = document.getElementById('hitlModalStatus');
    if (!overlay || !promptEl || !contextEl || !choicesEl || !responseEl || !labelEl || !submitEl || !statusEl) {
      _hitlModalResolver = null;
      _hitlModalState = null;
      resolve({ status: 'cancelled', mode: state.mode, answer: '' });
      return;
    }
    promptEl.textContent = state.prompt;
    contextEl.textContent = state.context;
    contextEl.style.display = state.context ? 'block' : 'none';
    responseEl.value = state.mode === 'text' ? state.defaultChoice : '';
    responseEl.placeholder = t('hitlModal.responsePh');
    statusEl.textContent = '';
    choicesEl.innerHTML = '';
    choicesEl.style.display = state.mode === 'choice' || state.mode === 'confirm' ? 'block' : 'none';
    labelEl.style.display = state.mode === 'confirm' ? 'none' : '';
    responseEl.style.display = state.mode === 'confirm' ? 'none' : '';
    submitEl.style.display = state.mode === 'confirm' ? 'none' : '';

    if (state.mode === 'choice') {
      for (const [i, choice] of state.choices.entries()) {
        const id = `hitlChoice${i}`;
        const label = document.createElement('label');
        label.className = 'hitl-choice';
        label.innerHTML = `<input type="radio" name="hitlChoice" id="${id}" value="${i}"><span></span>`;
        label.querySelector('span').textContent = choice;
        choicesEl.appendChild(label);
        if (state.defaultChoice && choice === state.defaultChoice) label.querySelector('input').checked = true;
      }
      labelEl.textContent = t('hitlModal.custom');
      labelEl.style.display = state.allowCustom ? '' : 'none';
      responseEl.style.display = state.allowCustom ? '' : 'none';
      responseEl.value = state.allowCustom && state.defaultChoice && !state.choices.includes(state.defaultChoice) ? state.defaultChoice : '';
    } else if (state.mode === 'confirm') {
      const yes = document.createElement('button');
      const no = document.createElement('button');
      yes.className = 'modal-btn primary';
      no.className = 'modal-btn secondary';
      yes.style.marginRight = '8px';
      yes.textContent = t('hitlModal.yes');
      no.textContent = t('hitlModal.no');
      yes.onclick = () => _closeHitlModal({ status: 'answered', mode: 'confirm', confirmed: true, answer: 'yes' });
      no.onclick = () => _closeHitlModal({ status: 'answered', mode: 'confirm', confirmed: false, answer: 'no' });
      choicesEl.appendChild(yes);
      choicesEl.appendChild(no);
    } else {
      labelEl.textContent = t('hitlModal.response');
    }
    overlay.classList.add('show');
    setTimeout(() => { if (responseEl.style.display !== 'none') responseEl.focus(); }, 0);
  });
}

function _closeHitlModal(result) {
  const overlay = document.getElementById('hitlModal');
  if (overlay) overlay.classList.remove('show');
  if (_hitlModalResolver) _hitlModalResolver(result);
  _hitlModalResolver = null;
  _hitlModalState = null;
}

function submitHitlModal() {
  const state = _hitlModalState;
  if (!state) return;
  const responseEl = document.getElementById('hitlModalResponse');
  const statusEl = document.getElementById('hitlModalStatus');
  const custom = (responseEl?.value || '').trim();
  if (state.mode === 'choice') {
    const selected = document.querySelector('input[name="hitlChoice"]:checked');
    if (selected) {
      const idx = Number(selected.value);
      _closeHitlModal({ status: 'answered', mode: 'choice', answer: state.choices[idx], choice_index: idx, custom: false });
      return;
    }
    if (state.allowCustom && custom) {
      _closeHitlModal({ status: 'answered', mode: 'choice', answer: custom, choice_index: null, custom: true });
      return;
    }
  } else if (custom || state.defaultChoice) {
    _closeHitlModal({ status: 'answered', mode: 'text', answer: custom || state.defaultChoice });
    return;
  }
  if (statusEl) statusEl.textContent = t('hitlModal.required');
}

function cancelHitlModal() {
  const mode = _hitlModalState?.mode || 'text';
  _closeHitlModal({ status: 'cancelled', mode, answer: '' });
}

function addMcpTool() {
  const name = document.getElementById('mcpToolName').value.trim();
  if (!name) { alert('Tool name is required'); return; }
  let params = { type: 'object', properties: {}, required: [] };
  const paramsStr = document.getElementById('mcpToolParams').value.trim();
  if (paramsStr) { try { params = JSON.parse(paramsStr); } catch (e) { alert('Invalid JSON: ' + e.message); return; } }
  const tool = {
    name,
    description: document.getElementById('mcpToolDesc').value.trim() || name,
    parameters: params,
    serverUrl: document.getElementById('mcpToolUrl').value.trim(),
    handler: document.getElementById('mcpToolHandler').value.trim(),
  };
  mcpTools = mcpTools.filter(t => t.name !== name);
  mcpTools.push(tool);
  saveMcpTools();
  rebuildToolDefs();
  renderMcpToolList();
  // Clear form
  ['mcpToolName','mcpToolDesc','mcpToolParams','mcpToolUrl','mcpToolHandler'].forEach(id => document.getElementById(id).value = '');
  logMemEntry('write', `MCP tool added: ${name}`);
}

function removeMcpTool(name) {
  mcpTools = mcpTools.filter(t => t.name !== name);
  saveMcpTools();
  rebuildToolDefs();
  renderMcpToolList();
}

function renderMcpToolList() {
  const el = document.getElementById('mcpToolList');
  if (!mcpTools.length) { el.textContent = t('mcpModal.noneInstalled'); return; }
  el.innerHTML = mcpTools.map(mt => `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0"><span>${iconHtml('i:wrench')} ${esc(mt.name)}</span><span class="c-del" style="opacity:1;cursor:pointer" onclick="removeMcpTool('${esc(mt.name)}')">&times;</span></div>`).join('');
}

async function executeMcpTool(name, input) {
  const tool = mcpTools.find(t => t.name === name);
  if (!tool) return `Unknown MCP tool: ${name}`;
  // Route through a connected MCP server (streamable_http / sse) when present.
  if (tool.serverId) {
    const server = mcpServers.find(s => s.id === tool.serverId);
    if (!server) return `MCP server not found for tool: ${name}`;
    try {
      const rt = _mcpRt(server.id);
      if (!rt.connected) await mcpConnectServer(server);
      const result = await _mcpCall(server, 'tools/call', { name, arguments: input || {} });
      const parts = Array.isArray(result?.content) ? result.content : [];
      const texts = [];
      for (const c of parts) {
        if (c && c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
        else if (c && c.type === 'image') texts.push('[image: ' + (c.mimeType || 'image') + ']');
        else if (c && c.type === 'resource' && c.resource) texts.push(`[resource: ${c.resource.uri || ''}]${c.resource.text ? '\n' + c.resource.text : ''}`);
        else texts.push(JSON.stringify(c));
      }
      const out = texts.join('\n') || '(no output)';
      if (result?.isError) return `Tool error: ${out}`;
      return out;
    } catch (e) { return `MCP call failed: ${e.message}`; }
  }
  // If server URL, call it
  if (tool.serverUrl) {
    try {
      const resp = await fetch(tool.serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: name, input }) });
      if (!resp.ok) return `MCP server error (${resp.status}): ${(await resp.text()).slice(0, 500)}`;
      const data = await resp.json();
      return typeof data.result === 'string' ? data.result : JSON.stringify(data);
    } catch (e) { return `MCP call failed: ${e.message}`; }
  }
  // Otherwise execute handler JS
  if (tool.handler) {
    try { const fn = new Function('input', tool.handler); return String(fn(input) || '(no output)'); }
    catch (e) { return `MCP handler error: ${e.message}`; }
  }
  return `MCP tool ${name} has no server URL or handler`;
}

// ═══════════════════════════════════════════════════════════════════
// VIRTUAL FILESYSTEM
// ═══════════════════════════════════════════════════════════════════
function normPath(p) {
  p = (p || '/').replace(/\\/g, '/');
  if (!p.startsWith('/')) p = cwd.replace(/\/$/, '') + '/' + p;
  const parts = [];
  for (const s of p.split('/')) { if (s === '..') { if (parts.length) parts.pop(); } else if (s && s !== '.') parts.push(s); }
  return '/' + parts.join('/');
}
function vfsResolve(path, root = vfs) {
  path = normPath(path); if (path === '/') return root;
  let n = root; for (const p of path.slice(1).split('/')) { if (!n || n.type !== 'dir' || !n.children[p]) return null; n = n.children[p]; } return n;
}
function vfsRead(path, root = vfs) { const n = vfsResolve(path, root); if (!n) return { error: `File not found: ${path}` }; if (n.type !== 'file') return { error: `Not a file: ${path}` }; return { content: n.content, path: normPath(path) }; }
function vfsWrite(path, content, skipRender = false, root = vfs) {
  path = normPath(path); const parts = path.slice(1).split('/'); const fn = parts.pop(); let n = root;
  for (const p of parts) { if (!n.children[p]) n.children[p] = { type: 'dir', children: {} }; n = n.children[p]; if (n.type !== 'dir') return { error: `${p} is not a directory` }; }
  if (n.children[fn]?.binary) _unrefVfsSubtree(n.children[fn]);
  n.children[fn] = { type: 'file', content, modified: Date.now() }; if (!skipRender && root === vfs) renderFileTree(); return { ok: true, path, bytes: content.length };
}
function vfsDelete(path, skipRender = false, root = vfs) { path = normPath(path); if (path === '/') return { error: 'Cannot delete root' }; const parts = path.slice(1).split('/'); const nm = parts.pop(); let n = root; for (const p of parts) { if (!n.children[p]) return { error: `Not found: ${path}` }; n = n.children[p]; } if (!n.children[nm]) return { error: `Not found: ${path}` }; _unrefVfsSubtree(n.children[nm]); delete n.children[nm]; if (!skipRender && root === vfs) renderFileTree(); return { ok: true }; }
function vfsMkdir(path) { path = normPath(path); const parts = path.slice(1).split('/'); let n = vfs; for (const p of parts) { if (!n.children[p]) n.children[p] = { type: 'dir', children: {} }; n = n.children[p]; } renderFileTree(); return { ok: true }; }
function vfsWalk(basePath, cb, root = vfs) {
  basePath = normPath(basePath || '/'); const n = vfsResolve(basePath, root); if (!n) return;
  (function walk(nd, p) { if (nd.type === 'file') cb(p, nd); else if (nd.children) for (const [nm, ch] of Object.entries(nd.children).sort((a,b) => a[0].localeCompare(b[0]))) walk(ch, p === '/' ? '/' + nm : p + '/' + nm); })(n, basePath);
}
function globMatch(pat, path) { const r = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '[^/]'); return new RegExp('^' + r + '$').test(path); }
function vfsGlob(pat, base) { base = normPath(base || '/'); const r = []; vfsWalk(base, fp => { const rel = base === '/' ? fp.slice(1) : fp.slice(base.length + 1); if (globMatch(pat, rel) || globMatch(pat, fp)) r.push(fp); }); return r; }
function vfsGrep(pat, base, inc) { base = normPath(base || '/'); const re = new RegExp(pat, 'i'); const r = []; vfsWalk(base, (fp, nd) => { if (nd.binary) return; if (inc) { const nm = fp.split('/').pop(); if (!globMatch(inc, nm) && !globMatch(inc, fp)) return; } const lines = nd.content.split('\n'); for (let i = 0; i < lines.length && r.length < 200; i++) if (re.test(lines[i])) r.push(`${fp}:${i+1}:${lines[i]}`); }); return r; }

