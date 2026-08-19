import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import type { WorkerExecutionIdentity } from '../worker/manifest/types.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  isRemoteTaskCancelling,
  isRemoteTaskCompleting,
  isRemoteTaskDeadLettered,
  isRemoteTaskLeased,
  isRemoteTaskQueued,
  isRemoteTaskRecord,
  isRemoteTaskTerminal,
  isRemoteTaskTerminalCancelled,
  isRemoteTaskTerminalResolved,
  isRemoteTaskTerminalRetryExhausted,
  isValidTaskHeaders,
  MAX_TASK_HEADER_COUNT,
  MAX_TASK_HEADER_VALUE_BYTES,
  MAX_TASK_IDENTIFIER_BYTES,
  taskLedgerKey,
  utf8ByteLength,
  type RemoteTaskCancelling,
  type RemoteTaskCompleting,
  type RemoteTaskDeadLettered,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskTerminalCancelled,
  type RemoteTaskTerminalResolved,
  type RemoteTaskTerminalRetryExhausted,
} from './task-ledger.ts';

const EXECUTION_IDENTITY: WorkerExecutionIdentity = {
  workerId: 'worker-1',
  manifestDigest: 'sha256:abc',
  protocolVersion: 3,
  sdkVersion: '0.18.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.14',
  deploymentName: 'billing',
  buildId: 'build-1',
  artifactDigest: 'sha256:def',
  workflowType: 'checkout',
  workflowRevision: 'sha256:111',
  activityName: 'charge',
  activityContractHash: 'sha256:222',
};

function baseFields() {
  return {
    recordVersion: 1 as const,
    operationId: 'op-1',
    workflowType: 'checkout',
    workflowExecutionToken: 'token-1',
    activityName: 'charge',
    queue: 'default',
    input: { amount: 100 },
    headers: { 'x-trace-id': 'trace-1' },
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
  };
}

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  return {
    ...baseFields(),
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: 1_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
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
    workerSessionId: 'session-1',
    executionIdentity: EXECUTION_IDENTITY,
    attempt: 1,
    leaseDeadline: 31_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    startedAt: 1_000,
    lastHeartbeatAt: 1_000,
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
    cancellationRequestedAt: 2_000,
    ...overrides,
  };
}

