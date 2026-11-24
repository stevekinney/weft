/**
 * In-process retry of the engine-owned durable writes a storage adapter refused: a workflow's
 * checkpoint batch and its two terminal `wf:<id>` writes. See {@link retryRefusedStorageWrite}.
 *
 * What counts as refused is decided by where an error came from, never by its message: the fenced
 * write path marks an error as the storage adapter's own at the call that threw it
 * ({@link adapterCall}, {@link adapterConditionalBatch}), and only a marked error is retried.
 *
 * @module core/engine/storage-write-retry
 */
import {
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from "../../embedded/storage/src/index.ts";
import {
  CheckpointCommitFailedError,
  type RefusedStorageWrite,
} from './checkpoint-commit-failed-error.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import { CheckpointEncodingError } from './checkpoint-encoding-error.ts';
import { EngineDisposedError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { EngineDeposedError } from './lease-errors.ts';
import { STORAGE_WRITE_RETRY_DELAYS_MS } from './termination/terminal-fence.ts';

/** The errors a storage adapter threw from a write call. Held weakly: a primitive cannot be marked. */
const storageAdapterErrors = new WeakSet<object>();

/**
 * Errors that are never retried even if an adapter happens to throw one: a checkpoint that cannot
 * be encoded, a lost compare-and-swap, a deposition, and a disposed engine each have their own
 * handling, and a retry would only repeat what they already decided.
 */
function isNeverRetried(error: unknown): boolean {
  return (
    error instanceof CheckpointEncodingError ||
    error instanceof WorkflowCheckpointConflictError ||
    error instanceof EngineDeposedError ||
    error instanceof EngineDisposedError
  );
}

/** Mark `error` as one the storage adapter threw from a write. Safe on any value; returns nothing. */
export function markStorageAdapterError(error: unknown): void {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return;
  if (isNeverRetried(error)) return;
  storageAdapterErrors.add(error);
}

/** Whether `error` was thrown by a storage adapter's write, and so may be retried. */
export function isRetryableStorageWriteError(error: unknown): boolean {
  return (
    (typeof error === 'object' || typeof error === 'function') &&
    error !== null &&
    storageAdapterErrors.has(error) &&
    !isNeverRetried(error)
  );
}

/**
 * Issue one storage adapter write and mark whatever it throws, without adding a promise turn: the
 * mark is a side reaction registered before the caller can await, so a successful write settles
 * for its caller exactly when it would without this wrapper (the checkpoint path is sensitive to
 * an extra turn, see {@link persistCheckpointAbandoningOnConflict}).
 */
export function adapterCall<T>(write: () => Promise<T>): Promise<T> {
  let pending: Promise<T>;
  try {
    pending = write();
  } catch (error) {
    markStorageAdapterError(error);
    throw error;
  }
  void pending.catch(markStorageAdapterError);
  return pending;
}

/**
 * {@link storageConditionalBatch} with the adapter's own `conditionalBatch` marked. The wrapper's
 * argument validation and capability checks throw their own errors before the adapter is called,
 * and those are deterministic, so only the adapter's call is marked.
 */
export function adapterConditionalBatch(
  storage: Storage,
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
): Promise<boolean> {
  const adapterConditionalBatchOf = storage.conditionalBatch?.bind(storage);
  if (adapterConditionalBatchOf === undefined) {
    return storageConditionalBatch(storage, conditions, operations);
  }
  return storageConditionalBatch(
    {
      capabilities: () => storage.capabilities(),
      conditionalBatch: (batchConditions, batchOperations) =>
        adapterCall(() => adapterConditionalBatchOf(batchConditions, batchOperations)),
    },
    conditions,
    operations,
  );
}

/**
 * Wait `milliseconds` before the next attempt, or throw {@link EngineDisposedError} as soon as the
 * engine is disposed: disposal ends the wait at once and the engine writes nothing more, leaving
 * the run for the next boot as a graceful shutdown does. The timer is cleared on either outcome,
 * so none outlives the engine.
 */
function waitBeforeRetry(internals: EngineInternals, milliseconds: number): Promise<void> {
  const signal = internals.abortController.signal;
  if (internals.disposed || signal.aborted) return Promise.reject(new EngineDisposedError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new EngineDisposedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The test-only replacements for the wait before a retry, per engine; see {@link holdStorageWriteRetryWaitsForTesting}. */
const retryWaitsForTesting = new WeakMap<
  EngineInternals,
  (milliseconds: number) => Promise<void>
>();

/**
 * Replace the wait before each further attempt of `internals`' refused writes with `wait`, which is
 * given the delay the attempt would have waited: a test holds a retry in its wait, with no attempt
 * in flight, and acts on the engine meanwhile. Nothing replaces the wait in production, where it is
 * a timer the engine's disposal ends.
 */
export function holdStorageWriteRetryWaitsForTesting(
  internals: EngineInternals,
  wait: (milliseconds: number) => Promise<void>,
): void {
  retryWaitsForTesting.set(internals, wait);
}

/** Which write is being retried, and for which generation of which workflow. */
export type RefusedWriteDescriptor = {
  readonly workflowId: string;
  readonly write: RefusedStorageWrite;
  readonly workflowExecutionToken: string | undefined;
};

/**
 * Retry an engine-owned write that storage refused, after its first attempt threw `firstError`.
 *
 * A refusal the adapter threw is retried up to `STORAGE_WRITE_RETRY_DELAYS_MS.length` more times,
 * waiting the listed delay before each; anything else is rethrown at once, so the write is
 * attempted exactly once. `attemptWrite` repeats the same write (the same operations and
 * conditions, never a recomputed batch) and returns whether it committed, so a caller that can
 * recognize a write that landed but reported failure folds that into its own return value. When
 * every attempt is refused this throws {@link CheckpointCommitFailedError} naming the last cause.
 * Tests shorten the waits through `EngineInternals.storageWriteRetryDelaysForTesting`, or hold them
 * through {@link holdStorageWriteRetryWaitsForTesting}.
 *
 * Callers invoke this from the `catch` of their own first attempt rather than wrapping it, so a
 * write that succeeds first time pays no extra promise turn.
 */
export async function retryRefusedStorageWrite(
  internals: EngineInternals,
  descriptor: RefusedWriteDescriptor,
  firstError: unknown,
  attemptWrite: () => Promise<boolean>,
): Promise<boolean> {
  if (!isRetryableStorageWriteError(firstError)) throw firstError;
  const delays = internals.storageWriteRetryDelaysForTesting ?? STORAGE_WRITE_RETRY_DELAYS_MS;
  const wait =
    retryWaitsForTesting.get(internals) ??
    ((milliseconds: number) => waitBeforeRetry(internals, milliseconds));
  let lastError: unknown = firstError;
  for (const delay of delays) {
    await wait(delay);
    try {
      return await attemptWrite();
    } catch (error) {
      if (!isRetryableStorageWriteError(error)) throw error;
      lastError = error;
    }
  }
  throw new CheckpointCommitFailedError(descriptor.workflowId, {
    write: descriptor.write,
    attempts: delays.length + 1,
    cause: lastError,
    workflowExecutionToken: descriptor.workflowExecutionToken,
  });
}
