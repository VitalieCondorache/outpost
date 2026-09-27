import { describe, expect, it } from 'vitest';
import { BASE_DELAY_MS, MAX_DELAY_MS, isRetryable, nextRetryDelayMs } from './backoff';

describe('nextRetryDelayMs', () => {
  const noJitter = () => 1;

  it('starts at the base delay for the first failure', () => {
    expect(nextRetryDelayMs(1, noJitter)).toBe(BASE_DELAY_MS);
  });

  it('doubles the delay on every consecutive failure', () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => nextRetryDelayMs(attempt, noJitter));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('caps the delay at the ceiling', () => {
    expect(nextRetryDelayMs(12, noJitter)).toBe(MAX_DELAY_MS);
  });

  it('applies jitter between 50% and 100% of the exponential value', () => {
    expect(nextRetryDelayMs(3, () => 0)).toBe(2_000);
    expect(nextRetryDelayMs(3, () => 0.5)).toBe(3_000);
    expect(nextRetryDelayMs(3, noJitter)).toBe(4_000);
  });

  it('treats nonsense attempts as the first one', () => {
    expect(nextRetryDelayMs(0, noJitter)).toBe(BASE_DELAY_MS);
    expect(nextRetryDelayMs(-5, noJitter)).toBe(BASE_DELAY_MS);
  });
});

describe('isRetryable', () => {
  it('retries transport errors', () => {
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
  });

  it('retries server faults and rate limits', () => {
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 408 })).toBe(true);
  });

  it('gives up on client errors', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
  });
});
