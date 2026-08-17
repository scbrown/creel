/* creel harness — part 17 of 26: swarm-role-editor
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
 *   - SWARM ROLE EDITOR (v3) — Sidebar list + create/edit modal
 */
// ═══════════════════════════════════════════════════════════════════
// SWARM ROLE EDITOR (v3) — Sidebar list + create/edit modal
// Roles merge SWARM_BUILTIN_ROLES (read-only) with userSwarmRoles (persisted in
// localStorage `ba_swarm_roles_v1`). The lead agent only sees enabled roles.
// ═══════════════════════════════════════════════════════════════════
const SWARM_ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
let _editingSwarmRoleId = null;
let _swarmRoleModalIsCreate = false;

function renderSwarmRoles() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const el = document.getElementById('swarmRolesList');
  if (!el) return;
  const all = getAllSwarmRoles().concat(
    userSwarmRoles.filter(r => r && r.enabled === false && !SWARM_BUILTIN_ROLES[r.id]),
    agentSwarmRoles.filter(r => r && r.enabled === false && !SWARM_BUILTIN_ROLES[r.id] && !userSwarmRoles.some(u => u.id === r.id))
  );
  // Deduplicate while preserving order, but include disabled custom roles for the editor view.
  const seen = new Set();
  const visible = [];
  for (const r of all) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    visible.push(r);
  }
  if (!visible.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:4px">' + esc(t('swarms.empty', 'No roles yet.')) + '</div>';
    return;
  }
  el.innerHTML = visible.map(r => {
    const isBuiltin = !!r.builtin;
    const isAgent = !isBuiltin && (r.createdBy === 'agent' || r.source === 'agent');
    const enabled = r.enabled !== false;
    const skillCount = Array.isArray(r.bindSkills) ? r.bindSkills.length : 0;
    const handoffCount = Array.isArray(r.allowedHandoffs) ? r.allowedHandoffs.length : 0;
    const meta = [];
    if (skillCount) meta.push(skillCount + ' skill' + (skillCount > 1 ? 's' : ''));
    if (handoffCount) meta.push(handoffCount + ' handoff' + (handoffCount > 1 ? 's' : ''));
    const metaText = meta.length ? ' · ' + meta.join(' · ') : '';
    const sourceBadge = isBuiltin
      ? '<span style="background:var(--text-dim);color:#1a1a1a;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px">builtin</span>'
      : (isAgent
        ? '<span style="background:var(--accent-blue,#5b8af5);color:#1a1a1a;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px">agent</span>'
        : '');
    const titleColor = enabled ? 'var(--text-primary)' : 'var(--text-dim)';
    const isEditableInUi = !isBuiltin && !isAgent; // agent roles are managed via the RoleManager tool, not the UI editor
    const editAction = isBuiltin
      ? `duplicateSwarmRole('${esc(r.id)}')`
      : (isAgent ? `duplicateSwarmRole('${esc(r.id)}')` : `openSwarmRoleModal('edit','${esc(r.id)}')`);
    const editLabel = isEditableInUi ? t('action.edit', 'Edit') : t('swarms.duplicate', 'Duplicate');
    return `<div class="hook-item" style="display:flex;align-items:center;gap:6px;cursor:default">
      <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleSwarmRoleEnabled('${esc(r.id)}')" aria-label="Enable role ${esc(r.name || r.id)}" ${isBuiltin ? 'disabled title="Built-in roles are always enabled"' : 'title="Enable / disable"'} style="margin:0;cursor:${isBuiltin ? 'not-allowed' : 'pointer'}">
      <span class="h-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-bolt"></use></svg></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;${enabled ? '' : 'opacity:0.55;'}color:${titleColor}" onclick="${editAction}" title="${esc(editLabel)}">${esc(r.name || r.id)}${sourceBadge} <span style="color:var(--text-dim);font-size:10px">${esc(r.id)}${esc(metaText)}</span></span>
      <button class="skill-install-btn" style="flex:none;margin:0;padding:2px 6px;font-size:10px" onclick="duplicateSwarmRole('${esc(r.id)}')" title="${esc(t('swarms.duplicate', 'Duplicate'))}" aria-label="Duplicate role ${esc(r.name || r.id)}">&#x29C9;</button>
      ${isBuiltin ? '' : `<button class="skill-install-btn" style="flex:none;margin:0;padding:2px 6px;font-size:10px" onclick="deleteSwarmRole('${esc(r.id)}')" title="${esc(t('swarms.delete', 'Delete'))}">&times;</button>`}
    </div>`;
  }).join('');
}

