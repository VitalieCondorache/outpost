import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { onBackgroundSyncWakeup, requestBackgroundSync } from './pwa/background-sync';
import { registerServiceWorker, requestPersistentStorage } from './pwa/register';
import { OutpostProvider } from './store/context';
import { createOutpost } from './store/create-outpost';
import './styles.css';

const container = document.getElementById('root');

async function bootstrap(): Promise<void> {
  if (container === null) throw new Error('#root is missing from index.html');

  const outpost = await createOutpost({
    // Stuck offline? Ask the platform to wake us up when the network is back,
    // even if the user closed the tab right after writing.
    onRequestBackgroundSync: () => {
      void requestBackgroundSync();
    },
  });

  createRoot(container).render(
    <StrictMode>
      <OutpostProvider outpost={outpost}>
        <App />
      </OutpostProvider>
    </StrictMode>,
  );

  // `registerType: 'autoUpdate'`: a new service worker takes over on the next load.
  registerServiceWorker();
  void requestPersistentStorage();
  onBackgroundSyncWakeup(() => void outpost.syncNow());
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[outpost] failed to start', error);
  if (container === null) return;

  const panel = document.createElement('div');
  panel.className = 'fatal';
  const heading = document.createElement('h1');
  heading.textContent = 'Outpost could not start';
  const detail = document.createElement('pre');
  detail.textContent = message;
  panel.append(heading, detail);
  container.replaceChildren(panel);
});
