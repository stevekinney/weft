/**
 * COR-75: a two-phase `engine.prepare()` / `handle.launch()` surface.
 *
 * `startWorkflow()` (`start.ts`) already separates "commit the initial
 * durable record" (`buildAndCommitStartBatch`) from "begin execution"
 * (`beginExecutionAwaitingLiveness`) — the commit happens first, and always
 * durably marks the record `'running'` before a single generator turn has
 * run (see `start-state.ts`). `prepare()` exposes that existing boundary
 * instead of introducing a new one: it runs the exact same admission,
 * reservation, and create-batch commit `startWorkflow()` does, with the
 * initial record forced to `'pending'` (no `startedAt`) instead of
 * `'running'` — {@link createInitialWorkflowState}'s `forcePendingWithoutTimer`
 * parameter — and defers `beginExecutionAwaitingLiveness` to a later,
 * explicit `launch()` call.
 *
 * Ownership and lease semantics match `start()` BY CONSTRUCTION, not by
 * separate reimplementation: `forcePendingWithoutTimer` is independent of
 * `delayedStartTimer`, so `buildAndCommitStartBatch`'s create batch still
 * folds claim acquisition into the same atomic write an ordinary start's
 * create batch uses (`start-commit.ts`'s `isDelayedStart` check is keyed on
 * `delayedStartTimer`, which `prepare()` always passes as `undefined`) — unlike
 * an actual `startAt`/`startAfter` delayed start, whose create batch
 * deliberately skips the fold because ITS `pending` row has no owner yet.
 * `launch()` therefore never needs to (re-)acquire a claim: it folds
 * `pending` → `running` through the ordinary {@link commitFencedEngineWrite},
 * fenced on the epoch this workflow's `prepare()` already claimed — exactly
 * like any other write an engine makes for a workflow it already owns.
 *
 * The `pending` → `running` fold itself mirrors `operations-time.ts`'s
 * `startDelayedWorkflow` (a delayed start's timer-fire fold): reload the
 * latest state, verify it is still `pending`, write the transition plus its
 * visibility-index update and (if requested) execution-deadline timer in one
 * fenced batch, then begin execution. `launch()` differs from that path in
 * one respect: because `options.executionTimeout`'s DURATION FORMAT is
 * validated up front in `prepareWorkflow()` (see below), an invalid deadline
 * can only be discovered here if the format was somehow valid then invalid
 * now (getNow()-relative overflow) — vanishingly unlikely, so unlike the
 * timer-fire path (which defers ALL validation to fire time and durably fails
 * the workflow on error, since nothing is awaiting it), `launch()` propagates
 * a synchronous rejection to its caller instead of durably failing the run.
 *
 * @module core/engine/lifecycle/prepare-and-launch
 */

