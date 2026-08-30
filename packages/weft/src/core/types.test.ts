import { describe, expect, it } from 'bun:test';

import type { OperationOutcome, WorkflowStatus } from './types';
import {
  DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_POLICY,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
} from './types';

describe('DEFAULT_RETRY_POLICY', () => {
  it('has maxAttempts of 3', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });

  it('has initialBackoff of 1000', () => {
    expect(DEFAULT_RETRY_POLICY.initialBackoff).toBe(1000);
  });

  it('has backoffMultiplier of 2', () => {
    expect(DEFAULT_RETRY_POLICY.backoffMultiplier).toBe(2);
  });

  it('has maxBackoff of 30000', () => {
    expect(DEFAULT_RETRY_POLICY.maxBackoff).toBe(30_000);
  });
});

describe('default constants', () => {
  it('DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD is 65536', () => {
    expect(DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD).toBe(65_536);
  });

  it('DEFAULT_MAX_NESTING_DEPTH is 10', () => {
    expect(DEFAULT_MAX_NESTING_DEPTH).toBe(10);
  });

  it('DEFAULT_POLL_INTERVAL_MS is 1000', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(1000);
  });

  it('DEFAULT_VISIBILITY_TIMEOUT_MS is 30000', () => {
    expect(DEFAULT_VISIBILITY_TIMEOUT_MS).toBe(30_000);
  });
});

/**
 * If a status is missing from the switch, TypeScript will report a
 * compile error because the default branch assigns a non-`never`
 * value to `_exhaustive: never`.
 */
function statusLabel(status: WorkflowStatus): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'timed-out':
      return 'timed-out';
    case 'suspended':
      return 'suspended';
    default: {
      const _exhaustive: never = status;
      throw new Error('Unhandled status: ' + String(_exhaustive));
    }
  }
}

describe('WorkflowStatus type', () => {
  it('covers all seven states exhaustively', () => {
    const allStatuses: WorkflowStatus[] = [
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled',
      'timed-out',
      'suspended',
    ];

    for (const status of allStatuses) {
      expect(statusLabel(status)).toBe(status);
    }
  });
});

describe('OperationOutcome discriminated union', () => {
  it('narrows to completed with a value', () => {
    const outcome: OperationOutcome = { status: 'completed', value: 42 };

    if (outcome.status === 'completed') {
      expect(outcome.value).toBe(42);
    } else {
      // This branch should not be reached; if it is, the test fails.
      expect(true).toBe(false);
    }
  });

  it('narrows to failed with an error and optional failure metadata', () => {
    const outcome: OperationOutcome = {
      status: 'failed',
      error: 'boom',
      errorName: 'ReviewTimeoutError',
      failureCategory: 'timeout',
    };

    if (outcome.status === 'failed') {
      expect(outcome.error).toBe('boom');
      expect(outcome.errorName).toBe('ReviewTimeoutError');
      expect(outcome.failureCategory).toBe('timeout');
    } else {
      expect(true).toBe(false);
    }
  });
});
