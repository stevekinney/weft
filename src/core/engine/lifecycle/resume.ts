import { KEYS } from '../../../storage/interface.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../../checkpoint.ts';
import { encode } from '../../codec.ts';
import { Context, setContextWorkflowInterceptor } from '../../context.ts';
import { EventLog, type EventHeadRecord } from '../../event-log.ts';
import { WorkflowResumedEvent } from '../../events.ts';
import { buildTimerBatchOperations } from '../../scheduler.ts';
import type { Checkpoint, WorkflowState } from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { createCancelHandlerRegistration, resetCancelHandlers } from '../cancel-handlers.ts';
import { rememberCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { rehydrateChildCancellationHandlers } from '../child-workflow-cancellation.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import { getWorkflowExecutionStartedAt, type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { getComposedWorkflowInterceptor } from '../strategy-helpers.ts';
import { decodeWorkflowState } from '../validation.ts';
import { buildWorkflowVisibilityIndexTransition } from '../workflow-indexes.ts';
import { prepareResumeState } from './persist.ts';
import { reprovideRecoveredServices } from './recovered-services.ts';
import {
  enforceHistoryPolicyBeforeReplay,
  loadTerminalCleanupTrackedState,
  loadWorkflowStartHeaders,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RegistrationEntry,
} from './shared.ts';

type SerializedResumeArgs = {
  workflowId: string;
  resumeCheckpoint: Checkpoint;
  serializedCheckpoint: Uint8Array;
  registeredVersionTuple: WorkflowVersionTuple;
  restoredHead: EventHeadRecord;
  workflowStartHeaders: Map<string, string> | undefined;
  registration: RegistrationEntry;
  callbacks: LifecycleCallbacks;
};

/**
 * Re-provide a recovered inline workflow's non-serialized `services` before the
 * generator is driven forward. Returns `true` when the resume must STOP (the run
 * was failed for unavailable services, or the terminal commit faulted), `false`
 * to continue. See {@link reprovideRecoveredServices} for the full contract.
 */
async function prepareRecoveredServicesOrFail(
  internals: EngineInternals,
  state: WorkflowState,
  callbacks: LifecycleCallbacks,
): Promise<boolean> {
  return reprovideRecoveredServices(
    internals,
    state,
    callbacks.failWorkflowForUnavailableServices,
    callbacks.handleCleanupError,
    callbacks.dispatchEvent,
  );
}

function assertResumeNotTerminating(internals: EngineInternals, workflowId: string): void {
  if (internals.terminalizingWorkflows.has(workflowId)) {
    throw new Error(`Cannot resume workflow "${workflowId}": termination is in progress`);
  }
}

function commitSerializedResumeState(
  internals: EngineInternals,
  args: Pick<
    SerializedResumeArgs,
    | 'workflowId'
    | 'resumeCheckpoint'
    | 'serializedCheckpoint'
    | 'registeredVersionTuple'
    | 'restoredHead'
    | 'workflowStartHeaders'
    | 'callbacks'
  >,
): void {
  const {
    workflowId,
    resumeCheckpoint,
    serializedCheckpoint,
    registeredVersionTuple,
    restoredHead,
    callbacks,
  } = args;
  internals.checkpoints.set(workflowId, resumeCheckpoint);
  rememberCommittedCheckpointBytes(internals, workflowId, serializedCheckpoint);
  internals.workflowVersionTuples.set(workflowId, registeredVersionTuple);
  internals.eventLogHeads.set(workflowId, restoredHead);
  setWorkflowStartHeaders(internals, workflowId, args.workflowStartHeaders, callbacks);
  internals.parkedInlineWorkflows.delete(workflowId);
}

async function relaunchInlineWorkflowAfterResume(
  internals: EngineInternals,
  latestState: WorkflowState,
  args: Pick<
    SerializedResumeArgs,
    'workflowId' | 'resumeCheckpoint' | 'registration' | 'callbacks'
  >,
): Promise<void> {
  const { workflowId, resumeCheckpoint, registration, callbacks } = args;
  // Keep the final running-state check and the re-entry into user code
  // in the same serialized section so cancel/timeout cannot commit a
  // terminal state and still let a parked workflow continue.
  //
  const accumulatedResults = new Map<number, unknown>(resumeCheckpoint.accumulatedResults);
  const workflowAbort = new AbortController();

  resetCancelHandlers(internals, workflowId);
  await rehydrateChildCancellationHandlers(internals, workflowId, callbacks);
  const context = new Context({
    workflowId,
    workflowType: latestState.type,
    startedAt: getWorkflowExecutionStartedAt(latestState),
    abortController: workflowAbort,
    getNow: internals.options.getNow,
    resolveWorkflowType: callbacks.resolveWorkflowTypeTarget,
    executionStateOwnerId: latestState.executionStateOwnerId ?? workflowId,
    accumulatedResults,
    locals: resumeCheckpoint.locals,
    searchAttributes: resumeCheckpoint.searchAttributes,
    registerCancelHandler: createCancelHandlerRegistration(internals, workflowId),
    ...(registration.searchAttributes && {
      searchAttributeSchema: registration.searchAttributes,
    }),
    sleepReferenceTime: resumeCheckpoint.createdAt,
    ...(latestState.executionDeadline !== undefined && {
      deadline: latestState.executionDeadline,
    }),
    // Non-serialized services re-provided by resolveServicesForRecovery (or set
    // at start when resuming in the same process); undefined when none.
    services: internals.workflowServices.get(workflowId),
    // Carry the host `ctx.log` sink onto the recovered context, mirroring the
    // fresh-start path (resolveLogSinkOption). Without it, a log at the live frontier
    // of a recovered run — and any speculative child it parents — reaches the console
    // but never `EngineOptions.onLog`. Construction normalizes a missing `onLog` to
    // `null`; use loose `!= null` so the narrowed type drops both `null` and the option's
    // declared `undefined`, keeping `logSink` assignable under `exactOptionalPropertyTypes`
    // (the build's stricter tsc enforces this) (#549).
    ...(internals.options.onLog != null && { logSink: internals.options.onLog }),
  });
  setContextWorkflowInterceptor(context, getComposedWorkflowInterceptor(internals));

  if (internals.options.development) {
    context.explain(true);
  }

  const generator = registration.handler(context, latestState.input);
  const inlineStrategy = internals.inlineStrategy!;
  inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);
  inlineStrategy.continueWorkflow(workflowId, undefined);
}

