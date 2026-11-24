/**
 * Validation for the A2A kit's options that become a timer delay.
 *
 * @module a2a/timer-delay
 */

/** The largest delay a timer accepts; Bun clamps anything above it to about 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Return `value` when it is a delay a timer honours: an integer from 1 to
 * {@link MAX_TIMER_MS}. A larger one would fire after about 1 ms instead, turning an
 * intended long wait into a busy loop.
 *
 * @throws {RangeError} Naming the option `name` when `value` is outside that range.
 */
export function requireTimerDelayMs(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be an integer from 1 to ${MAX_TIMER_MS}; received ${value}.`,
    );
  }
  return value;
}
