/**
 * `engine.resume(id)` / `recoverAll()`'s standalone-replay-from-storage entry
 * point. The actual work — load tracking/checkpoint/registration state,
 * prepare the resume, and relaunch inline or in a worker — lives in
 * `resume-body.ts`'s `performResumeAfterClaimAcquired` (split out to stay
 * under this repository's 500-line implementation-file ceiling once the
 * WFT-134 claim-release wrapping below was added). This file's own job is
 * just: load and validate state, acquire a claim if this run doesn't already
 * hold one, and release a claim it freshly acquired if the resume turns out
 * not to succeed after all — UNLESS `options.deferClaimReleaseOnRejection`
 * asks this call to leave that claim installed for its caller instead (see
 * {@link ResumeFromStorageOptions}).
 *
 * @module core/engine/lifecycle/resume
 */

import { KEYS } from '../../../storage/interface.ts';
import type { WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { decodeWorkflowState } from '../validation.ts';
import { performResumeAfterClaimAcquired } from './resume-body.ts';
import type { LifecycleCallbacks, RecoverAllOptions } from './shared.ts';
import {
  acquireStandaloneClaimBeforeResume,
  releaseFreshlyAcquiredResumeClaim,
  type StandaloneClaimAcquireResult,
} from './standalone-claim-acquire.ts';

/**
 * An out-parameter this call populates with the epoch of a claim it freshly
 * acquired, so a caller using `deferClaimReleaseOnRejection` can release that
 * EXACT generation itself once it is done using it (WFT-134 review round 2,
 * issue D). Left at `{ epoch: null }` when no fresh acquisition happened —
 * folding disabled, no registry, the cached claim matched, or acquisition
 * itself threw `WorkflowClaimUnavailableError` before returning.
 */
export type FreshResumeClaimTracker = { epoch: number | null };

/** Options for {@link resumeWorkflowFromStorage}. */
export type ResumeFromStorageOptions = {
  /**
   * `true` for `recoverAll()`'s per-entry recovery loop (WFT-134 issue D):
   * its own `recoverEntryOrIsolateFailure` isolates several errors into a
   * fenced `failWorkflowForXxx()` commit that needs a freshly-acquired claim
   * to still be installed, so this call must NOT release on rejection —
   * instead it records the acquired epoch in `freshClaimTracker` and lets the
   * caller release once its own isolated-failure handling is done. Default
   * (`false`/omitted) is correct for an explicit `engine.resume()` caller,
   * which has nothing further to do with the claim and must release
   * immediately on any rejection.
   */
  deferClaimReleaseOnRejection?: boolean;
  /** Populated with the freshly-acquired epoch, if any — see {@link FreshResumeClaimTracker}. */
  freshClaimTracker?: FreshResumeClaimTracker;
};

/** Populate `tracker.epoch` from a fresh acquisition — split out to keep `resumeWorkflowFromStorage`'s complexity under this repository's ceiling. */
function recordFreshClaimEpoch(
  acquireResult: StandaloneClaimAcquireResult,
  tracker: FreshResumeClaimTracker | undefined,
): void {
  if (acquireResult.freshlyAcquired && tracker !== undefined) {
    tracker.epoch = acquireResult.epoch;
  }
}

/**
 * Release a freshly-acquired claim on rejection, unless the caller deferred
 * that release — see `ResumeFromStorageOptions.deferClaimReleaseOnRejection`
 * (WFT-134). Split out for the same complexity-ceiling reason as {@link recordFreshClaimEpoch}.
 */
async function releaseFreshClaimOnRejectionUnlessDeferred(
  internals: EngineInternals,
  workflowId: string,
  acquireResult: StandaloneClaimAcquireResult,
  deferRelease: boolean | undefined,
): Promise<void> {
  if (acquireResult.freshlyAcquired && deferRelease !== true) {
    await releaseFreshlyAcquiredResumeClaim(internals, workflowId, acquireResult.epoch);
  }
}

export async function resumeWorkflowFromStorage(
  internals: EngineInternals,
  workflowId: string,
  dispatchResumedEvent: boolean,
  callbacks: LifecycleCallbacks,
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'],
  options?: ResumeFromStorageOptions,
): Promise<WorkflowHandle> {
  // Load workflow state
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!stateBytes) {
    throw new Error(`Workflow "${workflowId}" not found in storage`);
  }

  const state = decodeWorkflowState(stateBytes);
  if (state.status !== 'running' && state.status !== 'suspended') {
    throw new Error(
      `Cannot resume workflow "${workflowId}": status is "${state.status}", expected "running" or "suspended"`,
    );
  }

  const acquireResult = await acquireStandaloneClaimBeforeResume(internals, workflowId);
  recordFreshClaimEpoch(acquireResult, options?.freshClaimTracker);

  try {
    return await performResumeAfterClaimAcquired(
      internals,
      workflowId,
      state,
      dispatchResumedEvent,
      callbacks,
      onRecoveredWorkflow,
    );
  } catch (error) {
    // WFT-134: release a freshly-acquired claim (see its doc) on any
    // rejection above, notably `performSerializedResume`'s status/generation
    // re-check — unless the caller asked to defer that release (see
    // `ResumeFromStorageOptions`).
    await releaseFreshClaimOnRejectionUnlessDeferred(
      internals,
      workflowId,
      acquireResult,
      options?.deferClaimReleaseOnRejection,
    );
    throw error;
  }
}
