import type { Note } from '@outpost/shared';
import { relativeTime } from '../../lib/format';
import { noteExcerpt, noteTitle, type NotesView } from '../../lib/search';
import { useOutpost } from '../../store/context';

export interface NoteListProps {
  notes: Note[];
  selectedId: string | null;
  view: NotesView;
  onSelect: (id: string) => void;
}

export function NoteList({ notes, selectedId, view, onSelect }: NoteListProps) {
  const outpost = useOutpost();

  if (notes.length === 0) {
    return (
      <p className="list__empty">
        {view === 'trash' ? 'Trash is empty.' : 'No notes here yet — press ⌘N to write one.'}
      </p>
    );
  }

  return (
    <ul className="list">
      {notes.map((note) => {
        const selected = note.id === selectedId;
        const unsynced = note.rev === 0;

        return (
          <li key={note.id} className={`note${selected ? ' note--selected' : ''}`}>
            <button
              type="button"
              className="note__main"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(note.id)}
            >
              <span className="note__row">
                {note.pinned && (
                  <span className="note__pin" aria-label="Pinned" title="Pinned">
                    ★
                  </span>
                )}
                <span className="note__title">{noteTitle(note)}</span>
                {unsynced && (
                  <span
                    className="note__dot"
                    aria-label="Not synced yet"
                    title="Only on this device"
                  />
                )}
              </span>
              <span className="note__excerpt">{noteExcerpt(note)}</span>
              <span className="note__meta">
                {relativeTime(note.updatedAt)}
                {note.tags.length > 0 && ` · ${note.tags.join(' · ')}`}
              </span>
            </button>

            <span className="note__actions">
              {view === 'trash' ? (
                <>
                  <button
                    type="button"
                    className="icon"
                    title="Restore note"
                    aria-label="Restore note"
                    onClick={() => void outpost.restoreNote(note.id)}
                  >
                    ↺
                  </button>
                  <button
                    type="button"
                    className="icon icon--danger"
                    title="Delete forever"
                    aria-label="Delete forever"
                    onClick={() => void outpost.deleteForever(note.id)}
                  >
                    ×
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="icon"
                    title={note.pinned ? 'Unpin' : 'Pin'}
                    aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
                    onClick={() => void outpost.togglePin(note.id)}
                  >
                    {note.pinned ? '☆' : '★'}
                  </button>
                  <button
                    type="button"
                    className="icon icon--danger"
                    title="Move to trash"
                    aria-label="Move note to trash"
                    onClick={() => void outpost.trashNote(note.id)}
                  >
                    ␡
                  </button>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
