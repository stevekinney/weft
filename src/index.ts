/**
 * Weft — A Bun-native durable execution engine.
 *
 * Weft runs async workflows to completion across crashes, retries, and days
 * of wall-clock time. Each workflow is a generator function that yields to a
 * {@link Context}; the engine persists a checkpoint at every yield and
 * resumes from the last checkpoint on recovery.
 *
 * For end-to-end usage examples see the {@link Engine} class.
 *
 * @module weft
 */

export { VERSION } from './version.ts';
// Error base + discriminant
export { WeftError, isWeftError, isWeftErrorCode } from './core/weft-error.ts';
export type { WeftErrorCode } from './core/weft-error.ts';
// Wire fault code + failure-category mapping
export {
  FAULT_CODE_TO_FAILURE_CATEGORY,
  failureCategoryForFaultCode,
  isFaultCode,
} from './core/fault-code.ts';
export type { FaultCode } from './core/fault-code.ts';
// Core
export {
  ActivityReconciliationCapabilityError,
  ActivityReconciliationConflictError,
  ActivityReconciliationIndeterminateError,
  ActivityResolutionError,
  AsyncActivityTokenNotFoundError,
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  Engine,
  EngineCreateNameMismatchError,
  PersistedDataIncompatibleError,
  ScheduleHandle,
  WorkflowAlreadyExistsError,
  WorkflowHandle,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
  WorkflowTypeNotRegisteredForRecoveryError,
} from './core/engine';
export type { EngineCreateOptions, EngineStateNamespace, RecoverAllOptions } from './core/engine';
export {
  DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_RETRY_POLICY,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  HISTORY_CIRCUIT_BREAKER_REASON,
  WorkflowBuilderError,
  query,
  schedule,
  signal,
  update,
  workflow,
} from './core/types';
export type {
  ActivityArgsFor,
  ActivityCallOptions,
  ActivityCallable,
  ActivityContext,
  ActivityDefinition,
  ActivityEntryInput,
  ActivityFunction,
  ActivityMap,
  ActivityMapInput,
  ActivityObjectInput,
  ActivityResultFor,
  ActivityVerificationContext,
  ActivityVerificationPhase,
  ActivityVerificationResult,
  AnyActivityDefinition,
  AnyWorkflowDefinition,
  ArchiveAdapter,
  BuilderState,
  BuiltWorkflowDefinition,
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationAction,
  BulkOperationAuditEvent,
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationDryRunResult,
  BulkOperationError,
  BulkOperationFilterSummary,
  BulkOperationOptions,
  BulkOperationPrincipal,
  BulkOperationScopeSummary,
  BulkSignalAllCommitOptions,
  BulkSignalAllDryRunOptions,
  BulkSignalAllOptions,
  BulkSignalResult,
  BulkTagResult,
  Checkpoint,
  CheckpointState,
  CheckpointSummary,
  CompletedReviewEntry,
  CoordinatedUpdateResult,
  DefinitionSchema,
  Duration,
  EngineOptions,
  FailureCategory,
  ForkLineage,
  ForkOptions,
  HistoryPolicy,
  InferActivityEntries,
  InferActivityEntry,
  InferWorkflowEntries,
  InferWorkflowEntry,
  InitialBuilderState,
  ListFilter,
  ListOptions,
  MarkBuilderState,
  NormalizeActivities,
  NormalizedActivityEntry,
  NormalizedRetentionPolicy,
  PaginatedResult,
  PayloadSizePolicy,
  PendingReviewEntry,
  PurgeResult,
  QueryDefinition,
  QueryMap,
  QueryShape,
  RegisteredWorkflowDefinition,
  RetentionOverview,
  RetentionPolicy,
  RetryPolicy,
  ReviewListEntry,
  ReviewListFilter,
  ReviewStatus,
  ScheduleDefinition,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleSpec,
  ScheduleState,
  ScheduleStatus,
  ScheduleSummary,
  SearchAttributeDefinition,
  SearchAttributeHandle,
  SearchAttributeSchema,
  SearchAttributeValue,
  Serializer,
  SignalDefinition,
  SignalDeliveryOptions,
  SignalMap,
  SignalPayload,
  StartOptions,
  SubmitReviewOptions,
  TerminationReason,
  UpdateDefinition,
  UpdateMap,
  UpdatePayload,
  WorkerReplayOperationFailure,
  WorkerReplayOperationSignature,
  WorkflowAlreadyRegistered,
  WorkflowAtomicState,
  WorkflowAtomicStateOptions,
  WorkflowBuilder,
  WorkflowBuilderOptions,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowFunction,
  WorkflowGenerator,
  WorkflowId,
  WorkflowRegistry,
  WorkflowReplay,
  WorkflowSessionState,
  WorkflowState,
  WorkflowStateNamespace,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTimelineEntry,
  WorkflowTimelineStatus,
  WorkflowTypeRetentionPolicy,
} from './core/types';
// Alerting
export { AlertManager } from './alerting/index';
export type {
  AlertAction,
  AlertMetric,
  AlertRule,
  AlertState,
  AlertStatus,
  AlertingOptions,
  WebhookTarget,
} from './alerting/types';
// Events
export {
  ActivityAsyncPendingEvent,
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AlertFiredEvent,
  AlertResolvedEvent,
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  ConstraintViolatedEvent,
  DevelopmentWarningEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  StorageSizeReportedEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowRecoverySkippedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './core/events';
export type { TypedEventTarget, WeftEventMap, WorkflowRecoverySkippedReason } from './core/events';
// Runtime — portable helpers for cross-runtime code
export { detectRuntime, hashBytes, hashString, sleep } from './runtime/portable';
export type { RuntimeKind } from './runtime/portable';
// Compression
export { createBunCompressor, createCompressor } from './core/compression';
export type { CompressionAlgorithm, CompressionOptions, Compressor } from './core/compression';
export { CompressedStorage } from './storage/compressed-storage';
// Storage — interface, KEYS, and zero-native-dep backends only.
// Heavy or runtime-bound backends are subpath-only:
//   weft/storage/sqlite | weft/storage/lmdb | weft/storage/turso
export { storageDeleteRange } from './storage/delete-range';
export type { DeleteRangeOptions } from './storage/delete-range';
export {
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  storageValuesEqual,
} from './storage/interface';
export type {
  BatchOperation,
  ConditionalBatchCondition,
  GatedStorageCapabilityKey,
  ScanOptions,
  Storage,
  StorageCapabilities,
} from './storage/interface';
export { MemoryStorage } from './storage/memory';
export { ScopedStorage, scopedStorage } from './storage/scoped-storage';
export { jsonCodec, msgpackCodec, withCodec } from './storage/typed-storage';
export type {
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedStorage,
} from './storage/typed-storage';
// Codec
export { decode, encode, validateCloneable } from './core/codec';
// Payload-size cap
export { PayloadSizeExceededError } from './core/payload-size';

export {
  advanceCheckpoint,
  checkpointSizeBytes,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from './core/checkpoint';
// Scheduler
export { Scheduler, calculateBackoff, parseDuration } from './core/scheduler';
export type { TimerEntry } from './core/types/checkpoint';

export { constraint } from './core/constraint';
export type {
  ConstraintCheckState,
  ConstraintDefinition,
  ConstraintViolation,
} from './core/constraint';

export { ActivityRegistry } from './core/activity-registry';
export type { ActivityMetadata, ActivityRegistrationOptions } from './core/activity-registry';
export { activity } from './core/types';

export { Context } from './core/context';
export type {
  ContextOperationRequest,
  ContextOptions,
  OffloadReference,
  SagaStep,
  StoredStreamChunk,
  StreamReference,
  StreamSink,
} from './core/context';
export type {
  ChildWorkflowOptions,
  ChildWorkflowTarget,
  WorkflowMapOptions,
  WorkflowOperation,
  WorkflowPipeStage,
  WorkflowPipeStageDefinition,
  WorkflowReduceInput,
  WorkflowReduceOptions,
} from './core/types';

export { StepContext, compileStepWorkflow, isAsyncGeneratorFunction } from './core/step-context';
export type { StepWorkflowContext, StepWorkflowFunction } from './core/types';

export {
  composeActivityInterceptors,
  composeWorkflowInterceptors,
  interceptor,
} from './core/interceptor';
export type {
  ActivityExecutionInterception,
  ActivityInterception,
  ActivityInterceptor,
  ChildWorkflowInterception,
  ComposedActivityInterceptor,
  ComposedWorkflowInterceptor,
  Interceptor,
  QueryInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowInterceptor,
  WorkflowStartInterception,
} from './core/interceptor';

export {
  buildIndexOperations,
  decodeAttributeValue,
  encodeAttributeValue,
  searchAttribute,
} from './core/search-attributes';

export type { UpdateHandlerOptions } from './core/context/updates';
export {
  UpdateCoordinator,
  UpdateTimeoutError,
  UpdateValidationError,
  WorkflowTerminalError,
} from './core/updates';

export {
  VersionMismatchError,
  checkVersionCompatibility,
  diffCheckpointShapes,
  inferShape,
  migrateCheckpoint,
} from './core/versioning';
export type { FieldDiff, ShapeDescriptor, ShapeDiffOptions } from './core/versioning';

export {
  WorkflowTimeoutError,
  checkExpiredDeadlines,
  createDeadlineOperations,
  timeRemaining,
} from './core/timeouts';

export {
  AtomicState,
  AtomicStateChangeEvent,
  AtomicStateConflictError,
  AtomicStateConflictEvent,
  AtomicStateExhaustedEvent,
  OBSERVABLE_SYMBOL,
} from './core/atomic-state';
export type {
  AtomicStateCommitResult,
  AtomicStateEvent,
  AtomicStateObserver,
  AtomicStateOptions,
  AtomicStateScope,
  AtomicStateSnapshot,
  AtomicStateSubscription,
  SleepFunction,
} from './core/atomic-state';
// Durable concurrency primitives — mutex/semaphore built on AtomicState CAS.
export { DurableMutex, DurableSemaphore, initialLockRecord } from './core/concurrency';
export type {
  AcquireAttempt,
  AcquireWithSlot,
  CasSlot,
  DurableSemaphoreOptions,
  LockHolder,
  LockRecord,
  RenewWithSlot,
} from './core/concurrency';

export { handleRequest } from './server/handler';
export type { SchedulingPolicy } from './server/task-queue-types';
export type { RoutingPolicy } from './worker/registry';

export { createAuthenticator, validateAuthConfig } from './server/authentication';
export type {
  AuthConfig,
  AuthMethod,
  AuthResult,
  Authenticator,
  JWTAlgorithm,
  JWTConfig,
  JWTPayload,
  MTLSConfig,
} from './server/authentication';

export { ReviewCompletedEvent, ReviewRequestedEvent } from './core/review/events.ts';
export type { WeftReviewEventMap } from './core/review/events.ts';
export { ReviewCoordinator, ReviewTimeoutError } from './core/review/index.ts';
export type {
  EscalationAction,
  EscalationStep,
  HumanReviewOptions,
  HumanReviewResult,
  ReviewCoordinatorOptions,
  ReviewDecision,
  ReviewOptions,
  ReviewRequest,
} from './core/review/index.ts';

export {
  EffectLog,
  EffectReplayConflictError,
  computeSemanticHash,
} from './core/effect-log/index.ts';
export type { EffectLogLike, EffectRecord } from './core/effect-log/index.ts';
export { isJSONValue, normalizeJSONValue } from './core/json.ts';
export type { JSONPrimitive, JSONValue } from './core/json.ts';

export { createObservabilityInterceptors } from './observability/index';
export type { InterceptionContext, ObservabilityOptions } from './observability/index';
export {
  METRICS,
  createMetricsCollectorExporter,
  createOpenTelemetryMetrics,
} from './observability/metrics';
export { getOpenTelemetryApi } from './observability/no-op-telemetry';
export {
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  parseTraceParent,
} from './observability/propagation';

export { executeActivity } from './workers/activity-runner';
export type { ActivityExecutionRequest, ActivityExecutionResult } from './workers/activity-runner';
export { ActivityWorkerDispatcher } from './workers/activity-worker-dispatcher';
export type { ActivityWorkerDispatcherOptions } from './workers/activity-worker-dispatcher';
export {
  createActivityWorkerEntryUrl,
  initializeActivityWorkerMessageLoop,
  revokeActivityWorkerEntryUrl,
} from './workers/activity-worker-entry';
export type { ActivityHandlerLookup } from './workers/activity-worker-entry';
export { WorkerPool } from './workers/pool';
export type { WorkerPoolOptions } from './workers/pool';

export { HeartbeatManager } from './worker/heartbeat';
export { RemoteWorker } from './worker/index';
export { LongPollWorker } from './worker/long-poll';
export { WorkerRegistry } from './worker/registry';
export {
  WorkerProtocolIncompatibleError,
  workerProtocolIncompatibleMessage,
} from './worker/worker-protocol-incompatible-error';
export { buildQualifiedActivityTable } from './worker/workflow-activity-binding';
export type {
  RemoteWorkerActivityFunction,
  RemoteWorkerActivityImplementation,
  RemoteWorkerWorkflowDefinition,
} from './worker/workflow-activity-binding';

export { HttpClient, HttpClientError } from './client/index';
export type { HttpClientOptions } from './client/index';
export type { ClientHandle, UpdateResult, WeftClient } from './client/interface';
export { LocalClient } from './client/local';
export type {
  KnownWorkflowName,
  UnknownNameWhenRegistryEmpty,
} from './client/workflow-name-typing';

export {
  ConnectionConfigurationError,
  DEFAULT_WEFT_ADDRESS,
  resolveConnection,
} from './connection';
export type { ConnectionOptions, ResolvedConnection } from './connection';

export * from './diagnostics/index.ts';
