/**
 * COR-1908: `Scheduler.stop()` settles only once a tick already in flight has settled, so a host
 * that closes its storage after `await scheduler.stop()` is never reached by a late scan (the
 * "pool has been disposed" failures of COR-1906). No wall-clock deadline: the hang guard bounds
 * every wait, and a tick that never settles keeps `stop()` pending.
 */
import { describe, expect, it } from 'bun:test';

import { type BatchOperation, MemoryStorage, type ScanOptions } from "../../embedded/storage/src/index.ts";
import { awakeTurns, quietFor, waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import type { TimerEntry } from '../types.ts';
import { Scheduler } from './scheduler-class.ts';

const NOW = 1_000_000;
const QUIET_MILLISECONDS = 40;

/** A storage whose deadline scan can be held at its first read, and that notices use after close. */
class GatedStorage extends MemoryStorage {
  gate: Promise<void> | null = null;
  scanEntries = 0;
  readonly callsAfterClose: string[] = [];
  closed = false;

  #record(call: string): void {
    if (this.closed) this.callsAfterClose.push(call);
  }

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    this.#record(`scan ${prefix}`);
    if (prefix === 'wf-deadline:') {
      this.scanEntries += 1;
      if (this.gate !== null) await this.gate;
      this.#record(`scan ${prefix} (after gate)`);
    }
    yield* super.scan(prefix, options);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    this.#record(`get ${key}`);
    return super.get(key);
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.#record('batch');
    return super.batch(operations);
  }
}

const DUE: TimerEntry = {
  id: 'timer-1',
  workflowId: 'workflow-1',
  fireAt: NOW - 1_000,
  kind: 'sleep',
};

type Rig = {
  storage: GatedStorage;
  scheduler: Scheduler;
  fired: string[];
  order: string[];
  hold: () => PromiseWithResolvers<void>;
  /** Wait until a tick is parked at the gate. */
  parked: () => Promise<void>;
};

async function createRig(): Promise<Rig> {
  const storage = new GatedStorage();
  const fired: string[] = [];
  const order: string[] = [];
  const scheduler = new Scheduler({
    storage,
    getNow: () => NOW,
    pollIntervalMs: 5,
    onTimerFired: (entry) => {
      fired.push(entry.id);
    },
  });
  await scheduler.schedule(DUE);
  return {
    storage,
    scheduler,
    fired,
    order,
    hold: () => {
      const gate = Promise.withResolvers<void>();
      storage.gate = gate.promise;
      return gate;
    },
    parked: () => waitUntil(() => storage.scanEntries > 0, { message: 'a tick parked in a read' }),
  };
}

/** Tracks whether a promise has settled, without racing it against a timer. */
function track<T>(promise: Promise<T>): { settled: () => boolean; outcome: Promise<unknown> } {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return { value };
    },
    (reason: unknown) => {
      settled = true;
      return { reason };
    },
  );
  return { settled: () => settled, outcome };
}

