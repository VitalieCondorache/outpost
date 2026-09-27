import { openDB, type IDBPDatabase } from 'idb';
import { STORE_META, STORE_NOTES, STORE_OUTBOX, type OutpostSchema } from './schema';

export type OutpostDatabase = IDBPDatabase<OutpostSchema>;

export const DEFAULT_DB_NAME = 'outpost';
export const DB_VERSION = 1;

/**
 * Local source of truth. Everything the UI reads comes from here — the network
 * is only ever a background replication channel.
 */
export function openOutpostDb(name: string = DEFAULT_DB_NAME): Promise<OutpostDatabase> {
  return openDB<OutpostSchema>(name, DB_VERSION, {
    upgrade(db) {
      const notes = db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
      notes.createIndex('by-updatedAt', 'updatedAt');

      const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
      // `by-createdAt` is the FIFO order in which mutations are pushed.
      outbox.createIndex('by-createdAt', 'createdAt');
      // `by-noteId` powers mutation coalescing and chain bookkeeping.
      outbox.createIndex('by-noteId', 'noteId');

      db.createObjectStore(STORE_META, { keyPath: 'key' });
    },
  });
}

export async function deleteOutpostDb(name: string = DEFAULT_DB_NAME): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('failed to delete database'));
    // Another tab still holds a connection: the delete happens once it closes.
    request.onblocked = () => resolve();
  });
}
