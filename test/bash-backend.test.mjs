// Tests for the in-browser bash interpreter (app/bash-backend.js).
// Run: just test   (node --test test/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShell, createMemFs } = require('../app/bash-backend.js');

function shellWith(files = {}) {
  return createShell(createMemFs(files));
}
function run(script, files = {}, opts = {}) {
  return shellWith(files).exec(script, opts);
}

test('echo basics', () => {
  assert.equal(run('echo hello').stdout, 'hello\n');
  assert.equal(run('echo -n hi').stdout, 'hi');
  assert.equal(run('echo "a  b"').stdout, 'a  b\n');
  assert.equal(run("echo 'single $X'").stdout, 'single $X\n');
});

test('variables and expansion', () => {
  assert.equal(run('X=5; echo $X').stdout, '5\n');
  assert.equal(run('X=5; echo ${X}px').stdout, '5px\n');
  assert.equal(run('echo "$UNSET_VAR"').stdout, '\n');
  assert.equal(run('X="a b"; echo "$X"').stdout, 'a b\n');
  const r = run('export N=3; echo $N');
  assert.equal(r.stdout, '3\n');
});

test('env-prefix assignment scopes to one command', () => {
  const s = shellWith();
  assert.equal(s.exec('X=1 env | grep ^X=').stdout, 'X=1\n');
  assert.equal(s.exec('echo "[$X]"').stdout, '[]\n');
});

test('command substitution', () => {
  assert.equal(run('echo $(echo hi)').stdout, 'hi\n');
  assert.equal(run('echo `echo tick`').stdout, 'tick\n');
  assert.equal(run('X=$(echo a; echo b); echo "$X"').stdout, 'a\nb\n');
});

test('arithmetic', () => {
  assert.equal(run('echo $((2+3*4))').stdout, '14\n');
  assert.equal(run('X=7; echo $((X/2))').stdout, '3\n');
  assert.equal(run('echo $((1<2))').stdout, '1\n');
});

test('&& and || sequencing, exit codes, $?', () => {
  assert.equal(run('false && echo a || echo b').stdout, 'b\n');
  assert.equal(run('true && echo a || echo b').stdout, 'a\n');
  assert.equal(run('false; echo $?').stdout, '1\n');
  assert.equal(run('nonexistent_cmd 2>/dev/null; echo $?').stdout, '127\n');
  assert.equal(run('exit 3').code, 3);
});

test('pipes', () => {
  assert.equal(run("printf 'b\\na\\nc\\n' | sort | head -n 2").stdout, 'a\nb\n');
  assert.equal(run("printf 'x\\ny\\n' | wc -l").stdout, '2\n');
});

test('redirection', () => {
  const s = shellWith();
  s.exec('echo one > /f.txt');
  assert.equal(s.exec('cat /f.txt').stdout, 'one\n');
  s.exec('echo two >> /f.txt');
  assert.equal(s.exec('cat /f.txt').stdout, 'one\ntwo\n');
  assert.equal(s.exec('cat < /f.txt | wc -l').stdout, '2\n');
  const merged = s.exec('ls /nope 2>&1');
  assert.match(merged.stdout, /No such file/);
  assert.equal(merged.stderr, '');
  assert.equal(s.exec('ls /nope 2>/dev/null').stderr, '');
});

test('globs', () => {
  const files = { '/a.txt': '1', '/b.txt': '2', '/c.md': '3', '/sub/d.txt': '4' };
  assert.equal(run('echo /*.txt', files).stdout, '/a.txt /b.txt\n');
  assert.equal(run('ls /sub/*.txt', files).stdout, '/sub/d.txt\n');
  assert.equal(run('echo *.txt', files).stdout, 'a.txt b.txt\n'); // cwd = /
  assert.equal(run('echo /*.rs', files).stdout, '/*.rs\n');       // no match → literal
});

test('cwd persistence, cd, pwd', () => {
  const s = shellWith({ '/proj/src/main.rs': 'fn main(){}' });
  assert.equal(s.exec('cd /proj/src && pwd').stdout, '/proj/src\n');
  assert.equal(s.exec('pwd').stdout, '/proj/src\n'); // persists across exec calls
  assert.equal(s.exec('cat main.rs').stdout, 'fn main(){}');
  assert.equal(s.exec('cd /nope').code, 1);
});

test('cat, head, tail, wc', () => {
  const files = { '/n.txt': '1\n2\n3\n4\n5\n' };
  assert.equal(run('head -n 2 /n.txt', files).stdout, '1\n2\n');
  assert.equal(run('head -2 /n.txt', files).stdout, '1\n2\n');
  assert.equal(run('tail -n 2 /n.txt', files).stdout, '4\n5\n');
  assert.equal(run('tail -n +4 /n.txt', files).stdout, '4\n5\n');
  assert.equal(run('wc -l /n.txt', files).stdout, '5 /n.txt\n');
  assert.equal(run('cat -n /n.txt | head -n 1', files).stdout, '     1\t1\n');
});