type Scenario = {
  name: string;
  run: (rig: Rig) => Promise<void>;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'no tick in flight: resolves at once, and the entry is left for a later tick',
    run: async ({ scheduler, storage, fired }) => {
      await scheduler.stop();
      expect(storage.scanEntries).toBe(0);
      expect(fired).toEqual([]);
    },
  },
  {
    name: 'a tick blocked in a storage read: resolves only after it settles, with no storage call after',
    run: async ({ scheduler, storage, fired, order, hold, parked }) => {
      const gate = hold();
      const tick = track(scheduler.tick(NOW).then(() => order.push('tick settled')));
      await parked();

      const stop = track(scheduler.stop().then(() => order.push('stop resolved')));
      await quietFor(QUIET_MILLISECONDS);
      expect(stop.settled()).toBe(false);

      gate.resolve();
      await stop.outcome;
      await tick.outcome;
      expect(order).toEqual(['tick settled', 'stop resolved']);

      storage.closed = true;
      await quietFor(QUIET_MILLISECONDS);
      expect(storage.callsAfterClose).toEqual([]);
      // The tick saw the stop before it delivered anything, so the entry survives untouched.
      expect(fired).toEqual([]);
    },
  },
  {
    name: 'a tick in flight that rejects: stop resolves, and the rejection reaches the tick caller',
    run: async ({ scheduler, hold, parked }) => {
      const gate = hold();
      const tick = track(scheduler.tick(NOW));
      await parked();
      const stop = track(scheduler.stop());
      await quietFor(QUIET_MILLISECONDS);
      expect(stop.settled()).toBe(false);

      // Fail the read the way a disposed pool would.
      gate.reject(new Error('storage read failed'));
      expect(await tick.outcome).toEqual({ reason: new Error('storage read failed') });
      expect(await stop.outcome).toEqual({ value: undefined });
    },
  },
  {
    name: 'a timer due after stop: no new tick starts',
    run: async ({ scheduler, storage }) => {
      scheduler.start();
      await scheduler.stop();
      const entriesAtStop = storage.scanEntries;
      await quietFor(QUIET_MILLISECONDS);
      await scheduler.tick(NOW);
      expect(storage.scanEntries).toBe(entriesAtStop);
    },
  },
  {
    name: 'stop() called twice and concurrently: both wait for the same tick, and nothing runs twice',
    run: async ({ scheduler, storage, order, hold, parked }) => {
      const gate = hold();
      const tick = track(scheduler.tick(NOW).then(() => order.push('tick settled')));
      await parked();

      const first = track(scheduler.stop().then(() => order.push('first stop')));
      const second = track(scheduler.stop().then(() => order.push('second stop')));
      await quietFor(QUIET_MILLISECONDS);
      expect(first.settled() || second.settled()).toBe(false);

      gate.resolve();
      await Promise.all([first.outcome, second.outcome, tick.outcome]);
      expect(order[0]).toBe('tick settled');
      expect(order.toSorted()).toEqual(['first stop', 'second stop', 'tick settled']);
      expect(storage.scanEntries).toBe(1);
      await scheduler.stop();
    },
  },
  {
    name: 'a tick that never settles: stop stays pending with no deadline of its own',
    run: async ({ scheduler, hold, parked }) => {
      const gate = hold();
      const tick = track(scheduler.tick(NOW));
      await parked();
      const stop = track(scheduler.stop());
      for await (const turn of awakeTurns()) {
        if (turn >= 20) break;
      }
      await quietFor(QUIET_MILLISECONDS * 2);
      expect(stop.settled()).toBe(false);
      gate.resolve();
      await stop.outcome;
      await tick.outcome;
    },
  },
];

describe('Scheduler.stop() and the tick in flight', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const rig = await createRig();
      try {
        await scenario.run(rig);
      } finally {
        rig.storage.gate = null;
        await rig.scheduler.stop();
      }
    });
  }

  it('stop() inside a timer callback does not wait for its own tick', async () => {
    const storage = new GatedStorage();
    const stopped: Array<Promise<void>> = [];
    const scheduler = new Scheduler({
      storage,
      getNow: () => NOW,
      onTimerFired: () => {
        stopped.push(scheduler.stop());
      },
    });
    await scheduler.schedule(DUE);
    await scheduler.tick(NOW);
    expect(stopped).toHaveLength(1);
    await Promise.all(stopped);
  });

  it('flush() halts the poller without waiting on its own scan', async () => {
    const storage = new GatedStorage();
    const fired: string[] = [];
    const scheduler = new Scheduler({
      storage,
      getNow: () => NOW,
      onTimerFired: (entry) => {
        fired.push(entry.id);
      },
    });
    await scheduler.schedule(DUE);
    scheduler.start();
    await scheduler.flush(NOW);
    expect(fired).toEqual(['timer-1']);
    await scheduler.tick(NOW);
    expect(storage.scanEntries).toBe(1);
  });
});
