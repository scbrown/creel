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
 * through the side door.
 */

// Origins that may COMMAND the bridge (must match the manifest's content-script
// matches). Distinct from what the bridge may ACT ON — it opens/drives any site.
const CREEL_ORIGINS = [/^https:\/\/scbrown\.github\.io\/creel\//, /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/];
const isCreelUrl = (url) => CREEL_ORIGINS.some((re) => re.test(url || ''));

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
  if (args.tabId) {
    const tab = await chrome.tabs.get(args.tabId);
    return tab;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return active;
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

const ops = {
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
    if (args.wait !== false) await waitForTabLoad(tab.id);
    const loaded = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tabId: tab.id, url: loaded.url || url, title: loaded.title };
  },

  async navigate(args) {
    const tab = await resolveTab(args);
    const url = normalizeUrl(args.url);
    if (isCreelUrl(url)) throw new Error('refusing to navigate to a creel origin through the bridge');
    await chrome.tabs.update(tab.id, { url });
    if (args.wait !== false) await waitForTabLoad(tab.id);
    const loaded = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tabId: tab.id, url: loaded.url || url, title: loaded.title };
  },

  async read(args) {
    const tab = await resolveTab(args);
    if (isCreelUrl(tab.url)) throw new Error('refusing to read a creel origin through the bridge');
    return inPage(tab.id, (sel) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return { error: `no element matches ${sel}` };
      const text = (root.innerText || '').slice(0, 20000);
      return { url: location.href, title: document.title, selector: sel || 'body', text };
    }, [args.selector || null]);
  },

  async click(args) {
    const tab = await resolveTab(args);
    if (isCreelUrl(tab.url)) throw new Error('refusing to act on a creel origin through the bridge');
    return inPage(tab.id, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `no element matches ${sel}` };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, clicked: sel };
    }, [args.selector]);
  },

  async fill(args) {
    const tab = await resolveTab(args);
    if (isCreelUrl(tab.url)) throw new Error('refusing to act on a creel origin through the bridge');
    return inPage(tab.id, (sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `no element matches ${sel}` };
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, filled: sel };
    }, [args.selector, args.value]);
  },

  async query(args) {
    const tab = await resolveTab(args);
    if (isCreelUrl(tab.url)) throw new Error('refusing to read a creel origin through the bridge');
    return inPage(tab.id, (sel, limit) => {
      const els = Array.from(document.querySelectorAll(sel)).slice(0, limit || 25);
      return els.map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || '').slice(0, 120),
        href: el.href || undefined,
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
      }));
    }, [args.selector, args.limit]);
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
