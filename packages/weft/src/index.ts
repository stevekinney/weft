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
export {
  HttpClient,
  HttpClientError,
  type HttpClientOptions,
  type WorkflowEventStreamOptions,
  type WorkflowEventTransport,
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
  type ConnectionOptions,
  type ResolvedConnection,
} from './connection.ts';
export * from './core/index.ts';
export * from './core/messaging.ts';
export * from './core/public-types.ts';
export * from './core/workflow-registry.ts';
export * from './diagnostics/index.ts';
export * from './json-schema.ts';
export * from './mcp/index.ts';
export * from './observability/index.ts';
export {
  createObservabilityInterceptors,
  type InterceptionContext,
  type ObservabilityOptions,
} from './observability/index.ts';
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
export { hashBytes, hashString, sleep } from './runtime/portable.ts';
export * from './server/handler.ts';
export { handleRequest } from './server/handler.ts';
export * from './server/index.ts';
export { serve } from './server/index.ts';
export { weftFaultPolicy } from './server/weft-fault-policy.ts';
/*
 * The operation layer (`defineOperation`, `createOperationHandler`, the fault model, principals, the
 * replay-and-live feed and the document generators) is `@lostgradient/backchannel`. Weft exports
 * none of it.
 */
export type { SchedulingPolicy } from './server/task-queue-types.ts';
export * from './service-worker/index.ts';
export { CompressedStorage } from './storage/compressed-storage.ts';
export * from './storage/http.ts';
export { DEFAULT_SCOPE, KEYS, WEFT_RESERVED_KEY_PREFIXES } from './storage/keys.ts';
export {
  jsonCodec,
  msgpackCodec,
  withCodec,
  type CodecStorageOptions,
  type MessagePackValue,
  type StorageCodec,
  type StorageValueParser,
  type TypedBatchOperation,
  type TypedConditionalBatchCondition,
  type TypedStorage,
} from './storage/typed-storage.ts';
export * from './worker/index.ts';
// The portable testing primitives, named rather than `export *`: the testing barrel also exports
// the subprocess engine (`spawnServerSubprocess`, `withSubprocessServer`, `killAndReboot`), which
// calls `Bun.spawn` and belongs under `@lostgradient/weft/testing` alone. Re-exporting the whole
// barrel put `Bun.spawn` into the root's browser bundle, which the published package's
// portability gate refused at the 0.26.0 release (COR-1192).
export {
  UPGRADE_REFUSAL_REASON_PREFIX,
  WORKER_CONFLICT_REASONS,
  type WorkerConflictReason,
} from './server/operations/worker-conflict-reasons.ts';
export {
  ChaosNonRetryableError,
  ChaosTimeoutError,
  ChaosTransientError,
  withChaos,
  type ChaosScenario,
  type FaultClass,
} from './testing/chaos.ts';
export { flushPortableMicrotasks, yieldToPortableEventLoop } from './testing/event-loop.ts';
export {
  ActivityMockRegistry,
  type MockCall,
  type MockHandle,
  type MockedActivity,
} from './testing/mocks.ts';
export { TestEngine, type RunNOptions, type RunNResult } from './testing/test-engine.ts';
export { TimeControl } from './testing/time-control.ts';
export { VERSION } from './version.ts';
export {
  bindingFromExecution,
  executionRequirementFromWorkflowWorkerBinding,
  inheritWorkflowWorkerBinding,
  selectWorkflowActivityBinding,
} from './worker/binding-helpers.ts';
export {
  WORKER_DEPLOYMENT_ROUTING_PREFIX,
  WORKER_DEPLOYMENT_VERSION_PREFIX,
} from './worker/deployment-records.ts';
export {
  WorkerDeploymentCatalog,
  selectWorkerDeployment,
  type DeploymentRoutingCandidate,
  type DeploymentSelection,
  type DeploymentSelectionFailure,
  type DeploymentSelectionResult,
  type WorkerDeploymentRemovalOutcome,
  type WorkerDeploymentRouting,
  type WorkerDeploymentRoutingWrite,
  type WorkerDeploymentVersion,
  type WorkerDeploymentVersionReport,
  type WorkerDeploymentVersionState,
} from './worker/deployment-routing.ts';
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
  type ManifestValidationFailure,
  type WorkerActivityContract,
  type WorkerDeploymentIdentity,
  type WorkerExecutionIdentity,
  type WorkerExecutionRequirement,
  type WorkerManifest,
  type WorkerManifestFromRegistryOptions,
  type WorkerManifestParseResult,
  type WorkerManifestParseSuccess,
  type WorkerManifestRejectionReason,
  type WorkerRuntimeIdentity,
  type WorkerWorkflowContract,
} from './worker/manifest/index.ts';
export * from './worker/protocol.ts';
export { WorkerRegistry, type RoutingPolicy } from './worker/registry.ts';
export {
  consumeWorkflowWorkerStartOverridePreview,
  issueWorkflowWorkerStartOverridePreview,
  verifyWorkflowWorkerStartOverridePreview,
  type WorkerStartOverridePreview,
} from './worker/start-override-preview.ts';
export {
  DEFAULT_WORKFLOW_WORKER_VERSIONING_POLICY,
  bindWorkflowWorkerAtStart,
  evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint,
  evaluateWorkflowWorkerUpgrade,
  readWorkflowWorkerBinding,
  recordWorkflowWorkerUpgrade,
  type WorkerUpgradeBlockedReason,
  type WorkerUpgradeEvaluation,
  type WorkflowWorkerBinding,
  type WorkflowWorkerBindingRecord,
} from './worker/versioning-policy.ts';
export {
  WorkerProtocolIncompatibleError,
  workerProtocolIncompatibleMessage,
} from './worker/worker-protocol-incompatible-error.ts';
export {
  buildQualifiedActivityTable,
  type RemoteWorkerActivityFunction,
  type RemoteWorkerActivityImplementation,
  type RemoteWorkerWorkflowDefinition,
} from './worker/workflow-activity-binding.ts';
export {
  executeActivity,
  type ActivityExecutionRequest,
  type ActivityExecutionResult,
} from './workers/activity-runner.ts';
export {
  ActivityWorkerDispatcher,
  type ActivityWorkerDispatcherOptions,
} from './workers/activity-worker-dispatcher.ts';
export {
  createActivityWorkerEntryUrl,
  initializeActivityWorkerMessageLoop,
  revokeActivityWorkerEntryUrl,
  type ActivityHandlerLookup,
} from './workers/activity-worker-entry.ts';
export { WorkerPool, type WorkerPoolOptions } from './workers/pool.ts';

export * from './client/generated/operation-client.generated.ts';
export type { WeftClientConnection } from './client/weft-connection-transport.ts';
export { CodegenEmitError, jsonSchemaToTypeScript } from './json-schema/codegen-emit.ts';
export { createCatalogSnapshot } from './server/weft-catalog-snapshot.ts';

export { REGISTRY_VERSION, type RegistryActivityEntry } from './core/registry-snapshot.ts';
export {
  isRemoteTaskTerminalCancelled,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
} from './core/task-ledger/task-ledger.ts';
export {
  createLiveOperationRegistry,
  type LiveOperationRegistryOptions,
} from './server/rest-bindings.ts';

export * from './document-workflow/index.ts';

export {
  AUTHORIZATION_SCOPES,
  WEFT_SCOPE_VOCABULARY,
  type BuiltInAuthorizationScope,
} from './authorization-scopes.ts';
