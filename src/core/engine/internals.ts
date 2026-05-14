/**
 * EngineInternals — the shared mutable state object backing every Engine
 * instance. Established in PR 8 of the oxlint-strict refactor.
 *
 * Why a WeakMap instead of `private _field`?  TypeScript's `private` modifier
 * is class-private, not module-private — sibling modules under
 * `src/core/engine/` cannot access an Engine's `private _field` even though
 * they live next to the class. The WeakMap pattern lets every extracted
 * helper read and write the same mutable kernel state via
 * `getInternals(engine)`, which type-checks under `strict: true`.
 *
 * Why not move state into a sub-service object?  Replay determinism depends
 * on call ordering and field-access ordering staying identical to the
 * pre-refactor engine. A single mutable container preserves that; ownership
 * stays in one place.
 *
 * Internal-only.  This module is allow-listed for import only from
 * `src/core/engine/**` (see documentation/internal-imports-allowlist.json).
 */

import type { AlertManager } from '../../alerting/alert-manager.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import type { ActivityRegistry } from '../activity-registry.ts';
import type { EventHeadRecord } from '../event-log.ts';
import type { ExecutionStrategy } from '../execution-strategy.ts';
import type { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type {
  ComposedActivityInterceptor,
  ComposedWorkflowInterceptor,
  Interceptor,
} from '../interceptor.ts';
import type { HumanReviewResult, ReviewCoordinator } from '../review/index.ts';
import type { Scheduler } from '../scheduler.ts';
import type { TenantQuotaManager } from '../tenant-quotas.ts';
import type { Checkpoint } from '../types.ts';
import type { UpdateCoordinator } from '../updates.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';

import type {
  PendingTimelineEntry,
  QueuedInlineWorkflowExecutionStart,
  RegistrationEntry,
  ResolvedOptions,
  TrackedWaiterKeys,
  WorkflowResultWaiter,
} from './engine-internal-types.ts';
import type { ScheduleHandleEngine, WorkflowHandle, WorkflowHandleEngine } from './handles.ts';
import type { WorkflowFeedListener } from './index.ts';

type EngineRuntime = WorkflowHandleEngine & ScheduleHandleEngine;

// ---------------------------------------------------------------------------
// EngineInternals
// ---------------------------------------------------------------------------

export interface EngineInternals {
  engine: EngineRuntime;
  storage: WeftStorage;
  registrations: Map<string, RegistrationEntry>;
  workflowTypesByHandler: WeakMap<Function, string>;
  abortController: AbortController;
  scheduler: Scheduler;
  options: ResolvedOptions;
  strategy: ExecutionStrategy;
  inlineStrategy: InlineExecutionStrategy | null;
  queuedInlineWorkflowStarts: QueuedInlineWorkflowExecutionStart[];
  queuedInlineWorkflowStartIds: Set<string>;
  queuedOrLaunchingInlineWorkflowStartIds: Set<string>;
  queuedInlineWorkflowStartFlushScheduled: boolean;
  queuedInlineWorkflowStartChannel: MessageChannel | null;
  handleCache: Map<string, { ref: WeakRef<WorkflowHandle>; unregisterToken: object }>;
  finalizationRegistry: FinalizationRegistry<string>;
  resultResolvers: Map<string, WorkflowResultWaiter>;
  signalWaiters: Map<string, () => void>;
  signalWaitersByWorkflow: Map<string, TrackedWaiterKeys>;
  updateWaiters: Map<string, (payload: unknown) => void>;
  updateWaitersByWorkflow: Map<string, TrackedWaiterKeys>;
  sleepResolvers: Map<string, () => void>;
  sleepResolversByWorkflow: Map<string, Set<string>>;
  interceptors: Interceptor[];
  // `undefined` means "not yet computed". `null` means "computed and empty —
  // no interceptor implements hooks for this side". Distinguishing the two
  // lets `getComposed*Interceptor` cache the empty-slice result instead of
  // re-running `splitInterceptors` on every call when only one side has
  // hooks (e.g. an observability interceptor with workflow hooks but no
  // `execute`).
  composedWorkflowInterceptor: ComposedWorkflowInterceptor | null | undefined;
  composedActivityInterceptor: ComposedActivityInterceptor | null | undefined;
  updateCoordinator: UpdateCoordinator;
  activityRegistry: ActivityRegistry;
  activityWorkerDispatcher: ActivityWorkerDispatcher | null;
  checkpoints: Map<string, Checkpoint>;
  broadcastChannel: BroadcastChannel | null;
  pendingNestingDepth: number | undefined;
  pendingParentHeaders: Map<string, string> | undefined;
  pendingExecutionStateOwnerId: string | undefined;
  workflowNestingDepths: Map<string, number>;
  workflowHeaders: Map<string, Map<string, string>>;
  workflowStateWriteChains: Map<string, Promise<void>>;
  tenantQuotaManager: TenantQuotaManager;
  heartbeatDetails: Map<string, unknown>;
  pendingStarts: Set<string>;
  pendingScheduleCreations: Set<string>;
  workflowsNeedingTerminalCleanup: Set<string>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
  cleanupIntervalDisposalTracker: {
    disposed: boolean;
    cleanupInterval: ReturnType<typeof setInterval> | null;
  } | null;
  retentionSweepInterval: ReturnType<typeof setInterval> | null;
  retentionSweepInFlight: Promise<void> | null;
  nextRetentionSweepAt: number | null;
  reviewCoordinator: ReviewCoordinator;
  reviewWaiters: Map<string, (decision: HumanReviewResult) => void>;
  reviewWaitersByWorkflow: Map<string, TrackedWaiterKeys>;
  reviewEscalationHandlers: Map<
    string,
    (entry: { id: string; workflowId: string }) => Promise<boolean>
  >;
  workflowReviewIds: Map<string, Set<string>>;
  parkedInlineWorkflows: Set<string>;
  terminalizingWorkflows: Set<string>;
  reviewTimerIds: Map<string, string[]>;
  pendingWebhooks: Set<AbortController>;
  alertManager: AlertManager | null;
  eventLogHeads: Map<string, Readonly<EventHeadRecord>>;
  workflowFeedListeners: Map<string, Set<WorkflowFeedListener>>;
  workflowVersionTuples: Map<string, WorkflowVersionTuple>;
  pendingTimelineEntries: Map<string, PendingTimelineEntry>;
}

const INTERNALS = new WeakMap<object, EngineInternals>();

/**
 * Set up an empty `EngineInternals` skeleton in the WeakMap. The Engine
 * constructor calls this immediately after `super()`, before any field
 * write, so subsequent `getInternals(this).fieldName = expr` assignments
 * succeed.
 *
 * The constructor body then runs the same field-initialization expressions
 * the original `engine.ts` had — preserving the original ordering, which
 * is load-bearing for replay determinism.
 */
export function initializeInternals(engine: EngineRuntime): void {
  const internals = { engine } as EngineInternals;
  INTERNALS.set(engine, internals);
}

/**
 * Look up the `EngineInternals` object for an Engine instance. Throws when
 * `initializeInternals(engine)` has not been called yet — this only happens
 * if a method runs before/around `super()` finishes (e.g. an event listener
 * fires from the EventTarget super class). All Engine methods rely on
 * internals existing.
 */
export function getInternals(engine: object): EngineInternals {
  const internals = INTERNALS.get(engine);
  if (!internals) {
    throw new Error(
      'Engine internals not initialized — initializeInternals(this) was not called in the Engine constructor',
    );
  }
  return internals;
}
