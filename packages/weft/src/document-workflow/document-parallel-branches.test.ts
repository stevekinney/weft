/**
 * COR-2416: what a branch of a parallel step may hold, now that each branch runs on its own: an
 * activity that retries, a child workflow, a parallel step of its own, and a `map`. Each is
 * checked beside a sibling that waits, across a restart that comes after the branch's step.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from "../../test-support/embedded/testing/src/fake-timers.ts";
import { waitUntil } from "../../test-support/embedded/testing/src/wait-until.ts";

import { deserializeCheckpoint } from '../core/checkpoint.ts';
import { isParallelOperationCacheEntry } from '../core/context/parallel-cache-entry.ts';
import { Engine } from '../core/engine/index.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { KEYS } from '../storage/keys.ts';
import { settleInlineLaunches } from '../testing/inline-launch-settle.test-support.ts';
import { TestEngine } from '../testing/test-engine.ts';
import type { DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const calls: string[] = [];
let flakyAttempts = 0;
let gatedAttempts = 0;
let gate = Promise.withResolvers<string>();

/** A step input as the call log records it: a string as written, anything else as JSON. */
function labelOf(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

const child = workflow({ name: 'branch-child', version: '1' }).execute(async function* (
  _context: WorkflowContext,
  input: unknown,
) {
  yield* [];
  calls.push('child');
  return { echoed: input };
});

const host: DocumentWorkflowHost = {
  activities: {
    count: ({ input }) => {
      calls.push(labelOf(input));
      return input;
    },
    list: () => ({ items: ['x', 'y'] }),
    flaky: {
      retry: { maxAttempts: 2, initialBackoff: 5, backoffMultiplier: 1, maxBackoff: 5 },
      execute: ({ input }) => {
        flakyAttempts += 1;
        calls.push(labelOf(input));
        if (flakyAttempts === 1) throw new Error('first attempt fails');
        return `settled after ${String(flakyAttempts)}`;
      },
    },
    // Fails once, then holds its second attempt until the test lets it go.
    gatedFlaky: {
      retry: { maxAttempts: 2, initialBackoff: 5, backoffMultiplier: 1, maxBackoff: 5 },
      execute: () => {
        gatedAttempts += 1;
        if (gatedAttempts === 1) throw new Error('first attempt fails');
        return gate.promise;
      },
    },
    each: ({ previous }) => {
      calls.push(`each:${String(previous)}`);
      return previous;
    },
  },
  triggerKinds: { manual: () => undefined },
  workflows: ['branch-child'],
  workflowVersions: { 'branch-child': '1' },
};

const manual = { kind: 'manual' };
const parallel = (branches: Record<string, unknown>) => ({ kind: 'parallel', branches });
const wait = (signal: string) => ({ kind: 'await-signal', signal });
const doc = (name: string, steps: readonly unknown[]) => ({ name, trigger: manual, steps });

async function isWaitingOn(engine: Engine, id: string, signal: string): Promise<boolean> {
  const state = await engine.get(id);
  return (state?.waitingForSignals ?? []).includes(signal);
}

/** Whether the run's committed checkpoint holds a finished branch slot. */
async function hasFulfilledSlot(storage: MemoryStorage, id: string): Promise<boolean> {
  const bytes = await storage.get(KEYS.checkpoint(id));
  if (bytes === null) return false;
  const entry = deserializeCheckpoint(bytes)
    .accumulatedResults.map(([, value]) => value)
    .find(isParallelOperationCacheEntry);
  return entry?.branches.some((slot) => slot.status === 'fulfilled') ?? false;
}

/** Start `document`, wait for its sibling wait, restart, finish it, and return its result. */
async function runAcrossRestart(document: ReturnType<typeof doc>, finished: () => boolean) {
  const storage = new MemoryStorage();
  const id = `${document.name}-run`;
  {
    await using original = new Engine({ storage });
    original.register(child);
    await registerWorkflowDocuments(original, host, { active: [document] });
    await original.start(document.name, null, { id });
    await waitUntil(async () => (await isWaitingOn(original, id, 'go')) && finished(), {
      message: 'the branch to finish and the sibling to wait',
    });
    // The branch's commit follows its last step: wait for it before the restart.
    await waitUntil(async () => hasFulfilledSlot(storage, id), {
      message: 'the finished branch to be committed',
    });
  }
  await using restarted = new Engine({ storage });
  restarted.register(child);
  await registerWorkflowDocuments(restarted, host, { active: [document] });
  const [handle] = await restarted.recoverAll();
  await waitUntil(async () => isWaitingOn(restarted, id, 'go'), { message: 'the sibling to wait' });
  await handle!.signal('go', 'signalled');
  // Awaited here: the restarted engine is disposed as this function returns.
  return await handle!.result();
}

describe('what a branch of a parallel step may hold', () => {
  it('retries an activity inside a branch while a sibling waits, and runs it no more across a restart', async () => {
    calls.length = 0;
    flakyAttempts = 0;
    const result = await runAcrossRestart(
      doc('branch-retry', [
        parallel({ a: [{ kind: 'activity', handler: 'flaky', input: 'f' }], b: [wait('go')] }),
      ]),
      () => flakyAttempts === 2,
    );
    expect(result).toEqual({ a: 'settled after 2', b: 'signalled' });
    expect(flakyAttempts).toBe(2);
  });

  it('starts a child workflow inside a branch while a sibling waits, and starts it once across a restart', async () => {
    calls.length = 0;
    const result = await runAcrossRestart(
      doc('branch-child-workflow', [
        parallel({
          a: [{ kind: 'workflow', workflow: 'branch-child', input: 'kid' }],
          b: [wait('go')],
        }),
      ]),
      () => calls.includes('child'),
    );
    expect(result).toEqual({ a: { echoed: 'kid' }, b: 'signalled' });
    expect(calls.filter((call) => call === 'child')).toHaveLength(1);
  });

  it('runs a parallel step nested in a branch, and a map in a branch, beside a sibling that waits', async () => {
    calls.length = 0;
    const result = await runAcrossRestart(
      doc('branch-nested', [
        parallel({
          a: [
            parallel({
              x: [{ kind: 'activity', handler: 'count', input: 'x' }],
              y: [{ kind: 'activity', handler: 'count', input: 'y' }],
            }),
          ],
          m: [
            { kind: 'activity', handler: 'list' },
            { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'each' }] },
          ],
          b: [wait('go')],
        }),
      ]),
      () => calls.includes('each:y'),
    );
    expect(result).toEqual({ a: { x: 'x', y: 'y' }, m: ['x', 'y'], b: 'signalled' });
  });

  it('keeps the retry state of an activity per branch, though two branches have a step with the same number', async () => {
    // Branch `a` retries its activity at its step 1 and holds the retry's second attempt open;
    // branch `b` then runs a plain activity at its own step 1. The retry state `a` keeps in the
    // checkpoint is qualified by its branch, or `b`'s activity would find an attempt it never made.
    calls.length = 0;
    gatedAttempts = 0;
    gate = Promise.withResolvers<string>();
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(child);
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('branch-retry-state', [
          parallel({
            a: [
              { kind: 'activity', handler: 'count', input: 'a0' },
              { kind: 'activity', handler: 'gatedFlaky' },
            ],
            b: [wait('go'), { kind: 'activity', handler: 'count', input: 'b1' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('branch-retry-state', null, { id: 'branch-retry-state-run' });
    await waitUntil(async () => gatedAttempts === 2, { message: 'the retry to begin its attempt' });
    await run.signal('go', 'signalled');
    await waitUntil(async () => calls.includes('b1'), { message: 'the sibling`s activity to run' });
    gate.resolve('retried');
    expect(await run.result()).toEqual({ a: 'retried', b: 'b1' });
  });

  it('runs branches of uneven length, each to its own last step', async () => {
    calls.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(child);
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('branch-uneven', [
          parallel({
            long: [
              { kind: 'activity', handler: 'count', input: 'l1' },
              { kind: 'activity', handler: 'count', input: 'l2' },
              { kind: 'activity', handler: 'count', input: 'l3' },
            ],
            short: [{ kind: 'activity', handler: 'count', input: 's1' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('branch-uneven', null, { id: 'branch-uneven-run' });
    expect(await run.result()).toEqual({ long: 'l3', short: 's1' });
    // Each branch's steps run in their own order.
    expect(calls.filter((call) => call.startsWith('l'))).toEqual(['l1', 'l2', 'l3']);
  });

  it('times out a run waiting in a parallel step, as it does one waiting at the top level', async () => {
    const engine = new TestEngine();
    await registerWorkflowDocuments(engine, host, {
      active: [doc('branch-execution-timeout', [parallel({ a: [wait('one')], b: [wait('two')] })])],
    });
    const run = await engine.start('branch-execution-timeout', null, {
      id: 'branch-execution-timeout-run',
      executionTimeout: '1 second',
    });
    run.result().catch(() => undefined);
    await settleInlineLaunches();
    await engine.advanceTime('2 seconds');
    await settleInlineLaunches();
    const state = await engine.get(run.id);
    expect(state?.status).toBe('timed-out');
    engine[Symbol.dispose]();
  });
});

describe('a timed wait in a branch of a parallel step', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('keeps a deadline per branch: the shorter timeout wins first, and the longer one is not cut short', async () => {
    // Each branch's wait races a sleep at its own step 0 and 1. The deadline a sleep keeps in the
    // checkpoint is qualified by its branch, or the second branch would reuse the first's.
    useFakeTimers(0);
    await using engine = new Engine({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('branch-deadlines', [
          parallel({
            short: [{ kind: 'await-signal', signal: 'one', timeout: '1h' }],
            long: [{ kind: 'await-signal', signal: 'two', timeout: '3h' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('branch-deadlines', null, { id: 'branch-deadlines-run' });
    await waitUntil(async () => (await waitingLabel(engine, run.id)) === 'one,two', {
      message: 'both branches to wait',
    });
    await advanceTimersByTime(60 * 60 * 1000);
    await waitUntil(async () => (await waitingLabel(engine, run.id)) === 'two', {
      message: 'the shorter timeout to win',
    });
    // An hour in, the longer timeout has two to go: the wait is still open.
    expect(await waitingLabel(engine, run.id)).toBe('two');
    await advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(await run.result()).toEqual({ short: { timedOut: true }, long: { timedOut: true } });
  });

  it('still waits on the step after a map in a branch once it restarts there (finding F1, map rounds after the first)', async () => {
    // A map with no wait runs its two items in two lockstep rounds of its own inside the branch,
    // then the branch waits. Before the fix the replay read the second round, and then the wait,
    // one number early: the run ended once the sibling had its signal, without waiting on `w`.
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'branch-map-then-wait-run';
    const document = doc('branch-map-then-wait', [
      parallel({
        m: [
          { kind: 'activity', handler: 'list' },
          {
            kind: 'map',
            over: 'items',
            steps: [
              { kind: 'activity', handler: 'each' },
              { kind: 'activity', handler: 'each' },
            ],
          },
          wait('w'),
        ],
        b: [wait('go')],
      }),
    ]);
    {
      await using original = new Engine({ storage });
      original.register(child);
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start(document.name, null, { id });
      await waitUntil(async () => (await isWaitingOn(original, id, 'w')) && calls.length === 4, {
        message: 'the map to finish and its branch to wait',
      });
    }
    await using restarted = new Engine({ storage });
    restarted.register(child);
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('go', 'G');
    await waitUntil(
      async () =>
        (await statusOf(restarted, id)) !== 'running' ||
        (await waitingLabel(restarted, id)) === 'w',
      { message: 'the sibling to take go, and the run to wait on w or end' },
    );
    expect(await statusOf(restarted, id)).toBe('running');
    await handle!.signal('w', 'W');
    expect(await handle!.result()).toEqual({ m: 'W', b: 'G' });
    // The map ran once: the restart resumed the branch after it.
    expect(calls).toEqual(['each:x', 'each:y', 'each:x', 'each:y']);
  });

  it('stops waiting for its signal when the timeout wins, across a restart, while a sibling waits on', async () => {
    useFakeTimers(0);
    const storage = new MemoryStorage();
    const id = 'branch-timed-wait-run';
    const document = doc('branch-timed-wait', [
      parallel({
        a: [{ kind: 'await-signal', signal: 'go', timeout: '1h' }],
        b: [wait('two')],
      }),
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('branch-timed-wait', null, { id });
      await waitUntil(async () => (await waitingLabel(original, id)) === 'go,two', {
        message: 'both branches to wait',
      });
      await advanceTimersByTime(60 * 60 * 1000);
      await waitUntil(async () => (await waitingLabel(original, id)) === 'two', {
        message: 'the timed wait to stop',
      });
      await waitUntil(async () => hasFulfilledSlot(storage, id), {
        message: 'the branch whose timeout won to be committed',
      });
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'two'), {
      message: 'the sibling to wait again',
    });
    expect(await waitingNames(restarted, id)).toEqual(['two']);
    await handle!.signal('two', 'B');
    expect(await handle!.result()).toEqual({ a: { timedOut: true }, b: 'B' });
  });
});

async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

async function waitingNames(engine: Engine, id: string): Promise<readonly string[]> {
  const state = await engine.get(id);
  return state?.waitingForSignals ?? [];
}

/** The names a run waits on, sorted and joined: `go,two`. */
async function waitingLabel(engine: Engine, id: string): Promise<string> {
  const names = await waitingNames(engine, id);
  return names.toSorted().join(',');
}
