/**
 * COR-1582, correction 2: every site that binds durable work to a build carries two things, and
 * each has a test that is red without it. The commit requires the build's tombstone key to be
 * absent, so a binding that meets a removed build fails with `version-removed` and binds nothing;
 * and it puts a fresh stamp for the build, so a removal that read the stamp earlier cannot commit.
 *
 * The sites: a fresh start, a restart, a child start, a fork, an automatic upgrade,
 * `bindWorkflowWorkerAtStart`, the retry of a failed run, and the three places a ledger entry is
 * created. Each test puts the tombstone with the build still `draining` on purpose, so the
 * pre-check that reads the version record passes and the commit's own condition is what answers.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { encode } from '../core/codec/index.ts';
import { Engine } from '../core/engine.ts';
import { EngineOwnedRemoteActivityBroker } from '../core/engine/remote-activity-broker.ts';
import { taskLedgerKey } from '../core/task-ledger/task-ledger-keys.ts';
import { commitTaskLedgerTransition } from '../core/task-ledger/task-ledger-runtime.ts';
import { createQueued } from '../core/task-ledger/task-ledger-transitions.ts';
import { workflow } from '../core/types.ts';
import { forkWorkflowOperation } from '../server/operations/fork-workflow.ts';
import { startWorkflowOperation } from '../server/operations/start-workflow.ts';
import {
  buildManifest,
  DEPLOYMENT,
  drainBuildOne,
  faultOf,
  finishedRunOnDrainedBuild,
  fixture,
  InterleavingStorage,
  invoke,
  ownShardOf,
  runOf,
  runs,
  stampKeyOf,
  tombstoneKeyOf,
} from './deployment-build-fixture.test-support.ts';
import { seedBoundRun } from './deployment-build-references.test-support.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import {
  bindWorkflowWorkerAtStart,
  recordWorkflowWorkerUpgrade,
  type WorkflowWorkerBinding,
} from './versioning-policy.ts';

const TOMBSTONE = new Uint8Array([1]);
const REMOVED = { name: 'WorkerDeploymentVersionRemovedError' };

/** The bytes of a build's stamp, or `null` when nothing has ever bound to it. */
/** All 64 stamp shards of a build, in shard order. */
const shardsOf = (storage: MemoryStorage, buildId: string) =>
  Promise.all(Array.from({ length: 64 }, (_, shard) => storage.get(stampKeyOf(buildId, shard))));

/** Nothing has ever stamped the build: every shard is absent. */
async function expectNoStamp(storage: MemoryStorage, buildId: string): Promise<void> {
  const shards = await shardsOf(storage, buildId);
  expect(shards.every((shard) => shard === null)).toBe(true);
}

/** The binding with this key put a fresh value to its own shard of the build, and to no other. */
async function expectOnlyOwnShardMoved(
  storage: MemoryStorage,
  buildId: string,
  bindingKey: string,
  before: readonly (Uint8Array | null)[],
): Promise<void> {
  const after = await shardsOf(storage, buildId);
  const moved = after.flatMap((value, shard) =>
    Bun.deepEquals(value, before[shard]) ? [] : [shard],
  );
  expect(moved).toEqual([ownShardOf(bindingKey)]);
}

