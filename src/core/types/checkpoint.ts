import type { ContextOperationRequest } from '../context/operation-request.ts';
import { WeftError } from '../weft-error.ts';
import type { FailureCategory, OperationId, WorkflowId } from './identity.ts';
import type { Duration, RetryPolicy } from './retry-retention.ts';
import type { SearchAttributeValue } from './search-attributes.ts';
import type { WorkflowLogRecord } from './workflow-log.ts';

/** Version tag for Worker-mode operation replay signatures stored in checkpoints. */
export const WORKER_REPLAY_SIGNATURE_FORMAT = 'weft-worker-operation-signature-v1';

/**
 * Canonical fingerprint of an operation yielded by a Worker-mode workflow.
 *
 * The Worker runner stores these optional signatures next to cached operation
 * results so recovery can prove a cached result still belongs to the operation
 * currently yielded by the workflow code before replaying it.
 *
 * @example
 * ```ts
 * import type { WorkerReplayOperationSignature } from '@lostgradient/weft';
 *
 * const signature: WorkerReplayOperationSignature = {
 *   format: 'weft-worker-operation-signature-v1',
 *   operationType: 'activity',
 *   stableFieldsDigest: '0123456789abcdef',
 *   stableFieldsByteLength: 128,
 * };
 *
 * void signature;
 * ```
 */
export interface WorkerReplayOperationSignature {
  /** Signature format tag. */
  format: typeof WORKER_REPLAY_SIGNATURE_FORMAT;
  /** Operation type or kind used by the workflow runner. */
  operationType: string;
  /** SHA-256 digest of the canonical stable operation fields. */
  stableFieldsDigest: string;
  /** Encoded byte length of the canonical stable operation fields. */
  stableFieldsByteLength: number;
}

/**
 * Failed operation outcome cached by a Worker-mode checkpoint.
 *
 * Stored in a dedicated side table rather than inside `accumulatedResults` so
 * user-controlled result values can never be reinterpreted as internal failure
 * records by matching an object shape.
 *
 * @example
 * ```ts
 * import type { WorkerReplayOperationFailure } from '@lostgradient/weft';
 *
 * const failure: WorkerReplayOperationFailure = {
 *   status: 'failed',
 *   error: 'activity timed out',
 *   failureCategory: 'timeout',
 * };
 *
 * void failure;
 * ```
 */
export interface WorkerReplayOperationFailure {
  /** Failed operation status marker. */
  status: 'failed';
  /** Error message captured from the failed operation outcome. */
  error: string;
  /** Optional JavaScript error name captured from the failed operation outcome. */
  errorName?: string;
  /** Optional Weft failure category captured from the failed operation outcome. */
  failureCategory?: FailureCategory;
}

// ---------------------------------------------------------------------------
// Checkpoint: snapshot of workflow at a yield* boundary
// ---------------------------------------------------------------------------

/**
 * Durable snapshot of a workflow's execution state persisted at each
 * `yield` boundary. Contains the accumulated operation results, local
 * variables, pending signals, search attributes, and the step counter.
 * Users don't construct checkpoints directly; the engine manages them.
 * Available via time-travel APIs and {@link WorkflowReplay}.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type Checkpoint } from '@lostgradient/weft';
 *
 * const engine = new Engine({ checkpointHistory: 5 });
 * engine.register(workflow({ name: 'counter' }).execute(async function* () { return 42; }));
 * const handle = await engine.start('counter', null);
 * await handle.result();
 * // Checkpoints are persisted by the engine; retrieve via engine.getCheckpoint()
 * const _engine: typeof engine = engine;
 * void _engine;
 * ```
 */
export interface Checkpoint {
  workflowId: WorkflowId;
  step: number;
  locals: Record<string, unknown>;
  accumulatedResults: Array<[number, unknown]>;
  /**
   * Worker-mode replay guards for cached operation results. Inline execution
   * ignores this optional field; Worker recovery uses it to prove a cached
   * result still belongs to the yielded operation before reusing it.
   */
  workerReplaySignatures?: Array<[number, WorkerReplayOperationSignature]>;
  /**
   * Worker-mode failed operation outcomes keyed by step. Completed operation
   * results stay in `accumulatedResults`; failed outcomes live here so replay
   * can throw them back into the generator without trusting user result shape.
   */
  workerReplayFailures?: Array<[number, WorkerReplayOperationFailure]>;
  pendingSignals: string[];
  searchAttributes: Record<string, SearchAttributeValue>;
  /** User-defined workflow code version. Checked during recovery. */
  version: string;
  /**
   * Checkpoint schema version. Distinct from `version` (which is the
   * user's workflow code version). Bumped whenever the engine changes
   * the on-disk checkpoint format. Pre-1.0: refuse to load older versions.
   */
  schemaVersion: number;
  createdAt: number;
}

/**
 * Current checkpoint schema version. Skipped from `1` to `2` to make the
 * discontinuity unambiguous — pre-versioned checkpoints (no field) are
 * conceptually `< 1`, and v2 introduces the `ParallelOperationCacheEntry`
 * format with per-branch slots for `ctx.all` / `ctx.runAll` partial
 * persistence.
 */
export const CURRENT_CHECKPOINT_SCHEMA_VERSION = 2;

/**
 * Thrown by `validateCheckpointShape` when a checkpoint's
 * `schemaVersion` does not match the engine's current version. A mismatched
 * checkpoint is rejected, never upgraded in place: the engine loads only
 * checkpoints stamped with the exact current schema version.
 */
