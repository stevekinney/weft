import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import type { WorkflowState } from '../types.ts';
import { EngineDisposedError } from './errors.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { isScannedRun } from './purge-supersession.ts';

/**
 * Entries removed per batch. Each costs two deletes (the entry, and the response it names), so a
 * chunk is 2,000 operations, a fifth of `MAX_BATCH_OPERATIONS`.
 */
export const UPDATE_HISTORY_PURGE_CHUNK = 1_000;

/**
 * Remove a run's update history (`uph:`), and the answered responses (`upr:`) it names, in batches of
 * {@link UPDATE_HISTORY_PURGE_CHUNK} entries, before the purge's one atomic batch is built.
 *
 * The history has no bound: a long-lived entity workflow can receive thousands of updates. Folded into
 * the purge batch, each entry would add two operations to a batch that holds at most 10,000, so a
 * large enough history would make the run impossible to purge, and the history is removed by purge
 * alone (terminal cleanup keeps it by design).
 *
 * It is safe to stop partway and to run again. Each chunk is one atomic batch that removes an entry
 * together with the response it names, so what remains always names the responses still to remove.
 * A purge that fails partway leaves the run in place with a shorter history, and the next purge
 * finishes the job; a response left behind could only be one the five-minute sweep removes anyway.
 *
 * Each chunk is fenced on the run record the purge observed, where the storage can fence: a
 * same-id `start-new` replacement changes those bytes, and a chunk that lost to it removes nothing, so
 * the replacement's own history (it shares the key prefix) is never touched. A lost fence ends the
 * drain quietly; the purge's own commit, fenced the same way, reports the loss.
 */
export async function drainUpdateHistory(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<void> {
  const workflowKey = KEYS.workflow(state.id);
  const observedWorkflowBytes = await internals.storage.get(workflowKey);
  if (!isScannedRun(observedWorkflowBytes, state)) return;
  const conditions: ConditionalBatchCondition[] = internals.storage.capabilities().conditionalBatch
    ? [{ key: workflowKey, expectedValue: observedWorkflowBytes }]
    : [];

  const prefix = KEYS.updateHistoryPrefix(state.id);
  // Each chunk scans past the last key the one before it deleted, so a store whose scans lag its
  // deletes (`readAfterWrite: 'eventual'`) never hands back a key already removed, and every chunk
  // advances: the drain ends after one pass over the history, whatever the store's consistency.
  let after: string | undefined;
  let draining = true;
  while (draining) {
    if (internals.disposed) throw new EngineDisposedError();
    const chunk = await nextChunk(internals, prefix, after);
    // An empty chunk is the end; a chunk the fence refused ends it too.
    draining =
      chunk.last !== undefined &&
      (await commitFencedEngineWriteAllowingPreconditionFailure(
        internals,
        null,
        chunk.operations,
        conditions,
      ));
    after = chunk.last;
  }
}

/**
 * The deletes for the next {@link UPDATE_HISTORY_PURGE_CHUNK} entries after `after`, and the responses
 * they name, with the last entry key scanned (`undefined` when none remain).
 */
async function nextChunk(
  internals: EngineInternals,
  prefix: string,
  after: string | undefined,
): Promise<{ operations: BatchOperation[]; last: string | undefined }> {
  const operations: BatchOperation[] = [];
  let last: string | undefined;
  const range = after === undefined ? {} : { gt: after };
  for await (const [key] of internals.storage.scan(prefix, {
    ...range,
    limit: UPDATE_HISTORY_PURGE_CHUNK,
  })) {
    operations.push({ type: 'delete', key });
    last = key;
    // `<receivedAt>:<updateId>`: an update id is a UUID, so it holds no colon.
    const updateId = key.slice(key.lastIndexOf(':') + 1);
    if (updateId.length > 0)
      operations.push({ type: 'delete', key: KEYS.updateResponse(updateId) });
  }
  return { operations, last };
}
