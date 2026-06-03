import { KEYS } from '../../../storage/interface.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../../checkpoint.ts';
import { Context, setContextWorkflowInterceptor } from '../../context.ts';
import { EventLog, type EventHeadRecord } from '../../event-log.ts';
import { WorkflowResumedEvent } from '../../events.ts';
import type { Checkpoint, WorkflowState } from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { createCancelHandlerRegistration, resetCancelHandlers } from '../cancel-handlers.ts';
import { rememberCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { getWorkflowExecutionStartedAt, type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { getComposedWorkflowInterceptor } from '../strategy-helpers.ts';
import { decodeWorkflowState } from '../validation.ts';
import { prepareResumeState } from './persist.ts';
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
 * Re-provide a recovered inline workflow's non-serialized `services` via the
 * engine's `resolveWorkflowServices`. On `available`, the rebuilt value is
 * stored in `internals.workflowServices` so the relaunched `Context` reads it as
 * `ctx.services`. With no resolver configured, the run resumes with no services
 * (`ctx.services` is `undefined`) — the same as a fresh start without services.
 */
async function resolveServicesForRecovery(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<{ status: 'available' } | { status: 'unavailable'; reason: string }> {
  const resolver = internals.options.resolveWorkflowServices;
  if (!resolver) {
    return { status: 'available' };
  }
  const resolution = await resolver({
    workflowId: state.id,
    workflowType: state.type,
    input: state.input,
  });
  if (resolution.status === 'available') {
    internals.workflowServices.set(state.id, resolution.services);
    return { status: 'available' };
  }
  return { status: 'unavailable', reason: resolution.reason };
}

/**
 * Re-provide a recovered inline workflow's `services` before the generator is
 * driven forward. Returns `true` when the run was failed (services unavailable)
 * and the caller should stop resuming it; `false` to continue the resume. Worker
 * mode skips this entirely — services are inline-only and rejected at start.
 *
 * A failure here (e.g. a storage write fault during the terminal commit) is
 * recorded fail-warn rather than thrown, so it cannot escape into `recoverAll`'s
 * loop and abort recovery of sibling runs.
 */
async function prepareRecoveredServicesOrFail(
  internals: EngineInternals,
  state: WorkflowState,
  callbacks: LifecycleCallbacks,
): Promise<boolean> {
  if (internals.inlineStrategy === null) {
    return false;
  }
  const resolved = await resolveServicesForRecovery(internals, state);
  if (resolved.status !== 'unavailable') {
    return false;
  }
  try {
    await callbacks.failWorkflowForUnavailableServices(state.id, resolved.reason);
  } catch (error) {
    callbacks.handleCleanupError('failWorkflowForUnavailableServices', error, state.id);
  }
  return true;
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

function relaunchInlineWorkflowAfterResume(
  internals: EngineInternals,
  latestState: WorkflowState,
  args: Pick<
    SerializedResumeArgs,
    'workflowId' | 'resumeCheckpoint' | 'registration' | 'callbacks'
  >,
): void {
  const { workflowId, resumeCheckpoint, registration, callbacks } = args;
  // Keep the final running-state check and the re-entry into user code
  // in the same serialized section so cancel/timeout cannot commit a
  // terminal state and still let a parked workflow continue.
  //
  const accumulatedResults = new Map<number, unknown>(resumeCheckpoint.accumulatedResults);
  const workflowAbort = new AbortController();

  resetCancelHandlers(internals, workflowId);
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

function relaunchWorkerWorkflowAfterResume(
  internals: EngineInternals,
  latestState: WorkflowState,
  args: Pick<SerializedResumeArgs, 'workflowId' | 'resumeCheckpoint' | 'workflowStartHeaders'>,
): void {
  const { workflowId, resumeCheckpoint, workflowStartHeaders } = args;
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

  if (latestState.status !== 'running') {
    throw new Error(
      `Cannot resume workflow "${workflowId}": status is "${latestState.status}", expected "running"`,
    );
  }

  commitSerializedResumeState(internals, args);

  if (internals.inlineStrategy) {
    relaunchInlineWorkflowAfterResume(internals, latestState, args);
    return;
  }
  relaunchWorkerWorkflowAfterResume(internals, latestState, args);
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
  if (state.status !== 'running') {
    throw new Error(
      `Cannot resume workflow "${workflowId}": status is "${state.status}", expected "running"`,
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
