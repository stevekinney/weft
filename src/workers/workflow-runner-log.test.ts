import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { WorkerLoggerReplayState } from '../core/context/workflow-logger.ts';
import type { OperationRequest, WorkflowLogRecord } from '../core/types.ts';
import {
  createWorkerWorkflowContext,
  createWorkflowRunnerContext,
  handleResumeMessage,
  handleRunMessage,
  type WorkerWorkflowContext,
} from './workflow-runner.ts';

/** Capture console.{debug,info,warn,error} records for assertions. */
function captureConsole(): { records: WorkflowLogRecord[]; restore: () => void } {
  const records: WorkflowLogRecord[] = [];
  const originals = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    console[method] = mock((record: unknown) => records.push(record as WorkflowLogRecord));
  }
  return {
    records,
    restore: () => {
      console.debug = originals.debug;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

function activityOperation(
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
    retryPolicy: { maxAttempts: 3, initialBackoff: 1000, backoffMultiplier: 2, maxBackoff: 30_000 },
    scheduledAt: 0,
  };
}

describe('worker ctx.log', () => {
  let captured: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    captured = captureConsole();
  });
  afterEach(() => {
    captured.restore();
  });

  it('exposes a structured logger that auto-carries the worker run identity', async () => {
    const context = createWorkflowRunnerContext();
    let observedWorkflowType: string | undefined;
    async function* loggingWorkflow(ctx: WorkerWorkflowContext) {
      // The logger's auto-attached workflowType must match ctx.workflowType —
      // worker mode previously omitted workflowType from the context entirely.
      observedWorkflowType = ctx.workflowType;
      ctx.log.info('worker started', { phase: 'init' });
      return 'done';
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-worker-log', workflowType: 'worker-log-demo', input: null },
      () => loggingWorkflow,
    );

    expect(result.type).toBe('completed');
    expect(observedWorkflowType).toBe('worker-log-demo');
    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]).toMatchObject({
      level: 'info',
      message: 'worker started',
      workflowId: 'wf-worker-log',
      workflowType: 'worker-log-demo',
      attributes: { phase: 'init' },
    });
    // The logger's auto-attached workflowType matches the context's workflowType.
    expect(captured.records[0]!.workflowType).toBe('worker-log-demo');
    expect(typeof captured.records[0]!.timestamp).toBe('number');
  });

  it('suppresses logs in the replayed prefix on recovery but emits at the live frontier', async () => {
    // A workflow that logs BEFORE each durable step. On the fresh run it logs
    // 'before-1' (live) then parks on step 1. On recovery it replays the body:
    // 'before-1' sits at a cached step (suppressed), then 'before-2' is the live
    // frontier (emitted). This is the worker analogue of the inline post-step
    // suppression and the bounded check that nextStepIndex reconciliation works.
    const op1 = activityOperation('wf-worker-replay', 'step1', 'one');
    const op2 = activityOperation('wf-worker-replay', 'step2', 'two');

    async function* loggingWorkflow(ctx: WorkerWorkflowContext) {
      ctx.log.info('before-1');
      const first: unknown = yield op1;
      ctx.log.info('before-2');
      const second: unknown = yield op2;
      return { first, second };
    }

    // Fresh run: emits 'before-1' (live), then parks requesting op1.
    const firstContext = createWorkflowRunnerContext();
    const firstResult = await handleRunMessage(
      firstContext,
      { workflowId: 'wf-worker-replay', workflowType: 'replay', input: null },
      () => loggingWorkflow,
    );
    // Assert the operation boundary, not just the console: the run must park on op1.
    expect(firstResult.type).toBe('checkpoint');
    expect(firstResult.type === 'checkpoint' ? firstResult.operationRequest : undefined).toEqual(
      op1,
    );
    expect(captured.records.map((r) => r.message)).toEqual(['before-1']);
    const checkpoint = await handleResumeMessage(firstContext, {
      workflowId: 'wf-worker-replay',
      result: 'one-result',
    });
    expect(checkpoint.type).toBe('checkpoint');
    if (checkpoint.type !== 'checkpoint') return;

    // Recovery: replays the body from a checkpoint that has step 0 cached.
    // 'before-1' is in the replayed prefix → suppressed. 'before-2' is the live
    // frontier → emitted, and the recovered run must request op2 (proving the
    // replay reached the right position, not just that the log sequence matched).
    captured.restore();
    captured = captureConsole();
    const recoveredContext = createWorkflowRunnerContext();
    const recovered = await handleRunMessage(
      recoveredContext,
      {
        workflowId: 'wf-worker-replay',
        workflowType: 'replay',
        input: null,
        checkpoint: checkpoint.checkpoint,
      },
      () => loggingWorkflow,
    );

    expect(recovered.type).toBe('checkpoint');
    expect(recovered.type === 'checkpoint' ? recovered.operationRequest : undefined).toEqual(op2);
    expect(captured.records.map((r) => r.message)).toEqual(['before-2']);
  });

  it('quarantines caller attributes under their own key (no envelope shadowing)', async () => {
    const context = createWorkflowRunnerContext();
    async function* shadowingWorkflow(ctx: WorkerWorkflowContext) {
      ctx.log.error('boom', { workflowId: 'attacker', workflowType: 'attacker' });
      return null;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-real', workflowType: 'real-type', input: null },
      () => shadowingWorkflow,
    );

    expect(captured.records[0]).toMatchObject({
      workflowId: 'wf-real',
      workflowType: 'real-type',
      attributes: { workflowId: 'attacker', workflowType: 'attacker' },
    });
  });

  it('reads the live replay state through the closure even though it is set after context construction', () => {
    // createWorkerWorkflowContext is called before replayStates.set in
    // handleRunMessage. The logger must read the replay state lazily through the
    // closure so the FIRST synchronous log call observes the live state.
    let liveReplayState: WorkerLoggerReplayState | undefined;
    const ctx = createWorkerWorkflowContext(
      { workflowId: 'wf-closure', workflowType: 'closure', input: null },
      new AbortController(),
      () => liveReplayState,
    );

    // Before the replay state is registered, the logger treats it as live.
    ctx.log.info('pre-register');
    expect(captured.records.map((r) => r.message)).toEqual(['pre-register']);

    // Register a replay state whose cached step matches the frontier → suppressed.
    liveReplayState = {
      accumulatedResults: new Map([[0, 'cached']]),
      failedOutcomes: new Map(),
      nextStepIndex: 0,
    };
    ctx.log.info('replaying');
    expect(captured.records.map((r) => r.message)).toEqual(['pre-register']);

    // Advance the frontier past the cached prefix → live again.
    liveReplayState = {
      accumulatedResults: new Map([[0, 'cached']]),
      failedOutcomes: new Map(),
      nextStepIndex: 1,
    };
    ctx.log.info('post-replay');
    expect(captured.records.map((r) => r.message)).toEqual(['pre-register', 'post-replay']);
  });

  it('suppresses a log at a replayed FAILED step position (not just succeeded steps)', () => {
    // Worker checkpoints store failed steps in `failedOutcomes`, not
    // `accumulatedResults`. The replay probe must check both, or a log before a
    // step that failed-and-is-being-replayed would re-emit on recovery.
    let liveReplayState: WorkerLoggerReplayState | undefined;
    const ctx = createWorkerWorkflowContext(
      { workflowId: 'wf-failed', workflowType: 'failed', input: null },
      new AbortController(),
      () => liveReplayState,
    );

    // Step 0 is a REPLAYED FAILURE (in failedOutcomes, absent from accumulatedResults).
    liveReplayState = {
      accumulatedResults: new Map(),
      failedOutcomes: new Map([[0, { error: 'boom', failureCategory: 'application' }]]),
      nextStepIndex: 0,
    };
    ctx.log.info('before failed step — replaying');
    expect(captured.records).toHaveLength(0);

    // Frontier past the replayed-failure prefix → live again.
    liveReplayState = {
      accumulatedResults: new Map(),
      failedOutcomes: new Map([[0, { error: 'boom', failureCategory: 'application' }]]),
      nextStepIndex: 1,
    };
    ctx.log.info('after failed step — live');
    expect(captured.records.map((r) => r.message)).toEqual(['after failed step — live']);
  });
});
