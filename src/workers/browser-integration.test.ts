/**
 * Browser Web Worker integration test.
 *
 * Verifies that the **same** worker code (`initializeWorkerMessageLoop` from
 * `workflow-worker-entry.ts`, backed by `workflow-runner.ts`) runs in browser
 * Web Workers using the standard Worker API. The test-browser-worker.ts entry
 * point imports the real `initializeWorkerMessageLoop` and registers test
 * workflow handlers — no reimplementation, no shims.
 *
 * @module workers/browser-integration
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { WorkerInboundMessage, WorkerOutboundMessage } from '../core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testWorkerUrl = new URL('./test-browser-worker.ts', import.meta.url);

/** Wait for a message matching `predicate`, with a timeout. */
function waitForMessage(
  messages: WorkerOutboundMessage[],
  predicate: (message: WorkerOutboundMessage) => boolean,
  timeoutMilliseconds = 2000,
): Promise<WorkerOutboundMessage> {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(interval);
        resolve(found);
      }
    }, 5);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out after ${timeoutMilliseconds}ms waiting for matching message`));
    }, timeoutMilliseconds);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser Web Worker integration', () => {
  let worker: Worker;

  afterEach(() => {
    worker?.terminate();
  });

  describe('same worker code runs in browser Web Workers', () => {
    it('runs a simple workflow to completion via initializeWorkerMessageLoop', async () => {
      worker = new Worker(testWorkerUrl);

      const received: WorkerOutboundMessage[] = [];
      worker.addEventListener('message', (event: MessageEvent<WorkerOutboundMessage>) => {
        received.push(event.data);
      });

      const message: WorkerInboundMessage & { type: 'run' } = {
        type: 'run',
        workflowId: 'wf-simple-1',
        workflowType: 'simple',
        checkpoint: new ArrayBuffer(0),
        input: { test: 'value' },
      };

      worker.postMessage(message);

      const completion = await waitForMessage(
        received,
        (m) => m.type === 'completed' && m.workflowId === 'wf-simple-1',
      );

      expect(completion.type).toBe('completed');
      if (completion.type === 'completed') {
        expect(completion.result).toEqual({ input: { test: 'value' }, computed: 42 });
      }
    });

    it('yields a checkpoint with an operation request', async () => {
      worker = new Worker(testWorkerUrl);

      const received: WorkerOutboundMessage[] = [];
      worker.addEventListener('message', (event: MessageEvent<WorkerOutboundMessage>) => {
        received.push(event.data);
      });

      const message: WorkerInboundMessage & { type: 'run' } = {
        type: 'run',
        workflowId: 'wf-activity-1',
        workflowType: 'with-activity',
        checkpoint: new ArrayBuffer(0),
        input: { orderId: 'order-123' },
      };

      worker.postMessage(message);

      const checkpoint = await waitForMessage(
        received,
        (m) => m.type === 'checkpoint' && m.workflowId === 'wf-activity-1',
      );

      expect(checkpoint.type).toBe('checkpoint');
      if (checkpoint.type === 'checkpoint') {
        expect(checkpoint.operationRequest.activityName).toBe('testActivity');
        expect(checkpoint.checkpoint).toBeInstanceOf(ArrayBuffer);
      }
    });

    it('resumes a workflow with an operation result and completes', async () => {
      worker = new Worker(testWorkerUrl);

      const received: WorkerOutboundMessage[] = [];
      worker.addEventListener('message', (event: MessageEvent<WorkerOutboundMessage>) => {
        received.push(event.data);
      });

      // Start the workflow — it will yield at the activity
      worker.postMessage({
        type: 'run',
        workflowId: 'wf-resume-1',
        workflowType: 'with-activity',
        checkpoint: new ArrayBuffer(0),
        input: { orderId: 'order-456' },
      } satisfies WorkerInboundMessage);

      await waitForMessage(
        received,
        (m) => m.type === 'checkpoint' && m.workflowId === 'wf-resume-1',
      );

      // Clear and resume with a completed operation result
      received.length = 0;

      worker.postMessage({
        type: 'resume',
        workflowId: 'wf-resume-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'activity completed' },
      } satisfies WorkerInboundMessage);

      const completion = await waitForMessage(
        received,
        (m) => m.type === 'completed' && m.workflowId === 'wf-resume-1',
      );

      expect(completion.type).toBe('completed');
      if (completion.type === 'completed') {
        expect(completion.result).toEqual({
          input: { orderId: 'order-456' },
          activity_result: 'activity completed',
        });
      }
    });

    it('handles multi-step workflows with sequential resume cycles', async () => {
      worker = new Worker(testWorkerUrl);

      const received: WorkerOutboundMessage[] = [];
      worker.addEventListener('message', (event: MessageEvent<WorkerOutboundMessage>) => {
        received.push(event.data);
      });

      // Start — yields at step1
      worker.postMessage({
        type: 'run',
        workflowId: 'wf-multi-1',
        workflowType: 'multi-step',
        checkpoint: new ArrayBuffer(0),
        input: {},
      } satisfies WorkerInboundMessage);

      const firstCheckpoint = await waitForMessage(
        received,
        (m) => m.type === 'checkpoint' && m.workflowId === 'wf-multi-1',
      );
      if (firstCheckpoint.type === 'checkpoint') {
        expect(firstCheckpoint.operationRequest.activityName).toBe('step1');
      }

      // Resume step1 — yields at step2
      received.length = 0;
      worker.postMessage({
        type: 'resume',
        workflowId: 'wf-multi-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'step1 done' },
      } satisfies WorkerInboundMessage);

      const secondCheckpoint = await waitForMessage(
        received,
        (m) => m.type === 'checkpoint' && m.workflowId === 'wf-multi-1',
      );
      if (secondCheckpoint.type === 'checkpoint') {
        expect(secondCheckpoint.operationRequest.activityName).toBe('step2');
      }

      // Resume step2 — completes
      received.length = 0;
      worker.postMessage({
        type: 'resume',
        workflowId: 'wf-multi-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'step2 done' },
      } satisfies WorkerInboundMessage);

      const completion = await waitForMessage(
        received,
        (m) => m.type === 'completed' && m.workflowId === 'wf-multi-1',
      );
      expect(completion.type).toBe('completed');
      if (completion.type === 'completed') {
        expect(completion.result).toEqual({ step1: 'step1 done', step2: 'step2 done' });
      }
    });

    it('reports failure for unknown workflow types', async () => {
      worker = new Worker(testWorkerUrl);

      const received: WorkerOutboundMessage[] = [];
      worker.addEventListener('message', (event: MessageEvent<WorkerOutboundMessage>) => {
        received.push(event.data);
      });

      worker.postMessage({
        type: 'run',
        workflowId: 'wf-unknown-1',
        workflowType: 'nonexistent',
        checkpoint: new ArrayBuffer(0),
        input: null,
      } satisfies WorkerInboundMessage);

      const failure = await waitForMessage(
        received,
        (m) => m.type === 'failed' && m.workflowId === 'wf-unknown-1',
      );

      expect(failure.type).toBe('failed');
      if (failure.type === 'failed') {
        expect(failure.error).toContain('Unknown workflow type');
      }
    });
  });
});
