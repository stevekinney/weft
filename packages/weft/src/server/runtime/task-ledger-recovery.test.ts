/**
 * Unit tests for startup task-ledger recovery (WFT-23) — one describe block
 * per non-terminal ledger state, plus corrupt-record and scan-failure
 * handling. End-to-end cross-restart behavior (a real subprocess reboot with
 * live WebSocket workers) is covered separately by
 * `src/worker/remote-worker-reconnection.test.ts`.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCancelling,
  type RemoteTaskCompleting,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskTerminalResolved,
} from '../task-ledger.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { commitTaskLedgerCompletion } from './task-ledger-completion.ts';
import { runTaskLedgerRecovery } from './task-ledger-recovery.ts';

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-queued',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: now,
    firstQueuedAt: now,
    lastQueuedAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-leased',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function completingFixture(overrides: Partial<RemoteTaskCompleting> = {}): RemoteTaskCompleting {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-completing',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 2,
    state: 'completing',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    pendingStatus: 'completed',
    pendingResultDigest: 'placeholder-digest',
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function cancellingFixture(overrides: Partial<RemoteTaskCancelling> = {}): RemoteTaskCancelling {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-cancelling',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 2,
    state: 'cancelling',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    cancellationReason: 'workflow cancelled',
    cancellationRequestedAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function terminalFixture(
  overrides: Partial<RemoteTaskTerminalResolved> = {},
): RemoteTaskTerminalResolved {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-terminal',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 3,
    state: 'terminal',
    disposition: 'resolved',
    attempt: 1,
    attemptToken: 'attempt-token',
    status: 'completed',
    resultDigest: 'digest',
    terminalAt: now,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

describe('runTaskLedgerRecovery — leased', () => {
  it('rehydrates registry ownership, attemptToken, fairShareKey, and the deadline tracker when the lease is still valid', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = leasedFixture({
      operationId: 'op-still-leased',
      workflowId: 'wf-1',
      fairShareKey: 'tenant-a',
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    expect(
      context.registry.isAssignedToAttempt(
        stored.operationId,
        stored.workerSessionId,
        stored.attemptToken,
      ),
    ).toBe(true);
    expect(
      context.registry.isAssignedToAttempt(
        stored.operationId,
        stored.workerSessionId,
        'stale-token',
      ),
    ).toBe(false);
    expect(context.registry.getTask(stored.operationId)?.fairShareKey).toBe('tenant-a');
    expect(context.registry.getTask(stored.operationId)?.visibilityTimeout).toBe(
      stored.visibilityTimeoutMilliseconds,
    );

    const drained = context.deadlineTracker.drainExpired(Number.MAX_SAFE_INTEGER);
    expect(drained.some((entry) => entry.operationId === stored.operationId)).toBe(true);

    expect(context.operationToWorkflow.get(stored.operationId)).toBe('wf-1');
    expect(context.workflowOperations.get('wf-1')?.has(stored.operationId)).toBe(true);
  });

  it('requeues a leased record whose lease already expired instead of restoring it as still-owned', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = leasedFixture({
      operationId: 'op-expired-leased',
      leaseDeadline: Date.now() - 1_000,
      retryPolicy: {
        maxAttempts: 5,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    expect(context.registry.isAssigned(stored.operationId)).toBe(false);
    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(stored.operationId)),
    );
    expect(persisted?.state).toBe('queued');
    expect(persisted?.state === 'queued' && persisted.attempt).toBe(2);
  });

  it('terminalizes an expired leased record with retryExhausted instead of restoring it', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = leasedFixture({
      operationId: 'op-exhausted-leased',
      leaseDeadline: Date.now() - 1_000,
      attempt: 1,
      retryPolicy: {
        maxAttempts: 1,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(stored.operationId)),
    );
    expect(persisted?.state).toBe('terminal');
    expect(persisted?.state === 'terminal' && persisted.disposition).toBe('retryExhausted');
  });
});

describe('runTaskLedgerRecovery — queued', () => {
  it('redispatches a queued record whose availableAt has already elapsed', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = queuedFixture({ operationId: 'op-available-now', availableAt: Date.now() });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    await waitForCondition(() => context.taskQueue.isTracked(stored.operationId), {
      timeoutMs: 1_000,
      intervalMs: 5,
      label: 'recovered queued task to reach the long-poll queue',
    });
  });

  it('schedules but does not immediately dispatch a queued record whose availableAt is in the future', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = queuedFixture({
      operationId: 'op-available-later',
      availableAt: Date.now() + 60_000,
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    expect(context.taskQueue.isTracked(stored.operationId)).toBe(false);
    expect(context.pendingTimers.size).toBeGreaterThan(0);
  });
});

describe('runTaskLedgerRecovery — completing', () => {
  it('rehydrates registry ownership so a redelivered result still authorizes and resumes to terminal', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const digest = await sha256Hex(
      JSON.stringify({ status: 'completed', value: 'done', error: null }),
    );
    const stored = completingFixture({
      operationId: 'op-completing-redelivery',
      pendingStatus: 'completed',
      pendingResultDigest: digest,
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    expect(
      context.registry.isAssignedToAttempt(
        stored.operationId,
        stored.workerSessionId,
        stored.attemptToken,
      ),
    ).toBe(true);
    // A completing record is not a lease-expiry candidate — resolving it is
    // either the worker's redelivered result or WFT-24 dead-letter scope,
    // neither of which the deadline tracker's visibility-timeout scanners
    // handle for non-`leased` states.
    const drained = context.deadlineTracker.drainExpired(Number.MAX_SAFE_INTEGER);
    expect(drained.some((entry) => entry.operationId === stored.operationId)).toBe(false);

    const resumed = await commitTaskLedgerCompletion(options.engine.storage, {
      operationId: stored.operationId,
      attemptToken: stored.attemptToken,
      status: 'completed',
      value: 'done',
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.ok && resumed.terminal.state).toBe('terminal');
  });
});

describe('runTaskLedgerRecovery — cancelling', () => {
  it('rehydrates registry ownership for a cancelling record', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = cancellingFixture({ operationId: 'op-cancelling-recovery' });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    expect(
      context.registry.isAssignedToAttempt(
        stored.operationId,
        stored.workerSessionId,
        stored.attemptToken,
      ),
    ).toBe(true);
  });
});

describe('runTaskLedgerRecovery — terminal and unrecognized records', () => {
  it('skips a terminal record without any registry or queue side effects', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = terminalFixture({ operationId: 'op-already-terminal' });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    expect(context.registry.isAssigned(stored.operationId)).toBe(false);
    expect(context.taskQueue.isTracked(stored.operationId)).toBe(false);
    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(stored.operationId)),
    );
    expect(persisted).toEqual(stored);
  });

  it('logs and skips a corrupt record while still recovering every other record in the scan', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    await options.engine.storage.put(taskLedgerKey('op-corrupt'), new Uint8Array([1, 2, 3, 4]));
    const stored = leasedFixture({ operationId: 'op-after-corrupt' });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    await runTaskLedgerRecovery(context, options);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to recover task ledger record'),
      expect.anything(),
    );
    expect(
      context.registry.isAssignedToAttempt(
        stored.operationId,
        stored.workerSessionId,
        stored.attemptToken,
      ),
    ).toBe(true);
  });
});

describe('runTaskLedgerRecovery — scan failure', () => {
  /**
   * A storage whose `scan` iterator throws partway through — models a
   * genuine scan-level failure (e.g. a storage backend connectivity error),
   * distinct from a single corrupt record. Per the project brief, this must
   * reject the whole recovery gate rather than being logged and swallowed.
   */
  class ScanFailingStorage extends MemoryStorage {
    override async *scan(
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ): AsyncIterable<[string, Uint8Array]> {
      for await (const entry of super.scan(prefix, options)) {
        yield entry;
      }
      throw new Error('simulated storage scan failure');
    }
  }

  it('propagates a genuine scan failure instead of swallowing it', async () => {
    const storage = new ScanFailingStorage();
    const context = minimalServerContext();
    const options = minimalServeOptions(storage);
    const stored = leasedFixture({ operationId: 'op-before-scan-failure' });
    await storage.put(taskLedgerKey(stored.operationId), encodeRemoteTaskRecord(stored));

    await expect(runTaskLedgerRecovery(context, options)).rejects.toThrow(
      'simulated storage scan failure',
    );
  });
});

