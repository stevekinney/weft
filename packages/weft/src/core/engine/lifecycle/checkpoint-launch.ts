/**
 * Launch a workflow run from an already-built `WorkflowState`/`Checkpoint`
 * pair — the shared tail `fork()` (`transition.ts`) drives after planting a
 * new run's durable records. Split out of `transition.ts`, which has no
 * headroom under the repository's 500-line implementation-file ceiling for
 * this logic inline.
 *
 * @module core/engine/lifecycle/checkpoint-launch
 */

import { serializeCheckpoint } from '../../checkpoint.ts';
import { Context, setContextWorkflowInterceptor } from '../../context.ts';
import { WorkflowStartedEvent } from '../../events.ts';
import type { Checkpoint, WorkflowState } from '../../types.ts';
import { createCancelHandlerRegistration, resetCancelHandlers } from '../cancel-handlers.ts';
import { rememberCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { getWorkflowExecutionStartedAt, type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { getComposedWorkflowInterceptor } from '../strategy-helpers.ts';
import { createWorkflowVersionTuple } from './persist.ts';
import { createWorkflowHandle, type LifecycleCallbacks, type RegistrationEntry } from './shared.ts';

function launchInlineWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): void {
  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('Inline workflow launch requested without an inline strategy.');
  }

  const accumulatedResults = new Map<number, unknown>(checkpoint.accumulatedResults);
  const workflowAbort = new AbortController();

  resetCancelHandlers(internals, workflowId);
  const context = new Context({
    workflowId,
    ...(state.workflowExecutionToken !== undefined && {
      workflowExecutionToken: state.workflowExecutionToken,
    }),
    workflowType: state.type,
    startedAt: getWorkflowExecutionStartedAt(state),
    abortController: workflowAbort,
    getNow: internals.options.getNow,
    resolveWorkflowType: callbacks.resolveWorkflowTypeTarget,
    executionStateOwnerId: state.executionStateOwnerId ?? workflowId,
    accumulatedResults,
    searchAttributes: checkpoint.searchAttributes,
    registerCancelHandler: createCancelHandlerRegistration(internals, workflowId),
    ...(registration.searchAttributes && {
      searchAttributeSchema: registration.searchAttributes,
    }),
    sleepReferenceTime: checkpoint.createdAt,
    ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
    // Carry the host `ctx.log` sink onto the checkpoint-launched context, mirroring the
    // fresh-start and resume paths. This path runs for forked / launch-from-checkpoint
    // runs; without the sink, a log at the forked run's live frontier (and any
    // speculative child it parents) reaches the console but never `EngineOptions.onLog`.
    // Construction normalizes a missing `onLog` to `null`; use loose `!= null` so the
    // narrowed type drops both `null` and the option's declared `undefined`, keeping
    // `logSink` assignable under `exactOptionalPropertyTypes` (build's stricter tsc) (#549).
    ...(internals.options.onLog != null && { logSink: internals.options.onLog }),
  });
  setContextWorkflowInterceptor(context, getComposedWorkflowInterceptor(internals));

  if (internals.options.development) {
    context.explain(true);
  }

  const generator = registration.handler(context, state.input);
  inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);
  inlineStrategy.continueWorkflow(workflowId, undefined);
  void callbacks.swallowPromiseRejection(
    callbacks.processPendingUpdatesAfterInlineAdvance(workflowId),
  );
}

function launchWorkerWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
): void {
  const serialized = serializeCheckpoint(checkpoint);
  internals.strategy.startWorkflow({
    workflowId,
    ...(state.workflowExecutionToken !== undefined && {
      workflowExecutionToken: state.workflowExecutionToken,
    }),
    workflowType: state.type,
    input: state.input,
    checkpoint: serialized,
    executionStateOwnerId: state.executionStateOwnerId ?? workflowId,
    ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
    ...(internals.workflowHeaders.has(workflowId) && {
      headers: [...internals.workflowHeaders.get(workflowId)!],
    }),
  });
}

export function launchWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  /**
   * The EXACT revision `registration` was resolved against — from the same
   * `resolveExecutableRegistrationForRevision()` call that produced
   * `registration`, threaded through explicitly rather than re-read off
   * `state.revision` (WFT-19 review round 5, Codex, mirroring the identical
   * fix in `lifecycle/resume.ts`). `fork()`'s own `forkState.revision` is
   * now stamped with this same resolved value too (WFT-19 review round 6,
   * Codex — `createForkedWorkflowState()`'s matching fix, so a legacy
   * fork's durable pin agrees with this in-memory one), so `state.revision`
   * and `resolvedRevision` coincide for every current caller; kept as an
   * explicit parameter regardless, since this function's identity-cache
   * write must never depend on that invariant holding at a future call
   * site.
   */
  resolvedRevision: string | undefined,
  callbacks: LifecycleCallbacks,
): WorkflowHandle {
  // Cache the launched run's own exact (type, revision) pin for synchronous
  // per-instance registry lookup on the dispatch hot path (WFT-19), BEFORE
  // either checkpoint-launch strategy below can drive the generator's first
  // turn — a fork/launch-from-checkpoint run is a fresh live instance the
  // same as a start/resume/recovery launch, and a string-named scoped
  // activity dispatched on its first turn needs this populated already.
  // Cleared on terminal cleanup (see termination/cleanup.ts).
  internals.workflowTypeByWorkflowId.set(workflowId, {
    type: state.type,
    revision: resolvedRevision,
  });
  // Store checkpoint for future persistence
  internals.checkpoints.set(workflowId, checkpoint);
  // Prime the checkpoint-bytes CAS baseline (WFT-21, Codex review round 10,
  // P1) — `fork()` is this function's only caller, and its own initial
  // checkpoint commit already landed durably before this launch runs (see
  // `transition.ts`'s `commitFencedEngineWrite` call above), so the bytes
  // this in-memory record is set to here ARE the committed bytes. Without
  // this, `start.ts`'s own round-5 fix (`rememberCommittedCheckpointBytes`
  // at launch, mirroring `resume.ts`) was never extended to this THIRD
  // launch path: a worker-mode fork's first checkpoint commit had no
  // `expectedSerialized` baseline, so a yield inside that commit (e.g.
  // event-log compaction reading storage) left a window where a concurrent
  // cancel + `start-new` replacement of the same workflow id could land its
  // own fresh generation, and the stale fork's unfenced commit could then
  // overwrite the replacement's checkpoint and history — the exact class of
  // race the round-5 `start.ts` fix exists to close, missed here because
  // this function's single caller was never audited alongside `start()` and
  // `resume()` when that fix was made.
  rememberCommittedCheckpointBytes(internals, workflowId, serializeCheckpoint(checkpoint));
  internals.workflowVersionTuples.set(
    workflowId,
    createWorkflowVersionTuple(internals, registration, callbacks),
  );

  const handle = createWorkflowHandle(internals, workflowId, callbacks);
  callbacks.dispatchEvent(new WorkflowStartedEvent(workflowId, state.type, state.input));

  if (internals.inlineStrategy) {
    launchInlineWorkflowFromCheckpoint(
      internals,
      workflowId,
      state,
      checkpoint,
      registration,
      callbacks,
    );
  } else {
    launchWorkerWorkflowFromCheckpoint(internals, workflowId, state, checkpoint);
  }

  return handle;
}
