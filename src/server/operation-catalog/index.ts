/**
 * Transport-neutral operation catalog and the single dispatch pipeline.
 *
 * `executeOperation` is the only function transport adapters call to invoke an
 * operation. REST, JSON-RPC HTTP, JSON-RPC WebSocket, and stdio all share one
 * access check, one input validation step, one authorization hook, and one
 * error classifier.
 *
 * @module server/operation-catalog
 */

export type { FaultCode } from '../../core/fault-code.ts';
export { catalogActivities, catalogActivity } from './activity-adapter.ts';
export type { CatalogActivityDefinition } from './activity-adapter.ts';
export { DISPATCH_ALLOWLIST } from './dispatch-allowlist.ts';
export { classifyEngineError } from './pipeline-helpers.ts';
export { executeOperation } from './pipeline.ts';
export { UNIVERSAL_FAULT_DEFAULTS, raiseFault } from './raise-fault.ts';
export { createOperationRegistry } from './registry.ts';
export {
  SubscriptionElementValidationError,
  executeStream,
  executeSubscription,
} from './stream-pipeline.ts';
export {
  OPERATION_NAME_PATTERN,
  isValidOperationName,
  validateOperationName,
  type AuthorizationDecision,
  type DispatchContext,
  type DispatchResult,
  type ErasedOperation,
  type McpToolMetadata,
  type OperationContext,
  type OperationDefinition,
  type OperationInvocationResult,
  type OperationKind,
  type OperationRegistry,
  type ParameterizedAccessHint,
  type PipelineTrace,
  type PipelineTraceMarker,
  type RegistrableOperation,
  type StreamOperationInvocation,
  type SubscriptionOperationInvocation,
  type TransportAvailability,
  type UnknownKeyDisposition,
  type UnknownKeyPolicy,
} from './types.ts';
export { catalogWorkflow } from './workflow-adapter.ts';
export type { CatalogWorkflowOptions } from './workflow-adapter.ts';
