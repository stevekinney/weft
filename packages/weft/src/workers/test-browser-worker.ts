/**
 * Test worker entry point for browser Web Worker integration tests.
 *
 * Uses the **same** `initializeWorkerMessageLoop` from `workflow-worker-entry.ts`
 * that powers production workflow workers. Registers a few test workflow handlers
 * to verify the full message protocol works in a standard Web Worker context.
 *
 * @module workers/test-browser-worker
 */

/// <reference lib="webworker" />

import type { WorkerWorkflowContext } from './workflow-runner.ts';
import { initializeWorkerMessageLoop } from './workflow-worker-entry.ts';

// ---------------------------------------------------------------------------
// Test workflow registrations
// ---------------------------------------------------------------------------

/* eslint-disable require-yield */
const registrations = new Map<
  string,
  (ctx: WorkerWorkflowContext, input: unknown) => AsyncGenerator
>();

registrations.set('simple', async function* (_ctx, input) {
  return { input, computed: 42 };
});

registrations.set('infinite-loop', async function* () {
  let keepRunning = true;
  while (keepRunning) {
    keepRunning = Date.now() >= 0;
  }
  return 'unreachable';
});

registrations.set('infinite-loop-after-resume', async function* (ctx, input) {
  const signalName = signalNameFromInput(input);
  yield {
    id: `wait:${ctx.workflowId}:${signalName}`,
    workflowId: ctx.workflowId,
    kind: 'signal-wait',
    queue: 'default',
    attempt: 1,
    retryPolicy: {
      maxAttempts: 1,
      initialBackoff: 0,
      backoffMultiplier: 1,
      maxBackoff: 0,
    },
    scheduledAt: Date.now(),
    signalName,
  };

  let keepRunning = true;
  while (keepRunning) {
    keepRunning = Date.now() >= 0;
  }
  return 'unreachable';
});

registrations.set('catch-failed-activity-then-wait', async function* (ctx, input) {
  let caughtError = 'none';
  try {
    yield {
      id: `activity:${ctx.workflowId}:fails-before-signal`,
      workflowId: ctx.workflowId,
      kind: 'activity',
      queue: 'default',
      activityName: 'failsBeforeSignal',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 1,
        initialBackoff: 1000,
        backoffMultiplier: 1,
        maxBackoff: 1000,
      },
      scheduledAt: Date.now(),
    };
  } catch (error) {
    caughtError = error instanceof Error ? error.message : String(error);
  }

  const signalName = signalNameFromInput(input);
  const payload: unknown = yield {
    id: `wait:${ctx.workflowId}:${signalName}`,
    workflowId: ctx.workflowId,
    kind: 'signal-wait',
    queue: 'default',
    attempt: 1,
    retryPolicy: {
      maxAttempts: 1,
      initialBackoff: 0,
      backoffMultiplier: 1,
      maxBackoff: 0,
    },
    scheduledAt: Date.now(),
    signalName,
  };
  return { caughtError, payload, workflowId: ctx.workflowId };
});

registrations.set('with-activity', async function* (_ctx, input) {
  const result: unknown = yield {
    id: 'op-1',
    workflowId: 'wf-1',
    kind: 'activity',
    queue: 'default',
    activityName: 'testActivity',
    attempt: 1,
    retryPolicy: {
      maxAttempts: 3,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    },
    scheduledAt: Date.now(),
  };
  return { input, activity_result: result };
});

registrations.set('multi-step', async function* (_ctx, _input) {
  const step1: unknown = yield {
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
  const step2: unknown = yield {
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
  return { step1, step2 };
});

registrations.set('wait-signal-then-complete', async function* (ctx, input) {
  const signalName = signalNameFromInput(input);
  const payload: unknown = yield {
    id: `wait:${ctx.workflowId}:${signalName}`,
    workflowId: ctx.workflowId,
    kind: 'signal-wait',
    queue: 'default',
    attempt: 1,
    retryPolicy: {
      maxAttempts: 1,
      initialBackoff: 0,
      backoffMultiplier: 1,
      maxBackoff: 0,
    },
    scheduledAt: Date.now(),
    signalName,
  };
  return { input, payload, workflowId: ctx.workflowId };
});
/* eslint-enable require-yield */

function signalNameFromInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return 'resume';
  }

  if (!('signalName' in input)) {
    return 'resume';
  }

  const record = input as Record<string, unknown>;
  const signalName = record['signalName'];
  return typeof signalName === 'string' && signalName.length > 0 ? signalName : 'resume';
}

// ---------------------------------------------------------------------------
// Wire up the real worker message loop
// ---------------------------------------------------------------------------

initializeWorkerMessageLoop(Object.fromEntries(registrations));
