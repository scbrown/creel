/* creel — the locator engine: Playwright's model, in the page.
 *
 * An agent driving a UI fails in one of two ways: it cannot NAME the thing it
 * wants, or it acts before the thing is ready. Playwright solved both — roles
 * and accessible names instead of brittle CSS, and auto-waiting instead of
 * sleeps — and this is that model, small enough to live in a static page and
 * shared by every creel tab.
 *
 * A locator is a plain JSON object, so it survives the trip through a tool
 * call and across the BroadcastChannel to another tab:
 *
 *   {ref: 'e12'}                     a handle from the last ui_snapshot
 *   {role: 'button', name: 'Send'}   getByRole — the preferred form
 *   {label: 'API key'}               getByLabel
 *   {placeholder: 'Type message...'} getByPlaceholder
 *   {text: 'Settings'}               getByText
 *   {testId: 'send'}                 getByTestId (data-testid)
 *   {selector: '#sendBtn'}           the CSS escape hatch
 *
 * plus `exact` (default false: name matching is trimmed + case-insensitive
 * substring, as Playwright's is) and `nth` (0-based) to disambiguate.
 *
 * ── Credentials are write-only ──
 * An agent must be able to PUT a key the operator hands it into the field
 * that needs it. It must never be able to GET one back out — not through a
 * snapshot, not through a value read, not through an attribute read. So
 * credential fields are detected structurally here, once, and every read
 * path masks them while the write path stays open. That asymmetry is the
 * whole design: `fill` works, `value` returns '«credential»'.
 */
