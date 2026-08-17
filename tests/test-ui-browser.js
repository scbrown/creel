/* UI tests: the real creel page, in real Chromium, driven by its own tools.
 *
 * The unit tests (test-ui-crosstab.js) run creel-self.js against a DOM stub,
 * which proves the routing logic but cannot prove the thing that actually
 * matters — that an agent can find and operate the controls of the real
 * 18k-line page. A stub always agrees with you about what the DOM contains.
 * Chromium does not.
 *
 * So these tests boot app/onepagent.html at a real http origin, in a real
 * browser, and drive it exclusively through the `ui` MCP server — the same
 * JSON-RPC surface an agent gets. Nothing here reaches into the page's
 * internals to make an assertion pass that an agent could not also reach.
 *
 * Two tabs are opened for the cross-tab tests, so the BroadcastChannel
 * traffic is genuine browser traffic between genuine tabs.
 *
 * Run: node tests/test-ui-browser.js   (or `just test`)
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
  catch (e) { results.push(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 4).join('\n       ')}`); failures++; }
};

/** Call the ui server exactly as an agent's MCP client would. */
function uiCall(page) {
  let id = 0;
  return async (name, args = {}) => {
    const res = await page.evaluate(async (n, a, callId) => {
      const reply = await window.CreelUi.handle({
        jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: n, arguments: a },
      });
      if (reply.error) return { __error: reply.error.message };
      return JSON.parse(reply.result.content[0].text);
    }, name, args, ++id);
    if (res && res.__error) throw new Error(res.__error);
    return res;
  };
}