function _setSwarmRoleStatus(msg, isError) {
  const s = document.getElementById('swarmRoleModalStatus');
  if (!s) return;
  s.style.color = isError ? 'var(--accent-red)' : 'var(--text-dim)';
  s.textContent = msg || '';
}

function _populateSwarmRoleModalControls(currentRole) {
  // Tools grid: list base + memory + utility tools, excluding recursive ones and bb_*/SwarmHandoff (auto-granted).
  const grid = document.getElementById('swarmRoleToolsGrid');
  const skillsBox = document.getElementById('swarmRoleSkillsList');
  const handoffsBox = document.getElementById('swarmRoleHandoffsList');
  if (!grid || !skillsBox || !handoffsBox) return;
  const autoGranted = new Set(['bb_write', 'bb_read', 'bb_list', 'bb_post_task', 'bb_claim', 'SwarmHandoff']);
  // Tools that don't make sense inside a swarm worker — hide from the editor.
  const workerIncompatible = new Set(['AskUser', 'TodoWrite', 'ExitPlanMode', 'SkillManager']);
  const baseToolNames = (typeof BASE_TOOLS_ANTHROPIC !== 'undefined' ? BASE_TOOLS_ANTHROPIC : [])
    .map(t => t.name)
    .filter(n => !SWARM_RECURSIVE_TOOLS.has(n) && !autoGranted.has(n) && !workerIncompatible.has(n));
  const allowedSet = new Set(currentRole?.allowedTools || []);
  grid.innerHTML = baseToolNames.map(n => {
    const isWrite = SWARM_WRITE_TOOLS.has(n);
    const checked = allowedSet.has(n) ? 'checked' : '';
    const note = isWrite ? ' <span style="color:var(--accent-orange);font-size:9px">write</span>' : '';
    return `<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);text-transform:none;letter-spacing:0;cursor:pointer;margin:0"><input type="checkbox" data-swarm-tool="${esc(n)}" ${checked} style="width:auto;margin:0">${esc(n)}${note}</label>`;
  }).join('');
  // Skills list
  const installedSkills = Array.isArray(skills) ? skills : [];
  const boundSkills = new Set(currentRole?.bindSkills || []);
  if (!installedSkills.length) {
    skillsBox.innerHTML = '<div style="color:var(--text-dim)">' + esc(t('swarmRoleModal.noSkills', 'No skills installed.')) + '</div>';
  } else {
    skillsBox.innerHTML = installedSkills.map(sk => {
      const checked = boundSkills.has(sk.id) ? 'checked' : '';
      const toolCount = Array.isArray(sk.tools) ? sk.tools.length : 0;
      const meta = toolCount ? ` <span style="color:var(--text-dim)">(${toolCount} tool${toolCount > 1 ? 's' : ''})</span>` : ' <span style="color:var(--text-dim)">(no tools)</span>';
      return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:2px 0"><input type="checkbox" data-swarm-skill="${esc(sk.id)}" ${checked} style="width:auto;margin:0">${esc(sk.name || sk.id)}${meta}</label>`;
    }).join('');
    // Append "(missing)" markers for bound but uninstalled skills
    const missing = (currentRole?.bindSkills || []).filter(sid => !installedSkills.some(s => s.id === sid));
    if (missing.length) {
      skillsBox.innerHTML += missing.map(sid => `<div style="color:var(--accent-red);margin:2px 0">- ${esc(sid)} (missing)</div>`).join('');
    }
  }
  // Handoff targets: every other role
  const allRoles = getAllSwarmRoles().concat(userSwarmRoles.filter(r => !SWARM_BUILTIN_ROLES[r.id]));
  const seen = new Set();
  const handoffTargets = [];
  for (const r of allRoles) { if (r && !seen.has(r.id)) { seen.add(r.id); handoffTargets.push(r); } }
  const allowedHandoffs = new Set(currentRole?.allowedHandoffs || []);
  const selfId = currentRole?.id || '';
  handoffsBox.innerHTML = handoffTargets
    .filter(r => r.id !== selfId)
    .map(r => {
      const checked = allowedHandoffs.has(r.id) ? 'checked' : '';
      return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:2px 0"><input type="checkbox" data-swarm-handoff="${esc(r.id)}" ${checked} style="width:auto;margin:0">${esc(r.id)}${r.builtin ? ' <span style="color:var(--text-dim);font-size:10px">[builtin]</span>' : ''}</label>`;
    })
    .join('') || '<div style="color:var(--text-dim)">' + esc(t('swarmRoleModal.noHandoffs', 'No other roles available.')) + '</div>';
}

