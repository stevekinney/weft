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
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { OwnershipModeMismatchError } from './lease-errors.ts';
import type { OwnerSideSignalPollTarget } from './owner-side-signal-poll.ts';
import {
  bootstrapWorkflowLeaseOwnership,
  buildOwnerSideSignalPollTarget,
  createWorkflowClaimReclaimTarget,
  createWorkflowClaimRenewalTarget,
  type OwnerSideSignalPollSources,
  WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS,
} from './ownership-bootstrap.ts';
import {
  encodeEpoch,
  encodeOwnershipModeMarker,
  encodeWorkflowClaimHolder,
} from './workflow-claim-codec.ts';
import { WorkflowClaimMetricsCollector } from './workflow-claim-metrics.ts';
import type { WorkflowClaimRenewResult } from './workflow-claim-registry.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';
import { createWorkflowClaimTestStorage } from './workflow-claim.test-support.ts';

const TTL_MS = 30_000;
const RENEW_MS = 5_000;

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: null,
    startedAt: 1_000,
    status: 'running',
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

async function putWorkflowState(
  storage: Storage,
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): Promise<void> {
  await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId, overrides)));
}

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

  it('threads a provided signalPollTarget straight into the renewal task', async () => {
    using storage = new MemoryStorage();
    const clock = makeClock();
    const signalPollTarget: OwnerSideSignalPollTarget = {
      listParkedSignalWaits: () => [],
      hasBufferedSignal: async () => false,
      wakeWorkflow: async () => {},
    };

    const result = await bootstrapWorkflowLeaseOwnership({
      storage,
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
      signalPollTarget,
    });
    const pass = await result.renewalTask.runOnce();

    expect(pass.signalPoll).toEqual({
      status: 'completed',
      result: {
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
        outcomes: [],
        wokenCount: 0,
      },
    });
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

async function putHolder(storage: Storage, workflowId: string, engineId: string): Promise<void> {
  await storage.put(
    KEYS.workflowOwnerHolder(workflowId),
    encodeWorkflowClaimHolder({ engineId, epoch: 1, expiresAt: 1_000, claimedAt: 500 }),
  );
  await storage.put(KEYS.workflowOwnerEpoch(workflowId), encodeEpoch(1));
}

describe('createWorkflowClaimReclaimTarget · ownerless running workflows', () => {
  it('records lost_race when a competitor claims an ownerless workflow mid-acquire', async () => {
    const base = new MemoryStorage();
    await putWorkflowState(base, 'wf-ownerless');
    const gated = createWorkflowClaimTestStorage(base);
    const metrics = new WorkflowClaimMetricsCollector();
    const registry = new WorkflowClaimRegistry({
      storage: gated.storage,
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const competitor = new WorkflowClaimRegistry({
      storage: base,
      engineId: 'engine-b',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });

    // The workflow is running with no holder at all, so takeover reports
    // 'no-claim' and this engine falls through to a plain acquire. A competitor
    // claims it in the window before that acquire commits, so the CAS loses.
    // That is contention, not a storage fault, and must be counted as such.
    gated.queueBeforeCommit(async () => {
      await competitor.acquire('wf-ownerless');
    });

    const reclaimTarget = createWorkflowClaimReclaimTarget(registry, gated.storage, metrics);
    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-ownerless');

    expect(metrics.snapshot().attempts.lost_race).toBeGreaterThan(0);
    expect(registry.currentEpoch('wf-ownerless')).toBeNull();
    // The competitor now holds a live claim, so the retry sees it as unexpired.
    expect(result).toEqual({ status: 'not-eligible' });
  });

  it('records acquired when it claims an ownerless running workflow', async () => {
    const storage = new MemoryStorage();
    await putWorkflowState(storage, 'wf-free');
    const metrics = new WorkflowClaimMetricsCollector();
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const driven: string[] = [];
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      metrics,
      async (workflowId: string) => {
        driven.push(workflowId);
      },
    );

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-free');

    expect(result).toEqual({ status: 'reclaimed' });
    expect(metrics.snapshot().attempts.acquired).toBe(1);
    expect(driven).toEqual(['wf-free']);
  });

  it('treats an undecodable workflow record as not-running rather than throwing', async () => {
    const storage = new MemoryStorage();
    // Corrupt bytes where a workflow state should be: the status read must fail
    // closed to "not running" so a garbage record never gets handed a claim.
    await storage.put(KEYS.workflow('wf-corrupt'), new Uint8Array([0xff, 0xfe, 0x00]));
    const metrics = new WorkflowClaimMetricsCollector();
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(registry, storage, metrics);

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-corrupt');

    expect(result).toEqual({ status: 'not-eligible' });
    expect(registry.currentEpoch('wf-corrupt')).toBeNull();
  });
});

describe('createWorkflowClaimReclaimTarget', () => {
  it('excludes ids this engine already holds from the candidate list', async () => {
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-foreign', 'engine-b');
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    await registry.acquire('wf-mine');
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
    );

    const candidates = await reclaimTarget.listReclaimCandidateWorkflowIds();

    expect(candidates).toEqual(['wf-foreign']);
  });

  it('maps a successful takeover to "reclaimed" without recording backoff_skipped', async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1', 'engine-b');
    clock.advance(TTL_MS * 10); // far past any grace-adjusted expiry
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const metrics = new WorkflowClaimMetricsCollector();
    const reclaimTarget = createWorkflowClaimReclaimTarget(registry, storage, metrics);

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');

    expect(result).toEqual({ status: 'reclaimed' });
    expect(registry.currentEpoch('wf-1')).not.toBeNull();
    expect(metrics.snapshot().attempts.backoff_skipped).toBe(0);
  });

  it('maps a live (not-expired) holder to "not-eligible" without retrying', async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.workflowOwnerHolder('wf-1'),
      encodeWorkflowClaimHolder({
        engineId: 'engine-b',
        epoch: 1,
        expiresAt: clock.now() + TTL_MS,
        claimedAt: clock.now(),
      }),
    );
    await storage.put(KEYS.workflowOwnerEpoch('wf-1'), encodeEpoch(1));
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
    );

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');

    expect(result).toEqual({ status: 'not-eligible' });
  });

  it('maps an absent claim to "not-eligible"', async () => {
    const storage = new MemoryStorage();
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
    );

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-never-claimed');

    expect(result).toEqual({ status: 'not-eligible' });
  });

  it(`retries a lost-race CAS up to ${WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS} attempts and then gives up`, async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1', 'engine-b');
    clock.advance(TTL_MS * 10);
    const gated = createWorkflowClaimTestStorage(storage);
    for (let attempt = 0; attempt < WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS; attempt += 1) {
      gated.queueForceFalse();
    }
    const registry = new WorkflowClaimRegistry({
      storage: gated.storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      gated.storage,
      new WorkflowClaimMetricsCollector(),
    );

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');

    expect(result).toEqual({ status: 'lost-race' });
    expect(registry.currentEpoch('wf-1')).toBeNull();
  });

  it(`succeeds on the ${WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS}th attempt, proving the bound is inclusive`, async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1', 'engine-b');
    clock.advance(TTL_MS * 10);
    const gated = createWorkflowClaimTestStorage(storage);
    for (let attempt = 0; attempt < WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS - 1; attempt += 1) {
      gated.queueForceFalse();
    }
    const registry = new WorkflowClaimRegistry({
      storage: gated.storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      gated.storage,
      new WorkflowClaimMetricsCollector(),
    );

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');

    expect(result).toEqual({ status: 'reclaimed' });
  });

  it('a backoff-skipped result short-circuits the retry loop and records the metric', async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    const gated = createWorkflowClaimTestStorage(storage);
    const registry = new WorkflowClaimRegistry({
      storage: gated.storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    await registry.acquire('wf-1');
    gated.queueForceFalse();
    expect(await registry.renew('wf-1')).toEqual({ status: 'lost', workflowId: 'wf-1' }); // starts the cooldown
    const metrics = new WorkflowClaimMetricsCollector();
    const reclaimTarget = createWorkflowClaimReclaimTarget(registry, gated.storage, metrics);

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');

    expect(result).toEqual({ status: 'backoff-skipped' });
    expect(metrics.snapshot().attempts.backoff_skipped).toBe(1);
  });
});

