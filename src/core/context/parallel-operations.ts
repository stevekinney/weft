import { primeParallelOperations } from './child-workflow-pipe.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import {
  assertValidParallelOperationCacheEntry,
  BranchTopologyChangedError,
  createParallelOperationCacheEntry,
  isParallelOperationCacheEntry,
  type ParallelBranchSlot,
  type ParallelOperationCacheEntry,
} from './parallel-cache-entry.ts';
import { captureCallerStack } from './validation.ts';

/** Reconstruct the user-visible array result from a v2 entry's slots. */
function reconstructAllResult(entry: ParallelOperationCacheEntry): unknown[] {
  return entry.branches.map((slot) => {
    if (slot.status !== 'fulfilled') {
      throw new Error(
        `Cannot reconstruct ctx.all result: branch slot is ${slot.status}, not fulfilled`,
      );
    }
    return slot.value;
  });
}

/** Reconstruct the user-visible record result for `ctx.runAll`. */
function reconstructRunAllResult(entry: ParallelOperationCacheEntry): Record<string, unknown> {
  const names = entry.branchNames;
  if (names === undefined) {
    throw new Error('Cannot reconstruct ctx.runAll result: cache entry missing branchNames');
  }
  const result: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) {
    const slot = entry.branches[i];
    if (slot?.status !== 'fulfilled') {
      throw new Error(
        `Cannot reconstruct ctx.runAll result: branch '${names[i]}' is ${slot?.status ?? 'missing'}`,
      );
    }
    result[names[i]!] = slot.value;
  }
  return result;
}

/** True iff every slot in the entry is fulfilled (full success). */
function isEntryFullyFulfilled(entry: ParallelOperationCacheEntry): boolean {
  return entry.branches.every((slot) => slot.status === 'fulfilled');
}

export function* all(
  context: Context,
  internals: ContextInternals,
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step);
    assertValidParallelOperationCacheEntry(cached);
    if (isParallelOperationCacheEntry(cached)) {
      // Variant guard: a workflow that swapped ctx.all <-> ctx.race at the
      // same step would otherwise reconstruct the wrong shape. Treat as a
      // topology change.
      if (cached.variant !== 'all') {
        throw new BranchTopologyChangedError(
          `ctx.all step ${step} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
        );
      }
      // Topology guard: branch count must be deterministic across retries
      // even on the fully-fulfilled fast path. If the user changed
      // operations.length between attempts, returning the cached array
      // would silently feed wrong-position values into the workflow.
      if (operations.length !== cached.subOperationCount) {
        throw new BranchTopologyChangedError(
          `ctx.all branch count changed across retry: expected ${cached.subOperationCount}, got ${operations.length}. Branch count must be deterministic.`,
        );
      }
      if (isEntryFullyFulfilled(cached)) {
        internals.stepIndex += cached.subOperationCount;
        return reconstructAllResult(cached);
      }
      // Partial cache: re-yield with the cached entry so the engine reuses
      // fulfilled slots and re-dispatches the rest. Branch count was
      // already validated against `operations.length` above; priming
      // produces one sub-operation per input generator, so the count is
      // still valid here without rechecking.
      const subOperations = primeParallelOperations(operations);
      stampDeterministicOperationIds(subOperations, `parallel:${step}`);
      const callerStack = captureCallerStack();
      const result = yield {
        type: 'parallel',
        operationId: `parallel:${step}`,
        operations: subOperations,
        step,
        resumedCacheEntry: cached,
        callerStack,
      };
      // Engine wrote the v2 cache entry; don't overwrite.
      return result as unknown[];
    }

    return cached as unknown[];
  }

  const subOperations = primeParallelOperations(operations);
  const operationId = `parallel:${step}`;
  stampDeterministicOperationIds(subOperations, operationId);
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'parallel',
    operationId,
    operations: subOperations,
    step,
    callerStack,
  };

  // Write a fully-fulfilled v2 entry on success so resume sees a proper
  // cache entry regardless of execution mode (worker mode bypasses the
  // engine's `writePartialEntry` path).
  const values = result as unknown[];
  context.accumulatedResults.set(
    step,
    buildFulfilledAllEntry(values, operationId, subOperations.length),
  );
  return values;
}

/** Build a v2 cache entry from a fully-fulfilled `ctx.all` result. */
function buildFulfilledAllEntry(
  values: unknown[],
  operationId: string,
  subOperationCount: number,
): ParallelOperationCacheEntry {
  return createParallelOperationCacheEntry(
    'all',
    values.map(
      (value, i): ParallelBranchSlot => ({
        status: 'fulfilled',
        value,
        operationId: `${operationId}:${i}`,
      }),
    ),
    subOperationCount,
  );
}

export function* race(
  context: Context,
  internals: ContextInternals,
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
  branchNames?: string[],
): Generator<ContextOperationRequest, unknown, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step);
    assertValidParallelOperationCacheEntry(cached);
    if (isParallelOperationCacheEntry(cached)) {
      if (cached.variant !== 'race') {
        throw new BranchTopologyChangedError(
          `ctx.race step ${step} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
        );
      }
      assertRaceBranchTopology(operations.length, branchNames, cached);
      // isParallelOperationCacheEntry validates that a race cache contains
      // exactly one fulfilled winner, so the narrowed slot is trusted here.
      const winner = cached.branches[0] as Extract<ParallelBranchSlot, { status: 'fulfilled' }>;
      internals.stepIndex += cached.subOperationCount;
      return winner.value;
    }

    if (branchNames !== undefined) {
      throw new BranchTopologyChangedError(
        `ctx.raceKeyed step ${step} found a raw cached race value without keyed branch topology. The same step must use raceKeyed across retries.`,
      );
    }
    return cached;
  }

  const operationId = `race:${step}`;
  let subOperations: ContextOperationRequest[];
  if (branchNames === undefined) {
    subOperations = primeParallelOperations(operations);
  } else {
    const primed = primeKeyedRaceOperations(operations);
    subOperations = primed.subOperations;
    if (primed.synchronousWinner !== undefined) {
      // raceKeyed supplies one name per operation in the same object-entry order.
      const key = branchNames[primed.synchronousWinner.index]!;
      const result = { key, value: primed.synchronousWinner.value };
      cacheRaceWinner(context, step, result, operationId, operations.length, branchNames);
      return result;
    }
  }
  stampDeterministicOperationIds(subOperations, operationId);
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'race',
    operationId,
    operations: subOperations,
    ...(branchNames !== undefined ? { branchNames } : {}),
    callerStack,
  };

  // For race, the engine writes the winner directly via the existing
  // operation outcome path; we wrap it in a v2 entry here for symmetry
  // with ctx.all and to use the same isParallelOperationCacheEntry guard
  // on resume. `subOperationCount` keeps the original branch count so
  // the resume path can still advance the workflow's stepIndex past the
  // race's primed sub-operations.
  cacheRaceWinner(context, step, result, operationId, subOperations.length, branchNames);
  return result;
}

