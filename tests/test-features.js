/* Feature flags in the real page (creel-yon).
 *
 * The claim under test is not "the Python code is gone" — it is deliberately
 * still there. The claim is that with the flag off the runtime is unreachable
 * by every path that matters: the model cannot see the tools, a model that
 * invents the call gets a refusal instead of a 10MB download, and nothing
 * injects the Pyodide loader. Then the same page with the flag on gets it all
 * back, which is what makes this a flag rather than a demolition.
 *
 * Run: node tests/test-features.js   (or `just test`)
 * Skips cleanly (exit 0) when no Chromium is present.
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { Browser } = require('./browser.js');

const APP = path.join(__dirname, '..', 'app');
const PYTHON_TOOLS = ['PythonExec', 'VfsToPyodide', 'PyodideToVfs'];

const results = [];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 4).join('\n       ')}`); failures++; }
};

/** Every <script> src the document has acquired — the Pyodide loader is
 *  injected as a script tag, so this is where a download would announce
 *  itself before it started. */
const scriptSrcs = (page) => page.evaluate(
  () => Array.from(document.querySelectorAll('script[src]')).map(s => s.src));

(async () => {
  if (!Browser.available()) {
    console.log('creel features\n  skipped — no Chromium found (set CHROME_PATH to run these)');
    process.exit(0);
  }

  const browser = await Browser.launch({ root: APP });

  // ── the default surface: Python off ──────────────────────────────
  const off = await browser.newPage('/onepagent.html');
  await off.waitForFunction(() => !!window.CreelUi, { message: 'creel boot' });

  await check('python is off by default', async () => {
    assert.strictEqual(await off.evaluate(() => window.CREEL_FEATURES.python), false);
  });

  await check('no Python tool is offered to the model', async () => {
    const names = await off.evaluate(() => allToolsAnthropic.map(t => t.name));
    for (const t of PYTHON_TOOLS) assert.ok(!names.includes(t), `${t} is still in the tool list`);
    // The list is not simply empty — the harness's other tools are still there.
    assert.ok(names.includes('Read') && names.includes('Write'), 'the rest of the tool surface survived');
  });

  await check('the OpenAI-shaped tool list agrees with the Anthropic one', async () => {
    const names = await off.evaluate(() => allToolsOpenAI.map(t => t.function.name));
    for (const t of PYTHON_TOOLS) assert.ok(!names.includes(t), `${t} leaked into the OpenAI tool list`);
  });

  await check('an invented PythonExec call is refused, and names the alternatives', async () => {
    const out = await off.evaluate(() => executeTool('PythonExec', { code: 'print(1)' }));
    assert.match(out, /unavailable/i, 'refusal says the tool is unavailable');
    assert.match(out, /python/i, 'refusal names the flag');
    assert.match(out, /JSExec/, 'refusal points somewhere useful');
  });

  await check('the refused call downloads nothing', async () => {
    const srcs = await scriptSrcs(off);
    assert.ok(!srcs.some(s => /pyodide/i.test(s)),
      'a Pyodide loader was injected despite the flag: ' + srcs.filter(s => /pyodide/i.test(s)));
  });

  await check('ensurePyodide refuses rather than reaching for a CDN', async () => {
    const err = await off.evaluate(() => ensurePyodide().then(() => null, e => e.message));
    assert.ok(err, 'ensurePyodide resolved instead of throwing');
    assert.match(err, /unavailable|disabled/i);
    assert.ok(!(await scriptSrcs(off)).some(s => /pyodide/i.test(s)), 'loader injected anyway');
  });

  await check('the system prompt does not teach a runtime that is not there', async () => {
    const prompt = await off.evaluate(() => DEFAULT_SYSTEM);
    assert.ok(!/PythonExec runs Python/.test(prompt), 'the Python semantics paragraph is still in the prompt');
    assert.match(prompt, /no Python runtime/i, 'the prompt should say so plainly instead of staying silent');
  });

  await check('the system prompt describes the surface creel actually has', async () => {
    const prompt = await off.evaluate(() => DEFAULT_SYSTEM);
    // Every family the harness registers should be named, or an agent has to
    // discover its own harness by trial and error.
    for (const fam of ['ui_*', 'fleet_*', 'browser_*', 'github_*', 'state_*', 'quipu_*', 'bd_*']) {
      assert.ok(prompt.includes(fam), `${fam} is not named in the system prompt`);
    }
    assert.match(prompt, /state_push/, 'the prompt never tells the agent how state is saved');
    assert.match(prompt, /evictable/i, 'the prompt never says browser storage is not durable');
    // It is a prompt, not a manual: the cost of every extra word is paid on
    // every single turn.
    const words = prompt.split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 560, `system prompt has grown to ${words} words`);
  });

  // ── the calm default surface (creel-ban) ─────────────────────────

  await check('a first-run panel shows four sections, not eleven', async () => {
    const visible = await off.evaluate(() => [...document.querySelectorAll('.panel-section')]
      .filter((el) => !el.hidden).map((el) => el.dataset.section));
    assert.ok(visible.length <= 4, `first run shows ${visible.length} sections: ${visible.join(', ')}`);
    // Not an empty panel — the sections an operator uses every session are there.
    assert.ok(visible.includes('conversations') && visible.includes('files'),
      'the default surface should still hold the panel worth opening creel for: ' + visible.join(', '));
  });

  await check('every hidden section is listed, so nothing is lost', async () => {
    const chips = await off.evaluate(() => {
      togglePanelMore();
      return [...document.querySelectorAll('.panel-more-chip')].map((c) => c.textContent.replace(/^\u2713\s*/, ''));
    });
    const hidden = await off.evaluate(() => [...document.querySelectorAll('.panel-section[data-tier="more"]')]
      .map((el) => el.dataset.section));
    assert.strictEqual(chips.length, hidden.length,
      `${hidden.length} optional sections but ${chips.length} chips — one is unreachable`);
    for (const c of chips) assert.ok(c.trim(), 'a chip with no label cannot be clicked by name');
  });

  await check('a revealed section stays revealed across a reload', async () => {
    await off.evaluate(() => {
      const chip = [...document.querySelectorAll('.panel-more-chip')]
        .find((c) => /SKILLS/i.test(c.textContent));
      chip.click();
    });
    const shownNow = await off.evaluate(() =>
      !document.querySelector('.panel-section[data-section="skills"]').hidden);
    assert.strictEqual(shownNow, true, 'clicking the chip did not reveal the section');

    const persisted = await off.evaluate(() => JSON.parse(localStorage.getItem('creel_panel_shown') || '[]'));
    assert.ok(persisted.includes('skills'), 'the reveal was not remembered: ' + JSON.stringify(persisted));
  });

  await check('settings groups start closed and remember being opened', async () => {
    const closed = await off.evaluate(() =>
      [...document.querySelectorAll('details.settings-group')].filter((d) => d.open).length);
    assert.strictEqual(closed, 0, 'a settings group is open on first run');
    const total = await off.evaluate(() => document.querySelectorAll('details.settings-group').length);
    assert.ok(total >= 5, `only ${total} settings groups are collapsible`);

    await off.evaluate(() => {
      const d = document.querySelector('details.settings-group');
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });
    const remembered = await off.evaluate(() =>
      JSON.parse(localStorage.getItem('creel_settings_open') || '[]'));
    assert.strictEqual(remembered.length, 1, 'opening a settings group was not remembered');
  });

  await off.close();

  // ── the same page with the flag on ───────────────────────────────
  const on = await browser.newPage('/onepagent.html#creel-features=' + encodeURIComponent('{"python":true}'));
  await on.waitForFunction(() => !!window.CreelUi, { message: 'creel boot (python on)' });

  await check('the flag is a switch, not a demolition: Python comes back', async () => {
    assert.strictEqual(await on.evaluate(() => window.CREEL_FEATURES.python), true);
    const names = await on.evaluate(() => allToolsAnthropic.map(t => t.name));
    for (const t of PYTHON_TOOLS) assert.ok(names.includes(t), `${t} did not come back`);
    const prompt = await on.evaluate(() => DEFAULT_SYSTEM);
    assert.match(prompt, /PythonExec runs Python/, 'the semantics paragraph did not come back');
  });

  await check('an unknown flag name is ignored rather than invented', async () => {
    const page = await browser.newPage('/onepagent.html#creel-features=' + encodeURIComponent('{"nonsense":true}'));
    await page.waitForFunction(() => !!window.CREEL_FEATURES, { message: 'flags' });
    const keys = await page.evaluate(() => Object.keys(window.CREEL_FEATURES));
    assert.ok(!keys.includes('nonsense'), 'an unknown flag was accepted');
    await page.close();
  });

  await on.close();
  await browser.close();

  console.log('creel features');
  for (const r of results) console.log(r);
  console.log(failures ? '\nFAILED' : `\n${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
