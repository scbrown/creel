/* creel harness — part 19 of 26: role-manager
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
 *   - ROLE MANAGER (v4) — agent-callable CRUD over agent-tier custom roles.
 */
// ═══════════════════════════════════════════════════════════════════
// ROLE MANAGER (v4) — agent-callable CRUD over agent-tier custom roles.
// Lead-only. Built-in and v3 user-authored roles are read-only to this tool.
// ═══════════════════════════════════════════════════════════════════
const ROLE_MANAGER_READ_ACTIONS = new Set(['list', 'inspect']);
const ROLE_MANAGER_WRITE_ACTIONS = new Set(['create', 'update', 'delete', 'duplicate']);
function isRoleManagerWriteAction(input) {
  return ROLE_MANAGER_WRITE_ACTIONS.has(String(input?.action || '').trim());
}
// Settings-modal helper: enable the per-conversation checkbox only when persistence is on.
function _onAgentRolesPersistToggle() {
  const persist = document.getElementById('setSwarmAgentRolesPersist');
  const perConv = document.getElementById('setSwarmAgentRolesPerConv');
  if (!persist || !perConv) return;
  if (!persist.checked) { perConv.checked = false; perConv.disabled = true; }
  else { perConv.disabled = false; }
}
function _rmResult(payload) { return JSON.stringify(payload, null, 2); }
function _rmError(action, message, extra) { return _rmResult({ ok: false, action: action || 'unknown', error: message, ...(extra || {}) }); }
function _rmSummarizeRole(r) {
  return {
    id: r.id,
    name: r.name || r.id,
    source: r.builtin ? 'builtin' : (r.createdBy === 'agent' || r.source === 'agent' ? 'agent' : 'user'),
    enabled: r.enabled !== false,
    tools: Array.isArray(r.allowedTools) ? r.allowedTools.length : 0,
    handoffs: Array.isArray(r.allowedHandoffs) ? r.allowedHandoffs.length : 0,
    skills: Array.isArray(r.bindSkills) ? r.bindSkills.length : 0,
    description: r.description || ''
  };
}
function _rmFullRole(r) {
  // Strip the boot-time mutable .builtin / .enabled defaults so the JSON looks like a clean role record.
  const out = { id: r.id, name: r.name, description: r.description || '', systemPrompt: r.systemPrompt || '', allowedTools: r.allowedTools || [], allowedHandoffs: r.allowedHandoffs || [], bindSkills: r.bindSkills || [], maxSteps: r.maxSteps || 6, tokenBudget: r.tokenBudget || 60000, enabled: r.enabled !== false };
  if (r.defaultModel) out.defaultModel = r.defaultModel;
  if (r.builtin) out.builtin = true;
  if (r.createdBy) out.createdBy = r.createdBy;
  if (r.createdAt) out.createdAt = r.createdAt;
  return out;
}
// Decide whether an update is "substantial" enough to require confirmed=true.
function _rmIsSubstantialUpdate(prev, next) {
  const pp = String(prev.systemPrompt || '');
  const np = String(next.systemPrompt || '');
  if (pp && np && pp !== np) {
    // Compare lengths; consider >25% length swing a substantial change.
    const ratio = Math.abs(pp.length - np.length) / Math.max(pp.length, 1);
    if (ratio > 0.25) return true;
  } else if (!!pp !== !!np) {
    return true;
  }
  const prevTools = new Set(prev.allowedTools || []);
  const nextTools = new Set(next.allowedTools || []);
  let toolDiff = 0;
  for (const t of prevTools) if (!nextTools.has(t)) toolDiff++;
  for (const t of nextTools) if (!prevTools.has(t)) toolDiff++;
  if (toolDiff >= 3) return true;
  const prevSkills = new Set(prev.bindSkills || []);
  const nextSkills = new Set(next.bindSkills || []);
  let skillDiff = 0;
  for (const s of prevSkills) if (!nextSkills.has(s)) skillDiff++;
  for (const s of nextSkills) if (!prevSkills.has(s)) skillDiff++;
  if (skillDiff >= 1) return true;
  return false;
}
function _rmNormalizeIncomingRole(role) {
  if (!role || typeof role !== 'object') return null;
  const out = {
    id: String(role.id || '').trim(),
    name: String(role.name || '').trim(),
    description: String(role.description || '').trim(),
    systemPrompt: String(role.systemPrompt || ''),
    allowedTools: Array.isArray(role.allowedTools) ? role.allowedTools.map(String).filter(Boolean) : [],
    allowedHandoffs: Array.isArray(role.allowedHandoffs) ? role.allowedHandoffs.map(String).filter(Boolean) : [],
    bindSkills: Array.isArray(role.bindSkills) ? role.bindSkills.map(String).filter(Boolean) : [],
    maxSteps: Number.isFinite(role.maxSteps) ? Math.min(30, Math.max(1, role.maxSteps | 0)) : 6,
    tokenBudget: Number.isFinite(role.tokenBudget) ? Math.min(200000, Math.max(5000, role.tokenBudget | 0)) : 60000,
    enabled: role.enabled !== false,
  };
  if (role.defaultModel) out.defaultModel = String(role.defaultModel).trim();
  return out;
}
async function toolRoleManager(input) {
  if (!swarmSettings.enabled) return _rmError(input?.action, 'Agent Swarm is disabled. Ask the user to enable it in Settings → Agent Swarm.');
  if (!swarmSettings.roleManagerEnabled) return _rmError(input?.action, 'RoleManager is disabled. Ask the user to enable "Allow agent to manage roles" in Settings → Agent Swarm.');
  if (ralphRun?.active) return _rmError(input?.action, 'RoleManager is disabled while Ralph Loop is active.');
  const action = String(input?.action || '').trim();
  if (!action) return _rmError('', 'Missing required field "action".');
  switch (action) {
    case 'list':       return _rmList();
    case 'inspect':    return _rmInspect(input);
    case 'create':     return _rmCreate(input);
    case 'update':     return _rmUpdate(input);
    case 'delete':     return _rmDelete(input);
    case 'duplicate':  return _rmDuplicate(input);
    default:           return _rmError(action, `Unknown action "${action}". Valid: list, inspect, create, update, delete, duplicate.`);
  }
}
function _rmList() {
  const roles = getAllSwarmRoles().concat(
    userSwarmRoles.filter(r => r && r.enabled === false && !SWARM_BUILTIN_ROLES[r.id]),
    agentSwarmRoles.filter(r => r && r.enabled === false && !SWARM_BUILTIN_ROLES[r.id] && !userSwarmRoles.some(u => u.id === r.id))
  );
  // Dedupe by id while keeping merge order
  const seen = new Set();
  const uniq = [];
  for (const r of roles) { if (!seen.has(r.id)) { seen.add(r.id); uniq.push(r); } }
  return _rmResult({
    ok: true,
    action: 'list',
    summary: `${uniq.length} role(s) total — builtin: ${uniq.filter(r => r.builtin).length}, user: ${uniq.filter(r => !r.builtin && r.createdBy !== 'agent' && r.source !== 'agent').length}, agent: ${uniq.filter(r => r.createdBy === 'agent' || r.source === 'agent').length}.`,
    roles: uniq.map(_rmSummarizeRole),
    persistMode: !swarmSettings.agentRolesPersist ? 'memory' : (swarmSettings.agentRolesPerConv ? 'per-conversation' : 'global'),
  });
}
function _rmInspect(input) {
  const id = String(input?.id || '').trim();
  if (!id) return _rmError('inspect', 'Missing "id".');
  const r = findSwarmRoleAny(id);
  if (!r) return _rmError('inspect', `Role "${id}" not found.`);
  return _rmResult({ ok: true, action: 'inspect', role: _rmFullRole(r) });
}
function _rmCreate(input) {
  const incoming = _rmNormalizeIncomingRole(input?.role || {});
  if (!incoming) return _rmError('create', 'Missing "role" object.');
  if (!SWARM_ROLE_ID_PATTERN.test(incoming.id)) return _rmError('create', 'Invalid id; must match /^[a-z][a-z0-9-]{0,47}$/ (kebab-case).');
  if (!incoming.name) return _rmError('create', 'role.name is required.');
  if (!incoming.systemPrompt || incoming.systemPrompt.trim().length < 10) return _rmError('create', 'role.systemPrompt must be at least 10 chars.');
  if (incoming.allowedHandoffs.includes(incoming.id)) return _rmError('create', 'A role cannot hand off to itself.');
  const existingTier = _swarmRoleTier(incoming.id);
  if (existingTier) return _rmError('create', `ID "${incoming.id}" already exists in the ${existingTier} tier.`, { conflict_tier: existingTier });
  if (input?.dry_run) return _rmResult({ ok: true, action: 'create', dry_run: true, role: _rmFullRole(incoming), summary: `Would create agent role "${incoming.id}".` });
  const stored = { ...incoming, source: 'agent', createdBy: 'agent', createdAt: Date.now() };
  agentSwarmRoles.push(stored);
  saveAgentSwarmRoles();
  if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  return _rmResult({ ok: true, action: 'create', summary: `Created agent role "${stored.id}". Persistence: ${!swarmSettings.agentRolesPersist ? 'memory-only' : (swarmSettings.agentRolesPerConv ? 'per-conversation' : 'global localStorage')}.`, role: _rmFullRole(stored) });
}
function _rmUpdate(input) {
  const id = String(input?.id || '').trim();
  if (!id) return _rmError('update', 'Missing "id".');
  const tier = _swarmRoleTier(id);
  if (tier === 'builtin') return _rmError('update', `Built-in role "${id}" cannot be modified.`);
  if (tier === 'user') return _rmError('update', `User-authored role "${id}" can only be edited from the Swarms sidebar UI, not by RoleManager.`);
  if (tier !== 'agent') return _rmError('update', `Role "${id}" not found.`);
  const idx = agentSwarmRoles.findIndex(r => r.id === id);
  if (idx < 0) return _rmError('update', `Agent role "${id}" not found.`);
  const prev = agentSwarmRoles[idx];
  const incoming = _rmNormalizeIncomingRole({ ...prev, ...(input?.role || {}), id });
  if (!incoming) return _rmError('update', 'Missing "role" object.');
  if (!incoming.name) return _rmError('update', 'role.name is required.');
  if (!incoming.systemPrompt || incoming.systemPrompt.trim().length < 10) return _rmError('update', 'role.systemPrompt must be at least 10 chars.');
  if (incoming.allowedHandoffs.includes(id)) return _rmError('update', 'A role cannot hand off to itself.');
  const substantial = _rmIsSubstantialUpdate(prev, incoming);
  if (substantial && input?.confirmed !== true) {
    return _rmResult({ ok: false, action: 'update', needs_confirmation: true, summary: `Substantial change to "${id}" (system prompt or tool/skill set differs significantly). Re-call with confirmed=true to apply.`, role: _rmFullRole(incoming) });
  }
  if (input?.dry_run) return _rmResult({ ok: true, action: 'update', dry_run: true, substantial, role: _rmFullRole(incoming) });
  const next = { ...prev, ...incoming, source: 'agent', createdBy: 'agent', updatedAt: Date.now() };
  agentSwarmRoles[idx] = next;
  saveAgentSwarmRoles();
  if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  return _rmResult({ ok: true, action: 'update', summary: `Updated agent role "${id}".`, substantial, role: _rmFullRole(next) });
}
function _rmDelete(input) {
  const id = String(input?.id || '').trim();
  if (!id) return _rmError('delete', 'Missing "id".');
  const tier = _swarmRoleTier(id);
  if (tier === 'builtin') return _rmError('delete', `Built-in role "${id}" cannot be deleted.`);
  if (tier === 'user') return _rmError('delete', `User-authored role "${id}" must be deleted from the Swarms sidebar UI, not by RoleManager.`);
  if (tier !== 'agent') return _rmError('delete', `Role "${id}" not found.`);
  if (input?.confirmed !== true) {
    return _rmResult({ ok: false, action: 'delete', needs_confirmation: true, summary: `Re-call delete with confirmed=true to remove agent role "${id}".` });
  }
  if (input?.dry_run) return _rmResult({ ok: true, action: 'delete', dry_run: true, summary: `Would delete agent role "${id}".` });
  agentSwarmRoles = agentSwarmRoles.filter(r => r.id !== id);
  saveAgentSwarmRoles();
  if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  return _rmResult({ ok: true, action: 'delete', summary: `Deleted agent role "${id}".` });
}
function _rmDuplicate(input) {
  const srcId = String(input?.id || '').trim();
  if (!srcId) return _rmError('duplicate', 'Missing source "id".');
  const src = findSwarmRoleAny(srcId);
  if (!src) return _rmError('duplicate', `Source role "${srcId}" not found.`);
  let newId = String(input?.newId || '').trim();
  if (newId) {
    if (!SWARM_ROLE_ID_PATTERN.test(newId)) return _rmError('duplicate', 'newId must match /^[a-z][a-z0-9-]{0,47}$/.');
    if (_swarmRoleTier(newId)) return _rmError('duplicate', `newId "${newId}" already exists.`);
  } else {
    let baseNew = src.id + '-copy';
    newId = baseNew;
    let n = 2;
    while (_swarmRoleTier(newId)) { newId = baseNew + '-' + n++; }
  }
  const copy = {
    id: newId,
    name: (src.name || src.id) + ' (copy)',
    description: src.description || '',
    systemPrompt: src.systemPrompt || '',
    allowedTools: Array.isArray(src.allowedTools) ? [...src.allowedTools] : [],
    allowedHandoffs: Array.isArray(src.allowedHandoffs) ? [...src.allowedHandoffs] : [],
    bindSkills: Array.isArray(src.bindSkills) ? [...src.bindSkills] : [],
    maxSteps: src.maxSteps || 6,
    tokenBudget: src.tokenBudget || 60000,
    defaultModel: src.defaultModel || undefined,
    enabled: true,
    source: 'agent', createdBy: 'agent', createdAt: Date.now(),
  };
  if (input?.dry_run) return _rmResult({ ok: true, action: 'duplicate', dry_run: true, role: _rmFullRole(copy), summary: `Would duplicate "${srcId}" into agent role "${newId}".` });
  agentSwarmRoles.push(copy);
  saveAgentSwarmRoles();
  if (typeof renderSwarmRoles === 'function') renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  return _rmResult({ ok: true, action: 'duplicate', summary: `Duplicated "${srcId}" into agent role "${newId}".`, role: _rmFullRole(copy) });
}

