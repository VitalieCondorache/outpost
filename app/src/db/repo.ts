import type { MutationKind, Note } from '@outpost/shared';
import { debug } from '../lib/debug';
import type { OutpostDatabase } from './open-db';
import {
  META_CONFLICTS,
  META_CURSOR,
  META_DEVICE_ID,
  META_LAST_SYNC_AT,
  STORE_META,
  STORE_NOTES,
  STORE_OUTBOX,
  type LocalMutation,
} from './schema';

/**
 * All persistence lives here: notes, the mutation outbox and sync metadata.
 *
 * The outbox is the heart of the design. A local edit is written together with
 * its mutation in a single IndexedDB transaction, so a crash can never leave a
 * note that will never be pushed, nor a mutation for a note that was never
 * written.
 */
export class NotesRepo {
  constructor(private readonly db: OutpostDatabase) {}

  // ------------------------------------------------------------------- notes

  async listNotes(): Promise<Note[]> {
    const notes = await this.db.getAll(STORE_NOTES);
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getNote(id: string): Promise<Note | null> {
    return (await this.db.get(STORE_NOTES, id)) ?? null;
  }

  async putNote(note: Note): Promise<void> {
    await this.db.put(STORE_NOTES, note);
  }

  /**
   * Applies a delta pulled from the server.
   *
   * A note with pending local mutations is intentionally skipped: the local
   * edit is newer by definition, and it will be pushed (and possibly surface as
   * a conflict) on the next pass. `force` overrides that for conflict
   * resolution, where the user explicitly picked the server version.
   */
  async applyServerNotes(notes: Note[], force = false): Promise<number> {
    if (notes.length === 0) return 0;

    const tx = this.db.transaction([STORE_NOTES, STORE_OUTBOX], 'readwrite');
    const notesStore = tx.objectStore(STORE_NOTES);
    const outbox = tx.objectStore(STORE_OUTBOX);
    let applied = 0;

    for (const serverNote of notes) {
      if (!force) {
        const pending = await outbox.index('by-noteId').count(serverNote.id);
        if (pending > 0) continue;
      }
      await notesStore.put(serverNote);
      applied += 1;
    }

    await tx.done;
    return applied;
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction([STORE_NOTES, STORE_OUTBOX, STORE_META], 'readwrite');
    await Promise.all([
      tx.objectStore(STORE_NOTES).clear(),
      tx.objectStore(STORE_OUTBOX).clear(),
      tx.objectStore(STORE_META).clear(),
    ]);
    await tx.done;
  }

  /**
   * Empties the trash locally: the note and every mutation about it disappear.
   * The tombstone stays on the server (and expires after the retention window),
   * so another device cannot resurrect the note.
   */
  async deleteNoteForever(id: string): Promise<void> {
    const tx = this.db.transaction([STORE_NOTES, STORE_OUTBOX], 'readwrite');
    const outbox = tx.objectStore(STORE_OUTBOX);
    await tx.objectStore(STORE_NOTES).delete(id);
    for (const mutation of await outbox.index('by-noteId').getAll(id)) {
      await outbox.delete(mutation.id);
    }
    await tx.done;
  }

  // ------------------------------------------------------------------ outbox

  async countPending(): Promise<number> {
    return this.db.count(STORE_OUTBOX);
  }

  async listOutbox(): Promise<LocalMutation[]> {
    const mutations = await this.db.getAllFromIndex(STORE_OUTBOX, 'by-createdAt');
    return mutations;
  }

  /**
   * Writes the note and enqueues (or coalesces) its mutation atomically.
   *
   * Coalescing is what keeps the outbox small and conflict-free: while a note's
   * mutation is still waiting to be sent, further edits replace its payload
   * instead of appending a second mutation that would carry a stale `baseRev`
   * and conflict with its own predecessor.
   */
  async commitLocalChange(note: Note, mutation: LocalMutation): Promise<LocalMutation> {
    const tx = this.db.transaction([STORE_NOTES, STORE_OUTBOX], 'readwrite');
    const notesStore = tx.objectStore(STORE_NOTES);
    const outbox = tx.objectStore(STORE_OUTBOX);

    await notesStore.put(note);

    const pending = await outbox.index('by-noteId').getAll(note.id);
    const coalescable = pending
      .filter((candidate) => !candidate.inFlight && !candidate.blocked)
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(0);

    const stored: LocalMutation = coalescable
      ? {
          ...coalescable,
          kind: reconcileKind(coalescable, mutation),
          payload: mutation.payload,
          attempts: 0,
          lastError: null,
          nextAttemptAt: 0,
        }
      : mutation;

    debug(
      'outbox commit',
      note.id.slice(0, 4),
      `"${note.title}"`,
      `rev=${note.rev}`,
      `op=${stored.kind}/${stored.id.slice(0, 4)}/base=${stored.baseRev}`,
      coalescable ? '(coalesced)' : '(new)',
      `payload="${stored.payload?.title ?? 'null'}"`,
    );

    await outbox.put(stored);
    await tx.done;
    return stored;
  }

  /**
   * Claims the next batch of mutations to push.
   *
   * Rules encoded here:
   * - `inFlight` mutations are never handed out twice (a retry reuses the same
   *   `id`, so the server deduplicates anyway, but sending it twice in parallel
   *   would be wasteful).
   * - Mutations waiting for their retry delay are skipped.
   * - At most one mutation per note per batch, so the second mutation of the
   *   same note is sent only after the first one's new `rev` has been learned.
   */
  async takeBatch(limit: number, now: number): Promise<LocalMutation[]> {
    const tx = this.db.transaction(STORE_OUTBOX, 'readwrite');
    const outbox = tx.objectStore(STORE_OUTBOX);
    const candidates = await outbox.index('by-createdAt').getAll();

    const batch: LocalMutation[] = [];
    const notesInBatch = new Set<string>();

    for (const candidate of candidates) {
      if (candidate.inFlight || candidate.blocked) continue;
      if (candidate.nextAttemptAt > now) continue;
      if (notesInBatch.has(candidate.noteId)) continue;

      const claimed: LocalMutation = { ...candidate, inFlight: true };
      await outbox.put(claimed);
      batch.push(claimed);
      notesInBatch.add(candidate.noteId);

      if (batch.length >= limit) break;
    }

    await tx.done;
    return batch;
  }

  /**
   * Removes an acknowledged mutation and, when the server is authoritative for
   * that note (no other pending mutation), adopts the server state — including
   * its new `rev` and its tombstone flag.
   */
  async settle(mutationId: string, serverNote: Note | null): Promise<void> {
    const tx = this.db.transaction([STORE_OUTBOX, STORE_NOTES], 'readwrite');
    const outbox = tx.objectStore(STORE_OUTBOX);
    const notesStore = tx.objectStore(STORE_NOTES);

    const mutation = await outbox.get(mutationId);
    await outbox.delete(mutationId);

    if (mutation && serverNote) {
      const stillPending = await outbox.index('by-noteId').count(mutation.noteId);
      const local = await notesStore.get(mutation.noteId);

      if (stillPending === 0) {
        await notesStore.put(serverNote);
      } else if (local) {
        // Edits happened while the request was in flight: keep them, but adopt
        // the revision so the next mutation in the chain is not stale.
        await notesStore.put({ ...local, rev: serverNote.rev });
      }
    }

    await tx.done;
  }

  /**
   * Marks mutations as failed and schedules their retry. A relative delay is
   * stored (`now + retryInMs`) instead of an absolute timer, so a reload or a
   * period spent offline cannot lose it.
   */
  async penalize(
    mutationIds: string[],
    options: { reason: string; retryInMs: number; now: number },
  ): Promise<void> {
    if (mutationIds.length === 0) return;

    const tx = this.db.transaction(STORE_OUTBOX, 'readwrite');
    const outbox = tx.objectStore(STORE_OUTBOX);

    for (const id of mutationIds) {
      const mutation = await outbox.get(id);
      if (!mutation) continue;
      await outbox.put({
        ...mutation,
        inFlight: false,
        attempts: mutation.attempts + 1,
        lastError: options.reason,
        nextAttemptAt: options.now + options.retryInMs,
      });
    }

    await tx.done;
  }

  /** The server rejected this mutation for good: stop retrying, tell the user. */
  async failMutation(mutationId: string, reason: string): Promise<void> {
    const tx = this.db.transaction(STORE_OUTBOX, 'readwrite');
    const outbox = tx.objectStore(STORE_OUTBOX);
    const mutation = await outbox.get(mutationId);
    if (mutation) {
      await outbox.put({ ...mutation, inFlight: false, blocked: true, lastError: reason });
    }
    await tx.done;
  }

  /**
   * After a mutation is applied, every later mutation of the same note is based
   * on the state it produced, so their `baseRev` must move forward as well.
   */
  async bumpChainBaseRev(noteId: string, rev: number): Promise<void> {
    const tx = this.db.transaction(STORE_OUTBOX, 'readwrite');
    const outbox = tx.objectStore(STORE_OUTBOX);

    for (const mutation of await outbox.index('by-noteId').getAll(noteId)) {
      if (mutation.inFlight || mutation.blocked || mutation.baseRev >= rev) continue;
      await outbox.put({ ...mutation, baseRev: rev });
    }

    await tx.done;
  }

  async getMutation(id: string): Promise<LocalMutation | null> {
    return (await this.db.get(STORE_OUTBOX, id)) ?? null;
  }

  async updateMutation(id: string, patch: Partial<LocalMutation>): Promise<void> {
    const tx = this.db.transaction(STORE_OUTBOX, 'readwrite');
    const outbox = tx.objectStore(STORE_OUTBOX);
    const mutation = await outbox.get(id);
    if (mutation) await outbox.put({ ...mutation, ...patch, id });
    await tx.done;
  }

  async deleteMutation(id: string): Promise<void> {
    await this.db.delete(STORE_OUTBOX, id);
  }

  // -------------------------------------------------------------------- meta

  async getMeta<T>(key: string, fallback: T): Promise<T> {
    const record = await this.db.get(STORE_META, key);
    return record === undefined ? fallback : (record.value as T);
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.put(STORE_META, { key, value });
  }

  async getCursor(): Promise<number> {
    const cursor = await this.getMeta<number>(META_CURSOR, 0);
    return Number.isFinite(cursor) ? cursor : 0;
  }

  async setCursor(cursor: number): Promise<void> {
    await this.setMeta(META_CURSOR, cursor);
  }

  async getDeviceId(): Promise<string> {
    return this.getMeta<string>(META_DEVICE_ID, '');
  }

  async setDeviceId(deviceId: string): Promise<void> {
    await this.setMeta(META_DEVICE_ID, deviceId);
  }

  async getLastSyncAt(): Promise<number | null> {
    return this.getMeta<number | null>(META_LAST_SYNC_AT, null);
  }

  async setLastSyncAt(timestamp: number): Promise<void> {
    await this.setMeta(META_LAST_SYNC_AT, timestamp);
  }

  async getConflicts<T>(): Promise<T[]> {
    return this.getMeta<T[]>(META_CONFLICTS, []);
  }

  async setConflicts(conflicts: unknown[]): Promise<void> {
    await this.setMeta(META_CONFLICTS, conflicts);
  }
}

/**
 * Merges the kind of a pending mutation with a newer local change.
 *
 * - A note that never reached the server stays a `create` until it does.
 * - A pending `delete` becomes an `update` as soon as the payload carries an
 *   explicit tombstone state: a restore (`deletedAt: null`) must reach the
 *   server as a write, and an edit inside the trash must keep its content
 *   instead of being replaced by a bare delete.
 */
export function reconcileKind(existing: LocalMutation, incoming: LocalMutation): MutationKind {
  if (existing.kind === 'create' || incoming.kind === 'create') return 'create';
  if (existing.kind === 'delete' && incoming.payload !== null) return 'update';
  return incoming.kind;
}
