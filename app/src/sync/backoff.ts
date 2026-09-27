export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 30_000;

/**
 * Exponential backoff with full-ish jitter (50–100% of the exponential value).
 *
 * The jitter matters when several tabs or devices reconnect at the same moment
 * after a network outage: without it they would all hit the API in lockstep.
 *
 * `attempt` is 1-based: attempt 1 waits up to 1s, attempt 6 caps out at 30s.
 */
export function nextRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const steps = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(BASE_DELAY_MS * 2 ** (steps - 1), MAX_DELAY_MS);
  const jitter = 0.5 + random() * 0.5;
  return Math.round(exponential * jitter);
}

/** Retry is pointless for requests the server already rejected on purpose. */
export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status !== 'number') return true;
  return status >= 500 || status === 408 || status === 429;
}
