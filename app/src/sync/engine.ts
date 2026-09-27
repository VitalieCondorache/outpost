import type { Note, SyncResponse } from '@outpost/shared';
import type { NotesRepo } from '../db/repo';
import type { LocalMutation } from '../db/schema';
import { debug } from '../lib/debug';
import { newId } from '../lib/id';
import type { SyncApi } from './api';
import { nextRetryDelayMs } from './backoff';
import { buildMutation, toWireMutation } from './mutations';

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error';

export type SyncReason =
  | 'start'
  | 'online'
  | 'manual'
  | 'local-change'
  | 'retry'
  | 'drain'
  | 'interval'
  | 'queued'
  | 'after-conflict';

/** A mutation that lost the optimistic-concurrency race and needs a decision. */
export interface ConflictRecord {
  mutationId: string;
  noteId: string;
  local: Note | null;
  server: Note | null;
  detectedAt: number;
}

export type ConflictChoice = 'mine' | 'theirs' | 'both';

export interface SyncSnapshot {
  phase: SyncPhase;
  /** Why the last pass ran — handy in the inspector when debugging. */
  lastReason: SyncReason;
  /** Mutations that still have to reach the server. */
  pending: number;
  lastSyncAt: number | null;
  lastError: string | null;
  /** Consecutive failed passes; drives the backoff and the badge. */
  failures: number;
  conflicts: ConflictRecord[];
}

export interface SyncEngineOptions {
  repo: NotesRepo;
  api: SyncApi;
  deviceId: string;
  now?: () => number;
  random?: () => number;
  /** Defaults to `navigator.onLine`, injectable for tests. */
  online?: () => boolean;
  /** Idle sync interval; `0` disables the periodic pass. */
  intervalMs?: number;
  batchSize?: number;
  maxPasses?: number;
  /** Called whenever notes changed locally as a result of syncing. */
  onChanged?: () => void | Promise<void>;
  /** Lets the platform (Background Sync) wake the app up later. */
  onRequestBackgroundSync?: () => void;
}

const EMPTY_SNAPSHOT: SyncSnapshot = {
  phase: 'idle',
  lastReason: 'start',
  pending: 0,
  lastSyncAt: null,
  lastError: null,
  failures: 0,
  conflicts: [],
};

/**
 * The sync engine.
 *
 * It is deliberately framework-free and dependency-injected: `now`, `random`,
 * `online`, the repository and the API client are all replaceable, which is what
 * makes the interesting scenarios (retry after a failure, conflict, airplane
 * mode) testable without mocking half of the browser.
 */
export class SyncEngine {
  private readonly repo: NotesRepo;
  private readonly api: SyncApi;
  private readonly deviceId: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly online: () => boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxPasses: number;
  private readonly onChanged?: () => void | Promise<void>;
  private readonly onRequestBackgroundSync?: () => void;

