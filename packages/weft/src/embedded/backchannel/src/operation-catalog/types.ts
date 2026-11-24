import { z } from 'zod';
import type { OperationHostFactory, OperationInterceptor } from './operation-interceptors.ts';

import type { AccessPolicy } from '../authorization.ts';
import type { FaultCode } from '../fault-code.ts';
import type { OperationFault, TransportKind } from '../operation-fault.ts';
import type { Principal } from '../principal.ts';

/**
 * Regex for the canonical `<namespace>.<segment>(.<segment>)*` operation-name
 * form: at least two dot-separated segments, each starting with a lowercase
 * ASCII letter and continuing with lowercase ASCII letters or digits.
 *
 * THE NAMESPACE IS NO LONGER FIXED TO `weft`. It was, and every operation this
 * package defines still begins with `weft.` — the change is backward
 * compatible, because the old pattern's language is a strict subset of this
 * one. What it admits is a catalog shared with other packages: a gateway that
 * serves `@lostgradient/operative` and `@lostgradient/bureau` alongside Weft needs
 * `operative.*` and `bureau.*` to be legal names, and those packages already
 * depend on this one, so registering through this catalog is the path that
 * keeps one dispatch pipeline, one transport matrix, and one AsyncAPI document
 * rather than a second RPC dialect beside them.
 *
 * The two-segment minimum is retained deliberately: a bare `start` carries no
 * owner, and an unnamespaced catalog is one collision away from ambiguity
 * about which package answers a method.
 *
 * `rpc.` IS RESERVED, and the negative lookahead is what keeps a guarantee the
 * mandatory `weft.` prefix used to provide for free. JSON-RPC 2.0 reserves
 * every method name beginning with `rpc.` for rpc-internal methods and
 * extensions, and this server answers `rpc.discover` itself. Under a pattern
 * that admitted any namespace, a registered `rpc.discover` would shadow
 * discovery, and the only thing standing between that and a served catalog
 * would be the OpenRPC generator's deduplication guard — a backstop rather
 * than an impossibility. `openrpc-regressions.test.ts` pins this.
 */
