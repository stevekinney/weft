import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  advanceTimersByTime,
  flushMicrotasks,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import {
  createSchedulerContractContext,
  describeSchedulerContract,
  type SchedulerContractContext,
} from '../testing/scheduler-contract.test-support.ts';

import { KEYS, type BatchOperation, type ScanOptions } from '../storage/interface';
import { decode, encode } from './codec';
import { buildTimerBatchOperations, calculateBackoff, parseDuration, Scheduler } from './scheduler';
import type { TimerEntry } from './types';

const EXPECTED_EXPIRED_TIMER_SCAN_LIMIT = 1_000;

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('passes through a numeric value as milliseconds', () => {
    expect(parseDuration(5000)).toBe(5000);
  });

  it('parses "30 seconds" to 30000', () => {
    expect(parseDuration('30 seconds')).toBe(30000);
  });

  it('parses "30s" to 30000', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('parses "1 hour" to 3600000', () => {
    expect(parseDuration('1 hour')).toBe(3600000);
  });

  it('parses "24 hours" to 86400000', () => {
    expect(parseDuration('24 hours')).toBe(86400000);
  });

  it('parses "7 days" to 604800000', () => {
    expect(parseDuration('7 days')).toBe(604800000);
  });

  it('parses "500ms" to 500', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('parses "500 milliseconds" to 500', () => {
    expect(parseDuration('500 milliseconds')).toBe(500);
  });

  it('parses "2.5 minutes" to 150000', () => {
    expect(parseDuration('2.5 minutes')).toBe(150000);
  });

  it('parses singular "1 second" to 1000', () => {
    expect(parseDuration('1 second')).toBe(1000);
  });

  it('parses singular "1 minute" to 60000', () => {
    expect(parseDuration('1 minute')).toBe(60000);
  });

  it('parses singular "1 day" to 86400000', () => {
    expect(parseDuration('1 day')).toBe(86400000);
  });

  it('returns 0 for numeric 0', () => {
    expect(parseDuration(0)).toBe(0);
  });

  it('passes through a fractional numeric duration as milliseconds', () => {
    expect(parseDuration(1.5)).toBe(1.5);
  });

  it('throws for a negative numeric duration', () => {
    expect(() => parseDuration(-1)).toThrow(
      'Duration must resolve to a finite, non-negative number of milliseconds',
    );
  });

  it('throws for a non-finite numeric duration', () => {
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(
      'Duration must resolve to a finite, non-negative number of milliseconds',
    );
  });

  it('parses a duration string that resolves to fractional milliseconds', () => {
    expect(parseDuration('0.1ms')).toBe(0.1);
  });

  it('throws for an unparseable string', () => {
    expect(() => parseDuration('invalid')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// calculateBackoff
// ---------------------------------------------------------------------------

describe('calculateBackoff', () => {
  it('returns initialBackoff for attempt 1', () => {
    const result = calculateBackoff(1, {
      maxAttempts: 5,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(1000);
  });

  it('returns initialBackoff * multiplier for attempt 2', () => {
    const result = calculateBackoff(2, {
      maxAttempts: 5,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(2000);
  });

  it('returns initialBackoff * multiplier^2 for attempt 3', () => {
    const result = calculateBackoff(3, {
      maxAttempts: 5,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(4000);
  });

  it('caps the result at maxBackoff', () => {
    const result = calculateBackoff(10, {
      maxAttempts: 15,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(30000);
  });

  it('works with string durations in the policy', () => {
    const result = calculateBackoff(1, {
      maxAttempts: 5,
      initialBackoff: '2 seconds',
      backoffMultiplier: 2,
      maxBackoff: '1 minute',
    });
    expect(result).toBe(2000);
  });

  it('preserves fractional backoff results for callers that sleep on them', () => {
    const result = calculateBackoff(5, {
      maxAttempts: 5,
      initialBackoff: 1000,
      backoffMultiplier: 1.5,
      maxBackoff: 30_000,
    });

    expect(result).toBe(5062.5);
    expect(parseDuration(result)).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describeSchedulerContract({
  name: 'core',
  createScheduler(context) {
    // Core's `cancel(id, workflowId)` already matches `ContractScheduler`, so
    // the instance is returned directly without a wrapper.
    return new Scheduler({
      storage: context.storage,
      onTimerFired: (entry) => {
        context.firedEntries.push(entry);
      },
      pollIntervalMs: 100,
      getNow: () => context.getCurrentTime(),
    });
  },
});

// ---------------------------------------------------------------------------
// Scheduler — implementation-specific (core only). Sibling describe with its
// own hooks so it does not share the contract's lifecycle.
// ---------------------------------------------------------------------------

describe('Scheduler — implementation-specific', () => {
  let context: SchedulerContractContext;
  let storage: SchedulerContractContext['storage'];
  let firedEntries: TimerEntry[];
  let scheduler: Scheduler;

  /** Current fake time, read through the shared context. */
  const now = () => context.getCurrentTime();

  beforeEach(() => {
    context = createSchedulerContractContext();
    ({ storage, firedEntries } = context);

    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      pollIntervalMs: 100,
      getNow: () => context.getCurrentTime(),
    });
  });

  afterEach(() => {
    scheduler[Symbol.dispose]();
    restoreRealTimers();
  });

  const makeTimer = (overrides: Partial<TimerEntry> = {}): TimerEntry =>
    context.makeTimer(overrides);
  const collectStorageKeys = () => context.collectStorageKeys();

  it('limits each expired timer source scan and drains a larger backlog across ticks with one cleanup batch per tick', async () => {
    const timerCount = EXPECTED_EXPIRED_TIMER_SCAN_LIMIT + 2;
    await storage.batch(
      Array.from({ length: timerCount }, (_, index) =>
        buildTimerBatchOperations(
          makeTimer({
            id: `limited-timer-${String(index).padStart(4, '0')}`,
            workflowId: `limited-workflow-${String(index).padStart(4, '0')}`,
            fireAt: now() - 1000,
          }),
        ),
      ).flat(),
    );

    const originalScan = storage.scan.bind(storage);
    const scanOptionsByPrefix = new Map<string, ScanOptions | undefined>();
    storage.scan = (prefix, options) => {
      scanOptionsByPrefix.set(prefix, options);
      return originalScan(prefix, options);
    };

    const originalBatch = storage.batch.bind(storage);
    let cleanupBatches: BatchOperation[][] = [];
    storage.batch = async (operations) => {
      cleanupBatches.push(operations);
      return originalBatch(operations);
    };

    await scheduler.tick(now());

    expect(scanOptionsByPrefix.get('wf-deadline:')?.limit).toBe(EXPECTED_EXPIRED_TIMER_SCAN_LIMIT);
    expect(scanOptionsByPrefix.get('wf-delayed:')?.limit).toBe(EXPECTED_EXPIRED_TIMER_SCAN_LIMIT);
    expect(scanOptionsByPrefix.get('schedule-due:')?.limit).toBe(EXPECTED_EXPIRED_TIMER_SCAN_LIMIT);
    expect(scanOptionsByPrefix.get('wf-cleanup:')?.limit).toBe(EXPECTED_EXPIRED_TIMER_SCAN_LIMIT);
    expect(firedEntries).toHaveLength(EXPECTED_EXPIRED_TIMER_SCAN_LIMIT);
    expect(cleanupBatches).toHaveLength(1);
    expect(cleanupBatches[0]).toHaveLength(EXPECTED_EXPIRED_TIMER_SCAN_LIMIT * 2);

    let remainingKeys = await collectStorageKeys();
    expect(remainingKeys.filter((key) => key.startsWith('wf-deadline:'))).toHaveLength(2);
    expect(remainingKeys.filter((key) => key.startsWith('timer-idx:'))).toHaveLength(2);

    firedEntries.length = 0;
    cleanupBatches = [];
    scanOptionsByPrefix.clear();

    await scheduler.tick(now());

    expect(firedEntries).toHaveLength(2);
    expect(cleanupBatches).toHaveLength(1);
    expect(cleanupBatches[0]).toHaveLength(4);
    remainingKeys = await collectStorageKeys();
    expect(remainingKeys.filter((key) => key.startsWith('wf-deadline:'))).toHaveLength(0);
    expect(remainingKeys.filter((key) => key.startsWith('timer-idx:'))).toHaveLength(0);
  });

  it('rounds fractional timer fireAt values up before persisting them', async () => {
    const entry = makeTimer({ fireAt: 1_000_000.1 });
    await scheduler.schedule(entry);

    const storedValue = await storage.get('wf-deadline:0000000001000001:timer-1');
    expect(storedValue).not.toBeNull();

    const storedEntry = decode(storedValue!) as TimerEntry;
    expect(storedEntry.fireAt).toBe(1_000_001);
  });

  it('does not read a timer index when firing a terminal cleanup timer', async () => {
    const entry = makeTimer({
      id: 'terminal-cleanup:cleanup-token',
      fireAt: now() - 1000,
      kind: 'terminal-cleanup',
    });
    await scheduler.schedule(entry);

    const timerIndexKey = `timer-idx:${entry.id}`;
    const originalGet = storage.get.bind(storage);
    let timerIndexReadCount = 0;

    storage.get = async (key) => {
      if (key === timerIndexKey) {
        timerIndexReadCount++;
      }

      return originalGet(key);
    };

    await scheduler.tick(now());

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe(entry.id);
    expect(timerIndexReadCount).toBe(0);
  });

  it('preserves stable ordering when expired deadline and delayed-start timers share a fireAt', async () => {
    const deadlineEntry = makeTimer({
      id: 'deadline-workflow-1',
      workflowId: 'workflow-1',
      fireAt: now() - 1000,
      kind: 'execution-deadline',
    });
    const delayedStartEntry = makeTimer({
      id: 'delayed-start:workflow-2',
      workflowId: 'workflow-2',
      fireAt: now() - 1000,
      kind: 'delayed-start',
    });

    await scheduler.schedule(delayedStartEntry);
    await scheduler.schedule(deadlineEntry);

    await scheduler.tick(now());

    expect(firedEntries.map((entry) => entry.id)).toEqual([
      'deadline-workflow-1',
      'delayed-start:workflow-2',
    ]);
  });

  it('start is idempotent (calling start twice does not create duplicate intervals)', async () => {
    scheduler.start();
    scheduler.start(); // second call should be a no-op
    scheduler.stop();
    // No assertion needed -- just verifying it doesn't throw or create duplicate intervals
  });

  it('Symbol.dispose stops the polling interval', async () => {
    useFakeTimers(now());
    scheduler[Symbol.dispose]();
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      pollIntervalMs: 100,
      getNow: () => now(),
    });

    scheduler.start();
    scheduler[Symbol.dispose]();

    // Schedule a timer that would fire
    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    // Wait for what would be a poll cycle
    await advanceTimersByTime(200);
    await flushMicrotasks(20);

    expect(firedEntries).toHaveLength(0);
  });

  it('does not fire after dispose', async () => {
    useFakeTimers(now());
    scheduler[Symbol.dispose]();
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      pollIntervalMs: 100,
      getNow: () => now(),
    });

    scheduler.start();

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler[Symbol.dispose]();

    // Wait for what would be a poll cycle
    await advanceTimersByTime(200);
    await flushMicrotasks(20);

    expect(firedEntries).toHaveLength(0);
  });

  it('polling loop fires expired timers automatically', async () => {
    useFakeTimers(now());

    // Use a very short poll interval so the interval actually fires
    scheduler[Symbol.dispose]();
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      pollIntervalMs: 20,
      getNow: () => now(),
    });

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    await advanceTimersByTime(20);
    await flushMicrotasks(20);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('removes corrupted timer entries from storage and processes valid timers', async () => {
    // Write a garbage value directly under a wf-deadline: key to simulate corruption.
    // The encoded value is a plain string, which isTimerEntry() will reject.
    const corruptedFireAt = now() - 2000;
    const corruptedKey = KEYS.deadline(corruptedFireAt, 'corrupted-id');
    await storage.put(corruptedKey, encode('this is not a TimerEntry'));

    // Schedule a real timer that expires before now.
    const validEntry = makeTimer({ id: 'timer-valid', fireAt: now() - 1000 });
    await scheduler.schedule(validEntry);

    await scheduler.tick(now());

    // The valid timer must have fired.
    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-valid');

    // After tick(), no wf-deadline: keys should remain — both the corrupted key
    // and the valid timer's deadline key must have been deleted.
    const remainingKeys = await collectStorageKeys();
    const remainingDeadlines = remainingKeys.filter((key) => key.startsWith('wf-deadline:'));
    expect(remainingDeadlines).toHaveLength(0);

    // The valid timer's index key must also have been cleaned up.
    const remainingIndexes = remainingKeys.filter((key) => key.startsWith('timer-idx:'));
    expect(remainingIndexes).toHaveLength(0);
  });

  it('removes timer entries with invalid kinds before they can fire', async () => {
    const invalidKey = KEYS.deadline(now() - 2000, 'invalid-kind');
    await storage.put(
      invalidKey,
      encode({
        id: 'invalid-kind',
        workflowId: 'workflow-1',
        fireAt: now() - 2000,
        kind: 'definitely-not-a-real-kind',
      }),
    );

    const validEntry = makeTimer({ id: 'timer-valid', fireAt: now() - 1000 });
    await scheduler.schedule(validEntry);

    await scheduler.tick(now());

    expect(firedEntries.map((entry) => entry.id)).toEqual(['timer-valid']);

    const remainingKeys = await collectStorageKeys();
    const remainingDeadlines = remainingKeys.filter((key) => key.startsWith('wf-deadline:'));
    expect(remainingDeadlines).toHaveLength(0);
  });

  it('continues processing remaining timers when a callback throws on one', async () => {
    let callCount = 0;
    scheduler[Symbol.dispose]();
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        callCount++;
        firedEntries.push(entry);
        if (callCount === 1) {
          throw new Error('callback error on first timer');
        }
      },
      pollIntervalMs: 100,
      getNow: () => now(),
    });

    const entry1 = makeTimer({ id: 'timer-throw', fireAt: now() - 2000 });
    const entry2 = makeTimer({ id: 'timer-ok', fireAt: now() - 1000 });

    await scheduler.schedule(entry1);
    await scheduler.schedule(entry2);

    await scheduler.tick(now());

    // Both callbacks were invoked despite the first one throwing
    expect(firedEntries).toHaveLength(2);
    expect(firedEntries[0]!.id).toBe('timer-throw');
    expect(firedEntries[1]!.id).toBe('timer-ok');

    // The successful timer was cleaned up; the failed timer is retained for retry
    const remainingKeys = await collectStorageKeys();
    const remainingDeadlines = remainingKeys.filter((key) => key.startsWith('wf-deadline:'));
    const remainingIndexes = remainingKeys.filter((key) => key.startsWith('timer-idx:'));
    expect(remainingDeadlines).toHaveLength(1);
    expect(remainingIndexes).toHaveLength(1);
    expect(remainingIndexes[0]).toBe('timer-idx:timer-throw');
  });

  it('tick is a no-op after stop, preventing callbacks on disposed scheduler', async () => {
    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler.stop();

    // Calling tick after stop should not fire any callbacks
    await scheduler.tick(now());

    expect(firedEntries).toHaveLength(0);
  });

  it('start resets the stopped flag so tick works again', async () => {
    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler.stop();
    await scheduler.tick(now());
    expect(firedEntries).toHaveLength(0);

    // Restart and verify tick works again
    scheduler.start();
    await scheduler.tick(now());
    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('flush works after stop (drains remaining timers)', async () => {
    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    // Stop the scheduler (halts the polling loop)
    scheduler.stop();

    // flush() should still process expired timers despite stop() having been called
    await scheduler.flush(now());

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
  });

  it('tick terminates early when stop is called during callback processing', async () => {
    // Create a scheduler where the first callback calls stop()
    scheduler[Symbol.dispose]();

    const fired: string[] = [];
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        fired.push(entry.id);
        if (entry.id === 'timer-a') {
          // Calling stop() mid-tick should prevent subsequent callbacks
          scheduler.stop();
        }
      },
      pollIntervalMs: 100,
      getNow: () => now(),
    });

    const entryA = makeTimer({ id: 'timer-a', fireAt: now() - 2000 });
    const entryB = makeTimer({ id: 'timer-b', fireAt: now() - 1000 });

    await scheduler.schedule(entryA);
    await scheduler.schedule(entryB);

    await scheduler.tick(now());

    // Only timer-a should have fired; timer-b should be skipped because
    // stop() was called during the first callback
    expect(fired).toEqual(['timer-a']);
  });
});
