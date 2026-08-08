// Service worker — the offline app shell. Tier 1: READ your day with no
// network. There is no write queue here (see below).
//
// Lives in static/ but is served from /sw.js (app.py): a worker's scope is its
// own path, so one served from /static/ could only ever control /static/*.
//
// NETWORK-FIRST for everything of ours, on purpose. app.py's after_request
// hook sends Cache-Control: no-cache on / and /static/* because a stale app.js
// is fresh code that is silently invisible — exactly the bug a cache-first
// worker would reintroduce. And it would hit the desktop too: in local mode
// the windows load http://localhost:5000, which IS a secure context, so
// pywebview registers this worker as well. So these caches are ONLY ever a
// fallback for a fetch that failed. (Cache Storage ignores HTTP caching
// semantics, which is why no-cache doesn't stop the shell being stored.)
//
// Fonts are the one exception — immutable, versioned URLs, cache-first — and
// caching them is what keeps the typography from dropping to system sans the
// moment you go offline.
//
// Mutations are deliberately NOT touched: only GETs pass through here, so a
// write with no network fails loudly instead of looking accepted. An outbox
// for the narrow append-only write class (capture, complete, the exits,
// routine ticks, marks) is tier 2 and is not in this file.

const VERSION = 'v1';
const SHELL = 'pt-shell-' + VERSION;
const API = 'pt-api-' + VERSION;
const FONTS = 'pt-fonts-' + VERSION;
const KEEP = [SHELL, API, FONTS];

// The two documents plus everything they need to paint. Fonts are cross-origin
// with generated names, so they are picked up at runtime instead.
const SHELL_URLS = [
  '/',
  '/panel',
  '/static/style.css',
  '/static/app.js',
  '/static/panel.js',
  '/manifest.webmanifest',
  '/static/icon-192.png',
  '/static/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One at a time and swallowing failures: a single 404 in that list must not
    // fail the whole install and leave the app with no worker at all.
    await Promise.all(SHELL_URLS.map(
      url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith('pt-') && !KEEP.includes(n))
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;  // mutations stay untouched, by design
  const url = new URL(req.url);

  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL, true));
    return;
  }
  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(networkFirst(req, SHELL, false));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, API, false));
  }
});

async function networkFirst(req, cacheName, isNav) {
  try {
    const res = await fetch(req);
    // Only keep real successes. A 500 page cached as the shell is worse than
    // having no cache at all.
    if (res && res.ok && res.type !== 'opaque') {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    // ignoreSearch for navigations only: /?x= is still the shell, but
    // /api/overrides?date=… absolutely is not interchangeable.
    const hit = await caches.match(req, { ignoreSearch: isNav })
      || (isNav ? await caches.match('/') : null);
    if (hit) {
      // Only data fallbacks announce. The navigation is served before the page
      // exists to hear it, and announcing there just burns the throttle that
      // the API fallbacks — which DO have a listener attached — need.
      if (!isNav) announceStale();
      return hit;
    }
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Opaque (status 0) is the normal shape for a no-cors font request, so it
  // can't be filtered on res.ok — it still replays correctly from the cache.
  if (res && (res.ok || res.type === 'opaque')) {
    const cache = await caches.open(cacheName);
    cache.put(req, res.clone());
  }
  return res;
}

// Tell the page it is looking at the last good fetch rather than today's
// truth. Rate-limited because loadAll() fires ~15 requests at once and every
// one of them would otherwise shout.
let lastAnnounce = 0;

async function announceStale() {
  const now = Date.now();
  if (now - lastAnnounce < 3000) return;
  lastAnnounce = now;
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'pt-stale' }));
}
