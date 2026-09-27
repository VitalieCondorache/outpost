import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { OutpostDb } from './db.js';

const PORT = Number(process.env.PORT ?? 8787);
const DB_LOCATION = process.env.OUTPOST_DB ?? resolve(process.cwd(), 'data/outpost.db');
const TOMBSTONE_TTL_MS = Number(process.env.OUTPOST_TOMBSTONE_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);

if (DB_LOCATION !== ':memory:') {
  mkdirSync(dirname(DB_LOCATION), { recursive: true });
}

const db = new OutpostDb({ location: DB_LOCATION });
const purged = db.purgeTombstones(TOMBSTONE_TTL_MS);
const app = createApp({
  db,
  allowReset: process.env.NODE_ENV !== 'production' || process.env.ALLOW_RESET === 'true',
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[outpost] api      http://localhost:${info.port}`);
  console.log(`[outpost] database ${DB_LOCATION}`);
  if (purged.notes > 0 || purged.mutations > 0) {
    console.log(
      `[outpost] purged ${purged.notes} expired tombstone(s), ${purged.mutations} ledger entries`,
    );
  }
});

const shutdown = (signal: string) => () => {
  console.log(`[outpost] ${signal} received, closing`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