// ─── Blackboard tools (per-swarm-run shared workspace) ─────────────────────
function _bbEntryDisplay(e) {
  const claimed = e.claimedBy ? ` [claimed by ${e.claimedRole || e.claimedBy}]` : '';
  const tags = e.tags.length ? ' ' + e.tags.map(t => '#' + t).join(' ') : '';
  const src = e.sourceRole ? `${e.sourceRole}` : (e.source || 'unknown');
  return `[${e.id}] (${e.type}) ${e.key || '(no key)'} by ${src}${tags}${claimed}`;
}
async function toolBbWrite(input) {
  if (!swarmSettings.enabled) return 'Error: Agent Swarm is disabled.';
  if (!swarmRunActive) startSwarmRun();
  const key = String(input?.key || '').trim();
  const content = String(input?.content || '').trim();
  if (!content) return 'Error: bb_write requires "content".';
  const type = String(input?.type || 'note').trim();
  if (!['note', 'result', 'task'].includes(type)) return `Error: invalid type "${type}". Use note | result | task.`;
  const tags = Array.isArray(input?.tags) ? input.tags : [];
  const src = _bbCurrentSourceLabel();
  const r = _bbAddEntry({ type, key, content, tags, source: src.source, sourceRole: src.sourceRole });
  if (r.error) return `Error: ${r.error}`;
  return `Wrote ${r.entry.id} :: ${type} :: ${key || '(no key)'} (${r.entry.content.length} chars). Total entries: ${swarmRunActive.blackboard.entries.length}.`;
}
async function toolBbRead(input) {
  if (!swarmSettings.enabled) return 'Error: Agent Swarm is disabled.';
  if (!swarmRunActive) return 'No active swarm run; the blackboard is empty.';
  const limit = Math.max(1, Math.min(Number(input?.limit) || 8, 20));
  const matches = _bbFilter({ query: input?.query, key: input?.key, tags: input?.tags, type: input?.type, since: input?.since, limit });
  if (!matches.length) return 'No matching blackboard entries.';
  return matches.map(e => `${_bbEntryDisplay(e)}\n${e.content}`).join('\n\n---\n\n');
}
async function toolBbList(input) {
  if (!swarmSettings.enabled) return 'Error: Agent Swarm is disabled.';
  if (!swarmRunActive) return 'No active swarm run; the blackboard is empty.';
  const matches = _bbFilter({ query: input?.query, type: input?.type, tags: input?.tags, limit: 50 });
  if (!matches.length) return 'Blackboard is empty.';
  const head = `Blackboard: ${swarmRunActive.blackboard.entries.length} entries (showing ${matches.length}, newest first)`;
  return [head, ...matches.map(_bbEntryDisplay)].join('\n');
}
async function toolBbPostTask(input) {
  if (!swarmSettings.enabled) return 'Error: Agent Swarm is disabled.';
  if (!swarmRunActive) startSwarmRun();
  const brief = String(input?.brief || '').trim();
  if (!brief) return 'Error: bb_post_task requires "brief".';
  const key = String(input?.key || '').trim() || `task-${swarmRunActive.blackboard.seq + 1}`;
  const tags = Array.isArray(input?.tags) ? input.tags : [];
  const src = _bbCurrentSourceLabel();
  const r = _bbAddEntry({ type: 'task', key, content: brief, tags, source: src.source, sourceRole: src.sourceRole });
  if (r.error) return `Error: ${r.error}`;
  return `Posted task ${r.entry.id} (key=${key}). Other workers can call bb_claim with id="${r.entry.id}" to take it.`;
}
async function toolBbClaim(input) {
  if (!swarmSettings.enabled) return 'Error: Agent Swarm is disabled.';
  if (!swarmRunActive) return 'Error: No active swarm run.';
  const id = String(input?.id || '').trim();
  if (!id) return 'Error: bb_claim requires "id".';
  const bb = _bbGet();
  const e = bb?.entries.find(x => x.id === id);
  if (!e) return `Error: No blackboard entry with id "${id}".`;
  if (e.type !== 'task') return `Error: Entry ${id} is not a task (type=${e.type}).`;
  if (e.claimedBy) return `Error: Task ${id} already claimed by ${e.claimedRole || e.claimedBy}.`;
  const src = _bbCurrentSourceLabel();
  e.claimedBy = src.source;
  e.claimedRole = src.sourceRole;
  e.claimedAt = Date.now();
  return `Claimed task ${id}.\nKey: ${e.key}\nBrief: ${e.content}\n\nWhen finished, write your result with bb_write({type:"result", key:"${e.key}", content:..., tags:["from:${id}"]}).`;
}

