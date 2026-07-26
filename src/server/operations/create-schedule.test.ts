import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { handleJsonRpcHttpRequest } from '../json-rpc-http.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { anonymousPrincipal } from '../principal.ts';
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
    expect(await response.json()).toEqual({ error: 'Field "description" must be a string' });
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
    expect(await response.json()).toEqual({ error });
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
      { registry, engine, principal: anonymousPrincipal() },
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
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
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
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
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
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
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
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.schedule = originalSchedule;
    }
  });
});
