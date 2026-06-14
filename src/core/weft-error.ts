/**
 * Stable, machine-readable discriminant for every Weft error class that is
 * part of the public API (re-exported from `@lostgradient/weft`). Each value equals the
 * throwing class's name and is safe to `switch` on exhaustively. Errors not
 * exported from `@lostgradient/weft` carry internal codes that are intentionally absent
 * from this union and may change between releases.
 *
 * Prefer comparing `error.code` (or {@link isWeftErrorLike}) over `instanceof`
 * when an error may have crossed a realm or duplicate-module boundary, where
 * `instanceof` is unreliable.
 *
 * See `documentation/reference/api-errors.md` for the source-complete error
 * code table and usage guidance for the exported guards.
 *
 * @example
 * ```ts
 * import { isWeftErrorLike, type WeftErrorCode } from '@lostgradient/weft';
 *
 * function statusFor(error: unknown): number {
 *   if (isWeftErrorLike(error)) {
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
  | 'EngineDisposedError'
  | 'WorkflowNotFoundError'
  | 'WorkflowNotRegisteredError'
  | 'WorkflowConcurrencyLimitExceededError'
  | 'WorkflowSuspendNotSupportedError'
  | 'ActivityResolutionError'
  | 'BranchTopologyChangedError'
  | 'PersistedDataIncompatibleError'
  | 'WorkflowTimeoutError'
  | 'HttpClientError'
  | 'WorkerProtocolIncompatibleError'
  | 'UpdateTimeoutError'
  | 'UpdateValidationError'
  | 'WorkflowTerminalError'
  | 'WorkflowBuilderError'
  | 'VersionMismatchError'
  | 'EffectReplayConflictError'
  | 'ReviewTimeoutError'
  | 'AtomicStateConflictError'
  | 'StandardSchemaValidationError'
  | 'ActivityReconciliationCapabilityError'
  | 'ActivityReconciliationConflictError'
  | 'ActivityReconciliationIndeterminateError'
  | 'AsyncActivityTokenNotFoundError'
  | 'ActivityScheduleToCloseTimeoutError'
  | 'PayloadSizeExceededError'
  | 'StartOrSignalConflictError'
  | 'IdempotencyKeyPurgedError';

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
 * import { WeftError } from '@lostgradient/weft';
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
  EngineDisposedError: true,
  WorkflowNotFoundError: true,
  WorkflowNotRegisteredError: true,
  WorkflowConcurrencyLimitExceededError: true,
  WorkflowSuspendNotSupportedError: true,
  ActivityResolutionError: true,
  BranchTopologyChangedError: true,
  PersistedDataIncompatibleError: true,
  WorkflowTimeoutError: true,
  HttpClientError: true,
  WorkerProtocolIncompatibleError: true,
  UpdateTimeoutError: true,
  UpdateValidationError: true,
  WorkflowTerminalError: true,
  WorkflowBuilderError: true,
  VersionMismatchError: true,
  EffectReplayConflictError: true,
  ReviewTimeoutError: true,
  AtomicStateConflictError: true,
  StandardSchemaValidationError: true,
  ActivityReconciliationCapabilityError: true,
  ActivityReconciliationConflictError: true,
  ActivityReconciliationIndeterminateError: true,
  AsyncActivityTokenNotFoundError: true,
  ActivityScheduleToCloseTimeoutError: true,
  PayloadSizeExceededError: true,
  StartOrSignalConflictError: true,
  IdempotencyKeyPurgedError: true,
} satisfies Record<WeftErrorCode, true>;

const PUBLIC_WEFT_ERROR_CODES = new Set<string>(Object.keys(publicWeftErrorCodeMap));

/**
 * Same-realm narrowing: `true` when `value` is a Weft library error instance.
 * Use this for the common case of catching any Weft error. For comparisons
 * that may cross a realm or duplicate-module boundary (where `instanceof` is
 * unreliable), use {@link isWeftErrorLike} instead — it narrows the error
 * object structurally. {@link isWeftErrorCode} narrows a bare `code` *string*,
 * not a caught `unknown`.
 *
 * See `documentation/reference/api-errors.md#error-helpers` for guard selection
 * examples across same-realm and cross-boundary errors.
 *
 * @example
 * ```ts
 * import { isWeftError } from '@lostgradient/weft';
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
 * Cross-boundary discriminant check: `true` when `value` is one of the public
 * {@link WeftErrorCode} string values. This narrows a `code` *string*; to test
 * a caught `unknown` (the common `catch` case), reach for {@link isWeftErrorLike},
 * which checks the whole error object structurally.
 *
 * See `documentation/reference/api-errors.md#error-helpers` for guard selection
 * examples across same-realm and cross-boundary errors.
 *
 * @example
 * ```ts
 * import { isWeftErrorCode } from '@lostgradient/weft';
 *
 * function isPublicCode(code: string): boolean {
 *   return isWeftErrorCode(code);
 * }
 * ```
 */
