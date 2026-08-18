/* State persistence to a private GitHub repo (creel-3ru), in the real page.
 *
 * The GitHub API is stubbed, the rest is real: the real sync engine builds the
 * real manifest from real local state, the real transport stages it, and the
 * real commit path turns that into git objects. The stub is a small in-memory
 * git remote — blobs, trees, commits, one ref — so the assertions are about
 * what creel actually sent, not about what a mock was told to expect.
 *
 * The three claims worth pinning:
 *   1. A push is ONE commit, however many objects it carries.
 *   2. A repo GitHub reports as public is refused, before any write.
 *   3. Credentials leave the browser only on an explicit opt-in WITH a
 *      passphrase — neither condition alone is enough.
 *
 * Run: node tests/test-state.js   (or `just test`)
 * Skips cleanly (exit 0) when no Chromium is present.
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { Browser } = require('./browser.js');

const APP = path.join(__dirname, '..', 'app');

const results = [];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 5).join('\n       ')}`); failures++; }
};

/* An in-memory git remote, installed over window.fetch inside the page. */
function installFakeGitHub() {
  const store = {
    blobs: new Map(),          // sha -> base64 content
    trees: new Map(),          // sha -> [{path, sha}]
    commits: [],               // {sha, tree, parents, message}
    ref: null,                 // head sha
    repoPrivate: true,
    calls: [],
  };
  window.__gh = store;

  /** The files the fake remote holds at HEAD, as path -> decoded text. */
  window.readRemoteFiles = () => {
    if (!store.ref) return {};
    const commit = store.commits.find((c) => c.sha === store.ref);
    const out = {};
    for (const e of store.trees.get(commit.tree) || []) {
      out[e.path] = atob(store.blobs.get(e.sha));
    }
    return out;
  };

  let n = 0;
  const mkSha = () => (++n).toString(16).padStart(40, '0');
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  /** Flatten a tree sha into path -> blob sha, following base_tree links. */
  const flatten = (sha) => {
    const out = new Map();
    for (const e of store.trees.get(sha) || []) out.set(e.path, e.sha);
    return out;
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.github.com')) return realFetch(input, init);
    const p = url.slice('https://api.github.com'.length);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    store.calls.push(`${method} ${p}`);

    if (p === '/user') return json({ login: 'stiwi' });

    if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) {
      return json({
        full_name: p.slice('/repos/'.length),
        private: store.repoPrivate,
        default_branch: 'main',
        permissions: { push: true },
      });
    }
    if (/\/git\/ref\/heads\//.test(p)) {
      if (!store.ref) return json({ message: 'Not Found' }, 404);
      return json({ object: { sha: store.ref } });
    }
    if (/\/git\/commits\/[0-9a-f]+$/.test(p) && method === 'GET') {
      const c = store.commits.find((x) => x.sha === p.split('/').pop());
      return c ? json({ sha: c.sha, tree: { sha: c.tree } }) : json({ message: 'Not Found' }, 404);
    }
    if (/\/git\/trees\/[0-9a-f]+/.test(p) && method === 'GET') {
      const sha = p.split('/').pop().split('?')[0];
      const flat = flatten(sha);
      return json({
        sha,
        truncated: false,
        tree: [...flat].map(([path_, s]) => ({ path: path_, type: 'blob', sha: s })),
      });
    }
    if (/\/git\/blobs\/[0-9a-f]+$/.test(p) && method === 'GET') {
      const sha = p.split('/').pop();
      const content = store.blobs.get(sha);
      return content === undefined
        ? json({ message: 'Not Found' }, 404)
        : json({ sha, encoding: 'base64', content });
    }
    if (p.endsWith('/git/blobs') && method === 'POST') {
      const sha = mkSha();
      store.blobs.set(sha, body.content);
      return json({ sha });
    }
    if (p.endsWith('/git/trees') && method === 'POST') {
      const sha = mkSha();
      const merged = body.base_tree ? flatten(body.base_tree) : new Map();
      for (const e of body.tree) {
        if (e.sha === null) merged.delete(e.path);
        else merged.set(e.path, e.sha);
      }
      store.trees.set(sha, [...merged].map(([path_, s]) => ({ path: path_, sha: s })));
      return json({ sha });
    }
    if (p.endsWith('/git/commits') && method === 'POST') {
      const sha = mkSha();
      store.commits.push({ sha, tree: body.tree, parents: body.parents || [], message: body.message });
      return json({ sha });
    }
    if (/\/git\/refs/.test(p)) {
      if (method === 'PATCH') {
        if (!store.ref) return json({ message: 'Not Found' }, 404);
        store.ref = body.sha;
        return json({ object: { sha: store.ref } });
      }
      store.ref = body.sha;
      return json({ object: { sha: store.ref } });
    }
    return json({ message: 'unstubbed: ' + method + ' ' + p }, 500);
  };
}

