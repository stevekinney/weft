import { z } from 'zod';

import type { AccessPolicy } from '../authorization.ts';
import type { FaultCode, OperationFault, TransportKind } from '../operation-fault.ts';
import type { Principal } from '../principal.ts';

/**
 * Regex for the canonical `weft.<segment>(.<segment>)+` operation-name form.
 * Mandatory `weft.` prefix and at least one additional dot-separated segment.
 */
export const OPERATION_NAME_PATTERN = /^weft\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Throws if `name` does not match the canonical operation-name pattern. */
export function validateOperationName(name: string): void {
  if (!OPERATION_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid operation name "${name}" — must match weft.<segment>(.<segment>)+ where each segment starts with a lowercase ASCII letter and may contain lowercase ASCII letters or digits (e.g., "weft.workflows.start", "weft.workflows.list2")`,
    );
  }
}

/** Non-throwing variant of `validateOperationName`. */
export function isValidOperationName(name: string): boolean {
  return OPERATION_NAME_PATTERN.test(name);
}

/**
 * Per-operation transport availability flags. A `false` entry means callers
 * on that transport receive `UnsupportedTransport`, not `MethodNotFound`.
 */
export type TransportAvailability = {
  http: boolean;
  jsonRpcHttp: boolean;
  jsonRpcWebSocket: boolean;
  jsonRpcStdio: boolean;
};

/**
 * Per-transport unknown-key disposition. Top-level only; nested object
 * behavior is controlled by the zod schema's own object mode.
 */
export type UnknownKeyDisposition = 'reject' | 'strip' | 'passthrough';

export type UnknownKeyPolicy = {
  http: UnknownKeyDisposition;
  jsonRpc: UnknownKeyDisposition;
};

/**
 * Runtime shape of an operation. Unary operations return one validated
 * `outputSchema` value. Stream and subscription operations return long-lived
 * iterables whose elements are validated against `eventSchema`.
 */
export type OperationKind = 'unary' | 'stream' | 'subscription';

/** Invocation result for `kind: 'stream'` operations. */
export type StreamOperationInvocation<Element> = AsyncIterable<Element>;

/** Invocation result for `kind: 'subscription'` operations. */
export type SubscriptionOperationInvocation<Element, Envelope> = {
  readonly envelope: Envelope;
  readonly iterable: AsyncIterable<Element>;
  readonly close: () => Promise<void>;
};

export type OperationInvocationResult<Output> =
  | Output
  | StreamOperationInvocation<unknown>
  | SubscriptionOperationInvocation<unknown, Output>;

/**
 * Metadata that connects an operation-catalog entry to a live MCP tool.
 *
 * v1 only supports workflow-backed MCP tools. The exact MCP tool name is
 * resolved from the live engine registry during discovery because `tools/list`
 * owns collision handling.
 */
export type McpToolMetadata = {
  readonly workflowType: string;
};

/**
 * Result of the parameter-aware `authorize` hook.
 *
 * **`reason` is wire-visible.** Hook authors must not embed secrets or
 * sensitive context in a denial reason.
 */
export type AuthorizationDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Stable audit markers emitted after each successful operation pipeline stage.
 */
export type PipelineTraceMarker =
  | 'looked-up'
  | 'transport-checked'
  | 'access-checked'
  | 'parsed'
  | 'unknown-key-policy-applied'
  | 'authorized'
  | 'invoked'
  | 'output-validated';

/**
 * Optional observer hook used by audit tests to prove a transport used the
 * full `executeOperation` pipeline.
 */
export type PipelineTrace = (marker: PipelineTraceMarker) => void;

/**
 * Context passed to both the `authorize` hook and `invoke`.
 */
export type OperationContext<Input> = {
  readonly input: Input;
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: TransportKind;
};

/**
 * Common operation fields shared by unary, stream, and subscription kinds.
 * The discriminated union below adds `kind` and `eventSchema` per kind.
 */
type OperationDefinitionBase<Input, Output> = {
  readonly name: string;
  readonly mcpExposable: boolean;
  readonly mcpTool?: McpToolMetadata;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  /**
   * Whether invoking this operation irreversibly mutates state or is
   * otherwise hard to undo (cancel, purge, bulk-delete, raw storage writes,
   * recover-all, worker drain). Consumers read this single source of truth
   * instead of maintaining their own allowlists: the CLI `weft api` escape
   * hatch refuses destructive operations without explicit confirmation,
   * dashboard bulk actions gate their confirmations on it, and MCP exposure
   * uses it to decide what to surface. Read-only operations (`get-*`,
   * `list-*`, `aggregate`, `registry`, `metrics`) are `false`.
   *
   * Required with no implicit default so every new operation is forced to
   * make the call explicitly — the same quality-floor pattern as the
   * lint-disable rationale rule.
   */
  readonly destructive: boolean;
  readonly inputSchema: z.ZodType<Input>;
  /**
   * For unary operations, validates the returned value. For subscriptions,
   * validates the subscribe envelope. For streams, describes the start/SSE
   * metadata while each yielded element is validated by `eventSchema`.
   */
  readonly outputSchema: z.ZodType<Output>;
  readonly access: AccessPolicy;
  /** Fault codes this operation can raise in addition to universal pipeline defaults. */
  readonly producibleFaults?: ReadonlyArray<FaultCode>;
  /** Whether non-public operations should appear in generated discovery documents. */
  readonly discoverable?: boolean;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<Input>) => Promise<AuthorizationDecision>;
  readonly invoke: (context: OperationContext<Input>) => Promise<OperationInvocationResult<Output>>;
};

/**
 * Unary (request/response) operation. `kind` may be omitted (defaults to
 * `'unary'`). `eventSchema` MUST be absent — a unary operation has no
 * per-element shape to validate. The `eventSchema?: never` constraint
 * enforces this at the type level: passing `eventSchema` to a unary
 * operation is a TypeScript error, not a silent runtime mismatch.
 */
type UnaryOperationDefinition<Input, Output> = OperationDefinitionBase<Input, Output> & {
  readonly kind?: 'unary';
  readonly eventSchema?: never;
};

/**
 * Streaming operation (e.g. SSE). `kind: 'stream'` is required and
 * `eventSchema` MUST be present — the dispatcher validates each yielded
 * element against this schema. Without it the streaming pipeline would
 * have no contract to validate per-element output against, which would
 * silently leak un-validated data to consumers.
 */
type StreamOperationDefinition<Input, Output> = OperationDefinitionBase<Input, Output> & {
  readonly kind: 'stream';
  readonly eventSchema: z.ZodType;
};

/**
 * WebSocket subscription operation. `kind: 'subscription'` is required and
 * `eventSchema` MUST be present (validates each delivered envelope). Same
 * rationale as `StreamOperationDefinition` — the type forbids declaring a
 * subscription without its element schema.
 */
type SubscriptionOperationDefinition<Input, Output> = OperationDefinitionBase<Input, Output> & {
  readonly kind: 'subscription';
  readonly eventSchema: z.ZodType;
};

/**
 * Discriminated union over the three operation kinds. The discriminator
 * (`kind`) determines whether `eventSchema` is required (`'stream'` /
 * `'subscription'`) or forbidden (`'unary'` or absent). Streaming
 * operations declared without `eventSchema` are now a TypeScript error
 * rather than a runtime EngineFailure; unary operations cannot
 * accidentally carry an `eventSchema` that the pipeline would never read.
 */
export type OperationDefinition<Input, Output> =
  | UnaryOperationDefinition<Input, Output>
  | StreamOperationDefinition<Input, Output>
  | SubscriptionOperationDefinition<Input, Output>;

/**
 * An operation with its Input/Output type parameters erased. The dispatcher
 * only feeds values that have been validated by the operation's own schema.
 */
export type ErasedOperation = OperationDefinition<unknown, unknown>;

/** Read-only registry of operations keyed by name. */
export type OperationRegistry = {
  get(name: string): ErasedOperation | undefined;
  list(): ReadonlyArray<ErasedOperation>;
};

/**
 * Erased operation shape accepted by `createOperationRegistry`. Mirrors
 * the discriminated union on `OperationDefinition` so registry callers
 * declaring a stream/subscription without `eventSchema` get a compile-time
 * error rather than a runtime `EngineFailure` when the pipeline first
 * attempts per-element validation.
 */
type RegistrableOperationBase = {
  readonly name: string;
  readonly mcpExposable: boolean;
  readonly mcpTool?: McpToolMetadata;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  /** See {@link OperationDefinitionBase.destructive}. Required, no default. */
  readonly destructive: boolean;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly access: AccessPolicy;
  /** Fault codes this operation can raise in addition to universal pipeline defaults. */
  readonly producibleFaults?: ReadonlyArray<FaultCode>;
  /** Whether non-public operations should appear in generated discovery documents. */
  readonly discoverable?: boolean;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<never>) => Promise<AuthorizationDecision>;
  readonly invoke: (
    context: OperationContext<never>,
  ) => Promise<OperationInvocationResult<unknown>>;
};

type UnaryRegistrableOperation = RegistrableOperationBase & {
  readonly kind?: 'unary';
  readonly eventSchema?: never;
};

type StreamRegistrableOperation = RegistrableOperationBase & {
  readonly kind: 'stream';
  readonly eventSchema: z.ZodType;
};

type SubscriptionRegistrableOperation = RegistrableOperationBase & {
  readonly kind: 'subscription';
  readonly eventSchema: z.ZodType;
};

export type RegistrableOperation =
  | UnaryRegistrableOperation
  | StreamRegistrableOperation
  | SubscriptionRegistrableOperation;

export type DispatchContext = {
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: TransportKind;
  readonly registry: OperationRegistry;
  readonly pipelineTrace?: PipelineTrace;
};

export type DispatchResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly fault: OperationFault };
