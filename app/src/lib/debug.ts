/**
 * Opt-in verbose logging for the sync pipeline.
 *
 * Synchronisation bugs are invisible by nature — the UI looks fine while the
 * outbox quietly stops draining. Turn this on in the browser console when you
 * need the full mutation lifecycle:
 *
 *   localStorage.setItem('outpost:debug', '1'); location.reload();
 */
export function isDebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('outpost:debug') === '1';
  } catch {
    // Storage can be blocked (private mode, third-party context): stay silent.
    return false;
  }
}

export function debug(...args: unknown[]): void {
  if (isDebugEnabled()) console.debug('[outpost]', ...args);
}
