/**
 * COR-1582, correction 2: a run must never end up bound to a removed build, by optimistic
 * concurrency and not by a lock.
 *
 * Every commit that binds durable work to a build puts a fresh binding stamp for it (a blind
 * write) and requires the build's tombstone key to be absent. `remove` reads the version, the
 * routing and the stamp, scans, and writes `removed` and the tombstone conditioned on all three.
 * A binding that commits during the scan changes the stamp, so the removal rescans and sees it;
 * one that commits after the removal meets the tombstone. These tests place bindings at each of
 * those points. Each asserts the invariant itself, that no non-terminal run is bound to a removed
 * build, and the typed outcome of whichever side lost.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { encode } from '../core/codec/index.ts';
import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import {
  assertNoRunOnRemovedBuild,
  buildManifest,
  DEPLOYMENT,
  drainBuildOne,
  finishedRunOnDrainedBuild,
  fixture,
  InterleavingStorage,
  ownShardOf,
  ownStampKeyOf,
  putsKeyWithPrefix,
  runOf,
  runs,
  stampKeyOf,
  stateOf,
  tombstoneKeyOf,
  writesVersionState,
} from './deployment-build-fixture.test-support.ts';
import { seedBoundRun } from './deployment-build-references.test-support.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';

const versionKey = (buildId: string) => `worker-deployment-version:${DEPLOYMENT}:${buildId}`;
const atRemovalWrite = (operations: Parameters<typeof writesVersionState>[0]) =>
  writesVersionState(operations, 'removed');

describe('a restart racing a removal', () => {
  it('fails a restart whose build check read the build as draining once the removal has finished', async () => {
    // The door review's round-one probe: the removal runs to completion right after the restart's
    // own read of the version record, so the restart goes on to commit on bytes that said
    // `draining`.
    const storage = new InterleavingStorage();
    await using fx = await finishedRunOnDrainedBuild(storage);
    const { engine, catalog } = fx;
    let removal: unknown;
    storage.armGet(versionKey('build-1'), async () => {
      removal = await catalog.removeVersion(DEPLOYMENT, 'build-1');
    });

    const restart = await rejectionOf(
      engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' }),
    );

    expect(storage.fired).toBe(true);
    expect(removal).toEqual({ outcome: 'removed' });
    expect(restart).toMatchObject({ name: 'WorkerDeploymentVersionRemovedError' });
    expect(await runOf(storage, 'checkout-1')).toEqual({ status: 'completed', buildId: 'build-1' });
    await assertNoRunOnRemovedBuild(storage, catalog);
  });

  it('refuses the removal for a restart that commits between its scan and its write', async () => {
    // The primary review's probe C: the restart changes neither the version nor the routing
    // record, only the build's stamp, so the stamp condition is what stops the removal.
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    storage.arm(async () => {
      await engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' });
    }, atRemovalWrite);

    const outcome = await catalog.removeVersion(DEPLOYMENT, 'build-1');

    expect(storage.fired).toBe(true);
    // The write lost its stamp condition, the rescan found the restarted run, and the removal
    // refused it.
    expect(outcome).toEqual({ outcome: 'referenced', references: 1 });
    expect(await runOf(storage, 'checkout-1')).toEqual({ status: 'running', buildId: 'build-1' });
    expect(await stateOf(catalog, 'build-1')).toBe('draining');
    expect(await storage.get(tombstoneKeyOf('build-1'))).toBeNull();
  });

  it('refuses the removal for a restart that lands after the run records were scanned, because the stamp was read first', async () => {
    // The scan has passed every run record and not yet reached the ledger when the restart
    // commits. Only a stamp read before the scan can see that: read after it, the removal would
    // take the restart's stamp as its own and strand the run.
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    storage.armScan('task-ledger:', async () => {
      await engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' });
    });

    const outcome = await catalog.removeVersion(DEPLOYMENT, 'build-1');

    expect(storage.fired).toBe(true);
    expect(outcome).toEqual({ outcome: 'referenced', references: 1 });
    await assertNoRunOnRemovedBuild(storage, catalog);
  });

  it('lets a restart that committed before the removal read the stamp stand, and refuses the removal for it', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    await engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' });

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
      outcome: 'referenced',
      references: 1,
    });
    expect(await storage.get(tombstoneKeyOf('build-1'))).toBeNull();
  });
});

describe('each removal write condition is pinned on its own', () => {
  async function drainingBuildB() {
    const storage = new InterleavingStorage();
    const fx = await fixture(storage);
    await fx.catalog.setVersionState(DEPLOYMENT, 'build-2', 'draining');
    return { ...fx, storage };
  }

  it('probe A: a drain lifted, and nothing else, during the scan fails the write on the version bytes', async () => {
    await using fx = await drainingBuildB();
    const { storage, catalog } = fx;
    const rival = new WorkerDeploymentCatalog(storage);
    storage.arm(async () => {
      await rival.setVersionState(DEPLOYMENT, 'build-2', 'ready');
    }, atRemovalWrite);

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({
      outcome: 'not-draining',
      state: 'ready',
    });

    expect(storage.fired).toBe(true);
    expect(await stateOf(catalog, 'build-2')).toBe('ready');
    expect(await storage.get(tombstoneKeyOf('build-2'))).toBeNull();
  });

  it('probe B: resume, route to the build, drain again (same version bytes) fails the write on the routing bytes', async () => {
    await using fx = await drainingBuildB();
    const { storage, catalog } = fx;
    const before = await storage.get(versionKey('build-2'));
    const rival = new WorkerDeploymentCatalog(storage);
    storage.arm(async () => {
      await rival.setVersionState(DEPLOYMENT, 'build-2', 'ready');
      await rival.setRouting({
        deploymentName: DEPLOYMENT,
        currentBuildId: 'build-2',
        rampBasisPoints: 10_000,
        updatedAt: 3,
        expectedGeneration: 1,
      });
      await rival.setVersionState(DEPLOYMENT, 'build-2', 'draining');
      expect(await storage.get(versionKey('build-2'))).toEqual(before);
    }, atRemovalWrite);

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({ outcome: 'routed' });

    expect(storage.fired).toBe(true);
    expect(await stateOf(catalog, 'build-2')).toBe('draining');
    expect(await storage.get(tombstoneKeyOf('build-2'))).toBeNull();
  });

  it('probe C: a stamp that changes on its own fails the write, and the rescan removes the build', async () => {
    await using fx = await drainingBuildB();
    const { storage, catalog } = fx;
    storage.arm(async () => {
      // A binding that finished: only the stamp moved.
      await storage.put(stampKeyOf('build-2', 5), new Uint8Array([7, 7, 7]));
    }, atRemovalWrite);

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({ outcome: 'removed' });

    expect(storage.fired).toBe(true);
    expect(await stateOf(catalog, 'build-2')).toBe('removed');
  });

  it('probe D: a restart conditioned on the version bytes it read does not stop a removal, the stamp does', async () => {
    // Round one's emulation of the version-bytes proposal: the restart commits between the scan
    // and the write, on bytes that still say `draining`. Removal does not touch the version
    // record until its write, so only the stamp can see the restart; the run is never stranded.
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    storage.arm(async () => {
      await engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' });
    }, atRemovalWrite);

    await catalog.removeVersion(DEPLOYMENT, 'build-1');

    await assertNoRunOnRemovedBuild(storage, catalog);
    expect(await stateOf(catalog, 'build-1')).toBe('draining');
  });
});

describe('a child of a running parent during a removal', () => {
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
    for (const buildId of ['build-1', 'build-2']) {
      await catalog.registerVersion({
        deploymentName: DEPLOYMENT,
        buildId,
        artifactDigest: `sha256:${buildId}`,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: buildManifest(revision, buildId, 'tree'),
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
    const parent = await engine.start('tree', { role: 'parent' }, { id: 'tree-parent' });
    await drainBuildOne(catalog);
    return { storage, engine, catalog, parent };
  }

  it('C1-P2: the parent starts its child and completes, and the removal refuses the build while it runs', async () => {
    const { storage, engine, catalog, parent } = await treeFixture();
    try {
      // The removal is in its scan when the parent, which it counts, starts and finishes a child.
      let outcome: unknown;
      storage.armScan('wf:', async () => {
        await parent.signal('spawn');
        expect(await parent.result()).toBe('child-done');
      });
      outcome = await catalog.removeVersion(DEPLOYMENT, 'build-1');

      expect(storage.fired).toBe(true);
      // The parent finished while the removal read the stamp and scanned: the stamp had moved, so
      // the write failed and the rescan found nothing left bound. Nothing was failed on the way.
      expect(outcome).toEqual({ outcome: 'removed' });
      expect(await runOf(storage, 'tree-parent')).toEqual({
        status: 'completed',
        buildId: 'build-1',
      });
      expect(await runOf(storage, 'tree-child')).toEqual({
        status: 'completed',
        buildId: 'build-1',
      });
      await assertNoRunOnRemovedBuild(storage, catalog);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('refuses the build for as long as the parent runs, and the parent still starts its child', async () => {
    const { storage, engine, catalog, parent } = await treeFixture();
    try {
      expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
        outcome: 'referenced',
        references: 1,
      });

      await parent.signal('spawn');
      expect(await parent.result()).toBe('child-done');

      expect(await runOf(storage, 'tree-child')).toEqual({
        status: 'completed',
        buildId: 'build-1',
      });
      expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('two removals', () => {
  it('C1-P3: both settle, the second answering removed, with no lock to wait on', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, catalog } = fx;
    const second = new WorkerDeploymentCatalog(storage);
    let inner: unknown;
    storage.arm(async () => {
      // The second removal runs to completion while the first is between its scan and its write.
      inner = await second.removeVersion(DEPLOYMENT, 'build-1');
    }, atRemovalWrite);

    const first = await catalog.removeVersion(DEPLOYMENT, 'build-1');

    expect(storage.fired).toBe(true);
    expect(inner).toEqual({ outcome: 'removed' });
    expect(first).toEqual({ outcome: 'removed' });
    expect(await stateOf(catalog, 'build-1')).toBe('removed');
    expect(await storage.get(tombstoneKeyOf('build-1'))).not.toBeNull();
  });

  it('settles two removals started together', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, catalog } = fx;

    const outcomes = await Promise.all([
      catalog.removeVersion(DEPLOYMENT, 'build-1'),
      new WorkerDeploymentCatalog(storage).removeVersion(DEPLOYMENT, 'build-1'),
    ]);

    expect(outcomes.every((outcome) => outcome.outcome === 'removed')).toBe(true);
    expect(await stateOf(catalog, 'build-1')).toBe('removed');
  });

  it('keeps the tombstone through a second removal and a restart', async () => {
    // Replaces the correction-1 scenario in which a reconciliation deleted the tombstone. Nothing
    // deletes it now: a second removal and a restart between the two removals' steps leave it.
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    let restart: unknown;
    storage.arm(async () => {
      await new WorkerDeploymentCatalog(storage).removeVersion(DEPLOYMENT, 'build-1');
      restart = await rejectionOf(
        engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' }),
      );
    }, atRemovalWrite);

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });

    expect(restart).toMatchObject({ name: 'WorkerDeploymentVersionRemovedError' });
    expect(await storage.get(tombstoneKeyOf('build-1'))).not.toBeNull();
    expect(await runOf(storage, 'checkout-1')).toEqual({ status: 'completed', buildId: 'build-1' });
    await assertNoRunOnRemovedBuild(storage, catalog);
  });
});

describe('the tombstone is permanent and opaque', () => {
  it('C1-P4: survives a resume, another removal, and an engine start, byte for byte', async () => {
    const storage = new InterleavingStorage();
    await using fx = await fixture(storage);
    await drainBuildOne(fx.catalog);
    expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
    const tombstone = await storage.get(tombstoneKeyOf('build-1'));
    expect(tombstone).not.toBeNull();
    fx.engine[Symbol.dispose]();

    await using restarted = await fixture(storage, false);
    await restarted.engine.start('checkout', null, { id: 'checkout-booted' });
    await restarted.catalog.setVersionState(DEPLOYMENT, 'build-1', 'ready');
    expect(await restarted.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
      outcome: 'not-found',
    });

    expect(await storage.get(tombstoneKeyOf('build-1'))).toEqual(tombstone);
    expect(await stateOf(restarted.catalog, 'build-1')).toBe('removed');
  });

  it('C1-P8: decodes neither the stamp nor the tombstone, so undecodable bytes stop nothing but the build they name', async () => {
    const storage = new InterleavingStorage();
    await using fx = await fixture(storage);
    await drainBuildOne(fx.catalog);
    // Bytes that are not MessagePack, as a stamp of the build being removed and a tombstone of
    // another build: a decode anywhere on the start path or the scan would throw here.
    await storage.put(stampKeyOf('build-1', 0), new Uint8Array([0xc1]));
    await storage.put(stampKeyOf('build-1', 63), new Uint8Array([0xc1]));
    await storage.put(tombstoneKeyOf('build-3'), new Uint8Array([0xc1, 0xc1]));

    expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
    await fx.engine.start('checkout', null, { id: 'checkout-after' });
    expect(await runOf(storage, 'checkout-after')).toEqual({
      status: 'running',
      buildId: 'build-2',
    });
    expect(await storage.get(tombstoneKeyOf('build-3'))).toEqual(new Uint8Array([0xc1, 0xc1]));
  });
});

describe('a start that loses for another reason keeps its own error', () => {
  it('C1-P5: a duplicate id is a duplicate, and a tombstoned build is removed, never the other way round', async () => {
    const storage = new InterleavingStorage();
    await using fx = await fixture(storage);
    const { engine } = fx;
    storage.arm(
      async () => {
        await engine.start('checkout', null, { id: 'checkout-race' });
      },
      (operations) =>
        putsKeyWithPrefix(operations, 'wf:checkout-race') &&
        storage.committedPuts.every((key) => key !== 'wf:checkout-race'),
    );

    // The inner start wins the id; the outer commit loses its duplicate-id condition, with the
    // tombstone absent, so that is what it is told.
    expect(
      await rejectionOf(engine.start('checkout', null, { id: 'checkout-race' })),
    ).toMatchObject({
      name: 'WorkflowAlreadyExistsError',
    });

    // With the tombstone present the same start is refused as removed, whatever else is true.
    await storage.put(tombstoneKeyOf('build-1'), encode(1));
    expect(
      await rejectionOf(engine.start('checkout', null, { id: 'checkout-late' })),
    ).toMatchObject({
      name: 'WorkerDeploymentVersionRemovedError',
    });
    expect(await runOf(storage, 'checkout-late')).toBeUndefined();
  });
});

describe('a removal that keeps losing', () => {
  async function drainingBuildB() {
    const storage = new InterleavingStorage();
    const fx = await fixture(storage);
    await fx.catalog.setVersionState(DEPLOYMENT, 'build-2', 'draining');
    return { ...fx, storage };
  }

  /** Moves the stamp before each of the removal's first `times` writes, as a binding landing each time would. */
  function bindingEveryAttempt(storage: MemoryStorage, times: number): { writes: () => number } {
    let writes = 0;
    const original = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      if (writesVersionState(operations, 'removed')) {
        writes += 1;
        if (writes <= times) await storage.put(stampKeyOf('build-2'), new Uint8Array([writes]));
      }
      return original(conditions, operations);
    };
    return { writes: () => writes };
  }

  it('answers busy after three attempts rather than looping', async () => {
    await using fx = await drainingBuildB();
    const { storage, catalog } = fx;
    const attempts = bindingEveryAttempt(storage, 99);

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({ outcome: 'busy' });

    expect(attempts.writes()).toBe(3);
    expect(await stateOf(catalog, 'build-2')).toBe('draining');
    expect(await storage.get(tombstoneKeyOf('build-2'))).toBeNull();
  });

  it('removes the build when the third attempt is the first to hold', async () => {
    await using fx = await drainingBuildB();
    const { storage, catalog } = fx;
    const attempts = bindingEveryAttempt(storage, 2);

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({ outcome: 'removed' });

    expect(attempts.writes()).toBe(3);
  });
});

