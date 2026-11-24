// ---------------------------------------------------------------------------
// Workflow identity
// ---------------------------------------------------------------------------

/**
 * Opaque string identifier for a workflow instance. Generated automatically
 * by the engine at start time, or supplied via {@link StartOptions.id}. Pass
 * to {@link Engine.getHandle} or {@link Engine.get} to look up a running or
 * completed workflow.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type WorkflowId } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 *
 * const handle = await engine.start('ping', null);
 * const id: WorkflowId = handle.id;
 * const state = await engine.get(id);
 * console.log(state?.status); // 'completed'
 * ```
 */
export type WorkflowId = string;

export type OperationId = string;

// ---------------------------------------------------------------------------
// Failure category — populated on all failed workflows
// ---------------------------------------------------------------------------

/**
 * Classifies why a workflow failed. Populated automatically by the engine on
 * failure so operators can query e.g. "all timeout failures in the last hour"
 * via `engine.list({ attributes: [{ key: 'failureCategory', value: 'timeout' }] })`.
 *
 * - `'application'` — workflow or activity application code threw
 * - `'timeout'` — execution exceeded a configured deadline
 * - `'cancellation'` — cancellation or abort ended execution
 * - `'resource'` — quota, memory, disk, or capacity limit was exceeded
 * - `'system'` — engine, storage, or worker infrastructure fault
 *
 * @example
 * ```ts
 * import { Engine, type FailureCategory } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * // Query all workflows that failed due to a timeout:
 * const results = await engine.list({
 *   status: 'failed',
 *   attributes: [{ key: 'failureCategory', value: 'timeout' as FailureCategory }],
 * });
 * void results;
 * ```
 */
export type FailureCategory = 'application' | 'timeout' | 'cancellation' | 'resource' | 'system';

// ---------------------------------------------------------------------------
// Workflow status state machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle states a workflow moves through, from registration to terminal
 * state.
 *
 * Read this off `(await handle.state()).status` to learn whether a workflow
 * is still running, finished cleanly, or failed. Pass it to `engine.list()`
 * filters to scope queries by status.
 *
 * `'suspended'` is a non-terminal, non-running pause: a workflow that was
 * explicitly suspended via {@link WorkflowHandle.suspend} (or
 * `engine.suspend(id)`) keeps its checkpoint and is resumable via
 * {@link WorkflowHandle.resume} (or `engine.resume(id)`), but is NOT
 * auto-recovered by `engine.recoverAll()` — suspension is client-driven
 * preemption, not a fault condition.
 */
export type WorkflowStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'suspended';

/** Atomic outcome of a workflow cancellation request. */
export type CancelWorkflowResult =
  | { readonly workflowId: string; readonly status: 'cancel-requested' }
  | {
      readonly workflowId: string;
      readonly status: 'already-terminal';
      readonly terminalStatus: Extract<
        WorkflowStatus,
        'completed' | 'failed' | 'cancelled' | 'timed-out'
      >;
    };

/**
 * What `engine.previewCancel(workflowId)` reports, and `weft.workflows.cancel` with `dryRun: true`
 * answers: the run's current `status` and whether a cancel would take effect (`cancellable`: the
 * run is `pending`, `running` or `suspended`). Nothing was written; a run that is already terminal
 * reports `cancellable: false` with its terminal status.
 */
export type CancelWorkflowDryRunResult = {
  readonly dryRun: true;
  readonly workflowId: string;
  readonly status: WorkflowStatus;
  readonly cancellable: boolean;
};

/**
 * Outcome of `engine.retryFailed(workflowId)`: one failed run resumed in place from its checkpoint,
 * or why it was not. `retried` means the run is `running` again on the revision it is pinned to,
 * with every operation its checkpoint holds replayed from that checkpoint and never run again.
 * `not-failed` is a run in any other status (`currentStatus`), `no-checkpoint` a failed run with
 * no checkpoint to resume from (it failed before its first one, or the checkpoint is gone), and
 * `not-found` an id the engine has no run for. Only `retried` changed anything.
 *
 * @example
 * ```ts
 * import type { RetryFailedWorkflowResult } from '@lostgradient/weft';
 *
 * function said(result: RetryFailedWorkflowResult): string {
 *   return result.status === 'retried' ? `${result.workflowId} is running again` : result.status;
 * }
 * void said;
 * ```
 */
export type RetryFailedWorkflowResult =
  | { readonly workflowId: string; readonly status: 'retried' }
  | {
      readonly workflowId: string;
      readonly status: 'not-failed';
      readonly currentStatus: WorkflowStatus;
    }
  | { readonly workflowId: string; readonly status: 'no-checkpoint' }
  | { readonly workflowId: string; readonly status: 'not-found' };

/**
 * Lineage metadata recorded when a workflow was created by forking another
 * workflow at a checkpoint boundary. Absent on workflows started normally via
 * {@link Engine.start}. Available on {@link WorkflowState.forkedFrom}.
 */
export interface ForkLineage {
  workflowId: WorkflowId;
  step: number;
  /**
   * The {@link WorkflowState.workflowExecutionToken} of the source run when it was forked. A stable
   * id reused with `onTerminalConflict: 'start-new'` keeps the id and replaces the run, so
   * `engine.compare` reads the source only while the run stored under `workflowId` is this one.
   * Absent on a fork made before the field existed, and when the source had no token.
   */
  workflowExecutionToken?: string;
}
