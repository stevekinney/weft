import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { handleJsonRpcHttpRequest } from '../json-rpc-http.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { anonymousPrincipal } from '../principal.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.test-support.ts';
import { updateScheduleOperation, updateScheduleRestBinding } from './update-schedule.ts';

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

const registry = createOperationRegistry([updateScheduleOperation]);
const bindings = [updateScheduleRestBinding];

describe('weft.schedules.update', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 204 and updates the cron expression on the happy path', async () => {
    engine = createEngine();
    await engine.schedule('echo', { immutable: true }, '0 * * * *', {
      id: 'schedule-update',
      description: 'Original description',
      overlap: 'queue',
      backfill: true,
      jitter: '10s',
    });

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update', {
        cronExpression: '30 * * * *',
        description: 'Updated description',
        overlap: 'allow',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await engine.getSchedule('schedule-update')).toEqual(
      expect.objectContaining({
        id: 'schedule-update',
        workflowType: 'echo',
        cronExpression: '30 * * * *',
        description: 'Updated description',
        overlap: 'allow',
        backfill: true,
        jitterMs: 10_000,
      }),
    );
  });

  it('updates mutable options over JSON-RPC with the same contract as REST', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', {
      id: 'schedule-update-json-rpc',
      description: 'Original description',
      overlap: 'skip',
      backfill: false,
    });

    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'weft.schedules.update',
          params: {
            scheduleId: 'schedule-update-json-rpc',
            every: '5m',
            description: 'Updated over JSON-RPC',
            overlap: 'cancel-running',
            backfill: true,
            jitter: '30s',
          },
        }),
      }),
      { registry, engine, principal: anonymousPrincipal() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: null });
    expect(await engine.getSchedule('schedule-update-json-rpc')).toEqual(
      expect.objectContaining({
        intervalMs: 300_000,
        description: 'Updated over JSON-RPC',
        overlap: 'cancel-running',
        backfill: true,
        jitterMs: 30_000,
      }),
    );
  });

  it('returns 400 when description is null instead of treating it as omitted', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', {
      id: 'schedule-update-null-description',
      description: 'Keep me',
    });

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update-null-description', {
        cronExpression: '30 * * * *',
        description: null,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "description" must be a string',
    });
    expect(await engine.getSchedule('schedule-update-null-description')).toEqual(
      expect.objectContaining({
        cronExpression: '0 * * * *',
        description: 'Keep me',
      }),
    );
  });

  it('returns 400 for invalid mutable schedule options', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'schedule-update-invalid-options' });

    const invalidOptions: ReadonlyArray<{
      field: string;
      value: unknown;
      error: string;
    }> = [
      {
        field: 'overlap',
        value: 'parallel',
        error: 'Field "overlap" must be one of skip, queue, cancel-running, allow',
      },
      {
        field: 'backfill',
        value: 'yes',
        error: 'Field "backfill" must be a boolean',
      },
      {
        field: 'jitter',
        value: null,
        error: 'Field "jitter" must be a duration string or a number of milliseconds',
      },
      {
        field: 'jitter',
        value: 'soon',
        error:
          'Field "jitter" is invalid: Invalid duration string: "soon". Expected a number or a string like "30s", "5 minutes", "1 hour", etc.',
      },
      {
        field: 'jitter',
        value: -1,
        error:
          'Field "jitter" is invalid: Duration must resolve to a finite, non-negative number of milliseconds, got: -1',
      },
      {
        field: 'jitter',
        value: 0,
        error: 'Field "jitter" must resolve to a positive number of milliseconds',
      },
      {
        field: 'jitter',
        value: '0s',
        error: 'Field "jitter" must resolve to a positive number of milliseconds',
      },
    ];

    for (const invalidOption of invalidOptions) {
      const response = await handleRequest(
        jsonRequest('PATCH', '/v1/schedules/schedule-update-invalid-options', {
          cronExpression: '30 * * * *',
          [invalidOption.field]: invalidOption.value,
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: invalidOption.error });
    }

    expect(await engine.getSchedule('schedule-update-invalid-options')).toEqual(
      expect.objectContaining({ cronExpression: '0 * * * *' }),
    );
  });

  it('returns InvalidParams over JSON-RPC for a malformed jitter duration', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', {
      id: 'schedule-update-invalid-json-rpc-jitter',
    });

    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'weft.schedules.update',
          params: {
            scheduleId: 'schedule-update-invalid-json-rpc-jitter',
            cronExpression: '30 * * * *',
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

  it('uses the wire field name for zero jitter over JSON-RPC', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', {
      id: 'schedule-update-zero-json-rpc-jitter',
    });

    for (const jitter of [0, '0s']) {
      const response = await handleJsonRpcHttpRequest(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'weft.schedules.update',
            params: {
              scheduleId: 'schedule-update-zero-json-rpc-jitter',
              cronExpression: '30 * * * *',
              jitter,
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
          message: 'Field "jitter" must resolve to a positive number of milliseconds',
        }),
      });
    }
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    engine = createEngine();

    const response = await handleRequest(
      invalidJsonRequest('PATCH', '/v1/schedules/schedule-update', '{'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 when the request body is JSON null', async () => {
    // `null` is rejected (typeof 'object' && === null
    // fails the guard) with "Request body must be a JSON object".
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update', null),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 with "Missing required field: cronExpression or every" when body is a JSON array', async () => {
    // arrays are typeof 'object' && !== null, so they pass
    // the body-shape guard and fall through to the cadence check.
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing required field: cronExpression or every',
    });
  });

  it('returns 404 when the schedule does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/missing-schedule', { cronExpression: '30 * * * *' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Schedule "missing-schedule" not found',
      data: { resource: 'schedule', identifier: 'missing-schedule' },
    });
  });

  it('returns 409 when the engine reports a conflict', async () => {
    engine = createEngine();
    const originalUpdateSchedule = engine.updateSchedule.bind(engine);

    try {
      engine.updateSchedule = async () => {
        throw new Error('Schedule already exists');
      };

      const response = await handleRequest(
        jsonRequest('PATCH', '/v1/schedules/schedule-update', { cronExpression: '30 * * * *' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'Schedule already exists' });
    } finally {
      engine.updateSchedule = originalUpdateSchedule;
    }
  });

  it('returns 400 when the cron expression is invalid', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'schedule-update-invalid-cron' });

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update-invalid-cron', {
        cronExpression: 'not-a-cron',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Cron'),
      }),
    );
  });

  it('returns 400 when the interval expression is invalid', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'schedule-update-invalid-interval' });

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update-invalid-interval', {
        every: 'not-a-duration',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('interval'),
      }),
    );
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    engine = createEngine();
    const originalUpdateSchedule = engine.updateSchedule.bind(engine);

    try {
      engine.updateSchedule = async () => {
        throw new Error('update schedule exploded');
      };

      const response = await handleRequest(
        jsonRequest('PATCH', '/v1/schedules/schedule-update', { cronExpression: '30 * * * *' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.updateSchedule = originalUpdateSchedule;
    }
  });
});
