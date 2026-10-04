import { WeftError } from '../weft-error.ts';

/**
 * `name` of the operator warning emitted when a workflow's checkpoint commit
 * loses its compare-and-swap race against a newer checkpoint written by
 * another engine over the same store, and this engine therefore stops driving
 * that workflow. Unlike {@link EngineDeposedError}, no ownership claim is
 * involved: `ownership: 'none'` has none, so the lost write is the only
 * evidence that a second engine advanced the same workflow.
 *
 * @example
 * ```ts
 * import { WORKFLOW_CHECKPOINT_CONFLICT_WARNING_NAME } from '@lostgradient/weft';
 *
 * process.on('warning', (warning) => {
 *   if (warning.name === WORKFLOW_CHECKPOINT_CONFLICT_WARNING_NAME) {
 *     console.error('another engine advanced a workflow this one was driving', warning.message);
 *   }
 * });
 * ```
 */
export const WORKFLOW_CHECKPOINT_CONFLICT_WARNING_NAME = 'WeftWorkflowCheckpointConflictWarning';

/**
 * Operator diagnostic for a workflow this engine stopped driving because its
 * checkpoint commit lost a compare-and-swap race (see
 * {@link WorkflowCheckpointConflictError}). Carries the affected `workflowId` as
 * a real field — emitted as the warning object itself, like
 * {@link WeftWorkflowClaimLostWarning}, so consumers read `warning.workflowId`
 * instead of parsing the message.
 *
 * @example
 * ```ts
 * import { WeftWorkflowCheckpointConflictWarning } from '@lostgradient/weft';
 *
 * process.on('warning', (warning) => {
 *   if (warning instanceof WeftWorkflowCheckpointConflictWarning) {
 *     console.error('stopped driving workflow:', warning.workflowId);
 *   }
 * });
 * ```
 */
export class WeftWorkflowCheckpointConflictWarning extends Error {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(
      `workflow "${workflowId}" lost a checkpoint compare-and-swap race: another writer advanced its ` +
        'checkpoint over the same store. This engine stops driving that workflow and writes nothing ' +
        'further; the rest of its workflows are unaffected.',
    );
    this.name = WORKFLOW_CHECKPOINT_CONFLICT_WARNING_NAME;
    this.workflowId = workflowId;
  }
}

/**
 * Thrown when a workflow's checkpoint commit loses its compare-and-swap race
 * against a newer checkpoint that another writer over the same store already
 * wrote — typically a second live engine driving the same durable workflow. Weft
 * supports one engine per store without an ownership mode, so the engine that
 * loses stops driving the workflow rather than overwriting the winner's
 * progress; it writes nothing durable on the way out, because the winning
 * engine owns the workflow's checkpoint, terminal state, and record.
 *
 * `handle.result()` on the losing engine rejects with this error, including a
 * call made after the loss, for as long as this engine still holds the lost
 * generation. A parent workflow on the losing engine that was awaiting a child
 * this engine abandoned never receives a failure for it: the engine that won the
 * child drives the parent too. The loser writes nothing durable and releases
 * nothing locally, and it does not recover on its own: recovering the workflow on
 * the losing engine means re-resuming it from the winner's checkpoint, which this
 * error does not do for you. `ownership: 'workflow-lease'` is the complete
 * answer for two live engines over one store.
 *
 * The loss is scoped to the generation that lost, identified by its
 * `workflowExecutionToken`. If this engine launches that same generation again
 * (`engine.resume()`), the loss no longer applies; the handle `resume()` returns
 * (or a later `engine.getHandle()`) observes the resumed run, while a handle
 * whose `result()` already rejected keeps that outcome.
 *
 * @example
 * ```ts
 * import { WorkflowCheckpointConflictError } from '@lostgradient/weft';
 *
 * function lostToAnotherEngine(error: unknown): boolean {
 *   return error instanceof WorkflowCheckpointConflictError;
 * }
 * ```
 */
export class WorkflowCheckpointConflictError extends WeftError<'WorkflowCheckpointConflictError'> {
  readonly workflowId: string;
  /**
   * The durable execution token of the run whose checkpoint commit lost, captured
   * from the commit itself before the loss was classified. It scopes the loss to
   * that generation: a replacement run installed under the same workflow id while
   * the loss was being classified is not the loser.
   */
  readonly workflowExecutionToken: string | undefined;

  constructor(
    workflowId: string,
    options?: ErrorOptions & { readonly workflowExecutionToken?: string | undefined },
  ) {
    super(
      'WorkflowCheckpointConflictError',
      `Checkpoint commit for workflow "${workflowId}" lost its CAS race against a newer checkpoint: ` +
        'another writer over the same store advanced this workflow. This engine stops driving it ' +
        'and writes nothing further; the winning writer owns its durable state.',
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.workflowId = workflowId;
    this.workflowExecutionToken = options?.workflowExecutionToken;
  }
}

/** Whether `error` reports a lost checkpoint race for exactly this workflow. */
export function isCheckpointConflictFor(error: unknown, workflowId: string): boolean {
  return error instanceof WorkflowCheckpointConflictError && error.workflowId === workflowId;
}