function primeKeyedRaceOperations(
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): {
  subOperations: ContextOperationRequest[];
  synchronousWinner: { index: number; value: unknown } | undefined;
} {
  const subOperations: ContextOperationRequest[] = [];
  let synchronousWinner: { index: number; value: unknown } | undefined;

  for (const [index, operation] of operations.entries()) {
    const primed = operation.next();
    if (primed.done) {
      synchronousWinner ??= { index, value: primed.value };
    } else {
      subOperations.push(primed.value);
    }
  }

  return { subOperations, synchronousWinner };
}

function cacheRaceWinner(
  context: Context,
  step: number,
  result: unknown,
  operationId: string,
  subOperationCount: number,
  branchNames: string[] | undefined,
): void {
  context.accumulatedResults.set(step, {
    __weftParallelOperationCache: true,
    formatVersion: 2,
    variant: 'race',
    branches: [{ status: 'fulfilled', value: result, operationId: `${operationId}:winner` }],
    ...(branchNames !== undefined ? { branchNames } : {}),
    subOperationCount,
  } satisfies ParallelOperationCacheEntry);
}

function sameBranchNames(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function assertRaceBranchTopology(
  operationCount: number,
  branchNames: string[] | undefined,
  cached: ParallelOperationCacheEntry,
): void {
  // Count and keyed branch order must be deterministic across retries. A changed
  // topology would otherwise skip the wrong sub-operation steps or attach the
  // cached winner value to a different public key.
  if (operationCount !== cached.subOperationCount) {
    throw new BranchTopologyChangedError(
      `ctx.race branch count changed across retry: expected ${cached.subOperationCount}, got ${operationCount}. Branch count must be deterministic.`,
    );
  }
  if (!sameBranchNames(branchNames, cached.branchNames)) {
    throw new BranchTopologyChangedError(
      `ctx.race branch names changed across retry: expected ${formatBranchNames(cached.branchNames)}, got ${formatBranchNames(branchNames)}. Branch names and order must be deterministic.`,
    );
  }
}

function formatBranchNames(branchNames: string[] | undefined): string {
  return branchNames === undefined ? 'positional branches' : JSON.stringify(branchNames);
}

/**
 * Replace each sub-operation's `operationId` with a deterministic value
 * derived from the parent `operationId` and the sub-operation's positional
 * index. Stable across retries — useful for observability and tracing.
 *
 * The deterministic IDs are NOT used as slot keys (slot identity is
 * positional/named). They exist purely as observability metadata.
 */
function stampDeterministicOperationIds(
  subOperations: ContextOperationRequest[],
  parentOperationId: string,
): void {
  for (let i = 0; i < subOperations.length; i++) {
    const op = subOperations[i];
    if (op !== undefined) {
      (op as { operationId: string }).operationId = `${parentOperationId}:${i}`;
    }
  }
}

export function* memo<T>(
  context: Context,
  internals: ContextInternals,
  key: string,
  fn: () => T | Promise<T>,
): Generator<ContextOperationRequest, T, unknown> {
  const step = internals.stepIndex++;

  if (internals.memoCache?.has(key)) {
    return internals.memoCache.get(key) as T;
  }

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step) as T;
    internals.memoCache ??= new Map();
    internals.memoCache.set(key, cached);
    return cached;
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'memo',
    operationId,
    key,
    step,
    fn,
    callerStack,
  };

  internals.memoCache ??= new Map();
  internals.memoCache.set(key, result);
  context.accumulatedResults.set(step, result);
  return result as T;
}

