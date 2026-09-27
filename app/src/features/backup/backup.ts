import type { Note } from '@outpost/shared';

export const BACKUP_APP = 'outpost';
export const BACKUP_VERSION = 1;

export interface Backup {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: number;
  device: string;
  notes: Note[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A backup is deliberately the same shape as the sync payload plus a header, so
 * it can be produced and consumed without any conversion layer — and so the file
 * stays readable (and diffable) by a human.
 */
export function createBackup(notes: Note[], options: { deviceId: string; now?: number }): Backup {
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: options.now ?? Date.now(),
    device: options.deviceId,
    notes: notes.map((note) => ({ ...note, tags: [...note.tags] })),
  };
}

export function serializeBackup(backup: Backup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/**
 * Validates everything it reads. An import is the one place where foreign data
 * enters the store, so a malformed file must be rejected with a message the user
 * can act on instead of half-populating IndexedDB.
 */
export function parseBackup(json: string): ParseResult<Backup> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, error: 'the file is not valid JSON' };
  }

  if (!isRecord(parsed)) return { ok: false, error: 'the file does not contain a backup object' };
  if (parsed.app !== BACKUP_APP) {
    return { ok: false, error: 'this file was not exported by Outpost' };
  }
  if (typeof parsed.version !== 'number' || parsed.version > BACKUP_VERSION) {
    return { ok: false, error: `unsupported backup version: ${String(parsed.version)}` };
  }
  if (!Array.isArray(parsed.notes)) return { ok: false, error: 'the backup has no notes array' };

  const notes: Note[] = [];
  for (const [index, raw] of parsed.notes.entries()) {
    const result = parseNote(raw, index);
    if (!result.ok) return result;
    notes.push(result.value);
  }

  return {
    ok: true,
    value: {
      app: BACKUP_APP,
      version: parsed.version,
      exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : 0,
      device: typeof parsed.device === 'string' ? parsed.device : 'unknown',
      notes,
    },
  };
}

function parseNote(input: unknown, index: number): ParseResult<Note> {
  const path = `notes[${index}]`;
  if (!isRecord(input)) return fail(`${path} is not an object`);

  const { id, title, body, tags, pinned, deletedAt, updatedAt } = input;
  if (typeof id !== 'string' || id.length === 0) return fail(`${path}.id must be a string`);
  if (typeof title !== 'string') return fail(`${path}.title must be a string`);
  if (typeof body !== 'string') return fail(`${path}.body must be a string`);
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    return fail(`${path}.tags must be an array of strings`);
  }
  if (deletedAt !== null && typeof deletedAt !== 'number') {
    return fail(`${path}.deletedAt must be a number or null`);
  }

  return {
    ok: true,
    value: {
      id,
      title,
      body,
      tags: [...tags],
      pinned: pinned === true,
      deletedAt: deletedAt as number | null,
      // The revision is deliberately *not* imported: a restored note has to earn
      // its revision from this device again, through the normal sync flow.
      rev: 0,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : Date.now(),
    },
  };
}

export function backupFilename(now = Date.now()): string {
  return `outpost-${new Date(now).toISOString().slice(0, 10)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: string): ParseResult<never> {
  return { ok: false, error };
}
