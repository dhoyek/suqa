/* Storefront service worker (scope "/"). Deliberately small:
 *  - pages always come from the network (they hold live stock, prices and personal data) — when there is no
 *    connection, a friendly offline screen is shown instead of the browser's error;
 *  - versioned build files (/_next/static, /icons) are cached, so the app opens faster.
 * It never touches the POS caches (the POS has its own worker under /pos) and never caches API calls. */
const STATIC = 'suqa-store-static-v1';
const SHELL = 'suqa-store-shell-v1';
const KEEP = [STATIC, SHELL];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/offline.html'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('suqa-store-') && !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// keep the static cache small: old builds' files are dropped, oldest first
async function trim(c) {
  const keys = await c.keys();
  for (let i = 0; i < keys.length - 200; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/pos') || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html', { cacheName: SHELL })));
    return;
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.open(STATIC).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { await c.put(req, res.clone()); trim(c); }
      return res;
    }));
  }
});
