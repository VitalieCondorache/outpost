import type { Outpost } from '../store/outpost';

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls until the condition holds — a loaded machine must not fake a failure. */
export async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(25);
  }
  throw new Error('the expected state never arrived');
}

/**
 * Drains the outbox, including the passes queued behind one.
 *
 * `syncNow()` awaits the pass that is in flight and only *marks* that one more is
 * wanted, so the pass it queues runs fire-and-forget: six awaited passes are not
 * the same as "nothing is running". The phase is the signal — it stays `syncing`
 * until the last pass closes. Without that final wait a loaded machine reached the
 * assertion below while a pass was still open, which is how a green suite turns
 * into `phase: 'syncing'` where `idle` was expected.
 */
export async function settle(outpost: Outpost): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await outpost.syncNow();
    await tick();
  }

  await until(() => outpost.getSyncSnapshot().phase !== 'syncing');
}
