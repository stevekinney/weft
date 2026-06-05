import { parseDuration } from './scheduler.ts';
import type { Duration } from './types.ts';
import { WeftError } from './weft-error.ts';
import { assertValidWorkflowId } from './workflow-identifiers.ts';

export const MAX_WORKFLOW_TAGS = 32;
export const MAX_WORKFLOW_TAG_BYTES = 128;

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
  if (value.length === 0) {
    throw new StartWorkflowValidationError(`${fieldName} must not be empty`);
  }
  return value;
};

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
