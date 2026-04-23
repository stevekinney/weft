/**
 * Transport-neutral operation catalog and the single dispatch pipeline.
 *
 * `OperationDefinition<Input, Output>` is what every operation in the runtime
 * (workflow start, signal, update, query, schedule, subscribe, etc.) declares.
 * `executeOperation` is the only function transport adapters call to invoke an
 * operation — by going through it, REST, JSON-RPC HTTP, JSON-RPC WebSocket,
 * and the runtime stdio entrypoint all share one access check, one input
 * validation, one authorize hook, one error classifier. That is the
 * structural enforcement Track 8 design decision 2 calls for: drift between
 * transports is impossible because there is only one path.
 *
 * Pipeline order (matches plan §"Pipeline"):
 *   1. resolve operation by name → MethodNotFound on miss
 *   2. transport availability → UnsupportedTransport on miss
 *   3. access check via `evaluateAccess` → Unauthorized | Forbidden
 *   4. zod parse (shape only, .passthrough() before unknown-key policy)
 *   5. unknown-key policy enforcement (per transport)
 *   6. authorize hook (parameter-aware) → Forbidden on deny; throw → EngineFailure
 *   7. invoke
 *   8. catch + classify via `classifyEngineError`
 *   9. return { ok: true, value } | { ok: false, fault }
 *
 * The `Engine` type is intentionally a `unknown` here — transport adapters
 * pass whatever engine instance they hold, and operation `invoke` functions
 * downcast as needed. Phase 4 keeps this loose; Phase 5+ will tighten as the
 * transport adapters land.
 */

import { z } from 'zod';

import { evaluateAccess, type AccessPolicy } from './authorization.ts';
import {
  type FlattenedZodIssue,
  type OperationFault,
  type TransportKind,
} from './operation-fault.ts';
import { type Principal } from './principal.ts';

/**
 * Regex for the canonical `weft.<segment>(.<segment>)+` operation-name form.
 * Lowercase ASCII segments only; mandatory `weft.` prefix; at least one dot
 * after the prefix. The OpenRPC generator and JSON-RPC dispatcher both
 * treat this as the single source of truth for naming.
 */
