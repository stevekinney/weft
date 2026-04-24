/**
 * Core workflow engine. Orchestrates workflow execution, manages lifecycle
 * events, and coordinates storage, scheduling, and signal delivery.
 *
 * Execution is delegated to an {@link ExecutionStrategy}. By default the
 * engine uses {@link InlineExecutionStrategy} which drives generators on
 * the main thread. A {@link WorkerExecutionStrategy} can be supplied to
 * run workflows in isolated Web Workers.
 *
 * @module core/engine
 */

import type { VerificationRecorder } from '../ai/agent.ts';
import { isAgentDefinition, type AgentDefinition } from '../ai/declaration.ts';
import { HumanReviewCompletedEvent, HumanReviewRequestedEvent } from '../ai/events.ts';
import {
  ReviewCoordinator,
  ReviewTimeoutError,
  type HumanReviewOptions,
  type HumanReviewResult,
  type ReviewRequest,
} from '../ai/human-review.ts';
import type { LLMProvider } from '../ai/providers/interface.ts';
import { AlertManager } from '../alerting/alert-manager.ts';
import { CompressedStorage } from '../storage/compressed-storage.ts';
import type { BatchOperation, Storage as WeftStorage } from '../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  storageKeys,
  tryDecodeStorageKeyComponent,
} from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { ActivityWorkerDispatcher } from '../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../workers/pool.ts';
import type { ActivityRegistrationOptions } from './activity-registry.ts';
import { ActivityRegistry } from './activity-registry.ts';
import { assertScopedBulkWorkflowFilter } from './bulk-workflow-filter.ts';
import {
  advanceCheckpoint,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from './checkpoint.ts';
import { decode, encode } from './codec.ts';
import type { ConstraintCheckState, ConstraintDefinition } from './constraint.ts';
import type {
  ContextOperationRequest,
  StoredStreamChunk,
  StreamReference,
  StreamSink,
} from './context.ts';
import { Context } from './context.ts';
import { isRecord, safeDebugStringify, sanitizeDebugValueForDisplay } from './debug-output.ts';
import {
  cleanupPartialStreamChunks,
  createAgentInterceptorExecute,
  createCleanupErrorReporter,
  createExpiredResponseCleanupTick,
  createHandleCacheFinalizer,
  executeRunAllBranches,
} from './engine-helpers.ts';
import type { EventHeadRecord } from './event-log.ts';
import { EMPTY_EVENT_HEAD, EventLog } from './event-log.ts';
import {
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  CleanupWarningEvent,
  ConstraintViolatedEvent,
  DevelopmentWarningEvent,
  SignalReceivedEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './events.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import { InlineExecutionStrategy } from './inline-execution-strategy.ts';
import type {
  ActivityInterceptor,
  ComposedActivityInterceptor,
  ComposedWorkflowInterceptor,
  WorkflowInterceptor,
} from './interceptor.ts';
import { composeActivityInterceptors, composeWorkflowInterceptors } from './interceptor.ts';
import {
  collectDueCronOccurrences,
  getNextCronOccurrence,
  parseCronExpression,
} from './schedule.ts';
import { Scheduler, buildTimerBatchOperations, normalizeStorageTimestamp } from './scheduler.ts';
import {
  buildIndexOperations,
  encodeAttributeValue,
  validateAttributeType,
  validateEncodedValueSize,
} from './search-attributes.ts';
import {
  StartWorkflowValidationError,
  assertExclusiveStartWorkflowOptions,
  assertWorkflowTagCount,
  coerceStartWorkflowId,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
  parseStartWorkflowDuration,
} from './start-workflow-validation.ts';
import {
  compileStepWorkflow,
  isAsyncGeneratorFunction,
  isGeneratorResult,
} from './step-context.ts';
import { TenantQuotaManager } from './tenant-quotas.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type {
  AttributeFilter,
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationError,
  BulkSignalResult,
  BulkTagResult,
  Checkpoint,
  CheckpointState,
  CheckpointSummary,
  CoordinatedUpdateResult,
  EngineOptions,
  FailureCategory,
  ForkLineage,
  ForkOptions,
  ListFilter,
  NormalizedRetentionPolicy,
  OperationOutcome,
  PaginatedResult,
  PurgeResult,
  RetentionOverview,
  RetentionPolicy,
  ScheduleAccessOptions,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleState,
  ScheduleStatus,
  ScheduleSummary,
  SearchAttributeSchema,
  SearchAttributeValue,
  StartOptions,
  StepWorkflowFunction,
  SubmitReviewOptions,
  TenantQuotaUsage,
  TimerEntry,
  WorkerOutboundMessage,
  WorkflowEvent,
  WorkflowFunction,
  WorkflowRegistration,
  WorkflowReplay,
  WorkflowState,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTimelineEntry,
  WorkflowTimelineStatus,
  WorkflowTypeRetentionPolicy,
} from './types.ts';
import {
  DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
} from './types.ts';
import {
  UpdateCoordinator,
  UpdateTimeoutError,
  WorkflowTerminalError,
  type UpdateRequest,
} from './updates.ts';
import {
  VersionMismatchError,
  buildVersionUpdateOperations,
  checkVersionCompatibility,
  migrateCheckpoint,
} from './versioning.ts';
import { WorkerExecutionStrategy } from './worker-execution-strategy.ts';
import {
  buildWorkflowTagIndexOperations,
  isWorkflowTagArray,
  matchesWorkflowTagFilter,
  normalizeWorkflowTags,
} from './workflow-tags.ts';
import {
  collectToolVersions,
  diffWorkflowVersionTuples,
  type WorkflowVersionDiff,
  type WorkflowVersionTuple,
} from './workflow-version-tuple.ts';

declare global {
  interface SymbolConstructor {
    readonly observable: unique symbol;
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RegistrationEntry {
  handler: WorkflowFunction;
  version: string;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
  retention?: NormalizedRetentionPolicy;
  /** True when this registration originated from an AgentDefinition. */
  isAgent?: boolean;
  /** LLM provider for agent-typed registrations (used for connection pre-warming). */
  provider?: LLMProvider;
  /** Domain constraints evaluated at every checkpoint commit. */
  constraints?: ConstraintDefinition[];
  /** Resolve the effective workflow version tuple for the workflow's tenant context. */
  versionTupleForTenant?: (
    tenant: import('./tenant.ts').TenantContext | undefined,
  ) => WorkflowVersionTuple;
}

interface WorkflowStateUpdateOptions {
  allowedStatuses?: readonly WorkflowStatus[];
  buildAdditionalOperations?: (previousState: WorkflowState, updatedAt: number) => BatchOperation[];
  releaseTenantQuota?: boolean;
}

interface WorkflowStateUpdateResult {
  previousState: WorkflowState;
  updatedAt: number;
}

const BULK_OPERATION_BATCH_SIZE = 1000;

function normalizeBulkFilterNumber(
  value: unknown,
  fieldName: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`filter.${fieldName} must be a non-negative number when provided`);
  }

  return Math.floor(value);
}

/** Options required when registering an AgentDefinition as a workflow. */
export interface AgentRegistrationOptions {
  /** The LLM provider to use when running the agent. */
  provider: LLMProvider;
}

export class WorkflowAlreadyExistsError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`Workflow with id "${workflowId}" already exists`);
    this.name = 'WorkflowAlreadyExistsError';
    this.workflowId = workflowId;
  }
}

export class BulkDeleteRequiresTerminalWorkflowsError extends Error {
  constructor() {
    super('Bulk delete matches non-terminal workflows');
    this.name = 'BulkDeleteRequiresTerminalWorkflowsError';
  }
}

class WorkflowNotFoundError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`Workflow "${workflowId}" not found`);
    this.name = 'WorkflowNotFoundError';
    this.workflowId = workflowId;
  }
}

interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
  broadcastEvents: boolean;
  retention: NormalizedRetentionPolicy | null;
  retentionSweepIntervalMs: number;
  retentionSweepBatchSize: number;
  getNow: () => number;
  tenantResolver: import('./tenant.ts').TenantResolver | undefined;
}

interface WorkflowResultResolver {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

type EngineConstructorOptions = Partial<EngineOptions> & { getNow?: () => number };

type ExecutionStrategyBundle = {
  strategy: ExecutionStrategy;
  inlineStrategy: InlineExecutionStrategy | null;
};

type OperationWithCallerStack = {
  callerStack?: string;
};

type ActivityFunctionWithMetadata = ((...arguments_: unknown[]) => unknown) & {
  verify?: (result: unknown) => Promise<boolean> | boolean;
  compensate?: (input: unknown, output: unknown) => Promise<void> | void;
};

type ConsumedSignalResult =
  | { found: false }
  | {
      found: true;
      payload: unknown;
    };

type WorkflowHandleEventQueue = {
  events: Event[];
  resolver: (() => void) | undefined;
};

type WorkflowHandleIteratorState = {
  done: boolean;
};

type PendingTimelineEntry = {
  startedAt: number;
  entry: WorkflowTimelineEntry;
};

/**
 * Discriminator for `replayWorkflowFeed` / `snapshotWorkflowFeedTail`
 * / `subscribeWorkflowFeedCommits`. Mirrored by `EventSelector` in
 * `src/server/workflow-event-feed.ts` so the core engine takes no
 * dependency on the server package.
 */
export type WorkflowFeedSelector = 'events' | 'tokens';

/**
 * Hard-coded stream key for the `tokens` selector. Matches the
 * legacy REST SSE endpoint's key so resumption cursors round-trip
 * across transports.
 */
const TOKENS_STREAM_KEY = 'tokens';

/** Record `kind` for every token stream chunk emitted by the feed. */
const STREAM_CHUNK_KIND = 'stream:chunk';

/**
 * Build the unified `#workflowFeedListeners` map key. Uses `\0` as
 * the separator: workflow IDs are alphanumeric + `-`, `_` by
 * validation, and the selector is a fixed two-member union, so no
 * legal input can collide.
 */
function workflowFeedListenerKey(workflowId: string, selector: WorkflowFeedSelector): string {
  return `${workflowId}\0${selector}`;
}

/**
 * A committed workflow-feed record surfaced to subscribers of
 * `subscribeWorkflowFeedCommits()`. Fires after `storage.batch()`
 * (events) or `storage.put()` (tokens) resolves, so replay and live
 * delivery share the same committed sequence authority. The same
 * shape covers both selectors — consumers filter on `selector`
 * before interpreting `payload`.
 *
 *   - `events` selector: `kind` is the durable log entry type
 *     (e.g. `'workflow:checkpoint'`). `sequence` / `timestamp` come
 *     from the `WorkflowLogEntry` written inside the batch.
 *   - `tokens` selector: `kind` is always `'stream:chunk'`.
 *     `sequence` is the chunk index; `timestamp` is wall-clock at
 *     write time.
 */
export type WorkflowFeedRecord = {
  readonly workflowId: string;
  readonly selector: WorkflowFeedSelector;
  readonly kind: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly payload: unknown;
};

/**
 * Listener signature for `subscribeWorkflowFeedCommits()`. Returning
 * `void | Promise<void>` is explicit: an async listener's rejected
 * promise is caught by the notifier and discarded, exactly like a
 * sync throw. This is the only correct shape for a notifier called
 * from a hot path — an escaped unhandled rejection would surface as
 * a test-runner or Node process-level crash.
 */
export type WorkflowFeedListener = (record: WorkflowFeedRecord) => void | Promise<void>;

class SpeculativeExecutionState implements VerificationRecorder {
  readonly #verifications: Array<Promise<{ failed: false } | { failed: true; error: unknown }>>;
  readonly #compensations: Array<() => Promise<void>>;

  constructor() {
    this.#verifications = [];
    this.#compensations = [];
  }

  recordVerification(verification: Promise<void>): void {
    this.#verifications.push(
      verification.then(
        () => ({ failed: false as const }),
        (error) => ({ failed: true as const, error }),
      ),
    );
  }

  recordCompensation(compensation: () => Promise<void>): void {
    this.#compensations.push(compensation);
  }

  async drainVerifications(): Promise<void> {
    const outcomes = await Promise.all(this.#verifications);
    const failure = outcomes.find((outcome) => outcome.failed);
    if (failure) {
      throw failure.error;
    }
  }

  async rollback(): Promise<void> {
    for (let index = this.#compensations.length - 1; index >= 0; index--) {
      try {
        await this.#compensations[index]!();
      } catch {
        // Best-effort rollback continues through failed compensations.
      }
    }
    await Promise.all(this.#verifications);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely cast a `Function` stored on a ContextOperationRequest
 * to a callable signature.  We trust the Context layer to populate
 * `fn` with the correct reference—the Engine merely invokes it.
 */
function callActivityFunction(fn: Function, args: unknown[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return (fn as (...a: unknown[]) => unknown)(...args);
}

function callMemoFunction(fn: Function): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return (fn as () => unknown)();
}

function summarizeTimelineValue(value: unknown): string {
  return safeDebugStringify(value);
}

function getTimelineOperationLabel(operation: ContextOperationRequest): string {
  switch (operation.type) {
    case 'activity':
      return operation.activityName;
    case 'wait-signal':
      return operation.signalName;
    case 'wait-update':
      return operation.updateName;
    case 'child-workflow':
      return operation.workflowType;
    case 'memo':
    case 'offload':
    case 'archive':
    case 'stream':
      return operation.key;
    case 'load':
      return operation.reference.key;
    case 'agent':
      return operation.options.model;
    default:
      return operation.type;
  }
}

function getTimelineReviewArtifactType(artifact: unknown): unknown {
  if (typeof artifact !== 'object' || artifact === null || !('type' in artifact)) {
    return undefined;
  }

  return (artifact as Record<string, unknown>)['type'];
}

function getTimelineBasicInputSummary(operation: ContextOperationRequest): string {
  switch (operation.type) {
    case 'sleep':
      return summarizeTimelineValue({ duration: operation.duration });
    case 'wait-signal':
      return summarizeTimelineValue({ signalName: operation.signalName });
    case 'wait-update':
      return summarizeTimelineValue({ updateName: operation.updateName });
    case 'parallel':
    case 'race':
      return summarizeTimelineValue({ operationCount: operation.operations.length });
    case 'memo':
      return summarizeTimelineValue({ key: operation.key });
    case 'offload':
      return summarizeTimelineValue({ key: operation.key });
    case 'load':
      return summarizeTimelineValue({ key: operation.reference.key });
    case 'archive':
      return summarizeTimelineValue({ key: operation.key, data: operation.data });
    case 'speculate':
      return summarizeTimelineValue({ branch: 'speculative' });
    case 'stream':
      return summarizeTimelineValue({ key: operation.key });
    default:
      return summarizeTimelineValue(undefined);
  }
}

function getTimelineInputSummary(operation: ContextOperationRequest): string {
  switch (operation.type) {
    case 'activity':
      return summarizeTimelineValue(
        operation.args.length <= 1 ? operation.args[0] : operation.args,
      );
    case 'child-workflow':
      return summarizeTimelineValue({
        workflowType: operation.workflowType,
        input: operation.input,
      });
    case 'run-all':
      return summarizeTimelineValue({ branches: Object.keys(operation.branches) });
    case 'agent':
      return summarizeTimelineValue({
        model: operation.options.model,
        promptLength: operation.options.prompt.length,
      });
    case 'wait-review':
      return summarizeTimelineValue({
        reviewers: operation.reviewOptions.reviewers,
        artifactType: getTimelineReviewArtifactType(operation.reviewOptions.artifact),
      });
    case 'handoff':
    case 'debate':
    case 'supervise':
      return summarizeTimelineValue(operation.options);
    default:
      return getTimelineBasicInputSummary(operation);
  }
}

function isSanitizedSearchAttributeValue(
  value: unknown,
): value is import('./types.ts').SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sanitizeCheckpointLocals(locals: unknown): Record<string, unknown> {
  const sanitized = sanitizeDebugValueForDisplay(locals);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeCheckpointSearchAttributes(
  searchAttributes: unknown,
): Record<string, import('./types.ts').SearchAttributeValue> {
  const sanitized = sanitizeDebugValueForDisplay(searchAttributes);
  if (!isRecord(sanitized)) {
    return {};
  }

  const result: Record<string, import('./types.ts').SearchAttributeValue> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (isSanitizedSearchAttributeValue(value)) {
      result[key] = value;
    }
  }

  return result;
}

function sanitizeCheckpointState(
  checkpoint: import('./types.ts').CheckpointState,
): import('./types.ts').CheckpointState {
  return {
    step: checkpoint.step,
    locals: sanitizeCheckpointLocals(checkpoint.locals),
    searchAttributes: sanitizeCheckpointSearchAttributes(checkpoint.searchAttributes),
    version: checkpoint.version,
    createdAt: checkpoint.createdAt,
  };
}

function sanitizeWorkflowEventPayload(payload: unknown): Record<string, unknown> {
  const sanitized = sanitizeDebugValueForDisplay(payload);
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function sanitizeTimelineSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) {
    return undefined;
  }

  try {
    return summarizeTimelineValue(JSON.parse(summary) as unknown);
  } catch {
    return summary;
  }
}

const WORKFLOW_TIMELINE_STATUSES = new Set<WorkflowTimelineStatus>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

function isWorkflowVersionTuple(value: unknown): value is WorkflowVersionTuple {
  if (!isRecord(value) || typeof value['workflowVersion'] !== 'string') {
    return false;
  }

  if (value['agentVersion'] !== undefined && typeof value['agentVersion'] !== 'string') {
    return false;
  }

  return (
    value['toolVersions'] === undefined ||
    (Array.isArray(value['toolVersions']) &&
      value['toolVersions'].every((entry) => typeof entry === 'string'))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTimelineStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isWorkflowTimelineEntry(value: unknown): value is WorkflowTimelineEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isTimelineStep(value['step']) &&
    typeof value['operationType'] === 'string' &&
    typeof value['operationLabel'] === 'string' &&
    typeof value['inputSummary'] === 'string' &&
    isFiniteNumber(value['timestamp']) &&
    WORKFLOW_TIMELINE_STATUSES.has(value['status'] as WorkflowTimelineStatus) &&
    (value['outputSummary'] === undefined || typeof value['outputSummary'] === 'string') &&
    (value['duration'] === undefined || isFiniteNumber(value['duration'])) &&
    (value['versionTuple'] === undefined || isWorkflowVersionTuple(value['versionTuple']))
  );
}

function isValidScheduleTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidScheduleStatus(value: unknown): value is ScheduleStatus {
  return typeof value === 'string' && SCHEDULE_STATUSES.has(value as ScheduleStatus);
}

function isValidScheduleOverlapPolicy(value: unknown): value is ScheduleOverlapPolicy {
  return typeof value === 'string' && SCHEDULE_OVERLAP_POLICIES.has(value as ScheduleOverlapPolicy);
}

function isValidScheduleIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    coerceStartWorkflowId(value, 'schedule id');
    return true;
  } catch {
    return false;
  }
}

function coerceScheduleId(scheduleId: string, fieldName: string): string {
  return coerceStartWorkflowId(scheduleId, fieldName);
}

function coerceScheduleTenantId(tenantId: string, fieldName: string): string {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return tenantId;
}

function normalizeScheduleOptions(
  options: ScheduleOptions | undefined,
): Required<Pick<ScheduleOptions, 'overlap' | 'backfill'>> & { id?: string } {
  if (options === undefined) {
    return { overlap: 'skip', backfill: false };
  }

  if (typeof options !== 'object' || options === null) {
    throw new Error('options must be an object when provided');
  }

  const { id, overlap, backfill } = options;
  const normalizedOptions: Required<Pick<ScheduleOptions, 'overlap' | 'backfill'>> & {
    id?: string;
  } = {
    overlap: 'skip',
    backfill: false,
  };

  if (id !== undefined) {
    normalizedOptions.id = coerceScheduleId(id, 'options.id');
  }

  if (overlap !== undefined) {
    if (!SCHEDULE_OVERLAP_POLICIES.has(overlap)) {
      throw new Error(
        `options.overlap must be one of ${[...SCHEDULE_OVERLAP_POLICIES].join(', ')}`,
      );
    }
    normalizedOptions.overlap = overlap;
  }

  if (backfill !== undefined) {
    if (typeof backfill !== 'boolean') {
      throw new Error('options.backfill must be a boolean when provided');
    }
    normalizedOptions.backfill = backfill;
  }

  return normalizedOptions;
}

function normalizeScheduleAccessOptions(
  accessOptions: ScheduleAccessOptions | undefined,
): ScheduleAccessOptions | undefined {
  if (accessOptions === undefined) {
    return undefined;
  }

  if (typeof accessOptions !== 'object' || accessOptions === null) {
    throw new Error('accessOptions must be an object when provided');
  }

  const { tenantId } = accessOptions;
  if (tenantId === undefined) {
    return {};
  }

  return {
    tenantId: coerceScheduleTenantId(tenantId, 'accessOptions.tenantId'),
  };
}

function normalizeScheduleFilter(filter: ScheduleFilter | undefined): ScheduleFilter | undefined {
  if (filter === undefined) {
    return undefined;
  }

  if (typeof filter !== 'object' || filter === null) {
    throw new Error('filter must be an object when provided');
  }

  const { status, workflowType, tenantId, limit, offset } = filter;

  if (status !== undefined) {
    const statuses = Array.isArray(status) ? status : [status];
    for (const candidateStatus of statuses) {
      if (!SCHEDULE_STATUSES.has(candidateStatus)) {
        throw new Error(`filter.status must be one of ${[...SCHEDULE_STATUSES].join(', ')}`);
      }
    }
  }

  if (workflowType !== undefined) {
    if (typeof workflowType !== 'string' || workflowType.length === 0) {
      throw new Error('filter.workflowType must be a non-empty string when provided');
    }
  }

  if (tenantId !== undefined) {
    coerceScheduleTenantId(tenantId, 'filter.tenantId');
  }

  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('filter.limit must be a non-negative safe integer when provided');
  }

  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
    throw new Error('filter.offset must be a non-negative safe integer when provided');
  }

  return filter;
}

/**
 * Type predicate that validates a decoded `tenant` field is shaped like a
 * {@link import('./tenant.ts').TenantContext}. Returns true only when `tenant`
 * is `undefined`, or an object with a non-empty string `id` and (when present)
 * an `attributes` object. Defensive because `state.tenant` is fed directly
 * into agent `validateInput` and `toolsForTenant` hooks; a corrupt or tampered
 * storage record could otherwise inject a forged tenant identity into
 * security decisions.
 *
 * `null` is rejected intentionally — the canonical "no tenant" value is
 * `undefined`. A stored `null` indicates corruption.
 */
function isValidDecodedTenant(
  value: unknown,
): value is import('./tenant.ts').TenantContext | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return false;
  const attributes = record['attributes'];
  if (attributes !== undefined && (attributes === null || typeof attributes !== 'object')) {
    return false;
  }
  return true;
}

function isValidDecodedTags(value: unknown): value is string[] | undefined {
  return value === undefined || isWorkflowTagArray(value);
}

function decodeWorkflowState(bytes: Uint8Array): WorkflowState {
  // bytes were written by encode(WorkflowState) — shape is guaranteed by our own storage
  const state = decode(bytes) as WorkflowState;
  // Defensive check on the security-relevant tenant field. Other fields are
  // trusted by construction, but `tenant` feeds directly into agent decision
  // functions so we refuse to propagate a forged identity. On invalid shape we
  // log a warning and fall back to `undefined` (the safe default) rather than
  // throwing — refusing to decode would break recovery for unrelated workflows
  // sharing the same storage backend.
  if (!isValidDecodedTenant(state.tenant)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has an invalid tenant field; ` +
        `falling back to undefined tenant. This usually indicates corruption or tampering of ` +
        `the storage record.`,
    );
    delete state.tenant;
  }
  if (!isValidDecodedTags(state.tags)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has invalid tags; ` +
        'dropping the malformed tag list from the decoded state.',
    );
    delete state.tags;
  }
  return state;
}

function rejectInvalidScheduleRecord(scheduleId: string | undefined, message: string): null {
  const prefix =
    scheduleId === undefined
      ? '[weft] Ignoring malformed schedule record'
      : `[weft] Ignoring malformed schedule "${scheduleId}"`;
  console.warn(`${prefix} ${message}.`);
  return null;
}

function decodeScheduleIdentityFields(
  decoded: Record<string, unknown>,
): Pick<ScheduleState, 'id' | 'workflowType' | 'cronExpression' | 'status' | 'overlap'> | null {
  const id = decoded['id'];
  if (!isValidScheduleIdentifier(id)) {
    return rejectInvalidScheduleRecord(undefined, 'with invalid id');
  }

  const workflowType = decoded['workflowType'];
  if (typeof workflowType !== 'string' || workflowType.length === 0) {
    return rejectInvalidScheduleRecord(id, 'with invalid workflowType');
  }

  const cronExpression = decoded['cronExpression'];
  if (typeof cronExpression !== 'string') {
    return rejectInvalidScheduleRecord(id, 'with invalid cronExpression');
  }
  try {
    parseCronExpression(cronExpression);
  } catch {
    return rejectInvalidScheduleRecord(id, 'with invalid cronExpression');
  }

  const status = decoded['status'];
  if (!isValidScheduleStatus(status)) {
    return rejectInvalidScheduleRecord(id, 'with invalid status');
  }

  const overlap = decoded['overlap'];
  if (!isValidScheduleOverlapPolicy(overlap)) {
    return rejectInvalidScheduleRecord(id, 'with invalid overlap policy');
  }

  return {
    id,
    workflowType,
    cronExpression,
    status,
    overlap,
  };
}

function decodeScheduleRuntimeFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): Pick<
  ScheduleState,
  | 'backfill'
  | 'createdAt'
  | 'updatedAt'
  | 'lastFireAt'
  | 'nextFireAt'
  | 'currentWorkflowId'
  | 'queuedRuns'
  | 'tenant'
> | null {
  const backfill = decoded['backfill'];
  if (typeof backfill !== 'boolean') {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid backfill flag');
  }

  const createdAt = decoded['createdAt'];
  const updatedAt = decoded['updatedAt'];
  if (!isValidScheduleTimestamp(createdAt) || !isValidScheduleTimestamp(updatedAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid timestamps');
  }

  const lastFireAt = decoded['lastFireAt'];
  if (lastFireAt !== undefined && !isValidScheduleTimestamp(lastFireAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid lastFireAt');
  }

  const nextFireAt = decoded['nextFireAt'];
  if (nextFireAt === undefined) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid nextFireAt');
  }
  if (nextFireAt !== null && !isValidScheduleTimestamp(nextFireAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid nextFireAt');
  }

  const currentWorkflowId = decoded['currentWorkflowId'];
  if (currentWorkflowId !== undefined && !isValidScheduleIdentifier(currentWorkflowId)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid currentWorkflowId');
  }

  const queuedRuns = decoded['queuedRuns'];
  if (typeof queuedRuns !== 'number' || !Number.isSafeInteger(queuedRuns) || queuedRuns < 0) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid queuedRuns');
  }

  const tenant = decoded['tenant'];
  if (!isValidDecodedTenant(tenant)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid tenant');
  }

  return {
    backfill,
    createdAt,
    updatedAt,
    ...(lastFireAt !== undefined && { lastFireAt }),
    nextFireAt,
    ...(currentWorkflowId !== undefined && { currentWorkflowId }),
    queuedRuns,
    ...(tenant !== undefined && { tenant }),
  };
}

function decodeScheduleState(bytes: Uint8Array): ScheduleState | null {
  const decoded = decode(bytes);
  if (!isRecord(decoded)) {
    console.warn('[weft] Ignoring malformed schedule record with non-object payload.');
    return null;
  }

  const identity = decodeScheduleIdentityFields(decoded);
  if (!identity) {
    return null;
  }

  const runtime = decodeScheduleRuntimeFields(decoded, identity.id);
  if (!runtime) {
    return null;
  }

  return {
    ...identity,
    input: decoded['input'],
    ...runtime,
  };
}

function getWorkflowExecutionStartedAt(
  state: Pick<WorkflowState, 'createdAt' | 'startedAt'>,
): number {
  return state.startedAt ?? state.createdAt;
}

function normalizeForkStep(fromStep: number): number {
  if (!Number.isSafeInteger(fromStep) || fromStep < 0) {
    throw new Error('options.fromStep must be a non-negative safe integer');
  }

  return fromStep;
}

function enqueueWorkflowHandleEvent(queue: WorkflowHandleEventQueue, event: Event): void {
  queue.events.push(event);
  queue.resolver?.();
}

function finishWorkflowHandleIteration(
  state: WorkflowHandleIteratorState,
  queue: WorkflowHandleEventQueue,
  event: Event,
): void {
  // Guard against the "synthesized terminal event already landed" race: when
  // iteration starts after a workflow has already finished, the asyncIterator
  // synthesizes a terminal event from persisted state and sets `state.done =
  // true`. If the real terminal event then arrives (because it was in flight
  // between `addEventListener` and `await this.#engine.get()`), we must not
  // enqueue it a second time — the test suite asserts terminal events are
  // yielded exactly once.
  if (state.done) return;
  state.done = true;
  enqueueWorkflowHandleEvent(queue, event);
}

/**
 * Build a synthetic terminal event matching the persisted status of a
 * workflow that has already finished. Returns `null` for non-terminal states.
 *
 * Used by {@link WorkflowHandle[Symbol.asyncIterator]} and
 * {@link WorkflowHandle[Symbol.observable]} to avoid hanging when a consumer
 * starts iterating after the workflow has already reached a terminal state —
 * the real terminal event was dispatched before any listener was attached and
 * will never re-fire.
 */
function synthesizeTerminalEventFromState(state: WorkflowState): Event | null {
  switch (state.status) {
    case 'completed': {
      const duration = state.updatedAt - getWorkflowExecutionStartedAt(state);
      return new WorkflowCompletedEvent(state.id, state.result, duration);
    }
    case 'failed': {
      const error = new Error(state.error ?? 'Workflow failed');
      if (state.errorStack) error.stack = state.errorStack;
      return new WorkflowFailedEvent(state.id, error);
    }
    case 'cancelled':
      return new WorkflowCancelledEvent(state.id);
    case 'timed-out': {
      // Mirror the real dispatch in `#terminateWorkflow`, which computes
      // `elapsed` as `getNow() - state.createdAt` and then persists the
      // termination wall-clock time as `state.updatedAt`. Reading
      // `updatedAt - createdAt` here recovers the same value the real event
      // carried; `executionDeadline` would be the configured timeout budget
      // instead of the actual elapsed, which is a subtly different number
      // when the scheduler ticks past the deadline.
      const elapsed = state.updatedAt - getWorkflowExecutionStartedAt(state);
      return new WorkflowTimedOutEvent(state.id, 'execution', elapsed);
    }
    default:
      return null;
  }
}

function resolveEngineStorage(
  options?: EngineConstructorOptions,
  getAgentWorkflowIds?: () => ReadonlySet<string>,
): WeftStorage {
  const baseStorage = options?.storage ?? new MemoryStorage();
  if (!options?.compression) return baseStorage;
  return new CompressedStorage(baseStorage, {
    ...options.compression,
    ...(getAgentWorkflowIds
      ? {
          agentWorkflowIds: getAgentWorkflowIds,
          // Default to brotli for agent checkpoints (conversation data compresses
          // exceptionally well with brotli). Users may override via compression.agentAlgorithm.
          agentAlgorithm: options.compression.agentAlgorithm ?? 'brotli',
          ...(options.compression.agentThreshold !== undefined
            ? { agentThreshold: options.compression.agentThreshold }
            : {}),
        }
      : {}),
  });
}

function encodeWorkflowStartHeaders(headers: Map<string, string>): Uint8Array {
  return encode([...headers.entries()]);
}

function decodeWorkflowStartHeaders(bytes: Uint8Array): Map<string, string> {
  const entries = decode(bytes) as Array<[string, string]>;
  return new Map(entries);
}

const PERSISTED_WORKFLOW_START_HEADER_NAMES = new Set(['traceparent', 'tracestate']);

function selectPersistedWorkflowStartHeaders(
  headers: Map<string, string> | undefined,
): Map<string, string> | undefined {
  if (!headers || headers.size === 0) {
    return undefined;
  }

  const persistedHeaders = new Map<string, string>();

  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    if (!PERSISTED_WORKFLOW_START_HEADER_NAMES.has(normalizedName)) {
      continue;
    }
    persistedHeaders.set(normalizedName, value);
  }

  return persistedHeaders.size > 0 ? persistedHeaders : undefined;
}

function normalizeRetentionDuration(
  value: import('./types.ts').Duration | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const milliseconds = parseStartWorkflowDuration(value, fieldName);
  return Math.ceil(milliseconds);
}

function normalizeRetentionPolicy(
  policy: RetentionPolicy | undefined,
  context: string,
): NormalizedRetentionPolicy | null {
  if (!policy) {
    return null;
  }

  const normalized: NormalizedRetentionPolicy = {};
  const completed = normalizeRetentionDuration(policy.completed, `${context}.completed`);
  const failed = normalizeRetentionDuration(policy.failed, `${context}.failed`);
  const cancelled = normalizeRetentionDuration(policy.cancelled, `${context}.cancelled`);
  const timedOut = normalizeRetentionDuration(policy.timedOut, `${context}.timedOut`);

  if (completed !== undefined) {
    normalized.completed = completed;
  }
  if (failed !== undefined) {
    normalized.failed = failed;
  }
  if (cancelled !== undefined) {
    normalized.cancelled = cancelled;
  }
  if (timedOut !== undefined) {
    normalized.timedOut = timedOut;
  }

  const isEmpty =
    normalized.completed === undefined &&
    normalized.failed === undefined &&
    normalized.cancelled === undefined &&
    normalized.timedOut === undefined;

  return isEmpty ? null : normalized;
}

function resolveRetentionForStatus(
  policy: NormalizedRetentionPolicy | null | undefined,
  status: WorkflowStatus,
): number | undefined {
  switch (status) {
    case 'completed':
      return policy?.completed;
    case 'failed':
      return policy?.failed;
    case 'cancelled':
      return policy?.cancelled;
    case 'timed-out':
      return policy?.timedOut;
    default:
      return undefined;
  }
}

function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out'
  );
}

async function collectKeysForPrefix(storage: WeftStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];

  for await (const key of storageKeys(storage, prefix)) {
    keys.push(key);
  }

  return keys;
}

const EMPTY_STORAGE_VALUE = new Uint8Array(0);

