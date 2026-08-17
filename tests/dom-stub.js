/* A DOM small enough to read, big enough to boot creel's in-page servers.
 *
 * creel has no build step and no dependencies, and its cross-tab machinery is
 * the one part that cannot be checked by reading a single file: it is only
 * correct if TWO tabs agree. So the test harness makes two of them — two vm
 * contexts, each with its own window/document/sessionStorage, sharing the
 * host's real BroadcastChannel, which is what the tabs would share in a
 * browser. No jsdom, in keeping with the rest of the repo.
 *
 * This is a stub, not an implementation: it supports the selector shapes
 * creel's own code actually uses (#id, tag, tag[name=…], comma lists, and
 * `ancestor descendant`) and nothing more. A selector it cannot parse
 * matches nothing rather than throwing, which mirrors querySelectorAll's
 * behaviour closely enough for these tests.
 */
'use strict';

class El {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = new Map();
    this.style = { cssText: '' };
    this.nodeType = 1;
    this._text = '';
    this.value = '';
    this.listeners = new Map();
    this.classList = {
      _set: new Set(),
      add: (...c) => c.forEach((x) => this.classList._set.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._set.delete(x)),
      contains: (c) => this.classList._set.has(c),
    };
  }

  get id() { return this.attrs.get('id') || ''; }
  set id(v) { this.attrs.set('id', v); this.ownerDocument._byId.set(v, this); }

  get className() {
    return [...this.classList._set].join(' ') || (this.attrs.get('class') || '');
  }
  set className(v) {
    this.attrs.set('class', v);
    this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get innerText() { return this._text || this.children.map((c) => c.innerText).join('\n'); }
  set innerText(v) { this._text = v; }
  get textContent() { return this.innerText; }
  set textContent(v) { this._text = v; }

  get name() { return this.attrs.get('name') || ''; }
  get type() { return this.attrs.get('type') || (this.tagName === 'TEXTAREA' ? 'textarea' : 'text'); }
  get placeholder() { return this.attrs.get('placeholder') || ''; }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
  get labels() { return []; }

  setAttribute(k, v) { if (k === 'id') { this.id = v; return; } this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatchEvent({ type: 'click', target: this }); }
  getBoundingClientRect() { return { width: 100, height: 20 }; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    (this.listeners.get(ev.type) || []).forEach((fn) => fn(ev));
    return true;
  }

  matches(sel) { return matchAny(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return this.ownerDocument._all(this).filter((el) => matchAny(el, sel)); }
}

/** One simple compound selector: tag, #id, .class, [name="x"], or a mix. */
function matchSimple(el, part) {
  const m = part.match(/^([a-z][a-z0-9]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/i);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const bit of m[2].match(/[#.][\w-]+|\[[^\]]+\]/g) || []) {
    if (bit[0] === '#') { if (el.id !== bit.slice(1)) return false; }
    else if (bit[0] === '.') { if (!el.classList.contains(bit.slice(1))) return false; }
    else {
      const a = bit.slice(1, -1).match(/^([\w-]+)(?:([~*^$]?=)"?([^"\]]*)"?)?$/);
      if (!a) return false;
      const have = a[1] === 'id' ? el.id : el.getAttribute(a[1]);
      if (have == null) return false;
      if (a[2] && have !== a[3]) return false;
    }
  }
  return true;
}

/** Descendant combinators only — creel's selectors never need more. */
function matchOne(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchSimple(el, parts.pop())) return false;
  let node = el.parentElement;
  while (parts.length) {
    const want = parts.pop();
    while (node && !matchSimple(node, want)) node = node.parentElement;
    if (!node) return false;
    node = node.parentElement;
  }
  return true;
}

function matchAny(el, sel) {
  return String(sel).split(',').some((s) => s.trim() && matchOne(el, s.trim()));
}

function makeDocument() {
  const doc = { _byId: new Map(), readyState: 'complete', title: 'creel', activeElement: null };
  doc.createElement = (tag) => new El(doc, tag);
  doc._all = (root) => {
    const out = [];
    (function walk(n) { for (const c of n.children) { out.push(c); walk(c); } })(root || doc.documentElement);
    return out;
  };
  doc.documentElement = new El(doc, 'html');
  doc.head = doc.documentElement.appendChild(new El(doc, 'head'));
  doc.body = doc.documentElement.appendChild(new El(doc, 'body'));
  doc.getElementById = (id) => doc._byId.get(id) || null;
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.querySelectorAll = (sel) => doc._all(doc.documentElement).filter((el) => matchAny(el, sel));
  doc.listeners = new Map();
  doc.addEventListener = (t, fn) => { if (!doc.listeners.has(t)) doc.listeners.set(t, []); doc.listeners.get(t).push(fn); };
  doc.dispatchEvent = (ev) => { (doc.listeners.get(ev.type) || []).forEach((fn) => fn(ev)); return true; };
  return doc;
}

module.exports = { El, makeDocument, matchAny };
