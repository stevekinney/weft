import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WeftWorkflowClaimLostWarning } from './lease-deposition.ts';
import {
  decodeEpoch,
  encodeEpoch,
  encodeWorkflowClaimHolder,
  type WorkflowClaimHolderRecord,
} from './workflow-claim-codec.ts';
import {
  extractPutOperationValue,
  WorkflowClaimRegistry,
  type WorkflowClaimRegistryOptions,
} from './workflow-claim-registry.ts';
import { WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER } from './workflow-claim-transitions.ts';
import { createWorkflowClaimTestStorage } from './workflow-claim.test-support.ts';

const TTL_MS = 30_000;
const RENEW_MS = 5_000;

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function registryOptions(
  overrides: Partial<WorkflowClaimRegistryOptions> &
    Pick<WorkflowClaimRegistryOptions, 'storage' | 'getNow'>,
): WorkflowClaimRegistryOptions {
  return {
    engineId: 'engine-a',
    claimTtlMs: TTL_MS,
    claimRenewIntervalMs: RENEW_MS,
    ...overrides,
  };
}

async function readEpoch(storage: Storage, workflowId: string): Promise<number | null> {
  const raw = await storage.get(KEYS.workflowOwnerEpoch(workflowId));
  return raw === null ? null : decodeEpoch(raw);
}

async function readHolderExists(storage: Storage, workflowId: string): Promise<boolean> {
  return (await storage.get(KEYS.workflowOwnerHolder(workflowId))) !== null;
}

async function putHolder(
  storage: Storage,
  workflowId: string,
  record: WorkflowClaimHolderRecord,
): Promise<void> {
  await storage.put(KEYS.workflowOwnerHolder(workflowId), encodeWorkflowClaimHolder(record));
}

describe('extractPutOperationValue', () => {
  it('returns the value of the matching put operation', () => {
    const operations: BatchOperation[] = [
      { type: 'delete', key: 'other' },
      { type: 'put', key: 'target', value: new Uint8Array([1, 2, 3]) },
    ];
    expect(extractPutOperationValue(operations, 'target')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('throws when no put operation matches the key', () => {
    const operations: BatchOperation[] = [{ type: 'delete', key: 'target' }];
    expect(() => extractPutOperationValue(operations, 'target')).toThrow(
      /expected a "put" operation for key "target"/,
    );
  });
});

describe('WorkflowClaimRegistry.acquire', () => {
  it('acquires a never-seen id at epoch 1', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.acquire('wf-1');

    expect(result).toEqual({ status: 'acquired', workflowId: 'wf-1', epoch: 1 });
    expect(await readEpoch(storage, 'wf-1')).toBe(1);
    expect(registry.currentEpoch('wf-1')).toBe(1);
  });

  it('acquires a reused id at the epoch past the prior generation', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    await registry.acquire('wf-1');
    await registry.release('wf-1');
    const result = await registry.acquire('wf-1');

    expect(result).toEqual({ status: 'acquired', workflowId: 'wf-1', epoch: 2 });
    expect(await readEpoch(storage, 'wf-1')).toBe(2);
  });

  it('loses the race against an already-live holder and reports heldBy from the pre-read', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    await putHolder(storage, 'wf-1', {
      engineId: 'engine-b',
      epoch: 1,
      expiresAt: clock.now() + TTL_MS,
      claimedAt: clock.now(),
    });
    await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(1));
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.acquire('wf-1');

    expect(result).toEqual({ status: 'lost-race', workflowId: 'wf-1', heldBy: 'engine-b' });
    expect(registry.currentEpoch('wf-1')).toBeNull();
  });

  it('reports heldBy null when the pre-existing holder is undecodable garbage', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    await storage.put(KEYS.workflowOwnerHolder('wf-1'), new Uint8Array([1, 2, 3]));
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.acquire('wf-1');

    expect(result).toEqual({ status: 'lost-race', workflowId: 'wf-1', heldBy: null });
  });

  it('reports heldBy null when the forced CAS loss leaves no holder to re-read', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const gated = createWorkflowClaimTestStorage(storage);
    gated.queueForceFalse();
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );

    const result = await registry.acquire('wf-1');

    expect(result).toEqual({ status: 'lost-race', workflowId: 'wf-1', heldBy: null });
  });

  it('re-reads the true holder when a competitor races in between the read and the write', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const gated = createWorkflowClaimTestStorage(storage);
    gated.queueBeforeCommit(async () => {
      await putHolder(storage, 'wf-1', {
        engineId: 'engine-b',
        epoch: 1,
        expiresAt: clock.now() + TTL_MS,
        claimedAt: clock.now(),
      });
      await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(1));
    });
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );

    const result = await registry.acquire('wf-1');

    expect(result).toEqual({ status: 'lost-race', workflowId: 'wf-1', heldBy: 'engine-b' });
  });
});

