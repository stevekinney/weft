import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { tenantFromInputField } from '../../core/tenant.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest, type HandlerOptions } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.ts';
import { updateScheduleOperation, updateScheduleRestBinding } from './update-schedule.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

function createTenantAwareEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
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
    await engine.schedule('echo', null, '0 * * * *', { id: 'schedule-update' });

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update', { cronExpression: '30 * * * *' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await engine.getSchedule('schedule-update')).toEqual(
      expect.objectContaining({ cronExpression: '30 * * * *' }),
    );
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
    // Legacy `handleUpdateSchedule` rejected `null` (typeof 'object' && === null
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

  it('returns 400 with "Missing required field: cronExpression" when body is a JSON array', async () => {
    // Legacy parity: arrays are typeof 'object' && !== null, so they pass
    // the body-shape guard and fall through to the cronExpression check.
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-update', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: cronExpression' });
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
      jsonRequest('PATCH', '/v1/schedules/schedule-update', { cronExpression: '30 * * * *' }),
      engine,
      options,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim',
    });
  });

  it('returns 404 when a JWT-authenticated caller updates another tenant’s schedule', async () => {
    engine = createTenantAwareEngine();
    await engine.schedule('echo', { tenantId: 'globex' }, '0 * * * *', { id: 'schedule-globex' });

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/schedule-globex', { cronExpression: '30 * * * *' }),
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

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Schedule "schedule-globex" not found' });
  });

  it('returns 404 when the schedule does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('PATCH', '/v1/schedules/missing-schedule', { cronExpression: '30 * * * *' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Schedule "missing-schedule" not found' });
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

  it('returns the raw engine error message on unexpected failures', async () => {
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
      expect(await response.json()).toEqual({ error: 'update schedule exploded' });
    } finally {
      engine.updateSchedule = originalUpdateSchedule;
    }
  });
});
