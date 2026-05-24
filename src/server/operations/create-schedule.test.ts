import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { tenantFromInputField } from '../../core/tenant.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest, type HandlerOptions } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
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

function createTenantAwareEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  });
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
        overlap: 'queue',
        backfill: true,
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
        cronExpression: '0 * * * *',
        overlap: 'queue',
        backfill: true,
      }),
    );
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

  it('returns 403 when a JWT-authenticated request is missing a tenant claim', async () => {
    engine = createTenantAwareEngine();
    const options: HandlerOptions = {
      authContext: {
        method: 'jwt',
        claims: { sub: 'user-123' },
      },
      operationRegistry: registry,
      restBindings: bindings,
    };

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        cronExpression: '0 * * * *',
      }),
      engine,
      options,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim',
    });
  });

  it('returns 403 when the schedule input targets a different tenant', async () => {
    engine = createTenantAwareEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/schedules', {
        type: 'echo',
        input: { tenantId: 'globex', payload: 'tenant-b' },
        cronExpression: '0 * * * *',
        id: 'schedule-globex',
      }),
      engine,
      {
        authContext: {
          method: 'jwt',
          claims: { tenantId: 'acme' },
        },
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Schedule creation is limited to the authenticated tenant',
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
      expect(await response.json()).toEqual({ error: 'Schedule "missing-schedule" not found' });
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