describe('WorkflowClaimRegistry.renew', () => {
  it('renews successfully, advancing expiresAt but keeping the same epoch', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');
    const epochBefore = registry.currentEpoch('wf-1');

    clock.advance(RENEW_MS);
    const result = await registry.renew('wf-1');

    expect(result).toEqual({ status: 'renewed', workflowId: 'wf-1' });
    expect(registry.currentEpoch('wf-1')).toBe(epochBefore);
  });

  it('returns not-held when the workflow was never claimed', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.renew('wf-1');

    expect(result).toEqual({ status: 'not-held', workflowId: 'wf-1' });
  });

  it('loses the CAS, drops the local claim, and emits WeftWorkflowClaimLostWarning exactly once', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: WeftWorkflowClaimLostWarning[] = [];
    const registry = new WorkflowClaimRegistry(
      registryOptions({
        storage,
        getNow: clock.now,
        warn: (warning) => {
          if (warning instanceof WeftWorkflowClaimLostWarning) warnings.push(warning);
        },
      }),
    );
    await registry.acquire('wf-1');
    // Simulate a takeover from underneath this engine by writing a fresh holder.
    await putHolder(storage, 'wf-1', {
      engineId: 'engine-b',
      epoch: 2,
      expiresAt: clock.now() + TTL_MS,
      claimedAt: clock.now(),
    });

    const first = await registry.renew('wf-1');
    expect(first).toEqual({ status: 'lost', workflowId: 'wf-1' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.workflowId).toBe('wf-1');

    const second = await registry.renew('wf-1');
    expect(second).toEqual({ status: 'not-held', workflowId: 'wf-1' });
    expect(warnings).toHaveLength(1);
  });

  it('propagates a thrown storage error, leaves the claim intact, and does not warn', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const gated = createWorkflowClaimTestStorage(storage);
    const warnings: WeftWorkflowClaimLostWarning[] = [];
    const registry = new WorkflowClaimRegistry(
      registryOptions({
        storage: gated.storage,
        getNow: clock.now,
        warn: (warning) => {
          if (warning instanceof WeftWorkflowClaimLostWarning) warnings.push(warning);
        },
      }),
    );
    await registry.acquire('wf-1');
    const epochBefore = registry.currentEpoch('wf-1');

    gated.queueThrow(new Error('transient storage failure'));
    await expect(registry.renew('wf-1')).rejects.toThrow('transient storage failure');

    expect(warnings).toHaveLength(0);
    expect(registry.currentEpoch('wf-1')).toBe(epochBefore);

    const released = await registry.release('wf-1');
    expect(released.status).toBe('released');
  });

  it('shares one in-flight promise across concurrent renew calls for the same id', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');

    const [first, second] = await Promise.all([registry.renew('wf-1'), registry.renew('wf-1')]);

    expect(first).toEqual({ status: 'renewed', workflowId: 'wf-1' });
    expect(second).toBe(first);
  });

  it('a release that awaits a throwing in-flight renewal swallows the rejection and still releases', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const gated = createWorkflowClaimTestStorage(storage);
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );
    await registry.acquire('wf-1');

    gated.queueThrow(new Error('renew storage failure'));
    const renewPromise = registry.renew('wf-1');
    const releasePromise = registry.release('wf-1');

    await expect(renewPromise).rejects.toThrow('renew storage failure');
    const releaseResult = await releasePromise;

    expect(releaseResult).toEqual({ status: 'released', workflowId: 'wf-1' });
    expect(await readHolderExists(storage, 'wf-1')).toBe(false);
  });
});

describe('WorkflowClaimRegistry.renew · racing takeover', () => {
  it('keeps the entry a concurrent takeover installed when the in-flight renewal loses its CAS', async () => {
    const clock = makeClock();
    const base = new MemoryStorage();
    const gated = createWorkflowClaimTestStorage(base);
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );

    const acquired = await registry.acquire('workflow-a');
    expect(acquired.status).toBe('acquired');

    // Pause the renewal inside its conditionalBatch, then let a takeover for the
    // same id complete and durably install a fresh generation underneath it.
    const gate = gated.queueGate();
    const renewing = registry.renew('workflow-a');
    await gate.reached;

    // Simulate a successor generation landing while the renewal is suspended:
    // rewrite storage so the renewal's expected holder bytes no longer match,
    // and re-take the claim through the registry so it tracks a fresh entry.
    await putHolder(base, 'workflow-a', {
      engineId: 'engine-b',
      epoch: 2,
      expiresAt: clock.now() - 1,
      claimedAt: clock.now() - 1,
    });
    await base.put(KEYS.workflowOwnerEpoch('workflow-a'), encodeEpoch(2));
    clock.advance(TTL_MS + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * RENEW_MS + 1);
    const retaken = await registry.takeover('workflow-a');
    expect(retaken.status).toBe('acquired');
    const retakenEpoch = retaken.status === 'acquired' ? retaken.epoch : null;

    gate.release();
    // The renewal loses its CAS, because the bytes it conditioned on are gone.
    await expect(renewing).resolves.toMatchObject({ status: 'lost' });

    // ...but it must not forget the generation the takeover just established.
    // Dropping it here would stop renewing a claim this engine durably owns and
    // hand it to a successor at expiry.
    expect(registry.currentEpoch('workflow-a')).toBe(retakenEpoch);
  });
});

