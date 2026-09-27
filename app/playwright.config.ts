import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8787);
const API_URL = `http://127.0.0.1:${API_PORT}`;

/**
 * End-to-end suite: it runs the *production* build against the *real* API, so
 * the parts the unit tests fake (service worker precaching, real IndexedDB,
 * real HTTP, real SQLite) are covered here.
 *
 * `npm run build` must have run first — the root `npm run e2e` does that.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    serviceWorkers: 'allow',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node server/dist/index.js',
      url: `${API_URL}/api/health`,
      cwd: resolve(here, '..'),
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        OUTPOST_DB: resolve(here, 'e2e/.tmp/e2e.db'),
        ALLOW_RESET: 'true',
      },
    },
    {
      command: `npx vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      cwd: here,
      reuseExistingServer: false,
      env: { VITE_API_TARGET: API_URL },
    },
  ],
});