describe('bootstrapWorkflowLeaseOwnership · reclaim scan (end-to-end)', () => {
  it('reclaims an expired stranded claim and skips a still-live one, via renewalTask.runOnce()', async () => {
    using storage = new MemoryStorage();
    const clock = makeClock();

    const crashed = await bootstrapWorkflowLeaseOwnership({
      storage,
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    await crashed.registry.acquire('wf-stranded');
    // A second, still-healthy claim on the same crashed engine's storage,
    // freshly re-stamped as live right before the successor's pass runs.
    await putHolder(storage, 'wf-live', 'engine-still-healthy');

    // The crashed engine never renews again; a successor bootstraps fresh
    // against the same store and, after enough time passes, its reclaim scan
    // should take over the stranded claim while leaving the live one alone.
    clock.advance(TTL_MS * 10);
    await storage.put(
      KEYS.workflowOwnerHolder('wf-live'),
      encodeWorkflowClaimHolder({
        engineId: 'engine-still-healthy',
        epoch: 1,
        expiresAt: clock.now() + TTL_MS,
        claimedAt: clock.now(),
      }),
    );
    const successor = await bootstrapWorkflowLeaseOwnership({
      storage,
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });

    const pass = await successor.renewalTask.runOnce();

    expect(pass.reclaim).toMatchObject({
      status: 'completed',
      outcomes: expect.arrayContaining([
        { workflowId: 'wf-stranded', status: 'reclaimed' },
        { workflowId: 'wf-live', status: 'not-eligible' },
      ]),
    });
    expect(successor.registry.currentEpoch('wf-stranded')).not.toBeNull();
    expect(successor.registry.currentEpoch('wf-live')).toBeNull();
  });
});

describe('createWorkflowClaimReclaimTarget · redrive retry on a failed onReclaimed drive (WFT-79 Finding 2)', () => {
  it('keeps a failed drive pending and retries it directly (no takeover CAS) on a later attempt', async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1', 'engine-b');
    await putWorkflowState(storage, 'wf-1');
    clock.advance(TTL_MS * 10);
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    let driveCalls = 0;
    let shouldFail = true;
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
      async () => {
        driveCalls += 1;
        if (shouldFail) throw new Error('drive failed');
      },
    );

    // First pass: takeover succeeds, drive throws. The claim IS held (durable
    // ownership moved); the error is rethrown rather than swallowed.
    await expect(reclaimTarget.attemptWorkflowClaimTakeover('wf-1')).rejects.toThrow(
      'drive failed',
    );
    expect(driveCalls).toBe(1);
    expect(registry.currentEpoch('wf-1')).not.toBeNull();

    // The failed drive is excluded from the ordinary holder-keyed scan (this
    // engine now holds wf-1's only holder record), but IS included via the
    // pending-redrive set — proving the bug this finding closes: without it,
    // this id would never appear as a candidate again.
    const candidates = await reclaimTarget.listReclaimCandidateWorkflowIds();
    expect(candidates).toContain('wf-1');

    // A later pass retries the drive directly — no takeover attempted (the
    // claim is already held, and the workflow is still `running`).
    shouldFail = false;
    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');
    expect(result).toEqual({ status: 'reclaimed' });
    expect(driveCalls).toBe(2);
    expect(registry.currentEpoch('wf-1')).not.toBeNull();

    // Now that the drive succeeded, it drops out of the pending-redrive set.
    const candidatesAfter = await reclaimTarget.listReclaimCandidateWorkflowIds();
    expect(candidatesAfter).not.toContain('wf-1');
  });

  it('releases the claim (instead of renewing it forever) when the workflow reached a terminal state while its redrive was pending', async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1', 'engine-b');
    await putWorkflowState(storage, 'wf-1');
    clock.advance(TTL_MS * 10);
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
      async () => {
        throw new Error('drive failed');
      },
    );
    await expect(reclaimTarget.attemptWorkflowClaimTakeover('wf-1')).rejects.toThrow();
    expect(registry.currentEpoch('wf-1')).not.toBeNull();

    // The workflow reaches a terminal state (e.g. an external cancel landed
    // on it) while the redrive is still pending.
    await putWorkflowState(storage, 'wf-1', { status: 'completed' });

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');

    expect(result).toEqual({ status: 'not-eligible' });
    // The now-moot claim was released rather than renewed indefinitely.
    expect(registry.currentEpoch('wf-1')).toBeNull();
    const candidates = await reclaimTarget.listReclaimCandidateWorkflowIds();
    expect(candidates).not.toContain('wf-1');
  });

  it('falls through to the ordinary takeover path instead of forcing a redrive once this engine no longer holds the claim', async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1', 'engine-b');
    await putWorkflowState(storage, 'wf-1');
    clock.advance(TTL_MS * 10);
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
      async () => {
        throw new Error('drive failed');
      },
    );
    await expect(reclaimTarget.attemptWorkflowClaimTakeover('wf-1')).rejects.toThrow();
    expect(registry.currentEpoch('wf-1')).not.toBeNull(); // marked pending-redrive

    // A third engine takes the claim over (e.g. this engine's own renewal
    // stalled and it lost the race), and this engine's registry reconciles
    // that loss the same way an ordinary failed renewal would.
    const competitor = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-c',
      getNow: () => clock.now() + TTL_MS * 10,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const competitorTakeover = await competitor.takeover('wf-1');
    expect(competitorTakeover.status).toBe('acquired');
    expect(await registry.renew('wf-1')).toEqual({ status: 'lost', workflowId: 'wf-1' });
    expect(registry.currentEpoch('wf-1')).toBeNull();

    // The next attempt falls through to the ordinary takeover path (this
    // engine no longer holds anything to redrive) rather than forcing a
    // redrive against a claim it does not have — the losing `renew()` above
    // started this engine's own anti-thrash cooldown for `wf-1`, so the
    // takeover attempt is suppressed as `backoff-skipped`. Either that or a
    // `not-expired` holder read proves the same thing: the ordinary path ran
    // instead of forcing a redrive, which would have thrown the callback's
    // error rather than resolving.
    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-1');
    expect(result).toEqual({ status: 'backoff-skipped' });
  });
});