describe('WorkflowClaimRegistry.release', () => {
  it('releases the holder key but leaves the epoch key intact', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');

    const result = await registry.release('wf-1');

    expect(result).toEqual({ status: 'released', workflowId: 'wf-1' });
    expect(await readHolderExists(storage, 'wf-1')).toBe(false);
    expect(await readEpoch(storage, 'wf-1')).toBe(1);
    expect(registry.currentEpoch('wf-1')).toBeNull();
  });

  it('returns not-held for a workflow that was never claimed', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.release('wf-1');

    expect(result).toEqual({ status: 'not-held', workflowId: 'wf-1' });
  });

  it('reports lost-race and drops the local claim when the CAS fails', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const gated = createWorkflowClaimTestStorage(storage);
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );
    await registry.acquire('wf-1');

    gated.queueForceFalse();
    const result = await registry.release('wf-1');

    expect(result).toEqual({ status: 'lost-race', workflowId: 'wf-1' });
    expect(registry.currentEpoch('wf-1')).toBeNull();
  });

  it('fails a concurrent renew fast as not-held once release has begun', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');

    const releasePromise = registry.release('wf-1');
    const duringRelease = await registry.renew('wf-1');

    expect(duringRelease).toEqual({ status: 'not-held', workflowId: 'wf-1' });
    await releasePromise;
  });

  it('awaits an in-flight renewal and then conditions on the renewed bytes', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const gated = createWorkflowClaimTestStorage(storage);
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );
    await registry.acquire('wf-1');

    const gate = gated.queueGate();
    const renewPromise = registry.renew('wf-1');
    await gate.reached;
    const releasePromise = registry.release('wf-1');
    gate.release();

    const renewResult = await renewPromise;
    const releaseResult = await releasePromise;

    expect(renewResult).toEqual({ status: 'renewed', workflowId: 'wf-1' });
    expect(releaseResult).toEqual({ status: 'released', workflowId: 'wf-1' });
    expect(await readHolderExists(storage, 'wf-1')).toBe(false);
  });
});

describe('WorkflowClaimRegistry.takeover', () => {
  it('returns no-claim when the workflow was never claimed', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.takeover('wf-1');

    expect(result).toEqual({ status: 'no-claim', workflowId: 'wf-1' });
  });

  it('returns no-claim when a holder exists with no epoch key (invariant violation)', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    await putHolder(storage, 'wf-1', {
      engineId: 'engine-b',
      epoch: 1,
      expiresAt: clock.now() + TTL_MS,
      claimedAt: clock.now(),
    });
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.takeover('wf-1');

    expect(result).toEqual({ status: 'no-claim', workflowId: 'wf-1' });
  });

  it('reports not-expired exactly at the grace-adjusted deadline', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const expiresAt = clock.now();
    await putHolder(storage, 'wf-1', {
      engineId: 'engine-b',
      epoch: 1,
      expiresAt,
      claimedAt: clock.now(),
    });
    await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(1));
    clock.advance(WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * RENEW_MS);
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.takeover('wf-1');

    expect(result).toEqual({
      status: 'not-expired',
      workflowId: 'wf-1',
      heldBy: 'engine-b',
      expiresAt,
    });
  });

  it('takes over one tick past the grace-adjusted deadline', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const expiresAt = clock.now();
    await putHolder(storage, 'wf-1', {
      engineId: 'engine-b',
      epoch: 1,
      expiresAt,
      claimedAt: clock.now(),
    });
    await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(1));
    clock.advance(WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * RENEW_MS + 1);
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.takeover('wf-1');

    expect(result).toEqual({ status: 'acquired', workflowId: 'wf-1', epoch: 2 });
    expect(registry.currentEpoch('wf-1')).toBe(2);
  });

  it('steals an undecodable garbage holder immediately, without waiting for expiry', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    await storage.put(KEYS.workflowOwnerHolder('wf-1'), new Uint8Array([9, 9, 9]));
    await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(4));
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    const result = await registry.takeover('wf-1');

    expect(result).toEqual({ status: 'acquired', workflowId: 'wf-1', epoch: 5 });
  });

  it('loses the takeover race and re-reads the new holder', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const expiresAt = clock.now();
    await putHolder(storage, 'wf-1', {
      engineId: 'engine-b',
      epoch: 1,
      expiresAt,
      claimedAt: clock.now(),
    });
    await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(1));
    clock.advance(WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * RENEW_MS + 1);
    const gated = createWorkflowClaimTestStorage(storage);
    gated.queueBeforeCommit(async () => {
      await putHolder(storage, 'wf-1', {
        engineId: 'engine-c',
        epoch: 2,
        expiresAt: clock.now() + TTL_MS,
        claimedAt: clock.now(),
      });
      await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(2));
    });
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );

    const result = await registry.takeover('wf-1');

    expect(result).toEqual({ status: 'lost-race', workflowId: 'wf-1', heldBy: 'engine-c' });
  });
});

