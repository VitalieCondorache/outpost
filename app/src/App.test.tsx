import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { deleteOutpostDb } from './db/open-db';
import { OutpostProvider } from './store/context';
import { createOutpost } from './store/create-outpost';
import type { Outpost } from './store/outpost';
import { createFakeServer, type FakeServer } from './test/fake-server';

const createdDatabases: string[] = [];

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
