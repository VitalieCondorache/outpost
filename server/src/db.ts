import { DatabaseSync } from 'node:sqlite';
import type {
  HealthResponse,
  Mutation,
  MutationResult,
  Note,
  NoteInput,
  PullResponse,
} from '@outpost/shared';

type Statement = ReturnType<DatabaseSync['prepare']>;

interface NoteRow {
  id: string;
  title: string;
  body: string;
  tags: string;
  pinned: number;
  deleted_at: number | null;
  rev: number;
  updated_at: number;
  seq: number;
}

/**
 * SQLite schema.
 *
 * `seq` is a global, monotonically increasing write counter. It exists so that
 * `GET /api/notes?since=<seq>` can never miss or duplicate a change — the naive
 * "cursor = max(updated_at)" version silently loses rows written in the same
 * millisecond, which is a classic sync bug.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  title      TEXT    NOT NULL DEFAULT '',
  body       TEXT    NOT NULL DEFAULT '',
  tags       TEXT    NOT NULL DEFAULT '[]',
  pinned     INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS notes_seq_idx ON notes (seq);
CREATE INDEX IF NOT EXISTS notes_deleted_at_idx ON notes (deleted_at);

-- Idempotency ledger: a mutation may be retried, it is only applied once.
CREATE TABLE IF NOT EXISTS applied_mutations (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS applied_mutations_applied_at_idx ON applied_mutations (applied_at);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('seq', 0);
`;

export interface OutpostDbOptions {
  /** `:memory:` for tests, a file path in production. */
  location?: string;
  now?: () => number;
}

export class OutpostDb {
  private readonly raw: DatabaseSync;
  private readonly now: () => number;
  private readonly statements = new Map<string, Statement>();

  constructor({ location = ':memory:', now = Date.now }: OutpostDbOptions = {}) {
    this.raw = new DatabaseSync(location);
    this.raw.exec(SCHEMA);
    this.now = now;
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }

  stats(): HealthResponse {
    return {
      ok: true,
      notes: this.count('SELECT COUNT(*) AS total FROM notes WHERE deleted_at IS NULL'),
      tombstones: this.count('SELECT COUNT(*) AS total FROM notes WHERE deleted_at IS NOT NULL'),
      appliedMutations: this.count('SELECT COUNT(*) AS total FROM applied_mutations'),
      now: this.now(),
    };
  }

