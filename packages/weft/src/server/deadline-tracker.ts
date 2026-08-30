/**
 * In-memory min-heap that tracks inflight task deadlines.
 *
 * Used by the visibility timeout scanner to avoid a full storage scan
 * on every tick. The scanner pops expired entries from the heap instead
 * of iterating all `op:inflight:*` records.
 *
 * Uses generation-based lazy deletion: each operation ID has a generation
 * counter. `remove()` bumps the generation in O(1), and heap entries with
 * an older generation are skipped during `popMin()` and `drainExpired()`.
 *
 * @module server/deadline-tracker
 */

/** A single tracked deadline entry. */
export type DeadlineEntry = {
  operationId: string;
  deadline: number;
};

/** Internal heap entry with a generation stamp for lazy deletion. */
type HeapEntry = DeadlineEntry & { generation: number };

/**
 * Min-heap ordered by deadline with O(1) lazy removal.
 *
 * - `add`: O(log n)
 * - `remove`: O(1) — bumps generation counter
 * - `popMin`: O(log n) amortized — skips stale entries
 * - `drainExpired`: O(k log n) where k is the number of expired entries
 */
export class DeadlineTracker {
  readonly #heap: HeapEntry[];
  /** Current live generation per operation ID. `0` means removed/absent. */
  readonly #liveGeneration: Map<string, number>;
  /** Monotonic counter used to stamp new entries. */
  #nextGeneration: number;
  #liveCount: number;

  constructor() {
    this.#heap = [];
    this.#liveGeneration = new Map();
    this.#nextGeneration = 1;
    this.#liveCount = 0;
  }

  /** Number of tracked deadlines (excludes stale entries). */
  get size(): number {
    return this.#liveCount;
  }

  /** Peek at the earliest non-stale deadline. Returns `undefined` if empty. */
  peekDeadline(): number | undefined {
    this.#purgeTop();
    return this.#heap[0]?.deadline;
  }

  /**
   * Add a new deadline entry. Any previous entry for this operation ID
   * becomes stale and will be skipped during pop/drain.
   */
  add(entry: DeadlineEntry): void {
    const wasLive = this.#isLive(entry.operationId);
    const generation = this.#nextGeneration++;
    this.#liveGeneration.set(entry.operationId, generation);
    this.#heap.push({ ...entry, generation });
    this.#siftUp(this.#heap.length - 1);
    if (!wasLive) this.#liveCount++;
  }

  /** Remove and return the entry with the earliest deadline, or `undefined` if empty. */
  popMin(): DeadlineEntry | undefined {
    this.#purgeTop();
    if (this.#heap.length === 0) return undefined;
    const min = this.#extractMin()!;
    this.#liveGeneration.delete(min.operationId);
    this.#liveCount--;
    return min;
  }

  /** Invalidate all entries for the given operation ID in O(1). */
  remove(operationId: string): void {
    if (!this.#isLive(operationId)) return;
    this.#liveGeneration.delete(operationId);
    this.#liveCount--;
  }

  /** Drain all non-stale entries whose deadline is at or before `now`. */
  drainExpired(now: number): DeadlineEntry[] {
    const expired: DeadlineEntry[] = [];
    while (true) {
      this.#purgeTop();
      if (this.#heap.length === 0 || this.#heap[0]!.deadline > now) break;
      const min = this.#extractMin()!;
      this.#liveGeneration.delete(min.operationId);
      this.#liveCount--;
      expired.push(min);
    }
    return expired;
  }

  /** Remove all entries. */
  clear(): void {
    this.#heap.length = 0;
    this.#liveGeneration.clear();
    this.#liveCount = 0;
  }

  /** Whether an operation ID currently has a live (non-removed) entry. */
  #isLive(operationId: string): boolean {
    const gen = this.#liveGeneration.get(operationId);
    return gen !== undefined && gen > 0;
  }

  /** Check if a heap entry is stale. */
  #isStale(entry: HeapEntry): boolean {
    const live = this.#liveGeneration.get(entry.operationId) ?? 0;
    return entry.generation !== live;
  }

  /** Remove the heap root. */
  #extractMin(): HeapEntry | undefined {
    if (this.#heap.length === 0) return undefined;
    const min = this.#heap[0]!;
    const last = this.#heap.pop()!;
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }
    return min;
  }

  /** Pop and discard stale entries from the top of the heap. */
  #purgeTop(): void {
    while (this.#heap.length > 0 && this.#isStale(this.#heap[0]!)) {
      this.#extractMin();
    }
  }

  #siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.#heap[parent]!.deadline <= this.#heap[index]!.deadline) break;
      [this.#heap[parent], this.#heap[index]] = [this.#heap[index]!, this.#heap[parent]!];
      index = parent;
    }
  }

  #siftDown(index: number): void {
    const length = this.#heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.#heap[left]!.deadline < this.#heap[smallest]!.deadline) {
        smallest = left;
      }
      if (right < length && this.#heap[right]!.deadline < this.#heap[smallest]!.deadline) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.#heap[smallest], this.#heap[index]] = [this.#heap[index]!, this.#heap[smallest]!];
      index = smallest;
    }
  }
}
