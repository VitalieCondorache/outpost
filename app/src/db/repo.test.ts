import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '@outpost/shared';
import { buildMutation } from '../sync/mutations';
import { deleteOutpostDb, openOutpostDb, type OutpostDatabase } from './open-db';
import { NotesRepo, reconcileKind } from './repo';
import type { LocalMutation } from './schema';

const dbName = `outpost-repo-test-${Math.random().toString(36).slice(2)}`;
let db: OutpostDatabase;
let repo: NotesRepo;

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Title',
    body: 'Body',
    tags: [],
    pinned: false,
    deletedAt: null,
    rev: 0,
    updatedAt: 1_000,
    ...overrides,
  };
}

function mutation(overrides: Partial<LocalMutation> = {}): LocalMutation {
  return {
    id: 'm1',
    noteId: 'n1',
    kind: 'create',
    payload: { title: 'Title', body: 'Body', tags: [], pinned: false, deletedAt: null },
    baseRev: 0,
    createdAt: 1,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
    inFlight: false,
    blocked: false,
    ...overrides,
  };
}

beforeEach(async () => {
  db = await openOutpostDb(dbName);
  repo = new NotesRepo(db);
  await repo.clearAll();
});

afterEach(async () => {
  db.close();
  await deleteOutpostDb(dbName);
});

describe('commitLocalChange', () => {
  it('writes the note and its mutation in one transaction', async () => {
    await repo.commitLocalChange(note(), mutation());

    expect(await repo.getNote('n1')).toMatchObject({ id: 'n1', rev: 0 });
    expect(await repo.countPending()).toBe(1);
  });

  it('coalesces rapid edits into a single mutation carrying the latest payload', async () => {
    const first = buildMutation(note({ title: 'one' }), note({ rev: 0 }), {
      deviceId: 'd1',
      newMutationId: () => 'm-1',
      now: 1,
    });
    await repo.commitLocalChange(note({ title: 'one' }), first);

    const second = buildMutation(note({ title: 'two' }), note({ title: 'one', rev: 0 }), {
      deviceId: 'd1',
      newMutationId: () => 'm-2',
      now: 2,
    });
    await repo.commitLocalChange(note({ title: 'two' }), second);

    const outbox = await repo.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ id: 'm-1', payload: { title: 'two' } });
  });

  it('does not coalesce with a blocked mutation', async () => {
    await repo.commitLocalChange(note(), mutation({ id: 'm-blocked', blocked: true }));

    const next = buildMutation(note({ title: 'after' }), note({ title: 'x', rev: 1 }), {
      deviceId: 'd1',
      newMutationId: () => 'm-fresh',
    });
    await repo.commitLocalChange(note({ title: 'after', rev: 1 }), next);

    expect(await repo.countPending()).toBe(2);
  });
});

describe('takeBatch', () => {
  it('claims mutations FIFO and marks them in flight', async () => {
    await repo.commitLocalChange(
      note({ id: 'a' }),
      mutation({ id: 'm-a', noteId: 'a', createdAt: 1 }),
    );
    await repo.commitLocalChange(
      note({ id: 'b' }),
      mutation({ id: 'm-b', noteId: 'b', createdAt: 2 }),
    );

    const batch = await repo.takeBatch(10, 100);

    expect(batch.map((item) => item.id)).toEqual(['m-a', 'm-b']);
    expect(batch.every((item) => item.inFlight)).toBe(true);
    // Already claimed: a second call must not hand them out again.
    expect(await repo.takeBatch(10, 100)).toEqual([]);
  });

  it('skips mutations that are still waiting for their retry delay', async () => {
    await repo.commitLocalChange(note({ id: 'a' }), mutation({ id: 'm-a', noteId: 'a' }));
    await repo.penalize(['m-a'], { reason: 'boom', retryInMs: 5_000, now: 1_000 });

    expect(await repo.takeBatch(10, 2_000)).toEqual([]);

    const later = await repo.takeBatch(10, 7_000);
    expect(later.map((item) => item.id)).toEqual(['m-a']);
  });

  it('claims at most one mutation per note so the revision chain stays ordered', async () => {
    await repo.commitLocalChange(
      note({ id: 'a' }),
      mutation({ id: 'm-a1', noteId: 'a', createdAt: 1 }),
    );
    await repo.commitLocalChange(
      note({ id: 'a', rev: 1 }),
      mutation({ id: 'm-a2', noteId: 'a', createdAt: 2, baseRev: 1 }),
    );
    await repo.commitLocalChange(
      note({ id: 'b' }),
      mutation({ id: 'm-b1', noteId: 'b', createdAt: 3 }),
    );

    const batch = await repo.takeBatch(10, 100);

    expect(batch.map((item) => item.id)).toEqual(['m-a1', 'm-b1']);
  });
});

