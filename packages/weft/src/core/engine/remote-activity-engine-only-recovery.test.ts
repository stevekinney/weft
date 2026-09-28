/**
 * COR-219 residual: `Engine.recoverAll()` over storage with NO server for
 * `queued`, `leased`, and `completing` ledger records.
 *
 * `remote-activity-recovery.test.ts`'s "adopts the real value across a crash
 * between the ledger commit and any bridge delivery" test is the only
 * existing test that drives `Engine.recoverAll()` with no server involved,
 * and it exercises exactly one state: terminal-not-yet-adopted (a resolution
 * record already committed, recovered through
 * `recoverPendingAsyncActivities`). `queued`/`leased`/`completing` have real,
 * tested handling only at the SERVER-recovery level
 * (`task-ledger-recovery.ts`'s `runTaskLedgerRecovery`, run from `serve()`),
 * which is a different code path from engine-only recovery: this issue's own
 * sentence is specifically about "engine creation restor[ing] remote task
 * state before recovered workflows advance into an activity operation that
 * depends on it."
 *
 * Each test here drives a REAL workflow replay through `recoverAll()` —
 * never pre-seeding storage with a synthetic record — so the assertion is
 * about the actual replay path a recovered workflow takes through the leaf
 * activity executor and `EngineOwnedRemoteActivityBroker.enqueue`'s
 * idempotent-replay guard, not just the decode/branch logic in isolation
 * (the exact distinction the P-COR-38 refutation drew between a synthetic
 * fixture and a genuine replay).
 *
 * **Why a wrapped broker, and why it is still "the production broker."**
 * A recovered workflow's replay reaches `context.run()` again and throws a
 * FRESH `AsyncActivityDeferral` whose `afterRegister` calls
 * `broker.enqueue()` — but `Engine.recoverAll()` itself does not await that
 * dispatch settling before it resolves (confirmed empirically: instrumenting
 * `enqueue()` showed its write landing strictly AFTER `recoverAll()` had
 * already returned). There is no other observable side effect on the
 * idempotent no-op path — that IS the correct behavior being proven — so
 * polling storage on any fixed schedule after `recoverAll()` resolves would
 * be exactly the timing-margin anti-pattern this project's own review
 * process rejects. Each test below therefore wraps the REAL
 * `EngineOwnedRemoteActivityBroker` (same class, same `enqueue` method, same
 * storage) in a thin pass-through that resolves only after delegating to it,
 * giving a real, event-driven barrier (`waitForCondition(() => calls === 2)`)
 * without altering or bypassing any production logic.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import type { RemoteActivityBroker } from '../remote-activity-broker.ts';
import { commitTaskLedgerTransition } from '../task-ledger/task-ledger-runtime.ts';
import { beginCompletion, claimQueued } from '../task-ledger/task-ledger-transitions.ts';
import type { RemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import { decodeRemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';
import { EngineOwnedRemoteActivityBroker } from './remote-activity-broker.ts';

async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}

async function countTaskLedgerRecords(engine: Engine): Promise<number> {
  let count = 0;
  for await (const [_key] of engine.storage.scan('task-ledger:')) {
    count += 1;
  }
  return count;
}

/** A never-invoked local stub, matching every other remote-mode test's convention. */
async function neverLocal(_input: { orderId: string }): Promise<never> {
  throw new Error('local execution must never run in remote mode');
}

/**
 * A thin pass-through over the REAL `EngineOwnedRemoteActivityBroker` — see
 * this file's header comment for why this is not a recording/fake double.
 * `completedCalls` increments only after the delegated call has fully
 * resolved, and `freshEnqueues` mirrors the production broker's own
 * `onEnqueued` hint (fired only on a genuinely fresh write, never for the
 * idempotent-replay no-op path).
 */
function createObservedProductionBroker(storage: MemoryStorage): {
  broker: RemoteActivityBroker;
  completedCalls: () => number;
  freshEnqueues: () => number;
} {
  let completedCalls = 0;
  let freshEnqueues = 0;
  const production = new EngineOwnedRemoteActivityBroker(storage, {}, () => {
    freshEnqueues += 1;
  });
  return {
    broker: {
      async enqueue(request) {
        await production.enqueue(request);
        completedCalls += 1;
      },
    },
    completedCalls: () => completedCalls,
    freshEnqueues: () => freshEnqueues,
  };
}

