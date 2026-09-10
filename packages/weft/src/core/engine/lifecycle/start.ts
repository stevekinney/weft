import type { BatchOperation } from '../../../storage/interface.ts';
import { assertPayloadWithinLimit } from '../../payload-size.ts';
import { normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  assertExclusiveStartWorkflowOptions,
  assertValidOnTerminalConflict,
  coerceReplayWorkflowId,
  coerceStartWorkflowId,
  coerceStartWorkflowTimestamp,
  StartWorkflowValidationError,
} from '../../start-workflow-validation.ts';
import type { StartOptions, StartWorkflowOptions, TimerEntry } from '../../types.ts';
import {
  releaseInFlightStart,
  resolveAndReserveExecutableRegistration,
} from '../catalog-removal.ts';
import { forgetCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { Engine } from '../index.ts';
import type { EngineInternals } from '../internals.ts';
import { createDelayedStartTimerEntry } from '../operations-time.ts';
import { resolveAndReservePinnedExecutableRegistration } from '../pinned-schedule-revision.ts';
import { selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { buildWorkflowConcurrencyStartOperations } from '../workflow-concurrency.ts';
import { createWorkflowVersionTuple } from './persist.ts';
import {
  createWorkflowHandle,
  normalizeStartWorkflowTags,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RegistrationEntry,
} from './shared.ts';
import { buildAndCommitStartBatch, type BuildIdempotentStartOperations } from './start-commit.ts';
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

export async function start(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartWorkflowOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  return startWorkflow(internals, type, input, options, undefined, callbacks);
}

type StartWorkflowPreparation = {
  workflowId: string;
  callerProvidedId: boolean;
  parentHeaders: Map<string, string> | undefined;
  executionStateOwnerId: string | undefined;
  parentWorkflowId: string | undefined;
  parentWorkflowExecutionToken: string | undefined;
  submissionTime: number;
  delayedStartTimer: TimerEntry | undefined;
  normalizedTags: string[] | undefined;
};

function prepareStartWorkflow(
  internals: EngineInternals,
  options: StartOptions | undefined,
  callbacks: LifecycleCallbacks,
  /**
   * Internal-only (WFT-95): when truthy (`true`, `'reattach-only'`, or
   * `'bulk-retry-only'`), `options.id` is validated with the decode-compatible
   * {@link coerceReplayWorkflowId} instead of the strict
   * {@link coerceStartWorkflowId}. See `startWorkflow`'s `skipAdmissionIdCheck`
   * parameter for the full contract — this must stay unreachable from any
   * public start surface. The `'reattach-only'`/`'bulk-retry-only'` fence
   * itself is applied later in `startWorkflow`, after
   * `resolveTerminalConflictForRestart()` runs — this coercion only needs to
   * know whether to relax the `.`/`..` rejection at all, not which variant is
   * in effect.
   */
  skipAdmissionIdCheck: boolean | 'reattach-only' | 'bulk-retry-only',
): StartWorkflowPreparation {
  const callerProvidedId = options?.id !== undefined;
  const workflowId =
    options?.id !== undefined
      ? skipAdmissionIdCheck
        ? coerceReplayWorkflowId(options.id, 'options.id')
        : coerceStartWorkflowId(options.id, 'options.id')
      : crypto.randomUUID();

  // Capture and clear pending parent headers immediately, before any async
  // work, to prevent a concurrent child-workflow start from overwriting them.
  const parentHeaders = internals.pendingParentHeaders;
  internals.pendingParentHeaders = undefined;
  const pendingExecutionStateOwnerId = internals.pendingExecutionStateOwnerId;
  const executionStateOwnerId =
    pendingExecutionStateOwnerId === null
      ? undefined
      : (pendingExecutionStateOwnerId ?? workflowId);
  internals.pendingExecutionStateOwnerId = undefined;
  const parentWorkflowId = internals.pendingParentWorkflowId;
  internals.pendingParentWorkflowId = undefined;
  const parentWorkflowExecutionToken = internals.pendingParentWorkflowExecutionToken;
  internals.pendingParentWorkflowExecutionToken = undefined;
  const submissionTime = internals.options.getNow();
  const scheduledStartAt = resolveScheduledStartAt(internals, options, submissionTime, callbacks);
  const normalizedTags = normalizeStartWorkflowTags(internals, options?.tags, undefined, callbacks);
  const delayedStartTimer =
    scheduledStartAt !== undefined && scheduledStartAt > submissionTime
      ? createDelayedStartTimerEntry(internals, workflowId, scheduledStartAt, options, {
          parseStartOptionDuration: (value, fieldName) =>
            parseStartOptionDuration(internals, value, fieldName, callbacks),
        })
      : undefined;

  return {
    workflowId,
    callerProvidedId,
    parentHeaders,
    executionStateOwnerId,
    parentWorkflowId,
    parentWorkflowExecutionToken,
    submissionTime,
    delayedStartTimer,
    normalizedTags,
  };
}

function rollbackTransientStartState(internals: EngineInternals, workflowId: string): void {
  forgetCommittedCheckpointBytes(internals, workflowId);
  internals.checkpoints.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.workflowServices.delete(workflowId);
  internals.workflowsNeedingTerminalCleanup.delete(workflowId);
}

/**
 * `services` is a non-serializable per-run value read inline as `ctx.services`.
 * It cannot cross to a Worker, so reject it early under worker execution mode
 * rather than stranding a persisted run that can never read its services.
 */
function assertServicesSupportedForMode(
  internals: EngineInternals,
  options: StartOptions | undefined,
): void {
  if (options?.services !== undefined && internals.inlineStrategy === null) {
    throw new Error(
      'options.services is only supported in inline execution mode; it cannot be ' +
        'serialized to a Worker. Remove services or use workflowExecutionMode: "inline".',
    );
  }
}

/**
 * `startWorkflow`'s resolve-and-reserve dispatch — split out to keep that
 * function under the complexity ceiling. Deliberately NOT an `async`
 * function: it returns the callee's own pending `Promise` directly (or,
 * for the pinned branch, chains exactly one `.then()` onto it) rather than
 * `await`-ing internally and returning a freshly-wrapped one. An `await` on
 * an `async` function's return value costs an EXTRA microtask tick beyond
 * awaiting the inner promise directly — the exact class of hot-path timing
 * regression WFT-17/18 hit and fixed for this same function (see
 * `resolveCachedStartRevision`'s own doc comment) — so preserving the
 * ordinary (non-pinned) branch's tick-for-tick timing here is required, not
 * cosmetic; changing it can silently alter `startWorkflow`'s interleaving
 * against concurrent callers.
 *
 * For the pinned branch (`revisionOverride` defined, WFT-20), remaps the
 * pinned resolver's result so `resolvedRevision` is always `revisionOverride`
 * — even for an eager type, whose resolver returns `revision: undefined` by
 * its own eager convention — so the ordinary
 * `resolveCachedStartRevision(...) ?? (await resolveStartRevisionUncached(...))`
 * line below (byte-for-byte unchanged from before this field existed) keeps
 * working uniformly for both cases without `startWorkflow` needing any new
 * branch of its own.
 */
function resolveAndReserveStartRegistration(
  internals: EngineInternals,
  type: string,
  revisionOverride: string | undefined,
  callbacks: LifecycleCallbacks,
): Promise<{
  registration: RegistrationEntry;
  inFlightRevision: string | undefined;
  resolvedRevision: string | undefined;
}> {
  if (revisionOverride === undefined) {
    return resolveAndReserveExecutableRegistration(
      internals,
      type,
      callbacks.resolveExecutableRegistration,
    );
  }
  return resolveAndReservePinnedExecutableRegistration(
    internals.engine as unknown as Engine,
    internals,
    type,
    revisionOverride,
  ).then(({ registration, inFlightRevision }) => ({
    registration,
    inFlightRevision,
    resolvedRevision: revisionOverride,
  }));
}

export async function startWorkflow(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartWorkflowOptions | undefined,
  additionalStartOperations: BatchOperation[] | undefined,
  callbacks: LifecycleCallbacks,
  buildIdempotentStartOperations?: BuildIdempotentStartOperations,
  /**
   * A pinned schedule's forward-looking revision commitment (WFT-20),
   * threaded from `ScheduleCallbacks.startWorkflow`'s own `revisionOverride`
   * parameter. When supplied, this call resolves and reserves EXACTLY this
   * revision (via {@link resolveAndReservePinnedExecutableRegistration},
   * which enforces an exact-match check for an eager type rather than
   * silently falling back to whatever is active) instead of the ordinary
   * "whatever `resolveExecutableRegistration` currently resolves"
   * admission path, and the persisted `WorkflowState.revision` is this
   * value verbatim — never re-derived from `registeredCatalogRevisions`.
   * `undefined` (the default, every non-schedule start) is byte-for-byte
   * the pre-WFT-20 admission path.
   */
  revisionOverride?: string,
  /**
   * Internal-only, never part of the public `StartOptions` type (WFT-95).
   * When truthy, `options.id` skips strict fresh-admission validation
   * (`assertValidWorkflowId`'s `.`/`..` rejection) and is instead validated
   * with the decode-compatible `assertDecodableWorkflowId`. This exists
   * ONLY to replay an id that was already durably accepted before strict
   * admission existed — never to let a genuinely fresh caller admit `.`/`..`.
   *
   * Set from exactly three internal call sites, all replaying an
   * already-persisted id rather than admitting a new one:
   *   - `drainQueuedScheduleRun()` (via `ScheduledRunStartOptions.skipAdmissionIdCheck`,
   *     threaded through `startScheduledRun()`), which restarts a schedule's
   *     persisted `queuedRuns[].workflowId` — safe unconditionally (`true`),
   *     since a queued run created after this fix was already validated as
   *     non-`.`/`..` at schedule-admission time, so relaxing the check here
   *     is a no-op for it and only matters for a historical pre-WFT-95 queued run.
   *   - `retryFailedWorkflow()`'s checkpoint-absent fallback (`bulk-operations-retry.ts`),
   *     which rebuilds an already-persisted, already-validated-at-the-time
   *     `workflowId` from its stored input via `onTerminalConflict: 'start-new'`.
   *     Passes the literal `'bulk-retry-only'` rather than `true` — see
   *     {@link enforceReplayOnlyIdFence}'s doc comment for the TOCTOU race that
   *     value fences: the retry's own confirmation read and
   *     `resolveTerminalConflictForRestart`'s atomic read are not the same
   *     read, so a concurrent purge under `ownership: 'workflow-lease'` can
   *     leave nothing to purge-and-replace by the time this runs.
   *   - `dispatchChildWorkflowStart()`'s crash-reattach retry, which passes
   *     the literal `'reattach-only'` rather than `true` — see
   *     {@link enforceReplayOnlyIdFence}'s doc comment for the same TOCTOU
   *     race (this one only *speculatively* matched an existing record
   *     before this call, unlike the schedule-drain site above).
   *
   * Every other caller (REST, JSON-RPC, direct `engine.start()`,
   * `engine.startOrSignal()`, a fresh `ctx.startChild()`) omits this
   * parameter and gets the strict check, because it is not part of
   * `StartOptions`/`StartWorkflowOptions` and therefore cannot be set from
   * any public surface.
   */
  skipAdmissionIdCheck?: boolean | 'reattach-only' | 'bulk-retry-only',
): Promise<WorkflowHandle> {
  assertServicesSupportedForMode(internals, options);
  assertValidOnTerminalConflict(options);

  // `prepareStartWorkflow`'s sync capture of pendingParent* MUST run before any
  // await, or a concurrent same-tick `ctx.startChild()` could overwrite it.
  const preparation = prepareStartWorkflow(
    internals,
    options,
    callbacks,
    Boolean(skipAdmissionIdCheck),
  );
  const {
    workflowId,
    callerProvidedId,
    parentHeaders,
    executionStateOwnerId,
    parentWorkflowId,
    parentWorkflowExecutionToken,
    delayedStartTimer,
  } = preparation;

  assertDeferSupported(internals, options, Boolean(delayedStartTimer));

  // Atomic check-and-reserve, still synchronous with the prep above.
  if (internals.pendingStarts.has(workflowId)) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  internals.pendingStarts.add(workflowId);
  let startSucceeded = false;
  let inFlightRevision: string | undefined;

  try {
    // Reject oversized input before any await, before a lazy type's resolve.
    assertPayloadWithinLimit(input, internals.options.payloadSizePolicy.maxBytes, 'workflow input');

    const {
      registration,
      inFlightRevision: reservedRevision,
      resolvedRevision,
    } = await resolveAndReserveStartRegistration(internals, type, revisionOverride, callbacks);
    inFlightRevision = reservedRevision;
    const workflowConcurrency = registration.concurrency;
    const revision =
      resolveCachedStartRevision(internals, type, resolvedRevision) ??
      (await resolveStartRevisionUncached(internals, type));

    // Only caller-supplied ids can collide; a generated UUID skips the read. Decide the
    // duplicate-id outcome up front (throws for a non-terminal or default-policy collision),
    // but DEFER any destructive purge until just before the create commit below, so a
    // `'start-new'` restart rejected by later validation leaves the prior terminal run intact.
    // `pendingStarts` covers that window in-engine, `duplicateIdCondition` across engines.
    const {
      terminalRunToPurge,
      duplicateIdCondition,
      duplicateIdGenerationCondition,
      observedGenerationBytes,
    } = callerProvidedId
      ? await resolveTerminalConflictForRestart(internals, workflowId, options)
      : GENERATED_ID_START_DECISION;
    enforceReplayOnlyIdFence(skipAdmissionIdCheck, workflowId, terminalRunToPurge);

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
      delayedStartTimer,
      callbacks,
    );
    applyRestartLineage(state, terminalRunToPurge);
    const checkpoint = createInitialCheckpoint(
      internals,
      workflowId,
      versionTuple.workflowVersion,
      options,
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

    // Last possible moment before the create commit, so a `'start-new'`
    // restart rejected by any earlier build step leaves the prior terminal
    // run intact. Clears the OLD run's in-memory caches BEFORE the new run's
    // maps are written below, but folds the destructive storage delete into
    // the atomic create batch as `purgeDeleteOperations` below.
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
    setWorkflowStartHeaders(internals, workflowId, workflowStartHeaders, callbacks);

    // Cache the workflow version tuple for forwarding to event-log entries.
    internals.workflowVersionTuples.set(workflowId, versionTuple);

    // Build the create batch (folding in the id-dependent idempotency mapping /
    // signal, and prepending any restart purge deletes) and commit it, gated on
    // any idempotency preconditions. Throws StartIdempotencyRaceLostError when a
    // concurrent same-key caller won the CAS, which the `finally` rollback below
    // unwinds for the wrapper to handle.
    await buildAndCommitStartBatch(
      {
        internals,
        workflowId,
        state,
        checkpoint,
        registration,
        options,
        delayedStartTimer,
        persistedWorkflowStartHeaders,
        additionalStartOperations,
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
      buildIdempotentStartOperations,
    );

    // Hold the non-serialized per-run services in engine memory so the inline
    // Context can read them. The services value is never written to storage — it
    // bypasses every durable record. A presence-only "expects services" marker IS
    // written atomically in the start batch (see buildStartBatchOperations) so a
    // fresh-process recovery knows to re-provide them. Cleared on terminal cleanup
    // (and on rollback below).
    //
    // Joining `workflowsNeedingTerminalCleanup` mirrors `setWorkflowStartHeaders`:
    // it is what makes `completeWorkflow` schedule the deferred durable cleanup
    // that sweeps the marker. The start batch wrote the matching
    // `terminalCleanupNeeded` key so recovery re-derives this membership.
    if (options?.services !== undefined) {
      internals.workflowServices.set(workflowId, options.services);
      internals.workflowsNeedingTerminalCleanup.add(workflowId);
    }
    if (workflowConcurrency !== undefined) {
      internals.workflowsNeedingTerminalCleanup.add(workflowId);
    }

    const handle = createWorkflowHandle(internals, workflowId, callbacks);
    await beginExecutionAwaitingLiveness(
      internals,
      {
        type,
        input,
        checkpoint,
        state,
        registration,
        options,
        isDelayed: Boolean(delayedStartTimer),
      },
      workflowId,
      callbacks,
    );
    startSucceeded = true;
    return handle;
  } finally {
    internals.pendingStarts.delete(workflowId);
    releaseInFlightStart(internals, type, inFlightRevision);
    if (!startSucceeded) {
      rollbackTransientStartState(internals, workflowId);
    }
  }
}

export function resolveScheduledStartAt(
  internals: EngineInternals,
  options: StartOptions | undefined,
  submissionTime: number,
  callbacks: LifecycleCallbacks,
): number | undefined {
  assertExclusiveStartWorkflowOptions(options?.startAt, options?.startAfter);

  if (options?.startAt !== undefined) {
    return coerceStartWorkflowTimestamp(options.startAt, 'options.startAt');
  }

  if (options?.startAfter !== undefined) {
    const startAfterMilliseconds = parseStartOptionDuration(
      internals,
      options.startAfter,
      'options.startAfter',
      callbacks,
    );
    try {
      return normalizeStorageTimestamp(
        submissionTime + startAfterMilliseconds,
        'options.startAfter',
      );
    } catch {
      throw new StartWorkflowValidationError(
        'options.startAfter must resolve to a finite, non-negative start time',
      );
    }
  }

  return undefined;
}