const OPERATION_NAME_PATTERN = /^weft\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Throws if `name` does not match the canonical operation-name pattern. */
export function validateOperationName(name: string): void {
  if (!OPERATION_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid operation name "${name}" — must match weft.<segment>(.<segment>)+ where each segment is lowercase ASCII (e.g., "weft.workflows.start")`,
    );
  }
}

/** Non-throwing variant of `validateOperationName`. */
export function isValidOperationName(name: string): boolean {
  return OPERATION_NAME_PATTERN.test(name);
}

/**
 * Per-operation transport availability flags. A `false` entry means callers
 * on that transport receive `UnsupportedTransport`, not `MethodNotFound` —
 * the method exists, just not on this protocol.
 */
export type TransportAvailability = {
  http: boolean;
  jsonRpcHttp: boolean;
  jsonRpcWebSocket: boolean;
  jsonRpcStdio: boolean;
};

/**
 * Per-transport unknown-key disposition. Top-level only; nested object
 * unknown-key behavior is controlled by the zod schema's own `.strict` /
 * `.strip` / `.passthrough` modes.
 */
export type UnknownKeyDisposition = 'reject' | 'strip' | 'passthrough';

export type UnknownKeyPolicy = {
  http: UnknownKeyDisposition;
  jsonRpc: UnknownKeyDisposition;
};

/**
 * Result of the parameter-aware `authorize` hook.
 *
 * **`reason` is wire-visible.** When `allowed: false`, the string is sent to
 * the client in both `fault.message` and `fault.data.reason`. Hook authors
 * MUST NOT embed secrets, internal IDs, tokens, or sensitive context in the
 * reason; treat it as a public, user-facing explanation suitable for an
 * authorization-failure UI. For internal diagnostics, log separately at the
 * call site BEFORE returning the decision.
 */
export type AuthorizationDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Context passed to both the `authorize` hook and `invoke`. `input` is the
 * unknown-key-policy-applied + zod-validated param object. Both callbacks
 * receive identical context — keeping a single type makes that contract
 * explicit and forces both to evolve together if context fields are added.
 */
export type OperationContext<Input> = {
  readonly input: Input;
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: TransportKind;
};

export type OperationDefinition<Input, Output> = {
  readonly name: string;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly access: AccessPolicy;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<Input>) => Promise<AuthorizationDecision>;
  readonly invoke: (context: OperationContext<Input>) => Promise<Output>;
};

/**
 * An operation with its Input/Output type parameters erased. The `Input` is
 * `unknown` (the dispatcher only handles validated raw payloads). The
 * `OperationDefinition`'s contravariant `authorize` and `invoke` callback
 * positions are fine because the dispatcher always feeds them values that
 * match the schema-validated shape.
 */
export type ErasedOperation = OperationDefinition<unknown, unknown>;

/**
 * Read-only registry of operations keyed by name. Constructed once at server
 * startup; transport adapters look up operations by name to dispatch.
 */
export type OperationRegistry = {
  get(name: string): ErasedOperation | undefined;
  list(): ReadonlyArray<ErasedOperation>;
};

/**
 * Erased operation shape accepted by `createOperationRegistry`. Splits the
 * `Input`/`Output` type parameters per-position so assignability is sound
 * under `strictFunctionTypes`:
 *   - `inputSchema` and `outputSchema` are covariant in their `T` parameter
 *     (zod's `ZodType<T>.parse` returns `T`), so they accept the broadest
 *     type, `unknown`.
 *   - `authorize` and `invoke` are contravariant in their `Input` parameter,
 *     so they accept the narrowest type, `never`.
 * Together this lets a concrete `OperationDefinition<I, O>` produced by
 * `defineOperation` flow into the registry without per-element erasure.
 *
 * Defined as a fully-specified shape (not via `Omit`) so the assignability
 * check evaluates each field independently — an `Omit`-derived alias would
 * over-constrain via `OperationDefinition<never, unknown>`'s covariant
 * `inputSchema` slot.
 */
export type RegistrableOperation = {
  readonly name: string;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly access: AccessPolicy;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<never>) => Promise<AuthorizationDecision>;
  readonly invoke: (context: OperationContext<never>) => Promise<unknown>;
};

/**
 * Build an immutable registry. Throws on:
 *   - duplicate operation names (config bug),
 *   - operation names that violate the `weft.<segment>(.<segment>)+` form,
 *   - non-object input schemas — `inputSchema` MUST be a `z.ZodObject` so the
 *     unknown-key policy check in `executeOperation` step 5 has a defined
 *     set of top-level keys to compare against. Wrapping the object schema
 *     in `.optional()`, `.nullable()`, or transforms hides the shape from the
 *     pipeline and is rejected at registration to avoid silent misbehavior,
 *   - schemas declaring unsafe top-level shape keys (`__proto__` /
 *     `constructor` / `prototype`).
 *
 * Accepts an array of differently-typed operations. Each operation's
 * `Input`/`Output` type parameters are erased on the way into the registry —
 * the dispatcher reconstructs the right shape via the schema parse step.
 */
export function createOperationRegistry(
  operations: ReadonlyArray<RegistrableOperation>,
): OperationRegistry {
  const byName = new Map<string, ErasedOperation>();
  for (const operation of operations) {
    if (byName.has(operation.name)) {
      throw new Error(`duplicate operation name in registry: ${operation.name}`);
    }
    // Validate the name shape at registry assembly. `defineOperation` already
    // runs this check at construction, but the registry accepts any
    // `RegistrableOperation` — including ones built from object literals or
    // other sources that bypass the builder. This guarantees OpenRPC discovery
    // and JSON-RPC dispatch never see a name that violates the convention.
    validateOperationName(operation.name);
    if (!(operation.inputSchema instanceof z.ZodObject)) {
      throw new Error(
        `operation "${operation.name}" inputSchema must be a z.ZodObject (got ${operation.inputSchema.constructor.name}); wrappers like .optional() / transforms hide the top-level shape from the unknown-key policy check`,
      );
    }
    // Declared shape keys named `__proto__` / `constructor` / `prototype`
    // bypass the runtime UNSAFE_PROTOTYPE_KEYS filter (which only inspects
    // unknown keys) and would land on the input object as legitimate
    // properties. Reject them at registration so the schema author cannot
    // accidentally open a prototype-pollution vector via the declared shape.
    const declaredKeys = Object.keys(operation.inputSchema.shape);
    const unsafeDeclared = declaredKeys.filter((key) => UNSAFE_PROTOTYPE_KEYS.has(key));
    if (unsafeDeclared.length > 0) {
      throw new Error(
        `operation "${operation.name}" inputSchema declares unsafe top-level keys: ${unsafeDeclared.join(', ')}. Names that match a prototype-pollution vector (__proto__, constructor, prototype) are forbidden as schema keys.`,
      );
    }
    // Freeze the operation AND each load-bearing nested policy object so
    // the caller's references cannot be mutated post-registration. Without
    // the inner freezes, `Object.freeze({ ...operation })` is shallow:
    // a caller that did `const transports = { http: true, ... }` then
    // `defineOperation({ transports })` and later `transports.http = false`
    // would silently change the registered operation's behavior because
    // the spread aliases the same nested objects. `access`, `transports`,
    // and `unknownKeyPolicy` all flow into authorization / dispatch
    // decisions, so this aliasing path is a logic-corruption risk.
    //
    // Type-erasure cast: `RegistrableOperation`'s callbacks accept
    // `OperationContext<never>` (variance trick to admit any concrete
    // `Input` typing), but storage uses `ErasedOperation`
    // (`OperationDefinition<unknown, unknown>`) so the dispatcher can
    // iterate uniformly. The runtime invariant — each operation only
    // receives inputs validated by its own schema — is preserved.
    byName.set(
      operation.name,
      Object.freeze({
        ...operation,
        tags: Object.freeze([...operation.tags]),
        access: Object.freeze({ ...operation.access }),
        transports: Object.freeze({ ...operation.transports }),
        unknownKeyPolicy: Object.freeze({ ...operation.unknownKeyPolicy }),
      }) as ErasedOperation,
    );
  }
  const ordered = Object.freeze([...byName.values()]);
  return {
    get(name) {
      return byName.get(name);
    },
    list() {
      return ordered;
    },
  };
}

export type DispatchContext = {
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: TransportKind;
  readonly registry: OperationRegistry;
};

export type DispatchResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly fault: OperationFault };

/**
 * Single dispatch pipeline. Every transport calls this — there is no other
 * path to an operation invocation. Returns a typed `DispatchResult` instead
 * of throwing for expected control flow; uncaught exceptions inside `invoke`
 * are caught and classified into `EngineFailure`.
 */
export async function executeOperation<Output>(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<Output>> {
  // Step 1: resolve.
  const operation = context.registry.get(operationName);
  if (operation === undefined) {
    return failure({
      code: 'MethodNotFound',
      message: `unknown operation: ${operationName}`,
      data: { method: operationName },
    });
  }

  // Step 2: transport availability.
  if (!operation.transports[transportToAvailabilityKey(context.transport)]) {
    const supported = SUPPORTED_TRANSPORTS.filter(
      (t) => operation.transports[transportToAvailabilityKey(t)],
    );
    return failure({
      code: 'UnsupportedTransport',
      message: `operation "${operationName}" does not support transport "${context.transport}"`,
      data: { transport: context.transport, supported },
    });
  }

  // Step 3: access check.
  const access = evaluateAccess(operation.access, context.principal);
  if (!access.allowed) {
    if (access.classification === 'unauthorized') {
      return failure({
        code: 'Unauthorized',
        message: access.reason,
        data: { reason: access.reason },
      });
    }
    return failure({
      code: 'Forbidden',
      message: access.reason,
      data: { reason: access.reason },
    });
  }

  // Steps 4 + 5: unknown-key policy + zod parse, extracted for complexity.
  const parseOutcome = parseAndApplyUnknownKeyPolicy(
    operation,
    rawInput,
    transportToPolicyKey(context.transport),
  );
  if (parseOutcome.kind === 'failure') return failure(parseOutcome.fault);
  const input = parseOutcome.input;

  // Step 6: authorize hook.
  if (operation.authorize !== undefined) {
    let decision: unknown;
    try {
      decision = await operation.authorize({
        input,
        principal: context.principal,
        engine: context.engine,
        transport: context.transport,
      });
    } catch {
      // Hook threw — classify as EngineFailure so we never leak the hook's
      // error message to the wire (might contain DB queries, secrets, etc.).
      // The transport adapter's logger logs the original error server-side.
      return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
    }
    if (!isAuthorizationDecision(decision)) {
      // Hook returned a malformed value (undefined, wrong shape). Treat as
      // an internal contract violation — never construct a wire fault from
      // attacker-controlled or buggy intermediate state.
      return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
    }
    if (!decision.allowed) {
      return failure({
        code: 'Forbidden',
        message: decision.reason,
        data: { reason: decision.reason },
      });
    }
  }

  // Step 7 + 7b: invoke + output validation. Step 8 lives in the catch arm.
  let output: unknown;
  try {
    output = await operation.invoke({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch (error) {
    return failure(classifyEngineError(error));
  }
  return validateAndReturnOutput<Output>(operation.outputSchema, output);
}

/**
 * Input parsing stage: apply the catalog's top-level unknown-key policy,
 * run the schema's `safeParse`, and re-attach passthrough extras onto a
 * prototype-safe null-prototype object.
 */
function parseAndApplyUnknownKeyPolicy(
  operation: ErasedOperation,
  rawInput: unknown,
  policyKey: keyof UnknownKeyPolicy,
): { kind: 'ok'; input: unknown } | { kind: 'failure'; fault: OperationFault } {
  const policy = operation.unknownKeyPolicy[policyKey];

  // The registry asserts inputSchema is a `z.ZodObject` at construction
  // time, but a defensive try/catch keeps any future relaxation of that
  // invariant from leaking an uncaught error to the transport edge.
  let knownKeys: ReadonlySet<string>;
  try {
    knownKeys = extractTopLevelObjectKeys(operation.inputSchema);
  } catch {
    return {
      kind: 'failure',
      fault: { code: 'EngineFailure', message: 'internal error', data: {} },
    };
  }

  let preParseInput: unknown = rawInput;
  let passthroughExtras: ReadonlyArray<readonly [string, unknown]> = [];

  // Arrays satisfy `typeof === 'object'` but are not the `params` shape this
  // pipeline supports — fall straight through to `safeParse` so the schema
  // produces a clean shape error instead of pretending each numeric index
  // is an "unrecognized top-level key" or coercing the array to an object.
  const isPlainObject =
    rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput);

  if (isPlainObject) {
    const unknownTopLevel = Object.keys(rawInput as Record<string, unknown>).filter(
      (key) => !knownKeys.has(key),
    );
    if (unknownTopLevel.length > 0) {
      if (policy === 'reject') {
        return {
          kind: 'failure',
          fault: {
            code: 'InvalidParams',
            message: 'unrecognized top-level keys',
            data: {
              issues: [
                {
                  path: [],
                  message: `unrecognized top-level keys: ${unknownTopLevel.join(', ')}`,
                  code: 'unrecognized_keys',
                },
              ],
            },
          },
        };
      }
      // For BOTH `strip` and `passthrough` policies, we hand only the known
      // top-level keys to the schema. If we let unknown keys reach
      // `safeParse`, a schema declared `.strict()` would reject them and
      // override the catalog's policy — making the catalog non-authoritative.
      // The catalog's policy MUST win at the top level, so we strip first
      // (always) and re-attach passthrough extras after the parse succeeds.
      // `__proto__` / `prototype` / `constructor` are filtered by
      // `sanitizeTopLevel`, so the prototype chain cannot be polluted via
      // passthrough re-attachment.
      const sanitized = sanitizeTopLevel(rawInput as Record<string, unknown>, knownKeys);
      preParseInput = sanitized;
      if (policy === 'passthrough') {
        const rawRecord = rawInput as Record<string, unknown>;
        passthroughExtras = unknownTopLevel
          .filter((key) => !UNSAFE_PROTOTYPE_KEYS.has(key))
          .map((key) => [key, rawRecord[key]] as const);
      }
    }
  }

  let parseResult: ReturnType<typeof operation.inputSchema.safeParse>;
  try {
    parseResult = operation.inputSchema.safeParse(preParseInput);
  } catch {
    // A zod refinement/transform threw arbitrary exception — never leak.
    return {
      kind: 'failure',
      fault: { code: 'EngineFailure', message: 'internal error', data: {} },
    };
  }
  if (!parseResult.success) {
    return {
      kind: 'failure',
      fault: {
        code: 'InvalidParams',
        message: 'invalid params',
        data: { issues: flattenZodIssues(parseResult.error.issues) },
      },
    };
  }

  const parsed = parseResult.data as Record<string, unknown>;
  // For non-passthrough policies, return zod's parsed output directly —
  // its prototype chain is `Object.prototype`, which is what `invoke`
  // implementations expect.
  if (policy !== 'passthrough') return { kind: 'ok', input: parsed };

  // For `passthrough`, ALWAYS rebuild on a null-prototype object — even
  // when there are no extras to re-attach. This keeps the shape of
  // `input` consistent across calls to the same operation: `invoke`
  // implementations under `passthrough` policy can rely on a stable
  // null-prototype container regardless of whether the caller sent
  // extras. Without this, an operation that uses `input.hasOwnProperty`
  // would intermittently fail when extras happened to be present.
  const merged: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (UNSAFE_PROTOTYPE_KEYS.has(key)) continue;
    merged[key] = value;
  }
  // Parsed output wins over passthrough extras when names collide. The
  // registry rejects pipes/transforms at construction time, so this can
  // only happen if a future relaxation allows them — but the precedence
  // matters either way: the parse is the source of truth for known keys.
  for (const [key, value] of passthroughExtras) {
    if (key in merged) continue;
    merged[key] = value;
  }
  return { kind: 'ok', input: merged };
}

/**
 * Output validation stage: run the declared `outputSchema` against the
 * operation's return value. A mismatch is an internal contract violation
 * (the operation author's bug) and becomes `EngineFailure` — never the
 * original output, which might contain secret fields the schema forbids.
 */
function validateAndReturnOutput<Output>(
  outputSchema: z.ZodType,
  output: unknown,
): DispatchResult<Output> {
  let outputParse: ReturnType<typeof outputSchema.safeParse>;
  try {
    outputParse = outputSchema.safeParse(output);
  } catch {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!outputParse.success) {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  return { ok: true, value: outputParse.data as Output };
}

const SUPPORTED_TRANSPORTS: ReadonlyArray<TransportKind> = [
  'http-rest',
  'jsonRpcHttp',
  'jsonRpcWebSocket',
  'jsonRpcStdio',
];

function transportToPolicyKey(transport: TransportKind): keyof UnknownKeyPolicy {
  return transport === 'http-rest' ? 'http' : 'jsonRpc';
}

function transportToAvailabilityKey(transport: TransportKind): keyof TransportAvailability {
  switch (transport) {
    case 'http-rest':
      return 'http';
    case 'jsonRpcHttp':
      return 'jsonRpcHttp';
    case 'jsonRpcWebSocket':
      return 'jsonRpcWebSocket';
    case 'jsonRpcStdio':
      return 'jsonRpcStdio';
  }
}

/**
 * Extract the top-level keys of an object schema. The registry validates at
 * construction time that every `inputSchema` is a `z.ZodObject`, so this
 * function is total — it never returns `undefined` in production. The
 * narrow `instanceof` check here is belt-and-suspenders and produces a
 * loud error if the registry validation is ever bypassed.
 */
function extractTopLevelObjectKeys(schema: z.ZodType): ReadonlySet<string> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      'extractTopLevelObjectKeys called with a non-object schema — the operation registry should have rejected this at construction',
    );
  }
  // Filter unsafe prototype keys defensively. A schema author cannot name a
  // field `__proto__` / `prototype` / `constructor` as the top-level
  // unknown-key policy would treat them as known and bypass the
  // prototype-pollution guard in `sanitizeTopLevel`.
  return new Set(Object.keys(schema.shape).filter((key) => !UNSAFE_PROTOTYPE_KEYS.has(key)));
}

/**
 * Build a prototype-safe shallow projection of `rawInput` containing only
 * keys present in `knownKeys`. Names matching `__proto__` / `prototype` /
 * `constructor` are filtered out even if they appear in `knownKeys` (the
 * registry already rejects schemas declaring those names, but the filter
 * is defense in depth).
 *
 * Uses `Object.create(null)` for a null-prototype container — even if an
 * unsafe key name somehow slipped past the filter, it would be set as an
 * own property without mutating the prototype chain.
 *
 * Passthrough extras are NOT handled here. The caller computes them
 * separately from `rawInput` (post-parse) and merges them after the
 * schema parse succeeds, so they are never fed to `safeParse`.
 */
function sanitizeTopLevel(
  rawInput: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(rawInput)) {
    if (UNSAFE_PROTOTYPE_KEYS.has(key)) continue;
    if (knownKeys.has(key)) {
      out[key] = rawInput[key];
    }
  }
  return out;
}

const UNSAFE_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * Total runtime guard for `AuthorizationDecision`. A buggy or malicious
 * authorize hook can return `undefined`, the wrong shape, or values whose
 * property accesses throw. Misshaped returns are rejected — the pipeline
 * surfaces an `EngineFailure` rather than constructing a wire fault from
 * untrusted intermediate state.
 */
function isAuthorizationDecision(value: unknown): value is AuthorizationDecision {
  if (typeof value !== 'object' || value === null) return false;
  let allowed: unknown;
  try {
    allowed = (value as { allowed?: unknown }).allowed;
  } catch {
    return false;
  }
  if (allowed === true) return true;
  if (allowed !== false) return false;
  let reason: unknown;
  try {
    reason = (value as { reason?: unknown }).reason;
  } catch {
    return false;
  }
  return typeof reason === 'string';
}

function flattenZodIssues(
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code: string;
  }>,
): ReadonlyArray<FlattenedZodIssue> {
  return issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'string' || typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Translate a thrown value from `invoke` into a transport-neutral
 * OperationFault.
 *
 * Routing rules:
 *   - A pre-shaped OperationFault passes through unchanged. Operation
 *     authors are trusted to construct safe faults (this is the documented
 *     way to surface a typed failure from `invoke`).
 *   - Errors whose message contains "not found", "already exists", or
 *     "timeout"/"timed out" are routed to the corresponding FaultCode with
 *     a GENERIC public message. The original `error.message` is NOT
 *     propagated to the wire — it might contain secrets, full SQL, file
 *     paths, etc. Server-side logging should happen at the transport edge
 *     where the original error is still in scope.
 *   - Everything else maps to EngineFailure with "internal error".
 */
export function classifyEngineError(error: unknown): OperationFault {
  if (isOperationFault(error)) {
    return error;
  }
  if (error instanceof Error) {
    // Guard against an `Error` subclass that overrides `message` with a
    // throwing getter (e.g. via `Object.defineProperty`) — without this
    // try/catch the throw escapes `executeOperation`, breaking its
    // contract of always returning a `DispatchResult`.
    let rawMessage: unknown;
    try {
      rawMessage = error.message;
    } catch {
      return { code: 'EngineFailure', message: 'internal error', data: {} };
    }
    if (typeof rawMessage !== 'string') {
      return { code: 'EngineFailure', message: 'internal error', data: {} };
    }
    const message = rawMessage.toLowerCase();
    if (message.includes('not found')) {
      return {
        code: 'NotFound',
        message: 'not found',
        data: { resource: 'unknown' },
      };
    }
    if (message.includes('already exists')) {
      return {
        code: 'Conflict',
        message: 'conflict',
        data: { reason: 'resource already exists' },
      };
    }
    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        code: 'Timeout',
        message: 'operation timed out',
        data: {},
      };
    }
  }
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

// `Record<FaultCode, true>` enforces exhaustiveness at compile time: adding a
// new `FaultCode` to the union in operation-fault.ts forces a corresponding
// entry here. A plain `satisfies ReadonlyArray<...>` only validates each
// existing element, not completeness, so a new code would compile silently
// and `isOperationFault` would then reject otherwise-valid faults.
const FAULT_CODES = {
  Unauthorized: true,
  Forbidden: true,
  NotFound: true,
  Conflict: true,
  Unprocessable: true,
  Timeout: true,
  RateLimited: true,
  NotImplemented: true,
  UnsupportedTransport: true,
  SubscriptionOverflow: true,
  InvalidParams: true,
  MethodNotFound: true,
  EngineFailure: true,
} as const satisfies Readonly<Record<OperationFault['code'], true>>;

/**
 * Total runtime guard for `OperationFault`. A thrown value that LOOKS like
 * a fault can pass through unchanged into transport serializers, so this
 * guard must reject anything malformed rather than letting a partially-
 * shaped object reach the wire.
 *
 * - Property reads are wrapped in try/catch so a thrown value with a
 *   poisoned getter (Proxy, throwing accessor) cannot escape `executeOperation`.
 * - `data` MUST be a non-null object — every fault variant in the union
 *   carries a `data` field (NotImplemented and EngineFailure use `{}`),
 *   and downstream serializers always destructure it.
 */
function isOperationFault(value: unknown): value is OperationFault {
  if (typeof value !== 'object' || value === null) return false;
  let code: unknown;
  let message: unknown;
  let data: unknown;
  try {
    code = (value as { code?: unknown }).code;
    message = (value as { message?: unknown }).message;
    data = (value as { data?: unknown }).data;
  } catch {
    return false;
  }
  return (
    typeof code === 'string' &&
    typeof message === 'string' &&
    typeof data === 'object' &&
    data !== null &&
    // Every `OperationFault` variant declares `data` as a plain object
    // (or `{}`). Arrays satisfy `typeof === 'object'` but downstream
    // serializers destructure `data.issues`, `data.transport`, etc. and
    // would crash on an array shape. Reject arrays here so a thrown
    // value like `{ code: 'InvalidParams', message: 'x', data: [] }`
    // falls through to `EngineFailure` instead of reaching the wire.
    !Array.isArray(data) &&
    Object.hasOwn(FAULT_CODES, code)
  );
}

function failure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
