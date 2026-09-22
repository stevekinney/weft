/**
 * COR-230 ("Session and Attempt Lease Model") — the three independent
 * clocks, and the fresh `WorkerSessionIdentity` / `ActivityAttemptLease`
 * surface.
 *
 * This file proves the pure, storage-agnostic parts of the model:
 *
 *   - `claimQueued` establishes both the heartbeat-renewable
 *     `leaseDeadline` and the heartbeat-immune `attemptDeadline` at claim
 *     time (criterion 6).
 *   - `renewAttemptLease` never shortens the lease under out-of-order
 *     delivery, and never extends it past the attempt's absolute deadline
 *     (criteria 4 and 6).
 *   - `renewAttemptLease` cannot resurrect an attempt that has moved on to
 *     `completing`, `cancelling`, or terminal (criterion 3/4).
 *   - `WorkerSessionIdentity` (`worker/registry/types.ts`) is a distinct
 *     surface from `ActivityAttemptLease` (`task-ledger-types.ts`) — a
 *     worker's session generation increments independently of any attempt
 *     it may be holding.
 *   - A worker session removed from the registry is immediately ineligible
 *     for routing, which is the structural guarantee
 *     `runWorkerDisconnectRequeue` (`authentication-bridge.ts`) relies on to
 *     satisfy "session expiry removes the worker from routing before task
 *     takeover" (criterion 7).
 *   - Startup recovery rehydrating an in-flight attempt's ownership never
 *     fabricates a live worker session for the recovering process
 *     (criterion 8) — `WorkerRegistry.assignTask()` alone does not create a
 *     `WorkerInfo`/`WorkerSessionIdentity` entry.
 *
 * `task-heartbeat.test.ts` covers the wire-level split (bare `heartbeat` vs
 * `activityHeartbeat`) through the real message handler; this file covers
 * the ledger and registry primitives underneath it.
 */

import { describe, expect, it } from 'bun:test';

import {
  ATTEMPT_DEADLINE_MULTIPLIER,
  claimQueued,
  createQueued,
  renewAttemptLease,
  type CreateQueuedInput,
} from '../core/task-ledger/task-ledger-transitions.ts';
import {
  activityAttemptLeaseFromRecord,
  type ActivityAttemptLease,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
} from '../core/task-ledger/task-ledger-types.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
} from '../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../worker/registry.ts';

const BASE_QUEUED_INPUT: CreateQueuedInput = {
  recordVersion: 1,
  operationId: 'op-lease',
  workflowType: 'test',
  activityName: 'charge',
  queue: 'default',
  input: null,
  headers: {},
  visibilityTimeoutMilliseconds: 10_000,
  createdAt: 0,
};

function freshQueued(now: number, overrides: Partial<CreateQueuedInput> = {}): RemoteTaskQueued {
  const created = createQueued(null, { ...BASE_QUEUED_INPUT, ...overrides }, now);
  if (!created.ok) throw new Error(`Expected createQueued to succeed: ${created.reason}`);
  return created.nextRecord;
}

function claim(
  queued: RemoteTaskQueued,
  now: number,
  overrides: Partial<Parameters<typeof claimQueued>[1]> = {},
): RemoteTaskLeased {
  const claimed = claimQueued(
    queued,
    {
      expectedGeneration: queued.generation,
      attemptToken: 'attempt-1',
      workerSessionId: 'worker-1',
      leaseDurationMilliseconds: queued.visibilityTimeoutMilliseconds,
      ...overrides,
    },
    now,
  );
  if (!claimed.ok) throw new Error(`Expected claimQueued to succeed: ${claimed.reason}`);
  return claimed.nextRecord;
}

