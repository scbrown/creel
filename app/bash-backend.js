/* creel — in-browser bash: an in-page MCP server ('bash') that runs shell
 * commands against the shared VFS (the FILES panel) with zero network and
 * zero server — a pure-JS interpreter, in keeping with "the sandbox is the
 * browser". Same graceful in-page shape as the other creel backends.
 *
 * Tool: bash_exec {command, stdin?, cwd?, reset?} → {stdout, stderr,
 * exit_code, cwd}. The shell's cwd and exported variables persist across
 * calls for the lifetime of the tab.
 *
 * Supported: pipelines |, sequencing ; and newlines, && and ||, redirection
 * (> >> < 2> 2>> 2>&1, /dev/null), single/double quotes and backslash
 * escapes, comments, variables (NAME=v, $NAME, ${NAME}, $?), command
 * substitution $(...) and `...`, arithmetic $((...)), globs (* ? [...]),
 * and a core utility set implemented over the VFS: ls cat echo printf pwd
 * cd head tail wc grep sed sort uniq cut tr find mkdir rmdir rm cp mv touch
 * basename dirname test [ true false : seq xargs date tee which type env
 * set export unset source sh sleep exit.
 *
 * Deliberately NOT supported (use PythonExec, or the harness's remote
 * Daytona Bash, for these): control flow (if/for/while/case), functions,
 * background jobs, heredocs, real processes, network. Binary VFS files are
 * skipped by text utilities.
 *
 * The interpreter core is dependency-free and exported for node:test via
 * module.exports (createShell + createMemFs); the browser wiring at the
 * bottom binds it to the harness's vfs* globals.
 */
