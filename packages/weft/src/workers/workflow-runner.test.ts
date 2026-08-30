import { describe, expect, it } from 'bun:test';
import { deserializeCheckpoint, serializeCheckpoint } from '../core/checkpoint.ts';
import { readCheckpointReplayPayload } from '../core/engine/checkpoint-replay.ts';
import type { OperationRequest, WorkerOutboundMessage } from '../core/types.ts';
import {
  createWorkflowRunnerContext,
  handleCancelMessage,
  handleResumeMessage,
  handleRunMessage,
} from './workflow-runner.ts';

describe('createWorkflowRunnerContext', () => {
  it('returns empty maps for generators and abort controllers', () => {
    const context = createWorkflowRunnerContext();

    expect(context.generators).toBeInstanceOf(Map);
    expect(context.abortControllers).toBeInstanceOf(Map);
    expect(context.generators.size).toBe(0);
    expect(context.abortControllers.size).toBe(0);
  });
});

describe('handleRunMessage', () => {
  it('returns completed for a simple generator that finishes immediately', async () => {
    const context = createWorkflowRunnerContext();

    async function* simpleWorkflow() {
      return 'done';
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-1', workflowType: 'simple', input: null },
      () => simpleWorkflow,
    );

    expect(result).toEqual({
      type: 'completed',
      workflowId: 'wf-1',
      result: 'done',
    } satisfies WorkerOutboundMessage);
  });

  it('returns failed for an unknown workflow type', async () => {
    const context = createWorkflowRunnerContext();

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-2', workflowType: 'unknown', input: null },
      () => undefined,
    );

    expect(result.type).toBe('failed');
    expect(result.workflowId).toBe('wf-2');
    expect((result as { error: string }).error).toContain('unknown');
  });

  it('returns failed when the generator throws', async () => {
    const context = createWorkflowRunnerContext();

    async function* throwingWorkflow() {
      throw new Error('workflow exploded');
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-3', workflowType: 'throwing', input: null },
      () => throwingWorkflow,
    );

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toContain('workflow exploded');
    expect(result.type === 'failed' ? result.failureCategory : undefined).toBe('application');
  });

  it('cleans up state when the workflow handler throws before returning a generator', async () => {
    const context = createWorkflowRunnerContext();

    function synchronousThrowWorkflow(): AsyncGenerator {
      throw new Error('handler exploded');
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-sync-throw', workflowType: 'throwing-handler', input: null },
      () => synchronousThrowWorkflow,
    );

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toContain('handler exploded');
    expect(context.abortControllers.has('wf-sync-throw')).toBe(false);
    expect(context.generators.has('wf-sync-throw')).toBe(false);
    expect(context.replayStates.has('wf-sync-throw')).toBe(false);
  });

  it('classifies timeout-shaped worker run failures', async () => {
    class ReviewTimeoutError extends Error {
      constructor() {
        super('review timed out');
        this.name = 'ReviewTimeoutError';
      }
    }

    const context = createWorkflowRunnerContext();

    async function* timeoutWorkflow() {
      throw new ReviewTimeoutError();
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-timeout', workflowType: 'timeout', input: null },
      () => timeoutWorkflow,
    );

    expect(result.type).toBe('failed');
    expect(result.type === 'failed' ? result.failureCategory : undefined).toBe('timeout');
  });

  it('returns a checkpoint when the generator yields an operation request', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-4',
      kind: 'activity',
      queue: 'default',
      activityName: 'greet',
      input: 'world',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* yieldingWorkflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-4', workflowType: 'yielding', input: null },
      () => yieldingWorkflow,
    );

    expect(result.type).toBe('checkpoint');
    expect(result.workflowId).toBe('wf-4');
    expect((result as { operationRequest: OperationRequest }).operationRequest).toEqual(
      operationRequest,
    );

    // Generator should be stored for later resumption
    expect(context.generators.has('wf-4')).toBe(true);
  });

  it('passes input to the generator function', async () => {
    const context = createWorkflowRunnerContext();
    let receivedInput: unknown;

    async function* inputWorkflow(_ctx: unknown, input: unknown) {
      receivedInput = input;
      return 'processed';
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-5', workflowType: 'input-test', input: { key: 'value' } },
      () => inputWorkflow,
    );

    expect(receivedInput).toEqual({ key: 'value' });
  });

  it('passes a worker-side context as the first argument', async () => {
    const context = createWorkflowRunnerContext();
    let receivedContext: { workflowId: string } | undefined;

    async function* contextWorkflow(ctx: unknown, _input: unknown) {
      receivedContext = ctx as { workflowId: string };
      return 'ok';
    }

    await handleRunMessage(
      context,
      {
        workflowId: 'wf-with-context',
        workflowType: 'context-test',
        input: null,
      },
      () => contextWorkflow,
    );

    expect(receivedContext).toBeDefined();
    expect(receivedContext!.workflowId).toBe('wf-with-context');
  });

  it('exposes an abort signal on the worker context that aborts on cancel', async () => {
    const context = createWorkflowRunnerContext();
    let capturedSignal: AbortSignal | undefined;

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-signal',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* signalWorkflow(ctx: { signal: AbortSignal }, _input: unknown) {
      capturedSignal = ctx.signal;
      yield operationRequest;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-signal', workflowType: 'signal-test', input: null },
      () => signalWorkflow,
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    await handleCancelMessage(context, { workflowId: 'wf-signal' });
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('registers an abort controller for the workflow', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-6',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* pendingWorkflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-6', workflowType: 'pending', input: null },
      () => pendingWorkflow,
    );

    expect(context.abortControllers.has('wf-6')).toBe(true);
  });

  it('fails with a clear error when a worker-side workflow calls ctx.state.session()', async () => {
    const context = createWorkflowRunnerContext();

    async function* sessionWorkflow(
      ctx: {
        state: { session<T>(key: string, options?: { initial?: T }): { get(): T | undefined } };
      },
      _input: unknown,
    ) {
      ctx.state.session('draft', { initial: { count: 0 } }).get();
      return 'ok';
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-worker-session-state', workflowType: 'session-state-test', input: null },
      () => sessionWorkflow,
    );

    expect(result.type).toBe('failed');
    const error = (result as { error: string }).error;
    expect(error).toContain('Workflow type "session-state-test"');
    expect(error).toContain('ctx.state.session()');
    expect(error).toContain("workflowExecutionMode: 'inline'");
    expect(error).toContain('ctx.state.workflow() or ctx.state.execution()');
  });

  it('routes worker-side durable state through operation requests', async () => {
    const context = createWorkflowRunnerContext();

    async function* stateWorkflow(
      ctx: {
        state: {
          execution<T>(
            key: string,
            options?: { initial?: T },
          ): { get(): Generator<unknown, T | undefined, unknown> };
        };
      },
      _input: unknown,
    ) {
      return yield* ctx.state.execution<number>('counter', { initial: 0 }).get();
    }

    const result = await handleRunMessage(
      context,
      {
        workflowId: 'wf-worker-state',
        workflowType: 'state-test',
        input: null,
        executionStateOwnerId: 'wf-owner',
      },
      () => stateWorkflow,
    );

    expect(result.type).toBe('checkpoint');
    if (result.type !== 'checkpoint') return;
    expect(result.operationRequest).toMatchObject({
      type: 'state-read',
      scope: { type: 'execution', ownerWorkflowId: 'wf-owner' },
      key: 'counter',
      initial: 0,
    });
  });

  it('routes worker-side workflow state through operation requests', async () => {
    const context = createWorkflowRunnerContext();

    async function* stateWorkflow(
      ctx: {
        state: {
          workflow<T>(
            key: string,
            options?: { initial?: T },
          ): { get(): Generator<unknown, T | undefined, unknown> };
        };
      },
      _input: unknown,
    ) {
      return yield* ctx.state.workflow<number>('counter', { initial: 0 }).get();
    }

    const result = await handleRunMessage(
      context,
      {
        workflowId: 'wf-worker-workflow-state',
        workflowType: 'state-test',
        input: null,
      },
      () => stateWorkflow,
    );

    expect(result.type).toBe('checkpoint');
    if (result.type !== 'checkpoint') return;
    expect(result.operationRequest).toMatchObject({
      type: 'state-read',
      scope: { type: 'workflow', workflowType: 'state-test' },
      key: 'counter',
      initial: 0,
    });
  });
});

