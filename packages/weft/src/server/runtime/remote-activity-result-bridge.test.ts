/**
 * Unit test for `bridgeRemoteActivityResult`'s residual branch: the
 * catch-and-log path taken when `engine.completeAsyncActivity`/
 * `failAsyncActivity` rejects after `isPendingAsyncActivityToken` already
 * reported the token live — the legitimate race described in the module
 * doc comment, where a concurrent delivery of the same already-durable
 * result consumes the token between the check and this call. The success
 * path (`outcome.status === 'completed'`/`'failed'` resolving cleanly) and
 * the early-return-for-unknown-token path are already exercised end-to-end
 * by `server/remote-activity-integration.test.ts` and
 * `core/engine/remote-activity-recovery.test.ts`.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { RemoteTaskRecord } from '../../core/task-ledger/task-ledger.ts';
import { decodeRemoteTaskRecord } from '../../core/task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { activity, workflow } from '../../core/types.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { bridgeRemoteActivityResult } from './remote-activity-result-bridge.ts';

async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}

describe('bridgeRemoteActivityResult — lost race between the pending check and delivery', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('logs and swallows the rejection instead of throwing when completeAsyncActivity loses the race', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'lost-race-workflow' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );

    await engine.start('lost-race-workflow', null, { id: 'lost-race-1' });

    await waitForCondition(
      async () => {
        const stored = await readOnlyTaskLedgerRecord(engine!);
        return stored !== null && stored.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );
    const record = await readOnlyTaskLedgerRecord(engine);
    const operationId = record!.operationId;

    // Simulate the concurrent-delivery race directly: the pending-token
    // check inside bridgeRemoteActivityResult has already run by the time
    // completeAsyncActivity is invoked, so forcing that call to reject
    // reproduces "the token was consumed between the check and this call"
    // without needing a genuinely concurrent second caller.
    using completeSpy = spyOn(engine, 'completeAsyncActivity').mockImplementation(async () => {
      throw new Error('AsyncActivityTokenNotFoundError: already consumed');
    });
    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      bridgeRemoteActivityResult(engine, operationId, { status: 'completed', value: 42 }),
    ).resolves.toBeUndefined();

    expect(completeSpy).toHaveBeenCalledWith(operationId, 42);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `[weft] Remote activity result bridge could not deliver operation "${operationId}" to its parked workflow:`,
      ),
      expect.any(Error),
    );
  });

  it('routes a failed outcome through failAsyncActivity and logs the same way when it loses the race', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'lost-race-failure-workflow' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-2' });
        }),
    );

    await engine.start('lost-race-failure-workflow', null, { id: 'lost-race-2' });

    await waitForCondition(
      async () => {
        const stored = await readOnlyTaskLedgerRecord(engine!);
        return stored !== null && stored.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );
    const record = await readOnlyTaskLedgerRecord(engine);
    const operationId = record!.operationId;

    using failSpy = spyOn(engine, 'failAsyncActivity').mockImplementation(async () => {
      throw new Error('AsyncActivityTokenNotFoundError: already consumed');
    });
    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      bridgeRemoteActivityResult(engine, operationId, { status: 'failed', error: 'card declined' }),
    ).resolves.toBeUndefined();

    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `[weft] Remote activity result bridge could not deliver operation "${operationId}" to its parked workflow:`,
      ),
      expect.any(Error),
    );
  });
});
