/**
 * Unit tests for taskResultPayloadSizeError's error-classification branch:
 * a non-PayloadSizeExceededError thrown while measuring the payload (e.g. an
 * encoding failure) must propagate rather than being swallowed as if the
 * payload were merely oversized.
 */

import { describe, expect, it } from 'bun:test';

import { taskResultPayloadSizeError } from './task-result-resolution.ts';

describe('taskResultPayloadSizeError', () => {
  it('returns null when the payload is within the configured limit', () => {
    const error = taskResultPayloadSizeError({ status: 'completed', value: { ok: true } }, 1024);
    expect(error).toBeNull();
  });

  it('returns the PayloadSizeExceededError when the payload exceeds the limit', () => {
    const error = taskResultPayloadSizeError(
      { status: 'completed', value: { blob: 'x'.repeat(200) } },
      64,
    );
    expect(error?.message).toContain('activity result exceeds');
  });

  it('propagates a non-size encoding error instead of treating it as an oversized payload', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() =>
      taskResultPayloadSizeError({ status: 'completed', value: circular }, 1024),
    ).toThrow();
  });
});
