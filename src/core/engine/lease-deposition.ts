/**
 * Deposition handling for `ownership: 'lease'` Step-2 fencing (issue #470).
 *
 * "Deposed" means another instance now holds the ownership lease at a strictly
 * newer epoch, so this instance has lost the store. Deposition is detected at two
 * sites and both funnel here:
 *
 * - A fenced durable write's CAS fails against a newer epoch
 *   ({@link commitFencedEngineWrite} re-reads `lease:epoch` to disambiguate).
 * - The lease manager's renewal reports `onLeaseLost('deposed')` (a successor
 *   stole the holder out from under an otherwise-idle engine).
 *
 * The renewal-loss reason `'renewal-unconfirmable'` is deliberately NOT routed
 * here: it is a transient storage blip (the holder could not prove it still
 * holds), and halting a healthy holder on a momentary storage hiccup would be a
 * self-inflicted outage. Only a confirmed `'deposed'` triggers the halt.
 *
 * {@link handleDeposition} is idempotent (guarded on {@link EngineInternals.deposed})
 * and does the minimum synchronously — set the flag, warn the operator — then
 * schedules engine teardown on a later tick. Teardown is never run inline:
 * detection happens mid-commit while a workflow generator is advancing, and
 * synchronous {@link disposeEngine} clears maps that the unwinding commit and
 * other in-flight workflows still touch. The flag (plus the
 * {@link commitFencedEngineWrite} top short-circuit) carries the halt guarantee;
 * deferring the actual dispose by a tick is safe because every write in that
 * window is still fenced on the now-stale epoch and loses its CAS.
 *
 * This module is allow-listed for import only from `src/core/engine/**`.
 */

import type { EngineInternals } from './internals.ts';

/**
 * The `name` of the `process` warning emitted when an engine configured with
 * `ownership: 'lease'` can no longer be sure it owns the store. The same name
 * covers all three signals, so a single `process.on('warning')` handler catches
 * every "this engine may no longer own the store" event:
 *
 * - **deposed (confirmed)** — a renewal's CAS failed (a successor stole the lease),
 *   or a fenced durable write was rejected because a newer epoch holds the store
 *   (Step 2). The engine halts.
 * - **renewal-unconfirmable (transient)** — a storage error left the holder unable
 *   to prove it still holds within the lease window. This is NOT a confirmed
 *   deposition; the engine keeps running, and a later renewal or fenced write
 *   resolves the truth. The warning is informational so operators can investigate.
 *
 * Filter on this name to react to ownership-loss signals (alert, drain, restart).
 *
 * @example
 * ```ts
 * import { ENGINE_LEASE_LOST_WARNING_NAME } from '@lostgradient/weft';
 *
 * process.on('warning', (warning) => {
 *   if (warning.name === ENGINE_LEASE_LOST_WARNING_NAME) {
 *     // This engine may no longer own the store — investigate / drain / restart.
 *   }
 * });
 * ```
 */
export const ENGINE_LEASE_LOST_WARNING_NAME = 'WeftEngineLeaseLostWarning';

/**
 * React to a confirmed deposition. Idempotent: the first call sets the deposed
 * flag, emits the operator warning, and schedules a deferred engine teardown;
 * subsequent calls are no-ops. Returns immediately — the caller is expected to
 * then throw {@link EngineDeposedError} to unwind the current commit so it does
 * not advance in-memory state past a durable write that did not land.
 */
export function handleDeposition(internals: EngineInternals): void {
  if (internals.deposed) return;
  internals.deposed = true;

  // The fenced-write throw is swallowed at the inline strategy's turn boundary,
  // so this warning is the only thing that surfaces deposition to the operator.
  process.emitWarning(
    'engine deposed: a durable write was fenced out because another instance now holds this ' +
      "store's ownership lease at a newer epoch. This engine is halting to avoid split-brain " +
      'writes. Weft supports one engine process per store; ensure your deploy hands off cleanly ' +
      '(graceful shutdown releases the lease) and keep infrastructure-level single-instance ' +
      'enforcement in place.',
    ENGINE_LEASE_LOST_WARNING_NAME,
  );

  // Defer teardown off the current commit's stack. Running it inline would be
  // re-entrant teardown while a generator is mid-advance, clearing maps the
  // unwinding code still reads. The teardown itself is the engine's
  // `disposeAfterDeposition`, injected onto internals at construction — so this
  // module never statically imports `disposal.ts` (which would close an import
  // cycle through `storage-io → fenced-write → lease-deposition`).
  const tearDown = internals.tearDownAfterDeposition;
  if (tearDown !== null) {
    // Contain the deferred callback: a synchronous throw inside it would otherwise
    // become an unhandled rejection while the engine is already unwinding.
    void Promise.resolve()
      .then(tearDown)
      .catch(() => {});
  }
}
