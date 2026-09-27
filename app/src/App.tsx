import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '@outpost/shared';
import { BackupControls } from './features/backup/BackupControls';
import { NoteEditor } from './features/notes/NoteEditor';
import { NoteList } from './features/notes/NoteList';
import { InstallPrompt } from './features/pwa/InstallPrompt';
import { ConflictPanel } from './features/sync/ConflictPanel';
import { SyncBadge } from './features/sync/SyncBadge';
import { SyncInspector } from './features/sync/SyncInspector';
import { collectTags, inView, selectNotes, type NotesView } from './lib/search';
import { useHotkeys } from './lib/use-hotkeys';
import { useOutpost, useOutpostState } from './store/context';

const VIEWS: Array<{ id: NotesView; label: string }> = [
  { id: 'active', label: 'Notes' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'trash', label: 'Trash' },
];

export function App() {
  const outpost = useOutpost();
  const { notes, ready } = useOutpostState();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<NotesView>('active');
  const [tag, setTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => outpost.start(), [outpost]);

  const visible = useMemo(() => {
    const filtered = selectNotes(notes, query, view);
    return tag === null ? filtered : filtered.filter((note) => note.tags.includes(tag));
  }, [notes, query, view, tag]);

  // Keep a sensible selection as the list changes around the user.
  useEffect(() => {
    const stillVisible = selectedId !== null && visible.some((note) => note.id === selectedId);
    if (stillVisible) return;
    const next = visible[0]?.id ?? null;
    if (next !== selectedId) setSelectedId(next);
  }, [selectedId, visible]);

  const selected = useMemo(
    () => visible.find((note) => note.id === selectedId) ?? null,
    [visible, selectedId],
  );
  const tags = useMemo(() => collectTags(notes), [notes]);

  const createNote = async () => {
    const note = await outpost.createNote();
    setView('active');
    setQuery('');
    setTag(null);
    setSelectedId(note.id);
  };

  useHotkeys([
    { key: 'k', meta: true, handler: () => searchRef.current?.focus() },
    { key: 'n', meta: true, handler: () => void createNote() },
    { key: 'i', meta: true, handler: () => setInspectorOpen((open) => !open) },
  ]);

  if (!ready) {
    return <p className="loading">Opening the local database…</p>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">
          <span className="brand__mark" aria-hidden="true" />
          Outpost
        </h1>
        <p className="topbar__tagline muted">Offline-first notes</p>
        <SyncBadge />
      </header>

      <aside className="sidebar">
        <div className="sidebar__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => void createNote()}
          >
            New note <kbd>⌘N</kbd>
          </button>
          <InstallPrompt />
        </div>

        <div className="search">
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search notes…  ⌘K"
            aria-label="Search notes"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
                event.currentTarget.blur();
              }
            }}
          />
        </div>

        <nav className="tabs" aria-label="Views">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`tab${view === item.id ? ' tab--active' : ''}`}
              aria-pressed={view === item.id}
              onClick={() => {
                setView(item.id);
                setTag(null);
              }}
            >
              {item.label}
              <span className="tab__count">{countFor(item.id, notes)}</span>
            </button>
          ))}
        </nav>

        {tags.length > 0 && (
          <div className="tags" aria-label="Filter by tag">
            {tags.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={`tag${tag === candidate ? ' tag--active' : ''}`}
                aria-pressed={tag === candidate}
                onClick={() => setTag(tag === candidate ? null : candidate)}
              >
                #{candidate}
              </button>
            ))}
          </div>
        )}

        <NoteList notes={visible} selectedId={selectedId} view={view} onSelect={setSelectedId} />

        <footer className="sidebar__footer">
          <BackupControls />
          <button
            type="button"
            className="button button--ghost"
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            {inspectorOpen ? 'Hide inspector' : 'Sync inspector'}
          </button>
          <span className="muted mono">device {outpost.getDeviceId()}</span>
        </footer>
      </aside>

      <main className="main">
        <ConflictPanel />
        <NoteEditor note={selected} />
      </main>

      <SyncInspector open={inspectorOpen} onClose={() => setInspectorOpen(false)} />
    </div>
  );
}

function countFor(view: NotesView, notes: Note[]): number {
  return notes.filter((note) => inView(note, view)).length;
}
