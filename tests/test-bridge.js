/* The creel bridge: handshake, capability negotiation, and the origin guard.
 *
 * Two claims are tested, both of which a reader of either half alone would
 * miss because they live in the seam between the page and the extension:
 *
 * 1. DISCOVERY SURVIVES THE LOAD-ORDER RACE. The connector runs at
 *    document_start; browser-backend.js is the last script tag in an 18k-line
 *    document. Any design where the page must ALREADY be listening when the
 *    extension announces itself loses that race and the bridge looks absent.
 *    So the connector is driven here in the hostile order — announcing into
 *    the void before the page exists — and the page must still find it.
 *
 * 2. THE BRIDGE WILL NOT TOUCH CREEL'S OWN ORIGINS. That is the whole reason
 *    an agent cannot puppet its own harness through the side door, so it is
 *    asserted per op rather than assumed from a shared helper.
 *
 * Run: node tests/test-bridge.js   (or `just test`)
 */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const BACKEND_JS = read('app', 'browser-backend.js');
const CONNECTOR_JS = read('extension', 'creel-connector.js');
const WORKER_JS = read('extension', 'background.js');

const ORIGIN = 'http://localhost:8420';

/** A window whose postMessage really is asynchronous, because the whole bug
 *  class this guards against is about ordering. */
function makeWindow() {
  const listeners = [];
  const win = {
    location: { origin: ORIGIN, href: `${ORIGIN}/onepagent.html` },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    postMessage(data) {
      setImmediate(() => listeners.forEach((fn) => fn({ source: win, origin: ORIGIN, data })));
    },
  };
  return win;
}

/** The extension's background worker, with chrome stubbed down to a tab table.
 *  executeScript is recorded rather than executed: what is under test here is
 *  routing and the guards, not the injected DOM code. */
