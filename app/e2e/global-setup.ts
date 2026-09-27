import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp/e2e.db');

/**
 * Every run starts from an empty server database. The app's own storage is
 * isolated per Playwright context, so nothing else has to be cleaned.
 */
export default function globalSetup(): void {
  mkdirSync(dirname(DB_FILE), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
}
