/**
 * `recoverAll()`'s per-entry error isolation — split out of `transition.ts`,
 * which has no headroom under this repository's 500-line implementation-file
 * ceiling for the WFT-134 claim-release wrapping `recoverEntryOrIsolateFailure`
 * needed (mirrors `resume-body.ts`'s same split). This file's own job is just
 * the branch-matching: given the error `resume()` rejected with, either
 * isolate it to just this workflow (returning `null`) or rethrow it.
 *
 * @module core/engine/lifecycle/recovery-isolation
 */

import { RegExpExtensionDecodeError } from '../../codec/extension-codec.ts';
import { VersionMismatchError } from '../../versioning.ts';
import { DynamicWorkflowSourceUnavailableError } from '../dynamic-source-errors.ts';
import type { WorkflowHandle } from '../handles.ts';
import { WorkflowClaimUnavailableError } from '../lease-errors.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import type { LifecycleCallbacks, RecoverAllOptions } from './shared.ts';

/**
 * Isolate one `recoverAll()` entry's failure to just this workflow when it
 * matches a known-recoverable error, committing the matching `failWorkflowForXxx`
 * fenced write; rethrows anything else, including an opted-in
 * `VersionMismatchError` throw. See `transition.ts`'s `recoverEntryOrIsolateFailure`
 * for the caller-side claim-release wrapping around this.
 */
export async function isolateRecoveryFailure(
  workflowId: string,
  callbacks: LifecycleCallbacks,
  options: RecoverAllOptions | undefined,
  error: unknown,
): Promise<WorkflowHandle | null> {
  if (error instanceof RegExpExtensionDecodeError) {
    await callbacks.failWorkflowForCheckpointDecodeError(workflowId, error);
    return null;
  }
  if (error instanceof VersionMismatchError && options?.versionMismatchPolicy !== 'throw') {
    await callbacks.failWorkflowForVersionMismatch(workflowId, error);
    return null;
  }
  if (error instanceof WorkflowClaimUnavailableError) {
    return null;
  }
  if (error instanceof WorkflowRevisionUnavailableError) {
    // `recoverAll()`'s preload barrier classified this entry's
    // `(type, revision)` group `unavailable` before the loop started;
    // `resume()` reached this cached error via the batch-local,
    // closure-scoped `resolveExecutableRegistrationForRevision()` wrapper
    // AFTER acquiring this workflow's claim and loading its
    // terminal-cleanup tracking, so this commits cleanly under
    // `ownership: 'workflow-lease'` instead of racing an unfenced write.
    await callbacks.failWorkflowForRevisionUnavailable(workflowId, error);
    return null;
  }
  if (error instanceof DynamicWorkflowSourceUnavailableError) {
    // A legacy (revision-undefined) run on a dynamic source with a single
    // registered candidate falls through to the ordinary active-pointer
    // resolve inside `resolveExecutableRegistrationForRevision()`, which
    // can still fail with THIS error (a load failure, or an
    // ambiguous-revision race against a concurrent removal) rather than
    // `WorkflowRevisionUnavailableError` — isolate the same way.
    await callbacks.failWorkflowForUnavailableDynamicSource(workflowId, error);
    return null;
  }
  throw error;
}
