import type {
  WorkflowLogger,
  WorkflowLogLevel,
  WorkflowLogRecord,
} from '../types/workflow-context.ts';
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

/** Inputs the logger needs at construction; all sourced fresh per emit call. */
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
 * re-emit logs from the replayed prefix) and otherwise dispatches the structured
 * record to the matching `console` method.
 */
export function createWorkflowLogger(bindings: WorkflowLoggerBindings): WorkflowLogger {
  const emit = (
    level: WorkflowLogLevel,
    message: string,
    attributes: Record<string, unknown> | undefined,
  ): void => {
    if (bindings.isReplaying()) return;
    const record = buildLogRecord(bindings, level, message, attributes);
    console[CONSOLE_METHOD[level]](record);
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
 * the frontier as durable ops advance `stepIndex`.
 */
export function createInlineWorkflowLogger(
  workflowId: string,
  workflowType: string,
  getInternals: () => Pick<ContextInternals, 'accumulatedResults' | 'stepIndex' | 'getNow'>,
): WorkflowLogger {
  return createWorkflowLogger({
    workflowId,
    workflowType,
    isReplaying: () => {
      const internals = getInternals();
      return internals.accumulatedResults?.has(internals.stepIndex) ?? false;
    },
    now: () => getInternals().getNow(),
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
 */
export function createWorkerWorkflowLogger(
  workflowId: string,
  workflowType: string,
  getReplayState: () => WorkerLoggerReplayState | undefined,
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
  });
}
