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

import { initializeWorkerMessageLoop } from './workflow-worker-entry.ts';

// ---------------------------------------------------------------------------
// Test workflow registrations
// ---------------------------------------------------------------------------

/* eslint-disable require-yield */
const registrations = new Map<string, (...arguments_: unknown[]) => AsyncGenerator>();

registrations.set('simple', async function* (input: unknown) {
  return { input, computed: 42 };
});

registrations.set('with-activity', async function* (input: unknown) {
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

registrations.set('multi-step', async function* (_input: unknown) {
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
/* eslint-enable require-yield */

// ---------------------------------------------------------------------------
// Wire up the real worker message loop
// ---------------------------------------------------------------------------

initializeWorkerMessageLoop((type) => registrations.get(type));