  getNote(id: string): Note | null {
    const row = this.stmt('SELECT * FROM notes WHERE id = ?').get(id) as unknown as
      NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  /**
   * Delta pull. `since` is the opaque cursor returned by the previous pull.
   * Notes come back in `seq` order so a client can apply them incrementally.
   */
  pull(since: number): PullResponse {
    const rows = this.stmt('SELECT * FROM notes WHERE seq > ? ORDER BY seq ASC LIMIT 1000').all(
      since,
    ) as unknown as NoteRow[];

    const last = rows.at(-1);
    return { notes: rows.map(toNote), cursor: last ? last.seq : since };
  }

  listTombstones(): Note[] {
    const rows = this.stmt(
      'SELECT * FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    ).all() as unknown as NoteRow[];
    return rows.map(toNote);
  }

  /**
   * Applies a batch in a single transaction: either the whole batch lands or
   * none of it does, so a client never observes a half-applied push.
   */
  applyMutations(mutations: Mutation[]): MutationResult[] {
    return this.transaction(() => mutations.map((mutation) => this.applyOne(mutation)));
  }

  reset(): void {
    this.transaction(() => {
      this.raw.exec('DELETE FROM notes; DELETE FROM applied_mutations;');
      this.raw.exec("UPDATE counters SET value = 0 WHERE name = 'seq'");
    });
  }

  /** Trash is not forever: tombstones older than `maxAgeMs` are dropped. */
  purgeTombstones(maxAgeMs: number): { notes: number; mutations: number } {
    const cutoff = this.now() - maxAgeMs;
    return this.transaction(() => {
      const notes = this.stmt(
        'DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?',
      ).run(cutoff).changes;
      const mutations = this.stmt('DELETE FROM applied_mutations WHERE applied_at < ?').run(
        cutoff,
      ).changes;
      return { notes: Number(notes), mutations: Number(mutations) };
    });
  }

  // -------------------------------------------------------------- internals

  private applyOne(mutation: Mutation): MutationResult {
    const alreadyApplied = this.stmt('SELECT id FROM applied_mutations WHERE id = ?').get(
      mutation.id,
    );

    if (alreadyApplied) {
      const current = this.getNote(mutation.noteId);
      return {
        id: mutation.id,
        status: 'applied',
        duplicate: true,
        rev: current?.rev ?? 0,
        ...(current ? { server: current } : {}),
        message: 'mutation was already applied earlier',
      };
    }

    const existingRow = this.stmt('SELECT * FROM notes WHERE id = ?').get(
      mutation.noteId,
    ) as unknown as NoteRow | undefined;
    const baseRev = existingRow ? existingRow.rev : 0;

    // Optimistic concurrency check: a stale baseRev means somebody else edited
    // the note since this client last saw it. The client decides how to
    // reconcile — the server never guesses on its behalf.
    if (existingRow && mutation.baseRev !== baseRev) {
      return {
        id: mutation.id,
        status: 'conflict',
        rev: baseRev,
        server: toNote(existingRow),
        message: `stale baseRev: client=${mutation.baseRev} server=${baseRev}`,
      };
    }

    if (mutation.kind === 'delete' && !existingRow) {
      // Nothing to delete: the note never reached the server (or was purged).
      this.markApplied(mutation);
      return {
        id: mutation.id,
        status: 'applied',
        duplicate: true,
        rev: 0,
        message: 'note does not exist on the server',
      };
    }

    if (mutation.kind === 'delete' && existingRow && existingRow.deleted_at !== null) {
      // Trashing an already trashed note is a no-op, not an error.
      this.markApplied(mutation);
      return {
        id: mutation.id,
        status: 'applied',
        duplicate: true,
        rev: existingRow.rev,
        server: toNote(existingRow),
        message: 'note was already in the trash',
      };
    }

    const now = this.now();
    const rev = baseRev + 1;
    const seq = this.nextSeq();

    if (mutation.kind === 'delete') {
      this.stmt(
        'UPDATE notes SET deleted_at = ?, rev = ?, updated_at = ?, seq = ? WHERE id = ?',
      ).run(now, rev, now, seq, mutation.noteId);
    } else {
      const payload: NoteInput = mutation.payload ?? { title: '', body: '' };
      // Tombstone handling: an explicit `deletedAt` in the payload wins (that is
      // how a restore clears the tombstone), otherwise previous state is kept.
      const deletedAt =
        mutation.kind === 'create' || payload.deletedAt === null
          ? null
          : (payload.deletedAt ?? existingRow?.deleted_at ?? null);

      if (existingRow) {
        this.stmt(
          `UPDATE notes
             SET title = ?, body = ?, tags = ?, pinned = ?, deleted_at = ?,
                 rev = ?, updated_at = ?, seq = ?
           WHERE id = ?`,
        ).run(
          payload.title,
          payload.body,
          JSON.stringify(payload.tags ?? []),
          payload.pinned ? 1 : 0,
          deletedAt,
          rev,
          now,
          seq,
          mutation.noteId,
        );
      } else {
        this.stmt(
          `INSERT INTO notes (id, title, body, tags, pinned, deleted_at, rev, updated_at, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          mutation.noteId,
          payload.title,
          payload.body,
          JSON.stringify(payload.tags ?? []),
          payload.pinned ? 1 : 0,
          deletedAt,
          rev,
          now,
          seq,
        );
      }
    }

    this.markApplied(mutation);
    const saved = this.getNote(mutation.noteId);
    return { id: mutation.id, status: 'applied', rev, ...(saved ? { server: saved } : {}) };
  }

  private markApplied(mutation: Mutation): void {
    this.stmt(
      'INSERT OR IGNORE INTO applied_mutations (id, note_id, applied_at) VALUES (?, ?, ?)',
    ).run(mutation.id, mutation.noteId, this.now());
  }

  private nextSeq(): number {
    this.stmt("UPDATE counters SET value = value + 1 WHERE name = 'seq'").run();
    const row = this.stmt("SELECT value FROM counters WHERE name = 'seq'").get() as
      { value: number } | undefined;
    return Number(row?.value ?? 0);
  }

  private count(sql: string): number {
    const row = this.stmt(sql).get() as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  private stmt(sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.raw.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  private transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

function toNote(row: NoteRow): Note {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    tags: parseTags(row.tags),
    pinned: Number(row.pinned ?? 0) === 1,
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    rev: Number(row.rev ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function parseTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}
