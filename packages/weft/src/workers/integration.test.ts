import { afterEach, describe, expect, it } from 'bun:test';

import { WorkerPool } from './pool.ts';
import {
  createWorkflowRunnerContext,
  handleCancelMessage,
  handleResumeMessage,
  handleRunMessage,
} from './workflow-runner.ts';

function expectActivityOperationRequestName(operationRequest: unknown, expected: string): void {
  if (
    typeof operationRequest !== 'object' ||
    operationRequest === null ||
    !('activityName' in operationRequest)
  ) {
    throw new Error('Expected an activity operation request');
  }

  expect(operationRequest.activityName).toBe(expected);
}

// ---------------------------------------------------------------------------
// Integration tests: workflow runner with real async generators
// ---------------------------------------------------------------------------

describe('workflow runner integration', () => {
  // -------------------------------------------------------------------------
  // handleRunMessage
  // -------------------------------------------------------------------------

  describe('handleRunMessage', () => {
    it('completes immediately when the generator returns without yielding', async () => {
      const context = createWorkflowRunnerContext();

      const handler = async function* (_ctx: unknown, _input: unknown) {
        return 'done';
      };

      const result = await handleRunMessage(
        context,
        { workflowId: 'wf-1', workflowType: 'simple', input: null },
        () => handler,
      );

      expect(result.type).toBe('completed');
      if (result.type === 'completed') {
        expect(result.result).toBe('done');
      }
    });

    it('yields a checkpoint when the generator yields an operation', async () => {
      const context = createWorkflowRunnerContext();

      const handler = async function* (_ctx: unknown, _input: unknown) {
        const value: unknown = yield {
          id: 'op-1',
          workflowId: 'wf-1',
          kind: 'activity',
          queue: 'default',
          activityName: 'fetchData',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 3,
            initialBackoff: 1000,
            backoffMultiplier: 2,
            maxBackoff: 30000,
          },
          scheduledAt: Date.now(),
        };
        return value;
      };

      const result = await handleRunMessage(
        context,
        { workflowId: 'wf-1', workflowType: 'yielding', input: null },
        () => handler,
      );

      expect(result.type).toBe('checkpoint');
      if (result.type === 'checkpoint') {
        expectActivityOperationRequestName(result.operationRequest, 'fetchData');
      }
    });

    it('returns failed for unknown workflow types', async () => {
      const context = createWorkflowRunnerContext();

      const result = await handleRunMessage(
        context,
        { workflowId: 'wf-1', workflowType: 'nonexistent', input: null },
        () => undefined,
      );

      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.error).toContain('Unknown workflow type');
      }
    });

    it('returns failed when the generator throws', async () => {
      const context = createWorkflowRunnerContext();

      const handler = async function* () {
        throw new Error('boom');
      };

      const result = await handleRunMessage(
        context,
        { workflowId: 'wf-1', workflowType: 'failing', input: null },
        () => handler,
      );

      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.error).toBe('boom');
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleResumeMessage
  // -------------------------------------------------------------------------

  describe('handleResumeMessage', () => {
    it('completes the workflow when result is fed back', async () => {
      const context = createWorkflowRunnerContext();

      const handler = async function* (_ctx: unknown, _input: unknown) {
        const value: unknown = yield {
          id: 'op-1',
          workflowId: 'wf-1',
          kind: 'activity',
          queue: 'default',
          activityName: 'fetchData',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 3,
            initialBackoff: 1000,
            backoffMultiplier: 2,
            maxBackoff: 30000,
          },
          scheduledAt: Date.now(),
        };
        return `result:${String(value)}`;
      };

      // First, run to advance to the yield point
      await handleRunMessage(
        context,
        { workflowId: 'wf-1', workflowType: 'test', input: null },
        () => handler,
      );

      // Then resume with a result
      const result = await handleResumeMessage(context, {
        workflowId: 'wf-1',
        result: 'hello',
      });

      expect(result.type).toBe('completed');
      if (result.type === 'completed') {
        expect(result.result).toBe('result:hello');
      }
    });

    it('yields another checkpoint for multi-step workflows', async () => {
      const context = createWorkflowRunnerContext();

      const handler = async function* (_ctx: unknown, _input: unknown) {
        const first: unknown = yield {
          id: 'op-1',
          workflowId: 'wf-1',
          kind: 'activity',
          queue: 'default',
          activityName: 'step1',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 1,
            initialBackoff: 1000,
            backoffMultiplier: 1,
            maxBackoff: 1000,
          },
          scheduledAt: Date.now(),
        };
        const second: unknown = yield {
          id: 'op-2',
          workflowId: 'wf-1',
          kind: 'activity',
          queue: 'default',
          activityName: 'step2',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 1,
            initialBackoff: 1000,
            backoffMultiplier: 1,
            maxBackoff: 1000,
          },
          scheduledAt: Date.now(),
        };
        return `${String(first)}-${String(second)}`;
      };

      await handleRunMessage(
        context,
        { workflowId: 'wf-1', workflowType: 'multi', input: null },
        () => handler,
      );

      const secondStep = await handleResumeMessage(context, {
        workflowId: 'wf-1',
        result: 'A',
      });

      expect(secondStep.type).toBe('checkpoint');
      if (secondStep.type === 'checkpoint') {
        expectActivityOperationRequestName(secondStep.operationRequest, 'step2');
      }

      const finalResult = await handleResumeMessage(context, {
        workflowId: 'wf-1',
        result: 'B',
      });

      expect(finalResult.type).toBe('completed');
      if (finalResult.type === 'completed') {
        expect(finalResult.result).toBe('A-B');
      }
    });

    it('returns failed when no generator exists', async () => {
      const context = createWorkflowRunnerContext();

      const result = await handleResumeMessage(context, {
        workflowId: 'wf-nonexistent',
        result: null,
      });

      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.error).toContain('No active generator');
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleCancelMessage
  // -------------------------------------------------------------------------

  describe('handleCancelMessage', () => {
    it('cleans up generator and abort controller', async () => {
      const context = createWorkflowRunnerContext();

      const handler = async function* (_ctx: unknown, _input: unknown) {
        const value: unknown = yield {
          id: 'op-1',
          workflowId: 'wf-1',
          kind: 'activity',
          queue: 'default',
          activityName: 'longRunning',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 1,
            initialBackoff: 1000,
            backoffMultiplier: 1,
            maxBackoff: 1000,
          },
          scheduledAt: Date.now(),
        };
        return value;
      };

      await handleRunMessage(
        context,
        { workflowId: 'wf-1', workflowType: 'test', input: null },
        () => handler,
      );

      expect(context.generators.has('wf-1')).toBe(true);
      expect(context.abortControllers.has('wf-1')).toBe(true);

      await handleCancelMessage(context, { workflowId: 'wf-1' });

      expect(context.generators.has('wf-1')).toBe(false);
      expect(context.abortControllers.has('wf-1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Worker entry point integration (with real WorkerPool)
  // -------------------------------------------------------------------------

  describe('worker entry point with WorkerPool', () => {
    let pool: WorkerPool;

    afterEach(() => {
      pool?.[Symbol.dispose]();
    });

    it('creates a pool and acquires workers from the test worker', async () => {
      const workerUrl = new URL('./test-worker.ts', import.meta.url);
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const worker = await pool.acquire();

      // Test that the worker can process messages
      const response = await new Promise<{ echo: string }>((resolve) => {
        worker.addEventListener(
          'message',
          (event: MessageEvent) => {
            resolve(event.data);
          },
          { once: true },
        );
        worker.postMessage('integration-test');
      });

      expect(response).toEqual({ echo: 'integration-test' });

      pool.release(worker);
    });
  });
});
