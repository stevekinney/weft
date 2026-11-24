/**
 * COR-2416: the branches of an advancing parallel step count their own steps, so the number of a
 * step does not depend on the order its siblings settle in, and a replay of the same results
 * numbers every step the same way.
 */
import { describe, expect, it } from 'bun:test';

import { advanceBranches } from './advancing-operations.ts';
import { branchDriversOf, type BranchDriver, type BranchStep } from './branch-driver.ts';
import { Context } from './index.ts';
import { getInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import {
  isParallelOperationCacheEntry,
  type ParallelOperationCacheEntry,
} from './parallel-cache-entry.ts';

const first = async () => 'first';
const second = async () => 'second';
const third = async () => 'third';

function createContext(accumulatedResults?: Map<number, unknown>): Context {
  return new Context({
    workflowId: 'wf-advance',
    workflowType: 'test',
    startedAt: 1000,
    abortController: new AbortController(),
    ...(accumulatedResults === undefined ? {} : { accumulatedResults }),
  });
}

/** Two branches of two activities each, and one of three, built on `ctx`. */
function branches(ctx: Context) {
  return {
    a: (function* () {
      const one = yield* ctx.run(first);
      const two = yield* ctx.run(second);
      return `${one}+${two}`;
    })(),
    b: (function* () {
      const one = yield* ctx.run(first);
      const two = yield* ctx.run(second);
      const three = yield* ctx.run(third);
      return `${one}+${two}+${three}`;
    })(),
  };
}

type Started = {
  ctx: Context;
  request: ContextOperationRequest;
  drivers: readonly BranchDriver[];
  generator: Generator<ContextOperationRequest, unknown[], unknown>;
};

function start(accumulatedResults?: Map<number, unknown>): Started {
  const ctx = createContext(accumulatedResults);
  const { a, b } = branches(ctx);
  const generator = advanceBranches(ctx, getInternals(ctx), [a, b]);
  const yielded = generator.next();
  if (yielded.done) throw new Error('expected the step to yield an operation');
  const drivers = branchDriversOf(yielded.value);
  if (drivers === undefined) throw new Error('expected an advancing parallel request');
  return { ctx, request: yielded.value, drivers, generator };
}

/** The step number an activity request carries, which is the branch's own count. */
function stepOf(step: BranchStep): number | undefined {
  if (step.done) return undefined;
  return step.request.type === 'activity' ? step.request.step : undefined;
}

/** Settle each branch's current operation, in `order`, until every branch is done. */
function settleInOrder(started: Started, order: readonly number[]): Record<string, number[]> {
  const stepsSeen: Record<string, number[]> = { a: [], b: [] };
  const names = ['a', 'b'];
  const current = started.drivers.map((driver) => driver.first);
  for (const [index, step] of current.entries()) stepsSeen[names[index]!]!.push(stepOf(step)!);
  let turn = 0;
  while (current.some((step) => !step.done)) {
    const index = order[turn % order.length]!;
    turn += 1;
    if (current[index]!.done) continue;
    const next = started.drivers[index]!.resume({
      status: 'fulfilled',
      value: `value-${String(turn)}`,
    });
    current[index] = next;
    if (!next.done) stepsSeen[names[index]!]!.push(stepOf(next)!);
  }
  return stepsSeen;
}

describe('the steps of an advancing parallel step', () => {
  it('are numbered from zero in each branch, in whatever order the branches settle', () => {
    const orders: readonly [string, readonly number[]][] = [
      ['a first, then b', [0, 0, 1, 1, 1]],
      ['b first, then a', [1, 1, 1, 0, 0]],
      ['taking turns', [0, 1, 0, 1, 1]],
    ];
    const seen = orders.map(([, order]) => settleInOrder(start(), order));
    for (const steps of seen) expect(steps).toEqual({ a: [0, 1], b: [0, 1, 2] });
  });

  it('are the same after a replay from the results each branch kept, whichever settled first', () => {
    for (const settledFirst of [0, 1]) {
      const original = start();
      const settled = original.drivers[settledFirst]!.resume({
        status: 'fulfilled',
        value: 'kept',
      });
      expect(settled.done).toBe(false);
      const results = original.drivers.map((driver) => driver.results());
      // What the engine commits: a pending slot per branch with the results it kept.
      const entry: ParallelOperationCacheEntry = {
        __weftParallelOperationCache: true,
        formatVersion: 2,
        variant: 'all',
        subOperationCount: 2,
        branches: results.map((kept, index) => ({
          status: 'pending',
          operationId: `parallel:0:${String(index)}`,
          ...(kept.length === 0 ? {} : { results: kept }),
        })),
      };
      expect(isParallelOperationCacheEntry(entry)).toBe(true);
      const replayed = start(new Map([[0, entry]]));
      // The branch that had settled a step picks up at its next step; the other starts over.
      const expectedSteps = [0, 0];
      expectedSteps[settledFirst] = 1;
      expect(replayed.drivers.map((driver) => stepOf(driver.first))).toEqual(expectedSteps);
    }
  });

  it('leaves the step the context numbers next unchanged, whatever the branches do', () => {
    const started = start();
    expect(getInternals(started.ctx).stepIndex).toBe(1);
    settleInOrder(started, [0, 1]);
    expect(getInternals(started.ctx).stepIndex).toBe(1);
  });

  it('returns a finished step from its cache entry without asking the engine for anything', () => {
    const ctx = createContext(
      new Map([
        [
          0,
          {
            __weftParallelOperationCache: true,
            formatVersion: 2,
            variant: 'all',
            subOperationCount: 2,
            branches: [
              { status: 'fulfilled', value: 'left', operationId: 'parallel:0:0' },
              { status: 'fulfilled', value: 'right', operationId: 'parallel:0:1' },
            ],
          },
        ],
      ]),
    );
    const { a, b } = branches(ctx);
    const result = advanceBranches(ctx, getInternals(ctx), [a, b]).next();
    expect(result).toEqual({ done: true, value: ['left', 'right'] });
  });

  it('refuses a cache entry whose branch count differs from the step it replays', () => {
    const ctx = createContext(
      new Map([
        [
          0,
          {
            __weftParallelOperationCache: true,
            formatVersion: 2,
            variant: 'all',
            subOperationCount: 3,
            branches: [
              { status: 'pending', operationId: 'parallel:0:0' },
              { status: 'pending', operationId: 'parallel:0:1' },
              { status: 'pending', operationId: 'parallel:0:2' },
            ],
          },
        ],
      ]),
    );
    const { a, b } = branches(ctx);
    expect(() => advanceBranches(ctx, getInternals(ctx), [a, b]).next()).toThrow(
      'branch count changed',
    );
  });
});
