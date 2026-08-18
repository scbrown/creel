/* UI tests, part two: the surfaces an agent has to drive to do real work.
 *
 * test-ui-browser.js proves the locator engine against the real page — roles,
 * names, refs, auto-waiting, credential masking. This file proves the things
 * an agent actually reaches for once it is past "can I find a button":
 * the conversation list, the FILES workspace, the modals, the theme, and the
 * chat box's own keyboard contract.
 *
 * Those are the surfaces where an accessibility gap is invisible to a human
 * (the mouse works fine) and total for an agent (the control is not in the
 * tree at all). A `<div onclick=...>` has role `generic`, which ui_snapshot
 * does not emit and ui_click cannot resolve — so a conversation list built
 * from divs is, to every agent, an empty list. Testing by {role,name} is the
 * only way that failure shows up.
 *
 * Same rule as its sibling: assertions go through the `ui` MCP server, the
 * JSON-RPC surface an agent gets. Setup may reach into the page (writing a
 * workspace file is a model tool call in real life, not a click), but nothing
 * is *asserted* by a path an agent could not also take.
 *
 * Run: node tests/test-ui-surfaces.js   (or `just test`)
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

/** Start a fresh thread and give it a title. Renaming is an inline-edit flow
 *  in the UI; the test needs the end state, not the keystrokes. */
const titleThread = (page, title) => page.evaluate((t) => {
  newConversation();
  const conv = convHistory.find((c) => c.id === activeConvId);
  conv.title = t;
  conv.titleSource = 'manual';
  conv.titleStatus = 'done';
  saveConvMeta();
  renderConvList();
}, title);

