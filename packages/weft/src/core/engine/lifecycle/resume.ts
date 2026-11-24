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

import { KEYS } from '../../../storage/keys.ts';
import type { WorkflowState } from '../../types.ts';
import { captureAbandonment, isLaunchedUnderClaim } from '../execution-attempts.ts';
import type { WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { defersToQueuedInlineWorkflowStart } from '../local-execution.ts';
import type { ResumeAwaitingAdoption } from '../resume-awaiting-adoption.ts';
import { decodeWorkflowState } from '../validation.ts';
import { performResumeAfterClaimAcquired } from './resume-body.ts';
import type { LifecycleCallbacks, RecoverAllOptions } from './shared.ts';
import {
  acquireStandaloneClaimBeforeResume,
  releaseFreshlyAcquiredResumeClaim,
  type StandaloneClaimAcquireResult,
} from './standalone-claim-acquire.ts';
import { WorkflowNotResumableError } from './workflow-not-resumable-error.ts';

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
  /**
   * `true` only for the wake of an inline-parked run (`resumeParkedInlineWorkflow`): skips the
   * eager-type recovery revision check, which belongs to the recovery entry points.
   */
  skipEagerRevisionCheck?: boolean;
  /**
   * Set only by a claim reclaim's forced replay, to the epoch of the claim it took. When this
   * engine already drives the generation under that claim, the replay returns the running handle
   * instead of driving the generation a second time. A queued or launching inline start of the
   * run under that claim is deferred to before this function is reached (`resumeStoredWorkflow`),
   * so the check never meets one. It shares its synchronous turn with the in-flight registration
   * below, so no launch can land between them.
   */
  skipIfLaunchedUnderClaimEpoch?: number;
};

/**
 * `resume()`'s replay from storage: `resumeWorkflowFromStorage` with the caller's options, less
 * `forceReplayFromStorage`, which only decides whether `resume()` reaches it at all.
 *
 * A claim reclaim's replay (the one caller that sets `skipIfLaunchedUnderClaimEpoch`) defers to a
 * queued or launching inline start of the run under the claim it holds, which a start committed or
 * a delayed start fired between the reclaim's listing and here can leave: the flush drives the run
 * under that claim, so the replay returns the handle instead of registering and replaying beside
 * it (`defersToQueuedInlineWorkflowStart`). No turn is added to any other resume: the turn count
 * of this path is load-bearing (see `resumeWorkflowFromStorage`).
 */
export function resumeStoredWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: LifecycleCallbacks,
  onRecoveredWorkflow: RecoverAllOptions['onRecoveredWorkflow'] | undefined,
  options: (ResumeFromStorageOptions & { readonly forceReplayFromStorage?: boolean }) | undefined,
): Promise<WorkflowHandle> {
  const { forceReplayFromStorage: _decidesWhetherToReplay, ...forwarded } = options ?? {};
  if (
    forwarded.skipIfLaunchedUnderClaimEpoch !== undefined &&
    defersToQueuedInlineWorkflowStart(internals, workflowId)
  ) {
    return Promise.resolve(callbacks.getHandle(workflowId));
  }
  return resumeWorkflowFromStorage(
    internals,
    workflowId,
    true,
    callbacks,
    onRecoveredWorkflow,
    forwarded,
  );
}

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

/**
 * Resume `workflowId` from durable storage, joining a resume of it that is already in flight in
 * this engine and has not yet adopted the checkpoint.
 *
 * Until that adoption the engine holds no local checkpoint and no inline execution for the run, so
 * `recoverAll()`'s preflight and `resume()`'s local-ownership check both treat it as idle. A
 * resume parked in `resolveWorkflowServices` (a reclaim held while a Bureau finishes composing,
 * say) would otherwise be followed by a second resume of the same run that drives it in parallel;
 * the later checkpoint commit then loses its compare-and-swap and abandons the run. Only a resume
 * of the same execution generation joins: a replacement run under the same id is resumed on its
 * own. The joiner receives the in-flight resume's handle or rejection, and keeps its claim contract
 * (see {@link joinResumeAwaitingAdoption}). Its own `onRecoveredWorkflow` hook does not fire for that
 * run, because the run was recovered once, by the resume it joined. The in-flight resume's own
 * promise settles in the same number of turns as it did before joining existed: settlement order
 * on this path is load-bearing (one extra turn flips the WFT-79 F2 race in
 * `handle-result.test.ts`).
 */
