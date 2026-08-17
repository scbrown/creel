#!/usr/bin/env node
/* creel — tools/check-html.js: parse the inline <script> blocks of an HTML file.
 *
 * `just check` used to skip app/onepagent.html on the grounds that it is
 * vendored and its scripts are inline. Both halves of that stopped being true:
 * creel edits it constantly, and "inline" is a reason to reach for a parser,
 * not a reason to ship unparsed. A syntax error in a 16k-line inline script
 * otherwise surfaces as a blank page in a browser test, or in production.
 *
 * Each block is checked in isolation with the same parser `node --check` uses.
 * Classic scripts share one global lexical environment, so a name defined in
 * one block and used in another is correct and must not be reported — which is
 * why this is a parse check, not a reference check.
 *
 * Usage: node tools/check-html.js <file.html> [...]
 */
'use strict';

const fs = require('fs');
const vm = require('vm');

/** Inline blocks only — <script src=...> is a separate file the gate already
 *  checks, and a src tag with a body is not something this app does. */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const t = type ? type[1].toLowerCase() : '';
    // Anything that is not JavaScript (import maps, templates) is not ours to parse.
    if (t && !/^(text\/javascript|application\/javascript|module)$/.test(t)) continue;
    const line = html.slice(0, m.index).split('\n').length;
    out.push({ line, code: m[2], module: t === 'module' });
  }
  return out;
}

let failed = 0;
for (const file of process.argv.slice(2)) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = inlineScripts(html);
  for (const b of blocks) {
    // Blank the preceding lines so the parser's line numbers point at the
    // real ones in the HTML file rather than at an offset nobody can use.
    const padded = '\n'.repeat(b.line - 1) + b.code;
    // Module blocks need --experimental-vm-modules to parse; without it, say
    // so rather than reporting a missing flag as a syntax error.
    if (b.module && typeof vm.SourceTextModule !== 'function') {
      console.warn(`${file}: skipping module block at line ${b.line} (needs --experimental-vm-modules)`);
      continue;
    }
    try {
      if (b.module) new vm.SourceTextModule(padded, { identifier: file });
      else new vm.Script(padded, { filename: file });
    } catch (e) {
      failed++;
      console.error(`${file}: inline script at line ${b.line} failed to parse`);
      console.error('  ' + (e.message || String(e)));
    }
  }
  if (!failed) console.log(`${file}: ${blocks.length} inline script block(s) parse`);
}
process.exit(failed ? 1 : 0);
