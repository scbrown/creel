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

const VERSION = '0.2.0';

// Origins that may COMMAND the bridge (must match the manifest's content-script
// matches). Distinct from what the bridge may ACT ON — it opens/drives any site.
const CREEL_ORIGINS = [/^https:\/\/scbrown\.github\.io\/creel\//, /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/];
const isCreelUrl = (url) => CREEL_ORIGINS.some((re) => re.test(url || ''));

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

  /** The page as a list of things you can DO, each with a selector that
   *  works. This is the call that replaces guessing at CSS. */
  async snapshot(args) {
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

  async click(args) {
    const tab = await targetTab(args);
    return inPage(tab.id, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `no element matches ${sel}` };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, clicked: sel };
    }, [args.selector]);
  },

  async fill(args) {
    const tab = await targetTab(args);
    return inPage(tab.id, (sel, value, submit) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `no element matches ${sel}` };
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        // React and friends patch the value setter on the element; going
        // through the prototype's setter is what makes the framework
        // actually see the change instead of reverting it.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value); else el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (submit && el.form && el.form.requestSubmit) el.form.requestSubmit();
      return { ok: true, filled: sel, submitted: !!submit };
    }, [args.selector, args.value, args.submit === true]);
  },

  async select_option(args) {
    const tab = await targetTab(args);
    return inPage(tab.id, (sel, value, label) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `no element matches ${sel}` };
      if (el.tagName.toLowerCase() !== 'select') return { error: `${sel} is not a <select>` };
      const opts = Array.from(el.options);
      const hit = value != null
        ? opts.find((o) => o.value === value)
        : opts.find((o) => (o.text || '').trim() === label);
      if (!hit) return { error: `no option matching ${JSON.stringify(value ?? label)}`, options: opts.map((o) => o.value) };
      el.value = hit.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: hit.value, text: hit.text };
    }, [args.selector, args.value ?? null, args.label ?? null]);
  },

  async press(args) {
    const tab = await targetTab(args);
    return inPage(tab.id, (sel, key) => {
      const el = sel ? document.querySelector(sel) : (document.activeElement || document.body);
      if (!el) return { error: `no element matches ${sel}` };
      if (el.focus) el.focus();
      const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true };
      const down = new KeyboardEvent('keydown', init);
      const prevented = !el.dispatchEvent(down);
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      // A bare Enter in a real browser submits the owning form. Only do it
      // when the page did not already handle (and cancel) the keydown.
      if (key === 'Enter' && !prevented && el.form && el.form.requestSubmit) el.form.requestSubmit();
      return { ok: true, key, target: sel || 'activeElement', defaultPrevented: prevented };
    }, [args.selector || null, args.key || 'Enter']);
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

  /** Wait for the page to reach a state, instead of guessing at sleeps:
   *  a selector appearing (or vanishing), or text showing up in the body. */
  async wait_for(args) {
    const tab = await targetTab(args, 'read');
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10000, 500), 30000);
    return inPage(tab.id, (sel, text, gone, timeout) => new Promise((resolve) => {
      const started = Date.now();
      const met = () => {
        if (sel) {
          const found = !!document.querySelector(sel);
          return gone ? !found : found;
        }
        if (text) return (document.body.innerText || '').includes(text);
        return true;
      };
      const tick = () => {
        if (met()) return resolve({ ok: true, waitedMs: Date.now() - started, url: location.href, title: document.title });
        if (Date.now() - started >= timeout) {
          return resolve({ ok: false, error: `timed out after ${timeout}ms waiting for ${sel ? (gone ? `${sel} to vanish` : sel) : JSON.stringify(text)}`, url: location.href });
        }
        setTimeout(tick, 200);
      };
      tick();
    }), [args.selector || null, args.text || null, args.gone === true, timeoutMs]);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept from our own content script on a creel origin.
  if (!sender.tab || !isCreelUrl(sender.tab.url)) {
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
