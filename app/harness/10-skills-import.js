/* creel harness — part 10 of 26: skills-import
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
 * Continues the previous part: Skill Import: File (.skill / .zip / .json / SKILL.md)
 */
// ── Skill Import: File (.skill / .zip / .json / SKILL.md) ──
async function handleSkillFile(event) {
  const file = event.target.files[0];
  if (!file || skillInstallInProgress) return;
  await runSkillInstallTask('Reading skill file...', async progress => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.zip') || name.endsWith('.skill')) {
      await importSkillZip(file, progress);
    } else if (name === 'skill.md' || name.endsWith('.md')) {
      progress('Parsing SKILL.md...', 35);
      const text = await file.text();
      const skill = skillFromMd(text, 'file:' + file.name);
      progress('Installing skill...', 75);
      installSkill(skill); closeSkillModal();
    } else {
      progress('Parsing skill JSON...', 35);
      const text = await file.text();
      const skill = JSON.parse(text);
      skill.source = 'file:' + file.name;
      progress('Installing skill...', 75);
      installSkill(skill); closeSkillModal();
    }
  });
  event.target.value = '';
}

function skillFromMd(text, source) {
  const { meta, body } = parseSkillMd(text);
  return {
    name: meta.name || 'unnamed-skill',
    description: meta.description || '',
    icon: 'i:bolt',
    body,
    version: (meta.metadata && meta.metadata.version) || meta.version || '',
    author: (meta.metadata && meta.metadata.author) || meta.author || '',
    license: meta.license || '',
    trigger: meta.trigger || '',
    tools: meta.tools || [],
    references: {},
    scripts: {},
    assets: {},    // all other files (assets/, etc.)
    files: {},     // ALL files keyed by relative path
    active: true,
    source: source || 'file',
  };
}

async function importSkillZip(file, progress = () => {}) {
  try {
    progress('Reading archive...', 20);
    const { entries } = await readZipFile(file);
    progress(`Archive read: ${entries.length} files`, 35);
    // SkillLite format: find SKILL.md (may be in a subdirectory)
    let skillMdEntry = entries.find(e => e.name === 'SKILL.md') || entries.find(e => e.name.endsWith('/SKILL.md'));
    // Legacy format: skill.json
    const skillJsonEntry = !skillMdEntry && (entries.find(e => e.name.endsWith('skill.json') || e.name === 'skill.json'));

    let skill;
    let basePath = '';
    if (skillMdEntry) {
      basePath = skillMdEntry.name.replace(/\/?SKILL\.md$/, '');
      if (basePath && !basePath.endsWith('/')) basePath += '/';
      skill = skillFromMd(skillMdEntry.content, 'zip:' + file.name);
      if (!skill.binaryFiles) skill.binaryFiles = {};
      // Load ALL files from the archive
      const totalEntries = Math.max(1, entries.length);
      let processedEntries = 0;
      for (const entry of entries) {
        processedEntries++;
        progress(`Importing archive files ${processedEntries}/${totalEntries}...`, 35 + Math.round((processedEntries / totalEntries) * 35));
        if (entry.name === skillMdEntry.name) continue;
        const rel = basePath ? entry.name.slice(basePath.length) : entry.name;
        if (!rel) continue;
        if (entry.bytes) {
          // Binary file — store bytes separately (not in files{} to keep it JSON-safe)
          skill.binaryFiles[rel] = Array.from(entry.bytes);
          skill.files[rel] = `[Binary: ${rel}, ${entry.bytes.length} bytes]`;
        } else {
          skill.files[rel] = entry.content;
        }
        if (entry.content && rel.startsWith('references/')) skill.references[rel.slice(11)] = entry.content;
        else if (entry.content && rel.startsWith('scripts/')) skill.scripts[rel.slice(8)] = entry.content;
      }
    } else if (skillJsonEntry) {
      skill = JSON.parse(skillJsonEntry.content);
      skill.source = 'zip:' + file.name;
      if (!skill.files) skill.files = {};
      if (!skill.binaryFiles) skill.binaryFiles = {};
      const totalEntries = Math.max(1, entries.length);
      let processedEntries = 0;
      for (const entry of entries) {
        processedEntries++;
        progress(`Importing archive files ${processedEntries}/${totalEntries}...`, 35 + Math.round((processedEntries / totalEntries) * 35));
        if (entry.name === skillJsonEntry.name) continue;
        const rel = entry.name.split('/').slice(1).join('/') || entry.name;
        if (entry.bytes) {
          skill.binaryFiles[rel] = Array.from(entry.bytes);
          skill.files[rel] = `[Binary: ${rel}, ${entry.bytes.length} bytes]`;
        } else {
          skill.files[rel] = entry.content;
        }
        if (entry.content && (rel.endsWith('.md') || rel.endsWith('.txt'))) {
          if (!skill.references) skill.references = {};
          skill.references[rel.split('/').pop()] = entry.content;
        }
      }
    } else {
      throw new Error('No SKILL.md or skill.json found in archive');
    }
    progress('Installing skill...', 85);
    installSkill(skill); closeSkillModal();
  } catch (e) { throw new Error('Error reading archive: ' + e.message); }
}

