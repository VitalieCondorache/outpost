import type { Note } from '@outpost/shared';

export type NotesView = 'active' | 'pinned' | 'trash';

/**
 * Diacritics-insensitive, case-insensitive normalisation: typing "sedinta"
 * should find "Ședință". NFD splits letters from their accents, then we strip
 * the combining marks.
 */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function matchesQuery(note: Note, query: string): boolean {
  const needle = normalize(query.trim());
  if (needle.length === 0) return true;
  if (normalize(note.title).includes(needle)) return true;
  if (normalize(note.body).includes(needle)) return true;
  return note.tags.some((tag) => normalize(tag).includes(needle));
}

export function inView(note: Note, view: NotesView): boolean {
  if (view === 'trash') return note.deletedAt !== null;
  if (note.deletedAt !== null) return false;
  return view === 'pinned' ? note.pinned : true;
}

/** Newest first, with pinned notes floating to the top outside the trash view. */
export function sortNotes(notes: Note[], view: NotesView = 'active'): Note[] {
  return [...notes].sort((a, b) => {
    if (view !== 'trash' && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

export function selectNotes(notes: Note[], query: string, view: NotesView): Note[] {
  return sortNotes(
    notes.filter((note) => inView(note, view) && matchesQuery(note, query)),
    view,
  );
}

export function collectTags(notes: Note[]): string[] {
  const tags = new Set<string>();
  for (const note of notes) {
    if (note.deletedAt !== null) continue;
    for (const tag of note.tags) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

export function noteTitle(note: Note): string {
  const title = note.title.trim();
  return title.length > 0 ? title : 'Untitled note';
}

export function noteExcerpt(note: Note, length = 90): string {
  const body = note.body.replace(/\s+/g, ' ').trim();
  if (body.length === 0) return 'No content yet';
  return body.length > length ? `${body.slice(0, length)}…` : body;
}
