import { useCallback, useEffect, useState } from 'react';
import type { LocalMutation } from '../../db/schema';
import { clockTime, formatBytes, pluralize } from '../../lib/format';
import { useOutpost, useOutpostState } from '../../store/context';

interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

export interface SyncInspectorProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Observability for the sync engine.
 *
 * Client-side sync bugs are invisible by nature: the UI looks fine while the
 * outbox silently grows. This panel exposes the state the engine actually acts
 * on (outbox contents, cursor, backoff counters), which is also what makes the
 * offline demo convincing.
 */
export function SyncInspector({ open, onClose }: SyncInspectorProps) {
  const outpost = useOutpost();
  const { notes, sync } = useOutpostState();
  const [mutations, setMutations] = useState<LocalMutation[]>([]);
  const [cursor, setCursor] = useState(0);
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  const refresh = useCallback(async () => {
    const [pending, current] = await Promise.all([outpost.pendingMutations(), outpost.getCursor()]);
    setMutations(pending);
    setCursor(current);
    setStorage(await readStorage());
  }, [outpost]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(interval);
  }, [open, refresh, sync]);

  if (!open) return null;

  return (
    <aside className="inspector" aria-label="Sync inspector">
      <header className="inspector__header">
        <h2>Sync inspector</h2>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <dl className="inspector__facts">
        <Fact label="Device" value={outpost.getDeviceId()} />
        <Fact label="Phase" value={`${sync.phase} (${sync.lastReason})`} />
        <Fact label="Pending mutations" value={String(sync.pending)} />
        <Fact label="Failed passes" value={String(sync.failures)} />
        <Fact label="Cursor" value={String(cursor)} />
        <Fact label="Local notes" value={pluralize(notes.length, 'note')} />
        <Fact
          label="Last sync"
          value={sync.lastSyncAt === null ? 'never' : clockTime(sync.lastSyncAt)}
        />
        {sync.lastError !== null && <Fact label="Last error" value={sync.lastError} />}
        {storage !== null && (
          <Fact
            label="Storage"
            value={`${formatBytes(storage.usage)} of ${formatBytes(storage.quota)}${
              storage.persisted ? ' · persistent' : ' · best effort'
            }`}
          />
        )}
      </dl>

      <h3 className="inspector__subtitle">
        Outbox {mutations.length > 0 && <span className="muted">({mutations.length})</span>}
      </h3>

      {mutations.length === 0 ? (
        <p className="muted">Empty — every local change reached the server.</p>
      ) : (
        <table className="inspector__table">
          <thead>
            <tr>
              <th scope="col">kind</th>
              <th scope="col">baseRev</th>
              <th scope="col">tries</th>
              <th scope="col">state</th>
              <th scope="col">note</th>
            </tr>
          </thead>
          <tbody>
            {mutations.map((mutation) => (
              <tr key={mutation.id}>
                <td>{mutation.kind}</td>
                <td>{mutation.baseRev}</td>
                <td>{mutation.attempts}</td>
                <td title={mutation.lastError ?? undefined}>
                  {mutation.blocked ? 'blocked' : mutation.inFlight ? 'in flight' : 'queued'}
                </td>
                <td className="mono">{mutation.noteId.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="inspector__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => void outpost.syncNow()}
        >
          Sync now
        </button>
        <button
          type="button"
          className="button"
          onClick={() => void outpost.resetLocalData()}
          title="Delete every local note and queued mutation"
        >
          Wipe local data
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={() => void outpost.resetServer()}
          title="Danger: also deletes everything on the server"
        >
          Reset server
        </button>
      </div>
    </aside>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </>
  );
}

async function readStorage(): Promise<StorageInfo | null> {
  const manager = globalThis.navigator?.storage;
  if (!manager?.estimate) return null;

  try {
    const estimate = await manager.estimate();
    const persisted = manager.persisted ? await manager.persisted() : false;
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted };
  } catch {
    return null;
  }
}
