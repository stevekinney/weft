/**
 * Internal helpers used by `./protocol.ts` to enforce the RemoteWorker
 * protocol contract at the trust boundary.
 *
 * Nothing in this module is part of the public `@lostgradient/weft/worker-protocol` surface
 * (other than `isRemoteWorkerJsonValue`, which `protocol.ts` re-exports).
 * Splitting these helpers out of `protocol.ts` keeps the canonical parser
 * module focused on the schema-to-guard mapping a reviewer audits.
 *
 * @module worker/protocol-internals
 */

import type {
  ProtocolErrorMessage,
  RegisterErrorMessage,
  RemoteWorkerJsonValue,
} from './protocol-messages.ts';

/**
 * Protocol parse failure with a machine-readable code.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolFailure } from '@lostgradient/weft/worker-protocol';
 *
 * const failure: RemoteWorkerProtocolFailure = {
 *   code: 'invalid_message',
 *   message: 'Protocol message must be an object',
 * };
 * ```
 */
export type RemoteWorkerProtocolFailure = {
  readonly code: ProtocolErrorMessage['code'] | RegisterErrorMessage['code'];
  readonly message: string;
  readonly requestedProtocolVersion?: number;
};

/**
 * Result returned by protocol parser helpers.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolParseResult, RegisterMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const result: RemoteWorkerProtocolParseResult<RegisterMessage> = {
 *   ok: false,
 *   error: { code: 'invalid_registration', message: 'workerId is required' },
 * };
 * ```
 */
export type RemoteWorkerProtocolParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly error: RemoteWorkerProtocolFailure };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return true when a value can be represented by JSON on the worker protocol.
 *
 * @example
 * ```ts
 * import { isRemoteWorkerJsonValue } from '@lostgradient/weft/worker-protocol';
 *
 * const canSend = isRemoteWorkerJsonValue({ nested: ['ok'] });
 * ```
 */
export function isRemoteWorkerJsonValue(value: unknown): value is RemoteWorkerJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isRemoteWorkerJsonValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isRemoteWorkerJsonValue);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function protocolFailure(
  code: RemoteWorkerProtocolFailure['code'],
  message: string,
  requestedProtocolVersion?: number,
): RemoteWorkerProtocolParseResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(requestedProtocolVersion !== undefined ? { requestedProtocolVersion } : {}),
    },
  };
}

// A FieldSpec is the unit of trust-boundary work: validate one source field
// from `record[sourceKey]` and, if valid, copy it to the output under the
// same key. The parent parser supplies the record at call time; the spec
// table itself is a module-level constant so it can be read top-to-bottom
// against the schema without dragging field count into parser complexity.
// Tuple shape: [sourceKey, isRequired, predicate, errorMessage].
export type FieldSpec = readonly [
  sourceKey: string,
  isRequired: boolean,
  predicate: (v: unknown) => boolean,
  errorMessage: string,
];

export type CollectFieldsResult =
  | { readonly ok: true; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly error: RemoteWorkerProtocolParseResult<never> };

export function collectFields(
  code: RemoteWorkerProtocolFailure['code'],
  record: Record<string, unknown>,
  specs: readonly FieldSpec[],
): CollectFieldsResult {
  const values: Record<string, unknown> = {};
  for (const [sourceKey, isRequired, predicate, errorMessage] of specs) {
    const raw = record[sourceKey];
    if (raw === undefined) {
      if (isRequired) return { ok: false, error: protocolFailure(code, errorMessage) };
      continue;
    }
    if (!predicate(raw)) return { ok: false, error: protocolFailure(code, errorMessage) };
    values[sourceKey] = raw;
  }
  return { ok: true, values };
}