export async function resumeWorkflowFromStorage(
  internals: EngineInternals,
  workflowId: string,
  dispatchResumedEvent: boolean,
  callbacks: LifecycleCallbacks,
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'],
  options?: ResumeFromStorageOptions,
): Promise<WorkflowHandle> {
  const state = resumableState(workflowId, await internals.storage.get(KEYS.workflow(workflowId)));
  const claimEpoch = options?.skipIfLaunchedUnderClaimEpoch;
  if (
    claimEpoch !== undefined &&
    isLaunchedUnderClaim(internals, workflowId, claimEpoch, state.workflowExecutionToken)
  ) {
    return callbacks.getHandle(workflowId);
  }
  const decision = joinOrRegisterResume(
    internals,
    workflowId,
    state,
    dispatchResumedEvent,
    options,
  );
  if (decision.join !== undefined) return decision.join;
  const { adoption } = decision;

  let acquireResult: Awaited<ReturnType<typeof acquireStandaloneClaimBeforeResume>>;
  try {
    acquireResult = await acquireStandaloneClaimBeforeResume(internals, workflowId);
  } catch (error) {
    settleAndForget(internals, workflowId, adoption, error);
    throw error;
  }
  recordFreshClaimEpoch(acquireResult, options?.freshClaimTracker);
  shareFreshClaimEpoch(adoption, acquireResult);
  // Relaunching ends the abandoned attempt as soon as the checkpoint is adopted and begins a
  // new one, before the remaining resume steps run; restore the abandonment if any of them fail.
  const token = state.workflowExecutionToken;
  const restoreAbandonment = captureAbandonment(internals, workflowId, token);

  try {
    const handle = await performResumeAfterClaimAcquired(
      internals,
      workflowId,
      state,
      dispatchResumedEvent,
      callbacks,
      onRecoveredWorkflow,
      options?.skipEagerRevisionCheck,
    );
    settleAndForget(internals, workflowId, adoption, undefined, handle);
    return handle;
  } catch (error) {
    // Joiners learn of the rejection before the fresh claim is released, so one that deferred that
    // release can still fail the run under the claim.
    settleAndForget(internals, workflowId, adoption, error);
    restoreAbandonment();
    // WFT-134: release a freshly-acquired claim (see its doc) on any
    // rejection above, notably `performSerializedResume`'s status/generation
    // re-check — unless the caller asked to defer that release (see
    // `ResumeFromStorageOptions`).
    await releaseFreshClaimOnRejectionUnlessDeferred(
      internals,
      workflowId,
      acquireResult,
      deferClaimRelease(options, adoption),
    );
    throw error;
  }
}

/** The stored state of a workflow a resume may continue, or the error that says why not. */
function resumableState(workflowId: string, stateBytes: Uint8Array | null): WorkflowState {
  if (!stateBytes) {
    throw new Error(`Workflow "${workflowId}" not found in storage`);
  }
  const state = decodeWorkflowState(stateBytes);
  if (state.status !== 'running' && state.status !== 'suspended') {
    throw new WorkflowNotResumableError(workflowId, state.status);
  }
  return state;
}

/**
 * Join a resume of the same generation already in flight, or list this one as the resume later
 * resumes of its generation join. Each generation has its own entry, so a resume of a replacement
 * run never joins an older generation's resume, and later resumes of the replacement join it.
 */
function joinOrRegisterResume(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  dispatchResumedEvent: boolean,
  options: ResumeFromStorageOptions | undefined,
):
  | { join: Promise<WorkflowHandle>; adoption?: never }
  | { join?: never; adoption: RegisteredResume } {
  const requires = {
    eagerRevisionCheck: options?.skipEagerRevisionCheck !== true,
    resumedEvent: dispatchResumedEvent,
  };
  // A joiner never inherits a weaker resume. One that requires something every in-flight resume of
  // its generation skips resumes on its own, and is listed so stricter resumes after it join it.
  const compatible = internals.resumesAwaitingAdoption
    .get(workflowId)
    ?.get(state.workflowExecutionToken)
    ?.find((inFlight) => performsEverything(inFlight.performs, requires));
  if (compatible !== undefined) return { join: joinResumeAwaitingAdoption(compatible, options) };
  return { adoption: registerResumeAwaitingAdoption(internals, workflowId, state, requires) };
}

function performsEverything(
  performs: ResumeAwaitingAdoption['performs'],
  requires: ResumeAwaitingAdoption['performs'],
): boolean {
  return (
    (performs.eagerRevisionCheck || !requires.eagerRevisionCheck) &&
    (performs.resumedEvent || !requires.resumedEvent)
  );
}

