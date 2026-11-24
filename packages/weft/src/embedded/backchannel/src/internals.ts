/**
 * @lostgradient/backchannel/internals
 *
 * The plumbing a host needs to build on the operation layer. Unstable: a name here may change or move
 * without notice, and nothing outside this repository should depend on it.
 */

export {
  buildOperationEntry,
  buildSseChannel,
  buildSseMessages,
  buildWebSocketChannel,
  buildWebSocketMessages,
} from './asyncapi-channels.ts';
export { generateAsyncApiDocument, type AsyncApiOptions } from './asyncapi.ts';
export { importJWTKey, signJWT, verifyJWT } from './authentication/crypto.ts';
export { buildTLSOptions, tlsOptionsVerifyClientCertificates } from './authentication/index.ts';
export {
  DEFAULT_PUBLIC_PATHS,
  normalizeRequestPathname,
  type AuthContext,
} from './authentication/types.ts';
export {
  createAdditionalScopeSet,
  filterRecognizedScopes,
  type AdditionalScopeSet,
} from './authorization-scope.ts';
export { evaluateAccess, type AccessPolicy } from './authorization.ts';
export { copyBytesToArrayBuffer } from './byte-arrays.ts';
export type { ConnectionLease } from './connection-lease.ts';
export { isDiscoverable } from './discovery-filter.ts';
export type { EventSelector } from './event-selector.ts';
export { FAULT_CODE_RETRYABLE, isFaultRetryable } from './fault-code.ts';
export {
  MAX_REMEDIATION_LENGTH,
  assertValidRemediation,
  faultWireAdvice,
  remediationProblem,
  withRemediation,
} from './fault-remediation.ts';
export { faultToHttpResponse } from './fault-to-http.ts';
export { faultErrorData, faultToJsonRpcError } from './fault-to-json-rpc.ts';
export { assertFiniteFaultData } from './fault-wire-safety.ts';
export {
  authContextFromAuthResult,
  unauthorizedResponse,
} from './handler/authentication-responses.ts';
export { errorResponse, jsonResponse, negotiatedJsonOrBinary } from './handler/json-responses.ts';
export { dispatchJsonRpc } from './json-rpc-dispatch.ts';
export { handleJsonRpcHttpRequest } from './json-rpc-http.ts';
export {
  closeJsonRpcWebSocketSession,
  handleJsonRpcWebSocketMessage,
  openGenericJsonRpcWebSocketSession,
  workspaceEmitter,
  type JsonRpcSocketData,
} from './json-rpc-session-runtime.ts';
export type {
  JsonRpcWebSocketEmitter,
  JsonRpcWebSocketSession,
} from './json-rpc-websocket-types.ts';
export { createJsonRpcWebSocketSession } from './json-rpc-websocket.ts';
export { compareStrings } from './json-schema-utilities.ts';
export { MCP_TOOLS_LIST_METHOD } from './mcp-discovery-names.ts';
export { canonicalJson } from './openapi-canonical-json.ts';
export { buildErrorResponses } from './openapi-error-responses.ts';
export {
  emitBindings,
  generateOpenApiDocument,
  type OpenApiSecuritySchemeName,
} from './openapi.ts';
export { OpenRpcDocumentSchema } from './openrpc-document-schema.ts';
export { buildOpenRpcComponentsErrors } from './openrpc-errors.ts';
export { generateOpenRpcDocument } from './openrpc.ts';
export { snapshotOperationCatalog } from './operation-catalog-snapshot.ts';
export {
  UndeclaredFaultError,
  classifyEngineError,
  transportToAvailabilityKey,
  transportToPolicyKey,
} from './operation-catalog/pipeline-helpers.ts';
export { executeOperation } from './operation-catalog/pipeline.ts';
export { createOperationRegistry } from './operation-catalog/registry.ts';
export {
  SubscriptionElementValidationError,
  executeStream,
} from './operation-catalog/stream-pipeline.ts';
export type {
  AuthorizationDecision,
  DispatchResult,
  ErasedOperation,
  OperationRegistry,
  ParameterizedAccessHint,
  PipelineTrace,
  PipelineTraceMarker,
  RegistrableOperation,
} from './operation-catalog/types.ts';
export { UNIVERSAL_FAULT_DEFAULTS } from './operation-catalog/universal-faults.ts';
export { invalidParamsFault, isOperationFault } from './operation-fault-helpers.ts';
export {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
  shapeOperationFaultAsJson,
  shapeRestFaultAsJson,
  type RestFaultResponseOptions,
  type TransportKind,
} from './operation-fault.ts';
export {
  isClosableAsyncIterable,
  isReplayAwareClosableIterable,
} from './operations/closable-iterable.ts';
export { getPrincipalRestBinding } from './operations/get-principal.ts';
export {
  DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
  SSE_RESPONSE_HEADERS,
  createEventEnvelopeSSEStream,
  createStoredChunkSSEStream,
  formatServerSentEvent,
  readServerSentEventsCursor,
  requireServerSentEventsAccept,
  shapeServerSentEventsFault,
} from './operations/sse-stream.ts';
export { isAuthenticated } from './principal.ts';
export {
  ReplayWindowExceededError,
  createDurableSubscription,
  createSerialOperationQueue,
} from './replay-live-feed-internals.ts';
export {
  MalformedRouteParameterError,
  bindingPathMatches,
  isRestBindingCompatibleWithOperation,
  type ParamSource,
  type ResponseShape,
  type RestBinding,
  type RestInputContext,
  type UnknownRestBinding,
} from './rest-binding.ts';
export {
  DEFAULT_REST_MAX_BODY_BYTES,
  readOptionalRestJsonBody,
  readRestBodyBounded,
  readRestJsonBody,
  readRestTextBody,
  type RestBodyReadOptions,
} from './rest-body.ts';
export {
  API_PREFIX,
  DIRECT_HTTP_ROUTES,
  JSON_RPC_PATH,
  MCP_STREAMABLE_HTTP_PATH,
  externalApiPath,
  overlapsReservedRoute,
  toOpenApiPath,
  toRegex,
} from './route-model.ts';
export {
  buildPreflightResponse,
  decorateResponseWithCors,
  isOriginAllowed,
  isPreflightRequest,
  resolveCorsPolicy,
  validateCorsOptions,
  type ResolvedCorsPolicy,
} from './runtime/cors.ts';
export { compareCursor, parseOptionalSequenceCursor } from './sequence-cursor.ts';
export { runStdioSession, type StdioAdmission, type StdioSessionResult } from './stdio-session.ts';
export { requirePlainObject, stripDialect, zodToJsonSchema } from './zod-json-schema.ts';
