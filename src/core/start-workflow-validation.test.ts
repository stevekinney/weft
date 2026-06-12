import { describe, expect, it } from 'bun:test';

import {
  assertExclusiveStartWorkflowOptions,
  assertOnTerminalConflictUnsupported,
  assertValidOnTerminalConflict,
  coerceStartWorkflowDuration,
  coerceStartWorkflowId,
  coerceStartWorkflowIdempotencyKey,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MAX_WORKFLOW_TAG_BYTES,
  parseStartWorkflowDuration,
  StartWorkflowValidationError,
} from './start-workflow-validation.ts';

function captureValidationError(action: () => void): StartWorkflowValidationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StartWorkflowValidationError);
    return error as StartWorkflowValidationError;
  }

  throw new Error('Expected StartWorkflowValidationError');
}

describe('start workflow validation', () => {
  it('rejects providing both startAt and startAfter', () => {
    expect(() => assertExclusiveStartWorkflowOptions(1, '5s')).toThrow(
      new StartWorkflowValidationError('Provide only one of startAt or startAfter'),
    );
  });

  it('allows providing only one delayed-start option', () => {
    expect(() => assertExclusiveStartWorkflowOptions(1, undefined)).not.toThrow();
    expect(() => assertExclusiveStartWorkflowOptions(undefined, '5s')).not.toThrow();
  });

  it('returns a valid workflow id unchanged', () => {
    expect(coerceStartWorkflowId('workflow-123', 'options.id')).toBe('workflow-123');
  });

  it('rejects non-string workflow ids', () => {
    const error = captureValidationError(() => coerceStartWorkflowId(42, 'options.id'));

    expect(error).toEqual(new StartWorkflowValidationError('options.id must be a string'));
  });

  it('wraps invalid workflow ids in a start workflow validation error', () => {
    const error = captureValidationError(() => coerceStartWorkflowId('', 'options.id'));

    expect(error).toEqual(
      new StartWorkflowValidationError('options.id must not be an empty string'),
    );
  });

  it('validates idempotency keys as non-empty strings within the byte limit', () => {
    expect(coerceStartWorkflowIdempotencyKey('dedupe-key', 'options.idempotencyKey')).toBe(
      'dedupe-key',
    );
    expect(() => coerceStartWorkflowIdempotencyKey(42, 'options.idempotencyKey')).toThrow(
      new StartWorkflowValidationError('options.idempotencyKey must be a string'),
    );
    expect(() => coerceStartWorkflowIdempotencyKey('', 'options.idempotencyKey')).toThrow(
      new StartWorkflowValidationError('options.idempotencyKey must not be empty'),
    );
    expect(() =>
      coerceStartWorkflowIdempotencyKey(
        'x'.repeat(MAX_IDEMPOTENCY_KEY_BYTES + 1),
        'options.idempotencyKey',
      ),
    ).toThrow(
      new StartWorkflowValidationError(
        `options.idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes`,
      ),
    );
  });

  it('returns valid millisecond timestamps unchanged', () => {
    expect(coerceStartWorkflowTimestamp(1_234, 'options.startAt')).toBe(1_234);
  });

  it('rejects timestamps that are negative or non-integer', () => {
    expect(() => coerceStartWorkflowTimestamp(-1, 'options.startAt')).toThrow(
      new StartWorkflowValidationError(
        'options.startAt must be a non-negative integer millisecond timestamp',
      ),
    );
    expect(() => coerceStartWorkflowTimestamp(1.5, 'options.startAt')).toThrow(
      new StartWorkflowValidationError(
        'options.startAt must be a non-negative integer millisecond timestamp',
      ),
    );
  });

  it('parses valid workflow durations', () => {
    expect(parseStartWorkflowDuration('5s', 'options.startAfter')).toBe(5_000);
    expect(parseStartWorkflowDuration(2_500, 'options.executionTimeout')).toBe(2_500);
  });

  it('wraps invalid workflow durations in a validation error', () => {
    expect(() => parseStartWorkflowDuration('later', 'options.startAfter')).toThrow(
      new StartWorkflowValidationError(
        'options.startAfter must be a finite, non-negative number or a valid duration string',
      ),
    );
  });

  it('returns a validated duration in its original representation', () => {
    expect(coerceStartWorkflowDuration('5s', 'options.startAfter')).toBe('5s');
    expect(coerceStartWorkflowDuration(2_500, 'options.executionTimeout')).toBe(2_500);
  });

  it('rejects duration values that are neither strings nor numbers', () => {
    const error = captureValidationError(() =>
      coerceStartWorkflowDuration(false, 'options.startAfter'),
    );

    expect(error).toEqual(
      new StartWorkflowValidationError(
        'options.startAfter must be a finite, non-negative number or valid duration string',
      ),
    );
  });

  it('normalizes valid workflow tags in their original order', () => {
    expect(coerceStartWorkflowTags(['alpha', ' beta '], 'options.tags')).toEqual([
      'alpha',
      ' beta ',
    ]);
  });

  it('rejects non-array and non-string tag values', () => {
    expect(() => coerceStartWorkflowTags('alpha', 'options.tags')).toThrow(
      new StartWorkflowValidationError('options.tags must be an array of strings'),
    );
    expect(() => coerceStartWorkflowTags(['alpha', 2], 'options.tags')).toThrow(
      new StartWorkflowValidationError('options.tags must contain only strings'),
    );
  });

  it('rejects empty and oversized workflow tags', () => {
    expect(() => coerceStartWorkflowTags(['   '], 'options.tags')).toThrow(
      new StartWorkflowValidationError('options.tags must not contain empty tags'),
    );
    expect(() =>
      coerceStartWorkflowTags(['x'.repeat(MAX_WORKFLOW_TAG_BYTES + 1)], 'options.tags'),
    ).toThrow(
      new StartWorkflowValidationError(
        `options.tags tags must be at most ${MAX_WORKFLOW_TAG_BYTES} UTF-8 bytes each`,
      ),
    );
  });
});

