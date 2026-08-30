#!/usr/bin/env node
/* creel — tools/creel-doctor.js: the shell boundary for the creel preflight.
 *
 * Requested on aegis-edp2n.4 by CABOODLE: a stable, versioned, machine-readable
 * doctor result usable as the Creel preflight/verify boundary, with durable
 * check ids, pass/fail/unknown, required-vs-advisory severity, redacted
 * evidence, remediation text, and an aggregate that is nonzero for a required
 * failure or a required unknown.
 *
 * ── WHAT THIS CAN AND CANNOT SEE, STATED UP FRONT ───────────────────────────
 *
 * Every interesting thing the doctor checks is a BROWSER fact: secure context,
 * OPFS durability, a service worker's version, a popup blocker's decision, a
 * Web Lock that has vanished. None of them can be observed from node, and this
 * tool does not pretend otherwise — it EVALUATES evidence a tab exported. That
 * is the same shape as tools/creel-admission.js, which likewise judges evidence
 * it is given rather than talking to a provider.
 *
 * So a run with no evidence exits 2 (a required check is unknown), never 0.
 * "I could not look" must not be spelled the same way as "I looked and it was
 * fine", which is the one thing a preflight must never get wrong.
 *
 * Get evidence out of a tab with:
 *     await CreelDoctor.collect(...)        → paste/save as JSON
 * or export a whole record with:
 *     CreelDoctor.evaluate(await CreelDoctor.collect(...))
 *
 * Both are accepted here; a full record is re-evaluated from its own evidence
 * only if evidence is present, otherwise it is reported as given.
 *
 * ── EXIT CODES (the same ladder as creel-admission) ─────────────────────────
 *
 *   0  ok       every required check passes
 *   1  failed   a REQUIRED check FAILED — a diagnosed problem, fix the subject
 *   2  unknown  a REQUIRED check is UNKNOWN — a blind instrument, fix the LOOK
 *   3  error    this tool could not run: bad flags, unreadable or unparseable
 *               input. Never confuse with 2 — 3 means fix the invocation.
 *
 * Usage:
 *   node tools/creel-doctor.js --evidence <file>   [--json] [--quiet]
 *   node tools/creel-doctor.js --record   <file>   [--json] [--quiet]
 *   cat evidence.json | node tools/creel-doctor.js [--json]
 *
 * stdout is the JSON record ALONE when --json is given, so a caller can pipe it
 * without stripping a banner; the human block goes to stderr. Without --json the
 * human block goes to stdout.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const D = require(path.join(__dirname, '..', 'app', 'creel-doctor.js'));

const ERROR = 3;

function die(msg) {
  process.stderr.write(`creel-doctor: ${msg}\n`);
  process.exit(ERROR);
}

function parseArgs(argv) {
  const o = { json: false, quiet: false, evidence: null, record: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--evidence') o.evidence = argv[++i] || die('--evidence needs a file');
    else if (a === '--record') o.record = argv[++i] || die('--record needs a file');
    else if (a === '-h' || a === '--help') { process.stdout.write(usage()); process.exit(0); }
    else die(`unknown argument: ${a}`);
  }
  if (o.evidence && o.record) die('pass --evidence or --record, not both');
  return o;
}

function usage() {
  return 'usage: node tools/creel-doctor.js [--evidence f | --record f] [--json] [--quiet]\n'
    + '       reads stdin when neither file is given\n'
    + '  exit 0 ok · 1 required failure · 2 required unknown · 3 could not run\n';
}

function readInput(o) {
  const file = o.evidence || o.record;
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      die(`cannot read ${file}: ${e.message}`);
    }
  }
  try {
    /* An empty stdin is not an error — it is "no evidence", which the doctor
     * reports honestly as unknown rather than refusing to answer. */
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const raw = readInput(o).trim();

  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      die(`input is not JSON: ${e.message}`);
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die('input must be a JSON object (evidence, or a creel.doctor/1 record)');
  }

  /* A record carries `contract`; evidence does not. Re-evaluating a record from
   * its own evidence keeps ONE evaluator: a record produced by an older page and
   * a fresh collection are judged by the same code here, so a caller cannot get
   * two different verdicts for one world depending on which file they saved. */
  const isRecord = parsed.contract === D.CONTRACT;
  const record = isRecord && !parsed.evidence
    ? parsed
    : D.evaluate(isRecord ? parsed.evidence : parsed);

  if (o.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    if (!o.quiet) process.stderr.write(`${D.explain(record)}\n`);
  } else if (!o.quiet) {
    process.stdout.write(`${D.explain(record)}\n`);
  }

  const code = typeof record.code === 'number' ? record.code : ERROR;
  process.exit(code);
}

main();