function openSwarmRoleModal(mode, roleId) {
  _swarmRoleModalIsCreate = mode !== 'edit';
  _editingSwarmRoleId = _swarmRoleModalIsCreate ? null : (roleId || null);
  let current = null;
  if (!_swarmRoleModalIsCreate && roleId) {
    current = userSwarmRoles.find(r => r.id === roleId) || null;
    if (!current) { alert('Role not found: ' + roleId); return; }
  }
  document.getElementById('swarmRoleModalTitle').textContent = t(_swarmRoleModalIsCreate ? 'swarmRoleModal.addTitle' : 'swarmRoleModal.editTitle', _swarmRoleModalIsCreate ? 'Add Custom Role' : 'Edit Custom Role');
  const idEl = document.getElementById('swarmRoleId');
  idEl.value = current?.id || '';
  idEl.readOnly = !_swarmRoleModalIsCreate;
  idEl.style.opacity = _swarmRoleModalIsCreate ? '1' : '0.6';
  document.getElementById('swarmRoleName').value = current?.name || '';
  document.getElementById('swarmRoleDescription').value = current?.description || '';
  document.getElementById('swarmRoleSystemPrompt').value = current?.systemPrompt || '';
  // Custom tool names: store everything not in the base grid as a comma list
  const baseToolNames = new Set((typeof BASE_TOOLS_ANTHROPIC !== 'undefined' ? BASE_TOOLS_ANTHROPIC : []).map(t => t.name));
  const customNames = (current?.allowedTools || []).filter(n => !baseToolNames.has(n) && !['bb_write','bb_read','bb_list','bb_post_task','bb_claim','SwarmHandoff'].includes(n));
  document.getElementById('swarmRoleCustomTools').value = customNames.join(', ');
  document.getElementById('swarmRoleMaxSteps').value = String(current?.maxSteps || 6);
  document.getElementById('swarmRoleTokenBudget').value = String(current?.tokenBudget || 60000);
  document.getElementById('swarmRoleDefaultModel').value = current?.defaultModel || '';
  document.getElementById('swarmRoleEnabled').checked = current ? current.enabled !== false : true;
  _populateSwarmRoleModalControls(current);
  _setSwarmRoleStatus('');
  document.getElementById('swarmRoleModal').classList.add('show');
}

function closeSwarmRoleModal() {
  document.getElementById('swarmRoleModal').classList.remove('show');
  _editingSwarmRoleId = null;
}

