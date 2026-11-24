import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
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

  it('stamps workflowRevision on the bounded failure envelope when supplied (WFT-20)', () => {
    // Without this, `postOutboundMessage`'s bounded fallback for an oversized
    // checkpoint/terminal message would fail the host's strict revision
    // check and get the worker discarded for every other workflow it owns.
    const failure = createBoundedWorkerFailureMessage({
      workflowId: 'workflow-with-bounded-worker-failure',
      error: 'x'.repeat(10_000),
      failureCategory: 'resource',
      turnId: 17,
      workflowRevision: 'rev-1',
    });

    expect(failure).toMatchObject({ type: 'failed', workflowRevision: 'rev-1' });
    expect(estimateWorkerProtocolMessageBytes(failure)).toBeLessThanOrEqual(
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
  });

  it('omits workflowRevision on the bounded failure envelope when not supplied', () => {
    const failure = createBoundedWorkerFailureMessage({
      workflowId: 'workflow-with-bounded-worker-failure',
      error: 'boom',
      failureCategory: 'resource',
    });

    expect('workflowRevision' in failure).toBe(false);
  });

  it('counts binary payload bytes without requiring JSON-shaped messages', () => {
    const message = {
      type: 'checkpoint',
      pendingStepIndex: 0,
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
        pendingStepIndex: 0,
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

  it('includes keyed race branch names in replay signatures', async () => {
    const operation = {
      type: 'race' as const,
      operationId: 'race-keyed',
      step: 0,
      operations: [
        {
          type: 'sleep' as const,
          operationId: 'race-keyed:0',
          duration: 1_000,
          scheduledFireAt: 10_000,
        },
      ],
    };
    const event = await createWorkerReplayOperationSignature(
      { ...operation, branchNames: ['event'] },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const idle = await createWorkerReplayOperationSignature(
      { ...operation, branchNames: ['idle'] },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(event.stableFieldsDigest).not.toBe(idle.stableFieldsDigest);
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
        step: 0,
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
    expect(
      await throwingRejectionOf(
        createWorkerReplayOperationSignature(
          {
            type: 'unknown-operation',
            operationId: 'unknown-1',
          } as never,
          1024,
        ),
      ),
    ).toThrow(WorkerProtocolError);

    expect(
      await throwingRejectionOf(
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
      ),
    ).toThrow(WorkerProtocolError);
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

    it('accepts an absent or non-negative integer step and rejects any other', () => {
      expect(isValidWorkerLogRecord({ ...validRecord, step: 0 })).toBe(true);
      expect(isValidWorkerLogRecord({ ...validRecord, step: 4 })).toBe(true);
      expect(isValidWorkerLogRecord({ ...validRecord, step: -1 })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, step: 1.5 })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, step: '1' })).toBe(false);
    });

    it('accepts an absent or boolean replayed mark and rejects any other', () => {
      expect(isValidWorkerLogRecord({ ...validRecord, replayed: true })).toBe(true);
      expect(isValidWorkerLogRecord({ ...validRecord, replayed: false })).toBe(true);
      expect(isValidWorkerLogRecord({ ...validRecord, replayed: 'yes' })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, replayed: 1 })).toBe(false);
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

    it('accepts only a PLAIN-object attributes, rejecting arrays and non-plain objects', () => {
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: { k: 'v' } })).toBe(true);
      // A null-prototype object is still a plain keyed bag.
      const nullProto = Object.assign(Object.create(null), { k: 'v' });
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: nullProto })).toBe(true);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: 'nope' })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: null })).toBe(false);
      // Arrays and non-plain cloneable objects are `typeof 'object'` but NOT the keyed bag
      // the `Record<string, unknown>` contract requires — an untrusted worker can postMessage
      // any structured-cloneable value, so they must be rejected.
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: [] })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: ['a', 'b'] })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: new Date() })).toBe(false);
      expect(isValidWorkerLogRecord({ ...validRecord, attributes: new Map() })).toBe(false);
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