function resolveEngineOptions(
  storage: WeftStorage,
  options: EngineConstructorOptions | undefined,
  getNow: () => number,
): ResolvedOptions {
  return {
    storage,
    development: options?.development ?? false,
    checkpointHistory: options?.checkpointHistory ?? 10,
    checkpointSizeWarningThreshold: options?.checkpointSizeWarningThreshold ?? 65_536,
    maxNestingDepth: options?.maxNestingDepth ?? 10,
    broadcastEvents: options?.broadcastEvents ?? false,
    retention: normalizeRetentionPolicy(options?.retention, 'options.retention'),
    retentionSweepIntervalMs:
      normalizeRetentionDuration(
        options?.retentionSweepInterval,
        'options.retentionSweepInterval',
      ) ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
    retentionSweepBatchSize:
      options?.retentionSweepBatchSize !== undefined
        ? Math.max(1, Math.floor(options.retentionSweepBatchSize))
        : DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
    getNow,
    tenantResolver: options?.tenantResolver,
  };
}

function createExecutionStrategyBundle(parameters: {
  options: EngineConstructorOptions | undefined;
  getNow: () => number;
  maxNestingDepth: number;
  development: boolean;
  broadcastEvents: boolean;
  getRegistration: (workflowType: string) => RegistrationEntry | undefined;
  resolveWorkflowType: (target: string | Function) => string;
}): ExecutionStrategyBundle {
  const {
    options,
    getNow,
    maxNestingDepth,
    development,
    broadcastEvents,
    getRegistration,
    resolveWorkflowType,
  } = parameters;

  if (options?.workerExecution) {
    const pool = new WorkerPool({
      workerUrl: options.workerExecution.workerUrl,
      concurrency: options.workerExecution.concurrency ?? 4,
      smol: options.workerExecution.smol ?? false,
    });

    return {
      strategy: new WorkerExecutionStrategy(pool, { broadcastEvents }),
      inlineStrategy: null,
    };
  }

  const inlineStrategy = new InlineExecutionStrategy({
    getRegistration,
    getNow,
    maxNestingDepth,
    development,
    resolveWorkflowType,
  });

  return {
    strategy: inlineStrategy,
    inlineStrategy,
  };
}

function createActivityWorkerDispatcher(
  activityExecution: EngineConstructorOptions['activityExecution'],
): ActivityWorkerDispatcher | null {
  if (!activityExecution) {
    return null;
  }

  const activityPool = new WorkerPool({
    workerUrl: activityExecution.workerUrl,
    concurrency: activityExecution.poolSize ?? 4,
    smol: activityExecution.smol ?? false,
  });
  return new ActivityWorkerDispatcher(activityPool);
}

function createAlertManagerForEngine(
  engine: Engine,
  alerts: EngineOptions['alerts'] | undefined,
  getNow: () => number,
): AlertManager | null {
  return alerts ? new AlertManager(engine, alerts, getNow) : null;
}

/**
 * Maximum number of attribute-index scans to run in parallel during a single
 * `engine.list()` call. Bounds fan-out on connection-limited storage backends.
 */
const ATTRIBUTE_SCAN_CONCURRENCY = 8;
const FORK_LINEAGE_ATTRIBUTE = 'weft:forkedFrom';
const SCHEDULE_LATE_GRACE_MILLISECONDS = 1000;
const MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK = 256;
const SCHEDULE_STATUSES = new Set<ScheduleStatus>(['active', 'paused', 'cancelled']);
const SCHEDULE_OVERLAP_POLICIES = new Set<ScheduleOverlapPolicy>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

function intersectIdentifierSets(idSets: Set<string>[]): Set<string> | null {
  const [firstSet, ...remainingSets] = idSets;
  if (!firstSet) {
    return null;
  }

  const intersected = new Set(firstSet);
  for (const nextSet of remainingSets) {
    for (const id of intersected) {
      if (!nextSet.has(id)) {
        intersected.delete(id);
      }
    }
  }

  return intersected;
}

function matchesListFilter(
  state: WorkflowState,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
  normalizedTagFilters: readonly string[] | undefined,
): boolean {
  if (constrainedIds !== null && !constrainedIds.has(state.id)) {
    return false;
  }

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(state.status)) {
      return false;
    }
  }

  if (!matchesWorkflowTagFilter(state.tags, normalizedTagFilters)) {
    return false;
  }

  return filter?.type === undefined || state.type === filter.type;
}

/**
 * Slice an in-memory list of {@link WorkflowSummary} into a {@link PaginatedResult}.
 *
 * Important note on `total` semantics: the returned `total` reflects the number
 * of workflows that matched the supplied {@link ListFilter} (status, type, and
 * search attribute filters). It is **not** the absolute count of workflows in
 * storage. A UI computing "page 1 of N" from `total` will see the page count
 * for the active filter; the unfiltered population is intentionally not
 * surfaced through this response, since recovering it would require a separate
 * full scan that defeats the purpose of the filter fast path.
 */
function paginateWorkflowSummaries(
  items: WorkflowSummary[],
  filter?: ListFilter,
): PaginatedResult<WorkflowSummary> {
  return paginateItems(items, filter);
}

type PaginationFilter = {
  limit?: number;
  offset?: number;
};

function paginateItems<T>(items: T[], filter: PaginationFilter | undefined): PaginatedResult<T> {
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? items.length;
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeValueForEncodedComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValueForEncodedComparison(entry));
  }

  if (!isPlainObjectRecord(value)) {
    return value;
  }

  const normalizedRecord: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    normalizedRecord[key] = normalizeValueForEncodedComparison(value[key]);
  }

  return normalizedRecord;
}

function encodedValuesEqual(left: unknown, right: unknown): boolean {
  const leftEncoded = encode(normalizeValueForEncodedComparison(left));
  const rightEncoded = encode(normalizeValueForEncodedComparison(right));

  if (leftEncoded.byteLength !== rightEncoded.byteLength) {
    return false;
  }

  for (let index = 0; index < leftEncoded.byteLength; index++) {
    if (leftEncoded[index] !== rightEncoded[index]) {
      return false;
    }
  }

  return true;
}

function matchesScheduleFilter(state: ScheduleState, filter: ScheduleFilter | undefined): boolean {
  if (state.tenant?.id !== undefined) {
    if (filter?.tenantId === undefined) {
      return false;
    }
    if (state.tenant.id !== filter.tenantId) {
      return false;
    }
  } else if (filter?.tenantId !== undefined) {
    return false;
  }

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(state.status)) {
      return false;
    }
  }

  return filter?.workflowType === undefined || state.workflowType === filter.workflowType;
}

function paginateScheduleSummaries(
  items: ScheduleSummary[],
  filter?: ScheduleFilter,
): PaginatedResult<ScheduleSummary> {
  const sortedItems = items.toSorted((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }

    return left.id.localeCompare(right.id);
  });

  return paginateItems(sortedItems, filter);
}

