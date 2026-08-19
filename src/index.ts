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
 * This is the package's public re-export barrel: it contains only `export`
 * statements, no logic, and grows one line per public symbol. Line count here
 * is semantically meaningless, so it carries a `max-lines: off` override in
 * `.oxlintrc.json` (unlike logic-bearing files, which keep the numeric ceiling).
 *
 * @module weft
 */

export { VERSION } from './version.ts';
// Error base + discriminant
export {
  WeftError,
  isWeftError,
  isWeftErrorCode,
  isWeftErrorLike,
  isWeftFault,
} from './core/weft-error.ts';
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
  DurableActivityScopeError,
  DurableActivityUnsupportedError,
  durableActivity,
} from './core/context/durable-activity.ts';
export {
  ActivityReconciliationCapabilityError,
  ActivityReconciliationConflictError,
  ActivityReconciliationIndeterminateError,
  ActivityResolutionError,
  AsyncActivityTokenNotFoundError,
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  ENGINE_LEASE_LOST_WARNING_NAME,
  ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME,
  Engine,
  EngineCreateNameMismatchError,
  EngineDisposalError,
  EngineDisposedError,
  EngineLeaseAcquisitionTimeoutError,
  EngineLeaseCorruptedError,
  EngineLeaseNotHeldError,
  IdempotencyKeyPurgedError,
  PersistedDataIncompatibleError,
  ScheduleHandle,
  StartOrSignalConflictError,
  WorkflowAlreadyExistsError,
  WorkflowConcurrencyLimitExceededError,
  WorkflowHandle,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
  WorkflowSuspendNotSupportedError,
  WorkflowTeardownPendingError,
  WorkflowTypeNotRegisteredForRecoveryError,
} from './core/engine';
export type {
  EngineCreateOptions,
  EngineLeaseHealth,
  EngineStateNamespace,
  LeaseLostReason,
  RecoverAllOptions,
  RecoveredWorkflowInfo,
} from './core/engine';
export {
  DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_POLL_INTERVAL_MS,
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
  BulkRetryFailedResult,
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
  LaunchMetadata,
  ListFilter,
  ListOptions,
  MarkBuilderState,
  NormalizeActivities,
  NormalizedActivityEntry,
  NormalizedRetentionPolicy,
  PaginatedResult,
  PayloadSizePolicy,
  PendingAsyncActivityInfo,
  PendingAsyncActivityListOptions,
  PendingAsyncActivityPage,
  PendingReviewEntry,
  PurgeResult,
  QueryDefinition,
  QueryMap,
  QueryShape,
  RegisteredWorkflowDefinition,
  RestartLineage,
  RetentionOverview,
  RetentionPolicy,
  RetryPolicy,
  ReviewDecision,
  ReviewListEntry,
  ReviewListFilter,
  ReviewStatus,
  ScheduleDefinition,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleQueuedRun,
  ScheduleSpec,
  ScheduleState,
  ScheduleStatus,
  ScheduleSummary,
  ScheduleUpdateOptions,
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
  StartOrSignalOptions,
  StartOrSignalSignal,
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
  WorkflowConcurrencyOptions,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowFinalizerStatus,
  WorkflowFunction,
  WorkflowGenerator,
  WorkflowId,
  WorkflowKeyedRaceResult,
  WorkflowLogLevel,
  WorkflowLogRecord,
  WorkflowLogger,
  WorkflowRegistry,
  WorkflowReplay,
  WorkflowScheduleProvenance,
  WorkflowServicesResolution,
  WorkflowServicesResolverInfo,
  WorkflowServicesResolverLaunchOptions,
  WorkflowServicesResolverScheduleInfo,
  WorkflowSessionState,
  WorkflowSnapshot,
  WorkflowState,
  WorkflowStateNamespace,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTimelineEntry,
  WorkflowTimelineOperationDetail,
  WorkflowTimelineStatus,
  WorkflowTypeRetentionPolicy,
} from './core/types';
// Alerting
export { AlertManager } from './alerting/index';
export type {
  AlertAction,
  AlertMetric,
  AlertRule,
  AlertStateSnapshot,
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
  ScheduleFiredEvent,
  ScheduleMissedFireEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  StorageSizeReportedEvent,
  TaskResultDeadLetteredEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowDefinitionRegisteredEvent,
  WorkflowFailedEvent,
  WorkflowRecoverySkippedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowSuspendedEvent,
  WorkflowTeardownEvent,
  WorkflowTimedOutEvent,
} from './core/events';
export type {
  TypedEventTarget,
  WeftEventMap,
  WorkflowRecoverySkippedReason,
  WorkflowTeardownStatus,
} from './core/events';
// Runtime — portable helpers for cross-runtime code
export {
  detectRuntime,
  detectRuntimeVersion,
  hashBytes,
  hashString,
  sleep,
} from './runtime/portable';
export type { RuntimeKind } from './runtime/portable';
// Compression
export { createBunCompressor, createCompressor } from './core/compression';
export type { CompressionAlgorithm, CompressionOptions, Compressor } from './core/compression';
export { CompressedStorage } from './storage/compressed-storage';
// Storage — interface, KEYS, and zero-native-dep backends only.
// Heavy or runtime-bound backends are subpath-only:
//   @lostgradient/weft/storage/sqlite | @lostgradient/weft/storage/lmdb | @lostgradient/weft/storage/turso
export { storageDeleteRange } from './storage/delete-range';
export type { DeleteRangeOptions } from './storage/delete-range';
export {
  KEYS,
  MAX_BATCH_OPERATIONS,
  MAX_SCAN_LIMIT,
  StorageBatchOperationLimitExceededError,
  WEFT_RESERVED_KEY_PREFIXES,
  assertDurableStorageForRecovery,
  assertStorageBatchOperationCount,
  requireStorageCapability,
  storageBatch,
  storageConditionalBatch,
  storageValuesEqual,
} from './storage/interface';
export type {
  BatchOperation,
  ConditionalBatchCondition,
  GatedStorageCapabilityKey,
  ScanOptions,
  Storage,
  StorageBatchOperationLimitTarget,
  StorageCapabilities,
} from './storage/interface';
export { MemoryStorage } from './storage/memory';
export { ScopedStorage, scopedStorage } from './storage/scoped-storage';
export { copyTextKeyValueRowsToStorage } from './storage/text-value-import';
export type {
  CopyTextKeyValueRowsToStorageOptions,
  CopyTextKeyValueRowsToStorageResult,
  TextKeyValueRow,
} from './storage/text-value-import';
export { jsonCodec, msgpackCodec, withCodec } from './storage/typed-storage';
export type {
  CodecStorageOptions,
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedConditionalBatchCondition,
  TypedStorage,
} from './storage/typed-storage';
// Codec
export {
  decode,
  encode,
  registerSerializer,
  validateCloneable,
  type SerializerHandlers,
} from './core/codec';
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
export { BranchTopologyChangedError } from './core/context/parallel-cache-entry.ts';
export type {
  AwaitChildWorkflowOptions,
  ChildWorkflowHandle,
  ChildWorkflowOptions,
  ChildWorkflowParentClosePolicy,
  ChildWorkflowTarget,
  DetachedChildWorkflowOptions,
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

export {
  ActivityPerAttemptTimeoutError,
  ActivityScheduleToCloseTimeoutError,
} from './core/context/activity-schedule-to-close';
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
  ReviewDecisionRecord,
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
export {
  MAX_MANIFEST_ACTIVITY_COUNT,
  MAX_MANIFEST_CAPABILITY_COUNT,
  MAX_MANIFEST_CAPABILITY_DEPTH,
  MAX_MANIFEST_CAPABILITY_STRING_BYTES,
  MAX_MANIFEST_IDENTIFIER_BYTES,
  MAX_MANIFEST_WORKFLOW_COUNT,
  MAX_NORMALIZED_MANIFEST_BYTES,
  WORKER_MANIFEST_DIGEST_ALGORITHM,
  WORKER_MANIFEST_VERSION,
  buildWorkerExecutionIdentity,
  canonicalWorkerManifestJson,
  computeWorkerManifestDigest,
  digestCanonicalWorkerManifest,
  executionIdentitySatisfies,
  normalizeWorkerManifest,
  parseWorkerManifest,
  parseWorkerManifestJson,
} from './worker/manifest/index.ts';
export type {
  ManifestValidationFailure,
  WorkerActivityContract,
  WorkerDeploymentIdentity,
  WorkerExecutionIdentity,
  WorkerExecutionRequirement,
  WorkerManifest,
  WorkerManifestParseResult,
  WorkerManifestParseSuccess,
  WorkerManifestRejectionReason,
  WorkerRuntimeIdentity,
  WorkerWorkflowContract,
} from './worker/manifest/index.ts';
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

export type { WeftClientStorage } from './client/client-storage';
export type { WorkflowEventTail } from './client/event-tail';
export { HttpClient, HttpClientError } from './client/index';
export type {
  HttpClientOptions,
  WorkflowEventStreamOptions,
  WorkflowEventTransport,
} from './client/index';
export type {
  ClientHandle,
  ClientStartOptions,
  StartOrSignalOutcome,
  UpdateResult,
  WeftClient,
  WeftClientActivity,
} from './client/interface';
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
