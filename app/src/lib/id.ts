/**
 * Ids are generated on the client, because a note created offline must have a
 * globally unique identity before the server ever sees it.
 */
export function newId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Stable, human-readable device id used to tag mutations in the logs. */
export function newDeviceId(): string {
  return newId().slice(0, 8);
}