function _remoteToolFilePaths(filePath) {
  const raw = String(filePath || '').trim().replace(/\\/g, '/');
  const normalized = normPath(raw || '/');
  if (normalized === DAYTONA_WORKSPACE || normalized.startsWith(DAYTONA_WORKSPACE + '/')) {
    const rel = normalized.slice(DAYTONA_WORKSPACE.length) || '/';
    return { raw, vfsPath: normPath(rel), remotePath: normalized };
  }
  const vfsPath = normalized;
  return { raw, vfsPath, remotePath: DAYTONA_WORKSPACE + (vfsPath === '/' ? '' : vfsPath) };
}

function _rememberRemoteShadow(convId, vfsPath, root = vfs) {
  const sess = window._daytonaSessions?.[convId];
  if (!sess || !vfsPath || vfsPath === '/') return;
  if (!sess.syncedIn) sess.syncedIn = new Map();
  const node = vfsResolve(vfsPath, root);
  if (node?.type === 'file') sess.syncedIn.set(vfsPath, _vfsFingerprint(node));
}

function _formatReadText(text, input) {
  let lines = String(text || '').split('\n');
  const off = Math.max(0, Number(input?.offset) || 0);
  const lim = input?.limit == null ? lines.length : Math.max(0, Number(input.limit) || 0);
  lines = lines.slice(off, off + lim);
  return lines.map((l, i) => `${String(off + i + 1).padStart(5)}\t${l}`).join('\n');
}

