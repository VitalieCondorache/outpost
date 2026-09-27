import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Outpost, OutpostState } from './outpost';

const OutpostContext = createContext<Outpost | null>(null);

export function OutpostProvider({ outpost, children }: { outpost: Outpost; children: ReactNode }) {
  return <OutpostContext.Provider value={outpost}>{children}</OutpostContext.Provider>;
}

export function useOutpost(): Outpost {
  const outpost = useContext(OutpostContext);
  if (outpost === null) throw new Error('useOutpost must be used inside <OutpostProvider>');
  return outpost;
}

/**
 * Subscribes to the store. `getSnapshot` is also used as the server snapshot so
 * the component tree is renderable during a hydration pass without extra work.
 */
export function useOutpostState(): OutpostState {
  const outpost = useOutpost();
  return useSyncExternalStore(outpost.subscribe, outpost.getSnapshot, outpost.getSnapshot);
}
