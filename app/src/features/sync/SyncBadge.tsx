import { pluralize } from '../../lib/format';
import { relativeTime } from '../../lib/format';
import type { SyncSnapshot } from '../../sync/engine';
import { useOutpost, useOutpostState } from '../../store/context';

export type BadgeTone = 'ok' | 'busy' | 'offline' | 'error';

export interface BadgeDescription {
  label: string;
  tone: BadgeTone;
}

/** Pure so it can be unit tested without rendering the app. */
export function describeSync(sync: SyncSnapshot): BadgeDescription {
  if (sync.conflicts.length > 0) {
    return { label: `${pluralize(sync.conflicts.length, 'conflict')} to resolve`, tone: 'error' };
  }
  if (sync.phase === 'syncing') return { label: 'Syncing…', tone: 'busy' };
  if (sync.phase === 'offline') {
    return {
      label: sync.pending > 0 ? `Offline · ${pluralize(sync.pending, 'change')} queued` : 'Offline',
      tone: 'offline',
    };
  }
  if (sync.phase === 'error') {
    return {
      label: `Sync failed · retrying (${pluralize(sync.failures, 'attempt')})`,
      tone: 'error',
    };
  }
  if (sync.pending > 0) {
    return { label: `${pluralize(sync.pending, 'change')} to sync`, tone: 'busy' };
  }
  return {
    label: sync.lastSyncAt === null ? 'Synced' : `Synced ${relativeTime(sync.lastSyncAt)}`,
    tone: 'ok',
  };
}

export function SyncBadge() {
  const outpost = useOutpost();
  const { sync } = useOutpostState();
  const { label, tone } = describeSync(sync);

  return (
    <button
      type="button"
      className={`badge badge--${tone}`}
      onClick={() => void outpost.syncNow()}
      title="Force a sync pass"
      aria-live="polite"
    >
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </button>
  );
}
