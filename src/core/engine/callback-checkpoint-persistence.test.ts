import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { HISTORY_CIRCUIT_BREAKER_REASON, workflow } from '../types.ts';
import { persistCheckpointForDataOperation } from './callback-checkpoint-persistence.ts';
import { persistCheckpointForEngine } from './callback-creators.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

const checkpointOperation = {
  type: 'archive',
  operationId: 'archive-op',
  key: 'snapshot',
  data: { hello: 'world' },
} as const;

describe('checkpoint persistence callbacks', () => {
  it.each([
    ['data operation', persistCheckpointForDataOperation],
    ['engine', persistCheckpointForEngine],
  ] as const)(
    'enforces the shared history circuit breaker for the %s caller',
    async (_name, persist) => {
      const storage = new MemoryStorage();
      await using engine = new Engine({ storage });
      const persistence = Promise.withResolvers<void>();
      const definition = workflow({ name: 'park-for-checkpoint' }).execute(async function* (ctx) {
        getInternals(engine).options.historyPolicy = { maxEvents: 0, retentionWindow: null };
        try {
          await persist(engine, ctx.workflowId, checkpointOperation);
          persistence.resolve();
        } catch (error) {
          persistence.reject(error);
        }
        yield* ctx.waitForSignal('never');
        return 'done';
      });
      engine.register(definition);
      const handle = await engine.start('park-for-checkpoint', null, {
        id: 'park-for-checkpoint-1',
      });
      void handle.result().catch(() => undefined);
      await persistence.promise;

      let state: WorkflowState | undefined;
      await waitForCondition(
        async () => {
          const stateBytes = await storage.get(KEYS.workflow(handle.id));
          if (stateBytes === null) {
            return false;
          }
          state = decode(stateBytes) as WorkflowState;
          return state.status === 'timed-out';
        },
        { label: 'history circuit breaker timeout state' },
      );

      if (state === undefined) {
        throw new Error('Expected history circuit breaker to mark the workflow as timed-out');
      }
      expect(state.status).toBe('timed-out');
      expect(state.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);
    },
  );

  it('keeps the pending-timeline policy caller-specific', async () => {
    async function observePendingTimeline(
      persist: typeof persistCheckpointForDataOperation | typeof persistCheckpointForEngine,
    ): Promise<{ committed: boolean; preservedPendingTimeline: boolean }> {
      const observation = Promise.withResolvers<{
        committed: boolean;
        preservedPendingTimeline: boolean;
      }>();
      await using engine = new Engine({ storage: new MemoryStorage() });
      const definition = workflow({ name: 'timeline-checkpoint' }).execute(async function* (ctx) {
        const internals = getInternals(engine);
        internals.pendingTimelineEntries.set(ctx.workflowId, {
          startedAt: 1,
          entry: {
            step: 0,
            operationType: 'wait-signal',
            operationLabel: 'wait-signal',
            inputSummary: 'never',
            timestamp: 1,
            status: 'running',
          },
        });
        const pendingBefore = internals.pendingTimelineEntries.get(ctx.workflowId);
        const sequenceBefore = internals.eventLogHeads.get(ctx.workflowId)?.sequence ?? -1;

        try {
          await persist(engine, ctx.workflowId, checkpointOperation);
          observation.resolve({
            committed:
              (internals.eventLogHeads.get(ctx.workflowId)?.sequence ?? -1) > sequenceBefore,
            preservedPendingTimeline:
              internals.pendingTimelineEntries.get(ctx.workflowId) === pendingBefore,
          });
        } catch (error) {
          observation.reject(error);
          return 'failed';
        }
        yield* ctx.waitForSignal('never');
        return 'done';
      });
      engine.register(definition);
      await engine.start('timeline-checkpoint', null);
      return await observation.promise;
    }

    await expect(observePendingTimeline(persistCheckpointForDataOperation)).resolves.toEqual({
      committed: true,
      preservedPendingTimeline: true,
    });
    await expect(observePendingTimeline(persistCheckpointForEngine)).resolves.toEqual({
      committed: true,
      preservedPendingTimeline: false,
    });
  });
});
