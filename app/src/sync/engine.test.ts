import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '@outpost/shared';
import { deleteOutpostDb } from '../db/open-db';
import { createOutpost } from '../store/create-outpost';
import type { Outpost } from '../store/outpost';
import { createFakeServer, type FakeServer } from '../test/fake-server';
import { settle, until } from '../test/settle';

let server: FakeServer;
let outpost: Outpost;
let online: boolean;
let dbName: string;

function serverNote(): Note | undefined {
  return [...server.notes.values()][0];
}

beforeEach(async () => {
  server = createFakeServer({ now: () => 1_000 });
  online = true;
  dbName = `outpost-engine-${Math.random().toString(36).slice(2)}`;
  outpost = await createOutpost({
    dbName,
    api: server.api,
    online: () => online,
    // No idle polling: every pass in these tests is triggered explicitly.
    intervalMs: 0,
    random: () => 0,
  });
});

afterEach(async () => {
  await deleteOutpostDb(dbName);
});

describe('offline first', () => {
  it('writes locally and queues the mutation while offline', async () => {
    online = false;

    await outpost.createNote({ title: 'Written in a tunnel' });
    await settle(outpost);

    const [note] = outpost.getSnapshot().notes;
    expect(note).toMatchObject({ title: 'Written in a tunnel', rev: 0 });
    expect(outpost.getSyncSnapshot()).toMatchObject({ phase: 'offline', pending: 1 });
    expect(server.notes.size).toBe(0);
    expect(server.pushCount()).toBe(0);
  });

  it('flushes the outbox as soon as the network comes back', async () => {
    online = false;
    await outpost.createNote({ title: 'Queued while offline' });
    await settle(outpost);

    online = true;
    await settle(outpost);

    expect(outpost.getSyncSnapshot()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(serverNote()).toMatchObject({ title: 'Queued while offline', rev: 1 });
    expect(outpost.getSnapshot().notes[0]).toMatchObject({ rev: 1 });
  });

  it('merges notes written by another device on the next pull', async () => {
    server.createOnServer({
      id: 'from-other-device',
      title: 'Created elsewhere',
      body: '',
      tags: [],
      pinned: false,
      deletedAt: null,
      rev: 1,
      updatedAt: 500,
    });

    await settle(outpost);

    expect(outpost.getSnapshot().notes.map((note) => note.id)).toContain('from-other-device');
  });

  it('syncs a delete as a tombstone that is not resurrected by the pull', async () => {
    const note = await outpost.createNote({ title: 'Temporary' });
    await settle(outpost);

    await outpost.trashNote(note.id);
    await settle(outpost);

    expect(serverNote()?.deletedAt).not.toBeNull();
    expect(outpost.getSnapshot().notes[0]?.deletedAt).not.toBeNull();
    expect(outpost.getSyncSnapshot().pending).toBe(0);
  });

  it('clears a tombstone that was pushed before the note was restored', async () => {
    const note = await outpost.createNote({ title: 'Temporary' });
    await settle(outpost);

    // Let the *delete* reach the server on its own. The restore below is then a
    // second, chained write instead of an edit coalesced into the same mutation —
    // the interleaving in which a restore used to come back from the server still
    // carrying its tombstone, leaving the note stuck in the trash.
    await outpost.trashNote(note.id);
    await settle(outpost);
    expect(serverNote()?.deletedAt).not.toBeNull();

    await outpost.restoreNote(note.id);
    await settle(outpost);

    expect(serverNote()?.deletedAt).toBeNull();
    expect(outpost.getSnapshot().notes[0]?.deletedAt).toBeNull();
    expect(outpost.getSyncSnapshot()).toMatchObject({ phase: 'idle', pending: 0 });
  });
});

describe('failure handling', () => {
  it('keeps the mutation queued and schedules a retry after a network error', async () => {
    server.failNextPush('offline?');

    await outpost.createNote({ title: 'Retry me' });
    await settle(outpost);

    expect(outpost.getSyncSnapshot()).toMatchObject({ phase: 'error', failures: 1, pending: 1 });
    const [mutation] = await outpost.pendingMutations();
    expect(mutation).toMatchObject({ attempts: 1, inFlight: false, blocked: false });
    expect(mutation?.nextAttemptAt).toBeGreaterThan(0);

    // random() => 0 means the first retry waits exactly 500ms; poll instead of
    // sleeping a fixed amount so a slow machine cannot fail the test.
    await until(() => outpost.getSyncSnapshot().pending === 0);

    expect(outpost.getSyncSnapshot()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(serverNote()).toMatchObject({ title: 'Retry me', rev: 1 });
  });

  it('does not apply a mutation twice when the response was lost', async () => {
    server.failNextPushAfterApply();

    const note = await outpost.createNote({ title: 'Only once' });
    await settle(outpost);

    // The client never saw the response, so it still believes it failed.
    expect(outpost.getSyncSnapshot().pending).toBe(1);
    expect(server.notes.get(note.id)?.rev).toBe(1);

    await until(() => outpost.getSyncSnapshot().pending === 0);

    expect(outpost.getSyncSnapshot()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(server.notes.get(note.id)?.rev).toBe(1);
    expect(server.appliedMutations.size).toBe(1);
  });
});

describe('conflicts', () => {
  /**
   * Builds the classic conflict: this device edits offline while the same note
   * is changed on the server by somebody else.
   */
  async function createConflict(): Promise<Note> {
    const note = await outpost.createNote({ title: 'Draft' });
    await settle(outpost);

    online = false;
    await outpost.updateNote(note.id, { title: 'My version', body: 'written offline' });
    await settle(outpost);

    server.externalWrite(note.id, { title: 'Their version', body: 'written elsewhere' });

    online = true;
    await settle(outpost);

    return note;
  }

  it('parks the mutation instead of guessing which version wins', async () => {
    const note = await createConflict();

    const { conflicts } = outpost.getSyncSnapshot();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      noteId: note.id,
      local: { title: 'My version' },
      server: { title: 'Their version' },
    });

    // Nothing was lost: the server keeps its version, we keep ours.
    expect(server.notes.get(note.id)?.title).toBe('Their version');
    expect((await outpost.pendingMutations())[0]).toMatchObject({ blocked: true });
  });

  it('survives a reload', async () => {
    await createConflict();

    const reloaded = await createOutpost({
      dbName,
      api: server.api,
      online: () => online,
      intervalMs: 0,
    });

    expect(reloaded.getSyncSnapshot().conflicts).toHaveLength(1);
  });

  /** Fails the test early instead of relying on a non-null assertion. */
  function firstConflict() {
    const [conflict] = outpost.getSyncSnapshot().conflicts;
    if (!conflict) throw new Error('expected a conflict to be recorded');
    return conflict;
  }

  it('keeps my version and rebases the mutation on the server revision', async () => {
    const note = await createConflict();
    const conflict = firstConflict();

    await outpost.resolveConflict(conflict.mutationId, 'mine');

    expect(outpost.getSyncSnapshot().conflicts).toHaveLength(0);
    expect(outpost.getSyncSnapshot().pending).toBe(0);
    expect(server.notes.get(note.id)).toMatchObject({ title: 'My version', rev: 3 });
    expect(outpost.getSnapshot().notes[0]).toMatchObject({ title: 'My version', rev: 3 });
  });

  it('keeps their version and drops my pending edits', async () => {
    const note = await createConflict();
    const conflict = firstConflict();

    await outpost.resolveConflict(conflict.mutationId, 'theirs');

    expect(outpost.getSyncSnapshot()).toMatchObject({ pending: 0 });
    expect(outpost.getSnapshot().notes[0]).toMatchObject({ title: 'Their version' });
    expect(server.notes.get(note.id)?.title).toBe('Their version');
  });

  it('keeps both versions by creating a copy of the local note', async () => {
    const note = await createConflict();
    const conflict = firstConflict();

    await outpost.resolveConflict(conflict.mutationId, 'both');
    await settle(outpost);

    const notes = outpost.getSnapshot().notes;
    expect(notes).toHaveLength(2);
    expect(notes.find((candidate) => candidate.id === note.id)?.title).toBe('Their version');

    const copy = notes.find((candidate) => candidate.id !== note.id);
    expect(copy).toMatchObject({ title: 'My version (conflicting copy)', rev: 1 });
    if (!copy) throw new Error('expected a conflicting copy to be created');
    expect(server.notes.get(copy.id)).toMatchObject({ title: 'My version (conflicting copy)' });
    expect(server.notes.size).toBe(2);
  });
});
