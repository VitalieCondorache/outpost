import '@testing-library/jest-dom/vitest';
// Gives jsdom a real IndexedDB implementation, so the repository and the sync
// engine are tested against actual transactions instead of a mock.
import 'fake-indexeddb/auto';
import { configure } from '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Every write in this app goes through IndexedDB (a real one, via
// fake-indexeddb) and is followed by a re-read, so the default 1s budget for
// `waitFor`/`findBy*` is tight on a loaded machine. Keep this below the Vitest
// `testTimeout`, so a real failure is reported as a failed assertion.
configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// jsdom has no BroadcastChannel; the multi-tab bridge is a no-op unless a test
// provides one, which keeps the sync engine testable in isolation.
if (!('BroadcastChannel' in globalThis)) {
  class FakeBroadcastChannel {
    readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  }
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    value: FakeBroadcastChannel,
    writable: true,
  });
}
