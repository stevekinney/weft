export { AlertManager } from './alerting/index.ts';
export type {
  AlertAction,
  AlertMetric,
  AlertRule,
  AlertStateSnapshot,
  AlertStatus,
  AlertingOptions,
  WebhookTarget,
} from './alerting/types.ts';
export type { WeftClientStorage } from './client/client-storage.ts';
export type { WorkflowEventTail } from './client/event-tail.ts';
export { HttpClient, HttpClientError } from './client/index.ts';
export type {
  HttpClientOptions,
  WorkflowEventStreamOptions,
  WorkflowEventTransport,
} from './client/index.ts';
export type {
  ClientHandle,
  ClientScheduleHandle,
  ClientStartOptions,
  ClientStartOrSignalOptions,
  StartOrSignalOutcome,
  UpdateResult,
  WeftClient,
  WeftClientActivity,
} from './client/interface.ts';
export { LocalClient } from './client/local.ts';
export type {
  KnownWorkflowName,
  UnknownNameWhenRegistryEmpty,
} from './client/workflow-name-typing.ts';
export {
  ConnectionConfigurationError,
  DEFAULT_WEFT_ADDRESS,
  resolveConnection,
} from './connection.ts';
export type { ConnectionOptions, ResolvedConnection } from './connection.ts';
export * from './core/index.ts';
export * from './core/messaging.ts';
export * from './core/public-types.ts';
export * from './core/workflow-registry.ts';
export * from './diagnostics/index.ts';
export * from './json-schema.ts';
export * from './mcp/index.ts';
export * from './observability/index.ts';
export { createObservabilityInterceptors } from './observability/index.ts';
export type { InterceptionContext, ObservabilityOptions } from './observability/index.ts';
export {
  METRICS,
  createMetricsCollectorExporter,
  createOpenTelemetryMetrics,
} from './observability/metrics.ts';
export { getOpenTelemetryApi } from './observability/no-op-telemetry.ts';
export {
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  parseTraceParent,
} from './observability/propagation.ts';
export {
  detectRuntime,
  detectRuntimeVersion,
  hashBytes,
  hashString,
  sleep,
} from './runtime/portable.ts';
export type { RuntimeKind } from './runtime/portable.ts';
export { createAuthenticator, validateAuthConfig } from './server/authentication.ts';
export type {
  AuthConfig,
  AuthMethod,
  AuthResult,
  Authenticator,
  JWTAlgorithm,
  JWTConfig,
  JWTPayload,
  MTLSConfig,
} from './server/authentication.ts';
export { AUTHORIZATION_SCOPES, isAuthorizationScope } from './server/authorization-scope.ts';
export type { AuthorizationScope } from './server/authorization-scope.ts';
export * from './server/handler.ts';
export { handleRequest } from './server/handler.ts';
/*
 * The operation catalog, as a public contract.
 *
 * `defineOperation` was internal while Weft was its own catalog's only
 * author. It is exported now because it is not: `@lostgradient/operative` and
 * `@lostgradient/bureau` already depend on this package, and a gateway serving
 * all three wants one dispatch pipeline, one transport matrix
 * (`http`/`jsonRpcHttp`/`jsonRpcWebSocket`/`jsonRpcStdio`), and one AsyncAPI
 * document rather than a second RPC dialect beside them.
 *
 * Exporting the definition surface rather than moving it keeps the 194
 * operations already registered here, and their tests, exactly where they
 * are. See `OPERATION_NAME_PATTERN` for the namespace change that makes a
 * shared catalog expressible.
 */
export * from './server/index.ts';
export { serve } from './server/index.ts';
export {
  OPERATION_NAME_PATTERN,
  isValidOperationName,
  validateOperationName,
} from './server/operation-catalog/types.ts';
export type {
  OperationContext,
  OperationKind,
  StreamOperationInvocation,
  SubscriptionOperationInvocation,
  TransportAvailability,
  UnknownKeyPolicy,
} from './server/operation-catalog/types.ts';
export { defineOperation } from './server/operation-registry.ts';
export type {
  OperationDefinitionInput,
  SchemaOperationDefinition,
  StreamSchemaOperationDefinition,
  SubscriptionSchemaOperationDefinition,
  UnarySchemaOperationDefinition,
} from './server/operation-registry.ts';
/*
 * The replay-plus-live feed and its subscription plumbing, as public
 * contracts.
 *
 * `createReplayLiveFeed` is generic over its envelope and its backend, and
 * Weft already instantiates it twice (workflow events, fleet events). A third
 * consumer — an agent run in `@lostgradient/operative`, a bureau in
 * `@lostgradient/bureau` — needs the same cursors, the same replay-then-live
 * join, and the same resume semantics, so it takes them from here rather than
 * growing a parallel set. `createReplayAwareClosableIterable` goes with them:
 * a subscription operation outside this package cannot be written without it.
 *
 * `createInMemoryReplayLiveBackend` is the live-only backend. Choosing it
 * first is deliberate and reversible: a durable backend replaces that one
 * argument and changes nothing above it.
 *
 * These exports are grouped by subject in this comment but sorted by module
 * below, because the formatter orders export statements alphabetically.
 */
