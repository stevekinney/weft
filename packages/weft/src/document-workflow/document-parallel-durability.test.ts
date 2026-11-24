/**
 * COR-2416: a signal a branch of a parallel step takes is consumed in the same commit as the branch
 * progress that records it, at every nesting depth and on every outcome, so a restart never finds
 * the signal gone while the branch that took it starts over. Each test is a probe of the review of
 * the first round (`review-round-1.md`), run across a restart.
 */
import { describe, expect, it } from 'bun:test';

import { encodeStorageKeyComponent, MemoryStorage } from "../embedded/storage/src/index.ts";
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from "../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { waitUntil } from "../../test-support/embedded/testing/src/wait-until.ts";

import { deserializeCheckpoint } from '../core/checkpoint.ts';
import {
  isParallelOperationCacheEntry,
  type ParallelBranchSlot,
} from '../core/context/parallel-cache-entry.ts';
import { Engine } from '../core/engine/index.ts';
import { KEYS } from '../storage/keys.ts';
import type { DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const calls: string[] = [];
/** Whether the `gated` activity holds item `y` open: until the test restarts the engine. */
let holdItemY = false;
let retryingAttempts = 0;
let siblingCommitted = Promise.withResolvers<void>();

const host: DocumentWorkflowHost = {
  activities: {
    count: ({ input }) => {
      calls.push(typeof input === 'string' ? input : JSON.stringify(input));
      return input;
    },
    boom: () => {
      calls.push('boom');
      throw new Error('branch exploded');
    },
    list: () => ({ items: ['x', 'y'] }),
    each: ({ previous }) => {
      calls.push(`each:${String(previous)}`);
      return previous;
    },
    gated: ({ previous }) => {
      calls.push(`gated:${String(previous)}`);
      return previous === 'y' && holdItemY ? new Promise(() => undefined) : previous;
    },
    charge: {
      idempotencyKey: () => 'charge-1',
      execute: () => {
        calls.push('charge');
        return 'C';
      },
    },
    retrying: {
      retry: {
        maxAttempts: 2,
        initialBackoff: 3_600_000,
        backoffMultiplier: 1,
        maxBackoff: 3_600_000,
      },
      // The first attempt fails only once its sibling `b` has finished and been committed, so no
      // commit of `b`'s carries the retry's state.
      execute: async () => {
        retryingAttempts += 1;
        calls.push('retrying');
        if (retryingAttempts === 1) {
          await siblingCommitted.promise;
          throw new Error('first attempt fails');
        }
        return 'R';
      },
    },
  },
  triggerKinds: { manual: () => undefined },
};

/** Whether run `id`'s committed checkpoint keeps the backoff of an activity retry. */
async function hasCommittedRetryBackoff(storage: MemoryStorage, id: string): Promise<boolean> {
  const bytes = await storage.get(KEYS.checkpoint(id));
  if (bytes === null) return false;
  const keys = Object.keys(deserializeCheckpoint(bytes).locals ?? {});
  // The attempt the retry is on, and the deadline of the backoff sleep it waits in.
  return (
    keys.includes('__weftActivityRetryState') &&
    keys.some((key) => key.startsWith('__weftSleepDeadline:'))
  );
}

const parallel = (branches: Record<string, unknown>) => ({ kind: 'parallel', branches });
const wait = (signal: string) => ({ kind: 'await-signal', signal });
const doc = (name: string, steps: readonly unknown[]) => ({
  name,
  trigger: { kind: 'manual' },
  steps,
});

async function waitingNames(engine: Engine, id: string): Promise<readonly string[]> {
  const state = await engine.get(id);
  return (state?.waitingForSignals ?? []).toSorted();
}

async function isWaitingOn(engine: Engine, id: string, ...names: string[]): Promise<boolean> {
  const waiting = await waitingNames(engine, id);
  return names.every((name) => waiting.includes(name));
}

/** The slots of the top-level parallel step in the run's committed checkpoint. */
async function committedSlots(storage: MemoryStorage, id: string): Promise<ParallelBranchSlot[]> {
  const bytes = await storage.get(KEYS.checkpoint(id));
  if (bytes === null) return [];
  const entry = deserializeCheckpoint(bytes)
    .accumulatedResults.map(([, value]) => value)
    .find(isParallelOperationCacheEntry);
  return entry?.branches ?? [];
}

/** How many of its own steps branch `index` has committed, finished or not. */
async function committedStepCount(storage: MemoryStorage, id: string, index: number) {
  const slots = await committedSlots(storage, id);
  const slot = slots[index];
  if (slot === undefined) return 0;
  if (slot.status === 'fulfilled') return Number.POSITIVE_INFINITY;
  return 'results' in slot ? (slot.results?.length ?? 0) : 0;
}

/** Whether a signal named `name` is still buffered, durably, for run `id`. */
async function hasBufferedSignal(storage: MemoryStorage, id: string, name: string) {
  const prefix = `sig:${encodeStorageKeyComponent(id)}:${encodeStorageKeyComponent(name)}:`;
  return (await storage.count(prefix)) > 0;
}

async function startEngine(storage: MemoryStorage, document: ReturnType<typeof doc>) {
  const engine = new Engine({ storage });
  await registerWorkflowDocuments(engine, host, { active: [document] });
  return engine;
}

describe('a signal a branch takes is committed with the progress that records it', () => {
  it('keeps what a failed branch took across a restart, and fails the run as it would have (review probe 1)', async () => {
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'failed-after-signal-run';
    const document = doc('failed-after-signal', [
      parallel({
        a: [wait('one'), { kind: 'activity', handler: 'boom' }],
        b: [wait('two'), wait('three')],
      }),
      { kind: 'activity', handler: 'count', input: 'after' },
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'one', 'two'), {
        message: 'both branches to wait',
      });
      await run.signal('one', 'A');
      await waitUntil(async () => calls.includes('boom'), { message: 'branch a to fail' });
      await run.signal('two', 'B');
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch b`s first step to be committed',
      });
      // The commit that took `two` also landed the delete of `one`: what took it must be durable.
      expect(await hasBufferedSignal(storage, id, 'one')).toBe(false);
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'three'), {
      message: 'branch b to wait again',
    });
    // Branch `a` resumes after the signal it took: it runs the step that threw again, and never
    // waits on `one` again.
    await waitUntil(async () => calls.length === 2, {
      message: 'branch a to run the step that threw again',
    });
    expect(await waitingNames(restarted, id)).toEqual(['three']);
    await handle!.signal('three', 'C');
    expect(await throwingRejectionOf(handle!.result())).toThrow('branch exploded');
    const settled = await restarted.get(id);
    expect(settled?.status).toBe('failed');
    // The failed activity runs again after the restart (at-least-once), and no later step runs.
    expect(calls).toEqual(['boom', 'boom']);
  });

  it('commits a nested parallel step`s progress with the signal it took (review probe 2)', async () => {
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'nested-signal-run';
    const document = doc('nested-signal', [
      parallel({
        a: [parallel({ x: [wait('one')], y: [wait('two')] })],
        b: [wait('three'), wait('four')],
      }),
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'one', 'two', 'three'), {
        message: 'every branch to wait',
      });
      await run.signal('one', 'X');
      await waitUntil(async () => !(await isWaitingOn(original, id, 'one')), {
        message: 'the nested branch to take its signal',
      });
      await run.signal('three', 'T');
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch b`s first step to be committed',
      });
      // The commit that landed the consume of `one` holds the nested step's progress, which took it.
      expect(await hasBufferedSignal(storage, id, 'one')).toBe(false);
      expect(await committedStepCount(storage, id, 0)).toBe(1);
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'two', 'four'), {
      message: 'the open waits to wait again',
    });
    expect(await waitingNames(restarted, id)).toEqual(['four', 'two']);
    await handle!.signal('two', 'Y');
    await handle!.signal('four', 'F');
    expect(await handle!.result()).toEqual({ a: { x: 'X', y: 'Y' }, b: 'F' });
  });

  it('commits the last nested branch with its signal, before a sibling commits (a nested step that waits)', async () => {
    // The nested step finishes when `one` arrives; the outer sibling then commits `three` before
    // branch `a` itself moves on. That commit must already hold the nested step's result.
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'nested-finish-run';
    const document = doc('nested-finish', [
      parallel({
        a: [parallel({ x: [wait('one')] }), wait('five')],
        b: [wait('three'), wait('four')],
      }),
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'one', 'three'), {
        message: 'both branches to wait',
      });
      await run.signal('one', 'X');
      await run.signal('three', 'T');
      await waitUntil(async () => isWaitingOn(original, id, 'five', 'four'), {
        message: 'both branches to move on',
      });
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch b`s first step to be committed',
      });
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'five', 'four'), {
      message: 'the open waits to wait again',
    });
    expect(await waitingNames(restarted, id)).toEqual(['five', 'four']);
    await handle!.signal('five', 'V');
    await handle!.signal('four', 'F');
    expect(await handle!.result()).toEqual({ a: 'V', b: 'F' });
  });

  it('holds a wait a nested branch opens later on a signal an outer sibling waits on (review probe 3)', async () => {
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'nested-same-signal-run';
    const document = doc('nested-same-signal', [
      parallel({
        left: [parallel({ a: [wait('x'), wait('y')], b: [wait('z')] })],
        right: [wait('t'), wait('y')],
      }),
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'x', 'z', 't'), {
        message: 'every branch to wait',
      });
      await run.signal('x', 'X');
      await waitUntil(async () => isWaitingOn(original, id, 'y'), {
        message: 'the nested branch to wait on y',
      });
      await run.signal('t', 'T');
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch right`s first step to be committed',
      });
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'y', 'z'), {
      message: 'the open waits to wait again',
    });
    await handle!.signal('y', 'Y1');
    // One delivery answers one wait: the held one opens and waits for a delivery of its own.
    await waitUntil(async () => !(await hasBufferedSignal(storage, id, 'y')), {
      message: 'the first y to be taken',
    });
    await waitUntil(async () => isWaitingOn(restarted, id, 'y'), {
      message: 'the held wait on y to open',
    });
    await handle!.signal('y', 'Y2');
    await handle!.signal('z', 'Z');
    expect(await handle!.result()).toEqual({ left: { a: 'Y1', b: 'Z' }, right: 'Y2' });
  });
});

describe('what a branch`s settled step commits besides a signal', () => {
  it('commits an idempotent activity`s completed receipt with its step, so the branch`s second call reuses it (review E)', async () => {
    calls.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage() });
    const document = doc('receipt-in-branch', [
      parallel({
        a: [
          { kind: 'activity', handler: 'charge' },
          { kind: 'activity', handler: 'charge' },
        ],
        b: [wait('go')],
      }),
    ]);
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start(document.name, null, { id: 'receipt-in-branch-run' });
    await waitUntil(async () => isWaitingOn(engine, run.id, 'go'), { message: 'b to wait' });
    await run.signal('go', 'G');
    expect(await run.result()).toEqual({ a: 'C', b: 'G' });
    expect(calls).toEqual(['charge']);
  });

  it('commits a retried activity`s attempt and backoff while its sibling has finished (review F)', async () => {
    calls.length = 0;
    retryingAttempts = 0;
    const storage = new MemoryStorage();
    const id = 'retry-in-branch-run';
    const document = doc('retry-in-branch', [
      parallel({
        a: [{ kind: 'activity', handler: 'retrying' }],
        b: [{ kind: 'activity', handler: 'count', input: 'b' }],
      }),
    ]);
    siblingCommitted = Promise.withResolvers<void>();
    {
      await using original = await startEngine(storage, document);
      await original.start(document.name, null, { id });
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) > 1, {
        message: 'b to finish and be committed',
      });
      siblingCommitted.resolve();
      await waitUntil(async () => hasCommittedRetryBackoff(storage, id), {
        message: 'the retry`s attempt and backoff to be committed',
      });
    }
    // The backoff is an hour from the first attempt; the recovered run waits it out, not reruns it.
    useFakeTimers(Date.now());
    try {
      await using restarted = await startEngine(storage, document);
      const [handle] = await restarted.recoverAll();
      // The backoff's deadline is in the checkpoint: one move of the clock passes it, whether the
      // replay arms its timer before the move or after (`executeSleepSubOperation`).
      await advanceTimersByTime(2 * 3_600_000);
      expect(await handle!.result()).toEqual({ a: 'R', b: 'b' });
      expect(retryingAttempts).toBe(2);
    } finally {
      restoreRealTimers();
    }
  });

  it('recovers a map whose items each hold a parallel step, restarted after its first item`s slot commit (review D)', async () => {
    calls.length = 0;
    holdItemY = true;
    const storage = new MemoryStorage();
    const id = 'map-of-parallels-run';
    const document = doc('map-of-parallels', [
      { kind: 'activity', handler: 'list' },
      {
        kind: 'map',
        over: 'items',
        steps: [
          parallel({
            p: [{ kind: 'activity', handler: 'gated' }],
            q: [{ kind: 'activity', handler: 'each' }],
          }),
        ],
      },
    ]);
    {
      await using original = await startEngine(storage, document);
      await original.start(document.name, null, { id });
      // The map's round is the run's one parallel cache entry: its first slot is item `x`.
      await waitUntil(async () => (await committedStepCount(storage, id, 0)) > 1, {
        message: 'item x`s slot to be committed while item y runs',
      });
    }
    holdItemY = false;
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    expect(await handle!.result()).toEqual([
      { p: 'x', q: 'x' },
      { p: 'y', q: 'y' },
    ]);
    // Item `x` finished before the restart and is not run again.
    expect(calls.filter((call) => call.endsWith(':x')).toSorted()).toEqual(['each:x', 'gated:x']);
  });
});

