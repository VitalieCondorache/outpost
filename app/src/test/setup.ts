import '@testing-library/jest-dom/vitest';
// Gives jsdom a real IndexedDB implementation, so the repository and the sync
// engine are tested against actual transactions instead of a mock.
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
