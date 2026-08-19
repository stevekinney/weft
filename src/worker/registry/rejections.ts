// ---------------------------------------------------------------------------
// Bounded, in-memory registration-rejection log
// ---------------------------------------------------------------------------

import type { RegisterErrorMessage } from '../protocol.ts';

/** Number of most-recent rejection entries retained before the oldest is evicted. */
export const MAX_REGISTRATION_REJECTION_ENTRIES = 200;

/**
 * One declined `register` attempt.
 *
 * Deliberately bounded content: the rejection `code` (the same taxonomy
 * `registerError` sends on the wire), the attempted `workerId` when the frame
 * carried one, and whichever deployment/queue identity had already been
 * parsed by the time the gate that rejected it ran. No free-text message and
 * no manifest content — this is an auditable event log, not a diagnostic
 * dump. `workerId` is optional because the earliest rejection gate — a
 * malformed or wire-shape-invalid frame — can fail before any `workerId`
 * is known to be valid.
 */
export type RegistrationRejectionEntry = Readonly<{
  code: RegisterErrorMessage['code'];
  workerId?: string | undefined;
  rejectedAt: number;
  queue?: string | undefined;
  deploymentName?: string | undefined;
  buildId?: string | undefined;
}>;

/**
 * Append `entry` to `log`, evicting the oldest entry once the log exceeds
 * {@link MAX_REGISTRATION_REJECTION_ENTRIES}. Mutates `log` in place and
 * returns it, matching the registry's existing in-place array conventions.
 */
export function appendRegistrationRejection(
  log: RegistrationRejectionEntry[],
  entry: RegistrationRejectionEntry,
): RegistrationRejectionEntry[] {
  log.push(entry);
  if (log.length > MAX_REGISTRATION_REJECTION_ENTRIES) {
    log.splice(0, log.length - MAX_REGISTRATION_REJECTION_ENTRIES);
  }
  return log;
}

/** Return the `limit` most recent entries, newest first. */
export function recentRegistrationRejections(
  log: readonly RegistrationRejectionEntry[],
  limit: number,
): RegistrationRejectionEntry[] {
  return log.slice(Math.max(0, log.length - limit)).toReversed();
}
