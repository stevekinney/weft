/**
 * `weft.workers.list` operation + REST binding — unit tests.
 *
 * Covers:
 * - REST GET succeeds with `system:read` and returns sorted-by-id workers,
 *   each with `availableCapacity`, `heartbeatAgeMs` derived from the
 *   injected clock, and a top-level `routingPolicy`.
 * - Authorization: 401 unauthenticated, 403 missing scope, 200 with scope.
 * - Discovery-only registry: `invoke` throws so a misconfigured server
 *   surfaces the error instead of silently returning bogus data.
 * - The operation reads the clock exactly once per request — proving the
 *   single-snapshot invariant.
 * - Unknown HTTP query keys are stripped without raising InvalidParams.
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
  createListWorkersOperation,
  createListWorkersRestBinding,
  listWorkersOperation,
} from './list-workers.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';
import {
  createClearDeploymentDrainOperation,
  createClearDeploymentDrainRestBinding,
  createClearWorkerDrainOperation,
  createClearWorkerDrainRestBinding,
  createDrainDeploymentOperation,
  createDrainDeploymentRestBinding,
  createDrainWorkerOperation,
  createDrainWorkerRestBinding,
} from './worker-drain.ts';

function systemAdminAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:admin'] }),
    },
  };
}

const binding = createListWorkersRestBinding();

describe('weft.workers.list — REST GET /v1/workers', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns a sorted-by-id list with derived capacity and heartbeat age', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'charlie',
      queue: 'default',
      activities: ['process'],
      concurrency: 3,
    });
    workerRegistry.register({
      id: 'alpha',
      queue: 'mail',
      activities: ['send'],
      concurrency: 2,
    });
    // Pin lastHeartbeat so the assertion against the injected clock is exact.
    workerRegistry.getWorker('alpha')!.lastHeartbeat = 1000;
    workerRegistry.getWorker('charlie')!.lastHeartbeat = 2500;
    workerRegistry.assignTask('charlie', 'op-1', 30_000, undefined, 'attempt-token');

    const FIXED_NOW = 5000;
    const operation = createListWorkersOperation({
      workerRegistry,
      clock: () => FIXED_NOW,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      routingPolicy: string;
    };
    expect(body.routingPolicy).toBe('least-loaded');
    expect(body.items.map((item) => item['id'])).toEqual(['alpha', 'charlie']);
    expect(body.items[0]).toMatchObject({
      id: 'alpha',
      queue: 'mail',
      activities: ['send'],
      concurrency: 2,
      inFlight: 0,
      availableCapacity: 2,
      lastHeartbeatAt: 1000,
      heartbeatAgeMs: 4000,
    });
    expect(body.items[1]).toMatchObject({
      id: 'charlie',
      inFlight: 1,
      availableCapacity: 2,
      heartbeatAgeMs: 2500,
    });
  });

  it('returns deployment identity, drain health, and deployment aggregate summaries', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'active-worker',
      queue: 'payments',
      activities: ['charge'],
      concurrency: 4,
      deploymentName: 'payments',
      buildId: 'build-1',
      runtimeVersion: 'bun-1.2.13',
      gitSha: 'abc',
      startedAt: 100,
      capabilities: { region: 'us-west' },
    });
    workerRegistry.register({
      id: 'draining-worker',
      queue: 'payments',
      activities: ['charge'],
      concurrency: 4,
      deploymentName: 'payments',
      buildId: 'build-1',
      runtimeVersion: 'bun-1.2.13',
      gitSha: 'abc',
      startedAt: 200,
    });
    workerRegistry.assignTask('draining-worker', 'op-draining', 30_000, undefined, 'attempt-token');
    workerRegistry.markWorkerDraining('draining-worker', {
      reason: 'host replacement',
      updatedAt: 1000,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createListWorkersOperation({ workerRegistry, clock: () => 5000 }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      deployments: Array<Record<string, unknown>>;
    };
    expect(body.items.find((worker) => worker['id'] === 'active-worker')).toMatchObject({
      deploymentName: 'payments',
      buildId: 'build-1',
      runtimeVersion: 'bun-1.2.13',
      gitSha: 'abc',
      startedAt: 100,
      capabilities: { region: 'us-west' },
      health: 'active',
    });
    expect(body.items.find((worker) => worker['id'] === 'draining-worker')).toMatchObject({
      health: 'draining',
    });
    expect(body.deployments).toEqual([
      expect.objectContaining({
        deploymentName: 'payments',
        buildId: 'build-1',
        health: 'draining',
        workers: 2,
        activeWorkers: 1,
        drainingWorkers: 1,
        inFlight: 1,
      }),
    ]);
  });

  it('strips unknown query keys without raising InvalidParams', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();

    const response = await handleRequest(
      new Request('http://localhost/v1/workers?weird=true&extra=value', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createListWorkersOperation({ workerRegistry, clock: () => 0 }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('rejects unauthenticated callers with 401', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.workers.list',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });

  it('rejects callers without system:read with 403', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsInsufficientScope({
      operationName: 'weft.workers.list',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });
});

describe('worker drain operations', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('marks and clears a worker drain over REST with system:admin', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
    });
    workerRegistry.assignTask('worker-1', 'in-flight', 30_000, undefined, 'attempt-token');

    const registry = createOperationRegistry([
      createDrainWorkerOperation({ workerRegistry, clock: () => 1000 }),
      createClearWorkerDrainOperation({ workerRegistry }),
    ]);
    const restBindings = [createDrainWorkerRestBinding(), createClearWorkerDrainRestBinding()];

    const drainResponse = await handleRequest(
      new Request('http://localhost/v1/workers/worker-1/drain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'maintenance' }),
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings,
        ...systemAdminAuthContext(),
      },
    );

    expect(drainResponse.status).toBe(200);
    expect(await drainResponse.json()).toEqual({
      target: 'worker',
      workerId: 'worker-1',
      affectedWorkers: 1,
      inFlight: 1,
      health: 'draining',
    });
    expect(workerRegistry.getWorkerSummaries(2000)[0]).toMatchObject({
      health: 'draining',
    });
    expect(workerRegistry.getWorker('worker-1')).toMatchObject({
      drainReason: 'maintenance',
      drainStartedAt: 1000,
    });

    const clearResponse = await handleRequest(
      new Request('http://localhost/v1/workers/worker-1/drain', { method: 'DELETE' }),
      engine,
      {
        operationRegistry: registry,
        restBindings,
        ...systemAdminAuthContext(),
      },
    );

    expect(clearResponse.status).toBe(200);
    expect(workerRegistry.getWorkerSummaries(3000)[0]?.health).toBe('active');
  });

  it('requires system:admin for worker drain mutations', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
    });

    const result = await executeOperation(
      'weft.workers.drain',
      { workerId: 'worker-1' },
      {
        principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([createDrainWorkerOperation({ workerRegistry })]),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('rejects unused resume reasons over JSON-RPC', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
      deploymentName: 'payments',
    });
    workerRegistry.markWorkerDraining('worker-1', { updatedAt: 1000 });
    workerRegistry.markDeploymentDraining('payments', { updatedAt: 1000 });

    const principal = principalFromApiKey({ subject: 'test', scopes: ['system:admin'] });
    const registry = createOperationRegistry([
      createClearWorkerDrainOperation({ workerRegistry }),
      createClearDeploymentDrainOperation({ workerRegistry }),
    ]);

    const workerResult = await executeOperation(
      'weft.workers.resume',
      { workerId: 'worker-1', reason: 'unused' },
      { principal, engine, transport: 'jsonRpcStdio', registry },
    );
    const deploymentResult = await executeOperation(
      'weft.worker.deployments.resume',
      { deploymentName: 'payments', reason: 'unused' },
      { principal, engine, transport: 'jsonRpcStdio', registry },
    );

    expect(workerResult.ok).toBe(false);
    if (workerResult.ok) throw new Error('expected worker resume rejection');
    expect(workerResult.fault.code).toBe('InvalidParams');
    expect(deploymentResult.ok).toBe(false);
    if (deploymentResult.ok) throw new Error('expected deployment resume rejection');
    expect(deploymentResult.fault.code).toBe('InvalidParams');
    expect(workerRegistry.getWorker('worker-1')?.drainStartedAt).toBe(1000);
    expect(workerRegistry.getWorkerSummaries(2000)[0]?.health).toBe('drained');
  });

  it('rejects malformed worker drain JSON before mutating drain state', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/worker-1/drain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createDrainWorkerOperation({ workerRegistry, clock: () => 1000 }),
        ]),
        restBindings: [createDrainWorkerRestBinding()],
        ...systemAdminAuthContext(),
      },
    );

    expect(response.status).toBe(400);
    expect(workerRegistry.getWorkerSummaries(2000)[0]?.health).toBe('active');
  });

  it('rejects primitive worker drain JSON bodies', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/worker-1/drain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '42',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createDrainWorkerOperation({ workerRegistry, clock: () => 1000 }),
        ]),
        restBindings: [createDrainWorkerRestBinding()],
        ...systemAdminAuthContext(),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '' });
    expect(workerRegistry.getWorkerSummaries(2000)[0]?.health).toBe('active');
  });

  it('reports discovery-only and missing-worker drain failures', async () => {
    engine = createOperationTestEngine();
    const principal = principalFromApiKey({ subject: 'test', scopes: ['system:admin'] });

    const discoveryOnlyResult = await executeOperation(
      'weft.workers.drain',
      { workerId: 'missing-worker' },
      {
        principal,
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([createDrainWorkerOperation()]),
      },
    );
    expect(discoveryOnlyResult.ok).toBe(false);
    if (discoveryOnlyResult.ok) throw new Error('expected discovery-only rejection');
    expect(discoveryOnlyResult.fault).toMatchObject({ code: 'EngineFailure' });

    const missingWorkerResult = await executeOperation(
      'weft.workers.drain',
      { workerId: 'missing-worker' },
      {
        principal,
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([
          createDrainWorkerOperation({ workerRegistry: new WorkerRegistry() }),
        ]),
      },
    );
    expect(missingWorkerResult.ok).toBe(false);
    if (missingWorkerResult.ok) throw new Error('expected missing-worker rejection');
    expect(missingWorkerResult.fault).toEqual({
      code: 'NotFound',
      message: 'Worker not found: missing-worker',
      data: { resource: 'worker', identifier: 'missing-worker' },
    });
  });

  it('marks and clears deployment drain state for all matching workers', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'worker-a',
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
      deploymentName: 'payments',
    });
    workerRegistry.register({
      id: 'worker-b',
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
      deploymentName: 'payments',
    });

    const registry = createOperationRegistry([
      createDrainDeploymentOperation({ workerRegistry, clock: () => 1000 }),
      createClearDeploymentDrainOperation({ workerRegistry }),
    ]);
    const restBindings = [
      createDrainDeploymentRestBinding(),
      createClearDeploymentDrainRestBinding(),
    ];

    const drainResponse = await handleRequest(
      new Request('http://localhost/v1/worker-deployments/payments/drain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'rollback' }),
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings,
        ...systemAdminAuthContext(),
      },
    );

    expect(drainResponse.status).toBe(200);
    expect(await drainResponse.json()).toEqual({
      target: 'deployment',
      deploymentName: 'payments',
      affectedWorkers: 2,
      inFlight: 0,
      health: 'drained',
    });
    expect(workerRegistry.getWorkerSummaries(2000).map((worker) => worker.health)).toEqual([
      'drained',
      'drained',
    ]);

    const clearResponse = await handleRequest(
      new Request('http://localhost/v1/worker-deployments/payments/drain', { method: 'DELETE' }),
      engine,
      {
        operationRegistry: registry,
        restBindings,
        ...systemAdminAuthContext(),
      },
    );

    expect(clearResponse.status).toBe(200);
    expect(workerRegistry.getWorkerSummaries(3000).map((worker) => worker.health)).toEqual([
      'active',
      'active',
    ]);
  });
});

describe('weft.workers.list — operation behavior', () => {
  it('invokes the clock exactly once per request, applying the same now to every worker', async () => {
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({ id: 'a', queue: 'q', activities: ['x'], concurrency: 1 });
    workerRegistry.register({ id: 'b', queue: 'q', activities: ['x'], concurrency: 1 });
    workerRegistry.getWorker('a')!.lastHeartbeat = 10;
    workerRegistry.getWorker('b')!.lastHeartbeat = 20;

    let calls = 0;
    const operation = createListWorkersOperation({
      workerRegistry,
      clock: () => {
        calls += 1;
        return 100;
      },
    });
    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.workers.list',
        {},
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([operation]),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(calls).toBe(1);
      const items = (result.value as { items: Array<{ heartbeatAgeMs: number }> }).items;
      expect(items.map((item) => item.heartbeatAgeMs)).toEqual([90, 80]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('throws when invoked from a discovery-only registry (no WorkerRegistry wired in)', async () => {
    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.workers.list',
        {},
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([listWorkersOperation]),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('EngineFailure');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
