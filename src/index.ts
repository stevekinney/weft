/**
 * Weft — A Bun-native durable execution engine.
 *
 * Weft runs async workflows to completion across crashes, retries, and days
 * of wall-clock time. Each workflow is a generator function that yields to a
 * {@link Context}; the engine persists a checkpoint at every yield and
 * resumes from the last checkpoint on recovery.
 *
 * For end-to-end usage examples see the {@link Engine} class and the
 * {@link tenantFromInputField} helper.
 *
 * @module weft
 */

/**
 * Current Weft package version. Useful for diagnostics, telemetry, and
 * verifying which build is running.
 *
 * @example
 * ```ts
 * import { VERSION } from 'weft';
 *
 * console.log(`Running Weft ${VERSION}`);
 * ```
 */
export const VERSION = '0.0.1';

// Core
export {
  Engine,
  ScheduleHandle,
  WorkflowAlreadyExistsError,
  WorkflowHandle,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
} from './core/engine';
export type { EngineStateNamespace } from './core/engine';
export {
  DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_RETRY_POLICY,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  query,
  schedule,
  signal,
  update,
  workflow,
} from './core/types';
export type {
  ActivityCallOptions,
  ActivityCallable,
  ActivityContext,
  ActivityDefinition,
  ActivityFunction,
  ActivityTypes,
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationError,
  BulkSignalResult,
  BulkTagResult,
  Checkpoint,
  CheckpointState,
  CheckpointSummary,
  CoordinatedUpdateResult,
  DefinitionSchema,
  Duration,
  EngineOptions,
  FailureCategory,
  ForkLineage,
  ForkOptions,
  ListFilter,
  NormalizedRetentionPolicy,
  PaginatedResult,
  PurgeResult,
  QueryDefinition,
  RegisteredWorkflowDefinition,
  RetentionOverview,
  RetentionPolicy,
  RetryPolicy,
  ReviewDecision,
  ScheduleAccessOptions,
  ScheduleDefinition,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleState,
  ScheduleStatus,
  ScheduleSummary,
  SearchAttributeDefinition,
  SearchAttributeHandle,
  SearchAttributeSchema,
  SearchAttributeValue,
  Serializer,
  SignalDefinition,
  StandardJSONSchemaV1,
  StandardJSONSchemaV1Converter,
  StandardJSONSchemaV1Options,
  StandardJSONSchemaV1Properties,
  StandardJSONSchemaV1Target,
  StandardSchemaV1,
  StandardSchemaV1FailureResult,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Properties,
  StandardSchemaV1Result,
  StandardSchemaV1SuccessResult,
  StandardTypedV1,
  StandardTypedV1Properties,
  StandardTypedV1Types,
  StartOptions,
  SubmitReviewOptions,
  TenantQuotaMetricUsage,
  TenantQuotaOptions,
  TenantQuotaUsage,
  TenantWorkflowCreationRateLimit,
  TenantWorkflowCreationRateUsage,
  UpdateDefinition,
  WorkflowAtomicState,
  WorkflowAtomicStateOptions,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowFunction,
  WorkflowId,
  WorkflowRegistration,
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
  TokenEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './core/events';
export type { TypedEventTarget, WeftEventMap } from './core/events';

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
export { KEYS, storageConditionalBatch, storageValuesEqual } from './storage/interface';
export type {
  BatchOperation,
  ConditionalBatchCondition,
  ScanOptions,
  Storage,
} from './storage/interface';
export { MemoryStorage } from './storage/memory';
export { ScopedStorage, scopedStorage } from './storage/scoped-storage';
export { jsonCodec, msgpackCodec, withCodec } from './storage/typed-storage';
export type {
  JsonValue,
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedStorage,
} from './storage/typed-storage';

// Codec
export { decode, encode, validateCloneable } from './core/codec';

// Checkpoint
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

// Constraint
export { constraint } from './core/constraint';
export type {
  ConstraintCheckState,
  ConstraintDefinition,
  ConstraintViolation,
} from './core/constraint';

// Activity
export { ActivityRegistry } from './core/activity-registry';
export type { ActivityMetadata, ActivityRegistrationOptions } from './core/activity-registry';
export { activity } from './core/types';

// Context
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

// Multi-tenant primitives
export { tenantFromInputField } from './core/tenant';
export type { TenantContext, TenantResolver } from './core/tenant';
export { QuotaExceededError } from './core/tenant-quotas';

// Step Context
export { StepContext, compileStepWorkflow, isAsyncGeneratorFunction } from './core/step-context';
export type { StepWorkflowContext, StepWorkflowFunction } from './core/types';

// Interceptors
export {
  composeActivityInterceptors,
  composeWorkflowInterceptors,
  interceptor,
} from './core/interceptor';
export type {
  ActivityExecutionInterception,
  ActivityInterception,
  ActivityInterceptor,
  AgentInterception,
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

// Search Attributes
export {
  buildIndexOperations,
  decodeAttributeValue,
  encodeAttributeValue,
  searchAttribute,
} from './core/search-attributes';

// Updates
export { UpdateCoordinator, UpdateTimeoutError, WorkflowTerminalError } from './core/updates';

// Versioning
export {
  VersionMismatchError,
  checkVersionCompatibility,
  diffCheckpointShapes,
  inferShape,
  migrateCheckpoint,
} from './core/versioning';
export type { FieldDiff, ShapeDescriptor, ShapeDiffOptions } from './core/versioning';

// Timeouts
export {
  WorkflowTimeoutError,
  checkExpiredDeadlines,
  createDeadlineOperations,
  timeRemaining,
} from './core/timeouts';

// Atomic State
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

// Server
export type { PrometheusExporter } from './observability/metrics';
export { handleRequest } from './server/handler';
export type { SchedulingPolicy } from './server/task-queue';
export type { RoutingPolicy } from './worker/registry';

// Server Authentication
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

// AI / Agent
export { AgentLoopSuspendedError, executeAgentLoop } from './ai/agent/index.ts';
export type {
  AgentOptions,
  AgentResult,
  AgentTool,
  PendingProviderResumeState,
  PersistedAgentLoopState,
  TurnUsageEntry,
  VerificationRecorder,
} from './ai/agent/index.ts';

// Structural provider types (Weft owns the shapes; users supply implementations)
export type {
  ChatOptions,
  ChatResponse,
  ChatResumeContext,
  ChatResumeHint,
  LLMProvider,
  Message,
  MessageRole,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './ai/agent/index.ts';

// Coordination
export { createChildHeaders, debate, handoff, supervise } from './ai/coordination/index.ts';

// Declaration
export { agent, isAgentDefinition } from './ai/declaration';
export type { AgentDefinition, AgentToolDefinition, ToolIdentityResult } from './ai/declaration';

// Human Review
export { ReviewCoordinator, ReviewTimeoutError } from './ai/human-review';
export type { ReviewCoordinatorOptions } from './ai/human-review';

// Tool Effect Log
export {
  ToolCallReplayConflictError,
  ToolEffectLog,
  computeSemanticHash,
} from './ai/tool-effect-log';
export type { EffectRecord } from './ai/tool-effect-log';

// AI Events (durability-shaped only)
export {
  AgentCheckpointResumedEvent,
  AgentCheckpointSizeWarningEvent,
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
  HumanReviewCompletedEvent,
  HumanReviewRequestedEvent,
} from './ai/events/index.ts';

// Engine agent registration (re-exported from core/engine)
export type { AgentRegistrationOptions } from './core/engine';

// Observability
export { createObservabilityInterceptors } from './observability/index';
export type { InterceptionContext, ObservabilityOptions } from './observability/index';
export {
  METRICS,
  createMetricsCollectorExporter,
  createOpenTelemetryMetrics,
} from './observability/metrics';
export type { OpenTelemetryMetrics } from './observability/metrics';
export { getOpenTelemetryApi } from './observability/no-op-telemetry';
export type {
  OpenTelemetryApi,
  OpenTelemetryMeter,
  OpenTelemetrySpan,
  OpenTelemetryTracer,
} from './observability/no-op-telemetry';
export {
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  parseTraceParent,
} from './observability/propagation';

// Workers
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

// Remote Worker
export { HeartbeatManager } from './worker/heartbeat';
export { RemoteWorker } from './worker/index';
export { LongPollWorker } from './worker/long-poll';
export { WorkerRegistry } from './worker/registry';

// Client
export { HttpClient, HttpClientError } from './client/index';
export type { HttpClientOptions } from './client/index';
export type { ClientHandle, UpdateResult, WeftClient } from './client/interface';
export { LocalClient } from './client/local';

// Diagnostics
export { collectDiagnostics } from './diagnostics/doctor';
export {
  formatBytes,
  formatDiagnosticReport,
  formatDuration,
  formatVersionCheckReport,
} from './diagnostics/format';
export { MemoryProfiler, analyzeStability, linearRegression } from './diagnostics/memory-profiler';
export type {
  MemoryProfile,
  MemorySample,
  StabilityOptions,
  StabilityResult,
} from './diagnostics/memory-profiler';
export { generateRecommendations } from './diagnostics/recommendations';
export type {
  DatabaseHealth,
  DiagnosticReport,
  HealthStatus,
  LargestCheckpoint,
  LongestRunningWorkflow,
  QueueStatistics,
  Recommendation,
  RecommendationSeverity,
  VersionCheckReport,
  WorkflowStatistics,
  WorkflowStatusCounts,
  WorkflowTypeReport,
} from './diagnostics/types';
export { runVersionCheck } from './diagnostics/version-check';
