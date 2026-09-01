import { describe, expect, it } from 'bun:test';

import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCancelling,
  type RemoteTaskCompleting,
  type RemoteTaskDeadLettered,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskTerminalCancelled,
  type RemoteTaskTerminalResolved,
  type RemoteTaskTerminalRetryExhausted,
} from '../task-ledger.ts';
import { minimalServeOptions } from './server-context.test-support.ts';
import { adoptTaskResultImpl, getTaskResultViewImpl } from './task-result-view.ts';

function baseFields() {
  return {
    recordVersion: 1 as const,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
  };
}

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  return {
    ...baseFields(),
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: 0,
    firstQueuedAt: 0,
    lastQueuedAt: 0,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  return {
    ...baseFields(),
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-1',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: 30_000,
    firstQueuedAt: 0,
    lastQueuedAt: 0,
    startedAt: 0,
    lastHeartbeatAt: 0,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function completingFixture(overrides: Partial<RemoteTaskCompleting> = {}): RemoteTaskCompleting {
  const { state: _state, ...leased } = leasedFixture();
  return {
    ...leased,
    generation: 2,
    state: 'completing',
    pendingStatus: 'completed',
    pendingResultDigest: 'digest-1',
    ...overrides,
  };
}

function cancellingFixture(overrides: Partial<RemoteTaskCancelling> = {}): RemoteTaskCancelling {
  const { state: _state, ...leased } = leasedFixture();
  return {
    ...leased,
    generation: 2,
    state: 'cancelling',
    cancellationReason: 'user requested',
    cancellationRequestedAt: 3_000,
    ...overrides,
  };
}

function resolvedFixture(
  overrides: Partial<RemoteTaskTerminalResolved> = {},
): RemoteTaskTerminalResolved {
  return {
    ...baseFields(),
    generation: 3,
    state: 'terminal',
    disposition: 'resolved',
    attempt: 1,
    attemptToken: 'attempt-1',
    status: 'completed',
    resultDigest: 'digest-1',
    terminalAt: 4_000,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

function cancelledFixture(
  overrides: Partial<RemoteTaskTerminalCancelled> = {},
): RemoteTaskTerminalCancelled {
  return {
    ...baseFields(),
    generation: 3,
    state: 'terminal',
    disposition: 'cancelled',
    attempt: 1,
    cancellationReason: 'user requested',
    resultDigest: 'cancelled:op-1:0',
    terminalAt: 4_000,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

function retryExhaustedFixture(
  overrides: Partial<RemoteTaskTerminalRetryExhausted> = {},
): RemoteTaskTerminalRetryExhausted {
  return {
    ...baseFields(),
    generation: 3,
    state: 'terminal',
    disposition: 'retryExhausted',
    attempt: 3,
    attemptToken: 'attempt-secret-retry-exhausted',
    error: 'Activity exhausted all 3 retry attempts',
    resultDigest: 'retry-exhausted:op-1:attempt-secret-retry-exhausted',
    terminalAt: 4_000,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

function deadLetteredFixture(
  overrides: Partial<RemoteTaskDeadLettered> = {},
): RemoteTaskDeadLettered {
  return {
    ...baseFields(),
    generation: 3,
    state: 'deadLettered',
    attemptToken: 'attempt-1',
    attempt: 1,
    pendingStatus: 'completed',
    pendingResultDigest: 'digest-1',
    retryCount: 0,
    requeueCount: 0,
    deadLetteredAt: 4_000,
    persistenceFailureReason: 'lost the compare-and-swap race',
    ...overrides,
  };
}

describe('getTaskResultViewImpl', () => {
  it('returns null when no record exists', async () => {
    const options = minimalServeOptions();
    expect(await getTaskResultViewImpl(options.engine.storage, 'never-dispatched')).toBeNull();
  });

  it.each([
    ['queued', queuedFixture()],
    ['leased', leasedFixture()],
    ['completing', completingFixture()],
    ['cancelling', cancellingFixture()],
  ] as const)('reports state %s as pending', async (state, record) => {
    const options = minimalServeOptions();
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');

    expect(view).toEqual({ status: 'pending', state });
  });

  it('reports a resolved terminal record with resultDigest and resultStatus, no value', async () => {
    const options = minimalServeOptions();
    const record = resolvedFixture({ adopted: true, adoptedAt: 5_000 });
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');

    expect(view).toEqual({
      status: 'terminal',
      disposition: 'resolved',
      resultDigest: 'digest-1',
      terminalAt: 4_000,
      adopted: true,
      adoptedAt: 5_000,
      resultStatus: 'completed',
    });
    expect(view).not.toHaveProperty('value');
  });

  it('reports a resolved terminal record with error when failed', async () => {
    const options = minimalServeOptions();
    const record = resolvedFixture({ status: 'failed', error: 'boom' });
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');

    expect(view).toMatchObject({ resultStatus: 'failed', error: 'boom' });
  });

  it.each([
    [
      'cancelled',
      cancelledFixture({
        attemptToken: 'attempt-secret-cancelled',
        resultDigest: 'cancelled:op-1:attempt-secret-cancelled',
      }),
      'attempt-secret-cancelled',
    ],
    ['retryExhausted', retryExhaustedFixture(), 'attempt-secret-retry-exhausted'],
  ] as const)(
    'reports a %s terminal record without its synthetic resultDigest or attemptToken',
    async (disposition, record, attemptToken) => {
      const options = minimalServeOptions();
      await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

      const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');

      expect(view).toEqual({
        status: 'terminal',
        disposition,
        terminalAt: 4_000,
        adopted: false,
        ...('error' in record ? { error: record.error } : {}),
      });
      expect(view).not.toHaveProperty('resultDigest');
      expect(JSON.stringify(view)).not.toContain(attemptToken);
    },
  );

  it('reports a deadLettered record', async () => {
    const options = minimalServeOptions();
    const record = deadLetteredFixture({ error: 'boom' });
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');

    expect(view).toEqual({
      status: 'deadLettered',
      persistenceFailureReason: 'lost the compare-and-swap race',
      pendingStatus: 'completed',
      deadLetteredAt: 4_000,
      error: 'boom',
    });
  });
});

describe('adoptTaskResultImpl', () => {
  it('adopts a terminal record whose resultDigest matches', async () => {
    const options = minimalServeOptions();
    const record = resolvedFixture();
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    const adopted = await adoptTaskResultImpl(options.engine.storage, 'op-1', 'digest-1');

    expect(adopted).toBe(true);
    const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');
    expect(view).toMatchObject({ adopted: true });
  });

  it('is idempotent — adopting an already-adopted record with the same digest succeeds again', async () => {
    const options = minimalServeOptions();
    const record = resolvedFixture({ adopted: true, adoptedAt: 1_000 });
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    const adopted = await adoptTaskResultImpl(options.engine.storage, 'op-1', 'digest-1');

    expect(adopted).toBe(true);
  });

  it('rejects a resultDigest mismatch', async () => {
    const options = minimalServeOptions();
    const record = resolvedFixture();
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    const adopted = await adoptTaskResultImpl(options.engine.storage, 'op-1', 'wrong-digest');

    expect(adopted).toBe(false);
    const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');
    expect(view).toMatchObject({ adopted: false });
  });

  it.each([
    ['cancelled', cancelledFixture()],
    ['retry-exhausted', retryExhaustedFixture()],
  ] as const)(
    'adopts a %s terminal record without exposing its synthetic digest',
    async (_, record) => {
      const options = minimalServeOptions();
      await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

      const adopted = await adoptTaskResultImpl(options.engine.storage, 'op-1');

      expect(adopted).toBe(true);
      const view = await getTaskResultViewImpl(options.engine.storage, 'op-1');
      expect(view).toMatchObject({ adopted: true });
      expect(view).not.toHaveProperty('resultDigest');
    },
  );

  it('requires the public resultDigest to adopt a resolved terminal record', async () => {
    const options = minimalServeOptions();
    await options.engine.storage.put(
      taskLedgerKey('op-1'),
      encodeRemoteTaskRecord(resolvedFixture()),
    );

    expect(await adoptTaskResultImpl(options.engine.storage, 'op-1')).toBe(false);
    expect(await getTaskResultViewImpl(options.engine.storage, 'op-1')).toMatchObject({
      adopted: false,
    });
  });

  it('rejects adopting a non-terminal record', async () => {
    const options = minimalServeOptions();
    const record = leasedFixture();
    await options.engine.storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(record));

    expect(await adoptTaskResultImpl(options.engine.storage, 'op-1', 'digest-1')).toBe(false);
  });

  it('rejects adopting a nonexistent record', async () => {
    const options = minimalServeOptions();
    expect(await adoptTaskResultImpl(options.engine.storage, 'never-dispatched', 'digest-1')).toBe(
      false,
    );
  });
});
