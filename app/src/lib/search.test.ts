import { describe, expect, it } from 'vitest';
import type { Note } from '@outpost/shared';
import {
  collectTags,
  inView,
  matchesQuery,
  noteExcerpt,
  noteTitle,
  selectNotes,
  sortNotes,
} from './search';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Title',
    body: 'Body',
    tags: [],
    pinned: false,
    deletedAt: null,
    rev: 1,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('matchesQuery', () => {
  it('matches everything for an empty query', () => {
    expect(matchesQuery(note(), '   ')).toBe(true);
  });

  it('ignores case and diacritics', () => {
    const ședință = note({ title: 'Ședință de echipă' });
    expect(matchesQuery(ședință, 'sedinta')).toBe(true);
    expect(matchesQuery(ședință, 'ECHIPA')).toBe(true);
  });

  it('searches the body and the tags too', () => {
    const candidate = note({ title: 'x', body: 'to buy milk', tags: ['groceries'] });
    expect(matchesQuery(candidate, 'milk')).toBe(true);
    expect(matchesQuery(candidate, 'groce')).toBe(true);
    expect(matchesQuery(candidate, 'nothing')).toBe(false);
  });
});

describe('inView', () => {
  it('separates active, pinned and trashed notes', () => {
    const active = note();
    const pinned = note({ id: 'n2', pinned: true });
    const trashed = note({ id: 'n3', deletedAt: 5 });

    expect(inView(active, 'active')).toBe(true);
    expect(inView(trashed, 'active')).toBe(false);
    expect(inView(pinned, 'pinned')).toBe(true);
    expect(inView(active, 'pinned')).toBe(false);
    expect(inView(trashed, 'trash')).toBe(true);
  });
});

describe('sortNotes', () => {
  it('floats pinned notes to the top, newest first', () => {
    const old = note({ id: 'old', updatedAt: 1 });
    const fresh = note({ id: 'fresh', updatedAt: 3 });
    const pinned = note({ id: 'pinned', updatedAt: 2, pinned: true });

    expect(sortNotes([old, fresh, pinned]).map((item) => item.id)).toEqual([
      'pinned',
      'fresh',
      'old',
    ]);
  });

  it('purely sorts by recency in the trash', () => {
    const older = note({ id: 'older', updatedAt: 1, pinned: true, deletedAt: 1 });
    const newer = note({ id: 'newer', updatedAt: 9, deletedAt: 2 });

    expect(sortNotes([older, newer], 'trash').map((item) => item.id)).toEqual(['newer', 'older']);
  });
});

describe('selectNotes', () => {
  it('combines the view and the query', () => {
    const notes = [
      note({ id: 'a', title: 'Alpha' }),
      note({ id: 'b', title: 'Beta' }),
      note({ id: 'c', title: 'Alpha in trash', deletedAt: 1 }),
    ];

    expect(selectNotes(notes, '', 'active').map((item) => item.id)).toEqual(['a', 'b']);
    expect(selectNotes(notes, 'alpha', 'active').map((item) => item.id)).toEqual(['a']);
    expect(selectNotes(notes, '', 'trash').map((item) => item.id)).toEqual(['c']);
  });
});

describe('collectTags', () => {
  it('deduplicates, sorts and ignores the trash', () => {
    const notes = [
      note({ id: 'a', tags: ['work', 'sync'] }),
      note({ id: 'b', tags: ['sync', 'ideas'] }),
      note({ id: 'c', tags: ['trashed'], deletedAt: 1 }),
    ];

    expect(collectTags(notes)).toEqual(['ideas', 'sync', 'work']);
  });
});

describe('titles and excerpts', () => {
  it('falls back to a placeholder title', () => {
    expect(noteTitle(note({ title: '   ' }))).toBe('Untitled note');
    expect(noteTitle(note({ title: 'Real' }))).toBe('Real');
  });

  it('collapses whitespace and truncates the excerpt', () => {
    expect(noteExcerpt(note({ body: '  a\n\nb  ' }))).toBe('a b');
    expect(noteExcerpt(note({ body: '' }))).toBe('No content yet');
    expect(noteExcerpt(note({ body: 'x'.repeat(200) }), 10)).toBe('xxxxxxxxxx…');
  });
});