async function relaunchWorkerWorkflowAfterResume(
  internals: EngineInternals,
  latestState: WorkflowState,
  args: Pick<
    SerializedResumeArgs,
    'workflowId' | 'resumeCheckpoint' | 'workflowStartHeaders' | 'callbacks'
  >,
): Promise<void> {
  const { workflowId, resumeCheckpoint, workflowStartHeaders, callbacks } = args;
  resetCancelHandlers(internals, workflowId);
  await rehydrateChildCancellationHandlers(internals, workflowId, callbacks);
  const serialized = serializeCheckpoint(resumeCheckpoint);
  internals.strategy.startWorkflow({
    workflowId,
    workflowType: latestState.type,
    input: latestState.input,
    checkpoint: serialized,
    nestingDepth: internals.workflowNestingDepths.get(workflowId) ?? 0,
    executionStateOwnerId: latestState.executionStateOwnerId ?? workflowId,
    ...(latestState.executionDeadline !== undefined && {
      deadline: latestState.executionDeadline,
    }),
    ...(workflowStartHeaders !== undefined &&
      workflowStartHeaders.size > 0 && {
        headers: [...workflowStartHeaders],
      }),
  });
}

async function performSerializedResume(
  internals: EngineInternals,
  args: SerializedResumeArgs,
): Promise<void> {
  const { workflowId } = args;
  assertResumeNotTerminating(internals, workflowId);

  const latestState = await loadWorkflowState(internals, workflowId);
  assertResumeNotTerminating(internals, workflowId);

  if (!latestState) {
    throw new Error(`Workflow "${workflowId}" not found in storage`);
  }

  if (latestState.status !== 'running' && latestState.status !== 'suspended') {
    throw new Error(
      `Cannot resume workflow "${workflowId}": status is "${latestState.status}", expected "running" or "suspended"`,
    );
  }

  // A suspended workflow must be flipped back to 'running' durably as part of
  // this serialized section, before the generator is relaunched. If we
  // relaunched but left the persisted status 'suspended', a crash right after
  // relaunch would orphan the run: recoverAll() deliberately skips 'suspended',
  // so nothing would ever re-drive it. Recovered-running workflows already have
  // status 'running', so the flip is gated to the suspended case to avoid an
  // extra state write (and visibility-index churn) on every recoverAll() resume.
  await reactivateSuspendedWorkflowState(internals, latestState);

  commitSerializedResumeState(internals, args);

  if (internals.inlineStrategy) {
    await relaunchInlineWorkflowAfterResume(internals, latestState, args);
    return;
  }
  await relaunchWorkerWorkflowAfterResume(internals, latestState, args);
}

