import type { WorkflowLogger, WorkflowLogLevel, WorkflowLogRecord } from '../types/workflow-log.ts';
import type { ContextInternals } from './internals.ts';

/**
 * Runtime construction of the {@link WorkflowLogger} exposed as `ctx.log`. The
 * inline `Context` and the worker-side context share this one factory so the
 * record envelope and replay-suppression contract cannot drift between modes —
 * they differ only in how `isReplaying` is computed (inline reads
 * `internals.accumulatedResults?.has(internals.stepIndex)`; worker reads the
 * worker replay state) and where `workflowType` is sourced.
 *
 * @module core/context/workflow-logger
 */

/** The console method each level dispatches to. */
const CONSOLE_METHOD: Record<WorkflowLogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/**
 * Dispatch one record to the matching `console` method (`debug`/`info`/`warn`/`error`).
 * The single console-fallback primitive: the logger factory uses it when no sink is
 * installed or a sink throws, and the worker-log host-delivery path (#529) uses it when
 * the host `onLog` sink throws — so console-fallback behavior cannot drift between the
 * inline and worker-forwarded paths.
 */
export function logRecordToConsole(record: WorkflowLogRecord): void {
  console[CONSOLE_METHOD[record.level]](record);
}

/**
 * Inputs the logger needs at construction. The replay/clock probes (`isReplaying`,
 * `now`) are evaluated fresh per emit so they track the live frontier; the identity
 * fields (`workflowId`, `workflowType`) and the `sink` are fixed values.
 */
export interface WorkflowLoggerBindings {
  readonly workflowId: string;
  readonly workflowType: string;
  /**
   * Whether the current execution position is a replay of an already-committed
   * step. Evaluated lazily at each emit call so it reflects the live frontier.
   */
  isReplaying(): boolean;
  /** Wall-clock millisecond timestamp for the record (never checkpointed). */
  now(): number;
  /**
   * Optional host sink (`EngineOptions.onLog`). When provided, each non-replayed
   * record is routed here INSTEAD of the console — the host owns where logs go
   * (pino / winston / OpenTelemetry / etc.). When absent, records fall back to the
   * matching `console` method, preserving the default behavior. `onLog` is fixed at
   * engine construction (it has no public setter), so this is a captured value, not
   * a per-emit resolver.
   */
  readonly sink?: (record: WorkflowLogRecord) => void;
}

/**
 * Build the structured record for one log call. Envelope fields are owned by the
 * engine; caller `attributes` are nested under their own key so they can never
 * shadow `workflowId`/`workflowType`/`level`/`message`/`timestamp`.
 */
function buildLogRecord(
  bindings: WorkflowLoggerBindings,
  level: WorkflowLogLevel,
  message: string,
  attributes: Record<string, unknown> | undefined,
): WorkflowLogRecord {
  return {
    level,
    message,
    workflowId: bindings.workflowId,
    workflowType: bindings.workflowType,
    timestamp: bindings.now(),
    ...(attributes !== undefined && { attributes }),
  };
}

/**
 * Create a {@link WorkflowLogger} from the given bindings. Each method suppresses
 * emission when `bindings.isReplaying()` is true (so a recovered run does not
 * re-emit logs from the replayed prefix). A non-replayed record is routed to the
 * host sink (`bindings.sink`) when one is installed, and otherwise to the matching
 * `console` method — so a host that wires `EngineOptions.onLog` takes full control
 * of log routing without duplicate console noise, while the default stays console.
 *
 * A logger must never be able to crash the thing it is logging: if the host sink
 * throws (a serialization error, a transport failure, a bug in the callback — all
 * realistic for the pino / winston / OpenTelemetry integrations this targets), the
 * throw is swallowed and the record falls back to `console` so the workflow run is
 * not marked failed by a logging error.
 */
export function createWorkflowLogger(bindings: WorkflowLoggerBindings): WorkflowLogger {
  const emit = (
    level: WorkflowLogLevel,
    message: string,
    attributes: Record<string, unknown> | undefined,
  ): void => {
    if (bindings.isReplaying()) return;
    const record = buildLogRecord(bindings, level, message, attributes);
    if (bindings.sink !== undefined) {
      try {
        bindings.sink(record);
      } catch {
        logRecordToConsole(record);
      }
      return;
    }
    logRecordToConsole(record);
  };
  return {
    debug: (message, attributes) => emit('debug', message, attributes),
    info: (message, attributes) => emit('info', message, attributes),
    warn: (message, attributes) => emit('warn', message, attributes),
    error: (message, attributes) => emit('error', message, attributes),
  };
}