describe('handleResumeMessage', () => {
  it('resumes a yielded generator and returns completed', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-resume-1',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* twoStepWorkflow() {
      const result: unknown = yield operationRequest;
      return `got: ${String(result)}`;
    }

    // First, run the workflow to its first yield
    await handleRunMessage(
      context,
      { workflowId: 'wf-resume-1', workflowType: 'two-step', input: null },
      () => twoStepWorkflow,
    );

    // Now resume it
    const result = await handleResumeMessage(context, {
      workflowId: 'wf-resume-1',
      result: 'hello',
    });

    expect(result).toEqual({
      type: 'completed',
      workflowId: 'wf-resume-1',
      result: 'got: hello',
    } satisfies WorkerOutboundMessage);

    // Generator should be cleaned up after completion
    expect(context.generators.has('wf-resume-1')).toBe(false);
  });

  it('returns failed when resuming a non-existent workflow', async () => {
    const context = createWorkflowRunnerContext();

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-nonexistent',
      result: null,
    });

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toContain('wf-nonexistent');
  });

  it('throws the operation error into the generator when operationResult is failed', async () => {
    const context = createWorkflowRunnerContext();
    let caughtError: string | undefined;

    const operationRequest: OperationRequest = {
      id: 'op-fail',
      workflowId: 'wf-op-fail',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: { maxAttempts: 1, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      scheduledAt: Date.now(),
    };

    async function* failureHandlingWorkflow() {
      try {
        yield operationRequest;
      } catch (error) {
        caughtError = (error as Error).message;
      }
      return 'caught';
    }

    // Run to first yield
    await handleRunMessage(
      context,
      { workflowId: 'wf-op-fail', workflowType: 'fail-test', input: null },
      () => failureHandlingWorkflow,
    );

    // Resume with a failed operation outcome
    const result = await handleResumeMessage(context, {
      workflowId: 'wf-op-fail',
      result: null,
      operationResult: { status: 'failed', error: 'activity timed out' },
    });

    expect(result.type).toBe('completed');
    expect(caughtError).toBe('activity timed out');
  });

  it('returns the next checkpoint when the generator yields again', async () => {
    const context = createWorkflowRunnerContext();

    const firstOperation: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-multi',
      kind: 'activity',
      queue: 'default',
      activityName: 'step1',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    const secondOperation: OperationRequest = {
      id: 'op-2',
      workflowId: 'wf-multi',
      kind: 'activity',
      queue: 'default',
      activityName: 'step2',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* multiStepWorkflow() {
      const first: unknown = yield firstOperation;
      const second: unknown = yield secondOperation;
      return { first, second };
    }

    // Run to first yield
    await handleRunMessage(
      context,
      { workflowId: 'wf-multi', workflowType: 'multi', input: null },
      () => multiStepWorkflow,
    );

    // Resume with first result -> should yield again
    const secondCheckpoint = await handleResumeMessage(context, {
      workflowId: 'wf-multi',
      result: 'result-1',
    });

    expect(secondCheckpoint.type).toBe('checkpoint');
    expect((secondCheckpoint as { operationRequest: OperationRequest }).operationRequest).toEqual(
      secondOperation,
    );

    // Resume with second result -> should complete
    const final = await handleResumeMessage(context, {
      workflowId: 'wf-multi',
      result: 'result-2',
    });

    expect(final).toEqual({
      type: 'completed',
      workflowId: 'wf-multi',
      result: { first: 'result-1', second: 'result-2' },
    } satisfies WorkerOutboundMessage);
  });

  it('replays cached worker results from a checkpoint without re-emitting completed operations', async () => {
    const firstContext = createWorkflowRunnerContext();
    const firstOperation = createActivityOperation('wf-replay', 'step1', 'one');
    const secondOperation = createActivityOperation('wf-replay', 'step2', 'two');

    async function* replayWorkflow() {
      const first: unknown = yield firstOperation;
      const second: unknown = yield secondOperation;
      return { first, second };
    }

    await handleRunMessage(
      firstContext,
      { workflowId: 'wf-replay', workflowType: 'replay', input: null },
      () => replayWorkflow,
    );
    const checkpointBeforeRestart = await handleResumeMessage(firstContext, {
      workflowId: 'wf-replay',
      result: 'persisted-result',
    });

    expect(checkpointBeforeRestart.type).toBe('checkpoint');
    if (checkpointBeforeRestart.type !== 'checkpoint') return;

    const recoveredContext = createWorkflowRunnerContext();
    const recoveredCheckpoint = await handleRunMessage(
      recoveredContext,
      {
        workflowId: 'wf-replay',
        workflowType: 'replay',
        input: null,
        checkpoint: checkpointBeforeRestart.checkpoint,
      },
      () => replayWorkflow,
    );

    expect(recoveredCheckpoint.type).toBe('checkpoint');
    if (recoveredCheckpoint.type !== 'checkpoint') return;
    expect(recoveredCheckpoint.operationRequest).toEqual(secondOperation);

    const final = await handleResumeMessage(recoveredContext, {
      workflowId: 'wf-replay',
      result: 'second-result',
    });
    expect(final).toEqual({
      type: 'completed',
      workflowId: 'wf-replay',
      result: { first: 'persisted-result', second: 'second-result' },
    } satisfies WorkerOutboundMessage);
  });

  it('keeps Worker checkpoint messages bounded by pending replay deltas instead of all completed steps', async () => {
    const context = createWorkflowRunnerContext();
    const workflowId = 'wf-bounded-worker';
    const activityCount = 25;
    const operations = Array.from({ length: activityCount }, (_, index) =>
      createActivityOperation(workflowId, `step-${index}`, { index }),
    );
    const activityResult = { value: 'x'.repeat(200) };
    const checkpointSizes: number[] = [];

    async function* boundedWorkflow() {
      for (const operation of operations) {
        yield operation;
      }
      return 'done';
    }

    let message = await handleRunMessage(
      context,
      { workflowId, workflowType: 'bounded-worker', input: null },
      () => boundedWorkflow,
    );

    for (let index = 0; index < activityCount; index += 1) {
      expect(message.type).toBe('checkpoint');
      if (message.type !== 'checkpoint') return;

      checkpointSizes.push(message.checkpoint.byteLength);
      const checkpoint = deserializeCheckpoint(new Uint8Array(message.checkpoint));
      const replayPayload = readCheckpointReplayPayload(checkpoint);
      expect(
        checkpoint.accumulatedResults.length + (replayPayload?.accumulatedResults?.length ?? 0),
      ).toBeLessThanOrEqual(1);

      message = await handleResumeMessage(context, {
        workflowId,
        result: { ...activityResult, index },
      });
    }

    expect(message).toEqual({
      type: 'completed',
      workflowId,
      result: 'done',
    } satisfies WorkerOutboundMessage);
    expect(checkpointSizes.length).toBe(activityCount);
    expect(Math.max(...checkpointSizes)).toBeLessThan(1_500);
  });

  it('replays failed operation outcomes from the Worker failure side table', async () => {
    const firstContext = createWorkflowRunnerContext();
    const firstOperation = createActivityOperation('wf-failed-outcome-replay', 'step1', 'one');
    const secondOperation = createActivityOperation('wf-failed-outcome-replay', 'step2', 'two');

    async function* replayWorkflow() {
      let caughtError = 'none';
      try {
        yield firstOperation;
      } catch (error) {
        caughtError = (error as Error).message;
      }
      const second: unknown = yield secondOperation;
      return { caughtError, second };
    }

    await handleRunMessage(
      firstContext,
      { workflowId: 'wf-failed-outcome-replay', workflowType: 'replay', input: null },
      () => replayWorkflow,
    );
    const checkpointBeforeRestart = await handleResumeMessage(firstContext, {
      workflowId: 'wf-failed-outcome-replay',
      result: undefined,
      operationResult: {
        status: 'failed',
        error: 'activity timed out',
        failureCategory: 'timeout',
      },
    });

    expect(checkpointBeforeRestart.type).toBe('checkpoint');
    if (checkpointBeforeRestart.type !== 'checkpoint') return;

    const checkpoint = deserializeCheckpoint(new Uint8Array(checkpointBeforeRestart.checkpoint));
    expect(checkpoint.accumulatedResults).toEqual([]);
    expect(checkpoint.workerReplayFailures).toBeUndefined();
    expect(readCheckpointReplayPayload(checkpoint)?.workerReplayFailures).toEqual([
      [
        0,
        {
          status: 'failed',
          error: 'activity timed out',
          failureCategory: 'timeout',
        },
      ],
    ]);

    const recoveredContext = createWorkflowRunnerContext();
    const recoveredCheckpoint = await handleRunMessage(
      recoveredContext,
      {
        workflowId: 'wf-failed-outcome-replay',
        workflowType: 'replay',
        input: null,
        checkpoint: checkpointBeforeRestart.checkpoint,
      },
      () => replayWorkflow,
    );

    expect(recoveredCheckpoint.type).toBe('checkpoint');
    if (recoveredCheckpoint.type !== 'checkpoint') return;
    expect(recoveredCheckpoint.operationRequest).toEqual(secondOperation);

    const final = await handleResumeMessage(recoveredContext, {
      workflowId: 'wf-failed-outcome-replay',
      result: 'second-result',
    });
    expect(final).toEqual({
      type: 'completed',
      workflowId: 'wf-failed-outcome-replay',
      result: { caughtError: 'activity timed out', second: 'second-result' },
    } satisfies WorkerOutboundMessage);
  });

  it('fails closed when a cached worker result has no replay signature', async () => {
    const context = createWorkflowRunnerContext();
    const operation = createActivityOperation('wf-missing-signature', 'step1', 'one');

    async function* replayWorkflow() {
      const result: unknown = yield operation;
      return result;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-missing-signature', workflowType: 'replay', input: null },
      () => replayWorkflow,
    );
    const checkpointMessage = await handleResumeMessage(context, {
      workflowId: 'wf-missing-signature',
      result: 'persisted-result',
    });
    expect(checkpointMessage.type).toBe('completed');

    const checkpoint = deserializeCheckpoint(
      serializeCheckpoint({
        workflowId: 'wf-missing-signature',
        step: 1,
        locals: {},
        accumulatedResults: [[0, 'persisted-result']],
        searchAttributes: {},
        version: 'worker',
        schemaVersion: 2,
        createdAt: Date.now(),
      }),
    );

    const recovered = await handleRunMessage(
      createWorkflowRunnerContext(),
      {
        workflowId: 'wf-missing-signature',
        workflowType: 'replay',
        input: null,
        checkpoint: bytesToArrayBuffer(serializeCheckpoint(checkpoint)),
      },
      () => replayWorkflow,
    );

    expect(recovered).toMatchObject({
      type: 'failed',
      workflowId: 'wf-missing-signature',
      failureCategory: 'system',
    });
  });

  it('fails closed when a cached worker result signature no longer matches the yielded operation', async () => {
    const context = createWorkflowRunnerContext();
    const originalOperation = createActivityOperation('wf-mismatch', 'step1', 'original');
    const changedOperation = createActivityOperation('wf-mismatch', 'step1', 'changed');

    async function* originalWorkflow() {
      const first: unknown = yield originalOperation;
      yield createActivityOperation('wf-mismatch', 'step2', 'next');
      return first;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-mismatch', workflowType: 'replay', input: null },
      () => originalWorkflow,
    );
    const checkpointBeforeRestart = await handleResumeMessage(context, {
      workflowId: 'wf-mismatch',
      result: 'persisted-result',
    });
    expect(checkpointBeforeRestart.type).toBe('checkpoint');
    if (checkpointBeforeRestart.type !== 'checkpoint') return;

    async function* changedWorkflow() {
      const first: unknown = yield changedOperation;
      yield createActivityOperation('wf-mismatch', 'step2', 'next');
      return first;
    }

    const recovered = await handleRunMessage(
      createWorkflowRunnerContext(),
      {
        workflowId: 'wf-mismatch',
        workflowType: 'replay',
        input: null,
        checkpoint: checkpointBeforeRestart.checkpoint,
      },
      () => changedWorkflow,
    );

    expect(recovered).toMatchObject({
      type: 'failed',
      workflowId: 'wf-mismatch',
      failureCategory: 'system',
    });
  });

  it('replays user results that resemble Worker failure records as normal values', async () => {
    const firstContext = createWorkflowRunnerContext();
    const firstOperation = createActivityOperation('wf-marker-collision', 'step1', 'one');
    const secondOperation = createActivityOperation('wf-marker-collision', 'step2', 'two');
    const userResult = {
      __weftWorkerOperationFailure: true,
      version: 1,
      outcome: { status: 'failed', error: 'user data, not an internal failure' },
    };

    async function* replayWorkflow() {
      const first: unknown = yield firstOperation;
      yield secondOperation;
      return first;
    }

    await handleRunMessage(
      firstContext,
      { workflowId: 'wf-marker-collision', workflowType: 'replay', input: null },
      () => replayWorkflow,
    );
    const checkpointBeforeRestart = await handleResumeMessage(firstContext, {
      workflowId: 'wf-marker-collision',
      result: userResult,
    });

    expect(checkpointBeforeRestart.type).toBe('checkpoint');
    if (checkpointBeforeRestart.type !== 'checkpoint') return;

    const recoveredContext = createWorkflowRunnerContext();
    const recoveredCheckpoint = await handleRunMessage(
      recoveredContext,
      {
        workflowId: 'wf-marker-collision',
        workflowType: 'replay',
        input: null,
        checkpoint: checkpointBeforeRestart.checkpoint,
      },
      () => replayWorkflow,
    );

    expect(recoveredCheckpoint.type).toBe('checkpoint');
    if (recoveredCheckpoint.type !== 'checkpoint') return;
    expect(recoveredCheckpoint.operationRequest).toEqual(secondOperation);

    const final = await handleResumeMessage(recoveredContext, {
      workflowId: 'wf-marker-collision',
      result: 'second-result',
    });
    expect(final).toEqual({
      type: 'completed',
      workflowId: 'wf-marker-collision',
      result: userResult,
    } satisfies WorkerOutboundMessage);
  });

  it('updates replay maxProtocolMessageBytes from resume messages before issuing the next checkpoint', async () => {
    const context = createWorkflowRunnerContext();
    const firstOperation = createActivityOperation('wf-max-protocol', 'step1', 'one');
    const secondOperation = createActivityOperation('wf-max-protocol', 'step2', {
      payload: 'x'.repeat(5_000),
    });

    async function* replayWorkflow() {
      yield firstOperation;
      yield secondOperation;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-max-protocol', workflowType: 'replay', input: null },
      () => replayWorkflow,
    );

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-max-protocol',
      result: 'done',
      maxProtocolMessageBytes: 4_096,
    });

    expect(result).toMatchObject({
      type: 'failed',
      workflowId: 'wf-max-protocol',
      failureCategory: 'application',
    });
    expect(result.type === 'failed' ? result.error : '').toContain('exceeding limit 4096');
  });

  it('fails closed when a pending worker replay signature no longer matches the yielded operation', async () => {
    const originalCheckpoint = createWorkflowRunnerContext();

    async function* originalWorkflow() {
      yield createActivityOperation('wf-pending-mismatch', 'step1', 'original');
      yield createActivityOperation('wf-pending-mismatch', 'step2', 'next');
    }

    const checkpoint = await handleRunMessage(
      originalCheckpoint,
      { workflowId: 'wf-pending-mismatch', workflowType: 'replay', input: null },
      () => originalWorkflow,
    );
    expect(checkpoint.type).toBe('checkpoint');
    if (checkpoint.type !== 'checkpoint') return;

    async function* changedWorkflow() {
      yield createActivityOperation('wf-pending-mismatch', 'step1', 'changed');
      yield createActivityOperation('wf-pending-mismatch', 'step2', 'next');
    }

    const recovered = await handleRunMessage(
      createWorkflowRunnerContext(),
      {
        workflowId: 'wf-pending-mismatch',
        workflowType: 'replay',
        input: null,
        checkpoint: checkpoint.checkpoint,
      },
      () => changedWorkflow,
    );

    expect(recovered).toMatchObject({
      type: 'failed',
      workflowId: 'wf-pending-mismatch',
      failureCategory: 'system',
    });
  });
});

