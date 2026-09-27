export const BACKGROUND_SYNC_TAG = 'outpost-outbox';

interface SyncCapableRegistration extends ServiceWorkerRegistration {
  sync?: { register(tag: string): Promise<void> };
}

/** Background Sync is Chromium-only; everywhere else the `online` event covers it. */
export function supportsBackgroundSync(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'SyncManager' in window;
}

/**
 * Asks the platform to wake the app up when connectivity returns — even if the
 * user closed the tab right after writing offline.
 */
export async function requestBackgroundSync(tag = BACKGROUND_SYNC_TAG): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;

  try {
    const registration = (await navigator.serviceWorker.ready) as SyncCapableRegistration;
    if (!registration.sync) return false;
    await registration.sync.register(tag);
    return true;
  } catch {
    return false;
  }
}

/** Listens for the service worker's wake-up call. Returns a disposer. */
export function onBackgroundSyncWakeup(handler: () => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data?.type === 'outpost:sync-now') handler();
  };

  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}
