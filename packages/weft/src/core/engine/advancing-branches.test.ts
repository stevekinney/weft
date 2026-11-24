/**
 * COR-2416: the engine side of an advancing parallel step. Every branch moves on as soon as its own
 * operation settles; each settled step commits while a sibling is unfinished, naming what it
 * completed; the commits are chained and bound to the run that began the step.
 */
import { describe, expect, it } from 'bun:test';

import { quietFor, waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";

import { documentActivityOperation } from '../../document-workflow/interpreter.ts';
import { advanceBranchesOf } from '../context/advancing-operations.ts';
import { Context } from '../context/index.ts';
import type { ContextOperationRequest } from '../context/operation-request.ts';
import type { ParallelOperationCacheEntry } from '../context/parallel-cache-entry.ts';
import type { MidOperationCommitReport } from './checkpoint-io.ts';
import { createDeferredConsumeEnvelope } from './deferred-consume-envelope.ts';
import { stagedCoordinatorCompletion } from './file-workflow-completion-events.ts';
import type { EngineInternals } from './internals.ts';
import { processParallelOperation } from './operations-coordination.ts';

const WORKFLOW_ID = 'wf-advancing';

type Gate = PromiseWithResolvers<unknown>;

/**
 * A step with branches `a` and `b` whose activities the test settles by hand. A branch is a list of
 * activity names; each runs as a document step at the address `${step}#${branch}`.
 */
function advancingHarness(
  shape: Record<string, readonly string[]>,
  options: { persistFailure?: Error } = {},
) {
  const ctx = new Context({
    workflowId: WORKFLOW_ID,
    workflowType: 'test',
    startedAt: 1000,
    abortController: new AbortController(),
  });
  const gates = new Map<string, Gate>();
  const executed: string[] = [];
  const names = Object.keys(shape);
  const branches = names.map((name, branchIndex) =>
    (function* () {
      let last: unknown;
      for (const [position, activityName] of shape[name]!.entries()) {
        // `=twice` is an `all` that waits on the signal `x` twice; `~go` waits for the signal `go`;
        // any other name is an activity of that name.
        if (activityName === '=twice') {
          last = yield* ctx.all([ctx.waitForSignal('x'), ctx.waitForSignal('x')]);
          continue;
        }
        if (activityName.startsWith('~')) {
          last = yield* ctx.waitForSignal(activityName.slice(1));
          continue;
        }
        const run = ctx.run(
          Object.defineProperty(async () => activityName, 'name', { value: activityName }),
        );
        last = yield* documentActivityOperation(
          run as Generator<ContextOperationRequest, unknown, unknown>,
          branchIndex * 10 + position,
          `${String(branchIndex * 10 + position)}#${name}`,
        );
      }
      return last;
    })(),
  );
  const generator = advanceBranchesOf(ctx, branches);
  const yielded = generator.next();
  if (yielded.done) throw new Error('expected an operation');
  const request = yielded.value as Extract<ContextOperationRequest, { type: 'parallel' }>;

  const accumulatedResults = new Map<number, unknown>();
  const entry = {
    step: 0,
    operationType: 'parallel',
    operationLabel: 'parallel',
    inputSummary: '',
    timestamp: 0,
    status: 'running' as 'running' | 'completed' | 'failed',
  };
  const internals = {
    inlineStrategy: { getContext: () => ({ accumulatedResults }) },
    durableInlineOperations: new Map([
      [WORKFLOW_ID, { operationId: request.operationId, workflowExecutionToken: undefined }],
    ]),
    checkpoints: new Map(),
    pendingTimelineEntries: new Map([[WORKFLOW_ID, { startedAt: 0, entry }]]),
  } as unknown as EngineInternals;

  const commits: {
    entry: ParallelOperationCacheEntry;
    active: string[];
    report: MidOperationCommitReport | undefined;
  }[] = [];
  let inFlight = 0;
  let overlapped = false;
  let outcome: { value?: unknown; error?: unknown } = {};
  /** Names of the signal waits whose consume was finalized, in order, with the commits so far. */
  const finalized: string[] = [];
  let heldCommit: PromiseWithResolvers<void> | undefined;
  const done = processParallelOperation(internals, WORKFLOW_ID, request, {
    executeSubOperation: async (_id, operation, signal) => {
      const name =
        operation.type === 'wait-signal'
          ? `~${operation.signalName}`
          : operation.type === 'activity'
            ? operation.activityName
            : undefined;
      if (name === undefined) throw new Error(`unexpected ${operation.type}`);
      executed.push(name);
      // A name a branch asks for again gets a gate of its own: `settle` resolves the latest.
      const gate: Gate = Promise.withResolvers();
      gates.set(name, gate);
      signal?.addEventListener('abort', () => gate.reject(signal.reason), { once: true });
      const settled = await gate.promise;
      // A wait resolves with a deferred-consume envelope, which stages its consume when finalized.
      return operation.type === 'wait-signal'
        ? createDeferredConsumeEnvelope(async () => {
            finalized.push(`finalize ${name}`);
            return settled;
          })
        : settled;
    },
    runOperationWithResult: async (_id, _operation, execute) => {
      try {
        outcome = { value: await execute() };
      } catch (error) {
        outcome = { error };
      }
    },
    persistCheckpoint: async (_id, committing, report) => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      commits.push({
        entry: structuredClone(accumulatedResults.get(0)) as ParallelOperationCacheEntry,
        active: (
          committing as Extract<ContextOperationRequest, { type: 'parallel' }>
        ).operations.map((operation) =>
          operation.type === 'activity' ? operation.activityName : operation.type,
        ),
        report,
      });
      await Promise.resolve();
      if (heldCommit !== undefined) {
        const held = heldCommit;
        heldCommit = undefined;
        await held.promise;
      }
      finalized.push('commit written');
      inFlight -= 1;
      if (options.persistFailure !== undefined) throw options.persistFailure;
    },
  });
  return {
    commits,
    executed,
    entry,
    accumulatedResults,
    overlapped: () => overlapped,
    outcome: () => outcome,
    done,
    internals,
    request,
    async settle(activityName: string, value: unknown = activityName.toLowerCase()) {
      await waitUntil(async () => gates.has(activityName), {
        message: `${activityName} to start`,
      });
      gates.get(activityName)!.resolve(value);
    },
    fail(activityName: string, error: Error) {
      gates.get(activityName)!.reject(error);
    },
    finalized,
    /** Hold the next commit open until `release` is called. */
    holdNextCommit(): () => void {
      const held = Promise.withResolvers<void>();
      heldCommit = held;
      return () => held.resolve();
    },
    /** Make the run that began the step no longer the current one. */
    replaceRun() {
      internals.durableInlineOperations.set(WORKFLOW_ID, {
        operationId: 'another-operation',
        workflowExecutionToken: undefined,
      } as never);
    },
  };
}