import { KEYS } from '../../../storage/interface.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../../checkpoint.ts';
import { encode } from '../../codec.ts';
import { assertPayloadWithinLimit } from '../../payload-size.ts';
import { buildTimerBatchOperations, normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  assertValidOnTerminalConflict,
  StartWorkflowValidationError,
} from '../../start-workflow-validation.ts';
import type { Checkpoint, StartWorkflowOptions, WorkflowState } from '../../types.ts';
import { releaseInFlightStart } from '../catalog-removal.ts';
import { rememberCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import type { WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { loadWorkflowState, runSerializedWorkflowStateWrite } from '../storage-io.ts';
import { buildWorkflowConcurrencyStartOperations } from '../workflow-concurrency.ts';
import { buildWorkflowVisibilityIndexTransition } from '../workflow-indexes.ts';
import { createWorkflowVersionTuple, workflowVersionTupleFromState } from './persist.ts';
import { reprovideRecoveredServices } from './recovered-services.ts';
import {
  createWorkflowHandle,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
} from './shared.ts';
import { buildAndCommitStartBatch } from './start-commit.ts';
import {
  assertDeferSupported,
  beginExecutionAwaitingLiveness,
  runWorkflowStartInterceptor,
} from './start-exec.ts';
import {
  resolveCachedStartRevision,
  resolveStartRevisionUncached,
} from './start-revision-resolution.ts';
import {
  applyRestartLineage,
  createInitialCheckpoint,
  createInitialWorkflowState,
  parseStartOptionDuration,
} from './start-state.ts';
import {
  enforceReplayOnlyIdFence,
  GENERATED_ID_START_DECISION,
  prepareTerminalRunPurge,
  resolveTerminalConflictForRestart,
} from './start-terminal-conflict-purge.ts';
import {
  assertServicesSupportedForMode,
  prepareStartWorkflow,
  resolveAndReserveStartRegistration,
  rollbackTransientStartState,
} from './start.ts';

/**
 * Everything `launchPreparedWorkflow`/`abandonPreparedWorkflow` need to act
 * on a `prepare()`d run later, on demand. Deliberately thin: `state`,
 * `checkpoint`, and `registration` are RELOADED fresh at launch time (like
 * `startDelayedWorkflow` reloads them at fire time) rather than trusted from
 * a long-held closure, since an arbitrary amount of real time — and any
 * number of concurrent operations against this same workflow id — can pass
 * between `prepare()` and `launch()`/`abandon()`.
 *
 * `phase` and `reservationReleased` are mutated in place so `launch()` and
 * `abandon()` (which share one `PreparedWorkflowContext` instance per
 * `prepare()` call) observe each other's terminal action.
 */
export type PreparedWorkflowContext = {
  readonly workflowId: string;
  readonly type: string;
  readonly options: StartWorkflowOptions | undefined;
  inFlightRevision: string | undefined;
  phase: 'prepared' | 'launched' | 'abandoned';
  reservationReleased: boolean;
};

export type PrepareWorkflowResult = {
  handle: WorkflowHandle;
  context: PreparedWorkflowContext;
};

/** Release the pre-commit admission guard held since `prepareWorkflow()`. Safe to call more than once. */
function releasePreparedWorkflowReservation(
  internals: EngineInternals,
  context: PreparedWorkflowContext,
): void {
  if (context.reservationReleased) return;
  context.reservationReleased = true;
  internals.pendingStarts.delete(context.workflowId);
  releaseInFlightStart(internals, context.type, context.inFlightRevision);
}

export async function prepareWorkflow(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartWorkflowOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<PrepareWorkflowResult> {
  assertServicesSupportedForMode(internals, options);
  assertValidOnTerminalConflict(options);

  const preparation = prepareStartWorkflow(internals, options, callbacks, false);
  const {
    workflowId,
    callerProvidedId,
    parentHeaders,
    executionStateOwnerId,
    parentWorkflowId,
    parentWorkflowExecutionToken,
    delayedStartTimer,
  } = preparation;

  if (delayedStartTimer !== undefined) {
    throw new StartWorkflowValidationError(
      'options.startAt/options.startAfter are incompatible with engine.prepare(): a ' +
        'prepared workflow launches only when handle.launch() is called. Use ' +
        'engine.start() for a delayed start, or omit startAt/startAfter.',
    );
  }

  // Fail fast on an invalid `executionTimeout` duration NOW, before any
  // commit, rather than discovering it at launch time — unlike a delayed
  // start, which defers this check to its timer fire because nothing else
  // validates it first. The parsed value itself is discarded: the deadline
  // must count from `launch()` time, not `prepare()` time, so it is
  // recomputed from this same option there.
  if (options?.executionTimeout !== undefined) {
    parseStartOptionDuration(
      internals,
      options.executionTimeout,
      'options.executionTimeout',
      callbacks,
    );
  }

  if (internals.pendingStarts.has(workflowId)) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  internals.pendingStarts.add(workflowId);
  let inFlightRevision: string | undefined;

  try {
    assertPayloadWithinLimit(input, internals.options.payloadSizePolicy.maxBytes, 'workflow input');

    const {
      registration,
      inFlightRevision: reservedRevision,
      resolvedRevision,
    } = await resolveAndReserveStartRegistration(internals, type, undefined, callbacks);
    inFlightRevision = reservedRevision;
    const workflowConcurrency = registration.concurrency;
    const revision =
      resolveCachedStartRevision(internals, type, resolvedRevision) ??
      (await resolveStartRevisionUncached(internals, type));

    const {
      terminalRunToPurge,
      duplicateIdCondition,
      duplicateIdGenerationCondition,
      observedGenerationBytes,
    } = callerProvidedId
      ? await resolveTerminalConflictForRestart(internals, workflowId, options)
      : GENERATED_ID_START_DECISION;
    enforceReplayOnlyIdFence(false, workflowId, terminalRunToPurge);

    const versionTuple = createWorkflowVersionTuple(internals, registration, callbacks);

    const state = createInitialWorkflowState(
      internals,
      workflowId,
      type,
      input,
      versionTuple,
      revision,
      options,
      preparation.normalizedTags,
      executionStateOwnerId,
      parentWorkflowId,
      parentWorkflowExecutionToken,
      undefined,
      callbacks,
      true,
    );
    applyRestartLineage(state, terminalRunToPurge);
    const checkpoint = createInitialCheckpoint(
      internals,
      workflowId,
      versionTuple.workflowVersion,
      options,
      state.workflowExecutionToken,
      callbacks,
    );
    const workflowStartHeaders = runWorkflowStartInterceptor(
      internals,
      workflowId,
      type,
      input,
      parentHeaders,
      callbacks,
    );
    const persistedWorkflowStartHeaders = selectPersistedWorkflowStartHeaders(workflowStartHeaders);

    const purgeDeleteOperations =
      terminalRunToPurge !== null
        ? await prepareTerminalRunPurge(
            internals,
            terminalRunToPurge,
            callbacks,
            observedGenerationBytes,
          )
        : undefined;

    internals.checkpoints.set(workflowId, checkpoint);
    rememberCommittedCheckpointBytes(internals, workflowId, serializeCheckpoint(checkpoint));
    setWorkflowStartHeaders(internals, workflowId, workflowStartHeaders, callbacks);
    internals.workflowVersionTuples.set(workflowId, versionTuple);

    await buildAndCommitStartBatch(
      {
        internals,
        workflowId,
        state,
        checkpoint,
        registration,
        options,
        delayedStartTimer: undefined,
        persistedWorkflowStartHeaders,
        additionalStartOperations: undefined,
        buildWorkflowConcurrencyStartOperations:
          workflowConcurrency === undefined
            ? undefined
            : () =>
                buildWorkflowConcurrencyStartOperations(
                  internals,
                  type,
                  workflowId,
                  input,
                  workflowConcurrency,
                ),
        callbacks,
        purgeDeleteOperations,
        duplicateIdCondition,
        duplicateIdGenerationCondition,
      },
      undefined,
    );

    if (options?.services !== undefined) {
      internals.workflowServices.set(workflowId, options.services);
      internals.workflowsNeedingTerminalCleanup.add(workflowId);
    }
    if (workflowConcurrency !== undefined) {
      internals.workflowsNeedingTerminalCleanup.add(workflowId);
    }

    const handle = createWorkflowHandle(internals, workflowId, callbacks);
    // Reservation intentionally held past this point — released by whichever
    // of `launch()`/`abandon()` runs, not here. Holding it keeps a concurrent
    // catalog removal of `registration`'s revision from succeeding while this
    // prepared run could still be launched against it.
    return {
      handle,
      context: {
        workflowId,
        type,
        options,
        inFlightRevision,
        phase: 'prepared',
        reservationReleased: false,
      },
    };
  } catch (error) {
    internals.pendingStarts.delete(workflowId);
    releaseInFlightStart(internals, type, inFlightRevision);
    rollbackTransientStartState(internals, workflowId);
    throw error;
  }
}

export async function launchPreparedWorkflow(
  internals: EngineInternals,
  context: PreparedWorkflowContext,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  if (context.phase !== 'prepared') {
    throw new Error(
      `Cannot launch workflow "${context.workflowId}": it was already ${context.phase}.`,
    );
  }
  context.phase = 'launched';

  try {
    assertDeferSupported(internals, context.options, false);

    const state = await loadWorkflowState(internals, context.workflowId);
    if (!state || state.status !== 'pending') {
      throw new Error(
        `Cannot launch workflow "${context.workflowId}": it is no longer pending (status: ${
          state?.status ?? 'not found'
        }).`,
      );
    }

    const checkpointBytes = await internals.storage.get(KEYS.checkpoint(context.workflowId));
    if (!checkpointBytes) {
      throw new Error(`Cannot launch workflow "${context.workflowId}": its checkpoint is missing.`);
    }
    const checkpoint: Checkpoint = deserializeCheckpoint(checkpointBytes);

    // `state.revision` is always already stamped for a `prepare()`d record
    // (this release stamps every fresh start's revision, unlike a legacy
    // pre-pinning record) — never re-derived from the resolver's own return.
    const resolvedRegistration = await callbacks.resolveExecutableRegistrationForRevision(
      state.type,
      state.revision,
    );
    const registration = resolvedRegistration.entry;

    const now = internals.options.getNow();
    const executionDeadline = resolveLaunchExecutionDeadline(
      internals,
      context.workflowId,
      context.options,
      now,
      callbacks,
    );

    const runningState = await runSerializedWorkflowStateWrite(internals, context.workflowId, () =>
      commitPendingToRunning(internals, context.workflowId, executionDeadline, now),
    );
    if (!runningState) {
      throw new Error(`Cannot launch workflow "${context.workflowId}": it is no longer pending.`);
    }

    const servicesUnavailable = await reprovideRecoveredServices(
      internals,
      runningState,
      (workflowId, error) => callbacks.failWorkflowForUnavailableServices(workflowId, error),
      callbacks.handleCleanupError,
      callbacks.dispatchEvent,
    );
    if (servicesUnavailable) {
      throw new Error(
        `Cannot launch workflow "${context.workflowId}": its recorded services could not be re-provided.`,
      );
    }

    internals.checkpoints.set(context.workflowId, checkpoint);
    internals.workflowVersionTuples.set(
      context.workflowId,
      workflowVersionTupleFromState(internals, runningState, callbacks),
    );

    const handle = createWorkflowHandle(internals, context.workflowId, callbacks);
    await beginExecutionAwaitingLiveness(
      internals,
      {
        type: runningState.type,
        input: runningState.input,
        checkpoint,
        state: runningState,
        registration,
        options: context.options,
        isDelayed: false,
      },
      context.workflowId,
      callbacks,
    );
    return handle;
  } finally {
    releasePreparedWorkflowReservation(internals, context);
  }
}

function resolveLaunchExecutionDeadline(
  internals: EngineInternals,
  workflowId: string,
  options: StartWorkflowOptions | undefined,
  now: number,
  callbacks: LifecycleCallbacks,
): number | undefined {
  if (options?.executionTimeout === undefined) {
    return undefined;
  }
  // Already validated for format at `prepareWorkflow()` time; recomputed
  // fresh here so the deadline counts from launch, not from prepare.
  const executionTimeoutMs = parseStartOptionDuration(
    internals,
    options.executionTimeout,
    'options.executionTimeout',
    callbacks,
  );
  return normalizeStorageTimestamp(
    now + executionTimeoutMs,
    `Execution timeout for workflow "${workflowId}"`,
  );
}

async function commitPendingToRunning(
  internals: EngineInternals,
  workflowId: string,
  executionDeadline: number | undefined,
  now: number,
): Promise<WorkflowState | null> {
  const latestState = await loadWorkflowState(internals, workflowId);
  if (!latestState || latestState.status !== 'pending') {
    return null;
  }

  const nextRunningState: WorkflowState = {
    ...latestState,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    ...(executionDeadline !== undefined && { executionDeadline }),
  };

  const operations = [
    {
      type: 'put' as const,
      key: KEYS.workflow(workflowId),
      value: encode(nextRunningState),
    },
    ...buildWorkflowVisibilityIndexTransition(workflowId, latestState, nextRunningState).batchOps,
    ...(executionDeadline !== undefined
      ? buildTimerBatchOperations({
          id: `deadline:${workflowId}`,
          workflowId,
          fireAt: executionDeadline,
          kind: 'execution-deadline',
        })
      : []),
  ];

  // Ownership was already acquired when `prepareWorkflow()`'s create batch
  // committed (unlike a delayed start's create batch, which is deliberately
  // claim-less) — fence on the already-held epoch, exactly like any other
  // write this engine makes for a workflow it already owns.
  await commitFencedEngineWrite(
    internals,
    workflowId,
    operations,
    [],
    () => new Error(`Launch transition for workflow "${workflowId}" lost its CAS race.`),
  );
  return nextRunningState;
}

/**
 * Abandon a `prepare()`d run that was never (and will never be) launched:
 * transitions it to the terminal `'cancelled'` status via the exact same
 * `terminateWorkflow()` path `engine.cancel()` uses — already proven safe on
 * a `'pending'` record with no live generator or queued inline start (a
 * delayed start not yet fired cancels the same way) — tagged with
 * `PREPARED_WORKFLOW_ABANDONED_REASON` so it is distinguishable from an
 * ordinary mid-run cancel. A no-op if already abandoned; throws if already
 * launched.
 *
 * Takes `terminate` as a caller-supplied function, rather than importing
 * `terminateWorkflow` from `../termination/complete.ts` directly, so this
 * module does not depend on the termination module — which itself depends
 * (via `bulk-operations.ts`/`inline-launch-queue.ts`) on the `lifecycle.ts`
 * barrel this module is re-exported through. `index.ts` (above that barrel)
 * supplies the real implementation.
 */
export async function abandonPreparedWorkflow(
  internals: EngineInternals,
  context: PreparedWorkflowContext,
  terminate: (workflowId: string) => Promise<void>,
): Promise<void> {
  if (context.phase === 'launched') {
    throw new Error(`Cannot abandon workflow "${context.workflowId}": it was already launched.`);
  }
  if (context.phase === 'abandoned') {
    return;
  }
  context.phase = 'abandoned';

  try {
    await terminate(context.workflowId);
  } finally {
    releasePreparedWorkflowReservation(internals, context);
  }
}
