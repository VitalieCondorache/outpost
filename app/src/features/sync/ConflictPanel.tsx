import { noteTitle } from '../../lib/search';
import { useOutpost, useOutpostState } from '../../store/context';

const OPTIONS = [
  { choice: 'mine', label: 'Keep mine', hint: 'Overwrite the server copy on the next push' },
  { choice: 'theirs', label: 'Keep theirs', hint: 'Drop my edits for this note' },
  { choice: 'both', label: 'Keep both', hint: 'Server copy stays, mine becomes a new note' },
] as const;

/**
 * Conflict resolution is a product decision, not a background policy: the app
 * refuses to guess which version of a note the user wants to keep. This panel
 * is the only place where data can be discarded, and it says so.
 */
export function ConflictPanel() {
  const outpost = useOutpost();
  const { sync } = useOutpostState();

  if (sync.conflicts.length === 0) return null;

  return (
    <section className="conflict" role="alertdialog" aria-label="Sync conflicts">
      <header className="conflict__header">
        <h2>
          {sync.conflicts.length === 1 ? 'A note was edited twice' : 'Some notes were edited twice'}
        </h2>
        <p>
          The same note changed on another device while this one was offline. Nothing was
          overwritten — pick which version should win.
        </p>
      </header>

      <ul className="conflict__list">
        {sync.conflicts.map((conflict) => (
          <li key={conflict.mutationId} className="conflict__item">
            <h3>{conflict.local ? noteTitle(conflict.local) : 'Deleted note'}</h3>

            <div className="conflict__versions">
              <VersionColumn
                label="This device"
                text={conflict.local?.body ?? ''}
                title={conflict.local?.title ?? ''}
                missing="No local copy"
              />
              <VersionColumn
                label="Server"
                text={conflict.server?.body ?? ''}
                title={conflict.server?.title ?? ''}
                missing="The server has no copy"
              />
            </div>

            <div className="conflict__actions">
              {OPTIONS.map((option) => (
                <button
                  key={option.choice}
                  type="button"
                  className={option.choice === 'mine' ? 'button button--primary' : 'button'}
                  title={option.hint}
                  onClick={() => void outpost.resolveConflict(conflict.mutationId, option.choice)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VersionColumn({
  label,
  text,
  title,
  missing,
}: {
  label: string;
  text: string;
  title: string;
  missing: string;
}) {
  const hasContent = title.trim().length > 0 || text.trim().length > 0;

  return (
    <article className="version">
      <h4>{label}</h4>
      {hasContent ? (
        <>
          <p className="version__title">{title.trim().length > 0 ? title : 'Untitled note'}</p>
          <pre className="version__body">{excerpt(text)}</pre>
        </>
      ) : (
        <p className="version__missing">{missing}</p>
      )}
    </article>
  );
}

function excerpt(text: string, length = 160): string {
  const cleaned = text.trim();
  if (cleaned.length === 0) return '(empty)';
  return cleaned.length > length ? `${cleaned.slice(0, length)}…` : cleaned;
}