describe('Worker outbound message shape rejections', () => {
  const rejects = (message: unknown, expected: string) => {
    expect(() => assertWorkerOutboundMessageShape(message)).toThrow(expected);
  };

  it('rejects anything that is not an object with a workflow id', () => {
    rejects(null, 'Worker outbound message must be an object');
    rejects('completed', 'Worker outbound message must be an object');
    rejects({ type: 'completed' }, 'Worker outbound message must include workflowId');
    rejects(
      { type: 'completed', workflowId: 7 },
      'Worker outbound message must include workflowId',
    );
  });

  it('rejects a protocol version or turn id that is not an integer', () => {
    rejects(
      { type: 'completed', workflowId: 'wf', protocolVersion: 1.5 },
      'Worker outbound message protocolVersion must be an integer',
    );
    rejects(
      { type: 'completed', workflowId: 'wf', turnId: '3' },
      'Worker outbound message turnId must be an integer',
    );
  });

  it('rejects a message type the host does not know', () => {
    rejects(
      { type: 'shutdown', workflowId: 'wf' },
      'Worker outbound message has an unsupported type',
    );
  });

  it('rejects a checkpoint whose pending step index is missing or is not a non-negative integer', () => {
    const base = {
      type: 'checkpoint',
      workflowId: 'wf',
      checkpoint: new ArrayBuffer(0),
      operationRequest: { type: 'sleep' },
    };
    for (const pendingStepIndex of [undefined, -1, 1.5, '2', Number.NaN, null]) {
      rejects(
        { ...base, pendingStepIndex },
        'Worker checkpoint message pendingStepIndex must be a non-negative integer',
      );
    }
  });

  it('rejects a checkpoint without an operation request and a failure without an error string', () => {
    rejects(
      { type: 'checkpoint', workflowId: 'wf', checkpoint: new ArrayBuffer(0) },
      'Worker checkpoint message must include operationRequest',
    );
    rejects(
      {
        type: 'checkpoint',
        pendingStepIndex: 0,
        workflowId: 'wf',
        checkpoint: new ArrayBuffer(0),
        operationRequest: null,
      },
      'Worker checkpoint message must include operationRequest',
    );
    rejects(
      { type: 'failed', workflowId: 'wf' },
      'Worker failed message must include an error string',
    );
  });
});

describe('Worker protocol message size accounting for every value kind', () => {
  it('counts array members, errors, dates and sets inside a message', () => {
    const baseline = estimateWorkerProtocolMessageBytes({ type: 'completed', workflowId: 'wf' });
    const withValues = estimateWorkerProtocolMessageBytes({
      type: 'completed',
      workflowId: 'wf',
      result: [new Error('boom'), new Date('2026-01-01T00:00:00.000Z'), new Set(['a'])],
    });
    const withLongerError = estimateWorkerProtocolMessageBytes({
      type: 'completed',
      workflowId: 'wf',
      result: [new Error('boom'.repeat(100)), new Date('2026-01-01T00:00:00.000Z'), new Set(['a'])],
    });

    expect(withValues).toBeGreaterThan(baseline);
    expect(withLongerError).toBeGreaterThan(withValues);
  });

  it('counts an error that is a Map key but not its stack', () => {
    const first = new Error('same message');
    const second = new Error('same message');
    second.stack = 'a very long stack '.repeat(100);

    expect(estimateWorkerProtocolMessageBytes({ cache: new Map([[first, 1]]) })).toBe(
      estimateWorkerProtocolMessageBytes({ cache: new Map([[second, 1]]) }),
    );
  });

  it('rejects a function or symbol that only appears as a Map key', () => {
    expect(() => estimateWorkerProtocolMessageBytes({ cache: new Map([[() => {}, 1]]) })).toThrow(
      'Worker protocol message cannot include functions or symbols',
    );
    expect(() =>
      estimateWorkerProtocolMessageBytes({ cache: new Map([[Symbol('key'), 1]]) }),
    ).toThrow('Worker protocol message cannot include functions or symbols');
  });

  it('rejects a cycle that runs through a Map key, which the cloneability check does not walk', () => {
    const owner: Record<string, unknown> = {};
    owner['cache'] = new Map([[owner, 1]]);

    expect(() => estimateWorkerProtocolMessageBytes(owner)).toThrow(
      'Worker protocol message cannot include cyclic values',
    );
  });
});

