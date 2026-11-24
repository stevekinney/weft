/**
 * @lostgradient/backchannel
 *
 * The public surface of the operation layer.
 */

export {
  defaultAuthAuditSink,
  type AuthAuditEvent,
  type AuthAuditSink,
} from './authentication/audit.ts';
export {
  createApiKeyVerifier,
  createAuthenticator,
  createJwtVerifier,
  createMutualTlsVerifier,
  validateAuthConfig,
  type CreateAuthenticatorOptions,
  type CredentialVerification,
  type CredentialVerifier,
} from './authentication/index.ts';
export {
  createRateLimiter,
  validateRateLimitConfig,
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimitStore,
  type RateLimiter,
} from './authentication/rate-limiter.ts';
export { isSensitiveHeader, redactCredential, redactHeaders } from './authentication/redaction.ts';
export {
  createRotatingApiKeyStore,
  type ApiKeyRegistration,
  type ApiKeyStore,
  type RotatingApiKeyStore,
} from './authentication/rotating-api-key-store.ts';
export type {
  AuthConfig,
  AuthMethod,
  AuthResult,
  Authenticator,
  JWTAlgorithm,
  JWTConfig,
  JWTPayload,
  MTLSConfig,
} from './authentication/types.ts';
export {
  PACKAGE_AUTHORIZATION_SCOPE_PATTERN,
  createScopeVocabulary,
  isAuthorizationScope,
  isPackageAuthorizationScope,
  type AuthorizationScope,
  type PackageAuthorizationScope,
  type ScopeVocabulary,
} from './authorization-scope.ts';
export { bindFeedLifetime } from './bind-feed-lifetime.ts';
export type { DiscoveryInfo } from './discovery-info.ts';
export { isFaultCode, type FaultCode } from './fault-code.ts';
export { staleRevisionFault } from './fault-wire-safety.ts';
export {
  authContextToPrincipal,
  unauthenticatedLocalAuthContext,
} from './handler/auth-context-principal.ts';
export {
  createOperationHandlerAuthenticator,
  type OperationHandlerAuthenticate,
  type OperationHandlerAuthenticator,
  type OperationHandlerAuthenticatorOptions,
} from './handler/operation-handler-authentication.ts';
export type {
  OperationHandlerMount,
  OperationHandlerMountContext,
  OperationHandlerMountDispatchOptions,
  OperationHandlerMountOperation,
} from './handler/operation-handler-mounts.ts';
export {
  createOperationHandler,
  type OperationHandler,
  type OperationHandlerOptions,
} from './handler/operation-handler.ts';
export { guardWorkspaceResponse } from './handler/workspace-release.ts';
export {
  createInMemoryReplayLiveBackend,
  type InMemoryReplayLiveBackend,
  type InMemoryReplayLiveBackendOptions,
} from './in-memory-replay-live-backend.ts';
export {
  dispatchJsonRpc,
  type DispatchJsonRpcContext,
  type DispatchJsonRpcResult,
  type JsonRpcSubscription,
} from './json-rpc-dispatch.ts';
export {
  stringifyCatalogSnapshot,
  type CatalogAccessSnapshot,
  type CatalogOperationSnapshot,
  type CatalogRestBindingSnapshot,
  type CatalogSnapshot,
} from './operation-catalog-snapshot.ts';
export {
  createOperationRegistry,
  type DispatchResult,
  type OperationRegistry,
  type OperationRegistryOptions,
} from './operation-catalog/index.ts';
export {
  OPERATION_NAME_PATTERN,
  isValidOperationName,
  validateOperationName,
  type FaultPolicy,
  type OperationContext,
  type OperationKind,
  type StreamOperationInvocation,
  type SubscriptionOperationInvocation,
  type TransportAvailability,
  type UnknownKeyPolicy,
} from './operation-catalog/types.ts';
export { findUndescribedOperations } from './operation-description-audit.ts';
export type { OperationFault } from './operation-fault.ts';
export {
  defineOperation,
  type OperationDefinitionInput,
  type SchemaOperationDefinition,
  type StreamSchemaOperationDefinition,
  type SubscriptionSchemaOperationDefinition,
  type UnarySchemaOperationDefinition,
} from './operation-registry.ts';
export {
  createReplayAwareClosableIterable,
  type ClosableAsyncIterable,
  type ReplayAwareClosableIterable,
} from './operations/closable-iterable.ts';
export {
  createGetPrincipalOperation,
  type GetPrincipalOutput,
} from './operations/get-principal.ts';
export {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromStdioLocal,
  principalFromUnauthenticatedLocal,
  type AuthenticatedPrincipal,
  type JwtClaims,
  type Principal,
  type UnauthenticatedPrincipal,
  type WorkspaceIdentity,
} from './principal.ts';
export type {
  ReplayLiveFeed,
  ReplayLiveFeedBackend,
  ReplayLiveSubscribeOptions,
} from './replay-live-feed-types.ts';
export { createReplayLiveFeed } from './replay-live-feed.ts';
export type { CorsOptions } from './runtime/cors.ts';
export {
  decodeCursor,
  encodeCursor,
  type Cursor,
  type SequencedEventEnvelope,
} from './sequence-cursor.ts';

export type {
  OperationHostFactory,
  OperationInterceptor,
  OperationInterceptorContext,
} from './operation-catalog/operation-interceptors.ts';
