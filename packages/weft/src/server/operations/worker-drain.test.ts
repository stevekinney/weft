/**
 * Deployment drain and resume, deployment-wide and build-scoped (COR-277).
 */
import { describe, expect, it } from 'bun:test';

import { type OperationFault, principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import type { WorkerDeploymentChangedEvent } from '../../core/events/fleet-state-events.ts';
import { seedBoundRun } from '../../worker/deployment-build-references.test-support.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { createOperationTestEngine } from './operation-registry-test-helpers.test-support.ts';
import {
  createClearDeploymentDrainOperation,
  createClearDeploymentDrainRestBinding,
  createDrainDeploymentOperation,
  createDrainDeploymentRestBinding,
} from './worker-drain.ts';

function invoke(operation: { invoke: (context: never) => Promise<unknown> }, input: unknown) {
  return operation.invoke({ input } as never);
}

async function faultOf(promise: Promise<unknown>): Promise<OperationFault> {
  try {
    await promise;
  } catch (error) {
    return error as OperationFault;
  }
  throw new Error('Expected a fault, but the operation succeeded.');
}

async function fixture() {
  const registry = new WorkerRegistry();
  const storage = new MemoryStorage();
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const [id, buildId] of [
    ['old-1', 'build-1'],
    ['new-1', 'build-2'],
  ] as const) {
    registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id,
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
      deploymentName: 'payments',
      buildId,
    });
    await catalog.registerVersion({
      deploymentName: 'payments',
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: testWorkerManifest({
        deployment: { name: 'payments', buildId, artifactDigest: `sha256:${buildId}` },
      }),
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  return {
    registry,
    storage,
    catalog,
    drain: createDrainDeploymentOperation({ workerRegistry: registry, catalog, clock: () => 5 }),
    resume: createClearDeploymentDrainOperation({ workerRegistry: registry, catalog }),
  };
}

describe('worker:deployment-changed from drain and resume (COR-1724)', () => {
  function collectDeploymentEvents() {
    const events: WorkerDeploymentChangedEvent[] = [];
    return {
      events,
      dispatchEvent: (event: Event) => {
        events.push(event as WorkerDeploymentChangedEvent);
      },
    };
  }

  it('announces a build drain and resume with the drain state and the routing generation', async () => {
    const { registry, catalog } = await fixture();
    await catalog.setRouting({
      deploymentName: 'payments',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const { events, dispatchEvent } = collectDeploymentEvents();
    const drain = createDrainDeploymentOperation({
      workerRegistry: registry,
      catalog,
      clock: () => 5,
      dispatchEvent,
    });
    const resume = createClearDeploymentDrainOperation({
      workerRegistry: registry,
      catalog,
      dispatchEvent,
    });

    await invoke(drain, { deploymentName: 'payments', buildId: 'build-1', reason: 'bad build' });
    await invoke(resume, { deploymentName: 'payments', buildId: 'build-1' });

    expect(events.map((event) => [event.deploymentName, event.buildId, event.drainState])).toEqual([
      ['payments', 'build-1', 'drained'],
      ['payments', 'build-1', 'active'],
    ]);
    expect(events.map((event) => event.routingGeneration)).toEqual([1, 1]);
    expect(Object.keys(events[0]!).toSorted()).toEqual([
      'buildId',
      'deploymentName',
      'drainState',
      'isTrusted',
      'routingGeneration',
    ]);
  });

  it('announces a deployment-wide drain without a build id and reports generation 0 before any routing', async () => {
    const { registry, catalog } = await fixture();
    const { events, dispatchEvent } = collectDeploymentEvents();
    const drain = createDrainDeploymentOperation({
      workerRegistry: registry,
      catalog,
      dispatchEvent,
    });

    await invoke(drain, { deploymentName: 'payments' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      deploymentName: 'payments',
      buildId: undefined,
      drainState: 'drained',
      routingGeneration: 0,
    });
  });

  it('keeps a committed drain, and raises no event, when the routing generation cannot be read', async () => {
    const { registry, storage } = await fixture();
    class UnreadableRoutingCatalog extends WorkerDeploymentCatalog {
      override async getRouting(): Promise<never> {
        throw new Error('routing unreadable');
      }
    }
    const { events, dispatchEvent } = collectDeploymentEvents();
    const drain = createDrainDeploymentOperation({
      workerRegistry: registry,
      catalog: new UnreadableRoutingCatalog(storage),
      dispatchEvent,
    });

    expect(await invoke(drain, { deploymentName: 'payments' })).toMatchObject({
      health: 'drained',
    });
    expect(events).toEqual([]);
  });

  it('announces nothing for a refused drain or without a dispatch hook', async () => {
    const { registry, catalog } = await fixture();
    const { events, dispatchEvent } = collectDeploymentEvents();
    const drain = createDrainDeploymentOperation({
      workerRegistry: registry,
      catalog,
      dispatchEvent,
    });

    await faultOf(invoke(drain, { deploymentName: 'payments', buildId: 'build-9' }));
    expect(events).toEqual([]);

    const silent = createDrainDeploymentOperation({ workerRegistry: registry, catalog });
    await invoke(silent, { deploymentName: 'payments' });
    expect(events).toEqual([]);
  });
});

describe('weft.worker.deployments.drain and .resume — build-scoped', () => {
  it('drains and resumes one build independently of its siblings', async () => {
    const { registry, drain, resume } = await fixture();

    expect(
      await invoke(drain, { deploymentName: 'payments', buildId: 'build-1', reason: 'bad build' }),
    ).toEqual({
      target: 'deployment',
      deploymentName: 'payments',
      buildId: 'build-1',
      affectedWorkers: 1,
      inFlight: 0,
      health: 'drained',
    });
    expect(registry.findWorker('charge', { queue: 'default' })?.id).toBe('new-1');

    expect(await invoke(resume, { deploymentName: 'payments', buildId: 'build-1' })).toMatchObject({
      buildId: 'build-1',
      health: 'active',
    });
    expect(
      registry
        .getWorkerSummaries(1)
        .map((worker) => worker.health)
        .toSorted(),
    ).toEqual(['active', 'active']);
  });

  it('leaves the deployment-wide drain and resume exactly as they were when no build is named', async () => {
    const { registry, drain, resume } = await fixture();

    const drained = await invoke(drain, { deploymentName: 'payments' });
    expect(drained).toEqual({
      target: 'deployment',
      deploymentName: 'payments',
      affectedWorkers: 2,
      inFlight: 0,
      health: 'drained',
    });
    expect(drained).not.toHaveProperty('buildId');
    expect(registry.findWorker('charge', { queue: 'default' })).toBeUndefined();

    const resumed = await invoke(resume, { deploymentName: 'payments' });
    expect(resumed).toMatchObject({ affectedWorkers: 2, health: 'active' });
    expect(resumed).not.toHaveProperty('buildId');
  });

  it('refuses to drain a build the catalog has not accepted or has removed, without marking it', async () => {
    const { registry, drain } = await fixture();

    const unknown = await faultOf(
      invoke(drain, { deploymentName: 'payments', buildId: 'build-9' }),
    );
    expect(unknown).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'payments/build-9' },
    });
    const otherDeployment = await faultOf(
      invoke(drain, { deploymentName: 'shipping', buildId: 'build-1' }),
    );
    expect(otherDeployment.code).toBe('NotFound');

    // Nothing was marked: a worker that later connects on that build is routable.
    registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'late',
      queue: 'default',
      activities: ['charge'],
      concurrency: 1,
      deploymentName: 'payments',
      buildId: 'build-9',
    });
    expect(registry.getWorkerSummaries(1).find((worker) => worker.id === 'late')?.health).toBe(
      'active',
    );
  });

  it('writes the build’s state to the catalog: drain is draining, resume is ready', async () => {
    const { catalog, drain, resume } = await fixture();
    const stateOf = async (buildId: string) => {
      const version = await catalog.getVersion('payments', buildId);
      return version?.state;
    };

    await invoke(drain, { deploymentName: 'payments', buildId: 'build-1' });
    expect(await stateOf('build-1')).toBe('draining');
    expect(await stateOf('build-2')).toBe('ready');

    await invoke(resume, { deploymentName: 'payments', buildId: 'build-1' });
    expect(await stateOf('build-1')).toBe('ready');
  });

  it('keeps the drain on a build that has executions bound to it', async () => {
    const { storage, catalog, drain } = await fixture();
    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: 'payments',
      buildId: 'build-1',
    });

    await invoke(drain, { deploymentName: 'payments', buildId: 'build-1' });

    const version = await catalog.getVersion('payments', 'build-1');
    expect(version?.state).toBe('draining');
  });

  it('refuses to resume a removed build, leaving it removed and still drained', async () => {
    const { registry, catalog, drain, resume } = await fixture();
    await invoke(drain, { deploymentName: 'payments', buildId: 'build-1' });
    await catalog.removeVersion('payments', 'build-1');

    const fault = await faultOf(invoke(resume, { deploymentName: 'payments', buildId: 'build-1' }));

    expect(fault).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'payments/build-1' },
    });
    const version = await catalog.getVersion('payments', 'build-1');
    expect(version?.state).toBe('removed');
    expect(registry.findWorker('charge', { queue: 'default' })?.id).toBe('new-1');
  });

  it('resumes a build with no marker as a no-op, even one the catalog does not know', async () => {
    const { resume } = await fixture();
    expect(await invoke(resume, { deploymentName: 'payments', buildId: 'build-9' })).toMatchObject({
      buildId: 'build-9',
      affectedWorkers: 0,
      health: 'active',
    });
  });

  it('is a discovery-only error without a registry or, for a build, a catalog', async () => {
    const registry = new WorkerRegistry();
    expect(
      await throwingRejectionOf(
        invoke(createDrainDeploymentOperation({ workerRegistry: registry }), {
          deploymentName: 'payments',
          buildId: 'build-1',
        }),
      ),
    ).toThrow('discovery-only');
  });
});

