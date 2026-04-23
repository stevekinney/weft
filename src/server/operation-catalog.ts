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
 * Context passed to the `authorize` hook. `input` is the validated and
 * unknown-key-policy-applied param object, identical to what `invoke` will
 * receive.
 */
export type AuthorizationContext<Input> = {
  readonly input: Input;
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: TransportKind;
};

export type InvocationContext<Input> = {
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
  readonly authorize?: (context: AuthorizationContext<Input>) => Promise<AuthorizationDecision>;
  readonly invoke: (context: InvocationContext<Input>) => Promise<Output>;
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
 * Build an immutable registry. Throws on:
 *   - duplicate operation names (config bug),
 *   - non-object input schemas — `inputSchema` MUST be a `z.ZodObject` so the
 *     unknown-key policy check in `executeOperation` step 5 has a defined
 *     set of top-level keys to compare against. Wrapping the object schema
 *     in `.optional()`, `.nullable()`, or transforms hides the shape from the
 *     pipeline and is rejected at registration to avoid silent misbehavior.
 *
 * Accepts an array of differently-typed operations. Each operation's
 * `Input`/`Output` type parameters are erased on the way into the registry —
 * the dispatcher reconstructs the right shape via the schema parse step.
 * The cast at storage is type-erasure only: the `OperationDefinition`
 * structure is identical for every type-parameterization, only the variance
 * of the contravariant `Input` position prevents direct assignability under
 * `exactOptionalPropertyTypes`.
 */
export function createOperationRegistry(
  operations: ReadonlyArray<ErasedOperation>,
): OperationRegistry {
  const byName = new Map<string, ErasedOperation>();
  for (const operation of operations) {
    if (byName.has(operation.name)) {
      throw new Error(`duplicate operation name in registry: ${operation.name}`);
    }
    if (!(operation.inputSchema instanceof z.ZodObject)) {
      throw new Error(
        `operation "${operation.name}" inputSchema must be a z.ZodObject (got ${operation.inputSchema.constructor.name}); wrappers like .optional() / transforms hide the top-level shape from the unknown-key policy check`,
      );
    }
    byName.set(operation.name, operation);
  }
  const ordered = [...operations];
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

  // Step 4: zod parse (shape only).
  const parseResult = operation.inputSchema.safeParse(rawInput);
  if (!parseResult.success) {
    return failure({
      code: 'InvalidParams',
      message: 'invalid params',
      data: { issues: flattenZodIssues(parseResult.error.issues) },
    });
  }
  const parsedInput = parseResult.data as Record<string, unknown>;

  // Step 5: unknown-key policy. Top-level only — nested unknown-key behavior
  // is enforced by the zod schema in step 4. The registry guarantees
  // inputSchema is a z.ZodObject, so knownKeys is always defined.
  const policy = operation.unknownKeyPolicy[transportToPolicyKey(context.transport)];
  const knownKeys = extractTopLevelObjectKeys(operation.inputSchema);
  if (rawInput !== null && typeof rawInput === 'object') {
    const incomingKeys = Object.keys(rawInput as Record<string, unknown>);
    const unknown = incomingKeys.filter((key) => !knownKeys.has(key));
    if (unknown.length > 0) {
      if (policy === 'reject') {
        return failure({
          code: 'InvalidParams',
          message: 'unrecognized top-level keys',
          data: {
            issues: [
              {
                path: [],
                message: `unrecognized top-level keys: ${unknown.join(', ')}`,
                code: 'unrecognized_keys',
              },
            ],
          },
        });
      }
      if (policy === 'passthrough') {
        // Re-attach the unknown keys (zod's default for passthrough already
        // includes them, but we explicitly preserve them here for clarity).
        for (const key of unknown) {
          parsedInput[key] = (rawInput as Record<string, unknown>)[key];
        }
      }
      // 'strip' is the implicit zod default — nothing to do; unknown keys
      // were already dropped by safeParse.
    }
  }

  // Cast: at this point parsedInput conforms to Input by construction.
  const input = parsedInput as Parameters<typeof operation.invoke>[0]['input'];

  // Step 6: authorize hook.
  if (operation.authorize !== undefined) {
    let decision: AuthorizationDecision;
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
      return failure({
        code: 'EngineFailure',
        message: 'internal error',
        data: {},
      });
    }
    if (!decision.allowed) {
      return failure({
        code: 'Forbidden',
        message: decision.reason,
        data: { reason: decision.reason },
      });
    }
  }

  // Step 7: invoke. Step 8 lives in the catch arm.
  try {
    const output = await operation.invoke({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
    return { ok: true, value: output as Output };
  } catch (error) {
    return failure(classifyEngineError(error));
  }
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
  return new Set(Object.keys(schema.shape));
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
    const message = error.message.toLowerCase();
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

const FAULT_CODES: ReadonlyArray<OperationFault['code']> = [
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'Conflict',
  'Unprocessable',
  'Timeout',
  'RateLimited',
  'NotImplemented',
  'UnsupportedTransport',
  'SubscriptionOverflow',
  'InvalidParams',
  'MethodNotFound',
  'EngineFailure',
];

function isOperationFault(value: unknown): value is OperationFault {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (FAULT_CODES as ReadonlyArray<string>).includes(candidate.code)
  );
}

function failure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
