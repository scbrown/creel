/* creel harness — part 18 of 26: tool-impl
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
 *   - TOOL IMPLEMENTATIONS
 */
// ═══════════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════
// Plan Mode: writes are blocked, read-only tools and meta-tools are allowed.
const PLAN_MODE_WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash', 'PythonExec', 'VfsToPyodide', 'PyodideToVfs', 'JSExec', 'NodeExec', 'CronCreate', 'CronDelete']);

async function executeTool(name, input) {
  const run = currentRunContext;
  try {
    // Tool registries are rebuilt per conversation. Pin them immediately before
    // dispatch so another concurrent run cannot leave us with its skill handlers.
    rebuildToolDefs(activeEntryId, { skipRender: true });
    if (planMode && name !== 'ExitPlanMode' && name !== 'TodoWrite' && name !== 'AskUser') {
      const isMcp = mcpTools.find(t => t.name === name);
      const isBlockedSkillManagerWrite = name === 'SkillManager' && isSkillManagerWriteAction(input || {});
      const isBlockedRoleManagerWrite = name === 'RoleManager' && isRoleManagerWriteAction(input || {});
      if (PLAN_MODE_WRITE_TOOLS.has(name) || isMcp || isBlockedSkillManagerWrite || isBlockedRoleManagerWrite) {
        return `Error: Plan Mode is active. The tool "${name}" is blocked. Finish gathering information with read-only tools (Read / Glob / Grep / WebSearch / Fetch) and call ExitPlanMode when your plan is ready for user approval.`;
      }
    }
    logMemEntry('read', `Tool: ${name}`);
    flashTool(name, run);
    // A flagged-off tool is not in the schema list, so reaching here means the
    // model invented the call (or replayed it from older history). Answer with
    // the reason and the alternatives rather than dispatching into a runtime
    // that is not there.
    if (!featureAllowsTool(name)) return featureDisabledError(name);
    switch (name) {
      case 'Read': return await toolRead(input);
      case 'Write': { const r = await toolWrite(input); if (input?.file_path) markVfsTouched(input.file_path); return r; }
      case 'Edit': { const r = await toolEdit(input); if (input?.file_path) markVfsTouched(input.file_path); return r; }
      case 'Glob': return toolGlob(input);
      case 'Grep': return toolGrep(input);
      case 'Bash': return await (isRemoteSandbox() ? toolBashRemote(input) : toolBash(input));
      case 'PythonExec':
        if (isRemoteSandbox()) return 'Error: PythonExec is disabled when the remote sandbox is active. Use Bash instead — e.g. `python3 -c "..."` or `python3 /home/daytona/script.py`. Pip installs and /home/daytona changes persist across Bash calls.';
        return await toolPythonExec(input);
      case 'VfsToPyodide':
        if (isRemoteSandbox()) return 'Error: VfsToPyodide is disabled when the remote sandbox is active. Use Bash to move files within /home/daytona instead.';
        return pyodideInstance ? await toolVfsToPyodide(input) : 'Error: Pyodide is not loaded yet. Run PythonExec first to initialize Pyodide.';
      case 'PyodideToVfs':
        if (isRemoteSandbox()) return 'Error: PyodideToVfs is disabled when the remote sandbox is active. Write final files under /home/daytona/outputs via Bash and they will be synced to VFS /outputs.';
        return pyodideInstance ? await toolPyodideToVfs(input) : 'Error: Pyodide is not loaded yet. Run PythonExec first to initialize Pyodide.';
      case 'JSExec':
        if (isRemoteSandbox()) return 'Error: JSExec is disabled when the remote sandbox is active. Use Bash with `node` instead — e.g. `node -e "..."` or `node /home/daytona/script.js`. Npm installs and /home/daytona changes persist across Bash calls.';
        return await toolJSExec(input);
      case 'NodeExec':
        if (isRemoteSandbox()) return 'Error: NodeExec is disabled when the remote sandbox is active. Use Bash with `node` and `npm` instead. /home/daytona is your project root and persists across Bash calls.';
        return await toolNodeExec(input);
      case 'WebSearch': return await toolWebSearch(input);
      case 'Fetch': return await toolFetch(input);
      case 'RunSubAgent': return await toolRunSubAgent(input);
      case 'SwarmSpawn': return await toolSwarmSpawn(input);
      case 'SwarmStatus': return await toolSwarmStatus();
      case 'SwarmAbort': return await toolSwarmAbort(input);
      case 'SwarmHandoff': return 'Error: SwarmHandoff is a worker-only tool. The lead agent should use SwarmSpawn to delegate to a role; the worker itself decides whether to hand off to the next role.';
      case 'RoleManager': return await toolRoleManager(input || {});
      case 'bb_write': return await toolBbWrite(input);
      case 'bb_read': return await toolBbRead(input);
      case 'bb_list': return await toolBbList(input);
      case 'bb_post_task': return await toolBbPostTask(input);
      case 'bb_claim': return await toolBbClaim(input);
      case 'GenerateImage': return hasConfiguredDefaultMediaModel('image') ? await toolGenerateImage(input) : `Error: ${t('media.noModel')}`;
      case 'GenerateVideo': return hasConfiguredDefaultMediaModel('video') ? await toolGenerateVideo(input) : `Error: ${t('media.noModel')}`;
      case 'SkillManager': return await toolSkillManager(input || {});
      case 'TodoWrite': return toolTodoWrite(input);
      case 'AskUser': return await toolAskUser(input);
      case 'CronCreate': return await toolCronCreate(input || {});
      case 'CronDelete': return await toolCronDelete(input || {});
      case 'CronList': return await toolCronList(input || {});
      case 'ExitPlanMode': return await toolExitPlanMode(input);
      case 'memory_save': return await toolMemorySave(input);
      case 'memory_search': return await toolMemorySearch(input);
      case 'memory_update': return await toolMemoryUpdate(input);
      case 'memory_forget': return await toolMemoryForget(input);
      default:
        // Skill tool?
        if (skillToolHandlers[name]) {
          try { const fn = new Function('input', 'vfs', 'vfsRead', 'vfsWrite', 'vfsGlob', 'vfsGrep', skillToolHandlers[name]); return String(fn(input, vfs, vfsRead, vfsWrite, vfsGlob, vfsGrep) || ''); }
          catch (e) { return `Skill tool error: ${e.message}`; }
        }
        // MCP tool?
        if (mcpTools.find(t => t.name === name)) return await executeMcpTool(name, input);
        return `Unknown tool: ${name}`;
    }
  } catch (e) { return `Error: ${e.message}`; }
}

