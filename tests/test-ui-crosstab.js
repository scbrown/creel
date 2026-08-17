/* Cross-tab ui_ tools: two creel tabs in one process.
 *
 * The claim under test is the one the goal rests on — an agent can do for
 * another creel tab what the operator could do by switching windows. That is
 * only true if a ui_ call with `tab` leaves this tab, runs against the OTHER
 * tab's DOM, and comes back. Reading one file cannot show that; two tabs can.
 *
 * ── What belongs here, and what belongs in the browser suite ──
 * This file owns ROUTING: which tab executes a call, who answers a roster
 * scan, what happens to an unaddressable target, and the semantics that are
 * pure logic (self-prompt refusal, guidance vs new turn, stop when idle).
 * It runs against a DOM stub, which is fast and dependency-free but will
 * always agree with you about what the DOM contains.
 *
 * Anything that depends on a REAL DOM — the locator engine, accessible
 * names, auto-waiting, visibility, credential masking — is tested in
 * tests/test-ui-browser.js against the actual page in actual Chromium,
 * because a stub cannot honestly answer those questions. The locator engine
 * is stubbed here as a spy, purely to prove the ROUTE reaches the right tab.
 *
 * Run: node tests/test-ui-crosstab.js   (or `just test`)
 */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { makeDocument, El } = require('./dom-stub.js');

const SELF_JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'creel-self.js'), 'utf8');

/** Boot one creel tab: its own window/document/sessionStorage, the host's
 *  real BroadcastChannel (what the tabs genuinely share). */
function bootTab({ hash = '', title = 'creel' } = {}) {
  const document = makeDocument();
  document.title = title;

  const store = new Map();
  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    BroadcastChannel,
    Element: El,                        // creel-self's flash() guards on instanceof Element
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    navigator: {},                      // no locks → no root election, no quipu seeding
    location: { hash, origin: 'http://localhost:8420', href: `http://localhost:8420/onepagent.html${hash}` },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    Event: class Event { constructor(type) { this.type = type; } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // The bits of the harness (onepagent.html) that creel-self.js reaches for.
  const registered = new Map();
  sandbox.CreelInpage = { register: (url, server) => registered.set(url, server) };
  sandbox.mcpServers = [{ id: 'mcp_quipu_inpage', name: 'quipu', type: 'inpage', enabled: true }];
  sandbox.mcpTools = [];
  sandbox.API_MODEL = 'deepseek-chat';
  sandbox.sent = [];
  sandbox.runActive = false;
  sandbox.stopped = [];
  sandbox.getActiveConversationRun = () => (sandbox.runActive ? { active: true, convId: 'c1', state: {} } : null);
  sandbox.stopConversationRun = (id) => { sandbox.stopped.push(id); sandbox.runActive = false; };
  sandbox.handleInputChange = () => {};
  sandbox.handleSend = async () => { sandbox.sent.push(document.getElementById('userInput').value); };

  // A spy standing in for app/creel-locator.js. The real engine needs layout
  // and computed styles, which a stub cannot honestly provide — it is
  // exercised for real in tests/test-ui-browser.js. Here it only has to
  // record WHICH TAB an action was executed in.
  sandbox.locatorCalls = [];
  const record = (action) => async (loc, ...rest) => {
    sandbox.locatorCalls.push({ action, loc, rest });
    return { ok: true, action, tabTitle: document.title };
  };
  sandbox.CreelLocator = {
    actions: {
      click: record('click'), fill: record('fill'), type: record('type'),
      hover: record('hover'), check: record('check'), selectOption: record('selectOption'),
      press: record('press'),
    },
    snapshot: () => [],
    snapshotText: () => `snapshot of ${document.title}`,
    text: async (loc) => ({ text: `text of ${document.title}` }),
    waitFor: async () => null,
    role: () => 'button',
    accessibleName: () => 'stub',
  };

  vm.createContext(sandbox);
  vm.runInContext(SELF_JS, sandbox);

  const server = registered.get('inpage:ui');
  assert.ok(server, 'the ui server registered itself');

  let id = 0;
  const call = async (name, args) => {
    const res = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args || {} } });
    if (res.error) throw new Error(res.error.message);
    return JSON.parse(res.result.content[0].text);
  };
  const tools = async () => (await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/list' })).result.tools;

  return { sandbox, document, call, tools, server };
}

