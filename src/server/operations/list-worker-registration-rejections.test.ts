/**
 * `weft.workers.rejections` operation + REST binding — unit tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  createListWorkerRegistrationRejectionsOperation,
  createListWorkerRegistrationRejectionsRestBinding,
  listWorkerRegistrationRejectionsOperation,
} from './list-worker-registration-rejections.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

const binding = createListWorkerRegistrationRejectionsRestBinding();

describe('weft.workers.rejections — REST GET /v1/workers/registration-rejections', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns recorded rejections, newest first, with the default limit', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.recordRejection({
      code: 'invalid_registration',
      workerId: 'w-1',
      rejectedAt: 1,
      queue: 'default',
    });
    workerRegistry.recordRejection({
      code: 'deployment_conflict',
      workerId: 'w-2',
      rejectedAt: 2,
      deploymentName: 'payments',
      buildId: 'b1',
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/registration-rejections', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createListWorkerRegistrationRejectionsOperation({ workerRegistry }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      limit: number;
    };
    expect(body.limit).toBe(20);
    expect(body.items).toEqual([
      {
        code: 'deployment_conflict',
        workerId: 'w-2',
        rejectedAt: 2,
        deploymentName: 'payments',
        buildId: 'b1',
      },
      { code: 'invalid_registration', workerId: 'w-1', rejectedAt: 1, queue: 'default' },
    ]);
  });

  it('respects an explicit limit query parameter', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.recordRejection({ code: 'invalid_registration', rejectedAt: 1 });
    workerRegistry.recordRejection({ code: 'invalid_registration', rejectedAt: 2 });
    workerRegistry.recordRejection({ code: 'invalid_registration', rejectedAt: 3 });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/registration-rejections?limit=2', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createListWorkerRegistrationRejectionsOperation({ workerRegistry }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; limit: number };
    expect(body.limit).toBe(2);
    expect(body.items).toHaveLength(2);
  });

  it('returns an empty list when nothing has been rejected', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/registration-rejections', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createListWorkerRegistrationRejectionsOperation({ workerRegistry }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], limit: 20 });
  });

  it('rejects unauthenticated callers with 401', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.workers.rejections',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });

  it('rejects callers without system:read with 403', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsInsufficientScope({
      operationName: 'weft.workers.rejections',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });
});

describe('weft.workers.rejections — operation behavior', () => {
  it('throws when invoked from a discovery-only registry (no WorkerRegistry wired in)', async () => {
    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.workers.rejections',
        {},
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([listWorkerRegistrationRejectionsOperation]),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('EngineFailure');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('rejects an out-of-range limit over JSON-RPC', async () => {
    const engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    try {
      const result = await executeOperation(
        'weft.workers.rejections',
        { limit: 0 },
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([
            createListWorkerRegistrationRejectionsOperation({ workerRegistry }),
          ]),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('InvalidParams');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