function _readSwarmRoleModal() {
  const id = document.getElementById('swarmRoleId').value.trim();
  const name = document.getElementById('swarmRoleName').value.trim();
  const description = document.getElementById('swarmRoleDescription').value.trim();
  const systemPrompt = document.getElementById('swarmRoleSystemPrompt').value;
  const enabled = document.getElementById('swarmRoleEnabled').checked;
  const maxStepsRaw = parseInt(document.getElementById('swarmRoleMaxSteps').value, 10);
  const tokenBudgetRaw = parseInt(document.getElementById('swarmRoleTokenBudget').value, 10);
  const defaultModel = document.getElementById('swarmRoleDefaultModel').value.trim();
  const baseTools = [...document.querySelectorAll('#swarmRoleToolsGrid input[data-swarm-tool]')]
    .filter(cb => cb.checked).map(cb => cb.getAttribute('data-swarm-tool'));
  const customStr = document.getElementById('swarmRoleCustomTools').value;
  const customTools = customStr.split(',').map(s => s.trim()).filter(Boolean);
  const bindSkills = [...document.querySelectorAll('#swarmRoleSkillsList input[data-swarm-skill]')]
    .filter(cb => cb.checked).map(cb => cb.getAttribute('data-swarm-skill'));
  const allowedHandoffs = [...document.querySelectorAll('#swarmRoleHandoffsList input[data-swarm-handoff]')]
    .filter(cb => cb.checked).map(cb => cb.getAttribute('data-swarm-handoff'));
  // Merge base + custom (dedupe) and strip any sneakily-typed recursive tools.
  const allowedTools = [];
  for (const n of [...baseTools, ...customTools]) {
    if (!n || allowedTools.includes(n) || SWARM_RECURSIVE_TOOLS.has(n)) continue;
    allowedTools.push(n);
  }
  return {
    id, name, description, systemPrompt, allowedTools, bindSkills, allowedHandoffs,
    maxSteps: Number.isFinite(maxStepsRaw) ? Math.min(30, Math.max(1, maxStepsRaw)) : 6,
    tokenBudget: Number.isFinite(tokenBudgetRaw) ? Math.min(200000, Math.max(5000, tokenBudgetRaw)) : 60000,
    defaultModel: defaultModel || undefined,
    enabled,
  };
}

function _validateSwarmRoleForSave(role, isCreate) {
  if (!role.id || !SWARM_ROLE_ID_PATTERN.test(role.id)) return 'ID must be lowercase kebab-case (a-z, 0-9, dash), 1–48 chars, starting with a letter.';
  if (SWARM_BUILTIN_ROLES[role.id]) return 'ID conflicts with a built-in role: ' + role.id;
  if (isCreate && userSwarmRoles.some(r => r.id === role.id)) return 'A custom role with this ID already exists.';
  if (!role.name) return 'Name is required.';
  if (!role.systemPrompt || role.systemPrompt.trim().length < 10) return 'System prompt must be at least 10 characters.';
  if (role.allowedHandoffs.includes(role.id)) return 'A role cannot hand off to itself.';
  return null;
}

function saveSwarmRoleFromModal() {
  const role = _readSwarmRoleModal();
  const err = _validateSwarmRoleForSave(role, _swarmRoleModalIsCreate);
  if (err) { _setSwarmRoleStatus(err, true); return; }
  if (_swarmRoleModalIsCreate) {
    userSwarmRoles.push(role);
  } else {
    const idx = userSwarmRoles.findIndex(r => r.id === _editingSwarmRoleId);
    if (idx >= 0) userSwarmRoles[idx] = { ...userSwarmRoles[idx], ...role, id: userSwarmRoles[idx].id };
  }
  saveUserSwarmRoles();
  renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
  closeSwarmRoleModal();
}