const eventTypes = (report: MidOperationCommitReport | undefined) =>
  (report?.settledFileWorkflowEvents ?? []).map(
    (event) =>
      `${event.type.replace('file-workflow:', '')}@${String(event.payload['stepAddress'])}`,
  );

describe('the engine side of an advancing parallel step', () => {
  it('moves a branch on to its next step as soon as the current one settles', async () => {
    const harness = advancingHarness({ a: ['A1', 'A2'], b: ['B1'] });
    await waitUntil(async () => harness.executed.length === 2);
    expect(harness.executed).toEqual(['A1', 'B1']);
    await harness.settle('A1');
    // `a` starts its second step while `b` is still on its first.
    await waitUntil(async () => harness.executed.includes('A2'));
    expect(harness.executed).toEqual(['A1', 'B1', 'A2']);
    await harness.settle('A2');
    await harness.settle('B1');
    await harness.done;
    expect(harness.outcome()).toEqual({ value: ['a2', 'b1'] });
  });

  it('commits each settled step with the results its branch kept, and what the step completed', async () => {
    const harness = advancingHarness({ a: ['A1', 'A2'], b: ['B1'] });
    await harness.settle('A1');
    await waitUntil(async () => harness.commits.length === 1);
    const [commit] = harness.commits;
    expect(commit!.entry.branches.map((slot) => slot.status)).toEqual(['pending', 'pending']);
    const slotA = commit!.entry.branches[0]!;
    expect(slotA.status === 'pending' ? slotA.results : undefined).toEqual([[0, 'a1']]);
    // The step the commit opens is named, so its start is recorded; the one it settled completes.
    expect(commit!.active).toEqual(['A2', 'B1']);
    expect(eventTypes(commit!.report)).toEqual(['activity-completed@0#a', 'step-completed@0#a']);
    expect(commit!.report?.settledBranchOperationIds).toHaveLength(1);
    await harness.settle('B1');
    await harness.settle('A2');
    await harness.done;
  });

  it('commits nothing for the step that settles the last branch, and stages what it completed', async () => {
    const harness = advancingHarness({ a: ['A1'], b: ['B1'] });
    await harness.settle('A1');
    await waitUntil(async () => harness.commits.length === 1);
    await harness.settle('B1');
    await harness.done;
    expect(harness.commits).toHaveLength(1);
    expect(harness.outcome()).toEqual({ value: ['a1', 'b1'] });
    const staged = stagedCoordinatorCompletion(harness.entry);
    expect(staged?.events.map((event) => event.type)).toEqual([
      'file-workflow:activity-completed',
      'file-workflow:step-completed',
    ]);
  });

  const orders: readonly [string, readonly string[]][] = [
    ['a before b', ['A1', 'A2', 'B1', 'B2']],
    ['b before a', ['B1', 'B2', 'A1', 'A2']],
    ['interleaved', ['A1', 'B1', 'B2', 'A2']],
  ];
  for (const [name, order] of orders) {
    it(`writes the same final entry however the branches settle: ${name}`, async () => {
      const harness = advancingHarness({ a: ['A1', 'A2'], b: ['B1', 'B2'] });
      for (const activityName of order) await harness.settle(activityName);
      await harness.done;
      expect(harness.outcome()).toEqual({ value: ['a2', 'b2'] });
      const finalEntry = harness.accumulatedResults.get(0) as ParallelOperationCacheEntry;
      expect(finalEntry.branches.map((slot) => slot.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(finalEntry.branches.map((slot) => slot.operationId)).toEqual([
        'parallel:0:0',
        'parallel:0:1',
      ]);
    });
  }

  it('stages the consume of a settled wait into the commit of its own step, never one a sibling opened first', async () => {
    // A commit takes every consume staged for the workflow when it writes. A wait whose step
    // settles while a sibling's commit is still being assembled must not stage its consume into
    // that commit: the signal would go with a checkpoint that does not hold the wait's result.
    const harness = advancingHarness({ a: ['A1', 'A2'], b: ['~go', 'B2'] });
    await waitUntil(async () => harness.executed.length === 2);
    const release = harness.holdNextCommit();
    await harness.settle('A1');
    await waitUntil(async () => harness.commits.length === 1);
    await harness.settle('~go', 'payload');
    await quietFor(20);
    // The wait's step queues behind the sibling's commit: nothing is finalized yet.
    expect(harness.finalized).toEqual([]);
    release();
    await waitUntil(async () => harness.commits.length === 2);
    expect(harness.finalized.slice(0, 2)).toEqual(['commit written', 'finalize ~go']);
    await harness.settle('A2');
    await harness.settle('B2');
    await harness.done;
    expect(harness.outcome()).toEqual({ value: ['a2', 'b2'] });
  });

  it('never overlaps two commits when branches settle together', async () => {
    const harness = advancingHarness({ a: ['A1', 'A2'], b: ['B1', 'B2'], c: ['C1'] });
    await harness.settle('A1');
    await harness.settle('B1');
    await harness.settle('C1');
    await harness.settle('A2');
    await harness.settle('B2');
    await harness.done;
    expect(harness.overlapped()).toBe(false);
  });

  it('ends a branch that throws, lets its siblings settle, and rethrows its error', async () => {
    const harness = advancingHarness({ a: ['A1'], b: ['B1', 'B2'] });
    await waitUntil(async () => harness.executed.length === 2);
    harness.fail('A1', new Error('branch a failed'));
    await harness.settle('B1');
    await harness.settle('B2');
    await harness.done;
    expect((harness.outcome().error as Error).message).toBe('branch a failed');
    const finalEntry = harness.accumulatedResults.get(0) as ParallelOperationCacheEntry;
    expect(finalEntry.branches.map((slot) => slot.status)).toEqual(['rejected', 'fulfilled']);
  });

  it('holds a branch whose next wait is on a signal a sibling waits on, until that wait ends', async () => {
    // Two waiters on one signal name would share a waiter key. The lockstep rounds never had both
    // open at once, so a document that runs is not refused: the second wait opens when the first ends.
    const harness = advancingHarness({ a: ['A1', '~shared'], b: ['~shared'] });
    await waitUntil(async () => harness.executed.length === 2);
    await harness.settle('A1');
    await quietFor(20);
    // `a` has finished its first step, and its wait is not open yet.
    expect(harness.executed).toEqual(['A1', '~shared']);
    await harness.settle('~shared', 'first');
    await waitUntil(async () => harness.executed.filter((name) => name === '~shared').length === 2);
    await harness.settle('~shared', 'second');
    await harness.done;
    expect(harness.outcome()).toEqual({ value: ['second', 'first'] });
    // The held wait is named by a commit once it opens, so its start is recorded.
    expect(harness.commits.some((commit) => commit.active.includes('wait-signal'))).toBe(true);
  });

  it('fails the step at once for an operation that waits on one signal twice within itself', async () => {
    const harness = advancingHarness({ a: ['A1', '=twice'], b: ['B1'] });
    await harness.settle('A1');
    await waitUntil(async () => harness.outcome().error !== undefined);
    expect((harness.outcome().error as Error).message).toContain('same signal "x"');
    await harness.done;
  });

  it('fails the step with the commit failure, and commits no later step', async () => {
    const harness = advancingHarness(
      { a: ['A1', 'A2', 'A3'], b: ['B1'] },
      { persistFailure: new Error('checkpoint write refused') },
    );
    await harness.settle('A1');
    await waitUntil(async () => harness.commits.length === 1);
    await harness.settle('A2');
    await harness.settle('B1');
    await harness.settle('A3');
    await harness.done;
    expect(harness.commits).toHaveLength(1);
    expect((harness.outcome().error as Error).message).toBe('checkpoint write refused');
  });

  it('starts nothing more, and commits nothing, once the run is no longer the current one', async () => {
    const harness = advancingHarness({ a: ['A1', 'A2'], b: ['B1'] });
    await waitUntil(async () => harness.executed.length === 2);
    harness.replaceRun();
    await harness.settle('A1');
    await harness.settle('B1');
    await harness.done;
    expect(harness.executed).toEqual(['A1', 'B1']);
    expect(harness.commits).toHaveLength(0);
    expect(harness.outcome().error).toBeInstanceOf(Error);
  });
});
