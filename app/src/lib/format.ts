const UNITS: Array<[limit: number, divisor: number, suffix: string]> = [
  [60_000, 1_000, 's'],
  [3_600_000, 60_000, 'm'],
  [86_400_000, 3_600_000, 'h'],
];

/** Compact "just now / 5m ago / 3h ago / 12 Jan" formatting for the note list. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;
  if (!Number.isFinite(timestamp) || delta < 0) return 'now';
  if (delta < 45_000) return 'just now';

  for (const [limit, divisor, suffix] of UNITS) {
    if (delta < limit) return `${Math.max(1, Math.round(delta / divisor))}${suffix} ago`;
  }

  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(timestamp);
}

export function clockTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value < 10 && exponent > 0 ? 1 : 0)} ${units[exponent]}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${plural}`;
}