function _readVfsForTool(input, filePath, root = vfs) {
  const stat = vfsStat(filePath, root);
  if (!stat) return { ok: false, output: `File not found: ${filePath}` };
  if (stat.type !== 'file') return { ok: false, output: `Not a file: ${filePath}` };
  if (stat.binary) return { ok: true, output: `[Binary file: ${stat.path}, ${stat.size} bytes]`, binary: true };
  const r = vfsRead(filePath, root);
  if (r.error) return { ok: false, output: r.error };
  return { ok: true, output: _formatReadText(r.content, input), text: r.content };
}

async function _copyVfsFileToRemote(convId, paths, root = vfs) {
  const node = vfsResolve(paths.vfsPath, root);
  if (!node || node.type !== 'file') return false;
  if (node.binary) {
    const bytes = await vfsGetBinary(paths.vfsPath, root);
    if (!bytes) return false;
    await daytonaClient.writeFile(convId, paths.remotePath, bytes);
  } else {
    await daytonaClient.writeFile(convId, paths.remotePath, node.content || '');
  }
  _rememberRemoteShadow(convId, paths.vfsPath, root);
  return true;
}

// Push the local VFS version of one file into the sandbox iff its fingerprint
// differs from what was last uploaded. Used by Read/Edit Remote to guarantee
// the sandbox is not older than the VFS at read time — otherwise a stale
// sandbox copy would silently overwrite a fresher VFS edit (e.g. the user
// just typed into the editor) when the result is shadowed back.
async function _pushVfsToSandboxIfDirty(convId, paths, root = vfs) {
  const sess = window._daytonaSessions?.[convId];
  if (!sess || !paths?.vfsPath || paths.vfsPath === '/') return false;
  if (!sess.syncedIn) sess.syncedIn = new Map();
  const node = vfsResolve(paths.vfsPath, root);
  if (!node || node.type !== 'file') return false;
  if (sess.syncedIn.get(paths.vfsPath) === _vfsFingerprint(node)) return false;
  return _copyVfsFileToRemote(convId, paths, root);
}

async function _shadowRemoteBytes(convId, paths, bytes, root = vfs) {
  if (!paths.vfsPath || paths.vfsPath === '/') return;
  await _writeRemoteBytesToVfs(root, paths.vfsPath, bytes);
  if (root === vfs) renderFileTree();
  _rememberRemoteShadow(convId, paths.vfsPath, root);
}

async function _reconcileBeforeRemoteFileTool(convId, root, run) {
  if (!window._daytonaSessions?.[convId]) return [];
  const result = await syncVfsFromRemote(convId, root);
  if (run) activateConversationRun(run);
  await _refreshDaytonaSyncUi(convId, root, result);
  if (result.incomplete) throw new Error('remote file state was incomplete; no local file was uploaded. ' + result.warnings.join(' '));
  return result.warnings;
}

async function toolReadRemote(input) {
  const run = currentRunContext;
  const convId = run?.convId || activeConvId;
  if (!convId) return 'Error: no active conversation to bind a remote sandbox to.';
  const root = run?.state?.vfs || vfs;
  const fp = input?.file_path || '';
  if (!String(fp).trim()) return 'Error: file_path is required.';
  const paths = _remoteToolFilePaths(fp);
  const syncWarnings = [];
  const finish = output => _appendDaytonaSyncWarnings(output, syncWarnings);
  try {
    syncWarnings.push(...await _reconcileBeforeRemoteFileTool(convId, root, run));
    await _pushVfsToSandboxIfDirty(convId, paths, root);
  }
  catch (e) { return finish(`Error (sandbox pre-sync ${paths.remotePath}): ${e?.message || e}`); }
  if (run) activateConversationRun(run);
  try {
    const bytes = await daytonaClient.readFile(convId, paths.remotePath, true);
    if (run) activateConversationRun(run);
    await _shadowRemoteBytes(convId, paths, bytes, root);
    if (!_looksLikeText(bytes)) return finish(`[Binary file: ${paths.vfsPath}, ${bytes.length} bytes]`);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return finish(_formatReadText(text, input));
  } catch (e) {
    if (run) activateConversationRun(run);
    const local = _readVfsForTool(input, paths.vfsPath, root);
    if (local.ok) {
      try { await _copyVfsFileToRemote(convId, paths, root); }
      catch (copyError) { syncWarnings.push('Could not restore ' + paths.vfsPath + ' to the sandbox: ' + (copyError?.message || copyError)); }
      return finish(local.output);
    }
    return finish(`File not found in sandbox or VFS: ${fp}\nSandbox path: ${paths.remotePath}\nSandbox error: ${e?.message || e}`);
  }
}

async function toolWriteRemote(input) {
  const run = currentRunContext;
  const convId = run?.convId || activeConvId;
  if (!convId) return 'Error: no active conversation to bind a remote sandbox to.';
  const root = run?.state?.vfs || vfs;
  if (!String(input?.file_path || '').trim()) return 'Error: file_path is required.';
  const paths = _remoteToolFilePaths(input?.file_path || '');
  const content = String(input?.content ?? '');
  try {
    await daytonaClient.writeFile(convId, paths.remotePath, content);
    if (run) activateConversationRun(run);
  } catch (e) {
    return `Error (sandbox Write ${paths.remotePath}): ${e?.message || e}`;
  }
  const r = vfsWrite(paths.vfsPath, content, false, root);
  if (r.error) return r.error;
  _rememberRemoteShadow(convId, paths.vfsPath, root);
  return `File created in sandbox at: ${paths.remotePath} (VFS shadow: ${r.path}, ${r.bytes} bytes)`;
}

