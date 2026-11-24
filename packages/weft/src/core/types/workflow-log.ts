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
 * fields (`level`, `message`, `workflowId`, `workflowType`, `timestamp`, `step`) are
 * engine-owned; caller `attributes` nest under their own key so they can never shadow
 * an envelope field. `timestamp` is wall-clock ms at emit — observability metadata,
 * never checkpointed or replayed. Weft retains nothing by itself: a host that wants
 * history persists the records it receives through `EngineOptions.onLog` in its
 * logging system, or hands the engine a `createWorkflowLogStore` store, which writes
 * them with the run and serves them through `Engine.getLogs` and the
 * `weft.workflows.logs.list` operation.
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
  /**
   * The index of the durable step the workflow body was about to run when it logged: the
   * number of durable operations it had completed or replayed so far. The engine sets it on
   * every record it emits, inline and worker-forwarded; a record a host builds itself may
   * omit it.
   */
  readonly step?: number;
  /**
   * True when the run was continued from a park (a signal, a review, a timer) or a recovery and
   * this call sits in front of the operation it was parked on, and the run's checkpoint shows its
   * earlier execution reached that operation: the call was already logged, so this record repeats
   * a line that was delivered before. A run recovered before it took its first turn never carries
   * the mark, because nothing was logged before; without that evidence a line is delivered unmarked,
   * and a duplicate is preferred to a lost line. The engine
   * delivers it all the same, because a host may rely on seeing the call again (the human-wait
   * park marker does); a host that keeps one entry per call, as the persisted log store does,
   * skips it. Absent on every other record.
   */
  readonly replayed?: boolean;
  readonly attributes?: Record<string, unknown>;
}

/**
 * The structured logger exposed as `WorkflowContext.log`. Each method emits
 * a {@link WorkflowLogRecord} to the current process console (`console.debug` /
 * `console.info` / `console.warn` / `console.error`) with `workflowId`,
 * `workflowType`, `level`, and `timestamp` auto-attached. Caller-supplied
 * `attributes` are nested under their own key and cannot overwrite the envelope.
 *
 * Replay behavior: a workflow body re-executes from the start on recovery, or
 * when a parked run (a signal, a review, a timer) continues, to rebuild state.
 * Log calls in the already-committed replay window are suppressed, so a
 * continued run does not re-emit logs it already emitted: a log call sitting at
 * a step the engine has already cached is silenced. The operation the run was
 * parked on is not cached, so the log calls in front of it are delivered again
 * (`ctx.log('before wait'); yield* ctx.waitForSignal('go')` reaches the sink on
 * the first run and again on resume), marked {@link WorkflowLogRecord.replayed}.
 * The persisted log store skips a marked record, so a line is stored once; a
 * host `onLog` sink that wants one entry per call does the same. A log call past
 * the parked operation is new work and carries no mark. This holds in both inline
 * and worker execution modes.
 *
 * One replay caveat. A log call that runs after an operation completed and before
 * the next operation yields is logged again, unmarked, if the run crashes in that
 * window (the checkpoint that would record the operation's result is written at
 * the next yield, so recovery re-enters that operation and runs the log call
 * again). Logs inside `ctx.all` / `ctx.runAll` branches follow that branch's
 * re-execution semantics.
 *
 * A host sink installed via `EngineOptions.onLog` receives records from BOTH execution
 * modes: inline records directly, and worker-mode records forwarded from the worker
 * back to the host. When no sink is installed, worker-mode records go to the worker
 * process console (and inline records to the engine-host console). Inline log
 * timestamps come from the engine clock; worker-mode timestamps come from the worker
 * process wall clock.
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