async function toolSkillManager(input = {}) {
  const action = String(input.action || '').trim();
  if (!SKILL_MANAGER_READ_ACTIONS.has(action) && !SKILL_MANAGER_WRITE_ACTIONS.has(action)) return skillManagerError(action || 'unknown', 'Invalid action.');

  if (action === 'list') {
    return skillManagerResult({ ok: true, action, skills: skills.map(s => serializeSkillForTool(s)), count: skills.length });
  }

  if (action === 'inspect') {
    const skill = findSkillByIdOrName(input);
    if (!skill) return skillManagerError(action, 'Skill not found.');
    return skillManagerResult({ ok: true, action, skill: serializeSkillForTool(skill, { detail: true, includeBody: true }) });
  }

  if (action === 'create') {
    const skill = normalizeSkill({ ...(input.skill || {}) }, { source: 'ai:create' });
    if (!skill.name && input.name) skill.name = String(input.name).trim();
    const errors = validateSkillInput(skill, { operation: 'create' });
    const oldSkill = skills.find(s => s.name === skill.name);
    if (oldSkill) errors.push(`Skill already exists: ${skill.name}. Use update or install_from_json with confirmation to overwrite.`);
    if (errors.length) return skillManagerError(action, 'Skill validation failed.', { errors });
    const risk = assessSkillRisk(skill, 'create');
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, skill: serializeSkillForTool(skill, { detail: true, includeBody: true }), risk });
    if (requiresSkillManagerConfirmation(risk, 'create') && input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, risk, summary: `Creating skill "${skill.name}" requires confirmation.` });
    installSkill(skill);
    logMemEntry('write', `Skill created by AI: ${skill.name}`);
    return skillManagerResult({ ok: true, action, summary: `Created skill "${skill.name}".`, skill: serializeSkillForTool(skill), warnings: risk.reasons });
  }

  if (action === 'install_from_markdown') {
    const markdown = String(input.markdown || '');
    if (!markdown.trim()) return skillManagerError(action, 'markdown is required.');
    const skill = normalizeSkill(skillFromMd(markdown, 'ai:markdown'), { source: 'ai:markdown' });
    const oldSkill = skills.find(s => s.name === skill.name);
    const errors = validateSkillInput(skill, { operation: 'install' });
    if (errors.length) return skillManagerError(action, 'Skill validation failed.', { errors });
    const risk = assessSkillRisk(skill, 'install', oldSkill);
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, skill: serializeSkillForTool(skill, { detail: true, includeBody: true }), overwrite: !!oldSkill, risk });
    if (requiresSkillManagerConfirmation(risk, 'install') && input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, overwrite: !!oldSkill, risk, summary: `Installing skill "${skill.name}" requires confirmation.` });
    installSkill(skill);
    return skillManagerResult({ ok: true, action, summary: `Installed skill "${skill.name}" from Markdown.`, skill: serializeSkillForTool(skill), warnings: risk.reasons });
  }

  if (action === 'install_from_json') {
    const skillInput = input.skill;
    if (!isPlainObject(skillInput)) return skillManagerError(action, 'skill object is required.');
    const skill = normalizeSkill({ ...skillInput }, { source: skillInput.source || 'ai:json' });
    const oldSkill = skills.find(s => s.name === skill.name);
    const errors = validateSkillInput(skill, { operation: 'install' });
    if (errors.length) return skillManagerError(action, 'Skill validation failed.', { errors });
    const risk = assessSkillRisk(skill, 'install', oldSkill);
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, skill: serializeSkillForTool(skill, { detail: true, includeBody: true }), overwrite: !!oldSkill, risk });
    if (requiresSkillManagerConfirmation(risk, 'install') && input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, overwrite: !!oldSkill, risk, summary: `Installing skill "${skill.name}" requires confirmation.` });
    installSkill(skill);
    return skillManagerResult({ ok: true, action, summary: `Installed skill "${skill.name}" from JSON.`, skill: serializeSkillForTool(skill), warnings: risk.reasons });
  }

  if (action === 'install_from_github') {
    const source = parseGithubSkillSource(input);
    const { skill } = await fetchSkillFromGithubOptions(source, () => {});
    normalizeSkill(skill, { source: `github:${source.repo}@${source.branch}${source.path ? '/' + source.path : ''}` });
    const oldSkill = skills.find(s => s.name === skill.name);
    const errors = validateSkillInput(skill, { operation: 'install_github' });
    if (errors.length) return skillManagerError(action, 'Skill validation failed.', { errors });
    const risk = assessSkillRisk(skill, 'install_github', oldSkill);
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, source, skill: serializeSkillForTool(skill, { detail: true, includeBody: true }), overwrite: !!oldSkill, risk });
    if (input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, source, overwrite: !!oldSkill, risk, summary: `Installing remote GitHub skill "${skill.name}" requires confirmation.` });
    installSkill(skill);
    return skillManagerResult({ ok: true, action, summary: `Installed skill "${skill.name}" from GitHub.`, source, skill: serializeSkillForTool(skill), warnings: risk.reasons });
  }

  if (action === 'install_from_workspace') {
    let imported;
    try {
      imported = await skillFromWorkspacePath(input.path);
    } catch (e) {
      return skillManagerError(action, e?.message || String(e));
    }
    const { skill, root, manifest } = imported;
    normalizeSkill(skill, { source: `workspace:${root}` });
    const oldSkill = skills.find(s => s.name === skill.name);
    const errors = validateSkillInput(skill, { operation: 'install' });
    if (errors.length) return skillManagerError(action, 'Skill validation failed.', { errors, source: { root, manifest } });
    const risk = assessSkillRisk(skill, 'install', oldSkill);
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, source: { root, manifest }, skill: serializeSkillForTool(skill, { detail: true, includeBody: true }), overwrite: !!oldSkill, risk });
    if (requiresSkillManagerConfirmation(risk, 'install') && input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, source: { root, manifest }, overwrite: !!oldSkill, risk, summary: `Installing workspace skill "${skill.name}" requires confirmation.` });
    installSkill(skill);
    return skillManagerResult({ ok: true, action, summary: `Installed skill "${skill.name}" from workspace.`, source: { root, manifest }, skill: serializeSkillForTool(skill), warnings: risk.reasons });
  }

  if (action === 'update') {
    const existing = findSkillByIdOrName(input);
    if (!existing) return skillManagerError(action, 'Skill not found.');
    const updates = isPlainObject(input.updates) ? input.updates : {};
    if (!Object.keys(updates).length) return skillManagerError(action, 'updates object is required.');
    const next = applySkillUpdates(existing, updates);
    const errors = validateSkillInput(next, { operation: 'update', updates });
    if (errors.length) return skillManagerError(action, 'Skill validation failed.', { errors });
    const risk = assessSkillRisk(next, 'update', existing, { updates });
    const changedFields = Object.keys(updates).filter(k => SKILL_MANAGER_ALLOWED_UPDATE_FIELDS.has(k));
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, skill: serializeSkillForTool(next, { detail: true, includeBody: true }), changedFields, risk });
    if (requiresSkillManagerConfirmation(risk, 'update') && input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, risk, changedFields, summary: `Updating skill "${existing.name}" requires confirmation.` });
    const result = updateSkillByIdOrName(input, updates);
    logMemEntry('write', `Skill updated by AI: ${result.skill.name} (${changedFields.join(', ') || 'no allowed fields'})`);
    return skillManagerResult({ ok: true, action, summary: `Updated skill "${result.skill.name}".`, changedFields, skill: serializeSkillForTool(result.skill), warnings: risk.reasons });
  }

  if (action === 'set_active') {
    if (typeof input.active !== 'boolean') return skillManagerError(action, 'active boolean is required.');
    const skill = findSkillByIdOrName(input);
    if (!skill) return skillManagerError(action, 'Skill not found.');
    const risk = assessSkillRisk(skill, 'set_active', null, { active: input.active });
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, skill: serializeSkillForTool(skill), targetActive: input.active, risk });
    if (requiresSkillManagerConfirmation(risk, 'set_active') && input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, risk, summary: `Changing active state for skill "${skill.name}" requires confirmation.` });
    const result = setSkillActiveByIdOrName(input, input.active);
    if (!result.skill) return skillManagerError(action, 'Skill not found.');
    logMemEntry('write', `Skill active set by AI: ${result.skill.name} -> ${input.active}`);
    return skillManagerResult({ ok: true, action, summary: result.changed ? `Set skill "${result.skill.name}" active=${input.active}.` : `Skill "${result.skill.name}" was already active=${input.active}.`, changed: result.changed, skill: serializeSkillForTool(result.skill), warnings: risk.reasons });
  }

  if (action === 'remove') {
    const skill = findSkillByIdOrName(input);
    if (!skill) return skillManagerError(action, 'Skill not found.');
    const risk = assessSkillRisk(skill, 'remove');
    if (input.dry_run) return skillManagerResult({ ok: true, action, dry_run: true, skill: serializeSkillForTool(skill, { detail: true, includeBody: false }), risk });
    if (input.confirmed !== true) return skillManagerResult({ ok: false, action, needs_confirmation: true, risk, summary: `Deleting skill "${skill.name}" requires confirmation.` });
    const removedName = skill.name;
    removeSkill(skill.id);
    logMemEntry('write', `Skill removed by AI: ${removedName}`);
    return skillManagerResult({ ok: true, action, summary: `Removed skill "${removedName}".`, warnings: risk.reasons });
  }

  return skillManagerError(action, 'Unhandled action.');
}