export { bindFeedLifetime } from './server/bind-feed-lifetime.ts';
export { createInMemoryReplayLiveBackend } from './server/in-memory-replay-live-backend.ts';
export type {
  InMemoryReplayLiveBackend,
  InMemoryReplayLiveBackendOptions,
} from './server/in-memory-replay-live-backend.ts';
export {
  createReplayAwareClosableIterable,
  type ClosableAsyncIterable,
  type ReplayAwareClosableIterable,
} from './server/operations/event-stream-contracts.ts';
export type { SchedulingPolicy } from './server/task-queue-types.ts';
export { createReplayLiveFeed, decodeCursor, encodeCursor } from './server/workflow-event-feed.ts';
export type {
  Cursor,
  ReplayLiveFeed,
  ReplayLiveFeedBackend,
  ReplayLiveSubscribeOptions,
  SequencedEventEnvelope,
} from './server/workflow-event-feed.ts';
export * from './service-worker/index.ts';
export * from './storage/auto.ts';
export { BunSQLiteStorage } from './storage/bun-sql.ts';
export * from './storage/cloudflare.ts';
export { CompressedStorage } from './storage/compressed-storage.ts';
export { storageDeleteRange } from './storage/delete-range.ts';
export type { DeleteRangeOptions } from './storage/delete-range.ts';
export * from './storage/http.ts';
export * from './storage/indexeddb.ts';
export {
  DEFAULT_SCOPE,
  KEYS,
  MAX_BATCH_OPERATIONS,
  MAX_SCAN_LIMIT,
  StorageBatchOperationLimitExceededError,
  WEFT_RESERVED_KEY_PREFIXES,
  assertDurableStorageForRecovery,
  assertStorageBatchOperationCount,
  matchesScanOptions,
  requireStorageCapability,
  resolvePrefixRangeEnd,
  storageBatch,
  storageConditionalBatch,
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  storageValuesEqual,
} from './storage/interface.ts';
export type {
  BatchOperation,
  ConditionalBatchCondition,
  GatedStorageCapabilityKey,
  ScanOptions,
  Storage,
  StorageBatchOperationLimitTarget,
  StorageCapabilities,
} from './storage/interface.ts';
export {
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
  formatSortableStorageTimestamp,
  tryDecodeStorageKeyComponent,
} from './storage/key-encoding.ts';
export * from './storage/lmdb.ts';
export { MemoryStorage } from './storage/memory.ts';
export * from './storage/neon.ts';
export { NodeSQLiteStorage } from './storage/node-sqlite.ts';
export * from './storage/postgres.ts';
export * from './storage/resolve.ts';
export { ScopedStorage, scopedStorage } from './storage/scoped-storage.ts';
export { copyTextKeyValueRowsToStorage } from './storage/text-value-import.ts';
export type {
  CopyTextKeyValueRowsToStorageOptions,
  CopyTextKeyValueRowsToStorageResult,
  TextKeyValueRow,
} from './storage/text-value-import.ts';
export * from './storage/text-value-store.ts';
export * from './storage/turso.ts';
export { jsonCodec, msgpackCodec, withCodec } from './storage/typed-storage.ts';
export type {
  CodecStorageOptions,
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedConditionalBatchCondition,
  TypedStorage,
} from './storage/typed-storage.ts';
export * from './storage/web-extension.ts';
export * from './testing/index.ts';
export { VERSION } from './version.ts';
export { HeartbeatManager } from './worker/heartbeat.ts';
export { RemoteWorker } from './worker/index.ts';
export { LongPollWorker } from './worker/long-poll.ts';
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
  WorkerManifestBuildError,
  buildWorkerExecutionIdentity,
  buildWorkerManifestFromRegistry,
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
  WorkerManifestFromRegistryOptions,
  WorkerManifestParseResult,
  WorkerManifestParseSuccess,
  WorkerManifestRejectionReason,
  WorkerRuntimeIdentity,
  WorkerWorkflowContract,
} from './worker/manifest/index.ts';
export * from './worker/protocol.ts';
export { WorkerRegistry } from './worker/registry.ts';
export type { RoutingPolicy } from './worker/registry.ts';
export {
  WorkerProtocolIncompatibleError,
  workerProtocolIncompatibleMessage,
} from './worker/worker-protocol-incompatible-error.ts';
export { buildQualifiedActivityTable } from './worker/workflow-activity-binding.ts';
export type {
  RemoteWorkerActivityFunction,
  RemoteWorkerActivityImplementation,
  RemoteWorkerWorkflowDefinition,
} from './worker/workflow-activity-binding.ts';
export { executeActivity } from './workers/activity-runner.ts';
export type {
  ActivityExecutionRequest,
  ActivityExecutionResult,
} from './workers/activity-runner.ts';
export { ActivityWorkerDispatcher } from './workers/activity-worker-dispatcher.ts';
export type { ActivityWorkerDispatcherOptions } from './workers/activity-worker-dispatcher.ts';
export {
  createActivityWorkerEntryUrl,
  initializeActivityWorkerMessageLoop,
  revokeActivityWorkerEntryUrl,
} from './workers/activity-worker-entry.ts';
export type { ActivityHandlerLookup } from './workers/activity-worker-entry.ts';
export { WorkerPool } from './workers/pool.ts';
export type { WorkerPoolOptions } from './workers/pool.ts';

export * from './client/generated/operation-client.generated.ts';
export type { JsonRpcCallResult, JsonRpcErrorObject } from './client/json-rpc-request.ts';
export * from './client/operation-client-runtime.ts';
export { CodegenEmitError, jsonSchemaToTypeScript } from './json-schema/codegen-emit.ts';
export * from './server/operation-catalog-snapshot.ts';

export { REGISTRY_VERSION } from './core/registry-snapshot.ts';
export type { RegistryActivityEntry } from './core/registry-snapshot.ts';
export {
  isRemoteTaskTerminalCancelled,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
} from './core/task-ledger/task-ledger.ts';
export { createLiveOperationRegistry } from './server/rest-bindings.ts';
export type { LiveOperationRegistryOptions } from './server/rest-bindings.ts';
