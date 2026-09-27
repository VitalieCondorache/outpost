import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { OutpostDb } from '../src/db.js';

let db: OutpostDb;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new OutpostDb();
  app = createApp({ db, quiet: true });
});

async function post(body: unknown) {
  const response = await app.request('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const validMutation = {
  id: 'm1',
  noteId: 'n1',
  kind: 'create',
  baseRev: 0,
  createdAt: 1,
  payload: { title: 'Hello', body: 'World' },
};

describe('POST /api/sync validation', () => {
  it('rejects malformed JSON with 400', async () => {
    const response = await post('{ not json');
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toContain('valid JSON');
  });

  it.each([
    ['a non-object body', []],
    ['a missing deviceId', { mutations: [validMutation] }],
    ['an empty mutation list', { deviceId: 'd1', mutations: [] }],
    [
      'a mutation without a noteId',
      { deviceId: 'd1', mutations: [{ ...validMutation, noteId: '' }] },
    ],
    [
      'an unknown mutation kind',
      { deviceId: 'd1', mutations: [{ ...validMutation, kind: 'nope' }] },
    ],
    ['a negative baseRev', { deviceId: 'd1', mutations: [{ ...validMutation, baseRev: -1 }] }],
    [
      'a non-string title',
      {
        deviceId: 'd1',
        mutations: [{ ...validMutation, payload: { title: 42, body: '' } }],
      },
    ],
    [
      'too many tags',
      {
        deviceId: 'd1',
        mutations: [
          {
            ...validMutation,
            payload: { title: 'a', body: '', tags: Array.from({ length: 33 }, (_, i) => `t${i}`) },
          },
        ],
      },
    ],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(typeof response.body.error).toBe('string');
  });

  it('rejects an oversized batch', async () => {
    const mutations = Array.from({ length: 201 }, (_, index) => ({
      ...validMutation,
      id: `m${index}`,
    }));

    const response = await post({ deviceId: 'd1', mutations });

    expect(response.status).toBe(400);
    expect(String(response.body.error)).toContain('200');
  });

  it('never writes anything when the request is rejected', async () => {
    await post({ deviceId: 'd1', mutations: [{ ...validMutation, kind: 'nope' }] });
    expect(db.stats().notes).toBe(0);
  });

  it('normalises the payload of delete mutations to null', async () => {
    await post({ deviceId: 'd1', mutations: [validMutation] });

    const response = await post({
      deviceId: 'd1',
      mutations: [
        {
          ...validMutation,
          id: 'm2',
          kind: 'delete',
          baseRev: 1,
          payload: { title: 'x', body: 'y' },
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(db.getNote('n1')?.deletedAt).not.toBeNull();
  });

  it('treats a delete of an unknown note as a no-op instead of creating a tombstone', async () => {
    const response = await post({
      deviceId: 'd1',
      mutations: [{ ...validMutation, noteId: 'ghost', kind: 'delete' }],
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ results: [{ status: 'applied', rev: 0 }] });
    expect(db.getNote('ghost')).toBeNull();
  });
});
