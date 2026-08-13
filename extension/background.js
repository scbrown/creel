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

const CREEL_ORIGINS = [/^https:\/\/scbrown\.github\.io\//, /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/];
const isCreelUrl = (url) => CREEL_ORIGINS.some((re) => re.test(url || ''));

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
    if (isCreelUrl(args.url)) throw new Error('refusing to open a creel origin through the bridge');
    const tab = await chrome.tabs.create({ url: args.url, active: args.focus !== false });
    return { tabId: tab.id, url: tab.url };
  },

  async navigate(args) {
    const tab = await resolveTab(args);
    if (isCreelUrl(args.url)) throw new Error('refusing to navigate to a creel origin through the bridge');
    await chrome.tabs.update(tab.id, { url: args.url });
    return { tabId: tab.id, url: args.url };
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
