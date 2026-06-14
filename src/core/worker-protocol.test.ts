import { describe, expect, it } from 'bun:test';

import type { ContextOperationRequest } from './context.ts';
import { isValidWorkerLogRecord, isWorkerLogMessage } from './worker-protocol-log.ts';
import {
  MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
  WORKER_REPLAY_SIGNATURE_FORMAT,
  WorkerProtocolError,
  WorkerProtocolMessageSizeError,
  assertWorkerOutboundMessageShape,
  assertWorkerProtocolMessageWithinLimit,
  createBoundedWorkerFailureMessage,
  createWorkerReplayOperationSignature,
  estimateWorkerProtocolMessageBytes,
} from './worker-protocol.ts';

describe('Worker protocol message accounting', () => {
  it('keeps the bounded failure envelope inside the minimum protocol limit', () => {
    const failure = createBoundedWorkerFailureMessage({
      workflowId: 'workflow-with-bounded-worker-failure',
      error: 'x'.repeat(10_000),
      failureCategory: 'resource',
      turnId: 17,
    });

    expect(estimateWorkerProtocolMessageBytes(failure)).toBeLessThanOrEqual(
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
  });

  it('counts binary payload bytes without requiring JSON-shaped messages', () => {
    const message = {
      type: 'checkpoint',
      workflowId: 'wf-binary',
      checkpoint: new Uint8Array(256),
      nested: {
        buffer: new ArrayBuffer(128),
      },
    };

    expect(estimateWorkerProtocolMessageBytes(message)).toBeGreaterThan(384);
    expect(() => assertWorkerProtocolMessageWithinLimit(message, 256)).toThrow(
      WorkerProtocolMessageSizeError,
    );
  });

  it('accepts messages whose encoded size exactly matches the configured limit', () => {
    const message = {
      type: 'completed',
      workflowId: 'wf-boundary',
      result: { value: 'ok' },
    };
    const messageBytes = estimateWorkerProtocolMessageBytes(message);

    expect(assertWorkerProtocolMessageWithinLimit(message, messageBytes)).toBe(messageBytes);
    expect(() => assertWorkerProtocolMessageWithinLimit(message, messageBytes - 1)).toThrow(
      WorkerProtocolMessageSizeError,
    );
  });

  it('rejects cyclic and non-cloneable protocol messages', () => {
    const cyclic: Record<string, unknown> = { type: 'checkpoint' };
    cyclic['self'] = cyclic;

    expect(() => estimateWorkerProtocolMessageBytes(cyclic)).toThrow(WorkerProtocolError);
    expect(() => estimateWorkerProtocolMessageBytes({ type: 'failed', handler: () => {} })).toThrow(
      WorkerProtocolError,
    );
  });

  it('accounts for Map and Set members through the encoded envelope path', () => {
    const baseline = estimateWorkerProtocolMessageBytes({
      type: 'completed',
      workflowId: 'wf-map-set',
      result: {},
    });
    const nestedCollections = estimateWorkerProtocolMessageBytes({
      type: 'completed',
      workflowId: 'wf-map-set',
      result: {
        cache: new Map([[new Date('2026-01-01T00:00:00.000Z'), new Set(['a', 'b'])]]),
      },
    });

    expect(nestedCollections).toBeGreaterThan(baseline);
  });

  it('validates outbound message shape before host forwarding', () => {
    expect(() =>
      assertWorkerOutboundMessageShape({
        type: 'checkpoint',
        workflowId: 'wf-malformed',
        checkpoint: 'not-bytes',
        operationRequest: { type: 'wait-signal' },
      }),
    ).toThrow(WorkerProtocolError);

    expect(() =>
      assertWorkerOutboundMessageShape({
        type: 'failed',
        workflowId: 'wf-failed',
        error: 'bounded failure',
      }),
    ).not.toThrow();
  });
});

describe('Worker replay operation signatures', () => {
  it('produces stable signatures independent of runtime-only operation fields', async () => {
    const left = await createWorkerReplayOperationSignature(
      {
        id: 'operation-a',
        workflowId: 'workflow-a',
        kind: 'activity',
        queue: 'default',
        activityName: 'load-user',
        input: { id: 'user-1' },
        attempt: 1,
        retryPolicy: {
          maxAttempts: 3,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '1m',
        },
        scheduledAt: 1,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const right = await createWorkerReplayOperationSignature(
      {
        id: 'operation-b',
        workflowId: 'workflow-b',
        kind: 'activity',
        queue: 'default',
        activityName: 'load-user',
        input: { id: 'user-1' },
        attempt: 2,
        retryPolicy: {
          maxAttempts: 3,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '1m',
        },
        scheduledAt: 2,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(left).toEqual(right);
    expect(left.format).toBe(WORKER_REPLAY_SIGNATURE_FORMAT);
  });

  it('changes signatures when semantic operation input changes', async () => {
    const first = await createWorkerReplayOperationSignature(
      {
        type: 'state-read',
        operationId: 'read-settings',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'settings',
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const second = await createWorkerReplayOperationSignature(
      {
        type: 'state-read',
        operationId: 'read-profile',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'profile',
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(first.stableFieldsDigest).not.toBe(second.stableFieldsDigest);
  });

  it('keeps sleep signatures stable when scheduled fire times change', async () => {
    const first = await createWorkerReplayOperationSignature(
      {
        type: 'sleep',
        operationId: 'sleep-1',
        duration: 1_000,
        scheduledFireAt: 10_000,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const second = await createWorkerReplayOperationSignature(
      {
        type: 'sleep',
        operationId: 'sleep-2',
        duration: 1_000,
        scheduledFireAt: 20_000,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(first).toEqual(second);
  });

  it('includes Map entry keys and values when hashing replay signatures', async () => {
    const withMap = await createWorkerReplayOperationSignature(
      {
        type: 'activity',
        operationId: 'activity-map',
        activityName: 'persist-map',
        input: new Map([[{ key: 'alpha' }, { value: 'one' }]]),
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const withoutMap = await createWorkerReplayOperationSignature(
      {
        type: 'activity',
        operationId: 'activity-map',
        activityName: 'persist-map',
        input: new Map([[{ key: 'alpha' }, { value: 'two' }]]),
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(withMap.stableFieldsDigest).not.toBe(withoutMap.stableFieldsDigest);
  });

  it('produces signatures for every workflow context operation variant', async () => {
    const operations: ContextOperationRequest[] = [
      {
        type: 'activity',
        operationId: 'activity-1',
        activityName: 'load-user',
        input: { id: 'user-1' },
        fn: () => 'ignored by signature',
      },
      {
        type: 'sleep',
        operationId: 'sleep-1',
        duration: 1_000,
        scheduledFireAt: 10_000,
      },
      {
        type: 'wait-signal',
        operationId: 'signal-1',
        signalName: 'resume',
      },
      {
        type: 'wait-update',
        operationId: 'update-1',
        updateName: 'approve',
      },
      {
        type: 'parallel',
        operationId: 'parallel-1',
        step: 1,
        operations: [
          {
            type: 'activity',
            operationId: 'parallel-activity-1',
            activityName: 'load-profile',
            input: { profileId: 'profile-1' },
            fn: () => undefined,
          },
        ],
      },
      {
        type: 'race',
        operationId: 'race-1',
        operations: [
          {
            type: 'sleep',
            operationId: 'race-sleep-1',
            duration: 5_000,
            scheduledFireAt: 15_000,
          },
        ],
      },
      {
        type: 'memo',
        operationId: 'memo-1',
        key: 'memo-key',
        fn: () => 'memoized',
      },
      {
        type: 'child-workflow',
        operationId: 'child-1',
        workflowType: 'child',
        input: { childId: 'child-1' },
        options: { id: 'child-workflow-1' },
      },
      {
        type: 'offload',
        operationId: 'offload-1',
        key: 'offload-key',
        fn: async () => ({ cached: true }),
      },
      {
        type: 'load',
        operationId: 'load-1',
        reference: { key: 'offload-key', workflowId: 'wf-1', sizeBytes: 12 },
      },
      {
        type: 'archive',
        operationId: 'archive-1',
        key: 'archive-key',
        data: { archived: true },
      },
      {
        type: 'state-read',
        operationId: 'state-read-1',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'settings',
        initial: { enabled: true },
      },
      {
        type: 'state-commit',
        operationId: 'state-commit-1',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'settings',
        expectedVersion: 1,
        mode: 'set',
        value: { enabled: false },
      },
      {
        type: 'run-all',
        operationId: 'run-all-1',
        step: 2,
        branches: {
          first: [() => 'first'],
          second: [() => 'second', { id: 'branch-input' }],
        },
      },
      {
        type: 'speculate',
        operationId: 'speculate-1',
        execute: function* () {
          return 'speculated';
        },
      },
      {
        type: 'stream',
        operationId: 'stream-1',
        key: 'stream-key',
        fn: async function* () {
          yield 'chunk';
        },
      },
      {
        type: 'wait-review',
        operationId: 'review-1',
        reviewOptions: {
          artifact: { title: 'Review this' },
          reviewers: ['reviewer@example.com'],
        },
      },
    ];

    for (const operation of operations) {
      const signature = await createWorkerReplayOperationSignature(
        operation,
        MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
      );
      expect(signature).toMatchObject({
        format: WORKER_REPLAY_SIGNATURE_FORMAT,
        operationType: operation.type,
      });
    }
  });

  it('produces signatures for worker operation kind aliases', async () => {
    const timer = await createWorkerReplayOperationSignature(
      {
        id: 'timer-1',
        workflowId: 'workflow-timer',
        kind: 'timer',
        queue: 'default',
        attempt: 1,
        retryPolicy: {
          maxAttempts: 1,
          initialBackoff: 0,
          backoffMultiplier: 1,
          maxBackoff: 0,
        },
        scheduledAt: 1_000,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const signalWait = await createWorkerReplayOperationSignature(
      {
        id: 'signal-wait-1',
        workflowId: 'workflow-signal',
        kind: 'signal-wait',
        queue: 'default',
        attempt: 1,
        retryPolicy: {
          maxAttempts: 1,
          initialBackoff: 0,
          backoffMultiplier: 1,
          maxBackoff: 0,
        },
        scheduledAt: 1_000,
        signalName: 'resume',
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(timer.operationType).toBe('timer');
    expect(signalWait.operationType).toBe('signal-wait');
  });

  it('rejects unknown operation shapes and oversized signature inputs', async () => {
    await expect(
      createWorkerReplayOperationSignature(
        {
          type: 'unknown-operation',
          operationId: 'unknown-1',
        } as never,
        1024,
      ),
    ).rejects.toThrow(WorkerProtocolError);

    await expect(
      createWorkerReplayOperationSignature(
        {
          type: 'state-commit',
          operationId: 'commit-large',
          scope: { type: 'workflow', workflowType: 'account' },
          key: 'large',
          expectedVersion: 1,
          mode: 'set',
          value: 'x'.repeat(1024),
        },
        128,
      ),
    ).rejects.toThrow(WorkerProtocolError);
  });
});

describe('Worker log message validation (#529)', () => {
  const validRecord = {
    level: 'info',
    message: 'hello',
    workflowId: 'wf-1',
    workflowType: 'test',
    timestamp: 0,
  };

  describe('isValidWorkerLogRecord', () => {
    it('accepts a well-formed log record', () => {
      expect(isValidWorkerLogRecord(validRecord)).toBe(true);
    });

    it('accepts every valid level', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        expect(isValidWorkerLogRecord({ ...validRecord, level })).toBe(true);
      }
    });

    it('rejects a non-object record', () => {
      expect(isValidWorkerLogRecord(null)).toBe(false);
      expect(isValidWorkerLogRecord('nope')).toBe(false);
      expect(isValidWorkerLogRecord(42)).toBe(false);
    });

    it('rejects a record without a string message', () => {
      expect(isValidWorkerLogRecord({ ...validRecord, message: 123 })).toBe(false);
    });

    it('rejects a record with an invalid level', () => {
      expect(isValidWorkerLogRecord({ ...validRecord, level: 'trace' })).toBe(false);
    });

    it('rejects a record missing required envelope fields', () => {
      // The full-shape validator requires every engine-owned envelope field, because a
      // host sink is typed to receive a complete WorkflowLogRecord.
      expect(isValidWorkerLogRecord({ level: 'info', message: 'hi' })).toBe(false);
      const { workflowId: _id, ...withoutId } = validRecord;
      expect(isValidWorkerLogRecord(withoutId)).toBe(false);
      const { workflowType: _type, ...withoutType } = validRecord;
      expect(isValidWorkerLogRecord(withoutType)).toBe(false);
      const { timestamp: _ts, ...withoutTimestamp } = validRecord;
      expect(isValidWorkerLogRecord(withoutTimestamp)).toBe(false);
    });

    it('rejects non-string workflowId / workflowType and non-finite timestamp', () => {
      expect(isValidWorkerLogRecord({ ...validRecord, workflowId: 1 })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, workflowType: 1 })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, timestamp: 'now' })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, timestamp: Number.NaN })).toBe(false);
    });

    it('accepts an optional plain-object attributes but rejects a non-plain one', () => {
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: { k: 'v' } })).toBe(true);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: 'nope' })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: null })).toBe(false);
      // An array is `typeof 'object'` but is NOT the keyed bag the contract requires.
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: [] })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: ['a', 'b'] })).toBe(false);
    });
  });

  describe('isWorkerLogMessage', () => {
    it('matches any message with type log (payload validity decided separately)', () => {
      expect(isWorkerLogMessage({ type: 'log', workflowId: 'wf-1', record: validRecord })).toBe(
        true,
      );
      // Routes on type alone — even a malformed record routes into the lenient lane.
      expect(isWorkerLogMessage({ type: 'log', record: { bad: true } })).toBe(true);
    });

    it('does not match non-log messages or non-objects', () => {
      expect(isWorkerLogMessage({ type: 'checkpoint', workflowId: 'wf-1' })).toBe(false);
      expect(isWorkerLogMessage(null)).toBe(false);
      expect(isWorkerLogMessage('log')).toBe(false);
    });

    it('routes on type regardless of protocolVersion (version-tolerant observability lane)', () => {
      // The log lane carries no turn-protocol state and intentionally bypasses version
      // negotiation: a `log` from any protocol version routes in on `type` alone, and
      // its record is validated structurally rather than rejected on version. This is
      // the one place that compatibility decision lives.
      expect(
        isWorkerLogMessage({
          type: 'log',
          protocolVersion: 999,
          workflowId: 'wf-1',
          record: validRecord,
        }),
      ).toBe(true);
      expect(isWorkerLogMessage({ type: 'log', workflowId: 'wf-1', record: validRecord })).toBe(
        true,
      );
    });
  });

  describe('assertWorkerOutboundMessageShape accepts the log variant', () => {
    it('accepts a well-formed log message', () => {
      expect(() =>
        assertWorkerOutboundMessageShape({
          type: 'log',
          workflowId: 'wf-1',
          record: validRecord,
        }),
      ).not.toThrow();
    });

    it('rejects a log message with a missing or malformed record (strict path)', () => {
      expect(() => assertWorkerOutboundMessageShape({ type: 'log', workflowId: 'wf-1' })).toThrow(
        WorkerProtocolError,
      );
      expect(() =>
        assertWorkerOutboundMessageShape({
          type: 'log',
          workflowId: 'wf-1',
          record: { level: 'info' },
        }),
      ).toThrow(WorkerProtocolError);
    });
  });
});