describe('Three independent clocks (COR-230)', () => {
  it('claimQueued establishes leaseDeadline and a distinct, wider attemptDeadline (criterion 6)', () => {
    const now = 1_000_000;
    const queued = freshQueued(now);
    const leased = claim(queued, now);

    expect(leased.leaseDeadline).toBe(now + leased.visibilityTimeoutMilliseconds);
    expect(leased.attemptDeadline).toBe(
      now + ATTEMPT_DEADLINE_MULTIPLIER * leased.visibilityTimeoutMilliseconds,
    );
    // The absolute deadline must never be tighter than a single lease
    // window, or the very first claim would already be capped.
    expect(leased.attemptDeadline!).toBeGreaterThan(leased.leaseDeadline);
  });

  it('renewAttemptLease extends leaseDeadline on each heartbeat, up to attemptDeadline, and then plateaus (criterion 6)', () => {
    const now = 1_000_000;
    const queued = freshQueued(now, { visibilityTimeoutMilliseconds: 1_000 });
    let leased = claim(queued, now);
    const attemptDeadline = leased.attemptDeadline!;

    // Heartbeat repeatedly, well past the point the naive `now +
    // leaseDurationMilliseconds` computation would exceed attemptDeadline.
    let tick = now;
    for (let i = 0; i < ATTEMPT_DEADLINE_MULTIPLIER + 4; i++) {
      tick += 1_000;
      const renewed = renewAttemptLease(
        leased,
        {
          attemptToken: 'attempt-1',
          workerSessionId: 'worker-1',
          leaseDurationMilliseconds: 1_000,
        },
        tick,
      );
      if (!renewed.ok) throw new Error(`Expected renewal to succeed: ${renewed.reason}`);
      leased = renewed.nextRecord;
      expect(leased.leaseDeadline).toBeLessThanOrEqual(attemptDeadline);
    }

    // After enough heartbeats to have run well past the absolute deadline,
    // the lease has plateaued exactly at it — heartbeats cannot extend
    // further.
    expect(leased.leaseDeadline).toBe(attemptDeadline);
    expect(leased.attemptDeadline).toBe(attemptDeadline);
  });

  it('renewAttemptLease never shortens the lease under out-of-order delivery (criterion 4)', () => {
    const now = 1_000_000;
    const queued = freshQueued(now, { visibilityTimeoutMilliseconds: 10_000 });
    const leased = claim(queued, now);

    // A newer heartbeat (larger `now`) commits first.
    const newer = renewAttemptLease(
      leased,
      { attemptToken: 'attempt-1', workerSessionId: 'worker-1', leaseDurationMilliseconds: 10_000 },
      now + 5_000,
    );
    if (!newer.ok) throw new Error('Expected newer renewal to succeed');

    // An OLDER heartbeat (smaller `now`), reordered by a retry or a slow
    // write, is applied against the record the newer one already produced.
    const stale = renewAttemptLease(
      newer.nextRecord,
      { attemptToken: 'attempt-1', workerSessionId: 'worker-1', leaseDurationMilliseconds: 10_000 },
      now + 1_000,
    );
    if (!stale.ok) throw new Error('Expected stale renewal to still succeed (never rejected)');

    // The lease must not have moved backward.
    expect(stale.nextRecord.leaseDeadline).toBe(newer.nextRecord.leaseDeadline);
    expect(stale.nextRecord.leaseDeadline).toBeGreaterThanOrEqual(leased.leaseDeadline);
  });

  it('renewAttemptLease cannot resurrect an attempt that has moved to a different attempt token (stale attempt, criterion 3)', () => {
    const now = 1_000_000;
    const queued = freshQueued(now);
    const leased = claim(queued, now);

    // A DIFFERENT attempt token (the record was reassigned to a new attempt
    // under the same operationId) must be rejected, not silently renewed.
    const result = renewAttemptLease(
      leased,
      {
        attemptToken: 'stale-attempt',
        workerSessionId: 'worker-1',
        leaseDurationMilliseconds: 10_000,
      },
      now + 1_000,
    );
    expect(result).toEqual({ ok: false, reason: 'attempt token or worker session mismatch' });
  });

  it('renewAttemptLease rejects a renewal once the record has left the leased state entirely (completing)', () => {
    const now = 1_000_000;
    const queued = freshQueued(now);
    const leased = claim(queued, now);
    const completing = {
      ...leased,
      state: 'completing' as const,
      pendingStatus: 'completed' as const,
      pendingResultDigest: 'digest',
    };

    const result = renewAttemptLease(
      completing,
      { attemptToken: 'attempt-1', workerSessionId: 'worker-1', leaseDurationMilliseconds: 10_000 },
      now + 1_000,
    );
    expect(result).toEqual({ ok: false, reason: 'expected task state "leased"' });
  });

  it('activityAttemptLeaseFromRecord projects only a live leased attempt, distinct from WorkerSessionIdentity', () => {
    const now = 1_000_000;
    const queued = freshQueued(now);
    const leased = claim(queued, now);

    const view: ActivityAttemptLease | undefined = activityAttemptLeaseFromRecord(leased);
    expect(view).toEqual({
      operationId: 'op-lease',
      attemptToken: 'attempt-1',
      workerSessionId: 'worker-1',
      leaseDeadline: leased.leaseDeadline,
      attemptDeadline: leased.attemptDeadline!,
    });

    // Not a leased record: queued, terminal, etc. — no live attempt to view.
    expect(activityAttemptLeaseFromRecord(queued)).toBeUndefined();
    expect(activityAttemptLeaseFromRecord(null)).toBeUndefined();
  });
});