(async () => {
  if (!Browser.available()) {
    console.log('creel UI surfaces (real browser)\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  // A desktop-sized window on purpose: below 1024px creel switches to the
  // mobile layout, where the side panels are off-canvas drawers rather than
  // collapsible columns. Both are real, but they are different surfaces, and
  // the panel tests below are about the desktop one.
  const browser = await Browser.launch({ root: APP, window: '1400,900' });
  const page = await browser.newPage('/thread.html');
  const ui = uiCall(page);
  await page.waitForFunction(() => !!window.CreelUi && !!window.CreelLocator, { message: 'creel servers' });

  // ── names that are actually names ────────────────────────────────

  await check('no control is named by its glyph', async () => {
    // How both of the bugs this file found got in: a `×` button whose only
    // name is "×", a `▼` whose only name is "▼". The name comes from content
    // before it falls back to title, so a decorative character wins over the
    // one string that says what the control does — and then two of them are
    // indistinguishable to an agent that can only address controls by name.
    await page.evaluate(() => { vfsWrite('/named/probe.txt', 'x'); });
    const glyphs = await page.evaluate(() => window.CreelLocator
      .snapshot({ limit: 500 })
      .filter((n) => n.name && !/[\p{L}\p{N}]/u.test(n.name))
      .map((n) => `${n.role} named ${JSON.stringify(n.name)}${n.id ? ` (#${n.id})` : ''}`));
    assert.deepStrictEqual([...glyphs], [],
      'controls named after a symbol — give them an aria-label:\n  ' + glyphs.join('\n  '));
  });

  // ── the conversation list ────────────────────────────────────────
  // An agent asked to "go back to the thread about the parser" has to find it
  // in this list. If the list is not in the accessibility tree, it cannot.

  await check('a conversation in the list is a control an agent can find by name', async () => {
    await titleThread(page, 'the parser thread');
    const found = await ui('ui_snapshot', { filter: 'parser thread' });
    assert.ok(/the parser thread/.test(found.snapshot),
      'a conversation the operator can click is invisible to an agent:\n' + found.snapshot);
  });

  await check('clicking it switches to that thread', async () => {
    const before = await page.evaluate(() => activeConvId);
    await titleThread(page, 'somewhere else');
    assert.notStrictEqual(await page.evaluate(() => activeConvId), before, 'setup: did not move away');
    // `exact`, because a row and its own delete control both contain the
    // title — the locator refuses the ambiguity rather than guessing, which
    // is the whole point of it being an error.
    await ui('ui_click', { role: 'button', name: 'the parser thread', exact: true });
    await ui('ui_wait_for', { role: 'button', name: 'the parser thread', exact: true });
    const title = await page.evaluate(() => (convHistory.find((c) => c.id === activeConvId) || {}).title);
    assert.strictEqual(title, 'the parser thread', 'the click did not switch threads');
  });

  await check('each conversation carries a delete control that says what it deletes', async () => {
    // It is recessed rather than hidden, and that is deliberate: a control
    // revealed only by CSS :hover cannot be reached by an agent at all, since
    // :hover answers to a real pointer and ui_hover dispatches events.
    const text = (await ui('ui_snapshot', { filter: 'Delete conversation' })).snapshot;
    assert.ok(/Delete conversation somewhere else/.test(text),
      'a delete control that does not say WHAT it deletes is a trap:\n' + text);
  });

  await check('search narrows the list, and clearing it brings the rest back', async () => {
    await ui('ui_click', { role: 'button', name: 'Search conversations', exact: true });
    await ui('ui_fill', { role: 'searchbox', name: 'Search conversations', value: 'parser' });
    await ui('ui_wait_for', { role: 'button', name: 'somewhere else', exact: true, state: 'hidden' });
    const narrowed = (await ui('ui_snapshot', { limit: 400 })).snapshot;
    assert.ok(/the parser thread/.test(narrowed), 'search hid the thread it matches');

    await ui('ui_click', { role: 'button', name: 'Clear search' });
    await ui('ui_wait_for', { role: 'button', name: 'somewhere else', exact: true });
  });

  // ── the FILES workspace ──────────────────────────────────────────
  // The workspace is where an agent's output lives before it is pushed. An
  // agent that cannot see the tree cannot check its own work.

  await check('a file written into the workspace shows up as a named control', async () => {
    await page.evaluate(() => {
      vfsWrite('/notes/parser.md', '# parser notes\n');
      vfsWrite('/notes/todo.txt', 'one thing\n');
    });
    const text = (await ui('ui_snapshot', { filter: 'parser.md' })).snapshot;
    assert.ok(/parser\.md/.test(text), 'the FILES tree is not in the accessibility tree:\n' + text);
  });

  await check('every control in a populated file tree has an accessible name', async () => {
    const nameless = await page.evaluate(() => window.CreelLocator
      .snapshot({ root: document.getElementById('fileTree'), limit: 200, all: true })
      .filter((n) => !n.name && n.role !== 'generic')
      .map((n) => `${n.role}${n.id ? `#${n.id}` : ''}`));
    assert.deepStrictEqual([...nameless], [],
      'unnamed controls in the file tree: ' + nameless.join(', '));
  });

  await check('clicking a file opens it in the viewer', async () => {
    await ui('ui_click', { role: 'button', name: 'parser.md' });
    await page.waitForFunction(() => currentViewFile === '/notes/parser.md',
      { message: 'the file viewer to open /notes/parser.md' });
  });

  await check('a directory row toggles rather than opening a viewer', async () => {
    const open = () => page.evaluate(() => !collapsedDirs.has('/notes'));
    assert.strictEqual(await open(), true, 'setup: /notes should start expanded');
    await ui('ui_click', { role: 'button', name: 'Folder notes' });
    assert.strictEqual(await open(), false, 'clicking a folder did not collapse it');
    await ui('ui_click', { role: 'button', name: 'Folder notes' });
    assert.strictEqual(await open(), true, 'clicking it again did not expand it');
  });

  // ── modals ───────────────────────────────────────────────────────
  // A modal an agent can open but not close leaves the tab wedged: every
  // subsequent click lands on the overlay.

  await check('a modal announces itself as a dialog with a name', async () => {
    await ui('ui_open', { panel: 'settings' });
    const text = (await ui('ui_snapshot', { all: true, filter: 'Settings' })).snapshot;
    assert.ok(/dialog "Settings/i.test(text),
      'the settings modal is not an announced dialog:\n' + text.split('\n').slice(0, 12).join('\n'));
  });

  await check('Escape closes it — an agent must never be able to wedge its own tab', async () => {
    await ui('ui_press', { key: 'Escape' });
    await page.waitForFunction(() => !document.getElementById('settingsModal').classList.contains('show'),
      { message: 'the settings modal to close on Escape' });
  });

  await check('...and the close button does too, by name', async () => {
    await ui('ui_open', { panel: 'settings' });
    await ui('ui_click', { role: 'button', name: 'Close Settings' });
    await page.waitForFunction(() => !document.getElementById('settingsModal').classList.contains('show'),
      { message: 'the settings modal to close on its close button' });
  });

  await check('the page is operable again once the modal is gone', async () => {
    await ui('ui_fill', { role: 'textbox', name: 'Message to the agent', value: 'still working' });
    const v = await page.evaluate(() => document.getElementById('userInput').value);
    assert.strictEqual(v, 'still working', 'the chat box did not take input after a modal closed');
  });

  await check('every modal has a close control that says what it closes', async () => {
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay')]
      .map((m) => {
        const btn = m.querySelector('.modal-close');
        if (!btn) return `${m.id}: no .modal-close at all`;
        const name = window.CreelLocator.accessibleName(btn);
        return /close/i.test(name) && name.length > 6 ? null : `${m.id}: close control named ${JSON.stringify(name)}`;
      })
      .filter(Boolean));
    assert.deepStrictEqual([...unnamed], [], 'modals an agent cannot reliably close:\n  ' + unnamed.join('\n  '));
  });

  // ── the chat box's keyboard contract ─────────────────────────────

  await check('Enter sends, and the box empties', async () => {
    await ui('ui_fill', { role: 'textbox', name: 'Message to the agent', value: 'first line' });
    await ui('ui_press', { role: 'textbox', name: 'Message to the agent', key: 'Enter' });
    await page.waitForFunction(() => document.getElementById('userInput').value === '',
      { message: 'Enter to send and clear the chat box' });
  });

  await check('Shift+Enter does not send — a multi-line prompt survives', async () => {
    await ui('ui_fill', { role: 'textbox', name: 'Message to the agent', value: 'line one' });
    await ui('ui_press', { role: 'textbox', name: 'Message to the agent', key: 'Shift+Enter' });
    const v = await page.evaluate(() => document.getElementById('userInput').value);
    assert.ok(v.startsWith('line one'), `Shift+Enter sent the message anyway (box now ${JSON.stringify(v)})`);
    await ui('ui_fill', { role: 'textbox', name: 'Message to the agent', value: '' });
  });

  // ── theme ────────────────────────────────────────────────────────

  await check('the theme toggle really repaints, and Dracula is what dark means', async () => {
    // It lives in the overflow menu now (creel-ovp), which is the honest path:
    // an agent opens "More actions" and finds it there, same as the operator.
    await ui('ui_click', { role: 'button', name: 'More actions' });
    const themeOf = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const bgOf = () => page.evaluate(() => getComputedStyle(document.documentElement)
      .getPropertyValue('--bg-panel').trim().toLowerCase());

    assert.strictEqual(await themeOf(), 'dark', 'the page should start dark');
    const dark = await bgOf();
    assert.ok(/^#(282a36|21222c|343746|44475a)$/.test(dark),
      `dark --bg-panel is ${dark}, which is not a Dracula value (creel-hkl)`);

    await ui('ui_click', { role: 'button', name: 'Switch to light theme' });
    assert.strictEqual(await themeOf(), 'light', 'the toggle did not switch to light');
    assert.notStrictEqual(await bgOf(), dark, 'the theme attribute changed but nothing repainted');

    await ui('ui_click', { role: 'button', name: 'Switch to dark theme' });
    assert.strictEqual(await themeOf(), 'dark', 'the toggle is one-way');
    assert.strictEqual(await bgOf(), dark, 'coming back to dark did not restore the palette');
    await ui('ui_press', { key: 'Escape' });
  });

  // ── panels ───────────────────────────────────────────────────────

  await check('collapsing a panel takes its controls out of the tree, not just out of view', async () => {
    const seesFiles = async () => /button "Folder notes"/.test((await ui('ui_snapshot', { limit: 400 })).snapshot);
    assert.strictEqual(await seesFiles(), true, 'setup: the file tree should be visible');
    await ui('ui_click', { role: 'button', name: 'Toggle left panel' });
    await ui('ui_wait_for', { role: 'button', name: 'Folder notes', state: 'hidden' });
    assert.strictEqual(await seesFiles(), false,
      'a collapsed panel still offers its controls — an agent would click something it cannot see');
    await ui('ui_click', { role: 'button', name: 'Toggle left panel' });
    await ui('ui_wait_for', { role: 'button', name: 'Folder notes' });
  });

  await browser.close();
  console.log('creel UI surfaces (real browser)');
  console.log(results.join('\n'));
  console.log(failures ? `\n${failures} failed` : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
