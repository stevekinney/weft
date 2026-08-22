import { describe, expect, it } from 'bun:test';

import { WeftError, isWeftErrorCode } from '../weft-error.ts';
import {
  EngineDeposedError,
  EngineLeaseAcquisitionTimeoutError,
  EngineLeaseCorruptedError,
  EngineLeaseNotHeldError,
  OwnershipModeMismatchError,
  WorkflowClaimUnavailableError,
} from './lease-errors.ts';

describe('EngineDeposedError', () => {
  it('keeps the existing zero-argument constructor working for global ownership: "lease" deposition', () => {
    const error = new EngineDeposedError();
    expect(error).toBeInstanceOf(WeftError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('EngineDeposedError');
    expect(error.name).toBe('EngineDeposedError');
    expect(error.workflowId).toBeUndefined();
    expect(error.message).not.toContain('workflow "');
  });

  it('folds the workflow id into the message only when supplied, for ownership: "workflow-lease"', () => {
    const error = new EngineDeposedError('wf-1');
    expect(error.workflowId).toBe('wf-1');
    expect(error.message).toContain('workflow "wf-1"');
  });

  it('does not carry a stable, publicly registered WeftErrorCode', () => {
    // Internal-only per ADR 0002: never surfaced to user code, so it is
    // intentionally absent from the public WeftErrorCode union.
    expect(isWeftErrorCode(new EngineDeposedError().code)).toBe(false);
  });
});

describe('WorkflowClaimUnavailableError', () => {
  it('carries workflowId and heldBy', () => {
    const error = new WorkflowClaimUnavailableError('wf-1', 'engine-a');
    expect(error).toBeInstanceOf(WeftError);
    expect(error.code).toBe('WorkflowClaimUnavailableError');
    expect(error.name).toBe('WorkflowClaimUnavailableError');
    expect(error.workflowId).toBe('wf-1');
    expect(error.heldBy).toBe('engine-a');
    expect(error.message).toContain('wf-1');
    expect(error.message).toContain('engine-a');
  });

  it('accepts a null heldBy when the holder was concurrently deleted', () => {
    const error = new WorkflowClaimUnavailableError('wf-1', null);
    expect(error.heldBy).toBeNull();
    expect(error.message).toContain('wf-1');
  });

  it('does not carry a stable, publicly registered WeftErrorCode', () => {
    // Matches the existing EngineLease* precedent per ADR 0002.
    expect(isWeftErrorCode(new WorkflowClaimUnavailableError('wf-1', null).code)).toBe(false);
  });
});

describe('OwnershipModeMismatchError', () => {
  it('carries configuredMode, storedMode, and establishedAt', () => {
    const establishedAt = 1_700_000_000_000;
    const error = new OwnershipModeMismatchError('workflow-lease', 'lease', establishedAt);
    expect(error).toBeInstanceOf(WeftError);
    expect(error.code).toBe('OwnershipModeMismatchError');
    expect(error.name).toBe('OwnershipModeMismatchError');
    expect(error.configuredMode).toBe('workflow-lease');
    expect(error.storedMode).toBe('lease');
    expect(error.establishedAt).toBe(establishedAt);
    expect(error.message).toContain('workflow-lease');
    expect(error.message).toContain('lease');
  });

  it('carries a stable, publicly registered WeftErrorCode', () => {
    // Unlike the other lease errors in this module, this one is a
    // configuration-time boot blocker operators route and alert on.
    expect(isWeftErrorCode(new OwnershipModeMismatchError('lease', 'workflow-lease', 0).code)).toBe(
      true,
    );
  });
});

// A minimal sanity check that the pre-existing lease errors were not disturbed
// by the additions above; their own behavior is otherwise exercised at their
// production call sites (lease-manager.test.ts, lease-ownership.test.ts).
describe('pre-existing lease errors remain intact', () => {
  it('EngineLeaseAcquisitionTimeoutError still constructs', () => {
    expect(new EngineLeaseAcquisitionTimeoutError(1_000, null)).toBeInstanceOf(WeftError);
  });

  it('EngineLeaseCorruptedError still constructs', () => {
    expect(new EngineLeaseCorruptedError('detail')).toBeInstanceOf(WeftError);
  });

  it('EngineLeaseNotHeldError still constructs', () => {
    expect(new EngineLeaseNotHeldError()).toBeInstanceOf(WeftError);
  });
});
