import { parseDuration } from './scheduler.ts';
import type { Duration } from './types.ts';
import { WeftError } from './weft-error.ts';
import { assertValidWorkflowId } from './workflow-identifiers.ts';

export const MAX_WORKFLOW_TAGS = 32;
export const MAX_WORKFLOW_TAG_BYTES = 128;
/**
 * Upper bound on a start `idempotencyKey`, in UTF-8 bytes. `startOrSignal`
 * derives a signal id of `start-idem:${key}` (an 11-byte prefix) from the key,
 * and `validateSignalId` caps a signal id at 128 bytes — so the raw key must fit
 * in `128 - 11 = 117` bytes for the derived id to stay within that ceiling.
 */
export const MAX_IDEMPOTENCY_KEY_BYTES = 117;

const textEncoder = new TextEncoder();
const EXCLUSIVE_START_WORKFLOW_OPTIONS_ERROR = 'Provide only one of startAt or startAfter';

export class StartWorkflowValidationError extends WeftError<'StartWorkflowValidationError'> {
  constructor(message: string) {
    super('StartWorkflowValidationError', message);
  }
}

export const assertExclusiveStartWorkflowOptions = (
  startAt: unknown,
  startAfter: unknown,
): void => {
  if (startAt !== undefined && startAfter !== undefined) {
    throw new StartWorkflowValidationError(EXCLUSIVE_START_WORKFLOW_OPTIONS_ERROR);
  }
};

export const coerceStartWorkflowId = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string') {
    throw new StartWorkflowValidationError(`${fieldName} must be a string`);
  }

  try {
    assertValidWorkflowId(value, fieldName);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartWorkflowValidationError(message);
  }
};

/**
 * Coerce a transport-supplied idempotency key to a non-empty string. The key is
 * a caller-chosen dedup token (it becomes part of a `start-idem:` storage key),
 * so an empty string — which would collide across unrelated starts — is rejected.
 */
export const coerceStartWorkflowIdempotencyKey = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string') {
    throw new StartWorkflowValidationError(`${fieldName} must be a string`);
  }
  return assertValidIdempotencyKey(value, fieldName);
};

/**
 * Validate an already-string `idempotencyKey`: non-empty (an empty key would
 * collide across unrelated starts under the shared `start-idem:` mapping) and at
 * most {@link MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes (so the derived
 * `start-idem:${key}` signal id stays within the signal-id ceiling). Shared by
 * the transport coercion and the engine boundary so a direct `engine.start`
 * caller gets the same guarantees as an HTTP caller.
 */
export const assertValidIdempotencyKey = (value: string, fieldName: string): string => {
  if (value.length === 0) {
    throw new StartWorkflowValidationError(`${fieldName} must not be empty`);
  }
  if (textEncoder.encode(value).byteLength > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new StartWorkflowValidationError(
      `${fieldName} must be at most ${MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes`,
    );
  }
  return value;
};

/**
 * Validate the `onTerminalConflict` start policy against the rest of the start
 * options. `'error'` (the default) and `'start-new'` are the only accepted
 * values. `'start-new'` (Temporal's `ALLOW_DUPLICATE` for terminal runs) requires
 * an explicit, caller-chosen `id` and is mutually exclusive with `idempotencyKey`:
 * idempotency is a permanent at-most-once mapping that survives terminal state, so
 * restarting under it would contradict that contract. A generated UUID is never a
 * meaningful restart target, hence the explicit-`id` requirement.
 */
export function assertValidOnTerminalConflict(
  options: { onTerminalConflict?: unknown; id?: unknown; idempotencyKey?: unknown } | undefined,
): void {
  const onTerminalConflict = options?.onTerminalConflict;
  if (onTerminalConflict === undefined || onTerminalConflict === 'error') {
    return;
  }
  if (onTerminalConflict !== 'start-new') {
    throw new StartWorkflowValidationError(
      "options.onTerminalConflict must be 'error' or 'start-new'",
    );
  }
  if (options?.idempotencyKey !== undefined) {
    throw new StartWorkflowValidationError(
      "options.onTerminalConflict: 'start-new' is mutually exclusive with options.idempotencyKey: " +
        'idempotency is a permanent at-most-once mapping and cannot restart a terminal run',
    );
  }
  if (options?.id === undefined) {
    throw new StartWorkflowValidationError(
      "options.onTerminalConflict: 'start-new' requires an explicit options.id; a generated id is " +
        'never a meaningful restart target',
    );
  }
}