describe('a fresh start', () => {
  it('fails as removed, and binds nothing, when the build it chose has a tombstone', async () => {
    await using fx = await fixture();
    await putTombstone(fx.storage, tombstoneKeyOf('build-1'));

    expect(await rejectionOf(fx.engine.start('checkout', null, { id: 'fresh-1' }))).toMatchObject(
      REMOVED,
    );

    expect(await runOf(fx.storage, 'fresh-1')).toBeUndefined();
    await expectNoStamp(fx.storage, 'build-1');
  });

  it('answers Conflict version-removed over weft.workflows.start, not an engine failure', async () => {
    await using fx = await fixture();
    await putTombstone(fx.storage, tombstoneKeyOf('build-1'));

    expect(
      await faultOf(
        invoke(startWorkflowOperation, { type: 'checkout', id: 'fresh-op' }, fx.engine),
      ),
    ).toMatchObject({ code: 'Conflict', data: { reason: 'version-removed' } });
  });

  it('puts a fresh stamp for the build in the same batch as the run', async () => {
    await using fx = await fixture();
    const before = await shardsOf(fx.storage, 'build-1');
    await fx.engine.start('checkout', null, { id: 'fresh-1' });
    await expectOnlyOwnShardMoved(fx.storage, 'build-1', 'fresh-1', before);
    const between = await shardsOf(fx.storage, 'build-1');
    await fx.engine.start('checkout', null, { id: 'fresh-2' });

    await expectOnlyOwnShardMoved(fx.storage, 'build-1', 'fresh-2', between);
    await expectNoStamp(fx.storage, 'build-2');
  });

  it('stamps the build a prepared run binds to, too', async () => {
    await using fx = await fixture();

    const before = await shardsOf(fx.storage, 'build-1');
    await fx.engine.prepare('checkout', null, { id: 'prepared-1' });

    await expectOnlyOwnShardMoved(fx.storage, 'build-1', 'prepared-1', before);
  });
});

describe('a restart', () => {
  it('fails as removed, and leaves the finished run, when the build has a tombstone', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    await putTombstone(fx.storage, tombstoneKeyOf('build-1'));

    expect(
      await rejectionOf(
        fx.engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' }),
      ),
    ).toMatchObject(REMOVED);

    expect(await runOf(fx.storage, 'checkout-1')).toEqual({
      status: 'completed',
      buildId: 'build-1',
    });
  });

  it('puts a fresh stamp for the build it inherits', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const before = await shardsOf(fx.storage, 'build-1');

    await fx.engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' });

    await expectOnlyOwnShardMoved(fx.storage, 'build-1', 'checkout-1', before);
  });
});

