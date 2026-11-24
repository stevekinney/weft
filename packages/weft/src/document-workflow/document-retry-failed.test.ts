/**
 * `engine.retryFailed(workflowId)` on a document workflow (COR-2424): a run whose step failed is
 * resumed in place, the failed step runs again, and every step before it is replayed from the
 * checkpoint, never run again, so the step that failed receives the same `previous` it had.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";

import { Engine } from '../core/engine/index.ts';
import type { WorkflowState } from '../core/types.ts';
import { KEYS } from '../storage/keys.ts';
import type { DocumentActivityArgument, DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

async function stateOf(engine: Engine, id: string): Promise<WorkflowState | null> {
  const state = await engine.get(id);
  return state;
}

async function settled(engine: Engine, id: string, status: WorkflowState['status']) {
  await waitForCondition(
    async () => {
      const state = await stateOf(engine, id);
      return state?.status === status;
    },
    { label: `"${id}" to be ${status}`, intervalMs: 5 },
  );
}

/** A host whose `first` always succeeds and whose `second` fails until `failing` is cleared. */
function countingHost() {
  const calls = { first: 0, second: 0 };
  const previousSeen: unknown[] = [];
  const control = { failing: true };
  const host: DocumentWorkflowHost = {
    activities: {
      first: (argument: DocumentActivityArgument) => {
        calls.first += 1;
        return { made: 'one', from: argument.previous ?? null };
      },
      second: (argument: DocumentActivityArgument) => {
        calls.second += 1;
        previousSeen.push(argument.previous);
        if (control.failing) throw new Error('second failed');
        return 'two';
      },
    },
    triggerKinds: { manual: () => undefined },
  };
  return { calls, previousSeen, control, host };
}

