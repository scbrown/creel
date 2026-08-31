#!/usr/bin/env node
/* creel — tools/creel-push-metrics.js: the transport for a producer that
 * cannot be scraped.
 *
 * Requested on aegis-q9lh3 (child of the stack-metrics epic aegis-wou8k).
 * `app/creel-metrics.js` produces exposition text and deliberately stops there;
 * this is the other half.
 *
 * ── WHY A PUSH AND NOT A LISTENER ───────────────────────────────────────────
 *
 * creel is a static page. It has no address a Prometheus job could target, and
 * giving it one would delete `server-none`. A creel tab is the same SHAPE of
 * producer as a Shantytown agent — ephemeral, no listener — and Shantytown
 * already answered this by pushing (`ST_STATS_PUSHGATEWAY`, job `st_stats`).
 * This tool is the same mechanism with creel's payload, deliberately down to
 * the env-var name and the userinfo-carries-the-credential shape, so an
 * operator who knows one knows the other.
 *
 * ── THE CREDENTIAL IS NEVER IN THE REPO, THE BUNDLE, OR THIS FILE ───────────
 *
 * It arrives inside the configured URL at RUN time
 * (`http://user:pass@host:port`) and is used for one `Authorization: Basic`
 * header. That is why the transport lives out here rather than in the page: a
 * browser tab must hold no credential, which is the third tax creel exists to
 * delete. The two real callers are an operator (or a local sidecar) running
 * this, and — once it exists — the extension service worker, which has its own
 * storage the page cannot read.
 *
 * Nothing configured means nothing sent, and it EXITS 2 rather than 0. st spells
 * this "nothing set, nothing sent"; the difference here is that a gate must be
 * able to tell "I pushed" from "I was never wired up", because the second one
 * looks exactly like a healthy quiet component from the dashboard end — which
 * is the failure this epic exists to close.
 *
 * ── EXIT CODES (the same ladder as creel-doctor and creel-admission) ────────
 *
 *   0  pushed    the gateway accepted the payload (2xx)
 *   1  refused   the gateway answered and rejected it — auth, or a malformed body
 *   2  unset     no gateway configured, or nothing to send. NOTHING WAS PUSHED.
 *   3  error     this tool could not run: bad flags, unreadable input, no route
 *                to the gateway. Never confuse with 2 — 3 means fix the run.
 *
 * Usage:
 *   CREEL_METRICS_PUSHGATEWAY=http://[user:pass@]host[:port] \
 *     node tools/creel-push-metrics.js --record <file> [--evidence <file>]
 *   cat exposition.txt | node tools/creel-push-metrics.js
 *   node tools/creel-push-metrics.js --text <file> [--job creel] [--instance <id>]
 *   node tools/creel-push-metrics.js --print        # render only, push nothing
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const M = require(path.join(__dirname, '..', 'app', 'creel-metrics.js'));

const PUSHED = 0, REFUSED = 1, UNSET = 2, ERROR = 3;
const ENV = 'CREEL_METRICS_PUSHGATEWAY';

function die(msg) {
  process.stderr.write(`creel-push-metrics: ${msg}\n`);
  process.exit(ERROR);
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { die(`cannot read ${p}: ${e.message}`); return ''; }
}

function parseJson(text, what) {
  try { return JSON.parse(text); }
  catch (e) { die(`${what} is not JSON: ${e.message}`); return null; }
}

function parseArgs(argv) {
  const o = { job: 'creel', print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--record': o.record = next(); break;
      case '--evidence': o.evidence = next(); break;
      case '--text': o.text = next(); break;
      case '--job': o.job = next(); break;
      case '--instance': o.instance = next(); break;
      case '--print': o.print = true; break;
      case '--help': case '-h':
        process.stdout.write(`${__filename}\n\n  --record <f>    doctor record JSON\n`
          + '  --evidence <f>  the evidence that record was evaluated from\n'
          + '  --text <f>      pre-rendered exposition text (or pipe it on stdin)\n'
          + `  --job <name>    pushgateway job label (default: creel)\n`
          + '  --instance <id> pushgateway instance label\n'
          + '  --print         render and print; push nothing\n\n'
          + `env ${ENV}=http://[user:pass@]host[:port]\n`
          + 'exit: 0 pushed · 1 refused by the gateway · 2 nothing configured/nothing to send · 3 tool error\n');
        process.exit(0);
        break;
      default:
        if (a.startsWith('-')) die(`unknown flag: ${a}`);
        die(`unexpected argument: ${a}`);
    }
  }
  return o;
}

/** Exposition text from whichever input was given. Never invents content. */
function render(o, stdin) {
  if (o.text) return readFile(o.text);
  if (o.record) {
    const record = parseJson(readFile(o.record), '--record');
    const extra = o.evidence ? { evidence: parseJson(readFile(o.evidence), '--evidence') } : {};
    return M.render(record, extra);
  }
  if (stdin && stdin.trim()) {
    /* A JSON object on stdin is a record; anything else is already exposition.
     * Guessing is acceptable here only because the two are unmistakable. */
    const t = stdin.trimStart();
    if (t.startsWith('{')) return M.render(parseJson(stdin, 'stdin'), {});
    return stdin;
  }
  return '';
}

function push(url, job, instance, body) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { die(`${ENV} is not a URL: ${url}`); return; }

    const headers = { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) };
    if (parsed.username) {
      const cred = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}`;
      headers.Authorization = `Basic ${Buffer.from(cred).toString('base64')}`;
    }

    /* The pushgateway's grouping key is path segments, and a label with a `/`
     * in it would silently become another segment — a different group rather
     * than an error. Encode both. */
    const seg = (v) => encodeURIComponent(String(v));
    let route = `${parsed.pathname.replace(/\/+$/, '')}/metrics/job/${seg(job)}`;
    if (instance) route += `/instance/${seg(instance)}`;

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: route,
      method: 'PUT',
      headers,
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('timed out after 5s')); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(body);
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const stdin = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
  const body = render(o, stdin);

  if (o.print) { process.stdout.write(body); return body ? PUSHED : UNSET; }

  if (!body.trim()) {
    process.stderr.write('creel-push-metrics: nothing to send — NOTHING WAS PUSHED\n');
    return UNSET;
  }

  const url = (process.env[ENV] || '').trim();
  if (!url) {
    process.stderr.write(`creel-push-metrics: ${ENV} is unset — NOTHING WAS PUSHED\n`);
    return UNSET;
  }

  const r = await push(url, o.job, o.instance, body);
  if (r.error) die(`could not reach the gateway: ${r.error}`);
  if (r.status >= 200 && r.status < 300) {
    /* Say what landed and where, because "accepted by the gateway" is the only
     * thing an exit code can honestly claim — whether anyone SCRAPES the
     * gateway is a separate fact this tool cannot see. */
    const samples = body.split('\n').filter((l) => l && !l.startsWith('#')).length;
    process.stderr.write(`creel-push-metrics: pushed ${samples} samples to job=${o.job}`
      + `${o.instance ? ` instance=${o.instance}` : ''} (HTTP ${r.status})\n`);
    return PUSHED;
  }
  process.stderr.write(`creel-push-metrics: gateway REFUSED (HTTP ${r.status}) `
    + `${r.body.trim().split('\n')[0] || ''}\n`);
  return REFUSED;
}

main().then((code) => process.exit(code)).catch((e) => die(e && e.message ? e.message : String(e)));
