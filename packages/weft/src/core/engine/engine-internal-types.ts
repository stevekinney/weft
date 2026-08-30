import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { ConstraintDefinition } from '../constraint.ts';
import type { ExecutionStrategy } from '../execution-strategy.ts';
import type { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type {
  AnyActivityDefinition,
  ArchiveAdapter,
  Checkpoint,
  DefinitionSchema,
  EngineOptions,
  NormalizedHistoryPolicy,
  NormalizedPayloadSizePolicy,
  NormalizedRetentionPolicy,
  QueryDefinition,
  SearchAttributeSchema,
  SignalDefinition,
  UpdateDefinition,
  WorkflowConcurrencyOptions,
  WorkflowFunction,
  WorkflowTimelineEntry,
} from '../types.ts';

export interface RegistrationEntry {
  handler: WorkflowFunction;
  version: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema;
  outputSchema?: DefinitionSchema;
  signals?: Readonly<Record<string, Readonly<SignalDefinition<unknown>>>>;
  updates?: Readonly<Record<string, Readonly<UpdateDefinition<unknown>>>>;
  queries?: Readonly<Record<string, Readonly<QueryDefinition<unknown>>>>;
  searchAttributes?: SearchAttributeSchema;
  retention?: NormalizedRetentionPolicy;
  concurrency?: WorkflowConcurrencyOptions;
  constraints?: ConstraintDefinition[];
  /**
   * Definition-level teardown activity (issue #446), driven by the engine after a
   * `cancelled`/`timed-out` terminal. Stored on the engine-lifetime registry so it
   * survives per-workflow terminal cleanup; resolved at teardown by workflow type.
   */
  finalizer?: AnyActivityDefinition;
}

export interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  backgroundTaskMode: 'automatic' | 'manual';
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
  /** Durable-timer scheduler poll interval (ms). */
  schedulerPollIntervalMs: number;
  broadcastEvents: boolean;
  retention: NormalizedRetentionPolicy | null;
  retentionSweepIntervalMs: number;
  retentionSweepBatchSize: number;
  historyPolicy: NormalizedHistoryPolicy;
  /** Operator-supplied sink for compacted event-log ranges; `null` when none. */
  archiveAdapter: ArchiveAdapter | null;
  payloadSizePolicy: NormalizedPayloadSizePolicy;
  /** Whether the best-effort second-instance liveness detector is enabled. */
  secondInstanceDetectionEnabled: boolean;
  /** Heartbeat interval (ms) for the second-instance detector when enabled. */
  secondInstanceHeartbeatIntervalMs: number;
  /**
   * Ownership posture. `'none'` recovers immediately (infra owns mutual
   * exclusion); `'lease'` acquires a single store-wide storage lease before
   * recovery; `'workflow-lease'` fences execution per workflow instead
   * (ADR 0002), letting multiple engines share one durable store. The lease
   * tuning fields below are only meaningful when this is `'lease'`; the
   * workflow-claim tuning fields are only meaningful when this is
   * `'workflow-lease'`.
   */
  ownershipMode: 'none' | 'lease' | 'workflow-lease';
  /** Lease time-to-live (ms) when `ownershipMode` is `'lease'`. */
  leaseTtlMs: number;
  /** Lease renewal interval (ms) when `ownershipMode` is `'lease'`. */
  leaseRenewIntervalMs: number;
  /** Boot-time lease acquisition wait window (ms) when `ownershipMode` is `'lease'`. */
  leaseWaitTimeoutMs: number;
  /** Per-workflow claim time-to-live (ms) when `ownershipMode` is `'workflow-lease'`. */
  workflowClaimTtlMs: number;
  /** Per-workflow claim renewal interval (ms) when `ownershipMode` is `'workflow-lease'`. */
  workflowClaimRenewIntervalMs: number;
  getNow: () => number;
  /**
   * Re-provides the non-serialized per-run `services` value on recovery; `null`
   * when the engine was created without `resolveWorkflowServices`.
   */
  resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | null;
  /**
   * Host sink for `ctx.log` records (`EngineOptions.onLog`); `null` when the engine
   * was created without one (the default console behavior).
   */
  onLog: EngineOptions['onLog'] | null;
}

export interface WorkflowResultWaiter {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export type EngineConstructorOptions<TServices = unknown> = Partial<EngineOptions<TServices>> & {
  getNow?: () => number;
};

export type ExecutionStrategyBundle = {
  strategy: ExecutionStrategy;
  inlineStrategy: InlineExecutionStrategy | null;
};

export type TrackedWaiterKeys = string | Set<string>;

export type PendingTimelineEntry = {
  startedAt: number;
  entry: WorkflowTimelineEntry;
};

export type QueuedInlineWorkflowExecutionStart = {
  workflowId: string;
  workflowExecutionToken?: string;
  workflowType: string;
  input: unknown;
  checkpoint: Checkpoint;
  nestingDepth: number;
  executionDeadline: number | undefined;
  executionStateOwnerId: string;
  /**
   * Liveness callback invoked once this queued start has actually begun
   * executing (its generator has been driven). Set only for `defer: false`
   * launches, which await it before `engine.start()` resolves. Fired exactly
   * once; a discarded start (engine disposed without draining) settles it via
   * the dispose path so the `defer: false` awaiter never hangs.
   */
  onStarted?: () => void;
};
