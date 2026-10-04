import type { Checkpoint, StartOptions } from '../../types.ts';
import { adoptLaunchCheckpoint, releaseLaunchCheckpoint } from '../checkpoint-commit-snapshots.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * What one start or prepare installs in memory for its workflow id, and how to undo it.
 *
 * Until `adopt` has run, the start has installed nothing of its own, so whatever the
 * engine holds under the id belongs to a live run: its execution attempt, checkpoint,
 * committed bytes, headers, version tuple, services, and terminal-cleanup membership.
 * A start rejected that early (a duplicate id, an unregistered type, an oversized input)
 * must leave all of it alone, and `rollback` does nothing then. After `adopt`, the
 * checkpoint under the id is this start's, and `rollback` removes everything a failed
 * launch left behind.
 *
 * The launch that adopts the id is the only writer of a run's per-run transient state, and
 * `adopt` installs it ({@link installRunTransientState}) in the same synchronous step that
 * installs the checkpoint, so the run is a member of terminal cleanup, and holds its services,
 * for as long as it holds the id. The create batch that follows is awaited, and a cancel or
 * timeout that lands while it commits decides whether the run owes the durable cleanup timer by
 * reading that membership. `rollback` removes exactly what `adopt` installed, so a caller that
 * hands a start state of its own (a scheduled occurrence) leaves nothing in memory for a rejected
 * start to take back, or for another launch to inherit.
 */
export type LaunchAdoption = {
  /**
   * Install `checkpoint` as the launch checkpoint of this start, prime its committed bytes, and
   * install the run's per-run transient state from `run`.
   */
  adopt(checkpoint: Checkpoint, serialized: Uint8Array, run: RunTransientStateSources): void;
  /** Undo what `adopt` installed; a no-op for a start that has not adopted a checkpoint. */
  rollback(): void;
};

export function createLaunchAdoption(
  internals: EngineInternals,
  workflowId: string,
): LaunchAdoption {
  let adopted = false;
  return {
    adopt(checkpoint, serialized, run) {
      adoptLaunchCheckpoint(internals, workflowId, checkpoint, serialized);
      adopted = true;
      installRunTransientState(internals, workflowId, run);
    },
    rollback() {
      if (!adopted) return;
      releaseLaunchCheckpoint(internals, workflowId);
      internals.workflowHeaders.delete(workflowId);
      internals.workflowVersionTuples.delete(workflowId);
      internals.workflowServices.delete(workflowId);
      internals.workflowsNeedingTerminalCleanup.delete(workflowId);
    },
  };
}

/**
 * Per-run state a caller that already holds it hands `startWorkflow` to install for the run it
 * starts. Internal only: it arrives as a positional argument that `Engine.start`, `Engine.prepare`
 * and the entry points built on them never pass, and no start option names it.
 *
 * A scheduled occurrence is the one caller. It resolves the run's services before it starts, and
 * every scheduled run writes `schedule-run` metadata that only the deferred terminal cleanup
 * sweeps, so the run must join terminal cleanup whether or not it has services. The start batch
 * is unchanged by either field: the occurrence's own batch operations carry the durable markers,
 * which is why the services travel here and not in `options.services`, whose presence makes the
 * batch write the markers a second time.
 */
export type StartTransientState = {
  /** Join terminal cleanup even when the run has no services. */
  readonly joinTerminalCleanup?: boolean;
  /**
   * The run's `ctx.services`, held in memory exactly as `options.services` is. Wrapped so a
   * resolved value that is itself `undefined` is still installed.
   */
  readonly services?: { readonly value: unknown };
};

/** What {@link installRunTransientState} installs a run's services and cleanup membership from. */
export type RunTransientStateSources = {
  /** The start's options: `options.services` is the run's `ctx.services`. */
  readonly options: StartOptions | undefined;
  /** Whether the run's type limits workflow concurrency, a slot that only terminal cleanup releases. */
  readonly limitsConcurrency: boolean;
  /** State a caller that resolved the run's services ahead of the start handed over. */
  readonly transientState?: StartTransientState | undefined;
};

/**
 * Install the per-run state a start holds in memory, at the moment the launch adopts its id: the
 * non-serializable `services` the inline context reads, and the membership in
 * `workflowsNeedingTerminalCleanup` that makes terminalization schedule the deferred durable
 * cleanup that sweeps the run's scratch. Services imply the membership, because the start batch
 * writes the services marker, which only that cleanup sweeps.
 *
 * It runs at adoption and not once the create batch has committed because the batch is awaited:
 * a cancel or timeout that lands while it commits reads the membership synchronously to decide
 * whether to mint the cleanup token and timer, and a run that joined only after the commit would
 * be terminalized without them.
 *
 * This is the single place a start installs either entry, reached through
 * {@link LaunchAdoption.adopt} for `startWorkflow` and `prepareWorkflow` alike, and it is
 * synchronous: it adds no await to a launch path.
 *
 * A disposed engine installs nothing, as `adoptLaunchCheckpoint` adopts nothing: a start can be
 * awaiting its registration or its terminal-conflict read when the engine is disposed, and
 * disposal has by then released the services the engine holds so that a credential-bearing
 * closure is not stranded past it. Installing after that would hold the run's services, and its
 * cleanup membership, on an engine that has already let go of everything. A launch that adopted
 * before the engine was disposed has its services released by disposal, which does not clear the
 * membership, as for any run the engine held.
 */
export function installRunTransientState(
  internals: EngineInternals,
  workflowId: string,
  run: RunTransientStateSources,
): void {
  if (internals.disposed) return;
  const services =
    run.options?.services !== undefined
      ? { value: run.options.services }
      : run.transientState?.services;
  if (services !== undefined) {
    internals.workflowServices.set(workflowId, services.value);
  }
  if (
    services !== undefined ||
    run.limitsConcurrency ||
    run.transientState?.joinTerminalCleanup === true
  ) {
    internals.workflowsNeedingTerminalCleanup.add(workflowId);
  }
}