describe('the class guard', () => {
  const boundRun = (buildId: string, status = 'running') =>
    encode({
      id: 'guarded',
      type: 'checkout',
      status,
      workerBinding: { current: { deploymentName: DEPLOYMENT, buildId } },
    });

  it("fails a committed batch that binds a run without the build's stamp and tombstone condition", async () => {
    const storage = new InterleavingStorage();

    expect(
      await rejectionOf(
        storage.conditionalBatch(
          [],
          [{ type: 'put', key: 'wf:guarded', value: boundRun('build-1') }],
        ),
      ),
    ).toBeInstanceOf(Error);
    const missingBoth = await rejectionOf(
      storage.conditionalBatch(
        [],
        [{ type: 'put', key: 'wf:guarded', value: boundRun('build-1') }],
      ),
    );
    expect((missingBoth as Error).message).toContain(
      "the build's stamp put and the tombstone-absent condition",
    );
    const missingCondition = await rejectionOf(
      storage.conditionalBatch(
        [],
        [
          { type: 'put', key: 'wf:guarded', value: boundRun('build-1') },
          { type: 'put', key: ownStampKeyOf('build-1', 'guarded'), value: new Uint8Array([1]) },
        ],
      ),
    );
    expect((missingCondition as Error).message).toContain('the tombstone-absent condition');
    const missingStamp = await rejectionOf(
      storage.conditionalBatch(
        [{ key: tombstoneKeyOf('build-1'), expectedValue: null }],
        [{ type: 'put', key: 'wf:guarded', value: boundRun('build-1') }],
      ),
    );
    expect((missingStamp as Error).message).toContain("the build's stamp put");
  });

  it('passes a stamped batch, and a rewrite of a run that is already live on the same build', async () => {
    const storage = new InterleavingStorage();
    const stamp = {
      type: 'put' as const,
      key: ownStampKeyOf('build-1', 'guarded'),
      value: new Uint8Array([1]),
    };
    const condition = { key: tombstoneKeyOf('build-1'), expectedValue: null };

    expect(
      await storage.conditionalBatch(
        [condition],
        [{ type: 'put', key: 'wf:guarded', value: boundRun('build-1') }, stamp],
      ),
    ).toBe(true);
    // A progress write of the same live run binds nothing new.
    expect(
      await storage.conditionalBatch(
        [],
        [{ type: 'put', key: 'wf:guarded', value: boundRun('build-1') }],
      ),
    ).toBe(true);
    // A terminal run written back live, or a run moved to another build, is a binding again.
    await storage.put('wf:guarded', boundRun('build-1', 'failed'));
    expect(
      await rejectionOf(
        storage.conditionalBatch(
          [],
          [{ type: 'put', key: 'wf:guarded', value: boundRun('build-1') }],
        ),
      ),
    ).toBeInstanceOf(Error);
    expect(
      await rejectionOf(
        storage.conditionalBatch(
          [],
          [{ type: 'put', key: 'wf:guarded', value: boundRun('build-2', 'running') }],
        ),
      ),
    ).toBeInstanceOf(Error);
  });

  it('ignores records that name no build, and keys that are not run or ledger records', async () => {
    const storage = new InterleavingStorage();

    await storage.batch([
      { type: 'put', key: 'wf:plain', value: encode({ id: 'plain', status: 'running' }) },
      { type: 'put', key: 'wf:plain:ckpt', value: boundRun('build-1') },
      { type: 'put', key: 'other', value: boundRun('build-1') },
    ]);

    expect(await runs(storage)).toEqual([['plain', 'running', undefined]]);
  });

  it('can be turned off for a test that writes records on purpose', async () => {
    const storage = new InterleavingStorage();
    storage.guardBindings = false;

    await storage.batch([{ type: 'put', key: 'wf:guarded', value: boundRun('build-1') }]);
    await seedBoundRun(storage, {
      workflowId: 'seeded',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
    });

    expect(await runOf(storage, 'guarded')).toEqual({ status: 'running', buildId: 'build-1' });
  });
});

