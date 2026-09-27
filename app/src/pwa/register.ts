import { registerSW } from 'virtual:pwa-register';

export interface RegisterOptions {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}

/**
 * Registers the hand-written service worker (`src/pwa/sw.ts`).
 *
 * With `injectManifest` the precache list is injected at build time, so the app
 * shell is available before the first request in offline mode. Returns a
 * disposer that unregisters the update polling.
 */
export function registerServiceWorker(options: RegisterOptions = {}): () => void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  return registerSW({
    immediate: true,
    onNeedRefresh: () => options.onNeedRefresh?.(),
    onOfflineReady: () => options.onOfflineReady?.(),
    onRegisteredSW: (_scriptUrl, registration) => {
      if (!registration) return;
      // Poll hourly so a long-lived tab still notices a new deployment.
      window.setInterval(() => void registration.update(), 60 * 60 * 1000);
    },
  });
}

/**
 * Asks the browser not to evict our IndexedDB under storage pressure. The
 * answer is a hint, not a guarantee, which is why the inspector shows it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const manager = globalThis.navigator?.storage;
  if (!manager?.persist) return false;

  try {
    return await manager.persist();
  } catch {
    return false;
  }
}