function deleteSwarmRole(id) {
  if (SWARM_BUILTIN_ROLES[id]) return;
  if (!confirm(t('swarms.deleteConfirm', 'Delete custom role "' + id + '"?'))) return;
  // Remove from whichever tier owns the id (user or agent).
  if (userSwarmRoles.some(r => r.id === id)) {
    userSwarmRoles = userSwarmRoles.filter(r => r.id !== id);
    saveUserSwarmRoles();
  } else if (agentSwarmRoles.some(r => r.id === id)) {
    agentSwarmRoles = agentSwarmRoles.filter(r => r.id !== id);
    saveAgentSwarmRoles();
  } else {
    return;
  }
  renderSwarmRoles();
  if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
}

function toggleSwarmRoleEnabled(id) {
  if (SWARM_BUILTIN_ROLES[id]) return;
  const userRole = userSwarmRoles.find(x => x.id === id);
  if (userRole) {
    userRole.enabled = userRole.enabled === false;
    saveUserSwarmRoles();
    renderSwarmRoles();
    return;
  }
  const agentRole = agentSwarmRoles.find(x => x.id === id);
  if (agentRole) {
    agentRole.enabled = agentRole.enabled === false;
    saveAgentSwarmRoles();
    renderSwarmRoles();
  }
}

function duplicateSwarmRole(id) {
  let src = null;
  if (SWARM_BUILTIN_ROLES[id]) src = { id, ...SWARM_BUILTIN_ROLES[id] };
  else src = userSwarmRoles.find(r => r.id === id) || agentSwarmRoles.find(r => r.id === id);
  if (!src) return;
  // Generate a unique new id like "<id>-copy", "-copy-2", ...
  let baseNew = src.id + '-copy';
  let candidate = baseNew;
  let n = 2;
  while (SWARM_BUILTIN_ROLES[candidate] || userSwarmRoles.some(r => r.id === candidate) || agentSwarmRoles.some(r => r.id === candidate)) {
    candidate = baseNew + '-' + n++;
  }
  const copy = {
    id: candidate,
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
  };
  // UI-driven duplicate always lands in the user tier (visible + editable in the editor).
  userSwarmRoles.push(copy);
  saveUserSwarmRoles();
  renderSwarmRoles();
  openSwarmRoleModal('edit', copy.id);
}

function exportSwarmRolesJson() {
  if (!userSwarmRoles.length) { alert(t('swarms.exportEmpty', 'No custom roles to export.')); return; }
  const blob = new Blob([JSON.stringify(userSwarmRoles, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'onepagent-swarm-roles.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _validateSwarmRolesArray(arr) {
  if (!Array.isArray(arr)) return 'JSON must be an array of role objects.';
  for (const r of arr) {
    if (!r || typeof r !== 'object') return 'Each role must be an object.';
    if (!SWARM_ROLE_ID_PATTERN.test(r.id || '')) return 'Invalid id: ' + JSON.stringify(r.id);
    if (SWARM_BUILTIN_ROLES[r.id]) return 'ID conflicts with built-in role: ' + r.id;
    if (!r.name || !r.systemPrompt) return 'Role "' + r.id + '" missing name or systemPrompt.';
  }
  // Check for internal duplicates
  const ids = arr.map(r => r.id);
  if (new Set(ids).size !== ids.length) return 'Duplicate ids in import payload.';
  return null;
}

function importSwarmRolesJsonPrompt() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const arr = JSON.parse(text);
      const err = _validateSwarmRolesArray(arr);
      if (err) { alert('Import failed: ' + err); return; }
      // Merge by id: imported entries replace existing custom roles with the same id.
      const map = new Map(userSwarmRoles.map(r => [r.id, r]));
      for (const r of arr) map.set(r.id, { ...r, enabled: r.enabled !== false });
      userSwarmRoles = [...map.values()];
      saveUserSwarmRoles();
      renderSwarmRoles();
      if (typeof rebuildToolDefs === 'function') rebuildToolDefs();
      alert(t('swarms.importOk', 'Imported {n} role(s).').replace('{n}', String(arr.length)));
    } catch (err) {
      alert('Import failed: ' + (err?.message || String(err)));
    }
  };
  input.click();
}