describe('Worker replay signature input handling', () => {
  const digestOf = async (input: unknown): Promise<string> => {
    const signature = await createWorkerReplayOperationSignature(
      { type: 'activity', operationId: 'activity-1', activityName: 'work', input } as never,
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    return signature.stableFieldsDigest;
  };

  it('hashes binary content by bytes, ignoring the buffer it sits in', async () => {
    const wide = new Uint8Array([9, 1, 2, 3, 9]);

    expect(await digestOf(new Uint8Array(wide.buffer, 1, 3))).toBe(
      await digestOf(new Uint8Array([1, 2, 3])),
    );
    expect(await digestOf(new Uint8Array([1, 2, 3]).buffer)).toBe(
      await digestOf(new Uint8Array([1, 2, 3])),
    );
    expect(await digestOf(new Uint8Array([1, 2, 4]))).not.toBe(
      await digestOf(new Uint8Array([1, 2, 3])),
    );
  });

  it('hashes dates by instant and errors by name and message', async () => {
    expect(await digestOf(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      await digestOf(new Date('2026-01-01T00:00:00.000Z')),
    );
    expect(await digestOf(new Date('2026-01-01T00:00:00.000Z'))).not.toBe(
      await digestOf(new Date('2026-01-02T00:00:00.000Z')),
    );

    const first = new Error('boom');
    const second = new Error('boom');
    second.stack = 'a different stack';
    expect(await digestOf(first)).toBe(await digestOf(second));
    expect(await digestOf(first)).not.toBe(await digestOf(new TypeError('boom')));
    expect(await digestOf(first)).not.toBe(await digestOf(new Error('bang')));
  });

  it('hashes sets by their members', async () => {
    expect(await digestOf(new Set(['a', 'b']))).toBe(await digestOf(new Set(['a', 'b'])));
    expect(await digestOf(new Set(['a', 'b']))).not.toBe(await digestOf(new Set(['a', 'c'])));
  });

  it('rejects functions and symbols nested in an operation', async () => {
    expect(await throwingRejectionOf(digestOf({ callback: () => {} }))).toThrow(
      'Worker replay signature cannot include functions or symbols',
    );
    expect(await throwingRejectionOf(digestOf({ tag: Symbol('tag') }))).toThrow(
      'Worker replay signature cannot include functions or symbols',
    );
  });

  it('rejects an operation with neither a type nor a kind', async () => {
    expect(
      await throwingRejectionOf(
        createWorkerReplayOperationSignature({ operationId: 'anonymous' } as never, 1024),
      ),
    ).toThrow('Worker operation has no type or kind');
  });

  it('reports a cyclic operation as a protocol error instead of overflowing the stack', async () => {
    const self: Record<string, unknown> = { label: 'self' };
    self['again'] = self;
    const throughMap: Record<string, unknown> = {};
    throughMap['cache'] = new Map([['key', throughMap]]);
    const throughSet: Record<string, unknown> = {};
    throughSet['members'] = new Set([throughSet]);

    for (const cyclic of [self, throughMap, throughSet]) {
      expect(await throwingRejectionOf(digestOf(cyclic))).toThrow(WorkerProtocolError);
      expect(await throwingRejectionOf(digestOf(cyclic))).toThrow(
        'Worker replay signature cannot include cyclic values',
      );
    }
  });

  it('hashes a value shared by two fields, which is a repeat and not a cycle', async () => {
    const shared = { id: 'shared' };

    expect(await digestOf({ left: shared, right: shared })).toBe(
      await digestOf({ left: { id: 'shared' }, right: { id: 'shared' } }),
    );
  });
});

describe('Worker run-all replay signature branches', () => {
  const digestOfRunAll = async (branches: unknown): Promise<string> => {
    const signature = await createWorkerReplayOperationSignature(
      { type: 'run-all', operationId: 'run-all-1', branches } as never,
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    return signature.stableFieldsDigest;
  };

  it('hashes branches by arity and input, not by the function they run', async () => {
    expect(await digestOfRunAll({ first: [() => 1], second: [() => 2, { amount: 1 }] })).toBe(
      await digestOfRunAll({ first: [() => 'other'], second: [() => 'other', { amount: 1 }] }),
    );
    expect(await digestOfRunAll({ first: [() => 1], second: [() => 2, { amount: 1 }] })).not.toBe(
      await digestOfRunAll({ first: [() => 1], second: [() => 2, { amount: 2 }] }),
    );
  });

  it('hashes branches that are not a keyed record, and branch entries that are not arrays', async () => {
    expect(await digestOfRunAll(['a', 'b'])).not.toBe(await digestOfRunAll(['a', 'c']));
    expect(await digestOfRunAll({ first: 'literal' })).not.toBe(
      await digestOfRunAll({ first: 'other' }),
    );
  });

  it('reports branches that contain themselves as a protocol error', async () => {
    const branches: Record<string, unknown> = {};
    branches['again'] = branches;
    const operation: Record<string, unknown> = { type: 'run-all' };
    operation['branches'] = operation;

    expect(await throwingRejectionOf(digestOfRunAll(branches))).toThrow(
      'Worker replay signature cannot include cyclic values',
    );
    // A record that is both an ancestor and the `branches` of a nested run-all record.
    expect(
      await throwingRejectionOf(
        createWorkerReplayOperationSignature(
          { type: 'activity', operationId: 'a-1', activityName: 'work', input: operation } as never,
          MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
        ),
      ),
    ).toThrow('Worker replay signature cannot include cyclic values');
  });
});
