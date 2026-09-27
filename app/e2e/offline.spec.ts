import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  // The page must be *controlled* by the service worker, otherwise an offline
  // reload has no app shell to serve.
  await page.waitForFunction(
    () => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null,
  );
  await expect(page.getByRole('button', { name: /new note/i })).toBeVisible();
}

/**
 * Clicks "New note" and waits until the editor is bound to the new note.
 *
 * Until React commits the selection, the *previous* note is still mounted and
 * would receive the keystrokes. A human never hits that window (it lasts a couple
 * of milliseconds, hidden behind a click); a driver does, so the test waits on the
 * UI state instead of on a timer.
 */
async function newNote(page: Page): Promise<void> {
  const before = await page.locator('.note').count();
  await page.getByRole('button', { name: /new note/i }).click();
  await expect(page.locator('.note')).toHaveCount(before + 1);
  await expect(page.locator('.note').first().locator('.note__main')).toHaveAttribute(
    'aria-current',
    'true',
  );
}

/**
 * Types a note and waits until it is really in IndexedDB.
 *
 * The autosave is debounced on purpose, so "the note is in the list" is the signal
 * that a reload or a closed tab cannot lose the keystrokes.
 */
async function writeNote(page: Page, title: string, body: string): Promise<void> {
  await newNote(page);
  await page.getByLabel('Note title').fill(title);
  await page.getByLabel('Note body').fill(body);
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
}

async function expectSynced(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /synced/i })).toBeVisible({ timeout: 30_000 });
}

test.describe('offline-first notes', () => {
  test('writes offline, survives a reload and syncs when the network is back', async ({
    page,
    context,
    request,
  }) => {
    await openApp(page);

    await context.setOffline(true);
    await writeNote(page, 'Written in the tunnel', 'No signal down here.');

    // The badge has to be honest about the queue instead of pretending success.
    await expect(page.getByRole('button', { name: /offline/i })).toBeVisible();

    // The app shell comes from the precache, the note from IndexedDB.
    await page.reload();
    await expect(page.getByRole('button', { name: /Written in the tunnel/ })).toBeVisible();

    // Nothing has reached the server yet.
    const before = await request.get(`${API_URL}/api/health`);
    expect((await before.json()).notes).toBe(0);

    // Back online: a normal page load must drain the outbox.
    await context.setOffline(false);
    await page.reload();
    await expectSynced(page);

    const after = await request.get(`${API_URL}/api/notes?since=0`);
    const payload = (await after.json()) as { notes: Array<{ title: string; rev: number }> };
    expect(payload.notes.map((note) => note.title)).toContain('Written in the tunnel');
    expect(payload.notes[0]?.rev).toBe(1);
  });

  test('a second device pulls what the first one pushed', async ({ browser }) => {
    const first: BrowserContext = await browser.newContext();
    const deviceA = await first.newPage();
    await openApp(deviceA);
    await writeNote(deviceA, 'Shared through the API', 'Written on device A.');
    await expectSynced(deviceA);
    await first.close();

    const second: BrowserContext = await browser.newContext();
    const deviceB = await second.newPage();
    await openApp(deviceB);

    await expect(deviceB.getByRole('button', { name: /Shared through the API/ })).toBeVisible({
      timeout: 30_000,
    });
    await second.close();
  });
});
