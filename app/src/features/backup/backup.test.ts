import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '@outpost/shared';
import { deleteOutpostDb } from '../../db/open-db';
import { createOutpost } from '../../store/create-outpost';
import type { Outpost } from '../../store/outpost';
import { createFakeServer, type FakeServer } from '../../test/fake-server';
import {
  BACKUP_VERSION,
  backupFilename,
  createBackup,
  parseBackup,
  serializeBackup,
} from './backup';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Title',
    body: 'Body',
    tags: ['tag'],
    pinned: false,
    deletedAt: null,
    rev: 3,
    updatedAt: 1_000,
    ...overrides,
  };
}

/**
 * `syncNow()` resolves as soon as the pass in flight is done; a pass queued
 * behind it (a local change that triggered its own sync) may still be pending.
 * Draining in a loop is the deterministic way to wait for an empty outbox.
 */
async function settle(outpost: Outpost): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await outpost.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('createBackup / serializeBackup / parseBackup', () => {
  it('round-trips notes unchanged', () => {
    const backup = createBackup([note(), note({ id: 'n2', pinned: true })], {
      deviceId: 'device-a',
      now: 42,
    });

    expect(backup).toMatchObject({
      app: 'outpost',
      version: BACKUP_VERSION,
      exportedAt: 42,
      device: 'device-a',
    });

    const parsed = parseBackup(serializeBackup(backup));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.notes).toHaveLength(2);
    expect(parsed.value.notes[1]).toMatchObject({ id: 'n2', pinned: true });
  });

  it('never imports a revision: a restored note has to earn one', () => {
    const parsed = parseBackup(
      serializeBackup(createBackup([note({ rev: 7 })], { deviceId: 'd' })),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.notes[0]?.rev).toBe(0);
  });

  it('keeps tombstones so a restore cannot resurrect a deleted note', () => {
    const parsed = parseBackup(
      serializeBackup(createBackup([note({ deletedAt: 9_999 })], { deviceId: 'd' })),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.notes[0]?.deletedAt).toBe(9_999);
  });

  it.each([
    ['not JSON at all', 'nope{'],
    ['a JSON array', '[]'],
    ['another app', '{"app":"other","version":1,"notes":[]}'],
    ['a newer version', '{"app":"outpost","version":99,"notes":[]}'],
    ['a missing notes array', '{"app":"outpost","version":1}'],
    ['a malformed note', '{"app":"outpost","version":1,"notes":[{"id":"n1","title":1,"body":""}]}'],
    [
      'tags that are not strings',
      '{"app":"outpost","version":1,"notes":[{"id":"n1","title":"t","body":"","tags":[3]}]}',
    ],
  ])('rejects %s', (_label, json) => {
    const parsed = parseBackup(json);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.length).toBeGreaterThan(0);
  });
});

describe('backupFilename', () => {
  it('is dated and sorted', () => {
    expect(backupFilename(Date.UTC(2026, 0, 5))).toBe('outpost-2026-01-05.json');
  });
});

describe('importing a backup into the store', () => {
  let server: FakeServer;
  let outpost: Outpost;
  let dbName: string;

  async function openOutpost(): Promise<Outpost> {
    dbName = `outpost-backup-${Math.random().toString(36).slice(2)}`;
    return createOutpost({ dbName, api: server.api, online: () => true, intervalMs: 0 });
  }

  beforeEach(async () => {
    server = createFakeServer();
    outpost = await openOutpost();
  });

  afterEach(async () => {
    await deleteOutpostDb(dbName);
  });

  it('creates unknown notes and updates known ones', async () => {
    const existing = await outpost.createNote({ title: 'Local' });
    const backup = createBackup(
      [
        note({ id: existing.id, title: 'From the file', rev: 1 }),
        note({ id: 'imported', title: 'Brand new', rev: 4 }),
      ],
      { deviceId: 'usb-stick' },
    );

    const result = await outpost.importNotes(backup.notes);

    expect(result).toEqual({ created: 1, updated: 1 });
    const titles = outpost
      .getSnapshot()
      .notes.map((candidate) => candidate.title)
      .sort();
    expect(titles).toEqual(['Brand new', 'From the file']);

    // Imported notes sync like any other local change.
    await settle(outpost);
    expect(server.notes.get('imported')?.title).toBe('Brand new');
    expect(server.notes.get(existing.id)?.title).toBe('From the file');
  });

  it('restores a trashed note and syncs the tombstone away', async () => {
    const created = await outpost.createNote({ title: 'Keep me' });
    await outpost.trashNote(created.id);

    await outpost.importNotes(
      createBackup([note({ id: created.id, title: 'Keep me', rev: 1 })], { deviceId: 'usb-stick' })
        .notes,
    );

    expect(outpost.getSnapshot().notes[0]?.deletedAt).toBeNull();
    expect(server.notes.get(created.id)?.deletedAt).toBeNull();
  });

  it('round-trips a whole database from one device to another', async () => {
    await outpost.createNote({ title: 'Alpha', body: 'first' });
    await outpost.createNote({ title: 'Beta', body: 'second' });
    const backup = createBackup(outpost.getNotes(), { deviceId: outpost.getDeviceId() });

    const other = await openOutpost();
    const result = await other.importNotes(parseAndGetNotes(serializeBackup(backup)));

    expect(result.created).toBe(2);
    expect(
      other
        .getNotes()
        .map((candidate) => candidate.title)
        .sort(),
    ).toEqual(['Alpha', 'Beta']);
  });
});

function parseAndGetNotes(json: string): Note[] {
  const parsed = parseBackup(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.notes;
}
