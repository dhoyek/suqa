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
serwist.addEventListeners();
