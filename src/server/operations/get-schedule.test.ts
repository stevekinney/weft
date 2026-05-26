/**
 * `weft.schedules.get` operation + REST binding — unit tests.
 *
 * Covers:
 * - Happy path returns the schedule summary.
 * - Missing schedule returns 404.
 * - Authenticated principal (api-key) can access the schedule.
 * - Unauthenticated principal returns Unauthorized.
 * - EngineFailure fault shaper returns 500.
 *
 * REST tests inject an authContext with an api-key principal so the
 * `access:authenticated` check passes.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { getScheduleOperation, getScheduleRestBinding } from './get-schedule.ts';

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

/** AuthContext for handleRequest that satisfies the access:authenticated check via api-key. */
function apiKeyAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: [] }),
    },
  };
}

const registry = createOperationRegistry([getScheduleOperation]);

describe('weft.schedules.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the schedule summary on the happy path (api-key principal)', async () => {
    engine = createEngine();
    await engine.schedule('echo', { payload: 'alpha' }, '0 * * * *', { id: 'schedule-alpha' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-alpha', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { id?: string; workflowType?: string };
    expect(body.id).toBe('schedule-alpha');
    expect(body.workflowType).toBe('echo');
  });

  it('returns 404 when the schedule does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/does-not-exist', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Schedule "does-not-exist" not found' });
  });

  it('allows an authenticated principal (api-key) to access the schedule', async () => {
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'apikey-schedule' });

    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'svc', scopes: [] });

    const result = await executeOperation(
      'weft.schedules.get',
      { scheduleId: 'apikey-schedule' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const schedule = result.value as { id?: string };
    expect(schedule.id).toBe('apikey-schedule');
  });

  it('rejects an unauthenticated principal with Unauthorized', async () => {
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'any-schedule' });

    const liveRegistry = createLiveOperationRegistry();
    const result = await executeOperation(
      'weft.schedules.get',
      { scheduleId: 'any-schedule' },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('maps EngineFailure faults to 500 with "Internal server error"', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getScheduleOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/some-schedule', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('shapes Unauthorized faults as 401', async () => {
    engine = createEngine();

    const unauthorizedOperation = {
      ...getScheduleOperation,
      invoke: async () => {
        throw {
          code: 'Unauthorized',
          message: 'missing credentials',
          data: { reason: 'missing credentials' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/some-schedule', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([unauthorizedOperation]),
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'missing credentials' });
  });

  it('uses the fallback HTTP mapper for non-special-cased faults', async () => {
    engine = createEngine();

    const conflictOperation = {
      ...getScheduleOperation,
      invoke: async () => {
        throw {
          code: 'Conflict',
          message: 'schedule conflict',
          data: { reason: 'schedule conflict' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/some-schedule', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([conflictOperation]),
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'schedule conflict' });
  });
});
