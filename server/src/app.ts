import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { API_ROUTES } from '@outpost/shared';
import type { OutpostDb } from './db.js';
import { parseSyncRequest } from './validate.js';

export interface AppOptions {
  db: OutpostDb;
  /** Dev-only destructive endpoints (`/api/dev/reset`). */
  allowReset?: boolean;
  /** Silence request logging (tests). */
  quiet?: boolean;
}

export function createApp({ db, allowReset = true, quiet = false }: AppOptions) {
  const app = new Hono();

  if (!quiet) app.use('*', logger());

  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  );

  app.get(API_ROUTES.health, (c) => c.json(db.stats()));

  /**
   * Delta pull. The client sends the cursor it received last time and gets back
   * everything written since then. Tombstones are included on purpose: a client
   * must learn about deletions it did not perform.
   */
  app.get(API_ROUTES.notes, (c) => {
    const raw = Number(c.req.query('since') ?? '0');
    const since = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    return c.json(db.pull(since));
  });

  /**
   * Push endpoint. Mutations are applied atomically, and each result tells the
   * client whether it landed, lost a race (`conflict`) or was rejected.
   */
  app.post(API_ROUTES.sync, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be valid JSON' }, 400);
    }

    const parsed = parseSyncRequest(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const results = db.applyMutations(parsed.value.mutations);
    return c.json({ results });
  });

  app.post(API_ROUTES.reset, (c) => {
    if (!allowReset) return c.json({ error: 'reset is disabled' }, 403);
    db.reset();
    return c.json({ ...db.stats(), reset: true });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    if (!quiet) console.error('[outpost] unhandled error', error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

export type OutpostApp = ReturnType<typeof createApp>;
