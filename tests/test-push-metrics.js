/* creel — test-push-metrics.js (aegis-q9lh3): the transport, end to end.
 * Zero dependencies. Run: node tests/test-push-metrics.js
 *
 * This test stands up a real HTTP server and pushes to it, because the only
 * honest test of a transport is a delivery. The fleet rule this follows was
 * measured the expensive way on the escalation path (aegis-8ixi): four
 * upstream checks all passed — env expansion, the credential file, the URL
 * shape, the backend answering 200 — and a real page would still have reached
 * nobody, because every one of those checks sits UPSTREAM of delivery. So the
 * assertions here are about what the server RECEIVED: the route, the auth
 * header, the body.
 *
 * What is worth reading if you change this file:
 *
 *   · THE EXIT LADDER. `2` (never wired up) must never be spelled `0`. From a
 *     dashboard, a component that was never configured looks exactly like a
 *     healthy quiet one, which is the whole failure class the parent epic
 *     exists to close.
 *   · THE CREDENTIAL CASE. It asserts the credential reaches the server as a
 *     header and appears NOWHERE in the pushed body.
 *   · THE LABEL-ENCODING CASE. A `/` in a job label would silently become
 *     another path segment — a different group rather than an error.
 */
'use strict';

const assert = require('assert');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');

const TOOL = path.join(__dirname, '..', 'tools', 'creel-push-metrics.js');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

function gateway() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || null,
        contentType: req.headers['content-type'] || null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (server.reject) { res.writeHead(401); res.end('unauthorized'); return; }
      res.writeHead(200); res.end('');
    });
  });
  server.received = received;
  return server;
}

const run = (args, env, stdin) => new Promise((resolve) => {
  const child = execFile(process.execPath, [TOOL, ...args],
    { env: Object.assign({}, process.env, env) },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  child.stdin.end(stdin === undefined ? '' : stdin);
});

const RECORD = JSON.stringify({
  contract: 'creel.doctor/1', code: 0,
  summary: { pass: 2, fail: 0, unknown: 0, required_fail: 0, required_unknown: 0 },
  checks: [{ id: 'quipu-wasm', status: 'pass', severity: 'required' }],
});

(async () => {
  const server = gateway();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://creel:s3cret-not-in-any-repo@127.0.0.1:${port}`;

  try {
    /* nothing configured is 2, and it says so — never 0 */
    {
      const r = await run([], { CREEL_METRICS_PUSHGATEWAY: '' }, RECORD);
      eq(r.code, 2, 'an unconfigured gateway exits 2, not 0');
      ok(/NOTHING WAS PUSHED/.test(r.stderr), 'and says nothing was pushed, in those words');
      eq(server.received.length, 0, 'and contacted nobody');
    }

    /* nothing to send is also 2 — an empty payload is not a successful push */
    {
      const r = await run([], { CREEL_METRICS_PUSHGATEWAY: url }, '');
      eq(r.code, 2, 'an empty payload exits 2 even with a gateway configured');
      eq(server.received.length, 0, 'and pushes nothing');
    }

    /* the delivery itself — asserted on what the SERVER received */
    {
      const r = await run(['--instance', 'tab-7'], { CREEL_METRICS_PUSHGATEWAY: url }, RECORD);
      eq(r.code, 0, `a delivered push exits 0 (stderr: ${r.stderr})`);
      eq(server.received.length, 1, 'exactly one request reached the gateway');
      const got = server.received[0];
      eq(got.method, 'PUT', 'the pushgateway replace verb');
      eq(got.url, '/metrics/job/creel/instance/tab-7', 'the grouping key is in the route');
      eq(got.contentType, 'text/plain', 'exposition is text/plain');
      ok(got.body.includes('creel_doctor_code 0'), 'the rendered payload arrived');
      ok(/pushed \d+ samples/.test(r.stderr), 'and the tool reports what it sent');

      const cred = Buffer.from('creel:s3cret-not-in-any-repo').toString('base64');
      eq(got.auth, `Basic ${cred}`, 'the credential travels as a header');
      ok(!got.body.includes('s3cret-not-in-any-repo'), 'and never inside the body');
    }

    /* a label containing a slash must be encoded, not silently regrouped */
    {
      server.received.length = 0;
      await run(['--job', 'creel/prod'], { CREEL_METRICS_PUSHGATEWAY: url }, RECORD);
      eq(server.received[0].url, '/metrics/job/creel%2Fprod',
        'a slash in a label is encoded — otherwise it becomes a different group with no error');
    }

    /* a gateway that answers and rejects is 1, distinct from 3 */
    {
      server.received.length = 0;
      server.reject = true;
      const r = await run([], { CREEL_METRICS_PUSHGATEWAY: url }, RECORD);
      eq(r.code, 1, 'a 401 from the gateway is REFUSED (1), not a tool error (3)');
      ok(/REFUSED \(HTTP 401\)/.test(r.stderr), 'and the status is named');
      server.reject = false;
    }

    /* no route to the gateway is 3 — fix the run, not the subject */
    {
      const r = await run([], { CREEL_METRICS_PUSHGATEWAY: 'http://127.0.0.1:1' }, RECORD);
      eq(r.code, 3, 'an unreachable gateway is a tool error (3), never a quiet 0 or a 2');
      ok(/could not reach the gateway/.test(r.stderr), 'and says so');
    }

    /* --print renders without pushing at all */
    {
      server.received.length = 0;
      const r = await run(['--print'], { CREEL_METRICS_PUSHGATEWAY: url }, RECORD);
      eq(r.code, 0, '--print exits 0 when it rendered something');
      ok(r.stdout.includes('creel_doctor_code 0'), 'and prints the exposition');
      eq(server.received.length, 0, 'and contacts the gateway not at all');
    }

    /* pre-rendered exposition passes through untouched */
    {
      server.received.length = 0;
      const text = '# HELP creel_x t\n# TYPE creel_x gauge\ncreel_x 5\n';
      await run([], { CREEL_METRICS_PUSHGATEWAY: url }, text);
      eq(server.received[0].body, text, 'exposition text on stdin is pushed verbatim');
    }

    console.log(`ok — test-push-metrics.js: ${checks} checks passed`);
  } finally {
    server.close();
  }
})();
