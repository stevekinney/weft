/**
 * `weft.workers.forget` operation + REST binding (COR-2018, rows 78t and 79i).
 */
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { describe, expect, it } from 'bun:test';

import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import {
  createForgetWorkerOperation,
  createForgetWorkerRestBinding,
  forgetWorkerOperation,
} from './forget-worker.ts';
import { WORKER_CONFLICT_REASONS } from './worker-conflict-reasons.ts';

function invoke(operation: { invoke: (context: never) => Promise<unknown> }, input: unknown) {
  return operation.invoke({ input } as never);
}

function registryWithWorker(id: string): WorkerRegistry {
  const registry = new WorkerRegistry();
  registry.register({
    manifest: testWorkerManifest(),
    acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    id,
    queue: 'reports',
    activities: [],
    concurrency: 2,
  });
  return registry;
}

describe('weft.workers.forget', () => {
  it('drops a worker that went away', async () => {
    const registry = registryWithWorker('reports-worker');
    registry.unregister('reports-worker');
    const operation = createForgetWorkerOperation({ workerRegistry: registry });

    expect(await invoke(operation, { workerId: 'reports-worker' })).toEqual({
      workerId: 'reports-worker',
      forgotten: true,
    });
    expect(registry.getWorkerListing(Date.now())).toEqual([]);
  });

  it('faults with NotFound for a worker nobody lists', async () => {
    const operation = createForgetWorkerOperation({ workerRegistry: new WorkerRegistry() });
    expect(await rejectionOf(invoke(operation, { workerId: 'nobody' }))).toMatchObject({
      code: 'NotFound',
      data: { resource: 'worker', identifier: 'nobody' },
    });
  });

  it('faults with a Conflict naming why for a worker that still takes work', async () => {
    const operation = createForgetWorkerOperation({
      workerRegistry: registryWithWorker('payments-worker-1'),
    });
    expect(await rejectionOf(invoke(operation, { workerId: 'payments-worker-1' }))).toMatchObject({
      code: 'Conflict',
      data: { reason: WORKER_CONFLICT_REASONS.workerStillConnected },
    });
  });

  it('is metadata only without a registry, so a misconfigured server fails loudly', async () => {
    expect(String(await rejectionOf(invoke(forgetWorkerOperation, { workerId: 'x' })))).toContain(
      'discovery-only operation registry',
    );
  });

  it('binds POST /v1/workers/:workerId/forget', async () => {
    const binding = createForgetWorkerRestBinding();
    expect(binding).toMatchObject({ method: 'POST', path: '/v1/workers/:workerId/forget' });
    expect(
      await binding.extractInput(
        new Request('http://x/v1/workers/a/forget', { method: 'POST' }),
        { workerId: 'a' },
        undefined as never,
      ),
    ).toEqual({ workerId: 'a' });
  });
});