describe('settle and bumpChainBaseRev', () => {
  it('adopts the server state when nothing else is pending for the note', async () => {
    await repo.commitLocalChange(note(), mutation());
    await repo.takeBatch(10, 100);

    await repo.settle('m1', note({ rev: 1, title: 'from server', updatedAt: 2_000 }));

    expect(await repo.countPending()).toBe(0);
    expect(await repo.getNote('n1')).toMatchObject({ rev: 1, title: 'from server' });
  });

  it('keeps local edits but adopts the new revision when more changes are queued', async () => {
    await repo.commitLocalChange(note(), mutation({ id: 'm1' }));
    await repo.takeBatch(1, 100);
    await repo.commitLocalChange(
      note({ title: 'typed while in flight' }),
      mutation({ id: 'm2', baseRev: 0, createdAt: 2, kind: 'update' }),
    );

    await repo.settle('m1', note({ rev: 1, title: 'server title' }));

    expect(await repo.getNote('n1')).toMatchObject({ title: 'typed while in flight', rev: 1 });
  });

  it('rebases queued mutations on the revision produced by their predecessor', async () => {
    await repo.commitLocalChange(note(), mutation({ id: 'm1' }));
    await repo.takeBatch(1, 100);
    await repo.commitLocalChange(note(), mutation({ id: 'm2', baseRev: 0, createdAt: 2 }));

    await repo.bumpChainBaseRev('n1', 1);

    expect((await repo.getMutation('m2'))?.baseRev).toBe(1);
  });
});

describe('applyServerNotes', () => {
  it('skips notes that have pending local mutations', async () => {
    await repo.commitLocalChange(note({ title: 'local' }), mutation());

    const applied = await repo.applyServerNotes([note({ rev: 3, title: 'server' })]);

    expect(applied).toBe(0);
    expect(await repo.getNote('n1')).toMatchObject({ title: 'local' });
  });

  it('applies everything when forced (conflict resolution)', async () => {
    await repo.commitLocalChange(note({ title: 'local' }), mutation());

    const applied = await repo.applyServerNotes([note({ rev: 3, title: 'server' })], true);

    expect(applied).toBe(1);
    expect(await repo.getNote('n1')).toMatchObject({ title: 'server', rev: 3 });
  });

  it('merges notes written by other devices', async () => {
    const applied = await repo.applyServerNotes([note({ id: 'other', rev: 1 })]);

    expect(applied).toBe(1);
    expect((await repo.listNotes()).map((item) => item.id)).toEqual(['other']);
  });
});

describe('deleteNoteForever', () => {
  it('removes the note and every mutation about it', async () => {
    await repo.commitLocalChange(note(), mutation({ id: 'm1' }));
    await repo.commitLocalChange(note(), mutation({ id: 'm2', kind: 'update', createdAt: 2 }));

    await repo.deleteNoteForever('n1');

    expect(await repo.getNote('n1')).toBeNull();
    expect(await repo.countPending()).toBe(0);
  });
});

describe('metadata', () => {
  it('returns fallbacks and stores values', async () => {
    expect(await repo.getCursor()).toBe(0);
    await repo.setCursor(7);
    expect(await repo.getCursor()).toBe(7);

    expect(await repo.getLastSyncAt()).toBeNull();
    await repo.setLastSyncAt(1_234);
    expect(await repo.getLastSyncAt()).toBe(1_234);

    expect(await repo.getMeta('missing', 'fallback')).toBe('fallback');
    await repo.setMeta('custom', { a: 1 });
    expect(await repo.getMeta('custom', null)).toEqual({ a: 1 });
  });
});

describe('reconcileKind', () => {
  it('keeps a pending create a create', () => {
    expect(reconcileKind(mutation({ kind: 'create' }), mutation({ kind: 'update' }))).toBe(
      'create',
    );
  });

  it('turns a pending delete into an update when the note is restored', () => {
    const pendingDelete = mutation({ kind: 'delete', payload: null });
    const restore = mutation({
      kind: 'update',
      payload: { title: 'T', body: 'B', deletedAt: null },
    });

    expect(reconcileKind(pendingDelete, restore)).toBe('update');
  });

  it('turns a pending delete into an update when the trashed note is edited', () => {
    const pendingDelete = mutation({ kind: 'delete', payload: null });
    // The note is still in the trash, but its content changed: a plain `delete`
    // would drop that content on the server, so the payload must travel instead.
    const edit = mutation({
      kind: 'update',
      payload: { title: 'T', body: 'B', deletedAt: 5_000 },
    });

    expect(reconcileKind(pendingDelete, edit)).toBe('update');
  });
});