describe('assertValidOnTerminalConflict', () => {
  it('accepts undefined options, undefined policy, and the default error policy', () => {
    expect(() => assertValidOnTerminalConflict(undefined)).not.toThrow();
    expect(() => assertValidOnTerminalConflict({})).not.toThrow();
    expect(() => assertValidOnTerminalConflict({ onTerminalConflict: 'error' })).not.toThrow();
  });

  it("accepts 'start-new' with an explicit id and no idempotency key", () => {
    expect(() =>
      assertValidOnTerminalConflict({ onTerminalConflict: 'start-new', id: 'wf-1' }),
    ).not.toThrow();
  });

  it('rejects an unknown policy value', () => {
    const error = captureValidationError(() =>
      assertValidOnTerminalConflict({ onTerminalConflict: 'restart', id: 'wf-1' }),
    );
    expect(error.message).toContain("must be 'error' or 'start-new'");
  });

  it("rejects 'start-new' combined with an idempotency key", () => {
    const error = captureValidationError(() =>
      assertValidOnTerminalConflict({ onTerminalConflict: 'start-new', idempotencyKey: 'k' }),
    );
    expect(error.message).toContain('mutually exclusive with options.idempotencyKey');
  });

  it("rejects 'start-new' without an explicit id", () => {
    const error = captureValidationError(() =>
      assertValidOnTerminalConflict({ onTerminalConflict: 'start-new' }),
    );
    expect(error.message).toContain('requires an explicit options.id');
  });

  it('reports the idempotency-key conflict before the missing-id requirement', () => {
    // Both invariants are violated (no id, has idempotencyKey); the
    // idempotency-key message wins so the caller fixes the contradictory option
    // rather than just adding an id.
    const error = captureValidationError(() =>
      assertValidOnTerminalConflict({ onTerminalConflict: 'start-new', idempotencyKey: 'k' }),
    );
    expect(error.message).toContain('mutually exclusive with options.idempotencyKey');
  });
});

describe('assertOnTerminalConflictUnsupported', () => {
  it('accepts undefined options and options without the policy', () => {
    expect(() => assertOnTerminalConflictUnsupported(undefined, 'startOrSignal')).not.toThrow();
    expect(() => assertOnTerminalConflictUnsupported({}, 'startOrSignal')).not.toThrow();
  });

  it('rejects any present onTerminalConflict, naming the surface', () => {
    const error = captureValidationError(() =>
      assertOnTerminalConflictUnsupported({ onTerminalConflict: 'start-new' }, 'startOrSignal'),
    );
    expect(error.message).toContain('startOrSignal does not support options.onTerminalConflict');
  });

  it("rejects even the 'error' policy value as smuggled-in on an unsupported surface", () => {
    // The runtime backstop rejects any DEFINED value — even the harmless default
    // `'error'` — because the surface does not negotiate the value, it simply does
    // not accept the option at all. (A key present with an `undefined` value is
    // indistinguishable from an absent key, so that case is allowed; see above.)
    const error = captureValidationError(() =>
      assertOnTerminalConflictUnsupported({ onTerminalConflict: 'error' }, 'startOrSignal'),
    );
    expect(error.message).toContain('available on engine.start only');
  });
});
