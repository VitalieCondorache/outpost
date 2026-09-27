import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@outpost/shared';
import { App } from './App';
import { deleteOutpostDb } from './db/open-db';
import { createBackup, serializeBackup } from './features/backup/backup';
import { OutpostProvider } from './store/context';
import { createOutpost } from './store/create-outpost';
import type { Outpost } from './store/outpost';
import { createFakeServer, type FakeServer } from './test/fake-server';
import { expectNoA11yViolations } from './test/axe';

const createdDatabases: string[] = [];

/** Minimal note shape for the backup tests. */
function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Title',
    body: 'Body',
    tags: [],
    pinned: false,
    deletedAt: null,
    rev: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface Harness {
  outpost: Outpost;
  server: FakeServer;
  online: { value: boolean };
}

async function renderApp(): Promise<Harness> {
  const server = createFakeServer();
  const online = { value: true };
  const dbName = `outpost-app-${Math.random().toString(36).slice(2)}`;
  createdDatabases.push(dbName);

  const outpost = await createOutpost({
    dbName,
    api: server.api,
    online: () => online.value,
    intervalMs: 0,
  });

  render(
    <OutpostProvider outpost={outpost}>
      <App />
    </OutpostProvider>,
  );

  return { outpost, server, online };
}

afterEach(async () => {
  await Promise.all(createdDatabases.splice(0).map((name) => deleteOutpostDb(name)));
});

describe('<App />', () => {
  it('writes a new note locally and shows it in the list', async () => {
    const user = userEvent.setup();
    const { outpost } = await renderApp();

    await user.click(screen.getByRole('button', { name: /new note/i }));
    await user.type(screen.getByLabelText('Note title'), 'Buy filters');
    await user.type(screen.getByLabelText('Note body'), 'for the coffee machine');

    // The debounced autosave lands in IndexedDB, and the list re-reads from it.
    await waitFor(() => expect(outpost.getSnapshot().notes[0]?.title).toBe('Buy filters'), {
      timeout: 2_000,
    });
    expect(await screen.findByRole('button', { name: /Buy filters/ })).toBeInTheDocument();
  });

  it('keeps the first characters typed right after creating a note', async () => {
    const user = userEvent.setup();
    const { outpost } = await renderApp();

    await user.click(screen.getByRole('button', { name: /new note/i }));
    await user.type(screen.getByLabelText('Note title'), 'Typed fast');

    // Regression guard: the editor used to reset its draft state in an effect that
    // ran after the commit, which wiped keystrokes typed in between.
    expect(screen.getByLabelText('Note title')).toHaveValue('Typed fast');
    await waitFor(() => expect(outpost.getSnapshot().notes[0]?.title).toBe('Typed fast'), {
      timeout: 2_000,
    });
  });

  it('keeps working when the network is down and says so', async () => {
    const user = userEvent.setup();
    const { outpost, online, server } = await renderApp();

    online.value = false;
    await user.click(screen.getByRole('button', { name: /new note/i }));
    await user.type(screen.getByLabelText('Note title'), 'Airplane mode note');

    await waitFor(() => expect(outpost.getSnapshot().notes[0]?.title).toBe('Airplane mode note'), {
      timeout: 2_000,
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /offline/i })).toBeInTheDocument(),
    );
    expect(server.notes.size).toBe(0);
    expect(screen.getByLabelText('Note title')).toHaveValue('Airplane mode note');
  });

  it('filters the list with the search box', async () => {
    const user = userEvent.setup();
    const { outpost } = await renderApp();

    await outpost.createNote({ title: 'Alpha report' });
    await outpost.createNote({ title: 'Beta report' });

    await waitFor(() => expect(screen.getAllByRole('button', { name: /report/ })).toHaveLength(2));

    await user.type(screen.getByLabelText('Search notes'), 'alpha');

    await waitFor(() => expect(screen.getAllByRole('button', { name: /report/ })).toHaveLength(1));
    expect(screen.getByRole('button', { name: /Alpha report/ })).toBeInTheDocument();
  });

  it('has no WCAG A/AA violations in the default view', async () => {
    const { outpost } = await renderApp();
    await outpost.createNote({ title: 'Accessible note', body: 'Body text with some length.' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Accessible note/ })).toBeInTheDocument(),
    );

    await expectNoA11yViolations(document.body);
  });

  it('has no WCAG A/AA violations while a conflict waits for a decision', async () => {
    const { outpost, server, online } = await renderApp();
    const note = await outpost.createNote({ title: 'Draft' });
    await outpost.syncNow();

    online.value = false;
    await outpost.updateNote(note.id, { title: 'My version' });
    await outpost.syncNow();

    server.externalWrite(note.id, { title: 'Their version' });
    online.value = true;
    await outpost.syncNow();

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());

    await expectNoA11yViolations(document.body);
  });

  it('exports a backup file', async () => {
    const user = userEvent.setup();
    const { outpost } = await renderApp();
    await outpost.createNote({ title: 'Back me up' });
    await waitFor(() => expect(outpost.getNotes()).toHaveLength(1));

    const createObjectURL = vi.fn(() => 'blob:backup');
    const revokeObjectURL = vi.fn();
    // Augment the real constructor instead of replacing it: `new URL()` must keep
    // working elsewhere in the app.
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /export \.json/i }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup');
    expect(await screen.findByRole('status')).toHaveTextContent('Exported 1 note');
  });

  it('imports a backup file through the file picker', async () => {
    const user = userEvent.setup();
    const { outpost } = await renderApp();

    const json = serializeBackup(
      createBackup([note({ id: 'from-file', title: 'Imported note' })], { deviceId: 'other' }),
    );
    const file = new File([json], 'outpost.json', { type: 'application/json' });

    await user.upload(screen.getByLabelText('Import a backup file'), file);

    await waitFor(() =>
      expect(outpost.getNotes().map((candidate) => candidate.title)).toEqual(['Imported note']),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Imported 1 new and 0 updated');
  });

  it('reports a broken backup file instead of importing half of it', async () => {
    const user = userEvent.setup();
    const { outpost } = await renderApp();

    const file = new File(['{"app":"something-else"}'], 'broken.json', {
      type: 'application/json',
    });
    await user.upload(screen.getByLabelText('Import a backup file'), file);

    expect(await screen.findByRole('status')).toHaveTextContent('not exported by Outpost');
    expect(outpost.getNotes()).toHaveLength(0);
  });

  it('moves a note to the trash and restores it from there', async () => {
    const user = userEvent.setup();
    const { outpost } = await renderApp();
    await outpost.createNote({ title: 'Doomed note' });

    await user.click(await screen.findByRole('button', { name: /move note to trash/i }));

    await waitFor(() => expect(outpost.getSnapshot().notes[0]?.deletedAt).not.toBeNull());
    expect(screen.queryByRole('button', { name: /Doomed note/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /trash/i }));
    await user.click(await screen.findByRole('button', { name: /restore note/i }));

    await waitFor(() => expect(outpost.getSnapshot().notes[0]?.deletedAt).toBeNull());
  });
});
