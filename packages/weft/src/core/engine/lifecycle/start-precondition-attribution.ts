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
 * lazily so the extra storage read happens only on that path.
 *
 * That evidence is NOT proof the duplicate id was fine, and deliberately is not
 * treated as such. The concurrency precondition is a monotonic atomic-state VERSION
 * key (`buildWorkflowConcurrencyStartOperations` conditions on `snapshot.version`
 * and writes `version + 1`; releasing the slot increments again rather than
 * restoring), so once a same-id winner acquires and releases, that condition stays
 * mismatched forever and reports a conflict regardless of what else missed. What
 * makes retrying safe here is the caller's own earlier check: it re-reads the
 * duplicate-id key positively and raises `WorkflowAlreadyExistsError` before this
 * runs, so reaching this point means the workflow record currently matches the
 * expectation — the id is free right now, and a retry re-conditions on that same
 * still-matching value.
 *
 * The residual is the pre-compare-and-swap purge ABA (WFT-153): a winner purged
 * between the read and the commit makes an absent record look never-used, which no
 * value-comparing condition can detect. That is tracked separately and is the reason
 * this function does not claim exclusive attribution.
 *
 * With no concurrency evidence at all, fail closed: something missed, nothing
 * retryable explains it, and a spurious `WorkflowAlreadyExistsError` is public,
 * non-destructive, and retryable by the caller.
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