/** Give the tab a chat surface and a couple of controls to find. */
function furnish(tab, { messages = [] } = {}) {
  const { document } = tab;
  const input = document.createElement('textarea');
  input.id = 'userInput';
  document.body.appendChild(input);

  const send = document.createElement('button');
  send.id = 'sendBtn';
  send.innerText = 'Send';
  document.body.appendChild(send);

  const key = document.createElement('input');
  key.id = 'setApiKey';
  key.setAttribute('placeholder', 'API key');
  document.body.appendChild(key);

  const chat = document.createElement('div');
  chat.id = 'chatMessages';
  document.body.appendChild(chat);
  for (const m of messages) {
    const el = document.createElement('div');
    el.className = `msg msg-${m.role}`;
    el.innerText = m.text;
    chat.appendChild(el);
  }
  return { input, send, key, chat };
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

(async () => {
  const alpha = bootTab({ title: 'dashboard' });                              // operator tab
  const beta = bootTab({ hash: '#creel-agent=bob1', title: 'bobbin' });       // spawned agent tab
  furnish(alpha);
  const betaEls = furnish(beta, { messages: [
    { role: 'user', text: 'sweep the repo for dead links' },
    { role: 'assistant', text: 'reading README.md' },
  ] });

  await check('every ui tool takes a `tab` argument except ui_tabs', async () => {
    for (const t of await alpha.tools()) {
      const has = Object.prototype.hasOwnProperty.call(t.inputSchema.properties, 'tab');
      assert.strictEqual(has, t.name !== 'ui_tabs', `${t.name} tab arg`);
    }
  });

  await check('ui_tabs discovers both tabs, with roles and agent ids', async () => {
    const { tabs } = await alpha.call('ui_tabs');
    assert.strictEqual(tabs.length, 2, `saw ${tabs.length} tabs`);
    assert.strictEqual(tabs[0].self, true);
    const bobbin = tabs.find((t) => t.role === 'bobbin');
    assert.ok(bobbin, 'the agent tab reports role bobbin');
    assert.strictEqual(bobbin.agentId, 'bob1');
  });

  await check('ui_describe routes to the other tab and reports ITS identity', async () => {
    const mine = await alpha.call('ui_describe');
    const theirs = await alpha.call('ui_describe', { tab: 'bob1' });
    assert.notStrictEqual(mine.tab, theirs.tab, 'a routed call must not run locally');
    assert.strictEqual(theirs.agentId, 'bob1');
    assert.strictEqual(theirs.role, 'bobbin');
    assert.strictEqual(theirs._tab, theirs.tab, 'the answer is stamped with the answering tab');
  });

  await check('a tab addressed by its own tab id runs locally, not over the bus', async () => {
    const me = await alpha.call('ui_describe');
    const again = await alpha.call('ui_describe', { tab: me.tab });
    assert.strictEqual(again._tab, undefined, 'no round trip for self');
  });

  await check('ui_transcript reads the other tab\'s conversation', async () => {
    const t = await alpha.call('ui_transcript', { tab: 'bob1' });
    assert.strictEqual(t.count, 2);
    assert.strictEqual(t.messages[0].role, 'user');
    assert.match(t.messages[0].text, /dead links/);
    assert.strictEqual(t.messages[1].role, 'assistant');
  });

  await check('ui_prompt types into the other tab and sends it', async () => {
    const r = await alpha.call('ui_prompt', { tab: 'bob1', text: 'stop at 20 links' });
    assert.strictEqual(r.sent, true);
    assert.deepStrictEqual(beta.sandbox.sent, ['stop at 20 links']);
    assert.match(r.delivered, /new turn/);
  });

  await check('ui_prompt mid-run reports itself as guidance, not a new turn', async () => {
    beta.sandbox.runActive = true;
    const r = await alpha.call('ui_prompt', { tab: 'bob1', text: 'also check anchors' });
    assert.match(r.delivered, /guidance/);
    beta.sandbox.runActive = false;
  });

  await check('ui_prompt send:false types without sending', async () => {
    const before = beta.sandbox.sent.length;
    const r = await alpha.call('ui_prompt', { tab: 'bob1', text: 'draft only', send: false });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(beta.sandbox.sent.length, before, 'nothing was sent');
    assert.strictEqual(betaEls.input.value, 'draft only');
  });

  await check('a tab refuses to prompt itself — that is a loop', async () => {
    await assert.rejects(() => alpha.call('ui_prompt', { text: 'hi' }), /loop/);
    const me = await alpha.call('ui_describe');
    await assert.rejects(() => alpha.call('ui_prompt', { tab: me.tab, text: 'hi' }), /loop/);
    assert.deepStrictEqual(alpha.sandbox.sent, [], 'nothing reached its own chat');
  });

  await check('ui_stop stops the other tab\'s run, and is safe when idle', async () => {
    beta.sandbox.runActive = true;
    const r = await alpha.call('ui_stop', { tab: 'bob1' });
    assert.strictEqual(r.stopped, true);
    assert.deepStrictEqual(beta.sandbox.stopped, ['c1']);
    const again = await alpha.call('ui_stop', { tab: 'bob1' });
    assert.strictEqual(again.stopped, false);
  });

  await check('ui_snapshot routed to a tab describes THAT tab', async () => {
    const mine = await alpha.call('ui_snapshot');
    const theirs = await alpha.call('ui_snapshot', { tab: 'bob1' });
    assert.match(mine.snapshot, /dashboard/);
    assert.match(theirs.snapshot, /bobbin/, 'the remote tab took its own snapshot');
    assert.strictEqual(theirs._tab, theirs.tab);
  });

  await check('every action tool routes to the addressed tab, not the caller', async () => {
    const cases = [
      ['ui_click', { role: 'button', name: 'Send' }, 'click'],
      ['ui_fill', { selector: '#userInput', value: 'x' }, 'fill'],
      ['ui_type', { selector: '#userInput', text: 'x' }, 'type'],
      ['ui_hover', { role: 'button' }, 'hover'],
      ['ui_check', { role: 'checkbox' }, 'check'],
      ['ui_select_option', { role: 'combobox', value: 'v' }, 'selectOption'],
      ['ui_press', { key: 'Enter' }, 'press'],
    ];
    for (const [tool, args, action] of cases) {
      const before = alpha.sandbox.locatorCalls.length;
      await alpha.call(tool, { ...args, tab: 'bob1' });
      assert.strictEqual(alpha.sandbox.locatorCalls.length, before, `${tool} must not run in the calling tab`);
      const landed = beta.sandbox.locatorCalls.at(-1);
      assert.strictEqual(landed.action, action, `${tool} landed as ${action} in the bobbin`);
    }
  });

  await check('the locator is passed through intact, and `tab` is stripped from it', async () => {
    await alpha.call('ui_click', { tab: 'bob1', role: 'button', name: 'Settings', nth: 2, exact: true });
    const { loc } = beta.sandbox.locatorCalls.at(-1);
    assert.deepStrictEqual({ ...loc }, { role: 'button', name: 'Settings', nth: 2, exact: true });
    assert.strictEqual(loc.tab, undefined, '`tab` is routing, not part of the locator');
  });

  await check('an action with no tab runs locally', async () => {
    const before = beta.sandbox.locatorCalls.length;
    await alpha.call('ui_click', { role: 'button', name: 'Send' });
    assert.strictEqual(alpha.sandbox.locatorCalls.at(-1).action, 'click');
    assert.strictEqual(beta.sandbox.locatorCalls.length, before, 'the other tab was not touched');
  });

  await check('an unknown tab fails with a pointer to ui_tabs, not a hang', async () => {
    const t0 = Date.now();
    await assert.rejects(
      () => alpha.server.handle({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'ui_describe', arguments: { tab: 'nosuchtab' } },
      }).then((r) => { if (r.error) throw new Error(r.error.message); }),
      /ui_tabs/,
    );
    assert.ok(Date.now() - t0 < 25000, 'bounded wait');
  });

  console.log('cross-tab ui tools');
  console.log(results.join('\n'));
  console.log(process.exitCode ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(process.exitCode || 0);
})();