  private readonly listeners = new Set<() => void>();
  private snapshot: SyncSnapshot = EMPTY_SNAPSHOT;
  private conflicts: ConflictRecord[] = [];
  private failures = 0;
  private running = false;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: SyncEngineOptions) {
    this.repo = options.repo;
    this.api = options.api;
    this.deviceId = options.deviceId;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.online = options.online ?? (() => globalThis.navigator?.onLine !== false);
    this.intervalMs = options.intervalMs ?? 30_000;
    this.batchSize = options.batchSize ?? 25;
    this.maxPasses = options.maxPasses ?? 10;
    this.onChanged = options.onChanged;
    this.onRequestBackgroundSync = options.onRequestBackgroundSync;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  /** Restores the persisted view of the sync state (survives a reload). */
  async hydrate(): Promise<void> {
    const [pending, lastSyncAt, conflicts] = await Promise.all([
      this.repo.countPending(),
      this.repo.getLastSyncAt(),
      this.repo.getConflicts<ConflictRecord>(),
    ]);

    this.conflicts = conflicts;
    this.patch({
      pending,
      lastSyncAt,
      conflicts,
      phase: this.online() ? 'idle' : 'offline',
    });
  }

  /**
   * Wires the browser events that should trigger a sync and performs the first
   * pass. Returns a disposer so React effects can be idempotent.
   */
  start(): () => void {
    const onOnline = () => void this.sync('online');
    const onOffline = () => {
      this.clearTimer();
      this.patch({ phase: 'offline' });
    };

    globalThis.addEventListener?.('online', onOnline);
    globalThis.addEventListener?.('offline', onOffline);
    void this.sync('start');

    return () => {
      globalThis.removeEventListener?.('online', onOnline);
      globalThis.removeEventListener?.('offline', onOffline);
      this.clearTimer();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.listeners.clear();
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  /** The raw outbox, for the sync inspector. */
  pendingMutations(): Promise<LocalMutation[]> {
    return this.repo.listOutbox();
  }

  private patch(partial: Partial<SyncSnapshot>): void {
    const next: SyncSnapshot = { ...this.snapshot, ...partial };
    if (isSameSnapshot(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  async sync(reason: SyncReason = 'manual'): Promise<SyncSnapshot> {
    if (this.disposed) return this.snapshot;

    if (this.running) {
      // Coalesce concurrent requests: one more pass after the current one.
      this.queued = true;
      return this.snapshot;
    }

    if (!this.online()) {
      this.clearTimer();
      // Refresh the queue length: the badge must show what is waiting even when
      // no sync pass ever runs.
      this.patch({ phase: 'offline', pending: await this.repo.countPending() });
      return this.snapshot;
    }

    this.running = true;
    this.clearTimer();
    this.patch({ phase: 'syncing', lastError: null, lastReason: reason });

    let claimed: LocalMutation[] = [];
    let pushed = 0;

    try {
      const cursor = await this.repo.getCursor();
      debug('sync start', reason, 'cursor=', cursor);
      // Push in passes. A note whose mutation was applied gets a new revision,
      // which the *next* mutation of that note needs as its baseRev — that is
      // why a chain may take several passes.
      for (let pass = 0; pass < this.maxPasses; pass += 1) {
        const batch = await this.repo.takeBatch(this.batchSize, this.now());
        claimed = batch;
        if (batch.length === 0) {
          claimed = [];
          break;
        }

        const response = await this.api.push({
          deviceId: this.deviceId,
          mutations: batch.map(toWireMutation),
        });

        debug(
          'sync pushed',
          batch.map((m) => `${m.kind}:${m.id.slice(0, 4)}:base=${m.baseRev}`).join(' '),
          '->',
          response.results
            .map((r) => `${r.status}:${r.id.slice(0, 4)}:rev=${r.rev ?? '-'}`)
            .join(' '),
        );

        pushed += batch.length;
        await this.applyResults(batch, response);
        claimed = [];
      }

      // Then pull what the other devices (and our own earlier sessions) wrote.
      const pulled = await this.api.pull(cursor);
      debug(
        'sync pulled',
        pulled.cursor,
        pulled.notes.map((n) => `${n.id.slice(0, 4)}:rev${n.rev}:"${n.title}"`).join(' '),
      );
      await this.repo.applyServerNotes(pulled.notes);
      await this.repo.setCursor(pulled.cursor);

      // A pass that sent nothing (everything was waiting for its retry delay)
      // must not look like a healthy one: the failure state stays until a
      // mutation actually lands.
      if (pushed > 0) this.failures = 0;

      const timestamp = this.now();
      await this.repo.setLastSyncAt(timestamp);
      this.patch({
        phase: this.failures > 0 ? 'error' : 'idle',
        lastSyncAt: timestamp,
        lastError: this.failures > 0 ? this.snapshot.lastError : null,
        failures: this.failures,
        pending: await this.repo.countPending(),
      });
      await this.onChanged?.();
      this.scheduleNext();
      return this.snapshot;
    } catch (error) {
      const message = describeError(error);
      this.failures += 1;
      // The claimed mutations go back to the outbox with a retry delay; their
      // ids stay the same, so the server can deduplicate a retried push.
      await this.repo.penalize(
        claimed.map((mutation) => mutation.id),
        {
          reason: message,
          retryInMs: nextRetryDelayMs(this.failures, this.random),
          now: this.now(),
        },
      );

      this.patch({
        phase: this.online() ? 'error' : 'offline',
        lastError: message,
        failures: this.failures,
        pending: await this.repo.countPending(),
      });
      this.onRequestBackgroundSync?.();
      this.scheduleNext();
      return this.snapshot;
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        void this.sync('queued');
      }
    }
  }

  private async applyResults(batch: LocalMutation[], response: SyncResponse): Promise<void> {
    const claimed = new Map(batch.map((mutation) => [mutation.id, mutation]));
    let conflictAdded = false;

    for (const result of response.results) {
      const mutation = claimed.get(result.id);
      if (!mutation) continue;

      if (result.status === 'applied') {
        await this.repo.settle(result.id, result.server ?? null);
        if (result.server) {
          await this.repo.bumpChainBaseRev(mutation.noteId, result.server.rev);
        }
        continue;
      }

      if (result.status === 'conflict') {
        // Do not drop the local edit and do not overwrite the server one: keep
        // the mutation parked (blocked) until the user picks a resolution.
        await this.repo.updateMutation(result.id, {
          inFlight: false,
          blocked: true,
          lastError: result.message ?? 'conflict',
        });
        this.conflicts = [
          ...this.conflicts,
          {
            mutationId: result.id,
            noteId: mutation.noteId,
            local: await this.repo.getNote(mutation.noteId),
            server: result.server ?? null,
            detectedAt: this.now(),
          },
        ];
        await this.repo.setConflicts(this.conflicts);
        conflictAdded = true;
        continue;
      }

      await this.repo.failMutation(
        result.id,
        result.message ?? 'the server rejected this mutation',
      );
    }

    if (conflictAdded) {
      this.patch({ conflicts: this.conflicts, pending: await this.repo.countPending() });
      await this.onChanged?.();
    }
  }

  /**
   * Applies the user's decision for a conflicted note.
   *
   * - `mine`: the parked mutation is unblocked and rebased on the server
   *   revision, so the local version wins on the next push.
   * - `theirs`: every pending mutation of that note is dropped and the server
   *   version is written locally.
   * - `both`: the local version is recreated as a brand new note and the server
   *   version keeps the original id.
   */
  async resolveConflict(mutationId: string, choice: ConflictChoice): Promise<SyncSnapshot> {
    const conflict = this.conflicts.find((candidate) => candidate.mutationId === mutationId);
    if (!conflict) return this.snapshot;

    const mutation = await this.repo.getMutation(mutationId);
    const serverRev = conflict.server?.rev ?? 0;

    if (choice === 'mine') {
      if (mutation) {
        await this.repo.updateMutation(mutationId, {
          blocked: false,
          inFlight: false,
          baseRev: serverRev,
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        });
      }
    }

    if (choice === 'theirs') {
      await this.dropPendingMutations(conflict.noteId);
      if (conflict.server) await this.repo.putNote(conflict.server);
    }

    if (choice === 'both') {
      if (mutation && conflict.local) {
        const copy: Note = {
          ...conflict.local,
          id: newId(),
          rev: 0,
          deletedAt: null,
          updatedAt: this.now(),
          title: conflictCopyTitle(conflict.local.title),
        };
        const copyMutation = buildMutation(copy, { ...copy, rev: 0 }, { deviceId: this.deviceId });
        await this.repo.commitLocalChange(copy, copyMutation);
      }
      await this.repo.deleteMutation(mutationId);
      if (conflict.server) await this.repo.putNote(conflict.server);
    }

    this.conflicts = this.conflicts.filter((candidate) => candidate.mutationId !== mutationId);
    await this.repo.setConflicts(this.conflicts);
    this.patch({ conflicts: this.conflicts, pending: await this.repo.countPending() });
    await this.onChanged?.();

    // Resolving is exactly the moment to flush the rebased mutation.
    return this.sync('after-conflict');
  }

  private async dropPendingMutations(noteId: string): Promise<void> {
    const mutations = await this.repo.listOutbox();
    for (const mutation of mutations) {
      if (mutation.noteId === noteId) await this.repo.deleteMutation(mutation.id);
    }
  }

  private scheduleNext(): void {
    if (this.disposed) return;

    if (this.snapshot.pending > 0 || this.failures > 0) {
      const delay = nextRetryDelayMs(Math.max(1, this.failures), this.random);
      this.scheduleIn(delay, this.failures > 0 ? 'retry' : 'drain');
      return;
    }

    if (this.intervalMs > 0) this.scheduleIn(this.intervalMs, 'interval');
  }

  private scheduleIn(ms: number, reason: SyncReason): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync(reason);
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function isSameSnapshot(a: SyncSnapshot, b: SyncSnapshot): boolean {
  return (
    a.phase === b.phase &&
    a.lastReason === b.lastReason &&
    a.pending === b.pending &&
    a.lastSyncAt === b.lastSyncAt &&
    a.lastError === b.lastError &&
    a.failures === b.failures &&
    a.conflicts === b.conflicts
  );
}

function conflictCopyTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length === 0 ? 'Conflicting copy' : `${trimmed} (conflicting copy)`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