describe('WorkflowClaimRegistry.currentEpoch / currentEpochBytes', () => {
  it('returns null for an unknown workflow id', () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    expect(registry.currentEpoch('wf-1')).toBeNull();
    expect(registry.currentEpochBytes('wf-1')).toBeNull();
  });

  it('returns a defensive copy that mutation cannot corrupt', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');

    const bytes = registry.currentEpochBytes('wf-1');
    expect(bytes).not.toBeNull();
    bytes?.fill(0xff);

    const result = await registry.renew('wf-1');
    expect(result).toEqual({ status: 'renewed', workflowId: 'wf-1' });
    expect(registry.currentEpochBytes('wf-1')).toEqual(encodeEpoch(1));
  });
});

describe('WorkflowClaimRegistry.listHeldWorkflowIds', () => {
  it('returns an empty array when no claims are held', () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));

    expect(registry.listHeldWorkflowIds()).toEqual([]);
  });

  it('lists every currently tracked workflow id', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');
    await registry.acquire('wf-2');

    expect(registry.listHeldWorkflowIds().toSorted()).toEqual(['wf-1', 'wf-2']);
  });

  it('drops a released id and returns a snapshot mutation cannot corrupt', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');
    await registry.acquire('wf-2');
    await registry.release('wf-1');

    const snapshot = registry.listHeldWorkflowIds();
    expect(snapshot).toEqual(['wf-2']);

    await registry.acquire('wf-3');
    expect(snapshot).toEqual(['wf-2']);
    expect(registry.listHeldWorkflowIds().toSorted()).toEqual(['wf-2', 'wf-3']);
  });
});

describe('WorkflowClaimRegistry.releaseAll', () => {
  it('releases every tracked claim', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: clock.now }));
    await registry.acquire('wf-1');
    await registry.acquire('wf-2');

    await registry.releaseAll();

    expect(await readHolderExists(storage, 'wf-1')).toBe(false);
    expect(await readHolderExists(storage, 'wf-2')).toBe(false);
    expect(registry.currentEpoch('wf-1')).toBeNull();
    expect(registry.currentEpoch('wf-2')).toBeNull();
  });

  it('swallows a failing release so the rest of shutdown proceeds', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const gated = createWorkflowClaimTestStorage(storage);
    const registry = new WorkflowClaimRegistry(
      registryOptions({ storage: gated.storage, getNow: clock.now }),
    );
    await registry.acquire('wf-1');
    await registry.acquire('wf-2');

    gated.queueThrow(new Error('storage unavailable'));

    await expect(registry.releaseAll()).resolves.toBeUndefined();
    expect(await readHolderExists(storage, 'wf-2')).toBe(false);
  });
});

describe('createWorkflowClaimTestStorage', () => {
  it('proxies get/put/delete/scan/batch/dispose to the base storage', async () => {
    const base = new MemoryStorage();
    const gated = createWorkflowClaimTestStorage(base);

    await gated.storage.put('wf:a', new Uint8Array([1]));
    expect(await gated.storage.get('wf:a')).toEqual(new Uint8Array([1]));

    const scanned: string[] = [];
    for await (const [key] of gated.storage.scan('wf:')) scanned.push(key);
    expect(scanned).toEqual(['wf:a']);

    await gated.storage.batch([{ type: 'put', key: 'wf:b', value: new Uint8Array([2]) }]);
    expect(await gated.storage.get('wf:b')).toEqual(new Uint8Array([2]));

    await gated.storage.delete('wf:a');
    expect(await gated.storage.get('wf:a')).toBeNull();

    gated.storage[Symbol.dispose]();
    expect(await base.get('wf:b')).toBeNull();
  });

  it('throws when the base storage does not implement conditionalBatch', async () => {
    const base = new MemoryStorage();
    const bareStorage: Storage = {
      capabilities: () => base.capabilities(),
      get: (key) => base.get(key),
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      [Symbol.dispose]: () => base[Symbol.dispose](),
    };
    const gated = createWorkflowClaimTestStorage(bareStorage);

    await expect(gated.storage.conditionalBatch?.([], [])).rejects.toThrow(
      /requires conditionalBatch support/,
    );
  });
});