// ZIP reader: parse Central Directory for reliable sizes, supports Deflate
async function readZipFile(file) {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const decoder = new TextDecoder();
  const entries = [];

  // Find End of Central Directory (scan backwards)
  let eocdOffset = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) return { entries };

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);

  // Build index from Central Directory (has correct sizes even with data descriptors)
  const cdIndex = {};
  let pos = cdOffset;
  for (let i = 0; i < cdEntries && pos < buf.byteLength - 4; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const compression = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(new Uint8Array(buf, pos + 46, nameLen));
    cdIndex[name] = { compression, compSize, uncompSize, localHeaderOffset };
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // Read file data using local headers + Central Directory sizes
  for (const [name, info] of Object.entries(cdIndex)) {
    if (name.endsWith('/') || info.compSize === 0) continue;
    const lh = info.localHeaderOffset;
    if (view.getUint32(lh, true) !== 0x04034b50) continue;
    const lhNameLen = view.getUint16(lh + 26, true);
    const lhExtraLen = view.getUint16(lh + 28, true);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    if (dataStart + info.compSize > buf.byteLength) continue;
    const raw = new Uint8Array(buf, dataStart, info.compSize);
    try {
      let bytes;
      if (info.compression === 0) {
        bytes = raw.slice();
      } else if (info.compression === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(raw); writer.close();
        const rdr = ds.readable.getReader();
        const chunks = [];
        while (true) { const { done, value } = await rdr.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        bytes = new Uint8Array(total);
        let p = 0; for (const c of chunks) { bytes.set(c, p); p += c.length; }
      } else { continue; }
      // Detect binary vs text by extension
      const ext = name.split('.').pop().toLowerCase();
      const isBin = BINARY_EXTS.has(ext);
      entries.push({ name, content: isBin ? null : decoder.decode(bytes), bytes: isBin ? bytes : null });
    } catch { /* skip unreadable */ }
  }
  return { entries };
}

// ── Skill Import: GitHub (SkillLite-compatible directory) ──
async function importFromGithub(button, externalProgress) {
  if (skillInstallInProgress && !externalProgress) return;
  const runner = async progress => importFromGithubImpl(progress);
  if (externalProgress) return runner(externalProgress);
  return runSkillInstallTask('Fetching skill from GitHub...', runner, { button });
}

function parseGithubSkillSource(input = {}) {
  let url = String(input.url || input.repoUrl || input.githubUrl || input.repo || '').trim();
  let branch = String(input.branch || '').trim();
  let skillPath = String(input.path || input.skillPath || '').trim();
  if (!url) throw new Error('GitHub URL is required.');
  if (!url.startsWith('http')) url = 'https://github.com/' + url;
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)\/(.*))?/);
  if (!match) throw new Error('Invalid GitHub URL.');
  const repo = `${match[1]}/${match[2]}`.replace(/\.git$/, '');
  if (!branch && match[3]) branch = decodeURIComponent(match[3]);
  if (!skillPath && match[4]) skillPath = decodeURIComponent(match[4]);
  return { repo, branch: branch || 'main', path: skillPath.replace(/^\/+|\/+$/g, '') };
}

