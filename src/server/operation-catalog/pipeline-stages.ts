import { z } from 'zod';

import { evaluateAccess } from '../authorization.ts';
import { isPlainObject } from '../json-schema-utilities.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  SUPPORTED_TRANSPORTS,
  UNSAFE_PROTOTYPE_KEYS,
  extractTopLevelObjectKeys,
  flattenZodIssues,
  sanitizeTopLevel,
  transportToAvailabilityKey,
} from './pipeline-helpers.ts';
import {
  type AuthorizationDecision,
  type DispatchContext,
  type DispatchResult,
  type ErasedOperation,
  type PipelineTrace,
  type PipelineTraceMarker,
  type UnknownKeyDisposition,
  type UnknownKeyPolicy,
} from './types.ts';

export type PipelineParseOutcome =
  | { kind: 'ok'; input: unknown }
  | { kind: 'failure'; fault: OperationFault };

type PreParseOutcome =
  | {
      kind: 'ok';
      input: unknown;
      passthroughExtras: ReadonlyArray<readonly [string, unknown]>;
    }
  | { kind: 'failure'; fault: OperationFault };

/** Verify that an operation is available on the current transport. */
export function checkTransport(
  operation: ErasedOperation,
  context: DispatchContext,
): DispatchResult<never> | null {
  if (operation.transports[transportToAvailabilityKey(context.transport)]) return null;

  const supported = SUPPORTED_TRANSPORTS.filter(
    (transport) => operation.transports[transportToAvailabilityKey(transport)],
  );
  return failure({
    code: 'UnsupportedTransport',
    message: `operation "${operation.name}" does not support transport "${context.transport}"`,
    data: { transport: context.transport, supported },
  });
}

/** Verify the operation's static access policy against the caller principal. */
export function checkAccess(
  operation: ErasedOperation,
  context: DispatchContext,
): DispatchResult<never> | null {
  const access = evaluateAccess(operation.access, context.principal);
  if (access.allowed) return null;

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

/** Run the optional parameter-aware authorization hook. */
export async function checkAuthorization(
  operation: ErasedOperation,
  input: unknown,
  context: DispatchContext,
): Promise<DispatchResult<never> | null> {
  if (operation.authorize === undefined) return null;

  let decision: unknown;
  try {
    decision = await operation.authorize({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!isAuthorizationDecision(decision)) {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!decision.allowed) {
    if (decision.classification === 'unauthorized') {
      return failure({
        code: 'Unauthorized',
        message: decision.reason,
        data: { reason: decision.reason },
      });
    }
    return failure({
      code: 'Forbidden',
      message: decision.reason,
      data: { reason: decision.reason },
    });
  }
  return null;
}

/**
 * Input parsing stage: apply the catalog's top-level unknown-key policy,
 * run the schema's `safeParse`, and re-attach passthrough extras onto a
 * prototype-safe null-prototype object.
 */
export function parseAndApplyUnknownKeyPolicy(
  operation: ErasedOperation,
  rawInput: unknown,
  policyKey: keyof UnknownKeyPolicy,
  pipelineTrace?: PipelineTrace,
): PipelineParseOutcome {
  const policy = operation.unknownKeyPolicy[policyKey];
  const knownKeys = readKnownTopLevelKeys(operation);
  if (knownKeys.kind === 'failure') return knownKeys;

  const preParse = buildPreParseInput(rawInput, policy, knownKeys.keys);
  if (preParse.kind === 'failure') return preParse;

  const parseResult = safeParseInput(operation.inputSchema, preParse.input);
  if (parseResult.kind === 'failure') return parseResult;
  tracePipeline(pipelineTrace, 'parsed');

  const parsed = parseResult.input as Record<string, unknown>;
  if (policy !== 'passthrough') {
    tracePipeline(pipelineTrace, 'unknown-key-policy-applied');
    return { kind: 'ok', input: parsed };
  }

  const passthroughOutput = buildPassthroughOutput(parsed, preParse.passthroughExtras);
  tracePipeline(pipelineTrace, 'unknown-key-policy-applied');
  return { kind: 'ok', input: passthroughOutput };
}

/** Emit one pipeline trace marker when a trace observer is installed. */
export function tracePipeline(
  pipelineTrace: PipelineTrace | undefined,
  marker: PipelineTraceMarker,
): void {
  if (pipelineTrace === undefined) return;
  pipelineTrace(marker);
}

function readKnownTopLevelKeys(
  operation: ErasedOperation,
): { kind: 'ok'; keys: ReadonlySet<string> } | { kind: 'failure'; fault: OperationFault } {
  try {
    return { kind: 'ok', keys: extractTopLevelObjectKeys(operation.inputSchema) };
  } catch {
    return {
      kind: 'failure',
      fault: { code: 'EngineFailure', message: 'internal error', data: {} },
    };
  }
}

function buildPreParseInput(
  rawInput: unknown,
  policy: UnknownKeyDisposition,
  knownKeys: ReadonlySet<string>,
): PreParseOutcome {
  if (!isPlainObject(rawInput)) {
    return { kind: 'ok', input: rawInput, passthroughExtras: [] };
  }

  const rawRecord = rawInput;
  const unknownTopLevel = Object.keys(rawRecord).filter((key) => !knownKeys.has(key));
  if (unknownTopLevel.length === 0) {
    return { kind: 'ok', input: rawInput, passthroughExtras: [] };
  }

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

  return {
    kind: 'ok',
    input: sanitizeTopLevel(rawRecord, knownKeys),
    passthroughExtras: collectPassthroughExtras(rawRecord, unknownTopLevel, policy),
  };
}

function collectPassthroughExtras(
  rawInput: Record<string, unknown>,
  unknownTopLevel: ReadonlyArray<string>,
  policy: UnknownKeyDisposition,
): ReadonlyArray<readonly [string, unknown]> {
  if (policy !== 'passthrough') return [];
  return unknownTopLevel
    .filter((key) => !UNSAFE_PROTOTYPE_KEYS.has(key))
    .map((key) => [key, rawInput[key]] as const);
}

function buildPassthroughOutput(
  parsed: Record<string, unknown>,
  passthroughExtras: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (UNSAFE_PROTOTYPE_KEYS.has(key)) continue;
    merged[key] = value;
  }
  for (const [key, value] of passthroughExtras) {
    if (key in merged) continue;
    merged[key] = value;
  }
  return merged;
}

function safeParseInput(inputSchema: z.ZodType, input: unknown): PipelineParseOutcome {
  let parseResult: ReturnType<typeof inputSchema.safeParse>;
  try {
    parseResult = inputSchema.safeParse(input);
  } catch {
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
  return { kind: 'ok', input: parseResult.data };
}

function isAuthorizationDecision(value: unknown): value is AuthorizationDecision {
  if (typeof value !== 'object' || value === null) return false;
  const allowed = readObjectProperty(value, 'allowed');
  if (!allowed.ok) return false;
  if (allowed.value === true) return true;
  if (allowed.value !== false) return false;
  const reason = readObjectProperty(value, 'reason');
  if (!reason.ok || typeof reason.value !== 'string') return false;
  const classification = readObjectProperty(value, 'classification');
  if (!classification.ok) return false;
  return isAuthorizationFailureClassification(classification.value);
}

function readObjectProperty(
  value: object,
  property: PropertyKey,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: (value as Record<PropertyKey, unknown>)[property] };
  } catch {
    return { ok: false };
  }
}

function isAuthorizationFailureClassification(value: unknown): boolean {
  return value === undefined || value === 'unauthorized' || value === 'forbidden';
}

function failure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
