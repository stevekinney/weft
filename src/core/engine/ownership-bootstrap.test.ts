/**
 * `bootstrapWorkflowLeaseOwnership` (ADR 0002): the standalone unit that runs
 * Gate 1 + Gate 2 for `ownership: 'workflow-lease'` and, only once they pass,
 * constructs the claim registry, its renewal task, and a metrics recorder fed
 * by the renewal task's `onPassComplete` seam. `Engine`-level ordering (before
 * `recoverAll`, before the scheduler starts, on both construction paths) is
 * pinned separately in `workflow-lease-ownership.test.ts`.
 */
import { describe, expect, it } from 'bun:test';

import type { Storage, StorageCapabilities } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { OwnershipModeMismatchError } from './lease-errors.ts';
import {
  bootstrapWorkflowLeaseOwnership,
  createWorkflowClaimRenewalTarget,
} from './ownership-bootstrap.ts';
import { encodeOwnershipModeMarker } from './workflow-claim-codec.ts';
import type { WorkflowClaimRenewResult } from './workflow-claim-registry.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

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

/** A `WorkflowClaimRegistry` whose `renew()` always resolves to a canned result. */
class CannedRenewRegistry extends WorkflowClaimRegistry {
  readonly #canned: WorkflowClaimRenewResult;

  constructor(canned: WorkflowClaimRenewResult) {
    super({
      storage: new MemoryStorage(),
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    this.#canned = canned;
  }

  override async renew(): Promise<WorkflowClaimRenewResult> {
    return this.#canned;
  }
}

describe('createWorkflowClaimRenewalTarget', () => {
  it('resolves on a "renewed" result', async () => {
    const registry = new CannedRenewRegistry({ status: 'renewed', workflowId: 'wf-1' });
    const target = createWorkflowClaimRenewalTarget(registry);

    await expect(target.renewWorkflowClaim('wf-1')).resolves.toBeUndefined();
  });

  it('resolves (does not reject) on a "not-held" result — the benign release race', async () => {
    const registry = new CannedRenewRegistry({ status: 'not-held', workflowId: 'wf-1' });
    const target = createWorkflowClaimRenewalTarget(registry);

    await expect(target.renewWorkflowClaim('wf-1')).resolves.toBeUndefined();
  });

  it('rejects on a "lost" result', async () => {
    const registry = new CannedRenewRegistry({ status: 'lost', workflowId: 'wf-1' });
    const target = createWorkflowClaimRenewalTarget(registry);

    await expect(target.renewWorkflowClaim('wf-1')).rejects.toThrow(/lost its ownership claim/);
  });

  it('delegates listHeldWorkflowIds to the registry', async () => {
    const registry = new WorkflowClaimRegistry({
      storage: new MemoryStorage(),
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    await registry.acquire('wf-1');
    const target = createWorkflowClaimRenewalTarget(registry);

    expect(target.listHeldWorkflowIds()).toEqual(['wf-1']);
  });
});

describe('bootstrapWorkflowLeaseOwnership', () => {
  it('constructs a registry, renewal task, and metrics recorder after the gates pass', async () => {
    using storage = new MemoryStorage();
    const clock = makeClock();

    const result = await bootstrapWorkflowLeaseOwnership({
      storage,
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });

    expect(result.registry).toBeInstanceOf(WorkflowClaimRegistry);
    expect(result.metrics.snapshot()).toEqual({
      attempts: {
        acquired: 0,
        takeover: 0,
        lost_race: 0,
        deposed: 0,
        backoff_skipped: 0,
      },
      activeClaims: 0,
      renewalFailures: 0,
    });

    const marker = await storage.get(KEYS.ownershipModeMarker());
    expect(marker).not.toBeNull();
  });

  it('propagates a Gate 1 failure (no conditionalBatch) and constructs nothing', async () => {
    const base = new MemoryStorage();
    const noCasStorage: Storage = {
      capabilities: (): StorageCapabilities => ({
        ...base.capabilities(),
        conditionalBatch: false,
      }),
      get: (key) => base.get(key),
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      [Symbol.dispose]: () => base[Symbol.dispose](),
    };

    await expect(
      bootstrapWorkflowLeaseOwnership({
        storage: noCasStorage,
        getNow: () => 0,
        claimTtlMs: TTL_MS,
        claimRenewIntervalMs: RENEW_MS,
      }),
    ).rejects.toThrow(/conditionalBatch/);

    // No marker was stamped — Gate 1 fails before Gate 2 ever touches storage.
    expect(await base.get(KEYS.ownershipModeMarker())).toBeNull();
  });

  it('propagates a Gate 2 mismatch and constructs nothing', async () => {
    using storage = new MemoryStorage();
    await storage.put(
      KEYS.ownershipModeMarker(),
      encodeOwnershipModeMarker({ mode: 'lease', establishedAt: 5 }),
    );

    await expect(
      bootstrapWorkflowLeaseOwnership({
        storage,
        getNow: () => 0,
        claimTtlMs: TTL_MS,
        claimRenewIntervalMs: RENEW_MS,
      }),
    ).rejects.toThrow(OwnershipModeMismatchError);
  });

  it('bridges a "lost" renewal outcome and the registry active-claim count into the metrics recorder', async () => {
    using storage = new MemoryStorage();
    const clock = makeClock();

    const engineA = await bootstrapWorkflowLeaseOwnership({
      storage,
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    await engineA.registry.acquire('wf-1');
    await engineA.registry.acquire('wf-2');
    expect(engineA.metrics.snapshot().activeClaims).toBe(0); // no pass has run yet

    // Simulate engine A stalling past the grace window while a second engine
    // takes over wf-1 — the same cross-registry race
    // `workflow-claim-registry.test.ts` uses for its own takeover coverage.
    clock.advance(TTL_MS * 10);
    const engineB = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-b',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const takeover = await engineB.takeover('wf-1');
    expect(takeover.status).toBe('acquired');

    const pass = await engineA.renewalTask.runOnce();

    expect(pass.outcomes).toEqual(
      expect.arrayContaining([
        { workflowId: 'wf-1', status: 'failed', error: expect.any(Error) },
        { workflowId: 'wf-2', status: 'renewed' },
      ]),
    );
    const snapshot = engineA.metrics.snapshot();
    expect(snapshot.renewalFailures).toBe(1);
    // Engine A's own bookkeeping drops wf-1 once its renewal is confirmed
    // lost, so only wf-2 remains in its held-id count.
    expect(snapshot.activeClaims).toBe(1);
  });
});
