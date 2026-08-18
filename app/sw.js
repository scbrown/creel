/* OnePagent service worker
 * Strategy:
 *   - HTML navigations: network-first (fall back to cached shell when offline).
 *   - Explicit app-shell assets: stale-while-revalidate.
 *   - Explicit CDN assets: cache-first (opaque responses ok).
 *   - Anything else (APIs, auth, no-store, POST): pass through untouched.
 * Bump CACHE_VERSION whenever the app shell changes to evict old caches.
 */
const CACHE_VERSION = 'creel-v24';
const CACHE_NAME = `onepagent-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './thread.html',
  './onepagent.html',
  './logo.svg',
  './manifest.webmanifest',
  './icons/favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/icon-180.png',
  './quipu-backend.js',
  './github-backend.js',
  './local-backend.js',
  './quipu-explorer.js',
  './creel-fleet.js',
  './creel-fleet-log.js',
  './creel-fleet-tools.js',
  './creel-fleet-dashboard.js',
  './creel-self.js',
  './browser-backend.js',
  './measurement-backend.js',
  './reconnect.js',
  './quipu-worker.js',
  './quipu-store-core.js',
  './wasm/pkg/creel_quipu_provider.js',
  './wasm/pkg/creel_quipu_provider_bg.wasm',
  './vendor/quipu-ui/quipu-components.js',
  './vendor/quipu-ui/graph-canvas.js',
  './vendor/marked.min.js',
  './vendor/highlight.min.js',
  './vendor/github.min.css',
  './vendor/github-dark.min.css',
  './harness.css',
  './harness/01-i18n.js',
  './harness/02-config.js',
  './harness/03-sandbox-daytona.js',
  './harness/04-swarm.js',
  './harness/05-blob-store.js',
  './harness/06-conversation-store.js',
  './harness/07-skills.js',
  './harness/08-runtimes-node.js',
  './harness/09-tools-remote.js',
  './harness/10-skills-import.js',
  './harness/11-mcp-servers.js',
  './harness/12-provider-ui.js',
  './harness/13-sync-core.js',
  './harness/14-sync-push-pull.js',
  './harness/15-memory-store.js',
  './harness/16-hooks-cron.js',
  './harness/17-swarm-role-editor.js',
  './harness/18-tool-impl.js',
  './harness/19-role-manager.js',
  './harness/20-file-explorer.js',
  './harness/21-html-preview.js',
  './harness/22-memory-ui.js',
  './harness/23-sse-parsers.js',
  './harness/24-chat-ui.js',
  './harness/25-input.js',
  './harness/26-layout.js',
  './creel-features.js',
  './state-backend.js',
  './beads-store.js',
  './beads-backend.js',
  './creel-device.js',
  './creel-locator.js',
  './creel-ui-tools.js',
  './creel-world-model.js',
];

const CDN_PREFETCH = [];
const NETWORK_FIRST = [
  './quipu-backend.js',
  './github-backend.js',
  './local-backend.js',
  './quipu-explorer.js',
  './creel-fleet.js',
  './creel-fleet-log.js',
  './creel-fleet-tools.js',
  './creel-fleet-dashboard.js',
  './creel-self.js',
  './browser-backend.js',
  './measurement-backend.js',
  './reconnect.js',
  './quipu-worker.js',
  './quipu-store-core.js',
  './wasm/pkg/creel_quipu_provider.js',
  './harness/01-i18n.js',
  './harness/02-config.js',
  './harness/03-sandbox-daytona.js',
  './harness/04-swarm.js',
  './harness/05-blob-store.js',
  './harness/06-conversation-store.js',
  './harness/07-skills.js',
  './harness/08-runtimes-node.js',
  './harness/09-tools-remote.js',
  './harness/10-skills-import.js',
  './harness/11-mcp-servers.js',
  './harness/12-provider-ui.js',
  './harness/13-sync-core.js',
  './harness/14-sync-push-pull.js',
  './harness/15-memory-store.js',
  './harness/16-hooks-cron.js',
  './harness/17-swarm-role-editor.js',
  './harness/18-tool-impl.js',
  './harness/19-role-manager.js',
  './harness/20-file-explorer.js',
  './harness/21-html-preview.js',
  './harness/22-memory-ui.js',
  './harness/23-sse-parsers.js',
  './harness/24-chat-ui.js',
  './harness/25-input.js',
  './harness/26-layout.js',
  './creel-features.js',
  './state-backend.js',
  './beads-store.js',
  './beads-backend.js',
  './creel-device.js',
  './creel-locator.js',
  './creel-ui-tools.js',
  './creel-world-model.js',
];
const NETWORK_FIRST_URLS = new Set(NETWORK_FIRST.map((p) => new URL(p, self.location.href).href));
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));
const CDN_URLS = new Set(CDN_PREFETCH);

self.addEventListener('install', (event) => {
  // FIRST, and before any await: a worker that cannot take over is worse than
  // one with an incomplete cache. This used to sit at the end of the async
  // block below, after `cache.addAll(APP_SHELL)` — and addAll is atomic, so a
  // single 404, a flaky CDN response, or a timeout on the 3.3MB wasm rejected
  // the whole call, failed the install, and left the PREVIOUS worker serving
  // its old cache indefinitely. Reloading did not help: a reload does not
  // evict a controlling worker. The site deployed correctly and the browser
  // kept showing the old one.
  self.skipWaiting();

  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Per entry, not addAll. Precaching is an offline optimisation, not a
    // correctness requirement — everything here is also reachable over the
    // network by the fetch handlers below. So one asset that cannot be
    // fetched costs exactly that asset, not the entire update.
    const failed = [];
    await Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => failed.push(url))));
    if (failed.length) {
      // Say so. The old behaviour's worst property was silence: an install
      // that failed looked exactly like a browser that had not updated yet.
      console.warn(`[sw ${CACHE_VERSION}] activated with ${failed.length} of `
        + `${APP_SHELL.length} shell assets uncached (they will be fetched from the `
        + `network as needed):`, failed);
    }
    await Promise.all(CDN_PREFETCH.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'no-cors', cache: 'no-cache' });
        await cache.put(url, res);
      } catch (_) { /* offline at install — will populate later via runtime cache */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => k !== CACHE_NAME && k.startsWith('onepagent-') ? caches.delete(k) : null));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  // Let the page ask what it is running, so an update notice can name a
  // version rather than asserting one vaguely exists.
  if (event.data === 'VERSION') event.source?.postMessage({ type: 'sw-version', version: CACHE_VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (req.cache === 'no-store' || req.headers.has('authorization') || req.headers.has('x-api-key')) return;

  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirstHTML(event));
    return;
  }

  if (NETWORK_FIRST_URLS.has(url.href)) {
    event.respondWith(networkFirstAsset(req));
    return;
  }

  if (APP_SHELL_URLS.has(url.href)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (CDN_URLS.has(url.href)) event.respondWith(cacheFirst(req));
});

async function networkFirstHTML(event) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || await fetch(event.request);
    if (res && res.ok && res.type !== 'opaque') {
      cache.put(event.request, res.clone()).catch(() => {});
    }
    return res;
  } catch (_) {
    const cached = await cache.match(event.request)
      || await cache.match('./thread.html')
      || await cache.match('./index.html');
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirstAsset(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (_) {
    const cached = await cache.match(req);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('Offline', { status: 503 });
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (_) {
    return new Response('Offline', { status: 503 });
  }
}
