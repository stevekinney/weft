/**
 * The {@link WeftErrorCode} an error stands for, for the failure record a failed run stores
 * (COR-2529).
 *
 * @module core/error-code-of
 */
import { isWeftErrorCode, isWeftErrorLike, type WeftErrorCode } from './weft-error.ts';

/**
 * Codes the engine knows for an `Error` it rebuilt from a message. A failure that crosses the
 * execution strategy's `failed` message arrives as `new Error(message)`, which has lost the
 * original error's code; the strategy carries the code beside the message and
 * {@link attachErrorCode} binds it to the rebuilt error here, without touching the error.
 */
const attachedErrorCodes = new WeakMap<Error, WeftErrorCode>();

/** Bind `code` to `error`, an error the engine rebuilt from a failure message. */
export function attachErrorCode(error: Error, code: WeftErrorCode | undefined): void {
  if (code !== undefined) attachedErrorCodes.set(error, code);
}

/**
 * The {@link WeftErrorCode} of `error`, or `undefined` when it is not a Weft error.
 *
 * An error that crossed an operation boundary (an activity's failure fed back into the workflow)
 * is rebuilt from its message and its `name`, and a Weft error's `name` is its code, so a name
 * that is a public code counts too.
 */
export function errorCodeOf(error: unknown): WeftErrorCode | undefined {
  if (error instanceof Error) {
    const attached = attachedErrorCodes.get(error);
    if (attached !== undefined) return attached;
  }
  if (isWeftErrorLike(error)) return error.code;
  if (error instanceof Error && isWeftErrorCode(error.name)) return error.name;
  return undefined;
}