/**
 * `options.id` and `options.idempotencyKey` are mutually exclusive: idempotency
 * assigns its own generated workflow id and dedups through the key, so pinning a
 * caller id alongside it conflates "id already taken" with "lost the idempotency
 * race". Reject the combination so each concern stays separable. Shared by the
 * plain idempotent-start path and `startOrSignal` convergence validation.
 */
export function assertIdAndIdempotencyKeyExclusive(options: {
  id?: unknown;
  idempotencyKey?: unknown;
}): void {
  if (options.id !== undefined && options.idempotencyKey !== undefined) {
    throw new StartWorkflowValidationError(
      'options.id and options.idempotencyKey are mutually exclusive: idempotency assigns its own ' +
        'workflow id and dedups through the idempotency key. Provide one or the other.',
    );
  }
}

/**
 * Reject `onTerminalConflict` on a start surface that does not support it
 * (`ctx.startChild`). The option is type-absent from those surfaces, but a
 * transport or untyped JS caller could still smuggle the field into the options
 * object — this is the runtime backstop. Child starts reattach by id during
 * parent replay, so purging a terminal child mid-replay would break determinism.
 */
export function assertOnTerminalConflictUnsupported(
  options: object | undefined,
  surface: string,
): void {
  // The guarded surfaces' types do not declare `onTerminalConflict`, so read it
  // defensively: this exists to catch a transport/JS caller that put the field on
  // the object anyway, past the type boundary.
  if (
    options !== undefined &&
    'onTerminalConflict' in options &&
    (options as { onTerminalConflict?: unknown }).onTerminalConflict !== undefined
  ) {
    throw new StartWorkflowValidationError(
      `${surface} does not support options.onTerminalConflict`,
    );
  }
}

export function coerceStartWorkflowTimestamp(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StartWorkflowValidationError(
      `${fieldName} must be a non-negative integer millisecond timestamp`,
    );
  }

  return value;
}

export function parseStartWorkflowDuration(duration: Duration, fieldName: string): number {
  try {
    return parseDuration(duration);
  } catch {
    throw new StartWorkflowValidationError(
      `${fieldName} must be a finite, non-negative number or a valid duration string`,
    );
  }
}

export function coerceStartWorkflowDuration(value: unknown, fieldName: string): Duration {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new StartWorkflowValidationError(
      `${fieldName} must be a finite, non-negative number or valid duration string`,
    );
  }

  parseStartWorkflowDuration(value, fieldName);
  return value;
}

export function assertWorkflowTagCount(tags: readonly unknown[], fieldName: string): void {
  if (tags.length > MAX_WORKFLOW_TAGS) {
    throw new StartWorkflowValidationError(
      `${fieldName} must contain at most ${MAX_WORKFLOW_TAGS} tags`,
    );
  }
}

export function coerceStartWorkflowTags(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new StartWorkflowValidationError(`${fieldName} must be an array of strings`);
  }

  assertWorkflowTagCount(value, fieldName);

  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string') {
      throw new StartWorkflowValidationError(`${fieldName} must contain only strings`);
    }
    if (tag.trim().length === 0) {
      throw new StartWorkflowValidationError(`${fieldName} must not contain empty tags`);
    }
    if (textEncoder.encode(tag).byteLength > MAX_WORKFLOW_TAG_BYTES) {
      throw new StartWorkflowValidationError(
        `${fieldName} tags must be at most ${MAX_WORKFLOW_TAG_BYTES} UTF-8 bytes each`,
      );
    }
    tags.push(tag);
  }

  return tags;
}
