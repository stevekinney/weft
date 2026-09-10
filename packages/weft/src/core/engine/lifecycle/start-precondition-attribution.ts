import { WorkflowAlreadyExistsError } from '../errors.ts';
import { StartIdempotencyRaceLostError } from './start-commit-errors.ts';

/**
 * Decide what a lost start compare-and-swap MEANS, once every positively-detectable
 * cause has already been ruled out by the caller — an idempotency precondition, a
 * catalog-entry removal, and a lost workflow claim are each re-checked and raise
 * their own error before this runs.
 *
 * Throws when the loss is terminal; returns normally when the caller should retry
 * workflow-concurrency admission.
 *
 * WFT-152: a caller-supplied id that lost its duplicate-id condition means another
 * engine sharing this store committed a create for the same id after this start's
 * duplicate-id read. It raises the SAME {@link WorkflowAlreadyExistsError} the
 * in-engine `pendingStarts` guard raises for the identical collision, so a
 * cross-engine duplicate id is indistinguishable from an in-engine one at the call
 * site.
 *
 * Attribution is by ELIMINATION, never by re-reading the duplicate-id key. A
 * re-read is unsound: the winning run can complete and be purged (or swept by
 * retention) between the failed compare-and-swap and the check, restoring the
 * workflow record to the very value the condition expected, so the conflict reads
 * back as "no conflict". With no workflow-concurrency conditions in the batch,
 * nothing else is left for the lost outcome to mean.
 *
 * When concurrency conditions ARE present, retry only on positive evidence that the
 * retryable one is what missed — hence `hasWorkflowConcurrencyConflict`, invoked
 * lazily so the extra storage read happens only on that path. Inferring the
 * opposite way (retrying unless the duplicate-id key still shows a conflict) is what
 * makes the purge race dangerous rather than merely wasteful: a winner that
 * completed, released its concurrency slot AND was purged leaves BOTH keys matching
 * again, so the retry's batch commits and the losing start executes a SECOND run
 * under an id the caller asked to be unique. Failing closed costs at worst a
 * spurious `WorkflowAlreadyExistsError` on a transient admission miss, which is
 * public, non-destructive, and retryable by the caller.
 */
export async function attributeLostStartPreconditionOrRetry(
  workflowId: string,
  hasDuplicateIdCondition: boolean,
  hasWorkflowConcurrency: boolean,
  hasWorkflowConcurrencyConflict: () => Promise<boolean>,
): Promise<void> {
  if (!hasDuplicateIdCondition) {
    // Pre-WFT-152 behavior for a generated id: with no concurrency admission to
    // retry, the internal sentinel tells `startOrSignal` to resolve to the winner.
    if (!hasWorkflowConcurrency) {
      throw new StartIdempotencyRaceLostError();
    }
    return;
  }
  if (!hasWorkflowConcurrency) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  if (!(await hasWorkflowConcurrencyConflict())) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
}