export const OPERATION_NAME_PATTERN = /^(?!rpc\.)[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Throws if `name` does not match the canonical operation-name pattern. */
export function validateOperationName(name: string): void {
  if (!OPERATION_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid operation name "${name}" — must match <namespace>.<segment>(.<segment>)* where each segment starts with a lowercase ASCII letter and may contain lowercase ASCII letters or digits (e.g., "weft.workflows.start", "operative.runs.list2")`,
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
  /** Whether REST and Server-Sent Events serve the operation. */
  http: boolean;
  /** Whether JSON-RPC over HTTP serves the operation. */
  jsonRpcHttp: boolean;
  /** Whether JSON-RPC over WebSocket serves the operation. */
  jsonRpcWebSocket: boolean;
  /** Whether JSON-RPC over stdio serves the operation. */
  jsonRpcStdio: boolean;
};

/**
 * Per-transport unknown-key disposition. Top-level only; nested object
 * behavior is controlled by the zod schema's own object mode.
 */
export type UnknownKeyDisposition = 'reject' | 'strip' | 'passthrough';

/** How each transport treats input keys the operation's schema does not declare. */
export type UnknownKeyPolicy = {
  /** What REST does with an undeclared top-level key. */
  http: UnknownKeyDisposition;
  /** What JSON-RPC does with an undeclared top-level key. */
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
  /** Internal lifecycle key used by transports; independent from the public envelope. */
  readonly subscriptionId: string;
  /** What the operation answers with before its events. */
  readonly envelope: Envelope;
  /** The events, in order. */
  readonly iterable: AsyncIterable<Element>;
  /** Ends the subscription and releases what it holds. */
  readonly close: () => Promise<void>;
};

/**
 * Envelope acknowledging that a JSON-RPC subscription has started. This is
 * the protocol-level shape the built-in JSON-RPC WebSocket subscriptions
 * (`weft.workflows.events` and the fleet-events subscription in
 * `json-rpc-websocket.ts`) use for their own `outputSchema`/envelope — it is
 * NOT the general contract for every `kind: 'subscription'` operation.
 * `executeSubscription` in `stream-pipeline.ts` returns an erased envelope
 * precisely because a catalog subscription can declare any envelope shape its
 * own `outputSchema` validates; other subscription operations are free to use a different shape (see the
 * `subscriptionId`-only regression case in
 * `operation-catalog/dispatch-audit.test.ts`).
 */
export type SubscriptionStartEnvelope = {
  readonly subscriptionId: string;
  readonly cursor: string;
};

export type OperationInvocationResult<Output, Element = unknown> =
  Output | StreamOperationInvocation<Element> | SubscriptionOperationInvocation<Element, Output>;

/**
 * Metadata that connects an operation-catalog entry to a live, engine-served
 * MCP workflow tool. The exact MCP tool name is resolved from the live engine
 * registry during discovery because `tools/list` owns collision handling.
 *
 * An `mcpExposable` operation without it is served as an MCP tool of its own
 * name by dispatch through the catalog pipeline, by `createOperationMcpMount`.
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
export type AuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      classification?: 'unauthorized' | 'forbidden';
      reason: string;
    };

/** A hint that an operation's required scope depends on one of its input fields. */
export type ParameterizedAccessHint = {
  /** The input field that selects the variant. */
  readonly discriminator: string;
  /** The variant used when the input omits the field. */
  readonly defaultValue?: string;
  /** The values the field can take, each with its own access. */
  readonly variants: ReadonlyArray<{
    readonly value: string;
    readonly access: AccessPolicy;
  }>;
};

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
export type OperationContext<Input, Host = unknown> = {
  /** The parsed, validated input. */
  readonly input: Input;
  /** The authenticated caller. */
  readonly principal: Principal;
  /**
   * Whatever the transport host registered these operations against. Weft's
   * own handlers deliver the `Engine`; another package's handler delivers its
   * own host object. An operation declares the shape it needs through `Host`,
   * so a host that cannot supply it is a compile error at registration.
   */
  readonly host: Host;
  /** The transport the call arrived on. */
  readonly transport: TransportKind;
  /**
   * The abort signal of the request that carried this call, when its transport has one: an HTTP
   * transport (JSON-RPC over HTTP and the REST routes) passes the `Request`'s own signal, which
   * aborts when the client goes away. Absent on a transport with no request of its own (the
   * WebSocket and stdio JSON-RPC transports, MCP). The operation decides what an abort means for
   * it; the pipeline neither checks it nor changes how a result or a fault is answered.
   */
  readonly signal?: AbortSignal;
};

/**
 * Common operation fields shared by unary, stream, and subscription kinds.
 * The discriminated union below adds `kind` and `eventSchema` per kind.
 */
export type OperationDefinitionBase<
  Input,
  InvokeOutput,
  SchemaOutput = InvokeOutput,
  Host = unknown,
> = {
  readonly name: string;
  readonly mcpExposable: boolean;
  readonly mcpTool?: McpToolMetadata;
  readonly summary: string;
  /**
   * Optional longer-form prose describing what the operation does, its key
   * inputs, and notable faults or preconditions. `summary` stays the short
   * one-liner; `description` is the paragraph that surfaces in OpenAPI /
   * OpenRPC operation descriptions, the CLI `weft api --describe` view, and
   * MCP-facing discovery metadata. Optional: only the interactively-used
   * subset of operations populate it. `summary` remains mandatory for all.
   */
  readonly description?: string;
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
  readonly outputSchema: z.ZodType<SchemaOutput>;
  readonly access: AccessPolicy;
  readonly parameterizedAccess?: ParameterizedAccessHint;
  /** Fault codes this operation can raise in addition to universal pipeline defaults. */
  readonly producibleFaults?: ReadonlyArray<FaultCode>;
  /** Whether non-public operations should appear in generated discovery documents. */
  readonly discoverable?: boolean;
  /**
   * Whether the operation takes a boolean `dryRun` input: with it `true`, the operation performs
   * its authorization and validation, writes nothing, and answers what the call would do instead
   * of doing it. Absent or `false` means the input has no such field. A destructive operation a
   * caller may want to preview declares this, and its input schema carries the `dryRun` field.
   */
  readonly supportsDryRun?: boolean;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<Input, Host>) => Promise<AuthorizationDecision>;
};

/** Metadata and schema hooks shared by typed authoring and dispatch stages. */
export type OperationMetadata<
  Input,
  SchemaOutput = unknown,
  Host = unknown,
> = OperationDefinitionBase<Input, unknown, SchemaOutput, Host>;

/**
 * Unary (request/response) operation. `kind` may be omitted (defaults to
 * `'unary'`). `eventSchema` MUST be absent — a unary operation has no
 * per-element shape to validate. The `eventSchema?: never` constraint
 * enforces this at the type level: passing `eventSchema` to a unary
 * operation is a TypeScript error, not a silent runtime mismatch.
 */
type UnaryOperationDefinition<
  Input,
  InvokeOutput,
  SchemaOutput = InvokeOutput,
  Host = unknown,
> = OperationDefinitionBase<Input, InvokeOutput, SchemaOutput, Host> & {
  readonly kind?: 'unary';
  readonly eventSchema?: never;
  readonly invoke: (context: OperationContext<Input, Host>) => Promise<InvokeOutput>;
};

/**
 * Streaming operation (e.g. SSE). `kind: 'stream'` is required and
 * `eventSchema` MUST be present — the dispatcher validates each yielded
 * element against this schema. Without it the streaming pipeline would
 * have no contract to validate per-element output against, which would
 * silently leak un-validated data to consumers.
 */
type StreamOperationDefinition<
  Input,
  InvokeOutput,
  SchemaOutput,
  InvokeElement,
  Element,
  Host = unknown,
> = OperationDefinitionBase<Input, InvokeOutput, SchemaOutput, Host> & {
  readonly kind: 'stream';
  readonly eventSchema: z.ZodType<Element>;
  readonly invoke: (
    context: OperationContext<Input, Host>,
  ) => Promise<InvokeOutput | StreamOperationInvocation<InvokeElement>>;
};

/**
 * WebSocket subscription operation. `kind: 'subscription'` is required and
 * `eventSchema` MUST be present (validates each delivered envelope). Same
 * rationale as `StreamOperationDefinition` — the type forbids declaring a
 * subscription without its element schema.
 */
type SubscriptionOperationDefinition<
  Input,
  InvokeOutput,
  SchemaOutput,
  InvokeElement,
  Element,
  Host = unknown,
> = OperationDefinitionBase<Input, InvokeOutput, SchemaOutput, Host> & {
  readonly kind: 'subscription';
  readonly eventSchema: z.ZodType<Element>;
  readonly invoke: (
    context: OperationContext<Input, Host>,
  ) => Promise<SubscriptionOperationInvocation<InvokeElement, InvokeOutput>>;
};

/**
 * Discriminated union over the three operation kinds. The discriminator
 * (`kind`) determines whether `eventSchema` is required (`'stream'` /
 * `'subscription'`) or forbidden (`'unary'` or absent). Streaming
 * operations declared without `eventSchema` are now a TypeScript error
 * rather than a runtime EngineFailure; unary operations cannot
 * accidentally carry an `eventSchema` that the pipeline would never read.
 */
export type OperationDefinition<
  Input,
  InvokeOutput,
  SchemaOutput = InvokeOutput,
  InvokeElement = unknown,
  Element = InvokeElement,
  Host = unknown,
> =
  | UnaryOperationDefinition<Input, InvokeOutput, SchemaOutput, Host>
  | StreamOperationDefinition<Input, InvokeOutput, SchemaOutput, InvokeElement, Element, Host>
  | SubscriptionOperationDefinition<
      Input,
      InvokeOutput,
      SchemaOutput,
      InvokeElement,
      Element,
      Host
    >;

/**
 * An operation with its Input/Output type parameters erased. The dispatcher
 * only feeds values that have been validated by the operation's own schema.
 */
/**
 * Registry-facing operation metadata. Invocation stays behind the schema-owned
 * dispatch function so an erased registry entry can never be called with an
 * invented input type.
 */
export type ErasedOperation = RegistrableOperation;

/** Read-only registry of operations keyed by name. */
export type OperationRegistry = {
  /** The operation with the given name, if any. */
  get(name: string): ErasedOperation | undefined;
  /** Every registered operation. */
  list(): ReadonlyArray<ErasedOperation>;
};

/**
 * Erased operation shape accepted by `createOperationRegistry`. Mirrors
 * the discriminated union on `OperationDefinition` so registry callers
 * declaring a stream/subscription without `eventSchema` get a compile-time
 * error rather than a runtime `EngineFailure` when the pipeline first
 * attempts per-element validation.
 */
type RegistrableOperationBase<Host> = {
  readonly name: string;
  readonly mcpExposable: boolean;
  readonly mcpTool?: McpToolMetadata;
  readonly summary: string;
  /** See {@link OperationDefinitionBase.description}. Optional longer-form prose. */
  readonly description?: string;
  readonly tags: ReadonlyArray<string>;
  /** See {@link OperationDefinitionBase.destructive}. Required, no default. */
  readonly destructive: boolean;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly access: AccessPolicy;
  readonly parameterizedAccess?: ParameterizedAccessHint;
  /** Fault codes this operation can raise in addition to universal pipeline defaults. */
  readonly producibleFaults?: ReadonlyArray<FaultCode>;
  /** Whether non-public operations should appear in generated discovery documents. */
  readonly discoverable?: boolean;
  /** See {@link OperationDefinitionBase.supportsDryRun}. */
  readonly supportsDryRun?: boolean;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly dispatch: (
    rawInput: unknown,
    context: DispatchContext<Host>,
  ) => Promise<DispatchResult<unknown>>;
};

type UnaryRegistrableOperation<Host> = RegistrableOperationBase<Host> & {
  readonly kind?: 'unary';
  readonly eventSchema?: never;
};

type StreamRegistrableOperation<Host> = RegistrableOperationBase<Host> & {
  readonly kind: 'stream';
  readonly eventSchema: z.ZodType;
};

type SubscriptionRegistrableOperation<Host> = RegistrableOperationBase<Host> & {
  readonly kind: 'subscription';
  readonly eventSchema: z.ZodType;
};

/** An operation the registry can hold, of any kind. */
export type RegistrableOperation<Host = unknown> =
  | UnaryRegistrableOperation<Host>
  | StreamRegistrableOperation<Host>
  | SubscriptionRegistrableOperation<Host>;

/**
 * What the host that owns a registry decides about the faults its operations throw. The generic
 * dispatch code reads no environment variable and names no engine error class: it asks this.
 */
export type FaultPolicy = {
  /**
   * Whether a thrown `OperationFault` whose code is neither declared in the operation's
   * `producibleFaults` nor a universal default answers `EngineFailure` (strict) or passes
   * through with a warning. A function is read on every undeclared fault, so a host can follow
   * a setting that changes while the registry lives. Omitted, strict: a host that supplies
   * nothing never lets an undeclared fault through silently.
   */
  readonly strict?: boolean | (() => boolean);
  /**
   * Classifies a thrown value the dispatch code does not recognise (anything that is not an
   * `OperationFault`), such as the host's own error classes. Return `undefined` to leave it to
   * the generic message heuristics.
   */
  readonly classifyError?: (error: unknown) => OperationFault | undefined;
  /**
   * Whether a string is one of the host's fine-grained error codes. A fault's `data.weftCode`
   * reaches a REST body only when this accepts it; omitted, every string passes.
   */
  readonly isKnownErrorCode?: (value: string) => boolean;
};

export type DispatchContext<Host = unknown> = {
  readonly principal: Principal;
  /** The registry's {@link FaultPolicy}, which `createOperationRegistry` puts on every dispatch. */
  readonly faultPolicy?: FaultPolicy;
  /** See {@link OperationContext.host}. */
  readonly host: Host | OperationHostFactory<Host>;
  readonly interceptors?: readonly OperationInterceptor[];
  readonly transport: TransportKind;
  readonly registry: OperationRegistry;
  readonly pipelineTrace?: PipelineTrace;
  /** See {@link OperationContext.signal}: copied into the context `authorize` and `invoke` read. */
  readonly signal?: AbortSignal;
};

/** The outcome of dispatching one operation: its value, or the {@link OperationFault} that stopped it. */
export type DispatchResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly fault: OperationFault };