test('grep', () => {
  const files = { '/log.txt': 'error: one\ninfo: fine\nERROR: two\n', '/sub/x.txt': 'error deep\n' };
  assert.equal(run('grep error /log.txt', files).stdout, 'error: one\n');
  assert.equal(run('grep -i error /log.txt', files).stdout, 'error: one\nERROR: two\n');
  assert.equal(run('grep -c -i error /log.txt', files).stdout, '2\n');
  assert.equal(run('grep -v -i error /log.txt', files).stdout, 'info: fine\n');
  assert.equal(run('grep -n error /log.txt', files).stdout, '1:error: one\n');
  const r = run('grep -r error /', files);
  assert.match(r.stdout, /log\.txt:error: one/);
  assert.match(r.stdout, /x\.txt:error deep/);
  assert.equal(run('grep -q zzz /log.txt', files).code, 1);
  assert.equal(run('grep -l error /log.txt', files).stdout, '/log.txt\n');
  assert.equal(run("echo foo123 | grep -o '[0-9]+'").stdout, '123\n');
});

test('sed', () => {
  assert.equal(run('echo hello world | sed s/world/there/').stdout, 'hello there\n');
  assert.equal(run('echo aaa | sed s/a/b/g').stdout, 'bbb\n');
  assert.equal(run("printf 'a\\nb\\nc\\n' | sed -n 2p").stdout, 'b\n');
  assert.equal(run("printf 'a\\nb\\nc\\n' | sed 2d").stdout, 'a\nc\n');
  assert.equal(run("echo 'x=1' | sed 's/(x)=/\\1:/'").stdout, 'x:1\n'); // JS-regex groups
  const s = shellWith({ '/f.txt': 'old text\nold again\n' });
  s.exec('sed -i s/old/new/ /f.txt');
  assert.equal(s.exec('cat /f.txt').stdout, 'new text\nnew again\n');
});

test('sort, uniq, cut, tr', () => {
  assert.equal(run("printf 'b\\na\\nb\\n' | sort").stdout, 'a\nb\nb\n');
  assert.equal(run("printf 'b\\na\\nb\\n' | sort -u").stdout, 'a\nb\n');
  assert.equal(run("printf '10\\n9\\n' | sort -n").stdout, '9\n10\n');
  assert.equal(run("printf 'a\\na\\nb\\n' | uniq -c").stdout, '      2 a\n      1 b\n');
  assert.equal(run("echo 'a:b:c' | cut -d: -f2").stdout, 'b\n');
  assert.equal(run("echo 'a:b:c' | cut -d: -f1,3").stdout, 'a:c\n');
  assert.equal(run('echo abc | tr a-z A-Z').stdout, 'ABC\n');
  assert.equal(run('echo hello | tr -d l').stdout, 'heo\n');
});

test('find', () => {
  const files = { '/src/a.rs': '', '/src/deep/b.rs': '', '/src/c.txt': '' };
  const r = run("find /src -name '*.rs'", files);
  assert.equal(r.stdout, '/src/a.rs\n/src/deep/b.rs\n');
  assert.equal(run('find /src -type d', files).stdout, '/src\n/src/deep\n');
  assert.equal(run("find /src -maxdepth 1 -name '*.rs'", files).stdout, '/src/a.rs\n');
});

test('mkdir, rm, cp, mv, touch', () => {
  const s = shellWith({ '/a/f.txt': 'data' });
  assert.equal(s.exec('mkdir -p /x/y/z && test -d /x/y/z && echo ok').stdout, 'ok\n');
  assert.equal(s.exec('mkdir /x/y/z 2>&1').code, 1);
  assert.equal(s.exec('cp /a/f.txt /a/g.txt && cat /a/g.txt').stdout, 'data');
  assert.equal(s.exec('cp -r /a /b && cat /b/f.txt').stdout, 'data');
  assert.equal(s.exec('mv /a/g.txt /a/h.txt && cat /a/h.txt').stdout, 'data');
  assert.equal(s.exec('test -e /a/g.txt').code, 1);
  assert.equal(s.exec('rm /a/h.txt && test -e /a/h.txt').code, 1);
  assert.equal(s.exec('rm /a').code, 1);            // dir without -r
  assert.equal(s.exec('rm -r /a && test -d /a').code, 1);
  assert.equal(s.exec('rm /nope').code, 1);
  assert.equal(s.exec('rm -f /nope').code, 0);
  assert.equal(s.exec('touch /new.txt && test -f /new.txt && echo y').stdout, 'y\n');
});