(function () {
  'use strict';

  const MAX_OUT = 200000;      // per-stream cap per bash_exec call
  const MAX_STEPS = 20000;     // commands per call (runaway guard)
  const MAX_DEPTH = 25;        // $(...) nesting

  class BashError extends Error {}
  class ExitSignal { constructor(code) { this.code = code; } }

  // ── paths ────────────────────────────────────────────────────────
  function norm(p, cwd) {
    p = String(p || '').replace(/\\/g, '/');
    if (p === '~') p = '/';
    else if (p.startsWith('~/')) p = '/' + p.slice(2);
    if (!p.startsWith('/')) p = (cwd || '/').replace(/\/$/, '') + '/' + p;
    const parts = [];
    for (const s of p.split('/')) {
      if (s === '..') { if (parts.length) parts.pop(); }
      else if (s && s !== '.') parts.push(s);
    }
    return '/' + parts.join('/');
  }

  // ── tokenizer ────────────────────────────────────────────────────
  // Tokens: {op: ';'|'&&'|'||'|'|'} | {redir, fd, dupTo?} | {word: parts}
  // Word parts: {t, q} literal (q = quoted/expansion-inert),
  //             {v} variable, {sub} command substitution, {arith} $((...))
  function tokenize(src) {
    const toks = [];
    let cur = null;
    const flush = () => { if (cur) { toks.push(cur); cur = null; } };
    const part = (p) => { if (!cur) cur = { word: [] }; cur.word.push(p); };
    const lit = (text, q) => part({ t: text, q: !!q });
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
      if (c === '\n' || c === ';') { flush(); toks.push({ op: ';' }); i++; continue; }
      if (c === '#' && !cur) { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '&') {
        flush();
        if (src[i + 1] === '&') { toks.push({ op: '&&' }); i += 2; continue; }
        throw new BashError('background jobs (&) are not supported in the in-browser bash');
      }
      if (c === '|') {
        flush();
        if (src[i + 1] === '|') { toks.push({ op: '||' }); i += 2; }
        else { toks.push({ op: '|' }); i++; }
        continue;
      }
      if (c === '<' || c === '>' || ((c === '1' || c === '2') && src[i + 1] === '>' && !cur)) {
        flush();
        let fd = 1;
        if (c === '1' || c === '2') { fd = +c; i++; }
        if (src[i] === '<') {
          if (src[i + 1] === '<') throw new BashError('heredocs (<<) are not supported — pass input via the stdin argument or an echo | pipe');
          toks.push({ redir: '<', fd: 0 }); i++; continue;
        }
        i++; // consume '>'
        if (src[i] === '>') { toks.push({ redir: '>>', fd }); i++; continue; }
        if (src[i] === '&' && (src[i + 1] === '1' || src[i + 1] === '2')) {
          toks.push({ redir: '>&', fd, dupTo: +src[i + 1] }); i += 2; continue;
        }
        toks.push({ redir: '>', fd });
        continue;
      }
      if (c === "'") {
        const j = src.indexOf("'", i + 1);
        if (j < 0) throw new BashError('unterminated single quote');
        lit(src.slice(i + 1, j), true); i = j + 1; continue;
      }
      if (c === '"') { i = readDquote(src, i + 1, part); continue; }
      if (c === '$') { i = readDollar(src, i, part, false); continue; }
      if (c === '`') { i = readBacktick(src, i, part, false); continue; }
      if (c === '\\') { lit(src[i + 1] ?? '', true); i += 2; continue; }
      let j = i;
      while (j < n && !' \t\r\n;&|<>\'"`$\\'.includes(src[j])) j++;
      lit(src.slice(i, j), false);
      i = j;
    }
    flush();
    return toks;
  }

  function readDquote(src, i, part) {
    let buf = '';
    const flushBuf = () => { if (buf) { part({ t: buf, q: true }); buf = ''; } };
    while (i < src.length) {
      const c = src[i];
      if (c === '"') { flushBuf(); if (!buf) part({ t: '', q: true }); return i + 1; }
      if (c === '\\' && '"\\$`'.includes(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
      if (c === '$') { flushBuf(); i = readDollar(src, i, part, true); continue; }
      if (c === '`') { flushBuf(); i = readBacktick(src, i, part, true); continue; }
      buf += c; i++;
    }
    throw new BashError('unterminated double quote');
  }

  function readBacktick(src, i, part, q) {
    let j = i + 1;
    let script = '';
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\' && (src[j + 1] === '`' || src[j + 1] === '\\')) { script += src[j + 1]; j += 2; }
      else { script += src[j]; j++; }
    }
    if (j >= src.length) throw new BashError('unterminated backtick substitution');
    part({ sub: script, q });
    return j + 1;
  }

  function readDollar(src, i, part, q) {
    const c = src[i + 1];
    if (c === '{') {
      const j = src.indexOf('}', i + 2);
      if (j < 0) throw new BashError('unterminated ${');
      const name = src.slice(i + 2, j);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new BashError(`unsupported parameter expansion \${${name}} — only \${NAME} is supported`);
      }
      part({ v: name, q });
      return j + 1;
    }
    if (c === '(' && src[i + 2] === '(') {
      let k = i + 3;
      let depth = 0;
      while (k < src.length) {
        if (src[k] === '(') depth++;
        else if (src[k] === ')') {
          if (depth > 0) depth--;
          else if (src[k + 1] === ')') { part({ arith: src.slice(i + 3, k), q }); return k + 2; }
          else throw new BashError('malformed $(( ))');
        }
        k++;
      }
      throw new BashError('unterminated $(( ))');
    }
    if (c === '(') {
      let k = i + 2;
      let depth = 1;
      while (k < src.length && depth > 0) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === "'") { k = src.indexOf("'", k + 1); if (k < 0) throw new BashError('unterminated quote in $()'); k++; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        k++;
      }
      if (depth > 0) throw new BashError('unterminated $( )');
      part({ sub: src.slice(i + 2, k - 1), q });
      return k;
    }
    if (c && /[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      part({ v: src.slice(i + 1, j), q });
      return j;
    }
    if (c === '?') { part({ v: '?', q }); return i + 2; }
    part({ t: '$', q });
    return i + 1;
  }

  // ── parser ───────────────────────────────────────────────────────
  const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select']);

  // items: [{pipe: [cmd...], connector: ';'|'&&'|'||'}]
  // cmd: {assigns: [{name, value: parts}], words: [parts...], redirs}
  function parse(toks) {
    const items = [];
    let connector = ';';
    let pipe = [];
    let cmd = null;
    const ensure = () => { if (!cmd) cmd = { assigns: [], words: [], redirs: [] }; };
    const endCmd = () => { if (cmd) { pipe.push(cmd); cmd = null; } };
    const endPipe = (conn) => {
      endCmd();
      if (pipe.length) { items.push({ pipe, connector }); connector = conn; pipe = []; }
      else if (conn !== ';') throw new BashError(`syntax error near '${conn}'`);
      else connector = ';';
    };
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.op === ';') { endPipe(';'); continue; }
      if (t.op === '&&' || t.op === '||') { endPipe(t.op); continue; }
      if (t.op === '|') {
        endCmd();
        if (!pipe.length) throw new BashError("syntax error near '|'");
        continue;
      }
      if (t.redir) {
        ensure();
        const r = { op: t.redir, fd: t.fd, dupTo: t.dupTo };
        if (t.redir !== '>&') {
          const nt = toks[++k];
          if (!nt || !nt.word) throw new BashError(`missing redirect target after '${t.redir}'`);
          r.target = nt.word;
        }
        cmd.redirs.push(r);
        continue;
      }
      // word: maybe an assignment (only before the first non-assignment word)
      ensure();
      const first = t.word[0];
      if (!cmd.words.length && first && first.t !== undefined && !first.q) {
        const m = first.t.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
        if (m) {
          const value = [];
          if (m[2]) value.push({ t: m[2], q: false });
          value.push(...t.word.slice(1));
          cmd.assigns.push({ name: m[1], value });
          continue;
        }
      }
      cmd.words.push(t.word);
    }
    endPipe(';');
    return items;
  }

  // ── expansion ────────────────────────────────────────────────────
  function lookupVar(sh, name) {
    if (name === '?') return String(sh.lastCode || 0);
    if (name === 'PWD') return sh.cwd;
    if (name === 'HOME') return '/';
    return sh.env[name] ?? '';
  }

  function evalArith(ctx, expr) {
    const sub = expr.replace(/\$?[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
      const v = lookupVar(ctx.sh, m[0] === '$' ? m.slice(1) : m);
      const num = parseInt(v, 10);
      return String(Number.isFinite(num) ? num : 0);
    });
    if (!sub.trim()) return '0';
    if (!/^[\d\s+\-*/%()<>=!&|]*$/.test(sub)) throw new BashError(`unsupported arithmetic expression: ${expr}`);
    let val;
    try { val = Function('"use strict";return (' + sub + ')')(); }
    catch (e) { throw new BashError(`bad arithmetic expression: ${expr}`); }
    const num = Math.trunc(Number(val));
    return String(Number.isFinite(num) ? num : 0);
  }

  function partValue(ctx, part) {
    if (part.t !== undefined) return part.t;
    if (part.v !== undefined) return lookupVar(ctx.sh, part.v);
    if (part.arith !== undefined) return evalArith(ctx, part.arith);
    return cmdSub(ctx, part.sub);
  }

  /** Expansion without field splitting or globbing (assignments, redirects). */
  function expandNoSplit(ctx, parts) {
    let s = '';
    for (const p of parts) s += partValue(ctx, p);
    return s;
  }

  /** Full expansion of one word → zero or more argv fields. */
  function expandWordToFields(ctx, parts) {
    const fields = [];
    let pieces = null;
    const push = (text, glob) => { if (!pieces) pieces = []; pieces.push({ text, glob }); };
    const brk = () => { if (pieces) { fields.push(pieces); pieces = null; } };
    for (const p of parts) {
      if (p.t !== undefined) { push(p.t, !p.q); continue; }
      const val = partValue(ctx, p);
      if (p.q) { push(val, false); continue; }
      const split = val.split(/[ \t\n]+/);
      split.forEach((s, idx) => { if (idx > 0) brk(); if (s) push(s, false); });
    }
    brk();
    const out = [];
    for (const f of fields) out.push(...expandField(ctx, f));
    return out;
  }

  function segRegex(seg) {
    let rx = '^';
    for (let i = 0; i < seg.length; i++) {
      const { ch, g } = seg[i];
      if (!g) { rx += escapeRx(ch); continue; }
      if (ch === '*') rx += '[^/]*';
      else if (ch === '?') rx += '[^/]';
      else if (ch === '[') {
        let cls = '';
        let j = i + 1;
        if (seg[j] && (seg[j].ch === '!' || seg[j].ch === '^')) { cls += '^'; j++; }
        let closed = false;
        for (; j < seg.length; j++) {
          if (seg[j].ch === ']' && cls && cls !== '^') { closed = true; break; }
          cls += seg[j].ch === '\\' ? '\\\\' : seg[j].ch;
        }
        if (closed) { rx += '[' + cls + ']'; i = j; }
        else rx += '\\[';
      } else rx += escapeRx(ch);
    }
    return new RegExp(rx + '$');
  }
  const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function expandField(ctx, pieces) {
    const raw = pieces.map((p) => p.text).join('');
    if (!pieces.some((p) => p.glob && /[*?[]/.test(p.text))) return [raw];
    const chars = [];
    for (const p of pieces) for (const ch of p.text) chars.push({ ch, g: p.glob });
    const absolute = raw.startsWith('/');
    const segs = [[]];
    for (const c of chars) { if (c.ch === '/') segs.push([]); else segs[segs.length - 1].push(c); }
    const segList = segs.filter((s) => s.length);
    let cands = [{ abs: absolute ? '/' : ctx.sh.cwd, disp: absolute ? '/' : '' }];
    const join = (disp, s) => (disp === '' ? s : disp === '/' ? '/' + s : disp + '/' + s);
    for (const seg of segList) {
      const segStr = seg.map((c) => c.ch).join('');
      const hasGlob = seg.some((c) => c.g && /[*?[]/.test(c.ch));
      const next = [];
      for (const cand of cands) {
        if (!hasGlob) {
          const abs = norm(join(cand.abs === '/' ? '/' : cand.abs, segStr), '/');
          if (ctx.sh.fs.node(abs)) next.push({ abs, disp: join(cand.disp, segStr) });
        } else {
          const rx = segRegex(seg);
          for (const e of ctx.sh.fs.list(cand.abs) || []) {
            if (e.name.startsWith('.') && segStr[0] !== '.') continue;
            if (rx.test(e.name)) {
              next.push({ abs: norm(join(cand.abs === '/' ? '/' : cand.abs, e.name), '/'), disp: join(cand.disp, e.name) });
            }
          }
        }
      }
      cands = next;
      if (!cands.length) break;
    }
    return cands.length ? cands.map((c) => c.disp).sort() : [raw];
  }

  function cmdSub(ctx, script) {
    const sh = ctx.sh;
    if (sh.limits.depth >= MAX_DEPTH) throw new BashError('command substitution nested too deeply');
    const sub = { cwd: sh.cwd, env: { ...sh.env }, fs: sh.fs, limits: sh.limits, lastCode: sh.lastCode };
    sh.limits.depth++;
    let res;
    try { res = runScript(sub, script, ''); }
    finally { sh.limits.depth--; }
    ctx.err += res.err;
    return res.out.replace(/\n+$/, '');
  }

  // ── output helpers ───────────────────────────────────────────────
  function cap(sh, s) {
    if (s.length <= MAX_OUT) return s;
    sh.limits.truncated = true;
    return s.slice(0, MAX_OUT) + '\n[output truncated]\n';
  }
  const joinLines = (arr) => (arr.length ? arr.join('\n') + '\n' : '');
  const splitLines = (text) => {
    const lines = String(text).split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const ok = (out = '') => ({ out, err: '', code: 0 });
  const failWith = (msg, code = 1) => ({ out: '', err: msg.endsWith('\n') ? msg : msg + '\n', code });

  // ── fs helpers for utilities ─────────────────────────────────────
  const P = (sh, p) => norm(p, sh.cwd);

  function readFileText(sh, path) {
    const abs = P(sh, path);
    if (abs === '/dev/null') return '';
    const node = sh.fs.node(abs);
    if (!node) return null;
    if (node.type === 'dir') return { dir: true };
    if (node.binary) return { binary: true };
    return sh.fs.read(abs) ?? '';
  }

  /** Read stdin or the given files; calls cb(name, text) per input and
   *  returns partial error output for missing/binary files. */
  function eachInput(sh, files, stdin, cb, tool) {
    let err = '';
    let code = 0;
    if (!files.length) { cb('-', stdin || ''); return { err, code }; }
    for (const f of files) {
      if (f === '-') { cb('-', stdin || ''); continue; }
      const r = readFileText(sh, f);
      if (r === null) { err += `${tool}: ${f}: No such file or directory\n`; code = 1; continue; }
      if (r && r.dir) { err += `${tool}: ${f}: Is a directory\n`; code = 1; continue; }
      if (r && r.binary) { err += `${tool}: ${f}: binary file skipped\n`; code = 1; continue; }
      cb(f, r);
    }
    return { err, code };
  }

  function writeFileOut(sh, path, content, append) {
    const abs = P(sh, path);
    if (abs === '/dev/null') return;
    let prev = '';
    if (append) {
      const r = readFileText(sh, abs);
      if (typeof r === 'string') prev = r;
    }
    sh.fs.write(abs, prev + content);
  }

  function walkTree(sh, absDir, relDisp, cb, depth = 0, maxdepth = Infinity) {
    if (depth > maxdepth) return;
    const node = sh.fs.node(absDir);
    if (!node) return;
    cb(relDisp, absDir, node, depth);
    if (node.type !== 'dir' || depth >= maxdepth) return;
    for (const e of sh.fs.list(absDir) || []) {
      walkTree(sh, norm(absDir + '/' + e.name, '/'), relDisp === '/' ? '/' + e.name : relDisp + '/' + e.name, cb, depth + 1, maxdepth);
    }
  }

  /** Tiny flag parser: boolChars combine (-rf); argChars consume a value. */
  function flags(argv, boolChars, argChars = '') {
    const f = {};
    const args = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { args.push(...argv.slice(i + 1)); break; }
      if (a.startsWith('-') && a.length > 1) {
        let consumed = true;
        for (let k = 1; k < a.length; k++) {
          const ch = a[k];
          if (argChars.includes(ch)) {
            f[ch] = a.slice(k + 1) || argv[++i];
            break;
          }
          if (boolChars.includes(ch)) f[ch] = true;
          else { consumed = false; break; }
        }
        if (consumed) continue;
        throw new BashError(`${a}: invalid option`);
      }
      args.push(a);
    }
    return { f, args };
  }

  // ── utilities ────────────────────────────────────────────────────
  const UTILS = {};

  UTILS.echo = (sh, argv) => {
    const { f, args } = (() => {
      const f = {};
      let i = 0;
      for (; i < argv.length; i++) {
        if (argv[i] === '-n') f.n = true;
        else if (argv[i] === '-e') f.e = true;
        else if (argv[i] === '-ne' || argv[i] === '-en') { f.n = true; f.e = true; }
        else break;
      }
      return { f, args: argv.slice(i) };
    })();
    let s = args.join(' ');
    if (f.e) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    return ok(s + (f.n ? '' : '\n'));
  };

  UTILS.printf = (sh, argv) => {
    if (!argv.length) return failWith('printf: missing format');
    const fmt = argv[0];
    const rest = argv.slice(1);
    const fmtEsc = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
    let out = '';
    let i = 0;
    do {
      out += fmtEsc(fmt).replace(/%[-#0-9.]*[sdixXofeg%]/g, (spec) => {
        if (spec.endsWith('%')) return '%';
        const arg = rest[i++] ?? '';
        const kind = spec[spec.length - 1];
        if (kind === 's') {
          const w = spec.match(/%(-?)(\d+)/);
          let s = String(arg);
          if (w) s = w[1] ? s.padEnd(+w[2]) : s.padStart(+w[2]);
          return s;
        }
        const num = kind === 'f' || kind === 'e' || kind === 'g' ? parseFloat(arg) : parseInt(arg, 10);
        const v = Number.isFinite(num) ? num : 0;
        if (kind === 'x') return v.toString(16);
        if (kind === 'X') return v.toString(16).toUpperCase();
        if (kind === 'o') return v.toString(8);
        if (kind === 'f') return v.toFixed(6);
        return String(Math.trunc(v));
      });
    } while (i < rest.length && /%[^%]/.test(fmt));
    return ok(out);
  };

  UTILS.cat = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 'n');
    let out = '';
    const { err, code } = eachInput(sh, args, stdin, (name, text) => { out += text; }, 'cat');
    if (f.n) out = joinLines(splitLines(out).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`));
    return { out, err, code };
  };

  UTILS.pwd = (sh) => ok(sh.cwd + '\n');

  UTILS.ls = (sh, argv) => {
    const { f, args } = flags(argv, 'laR1Fdh');
    const paths = args.length ? args : ['.'];
    let out = '';
    let err = '';
    let code = 0;
    const fmt = (name, node) => (f.l ? `${node.type === 'dir' ? 'd' : '-'}rw-r--r-- ${String(node.size ?? 0).padStart(8)} ${name}` : name);
    const listDir = (abs, disp, header) => {
      if (header) out += `${disp}:\n`;
      const entries = (sh.fs.list(abs) || []).filter((e) => f.a || !e.name.startsWith('.'));
      out += joinLines(entries.map((e) => fmt(e.name + (e.type === 'dir' && !f.l ? '/' : ''), sh.fs.node(norm(abs + '/' + e.name, '/')) || { type: e.type })));
      if (f.R) {
        for (const e of entries) {
          if (e.type === 'dir') { out += '\n'; listDir(norm(abs + '/' + e.name, '/'), disp === '/' ? '/' + e.name : disp + '/' + e.name, true); }
        }
      }
    };
    const multi = paths.length > 1 || f.R;
    paths.forEach((p, idx) => {
      const abs = P(sh, p);
      const node = sh.fs.node(abs);
      if (!node) { err += `ls: cannot access '${p}': No such file or directory\n`; code = 2; return; }
      if (node.type === 'file' || f.d) { out += fmt(p, node) + '\n'; return; }
      if (idx > 0) out += '\n';
      listDir(abs, p, multi);
    });
    return { out, err, code };
  };

  UTILS.head = (sh, argv, stdin) => headTail(sh, argv, stdin, 'head');
  UTILS.tail = (sh, argv, stdin) => headTail(sh, argv, stdin, 'tail');
  function headTail(sh, argv, stdin, which) {
    argv = argv.map((a) => (/^-\d+$/.test(a) ? '-n' + a.slice(1) : a));
    const { f, args } = flags(argv, 'q', 'nc');
    let out = '';
    const { err, code } = eachInput(sh, args, stdin, (name, text) => {
      if (args.length > 1 && !f.q) out += `==> ${name} <==\n`;
      if (f.c !== undefined) {
        const c = parseInt(f.c, 10) || 0;
        out += which === 'head' ? text.slice(0, c) : text.slice(Math.max(0, text.length - c));
        return;
      }
      const nSpec = f.n !== undefined ? String(f.n) : '10';
      const lines = splitLines(text);
      if (which === 'tail' && nSpec.startsWith('+')) { out += joinLines(lines.slice(Math.max(0, parseInt(nSpec, 10) - 1))); return; }
      const n = Math.max(0, parseInt(nSpec, 10) || 0);
      out += joinLines(which === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n)));
    }, which);
    return { out, err, code };
  }

  UTILS.wc = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 'lwc');
    const noFlags = !f.l && !f.w && !f.c;
    const rows = [];
    const totals = { l: 0, w: 0, c: 0 };
    const { err, code } = eachInput(sh, args, stdin, (name, text) => {
      const l = (text.match(/\n/g) || []).length;
      const w = (text.match(/\S+/g) || []).length;
      const c = text.length;
      totals.l += l; totals.w += w; totals.c += c;
      rows.push({ name, l, w, c });
    }, 'wc');
    const fmt = (r) => {
      const cols = [];
      if (f.l || noFlags) cols.push(r.l);
      if (f.w || noFlags) cols.push(r.w);
      if (f.c || noFlags) cols.push(r.c);
      return cols.join(' ') + (r.name !== '-' ? ' ' + r.name : '');
    };
    const lines = rows.map(fmt);
    if (rows.length > 1) lines.push(fmt({ ...totals, name: 'total' }));
    return { out: joinLines(lines), err, code };
  };

  UTILS.grep = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 'ivnclrqoEFhw');
    if (!args.length) return failWith('usage: grep [-ivnclrqoEF] PATTERN [FILE...]', 2);
    const pat = args[0];
    let files = args.slice(1);
    let rx;
    try { rx = new RegExp(f.F ? escapeRx(pat) : f.w ? `\\b(?:${pat})\\b` : pat, f.i ? 'i' : ''); }
    catch (e) { rx = new RegExp(escapeRx(pat), f.i ? 'i' : ''); }
    if (f.r) {
      const expanded = [];
      for (const file of files.length ? files : ['.']) {
        const abs = P(sh, file);
        const node = sh.fs.node(abs);
        if (node && node.type === 'dir') walkTree(sh, abs, file, (disp, a, n) => { if (n.type === 'file' && !n.binary) expanded.push(disp); });
        else expanded.push(file);
      }
      files = expanded;
    }
    let out = '';
    let found = false;
    const multi = files.length > 1;
    const { err, code } = eachInput(sh, files, stdin, (name, text) => {
      let count = 0;
      for (const [idx, line] of splitLines(text).entries()) {
        const hit = rx.test(line) !== !!f.v;
        if (!hit) continue;
        found = true;
        count++;
        if (f.q || f.c || f.l) continue;
        const prefix = (multi && !f.h ? name + ':' : '') + (f.n ? (idx + 1) + ':' : '');
        if (f.o && !f.v) {
          const g = new RegExp(rx.source, rx.flags.replace('g', '') + 'g');
          for (const m of line.matchAll(g)) if (m[0]) out += prefix + m[0] + '\n';
        } else out += prefix + line + '\n';
      }
      if (f.c) out += (multi && !f.h ? name + ':' : '') + count + '\n';
      if (f.l && count) out += name + '\n';
    }, 'grep');
    if (f.q) return { out: '', err: '', code: found ? 0 : 1 };
    return { out, err, code: found ? 0 : (code || 1) };
  };

  // sed: [addr[,addr]]cmd where cmd ∈ s/// (flags g i p), p, d — plus -n, -e, -i
  function parseSedScript(script) {
    const cmds = [];
    let i = 0;
    const s = script;
    const readAddr = () => {
      if (s[i] === '$') { i++; return { last: true }; }
      if (/\d/.test(s[i])) { let j = i; while (/\d/.test(s[j])) j++; const n = +s.slice(i, j); i = j; return { line: n }; }
      if (s[i] === '/') {
        let j = i + 1;
        let re = '';
        while (j < s.length && s[j] !== '/') { re += s[j] === '\\' && s[j + 1] === '/' ? (j++, '/') : s[j]; j++; }
        i = j + 1;
        return { re: new RegExp(re) };
      }
      return null;
    };
    while (i < s.length) {
      while (s[i] === ';' || s[i] === ' ' || s[i] === '\n' || s[i] === '\t') i++;
      if (i >= s.length) break;
      const a1 = readAddr();
      let a2 = null;
      if (s[i] === ',') { i++; a2 = readAddr(); }
      const c = s[i];
      if (c === 's') {
        const delim = s[i + 1];
        if (!delim) throw new BashError('sed: unterminated s command');
        let j = i + 2;
        const readPart = () => {
          let buf = '';
          while (j < s.length && s[j] !== delim) { buf += s[j] === '\\' && s[j + 1] === delim ? (j++, delim) : s[j]; j++; }
          j++;
          return buf;
        };
        const pat = readPart();
        const rep = readPart();
        let fl = '';
        while (j < s.length && /[gip]/.test(s[j])) { fl += s[j]; j++; }
        i = j;
        cmds.push({ cmd: 's', a1, a2, pat, rep, g: fl.includes('g'), i: fl.includes('i'), p: fl.includes('p'), state: {} });
      } else if (c === 'd' || c === 'p') {
        i++;
        cmds.push({ cmd: c, a1, a2, state: {} });
      } else {
        throw new BashError(`sed: unsupported command '${c}' (supported: s///, p, d)`);
      }
    }
    return cmds;
  }

  function sedRepl(rep) {
    return (...m) => {
      let out = '';
      for (let i = 0; i < rep.length; i++) {
        if (rep[i] === '&') out += m[0];
        else if (rep[i] === '\\' && /[0-9&\\]/.test(rep[i + 1])) {
          const c = rep[++i];
          out += c === '&' ? '&' : c === '\\' ? '\\' : (m[+c] ?? '');
        } else out += rep[i];
      }
      return out;
    };
  }

  UTILS.sed = (sh, argv, stdin) => {
    const scripts = [];
    const files = [];
    let quiet = false;
    let inPlace = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-n') quiet = true;
      else if (a === '-i') inPlace = true;
      else if (a === '-e') scripts.push(argv[++i]);
      else if (a.startsWith('-') && a !== '-') return failWith(`sed: unsupported option ${a}`, 2);
      else if (!scripts.length) scripts.push(a);
      else files.push(a);
    }
    if (!scripts.length) return failWith('usage: sed [-n] [-i] [-e SCRIPT]... [FILE...]', 2);
    let cmds;
    try { cmds = parseSedScript(scripts.join('\n')); }
    catch (e) { return failWith(`sed: ${e.message}`, 2); }
    const runOn = (text) => {
      const lines = splitLines(text);
      const outLines = [];
      for (const c of cmds) c.state.active = false;
      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        let deleted = false;
        const extra = [];
        const matchAddr = (a) => (a.last ? lineNo === lines.length : a.line !== undefined ? lineNo === a.line : a.re.test(line));
        for (const c of cmds) {
          let sel = true;
          if (c.a1 && !c.a2) sel = matchAddr(c.a1);
          else if (c.a1 && c.a2) {
            if (!c.state.active) { if (matchAddr(c.a1)) { c.state.active = true; sel = true; } else sel = false; }
            else { sel = true; if (matchAddr(c.a2)) c.state.active = false; }
          }
          if (!sel || deleted) continue;
          if (c.cmd === 'd') deleted = true;
          else if (c.cmd === 'p') extra.push(line);
          else if (c.cmd === 's') {
            let rx;
            try { rx = new RegExp(c.pat, (c.g ? 'g' : '') + (c.i ? 'i' : '')); }
            catch (e) { rx = new RegExp(escapeRx(c.pat), c.g ? 'g' : ''); }
            line = line.replace(rx, sedRepl(c.rep));
            if (c.p) extra.push(line);
          }
        }
        if (!deleted && !quiet) outLines.push(line);
        outLines.push(...extra);
      });
      return joinLines(outLines);
    };
    if (inPlace) {
      if (!files.length) return failWith('sed: -i requires file arguments', 2);
      let err = '';
      let code = 0;
      for (const f of files) {
        const r = readFileText(sh, f);
        if (typeof r !== 'string') { err += `sed: ${f}: cannot read\n`; code = 2; continue; }
        writeFileOut(sh, f, runOn(r), false);
      }
      return { out: '', err, code };
    }
    let out = '';
    const { err, code } = eachInput(sh, files, stdin, (name, text) => { out += runOn(text); }, 'sed');
    return { out, err, code };
  };

  UTILS.sort = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 'rnuf');
    let lines = [];
    const { err, code } = eachInput(sh, args, stdin, (name, text) => { lines.push(...splitLines(text)); }, 'sort');
    lines.sort((a, b) => {
      if (f.n) return (parseFloat(a) || 0) - (parseFloat(b) || 0);
      const x = f.f ? a.toLowerCase() : a;
      const y = f.f ? b.toLowerCase() : b;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    if (f.r) lines.reverse();
    if (f.u) lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
    return { out: joinLines(lines), err, code };
  };

  UTILS.uniq = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 'cdi');
    const lines = [];
    const { err, code } = eachInput(sh, args.slice(0, 1), stdin, (name, text) => { lines.push(...splitLines(text)); }, 'uniq');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      let j = i;
      while (j < lines.length && (f.i ? lines[j].toLowerCase() === lines[i].toLowerCase() : lines[j] === lines[i])) j++;
      const count = j - i;
      if (!f.d || count > 1) out.push(f.c ? `${String(count).padStart(7)} ${lines[i]}` : lines[i]);
      i = j;
    }
    return { out: joinLines(out), err, code };
  };

  function parseRanges(spec, max) {
    const idx = new Set();
    for (const part of spec.split(',')) {
      const m = part.match(/^(\d*)-(\d*)$|^(\d+)$/);
      if (!m) throw new BashError(`cut: invalid range: ${part}`);
      if (m[3]) idx.add(+m[3]);
      else {
        const lo = m[1] ? +m[1] : 1;
        const hi = m[2] ? +m[2] : max;
        for (let i = lo; i <= Math.min(hi, max); i++) idx.add(i);
      }
    }
    return idx;
  }

  UTILS.cut = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 's', 'dfc');
    if (f.f === undefined && f.c === undefined) return failWith('cut: specify -f or -c', 2);
    const delim = f.d !== undefined ? f.d : '\t';
    const out = [];
    const { err, code } = eachInput(sh, args, stdin, (name, text) => {
      for (const line of splitLines(text)) {
        if (f.c !== undefined) {
          const idx = parseRanges(f.c, line.length);
          out.push([...line].filter((ch, i) => idx.has(i + 1)).join(''));
          continue;
        }
        if (!line.includes(delim)) { if (!f.s) out.push(line); continue; }
        const fieldsArr = line.split(delim);
        const idx = parseRanges(f.f, fieldsArr.length);
        out.push(fieldsArr.filter((x, i) => idx.has(i + 1)).join(delim));
      }
    }, 'cut');
    return { out: joinLines(out), err, code };
  };

  function trExpand(set) {
    const CLASSES = {
      '[:lower:]': 'abcdefghijklmnopqrstuvwxyz', '[:upper:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      '[:digit:]': '0123456789', '[:space:]': ' \t\n\r\f\v',
      '[:alpha:]': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
      '[:alnum:]': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    };
    for (const [k, v] of Object.entries(CLASSES)) set = set.split(k).join(v);
    set = set.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    let out = '';
    for (let i = 0; i < set.length; i++) {
      if (set[i + 1] === '-' && set[i + 2] && set[i + 2] !== '-') {
        for (let c = set.charCodeAt(i); c <= set.charCodeAt(i + 2); c++) out += String.fromCharCode(c);
        i += 2;
      } else out += set[i];
    }
    return out;
  }

  UTILS.tr = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 'dsc');
    if (!args.length) return failWith('usage: tr [-ds] SET1 [SET2]', 2);
    const set1 = trExpand(args[0]);
    let out = '';
    if (f.d) {
      const del = new Set(set1);
      out = [...(stdin || '')].filter((ch) => !del.has(ch)).join('');
    } else {
      if (args.length < 2) return failWith('tr: missing SET2', 2);
      let set2 = trExpand(args[1]);
      while (set2.length < set1.length) set2 += set2[set2.length - 1] || '';
      const map = new Map();
      for (let i = 0; i < set1.length; i++) map.set(set1[i], set2[i]);
      out = [...(stdin || '')].map((ch) => map.get(ch) ?? ch).join('');
    }
    if (f.s) out = out.replace(/(.)\1+/gs, (m, c) => ((args[1] ? trExpand(args[1]) : set1).includes(c) ? c : m));
    return ok(out);
  };

  UTILS.find = (sh, argv) => {
    const paths = [];
    let i = 0;
    while (i < argv.length && !argv[i].startsWith('-')) paths.push(argv[i++]);
    if (!paths.length) paths.push('.');
    let namePat = null;
    let type = null;
    let maxdepth = Infinity;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-name' || a === '-iname') namePat = { rx: segRegex([...argv[++i]].map((ch) => ({ ch, g: true }))), i: a === '-iname' };
      else if (a === '-type') type = argv[++i];
      else if (a === '-maxdepth') maxdepth = parseInt(argv[++i], 10);
      else if (a === '-print') { /* default */ }
      else return failWith(`find: unsupported predicate ${a} (supported: -name, -iname, -type, -maxdepth, -print)`, 2);
    }
    let out = '';
    let err = '';
    let code = 0;
    for (const p of paths) {
      const abs = P(sh, p);
      if (!sh.fs.node(abs)) { err += `find: '${p}': No such file or directory\n`; code = 1; continue; }
      walkTree(sh, abs, p, (disp, a, node) => {
        if (type === 'f' && node.type !== 'file') return;
        if (type === 'd' && node.type !== 'dir') return;
        if (namePat) {
          const base = disp.split('/').pop() || disp;
          if (!namePat.rx.test(namePat.i ? base.toLowerCase() : base)) return;
        }
        out += disp + '\n';
      }, 0, maxdepth);
    }
    return { out, err, code };
  };

  UTILS.mkdir = (sh, argv) => {
    const { f, args } = flags(argv, 'p');
    if (!args.length) return failWith('mkdir: missing operand');
    let err = '';
    let code = 0;
    for (const p of args) {
      const abs = P(sh, p);
      const existing = sh.fs.node(abs);
      if (existing) {
        if (!f.p || existing.type !== 'dir') { err += `mkdir: cannot create directory '${p}': File exists\n`; code = 1; }
        continue;
      }
      if (!f.p) {
        const parent = norm(abs + '/..', '/');
        const pn = sh.fs.node(parent);
        if (!pn || pn.type !== 'dir') { err += `mkdir: cannot create directory '${p}': No such file or directory\n`; code = 1; continue; }
      }
      sh.fs.mkdir(abs);
    }
    return { out: '', err, code };
  };

  UTILS.rmdir = (sh, argv) => {
    let err = '';
    let code = 0;
    for (const p of argv) {
      const abs = P(sh, p);
      const node = sh.fs.node(abs);
      if (!node || node.type !== 'dir') { err += `rmdir: failed to remove '${p}': Not a directory\n`; code = 1; continue; }
      if ((sh.fs.list(abs) || []).length) { err += `rmdir: failed to remove '${p}': Directory not empty\n`; code = 1; continue; }
      sh.fs.remove(abs);
    }
    return { out: '', err, code };
  };

  UTILS.rm = (sh, argv) => {
    const { f, args } = flags(argv, 'rfv');
    if (!args.length) return f.f ? ok() : failWith('rm: missing operand');
    let out = '';
    let err = '';
    let code = 0;
    for (const p of args) {
      const abs = P(sh, p);
      const node = sh.fs.node(abs);
      if (!node) { if (!f.f) { err += `rm: cannot remove '${p}': No such file or directory\n`; code = 1; } continue; }
      if (node.type === 'dir' && !f.r) { err += `rm: cannot remove '${p}': Is a directory\n`; code = 1; continue; }
      sh.fs.remove(abs);
      if (f.v) out += `removed '${p}'\n`;
    }
    return { out, err, code };
  };

  function copyOne(sh, srcAbs, destAbs, recurse, errs) {
    const node = sh.fs.node(srcAbs);
    if (!node) { errs.push(`No such file or directory: ${srcAbs}`); return; }
    if (node.type === 'dir') {
      if (!recurse) { errs.push(`omitting directory '${srcAbs}' (use -r)`); return; }
      sh.fs.mkdir(destAbs);
      for (const e of sh.fs.list(srcAbs) || []) {
        copyOne(sh, norm(srcAbs + '/' + e.name, '/'), norm(destAbs + '/' + e.name, '/'), true, errs);
      }
      return;
    }
    if (node.binary) { errs.push(`skipping binary file '${srcAbs}' (in-browser bash copies text only)`); return; }
    sh.fs.write(destAbs, sh.fs.read(srcAbs) ?? '');
  }

  function cpMv(sh, argv, move) {
    const tool = move ? 'mv' : 'cp';
    const { f, args } = flags(argv, 'rfRv');
    if (args.length < 2) return failWith(`${tool}: missing operand`);
    const destArg = args[args.length - 1];
    const srcs = args.slice(0, -1);
    const destAbsBase = P(sh, destArg);
    const destNode = sh.fs.node(destAbsBase);
    const destIsDir = destNode && destNode.type === 'dir';
    if (srcs.length > 1 && !destIsDir) return failWith(`${tool}: target '${destArg}' is not a directory`);
    const errs = [];
    for (const s of srcs) {
      const srcAbs = P(sh, s);
      const base = srcAbs.split('/').pop();
      const dest = destIsDir ? norm(destAbsBase + '/' + base, '/') : destAbsBase;
      const srcNode = sh.fs.node(srcAbs);
      if (!srcNode) { errs.push(`cannot stat '${s}': No such file or directory`); continue; }
      const before = errs.length;
      copyOne(sh, srcAbs, dest, f.r || f.R || move, errs);
      if (move && errs.length === before) sh.fs.remove(srcAbs);
    }
    return errs.length ? { out: '', err: errs.map((e) => `${tool}: ${e}`).join('\n') + '\n', code: 1 } : ok();
  }
  UTILS.cp = (sh, argv) => cpMv(sh, argv, false);
  UTILS.mv = (sh, argv) => cpMv(sh, argv, true);

  UTILS.touch = (sh, argv) => {
    if (!argv.length) return failWith('touch: missing operand');
    for (const p of argv.filter((a) => !a.startsWith('-'))) {
      const abs = P(sh, p);
      const node = sh.fs.node(abs);
      if (!node) sh.fs.write(abs, '');
      else if (node.type === 'file' && !node.binary) sh.fs.write(abs, sh.fs.read(abs) ?? '');
    }
    return ok();
  };

  UTILS.basename = (sh, argv) => {
    if (!argv.length) return failWith('basename: missing operand');
    let b = argv[0].replace(/\/+$/, '').split('/').pop() || '/';
    if (argv[1] && b !== argv[1] && b.endsWith(argv[1])) b = b.slice(0, -argv[1].length);
    return ok(b + '\n');
  };

  UTILS.dirname = (sh, argv) => {
    if (!argv.length) return failWith('dirname: missing operand');
    const p = argv[0].replace(/\/+$/, '');
    const idx = p.lastIndexOf('/');
    return ok((idx < 0 ? '.' : idx === 0 ? '/' : p.slice(0, idx)) + '\n');
  };

  UTILS.test = (sh, argv) => {
    if (argv[argv.length - 1] === ']') argv = argv.slice(0, -1);
    const evalTest = (a) => {
      if (!a.length) return false;
      if (a[0] === '!') return !evalTest(a.slice(1));
      if (a.length === 1) return a[0] !== '';
      if (a.length === 2) {
        const [op, v] = a;
        const node = () => sh.fs.node(P(sh, v));
        switch (op) {
          case '-e': return !!node();
          case '-f': return node()?.type === 'file';
          case '-d': return node()?.type === 'dir';
          case '-s': { const nd = node(); return nd?.type === 'file' && (nd.size ?? 0) > 0; }
          case '-z': return v === '';
          case '-n': return v !== '';
          case '-r': case '-w': case '-x': return !!node();
          default: throw new BashError(`test: ${op}: unary operator expected`);
        }
      }
      if (a.length === 3) {
        const [x, op, y] = a;
        const nx = parseInt(x, 10);
        const ny = parseInt(y, 10);
        switch (op) {
          case '=': case '==': return x === y;
          case '!=': return x !== y;
          case '-eq': return nx === ny;
          case '-ne': return nx !== ny;
          case '-lt': return nx < ny;
          case '-le': return nx <= ny;
          case '-gt': return nx > ny;
          case '-ge': return nx >= ny;
          default: throw new BashError(`test: ${op}: binary operator expected`);
        }
      }
      throw new BashError('test: too many arguments (compound -a/-o not supported)');
    };
    try { return { out: '', err: '', code: evalTest(argv) ? 0 : 1 }; }
    catch (e) { return failWith(e.message, 2); }
  };
  UTILS['['] = UTILS.test;

  UTILS.true = () => ok();
  UTILS.false = () => ({ out: '', err: '', code: 1 });
  UTILS[':'] = () => ok();
  UTILS.sleep = () => ok(); // no blocking sleeps in a synchronous page interpreter

  UTILS.seq = (sh, argv) => {
    const nums = argv.map(Number);
    let first = 1;
    let incr = 1;
    let last;
    if (nums.length === 1) last = nums[0];
    else if (nums.length === 2) { first = nums[0]; last = nums[1]; }
    else if (nums.length === 3) { first = nums[0]; incr = nums[1]; last = nums[2]; }
    else return failWith('usage: seq [FIRST [INCR]] LAST', 2);
    if (nums.some((x) => !Number.isFinite(x)) || incr === 0) return failWith('seq: invalid arguments', 2);
    const out = [];
    if (incr > 0) for (let x = first; x <= last && out.length < 100000; x += incr) out.push(x);
    else for (let x = first; x >= last && out.length < 100000; x += incr) out.push(x);
    return ok(joinLines(out.map(String)));
  };

  UTILS.xargs = (sh, argv, stdin, run) => {
    const { f, args } = flags(argv, 'r', 'nI');
    const cmd = args.length ? args : ['echo'];
    const items = f.I !== undefined
      ? splitLines(stdin || '').filter((l) => l.trim() !== '')
      : (stdin || '').split(/\s+/).filter(Boolean);
    if (!items.length && f.r) return ok();
    let out = '';
    let err = '';
    let anyFail = false;
    const runBatch = (batch) => {
      const full = f.I !== undefined
        ? cmd.map((a) => a.split(f.I).join(batch[0]))
        : [...cmd, ...batch];
      const r = run(full, '');
      out += r.out;
      err += r.err;
      if (r.code !== 0) anyFail = true;
    };
    if (f.I !== undefined) for (const item of items) runBatch([item]);
    else if (f.n !== undefined) {
      const n = Math.max(1, parseInt(f.n, 10) || 1);
      for (let i = 0; i < items.length; i += n) runBatch(items.slice(i, i + n));
    } else if (items.length || !f.r) runBatch(items);
    return { out, err, code: anyFail ? 123 : 0 };
  };

  UTILS.tee = (sh, argv, stdin) => {
    const { f, args } = flags(argv, 'a');
    let err = '';
    let code = 0;
    for (const p of args) {
      try { writeFileOut(sh, p, stdin || '', f.a); }
      catch (e) { err += `tee: ${p}: ${e.message}\n`; code = 1; }
    }
    return { out: stdin || '', err, code };
  };

  UTILS.date = (sh, argv) => {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const fmt = (argv.find((a) => a.startsWith('+')) || '+%a %b %e %H:%M:%S %Y').slice(1);
    const out = fmt.replace(/%[YmdHMSseFTabj%]/g, (sp) => {
      switch (sp[1]) {
        case 'Y': return String(d.getFullYear());
        case 'm': return pad(d.getMonth() + 1);
        case 'd': return pad(d.getDate());
        case 'e': return String(d.getDate()).padStart(2);
        case 'H': return pad(d.getHours());
        case 'M': return pad(d.getMinutes());
        case 'S': return pad(d.getSeconds());
        case 's': return String(Math.floor(d.getTime() / 1000));
        case 'F': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        case 'T': return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        case 'a': return DAY[d.getDay()];
        case 'b': return MON[d.getMonth()];
        case 'j': return pad(Math.ceil((d - new Date(d.getFullYear(), 0, 0)) / 86400000), 3);
        case '%': return '%';
        default: return sp;
      }
    });
    return ok(out + '\n');
  };

  UTILS.env = (sh) => ok(joinLines(Object.keys(sh.env).sort().map((k) => `${k}=${sh.env[k]}`)));
  UTILS.which = (sh, argv) => {
    const lines = [];
    let code = 0;
    for (const a of argv) {
      if (UTILS[a] || BUILTINS[a]) lines.push(`/bin/${a}`);
      else code = 1;
    }
    return { out: joinLines(lines), err: '', code };
  };
  UTILS.type = (sh, argv) => {
    const lines = [];
    let code = 0;
    for (const a of argv) {
      if (BUILTINS[a]) lines.push(`${a} is a shell builtin`);
      else if (UTILS[a]) lines.push(`${a} is /bin/${a}`);
      else { lines.push(`type: ${a}: not found`); code = 1; }
    }
    return { out: joinLines(lines), err: '', code };
  };

  // ── builtins (mutate shell state) ────────────────────────────────
  const BUILTINS = {
    cd(sh, argv) {
      const target = argv[0] ?? '/';
      const abs = P(sh, target);
      const node = sh.fs.node(abs);
      if (!node) return failWith(`cd: ${target}: No such file or directory`);
      if (node.type !== 'dir') return failWith(`cd: ${target}: Not a directory`);
      sh.cwd = abs;
      return ok();
    },
    exit(sh, argv) {
      throw new ExitSignal(argv[0] !== undefined ? (parseInt(argv[0], 10) || 0) & 255 : sh.lastCode || 0);
    },
    export(sh, argv) {
      for (const a of argv) {
        const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/);
        if (!m) return failWith(`export: ${a}: not a valid identifier`);
        if (m[2] !== undefined) sh.env[m[1]] = m[2];
        else if (sh.env[m[1]] === undefined) sh.env[m[1]] = '';
      }
      return ok();
    },
    unset(sh, argv) {
      for (const a of argv) delete sh.env[a];
      return ok();
    },
    set(sh, argv) {
      if (!argv.length) return UTILS.env(sh);
      return ok(); // accept `set -euo pipefail` etc. as a no-op
    },
    shopt() { return ok(); },
    source(sh, argv, stdin) {
      if (!argv.length) return failWith('source: filename argument required', 2);
      const r = readFileText(sh, argv[0]);
      if (typeof r !== 'string') return failWith(`source: ${argv[0]}: No such file or directory`);
      return runScript(sh, r, stdin);
    },
    sh(sh, argv, stdin) {
      if (argv[0] === '-c' && argv[1] !== undefined) {
        const sub = { cwd: sh.cwd, env: { ...sh.env }, fs: sh.fs, limits: sh.limits, lastCode: 0 };
        return runScript(sub, argv[1], stdin);
      }
      if (!argv.length) return failWith('sh: interactive mode not supported (pass a script file or -c)', 2);
      const r = readFileText(sh, argv[0]);
      if (typeof r !== 'string') return failWith(`sh: ${argv[0]}: No such file or directory`, 127);
      const sub = { cwd: sh.cwd, env: { ...sh.env }, fs: sh.fs, limits: sh.limits, lastCode: 0 };
      return runScript(sub, r, stdin);
    },
  };
  BUILTINS['.'] = BUILTINS.source;
  BUILTINS.bash = BUILTINS.sh;

  // ── executor ─────────────────────────────────────────────────────
  function runSimple(sh, argv, stdin) {
    const name = argv[0];
    const rest = argv.slice(1);
    if (RESERVED.has(name)) {
      return failWith(`bash: ${name}: control flow is not supported by the in-browser bash — compose with pipes, xargs, $(...), or use PythonExec`, 2);
    }
    const fn = BUILTINS[name] || UTILS[name];
    if (!fn) return failWith(`bash: ${name}: command not found (in-browser bash implements a subset — see the bash_exec tool description; use PythonExec for more)`, 127);
    try { return fn(sh, rest, stdin, (a, s) => runSimple(sh, a, s)); }
    catch (e) {
      if (e instanceof ExitSignal) throw e;
      // a bad flag or malformed argument fails this command, not the script
      return failWith(`${name}: ${e.message}`, e instanceof BashError ? 2 : 1);
    }
  }

  function runCommand(sh, cmd, stdin) {
    if (++sh.limits.steps > MAX_STEPS) throw new BashError('command limit exceeded (possible runaway loop)');
    const ctx = { sh, err: '' };
    const assigns = cmd.assigns.map((a) => ({ name: a.name, value: expandNoSplit(ctx, a.value) }));
    if (!cmd.words.length) {
      for (const a of assigns) sh.env[a.name] = a.value;
      return { out: '', err: ctx.err, code: 0 };
    }
    const argv = [];
    for (const w of cmd.words) argv.push(...expandWordToFields(ctx, w));
    if (!argv.length) return { out: '', err: ctx.err, code: 0 };
    const redirs = cmd.redirs.map((r) => (r.target ? { ...r, path: expandNoSplit(ctx, r.target) } : r));
    let input = stdin;
    for (const r of redirs) {
      if (r.op !== '<') continue;
      const t = readFileText(sh, r.path);
      if (typeof t !== 'string') return { out: '', err: ctx.err + `bash: ${r.path}: No such file or directory\n`, code: 1 };
      input = t;
    }
    // NAME=v prefix assignments scope to this one command
    const saved = {};
    for (const a of assigns) { saved[a.name] = sh.env[a.name]; sh.env[a.name] = a.value; }
    let res;
    try { res = runSimple(sh, argv, input); }
    finally {
      for (const a of assigns) {
        if (saved[a.name] === undefined) delete sh.env[a.name];
        else sh.env[a.name] = saved[a.name];
      }
    }
    let out = res.out;
    let err = cap(sh, ctx.err + res.err);
    const dup = redirs.find((r) => r.op === '>&');
    if (dup) {
      if (dup.fd === 2 && dup.dupTo === 1) { out = cap(sh, out + err); err = ''; }
      else if (dup.fd === 1 && dup.dupTo === 2) { err = cap(sh, err + out); out = ''; }
    }
    for (const r of redirs) {
      if (r.op !== '>' && r.op !== '>>') continue;
      const stream = r.fd === 2 ? err : out;
      try { writeFileOut(sh, r.path, stream, r.op === '>>'); }
      catch (e) { return { out: '', err: err + `bash: ${r.path}: ${e.message}\n`, code: 1 }; }
      if (r.fd === 2) err = ''; else out = '';
    }
    return { out, err, code: res.code };
  }

  function runPipeline(sh, cmds, stdin) {
    let cur = stdin ?? '';
    let err = '';
    let code = 0;
    for (const cmd of cmds) {
      const r = runCommand(sh, cmd, cur);
      err = cap(sh, err + r.err);
      cur = r.out;
      code = r.code;
    }
    return { out: cur, err, code };
  }

  function runScript(sh, src, stdin) {
    const items = parse(tokenize(src));
    let out = '';
    let err = '';
    let last = sh.lastCode || 0;
    for (const item of items) {
      if (item.connector === '&&' && last !== 0) continue;
      if (item.connector === '||' && last === 0) continue;
      let r;
      try { r = runPipeline(sh, item.pipe, stdin); }
      catch (e) {
        if (e instanceof ExitSignal) { last = e.code; sh.lastCode = last; break; }
        throw e;
      }
      out = cap(sh, out + r.out);
      err = cap(sh, err + r.err);
      last = r.code;
      sh.lastCode = last;
    }
    return { out, err, code: last };
  }

  // ── shell factory ────────────────────────────────────────────────
  function createShell(fs, opts = {}) {
    const sh = {
      cwd: opts.cwd || '/',
      env: { HOME: '/', PATH: '/bin', ...(opts.env || {}) },
      fs,
      lastCode: 0,
      limits: { steps: 0, depth: 0, truncated: false },
    };
    return {
      state: sh,
      exec(script, { stdin } = {}) {
        sh.limits.steps = 0;
        sh.limits.depth = 0;
        sh.limits.truncated = false;
        let res;
        try { res = runScript(sh, String(script ?? ''), stdin != null ? String(stdin) : ''); }
        catch (e) {
          if (e instanceof ExitSignal) res = { out: '', err: '', code: e.code };
          else if (e instanceof BashError) res = { out: '', err: `bash: ${e.message}\n`, code: 2 };
          else throw e;
        }
        return { stdout: res.out, stderr: res.err, code: res.code, cwd: sh.cwd, truncated: sh.limits.truncated };
      },
    };
  }

  // ── in-memory fs (tests, and fallback when no harness VFS) ──────
  function createMemFs(init = {}) {
    const root = { type: 'dir', children: {} };
    const resolve = (p) => {
      if (p === '/') return root;
      let n = root;
      for (const seg of p.slice(1).split('/')) {
        if (!n || n.type !== 'dir') return null;
        n = n.children[seg];
      }
      return n || null;
    };
    const fs = {
      node(p) {
        const n = resolve(p);
        if (!n) return null;
        if (n.type === 'dir') return { type: 'dir' };
        return { type: 'file', binary: !!n.binary, size: (n.content || '').length };
      },
      read(p) {
        const n = resolve(p);
        return n && n.type === 'file' && !n.binary ? (n.content ?? '') : null;
      },
      write(p, content) {
        const parts = p.slice(1).split('/');
        const name = parts.pop();
        let n = root;
        for (const seg of parts) {
          if (!n.children[seg]) n.children[seg] = { type: 'dir', children: {} };
          n = n.children[seg];
          if (n.type !== 'dir') throw new Error(`${seg} is not a directory`);
        }
        n.children[name] = { type: 'file', content };
      },
      list(p) {
        const n = resolve(p);
        if (!n || n.type !== 'dir') return null;
        return Object.entries(n.children)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, ch]) => ({ name, type: ch.type }));
      },
      mkdir(p) {
        let n = root;
        for (const seg of p === '/' ? [] : p.slice(1).split('/')) {
          if (!n.children[seg]) n.children[seg] = { type: 'dir', children: {} };
          n = n.children[seg];
          if (n.type !== 'dir') throw new Error(`${seg} is not a directory`);
        }
      },
      remove(p) {
        const parts = p.slice(1).split('/');
        const name = parts.pop();
        const parent = resolve('/' + parts.join('/'));
        if (!parent || parent.type !== 'dir' || !parent.children[name]) return false;
        delete parent.children[name];
        return true;
      },
    };
    for (const [p, content] of Object.entries(init)) fs.write(norm(p, '/'), content);
    return fs;
  }

  const api = { createShell, createMemFs, tokenize, parse, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined') return; // node (tests) stops here

  // ── browser wiring: harness VFS adapter + in-page MCP server ─────
  function harnessFs() {
    const has = typeof vfsResolve === 'function';
    return {
      node(p) {
        if (!has) return null;
        const n = vfsResolve(p);
        if (!n) return null;
        if (n.type === 'dir') return { type: 'dir' };
        return { type: 'file', binary: !!n.binary, size: n.binary ? (n.size || 0) : (n.content || '').length };
      },
      read(p) {
        const n = has && vfsResolve(p);
        return n && n.type === 'file' && !n.binary ? (n.content ?? '') : null;
      },
      write(p, content) {
        const r = vfsWrite(p, content);
        if (r && r.error) throw new Error(r.error);
      },
      list(p) {
        const n = has && vfsResolve(p);
        if (!n || n.type !== 'dir') return null;
        return Object.entries(n.children || {})
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, ch]) => ({ name, type: ch.type }));
      },
      mkdir(p) { vfsMkdir(p); },
      remove(p) {
        const r = vfsDelete(p);
        return !(r && r.error);
      },
    };
  }

  let shell = null;
  const getShell = () => {
    if (!shell) shell = createShell(typeof vfsResolve === 'function' ? harnessFs() : createMemFs());
    return shell;
  };

  const TOOLS = [
    {
      name: 'bash_exec',
      description: 'Run a bash command entirely in the browser against the shared FILES workspace (the same VFS as Read/Write/Edit) — no server, no container. Supports pipes, && || ;, redirection (> >> < 2> 2>&1), quotes, variables, $(...) and `...` substitution, $((...)) arithmetic, globs, and core utilities: ls cat echo printf pwd cd head tail wc grep sed (incl. -i) sort uniq cut tr find mkdir rm cp mv touch basename dirname test [ seq xargs date tee which env export source sh. NOT supported: control flow (if/for/while), functions, background jobs, heredocs, network, real processes — use PythonExec for those. cwd and exported variables persist across calls. grep/sed patterns are JavaScript regexes.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the bash command line or multi-line script to run' },
          stdin: { type: 'string', description: 'text piped to the script\'s standard input' },
          cwd: { type: 'string', description: 'directory to run in (persists; defaults to the previous call\'s cwd)' },
          reset: { type: 'boolean', description: 'reset shell state (cwd and variables) before running' },
        },
        required: ['command'],
      },
    },
  ];

  const impl = {
    async bash_exec(args) {
      if (args.reset) shell = null;
      const s = getShell();
      if (args.cwd) {
        const abs = norm(args.cwd, '/');
        const node = s.state.fs.node(abs);
        if (!node || node.type !== 'dir') throw new Error(`cwd ${args.cwd}: No such directory`);
        s.state.cwd = abs;
      }
      const r = s.exec(String(args.command ?? ''), { stdin: args.stdin });
      const out = { stdout: r.stdout, stderr: r.stderr, exit_code: r.code, cwd: r.cwd };
      if (r.truncated) out.truncated = true;
      return out;
    },
  };

  const CreelBash = {
    async handle(body) {
      const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
      const fail = (message) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      try {
        switch (body.method) {
          case 'initialize':
            return reply({
              protocolVersion: body.params?.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'bash', version: '0' },
            });
          case 'notifications/initialized':
            return null;
          case 'tools/list':
            return reply({ tools: TOOLS });
          case 'tools/call': {
            const { name, arguments: args } = body.params || {};
            if (!impl[name]) return fail(`unknown tool: ${name}`);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await impl[name](args || {})) }] });
          }
          default:
            return fail(`method not supported in-page: ${body.method}`);
        }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },

    registerDefaults() {
      window.CreelInpage.register('inpage:bash', this);
      if (typeof mcpServers !== 'undefined' && !mcpServers.find((s) => s.id === 'mcp_bash_inpage')) {
        mcpServers.push({
          id: 'mcp_bash_inpage', name: 'bash', type: 'inpage',
          url: 'inpage:bash', token: '', corsProxy: '', enabled: true,
        });
        if (typeof saveMcpServers === 'function') saveMcpServers();
      }
      const server = (typeof mcpServers !== 'undefined')
        && mcpServers.find((s) => s.id === 'mcp_bash_inpage');
      if (server && typeof mcpConnectServer === 'function') {
        mcpConnectServer(server).catch((e) => console.warn('bash in-page MCP connect failed', e));
      }
      if (typeof renderMcpServerList === 'function') renderMcpServerList();
    },
  };

  window.CreelBash = Object.assign(CreelBash, api);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CreelBash.registerDefaults());
  } else {
    CreelBash.registerDefaults();
  }
})();
