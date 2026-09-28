import { describe, expect, it } from 'bun:test';

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import { getInternals } from './internals.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

// Async disposal waits on tracked purge writes. If the tracked promise also
// covered the re-read that tells a lost CAS race from a deposition, a storage
// read that never returns would hold disposal and the lease release.

async function createEngine(ownership: 'lease' | 'workflow-lease') {
  return Engine.create({
    storage: new MemoryStorage(),
    workflows: {
      'fenced-write-tracking-noop': workflow({ name: 'fenced-write-tracking-noop' }).execute(
        async function* () {
          return null;
        },
      ),
    },
    ownership,
  });
}

/**
 * Wrap `base` so every `conditionalBatch` loses its CAS without a deposition,
 * then hold the fence's epoch re-read of `epochKey` until released.
 */
function loseCasAndHoldReread(base: Storage, epochKey: string) {
  let armed = false;
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const storage = {
    capabilities: () => base.capabilities(),
    get: async (key) => {
      if (armed && key === epochKey) {
        reached.resolve();
        await released.promise;
      }
      return base.get(key);
    },
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => base.scan(prefix, options),
    batch: (operations) => base.batch(operations),
    conditionalBatch: async () => {
      armed = true;
      return false;
    },
    [Symbol.dispose]: () => base[Symbol.dispose](),
  } satisfies Storage;
  return {
    storage,
    reached: reached.promise,
    release: () => {
      armed = false;
      released.resolve();
    },
  };
}

async function expectOnlyTheWriteTracked(
  internals: ReturnType<typeof getInternals>,
  workflowId: string | null,
  epochKey: string,
): Promise<void> {
  const base = internals.storage;
  const held = loseCasAndHoldReread(base, epochKey);
  internals.storage = held.storage;

  const tracked: Promise<unknown>[] = [];
  const commit = commitFencedEngineWrite(
    internals,
    workflowId,
    [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
    [],
    () => new Error('lost race'),
    (write) => {
      tracked.push(write);
      return write;
    },
  );
  await held.reached;

  expect(tracked).toHaveLength(1);
  expect(await Promise.allSettled(tracked)).toEqual([{ status: 'fulfilled', value: false }]);

  held.release();
  await expect(commit).rejects.toThrow('lost race');
  internals.storage = base;
}

describe('commitFencedEngineWrite write tracking', () => {
  it("tracks only the storage write, not a lost CAS's lease-epoch re-read under ownership: 'lease'", async () => {
    const engine = await createEngine('lease');

    await expectOnlyTheWriteTracked(getInternals(engine), null, KEYS.leaseEpoch());

    await engine[Symbol.asyncDispose]();
  });

  it("tracks only the storage write, not a lost CAS's workflow-epoch re-read under ownership: 'workflow-lease'", async () => {
    const engine = await createEngine('workflow-lease');
    const internals = getInternals(engine);
    const workflowId = 'fenced-write-tracking-workflow';
    // A workflow-scoped write is fenced on this engine's claim, so hold one.
    const registry = new WorkflowClaimRegistry({
      storage: internals.storage,
      engineId: 'fenced-write-tracking-engine',
      getNow: () => internals.options.getNow(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    internals.workflowClaimRegistry = registry;
    const acquisition = await registry.acquire(workflowId);
    expect(acquisition.status).toBe('acquired');

    await expectOnlyTheWriteTracked(internals, workflowId, KEYS.workflowOwnerEpoch(workflowId));

    await engine[Symbol.asyncDispose]();
  });
});