(async () => {
  if (!Browser.available()) {
    console.log('creel UI (real browser)\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });
  const alpha = await browser.newPage('/onepagent.html');
  const ui = uiCall(alpha);
  await alpha.waitForFunction(() => !!window.CreelUi && !!window.CreelLocator, { message: 'creel servers' });

  // ── the accessibility surface ────────────────────────────────────

  await check('every visible control in the real page has an accessible name', async () => {
    const nameless = await alpha.evaluate(() => window.CreelLocator
      .snapshot({ limit: 500 })
      .filter((n) => !n.name)
      .map((n) => `${n.role}${n.id ? `#${n.id}` : ''}`));
    assert.deepStrictEqual([...nameless], [],
      `unnamed controls are unreachable by {role,name} — give them an aria-label: ${nameless.join(', ')}`);
  });

  await check('the snapshot names controls by purpose, not by glyph or contents', async () => {
    const text = (await ui('ui_snapshot')).snapshot;
    for (const want of ['Toggle left panel', 'Send message', 'Settings', 'Thinking level']) {
      assert.ok(text.includes(want), `snapshot is missing "${want}"`);
    }
    // A <select>'s options are not its name.
    assert.ok(!/combobox "Think: Auto/.test(text), 'a dropdown must not be named after its option list');
  });

  await check('ui_snapshot returns refs that resolve back to the same element', async () => {
    const json = await ui('ui_snapshot', { format: 'json', filter: 'send' });
    const send = json.nodes.find((n) => n.name === 'Send message');
    assert.ok(send, 'the send button is in the snapshot');
    const same = await alpha.evaluate((ref) => {
      const el = window.CreelLocator.resolve({ ref });
      return el.id;
    }, send.ref);
    assert.strictEqual(same, 'sendBtn');
  });

  // ── locators, Playwright-style ───────────────────────────────────

  await check('locate by role + name', async () => {
    const r = await ui('ui_text', { role: 'button', name: 'Toggle left panel' });
    assert.strictEqual(r.role, 'button');
  });

  await check('a hidden section is genuinely absent, not merely styled away', async () => {
    // The left panel now starts with four sections and reveals the rest on
    // request (creel-ban). A hidden one must be hidden from the agent too:
    // if ui_text could still reach into it, the panel an agent describes and
    // the panel the operator sees would be different panels.
    await assert.rejects(() => ui('ui_text', { label: 'System prompt' }), /no element matches/);
  });

  await check('...and one click on its chip brings it back', async () => {
    // The reveal is an ordinary control with an accessible name, so the agent
    // does exactly what the operator does — no privileged path.
    await ui('ui_click', { role: 'button', name: 'More sections' });
    await ui('ui_click', { role: 'button', name: 'SYSTEM PROMPT' });
    const byLabel = await ui('ui_text', { label: 'System prompt' });
    assert.strictEqual(byLabel.role, 'textbox');
  });

  await check('locate by placeholder and by label', async () => {
    const byPlaceholder = await ui('ui_text', { placeholder: 'Type message' });
    assert.strictEqual(byPlaceholder.name, 'Message to the agent');
    const byLabel = await ui('ui_text', { label: 'System prompt' });
    assert.strictEqual(byLabel.role, 'textbox');
  });

  await check('name matching is substring + case-insensitive, and `exact` tightens it', async () => {
    await ui('ui_text', { role: 'button', name: 'toggle left' });          // substring, wrong case
    await assert.rejects(
      () => ui('ui_text', { role: 'button', name: 'toggle left', exact: true }),
      /no element matches/,
    );
  });

  await check('an ambiguous locator is an error naming the candidates, not a coin flip', async () => {
    await assert.rejects(() => ui('ui_click', { role: 'button' }), (e) => {
      assert.match(e.message, /ambiguous/);
      assert.match(e.message, /\[0\]/, 'the error lists candidates');
      return true;
    });
  });

  await check('`nth` resolves an intentionally plural locator', async () => {
    const r = await ui('ui_text', { role: 'button', nth: 0 });
    assert.strictEqual(r.role, 'button');
  });

  await check('a stale ref fails with a pointer to re-snapshot, and never waits it out', async () => {
    const t0 = Date.now();
    await assert.rejects(() => ui('ui_click', { ref: 'e99999' }), /unknown ref/);
    assert.ok(Date.now() - t0 < 2000, 'a bad ref fails fast rather than auto-waiting');
  });

  // ── auto-waiting ─────────────────────────────────────────────────

  await check('an action auto-waits for a control that appears late', async () => {
    await alpha.evaluate(() => {
      setTimeout(() => {
        const b = document.createElement('button');
        b.id = 'lateBtn';
        b.setAttribute('aria-label', 'Appears late');
        b.onclick = () => { window.__lateClicked = true; };
        document.body.appendChild(b);
      }, 600);
    });
    await ui('ui_click', { role: 'button', name: 'Appears late' });
    assert.strictEqual(await alpha.evaluate(() => window.__lateClicked), true);
  });

  await check('waiting for something that never arrives times out with a useful message', async () => {
    const t0 = Date.now();
    await assert.rejects(
      () => ui('ui_wait_for', { role: 'button', name: 'Never Ever Appears', timeout: 700 }),
      (e) => {
        assert.match(e.message, /timed out after 700ms/);
        assert.match(e.message, /Never Ever Appears/);
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 650 && elapsed < 4000, `honoured the timeout (took ${elapsed}ms)`);
  });

  await check('ui_wait_for state:hidden observes a control going away', async () => {
    await alpha.evaluate(() => setTimeout(() => document.getElementById('lateBtn').remove(), 400));
    const r = await ui('ui_wait_for', { role: 'button', name: 'Appears late', state: 'detached', timeout: 3000 });
    assert.strictEqual(r.found, false);
  });

  // ── acting on the real interface ─────────────────────────────────

  await check('ui_fill writes into the real chat box and the harness sees it', async () => {
    await ui('ui_fill', { placeholder: 'Type message', value: 'hello from an agent' });
    const value = await alpha.evaluate(() => document.getElementById('userInput').value);
    assert.strictEqual(value, 'hello from an agent');
  });

  await check('ui_click really opens the settings modal', async () => {
    await ui('ui_click', { role: 'button', name: 'Settings' });
    await ui('ui_wait_for', { selector: '#settingsModal.show', timeout: 3000 });
    assert.strictEqual(await alpha.evaluate(() => !!document.querySelector('#settingsModal.show')), true);
  });

  await check('ui_select_option drives a real dropdown', async () => {
    const r = await ui('ui_select_option', { role: 'combobox', name: 'Thinking level', value: 'high' });
    assert.strictEqual(r.selected, 'high');
    assert.strictEqual(await alpha.evaluate(() => document.getElementById('thinkSelect').value), 'high');
  });

  await check('ui_select_option names the real options when asked for one that does not exist', async () => {
    await assert.rejects(
      () => ui('ui_select_option', { role: 'combobox', name: 'Thinking level', value: 'telepathy' }),
      /available:.*"max"/s,
    );
  });

  // ── credentials: writable, never readable ────────────────────────

  await check('ui_fill CAN write a credential field — that is the point', async () => {
    const r = await ui('ui_fill', { selector: '#setApiKey', value: 'sk-operator-supplied-secret' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.credential, true);
    const landed = await alpha.evaluate(() => document.getElementById('setApiKey').value);
    assert.strictEqual(landed, 'sk-operator-supplied-secret', 'the write really reached the field');
  });

  await check('...but the result does not echo it back', async () => {
    const r = await ui('ui_fill', { selector: '#setApiKey', value: 'sk-another-secret' });
    assert.doesNotMatch(JSON.stringify(r), /sk-another-secret/, 'the value must not appear in the tool result');
    assert.match(r.wrote, /characters/, 'only the length is reported');
  });

  await check('ui_snapshot masks credential values while still listing the field', async () => {
    const text = (await ui('ui_snapshot', { filter: 'key' })).snapshot;
    assert.doesNotMatch(text, /sk-another-secret/);
    assert.match(text, /write-only/, 'the field is visible and marked write-only');
  });

  await check('ui_text cannot be used to read a credential back out', async () => {
    const r = await ui('ui_text', { selector: '#setApiKey' });
    assert.doesNotMatch(JSON.stringify(r), /sk-another-secret/);
  });

  await check('ui_set_credential persists a real provider key that no tool can read', async () => {
    await alpha.evaluate(() => {
      localStorage.setItem('ba_providers_v1', JSON.stringify({
        providers: { prov_test: { id: 'prov_test', name: 'Test Provider', type: 'openai', endpoint: 'https://example.test', apiKey: '' } },
      }));
      localStorage.setItem('ba_active_provider_id', 'prov_test');
    });
    const r = await ui('ui_set_credential', { value: 'sk-live-key-9876' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.provider, 'Test Provider');
    assert.doesNotMatch(JSON.stringify(r), /sk-live-key-9876/, 'not echoed');

    // The test is the operator, not the agent: reading storage directly is
    // allowed here, and is how we prove the WRITE actually happened.
    const stored = await alpha.evaluate(() => JSON.parse(localStorage.getItem('ba_providers_v1')).providers.prov_test.apiKey);
    assert.strictEqual(stored, 'sk-live-key-9876', 'the credential was really persisted');

    // The agent's view: present, never valued.
    const described = await ui('ui_describe');
    assert.strictEqual(described.provider.hasKey, true, 'an agent can tell a key EXISTS');
    assert.doesNotMatch(JSON.stringify(described), /sk-live-key-9876/, 'but never what it is');
  });

  await check('no ui tool anywhere leaks the stored credential', async () => {
    const surfaces = [
      ['ui_snapshot', { all: true, limit: 400 }],
      ['ui_snapshot', { format: 'json', limit: 400 }],
      ['ui_describe', {}],
      ['ui_transcript', {}],
      ['ui_tabs', {}],
    ];
    for (const [name, args] of surfaces) {
      const out = JSON.stringify(await ui(name, args));
      assert.doesNotMatch(out, /sk-live-key-9876|sk-another-secret|sk-operator-supplied-secret/, `${name} leaked a credential`);
    }
  });

  // ── the world model, in the real quipu store ─────────────────────

  await check('the root pane seeds its world model into the real graph', async () => {
    await alpha.waitForFunction(() => window.CreelSelf.role === 'root', { message: 'root election' });
    const found = await alpha.evaluate(async () => {
      await window.CreelQuipu.ensureWasm();
      const r = await window.CreelQuipu.provider.callTool('quipu_query', {
        query: `SELECT ?s WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "${window.CreelSelf.worldVersion}" } LIMIT 1`,
      });
      return r.count;
    });
    assert.strictEqual(found, 1, 'the current world model is in the store');
  });

  await check('a newer world model declares what it supersedes, without rewriting it', async () => {
    // Seed a later version against a store that already holds the current
    // one — the only way to exercise the supersedes path (creel-b8b).
    const out = await alpha.evaluate(async () => {
      await window.CreelSelf.seedWorldModel('creel-world-model-v99');
      const q = async (query) => (await window.CreelQuipu.provider.callTool('quipu_query', { query }));
      const supersedes = await q(`SELECT ?o WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "creel-world-model-v99" . ?s ?p ?o }`);
      const older = await q(`SELECT ?s WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "${window.CreelSelf.worldVersion}" } LIMIT 1`);
      return { v99: (await q('SELECT ?s WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "creel-world-model-v99" } LIMIT 1')).count, olderStillPresent: older.count, links: supersedes.count };
    });
    assert.strictEqual(out.v99, 1, 'the newer version seeded');
    assert.strictEqual(out.olderStillPresent, 1, 'the older version is kept as history, not rewritten');
    assert.ok(out.links > 0, 'the newer version carries relationships, including what it supersedes');
  });

  // ── cross-tab, in a real browser ─────────────────────────────────

  const beta = await browser.newPage('/onepagent.html#creel-agent=btest');
  await beta.waitForFunction(() => !!window.CreelUi && !!window.CreelLocator, { message: 'second tab ready' });

  await check('ui_tabs sees the other real tab over a real BroadcastChannel', async () => {
    const { tabs } = await ui('ui_tabs');
    assert.strictEqual(tabs.length, 2, `expected 2 tabs, saw ${tabs.length}`);
    const bobbin = tabs.find((t) => t.role === 'bobbin');
    assert.ok(bobbin, 'the agent tab identifies as a bobbin');
    assert.strictEqual(bobbin.agentId, 'btest');
  });

  await check('a snapshot routed to the other tab describes THAT tab', async () => {
    const r = await ui('ui_snapshot', { tab: 'btest', filter: 'send' });
    assert.ok(r._tab, 'the answer came from another tab');
    assert.match(r.snapshot, /Send message/);
  });

  await check('an action routed to the other tab changes only that tab', async () => {
    await ui('ui_fill', { tab: 'btest', placeholder: 'Type message', value: 'typed into the bobbin' });
    assert.strictEqual(await beta.evaluate(() => document.getElementById('userInput').value), 'typed into the bobbin');
    assert.strictEqual(await alpha.evaluate(() => document.getElementById('userInput').value), 'hello from an agent',
      'the calling tab was untouched');
  });

  await check('auto-waiting works across the tab boundary too', async () => {
    await beta.evaluate(() => setTimeout(() => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', 'Remote late button');
      b.onclick = () => { window.__remoteClicked = true; };
      document.body.appendChild(b);
    }, 500));
    await ui('ui_click', { tab: 'btest', role: 'button', name: 'Remote late button', timeout: 4000 });
    assert.strictEqual(await beta.evaluate(() => window.__remoteClicked), true);
  });

  await check('an action refuses a control that is present but not visible', async () => {
    // beta has not opened Settings, so its key field exists in the DOM but is
    // not actionable. Playwright's rule, and the right one: acting on an
    // invisible control silently does nothing the user could have done.
    await assert.rejects(
      () => ui('ui_fill', { tab: 'btest', selector: '#setApiKey', value: 'x', timeout: 800 }),
      /not visible/,
    );
  });

  await check('credentials stay write-only across tabs', async () => {
    // Drive the remote tab there the way a user would: open the panel first.
    await ui('ui_click', { tab: 'btest', role: 'button', name: 'Settings' });
    await ui('ui_wait_for', { tab: 'btest', selector: '#settingsModal.show', timeout: 3000 });
    await ui('ui_fill', { tab: 'btest', selector: '#setApiKey', value: 'sk-remote-secret' });
    assert.strictEqual(await beta.evaluate(() => document.getElementById('setApiKey').value), 'sk-remote-secret',
      'the remote write landed');
    const snap = await ui('ui_snapshot', { tab: 'btest', filter: 'key' });
    assert.doesNotMatch(JSON.stringify(snap), /sk-remote-secret/, 'but it cannot be read back across tabs either');
  });

  await check('a tab still refuses to prompt itself, in a real browser', async () => {
    await assert.rejects(() => ui('ui_prompt', { text: 'loop me' }), /loop/);
  });

  await browser.close();

  console.log('creel UI (real browser)');
  console.log(results.join('\n'));
  console.log(failures ? `\nFAILED (${failures})` : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e.message);
  process.exit(1);
});
