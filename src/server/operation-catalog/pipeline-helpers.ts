import { z } from 'zod';

import { WeftError } from '../../core/weft-error.ts';

import {
  WorkflowAlreadyExistsError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import type { FlattenedZodIssue, OperationFault, TransportKind } from '../operation-fault.ts';
import type { TransportAvailability, UnknownKeyPolicy } from './types.ts';

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

export function transportToPolicyKey(transport: TransportKind): keyof UnknownKeyPolicy {
  return transport === 'http-rest' ? 'http' : 'jsonRpc';
}

export function transportToAvailabilityKey(transport: TransportKind): keyof TransportAvailability {
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

const UNIVERSAL_PRODUCIBLE_FAULTS: ReadonlySet<string> = new Set([
  'Unauthorized',
  'Forbidden',
  'InvalidParams',
  'EngineFailure',
]);

/**
 * Translate a thrown value from `invoke` into a transport-neutral
 * OperationFault.
 *
 * Typed engine errors (`WorkflowAlreadyExistsError`,
 * `WorkflowNotFoundError`, `WorkflowNotRegisteredError`) are matched first
 * so the fault classification is robust against future error-message
 * rewording. Plain `Error` instances fall through to the message-pattern
 * heuristics, which exist as a last-resort generic catch-all.
 *
 * **Producible-faults enforcement.** When `operation` is supplied (the
 * dispatch pipeline always supplies it), any direct `OperationFault`
 * throw whose `code` is NOT in the operation's `producibleFaults` ∪
 * universal-defaults set is logged as a declaration violation:
 *
 *   - Test/dev (`NODE_ENV !== 'production'` OR `WEFT_STRICT_FAULTS=1`):
 *     console.error so the developer notices and either declares the
 *     fault or migrates the throw to `raiseFault`.
 *   - Production: silent log. The original fault is preserved on the
 *     wire to keep clients' actionable semantics intact.
 *
 * This makes the producibleFaults declarations runtime-load-bearing for
 * direct throws too — not just calls routed through the `raiseFault`
 * helper.
 */
export function classifyEngineError(
  error: unknown,
  operation?: { name: string; producibleFaults?: ReadonlyArray<string> },
): OperationFault {
  if (isOperationFault(error)) {
    try {
      enforceProducibleFaults(operation, error.code);
    } catch (enforcementError) {
      if (isUndeclaredFaultError(enforcementError)) {
        // Strict mode caught an undeclared fault. Surface as
        // EngineFailure with the diagnostic message so the test runner
        // can assert against `result.fault.message` and the test fails
        // loudly instead of silently passing through the original code.
        return {
          code: 'EngineFailure',
          message: enforcementError.message,
          data: {},
        };
      }
      throw enforcementError;
    }
    return error;
  }
  if (error instanceof WorkflowAlreadyExistsError) {
    return {
      code: 'Conflict',
      message: 'conflict',
      data: { reason: 'resource already exists' },
    };
  }
  if (error instanceof WorkflowNotRegisteredError) {
    return {
      code: 'InvalidParams',
      message: error.message,
      data: { issues: [] },
    };
  }
  if (error instanceof WorkflowNotFoundError) {
    return {
      code: 'NotFound',
      message: 'not found',
      data: { resource: 'workflow' },
    };
  }
  if (error instanceof Error) {
    return classifyErrorMessage(error);
  }
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

/**
 * Sentinel thrown by `enforceProducibleFaults` in strict mode when an
 * operation raises a fault code that isn't in its `producibleFaults`
 * declaration. The dispatcher catches this in `executeOperation` and
 * surfaces it as a generic `EngineFailure` so test failures point at the
 * declaration mismatch rather than silently passing through.
 */
class UndeclaredFaultError extends WeftError<'UndeclaredFaultError'> {
  readonly operationName: string;
  readonly faultCode: string;

  constructor(operationName: string, faultCode: string) {
    super(
      'UndeclaredFaultError',
      `[weft] Operation "${operationName}" raised undeclared fault "${faultCode}". ` +
        "Add it to the operation's `producibleFaults` array or migrate the throw to " +
        '`raiseFault(operation, fault)`.',
    );
    this.operationName = operationName;
    this.faultCode = faultCode;
  }
}

export function isUndeclaredFaultError(value: unknown): value is UndeclaredFaultError {
  return value instanceof UndeclaredFaultError;
}

function enforceProducibleFaults(
  operation: { name: string; producibleFaults?: ReadonlyArray<string> } | undefined,
  code: string,
): void {
  if (operation === undefined) return;
  if (UNIVERSAL_PRODUCIBLE_FAULTS.has(code)) return;
  const declared = operation.producibleFaults;
  if (declared !== undefined && declared.includes(code)) return;

  const isStrict = Bun.env['WEFT_STRICT_FAULTS'] === '1' || Bun.env['NODE_ENV'] !== 'production';
  if (isStrict) {
    // Strict mode: throw a hard error so the regression is observable
    // through the test framework's normal failure path. The dispatcher
    // catches `UndeclaredFaultError` separately so the message reaches
    // test output instead of being swallowed as a bare `EngineFailure`.
    throw new UndeclaredFaultError(operation.name, code);
  }
  // Production: log only. Original fault is preserved on the wire so
  // clients keep their actionable Conflict semantics.
  console.warn(
    `[weft] Operation "${operation.name}" raised undeclared fault "${code}". ` +
      "Add it to the operation's `producibleFaults` array or migrate the throw to " +
      '`raiseFault(operation, fault)`.',
  );
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
  NotImplemented: true,
  UnsupportedTransport: true,
  SubscriptionOverflow: true,
  InvalidParams: true,
  MethodNotFound: true,
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
