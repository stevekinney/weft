/**
 * Typed faults, generation preconditions, and the remove operation for the
 * worker deployment routing operations (COR-277). The routing catalog itself
 * is covered by `worker/deployment-routing.test.ts`.
 */
import { describe, expect, it } from 'bun:test';

import type { OperationFault } from "../../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import type { WorkerDeploymentChangedEvent } from '../../core/events/fleet-state-events.ts';
import {
  seedBoundRun,
  seedLedgerEntry,
} from '../../worker/deployment-build-references.test-support.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import { testWorkerManifest } from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  createPreviewWorkerDeploymentRoutingOperation,
  createPromoteWorkerDeploymentOperation,
  createRemoveWorkerDeploymentVersionOperation,
  createRollbackWorkerDeploymentOperation,
  createSetWorkerDeploymentRoutingOperation,
  createWorkerDeploymentDiagnosticsOperation,
  workerDeploymentRemoveRestBinding,
} from './worker-deployment-routing.ts';

type Invocable = { invoke: (context: never) => Promise<unknown> };

function invoke(operation: Invocable, input: unknown): Promise<unknown> {
  return operation.invoke({ input } as never);
}

/** The fault an operation threw, or a failure if it did not throw one. */
async function faultOf(promise: Promise<unknown>): Promise<OperationFault> {
  try {
    await promise;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && 'data' in error) {
      return error as OperationFault;
    }
    throw new Error(`Expected an OperationFault, received ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the operation to fault, but it succeeded.');
}

async function stateOf(catalog: WorkerDeploymentCatalog, buildId: string) {
  const version = await catalog.getVersion('billing', buildId);
  return version?.state;
}

class InterleavingStorage extends MemoryStorage {
  #beforeCommit: (() => Promise<void>) | undefined;
  arm(beforeCommit: () => Promise<void>): void {
    this.#beforeCommit = beforeCommit;
  }
  override async conditionalBatch(...args: Parameters<MemoryStorage['conditionalBatch']>) {
    const beforeCommit = this.#beforeCommit;
    this.#beforeCommit = undefined;
    if (beforeCommit !== undefined) await beforeCommit();
    return super.conditionalBatch(...args);
  }
}

async function catalogWithBuilds(
  buildIds: readonly string[] = ['build-a', 'build-b'],
  storage: MemoryStorage = new MemoryStorage(),
): Promise<WorkerDeploymentCatalog> {
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const buildId of buildIds) {
    const manifest = testWorkerManifest({
      deployment: { name: 'billing', buildId, artifactDigest: `sha256:${buildId}` },
    });
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest,
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  return catalog;
}

const ROUTING = {
  deploymentName: 'billing',
  currentBuildId: 'build-a',
  rampBasisPoints: 10_000,
} as const;

describe('preview reports the generation a change should be applied against', () => {
  it('returns 0 before the first routing change and the live generation after', async () => {
    const catalog = await catalogWithBuilds();
    const preview = createPreviewWorkerDeploymentRoutingOperation({ catalog });
    expect(await invoke(preview, ROUTING)).toMatchObject({ valid: true, currentGeneration: 0 });

    await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);
    expect(await invoke(preview, ROUTING)).toMatchObject({ valid: true, currentGeneration: 1 });
  });

  it('faults with a typed stale-generation Conflict when expectedGeneration has been passed', async () => {
    const catalog = await catalogWithBuilds();
    await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);

    const fault = await faultOf(
      invoke(createPreviewWorkerDeploymentRoutingOperation({ catalog }), {
        ...ROUTING,
        expectedGeneration: 0,
      }),
    );
    expect(fault).toMatchObject({
      code: 'Conflict',
      data: { reason: 'stale-generation', currentGeneration: 1 },
    });
  });

  it('rejects a ramping build equal to the current build as InvalidParams, before any write', async () => {
    const catalog = await catalogWithBuilds();
    const fault = await faultOf(
      invoke(createPreviewWorkerDeploymentRoutingOperation({ catalog }), {
        ...ROUTING,
        rampingBuildId: 'build-a',
      }),
    );
    expect(fault.code).toBe('InvalidParams');
  });
});

describe('previousBuildId on the routing operations (COR-1813)', () => {
  it('reports the replaced build from promote and rollback, and keeps it through a ramp', async () => {
    const catalog = await catalogWithBuilds(['build-a', 'build-b', 'build-c']);
    const set = createSetWorkerDeploymentRoutingOperation({ catalog });
    const promote = createPromoteWorkerDeploymentOperation({ catalog });
    const rollback = createRollbackWorkerDeploymentOperation({ catalog });

    expect(await invoke(set, ROUTING)).not.toHaveProperty('previousBuildId');
    expect(await invoke(promote, { deploymentName: 'billing', buildId: 'build-b' })).toMatchObject({
      currentBuildId: 'build-b',
      previousBuildId: 'build-a',
    });
    expect(
      await invoke(set, {
        deploymentName: 'billing',
        currentBuildId: 'build-b',
        rampingBuildId: 'build-c',
        rampBasisPoints: 500,
      }),
    ).toMatchObject({ previousBuildId: 'build-a', rampingBuildId: 'build-c' });
    expect(await invoke(rollback, { deploymentName: 'billing', buildId: 'build-a' })).toMatchObject(
      { currentBuildId: 'build-a', previousBuildId: 'build-b' },
    );
  });
});

describe('worker:deployment-changed from routing changes (COR-1724)', () => {
  it('announces setrouting, promote, and rollback with the new generation and the drain state', async () => {
    const catalog = await catalogWithBuilds();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.markDeploymentDraining('billing');
    const events: WorkerDeploymentChangedEvent[] = [];
    const options = {
      catalog,
      workerRegistry,
      dispatchEvent: (event: Event) => {
        events.push(event as WorkerDeploymentChangedEvent);
      },
    };

    await invoke(createSetWorkerDeploymentRoutingOperation(options), ROUTING);
    await invoke(createPromoteWorkerDeploymentOperation(options), {
      deploymentName: 'billing',
      buildId: 'build-b',
    });
    await invoke(createRollbackWorkerDeploymentOperation(options), {
      deploymentName: 'billing',
      buildId: 'build-a',
    });

    expect(events.map((event) => [event.deploymentName, event.buildId])).toEqual([
      ['billing', undefined],
      ['billing', undefined],
      ['billing', undefined],
    ]);
    expect(events.map((event) => event.routingGeneration)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.drainState)).toEqual(['drained', 'drained', 'drained']);
  });

  it('announces nothing when the change is refused', async () => {
    const catalog = await catalogWithBuilds();
    const events: Event[] = [];
    const set = createSetWorkerDeploymentRoutingOperation({
      catalog,
      dispatchEvent: (event) => events.push(event),
    });
    await invoke(set, ROUTING);
    events.length = 0;

    await faultOf(invoke(set, { ...ROUTING, expectedGeneration: 0 }));

    expect(events).toEqual([]);
  });
});

describe('setrouting, promote, and rollback fault with typed Conflicts', () => {
  it('setrouting: a stale expectedGeneration is a Conflict naming the current generation', async () => {
    const catalog = await catalogWithBuilds();
    const set = createSetWorkerDeploymentRoutingOperation({ catalog });
    await invoke(set, ROUTING);

    const fault = await faultOf(invoke(set, { ...ROUTING, expectedGeneration: 0 }));
    expect(fault).toMatchObject({
      code: 'Conflict',
      data: { reason: 'stale-generation', currentGeneration: 1 },
    });
    expect(await catalog.getRouting('billing')).toMatchObject({ generation: 1 });
  });

  it.each([
    ['promote', createPromoteWorkerDeploymentOperation],
    ['rollback', createRollbackWorkerDeploymentOperation],
  ] as const)(
    '%s: applies against the generation passed, and a moved pointer is a stale-generation Conflict',
    async (_name, create) => {
      const catalog = await catalogWithBuilds();
      const operation = create({ catalog });
      await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);

      // The generation the caller previewed is honored.
      expect(
        await invoke(operation, {
          deploymentName: 'billing',
          buildId: 'build-b',
          expectedGeneration: 1,
        }),
      ).toMatchObject({ currentBuildId: 'build-b', generation: 2 });

      // A caller still holding generation 1 is refused, and the pointer is untouched.
      const fault = await faultOf(
        invoke(operation, { deploymentName: 'billing', buildId: 'build-a', expectedGeneration: 1 }),
      );
      expect(fault).toMatchObject({
        code: 'Conflict',
        data: { reason: 'stale-generation', currentGeneration: 2 },
      });
      expect(await catalog.getRouting('billing')).toMatchObject({
        currentBuildId: 'build-b',
        generation: 2,
      });
    },
  );

  it.each([
    ['promote', createPromoteWorkerDeploymentOperation],
    ['rollback', createRollbackWorkerDeploymentOperation],
  ] as const)(
    '%s: omitting expectedGeneration keeps today’s behavior, including the first routing change',
    async (_name, create) => {
      const catalog = await catalogWithBuilds();
      const operation = create({ catalog });
      expect(
        await invoke(operation, { deploymentName: 'billing', buildId: 'build-a' }),
      ).toMatchObject({
        currentBuildId: 'build-a',
        generation: 1,
      });
      expect(
        await invoke(operation, { deploymentName: 'billing', buildId: 'build-b' }),
      ).toMatchObject({
        currentBuildId: 'build-b',
        generation: 2,
      });
    },
  );

  it('promote without expectedGeneration still refuses a pointer that moves between its read and its write', async () => {
    const storage = new InterleavingStorage();
    const catalog = await catalogWithBuilds(['build-a', 'build-b'], storage);
    const rival = new WorkerDeploymentCatalog(storage);
    await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);

    storage.arm(async () => {
      await rival.setRouting({ ...ROUTING, currentBuildId: 'build-b', updatedAt: 9 });
    });
    const fault = await faultOf(
      invoke(createPromoteWorkerDeploymentOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-b',
      }),
    );
    expect(fault).toMatchObject({ code: 'Conflict', data: { currentGeneration: 2 } });
  });

  it('a missing build is NotFound and a build that is not ready is a Conflict', async () => {
    const catalog = await catalogWithBuilds();
    const set = createSetWorkerDeploymentRoutingOperation({ catalog });

    expect(await faultOf(invoke(set, { ...ROUTING, currentBuildId: 'missing' }))).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'billing/missing' },
    });
    expect(
      await faultOf(
        invoke(createPromoteWorkerDeploymentOperation({ catalog }), {
          deploymentName: 'billing',
          buildId: 'missing',
        }),
      ),
    ).toMatchObject({ code: 'NotFound' });

    await catalog.setVersionState('billing', 'build-b', 'draining');
    expect(
      await faultOf(invoke(set, { ...ROUTING, rampingBuildId: 'build-b', rampBasisPoints: 100 })),
    ).toMatchObject({ code: 'Conflict', data: { reason: 'version-not-ready' } });
  });

  it('declares the faults it can produce', () => {
    const registry = createLiveOperationRegistry();
    const faults = (name: string) =>
      [
        ...(registry.list().find((operation) => operation.name === name)?.producibleFaults ?? []),
      ].toSorted();
    for (const name of [
      'weft.worker.deployments.setrouting',
      'weft.worker.deployments.promote',
      'weft.worker.deployments.rollback',
      'weft.worker.deployments.preview',
    ]) {
      expect(faults(name), name).toEqual(['Conflict', 'InvalidParams', 'NotFound']);
    }
    expect(faults('weft.worker.deployments.remove')).toEqual(['Conflict', 'NotFound']);
  });
});

describe('weft.worker.deployments.remove', () => {
  it('removes a draining build that nothing references', async () => {
    const catalog = await catalogWithBuilds();
    await catalog.setVersionState('billing', 'build-b', 'draining');
    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });

    expect(await invoke(remove, { deploymentName: 'billing', buildId: 'build-b' })).toEqual({
      deploymentName: 'billing',
      buildId: 'build-b',
      removed: true,
    });
    expect(await stateOf(catalog, 'build-b')).toBe('removed');
    expect(await stateOf(catalog, 'build-a')).toBe('ready');
  });

  it('refuses a build that is not draining, routed or not, and leaves it as it was', async () => {
    const catalog = await catalogWithBuilds();
    await catalog.setRouting({ ...ROUTING, updatedAt: 1 });
    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });

    // `build-b` is ready and not routed: only its state keeps it, so only its state is named.
    const unrouted = await faultOf(
      invoke(remove, { deploymentName: 'billing', buildId: 'build-b' }),
    );
    expect(unrouted).toMatchObject({ code: 'Conflict', data: { reason: 'version-not-draining' } });
    expect(unrouted.message).toContain('drain it first');
    expect(await stateOf(catalog, 'build-b')).toBe('ready');

    // `build-a` is ready and routed: it must be drained before routing is even considered.
    expect(
      await faultOf(invoke(remove, { deploymentName: 'billing', buildId: 'build-a' })),
    ).toMatchObject({ code: 'Conflict', data: { reason: 'version-not-draining' } });
    expect(await stateOf(catalog, 'build-a')).toBe('ready');
  });

  describe('refuses a build that work is bound to', () => {
    async function drainingBuild(storage = new MemoryStorage()) {
      const catalog = await catalogWithBuilds(['build-a', 'build-b'], storage);
      await catalog.setVersionState('billing', 'build-b', 'draining');
      return {
        storage,
        catalog,
        remove: createRemoveWorkerDeploymentVersionOperation({ catalog }),
      };
    }
    const BUILD_B = { deploymentName: 'billing', buildId: 'build-b' };

    it('one non-terminal run bound to the build makes removal refuse, naming the count', async () => {
      const { storage, catalog, remove } = await drainingBuild();
      await seedBoundRun(storage, { workflowId: 'run-1', ...BUILD_B });

      const fault = await faultOf(invoke(remove, BUILD_B));

      expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-referenced' } });
      expect(fault.message).toContain('1 piece of work');
      expect(await stateOf(catalog, 'build-b')).toBe('draining');
    });

    it('one non-terminal ledger entry requiring the build makes removal refuse', async () => {
      const { storage, catalog, remove } = await drainingBuild();
      await seedLedgerEntry(storage, { operationId: 'op-1', requirement: BUILD_B });
      await seedBoundRun(storage, { workflowId: 'run-1', ...BUILD_B });

      const fault = await faultOf(invoke(remove, BUILD_B));

      expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-referenced' } });
      expect(fault.message).toContain('2 pieces of work');
      expect(await stateOf(catalog, 'build-b')).toBe('draining');
    });

    it('removes the build once the run and the entry have finished', async () => {
      const { storage, catalog, remove } = await drainingBuild();
      await seedBoundRun(storage, { workflowId: 'run-1', ...BUILD_B });
      await seedLedgerEntry(storage, { operationId: 'op-1', requirement: BUILD_B });
      await faultOf(invoke(remove, BUILD_B));

      await seedBoundRun(storage, { workflowId: 'run-1', ...BUILD_B, status: 'completed' });
      await seedLedgerEntry(storage, { operationId: 'op-1', requirement: BUILD_B, finished: true });

      expect(await invoke(remove, BUILD_B)).toEqual({ ...BUILD_B, removed: true });
      expect(await stateOf(catalog, 'build-b')).toBe('removed');
    });

    it('is not blocked by work bound to another build of the deployment', async () => {
      const { storage, remove } = await drainingBuild();
      await seedBoundRun(storage, {
        workflowId: 'run-1',
        deploymentName: 'billing',
        buildId: 'build-a',
      });

      expect(await invoke(remove, BUILD_B)).toMatchObject({ removed: true });
    });
  });

  it.each(['current', 'ramping'] as const)(
    'refuses the %s build of the routing pointer with a version-routed Conflict',
    async (role) => {
      const catalog = await catalogWithBuilds();
      await catalog.setRouting(
        role === 'current'
          ? { ...ROUTING, updatedAt: 1 }
          : { ...ROUTING, rampingBuildId: 'build-b', rampBasisPoints: 2_500, updatedAt: 1 },
      );
      const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });
      const routed = role === 'current' ? 'build-a' : 'build-b';
      // Draining a routed build is allowed; it is the routing pointer that then refuses removal.
      await catalog.setVersionState('billing', routed, 'draining');

      const fault = await faultOf(invoke(remove, { deploymentName: 'billing', buildId: routed }));

      expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-routed' } });
      expect(await stateOf(catalog, routed)).toBe('draining');
      const routing = await catalog.getRouting('billing');
      expect(routing?.generation).toBe(1);
    },
  );

  it('removes a build once routing has moved off it', async () => {
    const catalog = await catalogWithBuilds();
    await catalog.setRouting({ ...ROUTING, updatedAt: 1 });
    await catalog.setRouting({ ...ROUTING, currentBuildId: 'build-b', updatedAt: 2 });
    await catalog.setVersionState('billing', 'build-a', 'draining');

    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });
    expect(await invoke(remove, { deploymentName: 'billing', buildId: 'build-a' })).toMatchObject({
      removed: true,
    });
  });

  it('reports a drain lifted and a routing change taken between its read and its write as a refusal, not a removal', async () => {
    const storage = new InterleavingStorage();
    const catalog = await catalogWithBuilds(['build-a', 'build-b'], storage);
    const rival = new WorkerDeploymentCatalog(storage);
    await catalog.setRouting({ ...ROUTING, updatedAt: 1 });
    await catalog.setVersionState('billing', 'build-b', 'draining');

    storage.arm(async () => {
      // The rival points routing at build-b between the operation's checks and its write.
      await rival.setVersionState('billing', 'build-b', 'ready');
      await rival.setRouting({ ...ROUTING, currentBuildId: 'build-b', updatedAt: 2 });
    });
    const fault = await faultOf(
      invoke(createRemoveWorkerDeploymentVersionOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-b',
      }),
    );
    // The build is no longer draining, so that is what the retried checks report first.
    expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-not-draining' } });
    expect(await stateOf(catalog, 'build-b')).toBe('ready');
  });

  it('answers version-busy, leaving the build draining, when bindings keep landing during its scans', async () => {
    const storage = new MemoryStorage();
    const catalog = await catalogWithBuilds(['build-a', 'build-b'], storage);
    await catalog.setVersionState('billing', 'build-b', 'draining');
    // A binding lands before each of the removal's writes, as work arriving continuously would.
    const original = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      await storage.put(
        'worker-deployment-binding:billing:build-b:00',
        crypto.getRandomValues(new Uint8Array(16)),
      );
      return original(conditions, operations);
    };

    const fault = await faultOf(
      invoke(createRemoveWorkerDeploymentVersionOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-b',
      }),
    );

    expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-busy' } });
    expect(await stateOf(catalog, 'build-b')).toBe('draining');
  });

  it('faults NotFound for a build that never existed and for one already removed', async () => {
    const catalog = await catalogWithBuilds();
    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });

    expect(
      await faultOf(invoke(remove, { deploymentName: 'billing', buildId: 'missing' })),
    ).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'billing/missing' },
    });

    await catalog.setVersionState('billing', 'build-b', 'draining');
    await invoke(remove, { deploymentName: 'billing', buildId: 'build-b' });
    expect(
      await faultOf(invoke(remove, { deploymentName: 'billing', buildId: 'build-b' })),
    ).toMatchObject({ code: 'NotFound' });
  });

  it('is registered with a REST binding and needs a live catalog', async () => {
    expect(workerDeploymentRemoveRestBinding).toMatchObject({
      method: 'POST',
      path: '/v1/worker-deployments/remove',
      operationName: 'weft.worker.deployments.remove',
    });
    const input = { deploymentName: 'billing', buildId: 'build-b' };
    expect(
      await workerDeploymentRemoveRestBinding.extractInput(
        new Request('http://localhost/v1/worker-deployments/remove', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
        {},
        {},
      ),
    ).toEqual(input);
    expect(
      createLiveOperationRegistry()
        .list()
        .some((operation) => operation.name === 'weft.worker.deployments.remove'),
    ).toBe(true);
    expect(
      await throwingRejectionOf(invoke(createRemoveWorkerDeploymentVersionOperation(), input)),
    ).toThrow('live worker deployment catalog');
  });
});

describe('weft.worker.deployments.diagnostics reports a true reference count', () => {
  it('computes executionReferences from the work bound to each build when the list is read', async () => {
    const storage = new MemoryStorage();
    const catalog = await catalogWithBuilds(['build-a', 'build-b'], storage);
    const diagnostics = createWorkerDeploymentDiagnosticsOperation({ catalog });
    const counts = async () =>
      Object.fromEntries(
        (
          (await invoke(diagnostics, { deploymentName: 'billing' })) as {
            versions: Array<{ buildId: string; executionReferences: number }>;
          }
        ).versions.map((version) => [version.buildId, version.executionReferences]),
      );
    expect(await counts()).toEqual({ 'build-a': 0, 'build-b': 0 });

    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: 'billing',
      buildId: 'build-b',
    });
    await seedBoundRun(storage, {
      workflowId: 'run-2',
      deploymentName: 'billing',
      buildId: 'build-b',
    });
    await seedLedgerEntry(storage, {
      operationId: 'op-1',
      requirement: { deploymentName: 'billing', buildId: 'build-a' },
    });
    expect(await counts()).toEqual({ 'build-a': 1, 'build-b': 2 });

    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: 'billing',
      buildId: 'build-b',
      status: 'completed',
    });
    expect(await counts()).toEqual({ 'build-a': 1, 'build-b': 1 });
  });
});
