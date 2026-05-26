/**
 * Stable, machine-readable discriminant for every Weft error class that is
 * part of the public API (re-exported from `weft`). Each value equals the
 * throwing class's name and is safe to `switch` on exhaustively. Errors not
 * exported from `weft` carry internal codes that are intentionally absent
 * from this union and may change between releases.
 *
 * Prefer comparing `error.code` (or {@link isWeftErrorCode}) over `instanceof`
 * when an error may have crossed a realm or duplicate-module boundary, where
 * `instanceof` is unreliable.
 *
 * @example
 * ```ts
 * import { isWeftError, isWeftErrorCode, type WeftErrorCode } from 'weft';
 *
 * function statusFor(error: unknown): number {
 *   if (isWeftError(error) && isWeftErrorCode(error.code)) {
 *     const code: WeftErrorCode = error.code;
 *     return code === 'WorkflowNotFoundError' ? 404 : 400;
 *   }
 *   return 500;
 * }
 * ```
 */
export type WeftErrorCode =
  | 'WorkflowAlreadyExistsError'
  | 'BulkDeleteRequiresTerminalWorkflowsError'
  | 'BulkOperationConfirmationError'
  | 'WorkflowTypeNotRegisteredForRecoveryError'
  | 'EngineCreateNameMismatchError'
  | 'WorkflowNotFoundError'
  | 'WorkflowNotRegisteredError'
  | 'ActivityResolutionError'
  | 'PersistedDataIncompatibleError'
  | 'WorkflowTimeoutError'
  | 'HttpClientError'
  | 'WorkerProtocolIncompatibleError'
  | 'QuotaExceededError'
  | 'UpdateTimeoutError'
  | 'WorkflowTerminalError'
  | 'WorkflowBuilderError'
  | 'VersionMismatchError'
  | 'EffectReplayConflictError'
  | 'ReviewTimeoutError'
  | 'AtomicStateConflictError'
  | 'StandardSchemaValidationError';

/**
 * Generic abstract base for all Weft library errors. The `TCode` parameter
 * makes each subclass's `code` its own literal type; the exported base surface
 * stays `code: string`, so internal (non-exported) error codes never leak into
 * the public `.d.ts`.
 *
 * Subclasses pass their stable code to `super(...)`; the base assigns both
 * `this.code` and `this.name` from it, so subclasses never set `this.name`
 * themselves. `options` forwards `cause` to the `Error` constructor.
 *
 * @example
 * ```ts
 * import { WeftError } from 'weft';
 *
 * function describe(error: unknown): string {
 *   return error instanceof WeftError ? `${error.code}: ${error.message}` : 'unknown';
 * }
 * ```
 */
export abstract class WeftError<TCode extends string = string> extends Error {
  /** Stable machine-readable discriminant; equals the subclass name. */
  readonly code: TCode;

  constructor(code: TCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = code;
  }
}

// No-drift: the set is derived from a union-checked object, so a missing or
// extra key is a compile error and the runtime guard cannot diverge from
// `WeftErrorCode`.
const publicWeftErrorCodeMap = {
  WorkflowAlreadyExistsError: true,
  BulkDeleteRequiresTerminalWorkflowsError: true,
  BulkOperationConfirmationError: true,
  WorkflowTypeNotRegisteredForRecoveryError: true,
  EngineCreateNameMismatchError: true,
  WorkflowNotFoundError: true,
  WorkflowNotRegisteredError: true,
  ActivityResolutionError: true,
  PersistedDataIncompatibleError: true,
  WorkflowTimeoutError: true,
  HttpClientError: true,
  WorkerProtocolIncompatibleError: true,
  QuotaExceededError: true,
  UpdateTimeoutError: true,
  WorkflowTerminalError: true,
  WorkflowBuilderError: true,
  VersionMismatchError: true,
  EffectReplayConflictError: true,
  ReviewTimeoutError: true,
  AtomicStateConflictError: true,
  StandardSchemaValidationError: true,
} satisfies Record<WeftErrorCode, true>;

const PUBLIC_WEFT_ERROR_CODES = new Set<string>(Object.keys(publicWeftErrorCodeMap));

/**
 * Same-realm narrowing: `true` when `value` is a Weft library error instance.
 * Use this for the common case of catching any Weft error. For comparisons
 * that may cross a realm or duplicate-module boundary, narrow on
 * {@link isWeftErrorCode} against `error.code` instead.
 *
 * @example
 * ```ts
 * import { isWeftError } from 'weft';
 *
 * function logFrom(error: unknown): string {
 *   return isWeftError(error) ? `[${error.code}] ${error.message}` : 'non-weft error';
 * }
 * ```
 */
export function isWeftError(value: unknown): value is WeftError {
  return value instanceof WeftError;
}

/**
 * Cross-boundary structural check: `true` when `value` is one of the public
 * {@link WeftErrorCode} values. Pair with {@link isWeftError} to safely switch
 * over public codes: `if (isWeftError(e) && isWeftErrorCode(e.code)) { ... }`.
 *
 * @example
 * ```ts
 * import { isWeftError, isWeftErrorCode } from 'weft';
 *
 * function isMissingWorkflow(error: unknown): boolean {
 *   return isWeftError(error) && isWeftErrorCode(error.code)
 *     ? error.code === 'WorkflowNotFoundError'
 *     : false;
 * }
 * ```
 */
export function isWeftErrorCode(value: unknown): value is WeftErrorCode {
  return typeof value === 'string' && PUBLIC_WEFT_ERROR_CODES.has(value);
}
