import { afterEach, describe, expect, it } from 'bun:test';
import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';

import { principalFromUnauthenticatedLocal } from "../../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  handleJsonRpcHttpRequest,
} from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { DynamicWorkflowSourceUnavailableError } from '../../core/engine/dynamic-source-errors.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { createScheduleOperation, createScheduleRestBinding } from './create-schedule.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.test-support.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

/** The time zone a stored schedule is read in. */
async function zoneOf(engine: Engine, scheduleId: string): Promise<string | undefined> {
  const summary = await engine.getSchedule(scheduleId);
  return summary?.timeZone;
}

const registry = createOperationRegistry([createScheduleOperation]);
const bindings = [createScheduleRestBinding];

describe('weft.schedules.create', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 201 and creates the schedule on the happy path', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        input: { payload: 'nightly' },
        cronExpression: '0 * * * *',
        id: 'nightly-maintenance',
        description: 'Run nightly maintenance',
        overlap: 'queue',
        backfill: true,
        jitter: '30s',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'nightly-maintenance' });
    expect(await engine.getSchedule('nightly-maintenance')).toEqual(
      expect.objectContaining({
        id: 'nightly-maintenance',
        workflowType: 'echo',
        description: 'Run nightly maintenance',
        cronExpression: '0 * * * *',
        overlap: 'queue',
        backfill: true,
        jitterMs: 30_000,
      }),
    );
  });

  it('creates a schedule in the time zone it names, and in UTC when it names none', async () => {
    engine = createEngine();

    const zoned = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 9 * * 1-5',
        id: 'weekday-mornings',
        timeZone: 'America/Los_Angeles',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    const plain = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 9 * * 1-5',
        id: 'weekday-mornings-utc',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect([zoned.status, plain.status]).toEqual([201, 201]);
    expect(await zoneOf(engine, 'weekday-mornings')).toBe('America/Los_Angeles');
    expect(await zoneOf(engine, 'weekday-mornings-utc')).toBe('UTC');
  });

  it('returns 400 for a time zone the runtime does not know, over REST and JSON-RPC', async () => {
    engine = createEngine();

    for (const timeZone of ['Mars/Olympus', '', 7]) {
      const response = await handleRequest(
        jsonRequest('POST', '/v1/schedules', {
          type: 'echo',
          cronExpression: '0 * * * *',
          id: 'bad-zone',
          timeZone,
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          'Field "timeZone" must be an IANA time zone name such as "America/Los_Angeles", or "UTC"',
        retryable: false,
      });
    }
    expect(await engine.getSchedule('bad-zone')).toBeNull();
  });

  it('returns 400 for a time zone on an interval schedule', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        every: '5m',
        id: 'interval-zone',
        timeZone: 'America/Los_Angeles',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await engine.getSchedule('interval-zone')).toBeNull();
  });

  it('keeps create-only fields beside shared schedule fields', async () => {
    const input = {
      type: 'echo',
      input: { payload: 'create-only' },
      every: '5m',
      id: 'create-only-fields',
    };
    const request = jsonRequest('POST', '/v1/schedules', input);

    const extracted = await createScheduleRestBinding.extractInput(request, {}, {});

    expect(extracted).toEqual(input);
  });

  it('stores the metadata it is given and returns 400 for metadata that is not a plain JSON object', async () => {
    engine = createEngine();

    const created = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        id: 'with-metadata',
        metadata: { owner: { kind: 'user', id: 'ada' } },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(created.status).toBe(201);
    const stored = await engine.getSchedule('with-metadata');
    expect(stored?.metadata).toEqual({ owner: { kind: 'user', id: 'ada' } });

    for (const metadata of ['ada', 7, ['a'], null]) {
      const response = await handleRequest(
        jsonRequest('POST', '/v1/schedules', {
          type: 'echo',
          cronExpression: '0 * * * *',
          id: 'bad-metadata',
          metadata,
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Field "metadata" must be a plain JSON object',
        retryable: false,
      });
    }
    expect(await engine.getSchedule('bad-metadata')).toBeNull();
  });

  it('returns 400 when description is not a string', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        description: 42,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "description" must be a string',
      retryable: false,
    });
  });

  it('returns 400 when jitter is neither a duration string nor a number', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        jitter: false,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "jitter" must be a duration string or a number of milliseconds',
      retryable: false,
    });
  });

  it('returns 400 when both schedule cadence fields are supplied', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        every: '5m',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Provide exactly one of cronExpression or every, not both',
      retryable: false,
    });
  });

  it('returns 400 when every has an invalid type', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        every: false,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "every" must be a duration string or a number of milliseconds',
      retryable: false,
    });
  });

  it.each([
    [
      'soon',
      'Field "jitter" is invalid: Invalid duration string: "soon". Expected a number or a string like "30s", "5 minutes", "1 hour", etc.',
    ],
    [
      -1,
      'Field "jitter" is invalid: Duration must resolve to a finite, non-negative number of milliseconds, got: -1',
    ],
    [0, 'Field "jitter" must resolve to a positive number of milliseconds'],
    ['0s', 'Field "jitter" must resolve to a positive number of milliseconds'],
  ] as const)('returns 400 for invalid typed jitter %j', async (jitter, error) => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        jitter,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error, retryable: false });
  });

  it('returns InvalidParams over JSON-RPC for a malformed jitter duration', async () => {
    engine = createEngine();

    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'weft.schedules.create',
          params: {
            type: 'echo',
            cronExpression: '0 * * * *',
            jitter: 'soon',
          },
        }),
      }),
      {
        registry,
        host: engine,
        principal: principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: expect.objectContaining({
        code: -32602,
        message:
          'Field "jitter" is invalid: Invalid duration string: "soon". Expected a number or a string like "30s", "5 minutes", "1 hour", etc.',
      }),
    });
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    engine = createEngine();

    const response = await handleRequest(invalidJsonRequest('POST', '/v1/schedules', '{'), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body', retryable: false });
  });

  it('returns 400 when the request body is JSON null', async () => {
    // `null` is rejected (typeof 'object' && === null
    // fails the guard) with "Request body must be a JSON object".
    engine = createEngine();

    const response = await handleRequest(jsonRequest('POST', '/v1/schedules', null), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Request body must be a JSON object',
      retryable: false,
    });
  });

  it('returns 400 with "Missing required field: type" when body is a JSON array', async () => {
    // arrays are typeof 'object' && !== null, so they pass the
    // body-shape guard and fall through to the "type" required-field check.
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing required field: type',
      retryable: false,
    });
  });

  it('returns 400 when overlap is invalid', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        overlap: 'invalid',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "overlap" must be one of skip, queue, cancel-running, allow',
      retryable: false,
    });
  });

  it('returns 404 when the engine reports a not-found error', async () => {
    engine = createEngine();
    const originalSchedule = engine.schedule.bind(engine);

    try {
      engine.schedule = async () => {
        throw new Error('Schedule "missing-schedule" not found');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/schedules', {
          type: 'echo',
          cronExpression: '0 * * * *',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Schedule "missing-schedule" not found',
        data: { resource: 'schedule' },
        retryable: false,
      });
    } finally {
      engine.schedule = originalSchedule;
    }
  });

  it('returns 409 when the schedule id already exists', async () => {
    engine = createEngine();

    const firstResponse = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        id: 'duplicate-schedule',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(firstResponse.status).toBe(201);

    const secondResponse = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
        id: 'duplicate-schedule',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(secondResponse.status).toBe(409);
    expect((await secondResponse.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('already exists'),
      }),
    );
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    engine = createEngine();
    const originalSchedule = engine.schedule.bind(engine);

    try {
      engine.schedule = async () => {
        throw new Error('schedule exploded');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/schedules', {
          type: 'echo',
          cronExpression: '0 * * * *',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
    } finally {
      engine.schedule = originalSchedule;
    }
  });
});