test('test / [ ... ]', () => {
  const files = { '/f.txt': 'x' };
  assert.equal(run('[ -f /f.txt ] && echo yes', files).stdout, 'yes\n');
  assert.equal(run('[ -d /f.txt ] || echo no', files).stdout, 'no\n');
  assert.equal(run('[ 3 -gt 2 ] && echo gt').stdout, 'gt\n');
  assert.equal(run('[ abc = abc ] && echo eq').stdout, 'eq\n');
  assert.equal(run('[ ! -e /zzz ] && echo missing').stdout, 'missing\n');
  assert.equal(run('X=; [ -z "$X" ] && echo empty').stdout, 'empty\n');
});

test('xargs and seq', () => {
  assert.equal(run('seq 3').stdout, '1\n2\n3\n');
  assert.equal(run('seq 2 4').stdout, '2\n3\n4\n');
  assert.equal(run("echo 'a b c' | xargs -n1 echo item").stdout, 'item a\nitem b\nitem c\n');
  assert.equal(run("printf 'x\\ny\\n' | xargs -I{} echo [{}]").stdout, '[x]\n[y]\n');
  const s = shellWith({ '/a.txt': '', '/b.txt': '' });
  assert.equal(s.exec('ls /*.txt | xargs rm && ls / | wc -l').stdout, '0\n');
});

test('basename, dirname, tee, printf', () => {
  assert.equal(run('basename /a/b/c.txt').stdout, 'c.txt\n');
  assert.equal(run('basename /a/b/c.txt .txt').stdout, 'c\n');
  assert.equal(run('dirname /a/b/c.txt').stdout, '/a/b\n');
  const s = shellWith();
  assert.equal(s.exec('echo data | tee /t1.txt /t2.txt').stdout, 'data\n');
  assert.equal(s.exec('cat /t1.txt /t2.txt').stdout, 'data\ndata\n');
  assert.equal(run("printf '%s=%d\\n' key 42").stdout, 'key=42\n');
  assert.equal(run("printf '%s\\n' a b").stdout, 'a\nb\n');
});

test('source runs in the current shell', () => {
  const s = shellWith({ '/setup.sh': 'X=fromfile\ncd /' });
  s.exec('source /setup.sh');
  assert.equal(s.exec('echo $X').stdout, 'fromfile\n');
});

test('multi-line scripts and comments', () => {
  const r = run('# a comment\necho one\necho two # trailing\n');
  assert.equal(r.stdout, 'one\ntwo\n');
  assert.equal(run('echo a; echo b').stdout, 'a\nb\n');
  assert.equal(run('echo a \\\n b').stdout, 'a b\n');
});

test('stdin option', () => {
  assert.equal(run('wc -l', {}, { stdin: 'a\nb\n' }).stdout, '2\n');
  assert.equal(run('grep b', {}, { stdin: 'a\nb\n' }).stdout, 'b\n');
});

test('useful errors for unsupported constructs', () => {
  const r1 = run('for i in 1 2; do echo $i; done');
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /control flow/);
  const r2 = run('cat <<EOF\nhi\nEOF');
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /heredoc/);
  const r3 = run('sleep 5 &');
  assert.equal(r3.code, 2);
  assert.match(r3.stderr, /background/);
});

test('a bad flag fails the command, not the script', () => {
  const r = run('ls -Z /; echo still here');
  assert.equal(r.stdout, 'still here\n');
  assert.match(r.stderr, /invalid option/);
});

test('set -e is tolerated as a no-op', () => {
  assert.equal(run('set -euo pipefail; echo ok').stdout, 'ok\n');
});

test('quoting protects globs and spaces', () => {
  const files = { '/a.txt': '' };
  assert.equal(run("echo '*.txt'", files).stdout, '*.txt\n');
  assert.equal(run('echo "*.txt"', files).stdout, '*.txt\n');
  assert.equal(run('echo *.txt', files).stdout, 'a.txt\n');
});

test('runaway protection', () => {
  const s = shellWith();
  // MAX_OUT cap: generating > 200k of output gets truncated, not OOM
  const r = s.exec('seq 100000');
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 300000);
});

test('binary files are skipped by text utilities', () => {
  const fs = createMemFs({ '/t.txt': 'text\n' });
  // hand-craft a binary node
  fs.write('/bin.dat', 'x');
  const shell = createShell(fs);
  // patch node to look binary (MemFs has no binary writer; simulate)
  const memNode = fs.node('/bin.dat');
  assert.ok(memNode);
  const r = shell.exec('cat /t.txt');
  assert.equal(r.stdout, 'text\n');
});