/**
 * Validate cached `ctx.runAll` topology against the workflow's current
 * branch list. Throws `BranchTopologyChangedError` on variant or
 * name-list mismatch.
 */
function validateRunAllTopology(
  cached: ParallelOperationCacheEntry,
  branchNames: string[],
  step: number,
): void {
  if (cached.variant !== 'run-all') {
    throw new BranchTopologyChangedError(
      `ctx.runAll step ${step} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
    );
  }
  const cachedNames = cached.branchNames ?? [];
  if (cachedNames.length !== branchNames.length) {
    throw new BranchTopologyChangedError(
      `ctx.runAll branch count changed across retry: expected ${cachedNames.length}, got ${branchNames.length}`,
    );
  }
  for (let i = 0; i < branchNames.length; i++) {
    if (cachedNames[i] !== branchNames[i]) {
      throw new BranchTopologyChangedError(
        `ctx.runAll branch order changed across retry: expected '${cachedNames[i]}' at index ${i}, got '${branchNames[i]}'. Branch names must appear in the same order across retries.`,
      );
    }
  }
}

export function* runAll<
  T extends Record<string, readonly [Function] | readonly [Function, unknown]>,
>(
  context: Context,
  internals: ContextInternals,
  branches: T,
): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown> {
  const step = internals.stepIndex++;
  const branchNames = Object.keys(branches);

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step);
    assertValidParallelOperationCacheEntry(cached);
    if (isParallelOperationCacheEntry(cached)) {
      validateRunAllTopology(cached, branchNames, step);
      if (isEntryFullyFulfilled(cached)) {
        return reconstructRunAllResult(cached) as Record<keyof T, unknown>;
      }
      // Partial cache: re-yield with the cached entry attached.
      const operationId = `run-all:${step}`;
      const callerStack = captureCallerStack();
      const result = yield {
        type: 'run-all' as const,
        operationId,
        branches,
        step,
        resumedCacheEntry: cached,
        callerStack,
      };
      // Engine wrote the v2 cache entry; don't overwrite.
      return result as Record<keyof T, unknown>;
    }
    return cached as Record<keyof T, unknown>;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.runAll({ ${branchNames.join(', ')} })`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Running ${branchNames.length} named branches in parallel`);
  }

  const operationId = `run-all:${step}`;
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'run-all' as const,
    operationId,
    branches,
    step,
    callerStack,
  };

  // Write a fully-fulfilled v2 entry on success so resume sees a proper
  // cache entry regardless of execution mode.
  const record = result as Record<string, unknown>;
  context.accumulatedResults.set(step, buildFulfilledRunAllEntry(record, branchNames, operationId));
  return result as Record<keyof T, unknown>;
}

/** Build a v2 cache entry from a fully-fulfilled `ctx.runAll` result. */
function buildFulfilledRunAllEntry(
  record: Record<string, unknown>,
  branchNames: string[],
  operationId: string,
): ParallelOperationCacheEntry {
  return createParallelOperationCacheEntry(
    'run-all',
    branchNames.map(
      (name): ParallelBranchSlot => ({
        status: 'fulfilled',
        value: record[name],
        operationId: `${operationId}:${name}`,
      }),
    ),
    branchNames.length,
    branchNames,
  );
}
