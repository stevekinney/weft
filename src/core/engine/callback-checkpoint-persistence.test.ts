import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { HISTORY_CIRCUIT_BREAKER_REASON, workflow } from '../types.ts';
import { persistCheckpointForDataOperation } from './callback-checkpoint-persistence.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

describe('persistCheckpointForDataOperation', () => {
  it('routes checkpoint persistence through engine callbacks and enforces the history circuit breaker', async () => {
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'park-for-checkpoint' }).execute(async function* (ctx) {
      yield* ctx.waitForSignal('never');
      return 'done';
    });

    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('park-for-checkpoint', null, { id: 'park-for-checkpoint-1' });

    getInternals(engine).options.historyPolicy = { maxEvents: 0, retentionWindow: null };

    await persistCheckpointForDataOperation(engine, handle.id, {
      type: 'archive',
      operationId: 'archive-op',
      key: 'snapshot',
      data: { hello: 'world' },
    });

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
  });
});