function _githubApiRef(ref) {
  return encodeURIComponent(ref);
}
function _dirname(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}
function _pathWithin(path, root) {
  return root ? (path === root || path.startsWith(root + '/')) : true;
}
function _relPath(path, root) {
  return root ? path.slice(root.length + 1) : path;
}
function _base64ToBytes(b64) {
  const raw = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function _isBinaryGithubPath(path) {
  return BINARY_EXTS.has(String(path || '').split('.').pop().toLowerCase());
}
function _putSkillAsset(skill, rel, bytes, isBinary) {
  if (!rel || rel === 'SKILL.md' || rel === 'skill.json') return;
  if (!skill.files) skill.files = {};
  if (!skill.binaryFiles) skill.binaryFiles = {};
  if (!skill.references) skill.references = {};
  if (!skill.scripts) skill.scripts = {};
  if (isBinary) {
    skill.binaryFiles[rel] = Array.from(bytes);
    skill.files[rel] = `[Binary: ${rel}, ${bytes.length} bytes]`;
    return;
  }
  const text = new TextDecoder().decode(bytes);
  skill.files[rel] = text;
  if (rel.startsWith('references/')) skill.references[rel.slice(11)] = text;
  else if (rel.startsWith('scripts/')) skill.scripts[rel.slice(8)] = text;
}
async function skillFromWorkspacePath(path) {
  const requestedPath = String(path || '').trim();
  if (!requestedPath) throw new Error('path is required.');

  const resolvedPath = normPath(requestedPath);
  const node = vfsResolve(resolvedPath);
  if (!node) throw new Error(`Workspace path not found: ${resolvedPath}`);

  let rootPath = resolvedPath;
  let manifestPath = resolvedPath;
  if (node.type === 'dir') {
    manifestPath = normPath(`${resolvedPath}/SKILL.md`);
    const manifestNode = vfsResolve(manifestPath);
    if (!manifestNode) throw new Error(`No SKILL.md found in workspace directory: ${resolvedPath}`);
    if (manifestNode.type !== 'file') throw new Error(`SKILL.md is not a file: ${manifestPath}`);
  } else if (node.type === 'file') {
    if (_pathBaseName(resolvedPath) !== 'SKILL.md') throw new Error('Workspace file path must point to SKILL.md.');
    rootPath = _pathDirName(resolvedPath);
  } else {
    throw new Error(`Unsupported workspace path type: ${resolvedPath}`);
  }

  const manifestStat = vfsStat(manifestPath);
  if (!manifestStat || manifestStat.type !== 'file') throw new Error(`Workspace manifest not found: ${manifestPath}`);
  if (manifestStat.binary) throw new Error(`Workspace manifest must be text: ${manifestPath}`);

  const manifest = vfsRead(manifestPath);
  if (manifest.error) throw new Error(`Failed to read workspace manifest: ${manifest.error}`);

  const skill = skillFromMd(manifest.content, `workspace:${rootPath}`);
  if (!skill.references) skill.references = {};
  if (!skill.scripts) skill.scripts = {};
  if (!skill.files) skill.files = {};
  if (!skill.binaryFiles) skill.binaryFiles = {};

  const { files } = await _collectVfsFiles(rootPath);
  for (const file of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    if (file.path === manifestPath || file.rel === 'SKILL.md') continue;
    if (file.binary) {
      _putSkillAsset(skill, file.rel, file.bytes, true);
    } else {
      _putSkillAsset(skill, file.rel, new TextEncoder().encode(file.content || ''), false);
    }
  }

  skill.source = `workspace:${rootPath}`;
  return { skill, root: rootPath, manifest: manifestPath };
}
async function fetchGithubJson(apiUrl) {
  const resp = await fetch(apiUrl);
  if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
  return await resp.json();
}
async function fetchGithubBlobBytes(blobUrl, path) {
  const blob = await fetchGithubJson(blobUrl);
  if (blob.encoding !== 'base64' || !blob.content) throw new Error(`Unsupported GitHub blob encoding for ${path}`);
  return _base64ToBytes(blob.content);
}

async function fetchSkillFromGithubOptions(options = {}, progress = () => {}) {
  const source = options.repo && options.branch !== undefined && options.path !== undefined ? options : parseGithubSkillSource(options);
  const { repo, branch, path: requestedPath } = source;
  progress('Fetching repository tree...', 15);
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${_githubApiRef(branch)}?recursive=1`;
  const treeData = await fetchGithubJson(treeUrl);
  const blobs = (treeData.tree || []).filter(e => e.type === 'blob' && e.path);
  if (!blobs.length) throw new Error('Repository tree is empty or unavailable');

  let skillRoot = requestedPath;
  let skillMdEntry = null;
  let skillJsonEntry = null;
  if (skillRoot) {
    skillMdEntry = blobs.find(e => e.path === `${skillRoot}/SKILL.md`);
    skillJsonEntry = !skillMdEntry && blobs.find(e => e.path === `${skillRoot}/skill.json`);
    if (!skillMdEntry && !skillJsonEntry) throw new Error(`No SKILL.md or skill.json found under ${skillRoot}`);
  } else {
    const skillMdCandidates = blobs
      .filter(e => e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md'))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    skillMdEntry = skillMdCandidates[0] || null;
    const skillJsonCandidates = !skillMdEntry ? blobs
      .filter(e => e.path === 'skill.json' || e.path.endsWith('/skill.json'))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)) : [];
    skillJsonEntry = skillJsonCandidates[0] || null;
    if (!skillMdEntry && !skillJsonEntry) throw new Error('No SKILL.md or skill.json found in repository');
    skillRoot = _dirname((skillMdEntry || skillJsonEntry).path);
  }

  let skill;
  if (skillMdEntry) {
    progress('Fetching SKILL.md...', 30);
    const md = new TextDecoder().decode(await fetchGithubBlobBytes(skillMdEntry.url, skillMdEntry.path));
    skill = skillFromMd(md, `github:${repo}@${branch}`);
    skill.source = `github:${repo}@${branch}${skillRoot ? '/' + skillRoot : ''}`;
  } else {
    progress('Fetching skill.json...', 30);
    const json = new TextDecoder().decode(await fetchGithubBlobBytes(skillJsonEntry.url, skillJsonEntry.path));
    skill = JSON.parse(json);
    skill.source = `github:${repo}@${branch}${skillRoot ? '/' + skillRoot : ''}`;
  }
  if (!skill.references) skill.references = {};
  if (!skill.scripts) skill.scripts = {};
  if (!skill.files) skill.files = {};
  if (!skill.binaryFiles) skill.binaryFiles = {};

  const rootFiles = blobs
    .filter(e => _pathWithin(e.path, skillRoot))
    .filter(e => e.path !== skillMdEntry?.path && e.path !== skillJsonEntry?.path)
    .sort((a, b) => a.path.localeCompare(b.path));
  const totalFiles = Math.max(1, rootFiles.length);
  for (const [idx, entry] of rootFiles.entries()) {
    const rel = _relPath(entry.path, skillRoot);
    try {
      progress(`Fetching skill files ${idx + 1}/${totalFiles}: ${rel}`, 35 + Math.round(((idx + 1) / totalFiles) * 45));
      const bytes = await fetchGithubBlobBytes(entry.url, entry.path);
      _putSkillAsset(skill, rel, bytes, _isBinaryGithubPath(rel));
    } catch (e) {
      console.warn('Failed to fetch skill asset from GitHub:', entry.path, e);
    }
  }
  return { skill, repo, branch, path: skillRoot };
}

async function importFromGithubImpl(progress = () => {}) {
  const url = document.getElementById('skillGithubUrl').value.trim();
  const branch = document.getElementById('skillGithubBranch').value.trim() || '';
  const skillPath = document.getElementById('skillGithubPath').value.trim() || '';
  if (!url) { alert('Please enter a GitHub URL'); return; }
  const { skill } = await fetchSkillFromGithubOptions({ url, branch, path: skillPath }, progress);
  progress('Installing skill...', 90);
  installSkill(skill); closeSkillModal();
}

// ── Skill Create (generates SKILL.md format) ──
function createSkill() {
  if (skillInstallInProgress) return;
  const name = document.getElementById('skillCreateName').value.trim();
  if (!name) { alert('Skill name is required'); return; }
  let tools = [];
  const toolsJson = document.getElementById('skillCreateTool').value.trim();
  if (toolsJson) { try { tools = JSON.parse(toolsJson); if (!Array.isArray(tools)) tools = [tools]; } catch (e) { alert('Invalid tool JSON: ' + e.message); return; } }
  runSkillInstallTask('Creating skill...', async progress => {
    progress('Installing skill...', 70);
    installSkill({
      name,
      icon: document.getElementById('skillCreateIcon').value.trim() || 'i:bolt',
      description: document.getElementById('skillCreateDesc').value.trim(),
      trigger: document.getElementById('skillCreateTrigger').value.trim(),
      body: document.getElementById('skillCreatePrompt').value.trim(),
      tools,
      references: {},
      scripts: {},
      active: true,
      source: 'manual',
    });
    closeSkillModal();
  });
}

// Modal
function openSkillModal(tab) {
  document.getElementById('skillModal').classList.add('show');
  switchSkillTab(tab || 'market');
}
function closeSkillModal() { document.getElementById('skillModal').classList.remove('show'); }
function switchSkillTab(id, btn) {
  const tabs = ['market', 'file', 'github', 'create'];
  document.querySelectorAll('#skillModal .modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#skillModal .tab-content').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  else {
    const idx = tabs.indexOf(id);
    if (idx >= 0) document.querySelector(`#skillModal .modal-tab:nth-child(${idx + 1})`).classList.add('active');
  }
  document.getElementById('tab-' + id).classList.add('active');
  if (id === 'market' && !_mpLoaded) loadMarketplace();
}