export function isWeftErrorCode(value: unknown): value is WeftErrorCode {
  return typeof value === 'string' && PUBLIC_WEFT_ERROR_CODES.has(value);
}

/**
 * Cross-boundary structural narrowing: `true` when `value` looks like a public
 * Weft error — an object carrying a public {@link WeftErrorCode} `code` and a
 * string `message`. Unlike {@link isWeftError}, this does *not* use `instanceof`,
 * so it stays reliable when the error crossed a realm or duplicate-module
 * boundary — the common case when Weft is a transitive dependency in a monorepo,
 * where two copies of the `WeftError` class make `instanceof` fail.
 *
 * Use this in a `catch` to branch on a caught `unknown` without first proving
 * `instanceof`. It is the structural counterpart to {@link isWeftError}: prefer
 * `isWeftError` for same-realm catches where you want the live class instance,
 * and `isWeftErrorLike` whenever the error may have crossed a module boundary.
 * To match a *specific* code, narrow with this guard then compare `error.code`
 * — TypeScript narrows it to the matched literal in the branch.
 *
 * See `documentation/reference/api-errors.md#error-helpers` for guard selection
 * examples across same-realm and cross-boundary errors.
 *
 * @example
 * ```ts
 * import { isWeftErrorLike } from '@lostgradient/weft';
 *
 * function statusFor(error: unknown): number {
 *   if (isWeftErrorLike(error)) {
 *     return error.code === 'WorkflowNotFoundError' ? 404 : 400;
 *   }
 *   return 500;
 * }
 * ```
 */
export function isWeftErrorLike(value: unknown): value is { code: WeftErrorCode; message: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // A type guard must be side-effect-free and total: untrusted input may be a
  // Proxy or carry throwing getters for `code`/`message`. Reading those is the
  // observable side effect, so guard the access and treat any throw as "not a
  // Weft error" rather than letting it escape the predicate.
  try {
    return (
      'code' in value &&
      isWeftErrorCode(value.code) &&
      'message' in value &&
      typeof value.message === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * Transport-uniform error classification: `true` when `error` represents the
 * given public {@link WeftErrorCode}, whether it was thrown in process or
 * arrived over HTTP. This is the canonical way to branch on a specific Weft
 * error without caring which transport produced it — the predicate the
 * `WeftClient` "constructor change, not an API change" promise rests on.
 *
 * It matches two shapes with one rule:
 * - An in-process typed error (or any {@link isWeftErrorLike} value) whose
 *   `code` equals `code` — what `LocalClient` throws.
 * - An `HttpClientError` carrying `weftCode === code` — what `HttpClient`
 *   throws when the REST fault rehydrated the originating public code. The
 *   check is structural (`'weftCode' in error`) rather than `instanceof
 *   HttpClientError`, both to stay reliable across realm/duplicate-module
 *   boundaries and to keep this guard in the core layer without importing the
 *   client.
 *
 * @example
 * ```ts
 * import { isWeftFault } from '@lostgradient/weft';
 *
 * // The same branch holds over LocalClient and HttpClient: a missing workflow
 * // is a no-op success ("nothing to tell"), not a failure to re-raise.
 * function rethrowUnlessMissing(error: unknown): void {
 *   if (!isWeftFault(error, 'WorkflowNotFoundError')) {
 *     throw error;
 *   }
 * }
 * ```
 */
export function isWeftFault(error: unknown, code: WeftErrorCode): boolean {
  if (isWeftErrorLike(error) && error.code === code) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  // Structural `weftCode` match for the HTTP-wrapped error. Same side-effect
  // guard as `isWeftErrorLike`: untrusted input may carry a throwing getter.
  try {
    return 'weftCode' in error && error.weftCode === code;
  } catch {
    return false;
  }
}
