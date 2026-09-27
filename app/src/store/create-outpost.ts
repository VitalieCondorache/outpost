import { DEFAULT_DB_NAME, openOutpostDb } from '../db/open-db';
import { NotesRepo } from '../db/repo';
import { newDeviceId } from '../lib/id';
import { HttpSyncApi, type SyncApi } from '../sync/api';
import { SyncEngine } from '../sync/engine';
import { Outpost } from './outpost';

export interface CreateOutpostOptions {
  dbName?: string;
  api?: SyncApi;
  online?: () => boolean;
  now?: () => number;
  random?: () => number;
  intervalMs?: number;
  onRequestBackgroundSync?: () => void;
}

export interface OutpostRuntime {
  outpost: Outpost;
  repo: NotesRepo;
  engine: SyncEngine;
}

/**
 * Wires the real object graph: IndexedDB → repository → sync engine → store.
 *
 * Nothing here touches the DOM, so tests can build an isolated instance (own
 * database name, fake API, controllable clock and connectivity) and drive the
 * exact same code the browser runs.
 */
export async function createOutpost(options: CreateOutpostOptions = {}): Promise<Outpost> {
  const { outpost } = await createOutpostRuntime(options);
  return outpost;
}

export async function createOutpostRuntime(
  options: CreateOutpostOptions = {},
): Promise<OutpostRuntime> {
  const db = await openOutpostDb(options.dbName ?? DEFAULT_DB_NAME);
  const repo = new NotesRepo(db);
  const api = options.api ?? new HttpSyncApi();

  let deviceId = await repo.getDeviceId();
  if (deviceId.length === 0) {
    deviceId = newDeviceId();
    await repo.setDeviceId(deviceId);
  }

  // The store is referenced from the engine callback before it exists; the
  // holder keeps the wiring explicit and avoids a temporal-dead-zone trap.
  const holder: { outpost?: Outpost } = {};

  const engine = new SyncEngine({
    repo,
    api,
    deviceId,
    now: options.now,
    random: options.random,
    online: options.online,
    intervalMs: options.intervalMs,
    onRequestBackgroundSync: options.onRequestBackgroundSync,
    // A pull that brought other devices' notes in must reach the UI.
    onChanged: () => holder.outpost?.refreshFromStorage(),
  });

  const outpost = new Outpost({
    repo,
    engine,
    resetServer: () => api.reset(),
  });
  holder.outpost = outpost;

  await outpost.init();
  return { outpost, repo, engine };
}
