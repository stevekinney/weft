/**
 * COR-1925: a tick commits its run, the schedule that names it and the next timer in one batch, and
 * resolves the run's services only once that batch has committed. A process that dies between the
 * commit and the resolver leaves a run recovery can finish: it asks the resolver for the run's
 * services with the schedule and occurrence the run belongs to, and the timer that fired does not
 * start the occurrence a second time.
 */
import { BunSQLiteStorage } from "../../embedded/storage-bun-sqlite/src/index.ts";
import { describe, expect, it } from 'bun:test';

import type { WorkflowServicesResolverInfo } from '../types/services-resolution.ts';
import { SCHEDULE_ID, stateOf } from './schedule-across-engines.test-support.ts';
import {
  createEngine,
  drainEngine,
  listRunningWorkflowIds,
  MINUTE,
  registerWorkflow,
  START,
} from './schedule.test-support.ts';

describe('a process that dies after a tick committed and before it resolved the run’s services', () => {
  it('recovers the run with its schedule and occurrence, and the tick does not start it again', async () => {
    const clock = { now: START };
    const shared = new BunSQLiteStorage(':memory:');
    const reached = Promise.withResolvers<void>();
    const dying = createEngine(clock, shared, {
      resolveWorkflowServices: () => {
        reached.resolve();
        return new Promise(() => {});
      },
    });
    registerWorkflow(dying, 'across-workflow', async function* (ctx) {
      yield* ctx.waitForSignal('release');
      return 'done';
    });
    await dying.schedule('across-workflow', null, '* * * * *', { id: SCHEDULE_ID });
    const { nextFireAt } = await stateOf(shared);
    clock.now = nextFireAt!;
    void dying.scheduler.tick(clock.now);
    await reached.promise;

    // The batch is whole: the run, its slot, the occurrence fired and the next occurrence's timer.
    const committed = await stateOf(shared);
    expect(committed.lastFireAt).toBe(nextFireAt!);
    expect(committed.nextFireAt).toBe(nextFireAt! + MINUTE);
    const runId = committed.currentWorkflowId!;
    expect(runId).toBeDefined();
    dying[Symbol.dispose]();

    const asked: WorkflowServicesResolverInfo[] = [];
    const recovered = createEngine(clock, shared, {
      resolveWorkflowServices: async (info) => {
        asked.push(info);
        return { status: 'available', services: {} };
      },
    });
    registerWorkflow(recovered, 'across-workflow', async function* (ctx) {
      yield* ctx.waitForSignal('release');
      return 'done';
    });
    try {
      await recovered.recoverAll();
      await drainEngine();
      // The timer that fired is still in the store, so the tick that follows the restart runs it.
      await recovered.scheduler.tick(clock.now);
      await drainEngine();

      expect(asked.map((info) => info.workflowId)).toEqual([runId]);
      expect(asked[0]?.schedule).toEqual({ id: SCHEDULE_ID, occurrence: nextFireAt! });
      expect(await listRunningWorkflowIds(recovered)).toEqual([runId]);
      const after = await stateOf(shared);
      expect(after.currentWorkflowId).toBe(runId);
      expect(after.lastFireAt).toBe(nextFireAt!);
    } finally {
      recovered[Symbol.dispose]();
    }
  });
});
