import { z } from 'zod';

import type { FlattenedZodIssue, OperationFault, TransportKind } from '../operation-fault.ts';
import type { FaultPolicy, TransportAvailability, UnknownKeyPolicy } from './types.ts';
import { UNIVERSAL_FAULT_DEFAULTS } from './universal-faults.ts';

export const SUPPORTED_TRANSPORTS: ReadonlyArray<TransportKind> = [
  'http-rest',
  'jsonRpcHttp',
  'jsonRpcWebSocket',
  'jsonRpcStdio',
];

export const UNSAFE_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/** Maps a transport to its key in {@link UnknownKeyPolicy}. */
export function transportToPolicyKey(transport: TransportKind): keyof UnknownKeyPolicy {
  return transport === 'http-rest' ? 'http' : 'jsonRpc';
}

/** Maps a transport to its key in {@link TransportAvailability}. */
export function transportToAvailabilityKey(
  transport: Exclude<TransportKind, 'mcp'>,
): keyof TransportAvailability {
  switch (transport) {
    case 'http-rest':
      return 'http';
    case 'jsonRpcHttp':
      return 'jsonRpcHttp';
    case 'jsonRpcWebSocket':
      return 'jsonRpcWebSocket';
    case 'jsonRpcStdio':
      return 'jsonRpcStdio';
    default: {
      const exhaustiveCheck: never = transport;
      throw new Error(`Unknown transport kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Extract the top-level keys of an object schema. The registry validates at
 * construction time that every `inputSchema` is a `z.ZodObject`.
 */
export function extractTopLevelObjectKeys(schema: z.ZodType): ReadonlySet<string> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      'extractTopLevelObjectKeys called with a non-object schema — the operation registry should have rejected this at construction',
    );
  }
  return new Set(Object.keys(schema.shape).filter((key) => !UNSAFE_PROTOTYPE_KEYS.has(key)));
}

/**
 * Build a prototype-safe shallow projection of `rawInput` containing only
 * keys present in `knownKeys`.
 */
export function sanitizeTopLevel(
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

export function flattenZodIssues(
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
 * A thrown `OperationFault` is checked against the operation's declared
 * faults. Any other value goes to the host's `policy.classifyError` first (the
 * host's own typed errors, matched by class so the classification is robust
 * against error-message rewording), then to the message-pattern heuristics,
 * which exist as a last-resort generic catch-all.
 *
 * **Producible-faults enforcement.** When `operation` is supplied (the
 * dispatch pipeline always supplies it), any direct `OperationFault`
 * throw whose `code` is NOT in the operation's `producibleFaults` ∪
 * universal-defaults set is a declaration violation. `policy.strict` decides
 * what happens, and it is strict when the host supplies nothing:
 *
 *   - Strict: the fault is replaced by an `EngineFailure` that carries the
 *     diagnostic, so the developer notices and either declares the fault or
 *     migrates the throw to `raiseFault`.
 *   - Not strict: a `console.warn`. The original fault is preserved on the
 *     wire to keep clients' actionable semantics intact.
 *
 * This makes the producibleFaults declarations runtime-load-bearing for
 * direct throws too — not just calls routed through the `raiseFault`
 * helper.
 */
export function classifyEngineError(
  error: unknown,
  operation?: { name: string; producibleFaults?: ReadonlyArray<string> },
  policy?: FaultPolicy,
): OperationFault {
  if (isOperationFault(error)) {
    const violation = findUndeclaredFault(operation, error.code, policy);
    if (violation !== null) {
      // Strict mode caught an undeclared fault. Surface as
      // EngineFailure with the diagnostic message so the test runner
      // can assert against `result.fault.message` and the test fails
      // loudly instead of silently passing through the original code.
      return {
        code: 'EngineFailure',
        message: violation.message,
        data: {},
      };
    }
    return error;
  }
  const hostFault = policy?.classifyError?.(error);
  if (hostFault !== undefined) return hostFault;
  if (error instanceof Error) {
    return classifyErrorMessage(error);
  }
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

/**
 * Diagnostic returned by `findUndeclaredFault` in strict mode when an
 * operation raises a fault code that isn't in its `producibleFaults`
 * declaration. `classifyEngineError` surfaces its message as an
 * `EngineFailure` so test failures point at the declaration mismatch
 * rather than silently passing through.
 */
export class UndeclaredFaultError extends Error {
  /** Stable machine-readable discriminant; equals the class name, as a `WeftError`'s does. */
  readonly code = 'UndeclaredFaultError';
  /** The operation that produced it. */
  readonly operationName: string;
  /** The code the operation produced. */
  readonly faultCode: string;

  constructor(operationName: string, faultCode: string) {
    super(
      `[weft] Operation "${operationName}" raised undeclared fault "${faultCode}". ` +
        "Add it to the operation's `producibleFaults` array or migrate the throw to " +
        '`raiseFault(operation, fault)`.',
    );
    this.name = this.code;
    this.operationName = operationName;
    this.faultCode = faultCode;
  }
}

/** Strict unless the host said otherwise: a host that supplies nothing gets strict mode. */
function isStrictFaultPolicy(policy: FaultPolicy | undefined): boolean {
  const strict = policy?.strict;
  if (strict === undefined) return true;
  return typeof strict === 'function' ? strict() : strict;
}

function findUndeclaredFault(
  operation: { name: string; producibleFaults?: ReadonlyArray<string> } | undefined,
  code: string,
  policy: FaultPolicy | undefined,
): UndeclaredFaultError | null {
  if (operation === undefined) return null;
  if ((UNIVERSAL_FAULT_DEFAULTS as ReadonlySet<string>).has(code)) return null;
  const declared = operation.producibleFaults;
  if (declared !== undefined && declared.includes(code)) return null;

  if (isStrictFaultPolicy(policy)) {
    // Strict mode: hand the diagnostic back so the regression is observable
    // through the test framework's normal failure path, with its message
    // intact instead of swallowed as a bare `EngineFailure`.
    return new UndeclaredFaultError(operation.name, code);
  }
  // Production: log only. Original fault is preserved on the wire so
  // clients keep their actionable Conflict semantics.
  console.warn(
    `[weft] Operation "${operation.name}" raised undeclared fault "${code}". ` +
      "Add it to the operation's `producibleFaults` array or migrate the throw to " +
      '`raiseFault(operation, fault)`.',
  );
  return null;
}

function classifyErrorMessage(error: Error): OperationFault {
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
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

const FAULT_CODES = {
  Unauthorized: true,
  Forbidden: true,
  NotFound: true,
  Conflict: true,
  Unprocessable: true,
  Timeout: true,
  PayloadTooLarge: true,
  NotImplemented: true,
  UnsupportedTransport: true,
  SubscriptionOverflow: true,
  InvalidParams: true,
  MethodNotFound: true,
  StaleRevision: true,
  RateLimited: true,
  Unavailable: true,
  UnsupportedCapability: true,
  EngineFailure: true,
} as const satisfies Readonly<Record<OperationFault['code'], true>>;

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
    !Array.isArray(data) &&
    Object.hasOwn(FAULT_CODES, code)
  );
}