async function toolEditRemote(input) {
  const run = currentRunContext;
  const convId = run?.convId || activeConvId;
  if (!convId) return 'Error: no active conversation to bind a remote sandbox to.';
  const root = run?.state?.vfs || vfs;
  if (!String(input?.file_path || '').trim()) return 'Error: file_path is required.';
  const paths = _remoteToolFilePaths(input?.file_path || '');
  const oldStr = String(input?.old_str ?? '');
  const newStr = String(input?.new_str ?? '');
  if (!oldStr) return 'Error: old_str is required.';
  const syncWarnings = [];
  const finish = output => _appendDaytonaSyncWarnings(output, syncWarnings);
  try {
    syncWarnings.push(...await _reconcileBeforeRemoteFileTool(convId, root, run));
    await _pushVfsToSandboxIfDirty(convId, paths, root);
  }
  catch (e) { return finish(`Error (sandbox pre-sync ${paths.remotePath}): ${e?.message || e}`); }
  if (run) activateConversationRun(run);
  let content = '';
  try {
    const bytes = await daytonaClient.readFile(convId, paths.remotePath, true);
    if (run) activateConversationRun(run);
    if (!_looksLikeText(bytes)) return finish(`Error: cannot edit binary file in sandbox: ${paths.remotePath}`);
    content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (e) {
    if (run) activateConversationRun(run);
    const local = vfsRead(paths.vfsPath, root);
    if (local.error) return finish(`Error: file not found in sandbox or VFS: ${paths.raw || input?.file_path || ''}\nSandbox path: ${paths.remotePath}\nSandbox error: ${e?.message || e}`);
    content = local.content || '';
  }
  const c = content.split(oldStr).length - 1;
  if (c === 0) return finish(`Error: old_str not found in ${paths.remotePath}`);
  if (c > 1) return finish(`Error: old_str matches ${c} locations in ${paths.remotePath}. Make it more specific.`);
  const next = content.replace(oldStr, newStr);
  try {
    await daytonaClient.writeFile(convId, paths.remotePath, next);
    if (run) activateConversationRun(run);
  } catch (e) {
    return finish(`Error (sandbox Edit ${paths.remotePath}): ${e?.message || e}`);
  }
  vfsWrite(paths.vfsPath, next, false, root);
  _rememberRemoteShadow(convId, paths.vfsPath, root);
  return finish(`Successfully edited sandbox file ${paths.remotePath} (VFS shadow: ${paths.vfsPath})`);
}

async function toolRead(input) {
  const fp = input?.file_path || '';
  if (!String(fp).trim()) return 'Error: file_path is required.';
  // L3 progressive loading: @skill:name/references/file.md or @skill:name/scripts/file.py
  if (fp.startsWith('@skill:')) {
    const ref = resolveSkillReference(fp);
    if (ref) { logMemEntry('read', `L3 skill ref: ${fp}`); return ref; }
    const scr = resolveSkillScript(fp);
    if (scr) { logMemEntry('read', `L3 skill script: ${fp}`); return scr; }
    return `Error: Skill resource not found: ${fp}`;
  }
  if (isRemoteSandbox()) return await toolReadRemote(input);
  const local = _readVfsForTool(input, fp);
  return local.output;
}
async function toolWrite(input) {
  if (!String(input?.file_path || '').trim()) return 'Error: file_path is required.';
  if (isRemoteSandbox()) return await toolWriteRemote(input);
  const r = vfsWrite(input.file_path, input.content);
  if (r.error) return r.error;
  return `File created successfully at: ${r.path} (${r.bytes} bytes)`;
}
async function toolEdit(input) {
  if (!String(input?.file_path || '').trim()) return 'Error: file_path is required.';
  if (isRemoteSandbox()) return await toolEditRemote(input);
  const p = normPath(input.file_path);
  const r = vfsRead(p);
  if (r.error) return r.error;
  const c = r.content.split(input.old_str).length - 1;
  if (c === 0) return `Error: old_str not found in ${p}`;
  if (c > 1) return `Error: old_str matches ${c} locations. Make it more specific.`;
  vfsWrite(p, r.content.replace(input.old_str, input.new_str));
  return `Successfully edited ${p}`;
}
function toolGlob(input) { const r = vfsGlob(input.pattern, input.path); return r.length ? r.join('\n') : 'No files matched.'; }
function toolGrep(input) { const r = vfsGrep(input.pattern, input.path, input.include); return r.length ? r.join('\n') : 'No matches found.'; }

// ─── Web Search (Tavily) ────────────────────────────────────────────────────
// API key lives server-side in Dify plugin settings; browser calls /search proxy.
let wsConfig = { depth: 'basic', maxResults: 5 };

function loadWsConfig() {
  try { const s = localStorage.getItem('ba_ws_config'); if (s) { const p = JSON.parse(s); wsConfig.depth = p.depth || wsConfig.depth; wsConfig.maxResults = p.maxResults || wsConfig.maxResults; } } catch {}
  const dEl = document.getElementById('wsDepth');
  const rEl = document.getElementById('wsMaxResults');
  if (dEl) dEl.value = wsConfig.depth;
  if (rEl) rEl.value = String(wsConfig.maxResults);
  updateWsStatus();
}

function saveWsConfig() {
  wsConfig.depth = document.getElementById('wsDepth').value;
  wsConfig.maxResults = parseInt(document.getElementById('wsMaxResults').value) || 5;
  try { localStorage.setItem('ba_ws_config', JSON.stringify(wsConfig)); } catch {}
}

function updateWsStatus() {
  const el = document.getElementById('wsStatus');
  if (!el) return;
  el.removeAttribute('data-i18n');
  if (_keys?.tavily_api_key) {
    el.textContent = '\u25CF ' + t('ws.ready');
    el.className = 'ws-status ok';
  } else {
    el.textContent = t('ws.notConfigured');
    el.className = 'ws-status err';
  }
}

async function toolWebSearch(input) {
  if (!_keys?.tavily_api_key) return 'Error: Tavily API key not configured. Add it in the Dify plugin settings (tavily_api_key).';
  const body = {
    query: input.query,
    search_depth: input.search_depth || wsConfig.depth || 'basic',
    max_results: input.max_results || wsConfig.maxResults || 5,
    api_key: _keys.tavily_api_key,
  };
  if (input.include_domains && input.include_domains.length) body.include_domains = input.include_domains;
  if (input.exclude_domains && input.exclude_domains.length) body.exclude_domains = input.exclude_domains;
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      return `WebSearch error (${resp.status}): ${errText}`;
    }
    const data = await resp.json();
    if (data.error) return `WebSearch error: ${data.error}`;
    if (!data.results || !data.results.length) return 'No results found.';
    return data.results.map((r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content || r.snippet || ''}`
    ).join('\n\n');
  } catch (e) {
    return `WebSearch error: ${e.message}`;
  }
}

async function toolFetch(input) {
  let url;
  try {
    url = new URL(input.url);
  } catch {
    return 'Fetch error: invalid URL.';
  }
  if (!/^https?:$/.test(url.protocol)) return 'Fetch error: only HTTP and HTTPS URLs are supported.';
  const maxChars = Math.max(500, Math.min(Number(input.max_chars) || 12000, 50000));
  try {
    const resp = await fetch(url.toString(), { redirect: 'follow' });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      return `Fetch error (${resp.status}): ${errText.slice(0, 500)}`;
    }
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const raw = await resp.text();
    if (!raw) return `URL: ${url.toString()}\n\n(no content)`;
    if (!contentType.includes('html')) {
      return `URL: ${url.toString()}\nContent-Type: ${contentType || 'unknown'}\n\n${raw.slice(0, maxChars)}`;
    }
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,canvas,iframe').forEach(node => node.remove());
    const title = (doc.querySelector('title')?.textContent || '').trim();
    const bodyText = (doc.body?.innerText || doc.documentElement?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
    const text = bodyText.slice(0, maxChars) || '(no readable text content)';
    return `${title ? `Title: ${title}\n` : ''}URL: ${url.toString()}\n\n${text}`;
  } catch (e) {
    return `Fetch error: ${e.message}`;
  }
}

function buildUnattendedHitlResult(input) {
  const state = _normalizeHitlInput(input);
  const reason = 'Ralph Loop is active; no human input is available. Proceed with safe assumptions or stop with a blocker.';
  if (state.mode === 'confirm') return { status: 'unattended', mode: 'confirm', confirmed: false, answer: 'no', reason };
  if (state.mode === 'choice') {
    if (state.defaultChoice) {
      const idx = state.choices.indexOf(state.defaultChoice);
      return { status: 'unattended', mode: 'choice', answer: state.defaultChoice, choice_index: idx >= 0 ? idx : null, custom: idx < 0, reason };
    }
    return { status: 'cancelled', mode: 'choice', answer: '', reason };
  }
  if (state.defaultChoice) return { status: 'unattended', mode: 'text', answer: state.defaultChoice, reason };
  return { status: 'cancelled', mode: 'text', answer: '', reason };
}
async function toolAskUser(input) {
  const run = currentRunContext;
  const prompt = String(input?.prompt || '').trim();
  if (!prompt) return 'Error: "prompt" is required.';
  if (ralphRun?.active) return JSON.stringify(buildUnattendedHitlResult({ ...(input || {}), prompt }), null, 2);
  const result = await showHitlModal({ ...(input || {}), prompt });
  if (run) activateConversationRun(run);
  return JSON.stringify(result, null, 2);
}

function _formatCronTaskForTool(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    cron: t.cron,
    prompt: t.prompt,
    recurring: !!t.recurring,
    enabled: !!t.enabled,
    createdBy: t.createdBy || 'user',
    nextFireAt: t.nextFireAt || null,
    nextFireAtISO: t.nextFireAt ? new Date(t.nextFireAt).toISOString() : null,
    lastFiredAt: t.lastFiredAt || null,
    lastFiredAtISO: t.lastFiredAt ? new Date(t.lastFiredAt).toISOString() : null,
    fireCount: t.fireCount || 0,
    modelOverride: t.modelOverride || null,
    maxRunMinutes: t.maxRunMinutes || null,
    folderId: t.folderId || null
  };
}

async function toolCronCreate(input) {
  const name = String(input.name || '').trim();
  const cron = String(input.cron || '').trim();
  const prompt = String(input.prompt || '').trim();
  if (!name) return 'Error: "name" is required.';
  if (!cron) return 'Error: "cron" is required (5-field expression).';
  if (!prompt) return 'Error: "prompt" is required.';
  if (!CronScheduler.parseCron(cron)) return `Error: invalid cron expression "${cron}". Format: "minute hour day-of-month month day-of-week".`;
  const next = CronScheduler.nextFireTime(cron, Date.now());
  if (!next) return 'Error: cron expression has no future match within 1 year.';
  const recurring = input.recurring !== false;
  // Confirmation gate (skipped under Ralph)
  if (input.confirmed !== true && !ralphRun?.active) {
    const summary = `Create scheduled task "${name}"\n` +
      `Cron: ${cron} (next fire: ${new Date(next).toLocaleString()})\n` +
      `Recurring: ${recurring}\n` +
      `Prompt: ${prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt}` +
      (input.modelOverride ? `\nModel override: ${input.modelOverride}` : '');
    const ans = await showHitlModal({ prompt: 'Approve creation of this scheduled task?', mode: 'confirm', context: summary });
    if (!ans || ans.status !== 'answered' || !ans.confirmed) {
      return JSON.stringify({ ok: false, status: 'cancelled', reason: 'User did not approve task creation.' }, null, 2);
    }
  }
  try {
    const created = CronScheduler.addTask({
      name, cron, prompt, recurring,
      modelOverride: input.modelOverride,
      maxRunMinutes: input.maxRunMinutes,
      folderId: input.folderId,
      createdBy: 'agent'
    });
    if (!CronScheduler.isEnabledGlobally()) {
      // Auto-enable on first agent-created task? No — leave it user-controlled.
    }
    try { if (typeof renderCronTasksList === 'function') renderCronTasksList(); } catch {}
    const out = {
      ok: true,
      task: _formatCronTaskForTool(created),
      note: CronScheduler.isEnabledGlobally() ? 'Scheduler is enabled — task will fire at nextFireAt.' : 'Scheduler is currently DISABLED globally; the task will not fire until the user enables Scheduled Tasks in Settings.'
    };
    return JSON.stringify(out, null, 2);
  } catch (e) {
    return `Error: ${e?.message || e}`;
  }
}

async function toolCronDelete(input) {
  const id = String(input.id || '').trim();
  if (!id) return 'Error: "id" is required.';
  const cur = CronScheduler.getTask(id);
  if (!cur) return JSON.stringify({ ok: false, reason: 'Task not found', id }, null, 2);
  if (input.confirmed !== true && !ralphRun?.active) {
    const summary = `Delete scheduled task "${cur.name}"?\nCron: ${cur.cron}\nPrompt: ${cur.prompt.length > 200 ? cur.prompt.slice(0, 200) + '...' : cur.prompt}`;
    const ans = await showHitlModal({ prompt: 'Approve deletion?', mode: 'confirm', context: summary });
    if (!ans || ans.status !== 'answered' || !ans.confirmed) {
      return JSON.stringify({ ok: false, status: 'cancelled', reason: 'User did not approve deletion.', id }, null, 2);
    }
  }
  const ok = CronScheduler.removeTask(id);
  try { if (typeof renderCronTasksList === 'function') renderCronTasksList(); } catch {}
  return JSON.stringify({ ok, id }, null, 2);
}

async function toolCronList() {
  const tasks = CronScheduler.listTasks().map(_formatCronTaskForTool);
  return JSON.stringify({
    ok: true,
    enabledGlobally: CronScheduler.isEnabledGlobally(),
    count: tasks.length,
    tasks
  }, null, 2);
}

function toolTodoWrite(input) {
  if (!input || !Array.isArray(input.todos)) return 'Error: todos must be an array of {content, activeForm, status}.';
  const valid = ['pending', 'in_progress', 'completed'];
  todos = input.todos.map((t, i) => ({
    id: 'td_' + i,
    content: String(t.content || '').slice(0, 500),
    activeForm: String(t.activeForm || t.content || '').slice(0, 500),
    status: valid.includes(t.status) ? t.status : 'pending'
  }));
  if (typeof renderTodos === 'function') renderTodos();
  saveCurrentConv();
  const counts = todos.reduce((a, t) => { a[t.status] = (a[t.status] || 0) + 1; return a; }, {});
  return `Todos updated: ${counts.completed || 0} done, ${counts.in_progress || 0} in progress, ${counts.pending || 0} pending.`;
}

async function toolExitPlanMode(input) {
  const run = currentRunContext;
  if (!planMode) return 'Error: Plan Mode is not active. You do not need to call ExitPlanMode.';
  const plan = String(input?.plan || '').trim();
  if (!plan) return 'Error: "plan" is required and must be the full plan as Markdown.';
  if (ralphRun?.active) return 'Error: Ralph Loop is active and cannot approve Plan Mode unattended. Continue read-only if useful, otherwise stop with a clear blocker and ask the user to disable Plan Mode or approve manually.';
  const verdict = await showPlanApprovalModal(plan);
  if (run) activateConversationRun(run);
  if (verdict.approved) {
    planMode = false;
    if (typeof renderPlanButton === 'function') renderPlanButton();
    if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
    return 'Plan approved by user. Plan Mode has been disabled. You may now execute write tools to implement the plan.';
  }
  return `Plan rejected by user. Feedback:\n${verdict.feedback || '(no feedback given)'}\n\nStay in Plan Mode and revise the plan, then call ExitPlanMode again.`;
}

async function wsTestSearch() {
  saveWsConfig();
  const q = (document.getElementById('wsQuery').value || '').trim();
  const el = document.getElementById('wsResults');
  if (!q) { el.innerHTML = '<div class="ws-result-item" style="border-left-color:var(--text-dim)"><a style="color:var(--text-dim)">Enter a query above.</a></div>'; return; }
  el.innerHTML = '<div class="ws-result-item"><a style="color:var(--text-secondary)">Searching\u2026</a></div>';
  const result = await toolWebSearch({ query: q });
  if (result.startsWith('Error') || result.startsWith('WebSearch')) {
    el.innerHTML = `<div class="ws-result-item" style="border-left-color:var(--accent-red)"><a style="color:var(--accent-red)">${esc(result)}</a></div>`;
    return;
  }
  const items = result.split('\n\n').filter(Boolean);
  el.innerHTML = items.map(item => {
    const lines = item.split('\n');
    const title = (lines[0] || '').replace(/^\[\d+\]\s*/, '');
    const urlLine = lines.find(l => l.startsWith('URL: '));
    const url = urlLine ? urlLine.replace('URL: ', '') : '#';
    const snippet = lines.filter(l => !l.match(/^\[\d+\]/) && !l.startsWith('URL:')).join(' ').trim();
    return `<div class="ws-result-item"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a><div class="ws-snippet">${esc(snippet)}</div></div>`;
  }).join('');
}

async function toolBash(input) {
  const cmd = (input.command || '').trim(); if (!cmd) return '';
  if (cmd.includes('&&')) { let out = ''; for (const p of cmd.split('&&').map(s => s.trim())) { const r = await execBash(p); if (r.startsWith('Error:') || r.startsWith('bash:')) return out ? out + '\n' + r : r; out += (out ? '\n' : '') + r; } return out; }
  if (cmd.includes(';')) { const pieces = cmd.split(';').map(s => s.trim()); const outs = []; for (const p of pieces) { const r = await execBash(p); if (r) outs.push(r); } return outs.join('\n'); }
  return execBash(cmd);
}

async function execBash(cmd) {
  if (!cmd) return '';
  const tk = shellTokenize(cmd), nm = tk[0], args = tk.slice(1);
  const statOrError = (p) => {
    const st = vfsStat(p);
    return st || { error: `Not found: ${p}` };
  };
  const fileTextOrBinaryMsg = (p) => {
    const st = statOrError(p);
    if (st.error) return st.error;
    if (st.type !== 'file') return `Not a file: ${p}`;
    if (st.binary) return `cat: ${p}: binary file (${st.size} bytes)`;
    const r = vfsRead(p);
    return r.error || r.content;
  };
  switch (nm) {
    case 'pwd': return cwd;
    case 'cd': { const t = args[0] || '/'; const p = normPath(t); const n = vfsResolve(p); if (!n || n.type !== 'dir') return `bash: cd: ${t}: No such directory`; cwd = p; return ''; }
    case 'ls': {
      let al = false, ll = false; const ps = [];
      for (const a of args) { if (a.startsWith('-')) { if (a.includes('a')) al = true; if (a.includes('l')) ll = true; } else ps.push(a); }
      const t = ps[0] || cwd; const n = vfsResolve(t);
      if (!n) return `ls: cannot access '${t}': No such file or directory`;
      if (n.type === 'file') return t.split('/').pop();
      const es = Object.entries(n.children).sort((a,b) => a[0].localeCompare(b[0]));
      if (!es.length) return '';
      if (ll) return es.map(([nm,c]) => {
        const size = c.type === 'file' ? (c.binary ? (c.size ?? (c.bytes ? c.bytes.length : 0)) : (c.content || '').length) : 0;
        return `${c.type==='dir'?'d':'-'}rw-r--r-- ${String(size).padStart(8)} ${nm}${c.type==='dir'?'/':''}`;
      }).join('\n');
      return es.map(([nm,c]) => nm + (c.type==='dir'?'/':'')).join('  ');
    }
    case 'cat': { if (!args.length) return 'cat: missing file operand'; return args.map(a => fileTextOrBinaryMsg(a)).join('\n'); }
    case 'head': {
      let n = 10; const fs = [];
      for (let i = 0; i < args.length; i++) { if (args[i] === '-n' && args[i+1]) n = parseInt(args[++i]) || 10; else if (args[i].match(/^-\d+$/)) n = parseInt(args[i].slice(1)); else fs.push(args[i]); }
      if (!fs.length) return 'head: missing file';
      return fs.map(f => {
        const st = statOrError(f); if (st.error) return st.error; if (st.binary) return `head: ${f}: binary file (${st.size} bytes)`;
        const r = vfsRead(f); return r.error || r.content.split('\n').slice(0, n).join('\n');
      }).join('\n');
    }
    case 'tail': {
      let n = 10; const fs = [];
      for (let i = 0; i < args.length; i++) { if (args[i] === '-n' && args[i+1]) n = parseInt(args[++i]) || 10; else if (args[i].match(/^-\d+$/)) n = parseInt(args[i].slice(1)); else fs.push(args[i]); }
      if (!fs.length) return 'tail: missing file';
      return fs.map(f => {
        const st = statOrError(f); if (st.error) return st.error; if (st.binary) return `tail: ${f}: binary file (${st.size} bytes)`;
        const r = vfsRead(f); if (r.error) return r.error; const ls = r.content.split('\n'); return ls.slice(Math.max(0, ls.length - n)).join('\n');
      }).join('\n');
    }
    case 'wc': {
      const fl = args.includes('-l'); const fs = args.filter(a => !a.startsWith('-'));
      if (!fs.length) return 'wc: missing file';
      return fs.map(f => {
        const st = statOrError(f); if (st.error) return st.error; if (st.type !== 'file') return `Not a file: ${f}`;
        if (st.binary) return fl ? `0 ${f}` : `0 0 ${st.size} ${f}`;
        const r = vfsRead(f); if (r.error) return r.error;
        const ls = r.content.split('\n').length;
        return fl ? `${ls} ${f}` : `${ls} ${r.content.split(/\s+/).filter(Boolean).length} ${r.content.length} ${f}`;
      }).join('\n');
    }
    case 'echo': return args.join(' ');
    case 'mkdir': { args.filter(a => !a.startsWith('-')).forEach(d => vfsMkdir(d)); return ''; }
    case 'touch': { args.forEach(f => { if (!vfsResolve(normPath(f))) vfsWrite(f, ''); }); return ''; }
    case 'rm': { const ts = args.filter(a => !a.startsWith('-')); return ts.map(t => { const r = vfsDelete(t); return r.error || ''; }).filter(Boolean).join('\n'); }
    case 'cp': {
      if (args.length < 2) return 'cp: missing operand';
      const rootVfs = vfs; // capture before any await; a concurrent run may swap global vfs during the graft
      const src = vfsResolve(args[0]);
      if (!src) return `cp: not found: ${args[0]}`;
      if (src.type !== 'file') return `Not a file: ${args[0]}`;
      const dstPath = normPath(args[1]);
      const parts = dstPath.slice(1).split('/'); const fn = parts.pop();
      let n = rootVfs;
      for (const p of parts) { if (!n.children[p]) n.children[p] = { type: 'dir', children: {} }; n = n.children[p]; }
      await _vfsGraftNode(src, n, fn);
      if (vfs === rootVfs) renderFileTree();
      return '';
    }
    case 'mv': {
      if (args.length < 2) return 'mv: missing operand';
      const rootVfs = vfs; // capture before any await; global vfs may be swapped by a concurrent run mid-graft
      const src = vfsResolve(args[0]);
      if (!src) return `mv: not found: ${args[0]}`;
      if (src.type !== 'file') return `Not a file: ${args[0]}`;
      // Resolve the source's parent + key against the captured tree NOW, so the
      // post-graft delete removes the original from the same conversation's VFS
      // (not whichever tree happens to be global after the await).
      const srcNorm = normPath(args[0]);
      const srcParts = srcNorm.slice(1).split('/'); const srcKey = srcParts.pop();
      let srcParent = rootVfs;
      for (const p of srcParts) { srcParent = (srcParent && srcParent.children) ? srcParent.children[p] : null; }
      const dstPath = normPath(args[1]);
      const parts = dstPath.slice(1).split('/'); const fn = parts.pop();
      let n = rootVfs;
      for (const p of parts) { if (!n.children[p]) n.children[p] = { type: 'dir', children: {} }; n = n.children[p]; }
      await _vfsGraftNode(src, n, fn);
      if (srcParent && srcParent.children && srcParent.children[srcKey]) {
        _unrefVfsSubtree(srcParent.children[srcKey]);
        delete srcParent.children[srcKey];
      }
      if (vfs === rootVfs) renderFileTree();
      return '';
    }
    case 'find': { let bp = '.', np = '*'; for (let i = 0; i < args.length; i++) { if (args[i] === '-name' && args[i+1]) np = args[++i]; else if (!args[i].startsWith('-')) bp = args[i]; } return vfsGlob('**/' + np, bp).join('\n'); }
    case 'tree': { const t = args[0] || cwd; const n = vfsResolve(t); if (!n || n.type !== 'dir') return `tree: ${t}: not a directory`; const ls = [normPath(t)]; (function d(nd, pfx) { const es = Object.entries(nd.children || {}).sort((a,b) => a[0].localeCompare(b[0])); es.forEach(([nm,ch], i) => { const last = i === es.length - 1; ls.push(pfx + (last ? '\\-- ' : '|-- ') + nm + (ch.type === 'dir' ? '/' : '')); if (ch.type === 'dir') d(ch, pfx + (last ? '    ' : '|   ')); }); })(n, ''); return ls.join('\n'); }
    case 'grep': { if (!args.length) return 'grep: missing pattern'; return vfsGrep(args[0], args[1] || cwd).join('\n'); }
    default: return `bash: ${nm}: command not supported in virtual environment`;
  }
}

function shellTokenize(cmd) { const tk = []; let cur = '', sq = false, dq = false, esc = false; for (const ch of cmd) { if (esc) { cur += ch; esc = false; continue; } if (ch === '\\' && !sq) { esc = true; continue; } if (ch === "'" && !dq) { sq = !sq; continue; } if (ch === '"' && !sq) { dq = !dq; continue; } if (ch === ' ' && !sq && !dq) { if (cur) { tk.push(cur); cur = ''; } continue; } cur += ch; } if (cur) tk.push(cur); return tk; }