async function dispatchAndReachQueued(
  engine: Engine,
  workflowType: string,
  workflowId: string,
): Promise<{ operationId: string }> {
  await engine.start(workflowType, null, { id: workflowId });
  let operationId: string | undefined;
  await waitForCondition(
    async () => {
      const record = await readOnlyTaskLedgerRecord(engine);
      if (record === null || record.state !== 'queued') return false;
      operationId = record.operationId;
      return true;
    },
    { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
  );
  if (operationId === undefined) throw new Error('expected a queued operationId');
  return { operationId };
}

describe('engine-only recovery of queued/leased/completing remote-activity records (COR-219)', () => {
  it('does not duplicate-enqueue a still-queued record when a recovered workflow replays ctx.run()', async () => {
    const chargeCard = activity({ name: 'chargeCard', execute: neverLocal });
    const definition = workflow({ name: 'engine-only-recovery-queued-workflow' })
      .activities({ chargeCard })
      .execute(async function* (context: WorkflowContext) {
        return yield* context.run(chargeCard, { orderId: 'ord-1' });
      });

    const storage = new MemoryStorage();
    const observed = createObservedProductionBroker(storage);

    const engine = new Engine({
      storage,
      activityExecution: { mode: 'remote', broker: observed.broker },
    });
    engine.register(definition);

    await dispatchAndReachQueued(engine, 'engine-only-recovery-queued-workflow', 'eor-queued-1');
    await waitForCondition(() => observed.completedCalls() >= 1, {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'first enqueue() call to complete',
    });
    const beforeRecovery = await readOnlyTaskLedgerRecord(engine);
    if (beforeRecovery === null || beforeRecovery.state !== 'queued') {
      throw new Error('expected a queued record before recovery');
    }
    expect(observed.freshEnqueues()).toBe(1);

    // The crash: dispose with no server or worker ever having existed.
    engine[Symbol.dispose]();

    const recoveredEngine = new Engine({
      storage,
      activityExecution: { mode: 'remote', broker: observed.broker },
    });
    recoveredEngine.register(definition);

    // The replayed workflow re-executes ctx.run(), re-deriving the SAME
    // deterministic token, and calls
    // EngineOwnedRemoteActivityBroker.enqueue() again for the identical
    // operationId — this is the idempotent-replay guard actually being
    // exercised by recovery, not a synthetic re-seed.
    await recoveredEngine.recoverAll();
    await waitForCondition(() => observed.completedCalls() >= 2, {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'the replay-driven second enqueue() call to complete',
    });

    const afterRecovery = await readOnlyTaskLedgerRecord(recoveredEngine);
    if (afterRecovery === null || afterRecovery.state !== 'queued') {
      throw new Error('expected the record to still be queued after recovery');
    }
    expect(afterRecovery.generation).toBe(beforeRecovery.generation);
    expect(afterRecovery.operationId).toBe(beforeRecovery.operationId);
    expect(await countTaskLedgerRecords(recoveredEngine)).toBe(1);
    // No fresh enqueue hint for a replay that only re-derived an ALREADY
    // durable record.
    expect(observed.freshEnqueues()).toBe(1);

    recoveredEngine[Symbol.dispose]();
  });

  it('does not duplicate-enqueue or disturb a leased record when a recovered workflow replays ctx.run()', async () => {
    const chargeCard = activity({ name: 'chargeCard', execute: neverLocal });
    const definition = workflow({ name: 'engine-only-recovery-leased-workflow' })
      .activities({ chargeCard })
      .execute(async function* (context: WorkflowContext) {
        return yield* context.run(chargeCard, { orderId: 'ord-1' });
      });

    const storage = new MemoryStorage();
    const observed = createObservedProductionBroker(storage);

    const engine = new Engine({
      storage,
      activityExecution: { mode: 'remote', broker: observed.broker },
    });
    engine.register(definition);

    const { operationId } = await dispatchAndReachQueued(
      engine,
      'engine-only-recovery-leased-workflow',
      'eor-leased-1',
    );
    await waitForCondition(() => observed.completedCalls() >= 1, {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'first enqueue() call to complete',
    });

    // Drive the ledger straight through `queued -> leased`, using the exact
    // same production transition a real worker's claim would — no server or
    // worker ever exists in this test.
    const attemptToken = crypto.randomUUID();
    const claimed = await commitTaskLedgerTransition(storage, operationId, (current, now) => {
      if (current === null || current.state !== 'queued') {
        throw new Error(`expected a queued record for "${operationId}"`);
      }
      return claimQueued(
        current,
        {
          expectedGeneration: current.generation,
          attemptToken,
          workerSessionId: 'engine-only-recovery-session',
          leaseDurationMilliseconds: 30_000,
        },
        now,
      );
    });
    if (!claimed.ok) throw new Error(`failed to claim: ${claimed.reason}`);
    const beforeRecovery = claimed.record;
    expect(beforeRecovery.state).toBe('leased');

    engine[Symbol.dispose]();

    const recoveredEngine = new Engine({
      storage,
      activityExecution: { mode: 'remote', broker: observed.broker },
    });
    recoveredEngine.register(definition);

    await recoveredEngine.recoverAll();
    await waitForCondition(() => observed.completedCalls() >= 2, {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'the replay-driven second enqueue() call to complete',
    });

    const afterRecovery = await readOnlyTaskLedgerRecord(recoveredEngine);
    if (afterRecovery === null || afterRecovery.state !== 'leased') {
      throw new Error('expected the record to still be leased after recovery');
    }
    expect(afterRecovery.generation).toBe(beforeRecovery.generation);
    expect(afterRecovery.attemptToken).toBe(attemptToken);
    expect(await countTaskLedgerRecords(recoveredEngine)).toBe(1);
    expect(observed.freshEnqueues()).toBe(1);

    recoveredEngine[Symbol.dispose]();
  });

  it('does not duplicate-enqueue or disturb a completing record when a recovered workflow replays ctx.run()', async () => {
    const chargeCard = activity({ name: 'chargeCard', execute: neverLocal });
    const definition = workflow({ name: 'engine-only-recovery-completing-workflow' })
      .activities({ chargeCard })
      .execute(async function* (context: WorkflowContext) {
        return yield* context.run(chargeCard, { orderId: 'ord-1' });
      });

    const storage = new MemoryStorage();
    const observed = createObservedProductionBroker(storage);

    const engine = new Engine({
      storage,
      activityExecution: { mode: 'remote', broker: observed.broker },
    });
    engine.register(definition);

    const { operationId } = await dispatchAndReachQueued(
      engine,
      'engine-only-recovery-completing-workflow',
      'eor-completing-1',
    );
    await waitForCondition(() => observed.completedCalls() >= 1, {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'first enqueue() call to complete',
    });

    const attemptToken = crypto.randomUUID();
    const claimed = await commitTaskLedgerTransition(storage, operationId, (current, now) => {
      if (current === null || current.state !== 'queued') {
        throw new Error(`expected a queued record for "${operationId}"`);
      }
      return claimQueued(
        current,
        {
          expectedGeneration: current.generation,
          attemptToken,
          workerSessionId: 'engine-only-recovery-session',
          leaseDurationMilliseconds: 30_000,
        },
        now,
      );
    });
    if (!claimed.ok) throw new Error(`failed to claim: ${claimed.reason}`);

    // Drive `leased -> completing` — a worker's result has arrived and is
    // pending commit, but the terminal transition never lands before the
    // crash.
    const completing = await commitTaskLedgerTransition(storage, operationId, (current) => {
      if (current === null || (current.state !== 'leased' && current.state !== 'cancelling')) {
        throw new Error(`expected a leased record for "${operationId}"`);
      }
      return beginCompletion(current, {
        attemptToken,
        pendingStatus: 'completed',
        pendingResultDigest: 'engine-only-recovery-completing-digest',
      });
    });
    if (!completing.ok) throw new Error(`failed to begin completion: ${completing.reason}`);
    const beforeRecovery = completing.record;
    expect(beforeRecovery.state).toBe('completing');

    engine[Symbol.dispose]();

    const recoveredEngine = new Engine({
      storage,
      activityExecution: { mode: 'remote', broker: observed.broker },
    });
    recoveredEngine.register(definition);

    await recoveredEngine.recoverAll();
    await waitForCondition(() => observed.completedCalls() >= 2, {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'the replay-driven second enqueue() call to complete',
    });

    const afterRecovery = await readOnlyTaskLedgerRecord(recoveredEngine);
    if (afterRecovery === null || afterRecovery.state !== 'completing') {
      throw new Error('expected the record to still be completing after recovery');
    }
    expect(afterRecovery.generation).toBe(beforeRecovery.generation);
    expect(afterRecovery.attemptToken).toBe(attemptToken);
    expect(afterRecovery.pendingResultDigest).toBe('engine-only-recovery-completing-digest');
    expect(await countTaskLedgerRecords(recoveredEngine)).toBe(1);
    expect(observed.freshEnqueues()).toBe(1);

    recoveredEngine[Symbol.dispose]();
  });
});
