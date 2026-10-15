import {
  KEYS,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import { currentExecutionAttempt, type RunIdentity } from '../execution-attempts.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * The fence for the teardown that follows one run's terminal commit: the durable identity the
 * engine captured for that run while it was live (see {@link RunIdentity}), or `undefined` when
 * it never learned it. Nothing is read here, so a replacement that lands between the commit and
 * the teardown can never be mistaken for the run. A teardown without an identity fails closed:
 * it skips its fenced durable writes and warns, and the persisted terminal-cleanup timer still
 * sweeps the run's scratch state.
 */
export type TerminalFence = { readonly identity: RunIdentity | undefined };

/**
 * The fence for a terminal commit of the run identified by `workflowExecutionToken`, settled
 * before the commit is issued so it is always the pre-commit identity.
 *
 * - This engine holds the run and already knows its identity: returned synchronously, with no
 *   read and no await (the common case, and the whole completion hot path).
 * - It holds the run but the adoption read is still in flight (a resumed run that terminates
 *   at once): the caller awaits that read before it issues the commit.
 * - It holds no attempt for the run (a cancel or timeout of a run another engine drives): the
 *   identity is read now, before the commit, so it cannot observe a replacement, which cannot
 *   exist until the run's terminal commit lands.
 * - It holds the run but never learned its identity: no identity, and the teardown fails closed.
 */
export function captureOrReadTerminalFence(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): TerminalFence | Promise<TerminalFence> {
  const attempt = currentExecutionAttempt(internals, workflowId);
  if (attempt === undefined || attempt.workflowExecutionToken !== workflowExecutionToken) {
    return readRunIdentity(internals, workflowId).then((identity) => ({ identity }));
  }
  if (attempt.identity !== undefined || attempt.pendingIdentity === undefined) {
    return { identity: attempt.identity };
  }
  return attempt.pendingIdentity.then(() => ({ identity: attempt.identity }));
}

/**
 * Attempts a fenced terminal operation makes when a concurrent change beats its conditional write:
 * the release of a run's slot and the terminal state commit share it, matching `AtomicState`'s
 * default retry budget.
 */
export const FENCED_RETRY_BUDGET = 10;

/** Report that a terminal teardown had no run identity to fence on and skipped its fenced writes. */
export function warnUnknownRunIdentity(
  fence: TerminalFence,
  workflowId: string,
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void,
): void {
  if (fence.identity !== undefined) return;
  handleCleanupError(
    'terminal-teardown-fence',
    new Error('The run identity is unknown, so its fenced durable teardown was skipped.'),
    workflowId,
  );
}

/** Read a run's generation, then its holder marker, as they stand now. */
export async function readRunIdentity(
  internals: EngineInternals,
  workflowId: string,
): Promise<RunIdentity> {
  const generation = await internals.storage.get(KEYS.workflowGeneration(workflowId));
  const holderMarker = await internals.storage.get(KEYS.workflowConcurrencyHolder(workflowId));
  return { generation, holderMarker };
}

/** Whether `current` is byte-identical to `expected`; `null` means the key is absent. */
export function bytesEqual(current: Uint8Array | null, expected: Uint8Array | null): boolean {
  if (current === null || expected === null) return current === expected;
  return current.length === expected.length && current.every((byte, i) => byte === expected[i]);
}

/** The condition that holds only while `wf-gen:<id>` is still the committing run's generation. */
export function sameRunCondition(
  workflowId: string,
  identity: RunIdentity,
): ConditionalBatchCondition {
  return { key: KEYS.workflowGeneration(workflowId), expectedValue: identity.generation };
}

/**
 * Apply a teardown batch only while the id still belongs to the committing run.
 *
 * With `conditionalBatch` the check is durable and atomic with the write, so it
 * also holds against a replacement started by another engine or landing
 * mid-batch. Storages without that capability keep best-effort same-engine
 * fencing: `isSuperseded` is evaluated immediately before an unconditional
 * batch, which cannot see another engine's replacement or one landing
 * mid-write. Returns whether the batch was applied.
 */
export async function commitFencedTeardownBatch(
  internals: EngineInternals,
  workflowId: string,
  fence: TerminalFence,
  operations: BatchOperation[],
  isSuperseded: () => boolean,
): Promise<boolean> {
  if (isSuperseded()) return false;
  if (internals.storage.capabilities().conditionalBatch) {
    const identity = fence.identity;
    if (identity === undefined) return false;
    return storageConditionalBatch(
      internals.storage,
      [sameRunCondition(workflowId, identity)],
      operations,
    );
  }
  await internals.storage.batch(operations);
  return true;
}

/** Maximum deletes per guarded teardown chunk, well under the storage batch limit. */
const GUARDED_DELETE_CHUNK_SIZE = 500;

/**
 * Delete `keys` in chunks, each committed through `fencedCommit`. Stops at the first rejected
 * chunk and reports whether every chunk applied. The keys are listed before they are deleted,
 * so a key written after the listing is never in a batch.
 */
export async function deleteKeysInGuardedChunks(
  keys: AsyncIterable<string>,
  fencedCommit: (operations: BatchOperation[]) => Promise<boolean>,
  initial: BatchOperation[] = [],
): Promise<boolean> {
  let chunk = initial;
  for await (const key of keys) {
    chunk.push({ type: 'delete', key });
    if (chunk.length >= GUARDED_DELETE_CHUNK_SIZE) {
      if (!(await fencedCommit(chunk))) return false;
      chunk = [];
    }
  }
  return chunk.length === 0 || fencedCommit(chunk);
}

/** {@link commitFencedTeardownBatch} bound to one terminal commit, for the cleanup helpers' `commitBatch` parameter. */
export function fencedTeardownCommit(
  internals: EngineInternals,
  workflowId: string,
  fence: TerminalFence,
  isSuperseded: () => boolean,
): (operations: BatchOperation[]) => Promise<boolean> {
  return (operations) =>
    commitFencedTeardownBatch(internals, workflowId, fence, operations, isSuperseded);
}

/**
 * Cancel the durable timers `timerIds` of the run `fence` describes, fenced on its generation so a
 * timer a same-id replacement scheduled under the same id is never removed, including by another
 * engine. Without `conditionalBatch` the cancel keeps the same-engine `isSuperseded` guard. A
 * missing identity cancels nothing. The cancels are fire-and-forget, as before.
 */
export function cancelRunTimers(
  internals: EngineInternals,
  workflowId: string,
  fence: TerminalFence,
  isSuperseded: () => boolean,
  timerIds: string[],
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>,
): void {
  const identity = fence.identity;
  if (identity === undefined || isSuperseded()) return;
  const conditions = internals.storage.capabilities().conditionalBatch
    ? [sameRunCondition(workflowId, identity)]
    : undefined;
  for (const timerId of timerIds) {
    void swallowPromiseRejection(internals.scheduler.cancel(timerId, workflowId, conditions));
  }
}