/**
 * Durably flip a suspended workflow back to 'running' before relaunch. No-op for
 * a workflow already running (the recoverAll path), so the common recovery case
 * does no extra storage write. Mutates `state.status` in place so the in-memory
 * `latestState` the relaunch helpers read also reflects 'running'.
 *
 * Re-arms the execution-deadline timer in the same batch when one is persisted.
 * The deadline is absolute wall-clock and suspend cancelled its durable timer,
 * so it must be re-inserted here at the same absolute `fireAt`. A `fireAt` that
 * is already in the past is selected by the scheduler's next expired-timer scan,
 * so a workflow resumed past its deadline times out immediately — exactly the
 * "suspension does not extend the deadline" contract.
 */
async function reactivateSuspendedWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<void> {
  if (state.status !== 'suspended') {
    return;
  }
  const previousState: WorkflowState = { ...state };
  state.status = 'running';
  state.updatedAt = internals.options.getNow();
  // Resume flips suspended→running — engine-generated workflow state. Fence it on
  // the lease epoch (issue #470 Step 2) so a deposed engine cannot reactivate a
  // workflow the successor already owns.
  await commitFencedEngineWrite(
    internals,
    [
      { type: 'put', key: KEYS.workflow(state.id), value: encode(state) },
      ...buildWorkflowVisibilityIndexTransition(state.id, previousState, state).batchOps,
      ...(state.executionDeadline !== undefined
        ? buildTimerBatchOperations({
            id: `deadline:${state.id}`,
            workflowId: state.id,
            fireAt: state.executionDeadline,
            kind: 'execution-deadline',
          })
        : []),
    ],
    [],
    () => new Error(`Resume of workflow "${state.id}" lost its CAS race.`),
  );
}

export async function resumeWorkflowFromStorage(
  internals: EngineInternals,
  workflowId: string,
  dispatchResumedEvent: boolean,
  callbacks: LifecycleCallbacks,
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

  // Load checkpoint
  const checkpointBytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  if (!checkpointBytes) {
    throw new Error(`Checkpoint not found for workflow "${workflowId}"`);
  }

  const checkpoint = deserializeCheckpoint(checkpointBytes);

  // Look up registration
  const registration = internals.registrations.get(state.type);
  if (!registration) {
    throw new Error(
      `No workflow registered with name "${state.type}" (needed to resume "${workflowId}")`,
    );
  }

  const preparedResumeState = await prepareResumeState(
    internals,
    workflowId,
    state,
    checkpoint,
    checkpointBytes,
    registration,
    callbacks,
  );
  const resumeCheckpoint = preparedResumeState.checkpoint;
  const registeredVersionTuple = preparedResumeState.versionTuple;

  // Restore the event log head from storage so that the next appendToBatch()
  // call uses the correct sequence number and prevHash rather than falling
  // back to EMPTY_EVENT_HEAD (sequence -1) and overwriting existing entries.
  const eventLog = new EventLog(internals.storage, workflowId);
  const restoredHead = await eventLog.loadHead();

  // History circuit breaker, pre-replay site: if the persisted history already
  // exceeds maxEvents, terminate without replaying so the oversized log never
  // stalls the shared event loop.
  if (await enforceHistoryPolicyBeforeReplay(internals, workflowId, restoredHead, callbacks)) {
    return callbacks.getHandle(workflowId);
  }

  const workflowStartHeaders = await loadWorkflowStartHeaders(internals, workflowId, callbacks);
  await loadTerminalCleanupTrackedState(internals, workflowId, callbacks);

  // Re-provide the non-serialized `services` value before the generator is
  // driven forward. Inline mode only — worker mode cannot receive a
  // non-serializable value (and `engine.start` rejected `services` there). When
  // the resolver reports the run unavailable, fail just this run and skip the
  // resume so the engine and other recovered runs are unaffected.
  if (await prepareRecoveredServicesOrFail(internals, state, callbacks)) {
    return callbacks.getHandle(workflowId);
  }

  const handle = callbacks.getHandle(workflowId);
  await callbacks.runSerializedWorkflowStateWrite(workflowId, () =>
    performSerializedResume(internals, {
      workflowId,
      resumeCheckpoint,
      serializedCheckpoint: preparedResumeState.serializedCheckpoint,
      registeredVersionTuple,
      restoredHead,
      workflowStartHeaders,
      registration,
      callbacks,
    }),
  );

  if (dispatchResumedEvent) {
    callbacks.dispatchEvent(new WorkflowResumedEvent(workflowId, resumeCheckpoint.step));
  }
  if (internals.inlineStrategy) {
    void callbacks.swallowPromiseRejection(
      callbacks.processPendingUpdatesAfterInlineAdvance(workflowId),
    );
  }

  return handle;
}
