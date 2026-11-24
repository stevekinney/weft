/**
 * Test worker entry point for the fork log regressions (COR-1924). It runs the workflow bodies that
 * `core/worker-fork-recovery.test.ts` forks, parks and recovers through a real engine host.
 *
 * @module workers/test-fork-log-worker
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
  // activity@0, wait 'go'@1, wait 'next'@2, wait 'last'@3
  'three-waits': async function* (ctx) {
    ctx.log.info('L0');
    const a: unknown = yield runActivity(ctx, 'noop', 'a');
    ctx.log.info('L1');
    const go: unknown = yield waitForSignal(ctx, 'go');
    ctx.log.info('L2');
    const next: unknown = yield waitForSignal(ctx, 'next');
    ctx.log.info('L3');
    const last: unknown = yield waitForSignal(ctx, 'last');
    return { a, go, next, last };
  },
  // wait 'go'@0, activity with an observable effect@1, wait 'next'@2, wait 'last'@3
  'effect-after-wait': async function* (ctx) {
    const go: unknown = yield waitForSignal(ctx, 'go');
    const effect: unknown = yield runActivity(ctx, 'effect', 'fx');
    const next: unknown = yield waitForSignal(ctx, 'next');
    const last: unknown = yield waitForSignal(ctx, 'last');
    return { go, effect, next, last };
  },
  // activity@0, getVersion@1, wait 'go'@2, wait 'next'@3
  versioned: async function* (ctx) {
    ctx.log.info('V0');
    const a: unknown = yield runActivity(ctx, 'noop', 'a');
    ctx.log.info('V1-before-getVersion');
    const version = yield* ctx.getVersion('change', 1, 1);
    ctx.log.info('V2-before-wait');
    const go: unknown = yield waitForSignal(ctx, 'go');
    ctx.log.info('V3');
    const next: unknown = yield waitForSignal(ctx, 'next');
    return { a, version, go, next };
  },
});
