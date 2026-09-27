import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, NoteInput } from '@outpost/shared';
import { relativeTime } from '../../lib/format';
import { useOutpost } from '../../store/context';

const SAVE_DEBOUNCE_MS = 400;

/**
 * The editor writes to the draft state immediately and to IndexedDB after a short
 * debounce. Waiting for the network is never part of the flow — that is the whole
 * point of a local-first app.
 */
export function NoteEditor({ note }: { note: Note | null }) {
  if (note === null) {
    return (
      <section className="editor editor--empty">
        <h2>Nothing selected</h2>
        <p>
          Create a note with ⌘N or pick one from the list. Every keystroke lands in IndexedDB first,
          so the network can never block you.
        </p>
      </section>
    );
  }

  // `key` remounts the form when the selected note changes, so the draft state is
  // initialised during render instead of being reset by an effect after the
  // commit. A post-commit reset has a window in which it wipes keystrokes typed in
  // between — the classic way to lose the first characters the user types.
  return <NoteForm key={note.id} note={note} />;
}

function NoteForm({ note }: { note: Note }) {
  const outpost = useOutpost();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(', '));
  const [saving, setSaving] = useState(false);

  const pendingRef = useRef<Partial<NoteInput>>({});
  const timerRef = useRef<number | null>(null);

  /** Writes whatever is pending, even if the debounce has not elapsed yet. */
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const accumulated = pendingRef.current;
    pendingRef.current = {};
    setSaving(false);

    if (Object.keys(accumulated).length > 0) {
      void outpost.updateNote(note.id, accumulated);
    }
  }, [note.id, outpost]);

  /** Merges the patch with the previous ones so fast typing never loses a field. */
  const queue = useCallback(
    (patch: Partial<NoteInput>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      setSaving(true);

      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Switching notes (or closing the tab) must not drop the debounced keystrokes.
  // Updates to the *same* note coming from elsewhere are deliberately not adopted,
  // so nothing the user is typing gets overwritten from underneath them.
  useEffect(() => () => flush(), [flush]);

  const trashed = note.deletedAt !== null;

  return (
    <section className="editor">
      <header className="editor__header">
        <input
          className="editor__title"
          value={title}
          placeholder="Untitled note"
          aria-label="Note title"
          onChange={(event) => {
            setTitle(event.target.value);
            queue({ title: event.target.value });
          }}
        />
        <p className="editor__status">
          <span className="muted">
            {saving ? 'Saving locally…' : `Saved locally ${relativeTime(note.updatedAt)}`}
          </span>
          {note.rev === 0 ? (
            <span className="pill pill--warn" title="Waiting for the first sync">
              not synced
            </span>
          ) : (
            <span className="pill" title="Server revision">
              rev {note.rev}
            </span>
          )}
          {trashed && <span className="pill pill--warn">in trash</span>}
        </p>
      </header>

      <label className="editor__tags">
        <span className="editor__tags-label">Tags</span>
        <input
          value={tags}
          placeholder="work, ideas, offline"
          aria-label="Tags, comma separated"
          onChange={(event) => {
            setTags(event.target.value);
            queue({ tags: parseTags(event.target.value) });
          }}
        />
      </label>

      <textarea
        className="editor__body"
        value={body}
        placeholder="Write anything. Airplane mode is fine."
        aria-label="Note body"
        onChange={(event) => {
          setBody(event.target.value);
          queue({ body: event.target.value });
        }}
      />

      <footer className="editor__footer">
        {trashed ? (
          <button
            type="button"
            className="button"
            onClick={() => void outpost.restoreNote(note.id)}
          >
            Restore from trash
          </button>
        ) : (
          <button type="button" className="button" onClick={() => void outpost.trashNote(note.id)}>
            Move to trash
          </button>
        )}
        <span className="muted">IndexedDB first · pushed to the API in the background</span>
      </footer>
    </section>
  );
}

export function parseTags(value: string): string[] {
  const tags = value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return [...new Set(tags)];
}