function genSubAgentRunId() {
  return 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function getSubAgentAllowedToolNames(roleConfig) {
  // If a role config is supplied (swarm worker), use its tool whitelist verbatim,
  // otherwise fall back to the legacy read-only sub-agent set.
  let names;
  if (roleConfig && Array.isArray(roleConfig.allowedTools)) {
    names = new Set(roleConfig.allowedTools);
  } else {
    names = new Set(SUB_AGENT_ALLOWED_TOOLS);
  }
  if (!memIsEnabled()) names.delete('memory_search');
  return names;
}
function getSubAgentSystemPrompt(roleConfig) {
  if (!roleConfig) {
    return `\n\n[SUB-AGENT MODE]\nYou are a bounded read-only sub-agent working on a delegated task. Complete only the delegated task. Use tools only when needed. Do not ask the user questions. Do not attempt to spawn another sub-agent. Do not modify files, execute code, generate media, use MCP tools, or write memory. If Plan Mode is active, only gather information and plan. Return a concise final answer with findings, read-only actions taken, and blockers.`;
  }
  // Swarm worker: emit Anthropic-style 4-piece role contract.
  const tools = (roleConfig.allowedTools || []).join(', ') || '(none)';
  const fmt = roleConfig.outputFormat || 'Concise text answer with citations.';
  const obj = roleConfig.objective || '(see task body)';
  const done = roleConfig.doneCriteria || 'Stop as soon as the requested output is produced. Do not over-investigate.';
  const handoffs = roleConfig.allowedHandoffs || [];
  const handoffBlock = handoffs.length
    ? `\n\n[HANDOFF AVAILABLE]\nYou may pass control to one of these roles when your slice is done and another role is better suited for the next step: ${handoffs.join(', ')}. To do so, call the SwarmHandoff tool with { target_role, brief, output_format? }. After SwarmHandoff returns, do NOT continue working — the next worker takes over. Use handoff sparingly: only when your output is genuinely insufficient on its own. If your task is fully answered, just produce the final answer instead.`
    : '';
  return `\n\n[SWARM WORKER MODE — role: ${roleConfig.name}]\n<role_contract>\n  <objective>${obj}</objective>\n  <output_format>${fmt}</output_format>\n  <tools_allowed>${tools}</tools_allowed>\n  <budget>steps≤${roleConfig.maxSteps || 6}, tokens≤${roleConfig.tokenBudget || 60000}</budget>\n  <done_criteria>${done}</done_criteria>\n</role_contract>\nYou are a swarm worker. Stay strictly within the role contract. Do not ask the user questions. Do not spawn other workers. Return a self-contained final answer in the requested format.${handoffBlock}\n${roleConfig.systemPrompt ? '\n[ROLE GUIDANCE]\n' + roleConfig.systemPrompt : ''}`;
}
async function buildSubAgentRequestBody(subMessages, headId, options = {}) {
  const parts = await collectRequestContextParts(subMessages, headId, { readOnlyMemory: true, skipToolRender: true, memoryRecallKey: options.memoryRecallKey, microCompact: options.microCompact || {} });
  const allowed = getSubAgentAllowedToolNames(options.roleConfig);
  parts.anthropicTools = (parts.anthropicTools || []).filter(t => allowed.has(t.name) && t.name !== SUB_AGENT_TOOL_NAME && t.name !== SWARM_TOOL_NAME);
  parts.openaiTools = (parts.openaiTools || []).filter(t => allowed.has(t.function?.name) && t.function?.name !== SUB_AGENT_TOOL_NAME && t.function?.name !== SWARM_TOOL_NAME);
  parts.volatileSystemPrompt = (parts.volatileSystemPrompt || '') + getSubAgentSystemPrompt(options.roleConfig);
  // Inject the live blackboard digest so the worker doesn't have to bb_list before deciding what to do.
  if (options.roleConfig && swarmSettings.enabled && swarmRunActive) {
    parts.volatileSystemPrompt += getBlackboardDigestForWorker();
  }
  parts.systemPrompt = (parts.stableSystemPrompt || '') + parts.volatileSystemPrompt;
  return assembleRequestBodyFromParts(parts, { model: options.modelOverride || API_MODEL });
}
function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n').trim();
}
async function executeSubAgentTool(name, input, run, roleConfig) {
  const allowed = getSubAgentAllowedToolNames(roleConfig);
  if (name === SUB_AGENT_TOOL_NAME) return { output: 'Error: Sub-agents cannot spawn other sub-agents.', isError: true };
  if (name === SWARM_TOOL_NAME) return { output: 'Error: Swarm workers cannot spawn other workers.', isError: true };
  if (name === 'RoleManager') return { output: 'Error: RoleManager is a lead-only tool. Workers cannot modify role definitions.', isError: true };
  // Handoff: validate and stash a pendingHandoff signal on the run; the loop unwinds at end of step.
  if (name === SWARM_HANDOFF_TOOL_NAME) {
    if (!roleConfig) return { output: 'Error: SwarmHandoff is only available to swarm workers.', isError: true };
    const target = String(input?.target_role || input?.role || '').trim();
    const brief = String(input?.brief || input?.task || '').trim();
    const outputFormat = String(input?.output_format || '').trim();
    if (!target) return { output: 'Error: SwarmHandoff requires "target_role".', isError: true };
    if (!brief) return { output: 'Error: SwarmHandoff requires "brief" describing what the next worker must do.', isError: true };
    const allowedHandoffs = roleConfig.allowedHandoffs || [];
    if (!allowedHandoffs.includes(target)) return { output: `Error: Role "${roleConfig.name}" cannot hand off to "${target}". Allowed targets: ${allowedHandoffs.join(', ') || '(none)'}.`, isError: true };
    const targetRole = getSwarmRole(target);
    if (!targetRole) return { output: `Error: Unknown handoff target role "${target}".`, isError: true };
    // Cycle detection: target must not appear in the chain history already traversed.
    const chainRoles = (run.chainHistory || []).map(c => c.role);
    if (chainRoles.includes(target)) return { output: `Error: Handoff cycle detected — role "${target}" already participated in this chain (${chainRoles.join(' → ')}).`, isError: true };
    const maxChain = Number(swarmSettings.maxHandoffChain) || SWARM_DEFAULTS.maxHandoffChain;
    if (chainRoles.length + 1 >= maxChain) return { output: `Error: Handoff chain would exceed max length ${maxChain} (current: ${chainRoles.join(' → ')}).`, isError: true };
    run.pendingHandoff = { target, brief, outputFormat };
    run.toolCalls.push({ name, inputPreview: truncateMiddleText(JSON.stringify(input || {}), 500), outputPreview: `→ handoff to ${target}`, isError: false, at: Date.now() });
    run.resultPreview = `→ handoff to ${target}`;
    renderSubAgents();
    return { output: `Handoff queued. Control will transfer to "${target}" after this step. Stop working now and emit no further tool calls.`, isError: false };
  }
  if (disabledTools.has(name)) return { output: `Error: Tool "${name}" is disabled.`, isError: true };
  if (!allowed.has(name)) return { output: `Error: Tool "${name}" is not in the allowed set for this worker.`, isError: true };
  let out;
  try { out = await executeTool(name, input || {}); }
  catch (e) { out = `Error: ${e.message || String(e)}`; }
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  const limited = truncateMiddleText(text, SUB_AGENT_TOOL_OUTPUT_MAX_CHARS);
  run.toolCalls.push({
    name,
    inputPreview: truncateMiddleText(JSON.stringify(input || {}), 500),
    outputPreview: truncateMiddleText(text, 500),
    isError: text.startsWith('Error:'),
    at: Date.now()
  });
  run.resultPreview = `${name}: ${truncateMiddleText(text, 160).replace(/\s+/g, ' ').trim()}`;
  renderSubAgents();
  return { output: limited, isError: limited.startsWith('Error:') };
}
async function runSubAgentLoop({ run, task, context, maxSteps, roleConfig, modelOverride }) {
  const convRun = currentRunContext;
  const subMessages = [{ role: 'user', content: [
    { type: 'text', text: ['Delegated task:', task, '', 'Additional context:', context || '(none)'].join('\n') }
  ] }];
  const memoryRecallKey = `subagent:${run.id}`;
  let finalText = '';
  let workerTokens = 0;
  for (let step = 1; step <= maxSteps; step++) {
    run.steps = step;
    renderSubAgents();
    // Per-run global budget check (swarm only)
    if (swarmRunActive && roleConfig) {
      if (swarmRunActive.aborted) return { ok: false, text: `Worker aborted: ${swarmRunActive.abortedReason || 'swarm run aborted'}.\n\n${finalText}`, steps: step, tokens: workerTokens };
      if (roleConfig.tokenBudget && workerTokens >= roleConfig.tokenBudget) {
        return { ok: false, text: `Worker token budget (${roleConfig.tokenBudget}) reached.\n\n${finalText || 'No final answer.'}`, steps: step, tokens: workerTokens };
      }
    }
    const body = await buildSubAgentRequestBody(subMessages, activeEntryId, { memoryRecallKey, roleConfig, modelOverride });
    if (convRun) activateConversationRun(convRun);
    body.stream = true;
    if (PROVIDER !== 'anthropic_compat') body.stream_options = { ...(body.stream_options || {}), include_usage: true };
    const resp = await sendLLMRequestBody(body, getCurrentRunAbortSignal());
    if (convRun) activateConversationRun(convRun);
    if (!resp.ok) return { ok: false, text: `Sub-agent API Error (${resp.status}): ${(await resp.text()).slice(0, 500)}`, steps: step, tokens: workerTokens };
    const reader = resp.body.getReader();
    const keepReasoning = shouldKeepReasoningForModel(body.model || API_MODEL);
    const result = PROVIDER === 'anthropic_compat'
      ? await parseAnthropicStream(reader, () => {}, () => {}, () => {}, () => {})
      : await parseOpenAIStream(reader, () => {}, () => {}, () => {}, () => {}, { keepReasoning, includeReasoningUsage: keepReasoning });
    if (convRun) activateConversationRun(convRun);
    if (result.stream_error) return { ok: false, text: `Sub-agent stream interrupted: ${result.stream_error}`, steps: step, tokens: workerTokens };
    // Track tokens for swarm budget
    const usage = result.usage || {};
    const turnTokens = (usage.input_tokens || usage.prompt_tokens || 0) + (usage.output_tokens || usage.completion_tokens || 0);
    workerTokens += turnTokens;
    if (swarmRunActive && roleConfig) {
      swarmRunActive.totalTokens += turnTokens;
      if (swarmSettings.totalTokenBudget && swarmRunActive.totalTokens >= swarmSettings.totalTokenBudget) {
        swarmRunActive.aborted = true;
        swarmRunActive.abortedReason = `total token budget (${swarmSettings.totalTokenBudget}) exhausted`;
      }
    }
    subMessages.push({ role: 'assistant', content: result.content });
    finalText = extractAssistantText(result.content) || finalText;
    const toolUses = (result.content || []).filter(b => b.type === 'tool_use');
    if (!toolUses.length || result.stop_reason !== 'tool_use') return { ok: true, text: finalText || '(Sub-agent completed without text output.)', steps: step, tokens: workerTokens };
    const toolResults = [];
    for (const tu of toolUses) {
      const toolResult = await executeSubAgentTool(tu.name, tu.input, run, roleConfig);
      if (convRun) activateConversationRun(convRun);
      toolResults.push(PROVIDER === 'anthropic_compat'
        ? { type: 'tool_result', tool_use_id: tu.id, content: toolResult.output, is_error: toolResult.isError || undefined }
        : { type: 'tool_result', tool_use_id: tu.id, content: toolResult.output });
    }
    subMessages.push({ role: 'user', content: toolResults });
    // Handoff signal: the worker called SwarmHandoff this step. Unwind immediately so the
    // chain runner in toolSwarmSpawn can launch the next worker with the brief.
    if (run.pendingHandoff) {
      const ho = run.pendingHandoff;
      run.pendingHandoff = null;
      return { ok: true, text: finalText || '(no final text before handoff)', steps: step, tokens: workerTokens, handoff: ho };
    }
  }
  return { ok: false, text: `Sub-agent reached the ${maxSteps}-step limit.\n\n${finalText || 'No final answer was produced.'}`, steps: maxSteps, tokens: workerTokens };
}
function formatSubAgentToolResult(run, result) {
  return [
    `Sub-agent ${result.ok ? 'completed' : 'stopped'}.`,
    `Run ID: ${run.id}`,
    `Steps: ${result.steps}`,
    '',
    truncateMiddleText(result.text || '(no result)', SUB_AGENT_RESULT_MAX_CHARS)
  ].join('\n');
}
async function toolRunSubAgent(input) {
  const task = String(input?.task || '').trim();
  if (!task) return 'Error: "task" is required.';
  const context = String(input?.context || '').trim();
  const requestedSteps = Number(input?.max_steps);
  const maxSteps = Math.max(1, Math.min(Number.isFinite(requestedSteps) && requestedSteps > 0 ? Math.floor(requestedSteps) : SUB_AGENT_DEFAULT_MAX_STEPS, SUB_AGENT_MAX_STEPS));
  const run = { id: genSubAgentRunId(), task: task.slice(0, 2000), context: context.slice(0, 4000), status: 'running', startedAt: Date.now(), finishedAt: null, steps: 0, toolCalls: [], resultPreview: '', error: null };
  subAgentRuns.push(run);
  renderSubAgents();
  saveCurrentConv();
  try {
    const result = await runSubAgentLoop({ run, task: run.task, context: run.context, maxSteps });
    run.status = result.ok ? 'completed' : 'error';
    run.finishedAt = Date.now();
    run.steps = result.steps;
    run.resultPreview = truncateMiddleText(result.text || '', 500);
    renderSubAgents();
    saveCurrentConv();
    return formatSubAgentToolResult(run, result);
  } catch (e) {
    run.status = isAbortError(e) ? 'aborted' : 'error';
    run.finishedAt = Date.now();
    run.error = e?.message || String(e);
    renderSubAgents();
    saveCurrentConv();
    return `Error: Sub-agent failed: ${run.error}`;
  }
}

