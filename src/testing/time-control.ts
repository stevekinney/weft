/**
 * Deterministic virtual clock for testing durable workflows.
 *
 * Does NOT monkey-patch global timers. Instead, provides an explicit
 * `now` property and a `schedule` method for registering timer callbacks
 * that fire when virtual time is advanced past their target.
 *
 * @module testing/time-control
 */

import { parseDuration } from '../core/scheduler';
import type { Duration } from '../core/types';

interface ScheduledTimer {
  fireAt: number;
  callback: () => void | Promise<void>;
  id: number;
  cancelled: boolean;
}

/**
 * Deterministic virtual clock for testing durable workflows that depend on
 * time-based behaviour (timers, delays, scheduling).
 *
 * Does NOT monkey-patch global timers.  Instead, provides an explicit `now`
 * property and an `advance` method that fires registered callbacks in
 * chronological order as virtual time moves forward.  Use this inside a
 * {@link TestEngine} to write fully deterministic timer tests.
 *
 * @example
 * ```ts
 * import { TimeControl } from '@lostgradient/weft/testing';
 *
 * const clock = new TimeControl(0);
 * let fired = false;
 *
 * clock.schedule(5_000, () => {
 *   fired = true;
 * });
 *
 * await clock.advance('5s');
 * console.log(fired);   // true
 * console.log(clock.now); // 5000
 * ```
 */
export class TimeControl {
  #currentTime: number;
  #timers: ScheduledTimer[];
  #nextId: number;

  constructor(startTime?: number) {
    this.#currentTime = startTime ?? Date.now();
    this.#timers = [];
    this.#nextId = 1;
  }

  /** Current virtual time in milliseconds since epoch. */
  get now(): number {
    return this.#currentTime;
  }

  /**
   * Advance time by duration. Fires all timers that fall within the
   * window, in chronological order.
   */
  async advance(duration: Duration): Promise<void> {
    const target = this.#currentTime + parseDuration(duration);
    await this.#fireTimersUpTo(target);
    this.#currentTime = target;
  }

  /** Advance time to a specific timestamp. Throws if in the past. */
  async advanceTo(timestamp: number): Promise<void> {
    if (timestamp < this.#currentTime) {
      throw new Error(
        `Cannot advance to ${timestamp}: current time is already ${this.#currentTime}`,
      );
    }
    await this.#fireTimersUpTo(timestamp);
    this.#currentTime = timestamp;
  }

  /**
   * Schedule a timer callback at a specific virtual time.
   * Returns a cancel function.
   */
  schedule(fireAt: number, callback: () => void | Promise<void>): () => void {
    const timer: ScheduledTimer = {
      fireAt,
      callback,
      id: this.#nextId++,
      cancelled: false,
    };
    this.#timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Number of pending (non-cancelled, not-yet-fired) timers. */
  get pendingTimerCount(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }

  /** Peek at the next timer's fire time. */
  get nextTimerAt(): number | undefined {
    const pending = this.#timers
      .filter((timer) => !timer.cancelled)
      .toSorted((a, b) => a.fireAt - b.fireAt);
    return pending[0]?.fireAt;
  }

  /** Reset to initial state. */
  reset(startTime?: number): void {
    this.#currentTime = startTime ?? Date.now();
    this.#timers = [];
    this.#nextId = 1;
  }

  /**
   * Fire all non-cancelled timers with fireAt <= target, in chronological
   * order, stepping #currentTime to each timer's fireAt as it fires.
   */
  async #fireTimersUpTo(target: number): Promise<void> {
    for (;;) {
      // Find the earliest non-cancelled timer that should fire
      let earliest: ScheduledTimer | undefined;
      let earliestIndex = -1;

      for (let i = 0; i < this.#timers.length; i++) {
        const timer = this.#timers[i]!;
        if (timer.cancelled || timer.fireAt > target) continue;
        if (earliest === undefined || timer.fireAt < earliest.fireAt) {
          earliest = timer;
          earliestIndex = i;
        }
      }

      if (earliest === undefined) break;

      // Remove from the queue
      this.#timers.splice(earliestIndex, 1);

      // Step virtual time to the timer's fire time
      this.#currentTime = earliest.fireAt;

      // Execute the callback
      await earliest.callback();
    }
  }
}
