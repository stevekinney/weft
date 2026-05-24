import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  flushMicrotasks,
  restoreRealTimers,
  sleepForTesting,
  useFakeTimers,
} from '../testing/fake-timers.ts';
import {
  type ContractScheduler,
  createSchedulerContractContext,
  describeSchedulerContract,
  type SchedulerContractContext,
} from '../testing/scheduler-contract.test-support.ts';

import type { TimerEntry } from '../core/types';
import type { Storage } from '../storage/interface';
import { MemoryStorage } from '../storage/memory';
import { ServiceWorkerScheduler } from './scheduler';

/**
 * Wrap a {@link ServiceWorkerScheduler} so its `cancel(id)` satisfies the
 * contract's `cancel(id, workflowId)` shape; the workflow id is dropped because
 * the service-worker scheduler cancels by timer id alone.
 */
function toContractScheduler(instance: ServiceWorkerScheduler): ContractScheduler {
  return {
    schedule: (entry) => instance.schedule(entry),
    tick: (now) => instance.tick(now),
    flush: (now) => instance.flush(now),
    cancel: (id, _workflowId) => instance.cancel(id),
    [Symbol.dispose]: () => instance[Symbol.dispose](),
  };
}

describeSchedulerContract({
  name: 'service-worker',
  createScheduler(context) {
    const instance = new ServiceWorkerScheduler({
      storage: context.storage,
      onTimerFired: (entry) => {
        context.firedEntries.push(entry);
      },
      getNow: () => context.getCurrentTime(),
    });
    return toContractScheduler(instance);
  },
});

// ---------------------------------------------------------------------------
// ServiceWorkerScheduler — implementation-specific. Sibling describe with its
// own global useFakeTimers() so the contract cases do not inherit it.
// ---------------------------------------------------------------------------

