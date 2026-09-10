/**
 * `engine.resume(id)` / `recoverAll()`'s standalone-replay-from-storage entry
 * point. The actual work — load tracking/checkpoint/registration state,
 * prepare the resume, and relaunch inline or in a worker — lives in
 * `resume-body.ts`'s `performResumeAfterClaimAcquired` (split out to stay
 * under this repository's 500-line implementation-file ceiling once the
 * WFT-134 claim-release wrapping below was added). This file's own job is
 * just: load and validate state, acquire a claim if this run doesn't already
 * hold one, and release a claim it freshly acquired if the resume turns out
 * not to succeed after all.
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
} from './standalone-claim-acquire.ts';

export async function resumeWorkflowFromStorage(
  internals: EngineInternals,
  workflowId: string,
  dispatchResumedEvent: boolean,
  callbacks: LifecycleCallbacks,
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'],
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

  const freshlyAcquiredClaim = await acquireStandaloneClaimBeforeResume(internals, workflowId);

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
    // re-check.
    if (freshlyAcquiredClaim) {
      await releaseFreshlyAcquiredResumeClaim(internals, workflowId);
    }
    throw error;
  }
}
