/**
 * `loadWorkflowResult()` THROWS the persisted terminal error for `failed`,
 * `cancelled` and `timed-out` — that throw IS the workflow's result, not a
 * storage read failure.
 *
 * The transient-read retry policy that lets a cross-engine parent survive a
 * storage blip must therefore not swallow it. Routing a terminal domain error
 * into that path leaves the waiter pending on every poll, so a parent awaiting
 * a failed child — or an observational `result()` caller — never receives the
 * rejection and hangs instead. Re-reading a failed workflow throws again every
 * time, so that retry can never succeed.
 *
 * These use stub `EngineInternals` rather than a live engine deliberately: the
 * behavior under test lives entirely in the resolver, and a real
 * `workflow-lease` engine drags in claim-renewal intervals and disposal
 * ordering that have nothing to do with it.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { bootstrapWorkflowResultResolver, createWorkflowResultWaiter } from './handle-result.ts';

const WORKFLOW_ID = 'r4-terminal-1';

function createInternals(storage: unknown) {
  return {
    storage,
    // A claim registry tracking no epoch — this engine owns nothing.
    workflowClaimRegistry: { engineId: 'observer-engine', currentEpoch: () => null },
    resultResolvers: new Map(),
    disposed: false,
  } as any;
}

async function seedState(storage: MemoryStorage, state: Record<string, unknown>): Promise<void> {
  await storage.put(KEYS.workflow(WORKFLOW_ID), encode(state));
}

/**
 * Settle the waiter and report how its promise actually resolved.
 *
 * The rejection is observed through an attached handler rather than a deferred
 * `expect(...).rejects` assertion: the waiter legitimately stays pending when
 * the policy decides to retry, and a deferred rejection assertion awaited after
 * the fact never settles in that case, which hangs the run instead of failing.
 */
async function settleAndCapture(internals: {
  resultResolvers: Map<string, unknown>;
}): Promise<{ outcome: string; rejected: boolean; rejection: unknown }> {
  const waiter = createWorkflowResultWaiter(internals as never, WORKFLOW_ID);
  let rejected = false;
  let rejection: unknown;
  const observed = waiter.promise.then(
    () => {},
    (error: unknown) => {
      rejected = true;
      rejection = error;
    },
  );

  const outcome = await bootstrapWorkflowResultResolver(internals as never, WORKFLOW_ID, waiter);
  await observed;
  return { outcome, rejected, rejection };
}

describe('terminal workflow failures settle the waiter instead of retrying forever', () => {
  it('rejects rather than leaving the waiter pending for a failed workflow', async () => {
    const storage = new MemoryStorage();
    await seedState(storage, {
      id: WORKFLOW_ID,
      type: 'r4-type',
      status: 'failed',
      error: 'child exploded',
      createdAt: 1,
      updatedAt: 2,
    });
    const internals = createInternals(storage);

    const { outcome, rejected, rejection } = await settleAndCapture(internals);

    // `'settled'` is load-bearing: without the fix this is `'pending'`, and the
    // waiter is left for a retry that can never succeed.
    expect(outcome).toBe('settled');
    expect(rejected).toBe(true);
    expect(String(rejection)).toContain('child exploded');
    expect(internals.resultResolvers.has(WORKFLOW_ID)).toBe(false);
  });

  it('rejects rather than leaving the waiter pending for a cancelled workflow', async () => {
    const storage = new MemoryStorage();
    await seedState(storage, {
      id: WORKFLOW_ID,
      type: 'r4-type',
      status: 'cancelled',
      createdAt: 1,
      updatedAt: 2,
    });
    const internals = createInternals(storage);

    const { outcome, rejected, rejection } = await settleAndCapture(internals);

    expect(outcome).toBe('settled');
    expect(rejected).toBe(true);
    expect(String(rejection)).toContain('cancelled');
  });

  it('still retries a genuine read failure on a completed workflow', async () => {
    // The complement. A `completed` workflow reaching the same catch means the
    // second read genuinely failed, which is the transient case the retry
    // policy exists for; losing that would reintroduce the bug it fixed.
    const storage = new MemoryStorage();
    await seedState(storage, {
      id: WORKFLOW_ID,
      type: 'r4-type',
      status: 'completed',
      result: 'fine',
      createdAt: 1,
      updatedAt: 2,
    });

    let reads = 0;
    const flakyStorage = {
      capabilities: () => storage.capabilities(),
      get: (key: string) => {
        if (key === KEYS.workflow(WORKFLOW_ID)) {
          reads += 1;
          // Read 1 establishes terminal status; read 2 is
          // `loadWorkflowResult`'s internal re-read, failed here transiently.
          if (reads === 2) return Promise.reject(new Error('transient blip'));
        }
        return storage.get(key);
      },
      put: (key: string, value: Uint8Array) => storage.put(key, value),
      delete: (key: string) => storage.delete(key),
      scan: (prefix: string, options?: unknown) => storage.scan(prefix, options as never),
      batch: (operations: unknown) => storage.batch(operations as never),
      conditionalBatch: (conditions: unknown, operations: unknown) =>
        storage.conditionalBatch(conditions as never, operations as never),
      [Symbol.dispose]: () => {},
    };

    const internals = createInternals(flakyStorage);
    const waiter = createWorkflowResultWaiter(internals, WORKFLOW_ID);
    void waiter.promise.catch(() => {});

    const outcome = await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, waiter);

    expect(outcome).toBe('pending');
    expect(internals.resultResolvers.get(WORKFLOW_ID)).toBe(waiter);
  });
});