describe('createWorkflowClaimReclaimTarget · ownerless-but-running acquire fallback (WFT-79 Finding 3)', () => {
  it('acquires (not takeover) a running workflow with no holder record at all, then drives it', async () => {
    const clock = makeClock();
    const storage = new MemoryStorage();
    await putWorkflowState(storage, 'wf-ownerless'); // running; no holder/epoch key exists yet.
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: clock.now,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const driven: string[] = [];
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
      async (workflowId) => {
        driven.push(workflowId);
      },
    );

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-ownerless');

    expect(result).toEqual({ status: 'reclaimed' });
    expect(driven).toEqual(['wf-ownerless']);
    expect(registry.currentEpoch('wf-ownerless')).toBe(1);
    expect(await storage.get(KEYS.workflowOwnerHolder('wf-ownerless'))).not.toBeNull();
  });

  it('does not acquire a "no-claim" candidate that has already reached a terminal state', async () => {
    const storage = new MemoryStorage();
    await putWorkflowState(storage, 'wf-done', { status: 'completed' });
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: () => 0,
      claimTtlMs: TTL_MS,
      claimRenewIntervalMs: RENEW_MS,
    });
    const reclaimTarget = createWorkflowClaimReclaimTarget(
      registry,
      storage,
      new WorkflowClaimMetricsCollector(),
    );

    const result = await reclaimTarget.attemptWorkflowClaimTakeover('wf-done');

    expect(result).toEqual({ status: 'not-eligible' });
    expect(registry.currentEpoch('wf-done')).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder('wf-done'))).toBeNull();
  });
});

