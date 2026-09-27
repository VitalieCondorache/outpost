/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
};

const BACKGROUND_SYNC_TAG = 'outpost-outbox';

cleanupOutdatedCaches();

// The precache list is injected at build time: the app shell (JS, CSS, icons)
// works on the very first offline load, before IndexedDB has been read.
precacheAndRoute(self.__WB_MANIFEST);

/**
 * The API is never cached.
 *
 * A cached `GET /api/notes` response would silently violate the revision
 * contract the sync engine relies on, so those requests either hit the network
 * or fail — and the client keeps working from its own outbox.
 */
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

/** SPA navigations are served from the precached shell. */
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }),
);

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

/**
 * Background Sync (Chromium) fires even when the tab was closed and the browser
 * relaunched it. The service worker cannot drain the outbox itself — the engine
 * and IndexedDB transactions live in the page — so it wakes every client and
 * lets the app do the work.
 */
const backgroundSyncScope = self as unknown as {
  addEventListener(
    type: 'sync',
    listener: (event: ExtendableEvent & { tag?: string }) => void,
  ): void;
};

backgroundSyncScope.addEventListener('sync', (event) => {
  if (event.tag !== BACKGROUND_SYNC_TAG) return;

  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'outpost:sync-now' });
    }),
  );
});