describe('runTaskLedgerRecovery — shutdown interlock', () => {
  /**
   * A storage whose `scan` sets `context.stopping` right before yielding the
   * second entry — models `server.stop()`'s timer-clearing disposer running
   * while a recovery scan is still in flight between two ledger keys.
   */
  class StoppingMidScanStorage extends MemoryStorage {
    readonly #onSecondEntry: () => void;

    constructor(onSecondEntry: () => void) {
      super();
      this.#onSecondEntry = onSecondEntry;
    }

    override async *scan(
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ): AsyncIterable<[string, Uint8Array]> {
      let index = 0;
      for await (const entry of super.scan(prefix, options)) {
        if (index === 1) this.#onSecondEntry();
        yield entry;
        index += 1;
      }
    }
  }

  it('stops processing further records once context.stopping flips mid-scan', async () => {
    const context = minimalServerContext();
    const storage = new StoppingMidScanStorage(() => {
      context.stopping = true;
    });
    const options = minimalServeOptions(storage);

    const first = queuedFixture({ operationId: 'op-a-first', availableAt: Date.now() });
    const second = queuedFixture({ operationId: 'op-z-second', availableAt: Date.now() });
    await storage.put(taskLedgerKey(first.operationId), encodeRemoteTaskRecord(first));
    await storage.put(taskLedgerKey(second.operationId), encodeRemoteTaskRecord(second));

    await runTaskLedgerRecovery(context, options);

    await waitForCondition(() => context.taskQueue.isTracked(first.operationId), {
      timeoutMs: 1_000,
      intervalMs: 5,
      label: 'the record recovered before shutdown to reach the long-poll queue',
    });
    // The second record was never processed — recovery returned as soon as
    // it saw `context.stopping`, so `scheduleDelayedDispatch` was never
    // reached for it and no timer leaked past the disposer's clear.
    expect(context.taskQueue.isTracked(second.operationId)).toBe(false);
    expect(context.pendingTimers.size).toBe(0);
  });

  it('processes no records when context.stopping is already set before the scan starts', async () => {
    const context = minimalServerContext();
    context.stopping = true;
    const options = minimalServeOptions();
    const stored = queuedFixture({ operationId: 'op-already-stopping', availableAt: Date.now() });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await runTaskLedgerRecovery(context, options);

    expect(context.taskQueue.isTracked(stored.operationId)).toBe(false);
    expect(context.pendingTimers.size).toBe(0);
  });
});
