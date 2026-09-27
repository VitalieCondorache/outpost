#!/usr/bin/env node
/**
 * Captures the screenshots used by the README, from the real application.
 *
 * Playwright drives the *production* build, seeds a few notes through the UI,
 * switches the context offline and takes the shots — so the documentation can
 * never drift away from what the app actually looks like.
 *
 * The stack must already be running:
 *   npm run build
 *   OUTPOST_DB=$(pwd)/app/e2e/.tmp/screenshot.db PORT=8787 node server/dist/index.js &
 *   npm run preview &            # serves app/dist on 127.0.0.1:4173
 *   node tools/screenshot.mjs
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const URL = process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:4173';
const API_URL = process.env.SCREENSHOT_API_URL ?? 'http://127.0.0.1:8787';
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../docs');

const NOTES = [
  {
    title: 'Tunnel survey — day 3',
    body: 'Crew B reached the junction at 14:20.\nVentilation holds, humidity at 82%.\n\nFollow up with the geologist before Friday.',
    tags: 'fieldwork, survey',
  },
  {
    title: 'Sync engine notes',
    body: 'Coalescing keeps the outbox at one mutation per dirty note.\nConflicts are never resolved silently — the user picks.',
    tags: 'ideas',
  },
  {
    title: 'Groceries',
    body: 'Coffee filters\nOlive oil\nBread',
    tags: '',
  },
];

/**
 * Clicks "New note" and waits until the editor is really bound to the new note.
 *
 * Until React commits the selection the *previous* note is still mounted, so
 * typing in between would land in the wrong note. A human never hits that window
 * (it lasts a couple of milliseconds behind a full click), an automated driver
 * does — hence the explicit wait on the UI state instead of on a timer.
 *
 * @param {import('@playwright/test').Page} page
 */
async function newNote(page) {
  const before = await page.locator('.note').count();
  await page.getByRole('button', { name: /new note/i }).click();
  await expect(page.locator('.note')).toHaveCount(before + 1);
  await expect(page.locator('.note').first().locator('.note__main')).toHaveAttribute(
    'aria-current',
    'true',
  );
}

/** @param {import('@playwright/test').Page} page */
async function writeNote(page, note) {
  await newNote(page);
  await page.getByLabel('Note title').fill(note.title);
  await page.getByLabel('Note body').fill(note.body);
  if (note.tags.length > 0) await page.getByLabel('Tags, comma separated').fill(note.tags);
  // The debounced autosave landed once the note shows up in the list.
  await expect(page.getByRole('button', { name: new RegExp(note.title) })).toBeVisible();
}

/**
 * Wipes the demo database, waiting for the API to accept connections first.
 *
 * The servers may be started by hand or by `docker compose`, so "not listening
 * yet" is a normal condition and must not fail the first shot.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 */
async function resetDemoApi(request) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await request.post(`${API_URL}/api/dev/reset`);
      if (response.ok()) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the demo API at ${API_URL} never became ready (is it running?)`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`capturing ${URL}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });

  // Start from an empty server so the shots are reproducible: a fresh browser
  // context plus a wiped API means no leftovers from a previous run.
  await resetDemoApi(context.request);

  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('console', (message) => console.log(`[browser:${message.type()}]`, message.text()));
  page.on('pageerror', (error) => console.log('[browser:error]', error.message));

  await page.goto(URL);
  await page.waitForFunction(
    () => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null,
    undefined,
    { timeout: 15_000 },
  );
  console.log('service worker is controlling the page');

  for (const note of NOTES) {
    await writeNote(page, note);
    console.log(`seeded: ${note.title}`);
  }
  await expect(page.getByRole('button', { name: /synced/i })).toBeVisible({ timeout: 30_000 });
  console.log('initial sync done');

  // Offline + a queued edit: the story of the whole project in one frame.
  await page.getByRole('button', { name: /Tunnel survey/ }).click();
  await context.setOffline(true);
  await page
    .getByLabel('Note body')
    .fill(`${NOTES[0]?.body}\n\nStorm warning at 16:00 — we walked out and kept writing.`);
  // Wait for the debounced autosave, so the badge really counts a queued change.
  await expect(page.getByRole('button', { name: /queued/i })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: resolve(OUT_DIR, 'screenshot.png') });
  console.log('wrote docs/screenshot.png');

  await page.getByRole('button', { name: /sync inspector/i }).click();
  await expect(page.getByRole('heading', { name: 'Sync inspector' })).toBeVisible();
  await page.screenshot({ path: resolve(OUT_DIR, 'inspector.png') });
  console.log('wrote docs/inspector.png');

  await context.setOffline(false);
  await browser.close();
}

try {
  await main();
  console.log(`screenshots written to ${OUT_DIR}`);
} catch (error) {
  console.error('[screenshot] failed:', error);
  process.exitCode = 1;
}
