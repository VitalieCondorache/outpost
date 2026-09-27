import type { Note, NoteInput } from '@outpost/shared';
import type { NotesRepo } from '../db/repo';
import { newId } from '../lib/id';
import type { ConflictChoice, SyncEngine, SyncSnapshot } from '../sync/engine';
import { buildMutation } from '../sync/mutations';

export interface OutpostState {
  /** Local source of truth: everything the UI renders comes from here. */
  notes: Note[];
  sync: SyncSnapshot;
  /** False until the first IndexedDB read finished. */
  ready: boolean;
}

export interface OutpostDeps {
  repo: NotesRepo;
  engine: SyncEngine;
  /** Optional, only used by the developer reset buttons. */
  resetServer?: () => Promise<void>;
}
const BROADCAST_CHANNEL = 'outpost:notes';

/**
 * The application store.
 *
 * It owns the local-first loop: write to IndexedDB, notify the UI immediately,
 * hand the mutation to the sync engine in the background. Nothing in the UI ever
 * waits for the network.
 */
export class Outpost {
  private readonly repo: NotesRepo;
  private readonly engine: SyncEngine;
  private readonly remoteReset?: () => Promise<void>;
  private readonly listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;

  private state: OutpostState = {
    notes: [],
    sync: {
      phase: 'idle',
      lastReason: 'start',
      pending: 0,
      lastSyncAt: null,
      lastError: null,
      failures: 0,
      conflicts: [],
    },
    ready: false,
  };

  constructor({ repo, engine, resetServer }: OutpostDeps) {
    this.repo = repo;
    this.engine = engine;
    this.remoteReset = resetServer;
    engine.subscribe(() => this.patch({ sync: engine.getSnapshot() }));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OutpostState => this.state;

  /** Loads persisted state. Safe to call before the first render. */
  async init(): Promise<void> {
    await this.engine.hydrate();
    await this.refresh();
    this.patch({ ready: true, sync: this.engine.getSnapshot() });
  }

  /**
   * Starts the engine and listens to the other tabs. Two tabs on one device
   * share IndexedDB, so the only thing they must exchange is "something
   * changed, re-read".
   */
  start(): () => void {
    const stopEngine = this.engine.start();
    this.setupChannel();
    return () => {
      stopEngine();
      this.teardownChannel();
    };
  }

  // ---------------------------------------------------------------- commands

  async createNote(initial: Partial<NoteInput> = {}): Promise<Note> {
    const note: Note = {
      id: newId(),
      title: initial.title ?? '',
      body: initial.body ?? '',
      tags: initial.tags ?? [],
      pinned: initial.pinned ?? false,
      deletedAt: null,
      rev: 0,
      updatedAt: Date.now(),
    };

    // `previous` is the same note with rev 0, which is exactly what tells the
    // mutation builder that this is an insert nobody has seen yet.
    const mutation = buildMutation(
      note,
      { ...note, rev: 0 },
      {
        deviceId: this.engine.getDeviceId(),
      },
    );
    await this.repo.commitLocalChange(note, mutation);
    await this.afterLocalChange();
    return note;
  }

  async updateNote(id: string, patch: Partial<NoteInput>): Promise<Note | null> {
    const previous = await this.repo.getNote(id);
    if (!previous) return null;

    const next: Note = {
      ...previous,
      title: patch.title ?? previous.title,
      body: patch.body ?? previous.body,
      tags: patch.tags ?? previous.tags,
      pinned: patch.pinned ?? previous.pinned,
      deletedAt: patch.deletedAt === undefined ? previous.deletedAt : patch.deletedAt,
      updatedAt: Date.now(),
    };

    const mutation = buildMutation(next, previous, { deviceId: this.engine.getDeviceId() });
    await this.repo.commitLocalChange(next, mutation);
    await this.afterLocalChange();
    return next;
  }

  togglePin(id: string): Promise<Note | null> {
    const note = this.state.notes.find((candidate) => candidate.id === id);
    if (!note) return Promise.resolve(null);
    return this.updateNote(id, { pinned: !note.pinned });
  }

  /** Soft delete: the note moves to the trash and the tombstone syncs. */
  trashNote(id: string): Promise<Note | null> {
    return this.updateNote(id, { deletedAt: Date.now() });
  }

  restoreNote(id: string): Promise<Note | null> {
    return this.updateNote(id, { deletedAt: null });
  }

  async deleteForever(id: string): Promise<void> {
    await this.repo.deleteNoteForever(id);
    await this.afterLocalChange();
  }

  async resolveConflict(mutationId: string, choice: ConflictChoice): Promise<void> {
    await this.engine.resolveConflict(mutationId, choice);
    await this.refresh();
  }

  syncNow(): Promise<SyncSnapshot> {
    return this.engine.sync('manual');
  }

  pendingMutations() {
    return this.engine.pendingMutations();
  }

  /** Opaque cursor of the last pull — shown by the sync inspector. */
  getCursor(): Promise<number> {
    return this.repo.getCursor();
  }

  getSyncSnapshot(): SyncSnapshot {
    return this.engine.getSnapshot();
  }

  getDeviceId(): string {
    return this.engine.getDeviceId();
  }

  /** Danger zone: wipes local data (inspector button and tests). */
  async resetLocalData(): Promise<void> {
    await this.repo.clearAll();
    await this.engine.hydrate();
    await this.refresh();
    this.broadcast();
  }

  /** Danger zone: wipes local data *and* the server (inspector button). */
  async resetServer(): Promise<void> {
    if (!this.remoteReset) return;
    await this.remoteReset();
    await this.resetLocalData();
  }

  // -------------------------------------------------------------- internals

  private async afterLocalChange(): Promise<void> {
    await this.refresh();
    this.broadcast();
    // Fire and forget: the UI already shows the change.
    void this.engine.sync('local-change');
  }

  /** Re-reads notes from IndexedDB and notifies subscribers. */
  async refreshFromStorage(): Promise<void> {
    this.patch({ notes: await this.repo.listNotes() });
  }

  private async refresh(): Promise<void> {
    await this.refreshFromStorage();
  }

  private patch(partial: Partial<OutpostState>): void {
    const notesUnchanged =
      partial.notes === undefined || notesEqual(partial.notes, this.state.notes);
    const next: OutpostState = {
      notes: notesUnchanged ? this.state.notes : (partial.notes as Note[]),
      sync: partial.sync ?? this.state.sync,
      ready: partial.ready ?? this.state.ready,
    };

    if (
      next.notes === this.state.notes &&
      next.sync === this.state.sync &&
      next.ready === this.state.ready
    ) {
      return;
    }

    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private setupChannel(): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;

    this.channel = new BroadcastChannel(BROADCAST_CHANNEL);
    this.channel.addEventListener('message', () => {
      void this.refresh();
    });
  }

  private teardownChannel(): void {
    this.channel?.close();
    this.channel = null;
  }

  private broadcast(): void {
    this.channel?.postMessage({ type: 'changed', at: Date.now() });
  }
}

/**
 * Cheap identity check so a re-read of unchanged data does not re-render the
 * whole list. Content is compared through `updatedAt`, which every write bumps.
 */
function notesEqual(a: Note[], b: Note[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  return a.every((note, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      note.id === other.id &&
      note.rev === other.rev &&
      note.updatedAt === other.updatedAt &&
      note.deletedAt === other.deletedAt &&
      note.pinned === other.pinned
    );
  });
}
