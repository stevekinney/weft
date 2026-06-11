import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { ConstraintDefinition } from '../constraint.ts';
import type { ExecutionStrategy } from '../execution-strategy.ts';
import type { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type {
  ArchiveAdapter,
  Checkpoint,
  DefinitionSchema,
  EngineOptions,
  NormalizedHistoryPolicy,
  NormalizedPayloadSizePolicy,
  NormalizedRetentionPolicy,
  SearchAttributeSchema,
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
  searchAttributes?: SearchAttributeSchema;
  retention?: NormalizedRetentionPolicy;
  constraints?: ConstraintDefinition[];
}

export interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
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
  getNow: () => number;
  /**
   * Re-provides the non-serialized per-run `services` value on recovery; `null`
   * when the engine was created without `resolveWorkflowServices`.
   */
  resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | null;
}

export interface WorkflowResultWaiter {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export type EngineConstructorOptions = Partial<EngineOptions> & { getNow?: () => number };

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
