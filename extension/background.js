/* creel bridge — background service worker (MV3).
 *
 * The privileged half: it holds tabs/scripting permissions and reaches
 * cross-origin pages the creel page's fetch (CORS-bound) never could. Every
 * DOM action runs via chrome.scripting.executeScript in the target tab's
 * MAIN world, so it operates the real page. The connector content script is
 * the only caller; ops are a fixed allow-list.
 *
 * creel manages its own tabs; this bridge deliberately refuses to touch a
 * tab whose URL is a creel origin, so an agent cannot puppet its own harness
 * through the side door. Driving creel's OWN surfaces is the `ui` server's
 * job (app/creel-self.js), which does it in-origin and cross-tab.
 */

const VERSION = '0.4.0';

/* ── which origins may COMMAND the bridge ─────────────────────────
 * This is the security boundary, and it is checked BY ORIGIN INCLUDING
 * PORT. Chrome match patterns cannot express a port, so the manifest's
 * content-script `matches` necessarily injects the connector into every
 * localhost page — which means this list, not the manifest, is what
 * actually decides who can drive the bridge. A dev server on some other
 * localhost port is a stranger, exactly like any website.
 *
 * The same list decides what the bridge refuses to ACT ON, so an agent
 * cannot puppet its own harness. Note the consequence of getting this
 * wrong in the other direction: too broad, and your own dev server on
 * :3000 becomes both undriveable and able to command the bridge.
 *
 * Configure for a different creel deployment with:
 *   chrome.storage.local.set({ creelOrigins: ['http://localhost:1234'] })
 */
const DEFAULT_CREEL_ORIGINS = [
  'https://scbrown.github.io',        // production Pages deployment
  'http://localhost:8420',            // `just serve`
  'http://127.0.0.1:8420',
];
// The Pages deployment serves creel under a path, so that one origin is
// additionally path-scoped; everything else is a whole origin.
const PAGES_PREFIX = 'https://scbrown.github.io/creel';

let creelOrigins = new Set(DEFAULT_CREEL_ORIGINS);

function applyOrigins(list) {
  if (Array.isArray(list) && list.length) {
    creelOrigins = new Set(list.map((o) => { try { return new URL(o).origin; } catch { return o; } }));
  } else {
    creelOrigins = new Set(DEFAULT_CREEL_ORIGINS);
  }
}
chrome.storage?.local?.get('creelOrigins').then((r) => applyOrigins(r.creelOrigins)).catch(() => {});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.creelOrigins) applyOrigins(changes.creelOrigins.newValue);
});

function isCreelUrl(url) {
  if (!url) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.origin === 'https://scbrown.github.io') return url.startsWith(PAGES_PREFIX);
  return creelOrigins.has(parsed.origin);
}

// The last tab this bridge opened or navigated. Multi-step flows (open →
// query → fill → click) are the norm, and defaulting to the *active* tab
// makes them fail confusingly: the active tab is usually creel itself, which
// every op then refuses. Remembering the working tab is what lets an agent
// omit tabId after the first call.
let lastTabId = null;

function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('missing url');
  // A bare host like "example.com" → https://; reject non-web schemes.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
  const parsed = new URL(withScheme);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`only http/https URLs allowed, got ${parsed.protocol}`);
  return parsed.href;
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') { clearTimeout(timer); done(); }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function resolveTab(args) {
  if (args.tabId) return chrome.tabs.get(args.tabId);
  if (lastTabId != null) {
    const remembered = await chrome.tabs.get(lastTabId).catch(() => null);
    if (remembered && !isCreelUrl(remembered.url)) return remembered;
    lastTabId = null;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('no target tab — pass tabId, or open one with open_tab');
  return active;
}

/** Resolve a tab and refuse creel's own origins in one step: every DOM op
 *  needs exactly this, and forgetting the guard is how the side door opens. */
async function targetTab(args, verb = 'act on') {
  const tab = await resolveTab(args);
  if (isCreelUrl(tab.url)) throw new Error(`refusing to ${verb} a creel origin through the bridge — use the in-page 'ui' tools for creel's own surfaces`);
  lastTabId = tab.id;
  return tab;
}

async function inPage(tabId, func, funcArgs) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args: funcArgs,
  });
  return res.result;
}

/* ── the locator engine, on the far side ──────────────────────────
 * creel-locator.js is the SAME file the app serves (kept identical by
 * `just check`), injected into the target page so that driving a foreign
 * website and driving a creel tab are one mental model: roles, accessible
 * names, refs, auto-waiting. Injection is by file rather than by evaluating
 * source, because the MAIN world inherits the page's CSP and most serious
 * sites ban eval.
 *
 * Refs live in the injected engine's own state, so they persist across calls
 * for as long as the page does — and die with a navigation, which is
 * correct: a ref into a page that has been replaced is meaningless.
 */