(function () {
  'use strict';

  // ── refs: stable handles across snapshots ────────────────────────
  const refToEl = new Map();
  const elToRef = new WeakMap();
  let refSeq = 0;

  function refFor(el) {
    let ref = elToRef.get(el);
    if (!ref) {
      ref = `e${++refSeq}`;
      elToRef.set(el, ref);
    }
    refToEl.set(ref, el);
    return ref;
  }

  // ── roles + accessible names (a working subset of ARIA) ──────────
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox',
    url: 'textbox', password: 'textbox',
  };
  const TAG_ROLES = {
    A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox',
    OPTION: 'option', IMG: 'img', UL: 'list', OL: 'list', LI: 'listitem',
    TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', FORM: 'form',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
    ASIDE: 'complementary', DIALOG: 'dialog', SUMMARY: 'button',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    P: 'paragraph', LABEL: 'label', PROGRESS: 'progressbar', HR: 'separator',
  };

  /** The element's ARIA role: explicit wins, then the implicit mapping. */
  function role(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      return INPUT_ROLES[t] || 'textbox';
    }
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
    if (el.tagName === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    return TAG_ROLES[el.tagName] || 'generic';
  }

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /** A pragmatic accname: the ordering that matters in practice, without the
   *  full recursive text-alternative algorithm. */
  function accessibleName(el) {
    const by = el.getAttribute && el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter(Boolean)
        .map((n) => clean(n.innerText || n.textContent))
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (clean(aria)) return clean(aria);

    if (el.labels && el.labels.length) {
      const text = clean([...el.labels].map((l) => l.innerText || l.textContent).join(' '));
      if (text) return text;
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.getAttribute('type') || '')) {
      if (clean(el.value)) return clean(el.value);
    }
    if (el.tagName === 'IMG' && clean(el.getAttribute('alt'))) return clean(el.getAttribute('alt'));

    // Content is NOT a name source for form controls: a <select>'s text is
    // its option list, so using it names every dropdown after its contents
    // ("Think: Auto Think: None Think: Low…") instead of its purpose.
    const NAMED_BY_CONTENT = !/^(SELECT|INPUT|TEXTAREA|OPTION)$/.test(el.tagName);
    if (NAMED_BY_CONTENT) {
      const own = clean(el.innerText || el.textContent);
      if (own) return own.slice(0, 120);
    }

    const title = el.getAttribute && el.getAttribute('title');
    if (clean(title)) return clean(title);
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (clean(ph)) return clean(ph);
    return '';
  }

  // ── credentials: detected once, masked on every read path ────────
  const CREDENTIAL_RE = /(^|[^a-z])(key|token|secret|password|passphrase|credential|auth)/i;
  const MASK = '«credential — write-only: an agent may set this, never read it»';

  function isCredential(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    const hay = [
      el.id, el.getAttribute && el.getAttribute('name'),
      el.getAttribute && el.getAttribute('placeholder'),
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('data-credential'),
    ].filter(Boolean).join(' ');
    return CREDENTIAL_RE.test(hay);
  }

  /** The only place a field's value leaves the page. */
  function readValue(el) {
    if (isCredential(el)) return MASK;
    if (el.isContentEditable) return clean(el.textContent).slice(0, 200);
    return String(el.value == null ? '' : el.value).slice(0, 200);
  }

  // ── visibility + actionability ───────────────────────────────────
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  const isEnabled = (el) => !(el.disabled || el.getAttribute('aria-disabled') === 'true');
  const isChecked = (el) => (el.type === 'checkbox' || el.type === 'radio')
    ? !!el.checked
    : el.getAttribute('aria-checked') === 'true';

  // ── resolution ───────────────────────────────────────────────────
  const nameMatches = (actual, want, exact) => (exact
    ? clean(actual) === clean(want)
    : clean(actual).toLowerCase().includes(clean(want).toLowerCase()));

  /** Every element a locator matches, in document order. */
  function queryAll(loc, root) {
    const doc = root || document;
    if (!loc || typeof loc !== 'object') throw new Error('a locator must be an object, e.g. {role:"button", name:"Send"} or {selector:"#id"}');

    if (loc.ref) {
      const el = refToEl.get(loc.ref);
      if (!el) throw new Error(`unknown ref ${JSON.stringify(loc.ref)} — refs come from ui_snapshot, and are invalidated by a reload. Take a fresh snapshot.`);
      if (!el.isConnected) throw new Error(`ref ${loc.ref} points at an element that has been removed from the page — take a fresh ui_snapshot`);
      return [el];
    }
    if (loc.selector) return [...doc.querySelectorAll(loc.selector)];

    const all = [...doc.querySelectorAll('*')];
    const exact = loc.exact === true;
    let hits = all;

    if (loc.testId) {
      hits = hits.filter((el) => el.getAttribute('data-testid') === loc.testId);
    }
    if (loc.role) {
      hits = hits.filter((el) => role(el) === loc.role);
    }
    if (loc.label) {
      hits = hits.filter((el) => {
        if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) return false;
        return nameMatches(accessibleName(el), loc.label, exact);
      });
    }
    if (loc.placeholder) {
      hits = hits.filter((el) => nameMatches(el.getAttribute('placeholder') || '', loc.placeholder, exact));
    }
    if (loc.name != null) {
      hits = hits.filter((el) => nameMatches(accessibleName(el), loc.name, exact));
    }
    if (loc.text) {
      // getByText matches the element that most directly contains the text,
      // not every ancestor that happens to include it.
      hits = hits.filter((el) => {
        if (!nameMatches(el.innerText || el.textContent || '', loc.text, exact)) return false;
        return ![...el.children].some((c) => nameMatches(c.innerText || c.textContent || '', loc.text, exact));
      });
    }
    if (hits === all) throw new Error('empty locator — give at least one of: ref, role, name, text, label, placeholder, testId, selector');

    if (loc.visible !== false) hits = hits.filter(isVisible);
    return hits;
  }

  /** Playwright's strictness: an ambiguous locator is an error, not a
   *  coin flip, unless the caller says which one with `nth`. */
  function resolve(loc, root) {
    const hits = queryAll(loc, root);
    if (!hits.length) throw new Error(`no element matches ${describe(loc)}`);
    if (loc.nth != null) {
      const el = hits[loc.nth < 0 ? hits.length + loc.nth : loc.nth];
      if (!el) throw new Error(`${describe(loc)} matched ${hits.length} element(s); nth ${loc.nth} is out of range`);
      return el;
    }
    if (hits.length > 1) {
      const preview = hits.slice(0, 5).map((el, i) => `  [${i}] ${role(el)} "${accessibleName(el).slice(0, 50)}"`).join('\n');
      throw new Error(`${describe(loc)} is ambiguous — it matched ${hits.length} elements. Add "nth", a more specific "name", or use a ref from ui_snapshot:\n${preview}`);
    }
    return hits[0];
  }

  const describe = (loc) => (loc.ref ? `ref ${loc.ref}` : JSON.stringify(loc));

  // ── auto-waiting ─────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Poll until the locator reaches `state`. This is what replaces sleeps:
   *  every action waits for its target to be ready before touching it. */
  async function waitFor(loc, { state = 'visible', timeout = 5000 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    for (;;) {
      let el = null;
      try {
        const hits = queryAll({ ...loc, visible: false });
        el = loc.nth != null ? hits[loc.nth < 0 ? hits.length + loc.nth : loc.nth] : hits[0];
        if (hits.length > 1 && loc.nth == null && state !== 'detached' && state !== 'hidden') el = resolve(loc);
        lastError = null;
      } catch (e) {
        lastError = e;
        // A ref that has gone stale can never recover by waiting.
        if (/unknown ref|ambiguous/.test(e.message)) throw e;
      }
      const present = !!el;
      const visible = present && isVisible(el);
      const ok = state === 'attached' ? present
        : state === 'detached' ? !present
          : state === 'visible' ? visible
            : state === 'hidden' ? (!present || !visible)
              : state === 'enabled' ? (visible && isEnabled(el))
                : visible;
      if (ok) return el || null;
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeout}ms waiting for ${describe(loc)} to be ${state}`
          + (lastError ? ` — ${lastError.message}` : present ? ' — it exists but is not visible' : ' — it is not in the page'));
      }
      await sleep(50);
    }
  }

  /** Resolve for an ACTION: wait for it to be visible and enabled first. */
  async function actionable(loc, timeout = 5000) {
    await waitFor(loc, { state: 'enabled', timeout });
    return resolve(loc);
  }

  // ── the ARIA snapshot ────────────────────────────────────────────
  const SKIP = /^(SCRIPT|STYLE|META|LINK|HEAD|TITLE|NOSCRIPT|TEMPLATE|BR|PATH|SVG|DEFS|G)$/;
  const INTERESTING = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'option', 'slider', 'spinbutton', 'heading', 'tab', 'tabpanel',
    'dialog', 'menuitem', 'switch', 'progressbar', 'img',
  ]);

  /** The page as an agent should see it: roles, accessible names, refs, and
   *  the state that decides whether an action will work. Interactive nodes
   *  by default — `all: true` widens it to landmarks and headings too. */
  function snapshot({ root, all = false, limit = 200, filter = '' } = {}) {
    const start = root || document.body;
    const want = String(filter || '').toLowerCase();
    const out = [];

    (function walk(node, depth) {
      for (const el of node.children || []) {
        if (out.length >= limit) return;
        if (SKIP.test(el.tagName)) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        const r = role(el);
        const visible = isVisible(el);
        if (visible && r && (all || INTERESTING.has(r))) {
          const name = accessibleName(el);
          if (!want || `${name} ${r} ${el.id || ''}`.toLowerCase().includes(want)) {
            const credential = isCredential(el);
            const node = { ref: refFor(el), role: r, name, depth };
            if (/^(textbox|searchbox|combobox|spinbutton|slider)$/.test(r)) {
              node.value = credential ? MASK : readValue(el);
            }
            if (credential) node.credential = 'write-only';
            if (r === 'checkbox' || r === 'radio' || r === 'switch') node.checked = isChecked(el);
            if (!isEnabled(el)) node.disabled = true;
            if (el.tagName === 'SELECT') node.options = [...el.options].slice(0, 20).map((o) => o.value);
            if (el.id) node.id = el.id;
            out.push(node);
          }
        }
        walk(el, depth + 1);
      }
    })(start, 0);

    return out;
  }

  /** The same tree as indented text — far cheaper in tokens than JSON, and
   *  the shape Playwright's own aria snapshots take. */
  function snapshotText(opts) {
    return snapshot(opts).map((n) => {
      const bits = [`${'  '.repeat(Math.min(n.depth, 6))}- ${n.role}`];
      if (n.name) bits.push(` "${n.name}"`);
      bits.push(` [${n.ref}]`);
      if (n.value !== undefined) bits.push(n.credential ? ' [credential: write-only]' : ` = ${JSON.stringify(n.value)}`);
      if (n.checked !== undefined) bits.push(n.checked ? ' [checked]' : ' [unchecked]');
      if (n.disabled) bits.push(' [disabled]');
      if (n.options) bits.push(` options=${JSON.stringify(n.options)}`);
      return bits.join('');
    }).join('\n');
  }

  // ── actions ──────────────────────────────────────────────────────
  const fire = (el, type, init) => el.dispatchEvent(new Event(type, { bubbles: true, ...init }));

  /** Frameworks patch the element's own value setter; going through the
   *  prototype's is what makes React observe the change. */
  function setValue(el, value) {
    if (el.isContentEditable) { el.textContent = value; return; }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }

  const actions = {
    async click(loc, opts = {}) {
      const el = await actionable(loc, opts.timeout);
      el.scrollIntoView({ block: 'center' });
      if (window.CreelSelf && window.CreelSelf.flash) window.CreelSelf.flash(el, true);
      el.click();
      return { ok: true, role: role(el), name: accessibleName(el) };
    },

    /** Write-through, credentials included: an operator hands the agent a
     *  key and the agent puts it where it belongs. The value never appears
     *  in the result — only the fact that something was written. */
    async fill(loc, value, opts = {}) {
      const el = await actionable(loc, opts.timeout);
      const credential = isCredential(el);
      el.focus();
      setValue(el, value);
      fire(el, 'input');
      fire(el, 'change');
      if (window.CreelSelf && window.CreelSelf.flash) window.CreelSelf.flash(el, true);
      return {
        ok: true,
        role: role(el),
        name: accessibleName(el),
        credential: credential || undefined,
        wrote: credential ? `${value.length} characters (not echoed)` : value.slice(0, 80),
      };
    },

    async type(loc, text, opts = {}) {
      const el = await actionable(loc, opts.timeout);
      el.focus();
      for (const ch of String(text)) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        setValue(el, (el.isContentEditable ? el.textContent : el.value) + ch);
        fire(el, 'input');
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
      fire(el, 'change');
      return { ok: true, typed: isCredential(el) ? `${String(text).length} characters` : text.slice(0, 80) };
    },

    async press(loc, key, opts = {}) {
      const el = loc ? await actionable(loc, opts.timeout) : (document.activeElement || document.body);
      if (el.focus) el.focus();
      const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true };
      const prevented = !el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      if (key === 'Enter' && !prevented && el.form && el.form.requestSubmit) el.form.requestSubmit();
      return { ok: true, key, defaultPrevented: prevented };
    },

    async hover(loc, opts = {}) {
      const el = await actionable(loc, opts.timeout);
      el.scrollIntoView({ block: 'center' });
      for (const t of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      }
      return { ok: true, hovered: accessibleName(el) };
    },

    async check(loc, want, opts = {}) {
      const el = await actionable(loc, opts.timeout);
      if (isChecked(el) !== want) el.click();
      if (isChecked(el) !== want) { el.checked = want; fire(el, 'change'); }
      return { ok: true, checked: isChecked(el) };
    },

    async selectOption(loc, { value, label }, opts = {}) {
      const el = await actionable(loc, opts.timeout);
      if (el.tagName !== 'SELECT') throw new Error(`${describe(loc)} is a ${el.tagName.toLowerCase()}, not a <select>`);
      const opt = value != null
        ? [...el.options].find((o) => o.value === value)
        : [...el.options].find((o) => clean(o.text) === clean(label));
      if (!opt) throw new Error(`no option ${JSON.stringify(value ?? label)} — available: ${JSON.stringify([...el.options].map((o) => o.value))}`);
      el.value = opt.value;
      fire(el, 'input');
      fire(el, 'change');
      return { ok: true, selected: opt.value, label: clean(opt.text) };
    },
  };

  window.CreelLocator = {
    snapshot, snapshotText, resolve, queryAll, waitFor, actionable, actions,
    role, accessibleName, isVisible, isEnabled, isChecked, isCredential, readValue,
    describe, MASK,
    /** Read-only text of an element — never a credential value. */
    text(loc, opts) {
      const el = resolve(loc, opts && opts.root);
      return { role: role(el), name: accessibleName(el), text: clean(el.innerText || el.textContent).slice(0, 5000) };
    },
    count(loc) { return queryAll({ ...loc, nth: undefined }).length; },
  };
})();
