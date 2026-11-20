/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import { Serwist, type PrecacheEntry, type SerwistGlobalConfig } from 'serwist';

// POS service worker (scope /pos). Precaches the app shell + static assets; pages are network-first with cache fallback,
// so the POS opens with no internet. New versions install in the background and are activated only when the app says so
// (no open sale) — see PosApp's update banner, which posts SKIP_WAITING.
declare global { interface WorkerGlobalScope extends SerwistGlobalConfig { __SW_MANIFEST: (PrecacheEntry | string)[] | undefined } }
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: defaultCache,
  fallbacks: { entries: [{ url: '/pos', matcher: ({ request }) => request.destination === 'document' }] },
});
self.addEventListener('message', e => { if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting(); });
// 🔔 new order (85_push_notifications): show it even when the POS is closed; tapping it opens (or brings forward) the POS on Talabat.
self.addEventListener('push', e => {
  let d: { title?: string; body?: string; url?: string; tag?: string } = {};
  try { d = e.data?.json() ?? {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Suqa', {
    body: d.body ?? '', tag: d.tag, data: { url: d.url || '/pos#orders' }, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    requireInteraction: true, renotify: !!d.tag, vibrate: [200, 100, 200],
  } as NotificationOptions));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data as { url?: string } | null)?.url || '/pos#orders', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const pos = wins.find(w => new URL(w.url).pathname.startsWith('/pos'));
    if (pos) { await pos.focus(); try { await (pos as WindowClient).navigate(url); } catch { /* same page: the hash is enough */ } return; }
    await self.clients.openWindow(url);
  })());
});
serwist.addEventListeners();