describe('build-scoped drain over REST and the live registry', () => {
  it('reads buildId from the POST body and from the DELETE query', async () => {
    const drain = createDrainDeploymentRestBinding();
    const resume = createClearDeploymentDrainRestBinding();
    expect(drain.inputSources).toMatchObject({
      buildId: { kind: 'body-field', bodyField: 'buildId' },
    });
    expect(resume.inputSources).toMatchObject({
      buildId: { kind: 'query', queryParam: 'buildId' },
    });

    expect(
      await drain.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain', {
          method: 'POST',
          body: JSON.stringify({ buildId: 'build-1', reason: 'bad build' }),
        }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments', buildId: 'build-1', reason: 'bad build' });
    expect(
      await drain.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain', { method: 'POST' }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments' });
    expect(
      await resume.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain?buildId=build-1', {
          method: 'DELETE',
        }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments', buildId: 'build-1' });
    expect(
      await resume.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain', { method: 'DELETE' }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments' });
  });

  it('wires dispatchEvent into the live drain, resume, and routing operations (COR-1724)', async () => {
    const engine = createOperationTestEngine();
    const { registry: workerRegistry, catalog } = await fixture();
    const events: WorkerDeploymentChangedEvent[] = [];
    const registry = createLiveOperationRegistry({
      workerRegistry,
      workerDeploymentCatalog: catalog,
      dispatchEvent: (event) => {
        events.push(event as WorkerDeploymentChangedEvent);
      },
    });
    const call = (name: string, input: Record<string, unknown>) =>
      executeOperation(name, input, {
        principal: principalFromApiKey({ subject: 'admin', scopes: ['system:admin'] }),
        host: engine,
        transport: 'jsonRpcStdio',
        registry,
      });

    await call('weft.worker.deployments.drain', { deploymentName: 'payments' });
    await call('weft.worker.deployments.resume', { deploymentName: 'payments' });
    await call('weft.worker.deployments.promote', {
      deploymentName: 'payments',
      buildId: 'build-2',
    });
    engine[Symbol.dispose]();

    expect(events.map((event) => [event.drainState, event.routingGeneration])).toEqual([
      ['drained', 0],
      ['active', 0],
      ['active', 1],
    ]);
  });

  it('wires the catalog into the live drain operation so a build is checked, with its fault on the wire', async () => {
    const engine = createOperationTestEngine();
    const registry = createLiveOperationRegistry({
      workerRegistry: new WorkerRegistry(),
      workerDeploymentCatalog: new WorkerDeploymentCatalog(new MemoryStorage()),
    });
    const result = await executeOperation(
      'weft.worker.deployments.drain',
      { deploymentName: 'payments', buildId: 'build-1' },
      {
        principal: principalFromApiKey({ subject: 'admin', scopes: ['system:admin'] }),
        host: engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    engine[Symbol.dispose]();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a fault');
    expect(result.fault).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'payments/build-1' },
    });
  });

  it('wires the catalog into the live resume operation so a drained build returns to ready and a removed one is refused', async () => {
    const engine = createOperationTestEngine();
    const catalog = new WorkerDeploymentCatalog(new MemoryStorage());
    for (const buildId of ['build-1', 'build-2']) {
      await catalog.registerVersion({
        deploymentName: 'payments',
        buildId,
        artifactDigest: `sha256:${buildId}`,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: testWorkerManifest({
          deployment: { name: 'payments', buildId, artifactDigest: `sha256:${buildId}` },
        }),
        state: 'ready',
        firstSeenAt: 1,
      });
    }
    const registry = createLiveOperationRegistry({
      workerRegistry: new WorkerRegistry(),
      workerDeploymentCatalog: catalog,
    });
    const call = (name: string, buildId: string) =>
      executeOperation(
        name,
        { deploymentName: 'payments', buildId },
        {
          principal: principalFromApiKey({ subject: 'admin', scopes: ['system:admin'] }),
          host: engine,
          transport: 'jsonRpcStdio',
          registry,
        },
      );

    await call('weft.worker.deployments.drain', 'build-1');
    const drained = await catalog.getVersion('payments', 'build-1');
    expect(drained?.state).toBe('draining');
    await call('weft.worker.deployments.resume', 'build-1');
    const resumed = await catalog.getVersion('payments', 'build-1');
    expect(resumed?.state).toBe('ready');

    await catalog.setVersionState('payments', 'build-2', 'draining');
    await catalog.removeVersion('payments', 'build-2');
    const refused = await call('weft.worker.deployments.resume', 'build-2');
    engine[Symbol.dispose]();
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a fault');
    expect(refused.fault.code).toBe('NotFound');
  });
});
