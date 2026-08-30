/**
 * `weft.schedules.list` operation + REST binding — unit tests.
 *
 * Covers:
 * - Happy path returns paginated schedule list.
 * - Invalid status value returns 400.
 * - Valid status values are accepted.
 * - Limit capped at 1000 (no error for large values).
 * - Offset must be non-negative.
 * - Unauthenticated principal returns Unauthorized.
 * - EngineFailure fault shaper returns 500.
 *
 * REST tests inject an authContext with an api-key principal so the
 * `access:authenticated` check passes.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  createListSchedulesApiKeyAuthContext,
  createListSchedulesTestEngine,
  listSchedulesTestRegistry,
} from './list-schedules.test-support.ts';
import { listSchedulesOperation, listSchedulesRestBinding } from './list-schedules.ts';

describe('weft.schedules.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns a paginated list of schedules on the happy path', async () => {
    engine = createListSchedulesTestEngine();
    await engine.schedule('echo', { x: 1 }, '0 * * * *', { id: 'sched-a' });
    await engine.schedule('echo', { x: 2 }, '30 * * * *', { id: 'sched-b' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules', { method: 'GET' }),
      engine,
      {
        operationRegistry: listSchedulesTestRegistry,
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as {
      items?: Array<{ id: string }>;
      total?: number;
      limit?: number;
      offset?: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items?.map((s) => s.id).toSorted()).toEqual(['sched-a', 'sched-b']);
    expect(typeof body.total).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });

  it('registers an executable echo workflow in the test engine', async () => {
    engine = createListSchedulesTestEngine();

    const handle = await engine.start('echo', { ok: true });

    await expect(handle.result()).resolves.toEqual({ ok: true });
  });

  it('returns 400 when the status query param is not valid', async () => {
    engine = createListSchedulesTestEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?status=INVALID', { method: 'GET' }),
      engine,
      {
        operationRegistry: listSchedulesTestRegistry,
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('status');
  });

  it('rejects non-string workflowType values via executeOperation', async () => {
    engine = createListSchedulesTestEngine();

    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'svc', scopes: [] });

    const result = await executeOperation(
      'weft.schedules.list',
      { workflowType: 42 },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid workflowType fault');
    expect(result.fault.code).toBe('InvalidParams');
    expect(result.fault.message).toBe('Query parameter "workflowType" must be a string');
  });

  it('accepts valid status values: active, paused, cancelled', async () => {
    engine = createListSchedulesTestEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'active-sched' });

    for (const status of ['active', 'paused', 'cancelled']) {
      const response = await handleRequest(
        new Request(`http://localhost/v1/schedules?status=${status}`, { method: 'GET' }),
        engine,
        {
          operationRegistry: listSchedulesTestRegistry,
          restBindings: [listSchedulesRestBinding],
          ...createListSchedulesApiKeyAuthContext(),
        },
      );
      expect(response.status).toBe(200);
    }
  });

  it('caps limit at 1000 internally without returning an error', async () => {
    engine = createListSchedulesTestEngine();

    // limit=9999 should be silently clamped to 1000 — not rejected.
    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?limit=9999', { method: 'GET' }),
      engine,
      {
        operationRegistry: listSchedulesTestRegistry,
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { limit?: number };
    expect(typeof body.limit).toBe('number');
  });

  it('returns 400 when limit is not a positive integer', async () => {
    engine = createListSchedulesTestEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?limit=0', { method: 'GET' }),
      engine,
      {
        operationRegistry: listSchedulesTestRegistry,
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(400);
  });

  it('returns 400 when offset is negative', async () => {
    engine = createListSchedulesTestEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?offset=-1', { method: 'GET' }),
      engine,
      {
        operationRegistry: listSchedulesTestRegistry,
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(400);
  });

  it('rejects an unauthenticated principal with Unauthorized', async () => {
    engine = createListSchedulesTestEngine();

    const liveRegistry = createLiveOperationRegistry();
    const result = await executeOperation(
      'weft.schedules.list',
      {},
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
    engine = createListSchedulesTestEngine();

    const failingOperation = {
      ...listSchedulesOperation,
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
      new Request('http://localhost/v1/schedules', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('shapes Unauthorized faults as 401', async () => {
    engine = createListSchedulesTestEngine();

    const unauthorizedOperation = {
      ...listSchedulesOperation,
      invoke: async () => {
        throw {
          code: 'Unauthorized',
          message: 'missing credentials',
          data: { reason: 'missing credentials' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([unauthorizedOperation]),
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'missing credentials' });
  });

  it('uses the fallback HTTP mapper for non-special-cased faults', async () => {
    engine = createListSchedulesTestEngine();

    const conflictOperation = {
      ...listSchedulesOperation,
      invoke: async () => {
        throw {
          code: 'Conflict',
          message: 'schedule conflict',
          data: { reason: 'schedule conflict' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([conflictOperation]),
        restBindings: [listSchedulesRestBinding],
        ...createListSchedulesApiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'schedule conflict' });
  });
});
