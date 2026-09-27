import { useEffect, useState } from 'react';

/** Chromium-only event; typed locally because it is not in the DOM lib yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Surfaces the browser's install prompt when the PWA is installable. */
export function InstallPrompt() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstall = (raw: Event) => {
      raw.preventDefault();
      setEvent(raw as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  if (event === null) return null;

  return (
    <button
      type="button"
      className="button button--ghost install"
      onClick={() => {
        void event.prompt();
        setEvent(null);
      }}
    >
      Install app
    </button>
  );
}