function createScheduleTimerId(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

function canAccessSchedule(
  state: ScheduleState,
  accessOptions: ScheduleAccessOptions | undefined,
): boolean {
  if (state.tenant?.id === undefined) {
    return accessOptions?.tenantId === undefined;
  }

  return accessOptions?.tenantId === state.tenant.id;
}

function clearScheduleCurrentWorkflow(state: ScheduleState): ScheduleState {
  const { currentWorkflowId: _currentWorkflowId, ...rest } = state;
  return rest;
}

type RefreshedScheduleState = {
  state: ScheduleState;
  currentWorkflowState: WorkflowState | null;
};
// ---------------------------------------------------------------------------
// WorkflowHandle
// ---------------------------------------------------------------------------

export class WorkflowHandle extends EventTarget implements AsyncDisposable {
  readonly id: string;
  readonly #engine: Engine;
  readonly #resultPromise: Promise<unknown>;

  constructor(id: string, engine: Engine, resultPromise: Promise<unknown>) {
    super();
    this.id = id;
    this.#engine = engine;
    this.#resultPromise = resultPromise;
  }

  async result(): Promise<unknown> {
    return this.#resultPromise;
  }

  async cancel(): Promise<void> {
    return this.#engine.cancel(this.id);
  }

  async signal(name: string, payload?: unknown): Promise<void> {
    return this.#engine.signal(this.id, name, payload);
  }

  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown> {
    return this.#engine.update(this.id, name, payload, options);
  }

  async query(name: string): Promise<unknown> {
    return this.#engine.query(this.id, name);
  }

  async getAttributes(): Promise<Record<string, SearchAttributeValue> | null> {
    return this.#engine.getAttributes(this.id);
  }

  async setAttributes(attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return this.#engine.setAttributes(this.id, attributes);
  }

  async addTags(...tags: string[]): Promise<void> {
    return this.#engine.addTags(this.id, ...tags);
  }

  async removeTags(...tags: string[]): Promise<void> {
    return this.#engine.removeTags(this.id, ...tags);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    const queue: WorkflowHandleEventQueue = { events: [], resolver: undefined };
    const state = { done: false };
    const listener = enqueueWorkflowHandleEvent.bind(undefined, queue);
    const terminal = finishWorkflowHandleIteration.bind(undefined, state, queue);

    // Non-terminal events use the plain enqueuing listener; terminal events
    // use `terminal`, which both enqueues the event AND sets `state.done =
    // true`. Registering `listener` and `terminal` on the same type would
    // enqueue the terminal event twice, so terminal types are handled only by
    // `terminal`.
    const nonTerminalTypes = ['activity:started', 'activity:completed', 'signal:received'];
    const terminalTypes = [
      'workflow:completed',
      'workflow:failed',
      'workflow:cancelled',
      'workflow:timed-out',
    ];

    for (const type of nonTerminalTypes) {
      this.addEventListener(type, listener);
    }
    for (const type of terminalTypes) {
      this.addEventListener(type, terminal);
    }

    try {
      // Guard against the "started iterating after workflow already finished"
      // hang: terminal events fire exactly once and are not replayed, so a
      // consumer that attaches listeners post-termination would wait forever.
      // We intentionally attach listeners BEFORE checking persisted status so
      // the race is trivially safe — if the workflow transitions between
      // listener attachment and the status read, the real event is already
      // queued and `state.done` is true, and we skip synthesis.
      if (!state.done) {
        const persisted = await this.#engine.get(this.id);
        if (persisted && !state.done) {
          const synthetic = synthesizeTerminalEventFromState(persisted);
          if (synthetic) {
            queue.events.push(synthetic);
            state.done = true;
          }
        }
      }

      while (!state.done || queue.events.length > 0) {
        if (queue.events.length === 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          queue.resolver = resolve;
          await promise;
          queue.resolver = undefined;
        }
        while (queue.events.length > 0) {
          yield queue.events.shift()!;
        }
      }
    } finally {
      for (const type of nonTerminalTypes) {
        this.removeEventListener(type, listener);
      }
      for (const type of terminalTypes) {
        this.removeEventListener(type, terminal);
      }
    }
  }

  [Symbol.observable](): {
    subscribe: (observer: {
      next?: (event: Event) => void;
      complete?: () => void;
      error?: (error: Error) => void;
    }) => { unsubscribe: () => void };
  } {
    return {
      subscribe: (observer: {
        next?: (event: Event) => void;
        complete?: () => void;
        error?: (error: Error) => void;
      }) => {
        const controller = new AbortController();
        const nextListener = observer.next?.bind(observer);

        const types = [
          'workflow:completed',
          'workflow:failed',
          'workflow:cancelled',
          'workflow:timed-out',
          'activity:started',
          'activity:completed',
        ];

        // Track whether the subscription has been terminated (via `complete`
        // or `error`). Per the Observable contract these are mutually
        // exclusive — once one fires, the subscription is closed and no
        // further `next`/`error`/`complete` notifications may be delivered.
        // This flag is checked by EVERY listener (not just error/complete)
        // so that a late real terminal event arriving after a synthesized
        // one cannot re-emit `observer.next` after the subscription is
        // already closed.
        let terminalDelivered = false;

        if (nextListener) {
          const guardedNext = (event: Event) => {
            if (terminalDelivered) return;
            nextListener(event);
          };
          for (const type of types) {
            this.addEventListener(type, guardedNext, { signal: controller.signal });
          }
        }

        // errorHandler terminates the subscription with `error` for the two
        // error-terminal event types and marks the subscription delivered so
        // the `complete` dispatcher below does not also fire — per the
        // Observable contract, `error` and `complete` are mutually exclusive.
        const errorHandler = (event: Event) => {
          if (terminalDelivered) return;
          if (event instanceof WorkflowFailedEvent) {
            terminalDelivered = true;
            observer.error?.(event.error);
          } else if (event instanceof WorkflowTimedOutEvent) {
            terminalDelivered = true;
            observer.error?.(
              new WorkflowTimeoutError(event.workflowId, event.timeoutType, event.elapsed),
            );
          }
        };
        this.addEventListener('workflow:failed', errorHandler, { signal: controller.signal });
        this.addEventListener('workflow:timed-out', errorHandler, { signal: controller.signal });

        // completeDispatcher fires `complete()` on the two non-error terminal
        // statuses. Previously only `workflow:completed` was wired, which
        // meant subscribers to a cancelled workflow never saw `complete` —
        // this closes that latent bug. `failed` and `timed-out` deliberately
        // do not register here because they terminate via `error` instead.
        const completeListener = observer.complete?.bind(observer);
        const completeDispatcher = () => {
          if (terminalDelivered) return;
          terminalDelivered = true;
          completeListener?.();
        };
        this.addEventListener('workflow:completed', completeDispatcher, {
          signal: controller.signal,
        });
        this.addEventListener('workflow:cancelled', completeDispatcher, {
          signal: controller.signal,
        });

        // Guard against the "subscribed after workflow already finished"
        // hang: terminal events fire once and are not replayed. Listeners
        // are attached synchronously above, so if the workflow transitions
        // between attachment and the async status read, the real event wins
        // and `terminalDelivered` is set, causing us to skip synthesis.
        //
        // We deliver the synthetic event directly to this subscription's
        // handlers rather than via `this.dispatchEvent(...)`, which would
        // broadcast the event to every other listener on the handle
        // (concurrent iterators, other observables, application code). The
        // synthetic event is a private reconstruction for this subscription
        // alone and must not leak into the handle's global dispatch stream.
        void (async () => {
          const persisted = await this.#engine.get(this.id);
          if (controller.signal.aborted || terminalDelivered || !persisted) return;
          const synthetic = synthesizeTerminalEventFromState(persisted);
          if (!synthetic) return;
          // Mirror the dispatch order EventTarget would use: next → error or
          // complete. The `terminalDelivered` guard is already respected
          // inside each handler.
          nextListener?.(synthetic);
          if (synthetic instanceof WorkflowFailedEvent) {
            errorHandler(synthetic);
          } else if (synthetic instanceof WorkflowTimedOutEvent) {
            errorHandler(synthetic);
          } else {
            completeDispatcher();
          }
        })();

        return {
          unsubscribe: controller.abort.bind(controller),
        };
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // No-op for now; handles are lightweight
  }
}

export class ScheduleHandle {
  readonly id: string;
  readonly #engine: Engine;
  readonly #accessOptions: ScheduleAccessOptions | undefined;

  constructor(id: string, engine: Engine, accessOptions?: ScheduleAccessOptions) {
    this.id = id;
    this.#engine = engine;
    this.#accessOptions = accessOptions;
  }

  async pause(): Promise<void> {
    await this.#engine.pauseSchedule(this.id, this.#accessOptions);
  }

  async resume(): Promise<void> {
    await this.#engine.resumeSchedule(this.id, this.#accessOptions);
  }

  async cancel(): Promise<void> {
    await this.#engine.cancelSchedule(this.id, this.#accessOptions);
  }

  async update(newCronExpression: string): Promise<void> {
    await this.#engine.updateSchedule(this.id, newCronExpression, this.#accessOptions);
  }

  async describe(): Promise<ScheduleSummary> {
    const schedule = await this.#engine.getSchedule(this.id, this.#accessOptions);
    if (!schedule) {
      throw new Error(`Schedule "${this.id}" not found`);
    }
    return schedule;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Durable execution engine.
 *
 * Register workflow functions with {@link Engine.register}, start them with
 * {@link Engine.start}, and query or cancel them via the returned
 * {@link WorkflowHandle}. Each workflow is a generator that yields to a
 * {@link Context}; the engine persists a checkpoint at every yield so the
 * workflow survives crashes, restarts, and worker reassignment without
 * losing progress.
 *
 * @example Run a workflow with an activity
 * ```ts
 * import { Engine, activity } from 'weft';
 *
 * const fetchUser = activity('fetchUser', async (id: string) => {
 *   const response = await fetch(`https://api.example.com/users/${id}`);
 *   return response.json();
 * });
 *
 * const engine = new Engine();
 * engine.register('greet-user', async function* (ctx, id: string) {
 *   const user = yield* ctx.run(fetchUser, id);
 *   return `Hello, ${(user as { name: string }).name}`;
 * });
 *
 * const handle = await engine.start('greet-user', 'user-123');
 * const greeting = await handle.result();
 * ```
 *
 * @example Run with a SQLite backend
 * ```ts
 * import { Engine } from 'weft';
 * import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';
 *
 * await using storage = new BunSQLiteStorage('./weft.db');
 * await using engine = new Engine({ storage });
 * // ...register and start workflows
 * ```
 */
export class Engine extends EventTarget implements Disposable, AsyncDisposable {
  #storage: WeftStorage;
  #registrations: Map<string, RegistrationEntry>;
  #workflowTypesByHandler: WeakMap<Function, string>;
  #abortController: AbortController;
  #scheduler: Scheduler;
  #options: ResolvedOptions;
  #strategy: ExecutionStrategy;
  #inlineStrategy: InlineExecutionStrategy | null;
  #handleCache: Map<string, { ref: WeakRef<WorkflowHandle>; unregisterToken: object }>;
  #finalizationRegistry: FinalizationRegistry<string>;
  #resultResolvers: Map<string, WorkflowResultResolver>;
  #signalWaiters: Map<string, () => void>;
  #signalWaitersByWorkflow: Map<string, Set<string>>;
  #updateWaiters: Map<string, (payload: unknown) => void>;
  #updateWaitersByWorkflow: Map<string, Set<string>>;
  #sleepResolvers: Map<string, () => void>;
  #sleepResolversByWorkflow: Map<string, Set<string>>;
  #interceptors: WorkflowInterceptor[];
  #activityInterceptors: ActivityInterceptor[];
  #composedWorkflowInterceptor: ComposedWorkflowInterceptor | null;
  #composedActivityInterceptor: ComposedActivityInterceptor | null;
  #updateCoordinator: UpdateCoordinator;
  #activityRegistry: ActivityRegistry;
  #activityWorkerDispatcher: ActivityWorkerDispatcher | null;
  #checkpoints: Map<string, Checkpoint>;
  #broadcastChannel: BroadcastChannel | null;
  #pendingNestingDepth: number | undefined;
  #pendingParentHeaders: Map<string, string> | undefined;
  #workflowNestingDepths: Map<string, number>;
  #workflowHeaders: Map<string, Map<string, string>>;
  #workflowStateWriteChains: Map<string, Promise<void>>;
  #budgetPolicyEnforcer: import('../ai/budget-policy.ts').BudgetPolicyEnforcer | null;
  #tenantQuotaManager: TenantQuotaManager;
  #heartbeatDetails: Map<string, unknown>;
  #pendingStarts: Set<string>;
  #pendingScheduleCreations: Set<string>;
  /**
   * Dedup set for recorded agent operation budget costs. Entries live here
   * for the lifetime of their parent workflow and are removed in
   * `#cleanupTerminalWorkflow` so the set does not grow unbounded.
   *
   * Removal is O(1) per workflow because `#chargedAgentOperationsByWorkflow`
   * keeps a reverse index — see `#recordAgentBudgetCost` for the write path.
   */
  #chargedAgentOperations: Set<string>;
  /**
   * Reverse index from `workflowId` to the set of operation ids it charged.
   * Lets terminal-state cleanup drop the workflow's dedup entries in O(k)
   * where k is that workflow's agent operation count, rather than scanning
   * the engine-wide `#chargedAgentOperations` set.
   */
  #chargedAgentOperationsByWorkflow: Map<string, Set<string>>;
  #cleanupInterval: ReturnType<typeof setInterval> | null;
  #retentionSweepInterval: ReturnType<typeof setInterval> | null;
  #retentionSweepInFlight: Promise<void> | null;
  #nextRetentionSweepAt: number | null;
  #defaultModelRouter: import('../ai/model-router.ts').ModelRouter | undefined;
  #reviewCoordinator: ReviewCoordinator;
  #reviewWaiters: Map<string, (decision: HumanReviewResult) => void>;
  #reviewWaitersByWorkflow: Map<string, Set<string>>;
  #reviewEscalationHandlers: Map<
    string,
    (entry: { id: string; workflowId: string }) => Promise<boolean>
  >;
  #workflowReviewIds: Map<string, Set<string>>;
  /** Timer IDs scheduled for each review (escalation + timeout), keyed by reviewId. */
  #reviewTimerIds: Map<string, string[]>;
  #pendingWebhooks: Set<AbortController>;
  #alertManager: AlertManager | null;
  /** Tracks workflow IDs that belong to agent-typed workflows for optimization. */
  #agentWorkflowIds = new Set<string>();
  /**
   * In-memory cache of the event log head for each workflow.
   * Avoids a storage.get() in the checkpoint hot path by keeping the latest
   * sequence number and hash in memory. Cleared when a workflow is cleaned up.
   */
  #eventLogHeads: Map<string, Readonly<EventHeadRecord>> = new Map();
  /**
   * Unified post-commit listener registry keyed by
   * `${workflowId}\0${selector}`. Populated by
   * `subscribeWorkflowFeedCommits()` — the production
   * `WorkflowEventFeedBackend` registers here so that replay and live
   * emission share the same committed sequence authority.
   *
   * Invoked from `#processContextOperation` after `storage.batch()`
   * resolves (events selector) and from `#writeStreamChunks` after
   * each `storage.put()` resolves (tokens selector). Listener
   * exceptions — sync throws and async rejections — are trapped so a
   * misbehaving subscriber cannot corrupt the checkpoint or stream-
   * write hot paths.
   *
   * NUL (`\0`) is a safe key separator: workflow IDs are validated
   * against `ID_PATTERN` (alphanumeric + `-`, `_`) and selectors are
   * a fixed two-member union, so no legal value can contain `\0`.
   */
  #workflowFeedListeners: Map<string, Set<WorkflowFeedListener>> = new Map();
  /**
   * In-memory cache of the workflow version tuple for each active workflow.
   * Populated at start/resume time and forwarded to event-log entries so every
   * checkpoint carry the workflow/agent/tool versions that were current when
   * the checkpoint was written.
   */
  #workflowVersionTuples: Map<string, WorkflowVersionTuple> = new Map();
  #pendingTimelineEntries: Map<string, PendingTimelineEntry>;

  constructor(options?: EngineConstructorOptions) {
    super();

    this.#registrations = new Map();
    this.#workflowTypesByHandler = new WeakMap();

    const storage = resolveEngineStorage(options, this.#getAgentWorkflowIds.bind(this));
    const getNow = options?.getNow ?? Date.now;
    const resolvedOptions = resolveEngineOptions(storage, options, getNow);
    const strategyBundle = createExecutionStrategyBundle({
      options,
      getNow,
      maxNestingDepth: resolvedOptions.maxNestingDepth,
      development: resolvedOptions.development,
      broadcastEvents: resolvedOptions.broadcastEvents,
      getRegistration: this.#registrations.get.bind(this.#registrations),
      resolveWorkflowType: this.#resolveWorkflowTypeTarget.bind(this),
    });

    this.#storage = storage;
    this.#abortController = new AbortController();
    this.#handleCache = new Map();
    this.#resultResolvers = new Map();
    this.#signalWaiters = new Map();
    this.#signalWaitersByWorkflow = new Map();
    this.#updateWaiters = new Map();
    this.#updateWaitersByWorkflow = new Map();
    this.#sleepResolvers = new Map();
    this.#sleepResolversByWorkflow = new Map();
    this.#interceptors = [];
    this.#activityInterceptors = [];
    this.#composedWorkflowInterceptor = null;
    this.#composedActivityInterceptor = null;
    this.#updateCoordinator = new UpdateCoordinator(storage);
    this.#activityRegistry = new ActivityRegistry();
    this.#activityWorkerDispatcher = null;
    this.#checkpoints = new Map();
    this.#broadcastChannel = null;
    this.#pendingNestingDepth = undefined;
    this.#pendingParentHeaders = undefined;
    this.#workflowNestingDepths = new Map();
    this.#workflowHeaders = new Map();
    this.#workflowStateWriteChains = new Map();
    this.#finalizationRegistry = new FinalizationRegistry<string>(
      createHandleCacheFinalizer(this.#handleCache),
    );

    this.#options = resolvedOptions;

    this.#defaultModelRouter = options?.defaultModelRouter;
    this.#scheduler = new Scheduler({
      storage,
      onTimerFired: this.#handleTimerFired.bind(this),
      getNow,
    });
    this.#strategy = strategyBundle.strategy;
    this.#inlineStrategy = strategyBundle.inlineStrategy;

    this.#budgetPolicyEnforcer = null;
    this.#tenantQuotaManager = new TenantQuotaManager(storage, getNow, options?.quotas);
    this.#heartbeatDetails = new Map();
    this.#pendingStarts = new Set();
    this.#pendingScheduleCreations = new Set();
    this.#chargedAgentOperations = new Set();
    this.#chargedAgentOperationsByWorkflow = new Map();
    this.#reviewCoordinator = new ReviewCoordinator(storage, getNow);
    this.#reviewWaiters = new Map();
    this.#reviewWaitersByWorkflow = new Map();
    this.#reviewEscalationHandlers = new Map();
    this.#workflowReviewIds = new Map();
    this.#reviewTimerIds = new Map();
    this.#pendingWebhooks = new Set();
    this.#pendingTimelineEntries = new Map();
    this.#cleanupInterval = setInterval(
      createExpiredResponseCleanupTick(
        this.#updateCoordinator,
        this.#handleCleanupError.bind(this),
      ),
      60_000,
    );
    this.#retentionSweepInterval = null;
    this.#retentionSweepInFlight = null;
    this.#nextRetentionSweepAt = null;

    this.#activityWorkerDispatcher = createActivityWorkerDispatcher(options?.activityExecution);

    // Wire up the strategy message handler
    this.#strategy.onMessage(this.#handleStrategyMessage.bind(this));

    this.#alertManager = createAlertManagerForEngine(this, options?.alerts, getNow);
    this.#ensureRetentionSweepInterval();
  }

  #hasConfiguredRetention(): boolean {
    if (this.#options.retention !== null) {
      return true;
    }

    for (const registration of this.#registrations.values()) {
      if (registration.retention !== undefined && registration.retention !== null) {
        return true;
      }
    }

    return false;
  }

  #setNextRetentionSweepAt(): void {
    this.#nextRetentionSweepAt = this.#options.getNow() + this.#options.retentionSweepIntervalMs;
  }

  #ensureRetentionSweepInterval(): void {
    if (!this.#hasConfiguredRetention()) {
      if (this.#retentionSweepInterval !== null) {
        clearInterval(this.#retentionSweepInterval);
        this.#retentionSweepInterval = null;
      }
      this.#nextRetentionSweepAt = null;
      return;
    }

    if (this.#retentionSweepInterval !== null) {
      return;
    }

    this.#setNextRetentionSweepAt();
    this.#retentionSweepInterval = setInterval(() => {
      this.#setNextRetentionSweepAt();
      if (this.#retentionSweepInFlight !== null) {
        return;
      }

      const sweepPromise = this.#runRetentionSweep();
      const settledSweepPromise = sweepPromise.finally(() => {
        if (this.#retentionSweepInFlight === settledSweepPromise) {
          this.#retentionSweepInFlight = null;
        }
      });
      this.#retentionSweepInFlight = settledSweepPromise;
    }, this.#options.retentionSweepIntervalMs);
  }

  async #runRetentionSweep(): Promise<void> {
    try {
      await this.#purgeInternal(undefined, {
        expiredOnly: true,
        limit: this.#options.retentionSweepBatchSize,
        now: this.#options.getNow(),
      });
    } catch (error) {
      this.#handleCleanupError('retentionSweep', error);
    }
  }

  async #swallowPromiseRejection(promise: Promise<unknown> | undefined): Promise<void> {
    if (!promise) {
      return;
    }

    try {
      await promise;
    } catch {
      // Best-effort cleanup and warmup operations intentionally ignore rejections.
    }
  }

  #getAgentWorkflowIds(): ReadonlySet<string> {
    return this.#agentWorkflowIds;
  }

  async #processPendingUpdatesAfterReplay(workflowId: string): Promise<void> {
    try {
      await this.#processPendingUpdatesForHandlers(workflowId);
    } catch (error: unknown) {
      this.#handleCleanupError('processPendingUpdates', error, workflowId);
    }
  }

  async #persistCoordinatedUpdateResponse(
    workflowId: string,
    updateName: string,
    updateId: string,
    idempotencyKey: string | undefined,
    value: unknown,
  ): Promise<void> {
    const responseOperations = this.#updateCoordinator.buildResponseOperations(
      updateId,
      workflowId,
      value,
      undefined,
      idempotencyKey,
    );

    try {
      await this.#storage.batch(responseOperations);
      this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, updateName, value));
      this.#broadcast({
        type: 'update:completed',
        workflowId,
        updateId,
      });
    } catch (error: unknown) {
      this.#handleCleanupError('writeCoordinatedUpdateResponse', error, workflowId);
    }
  }

  #resolveChainedResult(
    originalResolve: (value: unknown) => void,
    chainedResolve: (value: unknown) => void,
    value: unknown,
  ): void {
    originalResolve(value);
    chainedResolve(value);
  }

  #rejectChainedResult(
    originalReject: (reason: unknown) => void,
    chainedReject: (reason: unknown) => void,
    reason: unknown,
  ): void {
    originalReject(reason);
    chainedReject(reason);
  }

  #resolveReviewDecision(
    resolve: (result: { ok: true; value: HumanReviewResult }) => void,
    decision: HumanReviewResult,
  ): void {
    resolve({ ok: true, value: decision });
  }

  /** Register a waiter key in a workflow-keyed reverse index. */
  #trackWaiterKey(
    reverseIndex: Map<string, Set<string>>,
    workflowId: string,
    waiterKey: string,
  ): void {
    let keys = reverseIndex.get(workflowId);
    if (!keys) {
      keys = new Set();
      reverseIndex.set(workflowId, keys);
    }
    keys.add(waiterKey);
  }

  /** Remove a waiter key from a workflow-keyed reverse index. */
  #untrackWaiterKey(
    reverseIndex: Map<string, Set<string>>,
    workflowId: string,
    waiterKey: string,
  ): void {
    const keys = reverseIndex.get(workflowId);
    if (keys) {
      keys.delete(waiterKey);
      if (keys.size === 0) reverseIndex.delete(workflowId);
    }
  }

  async #handleReviewEscalationTimer(
    workflowId: string,
    reviewId: string,
    waiterKey: string,
    reviewRequest: import('../ai/human-review.ts').ReviewRequest,
    options: HumanReviewOptions,
    resolve: (result: { ok: true; value: HumanReviewResult } | { ok: false; error: Error }) => void,
    entry: { id: string; workflowId: string },
  ): Promise<boolean> {
    if (
      !entry.id.startsWith(`review-escalation:${reviewId}:`) &&
      entry.id !== `review-timeout:${reviewId}`
    ) {
      return false;
    }

    if (entry.id === `review-timeout:${reviewId}`) {
      this.#reviewWaiters.delete(waiterKey);
      this.#untrackWaiterKey(this.#reviewWaitersByWorkflow, workflowId, waiterKey);
      const elapsed = this.#options.getNow() - reviewRequest.createdAt;
      await this.#storage.delete(KEYS.review(workflowId, reviewId));

      const timeoutError = new ReviewTimeoutError(reviewId, elapsed);
      await this.#failWorkflow(workflowId, timeoutError);
      resolve({ ok: false, error: timeoutError });
      return true;
    }

    if (!options.escalation) {
      return false;
    }

    const action = this.#reviewCoordinator.checkEscalations(
      reviewRequest,
      options.escalation,
      this.#options.getNow(),
    );

    if (!action) {
      return false;
    }

    if (action.type === 'escalate') {
      options.onEscalation?.(action);
      return false;
    }

    this.#reviewWaiters.delete(waiterKey);
    this.#untrackWaiterKey(this.#reviewWaitersByWorkflow, workflowId, waiterKey);
    const autoResult: HumanReviewResult = {
      reviewId,
      decision: action.decision,
      reviewer: 'system',
      feedback: action.auditReason,
      timestamp: this.#options.getNow(),
    };

    await this.#storage.delete(KEYS.review(workflowId, reviewId));
    resolve({ ok: true, value: autoResult });
    return true;
  }

  async #sendReviewWebhook(
    workflowId: string,
    reviewRequest: import('../ai/human-review.ts').ReviewRequest,
    webhookUrl: string,
    webhookAbort: AbortController,
  ): Promise<void> {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId,
          reviewId: reviewRequest.reviewId,
          reviewType: reviewRequest.reviewType,
          reviewers: reviewRequest.reviewers,
          artifact: reviewRequest.artifact,
        }),
        signal: webhookAbort.signal,
      });
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn(`[weft] Failed to send review webhook for ${reviewRequest.reviewId}`, error);
      }
    } finally {
      this.#pendingWebhooks.delete(webhookAbort);
    }
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  register(name: string, handler: WorkflowFunction | StepWorkflowFunction): void;
  register(name: string, registration: WorkflowRegistration): void;
  register(agentDef: AgentDefinition, options: AgentRegistrationOptions): void;
  register(
    nameOrAgent: string | AgentDefinition,
    handlerOrRegistrationOrOptions?:
      | WorkflowFunction
      | StepWorkflowFunction
      | WorkflowRegistration
      | AgentRegistrationOptions,
  ): void {
    // --- AgentDefinition overload ---
    if (isAgentDefinition(nameOrAgent)) {
      const agentDef = nameOrAgent;
      const agentOptions = handlerOrRegistrationOrOptions as AgentRegistrationOptions;
      const agentVersion = agentDef.version ?? '0.0.0';
      const workflowVersion = '1';
      const resolveEffectiveTools = (tenant: import('./tenant.ts').TenantContext | undefined) =>
        agentDef.toolsForTenant ? agentDef.toolsForTenant(tenant) : agentDef.tools;
      const resolveVersionTuple = (
        tenant: import('./tenant.ts').TenantContext | undefined,
      ): WorkflowVersionTuple => {
        const effectiveTools = resolveEffectiveTools(tenant);
        return {
          workflowVersion,
          agentVersion,
          ...(effectiveTools &&
            effectiveTools.length > 0 && {
              toolVersions: collectToolVersions(effectiveTools),
            }),
        };
      };

      // Build a workflow function that delegates to ctx.agent(), ensuring the
      // agent execution flows through the engine's operation handler for budget
      // policy enforcement, observability, and durable checkpointing.
      const handler: WorkflowFunction = async function* (ctx, input) {
        const tenant = ctx.tenant;

        // Per-tenant input validation runs before any tool resolution so a
        // malformed payload fails fast without burning budget.
        if (agentDef.validateInput) {
          agentDef.validateInput(input, tenant);
        }

        // Resolve the effective tool set: per-tenant override takes precedence
        // over the static definition.
        const effectiveTools = resolveEffectiveTools(tenant);

        const prompt = typeof input === 'string' ? input : JSON.stringify(input);
        const agentOpts: import('./context.ts').AgentContextOptions = {
          model: agentDef.model,
          prompt,
          provider: agentOptions.provider,
        };
        if (agentDef.systemPrompt) agentOpts.systemPrompt = agentDef.systemPrompt;
        if (effectiveTools) agentOpts.tools = effectiveTools;
        if (agentDef.maxTurns !== undefined) agentOpts.maxTurns = agentDef.maxTurns;
        if (agentDef.budget) agentOpts.budget = agentDef.budget;
        if (agentDef.modelRouter) agentOpts.modelRouter = agentDef.modelRouter;
        if (agentDef.contextStrategy) agentOpts.contextStrategy = agentDef.contextStrategy;
        if (agentDef.hooks) agentOpts.hooks = agentDef.hooks;

        const result = yield* (ctx as Context).agent(agentOpts);
        return result;
      };

      const agentRegistrationEntry: RegistrationEntry = {
        handler,
        version: workflowVersion,
        isAgent: true,
        provider: agentOptions.provider,
        versionTupleForTenant: resolveVersionTuple,
      };

      this.#registrations.set(agentDef.name, agentRegistrationEntry);
      this.#ensureRetentionSweepInterval();
      this.#workflowTypesByHandler.set(handler, agentDef.name);
      return;
    }

    // --- Existing overloads (name + handler/registration) ---
    const name = nameOrAgent;
    const handlerOrRegistration = handlerOrRegistrationOrOptions as
      | WorkflowFunction
      | StepWorkflowFunction
      | WorkflowRegistration;

    const isRegistration =
      typeof handlerOrRegistration === 'object' &&
      handlerOrRegistration !== null &&
      'handler' in handlerOrRegistration;

    if (isRegistration) {
      const registration = handlerOrRegistration;
      const normalizedRetention = normalizeRetentionPolicy(
        registration.retention,
        `registration("${name}").retention`,
      );
      const entry: RegistrationEntry = {
        handler: registration.handler,
        version: registration.version ?? '1',
        ...(normalizedRetention !== null && { retention: normalizedRetention }),
      };
      if (registration.migrate) {
        entry.migrate = registration.migrate;
      }
      if (registration.searchAttributes) {
        entry.searchAttributes = registration.searchAttributes;
      }
      if (registration.constraints && registration.constraints.length > 0) {
        // Constraints are only evaluated by the inline execution strategy —
        // `#evaluateConstraints` reads per-workflow context via
        // `this.#inlineStrategy.getContext(...)`. In worker execution mode the
        // inline strategy is absent, so every constraint would be silently
        // skipped. Fail loud at registration time rather than swallowing the
        // invariant at runtime.
        if (this.#inlineStrategy === null) {
          throw new Error(
            `Cannot register workflow "${name}" with constraints: constraints are not supported in worker execution mode. ` +
              `The engine was constructed with \`workerExecution\`, which runs workflows in a Web Worker where the inline ` +
              `execution context required by constraint evaluation is unavailable. Remove the \`constraints\` option, or ` +
              `construct the engine without \`workerExecution\` to run workflows inline.`,
          );
        }
        entry.constraints = registration.constraints;
      }
      this.#registrations.set(name, entry);
      this.#ensureRetentionSweepInterval();
      this.#workflowTypesByHandler.set(registration.handler, name);
    } else {
      // Auto-detect step-based (non-generator) workflow functions and compile them
      const originalHandler = handlerOrRegistration;
      let handler = handlerOrRegistration;
      if (typeof handler === 'function' && !isAsyncGeneratorFunction(handler)) {
        handler = compileStepWorkflow(handler as StepWorkflowFunction);
      }

      this.#registrations.set(name, {
        handler: handler as WorkflowFunction,
        version: '1',
      });
      this.#ensureRetentionSweepInterval();
      if (typeof originalHandler === 'function') {
        this.#workflowTypesByHandler.set(originalHandler, name);
      }
      if (typeof handler === 'function') {
        this.#workflowTypesByHandler.set(handler, name);
      }
    }
  }

  #resolveWorkflowTypeTarget(target: string | Function): string {
    if (typeof target === 'string') {
      return target;
    }

    const registeredType = this.#workflowTypesByHandler.get(target);
    if (registeredType) {
      return registeredType;
    }

    throw new Error(
      'Workflow functions used in composition operators must be registered before use. ' +
        'Pass the registered workflow type string or register the function on the engine first.',
    );
  }

  // -------------------------------------------------------------------------
  // Interceptor registration
  // -------------------------------------------------------------------------

  addInterceptor(interceptor: WorkflowInterceptor): void {
    this.#interceptors.push(interceptor);
    this.#composedWorkflowInterceptor = null;
  }

  addActivityInterceptor(interceptor: ActivityInterceptor): void {
    this.#activityInterceptors.push(interceptor);
    this.#composedActivityInterceptor = null;
  }

  #getComposedWorkflowInterceptor(): ComposedWorkflowInterceptor | null {
    if (this.#interceptors.length === 0) return null;
    this.#composedWorkflowInterceptor ??= composeWorkflowInterceptors(this.#interceptors);
    return this.#composedWorkflowInterceptor;
  }

  #getComposedActivityInterceptor(): ComposedActivityInterceptor | null {
    if (this.#activityInterceptors.length === 0) return null;
    this.#composedActivityInterceptor ??= composeActivityInterceptors(this.#activityInterceptors);
    return this.#composedActivityInterceptor;
  }

  // -------------------------------------------------------------------------
  // Activity registration (for worker-based execution)
  // -------------------------------------------------------------------------

  /**
   * Register a named activity function. In worker mode, the generator yields
   * an operation request with `activityName` (not a function reference). The
   * engine uses this registry to look up the function by name and execute it
   * on the main thread.
   *
   * If `fn` was created via the `activity()` helper, metadata (retry, timeout,
   * queue, idempotent) is auto-extracted from its colocated properties.
   * Explicit `options` take precedence over auto-extracted values.
   */
  registerActivity(
    name: string,
    fn: (...arguments_: unknown[]) => unknown,
    options?: ActivityRegistrationOptions,
  ): void {
    this.#activityRegistry.register(name, fn, options);
  }

  // -------------------------------------------------------------------------
  // Start workflow
  // -------------------------------------------------------------------------

  async start(type: string, input: unknown, options?: StartOptions): Promise<WorkflowHandle> {
    return this.#startWorkflow(type, input, options);
  }

  async #startWorkflow(
    type: string,
    input: unknown,
    options?: StartOptions,
    tenantOverride?: { resolved: import('./tenant.ts').TenantContext | undefined },
    additionalStartOperations?: import('../storage/interface.ts').BatchOperation[],
  ): Promise<WorkflowHandle> {
    const registration = this.#registrations.get(type);
    if (!registration) {
      throw new Error(`No workflow registered with name "${type}"`);
    }

    const callerProvidedId = options?.id !== undefined;
    const workflowId =
      options?.id !== undefined
        ? coerceStartWorkflowId(options.id, 'options.id')
        : crypto.randomUUID();

    // Capture and clear pending parent headers immediately, before any async
    // work, to prevent a concurrent child-workflow start from overwriting them.
    const parentHeaders = this.#pendingParentHeaders;
    this.#pendingParentHeaders = undefined;
    const submissionTime = this.#options.getNow();
    const scheduledStartAt = this.#resolveScheduledStartAt(options, submissionTime);
    const normalizedTags = this.#normalizeStartWorkflowTags(options?.tags);
    const delayedStartTimer =
      scheduledStartAt !== undefined && scheduledStartAt > submissionTime
        ? this.#createDelayedStartTimerEntry(workflowId, scheduledStartAt, options)
        : undefined;

    // Atomic check-and-reserve: prevent two concurrent start() calls with the
    // same ID from both passing the storage check before either writes state.
    if (this.#pendingStarts.has(workflowId)) {
      throw new WorkflowAlreadyExistsError(workflowId);
    }
    this.#pendingStarts.add(workflowId);
    let startSucceeded = false;

    try {
      // Only hit storage to dedup when the caller supplied the id. A
      // freshly-generated v4 UUID is (for all practical purposes) unique, so
      // the extra round trip is wasted work on the hot start path. This is
      // the dominant optimization behind the workflow-start benchmark — the
      // get → batch sequence was two storage calls per start, now one.
      if (callerProvidedId) {
        const existingBytes = await this.#storage.get(KEYS.workflow(workflowId));
        if (existingBytes !== null) {
          throw new WorkflowAlreadyExistsError(workflowId);
        }
      }

      // Resolve the tenant context before the first checkpoint is written so
      // it gets persisted as part of the initial state blob.
      const tenant = tenantOverride
        ? tenantOverride.resolved
        : await this.#resolveTenantForStart(workflowId, type, input);
      const versionTuple = this.#createWorkflowVersionTuple(registration, tenant);

      const state = this.#createInitialWorkflowState(
        workflowId,
        type,
        input,
        versionTuple,
        options,
        normalizedTags,
        tenant,
        delayedStartTimer,
      );
      const checkpoint = this.#createInitialCheckpoint(
        workflowId,
        versionTuple.workflowVersion,
        options,
      );
      const workflowStartHeaders = this.#runWorkflowStartInterceptor(
        workflowId,
        type,
        input,
        parentHeaders,
      );
      const persistedWorkflowStartHeaders =
        selectPersistedWorkflowStartHeaders(workflowStartHeaders);
      this.#checkpoints.set(workflowId, checkpoint);
      this.#setWorkflowStartHeaders(workflowId, workflowStartHeaders);

      // Cache the workflow version tuple for forwarding to event-log entries.
      this.#workflowVersionTuples.set(workflowId, versionTuple);

      // Agent optimization: register before the initial storage batch so the
      // first checkpoint write uses agent-specific compression (brotli).
      if (registration.isAgent) {
        this.#agentWorkflowIds.add(workflowId);
      }

      const startOperations = this.#buildStartBatchOperations(
        workflowId,
        state,
        checkpoint,
        registration,
        options,
        state.executionDeadline,
        delayedStartTimer,
        persistedWorkflowStartHeaders,
        additionalStartOperations,
      );

      if (tenant !== undefined) {
        const tenantQuotaManager = this.#tenantQuotaManager;
        await tenantQuotaManager.commitStartAdmission({
          tenantId: tenant.id,
          workflowId,
          startOperations,
          get estimatedStorageBytes() {
            return tenantQuotaManager.estimateStartStorageBytes(workflowId, startOperations);
          },
        });
      } else {
        await this.#storage.batch(startOperations);
      }
      // Deadline timer operations are now folded into the start batch above,
      // eliminating a separate storage transaction on the hot start path.

      const handle = this.#createWorkflowHandle(workflowId);
      if (!delayedStartTimer) {
        this.#beginWorkflowExecution(
          workflowId,
          type,
          input,
          checkpoint,
          state.executionDeadline,
          tenant,
          registration,
        );
      }
      startSucceeded = true;
      return handle;
    } finally {
      this.#pendingStarts.delete(workflowId);
      if (!startSucceeded) {
        this.#checkpoints.delete(workflowId);
        this.#workflowHeaders.delete(workflowId);
        this.#workflowVersionTuples.delete(workflowId);
        if (registration.isAgent) {
          this.#agentWorkflowIds.delete(workflowId);
        }
      }
    }
  }

  #resolveScheduledStartAt(
    options: StartOptions | undefined,
    submissionTime: number,
  ): number | undefined {
    assertExclusiveStartWorkflowOptions(options?.startAt, options?.startAfter);

    if (options?.startAt !== undefined) {
      return coerceStartWorkflowTimestamp(options.startAt, 'options.startAt');
    }

    if (options?.startAfter !== undefined) {
      const startAfterMilliseconds = this.#parseStartOptionDuration(
        options.startAfter,
        'options.startAfter',
      );
      try {
        return normalizeStorageTimestamp(
          submissionTime + startAfterMilliseconds,
          'options.startAfter',
        );
      } catch {
        throw new StartWorkflowValidationError(
          'options.startAfter must resolve to a finite, non-negative start time',
        );
      }
    }

    return undefined;
  }

  #parseStartOptionDuration(
    duration: import('./types.ts').Duration,
    fieldName: 'options.executionTimeout' | 'options.startAfter',
  ): number {
    return parseStartWorkflowDuration(duration, fieldName);
  }

  #createDelayedStartTimerEntry(
    workflowId: string,
    scheduledStartAt: number,
    options: StartOptions | undefined,
  ): TimerEntry {
    return {
      id: `delayed-start:${workflowId}`,
      workflowId,
      fireAt: scheduledStartAt,
      kind: 'delayed-start',
      ...(options?.executionTimeout !== undefined && {
        executionTimeoutMs: this.#parseStartOptionDuration(
          options.executionTimeout,
          'options.executionTimeout',
        ),
      }),
    };
  }

  #beginWorkflowExecution(
    workflowId: string,
    workflowType: string,
    input: unknown,
    checkpoint: Checkpoint,
    executionDeadline: number | undefined,
    tenant: import('./tenant.ts').TenantContext | undefined,
    registration: RegistrationEntry,
  ): void {
    this.#warmupWorkflowRegistration(registration);

    this.dispatchEvent(new WorkflowStartedEvent(workflowId, workflowType, input));
    this.#startWorkflowExecution(
      workflowId,
      workflowType,
      input,
      checkpoint,
      executionDeadline,
      tenant,
    );
  }

  #warmupWorkflowRegistration(registration: RegistrationEntry): void {
    if (!registration.isAgent) {
      return;
    }

    try {
      const warmupResult = registration.provider?.warmup?.();
      void this.#swallowPromiseRejection(warmupResult);
    } catch {
      // Warmup is best-effort; ignore synchronous failures.
    }
  }

  // -------------------------------------------------------------------------
  // Handle retrieval
  // -------------------------------------------------------------------------

  getHandle(workflowId: string): WorkflowHandle {
    // Check cache
    const entry = this.#handleCache.get(workflowId);
    if (entry) {
      const existing = entry.ref.deref();
      if (existing) return existing;
    }

    // Create a new handle. We need a result promise.
    const existingResolver = this.#resultResolvers.get(workflowId);
    let resultPromise: Promise<unknown>;

    if (existingResolver) {
      // Workflow is still running; create a new promise that chains off the resolver
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const originalResolve = existingResolver.resolve;
      const originalReject = existingResolver.reject;
      existingResolver.resolve = this.#resolveChainedResult.bind(this, originalResolve, resolve);
      existingResolver.reject = this.#rejectChainedResult.bind(this, originalReject, reject);
      resultPromise = promise;
    } else {
      // The workflow may be terminal, actively running, or still pending.
      // Bootstrap a durable resolver from persisted state so handles created
      // after a restart can still wait for future completion.
      resultPromise = this.#createDeferredWorkflowResultPromise(workflowId);
    }

    return this.#createWorkflowHandleWithResultPromise(workflowId, resultPromise);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    const normalizedTagFilters = normalizeWorkflowTags(filter?.tags);
    const constrainedIds = await this.#resolveConstrainedIds(filter, normalizedTagFilters);

    const items: WorkflowSummary[] = [];

    // Fast path: when tag or attribute filters constrained the set of
    // candidate IDs, load only those rows by key instead of scanning every
    // `wf:*` entry.
    // This turns the cost from O(total workflows) into O(matches), which is
    // the shape the architecture "<1ms single-attribute equality" target
    // assumes.
    if (constrainedIds !== null) {
      // Parallelize storage reads. On in-memory backends this is essentially
      // free; on remote backends (network KV, S3-backed) it converts N
      // sequential round-trips into a single fan-out, which is what the
      // architecture's <1ms attribute-equality target relies on.
      // `Promise.all` preserves input order, so iterating the resolved array
      // in lockstep with the original id list keeps results deterministic
      // (insertion order from the attribute index intersection).
      const orderedIds = [...constrainedIds];
      const stateBytesList = await Promise.all(
        orderedIds.map((workflowId) => this.#storage.get(KEYS.workflow(workflowId))),
      );

      for (const stateBytes of stateBytesList) {
        if (!stateBytes) continue;

        const state = decodeWorkflowState(stateBytes);
        if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;

        items.push({
          id: state.id,
          type: state.type,
          status: state.status,
          ...(state.tags !== undefined && { tags: state.tags }),
          version: state.version,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        });
      }
      return paginateWorkflowSummaries(items, filter);
    }

    for await (const [key, value] of this.#storage.scan('wf:')) {
      if (!this.#isTopLevelWorkflowStateKey(key)) continue;

      const state = decodeWorkflowState(value);
      if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;

      items.push({
        id: state.id,
        type: state.type,
        status: state.status,
        ...(state.tags !== undefined && { tags: state.tags }),
        version: state.version,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    }

    return paginateWorkflowSummaries(items, filter);
  }

  async *#streamWorkflowStates(filter?: ListFilter): AsyncGenerator<WorkflowState> {
    const normalizedTagFilters = normalizeWorkflowTags(filter?.tags);
    const constrainedIds = await this.#resolveConstrainedIds(filter, normalizedTagFilters);

    if (constrainedIds !== null) {
      for (const workflowId of constrainedIds) {
        const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
        if (!stateBytes) continue;

        const state = decodeWorkflowState(stateBytes);
        if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;
        yield state;
      }

      return;
    }

    for await (const [key, value] of this.#storage.scan('wf:')) {
      if (!this.#isTopLevelWorkflowStateKey(key)) continue;

      const state = decodeWorkflowState(value);
      if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;
      yield state;
    }
  }

  async *#streamWorkflowStateBatches(filter?: ListFilter): AsyncGenerator<WorkflowState[]> {
    let remainingOffset = normalizeBulkFilterNumber(filter?.offset, 'offset') ?? 0;
    let remainingLimit = normalizeBulkFilterNumber(filter?.limit, 'limit');

    if (remainingLimit === 0) {
      return;
    }

    let batch: WorkflowState[] = [];

    for await (const state of this.#streamWorkflowStates(filter)) {
      if (remainingOffset > 0) {
        remainingOffset -= 1;
        continue;
      }

      batch.push(state);

      if (remainingLimit !== undefined) {
        remainingLimit -= 1;
      }

      if (batch.length === BULK_OPERATION_BATCH_SIZE) {
        yield batch;
        batch = [];
      }

      if (remainingLimit === 0) {
        break;
      }
    }

    if (batch.length > 0) {
      yield batch;
    }
  }

  #buildActionableBulkWorkflowFilter(
    filter: ListFilter,
    actionableStatuses: WorkflowStatus[],
  ): ListFilter {
    const requestedStatuses =
      filter.status === undefined
        ? actionableStatuses
        : Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
    const effectiveStatuses = requestedStatuses.filter((status) =>
      actionableStatuses.includes(status),
    );

    if (effectiveStatuses.length === 0) {
      return {
        ...filter,
        status: [],
      };
    }

    if (effectiveStatuses.length === 1) {
      const [effectiveStatus] = effectiveStatuses;
      if (effectiveStatus === undefined) {
        return {
          ...filter,
          status: [],
        };
      }

      return {
        ...filter,
        status: effectiveStatus,
      };
    }

    return {
      ...filter,
      status: effectiveStatuses,
    };
  }

  #toBulkOperationError(workflowId: string, error: unknown): BulkOperationError {
    return {
      id: workflowId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  #buildTerminalWorkflowIndexOperations(
    previousState: WorkflowState,
    nextState: WorkflowState,
  ): BatchOperation[] {
    const operations: BatchOperation[] = [];

    if (isTerminalWorkflowStatus(previousState.status)) {
      operations.push({
        type: 'delete',
        key: KEYS.terminalWorkflow(previousState.updatedAt, previousState.id),
      });
    }

    if (isTerminalWorkflowStatus(nextState.status)) {
      operations.push({
        type: 'put',
        key: KEYS.terminalWorkflow(nextState.updatedAt, nextState.id),
        value: EMPTY_STORAGE_VALUE,
      });
    }

    return operations;
  }

  #getMinimumRetentionMs(): number | null {
    let minimumRetentionMs: number | null = null;

    const considerRetentionPolicy = (
      policy: NormalizedRetentionPolicy | null | undefined,
    ): void => {
      for (const retentionMs of [
        policy?.completed,
        policy?.failed,
        policy?.cancelled,
        policy?.timedOut,
      ]) {
        if (retentionMs === undefined) {
          continue;
        }

        minimumRetentionMs =
          minimumRetentionMs === null ? retentionMs : Math.min(minimumRetentionMs, retentionMs);
      }
    };

    considerRetentionPolicy(this.#options.retention);
    for (const registration of this.#registrations.values()) {
      considerRetentionPolicy(registration.retention);
    }

    return minimumRetentionMs;
  }

  async *#streamExpiredRetentionWorkflowStates(now: number): AsyncGenerator<WorkflowState> {
    const minimumRetentionMs = this.#getMinimumRetentionMs();
    if (minimumRetentionMs === null) {
      return;
    }

    const terminalWorkflowPrefix = KEYS.terminalWorkflowPrefix();
    const newestPossibleExpiredUpdatedAt = now - minimumRetentionMs;
    const upperBound = `${terminalWorkflowPrefix}${String(newestPossibleExpiredUpdatedAt).padStart(16, '0')}:\xff`;

    for await (const [key] of this.#storage.scan(terminalWorkflowPrefix, { lte: upperBound })) {
      const encodedWorkflowId = key.slice(key.lastIndexOf(':') + 1);
      const workflowId = tryDecodeStorageKeyComponent(encodedWorkflowId);
      if (workflowId === null) {
        continue;
      }

      const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
      if (!stateBytes) {
        await this.#storage.delete(key);
        continue;
      }

      const state = decodeWorkflowState(stateBytes);
      if (!isTerminalWorkflowStatus(state.status)) {
        continue;
      }

      yield state;
    }
  }

  #resolveWorkflowTypeRetention(type: string): WorkflowTypeRetentionPolicy {
    const registration = this.#registrations.get(type);
    if (registration?.retention) {
      return {
        type,
        source: 'workflow',
        retention: registration.retention,
      };
    }

    if (this.#options.retention !== null) {
      return {
        type,
        source: 'engine',
        retention: this.#options.retention,
      };
    }

    return {
      type,
      source: 'none',
      retention: null,
    };
  }

  #getWorkflowRetentionDeadline(state: WorkflowState): number | null {
    if (!isTerminalWorkflowStatus(state.status)) {
      return null;
    }

    const policy = this.#resolveWorkflowTypeRetention(state.type).retention;
    const retentionMs = resolveRetentionForStatus(policy, state.status);
    if (retentionMs === undefined) {
      return null;
    }

    return state.updatedAt + retentionMs;
  }

  getRetentionOverview(): RetentionOverview {
    const workflowTypes = [...this.#registrations.keys()]
      .toSorted()
      .map((type) => this.#resolveWorkflowTypeRetention(type));

    return {
      defaultRetention: this.#options.retention,
      sweepIntervalMs: this.#options.retentionSweepIntervalMs,
      sweepBatchSize: this.#options.retentionSweepBatchSize,
      nextSweepAt: this.#nextRetentionSweepAt,
      workflowTypes,
    };
  }

  async purge(filter?: ListFilter): Promise<PurgeResult> {
    return this.#purgeInternal(filter, {
      expiredOnly: false,
      now: this.#options.getNow(),
    });
  }

  /** Cancel all running or pending workflows that match the provided filter. */
  async cancelAll(filter: ListFilter): Promise<BulkCancelResult> {
    assertScopedBulkWorkflowFilter(filter);
    const actionableFilter = this.#buildActionableBulkWorkflowFilter(filter, [
      'pending',
      'running',
    ]);
    const workflowIdsToCancel = await this.#snapshotMatchingWorkflowIds(actionableFilter);
    let cancelled = 0;
    const errors: BulkOperationError[] = [];

    for (const workflowId of workflowIdsToCancel) {
      try {
        await this.cancel(workflowId);
        const refreshedState = await this.#loadWorkflowState(workflowId);
        if (refreshedState?.status === 'cancelled') {
          cancelled += 1;
          continue;
        }

        errors.push({
          id: workflowId,
          error: 'Workflow no longer cancellable',
        });
      } catch (error) {
        errors.push(this.#toBulkOperationError(workflowId, error));
      }
    }

    return {
      cancelled,
      failed: errors.length,
      errors,
    };
  }

  /** Send a named signal to every running or pending workflow that matches the provided filter. */
  async signalAll(filter: ListFilter, name: string, payload?: unknown): Promise<BulkSignalResult> {
    assertScopedBulkWorkflowFilter(filter);
    if (name.length === 0) {
      throw new Error('Field "name" must be a non-empty string');
    }
    const actionableFilter = this.#buildActionableBulkWorkflowFilter(filter, [
      'pending',
      'running',
    ]);
    const workflowIdsToSignal = await this.#snapshotMatchingWorkflowIds(actionableFilter);
    let signalled = 0;
    let failed = 0;

    for (const workflowId of workflowIdsToSignal) {
      try {
        await this.signal(workflowId, name, payload);
        signalled += 1;
      } catch {
        failed += 1;
      }
    }

    return { signalled, failed };
  }

  /** Delete all matching terminal workflows, rejecting when the filter includes active workflows. */
  async deleteAll(filter: ListFilter): Promise<BulkDeleteResult> {
    assertScopedBulkWorkflowFilter(filter);
    const candidateWorkflowIds: string[] = [];

    for await (const batch of this.#streamWorkflowStateBatches(filter)) {
      for (const state of batch) {
        if (!isTerminalWorkflowStatus(state.status)) {
          throw new BulkDeleteRequiresTerminalWorkflowsError();
        }

        candidateWorkflowIds.push(state.id);
      }
    }

    let deleted = 0;
    for (
      let batchStart = 0;
      batchStart < candidateWorkflowIds.length;
      batchStart += BULK_OPERATION_BATCH_SIZE
    ) {
      const batchWorkflowIds = candidateWorkflowIds.slice(
        batchStart,
        batchStart + BULK_OPERATION_BATCH_SIZE,
      );
      const workflowStatesToDelete: WorkflowState[] = [];

      for (const workflowId of batchWorkflowIds) {
        const refreshedState = await this.#loadWorkflowState(workflowId);
        if (refreshedState === null) {
          continue;
        }
        if (!isTerminalWorkflowStatus(refreshedState.status)) {
          throw new BulkDeleteRequiresTerminalWorkflowsError();
        }

        workflowStatesToDelete.push(refreshedState);
      }

      for (const workflowState of workflowStatesToDelete) {
        await this.#purgeWorkflow(workflowState);
        deleted += 1;
      }
    }

    return { deleted };
  }

  /** Add tags to every workflow that matches the provided filter. */
  async tagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return this.#bulkMutateWorkflowTags(filter, tags, 'add');
  }

  /** Remove tags from every workflow that matches the provided filter. */
  async untagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return this.#bulkMutateWorkflowTags(filter, tags, 'remove');
  }

  async #snapshotMatchingWorkflowIds(filter?: ListFilter): Promise<string[]> {
    const workflowIds: string[] = [];

    // Snapshot ids before mutating workflow state entries so storage scans
    // cannot skip or re-visit workflows when backends reorder after writes.
    for await (const batch of this.#streamWorkflowStateBatches(filter)) {
      for (const state of batch) {
        workflowIds.push(state.id);
      }
    }

    return workflowIds;
  }

  #resolvePurgeWindow(
    filter: ListFilter | undefined,
    fallbackLimit: number | undefined,
  ): { effectiveLimit: number | undefined; manualOffset: number } {
    const manualOffset =
      filter?.offset !== undefined && Number.isFinite(filter.offset) && filter.offset > 0
        ? Math.floor(filter.offset)
        : 0;
    const manualLimit =
      filter?.limit !== undefined && Number.isFinite(filter.limit) && filter.limit >= 0
        ? Math.floor(filter.limit)
        : undefined;

    return {
      manualOffset,
      effectiveLimit:
        manualLimit !== undefined && fallbackLimit !== undefined
          ? Math.min(manualLimit, fallbackLimit)
          : (manualLimit ?? fallbackLimit),
    };
  }

  #shouldPurgeWorkflowState(state: WorkflowState, expiredOnly: boolean, now: number): boolean {
    if (!isTerminalWorkflowStatus(state.status)) {
      return false;
    }

    if (!expiredOnly) {
      return true;
    }

    const deadline = this.#getWorkflowRetentionDeadline(state);
    return deadline !== null && deadline <= now;
  }

  async #purgeInternal(
    filter: ListFilter | undefined,
    parameters: {
      expiredOnly: boolean;
      now: number;
      limit?: number;
    },
  ): Promise<PurgeResult> {
    const { effectiveLimit, manualOffset } = this.#resolvePurgeWindow(filter, parameters.limit);

    if (effectiveLimit === 0) {
      return { deleted: 0 };
    }

    let remainingOffset = manualOffset;
    let deleted = 0;

    const workflowStateStream =
      parameters.expiredOnly && filter === undefined
        ? this.#streamExpiredRetentionWorkflowStates(parameters.now)
        : this.#streamWorkflowStates(filter);

    for await (const state of workflowStateStream) {
      if (!this.#shouldPurgeWorkflowState(state, parameters.expiredOnly, parameters.now)) {
        continue;
      }

      if (remainingOffset > 0) {
        remainingOffset -= 1;
        continue;
      }

      await this.#purgeWorkflow(state);
      deleted += 1;

      if (effectiveLimit !== undefined && deleted >= effectiveLimit) {
        break;
      }
    }

    return { deleted };
  }

  #releaseChargedAgentOperations(workflowId: string): BatchOperation[] {
    const workflowOperations = this.#chargedAgentOperationsByWorkflow.get(workflowId);
    if (!workflowOperations) {
      return [];
    }

    const budgetChargedDeletes: BatchOperation[] = [];
    for (const operationId of workflowOperations) {
      this.#chargedAgentOperations.delete(operationId);
      budgetChargedDeletes.push({ type: 'delete', key: KEYS.budgetCharged(operationId) });
    }

    this.#chargedAgentOperationsByWorkflow.delete(workflowId);
    return budgetChargedDeletes;
  }

  async #purgeWorkflow(state: WorkflowState): Promise<void> {
    const workflowId = state.id;
    const encodedWorkflowId = encodeStorageKeyComponent(workflowId);
    const attributeBytes = await this.#storage.get(KEYS.attribute(workflowId));
    const deleteOperations: BatchOperation[] = [];
    const deleteKeys = new Set<string>([
      KEYS.workflow(workflowId),
      KEYS.checkpoint(workflowId),
      KEYS.workflowHeaders(workflowId),
      KEYS.attribute(workflowId),
      KEYS.terminalWorkflow(state.updatedAt, workflowId),
    ]);

    if (state.executionDeadline !== undefined) {
      deleteKeys.add(KEYS.deadline(state.executionDeadline, workflowId));
      deleteKeys.add(`timer-idx:deadline:${workflowId}`);
    }

    if (attributeBytes) {
      const currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
      for (const operation of buildIndexOperations(workflowId, currentAttributes, {})) {
        if (operation.type === 'delete') {
          deleteOperations.push(operation);
        }
      }
    }

    for (const operation of buildWorkflowTagIndexOperations(
      workflowId,
      normalizeWorkflowTags(state.tags),
      undefined,
    )) {
      if (operation.type === 'delete') {
        deleteOperations.push(operation);
      }
    }

    deleteOperations.push(...this.#releaseChargedAgentOperations(workflowId));

    const updateRequestPrefix = KEYS.updatePrefix(workflowId);
    const updateRequestKeys = await collectKeysForPrefix(this.#storage, updateRequestPrefix);
    for (const key of updateRequestKeys) {
      deleteKeys.add(key);
      const updateId = key.slice(updateRequestPrefix.length);
      if (updateId.length > 0) {
        deleteKeys.add(KEYS.updateResponse(updateId));
      }
    }

    for (const prefix of [
      `wf:${encodedWorkflowId}:ckpt:`,
      `ev:${encodedWorkflowId}:`,
      `sig:${encodedWorkflowId}:`,
      `review:${encodedWorkflowId}:`,
      `offload:${encodedWorkflowId}:`,
      `archive:${encodedWorkflowId}:`,
      `blob:${encodedWorkflowId}:`,
      `shared:${encodedWorkflowId}:`,
      `tool-effect:${encodedWorkflowId}:`,
      `upk:${encodedWorkflowId}:`,
    ]) {
      const keys = await collectKeysForPrefix(this.#storage, prefix);
      for (const key of keys) {
        deleteKeys.add(key);
      }
    }

    for (const key of deleteKeys) {
      deleteOperations.push({ type: 'delete', key });
    }

    await this.#storage.batch(deleteOperations);

    this.#checkpoints.delete(workflowId);
    this.#heartbeatDetails.delete(workflowId);
    this.#agentWorkflowIds.delete(workflowId);
    this.#eventLogHeads.delete(workflowId);
    this.#workflowVersionTuples.delete(workflowId);
    this.#handleCache.delete(workflowId);
    this.#resultResolvers.delete(workflowId);
    this.#workflowHeaders.delete(workflowId);
    this.#workflowNestingDepths.delete(workflowId);
    this.#cleanupWaiters(workflowId);
  }

  async schedule(
    type: string,
    input: unknown,
    cronExpression: string,
    options?: ScheduleOptions,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<ScheduleHandle> {
    if (!this.#registrations.has(type)) {
      throw new Error(`No workflow registered with name "${type}"`);
    }

    if (typeof cronExpression !== 'string') {
      throw new Error('cronExpression must be a string');
    }

    const normalizedOptions = normalizeScheduleOptions(options);
    const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
    parseCronExpression(cronExpression);
    const scheduleId = normalizedOptions.id ?? crypto.randomUUID();
    if (this.#pendingScheduleCreations.has(scheduleId)) {
      throw new Error(`Schedule with id "${scheduleId}" already exists`);
    }

    this.#pendingScheduleCreations.add(scheduleId);
    try {
      if (await this.#storage.get(KEYS.schedule(scheduleId))) {
        throw new Error(`Schedule with id "${scheduleId}" already exists`);
      }

      const now = this.#options.getNow();
      const resolvedTenant = await this.#resolveTenantForStart(scheduleId, type, input);
      const tenant =
        normalizedAccessOptions?.tenantId === undefined
          ? resolvedTenant
          : resolvedTenant === undefined
            ? { id: normalizedAccessOptions.tenantId }
            : resolvedTenant.id === normalizedAccessOptions.tenantId
              ? resolvedTenant
              : (() => {
                  throw new Error('Schedule creation is limited to the authenticated tenant');
                })();
      const state: ScheduleState = {
        id: scheduleId,
        workflowType: type,
        input,
        cronExpression,
        status: 'active',
        overlap: normalizedOptions.overlap,
        backfill: normalizedOptions.backfill,
        createdAt: now,
        updatedAt: now,
        nextFireAt: getNextCronOccurrence(cronExpression, now),
        queuedRuns: 0,
        ...(tenant !== undefined && { tenant }),
      };

      await this.#writeScheduleState(state);
      return new ScheduleHandle(scheduleId, this, tenant ? { tenantId: tenant.id } : undefined);
    } finally {
      this.#pendingScheduleCreations.delete(scheduleId);
    }
  }

  async getSchedule(
    scheduleId: string,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<ScheduleSummary | null> {
    const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
    const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
    const state = await this.#loadScheduleState(normalizedScheduleId);
    return state && canAccessSchedule(state, normalizedAccessOptions)
      ? this.#toScheduleSummary(state)
      : null;
  }

  async listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
    const normalizedFilter = normalizeScheduleFilter(filter);
    const items: ScheduleSummary[] = [];

    for await (const [key, value] of this.#storage.scan('schedule:')) {
      const scheduleKeySuffix = key.slice('schedule:'.length);
      if (scheduleKeySuffix.includes(':')) continue;

      const state = decodeScheduleState(value);
      if (!state || !matchesScheduleFilter(state, normalizedFilter)) continue;
      items.push(this.#toScheduleSummary(state));
    }

    return paginateScheduleSummaries(items, normalizedFilter);
  }

  async pauseSchedule(scheduleId: string, accessOptions?: ScheduleAccessOptions): Promise<void> {
    const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
    const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
    const state = await this.#requireScheduleState(normalizedScheduleId, normalizedAccessOptions);
    if (state.status !== 'active') return;

    await this.#scheduler.cancel(createScheduleTimerId(normalizedScheduleId), normalizedScheduleId);

    const now = this.#options.getNow();
    const updatedState: ScheduleState = {
      ...state,
      status: 'paused',
      updatedAt: now,
      nextFireAt: getNextCronOccurrence(state.cronExpression, now),
      queuedRuns: 0,
    };
    await this.#writeScheduleState(updatedState, { includeTimer: false });
  }

  async resumeSchedule(scheduleId: string, accessOptions?: ScheduleAccessOptions): Promise<void> {
    const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
    const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
    const state = await this.#requireScheduleState(normalizedScheduleId, normalizedAccessOptions);
    if (state.status === 'cancelled') {
      throw new Error(
        `Schedule "${normalizedScheduleId}" has been cancelled and cannot be resumed`,
      );
    }
    if (state.status === 'active') return;

    const now = this.#options.getNow();
    const updatedState: ScheduleState = {
      ...state,
      status: 'active',
      updatedAt: now,
      nextFireAt: getNextCronOccurrence(state.cronExpression, now),
    };
    await this.#writeScheduleState(updatedState);
  }

  async cancelSchedule(scheduleId: string, accessOptions?: ScheduleAccessOptions): Promise<void> {
    const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
    const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
    const state = await this.#requireScheduleState(normalizedScheduleId, normalizedAccessOptions);
    if (state.status === 'active') {
      await this.#scheduler.cancel(
        createScheduleTimerId(normalizedScheduleId),
        normalizedScheduleId,
      );
    }

    const updatedState: ScheduleState = {
      ...state,
      status: 'cancelled',
      updatedAt: this.#options.getNow(),
      nextFireAt: null,
      queuedRuns: 0,
    };
    await this.#writeScheduleState(updatedState, { includeTimer: false });
  }

  async updateSchedule(
    scheduleId: string,
    newCronExpression: string,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<void> {
    const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
    const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
    if (typeof newCronExpression !== 'string') {
      throw new Error('newCronExpression must be a string');
    }
    parseCronExpression(newCronExpression);

    const state = await this.#requireScheduleState(normalizedScheduleId, normalizedAccessOptions);
    if (state.status === 'active') {
      await this.#scheduler.cancel(
        createScheduleTimerId(normalizedScheduleId),
        normalizedScheduleId,
      );
    }

    const now = this.#options.getNow();
    const updatedState: ScheduleState = {
      ...state,
      cronExpression: newCronExpression,
      updatedAt: now,
      nextFireAt:
        state.status === 'cancelled' ? null : getNextCronOccurrence(newCronExpression, now),
    };
    await this.#writeScheduleState(updatedState, { includeTimer: state.status === 'active' });
  }

  /** Build a {@link WorkflowVersionTuple} from a {@link RegistrationEntry}. */
  #createWorkflowVersionTuple(
    registration: RegistrationEntry,
    tenant?: import('./tenant.ts').TenantContext,
  ): WorkflowVersionTuple {
    if (registration.versionTupleForTenant) {
      return registration.versionTupleForTenant(tenant);
    }

    return {
      workflowVersion: registration.version,
    };
  }

  #workflowVersionTupleFromState(state: WorkflowState): WorkflowVersionTuple {
    return {
      workflowVersion: state.version,
      ...(state.agentVersion !== undefined && { agentVersion: state.agentVersion }),
      ...(state.toolVersions !== undefined && { toolVersions: state.toolVersions }),
    };
  }

  #workflowStateWithVersionTuple(
    state: WorkflowState,
    versionTuple: WorkflowVersionTuple,
  ): WorkflowState {
    const {
      agentVersion: _existingAgentVersion,
      toolVersions: _existingToolVersions,
      ...rest
    } = state;

    return {
      ...rest,
      version: versionTuple.workflowVersion,
      updatedAt: this.#options.getNow(),
      ...(versionTuple.agentVersion !== undefined && {
        agentVersion: versionTuple.agentVersion,
      }),
      ...(versionTuple.toolVersions !== undefined && {
        toolVersions: versionTuple.toolVersions,
      }),
    };
  }

  /**
   * Legacy agent workflows stored only the workflow version (`"1"`) and did
   * not persist agent or tool version metadata. Resume them once, then
   * backfill the current tuple so future resumes become strict.
   */
  #isLegacyAgentVersionState(state: WorkflowState, registration: RegistrationEntry): boolean {
    return (
      registration.isAgent === true &&
      state.agentVersion === undefined &&
      state.toolVersions === undefined
    );
  }

  #derivePreparedExecutionState(
    workflowId: string,
    state: WorkflowState,
    checkpoint: Checkpoint,
    registration: RegistrationEntry,
  ): {
    state: WorkflowState;
    checkpoint: Checkpoint;
    versionTuple: WorkflowVersionTuple;
    shouldPersistPreparedState: boolean;
  } {
    const compatibility = checkVersionCompatibility(
      checkpoint.version,
      registration.version,
      !!registration.migrate,
    );
    const registeredVersionTuple = this.#createWorkflowVersionTuple(registration, state.tenant);
    const isLegacyAgentVersionState = this.#isLegacyAgentVersionState(state, registration);
    const versionDiff = isLegacyAgentVersionState
      ? {}
      : diffWorkflowVersionTuples(
          this.#workflowVersionTupleFromState(state),
          registeredVersionTuple,
        );
    const hasVersionTupleDrift =
      versionDiff.workflowVersion !== undefined ||
      versionDiff.agentVersion !== undefined ||
      versionDiff.toolVersions !== undefined;

    if (compatibility === 'incompatible' || (hasVersionTupleDrift && !registration.migrate)) {
      this.#throwVersionMismatch(workflowId, state, registration, versionDiff);
    }

    let preparedState = state;
    let preparedCheckpoint = checkpoint;
    let shouldPersistPreparedState = false;

    if (isLegacyAgentVersionState) {
      preparedState = this.#workflowStateWithVersionTuple(state, registeredVersionTuple);
      shouldPersistPreparedState = true;
    } else if (
      (compatibility === 'needs-migration' || hasVersionTupleDrift) &&
      registration.migrate
    ) {
      const migrated = migrateCheckpoint(
        checkpoint,
        checkpoint.version,
        registration.version,
        registration.migrate,
      ) as import('./types.ts').Checkpoint;
      migrated.version = registeredVersionTuple.workflowVersion;
      preparedCheckpoint = migrated;
      preparedState = this.#workflowStateWithVersionTuple(state, registeredVersionTuple);
      shouldPersistPreparedState = true;
    }

    return {
      state: preparedState,
      checkpoint: preparedCheckpoint,
      versionTuple: registeredVersionTuple,
      shouldPersistPreparedState,
    };
  }

  async #prepareResumeState(
    workflowId: string,
    state: WorkflowState,
    checkpoint: Checkpoint,
    registration: RegistrationEntry,
  ): Promise<{
    state: WorkflowState;
    checkpoint: Checkpoint;
    versionTuple: WorkflowVersionTuple;
  }> {
    const preparedExecutionState = this.#derivePreparedExecutionState(
      workflowId,
      state,
      checkpoint,
      registration,
    );

    if (preparedExecutionState.shouldPersistPreparedState) {
      await this.#storage.batch(
        buildVersionUpdateOperations(
          workflowId,
          serializeCheckpoint(preparedExecutionState.checkpoint),
          preparedExecutionState.versionTuple.workflowVersion,
          encode(preparedExecutionState.state),
        ),
      );
    }

    return {
      state: preparedExecutionState.state,
      checkpoint: preparedExecutionState.checkpoint,
      versionTuple: preparedExecutionState.versionTuple,
    };
  }

  /** Throws a {@link VersionMismatchError} with a full version diff. Never returns. */
  #throwVersionMismatch(
    workflowId: string,
    state: import('./types.ts').WorkflowState,
    registration: RegistrationEntry,
    versionDiff: WorkflowVersionDiff,
  ): never {
    throw new VersionMismatchError(
      workflowId,
      state.type,
      state.version,
      registration.version,
      undefined,
      versionDiff,
    );
  }

  #createInitialWorkflowState(
    workflowId: string,
    type: string,
    input: unknown,
    versionTuple: WorkflowVersionTuple,
    options?: StartOptions,
    tags?: string[],
    tenant?: import('./tenant.ts').TenantContext,
    delayedStartTimer?: TimerEntry,
  ): WorkflowState {
    const now = this.#options.getNow();
    const state: WorkflowState = {
      id: workflowId,
      type,
      status: delayedStartTimer ? 'pending' : 'running',
      input,
      version: versionTuple.workflowVersion,
      createdAt: now,
      ...(!delayedStartTimer && { startedAt: now }),
      updatedAt: now,
      ...(tags !== undefined && { tags }),
      ...(versionTuple.agentVersion !== undefined && {
        agentVersion: versionTuple.agentVersion,
      }),
      ...(versionTuple.toolVersions !== undefined && {
        toolVersions: versionTuple.toolVersions,
      }),
    };

    if (options?.executionTimeout !== undefined && !delayedStartTimer) {
      const executionTimeoutMilliseconds = this.#parseStartOptionDuration(
        options.executionTimeout,
        'options.executionTimeout',
      );
      let executionDeadline: number;
      try {
        executionDeadline = normalizeStorageTimestamp(
          now + executionTimeoutMilliseconds,
          'options.executionTimeout',
        );
      } catch {
        throw new StartWorkflowValidationError(
          'options.executionTimeout must resolve to a finite, non-negative deadline',
        );
      }
      state.executionDeadline = executionDeadline;
    }

    if (tenant !== undefined) {
      state.tenant = tenant;
    }

    return state;
  }

  /**
   * Resolve the tenant for a new workflow via the configured resolver. Returns
   * `undefined` when no resolver is set or the resolver itself returned
   * `undefined`. Thrown errors are surfaced to the caller of `start()` so
   * misconfigured resolvers fail loudly instead of silently bypassing tenancy.
   */
  async #resolveTenantForStart(
    workflowId: string,
    workflowType: string,
    input: unknown,
  ): Promise<import('./tenant.ts').TenantContext | undefined> {
    const resolver = this.#options.tenantResolver;
    if (!resolver) return undefined;
    const resolved = await resolver.resolve(workflowId, input, workflowType);
    return resolved;
  }

  #createInitialCheckpoint(
    workflowId: string,
    workflowVersion: string,
    options?: StartOptions,
  ): Checkpoint {
    const checkpoint = createCheckpoint(workflowId, workflowVersion, this.#options.getNow());
    if (options?.searchAttributes) {
      checkpoint.searchAttributes = { ...options.searchAttributes };
    }
    return checkpoint;
  }

  #buildStartBatchOperations(
    workflowId: string,
    state: WorkflowState,
    checkpoint: Checkpoint,
    registration: RegistrationEntry,
    options?: StartOptions,
    executionDeadline?: number,
    delayedStartTimer?: TimerEntry,
    workflowStartHeaders?: Map<string, string>,
    additionalOperations?: import('../storage/interface.ts').BatchOperation[],
  ): import('../storage/interface.ts').BatchOperation[] {
    const operations: import('../storage/interface.ts').BatchOperation[] = [
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
      {
        type: 'put',
        key: KEYS.checkpoint(workflowId),
        value: serializeCheckpoint(checkpoint),
      },
      ...buildWorkflowTagIndexOperations(workflowId, undefined, state.tags),
      ...this.#buildInitialSearchAttributeOperations(
        workflowId,
        registration,
        options?.searchAttributes,
      ),
      ...(workflowStartHeaders && workflowStartHeaders.size > 0
        ? [
            {
              type: 'put' as const,
              key: KEYS.workflowHeaders(workflowId),
              value: encodeWorkflowStartHeaders(workflowStartHeaders),
            },
          ]
        : []),
      ...(additionalOperations ?? []),
    ];

    // Fold deadline timer operations into the same batch so workflows with
    // an execution timeout don't pay for a second storage transaction.
    // Uses the shared helper so key format stays in sync with Scheduler.
    if (executionDeadline !== undefined) {
      operations.push(
        ...buildTimerBatchOperations({
          id: `deadline:${workflowId}`,
          workflowId,
          fireAt: executionDeadline,
          kind: 'execution-deadline',
        }),
      );
    }

    if (delayedStartTimer) {
      operations.push(...buildTimerBatchOperations(delayedStartTimer));
    }

    return operations;
  }

  #buildInitialSearchAttributeOperations(
    workflowId: string,
    registration: RegistrationEntry,
    searchAttributes: StartOptions['searchAttributes'],
  ): import('../storage/interface.ts').BatchOperation[] {
    if (!searchAttributes || Object.keys(searchAttributes).length === 0) {
      return [];
    }

    this.#validateSearchAttributes(registration, searchAttributes);
    this.#validateAttributeValueSizes(searchAttributes);

    return [
      {
        type: 'put',
        key: KEYS.attribute(workflowId),
        value: encode(searchAttributes),
      },
      ...buildIndexOperations(workflowId, {}, searchAttributes),
    ];
  }

  #validateSearchAttributes(
    registration: RegistrationEntry,
    searchAttributes: Record<string, SearchAttributeValue>,
  ): void {
    if (!registration.searchAttributes) {
      return;
    }

    const schema = registration.searchAttributes;
    for (const [key, value] of Object.entries(searchAttributes)) {
      if (!(key in schema)) {
        throw new Error(
          `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
        );
      }
      validateAttributeType(key, value, schema[key]!);
    }
  }

  #runWorkflowStartInterceptor(
    workflowId: string,
    workflowType: string,
    input: unknown,
    parentHeaders: Map<string, string> | undefined,
  ): Map<string, string> | undefined {
    const composedInterceptor = this.#getComposedWorkflowInterceptor();
    if (!composedInterceptor) {
      return undefined;
    }

    const headers = new Map<string, string>();
    if (parentHeaders) {
      for (const [key, value] of parentHeaders) {
        headers.set(key, value);
      }
    }

    let capturedHeaders: Map<string, string> | undefined;
    composedInterceptor.workflowStart(
      {
        workflowId,
        workflowType,
        input,
        headers,
      },
      (interception) => {
        capturedHeaders = new Map(interception.headers);
      },
    );

    return capturedHeaders;
  }

  #createWorkflowHandle(workflowId: string): WorkflowHandle {
    return this.#createWorkflowHandleWithResultPromise(
      workflowId,
      this.#createWorkflowResultPromise(workflowId),
    );
  }

  #createWorkflowHandleWithResultPromise(
    workflowId: string,
    resultPromise: Promise<unknown>,
  ): WorkflowHandle {
    const handle = new WorkflowHandle(workflowId, this, resultPromise);
    this.#cacheHandle(workflowId, handle);
    return handle;
  }

  #createWorkflowResultPromise(workflowId: string): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#resultResolvers.set(workflowId, { resolve, reject });
    // Internal workflow starts can create handles whose result promises are
    // never observed directly, so mark the promise handled to avoid unhandled
    // rejection noise while still allowing callers to await the original promise.
    void promise.catch(() => {});
    return promise;
  }

  #createDeferredWorkflowResultPromise(workflowId: string): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const resolver = { resolve, reject };
    this.#resultResolvers.set(workflowId, resolver);
    void promise.catch(() => {});
    void this.#bootstrapWorkflowResultResolver(workflowId, resolver);
    return promise;
  }

  async #bootstrapWorkflowResultResolver(
    workflowId: string,
    resolver: WorkflowResultResolver,
  ): Promise<void> {
    try {
      const state = await this.#loadWorkflowState(workflowId);
      if (this.#resultResolvers.get(workflowId) !== resolver) {
        return;
      }

      if (!state) {
        this.#resultResolvers.delete(workflowId);
        resolver.reject(new Error(`Workflow "${workflowId}" not found in storage`));
        return;
      }

      if (state.status === 'running' || state.status === 'pending') {
        return;
      }

      try {
        const result = await this.#loadWorkflowResult(workflowId);
        if (this.#resultResolvers.get(workflowId) === resolver) {
          this.#resultResolvers.delete(workflowId);
        }
        resolver.resolve(result);
      } catch (error) {
        if (this.#resultResolvers.get(workflowId) === resolver) {
          this.#resultResolvers.delete(workflowId);
        }
        resolver.reject(error);
      }
    } catch (error) {
      if (this.#resultResolvers.get(workflowId) === resolver) {
        this.#resultResolvers.delete(workflowId);
      }
      resolver.reject(error);
    }
  }

  #setWorkflowStartHeaders(workflowId: string, headers: Map<string, string> | undefined): void {
    if (!headers || headers.size === 0) {
      this.#workflowHeaders.delete(workflowId);
      return;
    }

    this.#workflowHeaders.set(workflowId, new Map(headers));
  }

  async #loadWorkflowStartHeaders(workflowId: string): Promise<Map<string, string> | undefined> {
    const bytes = await this.#storage.get(KEYS.workflowHeaders(workflowId));
    if (!bytes) {
      return undefined;
    }

    return decodeWorkflowStartHeaders(bytes);
  }

  /**
   * Store a WorkflowHandle in the cache and register it with the finalization
   * registry. If an earlier cached entry exists for the same workflowId, its
   * previous registration is unregistered first so that GC of the old handle
   * cannot evict the newly-cached entry.
   */
  #cacheHandle(workflowId: string, handle: WorkflowHandle): void {
    const existing = this.#handleCache.get(workflowId);
    if (existing) {
      this.#finalizationRegistry.unregister(existing.unregisterToken);
    }
    const unregisterToken = {};
    this.#handleCache.set(workflowId, {
      ref: new WeakRef(handle),
      unregisterToken,
    });
    this.#finalizationRegistry.register(handle, workflowId, unregisterToken);
  }

  #startWorkflowExecution(
    workflowId: string,
    workflowType: string,
    input: unknown,
    checkpoint: Checkpoint,
    executionDeadline: number | undefined,
    tenant: import('./tenant.ts').TenantContext | undefined,
  ): void {
    const nestingDepth = this.#pendingNestingDepth ?? 0;
    this.#pendingNestingDepth = undefined;
    // Skip the map entry for the common non-nested case — readers fall back
    // to 0. Saves per-workflow V8 Map overhead (~80 bytes) on the hot path.
    if (nestingDepth !== 0) {
      this.#workflowNestingDepths.set(workflowId, nestingDepth);
    }
    this.#strategy.startWorkflow({
      workflowId,
      workflowType,
      input,
      checkpoint: serializeCheckpoint(checkpoint),
      nestingDepth,
      ...(executionDeadline !== undefined && { deadline: executionDeadline }),
      ...(this.#workflowHeaders.has(workflowId) && {
        headers: [...this.#workflowHeaders.get(workflowId)!],
      }),
      ...(tenant !== undefined && { tenant }),
    });
  }

  async #resolveConstrainedIds(
    filter: ListFilter | undefined,
    normalizedTagFilters: readonly string[] | undefined,
  ): Promise<Set<string> | null> {
    const attributeFilters = filter?.attributes;
    const hasAttributeFilters = attributeFilters !== undefined && attributeFilters.length > 0;
    const hasTagFilters = normalizedTagFilters !== undefined && normalizedTagFilters.length > 0;

    if (!hasAttributeFilters && !hasTagFilters) {
      return null;
    }

    // Bound concurrency so a request with many attribute filters can't
    // saturate a connection-limited storage backend with N parallel scans.
    // Inline worker-pool loop: each worker pulls the next unclaimed filter
    // and writes the result into its original index. JavaScript is
    // single-threaded, so the `nextIndex += 1` read-modify-write is atomic
    // across event-loop yields.
    const queries: Array<() => Promise<Set<string>>> = [];
    if (normalizedTagFilters) {
      for (const tag of normalizedTagFilters) {
        queries.push(() => this.#queryTagIndex(tag));
      }
    }
    if (attributeFilters) {
      for (const attributeFilter of attributeFilters) {
        queries.push(() => this.#queryAttributeIndex(attributeFilter));
      }
    }

    const idSets: Array<Set<string> | undefined> = Array.from({ length: queries.length });
    const workerLimit = Math.max(1, Math.min(ATTRIBUTE_SCAN_CONCURRENCY, queries.length));
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= queries.length) return;
        idSets[currentIndex] = await queries[currentIndex]!();
      }
    };
    const workers: Promise<void>[] = [];
    for (let workerIndex = 0; workerIndex < workerLimit; workerIndex += 1) {
      workers.push(runWorker());
    }
    await Promise.all(workers);
    return intersectIdentifierSets(idSets as Set<string>[]);
  }

  #isTopLevelWorkflowStateKey(key: string): boolean {
    const idPart = key.slice(3);
    return !idPart.includes(':');
  }

  // -------------------------------------------------------------------------
  // Private: attribute index queries
  // -------------------------------------------------------------------------

  async #queryAttributeIndex(filter: AttributeFilter): Promise<Set<string>> {
    const ids = new Set<string>();
    const prefix = `idx:${filter.key}:`;

    if (filter.value !== undefined) {
      // Exact match: scan idx:{name}:{encodedValue}: prefix
      const encodedValue = encodeAttributeValue(filter.value);
      const exactPrefix = `idx:${filter.key}:${encodedValue}:`;
      for await (const [key] of this.#storage.scan(exactPrefix)) {
        // Key format: idx:{name}:{encodedValue}:{workflowId}
        const workflowId = tryDecodeStorageKeyComponent(key.slice(exactPrefix.length));
        if (workflowId !== null) {
          ids.add(workflowId);
        }
      }
    } else {
      // Range scan with gte/lte/gt/lt boundaries
      const scanOptions: import('../storage/interface.ts').ScanOptions = {};
      if (filter.gte !== undefined) {
        scanOptions.gte = `idx:${filter.key}:${encodeAttributeValue(filter.gte)}:`;
      }
      if (filter.gt !== undefined) {
        scanOptions.gt = `idx:${filter.key}:${encodeAttributeValue(filter.gt)}:\xff`;
      }
      if (filter.lte !== undefined) {
        // Use a boundary that includes all workflow IDs for the lte value
        const encodedLte = encodeAttributeValue(filter.lte);
        // Append a character after the last ':' to ensure we include all IDs under this value
        scanOptions.lte = `idx:${filter.key}:${encodedLte}:\xff`;
      }
      if (filter.lt !== undefined) {
        scanOptions.lt = `idx:${filter.key}:${encodeAttributeValue(filter.lt)}:`;
      }

      for await (const [key] of this.#storage.scan(prefix, scanOptions)) {
        // Key format: idx:{name}:{encodedValue}:{workflowId}
        // Extract workflowId: everything after the last ':'
        const afterPrefix = key.slice(prefix.length);
        const lastColon = afterPrefix.lastIndexOf(':');
        if (lastColon >= 0) {
          const workflowId = tryDecodeStorageKeyComponent(afterPrefix.slice(lastColon + 1));
          if (workflowId !== null) {
            ids.add(workflowId);
          }
        }
      }
    }

    return ids;
  }

  async #queryTagIndex(tag: string): Promise<Set<string>> {
    const ids = new Set<string>();
    const prefix = `tag:${encodeStorageKeyComponent(tag)}:`;

    for await (const [key] of this.#storage.scan(prefix)) {
      const workflowId = tryDecodeStorageKeyComponent(key.slice(prefix.length));
      if (workflowId !== null) {
        ids.add(workflowId);
      }
    }

    return ids;
  }

  // -------------------------------------------------------------------------
  // Private: attribute index cleanup
  // -------------------------------------------------------------------------

  async #cleanupAttributeIndex(
    workflowId: string,
    currentAttributes?: Record<string, SearchAttributeValue>,
  ): Promise<void> {
    if (currentAttributes === undefined) {
      const attributeBytes = await this.#storage.get(KEYS.attribute(workflowId));
      if (!attributeBytes) return;

      currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
    }

    const deleteOperations = buildIndexOperations(workflowId, currentAttributes, {});

    // Delete the attribute record itself along with all index entries
    deleteOperations.push({ type: 'delete', key: KEYS.attribute(workflowId) });

    if (deleteOperations.length > 0) {
      await this.#storage.batch(deleteOperations);
    }
  }

  // -------------------------------------------------------------------------
  // Signal
  // -------------------------------------------------------------------------

  async signal(workflowId: string, name: string, payload?: unknown): Promise<void> {
    const deliverSignal = async (
      targetWorkflowId: string,
      signalName: string,
      signalPayload: unknown,
    ): Promise<void> => {
      const signalId = crypto.randomUUID();
      const signalKey = KEYS.signal(targetWorkflowId, signalName, signalId);
      await this.#storage.put(signalKey, encode(signalPayload));

      this.dispatchEvent(new SignalReceivedEvent(targetWorkflowId, signalName, signalPayload));

      this.#broadcast({ type: 'signal:received', workflowId: targetWorkflowId, signalName });

      // Check if workflow is waiting for this signal
      const waiterKey = `${targetWorkflowId}:${signalName}`;
      const waiter = this.#signalWaiters.get(waiterKey);
      if (waiter) {
        this.#signalWaiters.delete(waiterKey);
        this.#untrackWaiterKey(this.#signalWaitersByWorkflow, targetWorkflowId, waiterKey);
        waiter();
      }
    };

    // Run signalReceived interceptor hook wrapping actual delivery
    const composed = this.#getComposedWorkflowInterceptor();
    if (composed) {
      let deliveryPromise: Promise<void> | undefined;
      let nextCalled = false;
      try {
        composed.signalReceived(
          {
            workflowId,
            signalName: name,
            payload: payload,
            headers: new Map<string, string>(),
          },
          (interception) => {
            if (nextCalled) {
              throw new Error('signalReceived interceptor called next() more than once');
            }
            nextCalled = true;
            deliveryPromise = deliverSignal(
              interception.workflowId,
              interception.signalName,
              interception.payload,
            );
          },
        );
      } catch (error) {
        // Always await the delivery promise even if the interceptor threw after
        // calling next, to avoid orphaned unhandled promise rejections.
        if (deliveryPromise) await deliveryPromise;
        throw error;
      }
      // If interceptor blocked delivery by not calling next, return early
      if (!deliveryPromise) return;
      await deliveryPromise;
    } else {
      await deliverSignal(workflowId, name, payload);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    const timeout = options?.timeout ?? 30_000;

    // Reject updates to workflows in terminal states
    await this.#guardTerminalWorkflow(workflowId);

    // Check if the workflow has an active context with an update handler.
    // Note: in worker mode, #inlineStrategy is null so synchronous update
    // handlers registered via ctx.onUpdate() are not available. Updates in
    // worker mode go through the #updateWaiters or UpdateCoordinator paths.
    const context = this.#inlineStrategy?.getContext(workflowId);
    if (context) {
      const handler = context.updateHandlers.get(name);
      if (handler) {
        const updateId = crypto.randomUUID();
        this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

        try {
          const result = await this.#invokeUpdateHandler(name, handler, payload);
          this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
          this.#broadcast({ type: 'update:completed', workflowId, updateId });
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.dispatchEvent(
            new UpdateCompletedEvent(updateId, workflowId, name, undefined, errorMessage),
          );
          this.#broadcast({ type: 'update:completed', workflowId, updateId });
          throw error;
        }
      }
    }

    // Check if workflow is waiting for this update via waitForUpdate
    const waiterKey = `${workflowId}:${name}`;
    const updateWaiter = this.#updateWaiters.get(waiterKey);
    const existingPendingUpdate = updateWaiter
      ? await this.#findPendingUpdateByName(workflowId, name)
      : undefined;
    const currentWaiter = updateWaiter ? this.#updateWaiters.get(waiterKey) : undefined;
    if (updateWaiter && currentWaiter === updateWaiter && !existingPendingUpdate) {
      this.#updateWaiters.delete(waiterKey);
      this.#untrackWaiterKey(this.#updateWaitersByWorkflow, workflowId, waiterKey);
      const updateId = crypto.randomUUID();
      this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

      const { promise: respondPromise, resolve: resolveRespond } = Promise.withResolvers<unknown>();
      let responded = false;
      const respond = (value: unknown) => {
        if (responded) return;
        responded = true;
        resolveRespond(value);
      };

      updateWaiter({ payload, respond });

      // Race the respond promise against the timeout, clearing the timer on either outcome
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          respondPromise,
          new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
              () => reject(new UpdateTimeoutError(updateId, timeout)),
              timeout,
            );
          }),
        ]);

        clearTimeout(timeoutId);

        this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
        this.#broadcast({ type: 'update:completed', workflowId, updateId });
        return result;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }

    // If no active handler, use the UpdateCoordinator with polling
    const updateId = await this.#updateCoordinator.createRequest(workflowId, name, payload);
    await this.#guardTerminalWorkflowAfterCoordinatedRequest(workflowId, updateId);
    this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

    await this.#deliverCoordinatedUpdateToWaiterIfAvailable(workflowId, {
      updateId,
      workflowId,
      name,
      payload,
      createdAt: Date.now(),
    });

    const response = await this.#updateCoordinator.waitForResponse(updateId, timeout);

    if (response.error) {
      throw new Error(response.error);
    }

    return response.result;
  }

  async query(workflowId: string, name: string): Promise<unknown> {
    // Built-in query: return latest heartbeat details for this workflow
    if (name === 'activityProgress') {
      return this.#heartbeatDetails.get(workflowId);
    }

    if (!this.#inlineStrategy) {
      throw new Error(
        'Workflow queries are not supported when using the worker execution strategy.',
      );
    }
    const context = this.#inlineStrategy.getContext(workflowId);
    if (!context) {
      return undefined;
    }
    const accessor = context.exposedAccessors.get(name);
    if (!accessor) return undefined;
    return accessor();
  }

  async setBudgetPolicy(
    options: import('../ai/budget-policy.ts').BudgetPolicyOptions,
  ): Promise<void> {
    if (!this.#budgetPolicyEnforcer) {
      const { BudgetPolicyEnforcer } = await import('../ai/budget-policy.ts');
      this.#budgetPolicyEnforcer = new BudgetPolicyEnforcer(this.#storage, this.#options.getNow);
    }
    this.#budgetPolicyEnforcer.setPolicy(options);
  }

  /** Retrieve the budget policy for a namespace, or `null` if none is set. */
  async getBudgetPolicy(
    namespace: string,
  ): Promise<import('../ai/budget-policy.ts').BudgetPolicyOptions | null> {
    if (!this.#budgetPolicyEnforcer) return null;
    return this.#budgetPolicyEnforcer.policies.get(namespace) ?? null;
  }

  /** Retrieve current quota usage versus configured limits for a tenant. */
  async getQuotaUsage(tenantId: string): Promise<TenantQuotaUsage> {
    return this.#tenantQuotaManager.getUsage(tenantId);
  }

  /** Read stored stream chunks back from storage, optionally after a durable sequence cursor. */
  async getStreamChunks(
    workflowId: string,
    key: string,
    options?: { after?: number },
  ): Promise<StoredStreamChunk[]> {
    const after = options?.after;
    const prefix = KEYS.streamChunkPrefix(workflowId, key);
    const chunks: StoredStreamChunk[] = [];
    const scanOptions =
      after !== undefined && after >= 0
        ? { gt: KEYS.streamChunk(workflowId, key, after) }
        : undefined;

    for await (const [storageKey, chunkBytes] of this.#storage.scan(prefix, scanOptions)) {
      const sequenceText = storageKey.slice(prefix.length);
      const sequence = Number.parseInt(sequenceText, 10);
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        continue;
      }

      chunks.push({
        sequence,
        value: decode(chunkBytes),
      });
    }

    return chunks;
  }

  #createForkLineage(sourceWorkflowId: string, checkpoint: Checkpoint): ForkLineage {
    return {
      workflowId: sourceWorkflowId,
      step: checkpoint.step,
    };
  }

  #buildForkSearchAttributes(
    checkpoint: Checkpoint,
    lineage: ForkLineage,
  ): Record<string, SearchAttributeValue> {
    return {
      ...checkpoint.searchAttributes,
      [FORK_LINEAGE_ATTRIBUTE]: lineage.workflowId,
    };
  }

  #createForkedWorkflowState(
    workflowId: string,
    sourceState: WorkflowState,
    versionTuple: WorkflowVersionTuple,
    lineage: ForkLineage,
    forkedAt: number,
  ): WorkflowState {
    return {
      id: workflowId,
      type: sourceState.type,
      status: 'running',
      input: sourceState.input,
      version: versionTuple.workflowVersion,
      createdAt: forkedAt,
      startedAt: forkedAt,
      updatedAt: forkedAt,
      ...(versionTuple.agentVersion !== undefined && {
        agentVersion: versionTuple.agentVersion,
      }),
      ...(versionTuple.toolVersions !== undefined && {
        toolVersions: versionTuple.toolVersions,
      }),
      ...(sourceState.tenant !== undefined && { tenant: sourceState.tenant }),
      forkedFrom: lineage,
    };
  }

  #buildForkBatchOperations(
    workflowId: string,
    state: WorkflowState,
    checkpoint: Checkpoint,
    workflowStartHeaders?: Map<string, string>,
  ): import('../storage/interface.ts').BatchOperation[] {
    const operations: import('../storage/interface.ts').BatchOperation[] = [
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
      {
        type: 'put',
        key: KEYS.checkpoint(workflowId),
        value: serializeCheckpoint(checkpoint),
      },
    ];

    if (Object.keys(checkpoint.searchAttributes).length > 0) {
      operations.push(
        {
          type: 'put',
          key: KEYS.attribute(workflowId),
          value: encode(checkpoint.searchAttributes),
        },
        ...buildIndexOperations(workflowId, {}, checkpoint.searchAttributes),
      );
    }

    if (workflowStartHeaders && workflowStartHeaders.size > 0) {
      operations.push({
        type: 'put',
        key: KEYS.workflowHeaders(workflowId),
        value: encodeWorkflowStartHeaders(workflowStartHeaders),
      });
    }

    return operations;
  }

  #launchWorkflowFromCheckpoint(
    workflowId: string,
    state: WorkflowState,
    checkpoint: Checkpoint,
    registration: RegistrationEntry,
  ): WorkflowHandle {
    // Store checkpoint for future persistence
    this.#checkpoints.set(workflowId, checkpoint);
    this.#workflowVersionTuples.set(
      workflowId,
      this.#createWorkflowVersionTuple(registration, state.tenant),
    );

    if (registration.isAgent) {
      this.#agentWorkflowIds.add(workflowId);
    }

    const handle = this.#createWorkflowHandle(workflowId);
    this.#warmupWorkflowRegistration(registration);
    this.dispatchEvent(new WorkflowStartedEvent(workflowId, state.type, state.input));

    if (this.#inlineStrategy) {
      const accumulatedResults = new Map<number, unknown>(checkpoint.accumulatedResults);
      const workflowAbort = new AbortController();

      const context = new Context({
        workflowId,
        workflowType: state.type,
        startedAt: getWorkflowExecutionStartedAt(state),
        abortController: workflowAbort,
        getNow: this.#options.getNow,
        resolveWorkflowType: this.#resolveWorkflowTypeTarget.bind(this),
        accumulatedResults,
        searchAttributes: checkpoint.searchAttributes,
        ...(registration.searchAttributes && {
          searchAttributeSchema: registration.searchAttributes,
        }),
        sleepReferenceTime: checkpoint.createdAt,
        ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
        ...(state.tenant !== undefined && { tenant: state.tenant }),
      });

      if (this.#options.development) {
        context.explain(true);
      }

      const generator = registration.handler(context, state.input);
      this.#inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);
      this.#inlineStrategy.continueWorkflow(workflowId, undefined);
      queueMicrotask(this.#processPendingUpdatesAfterReplay.bind(this, workflowId));
    } else {
      const serialized = serializeCheckpoint(checkpoint);
      this.#strategy.startWorkflow({
        workflowId,
        workflowType: state.type,
        input: state.input,
        checkpoint: serialized,
        ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
        ...(this.#workflowHeaders.has(workflowId) && {
          headers: [...this.#workflowHeaders.get(workflowId)!],
        }),
        ...(state.tenant !== undefined && { tenant: state.tenant }),
      });
    }

    return handle;
  }

  async fork(sourceWorkflowId: string, options?: ForkOptions): Promise<WorkflowHandle> {
    const sourceState = await this.#loadWorkflowState(sourceWorkflowId);
    if (!sourceState) {
      throw new Error(`Workflow "${sourceWorkflowId}" not found`);
    }

    const registration = this.#registrations.get(sourceState.type);
    if (!registration) {
      throw new Error(
        `No workflow registered with name "${sourceState.type}" (needed to fork "${sourceWorkflowId}")`,
      );
    }

    const fromStep =
      options?.fromStep !== undefined ? normalizeForkStep(options.fromStep) : undefined;
    const checkpointKey =
      fromStep !== undefined
        ? KEYS.checkpointHistory(sourceWorkflowId, fromStep)
        : KEYS.checkpoint(sourceWorkflowId);
    const checkpointBytes = await this.#storage.get(checkpointKey);
    if (!checkpointBytes) {
      if (fromStep !== undefined) {
        throw new Error(
          `Checkpoint not found at step ${String(fromStep)} for workflow "${sourceWorkflowId}"`,
        );
      }
      throw new Error(`Checkpoint not found for workflow "${sourceWorkflowId}"`);
    }

    const sourceCheckpoint = deserializeCheckpoint(checkpointBytes);
    const preparedExecutionState = this.#derivePreparedExecutionState(
      sourceWorkflowId,
      sourceState,
      sourceCheckpoint,
      registration,
    );
    const sourceWorkflowHeaders =
      this.#workflowHeaders.get(sourceWorkflowId) ??
      (await this.#loadWorkflowStartHeaders(sourceWorkflowId));
    const persistedWorkflowStartHeaders =
      selectPersistedWorkflowStartHeaders(sourceWorkflowHeaders);

    const workflowId = crypto.randomUUID();
    const forkedAt = this.#options.getNow();
    const lineage = this.#createForkLineage(sourceWorkflowId, sourceCheckpoint);
    const forkCheckpoint: Checkpoint = {
      ...preparedExecutionState.checkpoint,
      createdAt: forkedAt,
      workflowId,
      searchAttributes: this.#buildForkSearchAttributes(preparedExecutionState.checkpoint, lineage),
    };
    const forkState = this.#createForkedWorkflowState(
      workflowId,
      preparedExecutionState.state,
      preparedExecutionState.versionTuple,
      lineage,
      forkedAt,
    );

    let forkStarted = false;
    try {
      await this.#storage.batch(
        this.#buildForkBatchOperations(
          workflowId,
          forkState,
          forkCheckpoint,
          persistedWorkflowStartHeaders,
        ),
      );
      this.#eventLogHeads.set(workflowId, EMPTY_EVENT_HEAD);
      this.#setWorkflowStartHeaders(workflowId, persistedWorkflowStartHeaders);
      const handle = this.#launchWorkflowFromCheckpoint(
        workflowId,
        forkState,
        forkCheckpoint,
        registration,
      );
      forkStarted = true;
      return handle;
    } finally {
      if (!forkStarted) {
        this.#checkpoints.delete(workflowId);
        this.#workflowVersionTuples.delete(workflowId);
        this.#eventLogHeads.delete(workflowId);
        this.#agentWorkflowIds.delete(workflowId);
        this.#workflowHeaders.delete(workflowId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Resume / Recovery
  // -------------------------------------------------------------------------

  async resume(workflowId: string): Promise<WorkflowHandle> {
    // Load workflow state
    const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!stateBytes) {
      throw new Error(`Workflow "${workflowId}" not found in storage`);
    }

    let state = decodeWorkflowState(stateBytes);
    if (state.status !== 'running') {
      throw new Error(
        `Cannot resume workflow "${workflowId}": status is "${state.status}", expected "running"`,
      );
    }

    // Load checkpoint
    const checkpointBytes = await this.#storage.get(KEYS.checkpoint(workflowId));
    if (!checkpointBytes) {
      throw new Error(`Checkpoint not found for workflow "${workflowId}"`);
    }

    const checkpoint = deserializeCheckpoint(checkpointBytes);

    // Look up registration
    const registration = this.#registrations.get(state.type);
    if (!registration) {
      throw new Error(
        `No workflow registered with name "${state.type}" (needed to resume "${workflowId}")`,
      );
    }

    // Agent optimization: track resumed agent workflows for storage-layer optimization.
    if (registration.isAgent) {
      this.#agentWorkflowIds.add(workflowId);
    }

    const preparedResumeState = await this.#prepareResumeState(
      workflowId,
      state,
      checkpoint,
      registration,
    );
    state = preparedResumeState.state;
    const resumeCheckpoint = preparedResumeState.checkpoint;
    const registeredVersionTuple = preparedResumeState.versionTuple;

    // Store checkpoint for future persistence
    this.#checkpoints.set(workflowId, resumeCheckpoint);

    // Cache the workflow version tuple for forwarding to event-log entries.
    this.#workflowVersionTuples.set(workflowId, registeredVersionTuple);

    // Restore the event log head from storage so that the next appendToBatch()
    // call uses the correct sequence number and prevHash rather than falling
    // back to EMPTY_EVENT_HEAD (sequence -1) and overwriting existing entries.
    const eventLog = new EventLog(this.#storage, workflowId);
    const restoredHead = await eventLog.loadHead();
    this.#eventLogHeads.set(workflowId, restoredHead);
    this.#setWorkflowStartHeaders(workflowId, await this.#loadWorkflowStartHeaders(workflowId));

    const handle = this.getHandle(workflowId);

    // Dispatch resumed event
    this.dispatchEvent(new WorkflowResumedEvent(workflowId, resumeCheckpoint.step));

    if (this.#inlineStrategy) {
      // Inline mode: create context and generator, adopt into strategy
      const accumulatedResults = new Map<number, unknown>(resumeCheckpoint.accumulatedResults);
      const workflowAbort = new AbortController();

      // Create context with recovery state. Pass the checkpoint's createdAt as
      // the sleep reference time so that expired sleeps resolve immediately via
      // the fast path instead of scheduling a brand-new full-duration timer.
      const context = new Context({
        workflowId,
        workflowType: state.type,
        startedAt: getWorkflowExecutionStartedAt(state),
        abortController: workflowAbort,
        getNow: this.#options.getNow,
        resolveWorkflowType: this.#resolveWorkflowTypeTarget.bind(this),
        accumulatedResults,
        searchAttributes: resumeCheckpoint.searchAttributes,
        ...(registration.searchAttributes && {
          searchAttributeSchema: registration.searchAttributes,
        }),
        sleepReferenceTime: resumeCheckpoint.createdAt,
        ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
        ...(state.tenant !== undefined && { tenant: state.tenant }),
      });

      if (this.#options.development) {
        context.explain(true);
      }

      const generator = registration.handler(context, state.input);
      this.#inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);

      // Drive the generator (non-blocking) via the strategy
      this.#inlineStrategy.continueWorkflow(workflowId, undefined);

      // After replay, process any pending coordinated updates that match
      // registered inline handlers. Schedule on next microtask so the
      // generator has a chance to register its onUpdate handlers first.
      queueMicrotask(this.#processPendingUpdatesAfterReplay.bind(this, workflowId));
    } else {
      // Worker mode: send run message to the worker with the checkpoint
      const serialized = serializeCheckpoint(resumeCheckpoint);
      this.#strategy.startWorkflow({
        workflowId,
        workflowType: state.type,
        input: state.input,
        checkpoint: serialized,
        nestingDepth: this.#workflowNestingDepths.get(workflowId) ?? 0,
        ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
        ...(this.#workflowHeaders.has(workflowId) && {
          headers: [...this.#workflowHeaders.get(workflowId)!],
        }),
        ...(state.tenant !== undefined && { tenant: state.tenant }),
      });
    }

    return handle;
  }

  async recoverAll(): Promise<WorkflowHandle[]> {
    const handles: WorkflowHandle[] = [];

    for await (const [key, value] of this.#storage.scan('wf:')) {
      // Skip checkpoint and history keys
      if (key.includes(':ckpt') || key.includes(':offload') || key.includes(':archive')) continue;

      const state = decodeWorkflowState(value);
      if (state.status === 'pending') {
        handles.push(this.getHandle(state.id));
        continue;
      }
      if (state.status !== 'running') continue;

      const registration = this.#registrations.get(state.type);
      if (!registration) continue;

      const handle = await this.resume(state.id);
      handles.push(handle);
    }

    return handles;
  }

  // -------------------------------------------------------------------------
  // Cancel / Timeout
  // -------------------------------------------------------------------------

  async cancel(workflowId: string): Promise<void> {
    await this.#terminateWorkflow(workflowId, 'cancelled');
  }

  async timeout(workflowId: string): Promise<void> {
    await this.#terminateWorkflow(workflowId, 'timed-out');
  }

  /** Returns true if the given workflow ID belongs to an agent-typed workflow. */
  isAgentWorkflow(workflowId: string): boolean {
    return this.#agentWorkflowIds.has(workflowId);
  }

  /** Returns the set of currently tracked agent workflow IDs (for storage layer optimization). */
  get agentWorkflowIds(): ReadonlySet<string> {
    return this.#agentWorkflowIds;
  }

  async #terminateWorkflow(workflowId: string, status: 'cancelled' | 'timed-out'): Promise<void> {
    this.#strategy.cancelWorkflow(workflowId);
    const attributeBytes = await this.#storage.get(KEYS.attribute(workflowId));
    const attributes = attributeBytes
      ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
      : {};
    const retainedAttributes = this.#buildRetainedTerminalSearchAttributes(attributes);
    const terminationMessage = status === 'timed-out' ? 'Workflow timed out' : 'Workflow cancelled';
    const terminationResult = await this.#updateWorkflowState(
      workflowId,
      { status },
      {
        allowedStatuses: ['running', 'pending'],
        releaseTenantQuota: true,
        buildAdditionalOperations: (_previousState, updatedAt) => {
          this.#finalizePendingTimelineEntry(workflowId, status, terminationMessage, updatedAt);
          const pendingTimelineOperation = this.#buildPendingTimelineOperation(workflowId);
          return pendingTimelineOperation ? [pendingTimelineOperation] : [];
        },
      },
    );
    if (!terminationResult) {
      return;
    }

    const { previousState, updatedAt } = terminationResult;
    const elapsed = updatedAt - getWorkflowExecutionStartedAt(previousState);
    await this.#cleanupAttributeIndex(workflowId, attributes);
    await this.#writeRetainedTerminalSearchAttributes(workflowId, retainedAttributes);
    void this.#swallowPromiseRejection(
      this.#scheduler.cancel(`deadline:${workflowId}`, workflowId),
    );
    if (previousState.status === 'pending') {
      void this.#swallowPromiseRejection(
        this.#scheduler.cancel(`delayed-start:${workflowId}`, workflowId),
      );
    }

    const resolver = this.#resultResolvers.get(workflowId);
    const terminalError =
      status === 'timed-out'
        ? new WorkflowTimeoutError(workflowId, 'execution', elapsed)
        : new Error('Workflow cancelled');

    try {
      // Drop in-memory state, release charged operations, and delete durable
      // workflow-keyed records (reviews, offload, blob, shared, signal).
      // Cancelled/timed-out workflows have no consumers waiting on output
      // artifacts, so drop them alongside the internal bookkeeping.
      await this.#cleanupTerminalWorkflow(workflowId, true);

      const event =
        status === 'timed-out'
          ? new WorkflowTimedOutEvent(workflowId, 'execution', elapsed)
          : new WorkflowCancelledEvent(workflowId);
      this.dispatchEvent(event);
      this.#forwardEventToHandle(workflowId, event);

      if (resolver) resolver.reject(terminalError);
      // Scheduled queue handoff is best-effort cleanup and must not block
      // terminal delivery or handle settlement.
      void this.#finalizeScheduledWorkflowTerminal(workflowId);
    } catch (cleanupError) {
      // Settle the resolver so handle.result() callers are not stranded.
      if (resolver) resolver.reject(terminalError);
      throw cleanupError;
    } finally {
      this.#resultResolvers.delete(workflowId);
    }
  }

  // -------------------------------------------------------------------------
  // State retrieval (public API for HTTP handlers and clients)
  // -------------------------------------------------------------------------

  /** Retrieve the current state of a workflow by ID. */
  async get(workflowId: string): Promise<WorkflowState | null> {
    return this.#loadWorkflowState(workflowId);
  }

  async #loadScheduleState(scheduleId: string): Promise<ScheduleState | null> {
    const bytes = await this.#storage.get(KEYS.schedule(scheduleId));
    return bytes ? decodeScheduleState(bytes) : null;
  }

  async #requireScheduleState(
    scheduleId: string,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<ScheduleState> {
    const state = await this.#loadScheduleState(scheduleId);
    if (!state || !canAccessSchedule(state, accessOptions)) {
      throw new Error(`Schedule "${scheduleId}" not found`);
    }
    return state;
  }

  #toScheduleSummary(state: ScheduleState): ScheduleSummary {
    const { tenant: _tenant, input: _input, ...summary } = state;
    return summary;
  }

  async #writeScheduleState(
    state: ScheduleState,
    options?: { includeTimer?: boolean },
  ): Promise<void> {
    const operations: import('../storage/interface.ts').BatchOperation[] = [
      { type: 'put', key: KEYS.schedule(state.id), value: encode(state) },
    ];

    const includeTimer = options?.includeTimer ?? state.status === 'active';
    if (includeTimer && state.status === 'active' && state.nextFireAt !== null) {
      operations.push(
        ...buildTimerBatchOperations({
          id: createScheduleTimerId(state.id),
          workflowId: state.id,
          fireAt: state.nextFireAt,
          kind: 'schedule',
        }),
      );
    }

    await this.#storage.batch(operations);
  }

  /** Retrieve search attributes for a workflow. */
  async getAttributes(workflowId: string): Promise<Record<string, SearchAttributeValue> | null> {
    const bytes = await this.#storage.get(KEYS.attribute(workflowId));
    if (!bytes) return null;
    return decode(bytes) as Record<string, SearchAttributeValue>;
  }

  /** Merge search attributes into a workflow's existing attributes, updating the index. */
  async setAttributes(
    workflowId: string,
    attributes: Record<string, SearchAttributeValue>,
  ): Promise<void> {
    // Validate against the registration's schema if one exists
    const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (stateBytes) {
      const state = decodeWorkflowState(stateBytes);
      const registration = this.#registrations.get(state.type);
      if (registration?.searchAttributes) {
        const schema = registration.searchAttributes;
        for (const [key, value] of Object.entries(attributes)) {
          if (!(key in schema)) {
            throw new Error(
              `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
            );
          }
          validateAttributeType(key, value, schema[key]!);
        }
      }
    }

    this.#validateAttributeValueSizes(attributes);

    const existingBytes = await this.#storage.get(KEYS.attribute(workflowId));
    const existing: Record<string, SearchAttributeValue> = existingBytes
      ? (decode(existingBytes) as Record<string, SearchAttributeValue>)
      : {};

    const merged: Record<string, SearchAttributeValue> = { ...existing, ...attributes };

    const indexOperations = buildIndexOperations(workflowId, existing, merged);

    const operations: import('../storage/interface.ts').BatchOperation[] = [
      { type: 'put', key: KEYS.attribute(workflowId), value: encode(merged) },
      ...indexOperations,
    ];

    await this.#storage.batch(operations);
  }

  /** Add one or more tags to a workflow. */
  async addTags(workflowId: string, ...tags: string[]): Promise<void> {
    await this.#mutateWorkflowTags(workflowId, tags, 'add');
  }

  /** Remove one or more tags from a workflow. */
  async removeTags(workflowId: string, ...tags: string[]): Promise<void> {
    await this.#mutateWorkflowTags(workflowId, tags, 'remove');
  }

  /** Validate that all attribute values in a record fit within the storage key size limit. */
  #validateAttributeValueSizes(attributes: Record<string, SearchAttributeValue>): void {
    for (const [key, value] of Object.entries(attributes)) {
      if (Array.isArray(value)) {
        for (const element of value) {
          validateEncodedValueSize(encodeAttributeValue(element), key);
        }
      } else {
        validateEncodedValueSize(encodeAttributeValue(value), key);
      }
    }
  }

  /** Retrieve the event history for a workflow. */
  async getEvents(workflowId: string): Promise<WorkflowEvent[]> {
    const events: WorkflowEvent[] = [];
    const eventLog = new EventLog(this.#storage, workflowId);

    // Use EventLog.scan() instead of scanning the raw prefix so that the head
    // record (ev:{workflowId}:head) is filtered out by the isWorkflowLogEntry
    // guard inside scan(). Previously this method scanned the raw prefix and
    // returned a spurious entry for the head record on every checkpointed workflow.
    for await (const entry of eventLog.scan()) {
      events.push({
        type: entry.type,
        timestamp: entry.timestamp,
        data: sanitizeWorkflowEventPayload(entry.payload),
      });
    }

    return events;
  }

  /**
   * Iterate over the workflow's post-commit records for a given
   * selector whose `sequence` is strictly greater than
   * `afterSequence`. Yields the unified `WorkflowFeedRecord` shape —
   * the same shape `subscribeWorkflowFeedCommits()` delivers to live
   * listeners — so replay and live share one committed sequence
   * authority. A feed backend can switch between the two paths
   * without the envelope shape changing.
   *
   *   - `selector: 'events'` reads the durable `EventLog` via
   *     `scan({fromSequence})`. Unlike `getEvents()` (which drops
   *     sequence and repackages into the shallow `WorkflowEvent`),
   *     this method preserves sequence so the caller can emit a
   *     durable cursor.
   *   - `selector: 'tokens'` reads stored stream chunks for the
   *     hard-coded `'tokens'` stream key — the key the legacy REST
   *     SSE endpoint has always written to, so resumption cursors
   *     round-trip across transports.
   *
   * `afterSequence: -1` means "from the beginning" for both paths.
   */
  async *replayWorkflowFeed(
    workflowId: string,
    selector: WorkflowFeedSelector,
    afterSequence: number,
  ): AsyncIterable<WorkflowFeedRecord> {
    if (selector === 'events') {
      yield* this.#replayWorkflowEventLog(workflowId, afterSequence);
      return;
    }
    yield* this.#replayWorkflowTokens(workflowId, afterSequence);
  }

  /**
   * Snapshot the current tail sequence for the selector. Returns -1
   * when nothing has been committed yet. Paired with
   * `subscribeWorkflowFeedCommits()` by feed backends implementing
   * the atomic-handoff protocol.
   *
   * The `events` path reads the in-memory head cache first and falls
   * back to `EventLog.loadHead()` so a fresh engine instance (post-
   * restart, before the workflow re-hydrates) still reports the
   * durable tail correctly.
   */
  async snapshotWorkflowFeedTail(
    workflowId: string,
    selector: WorkflowFeedSelector,
  ): Promise<number> {
    if (selector === 'events') {
      const head = this.#eventLogHeads.get(workflowId);
      if (head) return head.sequence;
      const eventLog = new EventLog(this.#storage, workflowId);
      const loaded = await eventLog.loadHead();
      return loaded.sequence;
    }
    // `tokens` — scan is O(n) in stored chunks. The legacy stream-
    // chunk storage model does not persist a tail record, so a full
    // prefix iteration is unavoidable without a schema change.
    // Acceptable for now; the typical token stream is short-lived
    // and reconnect frequency is low.
    const chunks = await this.getStreamChunks(workflowId, TOKENS_STREAM_KEY);
    if (chunks.length === 0) return -1;
    let max = -1;
    for (const chunk of chunks) {
      if (chunk.sequence > max) max = chunk.sequence;
    }
    return max;
  }

  /**
   * Subscribe to post-commit workflow-feed notifications. Listeners
   * fire only after `storage.batch()` (events) or `storage.put()`
   * (tokens) has resolved, so every delivered record is durably
   * present in storage.
   *
   * Returns an unsubscribe function. Both sync throws and async
   * rejections from the listener are trapped so a misbehaving
   * subscriber cannot derail the commit path. Register and
   * unregister are safe to call during notification — the notifier
   * snapshots listener membership before dispatch.
   *
   * The unified registry is keyed by `${workflowId}\0${selector}`.
   * NUL is a safe separator: workflow IDs are validated against a
   * pattern that excludes control characters, and `selector` is a
   * fixed two-member union.
   */
  subscribeWorkflowFeedCommits(
    workflowId: string,
    selector: WorkflowFeedSelector,
    listener: WorkflowFeedListener,
  ): () => void {
    const key = workflowFeedListenerKey(workflowId, selector);
    let bucket = this.#workflowFeedListeners.get(key);
    if (!bucket) {
      bucket = new Set();
      this.#workflowFeedListeners.set(key, bucket);
    }
    bucket.add(listener);
    return () => {
      const set = this.#workflowFeedListeners.get(key);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.#workflowFeedListeners.delete(key);
    };
  }

  async *#replayWorkflowEventLog(
    workflowId: string,
    afterSequence: number,
  ): AsyncIterable<WorkflowFeedRecord> {
    const eventLog = new EventLog(this.#storage, workflowId);
    const fromSequence = afterSequence < 0 ? 0 : afterSequence + 1;
    for await (const entry of eventLog.scan({ fromSequence })) {
      yield {
        workflowId,
        selector: 'events',
        kind: entry.type,
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        payload: entry.payload,
      };
    }
  }

  async *#replayWorkflowTokens(
    workflowId: string,
    afterSequence: number,
  ): AsyncIterable<WorkflowFeedRecord> {
    const chunks =
      afterSequence >= 0
        ? await this.getStreamChunks(workflowId, TOKENS_STREAM_KEY, {
            after: afterSequence,
          })
        : await this.getStreamChunks(workflowId, TOKENS_STREAM_KEY);
    // Stream chunks carry no persisted timestamp — the replay path
    // stamps the wallclock at iteration time so consumers always see
    // a populated `timestamp`. Live chunks stamp the same way at
    // commit time for symmetry.
    const timestamp = Date.now();
    for (const chunk of chunks) {
      yield {
        workflowId,
        selector: 'tokens',
        kind: STREAM_CHUNK_KIND,
        sequence: chunk.sequence,
        timestamp,
        payload: chunk.value,
      };
    }
  }

  /**
   * Dispatch a committed record to every listener registered for
   * `(workflowId, selector)`. Called at the two `appendToBatch`
   * commit sites (events) and after each stream chunk put (tokens).
   *
   * **Iteration snapshot.** Listener membership is snapshotted before
   * dispatch. A listener's callback can synchronously register or
   * unregister other listeners; those changes take effect on the
   * next notify, not the current one. This preserves the "future
   * commits only" contract of `subscribe`.
   *
   * **Error isolation.** Both sync throws and async rejections are
   * swallowed so the commit path stays resilient.
   */
  #notifyWorkflowFeedCommit(
    workflowId: string,
    selector: WorkflowFeedSelector,
    record: WorkflowFeedRecord,
  ): void {
    const bucket = this.#workflowFeedListeners.get(workflowFeedListenerKey(workflowId, selector));
    if (!bucket || bucket.size === 0) return;
    const listeners = [...bucket];
    for (const listener of listeners) {
      try {
        const result = listener(record);
        if (result && typeof result.then === 'function') {
          // Async listener: its promise may reject after the sync
          // return. Catch so the rejection does not surface as a
          // Node-level unhandled-rejection event.
          void result.catch(() => {});
        }
      } catch {
        // Sync throw from the listener must not corrupt the commit path.
      }
    }
  }
  // -------------------------------------------------------------------------
  // Public: checkpoint history (time-travel debugging)
  // -------------------------------------------------------------------------

  /**
   * List checkpoint history entries for a workflow, newest first.
   * Returns summary metadata only — use {@link getCheckpointAt} for full state.
   */
  async listCheckpoints(workflowId: string): Promise<CheckpointSummary[]> {
    if (this.#options.checkpointHistory <= 0) return [];

    const prefix = `${KEYS.checkpoint(workflowId)}:`;
    const summaries: CheckpointSummary[] = [];

    for await (const [, value] of this.#storage.scan(prefix, {
      reverse: true,
      limit: this.#options.checkpointHistory,
    })) {
      const checkpoint = deserializeCheckpoint(value);
      summaries.push({
        step: checkpoint.step,
        timestamp: checkpoint.createdAt,
        sizeBytes: value.byteLength,
      });
    }

    return summaries;
  }

  /**
   * Retrieve the full deserialized checkpoint state at a specific step.
   * Returns `null` if the step has no stored history entry.
   */
  async getCheckpointAt(workflowId: string, step: number): Promise<CheckpointState | null> {
    const bytes = await this.#storage.get(KEYS.checkpointHistory(workflowId, step));
    if (!bytes) return null;

    const checkpoint = deserializeCheckpoint(bytes);
    return sanitizeCheckpointState({
      step: checkpoint.step,
      locals: checkpoint.locals,
      searchAttributes: checkpoint.searchAttributes,
      version: checkpoint.version,
      createdAt: checkpoint.createdAt,
    });
  }

  /** Return the durable per-step execution timeline for a workflow. */
  async getTimeline(workflowId: string): Promise<WorkflowTimelineEntry[]> {
    const timeline: WorkflowTimelineEntry[] = [];

    for await (const [, value] of this.#storage.scan(KEYS.timelinePrefix(workflowId))) {
      let decoded: unknown;
      try {
        decoded = decode(value);
      } catch {
        continue;
      }

      if (isWorkflowTimelineEntry(decoded)) {
        timeline.push({
          ...decoded,
          inputSummary: sanitizeTimelineSummary(decoded.inputSummary) ?? decoded.inputSummary,
          ...(decoded.outputSummary !== undefined
            ? {
                outputSummary:
                  sanitizeTimelineSummary(decoded.outputSummary) ?? decoded.outputSummary,
              }
            : {}),
        });
      }
    }

    timeline.sort((left, right) => left.step - right.step);
    return timeline;
  }

  /**
   * Reconstruct workflow state at a historical checkpoint step.
   * Returns `null` when that step is not retained in checkpoint history.
   */
  async replayTo(workflowId: string, step: number): Promise<WorkflowReplay | null> {
    const bytes = await this.#storage.get(KEYS.checkpointHistory(workflowId, step));
    if (!bytes) {
      return null;
    }

    const checkpoint = deserializeCheckpoint(bytes);
    const eventLog = new EventLog(this.#storage, workflowId);
    const entries = await eventLog.replay(Math.max(step - 1, -1));

    return {
      checkpoint: sanitizeCheckpointState({
        step: checkpoint.step,
        locals: checkpoint.locals,
        searchAttributes: checkpoint.searchAttributes,
        version: checkpoint.version,
        createdAt: checkpoint.createdAt,
      }),
      accumulatedResults: checkpoint.accumulatedResults.map(([index, value]) => [
        index,
        sanitizeDebugValueForDisplay(value),
      ]),
      events: entries.map((entry) => ({
        type: entry.type,
        timestamp: entry.timestamp,
        data: sanitizeWorkflowEventPayload(entry.payload),
      })),
    };
  }

  /** List all pending reviews. */
  async listReviews(): Promise<Array<Record<string, unknown>>> {
    const reviews: Array<Record<string, unknown>> = [];

    for await (const [, value] of this.#storage.scan('review:')) {
      reviews.push(decode(value) as Record<string, unknown>);
    }

    return reviews;
  }

  /** Retrieve a specific review by workflowId and reviewId. */
  async getReview(workflowId: string, reviewId: string): Promise<ReviewRequest | null> {
    return this.#reviewCoordinator.getReview(workflowId, reviewId);
  }

  /**
   * Submit a decision for a pending review. Stores the decision, removes
   * the pending review, and wakes the paused workflow if one is waiting.
   */
  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    const { decision, reviewer, feedback, sectionDecisions, workflowId } = options;

    // Look up the review by direct key when workflowId is provided (O(1)),
    // otherwise fall back to scanning all review entries (O(n)).
    let reviewKey: string | null = null;
    let resolvedWorkflowId: string | undefined = workflowId;
    let reviewData: ReviewRequest | undefined;

    if (workflowId !== undefined) {
      const directKey = KEYS.review(workflowId, reviewId);
      const existing = await this.#storage.get(directKey);
      if (existing !== null) {
        reviewKey = directKey;
        reviewData = decode(existing) as ReviewRequest;
      }
    } else {
      for await (const [key, value] of this.#storage.scan('review:')) {
        const review = decode(value) as Record<string, unknown>;
        if (review['reviewId'] === reviewId) {
          reviewKey = key;
          reviewData = review as unknown as ReviewRequest;
          resolvedWorkflowId = review['workflowId'] as string;
          break;
        }
      }
    }

    if (reviewKey === null) {
      throw new Error(`Review "${reviewId}" not found`);
    }

    const now = this.#options.getNow();
    const decisionResult: HumanReviewResult = {
      reviewId,
      decision,
      reviewer,
      timestamp: now,
    };

    if (feedback !== undefined) {
      decisionResult.feedback = feedback;
    }

    if (sectionDecisions !== undefined) {
      decisionResult.sectionDecisions = sectionDecisions;
    }

    await this.#storage.batch([
      { type: 'put', key: `review-decision:${reviewId}`, value: encode(decisionResult) },
      { type: 'delete', key: reviewKey },
    ]);

    // Dispatch HumanReviewCompletedEvent
    const duration = reviewData ? now - reviewData.createdAt : 0;
    this.dispatchEvent(
      new HumanReviewCompletedEvent(
        resolvedWorkflowId ?? '',
        reviewId,
        decision,
        reviewer,
        duration,
      ),
    );

    // Wake the waiting workflow by resolving its review waiter
    if (resolvedWorkflowId) {
      const waiterKey = `${resolvedWorkflowId}:${reviewId}`;
      const waiter = this.#reviewWaiters.get(waiterKey);
      if (waiter) {
        this.#reviewWaiters.delete(waiterKey);
        this.#untrackWaiterKey(this.#reviewWaitersByWorkflow, resolvedWorkflowId, waiterKey);
        waiter(decisionResult);
      }
    }
  }

  /** Retrieve the result of a coordinated update by its ID. */
  async getUpdateResult(updateId: string): Promise<import('./updates.ts').UpdateResponse | null> {
    return this.#updateCoordinator.getResponse(updateId);
  }

  /**
   * Submit a coordinated update request. Handles idempotency checking,
   * creates the request, and waits for a response within the timeout.
   */
  async submitCoordinatedUpdate(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult> {
    const timeout = options?.timeout ?? 30_000;
    const idempotencyKey = options?.idempotencyKey;

    // Check idempotency first — a retry for an already-processed key should
    // return the cached result even if the workflow has since completed.
    if (idempotencyKey !== undefined) {
      const existing = await this.#updateCoordinator.checkIdempotency(workflowId, idempotencyKey);
      if (existing !== null) {
        return { updateId: existing.updateId, result: existing.result };
      }
    }

    // Reject updates to workflows in terminal states
    await this.#guardTerminalWorkflow(workflowId);

    const requestOptions: { timeout: number; idempotencyKey?: string } = { timeout };
    if (idempotencyKey !== undefined) {
      requestOptions.idempotencyKey = idempotencyKey;
    }

    const updateId = await this.#updateCoordinator.createRequest(
      workflowId,
      name,
      payload,
      requestOptions,
    );
    await this.#guardTerminalWorkflowAfterCoordinatedRequest(workflowId, updateId);

    await this.#deliverCoordinatedUpdateToWaiterIfAvailable(
      workflowId,
      {
        updateId,
        workflowId,
        name,
        payload,
        createdAt: Date.now(),
        idempotencyKey,
      },
      true,
    );

    const response = await this.#updateCoordinator.waitForResponse(updateId, timeout);

    const result: CoordinatedUpdateResult = {
      updateId: response.updateId,
      result: response.result,
    };

    if (response.error !== undefined) {
      result.error = response.error;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  [Symbol.dispose](): void {
    this.#alertManager?.[Symbol.dispose]();
    this.#alertManager = null;
    this.#abortController.abort();
    this.#scheduler[Symbol.dispose]();
    this.#strategy[Symbol.dispose]();
    this.#activityWorkerDispatcher?.[Symbol.dispose]();
    this.#activityWorkerDispatcher = null;
    this.#inlineStrategy = null;
    if (this.#cleanupInterval !== null) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = null;
    }
    if (this.#retentionSweepInterval !== null) {
      clearInterval(this.#retentionSweepInterval);
      this.#retentionSweepInterval = null;
    }
    this.#nextRetentionSweepAt = null;
    this.#handleCache.clear();
    this.#resultResolvers.clear();
    this.#signalWaiters.clear();
    this.#signalWaitersByWorkflow.clear();
    this.#updateWaiters.clear();
    this.#updateWaitersByWorkflow.clear();
    this.#reviewWaiters.clear();
    this.#reviewWaitersByWorkflow.clear();
    this.#reviewEscalationHandlers.clear();
    this.#workflowReviewIds.clear();
    this.#reviewTimerIds.clear();
    for (const controller of this.#pendingWebhooks) {
      controller.abort();
    }
    this.#pendingWebhooks.clear();
    this.#sleepResolvers.clear();
    this.#sleepResolversByWorkflow.clear();
    this.#checkpoints.clear();
    this.#workflowNestingDepths.clear();
    this.#workflowHeaders.clear();
    this.#pendingStarts.clear();
    this.#pendingScheduleCreations.clear();
    this.#chargedAgentOperations.clear();
    this.#chargedAgentOperationsByWorkflow.clear();
    this.#agentWorkflowIds.clear();
    this.#eventLogHeads.clear();
    this.#pendingTimelineEntries.clear();
    this.#workflowVersionTuples.clear();
    this.#workflowFeedListeners.clear();
    this.#broadcastChannel?.close();
    this.#broadcastChannel = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }

  // -------------------------------------------------------------------------
  // Accessors (for TestEngine and internal use)
  // -------------------------------------------------------------------------

  get storage(): WeftStorage {
    return this.#storage;
  }

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  // -------------------------------------------------------------------------
  // Private: cleanup error handling
  // -------------------------------------------------------------------------

  /**
   * Handle errors from fire-and-forget cleanup operations. Dispatches a
   * {@link CleanupWarningEvent} so callers can observe failures without
   * affecting the primary workflow result.
   */
  #handleCleanupError(source: string, error: unknown, workflowId?: string): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.dispatchEvent(new CleanupWarningEvent(source, normalizedError, workflowId));
  }

  async #finalizeScheduledWorkflowTerminal(workflowId: string): Promise<void> {
    try {
      await this.#handleScheduledWorkflowTerminal(workflowId);
    } catch (error) {
      this.#handleCleanupError('handleScheduledWorkflowTerminal', error, workflowId);
    }
  }

  // -------------------------------------------------------------------------
  // Private: checkpoint persistence
  // -------------------------------------------------------------------------

  async #persistCheckpoint(
    workflowId: string,
    operation: ContextOperationRequest,
    workerCheckpointBytes?: ArrayBuffer,
  ): Promise<void> {
    const context = this.#inlineStrategy?.getContext(workflowId);

    if (context) {
      // Inline strategy: advance checkpoint from context state
      const current = this.#checkpoints.get(workflowId);
      if (!current) return;

      const previousAttributes = { ...current.searchAttributes };
      const hasPendingAttributeChanges = Object.keys(context.pendingAttributeChanges).length > 0;

      const accumulatedResults = Array.from(context.accumulatedResults.entries());
      const advanced = advanceCheckpoint(current, current.locals, {
        searchAttributes: context.pendingAttributeChanges,
        accumulatedResults,
        now: this.#options.getNow(),
      });

      const serialized = serializeCheckpoint(advanced);

      if (serialized.byteLength >= this.#options.checkpointSizeWarningThreshold) {
        this.dispatchEvent(
          new CheckpointSizeWarningEvent(workflowId, serialized.byteLength, advanced.step),
        );
      }

      const operations: import('../storage/interface.ts').BatchOperation[] = [
        { type: 'put', key: KEYS.checkpoint(workflowId), value: serialized },
      ];

      if (this.#options.checkpointHistory > 0) {
        operations.push({
          type: 'put',
          key: KEYS.checkpointHistory(workflowId, advanced.step),
          value: serialized,
        });
      }

      if (hasPendingAttributeChanges) {
        this.#validateAttributeValueSizes(context.pendingAttributeChanges);
        operations.push({
          type: 'put',
          key: KEYS.attribute(workflowId),
          value: encode(advanced.searchAttributes),
        });
        operations.push(
          ...buildIndexOperations(workflowId, previousAttributes, advanced.searchAttributes),
        );
      }

      const nextPendingTimelineEntry = this.#appendTimelineBatchOperations(
        workflowId,
        operation,
        advanced.step,
        advanced.createdAt,
        operations,
      );

      // Co-write event log entry in the same batch so checkpoint and log never diverge.
      // appendToBatch() is synchronous — no storage reads, no extra await.
      const eventLog = new EventLog(this.#storage, workflowId);
      const { newHead, timestamp } = eventLog.appendToBatch(
        { type: 'workflow:checkpoint', payload: { step: advanced.step } },
        operations,
        this.#eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
        this.#workflowVersionTuples.get(workflowId),
      );

      await this.#storage.batch(operations);
      this.#pendingTimelineEntries.set(workflowId, nextPendingTimelineEntry);
      this.#checkpoints.set(workflowId, advanced);
      this.#eventLogHeads.set(workflowId, newHead);
      this.#notifyWorkflowFeedCommit(workflowId, 'events', {
        workflowId,
        selector: 'events',
        kind: 'workflow:checkpoint',
        sequence: newHead.sequence,
        timestamp,
        payload: { step: advanced.step },
      });
      // Fire-and-forget: pruning is idempotent and non-critical, so deferring
      // it avoids blocking the checkpoint persist path.
      void this.#swallowPromiseRejection(this.#pruneCheckpointHistory(workflowId, advanced.step));

      if (hasPendingAttributeChanges) {
        this.dispatchEvent(
          new AttributesChangedEvent(workflowId, { ...context.pendingAttributeChanges }),
        );
      }
    } else if (workerCheckpointBytes && workerCheckpointBytes.byteLength > 0) {
      // Worker strategy: persist the checkpoint bytes sent from the worker
      const serialized = new Uint8Array(workerCheckpointBytes);
      const checkpoint = deserializeCheckpoint(serialized);

      if (serialized.byteLength >= this.#options.checkpointSizeWarningThreshold) {
        this.dispatchEvent(
          new CheckpointSizeWarningEvent(workflowId, serialized.byteLength, checkpoint.step),
        );
      }

      const operations: import('../storage/interface.ts').BatchOperation[] = [
        { type: 'put', key: KEYS.checkpoint(workflowId), value: serialized },
      ];

      if (this.#options.checkpointHistory > 0) {
        operations.push({
          type: 'put',
          key: KEYS.checkpointHistory(workflowId, checkpoint.step),
          value: serialized,
        });
      }

      const nextPendingTimelineEntry = this.#appendTimelineBatchOperations(
        workflowId,
        operation,
        checkpoint.step,
        checkpoint.createdAt,
        operations,
      );

      // Co-write event log entry in the same batch so checkpoint and log never diverge.
      // appendToBatch() is synchronous — no storage reads, no extra await.
      const eventLog = new EventLog(this.#storage, workflowId);
      const { newHead, timestamp } = eventLog.appendToBatch(
        { type: 'workflow:checkpoint', payload: { step: checkpoint.step } },
        operations,
        this.#eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
        this.#workflowVersionTuples.get(workflowId),
      );

      await this.#storage.batch(operations);
      this.#pendingTimelineEntries.set(workflowId, nextPendingTimelineEntry);
      this.#checkpoints.set(workflowId, checkpoint);
      this.#eventLogHeads.set(workflowId, newHead);
      this.#notifyWorkflowFeedCommit(workflowId, 'events', {
        workflowId,
        selector: 'events',
        kind: 'workflow:checkpoint',
        sequence: newHead.sequence,
        timestamp,
        payload: { step: checkpoint.step },
      });
      void this.#swallowPromiseRejection(this.#pruneCheckpointHistory(workflowId, checkpoint.step));
    }
  }

  #appendTimelineBatchOperations(
    workflowId: string,
    operation: ContextOperationRequest,
    step: number,
    timestamp: number,
    operations: import('../storage/interface.ts').BatchOperation[],
  ): PendingTimelineEntry {
    const pendingEntry = this.#pendingTimelineEntries.get(workflowId);
    const versionTuple = this.#workflowVersionTuples.get(workflowId);

    if (pendingEntry) {
      operations.push({
        type: 'put',
        key: KEYS.timeline(workflowId, pendingEntry.entry.step),
        value: encode(pendingEntry.entry),
      });
    }

    const entry: WorkflowTimelineEntry = {
      step,
      operationType: operation.type,
      operationLabel: getTimelineOperationLabel(operation),
      inputSummary: getTimelineInputSummary(operation),
      timestamp,
      status: 'running',
      ...(versionTuple ? { versionTuple } : {}),
    };

    operations.push({
      type: 'put',
      key: KEYS.timeline(workflowId, step),
      value: encode(entry),
    });

    return {
      startedAt: timestamp,
      entry,
    };
  }

  #finalizePendingTimelineEntry(
    workflowId: string,
    status: WorkflowTimelineEntry['status'],
    output: unknown,
    finishedAt = this.#options.getNow(),
  ): void {
    const pendingEntry = this.#pendingTimelineEntries.get(workflowId);
    if (!pendingEntry) {
      return;
    }

    const currentStatus = pendingEntry.entry.status;
    if (currentStatus === status) {
      return;
    }

    const canOverrideCompletedWithTerminalStatus =
      currentStatus === 'completed' &&
      (status === 'failed' || status === 'cancelled' || status === 'timed-out');
    if (currentStatus !== 'running' && !canOverrideCompletedWithTerminalStatus) {
      return;
    }

    pendingEntry.entry.status = status;
    pendingEntry.entry.outputSummary = summarizeTimelineValue(output);
    pendingEntry.entry.duration = finishedAt - pendingEntry.startedAt;
  }

  #buildPendingTimelineOperation(
    workflowId: string,
  ): import('../storage/interface.ts').BatchOperation | null {
    const pendingEntry = this.#pendingTimelineEntries.get(workflowId);
    if (!pendingEntry) {
      return null;
    }

    return {
      type: 'put',
      key: KEYS.timeline(workflowId, pendingEntry.entry.step),
      value: encode(pendingEntry.entry),
    };
  }

  /**
   * Delete the single checkpoint history entry that overflows the retention
   * limit. Since steps are monotonic and increment by one, writing step `s`
   * means step `s - limit` is now the first entry beyond the window.
   * O(1) per persist instead of O(retention-window).
   */
  async #pruneCheckpointHistory(workflowId: string, currentStep: number): Promise<void> {
    const limit = this.#options.checkpointHistory;
    if (limit <= 0) return;

    const overflowStep = currentStep - limit;
    if (overflowStep < 1) return;

    const key = KEYS.checkpointHistory(workflowId, overflowStep);
    await this.#storage.delete(key);
  }

  // -------------------------------------------------------------------------
  // Private: strategy helpers
  // -------------------------------------------------------------------------

  /**
   * Feed an operation result back into the workflow. Works for both inline
   * and worker strategies by routing through the appropriate method.
   */
  #feedOperationResult(workflowId: string, outcome: OperationOutcome, originalError?: Error): void {
    if (this.#inlineStrategy) {
      // Inline: use the direct methods for efficiency
      if (outcome.status === 'completed') {
        this.#inlineStrategy.continueWorkflow(workflowId, outcome.value);
      } else {
        this.#inlineStrategy.throwIntoWorkflow(
          workflowId,
          originalError ?? new Error(outcome.error),
        );
      }
    } else {
      // Worker: send resume message with the checkpoint
      const checkpoint = this.#checkpoints.get(workflowId);
      const serialized = checkpoint ? serializeCheckpoint(checkpoint) : new ArrayBuffer(0);
      this.#strategy.resumeWorkflow({
        workflowId,
        checkpoint: serialized,
        operationResult: outcome,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private: strategy message handling
  // -------------------------------------------------------------------------

  async #handleStrategyMessage(message: WorkerOutboundMessage): Promise<void> {
    switch (message.type) {
      case 'completed':
        await this.#completeWorkflow(message.workflowId, message.result);
        break;

      case 'failed': {
        const failedError = new Error(message.error);
        // Preserve the original error stack from the strategy if available,
        // rather than using the stack pointing to engine internals.
        if (message.errorStack) {
          failedError.stack = message.errorStack;
        }
        await this.#failWorkflow(
          message.workflowId,
          failedError,
          message.failureCategory ?? 'system',
        );
        break;
      }

      case 'checkpoint': {
        const operation = this.#translateOperationRequest(message.operationRequest);

        // Persist checkpoint at this yield boundary
        await this.#persistCheckpoint(message.workflowId, operation, message.checkpoint);

        // Development mode: validate checkpoint round-trip
        this.#validateDevelopmentCheckpoint(message.workflowId);

        // Evaluate domain constraints — done after persistence so the
        // checkpoint is durable before any violation reaction.
        const constraintViolated = await this.#evaluateConstraints(message.workflowId);
        if (constraintViolated) {
          // Violation already handled (event dispatched, error thrown or logged).
          break;
        }

        // Translate the operation request: worker protocol uses `kind` while the
        // engine uses `type`. Inline strategy already emits ContextOperationRequest.
        await this.#processOperation(message.workflowId, operation);
        break;
      }
    }
  }

  /**
   * Evaluate all registered constraints for a workflow at the current checkpoint.
   *
   * Returns `true` if any constraint was violated and a 'fail' or 'compensate'
   * reaction was triggered (meaning the operation should not proceed). Returns
   * `false` if all constraints passed or only 'warn' violations occurred.
   *
   * **Note**: Constraints are only evaluated when the inline execution strategy
   * is active. Worker execution mode cannot reach this code path with
   * constraints present — `register()` throws at registration time if
   * constraints are supplied while `#inlineStrategy` is `null`, so the
   * `!context` guard here only fires for benign cases (e.g. the workflow has
   * already terminated or the context was cleared mid-evaluation).
   */
  async #evaluateConstraints(workflowId: string): Promise<boolean> {
    const context = this.#inlineStrategy?.getContext(workflowId);
    if (!context) return false;

    const registration = this.#registrations.get(context.workflowType);
    const constraints = registration?.constraints;
    if (!constraints || constraints.length === 0) return false;

    // Build the minimal snapshot passed to check(). Only id, type, and a
    // fixed status of 'running' are available — constraints are evaluated
    // mid-execution, before the workflow has a result or final status.
    // To inspect external state, capture it in the enclosing scope instead.
    const stateSnapshot: ConstraintCheckState = {
      id: workflowId,
      type: context.workflowType,
      status: 'running',
    };

    for (const definition of constraints) {
      let violated: boolean;
      try {
        const result = definition.check(stateSnapshot);
        violated = !(result instanceof Promise ? await result : result);
      } catch (error) {
        // A throwing check is treated as a violation so the workflow doesn't
        // silently continue in an unknown state. Log the original error to aid
        // debugging — without this, users would see only the constraint
        // violation message with no indication their check() is broken.
        console.warn(`[weft] Constraint "${definition.name}" check() threw an error:`, error);
        violated = true;
      }

      if (!violated) continue;

      this.dispatchEvent(
        new ConstraintViolatedEvent(
          workflowId,
          definition.name,
          definition.scope,
          definition.onViolation,
        ),
      );

      if (definition.onViolation === 'warn') {
        console.warn(
          `[weft] Constraint "${definition.name}" (scope: ${definition.scope}) violated on workflow "${workflowId}" — continuing (onViolation: 'warn')`,
        );
        continue;
      }

      // Stop at first actionable violation — remaining constraints are not evaluated.
      const violationError = new Error(
        `Constraint violated: ${definition.name} (scope: ${definition.scope})`,
      );

      if (definition.onViolation === 'fail') {
        // 'fail': bypass saga — directly mark the workflow failed without
        // throwing into the generator. Any active ctx.saga() will NOT run
        // its compensators. Use 'compensate' if you want compensation to run.
        // Cancel the workflow in the strategy first to release the generator,
        // context, and abort controller — same as #terminateWorkflow does.
        this.#strategy.cancelWorkflow(workflowId);
        await this.#failWorkflow(workflowId, violationError);
      } else {
        // 'compensate': throw into the generator. If an active ctx.saga() is
        // wrapping the current step it will catch the error, run its registered
        // compensators in reverse, and then re-throw, completing the workflow failure.
        this.#feedOperationResult(
          workflowId,
          { status: 'failed', error: violationError.message },
          violationError,
        );
      }
      return true;
    }

    return false;
  }

  /**
   * Translate an operation request from a strategy into a {@link ContextOperationRequest}.
   *
   * The inline strategy already produces `ContextOperationRequest` (with `type`).
   * The worker protocol produces `OperationRequest` (with `kind`). This method
   * normalizes both shapes so {@link #processOperation} can switch on `type`.
   */
  #translateOperationRequest(operationRequest: unknown): ContextOperationRequest {
    const operation = operationRequest as Record<string, unknown>;

    if (operation == null || typeof operation !== 'object') {
      throw new Error('Invalid operation request received from execution strategy');
    }

    // Already in ContextOperationRequest shape (inline strategy)
    if ('type' in operation && typeof operation['type'] === 'string') {
      // Inline execution strategy yields ContextOperationRequest directly
      return operation as ContextOperationRequest;
    }

    // Worker OperationRequest uses `kind` — translate to `type`
    if ('kind' in operation && typeof operation['kind'] === 'string') {
      const kind = operation['kind'];

      // Map OperationRequest.kind values to ContextOperationRequest.type values
      const kindToType: Record<string, string> = {
        activity: 'activity',
        timer: 'sleep',
        'signal-wait': 'wait-signal',
        'child-workflow': 'child-workflow',
      };

      const type = kindToType[kind] ?? kind;

      // Worker protocol omits `fn` — it is resolved from the activity registry later
      return {
        ...operation,
        type,
        operationId: (operation['id'] as string) ?? crypto.randomUUID(),
        activityName: (operation['activityName'] as string) ?? '',
        args: operation['input'] !== undefined ? [operation['input']] : [],
      } as ContextOperationRequest;
    }

    throw new Error('Unsupported operation request shape received from execution strategy');
  }

  async #processOperation(workflowId: string, operation: ContextOperationRequest): Promise<void> {
    switch (operation.type) {
      case 'activity':
        return this.#processActivityOperation(workflowId, operation);
      case 'sleep':
        return this.#processSleepOperation(workflowId, operation);
      case 'wait-signal':
        return this.#processWaitSignalOperation(workflowId, operation);
      case 'wait-update':
        return this.#processWaitUpdateOperation(workflowId, operation);
      case 'parallel':
        return this.#processParallelOperation(workflowId, operation);
      case 'race':
        return this.#processRaceOperation(workflowId, operation);
      case 'memo':
        return this.#processMemoOperation(workflowId, operation);
      case 'child-workflow':
        return this.#processChildWorkflowOperation(workflowId, operation);
      case 'offload':
        return this.#processOffloadOperation(workflowId, operation);
      case 'load':
        return this.#processLoadOperation(workflowId, operation);
      case 'archive':
        return this.#processArchiveOperation(workflowId, operation);
      case 'run-all':
        return this.#processRunAllOperation(workflowId, operation);
      case 'agent':
        return this.#processAgentContextOperation(workflowId, operation);
      case 'speculate':
        return this.#processSpeculateOperation(workflowId, operation);
      case 'stream':
        return this.#processStreamOperation(workflowId, operation);
      case 'wait-review':
        return this.#processWaitReviewOperation(workflowId, operation);
      case 'handoff':
        return this.#processHandoffOperation(workflowId, operation);
      case 'debate':
        return this.#processDebateOperation(workflowId, operation);
      case 'supervise':
        return this.#processSuperviseOperation(workflowId, operation);
      default:
        const unsupportedType = String((operation as Record<string, unknown>)['type']);
        this.#failOperation(
          workflowId,
          operation,
          new Error(`Unsupported operation type: ${unsupportedType}`),
        );
        return;
    }
  }

  #completeOperation(workflowId: string, value: unknown): void {
    this.#finalizePendingTimelineEntry(workflowId, 'completed', value);
    this.#feedOperationResult(workflowId, { status: 'completed', value });
  }

  #failOperation(workflowId: string, operation: OperationWithCallerStack, error: unknown): void {
    if (error instanceof Error && operation.callerStack) {
      error.stack = `${error.stack}\n    --- workflow call site ---\n${operation.callerStack}`;
    }

    const enrichedError = error instanceof Error ? error : new Error(String(error));
    this.#finalizePendingTimelineEntry(workflowId, 'failed', enrichedError.message);
    this.#feedOperationResult(
      workflowId,
      { status: 'failed', error: enrichedError.message },
      enrichedError,
    );
  }

  async #runOperationWithResult(
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ): Promise<void> {
    try {
      const value = await execute();
      this.#completeOperation(workflowId, value);
    } catch (error) {
      this.#failOperation(workflowId, operation, error);
    }
  }

  async #runOperationWithoutResult(
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<void>,
  ): Promise<void> {
    try {
      await execute();
    } catch (error) {
      this.#failOperation(workflowId, operation, error);
    }
  }

  #getActivityFunctionWithMetadata(
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): ActivityFunctionWithMetadata | undefined {
    if (typeof operation.fn === 'function') {
      return operation.fn as ActivityFunctionWithMetadata;
    }

    const registered = this.#activityRegistry.resolve(operation.activityName);
    if (registered) {
      return registered as ActivityFunctionWithMetadata;
    }

    return undefined;
  }

  #buildActivityVerification(
    activityName: string,
    verify: (result: unknown) => Promise<boolean> | boolean,
    result: unknown,
  ): Promise<void> {
    return (async () => {
      const verified = await verify(result);
      if (!verified) {
        throw new Error(`Verification failed for activity "${activityName}"`);
      }
    })();
  }

  #buildActivityCompensation(
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
    result: unknown,
  ): (() => Promise<void>) | undefined {
    const activity = this.#getActivityFunctionWithMetadata(operation);
    if (!activity?.compensate) {
      return undefined;
    }

    const input = operation.args.length <= 1 ? operation.args[0] : operation.args;
    return async () => {
      await activity.compensate?.(input, result);
    };
  }

  async #executeActivityOperationResult(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
    speculativeState?: SpeculativeExecutionState,
  ): Promise<unknown> {
    const result = await this.#executeActivity(workflowId, operation);

    const compensation = speculativeState
      ? this.#buildActivityCompensation(operation, result)
      : undefined;
    if (compensation) {
      speculativeState?.recordCompensation(compensation);
    }

    const activity = this.#getActivityFunctionWithMetadata(operation);
    if (activity?.verify) {
      const verification = this.#buildActivityVerification(
        operation.activityName,
        activity.verify,
        result,
      );
      if (speculativeState) {
        speculativeState.recordVerification(verification);
      } else {
        await verification;
      }
    }

    return result;
  }

  async #processActivityOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeActivityOperationResult(workflowId, operation),
    );
  }

  async #processSleepOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'sleep' }>,
  ): Promise<void> {
    if (operation.scheduledFireAt <= this.#options.getNow()) {
      this.#completeOperation(workflowId, undefined);
      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    await this.#scheduler.schedule({
      id: `sleep:${operation.operationId}`,
      workflowId,
      fireAt: operation.scheduledFireAt,
      kind: 'sleep',
    });
    this.#registerSleepResolver(workflowId, operation.operationId, resolve);
    await promise;

    const postSleepState = await this.#loadWorkflowState(workflowId);
    if (postSleepState?.status === 'running') {
      this.#completeOperation(workflowId, undefined);
    }
  }

  #registerSleepResolver(workflowId: string, operationId: string, resolve: () => void): void {
    this.#sleepResolvers.set(`${workflowId}:${operationId}`, resolve);

    let workflowOperations = this.#sleepResolversByWorkflow.get(workflowId);
    if (!workflowOperations) {
      workflowOperations = new Set();
      this.#sleepResolversByWorkflow.set(workflowId, workflowOperations);
    }
    workflowOperations.add(operationId);
  }

  async #processWaitSignalOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-signal' }>,
  ): Promise<void> {
    const abortSignal = this.#abortController.signal;
    const waiterKey = `${workflowId}:${operation.signalName}`;

    while (true) {
      if (abortSignal.aborted) {
        return;
      }

      const existingPayload = await this.#consumeSignal(workflowId, operation.signalName);
      if (existingPayload.found) {
        this.#completeOperation(workflowId, existingPayload.payload);
        return;
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      this.#signalWaiters.set(waiterKey, resolve);
      this.#trackWaiterKey(this.#signalWaitersByWorkflow, workflowId, waiterKey);

      if (abortSignal.aborted) {
        this.#signalWaiters.delete(waiterKey);
        this.#untrackWaiterKey(this.#signalWaitersByWorkflow, workflowId, waiterKey);
        return;
      }

      const bufferedPayload = await this.#consumeSignal(workflowId, operation.signalName);
      if (bufferedPayload.found) {
        if (this.#signalWaiters.get(waiterKey) === resolve) {
          this.#signalWaiters.delete(waiterKey);
          this.#untrackWaiterKey(this.#signalWaitersByWorkflow, workflowId, waiterKey);
        }
        this.#completeOperation(workflowId, bufferedPayload.payload);
        return;
      }

      await promise;

      if (abortSignal.aborted) {
        return;
      }
    }
  }

  async #processWaitUpdateOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-update' }>,
  ): Promise<void> {
    const waiterKey = `${workflowId}:${operation.updateName}`;
    const matchingUpdate = await this.#findPendingUpdateByName(workflowId, operation.updateName);

    if (matchingUpdate) {
      this.#dispatchPendingUpdateReceived(workflowId, operation.updateName, matchingUpdate);
      this.#completeOperation(workflowId, {
        payload: matchingUpdate.payload,
        respond: this.#createCoordinatedUpdateResponder(
          workflowId,
          operation.updateName,
          matchingUpdate,
        ),
      });
      return;
    }

    const { promise, resolve } = Promise.withResolvers<unknown>();
    this.#updateWaiters.set(waiterKey, resolve);
    this.#trackWaiterKey(this.#updateWaitersByWorkflow, workflowId, waiterKey);

    const pendingUpdateAfterRegistration = await this.#findPendingUpdateByName(
      workflowId,
      operation.updateName,
    );
    if (pendingUpdateAfterRegistration) {
      if (this.#updateWaiters.get(waiterKey) === resolve) {
        this.#updateWaiters.delete(waiterKey);
        this.#untrackWaiterKey(this.#updateWaitersByWorkflow, workflowId, waiterKey);
      }

      this.#dispatchPendingUpdateReceived(
        workflowId,
        operation.updateName,
        pendingUpdateAfterRegistration,
      );
      this.#completeOperation(workflowId, {
        payload: pendingUpdateAfterRegistration.payload,
        respond: this.#createCoordinatedUpdateResponder(
          workflowId,
          operation.updateName,
          pendingUpdateAfterRegistration,
        ),
      });
      return;
    }

    this.#completeOperation(workflowId, await promise);
  }

  #dispatchPendingUpdateReceived(
    workflowId: string,
    updateName: string,
    update: UpdateRequest,
  ): void {
    this.dispatchEvent(
      new UpdateReceivedEvent(update.updateId, workflowId, updateName, update.payload),
    );
  }

  #createCoordinatedUpdateResponder(
    workflowId: string,
    updateName: string,
    update: UpdateRequest,
  ): (value: unknown) => void {
    let coordinatedResponded = false;

    return (value: unknown) => {
      if (coordinatedResponded) return;
      coordinatedResponded = true;

      void this.#persistCoordinatedUpdateResponse(
        workflowId,
        updateName,
        update.updateId,
        update.idempotencyKey,
        value,
      );
    };
  }

  async #deliverCoordinatedUpdateToWaiterIfAvailable(
    workflowId: string,
    update: UpdateRequest,
    dispatchReceivedEvent = false,
  ): Promise<boolean> {
    const waiterKey = `${workflowId}:${update.name}`;
    const waiter = this.#updateWaiters.get(waiterKey);
    if (!waiter) {
      return false;
    }

    const oldestPendingUpdate = await this.#findPendingUpdateByName(workflowId, update.name);
    if (!oldestPendingUpdate || oldestPendingUpdate.updateId !== update.updateId) {
      return false;
    }

    this.#updateWaiters.delete(waiterKey);
    this.#untrackWaiterKey(this.#updateWaitersByWorkflow, workflowId, waiterKey);
    if (dispatchReceivedEvent) {
      this.#dispatchPendingUpdateReceived(workflowId, update.name, update);
    }

    waiter({
      payload: update.payload,
      respond: this.#createCoordinatedUpdateResponder(workflowId, update.name, update),
    });
    return true;
  }

  async #findPendingUpdateByName(
    workflowId: string,
    name: string,
  ): Promise<UpdateRequest | undefined> {
    const pendingUpdates = await this.#updateCoordinator.getPendingUpdates(workflowId);
    return pendingUpdates.find((update) => update.name === name);
  }

  async #processParallelOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'parallel' }>,
  ): Promise<void> {
    // `ctx.all()` awaits every branch, so there's no "loser" to abort like
    // there is for `ctx.race()`. Each sub-operation runs to completion or
    // throws; `Promise.all` short-circuits on the first rejection, but the
    // surviving branches' budgets are intentionally preserved — callers that
    // want cancellation on failure should use `ctx.race()` with a guard.
    return this.#runOperationWithResult(workflowId, operation, async () =>
      Promise.all(
        operation.operations.map((subOperation) =>
          this.#executeSubOperation(workflowId, subOperation),
        ),
      ),
    );
  }

  async #processRaceOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'race' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      // Abort losing sub-operations once the race settles. Without this,
      // a losing agent sub-op would continue running its full LLM loop in
      // the background, consuming budget and emitting events with no
      // observer.
      const controller = new AbortController();
      const subOperations = operation.operations.map((subOperation) =>
        this.#executeSubOperation(workflowId, subOperation, controller.signal),
      );
      // Swallow rejections from losing branches — only the race winner's
      // result (or error) is surfaced. Losers typically reject with
      // AbortError after the controller fires in the finally block, and
      // without a handler those would surface as unhandled promise
      // rejections.
      void Promise.allSettled(subOperations);
      try {
        return await Promise.race(subOperations);
      } finally {
        controller.abort();
      }
    });
  }

  async #processMemoOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'memo' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () =>
      callMemoFunction(operation.fn),
    );
  }

  async #processOffloadOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'offload' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const data = await (operation.fn as () => Promise<unknown>)();
      const encoded = encode(data);
      await this.#storage.put(KEYS.offload(workflowId, operation.key), encoded);
      return {
        key: operation.key,
        workflowId,
        sizeBytes: encoded.byteLength,
      };
    });
  }

  async #processLoadOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'load' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const { workflowId: referenceWorkflowId, key: referenceKey, sizeBytes } = operation.reference;

      if (typeof referenceWorkflowId !== 'string' || referenceWorkflowId !== workflowId) {
        throw new Error('ctx.load() can only read offloaded data from the current workflow');
      }
      if (typeof referenceKey !== 'string' || referenceKey.length === 0) {
        throw new Error('ctx.load() requires a non-empty offload reference key');
      }
      if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
        throw new Error('ctx.load() requires a valid offload reference size');
      }

      const raw = await this.#storage.get(KEYS.offload(referenceWorkflowId, referenceKey));
      if (raw === null) {
        throw new Error(
          `Offloaded data not found for key "${referenceKey}" in workflow "${referenceWorkflowId}"`,
        );
      }
      return decode(raw);
    });
  }

  async #processArchiveOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'archive' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      await this.#storage.put(KEYS.archive(workflowId, operation.key), encode(operation.data));
      return undefined;
    });
  }

  async #processStreamOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'stream' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#createStreamReference(workflowId, operation),
    );
  }

  async #createStreamReference(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'stream' }>,
  ): Promise<StreamReference> {
    const sink: StreamSink = {
      heartbeat: (details?: unknown) => {
        this.#heartbeatDetails.set(workflowId, details);
      },
    };

    const writtenKeys: string[] = [];
    try {
      const streamSummary = await this.#writeStreamChunks(
        workflowId,
        operation,
        operation.fn(sink),
        writtenKeys,
      );
      const reference: StreamReference = {
        key: operation.key,
        workflowId,
        chunkCount: streamSummary.chunkCount,
        totalSizeBytes: streamSummary.totalSizeBytes,
      };
      await this.#storage.put(KEYS.streamMetadata(workflowId, operation.key), encode(reference));
      return reference;
    } catch (error) {
      await this.#cleanupStreamChunks(workflowId, operation.key, writtenKeys);
      throw error;
    }
  }

  async #writeStreamChunks(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'stream' }>,
    asyncGenerator: AsyncGenerator<unknown, void, unknown>,
    writtenKeys: string[],
  ): Promise<{ chunkCount: number; totalSizeBytes: number }> {
    let chunkCount = 0;
    let totalSizeBytes = 0;

    for await (const chunk of asyncGenerator) {
      const encoded = encode(chunk);
      const sequence = chunkCount;
      const chunkKey = KEYS.streamChunk(workflowId, operation.key, sequence);
      await this.#storage.put(chunkKey, encoded);
      writtenKeys.push(chunkKey);
      totalSizeBytes += encoded.byteLength;
      chunkCount++;
      // Use wallclock `Date.now()` rather than the engine's `getNow`
      // hook: stream chunks carry no durable timestamp, and perturbing
      // the injected clock that tests use to assert timeline durations
      // would silently affect unrelated test expectations.
      // Only the `tokens` stream key is surfaced through the feed
      // backend's `tokens` selector. Other stream keys are internal
      // to the workflow (e.g., agent-specific chunk buffers) and
      // don't have a feed mount, so firing notifications for them
      // would just burn CPU walking empty listener buckets.
      if (operation.key === TOKENS_STREAM_KEY) {
        this.#notifyWorkflowFeedCommit(workflowId, 'tokens', {
          workflowId,
          selector: 'tokens',
          kind: STREAM_CHUNK_KIND,
          sequence,
          // Stream chunks carry no durable timestamp. `Date.now()`
          // rather than `this.#options.getNow()` avoids perturbing
          // the injected clock that tests use to assert timeline
          // durations.
          timestamp: Date.now(),
          payload: chunk,
        });
      }
    }

    return { chunkCount, totalSizeBytes };
  }

  async #cleanupStreamChunks(
    workflowId: string,
    key: string,
    writtenKeys: string[],
  ): Promise<void> {
    await cleanupPartialStreamChunks(
      this.#storage,
      workflowId,
      key,
      writtenKeys,
      createCleanupErrorReporter(this.#handleCleanupError.bind(this), workflowId),
    );
  }

  async #processRunAllOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'run-all' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeRunAllOperationResult(workflowId, operation),
    );
  }

  async #processAgentContextOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'agent' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeAgentContextOperationResult(workflowId, operation),
    );
  }

  async #processSpeculateOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'speculate' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeSpeculativeBranch(workflowId, operation),
    );
  }

  async #executeAgentContextOperationResult(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'agent' }>,
  ): Promise<unknown> {
    const { executeAgentLoop } = await import('../ai/agent.ts');
    const {
      prompt,
      budget: budgetOptions,
      budgetNamespace,
      contextStrategy: _contextStrategy,
      ...rest
    } = operation.options;
    const budgetTracker = await this.#createAgentBudgetTracker(
      workflowId,
      operation,
      budgetOptions,
    );
    const resolvedBudgetNamespace = this.#resolveAgentBudgetNamespace(budgetNamespace);
    await this.#checkAgentBudgetPolicy(workflowId, budgetOptions, resolvedBudgetNamespace);

    const context = this.#inlineStrategy?.getContext(workflowId);
    this.#exposeTokenUsageAccessor(context, budgetTracker);

    const agentInterception = this.#createAgentInterception(workflowId, rest.model, prompt);
    const agentInterceptorGenerator = this.#openAgentInterceptor(agentInterception);
    const { ToolEffectLog } = await import('../ai/tool-effect-log.ts');
    const toolEffectLog = new ToolEffectLog(this.#storage, workflowId, operation.operationId);
    const agentResult = await executeAgentLoop(
      {
        ...rest,
        modelRouter: rest.modelRouter ?? this.#defaultModelRouter,
        budget: budgetTracker,
        eventTarget: this,
        workflowId,
        agentId: operation.operationId,
        onTurnStarted: agentInterception.onTurnStarted,
        onTurnCompleted: agentInterception.onTurnCompleted,
        onToolCalled: agentInterception.onToolCalled,
        onToolReturned: agentInterception.onToolReturned,
        toolEffectLog,
      },
      prompt,
    );
    this.#closeAgentInterceptor(agentInterceptorGenerator, agentResult.content);
    this.#exposeAgentObservability(context, agentResult, rest.maxTurns ?? 10);
    this.#recordAgentContextCost(context, agentResult.totalCost);
    await this.#recordAgentBudgetCost(
      workflowId,
      operation.operationId,
      resolvedBudgetNamespace,
      agentResult.totalCost,
    );
    return agentResult.content;
  }

  async #executeSpeculativeBranch(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'speculate' }>,
  ): Promise<unknown> {
    if (!this.#inlineStrategy) {
      throw new Error('ctx.speculate() requires inline execution mode');
    }

    const parentContext = this.#inlineStrategy.getContext(workflowId);
    if (!parentContext) {
      throw new Error(`No active inline context for workflow "${workflowId}"`);
    }

    const speculativeContext = parentContext.createSpeculativeChild();
    const speculativeState = new SpeculativeExecutionState();
    const generator = operation.execute(speculativeContext);

    try {
      const result = await this.#driveSpeculativeGenerator(workflowId, generator, speculativeState);
      await speculativeState.drainVerifications();
      parentContext.commitSpeculativeChild(speculativeContext);
      return result;
    } catch (error) {
      await speculativeState.rollback();
      throw error;
    }
  }

  async #driveSpeculativeGenerator(
    workflowId: string,
    generator:
      | Generator<ContextOperationRequest, unknown, unknown>
      | AsyncGenerator<unknown, unknown, unknown>,
    speculativeState: SpeculativeExecutionState,
  ): Promise<unknown> {
    let lastResult: unknown = undefined;
    let errorToThrow: Error | undefined;

    while (true) {
      const iterationResult =
        errorToThrow === undefined
          ? await generator.next(lastResult)
          : await generator.throw(errorToThrow);

      errorToThrow = undefined;

      if (iterationResult.done) {
        return iterationResult.value;
      }

      const nextOperation = iterationResult.value as ContextOperationRequest;
      try {
        lastResult = await this.#executeSubOperation(
          workflowId,
          nextOperation,
          undefined,
          speculativeState,
        );
      } catch (error) {
        errorToThrow = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  async #createAgentBudgetTracker(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'agent' }>,
    budgetOptions: Extract<ContextOperationRequest, { type: 'agent' }>['options']['budget'],
  ): Promise<InstanceType<(typeof import('../ai/budget.ts'))['BudgetTracker']> | undefined> {
    if (!budgetOptions) {
      return undefined;
    }

    const { BudgetTracker } = await import('../ai/budget.ts');
    const { AgentBudgetWarningEvent, AgentBudgetExceededEvent } = await import('../ai/events.ts');

    return new BudgetTracker(budgetOptions, {
      onWarning: (state) => {
        const threshold = budgetOptions.warningThreshold ?? 0.8;
        const costFraction =
          budgetOptions.maxCost !== undefined && budgetOptions.maxCost > 0
            ? state.costUsed / budgetOptions.maxCost
            : 0;
        const tokenFraction =
          budgetOptions.maxTokens !== undefined && budgetOptions.maxTokens > 0
            ? state.tokensUsed / budgetOptions.maxTokens
            : 0;
        const usedPercent = Math.max(costFraction, tokenFraction);
        const event = new AgentBudgetWarningEvent(
          workflowId,
          operation.operationId,
          usedPercent,
          state.tokensRemaining,
          state.costRemaining,
          threshold,
        );
        this.dispatchEvent(event);
        this.#forwardEventToHandle(workflowId, event);
      },
      onExceeded: (state) => {
        const event = new AgentBudgetExceededEvent(
          workflowId,
          operation.operationId,
          state.tokensUsed,
          state.costUsed,
          budgetOptions.maxTokens ?? 0,
          budgetOptions.maxCost ?? 0,
        );
        this.dispatchEvent(event);
        this.#forwardEventToHandle(workflowId, event);
      },
    });
  }

  #resolveAgentBudgetNamespace(budgetNamespace: string | undefined): string | undefined {
    if (!this.#budgetPolicyEnforcer) {
      return undefined;
    }

    return (
      budgetNamespace ??
      (this.#budgetPolicyEnforcer.policies.size === 1
        ? this.#budgetPolicyEnforcer.policies.keys().next().value
        : undefined)
    );
  }

  async #checkAgentBudgetPolicy(
    workflowId: string,
    budgetOptions: Extract<ContextOperationRequest, { type: 'agent' }>['options']['budget'],
    resolvedBudgetNamespace: string | undefined,
  ): Promise<void> {
    if (!this.#budgetPolicyEnforcer || !resolvedBudgetNamespace) {
      return;
    }

    if (!budgetOptions) {
      this.dispatchEvent(
        new DevelopmentWarningEvent(
          workflowId,
          'Organization budget policy is active but ctx.agent() was called without budget options. Provide budget with model pricing to enable cost tracking and org budget enforcement.',
          [],
        ),
      );
    }

    await this.#budgetPolicyEnforcer.checkBudget(resolvedBudgetNamespace);
  }

  #exposeTokenUsageAccessor(
    context: ReturnType<InlineExecutionStrategy['getContext']> | undefined,
    budgetTracker: InstanceType<(typeof import('../ai/budget.ts'))['BudgetTracker']> | undefined,
  ): void {
    if (!context || !budgetTracker) {
      return;
    }

    const previousAccessor = context.exposedAccessors.get('tokenUsage');
    context.expose({
      tokenUsage: () => {
        const current = budgetTracker.budgetRemaining();
        if (!previousAccessor) {
          return current;
        }

        const previous = previousAccessor() as typeof current;
        const mergedBreakdown = new Map<
          string,
          { model: string; inputTokens: number; outputTokens: number; cost: number }
        >();
        for (const entry of previous.breakdown) {
          mergedBreakdown.set(entry.model, { ...entry });
        }
        for (const entry of current.breakdown) {
          const existing = mergedBreakdown.get(entry.model);
          if (existing) {
            existing.inputTokens += entry.inputTokens;
            existing.outputTokens += entry.outputTokens;
            existing.cost += entry.cost;
            continue;
          }

          mergedBreakdown.set(entry.model, { ...entry });
        }

        return {
          tokensUsed: current.tokensUsed + previous.tokensUsed,
          costUsed: current.costUsed + previous.costUsed,
          tokensRemaining: current.tokensRemaining,
          costRemaining: current.costRemaining,
          breakdown: [...mergedBreakdown.values()],
        };
      },
    });
  }

  #createAgentInterception(
    workflowId: string,
    model: string,
    prompt: string,
  ): import('./interceptor.ts').AgentInterception {
    return {
      workflowId,
      model,
      prompt,
      headers: new Map<string, string>(),
    };
  }

  #openAgentInterceptor(
    agentInterception: import('./interceptor.ts').AgentInterception,
  ): Generator<unknown, unknown, unknown> | undefined {
    const composedInterceptor = this.#getComposedWorkflowInterceptor();
    if (!composedInterceptor) {
      return undefined;
    }

    const generator = composedInterceptor.agent(
      agentInterception,
      createAgentInterceptorExecute(agentInterception),
    );
    generator.next();
    return generator;
  }

  #closeAgentInterceptor(
    generator: Generator<unknown, unknown, unknown> | undefined,
    content: string,
  ): void {
    if (generator) {
      generator.next(content);
    }
  }

  #exposeAgentObservability(
    context: ReturnType<InlineExecutionStrategy['getContext']> | undefined,
    agentResult: Awaited<ReturnType<(typeof import('../ai/agent.ts'))['executeAgentLoop']>>,
    agentMaxTurns: number,
  ): void {
    if (!context) {
      return;
    }

    const previousWaterfallAccessor = context.exposedAccessors.get('agentCostWaterfall');
    const previousConversationAccessor = context.exposedAccessors.get('agentConversation');
    const previousProjectionAccessor = context.exposedAccessors.get('agentCostProjection');
    const currentTurnCosts = agentResult.turnCosts;
    const currentConversation = agentResult.conversation;
    const currentTurnCount = agentResult.turnCount;
    const currentTotalCost = agentResult.totalCost;

    context.expose({
      agentCostWaterfall: () => {
        const previous = previousWaterfallAccessor
          ? (previousWaterfallAccessor() as typeof currentTurnCosts)
          : [];
        return [...previous, ...currentTurnCosts];
      },
      agentConversation: () => {
        const previous = previousConversationAccessor
          ? (previousConversationAccessor() as typeof currentConversation)
          : [];
        return [...previous, ...currentConversation];
      },
      agentCostProjection: () => {
        const previousProjection = previousProjectionAccessor
          ? (previousProjectionAccessor() as {
              averageCostPerTurn: number;
              turnsCompleted: number;
              maxTurns: number;
              projectedTotalCost: number;
            })
          : null;

        const totalTurns = (previousProjection?.turnsCompleted ?? 0) + currentTurnCount;
        const totalCost =
          (previousProjection
            ? previousProjection.averageCostPerTurn * previousProjection.turnsCompleted
            : 0) + currentTotalCost;
        const averageCostPerTurn = totalTurns > 0 ? totalCost / totalTurns : 0;

        return {
          averageCostPerTurn,
          turnsCompleted: totalTurns,
          maxTurns: Math.max(previousProjection?.maxTurns ?? 0, agentMaxTurns),
          projectedTotalCost:
            averageCostPerTurn * Math.max(previousProjection?.maxTurns ?? 0, agentMaxTurns),
        };
      },
    });
  }

  #recordAgentContextCost(
    context: ReturnType<InlineExecutionStrategy['getContext']> | undefined,
    totalCost: number,
  ): void {
    if (!context || totalCost <= 0) {
      return;
    }

    const previousCost = context.getAttribute<number>('weft:tokenCost') ?? 0;
    context.setAttribute('weft:tokenCost', previousCost + totalCost);
  }

  async #recordAgentBudgetCost(
    workflowId: string,
    operationId: string,
    resolvedBudgetNamespace: string | undefined,
    totalCost: number,
  ): Promise<void> {
    if (!this.#budgetPolicyEnforcer || !resolvedBudgetNamespace || totalCost <= 0) {
      return;
    }

    const chargedKey = KEYS.budgetCharged(operationId);
    const alreadyCharged =
      this.#chargedAgentOperations.has(operationId) ||
      (await this.#storage.get(chargedKey)) !== null;

    if (alreadyCharged) {
      return;
    }

    await this.#storage.put(chargedKey, encode({ cost: totalCost }));
    await this.#budgetPolicyEnforcer.recordCost(resolvedBudgetNamespace, totalCost);
    this.#chargedAgentOperations.add(operationId);

    // Maintain the reverse index so terminal cleanup is O(k) in the
    // workflow's own agent operations rather than O(N) in the engine-wide
    // dedup set.
    let workflowOperations = this.#chargedAgentOperationsByWorkflow.get(workflowId);
    if (!workflowOperations) {
      workflowOperations = new Set();
      this.#chargedAgentOperationsByWorkflow.set(workflowId, workflowOperations);
    }
    workflowOperations.add(operationId);
  }

  async #processChildWorkflowOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'child-workflow' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeChildWorkflow(
        workflowId,
        operation,
        this.#assertChildWorkflowNestingDepth(workflowId),
      ),
    );
  }

  #assertChildWorkflowNestingDepth(workflowId: string): number {
    const currentDepth = this.#getWorkflowNestingDepth(workflowId);
    if (currentDepth + 1 > this.#options.maxNestingDepth) {
      throw new Error(
        `Child workflow nesting depth exceeded: ${currentDepth + 1} exceeds maximum of ${this.#options.maxNestingDepth}. ` +
          'Configure maxNestingDepth in engine options to increase the limit.',
      );
    }

    return currentDepth;
  }

  #getWorkflowNestingDepth(workflowId: string): number {
    const currentContext = this.#inlineStrategy?.getContext(workflowId);
    return currentContext?.nestingDepth ?? this.#workflowNestingDepths.get(workflowId) ?? 0;
  }

  async #executeChildWorkflow(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'child-workflow' }>,
    currentDepth: number,
  ): Promise<unknown> {
    const rawId = operation.options?.['id'];
    const childWorkflowId = typeof rawId === 'string' ? rawId : crypto.randomUUID();
    const parentHeaders = this.#workflowHeaders.get(workflowId) ?? new Map<string, string>();
    const executeChild = async () => {
      this.#pendingNestingDepth = currentDepth + 1;
      this.#pendingParentHeaders = this.#workflowHeaders.get(workflowId);
      let childHandle: WorkflowHandle;

      try {
        childHandle = await this.start(operation.workflowType, operation.input, {
          id: childWorkflowId,
        });
      } catch (error) {
        if (error instanceof WorkflowAlreadyExistsError) {
          const [existingState, parentState] = await Promise.all([
            this.#loadWorkflowState(childWorkflowId),
            this.#loadWorkflowState(workflowId),
          ]);

          if (!existingState) {
            throw error;
          }

          const existingTenantId = existingState.tenant?.id;
          const parentTenantId = parentState?.tenant?.id;
          const tenantMatches =
            (existingTenantId === undefined && parentTenantId === undefined) ||
            (existingTenantId !== undefined &&
              parentTenantId !== undefined &&
              existingTenantId === parentTenantId);

          if (
            existingState.type !== operation.workflowType ||
            !encodedValuesEqual(existingState.input, operation.input) ||
            !tenantMatches
          ) {
            throw new Error(
              `Child workflow id collision for "${childWorkflowId}" does not match the requested child workflow`,
              { cause: error },
            );
          }

          childHandle = this.getHandle(childWorkflowId);
        } else {
          throw error;
        }
      }

      return childHandle.result();
    };

    const composedInterceptor = this.#getComposedWorkflowInterceptor();
    if (!composedInterceptor) {
      return executeChild();
    }

    return composedInterceptor.childWorkflow(
      {
        workflowId,
        childWorkflowId,
        workflowType: operation.workflowType,
        input: operation.input,
        headers: new Map<string, string>(),
        parentHeaders,
      },
      executeChild,
    );
  }

  async #processWaitReviewOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-review' }>,
  ): Promise<void> {
    return this.#runOperationWithoutResult(workflowId, operation, () =>
      this.#processReviewOperation(workflowId, operation.reviewOptions),
    );
  }

  async #processHandoffOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'handoff' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const { handoff: executeHandoff, createChildHeaders } = await import('../ai/coordination.ts');
      return executeHandoff({
        ...operation.options,
        headers: createChildHeaders(this.#workflowHeaders.get(workflowId)),
      });
    });
  }

  async #processDebateOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'debate' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const { debate: executeDebate } = await import('../ai/coordination.ts');
      return executeDebate(operation.options);
    });
  }

  async #processSuperviseOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'supervise' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const { supervise: executeSupervise } = await import('../ai/coordination.ts');
      return executeSupervise(operation.options);
    });
  }

  async #executeSubOperation(
    workflowId: string,
    operation: ContextOperationRequest,
    signal?: AbortSignal,
    speculativeState?: SpeculativeExecutionState,
  ): Promise<unknown> {
    // Check for abort before starting any sub-operation so that losing race
    // branches are skipped if the winner has already settled.
    signal?.throwIfAborted();

    switch (operation.type) {
      case 'activity':
        signal?.throwIfAborted();
        return this.#executeActivityOperationResult(workflowId, operation, speculativeState);
      case 'child-workflow':
        signal?.throwIfAborted();
        return this.#executeChildWorkflow(
          workflowId,
          operation,
          this.#assertChildWorkflowNestingDepth(workflowId),
        );
      case 'memo':
        signal?.throwIfAborted();
        return callMemoFunction(operation.fn);
      case 'parallel':
        signal?.throwIfAborted();
        const subOperationPromises: Array<Promise<unknown>> = [];
        for (const subOperation of operation.operations) {
          subOperationPromises.push(
            this.#executeSubOperation(workflowId, subOperation, signal, speculativeState),
          );
        }
        return Promise.all(subOperationPromises);
      case 'race': {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abortNestedRace = () => {
          controller.abort(signal?.reason);
        };
        signal?.addEventListener('abort', abortNestedRace, { once: true });
        const subOperations: Array<Promise<unknown>> = [];
        for (const subOperation of operation.operations) {
          subOperations.push(
            this.#executeSubOperation(
              workflowId,
              subOperation,
              controller.signal,
              speculativeState,
            ),
          );
        }
        void Promise.allSettled(subOperations);
        try {
          return await Promise.race(subOperations);
        } finally {
          signal?.removeEventListener('abort', abortNestedRace);
          controller.abort();
        }
      }
      case 'run-all':
        signal?.throwIfAborted();
        return this.#executeRunAllOperationResult(workflowId, operation, speculativeState);
      case 'agent': {
        if (speculativeState) {
          throw new Error('ctx.speculate() does not yet support ctx.agent()');
        }
        const { executeAgentLoop } = await import('../ai/agent.ts');
        const {
          prompt,
          budget: budgetOptions,
          budgetNamespace,
          contextStrategy: _contextStrategy,
          ...rest
        } = operation.options;

        // Use the shared helper so agent sub-operations get the same
        // warning/exceeded event wiring as standalone `ctx.agent()` calls.
        const budgetTracker = await this.#createAgentBudgetTracker(
          workflowId,
          operation,
          budgetOptions,
        );

        // Enforce organization-level budget policy before starting the agent
        // loop so that agents embedded in ctx.all()/ctx.race() collectively
        // count against the shared namespace cap, matching the behavior of
        // #processAgentContextOperation.
        const resolvedBudgetNamespace = this.#resolveAgentBudgetNamespace(budgetNamespace);
        await this.#checkAgentBudgetPolicy(workflowId, budgetOptions, resolvedBudgetNamespace);

        const { ToolEffectLog } = await import('../ai/tool-effect-log.ts');
        const toolEffectLog = new ToolEffectLog(this.#storage, workflowId, operation.operationId);
        const agentResult = await executeAgentLoop(
          {
            ...rest,
            budget: budgetTracker,
            // Thread the abort signal so losing branches of `ctx.race()`
            // stop consuming budget after the race settles.
            signal,
            toolEffectLog,
          },
          prompt,
        );

        // Record against org budget so multiple agents in ctx.all()/ctx.race()
        // do not bypass the namespace cap.
        await this.#recordAgentBudgetCost(
          workflowId,
          operation.operationId,
          resolvedBudgetNamespace,
          agentResult.totalCost,
        );

        // Match `#processAgentContextOperation` which unwraps the result to
        // the content string. Without this, `ctx.all()`/`ctx.race()` with
        // agent sub-operations would return the full `AgentResult` object
        // while standalone `ctx.agent()` returns the content — breaking
        // type expectations for callers.
        return agentResult.content;
      }
      default:
        throw new Error(`Unsupported sub-operation type: ${operation.type}`);
    }
  }

  #isConfiguredInlineActivity(
    fn: Function,
  ): fn is Extract<ContextOperationRequest, { type: 'activity' }>['fn'] &
    ActivityFunctionWithMetadata {
    return typeof (fn as { execute?: unknown }).execute === 'function';
  }

  async #executeRunAllOperationResult(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'run-all' }>,
    speculativeState?: SpeculativeExecutionState,
  ): Promise<Record<string, unknown>> {
    return executeRunAllBranches(
      operation.branches as Parameters<typeof executeRunAllBranches>[0],
      (fn, args) => {
        // Only speculative runAll activity branches need the full execution
        // pipeline so verification and compensation tracking are preserved.
        if (!speculativeState || !this.#isConfiguredInlineActivity(fn)) {
          return callActivityFunction(fn, args);
        }

        return this.#executeActivityOperationResult(
          workflowId,
          {
            type: 'activity',
            operationId: crypto.randomUUID(),
            activityName: fn.name,
            fn,
            args,
          },
          speculativeState,
        );
      },
    );
  }

  async #startDelayedWorkflow(entry: TimerEntry): Promise<void> {
    const state = await this.#loadWorkflowState(entry.workflowId);
    if (!state || state.status !== 'pending') {
      return;
    }

    const checkpointBytes = await this.#storage.get(KEYS.checkpoint(entry.workflowId));
    if (!checkpointBytes) {
      await this.#failWorkflow(
        entry.workflowId,
        new Error(`Checkpoint not found for delayed workflow "${entry.workflowId}"`),
      );
      return;
    }
    const checkpoint = deserializeCheckpoint(checkpointBytes);

    const registration = this.#registrations.get(state.type);
    if (!registration) {
      await this.#failWorkflow(
        entry.workflowId,
        new Error(`No workflow registered with name "${state.type}"`),
      );
      return;
    }

    const now = this.#options.getNow();
    let executionDeadline: number | undefined;
    if (entry.executionTimeoutMs !== undefined) {
      if (!Number.isFinite(entry.executionTimeoutMs) || entry.executionTimeoutMs < 0) {
        await this.#failWorkflow(
          entry.workflowId,
          new Error(`Invalid delayed execution timeout for workflow "${entry.workflowId}"`),
        );
        return;
      }

      try {
        executionDeadline = normalizeStorageTimestamp(
          now + entry.executionTimeoutMs,
          `Delayed execution timeout for workflow "${entry.workflowId}"`,
        );
      } catch {
        await this.#failWorkflow(
          entry.workflowId,
          new Error(`Invalid delayed execution timeout for workflow "${entry.workflowId}"`),
        );
        return;
      }
    }
    const runningState = await this.#runSerializedWorkflowStateWrite(entry.workflowId, async () => {
      const latestState = await this.#loadWorkflowState(entry.workflowId);
      if (!latestState || latestState.status !== 'pending') {
        return null;
      }

      const nextRunningState: WorkflowState = {
        ...latestState,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        ...(executionDeadline !== undefined && { executionDeadline }),
      };

      const operations: import('../storage/interface.ts').BatchOperation[] = [
        {
          type: 'put',
          key: KEYS.workflow(entry.workflowId),
          value: encode(nextRunningState),
        },
      ];
      if (executionDeadline !== undefined) {
        operations.push(
          ...buildTimerBatchOperations({
            id: `deadline:${entry.workflowId}`,
            workflowId: entry.workflowId,
            fireAt: executionDeadline,
            kind: 'execution-deadline',
          }),
        );
      }

      await this.#storage.batch(operations);
      return nextRunningState;
    });
    if (!runningState) {
      return;
    }

    this.#checkpoints.set(entry.workflowId, checkpoint);
    this.#workflowVersionTuples.set(
      entry.workflowId,
      this.#workflowVersionTupleFromState(runningState),
    );
    this.#setWorkflowStartHeaders(
      entry.workflowId,
      await this.#loadWorkflowStartHeaders(entry.workflowId),
    );
    if (registration.isAgent) {
      this.#agentWorkflowIds.add(entry.workflowId);
    }

    this.#beginWorkflowExecution(
      entry.workflowId,
      runningState.type,
      runningState.input,
      checkpoint,
      executionDeadline,
      runningState.tenant,
      registration,
    );
  }

  async #refreshScheduledWorkflowState(state: ScheduleState): Promise<RefreshedScheduleState> {
    if (!state.currentWorkflowId) {
      return { state, currentWorkflowState: null };
    }

    const currentWorkflowState = await this.#loadWorkflowState(state.currentWorkflowId);
    if (currentWorkflowState?.status === 'running' || currentWorkflowState?.status === 'pending') {
      return { state, currentWorkflowState };
    }

    await this.#storage.delete(KEYS.scheduleRun(state.currentWorkflowId));
    return {
      state: clearScheduleCurrentWorkflow(state),
      currentWorkflowState,
    };
  }

  async #startScheduledRun(state: ScheduleState): Promise<string> {
    const workflowId = crypto.randomUUID();
    await this.#startWorkflow(
      state.workflowType,
      state.input,
      { id: workflowId },
      { resolved: state.tenant },
      state.overlap === 'allow'
        ? undefined
        : [{ type: 'put', key: KEYS.scheduleRun(workflowId), value: encode(state.id) }],
    );
    return workflowId;
  }

  async #applyScheduleOccurrence(state: ScheduleState): Promise<ScheduleState> {
    const { state: refreshedState, currentWorkflowState } =
      await this.#refreshScheduledWorkflowState(state);
    const hasActiveWorkflow =
      currentWorkflowState?.status === 'running' || currentWorkflowState?.status === 'pending';

    switch (refreshedState.overlap) {
      case 'allow':
        await this.#startScheduledRun(refreshedState);
        return refreshedState;

      case 'cancel-running':
        if (hasActiveWorkflow && refreshedState.currentWorkflowId) {
          void this.getHandle(refreshedState.currentWorkflowId)
            .result()
            .catch(() => {});
          await this.cancel(refreshedState.currentWorkflowId);
        }
        return {
          ...refreshedState,
          currentWorkflowId: await this.#startScheduledRun(
            clearScheduleCurrentWorkflow(refreshedState),
          ),
        };

      case 'queue':
        if (hasActiveWorkflow) {
          return {
            ...refreshedState,
            queuedRuns: refreshedState.queuedRuns + 1,
          };
        }
        return {
          ...refreshedState,
          currentWorkflowId: await this.#startScheduledRun(refreshedState),
        };

      case 'skip':
      default:
        if (hasActiveWorkflow) {
          return refreshedState;
        }
        return {
          ...refreshedState,
          currentWorkflowId: await this.#startScheduledRun(refreshedState),
        };
    }
  }

  async #settleBackfillScheduleState(state: ScheduleState): Promise<ScheduleState> {
    if (!state.currentWorkflowId) {
      return state;
    }

    // Inline execution can complete or checkpoint during the same scheduler
    // turn that started the run. Wait for that first turn to finish handling
    // its outbound message before re-reading persisted schedule state.
    const pendingTurn = this.#inlineStrategy?.waitForWorkflowTurn(state.currentWorkflowId);
    if (pendingTurn) {
      await pendingTurn;
    }

    const refreshed = await this.#refreshScheduledWorkflowState(state);
    return refreshed.state;
  }

  async #handleScheduleTimer(entry: TimerEntry): Promise<void> {
    const state = await this.#loadScheduleState(entry.workflowId);
    if (!state || state.status !== 'active' || state.nextFireAt === null) {
      return;
    }
    if (state.nextFireAt !== entry.fireAt) {
      return;
    }

    let nextState = state;

    try {
      const now = this.#options.getNow();
      const dueThroughTimestamp = Math.max(now, entry.fireAt);
      const dueOccurrences = collectDueCronOccurrences(
        state.cronExpression,
        state.nextFireAt,
        dueThroughTimestamp,
        {
          maxOccurrences: state.backfill ? MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK : 2,
        },
      );
      if (dueOccurrences.length === 0) {
        return;
      }

      const isLate = now - state.nextFireAt > SCHEDULE_LATE_GRACE_MILLISECONDS;
      const shouldSkipMissedOccurrences = !state.backfill && isLate;
      const occurrencesToProcess = shouldSkipMissedOccurrences
        ? []
        : state.backfill
          ? dueOccurrences
          : dueOccurrences.slice(0, 1);

      for (const occurrence of occurrencesToProcess) {
        nextState = {
          ...(await this.#applyScheduleOccurrence(nextState)),
          lastFireAt: occurrence,
          updatedAt: now,
        };

        // Persist overlap bookkeeping before computing the next tick so a later
        // failure can safely pause the schedule without replaying the same
        // occurrence or losing the active workflow linkage.
        await this.#writeScheduleState(nextState, { includeTimer: false });

        // Backfill can process multiple missed ticks in one scheduler turn.
        // Wait for the inline strategy to finish handling the just-started
        // run's outbound message so immediately-completing workflows do not
        // look active and incorrectly suppress later catch-up occurrences
        // under overlap policies like "skip" or "queue".
        if (state.backfill && nextState.currentWorkflowId !== undefined) {
          nextState = await this.#settleBackfillScheduleState(nextState);
        }
      }

      nextState = {
        ...nextState,
        updatedAt: now,
        nextFireAt: shouldSkipMissedOccurrences
          ? getNextCronOccurrence(nextState.cronExpression, now)
          : getNextCronOccurrence(
              nextState.cronExpression,
              occurrencesToProcess.at(-1) ?? dueOccurrences.at(-1)!,
            ),
      };

      await this.#writeScheduleState(nextState);
    } catch (error) {
      const errorNow = this.#options.getNow();
      const pausedState: ScheduleState = {
        ...nextState,
        status: 'paused',
        updatedAt: errorNow,
        nextFireAt: getNextCronOccurrence(nextState.cronExpression, errorNow),
      };

      await this.#writeScheduleState(pausedState, { includeTimer: false });
      console.error(
        `[weft] Paused schedule "${pausedState.id}" after timer processing failed:`,
        error,
      );
    }
  }

  async #handleScheduledWorkflowTerminal(workflowId: string): Promise<void> {
    const scheduleRunBytes = await this.#storage.get(KEYS.scheduleRun(workflowId));
    if (!scheduleRunBytes) {
      return;
    }

    await this.#storage.delete(KEYS.scheduleRun(workflowId));
    const decodedScheduleId = decode(scheduleRunBytes);
    if (!isValidScheduleIdentifier(decodedScheduleId)) {
      return;
    }

    const scheduleId = decodedScheduleId;
    const state = await this.#loadScheduleState(scheduleId);
    if (!state || state.currentWorkflowId !== workflowId) {
      return;
    }

    const now = this.#options.getNow();
    const clearedState: ScheduleState = {
      ...clearScheduleCurrentWorkflow(state),
      updatedAt: now,
    };

    if (
      clearedState.status === 'active' &&
      clearedState.overlap === 'queue' &&
      clearedState.queuedRuns > 0
    ) {
      const nextWorkflowId = await this.#startScheduledRun(clearedState);
      await this.#writeScheduleState(
        {
          ...clearedState,
          currentWorkflowId: nextWorkflowId,
          queuedRuns: clearedState.queuedRuns - 1,
          updatedAt: now,
        },
        { includeTimer: false },
      );
      return;
    }

    await this.#writeScheduleState(clearedState, { includeTimer: false });
  }

  async #handleTimerFired(entry: TimerEntry): Promise<void> {
    // Check if this timer is for a review escalation/timeout
    if (entry.id.startsWith('review-escalation:') || entry.id.startsWith('review-timeout:')) {
      // Extract reviewId from the timer ID
      const parts = entry.id.split(':');
      const reviewId = parts[1]!;
      const handler = this.#reviewEscalationHandlers.get(reviewId);
      if (handler) {
        // Guard: skip if the workflow is no longer running (e.g. cancelled/failed concurrently)
        const state = await this.#loadWorkflowState(entry.workflowId);
        if (!state || state.status !== 'running') return;
        await handler(entry);
      }
      return;
    }

    if (entry.kind === 'delayed-start') {
      await this.#startDelayedWorkflow(entry);
      return;
    }

    if (entry.kind === 'schedule') {
      await this.#handleScheduleTimer(entry);
      return;
    }

    if (entry.kind === 'sleep') {
      // Extract the operation ID from the timer ID (format: "sleep:<operationId>")
      const operationId = entry.id.replace('sleep:', '');
      const resolverKey = `${entry.workflowId}:${operationId}`;
      const resolver = this.#sleepResolvers.get(resolverKey);
      if (resolver) {
        this.#sleepResolvers.delete(resolverKey);
        const workflowOps = this.#sleepResolversByWorkflow.get(entry.workflowId);
        if (workflowOps) {
          workflowOps.delete(operationId);
          if (workflowOps.size === 0) this.#sleepResolversByWorkflow.delete(entry.workflowId);
        }
        resolver();
      }
    } else if (entry.kind === 'execution-deadline') {
      await this.timeout(entry.workflowId);
    }
  }

  /** Remove all pending review entries from storage for a given workflow. */
  async #cleanupReviews(workflowId: string): Promise<void> {
    const prefix = `review:${encodeStorageKeyComponent(workflowId)}:`;
    if (this.#storage.deletePrefix) {
      await this.#storage.deletePrefix(prefix);
      return;
    }
    const deleteOperations: import('../storage/interface.ts').BatchOperation[] = [];
    for await (const [key] of this.#storage.scan(prefix)) {
      deleteOperations.push({ type: 'delete', key });
    }
    if (deleteOperations.length > 0) {
      await this.#storage.batch(deleteOperations);
    }
  }

  /**
   * Remove durable records keyed by `workflowId` that otherwise leak after a
   * workflow reaches a terminal state.
   *
   * - When `includeOutputArtifacts` is `false` (used by `#completeWorkflow`
   *   and `#failWorkflow`), only internal bookkeeping is swept: pending
   *   signals. Output artifacts — offloaded values, blob stream chunks,
   *   shared state, and event history — are preserved so consumers can
   *   still read them via `getStreamChunks()`, `getOffload()`,
   *   `Engine.getEvents()`, etc. after `handle.result()` resolves.
   * - When `includeOutputArtifacts` is `true` (used by `#terminateWorkflow`),
   *   the workflow has been cancelled or timed out and no consumer is
   *   waiting on output artifacts, so everything except `ev:` (preserved
   *   for the events endpoint) is removed.
   *
   * Concurrency note: we assume all writers for a workflow's prefixed keys
   * originate from that workflow's own execution. By the time this runs, the
   * workflow is already terminal and cannot schedule new writes —
   * `#completeWorkflow`, `#failWorkflow`, and `#terminateWorkflow` all await
   * this method before returning. Any write that races the scan must have
   * come from a background task that itself holds a handle to the terminal
   * workflow, and those are caller-level bugs we don't try to paper over here.
   *
   * Scale note: deletes are flushed in batches of `CLEANUP_BATCH_SIZE` so
   * workflows with many blobs/signals do not allocate a single oversized
   * operation array.
   */
  async #cleanupWorkflowStorage(
    workflowId: string,
    includeOutputArtifacts: boolean,
  ): Promise<void> {
    const encodedWorkflowId = encodeStorageKeyComponent(workflowId);

    // Always sweep internal state. Signals are workflow-scoped scratch space,
    // and the tool-effect log holds per-tool-call dedup records that have no
    // consumers after the workflow terminates — leaving them behind would
    // leak linearly with tool-call volume across the engine's lifetime.
    const prefixes: string[] = [`sig:${encodedWorkflowId}:`, `tool-effect:${encodedWorkflowId}:`];

    if (includeOutputArtifacts) {
      // Terminated workflows have no waiting consumers, so drop the output
      // artifacts too. Event history is still preserved via the omission of
      // the `ev:` prefix — callers that want it gone should use a storage
      // TTL or explicit pruning.
      prefixes.push(
        `offload:${encodedWorkflowId}:`,
        `blob:${encodedWorkflowId}:`,
        `shared:${encodedWorkflowId}:`,
      );
    }

    await this.#storage.delete(KEYS.workflowHeaders(workflowId));

    // Use the storage adapter's native prefix deletion when available
    // (e.g., BunSQLiteStorage's prepared DELETE...WHERE key >= ? AND key < ?).
    // This replaces per-key scan-then-delete loops with a single SQL statement
    // per prefix — a significant win on the activity-completion hot path.
    // Deletions are sequential to avoid multiplying memory pressure on adapters
    // that materialize matching keys before deleting.
    if (this.#storage.deletePrefix) {
      for (const prefix of prefixes) {
        await this.#storage.deletePrefix(prefix);
      }
      return;
    }

    // Fallback for storage adapters without deletePrefix: scan and batch-delete.
    const CLEANUP_BATCH_SIZE = 500;
    let deleteOperations: import('../storage/interface.ts').BatchOperation[] = [];
    const flush = async (): Promise<void> => {
      if (deleteOperations.length === 0) return;
      await this.#storage.batch(deleteOperations);
      deleteOperations = [];
    };

    for (const prefix of prefixes) {
      for await (const [key] of this.#storage.scan(prefix)) {
        deleteOperations.push({ type: 'delete', key });
        if (deleteOperations.length >= CLEANUP_BATCH_SIZE) {
          await flush();
        }
      }
    }

    await flush();
  }

  /**
   * Shared cleanup invoked from every terminal-state transition (complete,
   * fail, cancel, timeout). Drops in-memory state (checkpoints, heartbeat
   * details, agent workflow membership, waiters) and deletes durable records
   * under workflow-keyed storage prefixes. Also releases the per-workflow
   * set of charged agent operation IDs so `#chargedAgentOperations` cannot
   * grow unbounded across the engine's lifetime.
   *
   * `includeOutputArtifacts` controls whether the caller has any consumers
   * still waiting to read streams/offload/shared state from the terminal
   * workflow. `#completeWorkflow` and `#failWorkflow` pass `false` so those
   * artifacts remain queryable after `handle.result()` resolves; only
   * `#terminateWorkflow` (cancel/timeout) passes `true`.
   */
  async #cleanupTerminalWorkflow(
    workflowId: string,
    includeOutputArtifacts: boolean,
  ): Promise<void> {
    // In-memory state
    this.#checkpoints.delete(workflowId);
    this.#heartbeatDetails.delete(workflowId);
    this.#agentWorkflowIds.delete(workflowId);
    this.#eventLogHeads.delete(workflowId);
    this.#pendingTimelineEntries.delete(workflowId);
    this.#workflowVersionTuples.delete(workflowId);
    this.#cleanupWaiters(workflowId);

    // Release the workflow's agent operation dedup entries via the reverse
    // index. O(k) in this workflow's own agent operations rather than O(N)
    // in the engine-wide set — important for long-lived engines that run
    // many agents across many workflows.
    //
    // Also queue the per-operation `budget-charged:{operationId}` durable
    // keys for deletion. These are not workflow-scoped in storage, so we
    // have to build the batch from the reverse index before dropping it.
    const budgetChargedDeletes = this.#releaseChargedAgentOperations(workflowId);

    // Durable records
    await this.#cleanupReviews(workflowId);
    await this.#cleanupWorkflowStorage(workflowId, includeOutputArtifacts);
    if (budgetChargedDeletes.length > 0) {
      await this.#storage.batch(budgetChargedDeletes);
    }
  }

  /**
   * Handle a `wait-review` operation: create a durable review request,
   * dispatch events, fire webhooks, set up escalation timers, and block
   * until a decision arrives via `submitReview()`.
   */
  async #processReviewOperation(workflowId: string, options: HumanReviewOptions): Promise<void> {
    const now = this.#options.getNow();

    // Create a review request in storage
    const reviewOptions: import('../ai/human-review.ts').ReviewOptions = {
      artifact: options.artifact,
    };
    if (options.reviewType !== undefined) reviewOptions.reviewType = options.reviewType;
    if (options.reviewers !== undefined) reviewOptions.reviewers = options.reviewers;
    if (options.allowPartial !== undefined) reviewOptions.allowPartial = options.allowPartial;
    if (options.timeout !== undefined) reviewOptions.timeout = options.timeout;
    if (options.escalation !== undefined) reviewOptions.escalation = options.escalation;
    if (options.webhookUrl !== undefined) reviewOptions.webhookUrl = options.webhookUrl;

    const reviewRequest = await this.#reviewCoordinator.createReview(workflowId, reviewOptions);

    const reviewId = reviewRequest.reviewId;

    // Dispatch HumanReviewRequestedEvent
    this.dispatchEvent(
      new HumanReviewRequestedEvent(
        workflowId,
        reviewId,
        reviewRequest.reviewType,
        reviewRequest.reviewers,
      ),
    );

    // Fire webhook notification with cancellation support tied to engine lifecycle
    if (options.webhookUrl) {
      const webhookAbort = new AbortController();
      this.#pendingWebhooks.add(webhookAbort);
      void this.#sendReviewWebhook(workflowId, reviewRequest, options.webhookUrl, webhookAbort);
    }

    // Set up escalation timers and track their IDs for cleanup
    const timerIds: string[] = [];
    if (options.escalation && options.escalation.length > 0) {
      for (const step of options.escalation) {
        const fireAt = now + step.after;
        const timerId = `review-escalation:${reviewId}:${step.after}`;
        timerIds.push(timerId);
        await this.#scheduler.schedule({
          id: timerId,
          workflowId,
          fireAt,
          kind: 'sleep', // Reuse sleep kind — the timer handler checks the id prefix
        });
      }
    }

    // Set up timeout timer
    if (options.timeout !== undefined) {
      const timeoutFireAt = now + options.timeout;
      const timeoutTimerId = `review-timeout:${reviewId}`;
      timerIds.push(timeoutTimerId);
      await this.#scheduler.schedule({
        id: timeoutTimerId,
        workflowId,
        fireAt: timeoutFireAt,
        kind: 'sleep',
      });
    }

    // Wait for the review decision (blocks the workflow generator).
    // We use a result-or-error wrapper instead of rejection to avoid
    // unhandled rejection timing issues with bun:test.
    const { promise, resolve } = Promise.withResolvers<
      { ok: true; value: HumanReviewResult } | { ok: false; error: Error }
    >();
    const waiterKey = `${workflowId}:${reviewId}`;
    this.#reviewWaiters.set(waiterKey, this.#resolveReviewDecision.bind(this, resolve));
    this.#trackWaiterKey(this.#reviewWaitersByWorkflow, workflowId, waiterKey);

    // Register the escalation handler and track the reviewId → workflowId association
    this.#reviewEscalationHandlers.set(
      reviewId,
      this.#handleReviewEscalationTimer.bind(
        this,
        workflowId,
        reviewId,
        waiterKey,
        reviewRequest,
        options,
        resolve,
      ),
    );
    if (timerIds.length > 0) {
      this.#reviewTimerIds.set(reviewId, timerIds);
    }
    let reviewIdSet = this.#workflowReviewIds.get(workflowId);
    if (!reviewIdSet) {
      reviewIdSet = new Set();
      this.#workflowReviewIds.set(workflowId, reviewIdSet);
    }
    reviewIdSet.add(reviewId);

    const outcome = await promise;

    // Clean up escalation handler, timer IDs, and workflow-reviewId tracking
    this.#reviewEscalationHandlers.delete(reviewId);
    this.#reviewTimerIds.delete(reviewId);
    const trackedIds = this.#workflowReviewIds.get(workflowId);
    if (trackedIds) {
      trackedIds.delete(reviewId);
      if (trackedIds.size === 0) this.#workflowReviewIds.delete(workflowId);
    }

    // Cancel any remaining escalation/timeout timers
    if (options.escalation) {
      for (const step of options.escalation) {
        await this.#scheduler.cancel(`review-escalation:${reviewId}:${step.after}`, workflowId);
      }
    }
    if (options.timeout !== undefined) {
      await this.#scheduler.cancel(`review-timeout:${reviewId}`, workflowId);
    }

    if (!outcome.ok) {
      // The workflow was already failed directly (e.g., by the timeout handler).
      // Just return without feeding a result.
      return;
    }

    this.#feedOperationResult(workflowId, { status: 'completed', value: outcome.value });
  }

  async #consumeSignal(workflowId: string, signalName: string): Promise<ConsumedSignalResult> {
    const prefix = `sig:${encodeStorageKeyComponent(workflowId)}:${signalName}:`;
    for await (const [key, value] of this.#storage.scan(prefix, { limit: 1 })) {
      await this.#storage.delete(key);
      return { found: true, payload: decode(value) };
    }
    return { found: false };
  }

  /**
   * Remove any pending signal, update, and sleep waiters for a workflow. This
   * prevents memory leaks and ensures that cancelled/completed/failed workflows
   * cannot accept new signals, updates, or resolve orphaned sleep timers.
   */
  #cleanupWaiters(workflowId: string): void {
    const signalKeys = this.#signalWaitersByWorkflow.get(workflowId);
    if (signalKeys) {
      for (const key of signalKeys) this.#signalWaiters.delete(key);
      this.#signalWaitersByWorkflow.delete(workflowId);
    }
    const updateKeys = this.#updateWaitersByWorkflow.get(workflowId);
    if (updateKeys) {
      for (const key of updateKeys) this.#updateWaiters.delete(key);
      this.#updateWaitersByWorkflow.delete(workflowId);
    }
    const reviewKeys = this.#reviewWaitersByWorkflow.get(workflowId);
    if (reviewKeys) {
      for (const key of reviewKeys) this.#reviewWaiters.delete(key);
      this.#reviewWaitersByWorkflow.delete(workflowId);
    }
    const sleepOps = this.#sleepResolversByWorkflow.get(workflowId);
    if (sleepOps) {
      for (const operationId of sleepOps) {
        const key = `${workflowId}:${operationId}`;
        const resolver = this.#sleepResolvers.get(key);
        if (resolver) resolver();
        this.#sleepResolvers.delete(key);
      }
      this.#sleepResolversByWorkflow.delete(workflowId);
    }
    // Clean up any review escalation handlers and their scheduled timers
    const reviewIds = this.#workflowReviewIds.get(workflowId);
    if (reviewIds) {
      for (const reviewId of reviewIds) {
        this.#reviewEscalationHandlers.delete(reviewId);
        const timers = this.#reviewTimerIds.get(reviewId);
        if (timers) {
          for (const timerId of timers) {
            void this.#swallowPromiseRejection(this.#scheduler.cancel(timerId, workflowId));
          }
          this.#reviewTimerIds.delete(reviewId);
        }
      }
      this.#workflowReviewIds.delete(workflowId);
    }

    this.#workflowNestingDepths.delete(workflowId);
    this.#workflowHeaders.delete(workflowId);
  }

  // -------------------------------------------------------------------------
  // Private: state management
  // -------------------------------------------------------------------------

  async #runSerializedWorkflowStateWrite<TResult>(
    workflowId: string,
    writeOperation: () => Promise<TResult>,
  ): Promise<TResult> {
    const previousWrite = this.#workflowStateWriteChains.get(workflowId) ?? Promise.resolve();
    const execution = previousWrite.catch(() => undefined).then(writeOperation);
    const settledExecution = execution.then(
      () => undefined,
      () => undefined,
    );

    this.#workflowStateWriteChains.set(workflowId, settledExecution);

    try {
      return await execution;
    } finally {
      if (this.#workflowStateWriteChains.get(workflowId) === settledExecution) {
        this.#workflowStateWriteChains.delete(workflowId);
      }
    }
  }

  async #completeWorkflow(workflowId: string, result: unknown): Promise<void> {
    const completionMetadata = await this.#runSerializedWorkflowStateWrite(workflowId, async () => {
      const state = await this.#loadWorkflowState(workflowId);
      if (!state || state.status !== 'running') {
        return null;
      }

      const now = this.#options.getNow();
      const duration = now - getWorkflowExecutionStartedAt(state);

      // Batch the completion state write with attribute index cleanup into a
      // single storage transaction to reduce round-trips on the hot path.
      const updatedState = {
        ...state,
        status: 'completed' as const,
        result,
        updatedAt: now,
      };
      const completionOperations: import('../storage/interface.ts').BatchOperation[] = [
        ...this.#buildTerminalWorkflowIndexOperations(state, updatedState),
        { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
      ];
      const pendingTimelineOperation = this.#buildPendingTimelineOperation(workflowId);
      if (pendingTimelineOperation) {
        completionOperations.push(pendingTimelineOperation);
      }

      // Inline attribute cleanup into the same batch instead of a separate
      // storage.get() + storage.batch() round-trip.
      const attributeBytes = await this.#storage.get(KEYS.attribute(workflowId));
      if (attributeBytes) {
        const currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
        const retainedAttributes = this.#buildRetainedTerminalSearchAttributes(currentAttributes);

        completionOperations.push(
          ...buildIndexOperations(workflowId, currentAttributes, retainedAttributes),
        );
        if (Object.keys(retainedAttributes).length > 0) {
          completionOperations.push({
            type: 'put',
            key: KEYS.attribute(workflowId),
            value: encode(retainedAttributes),
          });
        } else {
          completionOperations.push({ type: 'delete', key: KEYS.attribute(workflowId) });
        }
      }

      await this.#commitWorkflowStateOperations(state, completionOperations, {
        releaseTenantQuota: true,
      });
      return { duration };
    });
    if (!completionMetadata) return;

    const { duration } = completionMetadata;

    // Cancel deadline timer — fire-and-forget since the workflow is already
    // terminal and a stale timer firing will see the terminal state and no-op.
    void this.#swallowPromiseRejection(
      this.#scheduler.cancel(`deadline:${workflowId}`, workflowId),
    );

    // Drop in-memory state, release charged operations, and delete durable
    // workflow-keyed records (reviews, pending signals, per-workflow dedup).
    // Output artifacts (offload, blob, shared, events) are preserved so
    // consumers can still read them after `handle.result()` resolves.
    const resolver = this.#resultResolvers.get(workflowId);
    try {
      await this.#cleanupTerminalWorkflow(workflowId, false);

      const event = new WorkflowCompletedEvent(workflowId, result, duration);
      this.dispatchEvent(event);
      this.#forwardEventToHandle(workflowId, event);

      this.#broadcast({ type: 'workflow:completed', workflowId });

      if (resolver) resolver.resolve(result);
      // Scheduled queue handoff is best-effort cleanup and must not block
      // terminal delivery or handle settlement.
      void this.#finalizeScheduledWorkflowTerminal(workflowId);
    } catch (cleanupError) {
      // Settle the resolver so handle.result() callers are not stranded.
      if (resolver) resolver.resolve(result);
      throw cleanupError;
    } finally {
      this.#resultResolvers.delete(workflowId);
    }
  }

  async #failWorkflow(
    workflowId: string,
    error: Error,
    failureCategory: FailureCategory = 'system',
  ): Promise<void> {
    const attributeBytes = await this.#storage.get(KEYS.attribute(workflowId));
    const attributes = attributeBytes
      ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
      : {};
    const retainedAttributes = this.#buildRetainedTerminalSearchAttributes(attributes, {
      failureCategory,
    });

    const stateUpdate: Partial<WorkflowState> = {
      status: 'failed',
      error: error.message,
      failureCategory,
    };
    if (error.stack !== undefined) {
      stateUpdate.errorStack = error.stack;
    }
    const failureResult = await this.#updateWorkflowState(workflowId, stateUpdate, {
      allowedStatuses: ['running', 'pending'],
      releaseTenantQuota: true,
      buildAdditionalOperations: (_previousState, updatedAt) => {
        this.#finalizePendingTimelineEntry(workflowId, 'failed', error.message, updatedAt);
        const pendingTimelineOperation = this.#buildPendingTimelineOperation(workflowId);
        return pendingTimelineOperation ? [pendingTimelineOperation] : [];
      },
    });
    if (!failureResult) {
      return;
    }

    // Clean up user-set attribute indexes; fire-and-forget the deadline
    // timer cancel since the workflow is terminal.
    await this.#cleanupAttributeIndex(workflowId, attributes);
    void this.#swallowPromiseRejection(
      this.#scheduler.cancel(`deadline:${workflowId}`, workflowId),
    );

    // Re-write engine-managed terminal attributes so they remain queryable
    // after the user-defined search attributes have been removed.
    await this.#writeRetainedTerminalSearchAttributes(workflowId, retainedAttributes);

    // Drop in-memory state, release charged operations, and delete durable
    // workflow-keyed records (reviews, pending signals, per-workflow dedup).
    // Output artifacts (offload, blob, shared, events) are preserved so
    // consumers can still read them after `handle.result()` rejects.
    const resolver = this.#resultResolvers.get(workflowId);
    try {
      await this.#cleanupTerminalWorkflow(workflowId, false);

      const event = new WorkflowFailedEvent(workflowId, error);
      this.dispatchEvent(event);
      this.#forwardEventToHandle(workflowId, event);

      if (resolver) resolver.reject(error);
      // Scheduled queue handoff is best-effort cleanup and must not block
      // terminal delivery or handle settlement.
      void this.#finalizeScheduledWorkflowTerminal(workflowId);
    } catch (cleanupError) {
      // Settle the resolver so handle.result() callers are not stranded.
      if (resolver) resolver.reject(error);
      throw cleanupError;
    } finally {
      this.#resultResolvers.delete(workflowId);
    }
  }

  /**
   * Keep engine-managed terminal attributes queryable after the broader
   * attribute cleanup removes user-defined search attributes.
   */
  #buildRetainedTerminalSearchAttributes(
    currentAttributes: Record<string, SearchAttributeValue>,
    additionalAttributes?: Record<string, SearchAttributeValue>,
  ): Record<string, SearchAttributeValue> {
    const retainedAttributes = Object.fromEntries(
      Object.entries(currentAttributes).filter(([key]) => key.startsWith('weft:')),
    ) as Record<string, SearchAttributeValue>;

    return {
      ...retainedAttributes,
      ...additionalAttributes,
    };
  }

  async #writeRetainedTerminalSearchAttributes(
    workflowId: string,
    attributes: Record<string, SearchAttributeValue>,
  ): Promise<void> {
    if (Object.keys(attributes).length === 0) {
      return;
    }

    const indexOperations = buildIndexOperations(workflowId, {}, attributes);
    await this.#storage.batch([
      { type: 'put', key: KEYS.attribute(workflowId), value: encode(attributes) },
      ...indexOperations,
    ]);
  }

  async #updateWorkflowState(
    workflowId: string,
    updates: Partial<WorkflowState>,
    options: WorkflowStateUpdateOptions = {},
  ): Promise<WorkflowStateUpdateResult | null> {
    return await this.#runSerializedWorkflowStateWrite(workflowId, async () => {
      const bytes = await this.#storage.get(KEYS.workflow(workflowId));
      if (!bytes) {
        return null;
      }

      const state = decodeWorkflowState(bytes);
      if (options.allowedStatuses && !options.allowedStatuses.includes(state.status)) {
        return null;
      }

      const updatedAt = this.#options.getNow();
      const updated = {
        ...state,
        ...updates,
        updatedAt,
      };
      const additionalOperations = options.buildAdditionalOperations?.(state, updatedAt) ?? [];
      const commitOptions =
        options.releaseTenantQuota === true ? { releaseTenantQuota: true } : undefined;

      await this.#commitWorkflowStateOperations(
        state,
        [
          ...this.#buildTerminalWorkflowIndexOperations(state, updated),
          { type: 'put', key: KEYS.workflow(workflowId), value: encode(updated) },
          ...additionalOperations,
        ],
        commitOptions,
      );

      return {
        previousState: state,
        updatedAt,
      };
    });
  }
  #normalizeStartWorkflowTags(tags: unknown, fieldName = 'options.tags'): string[] | undefined {
    if (tags === undefined) {
      return undefined;
    }

    return normalizeWorkflowTags(coerceStartWorkflowTags(tags, fieldName));
  }

  async #mutateWorkflowTags(
    workflowId: string,
    tags: string[],
    mode: 'add' | 'remove',
  ): Promise<boolean> {
    return await this.#runSerializedWorkflowStateWrite(workflowId, async () => {
      const bytes = await this.#storage.get(KEYS.workflow(workflowId));
      if (!bytes) {
        throw new WorkflowNotFoundError(workflowId);
      }

      const state = decodeWorkflowState(bytes);
      const currentTags = normalizeWorkflowTags(state.tags) ?? [];
      const requestedTags = this.#normalizeStartWorkflowTags(tags, 'Workflow tags') ?? [];
      if (requestedTags.length === 0) {
        return false;
      }

      const nextTagSet = new Set(currentTags);
      for (const tag of requestedTags) {
        if (mode === 'add') {
          nextTagSet.add(tag);
        } else {
          nextTagSet.delete(tag);
        }
      }

      const nextTags = normalizeWorkflowTags([...nextTagSet]);
      if (mode === 'add' && nextTags !== undefined) {
        assertWorkflowTagCount(nextTags, 'Workflow tags');
      }
      const unchanged =
        currentTags.length === (nextTags?.length ?? 0) &&
        currentTags.every((tag, index) => tag === nextTags?.[index]);
      if (unchanged) {
        return false;
      }

      const updatedState: WorkflowState = {
        ...state,
        updatedAt: this.#options.getNow(),
      };
      if (nextTags !== undefined) {
        updatedState.tags = nextTags;
      } else {
        delete updatedState.tags;
      }

      await this.#storage.batch([
        ...this.#buildTerminalWorkflowIndexOperations(state, updatedState),
        { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
        ...buildWorkflowTagIndexOperations(workflowId, currentTags, nextTags),
      ]);

      return true;
    });
  }

  async #bulkMutateWorkflowTags(
    filter: ListFilter,
    tags: string[],
    mode: 'add' | 'remove',
  ): Promise<BulkTagResult> {
    assertScopedBulkWorkflowFilter(filter);
    const workflowIdsToMutate = await this.#snapshotMatchingWorkflowIds(filter);

    let modified = 0;
    for (const workflowId of workflowIdsToMutate) {
      let changed = false;
      try {
        changed = await this.#mutateWorkflowTags(workflowId, tags, mode);
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) {
          throw error;
        }
      }

      if (changed) {
        modified += 1;
      }
    }

    return { modified };
  }
  async #loadWorkflowState(workflowId: string): Promise<WorkflowState | null> {
    const bytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!bytes) return null;
    return decodeWorkflowState(bytes);
  }

  async #loadWorkflowResult(workflowId: string): Promise<unknown> {
    const state = await this.#loadWorkflowState(workflowId);
    if (!state) throw new Error(`Workflow "${workflowId}" not found`);
    if (state.status === 'completed') return state.result;
    if (state.status === 'failed') {
      const restoredError = new Error(state.error ?? 'Workflow failed');
      if (state.errorStack) restoredError.stack = state.errorStack;
      throw restoredError;
    }
    if (state.status === 'cancelled') throw new Error('Workflow cancelled');
    if (state.status === 'timed-out') {
      const elapsed = state.executionDeadline
        ? state.executionDeadline - getWorkflowExecutionStartedAt(state)
        : 0;
      throw new WorkflowTimeoutError(workflowId, 'execution', elapsed);
    }
    throw new Error(`Workflow "${workflowId}" is still ${state.status}`);
  }

  async #commitWorkflowStateOperations(
    state: WorkflowState,
    operations: import('../storage/interface.ts').BatchOperation[],
    options?: { releaseTenantQuota?: boolean },
  ): Promise<void> {
    if (options?.releaseTenantQuota && state.tenant !== undefined) {
      await this.#tenantQuotaManager.commitTerminalTransition({
        tenantId: state.tenant.id,
        workflowId: state.id,
        operations,
      });
      return;
    }

    await this.#storage.batch(operations);
  }

  // -------------------------------------------------------------------------
  // Private: event forwarding to handles
  // -------------------------------------------------------------------------

  #forwardEventToHandle(workflowId: string, event: Event): void {
    const entry = this.#handleCache.get(workflowId);
    if (!entry) return;
    const handle = entry.ref.deref();
    if (!handle) return;
    // Re-dispatch the typed event so handle listeners receive the full event
    // with all custom properties (workflowId, timeoutType, error, etc.).
    handle.dispatchEvent(event);
  }

  // -------------------------------------------------------------------------
  // Private: activity execution through interceptors
  // -------------------------------------------------------------------------

  /**
   * Resolve the activity function for a given operation. Checks the activity
   * registry first (required for worker mode where `operation.fn` is undefined),
   * then falls back to `operation.fn` for inline mode.
   */
  #resolveActivityFunction(
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): (...arguments_: unknown[]) => unknown {
    const registered = this.#activityRegistry.resolve(operation.activityName);
    if (registered) return registered;
    if (operation.fn) return operation.fn as (...arguments_: unknown[]) => unknown;
    throw new Error(
      `No activity registered with name "${operation.activityName}". ` +
        'In worker mode, activities must be registered via engine.registerActivity().',
    );
  }

  async #invokeWorkerActivity(
    operationId: string,
    activityName: string,
    args: unknown[],
  ): Promise<unknown> {
    const dispatcher = this.#activityWorkerDispatcher;
    if (!dispatcher) {
      throw new Error(`No activity worker dispatcher available for "${activityName}"`);
    }

    const result = await dispatcher.execute({
      operationId,
      activityName,
      input: args.length === 1 ? args[0] : args,
      attempt: 1,
    });
    if (result.status === 'failed') {
      throw new Error(result.error);
    }

    return result.value;
  }

  #invokeInlineActivity(
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
    activityContext: import('./types.ts').ActivityContext,
    _activityName: string,
    args: unknown[],
  ): unknown {
    const activityFunction = this.#resolveActivityFunction(operation);
    return callActivityFunction(activityFunction, [...args, activityContext]);
  }

  /**
   * Execute an activity function, dispatching to a Web Worker pool when
   * `activityExecution` is configured, or running inline on the main thread.
   */
  async #executeActivity(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): Promise<unknown> {
    const activityArguments = operation.args ?? [];

    // Build an ActivityContext so the activity function can send heartbeats.
    const abortController = this.#inlineStrategy?.getAbortController(workflowId);
    const activityContext: import('./types.ts').ActivityContext = {
      signal: abortController?.signal ?? new AbortController().signal,
      heartbeat: (details?: unknown) => {
        this.#heartbeatDetails.set(workflowId, details);
      },
    };

    // Build the leaf executor: either dispatch to a worker or call inline.
    const invokeActivity = this.#activityWorkerDispatcher
      ? this.#invokeWorkerActivity.bind(this, operation.operationId)
      : this.#invokeInlineActivity.bind(this, operation, activityContext);

    // If there are activity interceptors, use cached composition
    const composedActivity = this.#getComposedActivityInterceptor();
    if (composedActivity) {
      const activityInterception = {
        workflowId,
        activityName: operation.activityName,
        input: activityArguments.length === 1 ? activityArguments[0] : activityArguments,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      const result = await composedActivity.execute(activityInterception, async (interception) => {
        const args = Array.isArray(interception.input) ? interception.input : [interception.input];
        return invokeActivity(operation.activityName, args);
      });

      // Capture interceptor headers onto the operation for dispatch
      if (activityInterception.headers.size > 0) {
        (operation as Record<string, unknown>)['headers'] = [
          ...activityInterception.headers.entries(),
        ];
      }

      return result;
    }

    // If there are workflow interceptors with activity hooks, use cached composition
    const composedWorkflow = this.#getComposedWorkflowInterceptor();
    if (composedWorkflow) {
      const interception = {
        workflowId,
        activityName: operation.activityName,
        input: activityArguments.length === 1 ? activityArguments[0] : activityArguments,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      function* execute(): Generator<unknown, unknown, unknown> {
        const result = invokeActivity(operation.activityName, activityArguments);
        yield result;
        return result;
      }

      const generator = composedWorkflow.activity(interception, execute);
      let current: IteratorResult<unknown, unknown> = generator.next();
      while (!current.done) {
        current = generator.next(current.value);
      }

      // Capture interceptor headers onto the operation for dispatch
      if (interception.headers.size > 0) {
        (operation as Record<string, unknown>)['headers'] = [...interception.headers.entries()];
      }

      return current.value;
    }

    return invokeActivity(operation.activityName, activityArguments);
  }

  // -------------------------------------------------------------------------
  // Private: development mode checkpoint validation
  // -------------------------------------------------------------------------

  #validateDevelopmentCheckpoint(workflowId: string): void {
    if (!this.#options.development) return;

    const context = this.#inlineStrategy?.getContext(workflowId);
    if (!context) return;

    const step = context.stepIndex;
    const current = this.#checkpoints.get(workflowId);
    if (!current) return;
    const result = validateCheckpointRoundTrip(current);

    if (!result.valid) {
      const fieldPaths = result.divergences.map((divergence) => divergence.path);
      const message = `Checkpoint at step ${step} has ${result.divergences.length} non-serializable field(s)`;
      this.dispatchEvent(new DevelopmentWarningEvent(workflowId, message, fieldPaths));
    }
  }

  /**
   * Invoke an update handler, checking that it does not return a generator.
   * Centralises the runtime generator guard for both the inline-handler path
   * in `update()` and the pending-drain path on resume.
   */
  async #invokeUpdateHandler(
    name: string,
    handler: (payload: unknown) => unknown,
    payload: unknown,
  ): Promise<unknown> {
    const result = handler(payload);
    if (isGeneratorResult(result)) {
      throw new TypeError(
        `Update handler "${name}" returned a generator. ` +
          'Update handlers must return a plain value or a Promise, not a generator.',
      );
    }
    return await result;
  }

  /**
   * Process pending coordinated updates that match registered inline handlers.
   * Called on resume to drain updates that arrived while the workflow was paused.
   */
  async #processPendingUpdatesForHandlers(workflowId: string): Promise<void> {
    const context = this.#inlineStrategy?.getContext(workflowId);
    if (!context) return;

    const handlers = context.updateHandlers;
    if (handlers.size === 0) return;

    // getPendingUpdates returns FIFO-sorted results.
    const pendingUpdates = await this.#updateCoordinator.getPendingUpdates(workflowId);
    if (pendingUpdates.length === 0) return;

    for (const update of pendingUpdates) {
      const handler = handlers.get(update.name);
      if (!handler) continue;

      this.dispatchEvent(
        new UpdateReceivedEvent(update.updateId, workflowId, update.name, update.payload),
      );

      let result: unknown;
      let error: string | undefined;
      try {
        result = await this.#invokeUpdateHandler(update.name, handler, update.payload);
      } catch (handlerError) {
        error = handlerError instanceof Error ? handlerError.message : String(handlerError);
      }

      const responseOperations = this.#updateCoordinator.buildResponseOperations(
        update.updateId,
        workflowId,
        result,
        error,
        update.idempotencyKey,
      );
      await this.#storage.batch(responseOperations);

      this.dispatchEvent(
        new UpdateCompletedEvent(update.updateId, workflowId, update.name, result, error),
      );
      this.#broadcast({ type: 'update:completed', workflowId, updateId: update.updateId });
    }
  }

  static readonly #TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
    'completed',
    'failed',
    'cancelled',
    'timed-out',
  ]);

  /** Throw {@link WorkflowTerminalError} if the workflow is in a terminal state. */
  async #guardTerminalWorkflow(workflowId: string): Promise<void> {
    const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!stateBytes) return; // unknown workflow — let downstream handle it
    const state = decodeWorkflowState(stateBytes);
    if (Engine.#TERMINAL_STATUSES.has(state.status)) {
      throw new WorkflowTerminalError(workflowId, state.status);
    }
  }

  /**
   * Re-check terminal state after persisting a coordinated update request.
   * This closes the race where the workflow completes between the preflight
   * guard and request creation, which would otherwise leave the caller
   * waiting for a response that can never arrive.
   */
  async #guardTerminalWorkflowAfterCoordinatedRequest(
    workflowId: string,
    updateId: string,
  ): Promise<void> {
    try {
      await this.#guardTerminalWorkflow(workflowId);
    } catch (error) {
      if (error instanceof WorkflowTerminalError) {
        await this.#updateCoordinator.deleteRequest(workflowId, updateId);
      }

      throw error;
    }
  }

  /**
   * Post a message to the BroadcastChannel for cross-worker coordination.
   * Only active when `broadcastEvents` is enabled. Lazily creates the channel
   * on first use to avoid overhead when unused.
   */
  #broadcast(message: Record<string, unknown>): void {
    if (!this.#options.broadcastEvents) return;

    if (this.#broadcastChannel === null) {
      try {
        this.#broadcastChannel = new BroadcastChannel('weft:events');
      } catch {
        return;
      }
    }
    this.#broadcastChannel.postMessage(message);
  }
}
