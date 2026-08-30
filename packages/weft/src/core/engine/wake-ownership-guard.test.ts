import { describe, expect, it } from 'bun:test';

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { WeftWorkflowWakeDiscardedWarning } from './lease-deposition.ts';
import {
  DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  DEFAULT_WORKFLOW_CLAIM_TTL_MS,
} from './ownership-options.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';
import { encodeEpoch, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

/** A minimal `none`-ownership Engine whose internals we poke directly. */
async function createBareEngine(): Promise<{ internals: EngineInternals }> {
  await using engine = await Engine.create({ storage: new MemoryStorage(), workflows: {} });
  return { internals: getInternals(engine) };
}

/** Install a fresh claim registry and acquire `workflowId` through it. */
async function installAndAcquireClaim(
  internals: EngineInternals,
  workflowId: string,
  engineId = 'engine-under-test',
): Promise<WorkflowClaimRegistry> {
  const registry = new WorkflowClaimRegistry({
    storage: internals.storage,
    engineId,
    getNow: () => internals.options.getNow(),
    claimTtlMs: DEFAULT_WORKFLOW_CLAIM_TTL_MS,
    claimRenewIntervalMs: DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  });
  internals.workflowClaimRegistry = registry;
  const result = await registry.acquire(workflowId);
  expect(result.status).toBe('acquired');
  return registry;
}

/** Spy on `process.emitWarning`, restoring it after `run` settles. */
async function withEmitWarningSpy<Result>(
  run: (captured: unknown[]) => Promise<Result>,
): Promise<Result> {
  const captured: unknown[] = [];
  const original = process.emitWarning;
  process.emitWarning = (warning: unknown) => {
    captured.push(warning);
  };
  try {
    return await run(captured);
  } finally {
    process.emitWarning = original;
  }
}

describe('confirmWakeOwnership', () => {
  it("proceeds with no storage read when workflowClaimRegistry is null ('none'/'lease')", async () => {
    const { internals } = await createBareEngine();
    expect(internals.workflowClaimRegistry).toBeNull();

    let reads = 0;
    internals.storage = wrapGet(internals.storage, () => {
      reads += 1;
    });

    const decision = await confirmWakeOwnership(internals, 'wf-none', 'sleep');
    expect(decision).toBe('proceed');
    expect(reads).toBe(0);
  });

  it('discards and warns when the registry tracks no epoch for this workflow id', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-owned');

    await withEmitWarningSpy(async (captured) => {
      const decision = await confirmWakeOwnership(internals, 'wf-never-acquired', 'wait-condition');
      expect(decision).toBe('discard');
      expect(captured).toHaveLength(1);
      const warning = captured[0];
      expect(warning).toBeInstanceOf(WeftWorkflowWakeDiscardedWarning);
      if (warning instanceof WeftWorkflowWakeDiscardedWarning) {
        expect(warning.workflowId).toBe('wf-never-acquired');
        expect(warning.wakeKind).toBe('wait-condition');
      }
    });
  });

  it('proceeds when the re-read holder matches this registry’s engineId and epoch', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-match');

    const decision = await confirmWakeOwnership(internals, 'wf-match', 'async-activity');
    expect(decision).toBe('proceed');
  });

  it('discards when a successor engine now holds a newer epoch', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-stale');

    // Simulate a takeover: a different engine wrote a newer generation.
    await internals.storage.batch([
      { type: 'put', key: KEYS.workflowOwnerEpoch('wf-stale'), value: encodeEpoch(2) },
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('wf-stale'),
        value: encodeWorkflowClaimHolder({
          engineId: 'successor-engine',
          epoch: 2,
          expiresAt: internals.options.getNow() + 60_000,
          claimedAt: internals.options.getNow(),
        }),
      },
    ]);

    const decision = await confirmWakeOwnership(internals, 'wf-stale', 'inline-macrotask-drive');
    expect(decision).toBe('discard');
  });

  it('discards when the holder record was deleted (released) out from under this engine', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-released');
    await internals.storage.delete(KEYS.workflowOwnerHolder('wf-released'));

    const decision = await confirmWakeOwnership(internals, 'wf-released', 'sleep');
    expect(decision).toBe('discard');
  });

  it('proceeds when the durable re-read throws (a storage blip is not a confirmed loss)', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-blip');

    internals.storage = wrapGet(internals.storage, () => {
      throw new Error('simulated storage read failure');
    });

    const decision = await confirmWakeOwnership(internals, 'wf-blip', 'sleep');
    expect(decision).toBe('proceed');
  });
});

/** Wrap `base`, running `onGet` immediately before every `get`, then delegate. */
function wrapGet(base: Storage, onGet: (key: string) => void): Storage {
  return {
    capabilities: () => base.capabilities(),
    get: (key) => {
      onGet(key);
      return base.get(key);
    },
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => base.scan(prefix, options),
    batch: (operations) => base.batch(operations),
    conditionalBatch: (conditions, operations) => base.conditionalBatch!(conditions, operations),
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
}