export class CheckpointSchemaVersionError extends WeftError<'CheckpointSchemaVersionError'> {
  constructor(
    public readonly found: number | 'pre-versioned',
    public readonly expected: number,
  ) {
    super(
      'CheckpointSchemaVersionError',
      found === 'pre-versioned'
        ? `Checkpoint has no schemaVersion field (pre-versioned format); engine expects schemaVersion ${expected}. ` +
            `Pre-1.0: in-flight workflows must be drained before upgrade.`
        : found > expected
          ? `Checkpoint schemaVersion ${found} is newer than engine version ${expected}. ` +
            `The engine is too old to read this checkpoint.`
          : `Checkpoint schemaVersion ${found} is older than engine version ${expected}. ` +
            `Pre-1.0: in-flight workflows must be drained before upgrade.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Checkpoint history: time-travel debugging
// ---------------------------------------------------------------------------

/** Summary metadata for a single checkpoint history entry. */
export type CheckpointSummary = {
  step: number;
  timestamp: number;
  sizeBytes: number;
};

/** Full deserialized state at a specific checkpoint step. */
export type CheckpointState = Pick<
  Checkpoint,
  'step' | 'locals' | 'searchAttributes' | 'version' | 'createdAt'
>;

// ---------------------------------------------------------------------------
// Operation types
// ---------------------------------------------------------------------------

export type OperationKind = 'activity' | 'timer' | 'signal-wait' | 'child-workflow';

export interface OperationRequest {
  id: OperationId;
  workflowId: WorkflowId;
  kind: OperationKind;
  queue: string;
  activityName?: string;
  input?: unknown;
  attempt: number;
  retryPolicy: RetryPolicy;
  scheduledAt: number;
  timeout?: Duration;
  idempotencyKey?: string;
  /** Visibility timeout in milliseconds. Defaults to 30 000. */
  visibilityTimeout?: number;
}

export type OperationOutcome =
  | { status: 'completed'; value: unknown }
  | WorkerReplayOperationFailure;

// ---------------------------------------------------------------------------
// Timer entry for scheduler
// ---------------------------------------------------------------------------

/**
 * Persistent record of a single scheduled timer. Stored under a
 * deterministic key so timers survive process restarts; the engine
 * resumes the associated workflow when the timer fires.
 *
 * Most code receives `TimerEntry` values from the scheduler; users only
 * construct one when implementing an external scheduler that drives
 * `engine.fireTimer()` (e.g. a Service Worker periodic-sync handler).
 *
 * @example
 * ```ts
 * import { Engine, type TimerEntry } from '@lostgradient/weft';
 * declare const engine: Engine;
 * declare const entry: TimerEntry;
 * await engine.fireTimer(entry);
 * ```
 */
export interface TimerEntry {
  id: string;
  workflowId: WorkflowId;
  fireAt: number;
  kind:
    | 'sleep'
    | 'visibility-timeout'
    | 'execution-deadline'
    | 'delayed-start'
    | 'schedule'
    | 'terminal-cleanup'
    | 'wait-condition';
  executionTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Worker message protocol (postMessage between main thread and Web Workers)
// ---------------------------------------------------------------------------

export type WorkerInboundMessage =
  | {
      type: 'run';
      protocolVersion?: number;
      turnId?: number;
      maxProtocolMessageBytes?: number;
      workflowId: WorkflowId;
      workflowType: string;
      checkpoint: ArrayBuffer;
      input: unknown;
      executionStateOwnerId?: string;
      deadline?: number;
      headers?: [string, string][];
      /**
       * Whether the engine host has an `EngineOptions.onLog` sink installed. The
       * worker routes `ctx.log` records back to the host (as a `log` outbound
       * message) only when this is `true`; otherwise it logs to the worker's own
       * console, preserving the default. Omitted (treated as `false`) when no host
       * sink exists, so a worker can never lose logs to a no-op host callback.
       */
      hostHasLogSink?: boolean;
    }
  | {
      type: 'resume';
      protocolVersion?: number;
      turnId?: number;
      maxProtocolMessageBytes?: number;
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationResult: OperationOutcome;
      /** See {@link WorkerInboundMessage} `run.hostHasLogSink`; carried on every turn so a rebuilt or resumed worker keeps the capability. */
      hostHasLogSink?: boolean;
    }
  | { type: 'cancel'; protocolVersion?: number; turnId?: number; workflowId: WorkflowId };

export type WorkerOutboundMessage =
  | {
      type: 'checkpoint';
      protocolVersion?: number;
      turnId?: number;
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationRequest: OperationRequest | ContextOperationRequest;
    }
  | {
      type: 'completed';
      protocolVersion?: number;
      turnId?: number;
      workflowId: WorkflowId;
      result: unknown;
    }
  | {
      type: 'failed';
      protocolVersion?: number;
      turnId?: number;
      workflowId: WorkflowId;
      error: string;
      errorStack?: string;
      /** Populated when the execution strategy can classify the failure cause. */
      failureCategory?: FailureCategory;
    }
  | {
      /**
       * A `ctx.log` record forwarded from a worker to the engine host's
       * `EngineOptions.onLog` sink (#529). Unlike the other variants, `log` is a
       * NON-TERMINAL, best-effort observability message: it carries no turn-protocol
       * state, never settles or clears the worker turn, and never reaches the strict
       * accept-or-discard gate. The host delivers a record to the sink IFF the sending
       * worker owns `workflowId` (active or parked) AND `record.workflowId` matches the
       * envelope AND the record is a structurally valid `WorkflowLogRecord` within the
       * size cap; otherwise the record is dropped — a wrong-owner, malformed, oversize,
       * or out-of-turn `log` is never a protocol violation and never discards the
       * worker. A between-turns self-log (a fire-and-forget log resolving while the
       * worker is parked) IS delivered, because the worker still owns its parked
       * workflow. The worker emits these only when the inbound message reported
       * `hostHasLogSink: true`.
       */
      type: 'log';
      protocolVersion?: number;
      workflowId: WorkflowId;
      record: WorkflowLogRecord;
    };
