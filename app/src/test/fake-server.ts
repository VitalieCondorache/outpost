import type { Mutation, MutationResult, Note, PullResponse, SyncResponse } from '@outpost/shared';
import type { SyncApi } from '../sync/api';

interface StoredNote extends Note {
  seq: number;
}

export interface FakeServer {
  api: SyncApi;
  /** Server state, keyed by note id. */
  notes: Map<string, Note>;
  appliedMutations: Set<string>;
  /** Number of `push` calls received — used by the retry tests. */
  pushCount(): number;
  /** Fails the next push with a network-like error, before applying anything. */
  failNextPush(message?: string): void;
  /**
   * Applies the next push but throws on the way back: this is a lost response,
   * the scenario that makes idempotency keys necessary.
   */
  failNextPushAfterApply(message?: string): void;
  /** Simulates another device writing to a note. */
  externalWrite(noteId: string, patch: Partial<Pick<Note, 'title' | 'body'>>): Note;
  /** Simulates a note that appeared from another device. */
  createOnServer(note: Note): Note;
}

export interface FakeServerOptions {
  now?: () => number;
}

/**
 * In-memory implementation of the sync protocol for the app's tests.
 *
 * It mirrors the rules of `server/src/db.ts` (optimistic `rev` check, mutation
 * ledger, tombstones, monotonic `seq` cursor). The *real* server is what the
 * Playwright suite exercises end to end — this fake exists so unit tests stay
 * fast and deterministic.
 */
export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const notes = new Map<string, StoredNote>();
  const applied = new Set<string>();
  let seq = 0;
  let clock = options.now?.() ?? Date.now();
  let pushCount = 0;
  let failure: { apply: boolean; message: string } | null = null;

  const nextTimestamp = (): number => {
    clock += 1;
    return clock;
  };

  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  /** Drops the storage-only `seq` before sending a note over the wire. */
  const strip = (note: StoredNote): Note => ({
    id: note.id,
    title: note.title,
    body: note.body,
    tags: note.tags,
    pinned: note.pinned,
    deletedAt: note.deletedAt,
    rev: note.rev,
    updatedAt: note.updatedAt,
  });

  const applyMutation = (mutation: Mutation): MutationResult => {
    if (applied.has(mutation.id)) {
      const current = notes.get(mutation.noteId);
      return {
        id: mutation.id,
        status: 'applied',
        duplicate: true,
        rev: current?.rev ?? 0,
        ...(current ? { server: strip(current) } : {}),
        message: 'mutation was already applied earlier',
      };
    }

    const existing = notes.get(mutation.noteId);
    const baseRev = existing?.rev ?? 0;

    if (existing && existing.rev !== mutation.baseRev) {
      return {
        id: mutation.id,
        status: 'conflict',
        rev: baseRev,
        server: strip(existing),
        message: `stale baseRev: client=${mutation.baseRev} server=${baseRev}`,
      };
    }

    if (mutation.kind === 'delete' && !existing) {
      applied.add(mutation.id);
      return {
        id: mutation.id,
        status: 'applied',
        duplicate: true,
        rev: 0,
        message: 'note does not exist on the server',
      };
    }

    const rev = baseRev + 1;
    const updatedAt = nextTimestamp();
    const payload = mutation.payload;

    const next: StoredNote =
      mutation.kind === 'delete' && existing
        ? { ...existing, deletedAt: updatedAt, rev, updatedAt, seq: nextSeq() }
        : {
            id: mutation.noteId,
            title: payload?.title ?? '',
            body: payload?.body ?? '',
            tags: payload?.tags ?? [],
            pinned: payload?.pinned ?? false,
            deletedAt: payload?.deletedAt ?? existing?.deletedAt ?? null,
            rev,
            updatedAt,
            seq: nextSeq(),
          };

    notes.set(next.id, next);
    applied.add(mutation.id);

    return { id: mutation.id, status: 'applied', rev, server: strip(next) };
  };

  const api: SyncApi = {
    async push(request): Promise<SyncResponse> {
      pushCount += 1;
      const results = request.mutations.map(applyMutation);
      if (failure !== null) {
        const { message } = failure;
        failure = null;
        throw new Error(message);
      }
      failure = null;
      return { results };
    },

    async pull(since: number): Promise<PullResponse> {
      const changed = [...notes.values()]
        .filter((note) => note.seq > since)
        .sort((a, b) => a.seq - b.seq);
      const last = changed.at(-1);
      return { notes: changed.map(strip), cursor: last ? last.seq : since };
    },

    async reset(): Promise<void> {
      notes.clear();
      applied.clear();
      seq = 0;
      pushCount = 0;
    },
  };

  return {
    api,
    notes,
    appliedMutations: applied,
    pushCount: () => pushCount,
    failNextPush: (message = 'network unreachable') => {
      failure = { apply: false, message };
    },
    failNextPushAfterApply: (message = 'connection reset by peer') => {
      failure = { apply: true, message };
    },
    externalWrite: (noteId, patch) => {
      const existing = notes.get(noteId);
      if (!existing) throw new Error(`fake server has no note ${noteId}`);

      const next: StoredNote = {
        ...existing,
        ...patch,
        rev: existing.rev + 1,
        updatedAt: nextTimestamp(),
        seq: nextSeq(),
      };
      notes.set(noteId, next);
      return strip(next);
    },
    createOnServer: (note) => {
      const created: StoredNote = { ...note, rev: 1, seq: nextSeq(), updatedAt: nextTimestamp() };
      notes.set(created.id, created);
      return strip(created);
    },
  };
}
