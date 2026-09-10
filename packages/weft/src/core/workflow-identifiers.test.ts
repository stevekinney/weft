import { describe, expect, it } from 'bun:test';

import {
  assertDecodableWorkflowId,
  assertValidWorkflowId,
  isDecodableWorkflowId,
} from './workflow-identifiers.ts';

describe('assertValidWorkflowId', () => {
  it('accepts an ordinary id', () => {
    expect(() => assertValidWorkflowId('workflow-123')).not.toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => assertValidWorkflowId('')).toThrow('must not be an empty string');
  });

  it('rejects the exact strings "." and ".." (WFT-95 admission)', () => {
    expect(() => assertValidWorkflowId('.')).toThrow('must not be "." or ".."');
    expect(() => assertValidWorkflowId('..')).toThrow('must not be "." or ".."');
  });

  it('accepts an id that merely contains a dot character', () => {
    expect(() => assertValidWorkflowId('my.workflow.v2')).not.toThrow();
    expect(() => assertValidWorkflowId('...')).not.toThrow();
  });

  it('rejects an id over the maximum length', () => {
    expect(() => assertValidWorkflowId('x'.repeat(129))).toThrow('must be at most 128 characters');
  });

  it('rejects an id containing a control character', () => {
    expect(() => assertValidWorkflowId('bad\tid')).toThrow('must not contain control characters');
  });
});

describe('isDecodableWorkflowId', () => {
  it('accepts an ordinary id', () => {
    expect(isDecodableWorkflowId('workflow-123')).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(isDecodableWorkflowId('')).toBe(false);
  });

  // Regression (WFT-95 review): unlike `assertValidWorkflowId`, this
  // decode-facing predicate must keep accepting "." and ".." — ids that were
  // valid before WFT-95 and may already be durably persisted (a schedule id,
  // a persisted currentWorkflowId, a queued run's workflowId, schedule-run
  // metadata). Decoding must not strand that data on upgrade.
  it('accepts the exact strings "." and ".." (decode exemption)', () => {
    expect(isDecodableWorkflowId('.')).toBe(true);
    expect(isDecodableWorkflowId('..')).toBe(true);
  });

  it('rejects an id over the maximum length', () => {
    expect(isDecodableWorkflowId('x'.repeat(129))).toBe(false);
  });

  it('rejects an id containing a control character', () => {
    expect(isDecodableWorkflowId('bad\tid')).toBe(false);
  });

  // Regression (WFT-95 review, fourth round): a decoded field's static type
  // (`WorkflowState.executionStateOwnerId: string`, etc.) does not guarantee
  // its runtime shape — a corrupted persisted record could carry an array.
  // Without an explicit `typeof` guard, a non-empty array of strings would
  // pass (`.length`, iteration, and `containsControlCharacter()`'s
  // per-element `codePointAt()` all succeed on an array), silently accepting
  // a malformed field instead of dropping it.
  it('rejects non-string values, including a string array', () => {
    expect(isDecodableWorkflowId(42)).toBe(false);
    expect(isDecodableWorkflowId(null)).toBe(false);
    expect(isDecodableWorkflowId(undefined)).toBe(false);
    expect(isDecodableWorkflowId(['a', 'b'])).toBe(false);
  });
});

describe('assertDecodableWorkflowId', () => {
  it('narrows to string and rejects a string array with a clear error', () => {
    expect(() => assertDecodableWorkflowId(['a'], 'x')).toThrow('x must be a string');
    expect(() => assertDecodableWorkflowId(42, 'x')).toThrow('x must be a string');
  });
});