describe('two parallel steps in a row, the second restarted while it waits (round-two review 1)', () => {
  // The first step's result is replayed from the checkpoint event of the commit that recorded it.
  // A `file-workflow:*` event of a later document step in that commit carries a `step` of its own,
  // which recovery once read as a checkpoint step and stopped at: the first step ran again and
  // waited on a signal it had already consumed.
  const twoSteps = [
    parallel({ p: [wait('a')], q: [{ kind: 'activity', handler: 'count', input: 'one' }] }),
    parallel({ r: [wait('b')], s: [{ kind: 'activity', handler: 'count', input: 'two' }] }),
  ];
  const rows = [
    { name: 'at the top level', steps: twoSteps, expected: { r: 'B', s: 'two' } },
    {
      name: 'as the item of a map',
      steps: [
        { kind: 'activity', handler: 'list' },
        { kind: 'map', over: 'items', steps: twoSteps },
      ],
      expected: [
        { r: 'B', s: 'two' },
        { r: 'B2', s: 'two' },
      ],
    },
    {
      name: 'as the item of a map in a branch',
      steps: [
        parallel({
          m: [
            { kind: 'activity', handler: 'list' },
            { kind: 'map', over: 'items', steps: twoSteps },
          ],
          g: [wait('go')],
        }),
      ],
      expected: {
        g: 'G',
        m: [
          { r: 'B', s: 'two' },
          { r: 'B2', s: 'two' },
        ],
      },
    },
  ] as const;
  for (const [index, row] of rows.entries()) {
    it(`replays the first step and waits only on the second ${row.name}`, async () => {
      calls.length = 0;
      const storage = new MemoryStorage();
      const id = `two-parallel-steps-${String(index)}-run`;
      const document = doc(`two-parallel-steps-${String(index)}`, row.steps);
      {
        await using original = await startEngine(storage, document);
        const run = await original.start(document.name, null, { id });
        await waitUntil(async () => isWaitingOn(original, id, 'a'), { message: 'a wait on a' });
        await run.signal('a', 'A');
        await waitUntil(async () => isWaitingOn(original, id, 'b'), { message: 'a wait on b' });
      }
      await using restarted = await startEngine(storage, document);
      const [handle] = await restarted.recoverAll();
      await restarted.signal(id, 'b', 'B');
      if (Array.isArray(row.expected) || 'm' in row.expected) {
        // The map's second item waits on `a`, then `b`, again.
        await waitUntil(async () => isWaitingOn(restarted, id, 'a'), {
          message: 'the second item to wait on a',
        });
        await restarted.signal(id, 'a', 'A2');
        await waitUntil(async () => isWaitingOn(restarted, id, 'b'), {
          message: 'the second item to wait on b',
        });
        await restarted.signal(id, 'b', 'B2');
      }
      if ('g' in row.expected) await restarted.signal(id, 'go', 'G');
      expect(await handle!.result()).toEqual(row.expected);
      // The first item's first step ran once: its result came back from the checkpoint.
      expect(calls.filter((call) => call === 'one').length).toBe(
        Array.isArray(row.expected) || 'm' in row.expected ? 2 : 1,
      );
    });
  }
});