describe('buildOwnerSideSignalPollTarget (WFT-79 Finding 1)', () => {
  function makeSources(overrides: Partial<OwnerSideSignalPollSources> = {}): {
    sources: OwnerSideSignalPollSources;
    resumed: string[];
    woken: Array<{ workflowId: string; waiterKey: string }>;
  } {
    const resumed: string[] = [];
    const woken: Array<{ workflowId: string; waiterKey: string }> = [];
    const sources: OwnerSideSignalPollSources = {
      listParkedInlineWorkflowIds: () => [],
      isParkedInlineWorkflow: () => false,
      parkedSignalName: () => undefined,
      listSignalWaiterEntries: () => [],
      hasBufferedSignal: async () => false,
      resumeParkedInlineWorkflow: async (workflowId) => {
        resumed.push(workflowId);
      },
      wakeSignalWaiter: (workflowId, waiterKey) => {
        woken.push({ workflowId, waiterKey });
      },
      ...overrides,
    };
    return { sources, resumed, woken };
  }

  it('lists checkpoint-parked wait-signal entries, skipping a parked id with no wait-signal pending', () => {
    const { sources } = makeSources({
      listParkedInlineWorkflowIds: () => ['wf-parked', 'wf-other-op'],
      parkedSignalName: (workflowId) => (workflowId === 'wf-parked' ? 'go' : undefined),
    });

    const target = buildOwnerSideSignalPollTarget(sources);

    expect(target.listParkedSignalWaits()).toEqual([{ workflowId: 'wf-parked', signalName: 'go' }]);
  });

  it('lists live signal-waiter entries, splitting the waiterKey on the exact known workflowId prefix', () => {
    const { sources } = makeSources({
      listSignalWaiterEntries: () => [['wf-race', 'wf-race:approve']],
    });

    const target = buildOwnerSideSignalPollTarget(sources);

    expect(target.listParkedSignalWaits()).toEqual([
      { workflowId: 'wf-race', signalName: 'approve' },
    ]);
  });

  it('wakeWorkflow resumes a checkpoint-parked workflow via resumeParkedInlineWorkflow', async () => {
    const { sources, resumed } = makeSources({
      isParkedInlineWorkflow: (workflowId) => workflowId === 'wf-parked',
    });
    const target = buildOwnerSideSignalPollTarget(sources);

    await target.wakeWorkflow('wf-parked');

    expect(resumed).toEqual(['wf-parked']);
  });

  it('wakeWorkflow wakes only the CONFIRMED-buffered waiter among multiple race branches for the same workflow — never a sibling whose signal never arrived', async () => {
    const { sources, woken } = makeSources({
      listSignalWaiterEntries: () => [
        ['wf-race', 'wf-race:approve'],
        ['wf-race', 'wf-race:reject'],
      ],
      hasBufferedSignal: async (workflowId, signalName) =>
        workflowId === 'wf-race' && signalName === 'approve',
    });
    const target = buildOwnerSideSignalPollTarget(sources);

    await target.wakeWorkflow('wf-race');

    expect(woken).toEqual([{ workflowId: 'wf-race', waiterKey: 'wf-race:approve' }]);
  });

  it('wakeWorkflow is a no-op when nothing about the workflow is currently parked or waiting', async () => {
    const { sources, resumed, woken } = makeSources();
    const target = buildOwnerSideSignalPollTarget(sources);

    await target.wakeWorkflow('wf-unknown');

    expect(resumed).toEqual([]);
    expect(woken).toEqual([]);
  });
});