function createActivityOperation(
  workflowId: string,
  activityName: string,
  input: unknown,
): OperationRequest {
  return {
    id: `${workflowId}:${activityName}`,
    workflowId,
    kind: 'activity',
    queue: 'default',
    activityName,
    input,
    attempt: 1,
    retryPolicy: {
      maxAttempts: 3,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30_000,
    },
    scheduledAt: Date.now(),
  };
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe('handleCancelMessage', () => {
  it('aborts the controller for a running workflow', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-cancel',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* cancellableWorkflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-cancel', workflowType: 'cancellable', input: null },
      () => cancellableWorkflow,
    );

    const controller = context.abortControllers.get('wf-cancel');
    expect(controller).toBeDefined();
    expect(controller!.signal.aborted).toBe(false);

    await handleCancelMessage(context, { workflowId: 'wf-cancel' });

    expect(controller!.signal.aborted).toBe(true);
  });

  it('is a no-op for a non-existent workflow', async () => {
    const context = createWorkflowRunnerContext();

    // Should not throw
    await handleCancelMessage(context, { workflowId: 'wf-nonexistent' });
  });

  it('cleans up generators and controllers after cancellation', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-cleanup',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* workflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-cleanup', workflowType: 'workflow', input: null },
      () => workflow,
    );

    await handleCancelMessage(context, { workflowId: 'wf-cleanup' });

    expect(context.generators.has('wf-cleanup')).toBe(false);
    expect(context.abortControllers.has('wf-cleanup')).toBe(false);
    expect(context.replayStates.has('wf-cleanup')).toBe(false);
  });

  it('runs finally blocks in the workflow generator when cancelled', async () => {
    const context = createWorkflowRunnerContext();
    let sideEffect = 0;

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-finally',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* finallyWorkflow() {
      try {
        const result: unknown = yield operationRequest;
        return result;
      } finally {
        sideEffect++;
      }
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-finally', workflowType: 'finally-test', input: null },
      () => finallyWorkflow,
    );

    expect(sideEffect).toBe(0);

    await handleCancelMessage(context, { workflowId: 'wf-finally' });

    expect(sideEffect).toBe(1);
    expect(context.generators.has('wf-finally')).toBe(false);
    expect(context.abortControllers.has('wf-finally')).toBe(false);
  });

  it('swallows exceptions thrown from a workflow generator finalizer on cancel', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-finally-throws',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    const throwOnDispose = (): never => {
      throw new Error('finalizer exploded');
    };

    async function* throwingFinallyWorkflow() {
      try {
        yield operationRequest;
      } finally {
        throwOnDispose();
      }
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-finally-throws', workflowType: 'throw-finally', input: null },
      () => throwingFinallyWorkflow,
    );

    // Must not throw even though the finalizer raises.
    await handleCancelMessage(context, { workflowId: 'wf-finally-throws' });

    expect(context.generators.has('wf-finally-throws')).toBe(false);
    expect(context.abortControllers.has('wf-finally-throws')).toBe(false);
  });

  it('does not clobber a freshly-installed workflow when cancel races with a new run of the same id', async () => {
    // Regression: `handleCancelMessage` is async because it awaits
    // `generator.return()` so finally blocks can run. During that await,
    // the worker message loop can process another message for the same
    // workflow id — including a `run` that installs a brand-new generator
    // and controller in the context maps. The old cleanup unconditionally
    // deleted by workflow id, wiping the new workflow's state. The fix is
    // an identity check: only delete if the entry still matches what the
    // cancel handler captured before awaiting.
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-race',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    // First workflow: `finally` block awaits a slow disposer so
    // `generator.return()` takes long enough for us to interleave another
    // message before cleanup runs.
    let resolveDisposer!: () => void;
    const disposerGate = new Promise<void>((resolve) => {
      resolveDisposer = resolve;
    });

    async function* slowCleanupWorkflow() {
      try {
        yield operationRequest;
      } finally {
        await disposerGate;
      }
    }

    async function* secondWorkflow() {
      yield operationRequest;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-race', workflowType: 'slow-cleanup', input: null },
      () => slowCleanupWorkflow,
    );

    const originalController = context.abortControllers.get('wf-race');
    const originalGenerator = context.generators.get('wf-race');
    const originalReplayState = context.replayStates.get('wf-race');
    expect(originalController).toBeDefined();
    expect(originalGenerator).toBeDefined();
    expect(originalReplayState).toBeDefined();

    // Kick off cancel; it will park on `await generator.return()` because
    // the workflow's finally block is waiting on `disposerGate`.
    const cancelPromise = handleCancelMessage(context, { workflowId: 'wf-race' });

    // Give the cancel handler a microtask to capture the original
    // generator/controller and enter the await.
    await Promise.resolve();

    // Simulate a concurrent `run` that installs a new workflow with the
    // same id. This is the scenario the race guards against.
    await handleRunMessage(
      context,
      { workflowId: 'wf-race', workflowType: 'second', input: null },
      () => secondWorkflow,
    );

    const newController = context.abortControllers.get('wf-race');
    const newGenerator = context.generators.get('wf-race');
    const newReplayState = context.replayStates.get('wf-race');
    expect(newController).toBeDefined();
    expect(newGenerator).toBeDefined();
    expect(newReplayState).toBeDefined();
    expect(newController).not.toBe(originalController);
    expect(newGenerator).not.toBe(originalGenerator);
    expect(newReplayState).not.toBe(originalReplayState);

    // Release the slow disposer so cancel can finish cleanup.
    resolveDisposer();
    await cancelPromise;

    // After the cancel handler's cleanup step runs, the newly installed
    // workflow must still be present — the identity check must have
    // prevented the stale cancel from deleting it.
    expect(context.abortControllers.get('wf-race')).toBe(newController);
    expect(context.generators.get('wf-race')).toBe(newGenerator);
    expect(context.replayStates.get('wf-race')).toBe(newReplayState);
  });
});