describe('a child start', () => {
  async function treeFixture() {
    const storage = new InterleavingStorage();
    const engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'tree', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* (ctx, input: { role: 'parent' | 'child' }) {
          if (input.role === 'child') return 'child-done';
          yield* ctx.waitForSignal('spawn');
          return yield* ctx.startChild('tree', { role: 'child' }, { id: 'tree-child' });
        },
      ),
    );
    const [first] = await engine.workflows.listRevisions('tree');
    const revision = first?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      artifactDigest: 'sha256:build-1',
      manifestDigest: 'sha256:manifest-build-1',
      manifest: buildManifest(revision, 'build-1', 'tree'),
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: DEPLOYMENT,
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const parent = await engine.start('tree', { role: 'parent' }, { id: 'tree-parent' });
    return { storage, engine, parent };
  }

  it('fails as removed, and creates no child, when the build has a tombstone', async () => {
    const { storage, engine, parent } = await treeFixture();
    try {
      await putTombstone(storage, tombstoneKeyOf('build-1'));

      await parent.signal('spawn');
      expect(await rejectionOf(parent.result())).toBeInstanceOf(Error);

      expect(await runOf(storage, 'tree-child')).toBeUndefined();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('puts a fresh stamp for the build it inherits', async () => {
    const { storage, engine, parent } = await treeFixture();
    try {
      const before = await shardsOf(storage, 'build-1');

      await parent.signal('spawn');
      expect(await parent.result()).toBe('child-done');

      await expectOnlyOwnShardMoved(storage, 'build-1', 'tree-child', before);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('a fork', () => {
  it('fails as removed, not as a missing revision, and creates no run, when the build has a tombstone', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    await putTombstone(fx.storage, tombstoneKeyOf('build-1'));

    expect(await rejectionOf(fx.engine.fork('checkout-1'))).toMatchObject(REMOVED);
    expect(
      await faultOf(invoke(forkWorkflowOperation, { workflowId: 'checkout-1' }, fx.engine)),
    ).toMatchObject({ code: 'Conflict', data: { reason: 'version-removed' } });

    expect(await runs(fx.storage)).toEqual([['checkout-1', 'completed', 'build-1']]);
  });

  it('is previewed as refused, and writes nothing, when the build the fork would inherit has a tombstone', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    await putTombstone(fx.storage, tombstoneKeyOf('build-1'));
    const before = await shardsOf(fx.storage, 'build-1');

    expect(await rejectionOf(fx.engine.previewFork('checkout-1'))).toMatchObject(REMOVED);
    expect(
      await faultOf(
        invoke(forkWorkflowOperation, { workflowId: 'checkout-1', dryRun: true }, fx.engine),
      ),
    ).toMatchObject({ code: 'Conflict', data: { reason: 'version-removed' } });

    expect(await runs(fx.storage)).toEqual([['checkout-1', 'completed', 'build-1']]);
    expect(await shardsOf(fx.storage, 'build-1')).toEqual(before);
  });

  it('puts a fresh stamp for the build it inherits', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const before = await shardsOf(fx.storage, 'build-1');

    const forked = await fx.engine.fork('checkout-1');

    await expectOnlyOwnShardMoved(fx.storage, 'build-1', forked.id, before);
  });

  it('keeps its own error when it loses for another reason', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    fx.storage.arm(
      async () => {
        for await (const [key] of fx.storage.scan('catalog-entry:')) await fx.storage.delete(key);
      },
      (operations) =>
        operations.some(
          (operation) =>
            operation.type === 'put' &&
            operation.key.startsWith('wf:') &&
            operation.key !== 'wf:checkout-1' &&
            !operation.key.includes(':', 3),
        ),
    );

    expect(await rejectionOf(fx.engine.fork('checkout-1'))).toMatchObject({
      name: 'WorkflowRevisionUnavailableError',
    });
  });
});

describe('an automatic worker upgrade', () => {
  const binding = (buildId: string): WorkflowWorkerBinding => ({
    workflowId: 'run-1',
    workflowType: 'checkout',
    deploymentName: DEPLOYMENT,
    buildId,
    artifactDigest: `sha256:${buildId}`,
    manifestDigest: `sha256:manifest-${buildId}`,
    routingGeneration: 1,
    workflowRevision: 'revision-a',
    workflowContractHash: 'sha256:workflow',
    activityContracts: {},
    activityName: '*',
    activityContractHash: 'sha256:workflow',
    boundAt: 1,
    checkpointId: 'run-1',
  });
  const policy = {
    mode: 'auto-upgrade' as const,
    compatibility: {
      deploymentName: DEPLOYMENT,
      buildId: 'build-2',
      artifactDigest: 'sha256:build-2',
      manifestDigest: 'sha256:manifest-build-2',
      workflowRevision: 'revision-a',
      activityContractHash: 'sha256:workflow',
    },
  };
  async function upgradingRun() {
    const storage = new InterleavingStorage();
    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      policy: 'auto-upgrade',
    });
    return storage;
  }

  it('is refused, and the run stays put, when the build it moves to has a tombstone', async () => {
    const storage = await upgradingRun();
    await putTombstone(storage, tombstoneKeyOf('build-2'));

    expect(
      await rejectionOf(
        recordWorkflowWorkerUpgrade(storage, policy, binding('build-1'), binding('build-2')),
      ),
    ).toMatchObject(REMOVED);

    expect(await runOf(storage, 'run-1')).toEqual({ status: 'running', buildId: 'build-1' });
    await expectNoStamp(storage, 'build-2');
  });

  it('puts a fresh stamp for the build it moves to', async () => {
    const storage = await upgradingRun();
    const before = await shardsOf(storage, 'build-2');

    await recordWorkflowWorkerUpgrade(storage, policy, binding('build-1'), binding('build-2'));

    expect(await runOf(storage, 'run-1')).toEqual({ status: 'running', buildId: 'build-2' });
    await expectOnlyOwnShardMoved(storage, 'build-2', 'run-1', before);
    await expectNoStamp(storage, 'build-1');
  });

  it('is refused when the run is not under an auto-upgrade policy', async () => {
    const storage = await upgradingRun();

    expect(
      await rejectionOf(
        recordWorkflowWorkerUpgrade(
          storage,
          { mode: 'pinned' },
          binding('build-1'),
          binding('build-2'),
        ),
      ),
    ).toMatchObject({ message: 'Worker upgrade requires auto-upgrade policy.' });

    expect(await runOf(storage, 'run-1')).toEqual({ status: 'running', buildId: 'build-1' });
  });
});

