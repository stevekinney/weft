import { describe, expect, it } from 'bun:test';

import {
  REMOTE_WORKER_MAX_PROTOCOL_VERSION,
  REMOTE_WORKER_MESSAGE_SCHEMAS,
  REMOTE_WORKER_MIN_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTOCOL_JSON_SCHEMA,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  isRemoteWorkerJsonValue,
  parseServerToWorkerMessage,
  parseWorkerToServerMessage,
} from './protocol.ts';

describe('RemoteWorker protocol contract', () => {
  it('pins the supported protocol version range to v2 (qualified activity names)', () => {
    expect(REMOTE_WORKER_PROTOCOL_VERSION).toBe(2);
    expect(REMOTE_WORKER_MIN_PROTOCOL_VERSION).toBe(2);
    expect(REMOTE_WORKER_MAX_PROTOCOL_VERSION).toBe(2);
    expect(REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS).toEqual([2]);
  });

  it('publishes deterministic schemas for every protocol message', () => {
    expect(Object.keys(REMOTE_WORKER_MESSAGE_SCHEMAS)).toEqual([
      'register',
      'heartbeat',
      'taskResult',
      'task',
      'cancel',
      'shutdown',
      'registerAck',
      'registerError',
      'protocolError',
    ]);

    expect(JSON.stringify(REMOTE_WORKER_PROTOCOL_JSON_SCHEMA)).toBe(
      JSON.stringify(REMOTE_WORKER_PROTOCOL_JSON_SCHEMA),
    );

    expect(REMOTE_WORKER_MESSAGE_SCHEMAS.register.properties.protocolVersion).toEqual({
      const: REMOTE_WORKER_PROTOCOL_VERSION,
    });
    expect(REMOTE_WORKER_MESSAGE_SCHEMAS.registerAck.properties.protocolVersion).toEqual({
      const: REMOTE_WORKER_PROTOCOL_VERSION,
    });
    expect(
      REMOTE_WORKER_MESSAGE_SCHEMAS.registerError.properties.supportedProtocolVersions,
    ).toEqual({
      type: 'array',
      items: { const: REMOTE_WORKER_PROTOCOL_VERSION },
    });
    expect(REMOTE_WORKER_PROTOCOL_JSON_SCHEMA.$id).toBe(
      `https://weft.dev/schemas/remote-worker-protocol.v${String(REMOTE_WORKER_PROTOCOL_VERSION)}.json`,
    );
    expect(REMOTE_WORKER_PROTOCOL_JSON_SCHEMA.title).toBe(
      `Weft RemoteWorker Protocol v${String(REMOTE_WORKER_PROTOCOL_VERSION)}`,
    );
  });

  it('accepts a valid current register message', () => {
    const result = parseWorkerToServerMessage({
      type: 'register',
      protocolVersion: 2,
      workerId: 'worker-1',
      activities: ['payments.charge'],
      concurrency: 4,
      queue: 'default',
    });

    expect(result).toEqual({
      ok: true,
      message: {
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: ['payments.charge'],
        concurrency: 4,
        queue: 'default',
      },
    });
  });

  it('accepts optional deployment identity fields on current register messages', () => {
    const result = parseWorkerToServerMessage({
      type: 'register',
      protocolVersion: 2,
      workerId: 'worker-1',
      activities: ['payments.charge'],
      deploymentName: 'payments',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.2.13',
      gitSha: '0123456789abcdef',
      startedAt: 1_778_608_000_000,
      capabilities: {
        region: 'us-west',
        gpu: false,
        slots: 4,
        labels: ['stable', 'canary'],
      },
    });

    expect(result).toEqual({
      ok: true,
      message: {
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: ['payments.charge'],
        deploymentName: 'payments',
        buildId: 'build-2026-05-12',
        runtimeVersion: 'bun-1.2.13',
        gitSha: '0123456789abcdef',
        startedAt: 1_778_608_000_000,
        capabilities: {
          region: 'us-west',
          gpu: false,
          slots: 4,
          labels: ['stable', 'canary'],
        },
      },
    });
  });

  it('rejects missing or unsupported protocol versions as registration errors', () => {
    expect(
      parseWorkerToServerMessage({
        type: 'register',
        workerId: 'worker-1',
        activities: ['charge'],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unsupported_protocol_version' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 99,
        workerId: 'worker-1',
        activities: ['charge'],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unsupported_protocol_version', requestedProtocolVersion: 99 },
    });
  });

  it('validates JSON values accepted by the wire protocol', () => {
    expect(isRemoteWorkerJsonValue(null)).toBe(true);
    expect(isRemoteWorkerJsonValue(['ok', 1, false, { nested: true }])).toBe(true);
    expect(isRemoteWorkerJsonValue([Number.POSITIVE_INFINITY])).toBe(false);
    expect(isRemoteWorkerJsonValue({ value: Symbol('bad') })).toBe(false);
    expect(isRemoteWorkerJsonValue(undefined)).toBe(false);
  });

  it('rejects malformed registration and heartbeat messages', () => {
    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 2,
        workerId: '',
        activities: ['charge'],
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'register.workerId must be a non-empty string' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: [''],
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'register.activities must be an array of non-empty strings' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: ['charge'],
        concurrency: Number.NaN,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'register.concurrency must be a finite number' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: ['charge'],
        queue: '',
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'register.queue must be a non-empty string' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: ['charge'],
        deploymentName: '',
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'register.deploymentName must be a non-empty string when present' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: ['charge'],
        startedAt: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'register.startedAt must be a finite number when present' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 2,
        workerId: 'worker-1',
        activities: ['charge'],
        capabilities: { notJson: Symbol('bad') },
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'register.capabilities must be a JSON object when present' },
    });

    expect(parseWorkerToServerMessage({ type: 'heartbeat', workerId: '' })).toMatchObject({
      ok: false,
      error: { message: 'heartbeat.workerId must be a non-empty string' },
    });
  });

  it('rejects every optional register identity field when present but malformed', () => {
    // Pins the rejection message for each optional identity field on register.
    // Without this regression, a refactor of the field-validation table could
    // silently drop one of these guards.
    const base = {
      type: 'register',
      protocolVersion: 2,
      workerId: 'worker-1',
      activities: ['charge'],
    } as const;

    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ['buildId', '', 'register.buildId must be a non-empty string when present'],
      ['runtimeVersion', '', 'register.runtimeVersion must be a non-empty string when present'],
      ['gitSha', '', 'register.gitSha must be a non-empty string when present'],
      ['deploymentName', 42, 'register.deploymentName must be a non-empty string when present'],
    ];

    for (const [field, badValue, expectedMessage] of cases) {
      expect(parseWorkerToServerMessage({ ...base, [field]: badValue })).toMatchObject({
        ok: false,
        error: { message: expectedMessage },
      });
    }
  });

  it('round-trips every documented optional field through register, task, and taskResult', () => {
    // Trust-boundary regression: each documented optional field on the three
    // parsed message kinds must survive an unknown -> typed round trip without
    // mutation, and the parser must not introduce or drop properties.
    const registerInput = {
      type: 'register',
      protocolVersion: 2,
      workerId: 'worker-1',
      activities: ['charge', 'refund'],
      concurrency: 8,
      queue: 'billing',
      deploymentName: 'production-2026-05',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.3.13',
      gitSha: '0123456789abcdef',
      startedAt: 1_700_000_000,
      capabilities: { region: 'us-west', gpu: false },
    } as const;
    const registerResult = parseWorkerToServerMessage(registerInput);
    expect(registerResult).toMatchObject({ ok: true, message: registerInput });

    const taskInput = {
      type: 'task',
      operationId: 'op-1',
      attemptToken: 'attempt-token',
      activityName: 'charge',
      input: { amount: 42, memo: null },
      attempt: 3,
      headers: { 'x-correlation-id': 'corr-1' },
    } as const;
    const taskResult = parseServerToWorkerMessage(taskInput);
    expect(taskResult).toMatchObject({ ok: true, message: taskInput });

    const cancelledInput = {
      type: 'taskResult',
      operationId: 'op-2',
      attemptToken: 'attempt-token-2',
      status: 'cancelled',
      error: 'Task cancelled by client',
      cancelled: true,
    } as const;
    const cancelledResult = parseWorkerToServerMessage(cancelledInput);
    expect(cancelledResult).toMatchObject({ ok: true, message: cancelledInput });

    const completedInput = {
      type: 'taskResult',
      operationId: 'op-3',
      attemptToken: 'attempt-token-3',
      status: 'completed',
      value: { ok: true, attempts: 1 },
    } as const;
    expect(parseWorkerToServerMessage(completedInput)).toMatchObject({
      ok: true,
      message: completedInput,
    });

    const failedInput = {
      type: 'taskResult',
      operationId: 'op-4',
      attemptToken: 'attempt-token-4',
      status: 'failed',
      error: 'upstream timeout',
    } as const;
    expect(parseWorkerToServerMessage(failedInput)).toMatchObject({
      ok: true,
      message: failedInput,
    });
  });

  it('rejects malformed task results and unknown worker message types', () => {
    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'completed',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_message' },
    });

    expect(parseWorkerToServerMessage({ type: 'typo' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_message_type' },
    });
  });

  it('parses failed and cancelled task results with strict error metadata', () => {
    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'failed',
        error: 'failed',
        attemptToken: 'attempt-token',
      }),
    ).toEqual({
      ok: true,
      message: {
        type: 'taskResult',
        operationId: 'op-1',
        status: 'failed',
        error: 'failed',
        attemptToken: 'attempt-token',
      },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'cancelled',
        error: 'cancelled',
        cancelled: true,
        attemptToken: 'attempt-token',
      }),
    ).toEqual({
      ok: true,
      message: {
        type: 'taskResult',
        operationId: 'op-1',
        status: 'cancelled',
        error: 'cancelled',
        cancelled: true,
        attemptToken: 'attempt-token',
      },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: '',
        status: 'completed',
        value: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'taskResult.operationId must be a non-empty string' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'failed',
        error: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'failed taskResult.error must be a string' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'cancelled',
        error: 'cancelled',
        cancelled: false,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'taskResult.cancelled must be true when present' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'cancelled',
        error: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'cancelled taskResult.error must be a string' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'pending',
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'taskResult.status must be completed, failed, or cancelled' },
    });
  });

  it('rejects a taskResult whose echoed attemptToken is present but not a non-empty string', () => {
    // The required attemptToken echo is validated as a non-empty string. The
    // same `parseEchoedAttemptToken` guard runs for all three status variants, so
    // pin every variant rather than trusting the shared helper.
    const variants = [
      { status: 'completed', value: null },
      { status: 'failed', error: 'boom' },
      { status: 'cancelled', error: 'boom' },
    ] as const;
    for (const variant of variants) {
      for (const badToken of [42, '', null]) {
        expect(
          parseWorkerToServerMessage({
            type: 'taskResult',
            operationId: 'op-1',
            ...variant,
            attemptToken: badToken,
          }),
        ).toMatchObject({
          ok: false,
          error: { message: 'taskResult.attemptToken must be a non-empty string' },
        });
      }
    }
  });

  it('parses server-to-worker acknowledgement, task, cancel, shutdown, and errors', () => {
    expect(
      parseServerToWorkerMessage({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: 'worker-1',
        queue: 'default',
        activities: ['charge'],
        concurrency: 1,
      }),
    ).toMatchObject({ ok: true, message: { type: 'registerAck' } });

    expect(
      parseServerToWorkerMessage({
        type: 'task',
        operationId: 'op-1',
        attemptToken: 'attempt-token',
        activityName: 'charge',
        input: [{ amount: 42 }, null, ['ok']],
        headers: { traceparent: 'trace' },
      }),
    ).toMatchObject({ ok: true, message: { type: 'task' } });

    expect(parseServerToWorkerMessage({ type: 'cancel', operationId: 'op-1' })).toMatchObject({
      ok: true,
      message: { type: 'cancel' },
    });
    expect(parseServerToWorkerMessage({ type: 'shutdown' })).toMatchObject({
      ok: true,
      message: { type: 'shutdown' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerError',
        code: 'unsupported_protocol_version',
        message: 'nope',
        supportedProtocolVersions: [2],
      }),
    ).toMatchObject({ ok: true, message: { type: 'registerError' } });
    expect(
      parseServerToWorkerMessage({
        type: 'protocolError',
        code: 'invalid_json',
        message: 'nope',
      }),
    ).toMatchObject({ ok: true, message: { type: 'protocolError' } });
  });

  it('rejects malformed worker protocol envelopes before message-specific validation', () => {
    expect(parseWorkerToServerMessage(null)).toMatchObject({
      ok: false,
      error: { message: 'Worker protocol message must be a JSON object' },
    });
    expect(parseWorkerToServerMessage({ type: null })).toMatchObject({
      ok: false,
      error: { message: 'Worker protocol message.type must be a string' },
    });
  });

  it('rejects malformed server task, cancel, acknowledgement, and error messages', () => {
    expect(parseServerToWorkerMessage(null)).toMatchObject({
      ok: false,
      error: { message: 'Server protocol message must be a JSON object' },
    });
    expect(parseServerToWorkerMessage({ type: null })).toMatchObject({
      ok: false,
      error: { message: 'Server protocol message.type must be a string' },
    });
    expect(parseServerToWorkerMessage({ type: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_message_type' },
    });

    expect(parseWorkerToServerMessage(null)).toMatchObject({
      ok: false,
      error: { message: 'Worker protocol message must be a JSON object' },
    });
    expect(parseWorkerToServerMessage({ type: null })).toMatchObject({
      ok: false,
      error: { message: 'Worker protocol message.type must be a string' },
    });

    expect(parseServerToWorkerMessage({ type: 'task', operationId: '' })).toMatchObject({
      ok: false,
      error: { message: 'task.operationId must be a non-empty string' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'task',
        operationId: 'op-1',
        attemptToken: 'attempt-token',
        activityName: '',
        input: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'task.activityName must be a non-empty string' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'task',
        operationId: 'op-1',
        attemptToken: 'attempt-token',
        activityName: 'charge',
        input: Symbol('bad'),
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'task.input must be valid JSON' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'task',
        operationId: 'op-1',
        attemptToken: 'attempt-token',
        activityName: 'charge',
        input: null,
        attempt: Number.NaN,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'task.attempt must be a finite number' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'task',
        operationId: 'op-1',
        attemptToken: 'attempt-token',
        activityName: 'charge',
        input: null,
        headers: { traceparent: 123 },
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'task.headers must be a string map' },
    });

    expect(parseServerToWorkerMessage({ type: 'cancel', operationId: '' })).toMatchObject({
      ok: false,
      error: { message: 'cancel.operationId must be a non-empty string' },
    });

    expect(
      parseServerToWorkerMessage({
        type: 'registerAck',
        protocolVersion: 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerAck.protocolVersion must be 2' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: '',
        queue: 'default',
        activities: [],
        concurrency: 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerAck.workerId must be a non-empty string' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: 'worker-1',
        queue: '',
        activities: [],
        concurrency: 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerAck.queue must be a non-empty string' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: 'worker-1',
        queue: 'default',
        activities: [''],
        concurrency: 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerAck.activities must be a string array' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: 'worker-1',
        queue: 'default',
        activities: [],
        concurrency: Number.NaN,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerAck.concurrency must be a finite number' },
    });

    expect(
      parseServerToWorkerMessage({
        type: 'registerError',
        code: 'nope',
        message: 'nope',
        supportedProtocolVersions: [2],
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerError.code is not recognized' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerError',
        code: 'invalid_registration',
        message: null,
        supportedProtocolVersions: [2],
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerError.message must be a string' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerError',
        code: 'invalid_registration',
        message: 'nope',
        supportedProtocolVersions: [1],
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerError.supportedProtocolVersions is invalid' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerError',
        code: 'invalid_registration',
        message: 'nope',
        supportedProtocolVersions: [2],
        requestedProtocolVersion: Number.NaN,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'registerError.requestedProtocolVersion must be a finite number' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerError',
        code: 'invalid_registration',
        message: 'nope',
        supportedProtocolVersions: [2],
        requestedProtocolVersion: 1,
      }),
    ).toMatchObject({
      ok: true,
      message: { requestedProtocolVersion: 1 },
    });

    expect(
      parseServerToWorkerMessage({
        type: 'protocolError',
        code: 'nope',
        message: 'bad',
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'protocolError.code is not recognized' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'protocolError',
        code: 'invalid_message',
        message: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'protocolError.message must be a string' },
    });
  });

  it('keeps the defensive server parser default reachable under a widened type set', () => {
    const originalSetHas = Set.prototype.has;
    // oxlint-disable-next-line no-extend-native -- Test-only branch forcing for the defensive default.
    Set.prototype.has = function has(this: Set<unknown>, value: unknown): boolean {
      return value === 'acceptedByPatchedSet' || originalSetHas.call(this, value);
    } as typeof Set.prototype.has;

    try {
      expect(parseServerToWorkerMessage({ type: 'acceptedByPatchedSet' })).toMatchObject({
        ok: false,
        error: { code: 'unknown_message_type' },
      });
    } finally {
      // oxlint-disable-next-line no-extend-native -- Restoring the patched prototype after the test.
      Set.prototype.has = originalSetHas;
    }
  });

  it('keeps the documented message catalog aligned with exported schemas', async () => {
    const documentation = await Bun.file(
      'documentation/reference/remote-worker-protocol.md',
    ).text();
    const documentedMessages = [...documentation.matchAll(/^#### `([^`]+)`/gm)].map(
      (match) => match[1],
    );

    expect(documentedMessages).toEqual(Object.keys(REMOTE_WORKER_MESSAGE_SCHEMAS));

    expect(documentation).toContain(
      `- **Protocol version**: v${String(REMOTE_WORKER_PROTOCOL_VERSION)}.`,
    );
    expect(documentation).toContain(`"protocolVersion": ${String(REMOTE_WORKER_PROTOCOL_VERSION)}`);
    expect(documentation).toContain(
      `"supportedProtocolVersions": [${REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS.join(', ')}]`,
    );

    const apiWorkers = await Bun.file('documentation/reference/api-workers.md').text();
    expect(apiWorkers).toContain(`sends a v${String(REMOTE_WORKER_PROTOCOL_VERSION)} registration`);

    const remoteWorkersGuide = await Bun.file('documentation/guides/remote-workers.md').text();
    expect(remoteWorkersGuide).toContain(
      `The v${String(REMOTE_WORKER_PROTOCOL_VERSION)} task transport`,
    );
    expect(remoteWorkersGuide).toContain(
      `sends a v${String(REMOTE_WORKER_PROTOCOL_VERSION)} \`register\` message`,
    );

    const architectureDecision = await Bun.file(
      'documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md',
    ).text();
    expect(architectureDecision).toContain(
      `v${String(REMOTE_WORKER_PROTOCOL_VERSION)} requires \`register.protocolVersion: ${String(REMOTE_WORKER_PROTOCOL_VERSION)}\``,
    );
  });
});