describe('retrying a failed document run from its failed step', () => {
  it('runs the failed step again with the earlier step’s result and never runs the earlier step again', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const { calls, previousSeen, control, host } = countingHost();
    await registerWorkflowDocuments(engine, host, {
      active: [
        {
          name: 'two-steps',
          trigger: { kind: 'manual' },
          steps: [
            { kind: 'activity', handler: 'first' },
            { kind: 'activity', handler: 'second' },
          ],
        },
      ],
    });
    await engine.start('two-steps', null, { id: 'run-1' });
    await settled(engine, 'run-1', 'failed');
    expect(calls).toEqual({ first: 1, second: 1 });

    control.failing = false;
    expect(await engine.retryFailed('run-1')).toEqual({ workflowId: 'run-1', status: 'retried' });
    await settled(engine, 'run-1', 'completed');

    expect(calls).toEqual({ first: 1, second: 2 });
    expect(previousSeen).toEqual([
      { made: 'one', from: null },
      { made: 'one', from: null },
    ]);
    const done = await stateOf(engine, 'run-1');
    expect(done?.result).toBe('two');
  });

  it('runs again a step inside a map, keeping the items that finished', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const seen: unknown[] = [];
    let failOnB = true;
    let firstCalls = 0;
    const host: DocumentWorkflowHost = {
      activities: {
        first: () => {
          firstCalls += 1;
          return { items: ['a', 'b'] };
        },
        item: (argument: DocumentActivityArgument) => {
          seen.push(argument.previous);
          if (argument.previous === 'b' && failOnB) throw new Error('b failed');
          return `done ${String(argument.previous)}`;
        },
      },
      triggerKinds: { manual: () => undefined },
    };
    await registerWorkflowDocuments(engine, host, {
      active: [
        {
          name: 'mapped',
          trigger: { kind: 'manual' },
          steps: [
            { kind: 'activity', handler: 'first' },
            {
              kind: 'map',
              over: 'items',
              concurrency: 1,
              steps: [{ kind: 'activity', handler: 'item' }],
            },
          ],
        },
      ],
    });
    await engine.start('mapped', null, { id: 'run-map' });
    await settled(engine, 'run-map', 'failed');
    expect(seen).toEqual(['a', 'b']);

    failOnB = false;
    const outcome = await engine.retryFailed('run-map');
    expect(outcome.status).toBe('retried');
    await settled(engine, 'run-map', 'completed');

    expect(firstCalls).toBe(1);
    expect(seen).toEqual(['a', 'b', 'b']);
    const mapped = await stateOf(engine, 'run-map');
    expect(mapped?.result).toEqual(['done a', 'done b']);
  });

  // Known: a map that runs items together replays its settled round, so a completed item runs again.
  // Bureau refuses a retry of such a step (`isRetryableStep`); this pins what Weft does so the
  // refusal is removed only when this holds.
  it.failing(
    'runs again only the item that failed in a map that runs items together, never a completed one (COR-2424)',
    async () => {
      const storage = new MemoryStorage();
      await using engine = new Engine({ storage });
      const calls = new Map<string, number>();
      let failOnB = true;
      const host: DocumentWorkflowHost = {
        activities: {
          first: () => ({ items: ['a', 'b', 'c'] }),
          item: (argument: DocumentActivityArgument) => {
            const item = String(argument.previous);
            calls.set(item, (calls.get(item) ?? 0) + 1);
            if (item === 'b' && failOnB) throw new Error('b failed');
            return `done ${item}`;
          },
        },
        triggerKinds: { manual: () => undefined },
      };
      await registerWorkflowDocuments(engine, host, {
        active: [
          {
            name: 'mapped-together',
            trigger: { kind: 'manual' },
            steps: [
              { kind: 'activity', handler: 'first' },
              {
                kind: 'map',
                over: 'items',
                concurrency: 2,
                steps: [{ kind: 'activity', handler: 'item' }],
              },
            ],
          },
        ],
      });
      await engine.start('mapped-together', null, { id: 'run-map-together' });
      await settled(engine, 'run-map-together', 'failed');
      const before = new Map(calls);

      failOnB = false;
      const retried = await engine.retryFailed('run-map-together');
      expect(retried.status).toBe('retried');
      await settled(engine, 'run-map-together', 'completed');

      // An item that completed before the failure never ran again; the one that failed ran once more.
      for (const [item, count] of before) {
        if (item === 'b') expect(calls.get(item)).toBe(count + 1);
        else expect(calls.get(item)).toBe(count);
      }
      const finished = await stateOf(engine, 'run-map-together');
      expect(finished?.result).toEqual(['done a', 'done b', 'done c']);
    },
  );

  it('answers not-failed for a second retry of a run that is running again, and not-found for an unknown id', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const { calls, control, host } = countingHost();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: DocumentWorkflowHost = {
      ...host,
      activities: {
        ...host.activities,
        second: async (argument: DocumentActivityArgument) => {
          if (!control.failing) await held;
          return (host.activities['second'] as (value: DocumentActivityArgument) => unknown)(
            argument,
          );
        },
      },
    };
    await registerWorkflowDocuments(engine, slow, {
      active: [
        {
          name: 'two-steps',
          trigger: { kind: 'manual' },
          steps: [
            { kind: 'activity', handler: 'first' },
            { kind: 'activity', handler: 'second' },
          ],
        },
      ],
    });
    await engine.start('two-steps', null, { id: 'run-twice' });
    await settled(engine, 'run-twice', 'failed');

    control.failing = false;
    const [one, two] = await Promise.all([
      engine.retryFailed('run-twice'),
      engine.retryFailed('run-twice'),
    ]);
    expect([one.status, two.status].toSorted()).toEqual(['not-failed', 'retried']);
    release();
    await settled(engine, 'run-twice', 'completed');
    expect(calls).toEqual({ first: 1, second: 2 });
    expect(await engine.retryFailed('run-twice')).toEqual({
      workflowId: 'run-twice',
      status: 'not-failed',
      currentStatus: 'completed',
    });
    expect(await engine.retryFailed('no-such-run')).toEqual({
      workflowId: 'no-such-run',
      status: 'not-found',
    });
  });

  it('answers no-checkpoint for a failed run with no checkpoint, and does not start it again', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const { calls, control, host } = countingHost();
    await registerWorkflowDocuments(engine, host, {
      active: [
        {
          name: 'two-steps',
          trigger: { kind: 'manual' },
          steps: [
            { kind: 'activity', handler: 'first' },
            { kind: 'activity', handler: 'second' },
          ],
        },
      ],
    });
    await engine.start('two-steps', null, { id: 'run-bare' });
    await settled(engine, 'run-bare', 'failed');
    await storage.delete(KEYS.checkpoint('run-bare'));

    control.failing = false;
    expect(await engine.retryFailed('run-bare')).toEqual({
      workflowId: 'run-bare',
      status: 'no-checkpoint',
    });
    const bare = await stateOf(engine, 'run-bare');
    expect(bare?.status).toBe('failed');
    expect(calls).toEqual({ first: 1, second: 1 });
  });

  it('records the step starting again and the run ending a second time, after the failure and in order (COR-2424)', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const { control, host } = countingHost();
    await registerWorkflowDocuments(engine, host, {
      active: [
        {
          name: 'two-steps',
          trigger: { kind: 'manual' },
          steps: [
            { kind: 'activity', handler: 'first' },
            { kind: 'activity', handler: 'second' },
          ],
        },
      ],
    });
    await engine.start('two-steps', null, { id: 'run-history' });
    await settled(engine, 'run-history', 'failed');
    const lifecycle = async () => {
      const events = await engine.getEvents('run-history');
      return events
        .filter((event) => event.type.startsWith('file-workflow:'))
        .map(
          (event) =>
            `${event.type.slice('file-workflow:'.length)}:${String(event.data['step'] ?? event.data['status'])}`,
        );
    };
    const failedHistory = await lifecycle();
    expect(failedHistory.filter((event) => event === 'run-terminal:failed')).toHaveLength(1);

    control.failing = false;
    await engine.retryFailed('run-history');
    await settled(engine, 'run-history', 'completed');

    const history = await lifecycle();
    // What happened before the retry stays, and the retry's events follow it.
    expect(history.slice(0, failedHistory.length)).toEqual(failedHistory);
    const retried = history.slice(failedHistory.length);
    expect(retried).toEqual([
      'step-started:1',
      'activity-started:1',
      'activity-completed:1',
      'step-completed:1',
      'run-terminal:completed',
    ]);
    // The step that completed before the failure is not started again.
    expect(history.filter((event) => event === 'step-started:0')).toHaveLength(1);
  });
});