describe('bindWorkflowWorkerAtStart', () => {
  const binding = (buildId: string): WorkflowWorkerBinding => ({
    workflowId: 'run-1',
    workflowType: 'checkout',
    deploymentName: DEPLOYMENT,
    buildId,
    artifactDigest: `sha256:${buildId}`,
    manifestDigest: `sha256:manifest-${buildId}`,
    routingGeneration: 1,
    workflowRevision: 'revision-a',
    workflowContractHash: 'sha256:workflow',
    activityContracts: {},
    activityName: '*',
    activityContractHash: 'sha256:workflow',
    boundAt: 1,
    checkpointId: 'run-1',
  });
  async function unboundRun() {
    const storage = new InterleavingStorage();
    await storage.put('wf:run-1', encode({ id: 'run-1', type: 'checkout', status: 'running' }));
    return storage;
  }

  it('fails as removed, and binds nothing, when the build has a tombstone', async () => {
    const storage = await unboundRun();
    await putTombstone(storage, tombstoneKeyOf('build-1'));

    expect(await rejectionOf(bindWorkflowWorkerAtStart(storage, binding('build-1')))).toMatchObject(
      REMOVED,
    );

    expect(await runOf(storage, 'run-1')).toEqual({ status: 'running', buildId: undefined });
  });

  it('fails as removed when the build was removed before tombstones existed: a removed version record and no tombstone', async () => {
    const storage = await unboundRun();
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      artifactDigest: 'sha256:build-1',
      manifestDigest: 'sha256:manifest-build-1',
      manifest: buildManifest('revision-a', 'build-1'),
      state: 'ready',
      firstSeenAt: 1,
    });
    const version = await catalog.getVersion(DEPLOYMENT, 'build-1');
    await storage.put(
      `worker-deployment-version:${DEPLOYMENT}:build-1`,
      encode({ ...version, state: 'removed' }),
    );

    expect(await rejectionOf(bindWorkflowWorkerAtStart(storage, binding('build-1')))).toMatchObject(
      REMOVED,
    );

    expect(await runOf(storage, 'run-1')).toEqual({ status: 'running', buildId: undefined });
    await expectNoStamp(storage, 'build-1');
  });

  it('puts a fresh stamp for the build it binds', async () => {
    const storage = await unboundRun();
    const before = await shardsOf(storage, 'build-1');

    await bindWorkflowWorkerAtStart(storage, binding('build-1'));

    expect(await runOf(storage, 'run-1')).toEqual({ status: 'running', buildId: 'build-1' });
    await expectOnlyOwnShardMoved(storage, 'build-1', 'run-1', before);
  });
});

