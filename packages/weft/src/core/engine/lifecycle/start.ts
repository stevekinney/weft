import type { BatchOperation } from '../../../storage/interface.ts';
import { assertPayloadWithinLimit } from '../../payload-size.ts';
import { normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  StartWorkflowValidationError,
  assertExclusiveStartWorkflowOptions,
  assertValidOnTerminalConflict,
  coerceStartWorkflowId,
  coerceStartWorkflowTimestamp,
} from '../../start-workflow-validation.ts';
import type { StartOptions, StartWorkflowOptions, TimerEntry } from '../../types.ts';
import { ensureWorkflowCatalogReady } from '../catalog-readiness.ts';
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
import { selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { buildWorkflowConcurrencyStartOperations } from '../workflow-concurrency.ts';
import { createWorkflowVersionTuple } from './persist.ts';
import {
  createWorkflowHandle,
  normalizeStartWorkflowTags,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
} from './shared.ts';
import { buildAndCommitStartBatch, type BuildIdempotentStartOperations } from './start-commit.ts';
import {
  assertDeferSupported,
  beginExecutionAwaitingLiveness,
  runWorkflowStartInterceptor,
} from './start-exec.ts';
import {
  applyRestartLineage,
  createInitialCheckpoint,
  createInitialWorkflowState,
  parseStartOptionDuration,
} from './start-state.ts';
import {
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
): StartWorkflowPreparation {
  const callerProvidedId = options?.id !== undefined;
  const workflowId =
    options?.id !== undefined
      ? coerceStartWorkflowId(options.id, 'options.id')
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
 * The exact executable artifact this run is about to run: the resolved
 * dynamic-source candidate revision, or — for an eager registration, which
 * never populates `resolvedRevision` — this process's own
 * `registeredCatalogRevisions` entry for `type` (the revision of the code
 * actually loaded here, NOT `inFlightRevision`, which for an eager type
 * falls back to the catalog's cached ACTIVE pointer and can name a revision
 * this process never loaded under a multi-engine deployment). Synchronous,
 * on purpose: every top-level engine.* method already awaits
 * `ensureWorkflowCatalogReady()` before reaching `startWorkflow`, so this
 * map is populated by the time the overwhelmingly common case gets here.
 * `await`ing an async function always costs a microtask tick even when its
 * own body takes a fast path (the same reason `isWorkflowCatalogReady()` is
 * its own sync check in `catalog-readiness.ts`) — a plain sync lookup here
 * keeps `startWorkflow`'s interleaving with concurrent callers unchanged
 * from before this field existed. `undefined` means "genuinely not cached
 * yet"; the caller falls back to {@link resolveStartRevisionUncached}.
 */
function resolveCachedStartRevision(
  internals: EngineInternals,
  type: string,
  resolvedRevision: string | undefined,
): string | undefined {
  return resolvedRevision ?? internals.registeredCatalogRevisions.get(type);
}

/**
 * The rare fallback {@link resolveCachedStartRevision} defers to: a fired
 * schedule occurrence or a delayed-start timer calls `startWorkflow`
 * directly from background scheduler code, with no top-level
 * `ensureWorkflowCatalogReady()` gate already awaited. Re-checks catalog
 * readiness once, then re-reads the cache.
 */
async function resolveStartRevisionUncached(
  internals: EngineInternals,
  type: string,
): Promise<string> {
  await ensureWorkflowCatalogReady(internals.engine as unknown as Engine);
  const afterReadiness = internals.registeredCatalogRevisions.get(type);
  if (afterReadiness !== undefined) {
    return afterReadiness;
  }
  // Unreachable in practice: `type` resolved to a real `registration` at
  // this call's only call site, so it is either an eager registration
  // (which `ensureWorkflowCatalogReady()` always assigns a revision to) or
  // a resolved dynamic source (which always populates `resolvedRevision`,
  // handled entirely by {@link resolveCachedStartRevision} and never
  // reaching here). Fail loud rather than silently persisting a workflow
  // record with no revision identity.
  throw new Error(
    `Cannot start workflow "${type}": no catalog revision is registered for this ` +
      'eagerly-registered type, even after re-checking catalog readiness. This should be ' +
      'unreachable.',
  );
}

export async function startWorkflow(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartWorkflowOptions | undefined,
  additionalStartOperations: BatchOperation[] | undefined,
  callbacks: LifecycleCallbacks,
  buildIdempotentStartOperations?: BuildIdempotentStartOperations,
): Promise<WorkflowHandle> {
  assertServicesSupportedForMode(internals, options);
  assertValidOnTerminalConflict(options);

  // `prepareStartWorkflow`'s sync capture of pendingParent* MUST run before any
  // await, or a concurrent same-tick `ctx.startChild()` could overwrite it.
  const preparation = prepareStartWorkflow(internals, options, callbacks);
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
    } = await resolveAndReserveExecutableRegistration(
      internals,
      type,
      callbacks.resolveExecutableRegistration,
    );
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
    const { terminalRunToPurge, duplicateIdCondition } = callerProvidedId
      ? await resolveTerminalConflictForRestart(internals, workflowId, options)
      : GENERATED_ID_START_DECISION;

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
        ? await prepareTerminalRunPurge(internals, terminalRunToPurge, callbacks)
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
