import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Mutation,
  MutationKind,
  NoteInput,
  PullResponse,
  SyncResponse,
} from '@outpost/shared';
import { createApp } from '../src/app.js';
import { OutpostDb } from '../src/db.js';

let clock = 0;
let db: OutpostDb;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  clock = 1_000;
  db = new OutpostDb({ now: () => ++clock });
  app = createApp({ db, quiet: true });
});

function mutation(options: {
  noteId: string;
  kind?: MutationKind;
  baseRev?: number;
  payload?: NoteInput | null;
  id?: string;
}): Mutation {
  const kind = options.kind ?? 'create';
  const baseRev = options.baseRev ?? 0;
  return {
    id: options.id ?? `m-${options.noteId}-${kind}-${baseRev}`,
    noteId: options.noteId,
    kind,
    baseRev,
    createdAt: ++clock,
    payload: kind === 'delete' ? null : (options.payload ?? { title: 'Note', body: 'body' }),
  };
}

async function push(mutations: Mutation[]): Promise<SyncResponse> {
  const response = await app.request('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-a', mutations }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SyncResponse;
}

async function pull(since = 0): Promise<PullResponse> {
  const response = await app.request(`/api/notes?since=${since}`);
  expect(response.status).toBe(200);
  return (await response.json()) as PullResponse;
}

describe('POST /api/sync', () => {
  it('creates a note and reports the new revision', async () => {
    const { results } = await push([mutation({ noteId: 'n1' })]);

    expect(results[0]).toMatchObject({ status: 'applied', rev: 1 });
    expect(results[0]?.server).toMatchObject({
      id: 'n1',
      title: 'Note',
      rev: 1,
      deletedAt: null,
      tags: [],
    });
  });

  it('is idempotent: replaying a mutation never bumps the revision twice', async () => {
    const create = mutation({ noteId: 'n1' });

    await push([create]);
    const replay = await push([create]);

    expect(replay.results[0]).toMatchObject({ status: 'applied', duplicate: true, rev: 1 });
    expect(db.getNote('n1')?.rev).toBe(1);
  });

  it('reports a conflict for a stale baseRev instead of overwriting data', async () => {
    await push([mutation({ noteId: 'n1' })]);

    const stale = await push([
      mutation({
        noteId: 'n1',
        kind: 'update',
        baseRev: 0,
        payload: { title: 'clobbered', body: '' },
      }),
    ]);

    expect(stale.results[0]).toMatchObject({ status: 'conflict', rev: 1 });
    expect(stale.results[0]?.message).toContain('stale baseRev');
    expect(stale.results[0]?.server?.title).toBe('Note');
    expect(db.getNote('n1')?.title).toBe('Note');
  });

  it('applies sequential updates when the client read the current revision', async () => {
    await push([mutation({ noteId: 'n1' })]);

    const updated = await push([
      mutation({
        noteId: 'n1',
        kind: 'update',
        baseRev: 1,
        payload: { title: 'v2', body: 'body', tags: ['work', 'sync'], pinned: true },
      }),
    ]);

    expect(updated.results[0]).toMatchObject({ status: 'applied', rev: 2 });
    expect(db.getNote('n1')).toMatchObject({
      title: 'v2',
      tags: ['work', 'sync'],
      pinned: true,
      rev: 2,
    });
  });

  it('keeps a tombstone on delete so other devices learn about it', async () => {
    await push([mutation({ noteId: 'n1' })]);

    const deleted = await push([mutation({ noteId: 'n1', kind: 'delete', baseRev: 1 })]);

    expect(deleted.results[0]).toMatchObject({ status: 'applied', rev: 2 });
    expect(db.getNote('n1')?.deletedAt).not.toBeNull();

    const pulled = await pull(0);
    expect(pulled.notes[0]?.deletedAt).not.toBeNull();
    expect(db.stats()).toMatchObject({ notes: 0, tombstones: 1 });
  });

  it('treats a repeated delete as a no-op', async () => {
    await push([mutation({ noteId: 'n1' })]);
    await push([mutation({ noteId: 'n1', kind: 'delete', baseRev: 1 })]);

    const again = await push([mutation({ noteId: 'n1', kind: 'delete', baseRev: 1 })]);

    expect(again.results[0]).toMatchObject({ status: 'applied', duplicate: true, rev: 2 });
  });

  it('clears the tombstone on restore and keeps it on unrelated edits', async () => {
    await push([mutation({ noteId: 'n1' })]);
    await push([mutation({ noteId: 'n1', kind: 'delete', baseRev: 1 })]);

    const renamed = await push([
      mutation({
        noteId: 'n1',
        kind: 'update',
        baseRev: 2,
        payload: { title: 'still trashed', body: 'body' },
      }),
    ]);
    expect(renamed.results[0]).toMatchObject({ status: 'applied', rev: 3 });
    expect(db.getNote('n1')?.deletedAt).not.toBeNull();

    const restored = await push([
      mutation({
        noteId: 'n1',
        kind: 'update',
        baseRev: 3,
        payload: { title: 'still trashed', body: 'body', deletedAt: null },
      }),
    ]);
    expect(restored.results[0]).toMatchObject({ status: 'applied', rev: 4 });
    expect(db.getNote('n1')?.deletedAt).toBeNull();
  });

  it('resolves a batch in order, one revision per applied mutation', async () => {
    await push([mutation({ noteId: 'n1' })]);

    const batch = await push([
      mutation({
        noteId: 'n1',
        kind: 'update',
        baseRev: 1,
        payload: { title: 'ok', body: '' },
        id: 'm-ok',
      }),
      mutation({ noteId: 'n2', kind: 'create', id: 'm-new' }),
      mutation({
        noteId: 'n1',
        kind: 'update',
        baseRev: 1,
        payload: { title: 'stale', body: '' },
        id: 'm-stale',
      }),
    ]);

    expect(batch.results.map((result) => result.status)).toEqual([
      'applied',
      'applied',
      'conflict',
    ]);
    expect(db.getNote('n1')?.title).toBe('ok');
    expect(db.getNote('n2')?.rev).toBe(1);
  });
});

describe('GET /api/notes', () => {
  it('returns only what changed since the cursor and advances monotonically', async () => {
    await push([mutation({ noteId: 'n1' })]);
    const first = await pull(0);
    expect(first.notes.map((note) => note.id)).toEqual(['n1']);
    expect(first.cursor).toBeGreaterThan(0);

    const empty = await pull(first.cursor);
    expect(empty.notes).toEqual([]);
    expect(empty.cursor).toBe(first.cursor);

    await push([mutation({ noteId: 'n2' })]);
    const third = await pull(empty.cursor);
    expect(third.notes.map((note) => note.id)).toEqual(['n2']);
    expect(third.cursor).toBeGreaterThan(first.cursor);
  });
});
