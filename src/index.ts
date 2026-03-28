/**
 * Weft — A Bun-native durable execution engine.
 * @module weft
 */

export const VERSION = '0.0.1';

// Core
export { Engine, WorkflowHandle } from './core/engine';
export {
  DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_RETRY_POLICY,
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

// Events
export {
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  DevelopmentWarningEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
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

// Storage
export { BunSQLiteStorage } from './storage/bun-sql';
export { KEYS } from './storage/interface';
export type { BatchOperation, ScanOptions, Storage } from './storage/interface';
export { LMDBStorage } from './storage/lmdb';
export { MemoryStorage } from './storage/memory';
export { TursoStorage } from './storage/turso';
export type { TursoStorageOptions } from './storage/turso';

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

// Context
export { Context } from './core/context';
export type {
  ContextOperationRequest,
  ContextOptions,
  OffloadReference,
  StreamReference,
  StreamSink,
} from './core/context';

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
export { UpdateCoordinator, UpdateTimeoutError } from './core/updates';

// Versioning
export {
  VersionMismatchError,
  checkVersionCompatibility,
  migrateCheckpoint,
} from './core/versioning';

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
export { handleRequest } from './server/handler';
export { serve } from './server/index';
export type { ServeOptions, WeftServer } from './server/index';

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
export type { AgentOptions, AgentResult, AgentTool } from './ai/agent';
export { BudgetExceededError, BudgetTracker } from './ai/budget';
export type { BudgetOptions, BudgetState, ModelPricing } from './ai/budget';
export { BudgetPolicyEnforcer, OrganizationBudgetExceededError } from './ai/budget-policy';
export type { BudgetPolicyOptions } from './ai/budget-policy';
export { slidingWindowStrategy } from './ai/context-strategies/sliding-window';
export { ContextWindowManager, composeStrategies, noopStrategy } from './ai/context-window';
export type { ContextStrategy } from './ai/context-window';
export { debate, handoff, supervise } from './ai/coordination';
export { defineAgent } from './ai/declaration';
export type { AgentDefinition } from './ai/declaration';
export type { AgentHooks } from './ai/hooks';
export { ReviewCoordinator, ReviewTimeoutError } from './ai/human-review';
export {
  abTestRouter,
  costTierRouter,
  customRouter,
  staticFallbackRouter,
} from './ai/model-router';
export type { ModelRouter, ModelSelection, RoutingContext } from './ai/model-router';
export { ProviderHealthTracker } from './ai/provider-health';
export { ReconnectionBuffer, StreamMultiplexer, TokenBridge } from './ai/streaming';

// AI Events
export {
  AgentBudgetExceededEvent,
  AgentBudgetWarningEvent,
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
export type { MCPAuthConfig } from './ai/mcp/authentication';
export { MCPClient, MCPServerUnavailableError, MCPToolTimeoutError } from './ai/mcp/client';
export { ToolNameConflictError, ToolRegistry } from './ai/mcp/registry';
export { ToolSchemaValidationError, validateSchema } from './ai/mcp/schema-validator';

// Observability
export { createObservabilityInterceptors } from './observability/index';
export { METRICS } from './observability/metrics';
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
export {
  createActivityWorkerEntryUrl,
  initializeActivityWorkerMessageLoop,
} from './workers/activity-worker-entry';
export { WorkerPool } from './workers/pool';
export type { WorkerPoolOptions } from './workers/pool';

// Remote Worker
export { HeartbeatManager } from './worker/heartbeat';
export { RemoteWorker } from './worker/index';
export { LongPollWorker } from './worker/long-poll';
export { WorkerRegistry } from './worker/registry';

// Diagnostics
export { collectDiagnostics } from './diagnostics/doctor';
export {
  formatBytes,
  formatDiagnosticReport,
  formatDuration,
  formatVersionCheckReport,
} from './diagnostics/format';
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
