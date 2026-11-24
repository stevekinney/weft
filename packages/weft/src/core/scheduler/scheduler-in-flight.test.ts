/**
 * COR-1482: the scheduler delivers an entry to one callback at a time. A scan reads an expired
 * entry again on every poll until the scan that delivered it has run its callback and committed
 * its cleanup, so without a guard a callback that is still running is handed the same entry again.
 * A skipped delivery leaves its entry exactly as it is.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import type { TimerEntry } from '../types.ts';
import { Scheduler } from './scheduler-class.ts';

const NOW = 1_000_000;
const turns = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

async function allKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('')) keys.push(key);
  return keys.toSorted();
}

/** A scheduler whose callback counts its deliveries and waits on `gate` for each. */
function gatedScheduler(storage: MemoryStorage, gate: Promise<void>) {
  const delivered: string[] = [];
  const scheduler = new Scheduler({
    storage,
    getNow: () => NOW,
    onTimerFired: async (entry) => {
      delivered.push(entry.id);
      await gate;
    },
  });
  return { scheduler, delivered };
}

const KINDS: ReadonlyArray<{ readonly kind: TimerEntry['kind']; readonly id: string }> = [
  { kind: 'sleep', id: 'sleep:workflow-1:0' },
  { kind: 'wait-condition', id: 'wait-condition:workflow-1:0' },
  { kind: 'terminal-cleanup', id: 'terminal-cleanup:cleanup-token' },
];

describe('a second delivery of an entry whose callback is in flight', () => {
  for (const { kind, id } of KINDS) {
    it(`does not re-enter the callback of a ${kind} entry, and leaves the entry as it is`, async () => {
      const storage = new MemoryStorage();
      const gate = Promise.withResolvers<void>();
      const { scheduler, delivered } = gatedScheduler(storage, gate.promise);
      try {
        await scheduler.schedule({ id, workflowId: 'workflow-1', fireAt: NOW - 1_000, kind });
        const before = await allKeys(storage);

        const scanA = scheduler.tick(NOW);
        await turns(10);
        const scanB = scheduler.tick(NOW);
        await scanB; // the second scan finishes at once: it had nothing it could deliver
        expect(delivered).toEqual([id]);
        expect(await allKeys(storage)).toEqual(before);

        gate.resolve();
        await scanA;
        expect(delivered).toEqual([id]);
        expect(await allKeys(storage)).toEqual([]);
      } finally {
        gate.resolve();
        scheduler[Symbol.dispose]();
      }
    });
  }

  it('does not deliver a processed entry again while its cleanup is still to be committed', async () => {
    const storage = new MemoryStorage();
    const firstGate = Promise.withResolvers<void>();
    const delivered: string[] = [];
    const scheduler = new Scheduler({
      storage,
      getNow: () => NOW,
      onTimerFired: async (entry) => {
        delivered.push(entry.id);
        // The later entry holds the scan open after the earlier one has been processed.
        if (entry.id === 'sleep:b:0') await firstGate.promise;
      },
    });
    try {
      await scheduler.schedule({
        id: 'sleep:a:0',
        workflowId: 'a',
        fireAt: NOW - 2_000,
        kind: 'sleep',
      });
      await scheduler.schedule({
        id: 'sleep:b:0',
        workflowId: 'b',
        fireAt: NOW - 1_000,
        kind: 'sleep',
      });

      const scanA = scheduler.tick(NOW);
      await turns(10);
      await scheduler.tick(NOW);
      expect(delivered).toEqual(['sleep:a:0', 'sleep:b:0']);

      firstGate.resolve();
      await scanA;
      expect(await allKeys(storage)).toEqual([]);
    } finally {
      firstGate.resolve();
      scheduler[Symbol.dispose]();
    }
  });

  it('is released when the callback fails, so the entry is retried by the next scan', async () => {
    const storage = new MemoryStorage();
    let attempts = 0;
    const scheduler = new Scheduler({
      storage,
      getNow: () => NOW,
      onTimerFired: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('the first attempt fails');
      },
    });
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await scheduler.schedule({
        id: 'sleep:w:0',
        workflowId: 'w',
        fireAt: NOW - 1_000,
        kind: 'sleep',
      });

      await scheduler.tick(NOW);
      expect(await storage.get(KEYS.deadline(NOW - 1_000, 'sleep:w:0'))).not.toBeNull();
      await scheduler.tick(NOW);

      expect(attempts).toBe(2);
      expect(await allKeys(storage)).toEqual([]);
    } finally {
      consoleError.mockRestore();
      scheduler[Symbol.dispose]();
    }
  });

  it('never makes one schedule’s tick wait for another’s, and gives every entry of one schedule one owner', async () => {
    const storage = new MemoryStorage();
    const gate = Promise.withResolvers<void>();
    const { scheduler, delivered } = gatedScheduler(storage, gate.promise);
    try {
      for (const scheduleId of ['one', 'two']) {
        await scheduler.schedule({
          id: `schedule:${scheduleId}`,
          workflowId: scheduleId,
          fireAt: NOW - 1_000,
          kind: 'schedule',
        });
      }
      const scanA = scheduler.tick(NOW);
      await turns(10);
      // A scan delivers its entries one after another, so "two" waits for "one" within it.
      expect(delivered).toEqual(['schedule:one']);
      gate.resolve();
      await scanA;
      expect(delivered).toEqual(['schedule:one', 'schedule:two']);
    } finally {
      gate.resolve();
      scheduler[Symbol.dispose]();
    }
  });
});