function bootWorker() {
  const tabs = new Map();
  let nextId = 1;
  const injected = [];
  const store = {};
  const addTab = (url, active = false) => {
    const tab = { id: nextId++, url, title: `page ${url}`, active };
    tabs.set(tab.id, tab);
    return tab;
  };
  let listener = null;
  const EXT_ID = 'test-extension-id';
  const chrome = {
    runtime: {
      id: EXT_ID,
      onMessage: { addListener: (fn) => { listener = fn; } },
    },
    storage: {
      // A real chrome.storage.local, tiny: the background persists the
      // creel-origins override here, and the popup edits it through ops that
      // read/write this same store.
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (k) => { delete store[k]; },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      query: async (q) => [...tabs.values()].filter((t) => (q.active == null || t.active === q.active)),
      get: async (id) => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`); return tabs.get(id); },
      create: async ({ url }) => addTab(url, true),
      update: async (id, { url }) => { tabs.get(id).url = url; return tabs.get(id); },
      remove: async (id) => { tabs.delete(id); },
      reload: async () => {},
      goBack: async () => {},
      goForward: async () => {},
    },
    scripting: {
      executeScript: async ({ target, args }) => { injected.push({ tabId: target.tabId, args }); return [{ result: { ok: true, injected: true } }]; },
    },
  };
  const sandbox = { chrome, console, setTimeout, clearTimeout, URL, Promise };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WORKER_JS, sandbox);
  assert.ok(listener, 'the worker registered an onMessage listener');

  /** Call an op as the connector would, from a tab on a creel origin.
   *  `sender` is either a URL string (connector-style, from that tab) or a
   *  full sender object — pass { id: EXT_ID } to speak as the extension's own
   *  popup, which is the second trust path the worker allows. */
  const send = (op, args, sender = `${ORIGIN}/onepagent.html`) => new Promise((resolve) => {
    const senderObj = typeof sender === 'string'
      ? { tab: { url: sender } }
      : sender;
    listener({ op, args }, senderObj, resolve);
  });
  return { send, addTab, tabs, injected, store, EXT_ID };
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

(async () => {
  // ── the page half, discovered against the load-order race ────────
  const win = makeWindow();
  const worker = bootWorker();

  // The connector, booted BEFORE the page — the hostile order. Its opening
  // announcement lands in a window with no listener at all.
  const connectorSandbox = {
    window: win,
    document: { addEventListener: () => {} },
    console,
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: (msg, cb) => { worker.send(msg.op, msg.args).then(cb); },
      },
    },
  };
  connectorSandbox.globalThis = connectorSandbox;
  vm.createContext(connectorSandbox);
  vm.runInContext(CONNECTOR_JS, connectorSandbox);
  await new Promise((r) => setImmediate(r));   // let the lost hello go by

  // Now the page's server loads, as it does in onepagent.html: dead last.
  let server = null;
  const pageSandbox = {
    window: win,
    document: { readyState: 'complete', addEventListener: () => {} },
    console,
    setTimeout,
    clearTimeout,
    mcpServers: [],
    saveMcpServers: () => {},
    mcpConnectServer: async () => {},
    mcpReconnectServer: async () => {},
    renderMcpServerList: () => {},
  };
  // The page's server reaches for window.CreelInpage; here `window` is the
  // shared message bus object, not the sandbox global, so hang it there.
  win.CreelInpage = { register: (url, s) => { server = s; } };
  pageSandbox.globalThis = pageSandbox;
  vm.createContext(pageSandbox);
  vm.runInContext(BACKEND_JS, pageSandbox);
  assert.ok(server, 'the browser server registered itself');

  let id = 0;
  const call = async (name, args) => {
    const res = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args || {} } });
    if (res.error) throw new Error(res.error.message);
    return JSON.parse(res.result.content[0].text);
  };
  // Spread into a host array: values crossing a vm realm boundary are not
  // reference-equal to host prototypes, which deepStrictEqual objects to.
  const toolNames = async () => [...(await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/list' })).result.tools].map((t) => t.name);

  await check('before discovery completes, only browser_status is offered', async () => {
    assert.deepStrictEqual(await toolNames(), ['browser_status']);
  });

  await check('the page pings and finds a bridge that already announced into the void', async () => {
    await new Promise((r) => setTimeout(r, 500));       // a few ping rounds
    const s = await call('browser_status');
    assert.strictEqual(s.bridge_installed, true, 'the lost hello did not doom discovery');
    assert.strictEqual(s.version, '0.4.0');
  });

  await check('the full toolset appears once the bridge is found', async () => {
    const names = await toolNames();
    for (const t of ['browser_open_tab', 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_press', 'browser_attach_file', 'browser_wait_for', 'browser_close_tab']) {
      assert.ok(names.includes(t), `${t} offered`);
    }
  });

  await check('tools are negotiated: an op the installed bridge lacks is not offered', async () => {
    // Re-announce as an older extension that predates snapshot/press.
    win.postMessage({ __creel: 'creel-bridge:hello', version: '0.1.0', ops: ['list_tabs', 'open_tab', 'read', 'click'] });
    await new Promise((r) => setImmediate(r));
    const names = await toolNames();
    assert.ok(names.includes('browser_open_tab'));
    assert.ok(!names.includes('browser_snapshot'), 'an unimplemented op is hidden, not offered then failed');
    assert.ok(!names.includes('browser_press'));
    // and calling one anyway explains itself rather than saying "unknown op"
    await assert.rejects(() => call('browser_snapshot'), /does not implement/);
  });

  // ── the worker half: the origin guard, op by op ──────────────────
  const site = worker.addTab('https://example.com/');
  const creelTab = worker.addTab(`${ORIGIN}/onepagent.html`);

  await check('a sender that is not on a creel origin is refused outright', async () => {
    const r = await worker.send('list_tabs', {}, 'https://evil.example/');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /unauthorized/);
  });

  await check('list_tabs hides creel\'s own tabs', async () => {
    const r = await worker.send('list_tabs', {});
    assert.ok(r.ok);
    assert.ok(r.result.some((t) => t.url === 'https://example.com/'));
    assert.ok(!r.result.some((t) => t.url.startsWith(ORIGIN)), 'creel tabs are not listed');
  });

  await check('every DOM op refuses a creel-origin tab', async () => {
    for (const [op, args] of [
      ['read', {}], ['query', { selector: 'a' }], ['snapshot', {}], ['click', { selector: 'a' }],
      ['fill', { selector: 'a', value: 'x' }], ['press', {}], ['scroll', {}], ['wait_for', { selector: 'a' }],
      ['select_option', { selector: 's', value: 'x' }], ['close_tab', {}], ['navigate', { url: 'https://ok.example' }],
      ['history', { action: 'back' }], ['attach_file', { selector: 'input[type=file]', files: [{ name: 'x.txt', content: 'x' }] }],
    ]) {
      const r = await worker.send(op, { ...args, tabId: creelTab.id });
      assert.strictEqual(r.ok, false, `${op} should refuse`);
      assert.match(r.error, /refusing/, `${op}: ${r.error}`);
    }
  });

  await check('opening or navigating TO a creel origin is refused', async () => {
    const a = await worker.send('open_tab', { url: `${ORIGIN}/onepagent.html` });
    assert.strictEqual(a.ok, false);
    const b = await worker.send('navigate', { url: 'http://127.0.0.1:8420/x', tabId: site.id });
    assert.strictEqual(b.ok, false);
  });

  await check('bare hosts become https, non-web schemes are rejected', async () => {
    const ok = await worker.send('open_tab', { url: 'example.org', wait: false });
    assert.strictEqual(ok.result.url, 'https://example.org/');
    const bad = await worker.send('open_tab', { url: 'file:///etc/passwd' });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /only http\/https/);
  });

  await check('the tab the bridge last opened becomes the default target', async () => {
    const opened = await worker.send('open_tab', { url: 'https://target.example', wait: false });
    const before = worker.injected.length;
    const r = await worker.send('click', { selector: '#go' });          // no tabId
    assert.ok(r.ok, r.error);
    assert.strictEqual(worker.injected[before].tabId, opened.result.tabId, 'acted on the working tab, not the active one');
  });

  await check('__ops advertises the op surface for negotiation', async () => {
    const r = await worker.send('__ops', {});
    assert.strictEqual(r.result.version, '0.4.0');
    assert.ok(r.result.ops.includes('snapshot'));
    assert.ok(r.result.ops.includes('attach_file'));
    assert.ok(!r.result.ops.includes('__ops'), 'the meta op is not advertised as a capability');
  });

  // ── v-next: attach_file through the tool surface ─────────────────
  await check('attach_file routes to the locator engine with the files payload', async () => {
    const files = [{ name: 'receipt.pdf', base64: 'JVBERi0=', mimeType: 'application/pdf' }, { name: 'note.txt', content: 'hi there' }];
    const before = worker.injected.length;
    const r = await worker.send('attach_file', { tabId: site.id, selector: 'input[type=file]', files });
    assert.ok(r.ok, r.error);
    assert.ok(worker.injected.length > before, 'the engine was reached');
    const last = worker.injected[worker.injected.length - 1];
    assert.strictEqual(last.tabId, site.id, 'acted on the requested tab');
    assert.strictEqual(last.args[0], 'attach_file', 'the injected dispatcher got the op name');
    assert.deepStrictEqual([...last.args[1].files], files, 'the files travel verbatim to the page-side engine');
  });

  // ── v-next: the popup owns the creelOrigins boundary ─────────────
  const POPUP = { id: worker.EXT_ID };
  let DEFAULTS = [];

  await check('the popup (an extension page) can read the boundary', async () => {
    const r = await worker.send('list_origins', {}, POPUP);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.result.version, '0.4.0');
    DEFAULTS = [...r.result.origins];
    assert.deepStrictEqual([...r.result.origins], [...r.result.defaults], 'with no override, the effective list is the defaults');
    assert.match(r.result.pagesPrefix, /^https:\/\/scbrown\.github\.io\/creel$/);
  });

  await check('set_origins normalizes entries to exact origins (incl. port), persisting to storage', async () => {
    const r = await worker.send('set_origins', { origins: ['localhost:3000/some/path', 'http://127.0.0.1:5000'] }, POPUP);
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual([...r.result.origins], ['http://127.0.0.1:5000', 'https://localhost:3000'], 'bare host → https, path dropped');
    assert.deepStrictEqual([...worker.store.creelOrigins], ['http://127.0.0.1:5000', 'https://localhost:3000'], 'persisted for the next worker boot');
  });

  await check('duplicate origins (post-normalization) are rejected', async () => {
    const r = await worker.send('set_origins', { origins: ['http://localhost:3000', 'http://localhost:3000/page'] }, POPUP);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /duplicate/);
  });

  await check('the popup-edited boundary gates both directions, exactly, port included', async () => {
    // First make the boundary interesting: trust exactly one dev port.
    await worker.send('set_origins', { origins: ['http://localhost:3000'] }, POPUP);
    // Trust: a sender on the added origin may command the bridge now…
    const trusted = await worker.send('list_tabs', {}, 'http://localhost:3000/x');
    assert.ok(trusted.ok, 'an added origin is trusted: ' + trusted.error);
    // …but its port-neighbour is still a stranger.
    const stranger = await worker.send('list_tabs', {}, 'http://localhost:3001/x');
    assert.strictEqual(stranger.ok, false);
    assert.match(stranger.error, /unauthorized/);
    // Action: the bridge now refuses to open/navigate the added origin…
    const open = await worker.send('open_tab', { url: 'http://localhost:3000/x', wait: false });
    assert.strictEqual(open.ok, false, 'an added creel origin is refused as a target');
    assert.match(open.error, /refusing/);
    // …while its port-neighbour stays drivable.
    const openNeighbour = await worker.send('open_tab', { url: 'http://localhost:3001/x', wait: false });
    assert.ok(openNeighbour.ok, openNeighbour.error);
  });

  await check('empty list resets to defaults and un-locks the override', async () => {
    const r = await worker.send('set_origins', { origins: [] }, POPUP);
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual([...r.result.origins], DEFAULTS, 'an empty override means the defaults are in force again');
    assert.strictEqual(worker.store.creelOrigins, undefined, 'the override was cleared, not stored');
    const open = await worker.send('open_tab', { url: 'http://localhost:3000/x', wait: false });
    assert.ok(open.ok, 'localhost:3000 is drivable again: ' + open.error);
  });

  await check('a website can neither read nor edit the boundary', async () => {
    const read = await worker.send('list_origins', {}, 'https://evil.example/');
    assert.strictEqual(read.ok, false);
    assert.match(read.error, /unauthorized/);
    const edit = await worker.send('set_origins', { origins: ['https://evil.example'] }, 'https://evil.example/');
    assert.strictEqual(edit.ok, false);
    assert.match(edit.error, /unauthorized/);
    // The popup path still works after the attempted tamper.
    const ok = await worker.send('list_origins', {}, POPUP);
    assert.ok(ok.ok);
  });

  console.log('creel bridge');
  console.log(results.join('\n'));
  console.log(process.exitCode ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(process.exitCode || 0);
})();
