/**
 * `weft.workers.diagnostics` operation + REST binding — unit tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { testWorkerManifest } from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  createGetWorkerDiagnosticsOperation,
  createGetWorkerDiagnosticsRestBinding,
  getWorkerDiagnosticsOperation,
  type GetWorkerDiagnosticsOutput,
} from './get-worker-diagnostics.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

const binding = createGetWorkerDiagnosticsRestBinding();

function manifestWithWorkflow() {
  return testWorkerManifest({
    deployment: { name: 'payments', buildId: 'build-42', artifactDigest: 'sha256:artifact' },
    workflows: {
      checkout: {
        workflowVersion: '2.1.0',
        workflowRevision: 'sha256:revision',
        contractHash: 'sha256:contract',
        activities: {
          charge: { contractHash: 'sha256:activity', implementationRevision: 'build-42' },
        },
      },
    },
  });
}

describe('weft.workers.diagnostics — REST GET /v1/workers/:workerId/diagnostics', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns structurally distinct instance and deploymentVersion identity for a connected worker', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      manifest: manifestWithWorkflow(),
      acceptedManifestDigest: 'sha256:accepted',
      id: 'worker-1',
      queue: 'payments',
      activities: ['checkout.charge'],
      concurrency: 3,
    });
    workerRegistry.getWorker('worker-1')!.lastHeartbeat = 1000;

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/worker-1/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createGetWorkerDiagnosticsOperation({ workerRegistry, clock: () => 5000 }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      worker: { instance: Record<string, unknown>; deploymentVersion: Record<string, unknown> };
    };

    expect(body.worker.instance).toEqual({
      workerId: 'worker-1',
      queue: 'payments',
      health: 'active',
      connectedAt: expect.any(Number),
      startedAt: expect.any(Number),
      lastHeartbeatAt: 1000,
      heartbeatAgeMs: 4000,
      inFlight: 0,
      sessionGeneration: 1,
    });
    expect(body.worker.deploymentVersion).toEqual({
      deploymentName: 'payments',
      buildId: 'build-42',
      artifactDigest: 'sha256:artifact',
      runtimeName: 'bun',
      runtimeVersion: '1.3.14',
      sdkVersion: '0.18.0',
      manifestVersion: 1,
      protocolVersion: 6,
      manifestDigest: 'sha256:accepted',
      workflows: {
        checkout: {
          workflowVersion: '2.1.0',
          workflowRevision: 'sha256:revision',
          contractHash: 'sha256:contract',
          activities: {
            charge: { contractHash: 'sha256:activity', implementationRevision: 'build-42' },
          },
        },
      },
    });
  });

  it('never includes capabilities or raw schema content', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      manifest: testWorkerManifest({ capabilities: { gpu: true, region: 'us-west' } }),
      acceptedManifestDigest: 'sha256:accepted',
      id: 'worker-1',
      queue: 'default',
      activities: [],
      concurrency: 1,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/worker-1/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createGetWorkerDiagnosticsOperation({ workerRegistry, clock: () => 0 }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    const body = (await response.json()) as { worker: Record<string, unknown> };
    expect(JSON.stringify(body)).not.toContain('capabilities');
    expect(JSON.stringify(body)).not.toContain('gpu');
  });

  it('returns worker: null when the workerId is not connected', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();

    const response = await handleRequest(
      new Request('http://localhost/v1/workers/missing/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createGetWorkerDiagnosticsOperation({ workerRegistry, clock: () => 0 }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ worker: null });
  });

  it('rejects unauthenticated callers with 401', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.workers.diagnostics',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });

  it('rejects callers without system:read with 403', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsInsufficientScope({
      operationName: 'weft.workers.diagnostics',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });
});

describe('weft.workers.diagnostics — operation behavior', () => {
  it('throws when invoked from a discovery-only registry (no WorkerRegistry wired in)', async () => {
    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.workers.diagnostics',
        { workerId: 'worker-1' },
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([getWorkerDiagnosticsOperation]),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('EngineFailure');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('surfaces sessionGeneration and inFlight from the registry, both changing across a reconnect (COR-220)', async () => {
    const engine = createOperationTestEngine();
    try {
      const workerRegistry = new WorkerRegistry();
      workerRegistry.register({
        manifest: manifestWithWorkflow(),
        acceptedManifestDigest: 'sha256:accepted',
        id: 'worker-1',
        queue: 'payments',
        activities: ['checkout.charge'],
        concurrency: 3,
      });
      workerRegistry.assignTask('worker-1', 'op-1', 30_000, undefined, 'attempt-1');

      const registry = createOperationRegistry([
        createGetWorkerDiagnosticsOperation({ workerRegistry }),
      ]);
      const firstResult = await executeOperation(
        'weft.workers.diagnostics',
        { workerId: 'worker-1' },
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry,
        },
      );
      if (!firstResult.ok) throw new Error('expected success');
      const firstOutput = firstResult.value as GetWorkerDiagnosticsOutput;
      expect(firstOutput.worker?.instance.sessionGeneration).toBe(1);
      expect(firstOutput.worker?.instance.inFlight).toBe(1);

      // A reconnect that proves nothing about the disconnected session — an
      // ordinary fresh registration, exactly like `register()`'s default
      // (no `resumingSessionGeneration`) behaves for any caller that hasn't
      // proven a resume.
      workerRegistry.register({
        manifest: manifestWithWorkflow(),
        acceptedManifestDigest: 'sha256:accepted',
        id: 'worker-1',
        queue: 'payments',
        activities: ['checkout.charge'],
        concurrency: 3,
      });

      const secondResult = await executeOperation(
        'weft.workers.diagnostics',
        { workerId: 'worker-1' },
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry,
        },
      );
      if (!secondResult.ok) throw new Error('expected success');
      const secondOutput = secondResult.value as GetWorkerDiagnosticsOutput;
      expect(secondOutput.worker?.instance.sessionGeneration).toBe(2);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
