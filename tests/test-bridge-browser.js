/* The bridge, end to end, in a real browser with the real extension loaded.
 *
 * tests/test-bridge.js proves the handshake and the guards against stubs.
 * This proves the thing stubs cannot: that Chromium actually loads the
 * extension, that the connector reaches the service worker, that the worker
 * reaches a genuinely cross-origin page, and that the locator engine can be
 * installed into a site whose CSP forbids eval.
 *
 * That last point is why the fixture sets `script-src 'self'`. An
 * implementation that shipped the locator engine by evaluating source in the
 * page would pass every other test here and fail on any real website.
 *
 * Two origins are served on two ports: creel on one (127.0.0.1 matches the
 * bridge's allowed-commander list) and the fixture site on the other.
 *
 * Run: node tests/test-bridge-browser.js   (or `just test`)
 * Skips cleanly (exit 0) when no Chromium is present.
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { Browser } = require('./browser.js');

const ROOT = path.join(__dirname, '..');
const results = [];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 4).join('\n       ')}`); failures++; }
};

(async () => {
  if (!Browser.available()) {
    console.log('creel bridge (real browser + extension)\n  skipped — no Chromium found');
    process.exit(0);
  }

  const browser = await Browser.launch({
    root: path.join(ROOT, 'app'),
    extension: path.join(ROOT, 'extension'),
  });
  const site = await browser.serveExtra(path.join(ROOT, 'tests', 'fixtures'));

  // Both servers are on 127.0.0.1 with random ports, so this test only means
  // anything if the bridge distinguishes them BY PORT. Point it at creel's
  // port through the documented config path — which is also what a user on a
  // non-default port has to do.
  const worker = await browser.extensionWorker();
  await worker.evaluate((origin) => chrome.storage.local.set({ creelOrigins: [origin] }), browser.origin);
  await new Promise((r) => setTimeout(r, 300));

  const creel = await browser.newPage('/onepagent.html');
  await creel.waitForFunction(() => !!window.CreelBrowser, { message: 'the browser server' });

  let callId = 0;
  const tool = async (name, args = {}) => {
    const res = await creel.evaluate(async (n, a, id) => {
      const reply = await window.CreelBrowser.handle({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: n, arguments: a },
      });
      if (reply.error) return { __error: reply.error.message };
      return JSON.parse(reply.result.content[0].text);
    }, name, args, ++callId);
    if (res && res.__error) throw new Error(res.__error);
    return res;
  };
  const toolNames = async () => creel.evaluate(async () => {
    const r = await window.CreelBrowser.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    return r.result.tools.map((t) => t.name);
  });

  let tabId = null;

  await check('Chromium loads the extension and its service worker starts', async () => {
    assert.strictEqual(await worker.evaluate(() => VERSION), '0.3.0');
  });

  await check('the creel-origin gate distinguishes localhost ports', async () => {
    // The regression this guards: a port-blind check makes every dev server
    // on localhost both undriveable AND able to command the bridge.
    const verdicts = await worker.evaluate((creelOrigin, siteOrigin) => ({
      creel: isCreelUrl(`${creelOrigin}/onepagent.html`),
      otherPort: isCreelUrl(`${siteOrigin}/site.html`),
      pages: isCreelUrl('https://scbrown.github.io/creel/onepagent.html'),
      pagesOtherPath: isCreelUrl('https://scbrown.github.io/somebody-else/'),
    }), browser.origin, site);
    assert.strictEqual(verdicts.creel, true, 'creel\'s own port is creel');
    assert.strictEqual(verdicts.otherPort, false, 'another localhost port is a stranger, not creel');
    assert.strictEqual(verdicts.pages, true);
    assert.strictEqual(verdicts.pagesOtherPath, false, 'a different project on the same Pages host is not creel');
  });

  await check('the page discovers the real bridge through the ping handshake', async () => {
    await creel.waitForFunction(async () => {
      const r = await window.CreelBrowser.handle({
        jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'browser_status', arguments: {} },
      });
      return JSON.parse(r.result.content[0].text).bridge_installed === true;
    }, { timeout: 15000, message: 'the bridge to announce itself' });
    const status = await tool('browser_status');
    assert.strictEqual(status.bridge_installed, true);
    assert.strictEqual(status.version, '0.3.0');
    assert.ok(status.ops.includes('snapshot'), 'the real worker advertises its ops');
  });

  await check('the full locator toolset is offered once connected', async () => {
    const names = await toolNames();
    for (const t of ['browser_snapshot', 'browser_click', 'browser_fill', 'browser_hover', 'browser_check', 'browser_wait_for', 'browser_text']) {
      assert.ok(names.includes(t), `${t} offered`);
    }
  });

  await check('browser_open_tab really opens a cross-origin page', async () => {
    const r = await tool('browser_open_tab', { url: `${site}/site.html`, focus: false });
    tabId = r.tabId;
    assert.match(r.url, /\/site\.html$/);
    assert.strictEqual(r.title, 'Fixture Shop');
  });

  await check('the locator engine installs into a page whose CSP forbids eval', async () => {
    // If this passes, injection is genuinely by file. An eval-based design
    // dies here and nowhere else.
    const snap = await tool('browser_snapshot', { tabId });
    assert.match(snap.snapshot, /button "Place order"/);
    assert.match(snap.snapshot, /textbox "Item name"/);
    assert.match(snap.snapshot, /combobox "Quantity"/);
  });

  await check('a cross-origin page is driven entirely by role and name', async () => {
    await tool('browser_fill', { tabId, role: 'textbox', name: 'Item name', value: 'wool' });
    await tool('browser_select_option', { tabId, role: 'combobox', name: 'Quantity', value: '3' });
    await tool('browser_check', { tabId, role: 'checkbox', name: 'Wrap as a gift' });
    await tool('browser_click', { tabId, role: 'button', name: 'Place order' });
    const banner = await tool('browser_text', { tabId, selector: '#banner' });
    assert.match(banner.text, /Ordered 3 x wool \(gift wrapped\)/);
  });

  await check('refs from a snapshot resolve on the far side', async () => {
    const snap = await tool('browser_snapshot', { tabId, format: 'json' });
    const item = snap.nodes.find((n) => n.name === 'Item name');
    assert.ok(item && item.ref, 'the field has a ref');
    await tool('browser_fill', { tabId, ref: item.ref, value: 'linen' });
    const after = await tool('browser_snapshot', { tabId, format: 'json' });
    assert.strictEqual(after.nodes.find((n) => n.ref === item.ref).value, 'linen', 'the same ref is still the same field');
  });

  await check('auto-waiting works over the bridge on content that appears late', async () => {
    await tool('browser_click', { tabId, role: 'button', name: 'Show delayed notice' });
    const r = await tool('browser_wait_for', { tabId, text: 'being prepared', timeout: 5000 });
    assert.strictEqual(r.found, true);
  });

  await check('a password field is writable but never readable', async () => {
    await tool('browser_fill', { tabId, role: 'textbox', name: 'Card number', value: '4111111111119999' });
    await tool('browser_click', { tabId, role: 'button', name: 'Place order' });

    // The write landed: the page itself echoes only the last four digits.
    const banner = await tool('browser_text', { tabId, selector: '#banner' });
    assert.match(banner.text, /card ends 9999/, 'the value really reached the field');

    // But nothing the agent can call hands the number back.
    const snap = await tool('browser_snapshot', { tabId, format: 'json' });
    const card = snap.nodes.find((n) => n.name === 'Card number');
    assert.ok(card, 'the field is still listed');
    assert.strictEqual(card.credential, 'write-only');
    assert.doesNotMatch(JSON.stringify(snap), /4111111111119999/);
    const read = await tool('browser_read', { tabId });
    assert.doesNotMatch(JSON.stringify(read), /4111111111119999/);
  });

  await check('the bridge still refuses to act on creel\'s own origin', async () => {
    const tabs = await tool('browser_list_tabs');
    assert.ok(!tabs.some((t) => t.url.includes('onepagent.html')), 'creel tabs are hidden');
    // And naming creel explicitly is refused rather than obeyed.
    await assert.rejects(
      () => tool('browser_open_tab', { url: `${browser.origin}/onepagent.html` }),
      /refusing/,
    );
  });

  await check('an ambiguous locator on a real site errors instead of guessing', async () => {
    await assert.rejects(() => tool('browser_click', { tabId, role: 'button' }), /ambiguous/);
  });

  await check('browser_close_tab cleans up', async () => {
    const r = await tool('browser_close_tab', { tabId });
    assert.strictEqual(r.ok, true);
    const tabs = await tool('browser_list_tabs');
    assert.ok(!tabs.some((t) => t.id === tabId), 'the tab is gone');
  });

  await browser.close();

  console.log('creel bridge (real browser + extension)');
  console.log(results.join('\n'));
  console.log(failures ? `\nFAILED (${failures})` : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e.message);
  process.exit(1);
});