function toggleToolEnabled(name) {
  ensureVisibleConversationStateActive();
  if (disabledTools.has(name)) disabledTools.delete(name); else disabledTools.add(name);
  try { localStorage.setItem('ba_disabled_tools', JSON.stringify([...disabledTools])); } catch {}
  rebuildToolDefs();
}
function getEnabledToolsAnthropic() { return allToolsAnthropic.filter(t => !disabledTools.has(t.name)); }
function getEnabledToolsOpenAI() { return allToolsOpenAI.filter(t => !disabledTools.has(t.function.name)); }

function rebuildToolDefs(headId = activeEntryId, options = {}) {
  // Static built-in tools (BASE + PYODIDE) are kept in a fixed order regardless of
  // current mode (planMode / sandbox / swarm / media model / pyodide load / memory
  // enablement) so the tools-array byte sequence stays stable for prompt caching.
  // Runtime gating happens inside each tool handler (executeTool returns an Error
  // string when the tool is unavailable). The toolsGrid UI applies its own visibility
  // filter so the user only sees cards for currently-usable tools.
  // Feature-flagged tools are dropped here rather than gated per-call: a tool
  // in the array is a tool the model will try. The flag cannot change during a
  // session, so the array stays byte-stable for prompt caching either way.
  allToolsAnthropic = [
    ...BASE_TOOLS_ANTHROPIC.filter(t => featureAllowsTool(t.name)),
    ...(CREEL_FEATURES.python ? PYODIDE_NATIVE_TOOLS : []),
  ];
  skillToolHandlers = {};
  for (const st of getAllSkillTools()) {
    if (st.handler) skillToolHandlers[st.name] = st.handler;
  }
  for (const st of getTriggeredSkillTools(headId)) {
    allToolsAnthropic.push({ name: st.name, description: st.description || '', input_schema: st.parameters || { type: 'object', properties: {}, required: [] } });
  }
  // Add MCP tools
  for (const mt of mcpTools) {
    allToolsAnthropic.push({ name: mt.name, description: mt.description || '', input_schema: mt.parameters || { type: 'object', properties: {}, required: [] } });
  }
  // Long-term memory tools are always exposed; toolMemory* handlers enforce memIsEnabled() at runtime.
  allToolsAnthropic.push(
    { name: 'memory_save', description: 'Save a durable fact to long-term memory. Use sparingly and only for information that should survive across conversations: user preferences, project constraints, decisions made, entity relationships, or environment facts the user stated. Do NOT save ephemeral task details, debugging steps, or public knowledge. Each fact must be self-contained, stated in third-person ("User prefers X"), <= 220 chars. If this fact REPLACES an existing memory (user changed their mind, old fact is stale), pass supersedes_ids with the ids of the memories to retire.', input_schema: { type: 'object', properties: { content: { type: 'string', description: 'The fact to remember, stated plainly and in third-person.' }, tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase topic / entity tags for retrieval (e.g. ["python","testing"]).' }, type: { type: 'string', enum: ['fact','preference','event','skill','note'], description: 'Classification. Defaults to fact.' }, supersedes_ids: { type: 'array', items: { type: 'string' }, description: 'Optional. Ids of existing memories that this new memory replaces; they will be retired.' } }, required: ['content'] } },
    { name: 'memory_search', description: 'Search long-term memory for facts relevant to a query. Returns matching entries with their ids, time labels, tags, and relevance scores. Retired (superseded) memories are excluded unless include_superseded is true.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Free-text query describing what to recall.' }, tags: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict results to entries with these tags.' }, limit: { type: 'integer', description: 'Max results (1-25). Default 8.' }, include_superseded: { type: 'boolean', description: 'If true, include retired memories in the results.' } }, required: ['query'] } },
    { name: 'memory_update', description: 'Update fields of an existing memory in place. Use when a stored fact needs a clarification or tag fix. Fails if no memory has that id. Bumps updatedAt.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Target memory id (e.g. mem_abc123).' }, content: { type: 'string', description: 'New content, 4-400 chars.' }, tags: { type: 'array', items: { type: 'string' } }, type: { type: 'string', enum: ['fact','preference','event','skill','note'] }, pinned: { type: 'boolean' } }, required: ['id'] } },
    { name: 'memory_forget', description: 'Retire a memory so it no longer surfaces in recall or search. Soft delete — the record is kept but marked superseded. Use when the user explicitly tells you to forget something, or when a memory is demonstrably wrong with no obvious replacement.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Target memory id.' }, reason: { type: 'string', description: 'Optional short tag indicating why (e.g. "stale", "incorrect", "user-request").' } }, required: ['id'] } }
  );
  allToolsOpenAI = allToolsAnthropic.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (!options.skipRender) renderToolsGrid();
}

