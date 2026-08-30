/**
 * Cache entry shape and validators for parallel operations
 * (`ctx.all` / `ctx.race` / `ctx.runAll`). Lives in its own module so
 * `parallel-operations.ts` (the generators) stays under the file-size
 * cap — the generator logic and the cache-entry shape are independently
 * reviewable.
 *
 * The v2 `ParallelOperationCacheEntry` shape is what gets written into
 * the workflow's `accumulatedResults` map. It carries per-branch slots
 * (pending/fulfilled/rejected/aborted) so partial-failure preservation
 * can be reconstructed across retries — see `parallel-execution.md`
 * for the durability contract.
 */

import { WeftError } from '../weft-error.ts';

/**
 * One slot in a {@link ParallelOperationCacheEntry}'s `branches` table.
 *
 * - `pending`: branch was dispatched but never observed to settle (e.g., the
 *   process crashed before its result was recorded). Re-dispatched on retry.
 * - `fulfilled`: branch completed successfully. Reused on retry; never re-runs.
 * - `rejected`: branch threw. Metadata only — never reused on retry; the
 *   branch re-dispatches just like a `pending` slot. The `reason` is a
 *   normalized `{ name, message }` because raw `Error` objects don't
 *   round-trip through MessagePack.
 * - `aborted`: reserved for `ctx.race` losers. Never produced by
 *   `ctx.all`/`ctx.runAll` because they don't cancel siblings on failure.
 */
export type ParallelBranchSlot =
  | { status: 'pending'; operationId: string }
  | { status: 'fulfilled'; value: unknown; operationId: string }
  | {
      status: 'rejected';
      reason: { name: string; message: string };
      operationId: string;
    }
  | { status: 'aborted'; operationId: string };

/**
 * Persistent record of a parallel operation's per-branch outcomes. Stored
 * in `accumulatedResults` at the parent operation's step. On retry, the
 * generator inspects this entry and lets fulfilled branches skip dispatch
 * while non-fulfilled branches re-execute.
 *
 * `formatVersion: 2` is the v2 shape — the only shape v2-aware engines
 * write or read.
 */
export type ParallelOperationCacheEntry = {
  __weftParallelOperationCache: true;
  formatVersion: 2;
  variant: 'all' | 'race' | 'run-all';
  branches: ParallelBranchSlot[];
  /** Ordered key list for `run-all` or `raceKeyed`; absent for `all` and positional `race`. */
  branchNames?: string[];
  subOperationCount: number;
};

/**
 * Thrown when the workflow's branch topology (count for `ctx.all`, ordered
 * key list for `ctx.runAll`) differs from the cached entry on retry.
 * Indicates non-deterministic workflow code — branches must be stable
 * across retries.
 *
 * @example
 * ```ts
 * import { BranchTopologyChangedError } from '@lostgradient/weft';
 *
 * function isBranchTopologyChange(error: unknown): boolean {
 *   return error instanceof BranchTopologyChangedError;
 * }
 * ```
 */
export class BranchTopologyChangedError extends WeftError<'BranchTopologyChangedError'> {
  constructor(message: string) {
    super('BranchTopologyChangedError', message);
  }
}

function isValidVariant(value: unknown): value is 'all' | 'race' | 'run-all' {
  return value === 'all' || value === 'race' || value === 'run-all';
}

function isValidSlotStatus(
  value: unknown,
): value is 'pending' | 'fulfilled' | 'rejected' | 'aborted' {
  return (
    value === 'pending' || value === 'fulfilled' || value === 'rejected' || value === 'aborted'
  );
}

function isValidRejectionReason(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const reason = value as Record<string, unknown>;
  return typeof reason['name'] === 'string' && typeof reason['message'] === 'string';
}

function isValidBranchSlot(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const slot = value as Record<string, unknown>;
  if (!isValidSlotStatus(slot['status'])) return false;
  if (typeof slot['operationId'] !== 'string') return false;
  if (slot['status'] === 'rejected' && !isValidRejectionReason(slot['reason'])) return false;
  return true;
}

function isValidBranchNames(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((name) => typeof name === 'string');
}

function isValidSubOperationCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasParallelOperationCacheMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['__weftParallelOperationCache'] === true
  );
}

function hasValidBranchTopology(
  variant: 'all' | 'race' | 'run-all',
  branches: unknown[],
  subOperationCount: number,
  branchNames: unknown,
): boolean {
  if (variant === 'race') {
    return hasValidRaceTopology(branches, subOperationCount, branchNames);
  }
  if (branches.length !== subOperationCount) {
    return false;
  }
  if (variant === 'run-all') {
    return Array.isArray(branchNames) && branchNames.length === subOperationCount;
  }
  return branchNames === undefined;
}

function hasValidRaceTopology(
  branches: unknown[],
  subOperationCount: number,
  branchNames: unknown,
): boolean {
  // Race always caches exactly one fulfilled winner; anything else is malformed
  // and would skip the stepIndex advance on resume.
  if (branches.length !== 1 || subOperationCount < 1) return false;
  const winner = branches[0] as Record<string, unknown> | null | undefined;
  if (winner == null || typeof winner !== 'object') return false;
  if (winner['status'] !== 'fulfilled') return false;
  return (
    branchNames === undefined ||
    (Array.isArray(branchNames) && branchNames.length === subOperationCount)
  );
}

/** Type guard for the v2 parallel-operation cache entry shape. */
export function isParallelOperationCacheEntry(
  value: unknown,
): value is ParallelOperationCacheEntry {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record['__weftParallelOperationCache'] !== true) return false;
  if (record['formatVersion'] !== 2) return false;
  if (!isValidVariant(record['variant'])) return false;
  if (!Array.isArray(record['branches'])) return false;
  if (!isValidSubOperationCount(record['subOperationCount'])) return false;
  if (!isValidBranchNames(record['branchNames'])) return false;
  const subOperationCount = record['subOperationCount'] as number;
  if (
    !hasValidBranchTopology(
      record['variant'],
      record['branches'],
      subOperationCount,
      record['branchNames'],
    )
  ) {
    return false;
  }
  return record['branches'].every(isValidBranchSlot);
}

/**
 * Throw `BranchTopologyChangedError` if the value carries the
 * parallel-operation cache marker but doesn't pass the full v2 shape
 * check. Used to surface malformed entries (e.g. checkpoints written
 * by a future engine version) instead of silently producing wrong
 * replay behavior.
 *
 * NOT an `asserts` predicate: a value without the marker is also a
 * valid input here (it means the cache slot held a plain cached value).
 * Callers still narrow via `isParallelOperationCacheEntry` after calling
 * this. Using `asserts` would over-narrow plain non-parallel cached
 * values and mark the current plain-value return path as dead code in
 * TypeScript.
 */
export function assertValidParallelOperationCacheEntry(value: unknown): void {
  if (hasParallelOperationCacheMarker(value) && !isParallelOperationCacheEntry(value)) {
    throw new BranchTopologyChangedError(
      'Parallel operation cache entry is malformed or incompatible with this engine version.',
    );
  }
}

/** Build a fresh v2 cache entry with the given branch slots. */
export function createParallelOperationCacheEntry(
  variant: 'all' | 'race' | 'run-all',
  branches: ParallelBranchSlot[],
  subOperationCount: number,
  branchNames?: string[],
): ParallelOperationCacheEntry {
  return {
    __weftParallelOperationCache: true,
    formatVersion: 2,
    variant,
    branches,
    ...(branchNames !== undefined ? { branchNames } : {}),
    subOperationCount,
  };
}