async function ensureLocator(tabId) {
  const present = await inPage(tabId, () => !!window.CreelLocator, []);
  if (present) return;
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['creel-locator.js'] });
  const ok = await inPage(tabId, () => !!window.CreelLocator, []);
  if (!ok) throw new Error('could not install the locator engine in that page (its CSP may forbid injected scripts) — the read/query/click ops still work with plain CSS selectors');
}

/** One self-contained dispatcher, injected as a function and selected by
 *  name. Deliberately NOT a serialized closure evaluated in the page: eval
 *  from page context is what a strict CSP blocks, and this has to work on
 *  sites that set one. */
async function locatorOp(tab, op, args) {
  await ensureLocator(tab.id);
  const result = await inPage(tab.id, async (which, a) => {
    const L = window.CreelLocator;
    if (!L) return { ok: false, error: 'the locator engine is not present in this page' };
    const loc = a.locator || {};
    const targeted = Object.keys(loc).length > 0;
    const opts = { timeout: a.timeout };
    const head = { url: location.href, title: document.title };
    try {
      switch (which) {
        case 'snapshot': {
          const body = a.format === 'json'
            ? { nodes: L.snapshot(a) }
            : { snapshot: L.snapshotText(a) || '(nothing interactive is visible — try all:true)' };
          return { ok: true, value: { ...head, ...body } };
        }
        case 'click': return { ok: true, value: await L.actions.click(loc, opts) };
        case 'fill': return { ok: true, value: await L.actions.fill(loc, String(a.value ?? ''), opts) };
        case 'type': return { ok: true, value: await L.actions.type(loc, String(a.text ?? ''), opts) };
        case 'hover': return { ok: true, value: await L.actions.hover(loc, opts) };
        case 'check': return { ok: true, value: await L.actions.check(loc, a.checked !== false, opts) };
        case 'select_option': return { ok: true, value: await L.actions.selectOption(loc, { value: a.value, label: a.label }, opts) };
        case 'attach_file': {
          const files = Array.isArray(a.files) ? a.files : (a.files ? [a.files] : []);
          return { ok: true, value: await L.actions.setFile(loc, files, opts) };
        }
        case 'press': return { ok: true, value: await L.actions.press(targeted ? loc : null, a.key || 'Enter', opts) };
        case 'text': return { ok: true, value: { ...head, ...L.text(loc) } };
        case 'wait_for': {
          const el = await L.waitFor(loc, { state: a.state || 'visible', timeout: a.timeout || 5000 });
          return { ok: true, value: { ...head, ok: true, state: a.state || 'visible', found: !!el, name: el ? L.accessibleName(el) : undefined } };
        }
        default: return { ok: false, error: `unknown locator op: ${which}` };
      }
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }, [op, args]);
  if (!result || !result.ok) throw new Error((result && result.error) || 'locator op failed');
  return result.value;
}

/* ── injected code ────────────────────────────────────────────────
 * Injected functions run in the page's MAIN world, so they must be fully
 * self-contained — no closure over anything in this file. They also cannot
 * use `new Function`/eval to share helper source: the MAIN world inherits
 * the page's CSP, and most serious sites ban eval. So the one helper that
 * two ops need — the selector builder — is written inline in each.
 *
 * cssPath(el) prefers stable handles (#id, [name]) and VERIFIES uniqueness
 * before returning one: a selector the agent cannot re-use to act is worse
 * than no selector at all. It falls back to an nth-of-type path.
 */

const ops = {
  /** Advertise the op surface so the page can degrade gracefully when the
   *  installed extension is older than the creel build (or newer). */
  async __ops() {
    return { version: VERSION, ops: Object.keys(ops).filter((k) => !k.startsWith('__')) };
  },

  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => !isCreelUrl(t.url))
      .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
  },

  async open_tab(args) {
    const url = normalizeUrl(args.url);
    if (isCreelUrl(url)) throw new Error('refusing to open a creel origin through the bridge');
    const tab = await chrome.tabs.create({ url, active: args.focus !== false });
    lastTabId = tab.id;
    if (args.wait !== false) await waitForTabLoad(tab.id);
    const loaded = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tabId: tab.id, url: loaded.url || url, title: loaded.title };
  },

  async navigate(args) {
    const tab = await targetTab(args, 'navigate');
    const url = normalizeUrl(args.url);
    if (isCreelUrl(url)) throw new Error('refusing to navigate to a creel origin through the bridge');
    await chrome.tabs.update(tab.id, { url });
    if (args.wait !== false) await waitForTabLoad(tab.id);
    const loaded = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tabId: tab.id, url: loaded.url || url, title: loaded.title };
  },

  async close_tab(args) {
    const tab = await targetTab(args, 'close');
    await chrome.tabs.remove(tab.id);
    if (lastTabId === tab.id) lastTabId = null;
    return { ok: true, closed: tab.id, url: tab.url };
  },

  async history(args) {
    const tab = await targetTab(args, 'navigate');
    const action = args.action || 'back';
    if (!['back', 'forward', 'reload'].includes(action)) throw new Error(`unknown history action: ${action}`);
    // goBack/goForward exist on chrome.tabs in MV3 Chrome 72+; fall back to
    // history.go() in-page when the API is unavailable.
    if (action === 'reload') {
      await chrome.tabs.reload(tab.id);
    } else if (action === 'back') {
      if (chrome.tabs.goBack) await chrome.tabs.goBack(tab.id);
      else await inPage(tab.id, () => history.back(), []);
    } else if (action === 'forward') {
      if (chrome.tabs.goForward) await chrome.tabs.goForward(tab.id);
      else await inPage(tab.id, () => history.forward(), []);
    }
    if (args.wait !== false) await waitForTabLoad(tab.id, 10000);
    const loaded = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tabId: tab.id, action, url: loaded.url, title: loaded.title };
  },

  async read(args) {
    const tab = await targetTab(args, 'read');
    return inPage(tab.id, (sel, limit) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return { error: `no element matches ${sel}` };
      const full = root.innerText || '';
      const cap = limit || 20000;
      return {
        url: location.href,
        title: document.title,
        selector: sel || 'body',
        text: full.slice(0, cap),
        truncated: full.length > cap ? full.length : undefined,
      };
    }, [args.selector || null, args.limit || null]);
  },

  async query(args) {
    const tab = await targetTab(args, 'read');
    return inPage(tab.id, (sel, limit) => {
      const uniq = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
      const cssPath = (el) => {
        if (el.id && uniq(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
        const nm = el.getAttribute && el.getAttribute('name');
        if (nm && uniq(`${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`)) return `${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`;
        const parts = [];
        for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
          if (n.id && uniq(`#${CSS.escape(n.id)}`)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
          let part = n.tagName.toLowerCase();
          const sibs = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
          if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(n) + 1})`;
          parts.unshift(part);
        }
        return parts.join(' > ');
      };
      const els = Array.from(document.querySelectorAll(sel)).slice(0, limit || 25);
      return els.map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || '').slice(0, 120),
        href: el.href || undefined,
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
        selector: cssPath(el),
      }));
    }, [args.selector, args.limit || null]);
  },

  // ── locator ops: the same surface creel's own `ui` tools expose ──
  // Everything below routes through the shared locator engine, so an agent
  // uses one mental model — roles, accessible names, refs, auto-waiting —
  // whether the tab is creel's or a stranger's.
  async snapshot(args) { return locatorOp(await targetTab(args, 'read'), 'snapshot', args); },
  async click(args) { return locatorOp(await targetTab(args), 'click', args); },
  async fill(args) { return locatorOp(await targetTab(args), 'fill', args); },
  async type(args) { return locatorOp(await targetTab(args), 'type', args); },
  async hover(args) { return locatorOp(await targetTab(args), 'hover', args); },
  async check(args) { return locatorOp(await targetTab(args), 'check', args); },
  async select_option(args) { return locatorOp(await targetTab(args), 'select_option', args); },
  async press(args) { return locatorOp(await targetTab(args), 'press', args); },
  async text(args) { return locatorOp(await targetTab(args, 'read'), 'text', args); },
  async wait_for(args) { return locatorOp(await targetTab(args, 'read'), 'wait_for', args); },
  /** Attach files to an <input type="file"> in the target page. The engine
   *  builds a real DataTransfer with real File objects in the page itself, so
   *  the page's change handler sees exactly what a user's picker would have
   *  produced. `files` is [{name, content|base64, mimeType?, lastModified?}]. */
  async attach_file(args) { return locatorOp(await targetTab(args), 'attach_file', args); },

  /** The popup's view of the boundary: the effective creel-origin list
   *  (defaults unless the user overrode them in chrome.storage.local), what
   *  the defaults are, and the path prefix the Pages deployment lives under.
   *  Origin *management* only — never a way to act on tabs. */
  async list_origins() {
    return {
      version: VERSION,
      origins: [...creelOrigins].sort(),
      defaults: DEFAULT_CREEL_ORIGINS,
      pagesPrefix: PAGES_PREFIX,
      storageKey: 'creelOrigins',
    };
  },

  /** The popup's edit path: normalize each entry to an exact origin (the URL
   *  constructor drops any path/query, keeping scheme+host+port — the same
   *  normalization the boundary itself uses), persist, and apply immediately.
   *  An empty list clears the override and returns to the defaults. */
  async set_origins(args) {
    if (!Array.isArray(args.origins)) throw new Error('set_origins needs origins: [origin strings]');
    const normalized = args.origins.map((o) => {
      const s = String(o).trim();
      if (!s) throw new Error('empty origin entry');
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
      if (!/^https?:$/.test(u.protocol)) throw new Error(`only http/https origins allowed, got ${u.protocol}//`);
      return u.origin;
    });
    if (new Set(normalized).size !== normalized.length) throw new Error('duplicate origins in list');
    if (!normalized.length) {
      await chrome.storage.local.remove('creelOrigins');
      applyOrigins([]);
    } else {
      await chrome.storage.local.set({ creelOrigins: normalized });
      applyOrigins(normalized);
    }
    return { ok: true, origins: [...creelOrigins].sort() };
  },

  /** Retained: a plain CSS listing, for pages where the locator engine
   *  cannot be installed at all. */
  async legacy_snapshot(args) {
    const tab = await targetTab(args, 'read');
    return inPage(tab.id, (limit) => {
      const uniq = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
      const cssPath = (el) => {
        if (el.id && uniq(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
        const nm = el.getAttribute && el.getAttribute('name');
        if (nm && uniq(`${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`)) return `${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`;
        const parts = [];
        for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
          if (n.id && uniq(`#${CSS.escape(n.id)}`)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
          let part = n.tagName.toLowerCase();
          const sibs = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
          if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(n) + 1})`;
          parts.unshift(part);
        }
        return parts.join(' > ');
      };
      const SEL ='a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [contenteditable="true"], [onclick]';
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const labelOf = (el) => (
        el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
        || (el.labels && el.labels[0] && el.labels[0].innerText)
        || el.getAttribute('title')
        || el.getAttribute('alt')
        || (el.innerText || '').trim()
        || el.getAttribute('name')
        || ''
      ).replace(/\s+/g, ' ').slice(0, 80);
      const out = [];
      for (const el of document.querySelectorAll(SEL)) {
        if (out.length >= (limit || 60)) break;
        if (el.type === 'hidden' || !visible(el)) continue;
        const tag = el.tagName.toLowerCase();
        out.push({
          kind: tag === 'a' ? 'link'
            : tag === 'select' ? 'select'
              : (tag === 'input' || tag === 'textarea') ? `input:${el.type || 'text'}`
                : 'button',
          label: labelOf(el),
          selector: cssPath(el),
          value: (tag === 'input' || tag === 'textarea') && el.type !== 'password' ? String(el.value || '').slice(0, 80) : undefined,
          href: el.href || undefined,
          disabled: el.disabled || undefined,
          options: tag === 'select' ? Array.from(el.options).slice(0, 20).map((o) => o.value) : undefined,
        });
      }
      return { url: location.href, title: document.title, count: out.length, elements: out };
    }, [args.limit || null]);
  },

  async scroll(args) {
    const tab = await targetTab(args);
    return inPage(tab.id, (sel, to) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return { error: `no element matches ${sel}` };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        return { ok: true, scrolledTo: sel, y: window.scrollY };
      }
      if (to === 'top') window.scrollTo(0, 0);
      else if (to === 'bottom' || to == null) window.scrollTo(0, document.body.scrollHeight);
      else window.scrollBy(0, Number(to) || 0);
      return { ok: true, y: window.scrollY, height: document.body.scrollHeight };
    }, [args.selector || null, args.to ?? null]);
  },
};

// Ops our own extension pages (the popup) may call directly. These manage
// the origins list — the boundary itself — and never act on a tab. Everything
// else keeps the single narrow gate: the connector, on a creel origin.
const EXTENSION_PAGE_OPS = new Set(['__ops', 'list_origins', 'set_origins']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Two trust paths, both deliberately narrow:
  // 1. Our content script on a creel origin — the normal path. The page can
  //    only reach the bridge through the connector, and the connector only
  //    runs on creel origins (manifest matches), so this is the one gate.
  // 2. Our own extension pages (popup) — but ONLY for the origins ops above.
  //    A popup message has no sender.tab, so without this carve-out the popup
  //    could never read or edit the list it exists to manage. It still cannot
  //    command tabs: every tab-commanding op keeps gate 1.
  const fromConnector = !!sender.tab && isCreelUrl(sender.tab.url);
  const fromExtensionPage = !sender.tab && sender.id === chrome.runtime.id && EXTENSION_PAGE_OPS.has(msg.op);
  if (!fromConnector && !fromExtensionPage) {
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }
  const fn = ops[msg.op];
  if (!fn) { sendResponse({ ok: false, error: `unknown op: ${msg.op}` }); return false; }
  fn(msg.args || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true;   // async response
});
