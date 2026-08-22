import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { yieldToEventLoop } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { CURRENT_CHECKPOINT_SCHEMA_VERSION } from '../types/checkpoint.ts';
import {
  flushQueuedInlineWorkflowStartsDirectly,
  queueInlineWorkflowExecutionStart,
} from './inline-launch-queue.ts';
import { getInternals } from './internals.ts';

describe('inline launch queue', () => {
  it('falls back to a timeout flush when no message channel is available', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    internals.queuedInlineWorkflowStartChannel?.port1.close();
    internals.queuedInlineWorkflowStartChannel?.port2.close();
    internals.queuedInlineWorkflowStartChannel = null;
    const onStarted = mock(() => {});
    const swallowPromiseRejection = mock(async (promise: Promise<unknown> | undefined) => {
      await promise;
    });

    queueInlineWorkflowExecutionStart(
      internals,
      {
        workflowId: 'queued-inline-timeout',
        workflowType: 'timeout-flush',
        input: null,
        checkpoint: {
          workflowId: 'queued-inline-timeout',
          step: 0,
          locals: {},
          accumulatedResults: [],
          searchAttributes: {},
          version: '1',
          schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
          createdAt: 0,
        },
        nestingDepth: 0,
        executionDeadline: undefined,
        executionStateOwnerId: 'queued-inline-timeout-owner',
        onStarted,
      },
      {
        processPendingUpdatesAfterInlineAdvance: async () => {},
        swallowPromiseRejection,
      },
    );

    await yieldToEventLoop();
    await yieldToEventLoop();

    expect(swallowPromiseRejection.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(internals.queuedInlineWorkflowStartFlushScheduled).toBe(false);
  });

  describe("startQueuedInlineWorkflowExecution: ADR 0002 'inline-macrotask-drive' wake kind", () => {
    // The pre-existing test above proves onStarted still settles when there is
    // no durable state at all (the "not running" skip path) — that never
    // reaches the new ownership check. These prove the check itself, on a
    // workflow durably marked 'running': the 'proceed' branch is already
    // exercised end-to-end by every `ownership: 'workflow-lease'` `engine.start()`
    // test elsewhere (default `defer: true` always flows through this exact
    // queued path), so only the 'discard' branch needs direct coverage here.
    const parkOnSignal = workflow({ name: 'inline-launch-queue-ownership-parked' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('go');
        return 'done';
      },
    );

    it('discards a queued start without driving the generator once a successor engine holds the claim', async () => {
      await using storage = new MemoryStorage();

      // Engine A durably starts (and, under workflow-lease, claims) a workflow
      // that stays 'running' — parked on a signal it never receives.
      await using engineA = await Engine.create({
        storage,
        ownership: 'workflow-lease',
        workflows: { 'inline-launch-queue-ownership-parked': parkOnSignal },
      });
      await engineA.start('inline-launch-queue-ownership-parked', null, {
        id: 'wf-successor-owned',
        defer: false,
      });

      // Engine B shares the same durable store but never acquired a claim for
      // this workflow id — its registry tracks no epoch for it. This is the
      // exact ADR scenario: a queued macrotask whose latency outlived the
      // claim it was enqueued under (here, simply never held by this engine).
      await using engineB = await Engine.create({
        storage,
        ownership: 'workflow-lease',
        workflows: { 'inline-launch-queue-ownership-parked': parkOnSignal },
      });
      const internalsB = getInternals(engineB);

      let started = false;
      engineB.addEventListener('workflow:started', () => {
        started = true;
      });
      const onStarted = mock(() => {});

      queueInlineWorkflowExecutionStart(
        internalsB,
        {
          workflowId: 'wf-successor-owned',
          workflowType: 'inline-launch-queue-ownership-parked',
          input: null,
          checkpoint: {
            workflowId: 'wf-successor-owned',
            step: 0,
            locals: {},
            accumulatedResults: [],
            searchAttributes: {},
            version: '1',
            schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
            createdAt: 0,
          },
          nestingDepth: 0,
          executionDeadline: undefined,
          executionStateOwnerId: 'wf-successor-owned-owner',
          onStarted,
        },
        {
          processPendingUpdatesAfterInlineAdvance: async () => {},
          swallowPromiseRejection: async (promise) => {
            await promise;
          },
        },
      );

      await flushQueuedInlineWorkflowStartsDirectly(internalsB, {
        processPendingUpdatesAfterInlineAdvance: async () => {},
        swallowPromiseRejection: async (promise) => {
          await promise;
        },
      });

      // Discarded: engine B never drove the generator (no second
      // 'workflow:started' dispatch on engine B), yet the liveness callback
      // still settles — matching the existing skip-path contract.
      expect(started).toBe(false);
      expect(onStarted).toHaveBeenCalledTimes(1);
      expect(internalsB.queuedInlineWorkflowStartIds.has('wf-successor-owned')).toBe(false);
    });
  });
});
