import { useEffect, useRef } from 'react';

export interface Hotkey {
  key: string;
  /** Require Cmd on macOS / Ctrl elsewhere. */
  meta?: boolean;
  shift?: boolean;
  handler: (event: KeyboardEvent) => void;
}

/**
 * Global keyboard bindings. The latest array is kept in a ref so binding a new
 * handler on every render does not re-attach the listener.
 */
export function useHotkeys(hotkeys: Hotkey[]): void {
  const latest = useRef(hotkeys);
  latest.current = hotkeys;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      for (const hotkey of latest.current) {
        const wantsMeta = hotkey.meta ?? false;
        const wantsShift = hotkey.shift ?? false;
        const metaPressed = event.metaKey || event.ctrlKey;
        if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) continue;
        if (metaPressed !== wantsMeta) continue;
        if (event.shiftKey !== wantsShift) continue;
        event.preventDefault();
        hotkey.handler(event);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
