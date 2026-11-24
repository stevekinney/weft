/**
 * COR-1582: the class guard, run over an engine that starts, restarts, forks, retries and
 * dispatches. The fixture's storage fails any committed batch that binds a run or a ledger entry
 * to a build without that build's stamp put and tombstone-absent condition
 * (`worker/deployment-build-fixture.test-support.ts`), so a binding path added anywhere in the
 * engine without both fails here, at the first test that drives it, rather than silently shrinking
 * the set of paths the removal protocol covers.
 */
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  buildManifest,
  DEPLOYMENT,
  InterleavingStorage,
  ownStampKeyOf,
  runOf,
} from '../../worker/deployment-build-fixture.test-support.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import { taskLedgerKey } from '../task-ledger/task-ledger-keys.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { EngineOwnedRemoteActivityBroker } from './remote-activity-broker.ts';

describe('every binding commit an engine makes is stamped and guarded', () => {
  it('starts, restarts, forks, retries a failed run, and enqueues a ledger entry through the guard', async () => {
    const storage = new InterleavingStorage();
    const engine = new Engine({ storage });
    try {
      engine.register(
        workflow({ name: 'checkout', workerVersioningPolicy: { mode: 'pinned' } }).execute(
          async function* (ctx, input: { fail?: boolean }) {
            yield* ctx.waitForSignal('go');
            if (input.fail === true) throw new Error('boom');
            return 'done';
          },
        ),
      );
      const [first] = await engine.workflows.listRevisions('checkout');
      const catalog = new WorkerDeploymentCatalog(storage);
      await catalog.registerVersion({
        deploymentName: DEPLOYMENT,
        buildId: 'build-1',
        artifactDigest: 'sha256:build-1',
        manifestDigest: 'sha256:manifest-build-1',
        manifest: buildManifest(first?.manifest.revision ?? '', 'build-1'),
        state: 'ready',
        firstSeenAt: 1,
      });
      await catalog.setRouting({
        deploymentName: DEPLOYMENT,
        currentBuildId: 'build-1',
        rampBasisPoints: 10_000,
        updatedAt: 1,
      });

      // A fresh start, then a restart of the finished run over its id.
      const started = await engine.start('checkout', {}, { id: 'run-1' });
      await started.signal('go');
      await started.result();
      const restarted = await engine.start(
        'checkout',
        {},
        { id: 'run-1', onTerminalConflict: 'start-new' },
      );
      // A fork of the restarted run.
      const forked = await engine.fork('run-1');
      // A run that fails, and the retry of it.
      const failing = await engine.start('checkout', { fail: true }, { id: 'run-fail' });
      await failing.signal('go');
      await rejectionOf(failing.result());
      const retried = await engine.retryFailedAll({ status: 'failed' });
      expect(retried).toMatchObject({ retried: 1 });
      // A ledger entry for the run's activity.
      const broker = new EngineOwnedRemoteActivityBroker(storage, {}, () => {});
      await broker.enqueue({
        operationId: 'op-1',
        workflowId: 'run-1',
        workflowType: 'checkout',
        activityName: 'charge',
        input: {},
        headers: {},
      });

      expect(restarted.id).toBe('run-1');
      expect(await runOf(storage, forked.id)).toMatchObject({ buildId: 'build-1' });
      expect(await storage.get(taskLedgerKey('op-1'))).not.toBeNull();
      expect(await storage.get(ownStampKeyOf('build-1', 'run-1'))).not.toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
