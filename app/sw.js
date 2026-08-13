/* OnePagent service worker
 * Strategy:
 *   - HTML navigations: network-first (fall back to cached shell when offline).
 *   - Explicit app-shell assets: stale-while-revalidate.
 *   - Explicit CDN assets: cache-first (opaque responses ok).
 *   - Anything else (APIs, auth, no-store, POST): pass through untouched.
 * Bump CACHE_VERSION whenever the app shell changes to evict old caches.
 */
const CACHE_VERSION = 'v3';
const CACHE_NAME = `onepagent-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './onepagent.html',
  './logo.svg',
  './manifest.webmanifest',
  './icons/favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/icon-180.png',
];

const CDN_PREFETCH = [
  'https://cdn.bootcdn.net/ajax/libs/marked/11.1.1/marked.min.js',
];
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));
const CDN_URLS = new Set(CDN_PREFETCH);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await Promise.all(CDN_PREFETCH.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'no-cors', cache: 'no-cache' });
        await cache.put(url, res);
      } catch (_) { /* offline at install — will populate later via runtime cache */ }
    }));
    self.skipWaiting();
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
      || await cache.match('./onepagent.html')
      || await cache.match('./index.html');
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
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