function isToolVisibleInUi(toolName) {
  if (toolName === 'TodoWrite' || toolName === 'ExitPlanMode') return planMode;
  if (toolName === 'GenerateImage') return hasConfiguredDefaultMediaModel('image');
  if (toolName === 'GenerateVideo') return hasConfiguredDefaultMediaModel('video');
  if (toolName === 'SwarmSpawn' || toolName === 'SwarmStatus' || toolName === 'SwarmAbort' || toolName === 'SwarmHandoff') return !!swarmSettings.enabled;
  if (toolName === 'RoleManager') return !!swarmSettings.enabled && !!swarmSettings.roleManagerEnabled;
  if (toolName === 'bb_write' || toolName === 'bb_read' || toolName === 'bb_list' || toolName === 'bb_post_task' || toolName === 'bb_claim') return !!swarmSettings.enabled;
  if (!featureAllowsTool(toolName)) return false;
  const _remote = isRemoteSandbox();
  if (toolName === 'Bash') return _remote;
  if (_remote && (toolName === 'PythonExec' || toolName === 'JSExec' || toolName === 'NodeExec')) return false;
  if (toolName === 'VfsToPyodide' || toolName === 'PyodideToVfs') return !_remote && !!pyodideInstance;
  if (toolName === 'memory_save' || toolName === 'memory_search' || toolName === 'memory_update' || toolName === 'memory_forget') return memIsEnabled();
  return true;
}

function renderToolsGrid() {
  if (currentRunContext && !isRunVisible(currentRunContext)) return;
  const icons = { Read: 'i:book', Write: 'i:file-pen', Edit: 'i:pencil', Glob: 'i:search', Grep: 'i:search', Bash: 'i:terminal', PythonExec: 'i:terminal', VfsToPyodide: 'i:terminal', PyodideToVfs: 'i:terminal', JSExec: 'i:terminal', NodeExec: 'i:terminal', WebSearch: 'i:globe', Fetch: 'i:antenna', RunSubAgent: 'i:bolt', SwarmSpawn: 'i:bolt', SwarmStatus: 'i:bolt', SwarmAbort: 'i:x', SwarmHandoff: 'i:bolt', bb_write: 'i:pencil', bb_read: 'i:book', bb_list: 'i:file-text', bb_post_task: 'i:plus', bb_claim: 'i:check', GenerateImage: 'i:image', GenerateVideo: 'i:film', SkillManager: 'i:wrench', AskUser: 'i:message-circle' };
  const el = document.getElementById('toolsGrid');
  el.innerHTML = allToolsAnthropic.filter(t => isToolVisibleInUi(t.name)).map(t => {
    const ic = icons[t.name] || 'i:wrench';
    const enabled = !disabledTools.has(t.name);
    return `<div class="tg-card ${enabled ? 'enabled' : ''}" data-tool="${esc(t.name)}" title="${esc(t.description)}" onclick="toggleToolEnabled(this.dataset.tool)" style="${enabled ? '' : 'opacity:0.4'}"><div class="tg-badge"></div><div class="tg-icon">${iconHtml(ic)}</div><div class="tg-name">${esc(t.name)}</div></div>`;
  }).join('');
}

