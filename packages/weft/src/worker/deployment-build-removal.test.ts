/**
 * COR-1582: a deployment build cannot be removed while durable work is bound to it, and a run
 * cannot be restarted or forked onto a build that has been removed. These tests drive real engine
 * runs through the removal operation, so the reference the operation counts is the binding the
 * engine wrote, not a seeded stand-in.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { forkWorkflowOperation } from '../server/operations/fork-workflow.ts';
import { createStartOrSignalWorkflowOperation } from '../server/operations/start-or-signal-workflow.ts';
import { startWorkflowOperation } from '../server/operations/start-workflow.ts';
import { createRemoveWorkerDeploymentVersionOperation } from '../server/operations/worker-deployment-routing.ts';
import {
  buildManifest,
  DEPLOYMENT,
  drainBuildOne,
  faultOf,
  fixture,
  InterleavingStorage,
  invoke,
  REMOVE_BUILD_ONE,
} from './deployment-build-fixture.test-support.ts';
import { seedBoundRun, seedLedgerEntry } from './deployment-build-references.test-support.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import { WorkerDeploymentVersionRemovedError } from './deployment-version-removed-error.ts';
import { NoRoutedWorkerDeploymentError } from './no-routed-deployment-error.ts';
import { resolveWorkflowWorkerStartBinding } from './versioning-policy.ts';

describe('removing a build that engine runs are bound to', () => {
  it('refuses while a run is bound, also after a restart, and removes once the run finishes', async () => {
    const storage = new MemoryStorage();
    await using first = await fixture(storage);
    const handle = await first.engine.start('checkout', null, { id: 'checkout-1' });
    await drainBuildOne(first.catalog);

    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog: first.catalog });
    expect(await faultOf(invoke(remove, REMOVE_BUILD_ONE))).toMatchObject({
      code: 'Conflict',
      data: { reason: 'version-referenced' },
    });

    // A restart between the run's start and the removal: nothing in memory survives, so the
    // answer can only come from what the storage holds.
    first.engine[Symbol.dispose]();
    await using restarted = await fixture(storage, false);
    const afterRestart = createRemoveWorkerDeploymentVersionOperation({
      catalog: new WorkerDeploymentCatalog(storage),
    });
    expect(await faultOf(invoke(afterRestart, REMOVE_BUILD_ONE))).toMatchObject({
      code: 'Conflict',
      data: { reason: 'version-referenced' },
    });
    const afterRestartVersion = await restarted.catalog.getVersion(DEPLOYMENT, 'build-1');
    expect(afterRestartVersion?.state).toBe('draining');

    await seedBoundRun(storage, {
      workflowId: handle.id,
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      status: 'completed',
    });
    expect(await invoke(afterRestart, REMOVE_BUILD_ONE)).toEqual({
      ...REMOVE_BUILD_ONE,
      removed: true,
    });
  });

  it('reports the run in the version listing as a true reference count', async () => {
    await using fx = await fixture();
    const { engine, catalog } = fx;
    await engine.start('checkout', null, { id: 'checkout-1' });
    await engine.start('checkout', null, { id: 'checkout-2' });

    const report = await catalog.diagnostics(DEPLOYMENT);

    expect(
      report.map(({ buildId, executionReferences }) => [buildId, executionReferences]),
    ).toEqual([
      ['build-1', 2],
      ['build-2', 0],
    ]);
  });

  it('refuses a removal whose build was resumed, routed to and bound to between its reads and its write', async () => {
    const storage = new InterleavingStorage();
    await using fx = await fixture(storage);
    const { engine, catalog } = fx;
    await drainBuildOne(catalog);
    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });

    storage.arm(async () => {
      // An operator lifts the drain and routes to the build again, and a run binds to it.
      await catalog.setVersionState(DEPLOYMENT, 'build-1', 'ready');
      await catalog.setRouting({
        deploymentName: DEPLOYMENT,
        currentBuildId: 'build-1',
        rampBasisPoints: 10_000,
        updatedAt: 3,
      });
      await engine.start('checkout', null, { id: 'checkout-racing' });
    });
    const fault = await faultOf(invoke(remove, REMOVE_BUILD_ONE));

    expect(fault).toMatchObject({ code: 'Conflict' });
    const version = await catalog.getVersion(DEPLOYMENT, 'build-1');
    expect(version?.state).toBe('ready');
    const [buildOne] = await catalog.diagnostics(DEPLOYMENT);
    expect(buildOne?.executionReferences).toBe(1);
  });
});

describe('a start cannot bind to a draining build', () => {
  it('does not bind an auto-upgrade start whose compatibility names a draining build, so it stays removable', async () => {
    await using fx = await fixture();
    const { storage, catalog, revision } = fx;
    await drainBuildOne(catalog);
    const policy = {
      mode: 'auto-upgrade' as const,
      compatibility: {
        deploymentName: DEPLOYMENT,
        buildId: 'build-1',
        artifactDigest: 'sha256:build-1',
        manifestDigest: 'sha256:manifest-build-1',
        workflowRevision: revision,
        activityContractHash: 'sha256:charge',
      },
    };

    expect(
      await rejectionOf(
        resolveWorkflowWorkerStartBinding(storage, {
          workflowId: 'checkout-auto',
          workflowType: 'checkout',
          workflowRevision: revision,
          policy,
          checkpointId: 'checkout-auto',
        }),
      ),
    ).toBeInstanceOf(NoRoutedWorkerDeploymentError);
    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
  });
});

describe('a restart or fork that would inherit a removed build', () => {
  /** A `checkout` run that finished on `build-1`, after which `build-1` was drained and removed. */
  async function finishedRunOnRemovedBuild() {
    const fixed = await fixture();
    const handle = await fixed.engine.start('checkout', null, { id: 'checkout-1' });
    await handle.signal('go', 'done');
    await handle.result();
    await drainBuildOne(fixed.catalog);
    // The finished run is not work: it no longer references the build, so removal succeeds.
    expect(await fixed.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
      outcome: 'removed',
    });
    return fixed;
  }

  it('fails the engine restart with a typed error rather than binding the new run to it', async () => {
    await using fx = await finishedRunOnRemovedBuild();
    const { engine, storage } = fx;

    const error = await rejectionOf(
      engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' }),
    );

    expect(error).toBeInstanceOf(WorkerDeploymentVersionRemovedError);
    expect(error).toMatchObject({ deploymentName: DEPLOYMENT, buildId: 'build-1' });
    // The restart left the finished run in place.
    expect(await storage.get('wf:checkout-1')).not.toBeNull();
  });

  it('answers a restart through startorsignal with Conflict version-removed, and a plain start of the same id is only a duplicate', async () => {
    await using fx = await finishedRunOnRemovedBuild();
    const { engine } = fx;

    // A plain start of an id that exists is a duplicate, not a restart.
    expect(
      await faultOf(invoke(startWorkflowOperation, { type: 'checkout', id: 'checkout-1' }, engine)),
    ).not.toMatchObject({ data: { reason: 'version-removed' } });

    const restart = await faultOf(
      invoke(
        createStartOrSignalWorkflowOperation(),
        {
          type: 'checkout',
          id: 'checkout-1',
          signalName: 'go',
          signalId: 'signal-1',
          onTerminalConflict: 'start-new',
        },
        engine,
      ),
    );
    expect(restart).toMatchObject({ code: 'Conflict', data: { reason: 'version-removed' } });
  });

  it('answers a fork of the finished run with Conflict version-removed and creates no run', async () => {
    await using fx = await finishedRunOnRemovedBuild();
    const { engine, storage } = fx;

    const fault = await faultOf(
      invoke(forkWorkflowOperation, { workflowId: 'checkout-1' }, engine),
    );

    expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-removed' } });
    const runs: string[] = [];
    for await (const [key] of storage.scan('wf:')) if (!key.slice(3).includes(':')) runs.push(key);
    expect(runs).toEqual(['wf:checkout-1']);
  });
});

describe('seeded work is counted the way the engine records it', () => {
  it('counts a bound run and a ledger entry, and refuses removal until both finish', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      artifactDigest: 'sha256:build-1',
      manifestDigest: 'sha256:manifest-build-1',
      manifest: buildManifest('revision-a', 'build-1'),
      state: 'draining',
      firstSeenAt: 1,
    });
    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
    });
    await seedLedgerEntry(storage, {
      operationId: 'operation-1',
      requirement: { deploymentName: DEPLOYMENT, buildId: 'build-1' },
    });

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
      outcome: 'referenced',
      references: 2,
    });

    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      status: 'completed',
    });
    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
      outcome: 'referenced',
      references: 1,
    });
    await seedLedgerEntry(storage, {
      operationId: 'operation-1',
      requirement: { deploymentName: DEPLOYMENT, buildId: 'build-1' },
      finished: true,
    });
    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
  });
});
