import { describe, expect, it } from 'vitest';
import type { Note } from '@outpost/shared';
import { buildMutation, resolveKind, toWireMutation } from './mutations';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Title',
    body: 'Body',
    tags: ['a'],
    pinned: false,
    deletedAt: null,
    rev: 0,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('resolveKind', () => {
  it('is a create while the note has never been on the server', () => {
    expect(resolveKind(note(), note({ rev: 0 }))).toBe('create');
  });

  it('is an update for an edit of a synced note', () => {
    expect(resolveKind(note({ rev: 2 }), note({ rev: 2 }))).toBe('update');
  });

  it('is a delete when a live note moves to the trash', () => {
    expect(resolveKind(note({ deletedAt: 5_000, rev: 2 }), note({ rev: 2 }))).toBe('delete');
  });

  it('is an update when a trashed note is restored', () => {
    expect(resolveKind(note({ rev: 3 }), note({ deletedAt: 5_000, rev: 3 }))).toBe('update');
  });
});

describe('buildMutation', () => {
  it('bases the mutation on the revision the client last saw', () => {
    const mutation = buildMutation(note({ rev: 4, title: 'edited' }), note({ rev: 4 }), {
      deviceId: 'd1',
      now: 42,
      newMutationId: () => 'm1',
    });

    expect(mutation).toMatchObject({
      id: 'm1',
      noteId: 'n1',
      kind: 'update',
      baseRev: 4,
      createdAt: 42,
      attempts: 0,
      inFlight: false,
      blocked: false,
    });
  });

  it('carries the full note state in the payload, tombstone included', () => {
    const mutation = buildMutation(
      note({ rev: 2, title: 'new', tags: ['x', 'y'], pinned: true, deletedAt: 99 }),
      note({ rev: 2 }),
      { deviceId: 'd1', newMutationId: () => 'm2' },
    );

    expect(mutation.payload).toEqual({
      title: 'new',
      body: 'Body',
      tags: ['x', 'y'],
      pinned: true,
      deletedAt: 99,
    });
  });

  it('produces a create for an offline note', () => {
    const mutation = buildMutation(note(), note({ rev: 0 }), {
      deviceId: 'd1',
      newMutationId: () => 'm3',
    });

    expect(mutation.kind).toBe('create');
    expect(mutation.baseRev).toBe(0);
  });
});

describe('toWireMutation', () => {
  it('sends the protocol shape only, without local bookkeeping', () => {
    const mutation = buildMutation(note({ rev: 1 }), note({ rev: 1 }), {
      deviceId: 'd1',
      newMutationId: () => 'm4',
    });
    const wire = toWireMutation({ ...mutation, attempts: 3, inFlight: true, blocked: true });

    expect(Object.keys(wire).sort()).toEqual([
      'baseRev',
      'createdAt',
      'id',
      'kind',
      'noteId',
      'payload',
    ]);
  });
});