/**
 * Build the inline `ctx.log` logger for a {@link Context}. The replay probe reads
 * the RAW nullable `internals.accumulatedResults` field (not the allocating
 * `ctx.accumulatedResults` getter) and the live `internals.stepIndex` without
 * incrementing it — `ctx.log` consumes no durable position, the same step-neutral
 * peek `waitForSignal` makes. `getInternals` is read per emit so the probe tracks
 * the frontier as durable ops advance `stepIndex`. The `sink` is captured by value:
 * `EngineOptions.onLog` is fixed at engine construction, so it never changes for the
 * life of the context.
 */
export function createInlineWorkflowLogger(
  workflowId: string,
  workflowType: string,
  getInternals: () => Pick<ContextInternals, 'accumulatedResults' | 'stepIndex' | 'getNow'>,
  sink?: (record: WorkflowLogRecord) => void,
): WorkflowLogger {
  return createWorkflowLogger({
    workflowId,
    workflowType,
    isReplaying: () => {
      const internals = getInternals();
      return internals.accumulatedResults?.has(internals.stepIndex) ?? false;
    },
    now: () => getInternals().getNow(),
    ...(sink !== undefined && { sink }),
  });
}

/**
 * The slice of worker replay state the worker logger's replay probe reads. A step
 * being replayed is cached in `accumulatedResults` (it succeeded) OR in
 * `failedOutcomes` (it failed and the failure is replayed) — the logger must check
 * both, mirroring the runner's own `hasCachedWorkerOutcome`, or a log at a
 * replayed *failure* position would re-emit on recovery.
 */
export interface WorkerLoggerReplayState {
  readonly accumulatedResults: ReadonlyMap<number, unknown>;
  readonly failedOutcomes: ReadonlyMap<number, unknown>;
  readonly nextStepIndex: number;
}

/**
 * Build the worker-side `ctx.log` logger. Mirrors {@link createInlineWorkflowLogger}
 * through the shared factory; only the replay probe differs. `nextStepIndex` points
 * at the step the worker generator is about to run, so a cached outcome at that
 * index (success in `accumulatedResults` or failure in `failedOutcomes`) means the
 * step is replaying and its preceding log is suppressed; an uncached index is the
 * live frontier — the same per-position check the inline path makes (and the same
 * union the runner's own replay short-circuit uses). The state is read through
 * `getReplayState` (not captured by value) because the worker registers its replay
 * state *after* the context is built, so the closure must observe the live state at
 * emit time. Worker records use wall-clock `Date.now()` (the worker has no engine
 * clock); the timestamp is observability metadata only, never checkpointed.
 *
 * When the engine host installs an `EngineOptions.onLog` sink, the run/resume message
 * reports `hostHasLogSink: true` and the worker supplies a `forwardToHost` callback
 * here (#529): each non-replayed record is posted back to the host as a `log`
 * protocol message INSTEAD of the worker console, mirroring the inline sink. The
 * callback runs through the shared factory's `sink` slot, so its existing
 * throw-then-console fallback applies — if forwarding is impossible (an oversized or
 * non-cloneable record makes `postMessage` throw), the record falls back to the
 * worker console rather than failing the run. When no host sink exists, `forwardToHost`
 * is omitted and the worker logs to its own console, preserving the default and never
 * losing a log to a no-op host callback.
 */
export function createWorkerWorkflowLogger(
  workflowId: string,
  workflowType: string,
  getReplayState: () => WorkerLoggerReplayState | undefined,
  forwardToHost?: (record: WorkflowLogRecord) => void,
): WorkflowLogger {
  return createWorkflowLogger({
    workflowId,
    workflowType,
    isReplaying: () => {
      const replayState = getReplayState();
      if (replayState === undefined) return false;
      const step = replayState.nextStepIndex;
      return replayState.accumulatedResults.has(step) || replayState.failedOutcomes.has(step);
    },
    now: () => Date.now(),
    ...(forwardToHost !== undefined && { sink: forwardToHost }),
  });
}
