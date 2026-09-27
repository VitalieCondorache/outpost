/** Reads a user-picked file as text, with a FileReader fallback for older engines. */
export function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsText(file);
  });
}

/**
 * Triggers a client-side download.
 *
 * Returns `false` when the environment cannot produce an object URL (jsdom in
 * tests, or a browser with storage restrictions) so the caller can tell the user
 * instead of throwing.
 */
export function downloadFile(
  filename: string,
  contents: string,
  mime = 'application/json',
): boolean {
  if (typeof URL.createObjectURL !== 'function') return false;

  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
