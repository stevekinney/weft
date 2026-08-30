import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import type { QueryDefinition, WorkflowContext } from '../types.ts';
import { query, update, workflow } from '../types.ts';

async function flushWorkflowTurn(): Promise<void> {
  await sleepForTesting(10);
}

async function waitForQuery<T>(
  handle: { query(definition: QueryDefinition<void, T>): Promise<T> },
  definition: QueryDefinition<void, T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await handle.query(definition);
    if (result !== undefined) {
      return result;
    }
    await flushWorkflowTurn();
  }

  throw new Error(`Expected query "${definition.name}" to become available`);
}

describe('core execution and messaging parity', () => {
  let engine: TestEngine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('round-trips a workflow activity result through ctx.run()', async () => {
    engine = new TestEngine();

    const formatGreeting = async (_input: { name: string }) => {
      throw new Error('Expected the TestEngine mock to replace the activity implementation');
    };
    const formatGreetingMock = engine.mock(formatGreeting, async (input: { name: string }) => {
      return `Hello, ${input.name}`;
    });

    const greetingWorkflow = workflow({ name: 'parity-greeting' }).execute(async function* (
      context: WorkflowContext,
      input: { name: string },
    ) {
      const mockedActivity = engine?.mocks.get(formatGreeting);
      const activityImplementation = mockedActivity
        ? mockedActivity.implementation
        : formatGreeting;

      return yield* context.run(activityImplementation, input);
    });

    engine.register(greetingWorkflow);

    const handle = await engine.start('parity-greeting', { name: 'Ada' });

    await expect(handle.result()).resolves.toBe('Hello, Ada');
    expect(formatGreetingMock.callCount).toBe(1);
    expect(formatGreetingMock.lastCall?.input).toEqual({ name: 'Ada' });
  });

  it('delivers a signal sent to a running workflow', async () => {
    engine = new TestEngine();

    const approvalWorkflow = workflow({ name: 'parity-signal-approval' }).execute(async function* (
      context: WorkflowContext,
    ) {
      return yield* context.waitForSignal<{ approved: boolean }>('approval');
    });
    engine.register(approvalWorkflow);

    const handle = await engine.start('parity-signal-approval', null);
    await flushWorkflowTurn();

    await handle.signal('approval', { approved: true });

    await expect(handle.result()).resolves.toEqual({ approved: true });
  });

  it('buffers signals sent before the workflow reaches the wait point and delivers them in order', async () => {
    engine = new TestEngine();

    const bufferedSignalWorkflow = workflow({ name: 'parity-buffered-signals' }).execute(
      async function* (context: WorkflowContext) {
        yield* context.waitForSignal('release');
        const first = yield* context.waitForSignal<string>('item');
        const second = yield* context.waitForSignal<string>('item');
        return [first, second];
      },
    );
    engine.register(bufferedSignalWorkflow);

    const handle = await engine.start('parity-buffered-signals', null);

    await handle.signal('item', 'first');
    await handle.signal('item', 'second');
    await handle.signal('release', null);

    await expect(handle.result()).resolves.toEqual(['first', 'second']);
  });

  it('preserves buffered signal order across engine recovery', async () => {
    const firstEngine = new TestEngine({ startTime: 1_000 });
    engine = firstEngine;

    const recoveredSignalWorkflow = workflow({ name: 'parity-recovered-buffered-signals' }).execute(
      async function* (context: WorkflowContext) {
        yield* context.waitForSignal('release');
        const first = yield* context.waitForSignal<string>('item');
        const second = yield* context.waitForSignal<string>('item');
        return [first, second];
      },
    );
    firstEngine.register(recoveredSignalWorkflow);

    const handle = await firstEngine.start('parity-recovered-buffered-signals', null, {
      id: 'parity-recovered-buffered-signals-id',
    });

    await handle.signal('item', 'first');

    const recoveredEngine = firstEngine.recover();
    firstEngine[Symbol.dispose]();
    engine = recoveredEngine;
    recoveredEngine.register(recoveredSignalWorkflow);

    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles.map((recoveredHandle) => recoveredHandle.id)).toEqual([handle.id]);
    const recoveredHandle = recoveredHandles[0]!;
    await flushWorkflowTurn();

    await recoveredHandle.signal('item', 'second');
    await recoveredHandle.signal('release', null);

    await expect(recoveredHandle.result()).resolves.toEqual(['first', 'second']);
  });

  it('queries running workflow state without mutating it', async () => {
    engine = new TestEngine();
    const counterQuery = query<void, { counter: number }>('counter');

    const queryableWorkflow = workflow({ name: 'parity-queryable-counter' }).execute(
      async function* (context: WorkflowContext) {
        let counter = 1;
        context.expose({ counter: () => ({ counter }) });

        counter = yield* context.waitForSignal<number>('set-counter');
        yield* context.waitForSignal('finish');
        return counter;
      },
    );
    engine.register(queryableWorkflow);

    const handle = await engine.start('parity-queryable-counter', null);
    await flushWorkflowTurn();

    expect(await waitForQuery(handle, counterQuery)).toEqual({ counter: 1 });
    expect(await waitForQuery(handle, counterQuery)).toEqual({ counter: 1 });

    await handle.signal('set-counter', 7);
    await flushWorkflowTurn();

    expect(await waitForQuery(handle, counterQuery)).toEqual({ counter: 7 });

    await handle.signal('finish', null);
    await expect(handle.result()).resolves.toBe(7);
  });

  it('returns a typed update response synchronously to the caller', async () => {
    engine = new TestEngine();
    const approveUpdate = update<{ amount: number }, { approved: boolean; amount: number }>(
      'approve',
    );

    const updateWorkflow = workflow({ name: 'parity-update-round-trip' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const { payload, respond } = yield* context.waitForUpdate(approveUpdate);
      const response = { approved: true, amount: payload.amount };
      respond(response);
      return `approved:${payload.amount}`;
    });
    engine.register(updateWorkflow);

    const handle = await engine.start('parity-update-round-trip', null);
    await flushWorkflowTurn();

    await expect(handle.update(approveUpdate, { amount: 42 })).resolves.toEqual({
      approved: true,
      amount: 42,
    });
    await expect(handle.result()).resolves.toBe('approved:42');
  });

  it('resumes a review workflow with an approved decision', async () => {
    engine = new TestEngine();

    const reviewWorkflow = workflow({ name: 'parity-review-approved' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const decision = yield* context.review({
        artifact: { invoiceId: 'inv-1', amount: 42 },
        reviewers: ['alice'],
        reviewType: 'expense-approval',
      });

      return {
        approved: decision.decision === 'approved',
        reviewer: decision.reviewer,
      };
    });
    engine.register(reviewWorkflow);

    const handle = await engine.start('parity-review-approved', null);
    await flushWorkflowTurn();

    const reviews = await engine.listReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      workflowId: handle.id,
      reviewType: 'expense-approval',
      reviewers: ['alice'],
    });

    await engine.submitReview(reviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: handle.id,
    });

    await expect(handle.result()).resolves.toEqual({
      approved: true,
      reviewer: 'alice',
    });
    await expect(engine.listReviews()).resolves.toHaveLength(0);
  });

  it('resumes a review workflow with a rejected decision', async () => {
    engine = new TestEngine();

    const reviewWorkflow = workflow({ name: 'parity-review-rejected' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const decision = yield* context.review({
        artifact: { invoiceId: 'inv-2', amount: 1000 },
        reviewers: ['bob'],
        reviewType: 'expense-approval',
      });

      return {
        decision: decision.decision,
        feedback: decision.feedback,
      };
    });
    engine.register(reviewWorkflow);

    const handle = await engine.start('parity-review-rejected', null);
    await flushWorkflowTurn();

    const reviews = await engine.listReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      workflowId: handle.id,
      reviewType: 'expense-approval',
      reviewers: ['bob'],
    });

    await engine.submitReview(reviews[0]!.reviewId, {
      decision: 'rejected',
      reviewer: 'bob',
      feedback: 'Amount exceeds the approval policy.',
      workflowId: handle.id,
    });

    await expect(handle.result()).resolves.toEqual({
      decision: 'rejected',
      feedback: 'Amount exceeds the approval policy.',
    });
    await expect(engine.listReviews()).resolves.toHaveLength(0);
  });
});