const SENSITIVE_CAUSE = '/etc/secrets/token=abc123 unreadable';

const dynamicSourceCases = [
  {
    reason: 'load-failed' as const,
    build: () =>
      new DynamicWorkflowSourceUnavailableError(
        'echo',
        'r1',
        'load-failed',
        new Error(SENSITIVE_CAUSE),
      ),
    message: 'Dynamic workflow source "echo" revision "r1" failed to load.',
  },
  {
    reason: 'ambiguous-revision' as const,
    build: () => new DynamicWorkflowSourceUnavailableError('echo', undefined, 'ambiguous-revision'),
    message: undefined,
  },
];

describe('weft.schedules.create DynamicWorkflowSourceUnavailableError wire mapping', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  for (const testCase of dynamicSourceCases) {
    const expectedMessage = testCase.message ?? testCase.build().message;

    it(`returns REST 409 for reason ${testCase.reason}`, async () => {
      engine = createEngine();
      engine.schedule = async () => {
        throw testCase.build();
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/schedules', {
          type: 'echo',
          cronExpression: '0 * * * *',
          revisionPolicy: 'pinned',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      const text = await response.text();

      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toEqual({
        error: expectedMessage,
        weftCode: 'DynamicWorkflowSourceUnavailableError',
        retryable: false,
      });
      expect(text).not.toContain('/etc/secrets/token=abc123');
    });

    it(`returns JSON-RPC Conflict for reason ${testCase.reason}`, async () => {
      engine = createEngine();
      engine.schedule = async () => {
        throw testCase.build();
      };

      const response = await handleJsonRpcHttpRequest(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'weft.schedules.create',
            params: { type: 'echo', cronExpression: '0 * * * *', revisionPolicy: 'pinned' },
          }),
        }),
        {
          registry,
          host: engine,
          principal: principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY),
        },
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32021,
          message: expectedMessage,
          data: {
            reason: testCase.reason,
            weftCode: 'Conflict',
            httpStatus: 409,
            retryable: false,
          },
        },
      });
      expect(text).not.toContain('/etc/secrets/token=abc123');
    });
  }
});
