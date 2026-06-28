import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { WorkerLoggerReplayState } from '../core/context/workflow-logger.ts';
import type { OperationRequest, WorkerOutboundMessage } from '../core/types.ts';
import { WORKER_PROTOCOL_VERSION } from '../core/worker-protocol.ts';
import { captureWorkflowLogConsole } from '../testing/workflow-log-capture.test-support.ts';
import { createReplayState } from './worker-replay-state.ts';
import {
  createWorkerWorkflowContext,
  createWorkflowRunnerContext,
  handleResumeMessage,
  handleRunMessage,
  type WorkerWorkflowContext,
} from './workflow-runner.ts';

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
  let captured: ReturnType<typeof captureWorkflowLogConsole>;
  beforeEach(() => {
    captured = captureWorkflowLogConsole();
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
    captured = captureWorkflowLogConsole();
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
      {
        workflowId: 'wf-closure',
        workflowExecutionToken: 'workflow-token-worker-context',
        workflowType: 'closure',
        input: null,
      },
      new AbortController(),
      () => liveReplayState,
    );

    expect(ctx.workflowExecutionToken).toBe('workflow-token-worker-context');

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

  describe('host log forwarding (#529)', () => {
    it('routes a record to the host forwarder INSTEAD of the worker console', () => {
      const forwarded: Array<{ message: string }> = [];
      const ctx = createWorkerWorkflowContext(
        { workflowId: 'wf-fwd', workflowType: 'fwd', input: null },
        new AbortController(),
        () => undefined,
        (record) => forwarded.push({ message: record.message }),
      );

      ctx.log.info('to-host', { phase: 'init' });

      expect(forwarded).toEqual([{ message: 'to-host' }]);
      // The shared factory routes to the sink instead of console.
      expect(captured.records).toHaveLength(0);
    });

    it('does NOT forward a replay-suppressed record', () => {
      const forwarded: string[] = [];
      let liveReplayState: WorkerLoggerReplayState | undefined;
      const ctx = createWorkerWorkflowContext(
        { workflowId: 'wf-fwd-replay', workflowType: 'fwd', input: null },
        new AbortController(),
        () => liveReplayState,
        (record) => forwarded.push(record.message),
      );

      liveReplayState = {
        accumulatedResults: new Map([[0, 'cached']]),
        failedOutcomes: new Map(),
        nextStepIndex: 0,
      };
      ctx.log.info('replaying — suppressed');
      expect(forwarded).toEqual([]);

      liveReplayState = {
        accumulatedResults: new Map([[0, 'cached']]),
        failedOutcomes: new Map(),
        nextStepIndex: 1,
      };
      ctx.log.info('live — forwarded');
      expect(forwarded).toEqual(['live — forwarded']);
    });

    it('falls back to the worker console when the host forwarder throws', () => {
      const ctx = createWorkerWorkflowContext(
        { workflowId: 'wf-fwd-throw', workflowType: 'fwd', input: null },
        new AbortController(),
        () => undefined,
        () => {
          throw new Error('postMessage failed (oversize)');
        },
      );

      // A throwing forwarder (e.g. oversize record makes postMessage throw) must not
      // crash the run; the shared factory's try/catch falls the record back to console.
      ctx.log.warn('forward-failed');

      expect(captured.records.map((r) => r.message)).toEqual(['forward-failed']);
    });

    it('posts a forwarded log carrying the workflow identity and protocol version (no turn state)', async () => {
      const context = createWorkflowRunnerContext();
      const posted: Array<Extract<WorkerOutboundMessage, { type: 'log' }>> = [];
      async function* loggingWorkflow(ctx: WorkerWorkflowContext) {
        ctx.log.info('forwarded-run');
        return 'done';
      }

      await handleRunMessage(
        context,
        { workflowId: 'wf-fwd-run', workflowType: 'fwd', input: null },
        () => loggingWorkflow,
        (message) => posted.push(message),
      );

      // The host gates delivery by ownership and identity, so the message carries no
      // turn-protocol state — only the workflowId envelope, the protocol version, and
      // the record. The host re-validates `record.workflowId === message.workflowId`.
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        type: 'log',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workflowId: 'wf-fwd-run',
        record: expect.objectContaining({ message: 'forwarded-run', workflowId: 'wf-fwd-run' }),
      });
      expect('turnId' in posted[0]!).toBe(false);
    });

    it('keeps forwarding logs emitted AFTER a resume (forwarding survives park → resume)', async () => {
      // The forwarder is built once in handleRunMessage and captured by the generator's
      // closure; the same generator continues on resume. A log emitted in the resumed
      // turn must still reach the host forwarder — forwarding must not die after a park.
      const context = createWorkflowRunnerContext();
      const posted: Array<{ message: string }> = [];
      const op = activityOperation('wf-fwd-resume', 'step1', 'one');
      async function* loggingWorkflow(ctx: WorkerWorkflowContext) {
        const result: unknown = yield op;
        ctx.log.info('after-resume');
        return result;
      }

      // Run turn: parks on the activity, no log yet.
      await handleRunMessage(
        context,
        { workflowId: 'wf-fwd-resume', workflowType: 'fwd', input: null },
        () => loggingWorkflow,
        (message) => posted.push({ message: message.record.message }),
      );
      expect(posted).toEqual([]);

      // Resume turn: the log after resume is still forwarded by the original closure.
      await handleResumeMessage(context, {
        workflowId: 'wf-fwd-resume',
        result: 'one-result',
      });
      expect(posted).toEqual([{ message: 'after-resume' }]);
    });

    it('a forwarder retained after terminal cleanup posts a record but leaks no run state', async () => {
      const context = createWorkflowRunnerContext();
      const posted: Array<Extract<WorkerOutboundMessage, { type: 'log' }>> = [];
      let retainedLogger: WorkerWorkflowContext['log'] | undefined;
      async function* completingWorkflow(ctx: WorkerWorkflowContext) {
        // Capture the logger so the test can invoke it AFTER terminal cleanup, the
        // realistic "fire-and-forget log resolves after the run completed" window.
        retainedLogger = ctx.log;
        return 'done';
      }

      const result = await handleRunMessage(
        context,
        { workflowId: 'wf-leak', workflowType: 'leak', input: null },
        () => completingWorkflow,
        (message) => posted.push(message),
      );

      // A completed run is cleaned through cleanupWorkflowRunnerState — no per-workflow
      // state lingers in a long-lived pooled worker (#529).
      expect(result.type).toBe('completed');
      expect(context.replayStates.has('wf-leak')).toBe(false);
      expect(context.generators.has('wf-leak')).toBe(false);
      expect(context.abortControllers.has('wf-leak')).toBe(false);

      // Behavioral teeth: a log emitted after cleanup still posts (best-effort) and does
      // NOT re-create any run state — the forwarder reads the (now absent) replay state
      // through the live closure rather than a retained per-workflow entry.
      retainedLogger!.info('after-terminal');
      expect(posted.at(-1)).toMatchObject({
        type: 'log',
        workflowId: 'wf-leak',
        record: expect.objectContaining({ message: 'after-terminal' }),
      });
      expect(context.replayStates.has('wf-leak')).toBe(false);
    });
  });
});

describe('worker ctx.getVersion', () => {
  it('yields a get-version request and pins the version in checkpoint locals', () => {
    const replayState = createReplayState({ workflowId: 'wf-version' });
    const ctx = createWorkerWorkflowContext(
      { workflowId: 'wf-version', workflowType: 'versioning', input: null },
      new AbortController(),
      () => undefined,
      undefined,
      () => replayState,
    );

    const generator = ctx.getVersion('shipping-v2', 1, 2);
    const request = generator.next();

    expect(request).toMatchObject({
      done: false,
      value: {
        type: 'get-version',
        changeId: 'shipping-v2',
        minSupported: 1,
        maxSupported: 2,
        version: 2,
      },
    });
    expect(replayState.checkpoint.locals['version:shipping-v2']).toBe(2);

    const completion = generator.next(2);
    expect(completion).toEqual({ done: true, value: 2 });
  });
});
