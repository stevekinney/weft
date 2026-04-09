/**
 * Weft — A Bun-native durable execution engine.
 *
 * Weft runs async workflows to completion across crashes, retries, and days
 * of wall-clock time. Each workflow is a generator function that yields to a
 * {@link Context}; the engine persists a checkpoint at every yield and
 * resumes from the last checkpoint on recovery.
 *
 * @example Hello world
 * ```ts
 * import { Engine, activity } from 'weft';
 *
 * const sendEmail = activity('sendEmail', async ({ to }: { to: string }) => {
 *   await Bun.sleep(100);
 *   return { messageId: crypto.randomUUID(), to };
 * });
 *
 * const engine = new Engine();
 * engine.register('greet', async function* (ctx, input: { email: string }) {
 *   const result = yield* ctx.run(sendEmail, { to: input.email });
 *   return result.messageId;
 * });
 *
 * const handle = await engine.start('greet', { email: 'you@example.com' });
 * const messageId = await handle.result();
 * ```
 *
 * @example Multi-tenant engine
 * ```ts
 * import { Engine, tenantFromInputField } from 'weft';
 *
 * const engine = new Engine({
 *   tenantResolver: tenantFromInputField('customerId'),
 * });
 *
 * engine.register('per-tenant', async function* (ctx, input) {
 *   // ctx.tenant is { id: "acme" } when input = { customerId: "acme", ... }
 *   return ctx.tenant?.id ?? 'anonymous';
 * });
 * ```
 *
 * @module weft
 */

export const VERSION = '0.0.1';

