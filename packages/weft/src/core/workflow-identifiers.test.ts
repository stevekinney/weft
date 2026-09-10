import { describe, expect, it } from 'bun:test';

import { assertValidWorkflowId, isDecodableWorkflowId } from './workflow-identifiers.ts';

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
});
