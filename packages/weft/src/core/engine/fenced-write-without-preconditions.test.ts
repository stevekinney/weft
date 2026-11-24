/**
 * `commitFencedEngineWriteWithoutPreconditions`: an engine-generated write with no preconditions of
 * its own. Its epoch is the only condition a commit can lose, so a lost epoch halts as a
 * deposition, and a commit that fails with the epoch still held, which only a storage adapter
 * reporting a compare-and-swap it should not have can produce, is a plain error naming the write.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf, throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { commitFencedEngineWriteWithoutPreconditions } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { EngineDeposedError } from './lease-errors.ts';

const HELD_EPOCH = new Uint8Array(8);
new DataView(HELD_EPOCH.buffer).setBigUint64(0, 1n, false);

const WRITE = [{ type: 'put' as const, key: 'effect', value: new Uint8Array([1]) }];

/** An engine holding the lease at epoch 1, over a store that records that epoch. */
async function leaseHoldingEngine(storedEpoch: Uint8Array = HELD_EPOCH) {
  const storage = new MemoryStorage();
  await storage.put(KEYS.leaseEpoch(), storedEpoch);
  const internals = {
    deposed: false,
    engine: { dispatchEvent: () => true },
    leaseManager: {
      currentEpochBytes: () => HELD_EPOCH,
      health: () => ({ status: 'healthy', holdsLease: true }),
    },
    options: { ownershipMode: 'lease' },
    storage,
    tearDownAfterDeposition: null,
  } as unknown as EngineInternals;
  return { internals, storage };
}

describe('commitFencedEngineWriteWithoutPreconditions', () => {
  it('commits the write while the lease epoch still holds', async () => {
    const { internals, storage } = await leaseHoldingEngine();

    await commitFencedEngineWriteWithoutPreconditions(internals, null, WRITE, 'Probe write');

    expect(await storage.get('effect')).toEqual(new Uint8Array([1]));
  });

  it('commits without any fence when the engine has no ownership', async () => {
    const storage = new MemoryStorage();
    const internals = {
      options: { ownershipMode: 'none' },
      storage,
    } as unknown as EngineInternals;

    await commitFencedEngineWriteWithoutPreconditions(internals, 'any-workflow', WRITE, 'Probe');

    expect(await storage.get('effect')).toEqual(new Uint8Array([1]));
  });

  it('names the write when the commit fails although the epoch still holds', async () => {
    const { internals, storage } = await leaseHoldingEngine();
    storage.conditionalBatch = async () => false;

    expect(
      await throwingRejectionOf(
        commitFencedEngineWriteWithoutPreconditions(internals, null, WRITE, 'Probe write'),
      ),
    ).toThrow('Probe write lost its CAS race.');
    expect(internals.deposed).toBe(false);
    expect(await storage.get('effect')).toBeNull();
  });

  it('halts as a deposition when the commit fails because the epoch moved on', async () => {
    const newerEpoch = new Uint8Array(8);
    new DataView(newerEpoch.buffer).setBigUint64(0, 2n, false);
    const { internals, storage } = await leaseHoldingEngine(newerEpoch);
    storage.conditionalBatch = async () => false;
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation(() => {});

    try {
      expect(
        await rejectionOf(
          commitFencedEngineWriteWithoutPreconditions(internals, null, WRITE, 'Probe write'),
        ),
      ).toBeInstanceOf(EngineDeposedError);
      expect(internals.deposed).toBe(true);
      expect(emitWarning).toHaveBeenCalledTimes(1);
    } finally {
      emitWarning.mockRestore();
    }
  });
});
