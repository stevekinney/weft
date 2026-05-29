/**
 * Shared output helpers for the hand-authored, server-facing CLI commands.
 *
 * Centralizes color detection (TTY + `NO_COLOR`/`FORCE_COLOR`), human-friendly
 * duration and timestamp rendering, NDJSON serialization, and destructive-action
 * confirmation. Every noun-verb command consumes these helpers so the DX
 * conventions (table on a TTY, NDJSON under `--json`, prompts before destructive
 * operations) stay consistent across the surface.
 *
 * @module cli/output
 */

/** Returns true when ANSI color should be emitted for the given stream. */
export function supportsColor(stream: { isTTY?: boolean } | undefined = process.stdout): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '') return true;
  return stream?.isTTY === true;
}

/** ANSI color helpers gated by {@link supportsColor}. */
export const color = {
  green: (text: string) => (supportsColor() ? `\x1b[32m${text}\x1b[0m` : text),
  yellow: (text: string) => (supportsColor() ? `\x1b[33m${text}\x1b[0m` : text),
  red: (text: string) => (supportsColor() ? `\x1b[31m${text}\x1b[0m` : text),
  cyan: (text: string) => (supportsColor() ? `\x1b[36m${text}\x1b[0m` : text),
  dim: (text: string) => (supportsColor() ? `\x1b[2m${text}\x1b[0m` : text),
  bold: (text: string) => (supportsColor() ? `\x1b[1m${text}\x1b[0m` : text),
};

/**
 * Serialize an array of values as NDJSON: one compact JSON object per line.
 * Entries that `JSON.stringify` cannot encode (e.g. `undefined`, functions)
 * are skipped so the output is always valid NDJSON.
 */
export function ndjson(values: readonly unknown[]): string {
  return values
    .map((value) => JSON.stringify(value))
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

/**
 * Pretty-print a single value as indented JSON for non-list `--json` output.
 * Returns `'null'` when `JSON.stringify` yields `undefined` (e.g. for void
 * results) so the contract of returning a valid JSON string is always upheld.
 */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

/** Render a Unix-millisecond timestamp as an ISO string, or `-` when absent. */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Date(value).toISOString();
}

/**
 * Render a millisecond duration as a compact human string (e.g. `1.5s`, `2m 3s`,
 * `1h 4m`). Sub-second durations render in milliseconds.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  // Use integer-millisecond floor for bucket boundary to prevent "1000ms"
  // when milliseconds is fractional (e.g. 999.5 rounds to 1000 with Math.round).
  const wholeMilliseconds = Math.floor(milliseconds);
  if (wholeMilliseconds < 1000) return `${wholeMilliseconds}ms`;
  const totalSeconds = milliseconds / 1000;
  // Use integer-seconds arithmetic throughout to avoid rounding across bucket
  // boundaries (e.g. 59.999s rounding to "60s", or 119.6s producing "1m 60s").
  const totalWholeSeconds = Math.floor(totalSeconds);
  if (totalWholeSeconds < 60) {
    if (totalWholeSeconds < 10) {
      // Show one decimal place but clamp to the whole-second floor so rounding
      // can never cross bucket boundaries (e.g. 9.999s → "9.9s", not "10.0s").
      const clamped = Math.min(totalSeconds, totalWholeSeconds + 0.9);
      return `${clamped.toFixed(1)}s`;
    }
    return `${totalWholeSeconds}s`;
  }
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const seconds = totalWholeSeconds - totalMinutes * 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Truncate a string to fit a terminal column width, appending an ellipsis when
 * the value is clipped. A non-positive or non-finite width returns the value
 * unchanged so non-TTY output is never lossy.
 */
export function truncateToWidth(value: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0 || value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

/**
 * Confirmation gate for destructive operations.
 *
 * - `assumeYes` (the `--yes`/`-y` flag) bypasses the prompt entirely and returns `'confirmed'`.
 * - On a non-interactive stdin without `--yes`, returns `'non-interactive'` so the caller
 *   can exit 1 with a clear message rather than hanging on a prompt.
 * - On a TTY, prints `prompt` and reads a line; defaults to No unless the reply
 *   starts with `y`/`Y`. Returns `'confirmed'` or `'denied'` accordingly.
 */
export async function confirmDestructive(options: {
  readonly prompt: string;
  readonly assumeYes: boolean;
  readonly isTty?: boolean;
  readonly readLine?: () => Promise<string>;
}): Promise<'confirmed' | 'denied' | 'non-interactive'> {
  if (options.assumeYes) return 'confirmed';
  const interactive = options.isTty ?? Boolean(process.stdin.isTTY);
  if (!interactive) return 'non-interactive';

  const readLine = options.readLine ?? defaultReadLine;
  process.stdout.write(`${options.prompt} [y/N] `);
  const rawAnswer = await readLine();
  const answer = rawAnswer.trim().toLowerCase();
  return answer.startsWith('y') ? 'confirmed' : 'denied';
}

async function defaultReadLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value, done } = await reader.read();
    if (done || value === undefined) return '';
    const text = new TextDecoder().decode(value);
    const newlineIndex = text.indexOf('\n');
    return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  } finally {
    reader.releaseLock();
  }
}

/** Extract a human-readable message from an unknown error value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
