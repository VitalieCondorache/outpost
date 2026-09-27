import type { Mutation, MutationKind, Note, NoteInput } from '@outpost/shared';
import type { LocalMutation } from '../db/schema';
import { newId } from '../lib/id';

export interface BuildMutationOptions {
  deviceId: string;
  now?: number;
  /** Injectable for deterministic tests. */
  newMutationId?: () => string;
}

/**
 * Turns "the note now looks like `next`, it used to look like `previous`" into
 * a mutation the server understands.
 *
 * - `rev === 0` on the previous state means the note never reached the server,
 *   so the mutation is a `create`.
 * - Moving a live note to the trash produces a `delete`; the reverse is a plain
 *   `update` carrying `deletedAt: null` (a restore).
 * - `baseRev` is the revision this change was written against — the server uses
 *   it to detect that somebody else got there first.
 */
export function buildMutation(
  next: Note,
  previous: Note,
  options: BuildMutationOptions,
): LocalMutation {
  const now = options.now ?? Date.now();
  const kind = resolveKind(next, previous);

  return {
    id: options.newMutationId?.() ?? newId(),
    noteId: next.id,
    kind,
    payload: toPayload(next),
    baseRev: previous.rev,
    createdAt: now,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
    inFlight: false,
    blocked: false,
  };
}

export function resolveKind(next: Note, previous: Note): MutationKind {
  if (previous.rev === 0) return 'create';
  if (next.deletedAt !== null && previous.deletedAt === null) return 'delete';
  return 'update';
}

export function toPayload(note: Note): NoteInput {
  return {
    title: note.title,
    body: note.body,
    tags: note.tags,
    pinned: note.pinned,
    deletedAt: note.deletedAt,
  };
}

/**
 * The outbox record carries local bookkeeping (attempts, in-flight flag) that
 * the server must never see: the wire payload is exactly the protocol shape.
 */
export function toWireMutation(mutation: LocalMutation): Mutation {
  return {
    id: mutation.id,
    noteId: mutation.noteId,
    kind: mutation.kind,
    payload: mutation.payload,
    baseRev: mutation.baseRev,
    createdAt: mutation.createdAt,
  };
}
