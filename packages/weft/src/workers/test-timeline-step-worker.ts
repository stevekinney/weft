/**
 * Test worker entry point for the timeline step index regressions (COR-1988). It runs the workflow
 * bodies that `core/engine/timeline-step-index-worker.test.ts` drives through a real engine host:
 * the worker counts durable steps, the host numbers checkpoints, and a timeline entry has to carry
 * the first of the two that a `ctx.log` line's `step` also carries.
 *
 * @module workers/test-timeline-step-worker
 */

/// <reference lib="webworker" />

import type { WorkerWorkflowContext } from './workflow-runner.ts';
import { initializeWorkerMessageLoop } from './workflow-worker-entry.ts';

const retryPolicy = { maxAttempts: 1, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 };

function waitForSignal(ctx: WorkerWorkflowContext, signalName: string) {
  return {
    id: `wait:${ctx.workflowId}:${signalName}`,
    workflowId: ctx.workflowId,
    kind: 'signal-wait' as const,
    queue: 'default',
    attempt: 1,
    retryPolicy,
    scheduledAt: Date.now(),
    signalName,
  };
}

function runActivity(ctx: WorkerWorkflowContext, activityName: string, input: unknown) {
  return {
    id: `activity:${ctx.workflowId}:${activityName}`,
    workflowId: ctx.workflowId,
    kind: 'activity' as const,
    queue: 'default',
    activityName,
    input,
    attempt: 1,
    retryPolicy,
    scheduledAt: Date.now(),
  };
}

initializeWorkerMessageLoop({
  // log@0, activity@0, log@1
  'step-basic': async function* (ctx) {
    ctx.log.info('before-activity');
    const a: unknown = yield runActivity(ctx, 'noop', 'a');
    ctx.log.info('after-activity');
    return a;
  },
  // two activities, then a wait, then an activity: the steps count 0, 1, 2, 3
  'step-signal-resume': async function* (ctx) {
    ctx.log.info('before-first');
    const a: unknown = yield runActivity(ctx, 'noop', 'a');
    ctx.log.info('before-second');
    const b: unknown = yield runActivity(ctx, 'noop', 'b');
    ctx.log.info('before-wait');
    const go: unknown = yield waitForSignal(ctx, 'go');
    ctx.log.info('after-wait');
    const c: unknown = yield runActivity(ctx, 'noop', 'c');
    ctx.log.info('end');
    return { a, b, go, c };
  },
  // A worker body retries by catching the failure and yielding the activity again: the host never
  // retries a worker's operation. The failed attempt takes step 0 and the retry step 1.
  'step-retry': async function* (ctx) {
    ctx.log.info('before-flaky');
    let flaky: unknown;
    try {
      flaky = yield runActivity(ctx, 'flaky', null);
    } catch {
      ctx.log.info('retrying');
      flaky = yield runActivity(ctx, 'flaky', null);
    }
    ctx.log.info('after-flaky');
    const b: unknown = yield runActivity(ctx, 'noop', 'b');
    return { flaky, b };
  },
  // getVersion pins at step 0 and yields; the second call finds the pin, takes step 1, and yields
  // nothing, so the activity at step 2 is the second checkpoint: the two counts part ways.
  'step-version': async function* (ctx) {
    ctx.log.info('before-pin');
    const first = yield* ctx.getVersion('change', 1, 1);
    ctx.log.info('before-repeat');
    const second = yield* ctx.getVersion('change', 1, 1);
    ctx.log.info('before-activity');
    const a: unknown = yield runActivity(ctx, 'noop', 'a');
    ctx.log.info('end');
    return { first, second, a };
  },
});
