/* A browser driver in 150 lines: CDP over Node's built-in WebSocket.
 *
 * creel's whole claim is that it needs no build step and no dependencies, so
 * its UI tests should not drag in a 300MB toolchain to prove it. Chromium is
 * already on this machine (Playwright's download), Node 22 ships a WebSocket
 * client, and the Chrome DevTools Protocol is a JSON-RPC socket. That is the
 * entire dependency list.
 *
 * This is not Playwright — no auto-waiting, no selector engine, no isolation
 * work. It does not need to be: creel ships its OWN locator engine
 * (app/creel-locator.js), which is precisely what these tests exist to
 * exercise. The driver's job is only to open real tabs at a real origin and
 * evaluate expressions in them. Everything Playwright-shaped happens inside
 * the page, where creel's agents live.
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  const dir = '/opt/pw-browsers';
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

/** Serve app/ over http, because creel's machinery (BroadcastChannel, Web
 *  Locks, sessionStorage, module-free scripts) needs a real origin — file://
 *  gives every tab a null origin and none of it works. */
function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  /** Evaluate a function in the page and return its (JSON-able) result.
   *  Async functions are awaited; a thrown error surfaces as a thrown error
   *  here, with the page's message. */
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const res = await this.browser.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    }, this.sessionId);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page error: ${d.exception?.description || d.text || 'unknown'}`);
    }
    return res.result.value;
  }

  /** Poll a predicate in the page until it is truthy. */
  async waitForFunction(fn, { timeout = 10000, message = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let ok = false;
      try { ok = await this.evaluate(fn); } catch { /* page still loading */ }
      if (ok) return true;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async close() {
    await this.browser.send('Target.closeTarget', { targetId: this.targetId });
  }
}

class Browser {
  constructor(proc, ws, fileServer, origin) {
    this.proc = proc;
    this.ws = ws;
    this.fileServer = fileServer;
    this.origin = origin;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${p.method})`));
      else p.resolve(msg.result);
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }
      }, 30000);
    });
  }

  /** Open a tab at a path under the served app root, and wait for it to be
   *  interactive. Returns a Page. */
  async newPage(pathAndHash = '/onepagent.html') {
    const url = `${this.origin}${pathAndHash}`;
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await this.send('Runtime.enable', {}, sessionId);
    await page.waitForFunction(() => document.readyState === 'complete', { message: 'document ready' });
    return page;
  }

  async close() {
    try { this.ws.close(); } catch { /* already gone */ }
    this.proc.kill();
    await new Promise((r) => this.fileServer.close(r));
  }

  static available() { return !!findChrome(); }

  static async launch({ root }) {
    const chrome = findChrome();
    if (!chrome) throw new Error('no Chromium found — set CHROME_PATH');
    const { server, port } = await serve(root);
    const userDataDir = fs.mkdtempSync('/tmp/creel-cdp-');
    const proc = spawn(chrome, [
      '--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', `--user-data-dir=${userDataDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // Chromium prints the devtools endpoint on stderr when the port is 0.
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`chromium did not report a devtools endpoint:\n${buf}`)), 25000);
      proc.stderr.on('data', (chunk) => {
        buf += chunk;
        const m = buf.match(/ws:\/\/[^\s]+/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chromium exited (${code}):\n${buf}`)); });
    });

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not connect to chromium'));
    });
    return new Browser(proc, ws, server, `http://127.0.0.1:${port}`);
  }
}

module.exports = { Browser, Page, findChrome };
