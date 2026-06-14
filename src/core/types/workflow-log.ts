/**
 * The `ctx.log` structured-logging surface: the {@link WorkflowLogger} exposed on
 * the workflow context, the {@link WorkflowLogRecord} envelope it emits, and the
 * {@link WorkflowLogLevel} severity. Split out from `workflow-context.ts` so the
 * context module stays under the line cap and the log types can be re-exported as
 * a cohesive cluster.
 *
 * @module core/types/workflow-log
 */

/**
 * Severity of a {@link WorkflowLogRecord}, ordered `debug < info < warn < error`.
 *
 * @example
 * ```ts
 * import type { WorkflowLogLevel } from '@lostgradient/weft';
 * const isError = (level: WorkflowLogLevel) => level === 'error';
 * ```
 */
export type WorkflowLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The structured record a {@link WorkflowLogger} emits for one log call. Envelope
 * fields (`level`, `message`, `workflowId`, `workflowType`, `timestamp`) are
 * engine-owned and always present; caller `attributes` nest under their own key so
 * they can never shadow an envelope field. `timestamp` is wall-clock ms at emit —
 * observability metadata, never checkpointed or replayed. Type a host sink
 * installed via `EngineOptions.onLog` with this record.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowLogRecord } from '@lostgradient/weft';
 * const engine = new Engine({ onLog: (r: WorkflowLogRecord) => console.log(r.level, r.message) });
 * ```
 */
export interface WorkflowLogRecord {
  readonly level: WorkflowLogLevel;
  readonly message: string;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly timestamp: number;
  readonly attributes?: Record<string, unknown>;
}

/**
 * The structured logger exposed as `WorkflowContext.log`. Each method emits
 * a {@link WorkflowLogRecord} to the current process console (`console.debug` /
 * `console.info` / `console.warn` / `console.error`) with `workflowId`,
 * `workflowType`, `level`, and `timestamp` auto-attached. Caller-supplied
 * `attributes` are nested under their own key and cannot overwrite the envelope.
 *
 * Replay behavior: a workflow body re-executes from the start on recovery to
 * rebuild state. Log calls in the already-committed replay window are suppressed,
 * so a recovered run does not re-emit logs it already emitted. Suppression is
 * per-position: a log call sitting at a step the engine has already cached is
 * silenced; a log call at the live frontier emits. This holds in both inline and
 * worker execution modes.
 *
 * Two replay caveats. A log placed *after* the last committed step re-fires on
 * recovery, because there is no cached step to suppress it (the same caveat
 * Temporal's workflow logger carries); likewise a workflow with no committed
 * durable step has no replay position to suppress against, so its logs may
 * re-emit on recovery. Logs inside `ctx.all` / `ctx.runAll` branches follow that
 * branch's re-execution semantics.
 *
 * In worker-pool mode, "the current process console" is the worker process, not
 * the engine host. Inline log timestamps come from the engine clock; worker-mode
 * timestamps come from the worker process wall clock. A host sink installed via
 * `EngineOptions.onLog` receives inline records; host-side collection of
 * worker-mode logs is tracked in #529.
 *
 * Exported so a host can also type a logger it injects through `ctx.services`
 * (the pre-`ctx.log` pattern).
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowContext, type WorkflowLogger } from '@lostgradient/weft';
 *
 * const myWorkflow = workflow({ name: 'my-workflow' }).execute(async function* (
 *   ctx: WorkflowContext,
 * ) {
 *   ctx.log?.info('workflow started', { attempt: 1 });
 *   ctx.log?.warn('retrying activity', { reason: 'timeout' });
 *   // A host logger injected through `ctx.services` can reuse this type:
 *   const { log } = (ctx.services ?? {}) as { log?: WorkflowLogger };
 *   log?.error('activity failed', { error: 'ECONNREFUSED' });
 * });
 * void myWorkflow;
 * ```
 */
export interface WorkflowLogger {
  /** Emit a `debug` record. Auto-carries `workflowId`/`workflowType`; suppressed during replay. */
  debug(message: string, attributes?: Record<string, unknown>): void;
  /** Emit an `info` record. Auto-carries `workflowId`/`workflowType`; suppressed during replay. */
  info(message: string, attributes?: Record<string, unknown>): void;
  /** Emit a `warn` record. Auto-carries `workflowId`/`workflowType`; suppressed during replay. */
  warn(message: string, attributes?: Record<string, unknown>): void;
  /** Emit an `error` record. Auto-carries `workflowId`/`workflowType`; suppressed during replay. */
  error(message: string, attributes?: Record<string, unknown>): void;
}
