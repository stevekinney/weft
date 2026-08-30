import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { TimerEntry } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';

/**
 * Minimal disposable scheduler surface the shared timer contract exercises.
 *
 * The contract covers only behavior that both the core {@link Scheduler} and the
 * service-worker scheduler implement identically (they share
 * `buildTimerBatchOperations`, so deadline/index key formats are identical by
 * construction). Lifecycle (`start`/`stop`) is intentionally absent: the two
 * implementations differ structurally (`setInterval` vs `setTimeout` +
 * periodic-sync), so idempotence stays a local case in each suite.
 */
export type ContractScheduler = Disposable & {
  schedule(entry: TimerEntry): Promise<void>;
  tick(now?: number): Promise<void>;
  flush(now?: number): Promise<void>;
  /**
   * Cancel by id and workflow id. This is the core scheduler's richer signature
   * `cancel(id, workflowId)`; the service-worker factory ignores `workflowId`.
   * Shared cases pass a real workflow id, matching existing core tests.
   */
  cancel(id: string, workflowId: string): Promise<void>;
};

/**
 * Mutable per-case context the factory reads when constructing a scheduler.
 *
 * The factory wires `onTimerFired` to push into {@link firedEntries}, `getNow`
 * to {@link getCurrentTime}, and storage to {@link storage}. Cases drive time
 * only through {@link setCurrentTime} plus explicit `tick(now)`/`flush(now)`
 * arguments, never via wall-clock advancement, so they are agnostic to whether
 * fake timers are installed.
 */
export type SchedulerContractContext = {
  storage: MemoryStorage;
  firedEntries: TimerEntry[];
  /** Read the current fake time; the factory's `getNow` closure reads this. */
  getCurrentTime(): number;
  /** Set the current fake time; cases mutate this then pass it to `tick()`. */
  setCurrentTime(value: number): void;
  /** Build a timer entry with sensible defaults relative to the current time. */
  makeTimer(overrides?: Partial<TimerEntry>): TimerEntry;
  /** Collect every key currently present in {@link storage}. */
  collectStorageKeys(): Promise<string[]>;
};

/**
 * Construct fresh per-test scheduler-test state. Reused by the shared contract
 * and by each suite's implementation-specific block, so `makeTimer` and
 * `collectStorageKeys` are defined exactly once.
 */
export function createSchedulerContractContext(): SchedulerContractContext {
  const storage = new MemoryStorage();
  const firedEntries: TimerEntry[] = [];
  let currentTime = 1_000_000;

  const context: SchedulerContractContext = {
    storage,
    firedEntries,
    getCurrentTime() {
      return currentTime;
    },
    setCurrentTime(value) {
      currentTime = value;
    },
    makeTimer(overrides = {}) {
      return {
        id: 'timer-1',
        workflowId: 'workflow-1',
        fireAt: currentTime + 5000,
        kind: 'sleep',
        ...overrides,
      };
    },
    async collectStorageKeys() {
      const keys: string[] = [];
      for await (const key of storage.keys('')) {
        keys.push(key);
      }
      return keys;
    },
  };

  return context;
}

export type SchedulerContractConfig = {
  /** Label included in the describe title, e.g. 'core' or 'service-worker'. */
  name: string;
  /**
   * Build a scheduler from the current context. Called inside `beforeEach`
   * after the context is reset. The suite owns construction (wiring
   * `onTimerFired`, `getNow`, and storage from the context) and the `cancel`
   * signature seam: the core factory returns the instance directly; the
   * service-worker factory wraps it so `cancel(id, _workflowId)` drops the
   * second argument.
   */
  createScheduler(context: SchedulerContractContext): ContractScheduler;
};

/**
 * Register the shared scheduler timer-contract cases for one implementation.
 *
 * Opens its own top-level `describe` with its own `beforeEach`/`afterEach`, so
 * it must be invoked as a sibling of each suite's local blocks — never nested —
 * to avoid inheriting per-suite hooks (e.g. the service-worker suite's global
 * `useFakeTimers`). The helper disposes only the scheduler it created.
 */