describe('the retry of a failed run', () => {
  async function failedRun() {
    const storage = new InterleavingStorage();
    const engine = new Engine({ storage });
    // The run fails on its first launch; after `armRelaunchWait` a relaunch waits for a signal, so
    // a retry that reactivates it leaves it running.
    let waitOnRelaunch = false;
    engine.register(
      workflow({ name: 'boom', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* (ctx) {
          if (!waitOnRelaunch) throw new Error('boom');
          return yield* ctx.waitForSignal<string>('go');
        },
      ),
    );
    const [first] = await engine.workflows.listRevisions('boom');
    const revision = first?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    for (const buildId of ['build-1', 'build-2']) {
      await catalog.registerVersion({
        deploymentName: DEPLOYMENT,
        buildId,
        artifactDigest: `sha256:${buildId}`,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: buildManifest(revision, buildId, 'boom'),
        state: 'ready',
        firstSeenAt: 1,
      });
    }
    await catalog.setRouting({
      deploymentName: DEPLOYMENT,
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const handle = await engine.start('boom', null, { id: 'boom-1' });
    await rejectionOf(handle.result());
    await drainBuildOne(catalog);
    return {
      storage,
      engine,
      catalog,
      armRelaunchWait: () => {
        waitOnRelaunch = true;
      },
    };
  }

  it('reports a run whose build is removed as version-removed and does not reactivate it', async () => {
    const { storage, engine, catalog } = await failedRun();
    try {
      // The failed run is terminal, so the removal counts nothing against it.
      expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });

      const result = await engine.retryFailedAll({ status: 'failed' });

      expect(result).toMatchObject({ retried: 0, failed: 1 });
      expect(result.errors[0]).toMatchObject({ id: 'boom-1', reason: 'version-removed' });
      expect(await runOf(storage, 'boom-1')).toEqual({ status: 'failed', buildId: 'build-1' });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('reports a build removed before tombstones existed, which has a removed version and no tombstone', async () => {
    const { storage, engine, catalog } = await failedRun();
    try {
      const version = await catalog.getVersion(DEPLOYMENT, 'build-1');
      await storage.put(
        `worker-deployment-version:${DEPLOYMENT}:build-1`,
        encode({ ...version, state: 'removed' }),
      );

      const result = await engine.retryFailedAll({ status: 'failed' });

      expect(result.errors[0]).toMatchObject({ id: 'boom-1', reason: 'version-removed' });
      expect(await runOf(storage, 'boom-1')).toEqual({ status: 'failed', buildId: 'build-1' });
      expect(await storage.get(tombstoneKeyOf('build-1'))).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it("lands between the removal's stamp reads and its write: the removal rescans, sees the reactivated run, and refuses", async () => {
    // The door review's probe 2. The retry commits while the removal holds the stamp shard the
    // run stamps, so the removal's write fails on that shard and the rescan counts the run.
    const { storage, engine, catalog, armRelaunchWait } = await failedRun();
    try {
      let retry: unknown;
      storage.armGet(stampKeyOf('build-1', ownShardOf('boom-1')), async () => {
        armRelaunchWait();
        retry = await engine.retryFailedAll({ status: 'failed' });
      });

      const outcome = await catalog.removeVersion(DEPLOYMENT, 'build-1');

      expect(storage.fired).toBe(true);
      expect(retry).toMatchObject({ retried: 1, failed: 0 });
      expect(outcome).toEqual({ outcome: 'referenced', references: 1 });
      expect(await runOf(storage, 'boom-1')).toEqual({ status: 'running', buildId: 'build-1' });
      expect(await storage.get(tombstoneKeyOf('build-1'))).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('answers a removal that lands after the retry looked at the build the same way', async () => {
    const { storage, engine } = await failedRun();
    try {
      // Only the tombstone: the version record still says `draining`, so only the reactivation
      // commit's own condition can refuse it.
      await putTombstone(storage, tombstoneKeyOf('build-1'));

      const result = await engine.retryFailedAll({ status: 'failed' });

      expect(result.errors[0]).toMatchObject({ id: 'boom-1', reason: 'version-removed' });
      expect(await runOf(storage, 'boom-1')).toEqual({ status: 'failed', buildId: 'build-1' });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('puts a fresh stamp for the build it reactivates the run on', async () => {
    const { storage, engine } = await failedRun();
    try {
      const before = await shardsOf(storage, 'build-1');

      await engine.retryFailedAll({ status: 'failed' });

      const reactivated = await runOf(storage, 'boom-1');
      expect(reactivated?.buildId).toBe('build-1');
      await expectOnlyOwnShardMoved(storage, 'build-1', 'boom-1', before);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('a ledger entry that requires a build', () => {
  const request = {
    operationId: 'op-1',
    workflowId: 'run-1',
    workflowType: 'checkout',
    activityName: 'charge',
    input: {},
    headers: {},
  };
  async function enqueuedBy() {
    const storage = new InterleavingStorage();
    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
    });
    return { storage, broker: new EngineOwnedRemoteActivityBroker(storage, {}, () => {}) };
  }

  it("the broker's enqueue fails as removed, creating no entry, when the build has a tombstone", async () => {
    const { storage, broker } = await enqueuedBy();
    await putTombstone(storage, tombstoneKeyOf('build-1'));

    expect(await rejectionOf(broker.enqueue(request))).toMatchObject(REMOVED);

    expect(await storage.get(taskLedgerKey('op-1'))).toBeNull();
  });

  it("the broker's enqueue puts a fresh stamp for the build", async () => {
    const { storage, broker } = await enqueuedBy();
    const before = await shardsOf(storage, 'build-1');

    await broker.enqueue(request);

    expect(await storage.get(taskLedgerKey('op-1'))).not.toBeNull();
    await expectOnlyOwnShardMoved(storage, 'build-1', 'op-1', before);
  });

  const createInput = {
    recordVersion: 1 as const,
    operationId: 'op-2',
    workflowType: 'checkout',
    activityName: 'charge',
    queue: 'default',
    input: {},
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    executionRequirement: { deploymentName: DEPLOYMENT, buildId: 'build-1' },
    createdAt: 1,
  };

  // The server's dispatch path creates through the same function, in `buildCreateThenClaimTransition`
  // (the create branch) and `enqueueTaskForLongPoll`; a record it creates names no build today, so
  // these two are exercised through the shared commit with a record that does.
  it("a create through the shared ledger commit, the server dispatch path's, is refused when the build has a tombstone", async () => {
    const storage = new InterleavingStorage();
    await putTombstone(storage, tombstoneKeyOf('build-1'));

    const result = await commitTaskLedgerTransition(storage, 'op-2', (current, now) =>
      createQueued(current, createInput, now),
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      removedBuild: { deploymentName: DEPLOYMENT, buildId: 'build-1' },
    });
    expect(await storage.get(taskLedgerKey('op-2'))).toBeNull();
  });

  it('a create through the shared ledger commit puts a fresh stamp, and a record that names no build puts none', async () => {
    const storage = new InterleavingStorage();

    const before = await shardsOf(storage, 'build-1');
    await commitTaskLedgerTransition(storage, 'op-2', (current, now) =>
      createQueued(current, createInput, now),
    );
    await expectOnlyOwnShardMoved(storage, 'build-1', 'op-2', before);

    const { executionRequirement: _none, ...unbound } = createInput;
    await commitTaskLedgerTransition(storage, 'op-3', (current, now) =>
      createQueued(current, { ...unbound, operationId: 'op-3' }, now),
    );
    await expectNoStamp(storage, 'build-2');
  });

  it('an update of an entry that already exists binds nothing and puts no stamp', async () => {
    const storage = new InterleavingStorage();
    await commitTaskLedgerTransition(storage, 'op-2', (current, now) =>
      createQueued(current, createInput, now),
    );
    const before = await shardsOf(storage, 'build-1');

    const result = await commitTaskLedgerTransition(storage, 'op-2', (current, now) =>
      createQueued(current, createInput, now),
    );

    expect(result.ok).toBe(false);
    expect(await shardsOf(storage, 'build-1')).toEqual(before);
  });
});

async function putTombstone(storage: MemoryStorage, key: string): Promise<void> {
  await storage.put(key, TOMBSTONE);
}