describe('the stamp is 64 shards, and a binding writes only its own', () => {
  it('chooses a shard by the FNV-1a hash of the binding key, modulo 64, and spells shard keys as two hex digits', () => {
    // Persisted format: these values must never change.
    expect(
      ['run-1', 'checkout-1', 'fresh-1', 'op-1', 'boom-1', 'tree-child', '', 'é'].map((key) =>
        ownShardOf(key),
      ),
    ).toEqual([60, 55, 53, 28, 28, 30, 5, 1]);
    const keys = Array.from({ length: 64 }, (_, shard) => stampKeyOf('build-1', shard));
    expect(new Set(keys).size).toBe(64);
    expect(keys[0]).toBe('worker-deployment-binding:test-deployment:build-1:00');
    expect(keys[63]).toBe('worker-deployment-binding:test-deployment:build-1:3f');
    expect(
      Array.from({ length: 1000 }, (_, index) => ownShardOf(`run-${index}`)).every(
        (shard) => shard >= 0 && shard < 64,
      ),
    ).toBe(true);
  });

  it('fails the removal write whichever single shard a binding moves, so every shard is conditioned', async () => {
    // Dropping any one shard's condition at the removal write lets exactly that shard's binding
    // through; this runs all 64.
    for (let shard = 0; shard < 64; shard += 1) {
      const storage = new InterleavingStorage();
      await using fx = await fixture(storage);
      await fx.catalog.setVersionState(DEPLOYMENT, 'build-2', 'draining');
      const results: boolean[] = [];
      const original = storage.conditionalBatch.bind(storage);
      storage.conditionalBatch = async (conditions, operations) => {
        const applied = await original(conditions, operations);
        if (writesVersionState(operations, 'removed')) results.push(applied);
        return applied;
      };
      storage.arm(async () => {
        await storage.put(stampKeyOf('build-2', shard), new Uint8Array([shard]));
      }, atRemovalWrite);

      expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({ outcome: 'removed' });

      // The first write lost on the moved shard; the rescan's write held.
      expect(results, `shard ${shard}`).toEqual([false, true]);
    }
  });

  it("fails a committed batch that puts a shard that is not the binding's own", async () => {
    const storage = new InterleavingStorage();
    const wrong = (ownShardOf('guarded') + 1) % 64;
    const message = await rejectionOf(
      storage.conditionalBatch(
        [{ key: tombstoneKeyOf('build-1'), expectedValue: null }],
        [
          {
            type: 'put',
            key: 'wf:guarded',
            value: encode({
              id: 'guarded',
              status: 'running',
              workerBinding: { current: { deploymentName: DEPLOYMENT, buildId: 'build-1' } },
            }),
          },
          { type: 'put', key: stampKeyOf('build-1', wrong), value: new Uint8Array([1]) },
        ],
      ),
    );

    expect((message as Error).message).toContain('that is not its own');
  });
});

describe('only top-level run records are scanned', () => {
  it('ignores a checkpoint-shaped wf: key even when it carries a running binding', async () => {
    await using fx = await fixture();
    await drainBuildOne(fx.catalog);
    await fx.storage.put(
      'wf:run-1:ckpt',
      encode({
        status: 'running',
        workerBinding: { current: { deploymentName: DEPLOYMENT, buildId: 'build-1' } },
      }),
    );

    expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
  });
});
