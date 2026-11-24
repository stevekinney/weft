import type { Storage as WeftStorage } from "../../embedded/storage/src/index.ts";
import type { ConstraintDefinition } from '../constraint.ts';
import type { ExecutionStrategy } from '../execution-strategy.ts';
import type { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type { RevisionRealmRegistry } from '../realm/revision-realm-registry.ts';
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
  UsedActivityDefinition,
  WorkflowConcurrencyOptions,
  WorkflowFunction,
  WorkflowTimelineEntry,
} from '../types.ts';
import type { WorkflowWorkerVersioningPolicy } from '../versioning.ts';
import type { PendingLaunch } from './local-execution.ts';

/**
 * The identity a running workflow instance was launched under, cached by
 * `EngineInternals.workflowTypeByWorkflowId` for the lifetime of its
 * execution (WFT-19). `revision` is the exact `WorkflowState.revision` this
 * instance is pinned to (WFT-17) — `undefined` for an eager registration or
 * a legacy (pre-pinning) record — so a process-local lookup keyed by
 * `workflowId` can resolve THIS instance's own dynamic-source revision
 * rather than falling back to whichever revision this process resolved
 * last.
 */
export type WorkflowExecutionIdentity = { type: string; revision: string | undefined };

/** Per message kind, each builder key that aliases a different wire name, mapped to that wire name. */
export type MessageAliases = Readonly<{
  signal?: Readonly<Record<string, string>>;
  update?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
}>;

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
  /**
   * Builder keys that alias a different wire name, per message kind
   * (`.signals({ localAlias: signal('wireName') })`). The maps above are keyed
   * by wire name; an alias resolves through this to its declared definition.
   */
  messageAliases?: MessageAliases;
  /** Engine-provided activities the workflow declared with `.uses()`, keyed by name. */
  uses?: Readonly<Record<string, UsedActivityDefinition>>;
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
  workerVersioningPolicy?: WorkflowWorkerVersioningPolicy;
}

/** Resolved form of `EngineOptions.runConcurrency`: the cap and which top-level runs count. */
export interface ResolvedRunConcurrency {
  /** The most counted runs executing at once. */
  readonly max: number;
  /** Whether a top-level run of `workflowType` counts; every one does when the option omits it. */
  readonly counts: (workflowType: string) => boolean;
}

export interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  backgroundTaskMode: 'automatic' | 'manual';
  /** Resolved form of `EngineOptions.inlineLaunchScheduling` (COR-74). */
  inlineLaunchSchedulingMode: 'event-loop' | 'manual';
  /** Resolved form of `EngineOptions.schemas`. */
  schemaPolicy: 'optional' | 'required';
  /** Resolved form of `EngineOptions.payloadValidation`. */
  payloadValidation: 'none' | 'inbound';
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
  /**
   * Resolved form of `EngineOptions.runConcurrency`: the cap and which workflow types count, or
   * `null` for no cap. Optional so hand-built test internals without it read as no cap.
   */
  runConcurrency?: ResolvedRunConcurrency | null;
  /** Durable-timer scheduler poll interval (ms). */
  schedulerPollIntervalMs: number;
  /** Storage-size report interval (ms); zero disables reporting. */
  storageSizeReportIntervalMs: number;
  /** Server-side authority for destructive worker start override previews. */
  workerStartOverrideSigningSecret: string | null;
  broadcastEvents: boolean;
  /** {@link EngineOptions.maintainWorkflowVisibilityIndexes}, defaulted to `false`. */
  maintainWorkflowVisibilityIndexes: boolean;
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
  /**
   * The persisted-log store (`EngineOptions.workflowLogs`); `null` when the engine was created
   * without one, in which case `Engine.getLogs` answers no lines.
   */
  workflowLogs: EngineOptions['workflowLogs'] | null;
}

export interface WorkflowResultWaiter {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /**
   * Whether the waiter is bound to a run yet. Set when the waiter is created while this engine
   * holds the run, or from the first durable read otherwise. Kept apart from the token because a
   * run recorded before tokens existed is bound with no token, and must still not match a later
   * token-bearing run (COR-1604).
   */
  boundToRun: boolean;
  /**
   * The {@link WorkflowState.workflowExecutionToken} of the run this waiter is bound to.
   * `resultResolvers` is keyed by workflow id, and a `start-new` replacement reuses the id, so
   * this is what keeps a settle that belongs to a different run from reaching the waiter.
   * `undefined` while unbound, or when bound to a run recorded before tokens existed.
   */
  workflowExecutionToken?: string | undefined;
}

export type EngineConstructorOptions<TServices = unknown> = Partial<EngineOptions<TServices>> & {
  getNow?: () => number;
};

export type ExecutionStrategyBundle = {
  strategy: ExecutionStrategy;
  inlineStrategy: InlineExecutionStrategy | null;
  /** Set only for `workflowExecutionMode: 'realm'` (COR-249's engine integration); installed onto `EngineInternals.revisionRealmRegistry`. */
  revisionRealmRegistry?: RevisionRealmRegistry;
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
  /** The exact revision this queued start is pinned to (WFT-17/WFT-19). */
  revision: string | undefined;
  /**
   * Liveness callback invoked once this queued start has actually begun
   * executing (its generator has been driven). Set only for `defer: false`
   * launches, which await it before `engine.start()` resolves. Fired exactly
   * once; a discarded start (engine disposed without draining) settles it via
   * the dispose path so the `defer: false` awaiter never hangs.
   */
  onStarted?: () => void;
  /**
   * The record the queue made for this start when it enqueued it (`local-execution.ts`), which its
   * flush transitions and settles through, never by id: a later start of the same id makes its own
   * record.
   */
  launch: PendingLaunch;
};

/** What a caller hands the inline launch queue; the queue makes the entry's record itself. */
export type QueuedInlineWorkflowStartRequest = Omit<QueuedInlineWorkflowExecutionStart, 'launch'>;
