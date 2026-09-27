import { describe, expect, it } from 'vitest';
import type { Mutation } from '@outpost/shared';
import { createFakeServer, type FakeServer } from './fake-server';

/**
 * The fake server is only allowed to stay in the repository while it behaves like
 * `server/src/db.ts`, and the Playwright suite can only prove that for the
 * scenarios it happens to cover. These tests pin the rules that the app tests
 * depend on but never exercise directly — a drifted double fails silently, and
 * "green unit tests while the real path is broken" is exactly how the tombstone
 * rule below stayed wrong for a while.
 */

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    id: 'm1',
    noteId: 'n1',
    kind: 'create',
    payload: { title: 'Title', body: '' },
    baseRev: 0,
    createdAt: 1,
    ...overrides,
  };
}

async function push(server: FakeServer, mutations: Mutation[]) {
  const response = await server.api.push({ deviceId: 'test-device', mutations });
  return response.results;
}

/** `create` (rev 1) → `delete` (rev 2): a note sitting in the server's trash. */
async function trashIt(server: FakeServer): Promise<void> {
  const results = await push(server, [mutation()]);
  expect(results[0]?.rev).toBe(1);

  const deleted = await push(server, [
    mutation({ id: 'm2', kind: 'delete', payload: null, baseRev: 1 }),
  ]);
  expect(deleted[0]).toMatchObject({ status: 'applied', rev: 2 });
  expect(server.notes.get('n1')?.deletedAt).not.toBeNull();
}

describe('fake server: the rules it mirrors from the real server', () => {
  it('treats an explicit `deletedAt: null` as a restore, not as a missing field', async () => {
    const server = createFakeServer({ now: () => 1_000 });
    await trashIt(server);

    const results = await push(server, [
      mutation({
        id: 'm3',
        kind: 'update',
        baseRev: 2,
        payload: { title: 'Title', body: '', tags: [], pinned: false, deletedAt: null },
      }),
    ]);

    expect(results[0]).toMatchObject({ status: 'applied', rev: 3 });
    expect(results[0]?.server?.deletedAt).toBeNull();
    expect(server.notes.get('n1')?.deletedAt).toBeNull();
  });

  it('keeps the tombstone when the payload says nothing about it', async () => {
    const server = createFakeServer({ now: () => 1_000 });
    await trashIt(server);

    const results = await push(server, [
      mutation({
        id: 'm3',
        kind: 'update',
        baseRev: 2,
        payload: { title: 'Edited inside the trash', body: '' },
      }),
    ]);

    expect(results[0]).toMatchObject({ status: 'applied', rev: 3 });
    expect(results[0]?.server?.deletedAt).not.toBeNull();
    expect(server.notes.get('n1')?.title).toBe('Edited inside the trash');
  });

  it('makes a second delete of the same note a no-op instead of a new revision', async () => {
    const server = createFakeServer({ now: () => 1_000 });
    await trashIt(server);
    const tombstone = server.notes.get('n1')?.deletedAt;

    const results = await push(server, [
      mutation({ id: 'm3', kind: 'delete', payload: null, baseRev: 2 }),
    ]);

    expect(results[0]).toMatchObject({ status: 'applied', duplicate: true, rev: 2 });
    expect(server.notes.get('n1')).toMatchObject({ rev: 2, deletedAt: tombstone });
  });

  it('answers a stale baseRev with a conflict instead of guessing', async () => {
    const server = createFakeServer({ now: () => 1_000 });
    await trashIt(server);

    const results = await push(server, [
      mutation({ id: 'm3', kind: 'update', baseRev: 1, payload: { title: 'Stale', body: '' } }),
    ]);

    expect(results[0]).toMatchObject({ status: 'conflict', rev: 2 });
    expect(server.notes.get('n1')?.title).toBe('Title');
  });
});