// ─── Swarm tools ────────────────────────────────────────────────────────────
// Run a single worker. Returns { run, result } where result may carry a `handoff` field.
async function _runOneSwarmWorker({ roleId, task, outputFormat, context, chainHistory }) {
  const convRun = currentRunContext; // owning conversation run; re-bind globals after each await
  const role = getSwarmRole(roleId);
  if (!role) return { error: `Unknown role "${roleId}". Available: ${listSwarmRoles().join(', ')}.` };
  if (swarmRunActive.workerCount >= swarmSettings.maxWorkersPerRun) {
    return { error: `Swarm worker cap reached (${swarmSettings.maxWorkersPerRun} per turn).` };
  }
  if (swarmRunActive.aborted) {
    return { error: `Swarm run aborted: ${swarmRunActive.abortedReason || 'budget exhausted'}.` };
  }
  swarmRunActive.workerCount++;
  const preCtx = await runHooks('pre_swarm_spawn', { role: roleId, task, output_format: outputFormat, context, runId: swarmRunActive.id, chainHistory });
  if (convRun) activateConversationRun(convRun);
  if (preCtx._blocked) return { error: `Swarm spawn blocked by hook [${preCtx._blocked.by}]: ${preCtx._blocked.reason}` };
  const effRole = { ...role, objective: task, outputFormat: outputFormat || 'Concise text answer with specific citations.' };
  const run = { id: genSubAgentRunId(), kind: 'swarm', role: roleId, task: task.slice(0, 2000), context: (context || '').slice(0, 4000), status: 'running', startedAt: Date.now(), finishedAt: null, steps: 0, toolCalls: [], resultPreview: '', error: null, chainHistory: chainHistory ? [...chainHistory] : [], handoffFrom: chainHistory && chainHistory.length ? chainHistory[chainHistory.length - 1].id : null };
  subAgentRuns.push(run);
  renderSubAgents();
  saveCurrentConv();
  try {
    const modelOverride = swarmSettings.workerModel || undefined;
    const result = await runSubAgentLoop({ run, task: run.task, context: run.context, maxSteps: role.maxSteps, roleConfig: effRole, modelOverride });
    run.status = result.handoff ? 'handoff' : (result.ok ? 'completed' : 'error');
    run.finishedAt = Date.now();
    run.steps = result.steps;
    run.resultPreview = result.handoff ? `→ handoff to ${result.handoff.target}` : truncateMiddleText(result.text || '', 500);
    renderSubAgents();
    saveCurrentConv();
    await runHooks('post_swarm_spawn', { role: roleId, task, runId: swarmRunActive?.id, ok: result.ok, tokens: result.tokens, steps: result.steps, handoff: result.handoff || null });
    return { run, result };
  } catch (e) {
    run.status = isAbortError(e) ? 'aborted' : 'error';
    run.finishedAt = Date.now();
    run.error = e?.message || String(e);
    renderSubAgents();
    saveCurrentConv();
    return { run, error: `Swarm worker failed: ${run.error}` };
  }
}