// Core
export { Engine, WorkflowHandle } from './core/engine';
export {
  DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_RETRY_POLICY,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
} from './core/types';
export type {
  ActivityCallOptions,
  ActivityContext,
  ActivityDefinition,
  ActivityFunction,
  Checkpoint,
  CoordinatedUpdateResult,
  Duration,
  EngineOptions,
  ListFilter,
  PaginatedResult,
  RetryPolicy,
  ReviewDecision,
  SearchAttributeSchema,
  SearchAttributeValue,
  Serializer,
  StartOptions,
  SubmitReviewOptions,
  WorkflowContext,
  WorkflowEvent,
  WorkflowFunction,
  WorkflowId,
  WorkflowRegistration,
  WorkflowRegistry,
  WorkflowState,
  WorkflowStatus,
  WorkflowSummary,
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

// Compression
export { createBunCompressor } from './core/compression';
export type { CompressionAlgorithm, CompressionOptions, Compressor } from './core/compression';
export { CompressedStorage } from './storage/compressed-storage';

// Storage — interface, KEYS, and zero-native-dep backends only.
// Heavy backends (BunSQLiteStorage, LMDBStorage, TursoStorage) are subpath-only:
//   weft/storage/bun-sqlite | weft/storage/lmdb | weft/storage/turso
export { KEYS } from './storage/interface';
export type { BatchOperation, ScanOptions, Storage } from './storage/interface';
export { MemoryStorage } from './storage/memory';

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

// Activity
export { activity } from './core/activity';
export { ActivityRegistry } from './core/activity-registry';
export type { ActivityMetadata, ActivityRegistrationOptions } from './core/activity-registry';

// Context
export { Context } from './core/context';
export type {
  ContextOperationRequest,
  ContextOptions,
  OffloadReference,
  SagaStep,
  StreamReference,
  StreamSink,
} from './core/context';

// Multi-tenant primitives
export { tenantFromInputField } from './core/tenant';
export type { TenantContext, TenantResolver } from './core/tenant';

// Step Context
export { StepContext, compileStepWorkflow, isAsyncGeneratorFunction } from './core/step-context';
export type { StepWorkflowContext, StepWorkflowFunction } from './core/types';

// Interceptors
export { composeActivityInterceptors, composeWorkflowInterceptors } from './core/interceptor';
export type {
  ActivityExecutionInterception,
  ActivityInterception,
  ActivityInterceptor,
  AgentInterception,
  ChildWorkflowInterception,
  ComposedActivityInterceptor,
  ComposedWorkflowInterceptor,
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

// Shared State
export { SharedState, SharedStateConflictError } from './core/shared-state';

// Server
export type { PrometheusExporter } from './observability/metrics';
export { handleRequest } from './server/handler';
export { serve } from './server/index';
export type { ServeOptions, WeftServer } from './server/index';
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

// Testing
export { ActivityMockRegistry } from './testing/mocks';
export type { MockCall, MockHandle } from './testing/mocks';
export { TestEngine } from './testing/test-engine';
export { TimeControl } from './testing/time-control';

// AI / Agent
export { executeAgentLoop } from './ai/agent';
export type {
  AgentOptions,
  AgentResult,
  AgentTool,
  MCPToolSource,
  TurnCostEntry,
} from './ai/agent';
export { BudgetExceededError, BudgetTracker } from './ai/budget';
export type { BudgetOptions, BudgetState, ModelPricing } from './ai/budget';
export { BudgetPolicyEnforcer, OrganizationBudgetExceededError } from './ai/budget-policy';
export type { BudgetPolicyOptions } from './ai/budget-policy';
export { slidingWindowStrategy } from './ai/context-strategies/sliding-window';
export { ContextWindowManager, composeStrategies, noopStrategy } from './ai/context-window';
export type { ContextStrategy } from './ai/context-window';
export { createChildHeaders, debate, handoff, supervise } from './ai/coordination';
export { defineAgent, isAgentDefinition } from './ai/declaration';
export type { AgentDefinition, AgentToolDefinition, ToolIdentityResult } from './ai/declaration';
export type { AgentHooks } from './ai/hooks';
export { ReviewCoordinator, ReviewTimeoutError } from './ai/human-review';
export type { ReviewCoordinatorOptions } from './ai/human-review';
export {
  abTestRouter,
  costTierRouter,
  customRouter,
  staticFallbackRouter,
} from './ai/model-router';
export type { ModelRouter, ModelSelection, RoutingContext } from './ai/model-router';
export { ProviderHealthTracker } from './ai/provider-health';
export { ReconnectionBuffer, StreamMultiplexer, TokenBridge } from './ai/streaming';
export type { AgentRegistrationOptions } from './core/engine';

// AI Events
export {
  AgentBudgetExceededEvent,
  AgentBudgetWarningEvent,
  AgentCheckpointResumedEvent,
  AgentContextCompactedEvent,
  AgentModelFallbackEvent,
  AgentProviderCircuitOpenEvent,
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
  HumanReviewCompletedEvent,
  HumanReviewRequestedEvent,
} from './ai/events';
export {
  ToolCallReplayConflictError,
  ToolEffectLog,
  computeSemanticHash,
} from './ai/tool-effect-log';
export type { EffectRecord } from './ai/tool-effect-log';

// Providers
export { AnthropicProvider } from './ai/providers/anthropic';
export type { ChatOptions, LLMProvider } from './ai/providers/interface';
export { OpenAIProvider } from './ai/providers/openai';
export type {
  ChatResponse,
  Message,
  StreamChunk,
  TokenUsage,
  ToolDefinition,
} from './ai/providers/types';

// MCP
export { buildAuthHeaders } from './ai/mcp/authentication';
export type { MCPAuthConfig, SyncMCPAuthConfig } from './ai/mcp/authentication';
export { MCPClient, MCPServerUnavailableError, MCPToolTimeoutError } from './ai/mcp/client';
export type {
  MCPClientOptions,
  MCPClientTransportOptions,
  MCPClientUrlOptions,
} from './ai/mcp/client';
export { OAuth2TokenError, createOAuth2TokenManager } from './ai/mcp/oauth2-token-manager';
export type { OAuth2Config, OAuth2TokenManager } from './ai/mcp/oauth2-token-manager';
export { ToolNameConflictError, ToolRegistry } from './ai/mcp/registry';
export type { RegistryTool } from './ai/mcp/registry';
export { ToolSchemaValidationError, validateSchema } from './ai/mcp/schema-validator';
export { MCPTransportError, inferTransportKind, parseStdioUrl } from './ai/mcp/transport';
export type { MCPRequest, MCPResponse, MCPTransport, TransportKind } from './ai/mcp/transport';
export { HttpTransport } from './ai/mcp/transport-http';
export type { HeaderSource, HttpTransportOptions } from './ai/mcp/transport-http';
export { HttpSseTransport } from './ai/mcp/transport-http-sse';
export type { HttpSseTransportOptions } from './ai/mcp/transport-http-sse';
export { StdioTransport } from './ai/mcp/transport-stdio';
export type { StdioTransportOptions } from './ai/mcp/transport-stdio';

// Observability
export { createObservabilityInterceptors } from './observability/index';
export type { InterceptionContext, ObservabilityOptions } from './observability/index';
export {
  METRICS,
  createMetricsCollectorExporter,
  createOtelMetrics,
} from './observability/metrics';
export type { OtelMetrics } from './observability/metrics';
export { getOtelApi } from './observability/no-op-telemetry';
export type { OtelApi, OtelMeter, OtelSpan, OtelTracer } from './observability/no-op-telemetry';
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
