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
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'suspended';