async function toolSwarmSpawn(input) {
  if (!swarmSettings.enabled) return 'Error: Agent Swarm is disabled. Enable it in Settings → Swarm.';
  if (ralphRun?.active) return 'Error: Swarm is disabled while Ralph Loop is active. Stop Ralph first.';
  const initialRoleId = String(input?.role || '').trim();
  if (!initialRoleId) return 'Error: "role" is required.';
  const initialTask = String(input?.task || '').trim();
  if (!initialTask) return 'Error: "task" is required.';
  const initialOutputFormat = String(input?.output_format || '').trim();
  const initialContext = String(input?.context || '').trim();
  if (!swarmRunActive) startSwarmRun();
  // Chain runner: each step runs one worker; if it hands off, feed brief + previous result into the next worker.
  const maxChain = Number(swarmSettings.maxHandoffChain) || SWARM_DEFAULTS.maxHandoffChain;
  const segments = []; // collected outputs across the chain
  let nextRoleId = initialRoleId;
  let nextTask = initialTask;
  let nextOutputFormat = initialOutputFormat;
  let nextContext = initialContext;
  const chainHistory = [];
  let lastError = null;
  for (let depth = 0; depth < maxChain; depth++) {
    const step = await _runOneSwarmWorker({ roleId: nextRoleId, task: nextTask, outputFormat: nextOutputFormat, context: nextContext, chainHistory });
    if (step.error) { lastError = step.error; break; }
    const { run, result } = step;
    chainHistory.push({ id: run.id, role: nextRoleId, ok: !!result.ok, text: result.text || '', tokens: result.tokens || 0, steps: result.steps });
    segments.push({ role: nextRoleId, ok: !!result.ok, text: result.text || '', steps: result.steps, tokens: result.tokens || 0 });
    if (!result.handoff) break;
    // Continue the chain: previous output becomes context for the next worker.
    nextRoleId = result.handoff.target;
    nextTask = result.handoff.brief;
    nextOutputFormat = result.handoff.outputFormat || initialOutputFormat;
    nextContext = `[Handoff chain so far]\n` + segments.map((s, i) => `--- Step ${i + 1} (${s.role}) ---\n${truncateMiddleText(s.text, 1500)}`).join('\n\n');
  }
  // Format the chain result back to the lead.
  if (!segments.length) return `Error: ${lastError || 'Swarm chain produced no segments.'}`;
  const totalTokens = segments.reduce((a, s) => a + (s.tokens || 0), 0);
  const totalSteps = segments.reduce((a, s) => a + (s.steps || 0), 0);
  const chainLabel = segments.map(s => s.role).join(' → ');
  const head = segments.length === 1
    ? `Swarm worker ${segments[0].ok ? 'completed' : 'stopped'}. Role: ${segments[0].role}. Steps: ${segments[0].steps}. Tokens: ${segments[0].tokens}.`
    : `Swarm chain completed: ${chainLabel}. Total steps: ${totalSteps}. Total tokens: ${totalTokens}.`;
  const body = segments.length === 1
    ? truncateMiddleText(segments[0].text || '(no result)', SUB_AGENT_RESULT_MAX_CHARS)
    : segments.map((s, i) => `[Step ${i + 1} — ${s.role}${s.ok ? '' : ' (stopped)'}]\n${truncateMiddleText(s.text || '(no result)', Math.floor(SUB_AGENT_RESULT_MAX_CHARS / segments.length))}`).join('\n\n');
  const tail = lastError ? `\n\n[Chain truncated: ${lastError}]` : '';
  return [head, '', body + tail].join('\n');
}
async function toolSwarmStatus() {
  if (!swarmSettings.enabled) return 'Swarm: disabled.';
  const swarmRuns = subAgentRuns.filter(r => r.kind === 'swarm');
  const running = swarmRuns.filter(r => r.status === 'running');
  const lines = [
    `Swarm: enabled (concurrency=${swarmSettings.maxConcurrency}, max-workers/run=${swarmSettings.maxWorkersPerRun}, total-budget=${swarmSettings.totalTokenBudget} tokens, max-handoff-chain=${swarmSettings.maxHandoffChain})`,
    `Active run: ${swarmRunActive ? swarmRunActive.id + ' (workers=' + swarmRunActive.workerCount + ', tokens=' + swarmRunActive.totalTokens + (swarmRunActive.aborted ? ', aborted: ' + swarmRunActive.abortedReason : '') + ')' : '(none)'}`,
    `Workers in this conversation: ${swarmRuns.length} (${running.length} running)`
  ];
  const bb = _bbGet();
  if (bb && bb.entries.length) {
    const byType = bb.entries.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {});
    const openTasks = bb.entries.filter(e => e.type === 'task' && !e.claimedBy).length;
    lines.push(`Blackboard: ${bb.entries.length} entries (` + Object.entries(byType).map(([k, v]) => k + '=' + v).join(', ') + `, open tasks=${openTasks})`);
  } else {
    lines.push('Blackboard: empty');
  }
  if (swarmRuns.length) {
    lines.push('');
    lines.push('Recent workers:');
    for (const r of swarmRuns.slice(-6)) {
      lines.push(`  - ${r.id} [${r.role}] ${r.status} steps=${r.steps} :: ${truncateMiddleText(r.resultPreview || '', 100).replace(/\s+/g, ' ').trim()}`);
    }
  }
  return lines.join('\n');
}
async function toolSwarmAbort(input) {
  if (!swarmRunActive) return 'No active swarm run.';
  const reason = String(input?.reason || 'lead requested abort').slice(0, 200);
  swarmRunActive.aborted = true;
  swarmRunActive.abortedReason = reason;
  return `Swarm run ${swarmRunActive.id} marked aborted: ${reason}. Workers will exit at their next budget check.`;
}

