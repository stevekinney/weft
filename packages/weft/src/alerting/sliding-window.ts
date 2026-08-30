/**
 * Sliding time window data structures for metric computation.
 *
 * Both windows use a chronologically-ordered deque and binary search for
 * pruning, keeping amortized cost O(log n) per event rather than O(n).
 *
 * @module alerting/sliding-window
 */

// ---------------------------------------------------------------------------
// Binary search helper
// ---------------------------------------------------------------------------

/**
 * Find the index of the first element whose timestamp >= cutoff using binary
 * search. Returns the array length if no such element exists.
 */
function lowerBound(entries: readonly { timestamp: number }[], cutoff: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid]!.timestamp < cutoff) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ---------------------------------------------------------------------------
// CounterWindow
// ---------------------------------------------------------------------------

/** Tracks event counts for rate computation (e.g., failure_rate). */
export class CounterWindow {
  #windowMs: number;
  #events: Array<{ timestamp: number; failed: boolean }>;
  #failureCount: number;

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
    this.#events = [];
    this.#failureCount = 0;
  }

  /** Record an event with its timestamp and failure status. */
  record(timestamp: number, failed: boolean): void {
    this.#events.push({ timestamp, failed });
    if (failed) this.#failureCount++;
    this.#prune(timestamp);
  }

  /** Returns failure rate as a number between 0 and 1. Returns 0 if no events. */
  rate(now: number): number {
    this.#prune(now);
    if (this.#events.length === 0) return 0;
    return this.#failureCount / this.#events.length;
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    const start = lowerBound(this.#events, cutoff);
    if (start === 0) return;
    // Count failures being removed
    for (let i = 0; i < start; i++) {
      if (this.#events[i]!.failed) this.#failureCount--;
    }
    this.#events.splice(0, start);
  }
}

// ---------------------------------------------------------------------------
// HistogramWindow
// ---------------------------------------------------------------------------

/** Stores individual values for percentile computation (e.g., p99 duration). */
export class HistogramWindow {
  #windowMs: number;
  #observations: Array<{ timestamp: number; value: number }>;
  /** Values sorted in ascending order for O(1) percentile lookups after prune. */
  #sortedValues: number[];

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
    this.#observations = [];
    this.#sortedValues = [];
  }

  /** Record an observation with its timestamp. */
  record(timestamp: number, value: number): void {
    this.#observations.push({ timestamp, value });
    this.#insertSorted(value);
    this.#prune(timestamp);
  }

  /** Returns the p-th percentile value (p between 0 and 100). Returns 0 if no observations. */
  percentile(p: number, now: number): number {
    this.#prune(now);
    if (this.#sortedValues.length === 0) return 0;
    const index = Math.ceil((p / 100) * this.#sortedValues.length) - 1;
    return this.#sortedValues[Math.max(0, index)] ?? 0;
  }

  /** Insert a value into the sorted array at the correct position (binary search). */
  #insertSorted(value: number): void {
    let lo = 0;
    let hi = this.#sortedValues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#sortedValues[mid]! < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.#sortedValues.splice(lo, 0, value);
  }

  /** Remove a value from the sorted array (binary search + splice). */
  #removeSorted(value: number): void {
    let lo = 0;
    let hi = this.#sortedValues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#sortedValues[mid]! < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // lo is the first position where sorted[lo] >= value
    if (lo < this.#sortedValues.length && this.#sortedValues[lo] === value) {
      this.#sortedValues.splice(lo, 1);
    }
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    const start = lowerBound(this.#observations, cutoff);
    if (start === 0) return;
    // Remove pruned values from sorted array
    for (let i = 0; i < start; i++) {
      this.#removeSorted(this.#observations[i]!.value);
    }
    this.#observations.splice(0, start);
  }
}