(async () => {
  if (!Browser.available()) {
    console.log('creel state repo\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  const page = await browser.newPage('/onepagent.html');
  await page.waitForFunction(() => !!window.CreelState, { message: 'state backend' });

  /** Call a state_* tool the way an agent's MCP client would. */
  let callId = 0;
  const state = async (name, args = {}) => {
    const res = await page.evaluate(async (n, a, id) => {
      const reply = await window.CreelState.handle({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: n, arguments: a },
      });
      if (reply.error) return { __error: reply.error.message };
      return JSON.parse(reply.result.content[0].text);
    }, name, args, ++callId);
    if (res && res.__error) throw new Error(res.__error);
    return res;
  };

  await page.evaluate(installFakeGitHub);
  // A pull asks before replacing local state with a native confirm(), which
  // blocks the page and therefore the driver. Answer yes: these tests are
  // about what a confirmed pull does.
  await page.evaluate(() => { window.confirm = () => true; });
  await page.evaluate(() => { localStorage.setItem('creel_github_pat', 'ghp_fake'); });

  await check('with nothing configured, status says so instead of guessing', async () => {
    const s = await state('state_status');
    assert.strictEqual(s.configured, false);
    assert.match(s.hint, /state_configure/);
  });

  await check('a PUBLIC repo is refused, and the refusal says why', async () => {
    await page.evaluate(() => { window.__gh.repoPrivate = false; });
    const err = await state('state_configure', { owner: 'stiwi', repo: 'creel-state' })
      .then(() => null, (e) => e.message);
    assert.ok(err, 'a public repo was accepted');
    assert.match(err, /PUBLIC/);
    assert.match(err, /private/i, 'the refusal should say what to do about it');
  });

  await check('nothing was written to the repo it refused', async () => {
    const commits = await page.evaluate(() => window.__gh.commits.length);
    assert.strictEqual(commits, 0);
  });

  await check('a private repo is accepted and defaults to creel-state on the login', async () => {
    await page.evaluate(() => { window.__gh.repoPrivate = true; });
    const r = await state('state_configure', {});
    assert.strictEqual(r.repo, 'stiwi/creel-state', 'defaulted to <login>/creel-state');
    assert.strictEqual(r.private, true);
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.branch, 'main');
  });

  await check('the state repo becomes the sync destination', async () => {
    const backend = await page.evaluate(() => _syncCfg().backend);
    assert.strictEqual(backend, 'github');
    assert.strictEqual(await page.evaluate(() => _syncConfigured()), true);
  });

  await check('a push is exactly one commit, whatever it carries', async () => {
    const r = await state('state_push');
    assert.strictEqual(r.pushed, true);
    const { commits, files } = await page.evaluate(() => ({
      commits: window.__gh.commits.length,
      files: Object.keys(readRemoteFiles()).length,
    }));
    assert.strictEqual(commits, 1, `expected 1 commit, got ${commits}`);
    assert.ok(files >= 2, `expected a manifest and at least one object, got ${files} file(s)`);
  });

  await check('the commit lands under the configured prefix, manifest and all', async () => {
    const paths = await page.evaluate(() => Object.keys(readRemoteFiles()));
    assert.ok(paths.includes('state/manifest.json'), 'no manifest at state/manifest.json: ' + paths.slice(0, 5));
    assert.ok(paths.some((p) => p.startsWith('state/objects/')), 'no content-addressed objects');
  });

  await check('a second push with nothing new does not re-upload the world', async () => {
    const before = await page.evaluate(() => window.__gh.blobs.size);
    await state('state_push');
    const after = await page.evaluate(() => window.__gh.blobs.size);
    // The manifest changes every push (it carries updatedAt), so one new blob
    // is expected; the objects it names must be reused, not re-sent.
    assert.ok(after - before <= 2, `re-uploaded ${after - before} blobs for an unchanged state`);
  });

  await check('the quipu graph travels with the state', async () => {
    // Boot the in-page store, then push. The claim is checked against the
    // manifest that was actually pushed, not against a second export — the
    // graph mutates as it boots, so exporting twice yields two different
    // hashes and would prove nothing either way.
    const booted = await page.evaluate(async () => {
      try { await window.CreelQuipu.ensureWasm(); return true; } catch { return false; }
    });
    await state('state_push');
    const pushed = await page.evaluate(() => {
      const files = readRemoteFiles();
      return files['state/manifest.json'] ? JSON.parse(files['state/manifest.json']) : null;
    });
    assert.ok(pushed, 'no readable manifest was pushed');
    assert.ok('quipu' in pushed, 'the manifest has no quipu field at all');
    if (!booted) return;   // no wasm bundle in this checkout; the field is the contract
    assert.ok(pushed.quipu && pushed.quipu.hash, 'the manifest does not name the quipu store');
    assert.ok(pushed.quipu.size > 0, 'the exported graph is empty');
    const inRepo = await page.evaluate((h) => Object.keys(readRemoteFiles()).some((p) => p.includes(h)),
      pushed.quipu.hash);
    assert.ok(inRepo, 'the quipu blob was named but not uploaded');
  });

  await check('without opt-in, no API key leaves the browser', async () => {
    await page.evaluate(() => {
      const s = loadSettings() || {};
      s.api_key = 'sk-SECRET-must-not-travel';
      saveSettingsToStorage(s);
    });
    await state('state_push');
    const leaked = await page.evaluate(() => Object.values(readRemoteFiles())
      .some((t) => t.includes('sk-SECRET-must-not-travel')));
    assert.strictEqual(leaked, false, 'an API key was pushed without opt-in');
  });

  await check('opt-in ALONE does not send keys — a passphrase is also required', async () => {
    const r = await state('state_configure', { include_secrets: true });
    assert.strictEqual(r.includesSecrets, false, 'claimed to sync secrets with no passphrase');
    assert.match(r.note || '', /passphrase/i, 'should say why the opt-in is not in force');
    assert.strictEqual(await page.evaluate(() => _syncCarriesSecrets()), false);
    await state('state_push');
    const leaked = await page.evaluate(() => Object.values(readRemoteFiles())
      .some((t) => t.includes('sk-SECRET-must-not-travel')));
    assert.strictEqual(leaked, false, 'an API key was pushed with no passphrase set');
  });

  await check('status reports the blocked opt-in rather than staying quiet', async () => {
    const s = await state('state_status');
    assert.strictEqual(s.includesSecrets, false);
    assert.match(s.secretsBlockedReason || '', /passphrase/i);
  });

  await check('opt-in plus passphrase sends keys — and they are encrypted at rest', async () => {
    await page.evaluate(() => {
      const c = JSON.parse(localStorage.getItem('creel_state_repo'));
      c.passphrase = 'correct horse battery staple';
      localStorage.setItem('creel_state_repo', JSON.stringify(c));
    });
    assert.strictEqual(await page.evaluate(() => _syncCarriesSecrets()), true);
    await state('state_push');
    const plaintext = await page.evaluate(() => Object.values(readRemoteFiles())
      .some((t) => t.includes('sk-SECRET-must-not-travel')));
    assert.strictEqual(plaintext, false, 'the key was written to the repo in the clear');
    const encrypted = await page.evaluate(() => Object.keys(readRemoteFiles()).some((p) => p.endsWith('.bin')));
    assert.ok(encrypted, 'nothing was written through the encryption envelope');
  });

  await check('a repo that turns public between pushes stops the next one', async () => {
    await page.evaluate(() => { window.__gh.repoPrivate = false; });
    const before = await page.evaluate(() => window.__gh.commits.length);
    const err = await state('state_push').then(() => null, (e) => e.message);
    assert.ok(err, 'pushed to a repo that had become public');
    assert.match(err, /PUBLIC/);
    assert.strictEqual(await page.evaluate(() => window.__gh.commits.length), before,
      'a commit was made despite the refusal');
    await page.evaluate(() => { window.__gh.repoPrivate = true; });
  });

  await check('a pull restores state that was changed after the push', async () => {
    // Drop the passphrase so this round-trip is legible in the assertions;
    // the encryption path is covered above.
    await page.evaluate(() => {
      const c = CreelState.loadCfg(); c.passphrase = ''; c.includeSecrets = false;
      CreelState.saveCfg(c); CreelState.reset();
    });
    await page.evaluate(() => {
      const s = loadSettings() || {}; s.temperature = 0.11; saveSettingsToStorage(s);
    });
    await state('state_push');
    await page.evaluate(() => {
      const s = loadSettings() || {}; s.temperature = 0.99; saveSettingsToStorage(s);
    });
    assert.strictEqual(await page.evaluate(() => loadSettings().temperature), 0.99);

    await state('state_pull');
    assert.strictEqual(await page.evaluate(() => loadSettings().temperature), 0.11,
      'the pulled settings did not replace the local ones');
  });

  await check('a pull hands the pushed graph bytes back to quipu', async () => {
    // The graph is restored by importDb; watch the call rather than wiping
    // OPFS, so the assertion is about the bytes that crossed the boundary.
    const seen = await page.evaluate(async () => {
      const real = window.CreelQuipu.importDb;
      let got = null;
      window.CreelQuipu.importDb = async (bytes) => {
        got = Array.from(bytes.slice(0, 16));
        return { ok: true };   // do not actually replace the live store
      };
      try {
        await window.CreelState.handle({
          jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'state_pull', arguments: {} },
        });
      } finally { window.CreelQuipu.importDb = real; }
      const manifest = JSON.parse(readRemoteFiles()['state/manifest.json']);
      return { got, quipu: manifest.quipu };
    });
    if (!seen.quipu) return;   // no graph in this checkout — nothing to restore
    assert.ok(seen.got, 'the pull never handed the graph to quipu');
    // SQLite's file magic: what came back is a database, not an empty buffer
    // or a stray JSON object.
    const magic = String.fromCharCode(...seen.got.slice(0, 6));
    assert.strictEqual(magic, 'SQLite', 'what was restored is not a database: ' + magic);
  });

  await check('a tab has a stable slice id of its own', async () => {
    const a = await page.evaluate(() => CreelState.tabScope());
    assert.ok(a, 'the tab has no slice id at all');
    // Stable within the tab — a slice that changes identity is not a slice.
    assert.strictEqual(await page.evaluate(() => CreelState.tabScope()), a);
    const status = await state('state_status');
    assert.match(status.agentSlice, /^state\/agents\//, 'status does not say where the slice lands');
    assert.ok(status.agentSlice.includes(a), 'the reported slice is not this tab\'s');
  });

  await check('an agent push lands beside the shared state, not on top of it', async () => {
    const sharedBefore = await page.evaluate(() => Object.keys(readRemoteFiles())
      .filter((p) => p.startsWith('state/') && !p.startsWith('state/agents/')).sort());
    const r = await state('state_push', { scope: 'agent' });
    assert.strictEqual(r.scope, 'agent');
    assert.match(r.prefix, /^state\/agents\//);

    const paths = await page.evaluate(() => Object.keys(readRemoteFiles()));
    assert.ok(paths.some((p) => p.startsWith(r.prefix + '/objects/')),
      'the agent slice wrote no objects under its own prefix');
    assert.ok(paths.includes(r.prefix + '/manifest.json'), 'the slice has no manifest of its own');

    // The shared state is untouched: two scopes, two trees.
    const sharedAfter = await page.evaluate(() => Object.keys(readRemoteFiles())
      .filter((p) => p.startsWith('state/') && !p.startsWith('state/agents/')).sort());
    assert.deepStrictEqual(sharedAfter, sharedBefore, 'an agent push disturbed the shared state');
  });

  await check('two tabs get two slices, and neither is the other', async () => {
    const other = await browser.newPage('/onepagent.html#creel-agent=beta1');
    await other.waitForFunction(() => !!window.CreelState, { message: 'state backend' });
    const mine = await page.evaluate(() => CreelState.tabScope());
    const theirs = await other.evaluate(() => CreelState.tabScope());
    assert.notStrictEqual(mine, theirs, 'two tabs resolved to the same slice');
    assert.strictEqual(theirs, 'beta1', 'a spawned agent tab should use its fleet agent id');
    await other.close();
  });

  await check('after a scoped push the shared scope is still the default', async () => {
    // withScope must not leak: a push that left the scope set would silently
    // redirect every later operation into one tab's slice.
    assert.strictEqual(await page.evaluate(() => CreelState.syncConfig().prefix), 'state');
    const r = await state('state_push');
    assert.strictEqual(r.scope, 'shared');
    assert.strictEqual(r.prefix, 'state');
  });

  await check('a tab stamps its own group on the facts it ingests', async () => {
    const booted = await page.evaluate(async () => {
      try { await window.CreelQuipu.ensureWasm(); return true; } catch { return false; }
    });
    if (!booted) return;   // no wasm bundle in this checkout

    const group = await page.evaluate(() => window.CreelQuipu.tabGroupId());
    assert.match(group, /^agent:/, 'the tab has no graph group');

    // Ingest through the MCP surface an agent uses, with no group_id given.
    const seen = await page.evaluate(async () => {
      const real = window.CreelQuipu.provider.callTool.bind(window.CreelQuipu.provider);
      let sawArgs = null;
      window.CreelQuipu.provider.callTool = (name, args) => {
        if (name === 'quipu_episode') sawArgs = args;
        return real(name, args);
      };
      try {
        await window.CreelQuipu.handle({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'quipu_episode', arguments: {
            name: 'creel-age-probe', episode_body: 'a fact written by one tab',
            nodes: [{ name: 'probe-entity', type: 'Probe', description: 'x' }], edges: [],
          } },
        });
      } finally { window.CreelQuipu.provider.callTool = real; }
      return sawArgs;
    });
    assert.ok(seen, 'the episode never reached the provider');
    assert.strictEqual(seen.group_id, group, 'the episode was not stamped with the tab group');
  });

  await check('an explicit group always wins over the tab default', async () => {
    const booted = await page.evaluate(() => !!window.CreelQuipu.provider);
    if (!booted) return;
    const seen = await page.evaluate(async () => {
      const real = window.CreelQuipu.provider.callTool.bind(window.CreelQuipu.provider);
      let sawArgs = null;
      window.CreelQuipu.provider.callTool = (name, args) => { sawArgs = args; return real(name, args); };
      try {
        await window.CreelQuipu.handle({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'quipu_episode', arguments: {
            name: 'creel-age-probe-2', episode_body: 'deliberately shared',
            group_id: 'shared:crew', nodes: [], edges: [],
          } },
        });
      } finally { window.CreelQuipu.provider.callTool = real; }
      return sawArgs;
    });
    assert.strictEqual(seen.group_id, 'shared:crew',
      'an agent writing deliberately into a named group was overridden');
  });

  await check('reads stay fleet-wide — attribution is not isolation', async () => {
    const booted = await page.evaluate(() => !!window.CreelQuipu.provider);
    if (!booted) return;
    // A query carries no group filter unless the caller writes one, so a fact
    // stamped by this tab is still visible to every other tab's reads.
    const seen = await page.evaluate(async () => {
      const real = window.CreelQuipu.provider.callTool.bind(window.CreelQuipu.provider);
      let sawArgs = null;
      window.CreelQuipu.provider.callTool = (name, args) => { sawArgs = args; return real(name, args); };
      try {
        await window.CreelQuipu.handle({
          jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'quipu_cord', arguments: { limit: 5 } },
        });
      } finally { window.CreelQuipu.provider.callTool = real; }
      return sawArgs;
    });
    assert.ok(!('group_id' in seen), 'a read was silently scoped to one tab');
  });

  await check('a push marks state clean, and a change marks it dirty again', async () => {
    // This is the signal the leave guard reads, so it has to track reality:
    // warning about state that is already pushed is the false alarm that
    // makes the real warning worthless.
    await state('state_push');
    assert.strictEqual(await page.evaluate(() => stateIsDirty()), false,
      'state is still dirty right after a successful push');

    await page.evaluate(() => markStateDirty());
    assert.strictEqual(await page.evaluate(() => stateIsDirty()), true);
    const s = await state('state_status');
    assert.strictEqual(s.unpushedChanges, true, 'state_status hides what the guard can see');

    // And the operator can see it without asking: the Sync button is marked.
    const marked = await page.evaluate(() => {
      _renderDirtyIndicator();
      const btn = document.getElementById('syncBtn');
      return { dot: !!btn.querySelector('.sync-dirty-dot'), title: btn.title };
    });
    assert.strictEqual(marked.dot, true, 'nothing on screen says state is unpushed');
    assert.match(marked.title, /unpushed/i);

    await state('state_push');
    assert.strictEqual(await page.evaluate(() => stateIsDirty()), false);
    assert.strictEqual(await page.evaluate(() => {
      _renderDirtyIndicator();
      return !!document.getElementById('syncBtn').querySelector('.sync-dirty-dot');
    }), false, 'the marker outlived the push that cleared it');
  });

  await check('an ordinary edit marks state dirty without anyone asking', async () => {
    await state('state_push');
    // schedulePush is what every mutation path already calls; the dirty stamp
    // rides on it so it cannot be forgotten at a new call site.
    await page.evaluate(() => schedulePush());
    assert.strictEqual(await page.evaluate(() => stateIsDirty()), true,
      'a local mutation did not mark state unpushed');
  });

  await check('the settings block round-trips the config an agent set', async () => {
    // Settings is where a human configures this, so what the tools write must
    // show up there — and what the fields say must be what gets saved.
    // Set a known config through the tool surface, so this test asserts the
    // UI reflects the config rather than whatever the previous test left.
    await state('state_configure', { repo: 'creel-state', branch: 'main', include_secrets: true });
    await page.evaluate(() => openSettingsModal());
    const shown = await page.evaluate(() => ({
      enabled: document.getElementById('setStateEnabled').checked,
      owner: document.getElementById('setStateOwner').value,
      repo: document.getElementById('setStateRepo').value,
      branch: document.getElementById('setStateBranch').value,
      prefix: document.getElementById('setStatePrefix').value,
      secrets: document.getElementById('setStateSecrets').checked,
    }));
    assert.deepStrictEqual(
      { enabled: shown.enabled, owner: shown.owner, repo: shown.repo, branch: shown.branch },
      { enabled: true, owner: 'stiwi', repo: 'creel-state', branch: 'main' });
    assert.strictEqual(shown.secrets, true, 'the include-secrets opt-in did not survive to the UI');

    await page.evaluate(() => {
      document.getElementById('setStatePrefix').value = 'elsewhere';
      _saveStateCfgFromModal();
    });
    assert.strictEqual(await page.evaluate(() => CreelState.syncConfig().prefix), 'elsewhere');
    await page.evaluate(() => {
      document.getElementById('setStatePrefix').value = 'state';
      _saveStateCfgFromModal();
    });
  });

  await check('turning the state repo off hands sync back to S3', async () => {
    await page.evaluate(() => {
      document.getElementById('setStateEnabled').checked = false;
      _saveStateCfgFromModal();
    });
    assert.notStrictEqual(await page.evaluate(() => _syncCfg()?.backend), 'github');
    await page.evaluate(() => {
      document.getElementById('setStateEnabled').checked = true;
      _saveStateCfgFromModal();
    });
    assert.strictEqual(await page.evaluate(() => _syncCfg().backend), 'github');
  });

  await page.close();
  await browser.close();

  console.log('creel state repo');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