/**
 * How each resume option behaves when its resume joins one already in flight. Typed over every
 * option, so a new option cannot be added without deciding whether a joiner carries it over or
 * requires the in-flight resume to honour it (see {@link joinOrRegisterResume}).
 */
export const RESUME_OPTION_JOIN_POLICY = {
  deferClaimReleaseOnRejection: 'carried over: the joined resume then defers its release too',
  freshClaimTracker: "carried over: filled with the joined resume's freshly acquired epoch",
  skipEagerRevisionCheck: 'required: a joiner that checks joins only a resume that checks',
  skipIfLaunchedUnderClaimEpoch:
    'decided before joining: a replay returns when the generation is driven, or queued to be driven, under its claim, and may join otherwise',
} as const satisfies Record<keyof ResumeFromStorageOptions, string>;

/** Hand the epoch of a claim this resume freshly acquired to the joiners' trackers. */
function shareFreshClaimEpoch(
  adoption: RegisteredResume | undefined,
  acquireResult: StandaloneClaimAcquireResult,
): void {
  if (adoption === undefined || !acquireResult.freshlyAcquired) return;
  adoption.entry.claimEpoch = acquireResult.epoch;
  for (const tracker of adoption.entry.freshClaimTrackers) tracker.epoch = acquireResult.epoch;
}

/** Whether this resume or any joiner releases a fresh claim itself after a rejection. */
function deferClaimRelease(
  options: ResumeFromStorageOptions | undefined,
  adoption: RegisteredResume | undefined,
): boolean {
  return (
    options?.deferClaimReleaseOnRejection === true ||
    adoption?.entry.deferClaimReleaseOnRejection === true
  );
}

/** Settle the joiners of `adoption` and drop its entry, unless a later resume already replaced it. */
function settleAndForget(
  internals: EngineInternals,
  workflowId: string,
  adoption: RegisteredResume | undefined,
  error: unknown,
  handle?: WorkflowHandle,
): void {
  if (adoption === undefined) return;
  if (handle === undefined) adoption.settle.reject(error);
  else adoption.settle.resolve(handle);
  const generations = internals.resumesAwaitingAdoption.get(workflowId);
  const token = adoption.entry.workflowExecutionToken;
  const entries = generations?.get(token);
  if (generations === undefined || entries === undefined || !entries.includes(adoption.entry)) {
    return;
  }
  const remaining = entries.filter((entry) => entry !== adoption.entry);
  if (remaining.length > 0) generations.set(token, remaining);
  else generations.delete(token);
  if (generations.size === 0) internals.resumesAwaitingAdoption.delete(workflowId);
}

type RegisteredResume = {
  readonly entry: ResumeAwaitingAdoption;
  readonly settle: PromiseWithResolvers<WorkflowHandle>;
};

/** List this resume as the one later resumes of the same generation join until it adopts. */
function registerResumeAwaitingAdoption(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  performs: ResumeAwaitingAdoption['performs'],
): RegisteredResume {
  const settle = Promise.withResolvers<WorkflowHandle>();
  // A resume nobody joined must not surface its rejection a second time, unhandled.
  settle.promise.catch(() => {});
  const entry: ResumeAwaitingAdoption = {
    workflowExecutionToken: state.workflowExecutionToken,
    handle: settle.promise,
    performs,
    claimEpoch: null,
    freshClaimTrackers: [],
    deferClaimReleaseOnRejection: false,
  };
  let generations = internals.resumesAwaitingAdoption.get(workflowId);
  if (generations === undefined) {
    generations = new Map();
    internals.resumesAwaitingAdoption.set(workflowId, generations);
  }
  generations.set(state.workflowExecutionToken, [
    ...(generations.get(state.workflowExecutionToken) ?? []),
    entry,
  ]);
  return { entry, settle };
}

/**
 * Join a resume of the same generation already in flight. The joiner's claim contract carries
 * over: its tracker learns the epoch of a claim the joined resume freshly acquired, and a joiner
 * that releases a fresh claim itself after a rejection stops the joined resume from releasing it
 * first, so a recovery sweep can still fail the run under the claim and move on.
 */
function joinResumeAwaitingAdoption(
  entry: ResumeAwaitingAdoption,
  options: ResumeFromStorageOptions | undefined,
): Promise<WorkflowHandle> {
  if (options?.deferClaimReleaseOnRejection === true) entry.deferClaimReleaseOnRejection = true;
  const tracker = options?.freshClaimTracker;
  if (tracker !== undefined) {
    if (entry.claimEpoch === null) entry.freshClaimTrackers.push(tracker);
    else tracker.epoch = entry.claimEpoch;
  }
  return entry.handle;
}