function terminalResolvedFixture(
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
    terminalAt: 3_000,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

function terminalCancelledFixture(
  overrides: Partial<RemoteTaskTerminalCancelled> = {},
): RemoteTaskTerminalCancelled {
  return {
    ...baseFields(),
    generation: 1,
    state: 'terminal',
    disposition: 'cancelled',
    attempt: 1,
    cancellationReason: 'user requested',
    resultDigest: 'cancelled-digest',
    terminalAt: 2_000,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

function terminalRetryExhaustedFixture(
  overrides: Partial<RemoteTaskTerminalRetryExhausted> = {},
): RemoteTaskTerminalRetryExhausted {
  return {
    ...baseFields(),
    generation: 4,
    state: 'terminal',
    disposition: 'retryExhausted',
    attempt: 3,
    attemptToken: 'attempt-3',
    error: 'exhausted',
    resultDigest: 'retry-exhausted-digest',
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
    deadLetteredAt: 5_000,
    persistenceFailureReason: 'storage exhausted retries',
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

describe('taskLedgerKey', () => {
  it('produces one authoritative current-state key per operation', () => {
    expect(taskLedgerKey('op-1')).toBe('task-ledger:op-1');
  });

  it('encodes hostile operationId components so they cannot collide across keys', () => {
    const encoded = taskLedgerKey('op:1/../op:2');
    expect(encoded).not.toContain('/');
    expect(taskLedgerKey('op:1')).not.toBe(taskLedgerKey('op%3A1'));
  });
});

describe('isValidTaskHeaders', () => {
  it('accepts a bounded string-to-string record', () => {
    expect(isValidTaskHeaders({ 'x-trace-id': 'abc' })).toBe(true);
    expect(isValidTaskHeaders({})).toBe(true);
  });

  it('rejects non-string values, arrays, and non-records', () => {
    expect(isValidTaskHeaders({ a: 1 })).toBe(false);
    expect(isValidTaskHeaders(['a'])).toBe(false);
    expect(isValidTaskHeaders(null)).toBe(false);
    expect(isValidTaskHeaders('nope')).toBe(false);
  });

  it('rejects a header map exceeding the entry-count bound', () => {
    const headers: Record<string, string> = {};
    for (let index = 0; index <= MAX_TASK_HEADER_COUNT; index += 1) {
      headers[`h${String(index)}`] = 'v';
    }
    expect(isValidTaskHeaders(headers)).toBe(false);
  });

  it('rejects a header value exceeding the byte-length bound', () => {
    expect(isValidTaskHeaders({ big: 'x'.repeat(MAX_TASK_HEADER_VALUE_BYTES + 1) })).toBe(false);
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes, not code units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('日')).toBe(3);
  });
});

describe('isRemoteTaskQueued', () => {
  it('accepts a well-formed queued record', () => {
    expect(isRemoteTaskQueued(queuedFixture())).toBe(true);
  });

  it('rejects a record missing a required field', () => {
    const { attempt: _attempt, ...withoutAttempt } = queuedFixture();
    expect(isRemoteTaskQueued(withoutAttempt)).toBe(false);
  });

  it('rejects an operationId exceeding the identifier byte bound', () => {
    expect(
      isRemoteTaskQueued(queuedFixture({ operationId: 'x'.repeat(MAX_TASK_IDENTIFIER_BYTES + 1) })),
    ).toBe(false);
  });

  it('rejects a non-JSON input value', () => {
    expect(isRemoteTaskQueued({ ...queuedFixture(), input: () => undefined })).toBe(false);
  });

  it('accepts an absent optional workflowId, matching TaskDispatch.workflowId today', () => {
    const record = queuedFixture();
    expect('workflowId' in record).toBe(false);
    expect(isRemoteTaskQueued(record)).toBe(true);
  });

  it('rejects a record in a different state', () => {
    expect(isRemoteTaskQueued(leasedFixture())).toBe(false);
  });
});

describe('isValidTaskBase retryPolicy and executionRequirement bounds', () => {
  const retryPolicy = {
    maxAttempts: 5,
    initialBackoff: '1s',
    backoffMultiplier: 2,
    maxBackoff: '30s',
    nonRetryableErrors: ['ValidationError'],
  };

  it('accepts a well-formed retryPolicy with string durations and nonRetryableErrors', () => {
    expect(isRemoteTaskQueued(queuedFixture({ retryPolicy }))).toBe(true);
  });

  it('accepts numeric-duration retryPolicy fields and an absent nonRetryableErrors', () => {
    expect(
      isRemoteTaskQueued(
        queuedFixture({
          retryPolicy: {
            maxAttempts: 3,
            initialBackoff: 1000,
            backoffMultiplier: 2,
            maxBackoff: 30_000,
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects a retryPolicy with a non-finite maxAttempts', () => {
    expect(
      isRemoteTaskQueued({
        ...queuedFixture(),
        retryPolicy: { ...retryPolicy, maxAttempts: 'five' },
      }),
    ).toBe(false);
  });

  it('rejects a retryPolicy whose duration fields are not number or string', () => {
    expect(
      isRemoteTaskQueued({
        ...queuedFixture(),
        retryPolicy: { ...retryPolicy, initialBackoff: null },
      }),
    ).toBe(false);
  });

  it('rejects a retryPolicy with a non-string entry in nonRetryableErrors', () => {
    expect(
      isRemoteTaskQueued({
        ...queuedFixture(),
        retryPolicy: { ...retryPolicy, nonRetryableErrors: [42] },
      }),
    ).toBe(false);
  });

  it('rejects a retryPolicy that is not an object', () => {
    expect(isRemoteTaskQueued({ ...queuedFixture(), retryPolicy: 'aggressive' })).toBe(false);
  });

  it('accepts a well-formed executionRequirement', () => {
    expect(
      isRemoteTaskQueued(
        queuedFixture({ executionRequirement: { deploymentName: 'billing', buildId: 'b3' } }),
      ),
    ).toBe(true);
  });

  it('rejects an executionRequirement with an over-length identifier', () => {
    expect(
      isRemoteTaskQueued(
        queuedFixture({
          executionRequirement: { deploymentName: 'x'.repeat(MAX_TASK_IDENTIFIER_BYTES + 1) },
        }),
      ),
    ).toBe(false);
  });

  it('rejects an executionRequirement that is not an object', () => {
    expect(isRemoteTaskQueued({ ...queuedFixture(), executionRequirement: 'billing' })).toBe(false);
  });
});

describe('isRemoteTaskLeased', () => {
  it('accepts a well-formed leased record', () => {
    expect(isRemoteTaskLeased(leasedFixture())).toBe(true);
  });

  it('rejects a malformed executionIdentity', () => {
    expect(
      isRemoteTaskLeased({ ...leasedFixture(), executionIdentity: { workerId: 'worker-1' } }),
    ).toBe(false);
  });

  it('rejects a record from a different state', () => {
    expect(isRemoteTaskLeased(queuedFixture())).toBe(false);
  });
});

describe('isRemoteTaskCompleting', () => {
  it('accepts a well-formed completing record', () => {
    expect(isRemoteTaskCompleting(completingFixture())).toBe(true);
  });

  it('rejects an invalid pendingStatus', () => {
    expect(isRemoteTaskCompleting({ ...completingFixture(), pendingStatus: 'pending' })).toBe(
      false,
    );
  });
});

describe('isRemoteTaskCancelling', () => {
  it('accepts a well-formed cancelling record with a required attemptToken', () => {
    const record = cancellingFixture();
    expect(record.attemptToken).toBeTruthy();
    expect(isRemoteTaskCancelling(record)).toBe(true);
  });

  it('rejects a cancelling record missing attemptToken', () => {
    const { attemptToken: _attemptToken, ...withoutToken } = cancellingFixture();
    expect(isRemoteTaskCancelling(withoutToken)).toBe(false);
  });
});

describe('terminal disposition guards', () => {
  it('isRemoteTaskTerminalResolved accepts the resolved lineage only', () => {
    expect(isRemoteTaskTerminalResolved(terminalResolvedFixture())).toBe(true);
    expect(isRemoteTaskTerminalResolved(terminalCancelledFixture())).toBe(false);
  });

  it('isRemoteTaskTerminalCancelled accepts an absent attemptToken (queued-origin cancel)', () => {
    const { attemptToken: _attemptToken, ...withoutToken } = terminalCancelledFixture({
      attemptToken: 'attempt-1',
    });
    expect(isRemoteTaskTerminalCancelled(withoutToken)).toBe(true);
  });

  it('isRemoteTaskTerminalRetryExhausted requires attemptToken and error', () => {
    expect(isRemoteTaskTerminalRetryExhausted(terminalRetryExhaustedFixture())).toBe(true);
    const { error: _error, ...withoutError } = terminalRetryExhaustedFixture();
    expect(isRemoteTaskTerminalRetryExhausted(withoutError)).toBe(false);
  });

  it('isRemoteTaskTerminal accepts any of the three lineages', () => {
    expect(isRemoteTaskTerminal(terminalResolvedFixture())).toBe(true);
    expect(isRemoteTaskTerminal(terminalCancelledFixture())).toBe(true);
    expect(isRemoteTaskTerminal(terminalRetryExhaustedFixture())).toBe(true);
    expect(isRemoteTaskTerminal(queuedFixture())).toBe(false);
  });
});

describe('isRemoteTaskDeadLettered', () => {
  it('accepts a well-formed dead-lettered record', () => {
    expect(isRemoteTaskDeadLettered(deadLetteredFixture())).toBe(true);
  });

  it('rejects a record missing persistenceFailureReason', () => {
    const { persistenceFailureReason: _reason, ...withoutReason } = deadLetteredFixture();
    expect(isRemoteTaskDeadLettered(withoutReason)).toBe(false);
  });
});

describe('isRemoteTaskRecord', () => {
  it('discriminates across every state by the `state` field', () => {
    expect(isRemoteTaskRecord(queuedFixture())).toBe(true);
    expect(isRemoteTaskRecord(leasedFixture())).toBe(true);
    expect(isRemoteTaskRecord(completingFixture())).toBe(true);
    expect(isRemoteTaskRecord(cancellingFixture())).toBe(true);
    expect(isRemoteTaskRecord(terminalResolvedFixture())).toBe(true);
    expect(isRemoteTaskRecord(deadLetteredFixture())).toBe(true);
  });

  it('rejects an unknown state and non-record input', () => {
    expect(isRemoteTaskRecord({ ...queuedFixture(), state: 'bogus' })).toBe(false);
    expect(isRemoteTaskRecord(null)).toBe(false);
    expect(isRemoteTaskRecord('queued')).toBe(false);
  });
});

describe('encodeRemoteTaskRecord / decodeRemoteTaskRecord', () => {
  it('round-trips every state through encode and decode', () => {
    const records = [
      queuedFixture(),
      leasedFixture(),
      completingFixture(),
      cancellingFixture(),
      terminalResolvedFixture(),
      terminalCancelledFixture(),
      terminalRetryExhaustedFixture(),
      deadLetteredFixture(),
    ];
    for (const record of records) {
      const decoded = decodeRemoteTaskRecord(encodeRemoteTaskRecord(record));
      expect(decoded).toEqual(record);
    }
  });

  it('returns null for absent bytes', () => {
    expect(decodeRemoteTaskRecord(null)).toBeNull();
  });

  it('returns null for well-formed-but-invalid decoded content', () => {
    expect(decodeRemoteTaskRecord(encode({ state: 'queued' }))).toBeNull();
  });
});