// ── Skill Marketplace ─────────────────────────────────────────────
const MP_DEFAULT_REGISTRY = 'https://skills.onepagent.top/registry.json';
let _mpEntries = [];
let _mpLoaded = false;
function _mpRegistryUrl() {
  const el = document.getElementById('mpRegistryUrl');
  const v = (el?.value || '').trim() || localStorage.getItem('ba_mp_registry') || MP_DEFAULT_REGISTRY;
  if (el && !el.value) el.value = v;
  return v;
}
async function loadMarketplace(forceRefresh) {
  const url = _mpRegistryUrl();
  try { localStorage.setItem('ba_mp_registry', url); } catch {}
  const status = document.getElementById('mpStatus');
  const listEl = document.getElementById('mpList');
  status.textContent = 'Loading registry...';
  if (forceRefresh) listEl.innerHTML = '';
  try {
    const resp = await fetch(url, { cache: forceRefresh ? 'reload' : 'default' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const entries = Array.isArray(data) ? data : (data.skills || data.entries || []);
    _mpEntries = entries;
    _mpLoaded = true;
    status.textContent = `${entries.length} skills available`;
    renderMarketplaceList();
  } catch (e) {
    status.textContent = 'Failed: ' + e.message + ' — check the registry URL or network.';
    listEl.innerHTML = `<div style="font-size:11px;color:var(--text-dim);padding:16px;text-align:center;line-height:1.6">No registry loaded.<br>Default: <code style="font-size:10px">${esc(MP_DEFAULT_REGISTRY)}</code><br>Or set your own JSON index URL above.</div>`;
  }
}
function renderMarketplaceList() {
  const listEl = document.getElementById('mpList');
  const q = (document.getElementById('mpSearch')?.value || '').trim().toLowerCase();
  const filtered = _mpEntries.filter(e => {
    if (!q) return true;
    const hay = [e.name, e.description, e.author, (e.tags || []).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (!filtered.length) {
    listEl.innerHTML = `<div style="font-size:11px;color:var(--text-dim);padding:16px;text-align:center">${_mpEntries.length ? 'No matches.' : 'Registry empty.'}</div>`;
    return;
  }
  const installed = new Set(skills.map(s => s.name));
  listEl.innerHTML = filtered.map((e, i) => {
    const realIdx = _mpEntries.indexOf(e);
    const tags = (e.tags || []).map(t => `<span class="mp-tag">${esc(String(t))}</span>`).join('');
    const already = installed.has(e.name);
    return `<div class="mp-card">
      <div class="mp-icon">${iconHtml(e.icon || 'i:bolt')}</div>
      <div class="mp-body">
        <div class="mp-name">${esc(e.name || 'unnamed')}${e.author ? `<span class="mp-author">by ${esc(e.author)}</span>` : ''}</div>
        <div class="mp-desc">${esc(e.description || '')}</div>
        ${tags ? `<div class="mp-tags">${tags}</div>` : ''}
      </div>
      <button class="mp-install" ${already ? 'disabled' : ''} onclick="installFromMarketplace(${realIdx}, this)">${already ? 'Installed' : 'Install'}</button>
    </div>`;
  }).join('');
}
async function installFromMarketplace(index, btn) {
  const entry = _mpEntries[index];
  if (!entry || skillInstallInProgress) return;
  const status = document.getElementById('mpStatus');
  const oldText = btn ? btn.textContent : '';
  try {
    await runSkillInstallTask(`Installing "${entry.name}"...`, async progress => {
      if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }
      if (entry.source === 'inline' && entry.skill) {
        progress('Installing inline skill...', 70);
        installSkill(Object.assign({ active: true, source: 'marketplace:' + (entry.name || 'inline') }, entry.skill));
      } else if (entry.repo) {
        progress('Preparing GitHub import...', 10);
        document.getElementById('skillGithubUrl').value = /^https?:\/\//.test(entry.repo) ? entry.repo : ('https://github.com/' + entry.repo);
        document.getElementById('skillGithubBranch').value = entry.branch || 'main';
        document.getElementById('skillGithubPath').value = entry.path || '';
        await importFromGithub(null, progress);
      } else if (entry.url) {
        progress('Fetching skill file...', 25);
        const resp = await fetch(entry.url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        progress('Parsing skill file...', 55);
        const txt = await resp.text();
        let skill;
        try { skill = JSON.parse(txt); }
        catch {
          if (entry.url.toLowerCase().endsWith('.md')) skill = skillFromMd(txt, 'marketplace:' + entry.name);
          else skill = { name: entry.name, description: entry.description, icon: entry.icon || 'i:bolt', body: txt, references: {}, scripts: {}, active: true };
        }
        skill.source = 'marketplace:' + entry.name;
        progress('Installing skill...', 85);
        installSkill(skill);
      } else {
        throw new Error('Entry has no repo/url/inline skill');
      }
    }, { button: btn, rethrow: true, silentError: true });
    status.textContent = `Installed "${entry.name}"`;
    if (btn) { btn.textContent = 'Installed'; btn.disabled = true; }
    renderMarketplaceList();
  } catch (e) {
    status.textContent = 'Install failed: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = oldText || 'Install'; }
  }
}

// Skill file drop
const skillFileDrop = document.getElementById('skillFileDrop');
if (skillFileDrop) {
  skillFileDrop.addEventListener('dragover', e => { e.preventDefault(); skillFileDrop.classList.add('dragover'); });
  skillFileDrop.addEventListener('dragleave', () => skillFileDrop.classList.remove('dragover'));
  skillFileDrop.addEventListener('drop', e => {
    e.preventDefault(); skillFileDrop.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleSkillFile({ target: { files: e.dataTransfer.files } });
  });
}

