import type { DBSchema } from 'idb';
import type { Mutation, Note } from '@outpost/shared';

/**
 * A mutation as it lives in the client outbox: the wire payload plus the local
 * bookkeeping needed to retry it safely.
 */
export interface LocalMutation extends Mutation {
  /** How many delivery attempts failed so far (drives the retry backoff). */
  attempts: number;
  lastError: string | null;
  /** Epoch ms before which this mutation must not be sent again. */
  nextAttemptAt: number;
  /** True while a push request carrying this mutation is in flight. */
  inFlight: boolean;
  /** True when the mutation lost a conflict and needs a user decision. */
  blocked: boolean;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

export const STORE_NOTES = 'notes';
export const STORE_OUTBOX = 'outbox';
export const STORE_META = 'meta';

export interface OutpostSchema extends DBSchema {
  notes: {
    key: string;
    value: Note;
    indexes: { 'by-updatedAt': number };
  };
  outbox: {
    key: string;
    value: LocalMutation;
    indexes: { 'by-createdAt': number; 'by-noteId': string };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
}

export const META_CURSOR = 'syncCursor';
export const META_DEVICE_ID = 'deviceId';
export const META_LAST_SYNC_AT = 'lastSyncAt';
export const META_CONFLICTS = 'conflicts';