describe('handleResumeMessage — error paths', () => {
  it('returns failed when the generator throws on resume', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-throw-on-resume',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* throwOnResumeWorkflow() {
      yield operationRequest;
      throw new Error('resume exploded');
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-throw-on-resume', workflowType: 'throwing', input: null },
      () => throwOnResumeWorkflow,
    );

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-throw-on-resume',
      result: 'trigger',
    });

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toContain('resume exploded');
    expect(result.type === 'failed' ? result.failureCategory : undefined).toBe('application');

    // Generator should be cleaned up
    expect(context.generators.has('wf-throw-on-resume')).toBe(false);
    expect(context.abortControllers.has('wf-throw-on-resume')).toBe(false);
  });
});

describe('formatError', () => {
  it('handles non-Error thrown values in handleRunMessage', async () => {
    const context = createWorkflowRunnerContext();

    async function* nonErrorThrow() {
      throw 'string-error';
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-non-error', workflowType: 'non-error', input: null },
      () => nonErrorThrow,
    );

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toBe('string-error');
    expect(result.type === 'failed' ? result.failureCategory : undefined).toBe('system');
  });

  it('handles non-Error thrown values in handleResumeMessage', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-non-error-resume',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* nonErrorResumeThrow() {
      yield operationRequest;
      throw 42;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-non-error-resume', workflowType: 'non-error-resume', input: null },
      () => nonErrorResumeThrow,
    );

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-non-error-resume',
      result: 'trigger',
    });

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toBe('42');
    expect(result.type === 'failed' ? result.failureCategory : undefined).toBe('system');
  });

  it('preserves failed operation categories when an operation failure terminates the workflow', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-operation-failure-category',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* uncaughtOperationFailure() {
      yield operationRequest;
    }

    await handleRunMessage(
      context,
      {
        workflowId: 'wf-operation-failure-category',
        workflowType: 'operation-failure',
        input: null,
      },
      () => uncaughtOperationFailure,
    );

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-operation-failure-category',
      result: undefined,
      operationResult: {
        status: 'failed',
        error: 'review timed out',
        errorName: 'ReviewTimeoutError',
        failureCategory: 'timeout',
      },
    });

    expect(result.type).toBe('failed');
    expect(result.type === 'failed' ? result.failureCategory : undefined).toBe('timeout');
  });
});
