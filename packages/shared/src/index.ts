/**
 * Wire protocol shared by the PWA (client) and the sync API (server).
 *
 * Design decisions worth knowing before you read the rest:
 *
 * 1. Every note carries a server-assigned, monotonically increasing `rev`.
 *    A client mutation states which revision it was based on (`baseRev`).
 *    The server only accepts the mutation when `baseRev` still matches, which
 *    turns conflicting concurrent edits into an explicit HTTP-level signal
 *    instead of a silent overwrite.
 *
 * 2. Every mutation carries an `id` that never changes across retries. The
 *    server keeps a ledger of applied mutation ids, so a retry after a lost
 *    response can never be applied twice (idempotency).
 *
 * 3. Deletes are soft: `deletedAt` is a tombstone that syncs like any other
 *    field. Without tombstones a deleted note would be resurrected by the
 *    next pull from another device.
 */

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  /** Epoch ms of the soft delete, `null` when the note is alive. */
  deletedAt: number | null;
  /** Server revision. `0` means "never synced" (created while offline). */
  rev: number;
  /** Epoch ms of the last local or server change. */
  updatedAt: number;
}

/** The mutable part of a note, as sent inside a mutation payload. */
export interface NoteInput {
  title: string;
  body: string;
  tags?: string[];
  pinned?: boolean;
  /**
   * Only sent when the mutation changes the tombstone state.
   * `null` = restore from trash, a timestamp = move to trash.
   */
  deletedAt?: number | null;
}

export type MutationKind = 'create' | 'update' | 'delete';

export interface Mutation {
  /** Idempotency key. Stable across retries, unique per mutation. */
  id: string;
  noteId: string;
  kind: MutationKind;
  /** `null` for `delete` mutations. */
  payload: NoteInput | null;
  /** Revision the client based this change on. */
  baseRev: number;
  /** Epoch ms — used as the FIFO ordering key. */
  createdAt: number;
}

export interface SyncRequest {
  deviceId: string;
  mutations: Mutation[];
}

export type MutationStatus = 'applied' | 'conflict' | 'failed';

export interface MutationResult {
  /** Echoes `Mutation.id`. */
  id: string;
  status: MutationStatus;
  /** Server revision after the mutation was applied. */
  rev?: number;
  /** Server state, present for `applied` and `conflict`. */
  server?: Note;
  /** True when the mutation was already applied earlier (retry/dedup). */
  duplicate?: boolean;
  /** Human readable detail for `failed` and `conflict`. */
  message?: string;
}

export interface SyncResponse {
  results: MutationResult[];
}

export interface PullResponse {
  /** Notes with `seq > since`, ordered by `seq` ascending. */
  notes: Note[];
  /** Opaque cursor to pass back as `since`. Monotonic per server. */
  cursor: number;
}

export interface HealthResponse {
  ok: true;
  notes: number;
  tombstones: number;
  appliedMutations: number;
  now: number;
}

export const API_ROUTES = {
  health: '/api/health',
  notes: '/api/notes',
  sync: '/api/sync',
  reset: '/api/dev/reset',
} as const;
