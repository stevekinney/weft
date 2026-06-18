import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory';
import { decode } from './codec';
import {
  checkExpiredDeadlines,
  cleanupDeadlineOperations,
  createDeadlineOperations,
  timeRemaining,
  WorkflowTimeoutError,
} from './timeouts';
import { HISTORY_CIRCUIT_BREAKER_REASON } from './types/history-policy';

// ---------------------------------------------------------------------------
// createDeadlineOperations
// ---------------------------------------------------------------------------

describe('createDeadlineOperations', () => {
  it('produces a PUT operation with the correct key format', () => {
    const startedAt = 1_000_000;
    const operations = createDeadlineOperations('wf-abc', startedAt, '30 seconds');

    expect(operations).toHaveLength(1);
    expect(operations[0]!.type).toBe('put');

    const putOperation = operations[0] as { type: 'put'; key: string; value: Uint8Array };
    // startedAt + 30_000ms = 1_030_000
    expect(putOperation.key).toBe('wf-deadline:0000000001030000:wf-abc');

    const decoded = decode(putOperation.value) as { workflowId: string; deadline: number };
    expect(decoded.workflowId).toBe('wf-abc');
    expect(decoded.deadline).toBe(1_030_000);
  });

  it('produces a deadline key that is zero-padded for lexicographic sorting', () => {
    const earlyOperations = createDeadlineOperations('wf-1', 100, 50);
    const lateOperations = createDeadlineOperations('wf-2', 100, 5_000_000);

    const earlyKey = (earlyOperations[0] as { type: 'put'; key: string }).key;
    const lateKey = (lateOperations[0] as { type: 'put'; key: string }).key;

    // Lexicographic comparison should match numeric comparison
    expect(earlyKey < lateKey).toBe(true);
  });

  it('rounds fractional deadlines up before encoding the key and payload', () => {
    const operations = createDeadlineOperations('wf-fractional', 1_000, '0.1ms');
    const putOperation = operations[0] as { type: 'put'; key: string; value: Uint8Array };

    expect(putOperation.key).toBe('wf-deadline:0000000000001001:wf-fractional');

    const decoded = decode(putOperation.value) as { workflowId: string; deadline: number };
    expect(decoded.workflowId).toBe('wf-fractional');
    expect(decoded.deadline).toBe(1_001);
  });
});

// ---------------------------------------------------------------------------
// checkExpiredDeadlines
// ---------------------------------------------------------------------------

describe('checkExpiredDeadlines', () => {
  it('returns expired workflows', async () => {
    const storage = new MemoryStorage();
    const now = 2_000_000;

    // Store a deadline in the past
    const operations = createDeadlineOperations('wf-expired', 1_000_000, 500_000);
    await storage.batch(operations);

    const expired = await checkExpiredDeadlines(storage, now);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.workflowId).toBe('wf-expired');
    expect(expired[0]!.deadline).toBe(1_500_000);
  });

  it('does NOT return future deadlines', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;

    // Store a deadline in the future
    const operations = createDeadlineOperations('wf-future', 1_000_000, 5_000_000);
    await storage.batch(operations);

    const expired = await checkExpiredDeadlines(storage, now);
    expect(expired).toHaveLength(0);
  });

  it('returns empty when no deadlines are expired', async () => {
    const storage = new MemoryStorage();
    const expired = await checkExpiredDeadlines(storage, Date.now());
    expect(expired).toEqual([]);
  });

  it('returns only expired deadlines in chronological order when multiple exist', async () => {
    const storage = new MemoryStorage();
    const now = 3_000_000;

    // Three deadlines: two expired (at 1.5M and 2M), one future (at 5M)
    const operations1 = createDeadlineOperations('wf-first', 1_000_000, 500_000); // deadline 1_500_000
    const operations2 = createDeadlineOperations('wf-second', 1_000_000, 1_000_000); // deadline 2_000_000
    const operations3 = createDeadlineOperations('wf-future', 1_000_000, 5_000_000); // deadline 6_000_000

    await storage.batch([...operations1, ...operations2, ...operations3]);

    const expired = await checkExpiredDeadlines(storage, now);
    expect(expired).toHaveLength(2);
    // Should be in chronological order (earliest deadline first)
    expect(expired[0]!.workflowId).toBe('wf-first');
    expect(expired[0]!.deadline).toBe(1_500_000);
    expect(expired[1]!.workflowId).toBe('wf-second');
    expect(expired[1]!.deadline).toBe(2_000_000);
  });
});

// ---------------------------------------------------------------------------
// cleanupDeadlineOperations
// ---------------------------------------------------------------------------

describe('cleanupDeadlineOperations', () => {
  it('produces a DELETE operation with the correct key', () => {
    const operations = cleanupDeadlineOperations('wf-abc', 1_030_000);

    expect(operations).toHaveLength(1);
    expect(operations[0]!.type).toBe('delete');
    expect((operations[0] as { type: 'delete'; key: string }).key).toBe(
      'wf-deadline:0000000001030000:wf-abc',
    );
  });
});

// ---------------------------------------------------------------------------
// timeRemaining
// ---------------------------------------------------------------------------

describe('timeRemaining', () => {
  it('returns a positive number when before the deadline', () => {
    const remaining = timeRemaining(2_000_000, 1_000_000);
    expect(remaining).toBe(1_000_000);
    expect(remaining).toBeGreaterThan(0);
  });

  it('returns 0 or negative when past the deadline', () => {
    const atDeadline = timeRemaining(1_000_000, 1_000_000);
    expect(atDeadline).toBeLessThanOrEqual(0);

    const pastDeadline = timeRemaining(1_000_000, 2_000_000);
    expect(pastDeadline).toBeLessThan(0);
  });

  it('returns Infinity when no deadline is set', () => {
    expect(timeRemaining(undefined, 1_000_000)).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// WorkflowTimeoutError
// ---------------------------------------------------------------------------

describe('WorkflowTimeoutError', () => {
  it('has correct properties', () => {
    const error = new WorkflowTimeoutError('wf-123', 'execution', 30_000);

    expect(error.workflowId).toBe('wf-123');
    expect(error.timeoutType).toBe('execution');
    expect(error.elapsed).toBe(30_000);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WorkflowTimeoutError);
    expect(error.name).toBe('WorkflowTimeoutError');
  });

  it('has a descriptive message', () => {
    const error = new WorkflowTimeoutError('wf-456', 'run', 60_000);

    expect(error.message).toContain('wf-456');
    expect(error.message).toContain('run');
    expect(error.message).toContain('60000');
  });

  it('leaves terminationReason undefined for an ordinary deadline timeout', () => {
    const error = new WorkflowTimeoutError('wf-789', 'execution', 1_000);

    expect(error.terminationReason).toBeUndefined();
  });

  it('carries the circuit-breaker termination reason when provided', () => {
    const error = new WorkflowTimeoutError(
      'wf-cb',
      'execution',
      1_000,
      HISTORY_CIRCUIT_BREAKER_REASON,
    );

    expect(error.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);
  });
});
