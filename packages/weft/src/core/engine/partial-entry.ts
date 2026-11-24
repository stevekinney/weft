import type { ParallelOperationCacheEntry } from '../context/parallel-cache-entry.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Whether the current execution mode can persist a partial cache entry for this
 * workflow. Only the inline strategy exposes a context whose `accumulatedResults`
 * the next checkpoint flushes; worker mode has no inline context, so a partial
 * entry can never be written there. This read is side-effect-free, so it is safe
 * to probe on the failure path BEFORE finalizing — letting an unsupported
 * worker-mode `ctx.all` throw without first consuming a durable signal.
 */
export function canPersistPartialEntry(internals: EngineInternals, workflowId: string): boolean {
  return internals.inlineStrategy?.getContext(workflowId) !== undefined;
}

/**
 * Mutate the workflow's `accumulatedResults` map in place at the given
 * step. The next checkpoint write — triggered by the workflow's next
 * yield, or by a commit the coordinator makes while its branches still run —
 * will persist the partial entry. If the workflow throws and fails before
 * either, the partial entry is lost; users with externally visible side
 * effects must still use idempotency keys for activities inside `ctx.all`.
 */
export function writePartialEntry(
  internals: EngineInternals,
  workflowId: string,
  step: number,
  entry: ParallelOperationCacheEntry,
): boolean {
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (context === undefined) return false;
  context.accumulatedResults.set(step, entry);
  return true;
}