export function describeSchedulerContract(config: SchedulerContractConfig): void {
  describe(`scheduler contract — ${config.name}`, () => {
    let context: SchedulerContractContext;
    let scheduler: ContractScheduler;

    beforeEach(() => {
      context = createSchedulerContractContext();
      scheduler = config.createScheduler(context);
    });

    afterEach(() => {
      scheduler[Symbol.dispose]();
    });

    it('writes a timer entry to storage on schedule', async () => {
      await scheduler.schedule(context.makeTimer());

      const keys = await context.collectStorageKeys();
      expect(keys.some((key) => key.startsWith('wf-deadline:'))).toBe(true);
      expect(keys.some((key) => key.startsWith('timer-idx:'))).toBe(true);
    });

    it('writes the correct deadline key format', async () => {
      await scheduler.schedule(context.makeTimer({ fireAt: 1_005_000 }));

      const keys = await context.collectStorageKeys();
      const deadlineKey = keys.find((key) => key.startsWith('wf-deadline:'));
      expect(deadlineKey).toBe('wf-deadline:0000000001005000:timer-1');
    });

    it('fires callback for expired timers when tick is called', async () => {
      await scheduler.schedule(context.makeTimer({ fireAt: context.getCurrentTime() - 1000 }));

      await scheduler.tick(context.getCurrentTime());

      expect(context.firedEntries).toHaveLength(1);
      expect(context.firedEntries[0]!.id).toBe('timer-1');
    });

    it('does NOT fire callback for future timers', async () => {
      await scheduler.schedule(context.makeTimer({ fireAt: context.getCurrentTime() + 5000 }));

      await scheduler.tick(context.getCurrentTime());

      expect(context.firedEntries).toHaveLength(0);
    });

    it('fires all expired timers in chronological order', async () => {
      const now = context.getCurrentTime();
      await scheduler.schedule(context.makeTimer({ id: 'timer-1', fireAt: now - 3000 }));
      await scheduler.schedule(context.makeTimer({ id: 'timer-2', fireAt: now - 1000 }));
      await scheduler.schedule(context.makeTimer({ id: 'timer-3', fireAt: now - 2000 }));

      await scheduler.tick(now);

      expect(context.firedEntries.map((entry) => entry.id)).toEqual([
        'timer-1',
        'timer-3',
        'timer-2',
      ]);
    });

    it('tick cleans up deadline and index keys after firing', async () => {
      await scheduler.schedule(context.makeTimer({ fireAt: context.getCurrentTime() - 1000 }));

      await scheduler.tick(context.getCurrentTime());

      const keys = await context.collectStorageKeys();
      expect(keys.filter((key) => key.startsWith('wf-deadline:'))).toHaveLength(0);
      expect(keys.filter((key) => key.startsWith('timer-idx:'))).toHaveLength(0);
    });

    it('tick uses getNow when no argument is provided', async () => {
      await scheduler.schedule(context.makeTimer({ fireAt: context.getCurrentTime() - 1000 }));

      await scheduler.tick();

      expect(context.firedEntries).toHaveLength(1);
      expect(context.firedEntries[0]!.id).toBe('timer-1');
    });

    it('cancel prevents a timer from firing', async () => {
      const entry = context.makeTimer({ fireAt: context.getCurrentTime() - 1000 });
      await scheduler.schedule(entry);
      await scheduler.cancel(entry.id, entry.workflowId);

      await scheduler.tick(context.getCurrentTime());

      expect(context.firedEntries).toHaveLength(0);
    });

    it('cancel removes both deadline and index keys', async () => {
      const entry = context.makeTimer({ fireAt: context.getCurrentTime() - 1000 });
      await scheduler.schedule(entry);

      await scheduler.cancel(entry.id, entry.workflowId);

      const keys = await context.collectStorageKeys();
      expect(keys.some((key) => key.startsWith('wf-deadline:'))).toBe(false);
      expect(keys.some((key) => key.startsWith('timer-idx:'))).toBe(false);
    });

    it('cancel is a no-op for a timer that was never scheduled', async () => {
      await scheduler.cancel('nonexistent-timer', 'some-workflow');

      await scheduler.tick(context.getCurrentTime());

      expect(context.firedEntries).toHaveLength(0);
    });

    it('flush processes expired timers and cleans their keys', async () => {
      await scheduler.schedule(context.makeTimer({ fireAt: context.getCurrentTime() - 1000 }));

      await scheduler.flush(context.getCurrentTime());

      expect(context.firedEntries).toHaveLength(1);
      expect(context.firedEntries[0]!.id).toBe('timer-1');

      const keys = await context.collectStorageKeys();
      expect(keys.filter((key) => key.startsWith('wf-deadline:'))).toHaveLength(0);
      expect(keys.filter((key) => key.startsWith('timer-idx:'))).toHaveLength(0);
    });

    it('full integration: schedule, advance time via tick, verify fired', async () => {
      await scheduler.schedule(context.makeTimer({ fireAt: context.getCurrentTime() + 5000 }));

      await scheduler.tick(context.getCurrentTime());
      expect(context.firedEntries).toHaveLength(0);

      context.setCurrentTime(context.getCurrentTime() + 6000);
      await scheduler.tick(context.getCurrentTime());

      expect(context.firedEntries).toHaveLength(1);
      expect(context.firedEntries[0]!.id).toBe('timer-1');
      expect(context.firedEntries[0]!.workflowId).toBe('workflow-1');

      const keys = await context.collectStorageKeys();
      expect(keys.filter((key) => key.startsWith('wf-deadline:'))).toHaveLength(0);
    });
  });
}
