import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { HISTORY_CIRCUIT_BREAKER_REASON, workflow } from '../types.ts';
import { getInternals } from './internals.ts';
import { runRetentionSweep } from './retention.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const noop = async () => null;

function suppressResult(handle: { result(): Promise<unknown> }): void {
  handle.result().catch(() => {});
}

// Colocated under `src/core/engine/` because the retention sweep is driven via
// the engine internals helper, which only this directory may import.
describe('history circuit breaker — retention eligibility', () => {
  it('a circuit-breaker timed-out workflow is swept like a deadline timed-out one', async () => {
    const storage = new MemoryStorage();
    // Zero retention for timed-out workflows means the next sweep purges them.
    const engine = new Engine({
      storage,
      history: { maxEvents: 2 },
      retention: { timedOut: 0 },
    });
    engine.register(
      workflow({ name: 'counting' }).execute(async function* (ctx: WorkflowContext) {
        for (let index = 0; index < 10; index++) {
          yield* ctx.run(noop);
        }
        return 'done';
      }),
    );

    const handle = await engine.start('counting', null);
    suppressResult(handle);
    await flush();

    const breachedBytes = await storage.get(KEYS.workflow(handle.id));
    expect(breachedBytes).not.toBeNull();
    const breached = decode(breachedBytes!) as WorkflowState;
    expect(breached.status).toBe('timed-out');
    expect(breached.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    await runRetentionSweep(
      getInternals(engine),
      () => undefined,
      () => undefined,
    );
    await flush();

    // After the sweep the workflow state is gone — terminationReason does not
    // exempt a circuit-breaker timeout from status-based retention.
    expect(await storage.get(KEYS.workflow(handle.id))).toBeNull();

    engine[Symbol.dispose]();
  });
});
