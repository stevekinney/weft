import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { yieldToEventLoop } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { CURRENT_CHECKPOINT_SCHEMA_VERSION } from '../types/checkpoint.ts';
import { queueInlineWorkflowExecutionStart } from './inline-launch-queue.ts';
import { getInternals } from './internals.ts';

describe('inline launch queue', () => {
  it('falls back to a timeout flush when no message channel is available', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
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
          pendingSignals: [],
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
});
