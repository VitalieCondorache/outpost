import type { Mutation, MutationKind, NoteInput, SyncRequest } from '@outpost/shared';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_BATCH = 200;
const MAX_TEXT = 20_000;
const MAX_TAGS = 32;
const KINDS: MutationKind[] = ['create', 'update', 'delete'];

/**
 * Hand-rolled validation, no schema library: the protocol is small enough that
 * explicit checks stay readable, and it keeps the API dependency-free.
 * Every failure returns a path so clients can log something actionable.
 */
export function parseSyncRequest(input: unknown): ParseResult<SyncRequest> {
  if (!isRecord(input)) return fail('body must be a JSON object');

  const { deviceId, mutations } = input;
  if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 128) {
    return fail('deviceId must be a non-empty string of at most 128 characters');
  }
  if (!Array.isArray(mutations)) return fail('mutations must be an array');
  if (mutations.length === 0) return fail('mutations must not be empty');
  if (mutations.length > MAX_BATCH) return fail(`mutations must not exceed ${MAX_BATCH} entries`);

  const parsed: Mutation[] = [];
  for (const [index, raw] of mutations.entries()) {
    const result = parseMutation(raw, `mutations[${index}]`);
    if (!result.ok) return result;
    parsed.push(result.value);
  }

  return { ok: true, value: { deviceId, mutations: parsed } };
}

function parseMutation(input: unknown, path: string): ParseResult<Mutation> {
  if (!isRecord(input)) return fail(`${path} must be an object`);

  const { id, noteId, kind, payload, baseRev, createdAt } = input;

  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return fail(`${path}.id must be a non-empty string of at most 128 characters`);
  }
  if (typeof noteId !== 'string' || noteId.length === 0 || noteId.length > 128) {
    return fail(`${path}.noteId must be a non-empty string of at most 128 characters`);
  }
  if (typeof kind !== 'string' || !isKind(kind)) {
    return fail(`${path}.kind must be one of ${KINDS.join(', ')}`);
  }
  if (!isNonNegativeInteger(baseRev)) return fail(`${path}.baseRev must be a positive integer`);
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return fail(`${path}.createdAt must be a finite number`);
  }

  if (kind === 'delete') {
    return { ok: true, value: { id, noteId, kind, payload: null, baseRev, createdAt } };
  }

  const parsedPayload = parsePayload(payload, `${path}.payload`);
  if (!parsedPayload.ok) return parsedPayload;

  return {
    ok: true,
    value: { id, noteId, kind, payload: parsedPayload.value, baseRev, createdAt },
  };
}

function parsePayload(input: unknown, path: string): ParseResult<NoteInput> {
  if (!isRecord(input)) return fail(`${path} must be an object`);

  const { title, body, tags, pinned, deletedAt } = input;

  if (typeof title !== 'string' || title.length > MAX_TEXT) {
    return fail(`${path}.title must be a string of at most ${MAX_TEXT} characters`);
  }
  if (typeof body !== 'string' || body.length > MAX_TEXT) {
    return fail(`${path}.body must be a string of at most ${MAX_TEXT} characters`);
  }

  let parsedTags: string[] | undefined;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
      return fail(`${path}.tags must be an array of at most ${MAX_TAGS} entries`);
    }
    if (!tags.every((tag): tag is string => typeof tag === 'string' && tag.length <= 64)) {
      return fail(`${path}.tags entries must be strings of at most 64 characters`);
    }
    parsedTags = tags;
  }

  if (pinned !== undefined && typeof pinned !== 'boolean') {
    return fail(`${path}.pinned must be a boolean`);
  }
  if (deletedAt !== undefined && deletedAt !== null && typeof deletedAt !== 'number') {
    return fail(`${path}.deletedAt must be a number or null`);
  }

  return {
    ok: true,
    value: {
      title,
      body,
      ...(parsedTags ? { tags: parsedTags } : {}),
      ...(pinned === undefined ? {} : { pinned }),
      ...(deletedAt === undefined ? {} : { deletedAt: deletedAt as number | null }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: string): value is MutationKind {
  return (KINDS as string[]).includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function fail(error: string): ParseResult<never> {
  return { ok: false, error };
}
