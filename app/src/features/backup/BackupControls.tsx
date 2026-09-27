import { useRef, useState } from 'react';
import { downloadFile, readFileText } from '../../lib/files';
import { useOutpost, useOutpostState } from '../../store/context';
import { backupFilename, createBackup, parseBackup, serializeBackup } from './backup';

/**
 * Backup is a data-safety feature, not a developer tool: it lives next to the
 * notes, not inside the sync inspector.
 *
 * The import intentionally goes through the ordinary local-change pipeline, so a
 * restored note syncs (and can conflict) exactly like a typed one.
 */
export function BackupControls() {
  const outpost = useOutpost();
  const { notes } = useOutpostState();
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportNotes = () => {
    const backup = createBackup(notes, { deviceId: outpost.getDeviceId() });
    const saved = downloadFile(backupFilename(backup.exportedAt), serializeBackup(backup));

    setMessage(
      saved
        ? `Exported ${notes.length} note${notes.length === 1 ? '' : 's'}`
        : 'This browser blocked the download',
    );
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;

    setBusy(true);
    try {
      const parsed = parseBackup(await readFileText(file));
      if (!parsed.ok) {
        setMessage(parsed.error);
        return;
      }

      const { created, updated } = await outpost.importNotes(parsed.value.notes);
      setMessage(
        `Imported ${created} new and ${updated} updated note${created + updated === 1 ? '' : 's'}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'the file could not be read');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backup">
      <div className="backup__actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={exportNotes}
          title="Download every note as JSON"
        >
          Export .json
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          title="Restore notes from a backup file"
        >
          {busy ? 'Reading…' : 'Import…'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          aria-label="Import a backup file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Allow re-selecting the same file after a failed import.
            event.target.value = '';
            void importFile(file);
          }}
        />
      </div>

      {message !== null && (
        <p className="backup__message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