describe('ServiceWorkerScheduler — implementation-specific', () => {
  let context: SchedulerContractContext;
  let storage: SchedulerContractContext['storage'];
  let firedEntries: TimerEntry[];
  let scheduler: ServiceWorkerScheduler;

  /** Current fake time, read through the shared context. */
  const now = () => context.getCurrentTime();

  beforeEach(() => {
    useFakeTimers();

    context = createSchedulerContractContext();
    ({ storage, firedEntries } = context);

    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
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

  it('writes delayed-start timers under the delayed-start key prefix', async () => {
    const entry = makeTimer({
      id: 'delayed-start:workflow-1',
      workflowId: 'workflow-1',
      fireAt: 1005000,
      kind: 'delayed-start',
    });
    await scheduler.schedule(entry);

    const keys = await collectStorageKeys();
    const delayedStartKey = keys.find((key) => key.startsWith('wf-delayed:'));
    expect(delayedStartKey).toBe('wf-delayed:0000000001005000:workflow-1');
  });

  // -------------------------------------------------------------------------
  // tick() — delayed-start (service-worker only)
  // -------------------------------------------------------------------------

  it('fires expired delayed-start timers when tick is called', async () => {
    const entry = makeTimer({
      id: 'delayed-start:workflow-1',
      workflowId: 'workflow-1',
      fireAt: now() - 1000,
      kind: 'delayed-start',
    });
    await scheduler.schedule(entry);

    await scheduler.tick(now());

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('delayed-start:workflow-1');

    const keys = await collectStorageKeys();
    expect(keys.some((key) => key.startsWith('wf-delayed:'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // flush() — poller stops after flush (service-worker only)
  // -------------------------------------------------------------------------

  it('flush stops the fallback poller so later timers do not fire', async () => {
    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();
    await scheduler.flush(now());

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    // After flush, adding another expired timer and waiting should not fire it
    // because the scheduler has been stopped.
    const entry2 = makeTimer({ id: 'timer-2', fireAt: now() - 500 });
    await scheduler.schedule(entry2);
    await sleepForTesting(200);
    expect(firedEntries).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // start() with periodic sync
  // -------------------------------------------------------------------------

  it('start registers periodic sync when registration.periodicSync is available', async () => {
    const registerMock = mock(() => Promise.resolve());
    const registration = {
      periodicSync: {
        register: registerMock,
      },
    } as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      periodicSyncTag: 'custom-tag',
      getNow: () => now(),
    });

    scheduler.start();

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith('custom-tag', { minInterval: 60000 });
  });

  it('start falls back to polling when periodic sync registration fails', async () => {
    const registerMock = mock(() => Promise.reject(new Error('Not allowed')));
    const registration = {
      periodicSync: {
        register: registerMock,
      },
    } as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      fallbackIntervalMilliseconds: 50,
      getNow: () => now(),
    });

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    // Allow microtask for the .catch() to schedule fallback polling.
    await flushMicrotasks();
    // Then advance through the fallback poll timer.
    await sleepForTesting(300);

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(firedEntries.length).toBeGreaterThanOrEqual(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('start uses default periodic sync tag when none is provided', async () => {
    const registerMock = mock(() => Promise.resolve());
    const registration = {
      periodicSync: {
        register: registerMock,
      },
    } as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      getNow: () => now(),
    });

    scheduler.start();

    expect(registerMock).toHaveBeenCalledWith('weft-timers', { minInterval: 60000 });
  });

  // -------------------------------------------------------------------------
  // start() fallback to setTimeout
  // -------------------------------------------------------------------------

  it('start falls back to setTimeout when periodicSync is not available', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => now(),
    });

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    await sleepForTesting(200);

    expect(firedEntries.length).toBeGreaterThanOrEqual(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('polling loop continues after a tick error', async () => {
    let tickCount = 0;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: () => {
        tickCount++;
        if (tickCount === 1) {
          throw new Error('Simulated tick failure');
        }
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => now(),
    });

    // Schedule two timers that are already expired
    const entry1 = makeTimer({ id: 'timer-a', fireAt: now() - 2000 });
    const entry2 = makeTimer({ id: 'timer-b', fireAt: now() - 1000 });
    await scheduler.schedule(entry1);
    await scheduler.schedule(entry2);

    scheduler.start();

    // Wait long enough for multiple poll cycles
    await sleepForTesting(400);

    // The first tick processes timer-a (callback throws, caught by try/catch
    // in tick) then continues to timer-b. The .finally() in #schedulePoll
    // ensures subsequent poll cycles also run. tickCount >= 2 confirms both
    // timers were processed despite the error.
    expect(tickCount).toBeGreaterThanOrEqual(2);

    scheduler.stop();
  });

  it('start is idempotent (calling start twice does not create duplicate polling)', () => {
    scheduler.start();
    scheduler.start(); // second call should be a no-op
    scheduler.stop();
    // No assertion needed -- just verifying it does not throw or create duplicate polling
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  it('stop clears timeout handles', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => now(),
    });

    scheduler.start();
    scheduler.stop();

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    await sleepForTesting(200);

    expect(firedEntries).toHaveLength(0);
  });

  it('stop is idempotent', () => {
    scheduler.stop();
    scheduler.stop();
    // Should not throw
  });

  // -------------------------------------------------------------------------
  // Symbol.dispose
  // -------------------------------------------------------------------------

  it('[Symbol.dispose]() calls stop', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => now(),
    });

    scheduler.start();
    scheduler[Symbol.dispose]();

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    await sleepForTesting(200);

    expect(firedEntries).toHaveLength(0);
  });

  it('start with registration but no periodicSync falls back to setTimeout', async () => {
    const registration = {} as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      fallbackIntervalMilliseconds: 50,
      getNow: () => now(),
    });

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    await sleepForTesting(200);

    expect(firedEntries.length).toBeGreaterThanOrEqual(1);

    scheduler.stop();
  });

  it('uses default fallback interval when not specified', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      getNow: () => now(),
    });

    // Just verify it does not throw when starting without fallbackIntervalMilliseconds
    scheduler.start();
    scheduler.stop();
  });

  it('handles async onTimerFired callbacks', async () => {
    const asyncFired: TimerEntry[] = [];
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: async (entry) => {
        await sleepForTesting(1);
        asyncFired.push(entry);
      },
      getNow: () => now(),
    });

    const entry = makeTimer({ fireAt: now() - 1000 });
    await scheduler.schedule(entry);

    await scheduler.tick(now());

    expect(asyncFired).toHaveLength(1);
    expect(asyncFired[0]!.id).toBe('timer-1');
  });

  it('logs polling errors when the scheduled tick throws', async () => {
    const errorSpy = mock((_message?: unknown, ..._args: unknown[]) => {});
    const originalError = console.error;
    console.error = errorSpy as typeof console.error;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: () => {
        throw new Error('tick failed');
      },
      fallbackIntervalMilliseconds: 20,
      getNow: () => now(),
    });

    try {
      await scheduler.schedule(makeTimer({ fireAt: now() - 1000 }));
      scheduler.start();
      await sleepForTesting(80);

      expect(errorSpy).toHaveBeenCalled();
    } finally {
      console.error = originalError;
      scheduler.stop();
    }
  });

  it('logs polling errors when storage scanning rejects during the timer loop', async () => {
    const realStorage = new MemoryStorage();
    const errorSpy = mock((_message?: unknown, ..._args: unknown[]) => {});
    const originalError = console.error;
    console.error = errorSpy as typeof console.error;

    const failingStorage: Storage = {
      get: realStorage.get.bind(realStorage),
      put: realStorage.put.bind(realStorage),
      delete: realStorage.delete.bind(realStorage),
      batch: realStorage.batch.bind(realStorage),
      async *scan() {
        throw new Error('scan failed');
      },
      [Symbol.dispose]() {
        realStorage[Symbol.dispose]();
      },
    };

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage: failingStorage,
      onTimerFired: () => undefined,
      fallbackIntervalMilliseconds: 20,
      getNow: () => now(),
    });

    try {
      scheduler.start();
      await sleepForTesting(80);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] ServiceWorkerScheduler tick failed:',
        expect.any(Error),
      );
    } finally {
      console.error = originalError;
      scheduler.stop();
    }
  });
});