describe('WorkerSessionIdentity (COR-230) — a session clock, distinct from the attempt clock', () => {
  function register(registry: WorkerRegistry, workerId: string): void {
    registry.register({
      id: workerId,
      queue: 'default',
      activities: ['test.charge'],
      concurrency: 5,
      manifest: manifestForActivities(['test.charge']),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    });
  }

  it('increments sessionGeneration on every accepted registration, including a reconnect under the same workerId', () => {
    const registry = new WorkerRegistry();
    expect(registry.sessionIdentity('worker-1')).toBeUndefined();

    register(registry, 'worker-1');
    expect(registry.sessionIdentity('worker-1')).toEqual({
      workerId: 'worker-1',
      sessionGeneration: 1,
      manifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      transport: 'websocket',
    });

    // A second registration for the SAME workerId — a reconnect — is a NEW
    // session, generation 2, even though nothing else about the worker
    // changed.
    register(registry, 'worker-1');
    expect(registry.sessionIdentity('worker-1')?.sessionGeneration).toBe(2);
  });

  it('a proven resume (matching resumingSessionGeneration) leaves sessionGeneration unchanged and preserves inFlight (COR-220)', () => {
    const registry = new WorkerRegistry();
    register(registry, 'worker-1');
    registry.assignTask('worker-1', 'op-retained', 30_000, undefined, 'attempt-retained');
    expect(registry.sessionIdentity('worker-1')?.sessionGeneration).toBe(1);
    expect(registry.getWorker('worker-1')?.inFlight).toBe(1);

    // Re-register echoing the CURRENT generation — a proven resume.
    registry.register(
      {
        id: 'worker-1',
        queue: 'default',
        activities: ['test.charge'],
        concurrency: 5,
        manifest: manifestForActivities(['test.charge']),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      },
      1,
    );

    expect(registry.sessionIdentity('worker-1')?.sessionGeneration).toBe(1);
    // The in-flight attempt tracked before the reconnect is still counted —
    // nothing was reclaimed.
    expect(registry.getWorker('worker-1')?.inFlight).toBe(1);
    expect(registry.isAssignedToAttempt('op-retained', 'worker-1', 'attempt-retained')).toBe(true);
  });

  it('an unproven resume (mismatched or missing resumingSessionGeneration) always bumps sessionGeneration', () => {
    const registry = new WorkerRegistry();
    register(registry, 'worker-1');
    expect(registry.sessionIdentity('worker-1')?.sessionGeneration).toBe(1);

    // A stale echo — names a generation that is no longer current.
    registry.register(
      {
        id: 'worker-1',
        queue: 'default',
        activities: ['test.charge'],
        concurrency: 5,
        manifest: manifestForActivities(['test.charge']),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      },
      99,
    );
    expect(registry.sessionIdentity('worker-1')?.sessionGeneration).toBe(2);

    // No echo at all — an ordinary fresh/unproven registration.
    register(registry, 'worker-1');
    expect(registry.sessionIdentity('worker-1')?.sessionGeneration).toBe(3);
  });

  it('a session heartbeat renews only WorkerRegistry.lastHeartbeat — never sessionGeneration, never any attempt lease', () => {
    const registry = new WorkerRegistry();
    register(registry, 'worker-1');
    const before = registry.sessionIdentity('worker-1');

    registry.heartbeat('worker-1');

    expect(registry.sessionIdentity('worker-1')).toEqual(before);
  });

  it('a session removed from the registry is immediately ineligible for routing (criterion 7)', () => {
    const registry = new WorkerRegistry();
    register(registry, 'worker-1');
    registry.assignTask('worker-1', 'op-in-flight', 30_000, undefined, 'attempt-1');

    expect(registry.findWorker('test.charge')).toBeDefined();

    // `runWorkerDisconnectRequeue` (authentication-bridge.ts) calls
    // `unregister()` synchronously, BEFORE the async reassignment loop that
    // requeues this worker's in-flight tasks even begins its first await —
    // this is the structural guarantee that makes that ordering correct.
    registry.unregister('worker-1');

    expect(registry.findWorker('test.charge')).toBeUndefined();
    expect(registry.sessionIdentity('worker-1')).toBeUndefined();
    // The in-flight tracking used to reassign the task is unaffected by the
    // session's removal — reassignment reads the ledger, not the registry,
    // for task details; only routing eligibility (this assertion) and the
    // in-flight map itself are registry-owned.
    expect(registry.isAssigned('op-in-flight')).toBe(false);
  });

  it('rehydrating in-flight ownership during recovery never fabricates a live worker session (criterion 8)', () => {
    const registry = new WorkerRegistry();

    // This mirrors exactly what `task-ledger-recovery.ts`'s
    // `rehydrateWorkerOwnership` does for a `leased`/`completing`/`cancelling`
    // record recovered from storage after a restart: it calls `assignTask`
    // directly, keyed by the record's persisted `workerSessionId`. It never
    // calls `register()` — only the worker process itself, by reconnecting
    // and sending a fresh `register` message, can do that.
    registry.assignTask('recovered-worker-session', 'op-recovered', 30_000, undefined, 'attempt-1');

    // The in-flight assignment is tracked...
    expect(registry.isAssigned('op-recovered')).toBe(true);
    expect(registry.getTask('op-recovered')?.workerId).toBe('recovered-worker-session');

    // ...but no live session exists for that workerId, and it is therefore
    // not routing-eligible for new work — recovery restores enough state to
    // recognize a reconnecting worker's messages, but never impersonates a
    // live connection that does not exist.
    expect(registry.getWorker('recovered-worker-session')).toBeUndefined();
    expect(registry.sessionIdentity('recovered-worker-session')).toBeUndefined();
    expect(registry.findWorker('test.charge')).toBeUndefined();
  });
});
