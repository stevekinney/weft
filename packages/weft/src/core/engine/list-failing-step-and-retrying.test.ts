/**
 * COR-2530: a caller lists the runs that failed at a named step, or that are retrying an activity
 * now, without reading every run's history.
 *
 * The matrix crosses the ways a run ends up in, or out of, each filter with what `engine.list`,
 * `engine.aggregate` and the bulk stream return, and with the `wf-retrying:` index behind
 * `retrying: true`.
 *
 * | Row | Scenario | Expected |
 * | --- | --- | --- |
 * | backoff-listed | an activity failed once and its backoff is pending | `retrying: true` lists it, from the index alone |
 * | settled-unlisted | the retried attempt succeeds | the run leaves `retrying: true` and its index entry is gone |
 * | recovery-settles | the process stops in a backoff, a new one recovers and the activity settles | no run is left indexed as retrying |
 * | ends-while-retrying | a run exhausts its retries, is cancelled in a backoff, or is cancelled after a crash and recovery | terminal cleanup deletes the record, so no entry outlives the run |
 * | stale-entry | an index entry names a run that is not retrying (finished, or another run's token) | the entry never matches |
 * | negation | `retrying: false` | every run that is not retrying, including a running one with no record |
 * | failed-step | runs failed at different steps | `failedStep` lists the matching ones only |
 * | long-label | a failed step's label is 300 characters | the full label matches the stored 200-character cut |
 * | combined | `failedStep` or `retrying` with `status`, `type`, `idPrefix` and each other | the filters AND together |
 * | aggregate | the same filters on `engine.aggregate` | the counts follow the same runs |
 * | bulk | the bulk stream honors both | a bulk filter never drops one silently |
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { isParkedOn, statusOf } from '../../testing/run-observation.test-support.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { streamMatchingWorkflowStates } from './workflow-state-stream.ts';

const START = 1_000_000;
const BACKOFF = { maxAttempts: 3, initialBackoff: '2s', backoffMultiplier: 1, maxBackoff: '2s' };
const NO_BACKOFF = { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 };

const alwaysFails = (name: string, retry?: Record<string, unknown>) =>
  activity({
    name,
    ...(retry === undefined ? {} : { retry }),
    execute: async () => {
      throw new Error('always-fails');
    },
  } as never);

async function idsOf(engine: Engine, filter: Parameters<Engine['list']>[0]): Promise<string[]> {
  const page = await engine.list(filter);
  return page.items.map((item) => item.id).toSorted();
}

async function retryingRecordKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(KEYS.activityRetryingPrefix())) keys.push(key);
  return keys;
}

/** Wait until terminal cleanup has removed every retrying record: no entry outlives its run. */
async function waitForNoRetryingRecords(storage: MemoryStorage): Promise<void> {
  await waitForCondition(
    async () => {
      const keys = await retryingRecordKeys(storage);
      return keys.length === 0;
    },
    { label: 'terminal cleanup to remove every retrying record' },
  );
}

/** Wait until the run's retry decision is durable: its `wf-retrying:` record is committed. */
async function waitForRetryingRecord(storage: MemoryStorage, id: string): Promise<void> {
  await waitForCondition(async () => (await storage.get(KEYS.activityRetrying(id))) !== null, {
    label: `retrying record for "${id}"`,
  });
}

async function waitForParkedOnDone(engine: Engine, id: string): Promise<void> {
  await waitForCondition(() => isParkedOn(engine, id, 'done'), {
    label: `"${id}" to park on the done signal`,
  });
}

async function waitForStatus(engine: Engine, id: string, status: WorkflowState['status']) {
  await waitForCondition(async () => (await statusOf(engine, id)) === status, {
    label: `"${id}" to be ${status}`,
  });
}

/** A workflow whose only step is the given activity, so the run ends at that step's label. */
function failingWorkflow(name: string, step: ReturnType<typeof alwaysFails>, stepName: string) {
  return workflow({ name })
    .activities({ [stepName]: step })
    .execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.run(step);
    });
}

async function failRun(engine: Engine, type: string, id: string): Promise<void> {
  const handle = await engine.start(type, null, { id });
  await throwingRejectionOf(handle.result());
  await waitForStatus(engine, id, 'failed');
}

/** A run parked in its backoff before attempt 2 of `flaky`, on a clock that never reaches the retry. */
async function startBackoffRun(engine: Engine, storage: MemoryStorage, id: string): Promise<void> {
  const flaky = alwaysFails('flaky', BACKOFF);
  engine.register(failingWorkflow('backoff-run', flaky, 'flaky'));
  await engine.start('backoff-run', null, { id });
  await waitForRetryingRecord(storage, id);
}

describe('COR-2530 retrying filter', () => {
  it('backoff-listed: lists a run in its backoff from the retrying index alone', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage, getNow: () => START });
    await startBackoffRun(engine, storage, 'backoff-1');
    engine.register(
      workflow({ name: 'idle' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('done');
      }),
    );
    await engine.start('idle', null, { id: 'idle-1' });
    await waitForParkedOnDone(engine, 'idle-1');

    expect(await idsOf(engine, { retrying: true })).toEqual(['backoff-1']);
    expect(await engine.list({ retrying: true })).toMatchObject({
      total: 1,
      items: [{ id: 'backoff-1', retrying: { activity: 'flaky', attempt: 2 } }],
    });
    expect(await retryingRecordKeys(storage)).toEqual([KEYS.activityRetrying('backoff-1')]);
    expect(await engine.aggregate({ retrying: true }, { groupBy: 'status' })).toMatchObject({
      total: 1,
      groups: [{ key: 'running', count: 1 }],
    });
  });

  it('settled-unlisted: a settled activity leaves the filter and the index', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventually = activity({
      name: 'eventually',
      retry: NO_BACKOFF,
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        await gate;
        return 'ok';
      },
    } as never);
    engine.register(
      workflow({ name: 'settles' })
        .activities({ eventually })
        .execute(async function* (ctx: WorkflowContext) {
          const value = yield* ctx.run(eventually);
          yield* ctx.waitForSignal('done');
          return value;
        }),
    );
    await engine.start('settles', null, { id: 'settles-1' });
    await waitForCondition(async () => calls === 2, { label: 'attempt 2 running' });
    expect(await idsOf(engine, { retrying: true })).toEqual(['settles-1']);
    expect(await retryingRecordKeys(storage)).toEqual([KEYS.activityRetrying('settles-1')]);

    release?.();
    await waitForParkedOnDone(engine, 'settles-1');

    expect(await idsOf(engine, { retrying: true })).toEqual([]);
    expect(await retryingRecordKeys(storage)).toEqual([]);
    expect(await idsOf(engine, { retrying: false })).toEqual(['settles-1']);
  });

  it('recovery-settles: a crash in a backoff never leaves a settled run indexed', async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const flaky = activity({
      name: 'flaky',
      retry: BACKOFF,
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return 'ok';
      },
    } as never);
    const build = (now: number) => {
      const engine = new Engine({ storage, getNow: () => now });
      engine.register(
        workflow({ name: 'recovers' })
          .activities({ flaky })
          .execute(async function* (ctx: WorkflowContext) {
            const value = yield* ctx.run(flaky);
            yield* ctx.waitForSignal('done');
            return value;
          }),
      );
      return engine;
    };
    const first = build(START);
    await first.start('recovers', null, { id: 'recovers-1' });
    await waitForRetryingRecord(storage, 'recovers-1');
    expect(await idsOf(first, { retrying: true })).toEqual(['recovers-1']);
    first[Symbol.dispose]();

    await using second = build(START + 60_000);
    // The record committed with the checkpoint survives the crash, so the recovered engine lists it.
    expect(await idsOf(second, { retrying: true })).toEqual(['recovers-1']);
    await second.recoverAll();
    await waitForParkedOnDone(second, 'recovers-1');

    expect(await idsOf(second, { retrying: true })).toEqual([]);
    expect(await retryingRecordKeys(storage)).toEqual([]);
  });

  it('ends-while-retrying: a run that fails or is cancelled in its retries leaves no index entry', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    // Retries exhaust on attempt 3 and the error ends the run, with the record committed at attempt 2.
    const flaky = alwaysFails('flaky', NO_BACKOFF);
    engine.register(failingWorkflow('exhausts', flaky, 'flaky'));
    await failRun(engine, 'exhausts', 'exhausts-1');

    // A run cancelled in the backoff before attempt 2.
    await startBackoffRun(engine, storage, 'cancelled-1');
    expect(await idsOf(engine, { retrying: true })).toEqual(['cancelled-1']);
    await engine.cancel('cancelled-1');
    await waitForStatus(engine, 'cancelled-1', 'cancelled');

    expect(await idsOf(engine, { retrying: true })).toEqual([]);
    await waitForNoRetryingRecords(storage);
  });

  it('ends-while-retrying: a run cancelled after a crash and recovery leaves no index entry', async () => {
    const storage = new MemoryStorage();
    const flaky = alwaysFails('flaky', {
      maxAttempts: 3,
      initialBackoff: '1h',
      backoffMultiplier: 1,
      maxBackoff: '1h',
    });
    const build = (getNow?: () => number) => {
      const engine = new Engine({ storage, ...(getNow === undefined ? {} : { getNow }) });
      engine.register(failingWorkflow('recovers-then-ends', flaky, 'flaky'));
      return engine;
    };
    // The first process stops in its backoff before attempt 2.
    const first = build(() => START);
    await first.start('recovers-then-ends', null, { id: 'recovered-1' });
    await waitForRetryingRecord(storage, 'recovered-1');
    first[Symbol.dispose]();

    // The second recovers the run (attempt 2 is overdue on its clock), attempt 2 fails, and the
    // run waits in the backoff before attempt 3: the record now names attempt 3.
    await using second = build(() => START + 2 * 60 * 60 * 1000);
    await second.recoverAll();
    await waitForCondition(
      async () => {
        const bytes = await storage.get(KEYS.activityRetrying('recovered-1'));
        return bytes !== null && (decode(bytes) as { attempt?: number }).attempt === 3;
      },
      { label: 'the recovered run to wait before attempt 3' },
    );
    expect(await idsOf(second, { retrying: true })).toEqual(['recovered-1']);

    await second.cancel('recovered-1');
    await waitForStatus(second, 'recovered-1', 'cancelled');

    expect(await idsOf(second, { retrying: true })).toEqual([]);
    await waitForNoRetryingRecords(storage);
  });

  it('stale-entry: an entry for a run that is not retrying never matches', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'finished' }).execute(async function* () {
        return 'done';
      }),
    );
    const handle = await engine.start('finished', null, { id: 'finished-1' });
    await handle.result();
    engine.register(
      workflow({ name: 'waiting' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('done');
      }),
    );
    await engine.start('waiting', null, { id: 'waiting-1' });
    await waitForParkedOnDone(engine, 'waiting-1');

    // A finished run's leftover record, and a running run's record that names another run.
    await storage.put(
      KEYS.activityRetrying('finished-1'),
      encode({ activity: 'flaky', attempt: 2 }),
    );
    await storage.put(
      KEYS.activityRetrying('waiting-1'),
      encode({ activity: 'flaky', attempt: 2, workflowExecutionToken: 'another-run' }),
    );

    expect(await idsOf(engine, { retrying: true })).toEqual([]);
    expect(await idsOf(engine, { retrying: false })).toEqual(['finished-1', 'waiting-1']);
  });

  it('negation: retrying false lists every run that is not retrying', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage, getNow: () => START });
    await startBackoffRun(engine, storage, 'backoff-1');
    engine.register(
      workflow({ name: 'idle' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('done');
      }),
    );
    await engine.start('idle', null, { id: 'idle-1' });
    await waitForParkedOnDone(engine, 'idle-1');

    expect(await idsOf(engine, { retrying: false })).toEqual(['idle-1']);
    expect(await idsOf(engine, {})).toEqual(['backoff-1', 'idle-1']);
  });
});

describe('COR-2530 failedStep filter', () => {
  async function failedRuns() {
    const engine = new Engine();
    const chargeCard = alwaysFails('charge-card');
    const shipOrder = alwaysFails('ship-order');
    const longName = 'x'.repeat(300);
    const longStep = alwaysFails(longName);
    engine.register(failingWorkflow('order-a', chargeCard, 'charge-card'));
    engine.register(failingWorkflow('order-b', shipOrder, 'ship-order'));
    engine.register(failingWorkflow('order-c', longStep, longName));
    await failRun(engine, 'order-a', 'a-1');
    await failRun(engine, 'order-a', 'a-2');
    await failRun(engine, 'order-b', 'b-1');
    await failRun(engine, 'order-c', 'c-1');
    engine.register(
      workflow({ name: 'idle' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('done');
      }),
    );
    await engine.start('idle', null, { id: 'idle-1' });
    await waitForParkedOnDone(engine, 'idle-1');
    return engine;
  }

  it('failed-step: lists only the runs that failed at the named step', async () => {
    await using engine = await failedRuns();

    expect(await idsOf(engine, { failedStep: 'charge-card' })).toEqual(['a-1', 'a-2']);
    expect(await idsOf(engine, { failedStep: 'ship-order' })).toEqual(['b-1']);
    expect(await idsOf(engine, { failedStep: 'no-such-step' })).toEqual([]);
  });

  it('long-label: the full label matches the stored 200-character cut', async () => {
    await using engine = await failedRuns();

    expect(await idsOf(engine, { failedStep: 'x'.repeat(300) })).toEqual(['c-1']);
    expect(await idsOf(engine, { failedStep: 'x'.repeat(200) })).toEqual(['c-1']);
    expect(await idsOf(engine, { failedStep: 'x'.repeat(199) })).toEqual([]);
  });

  it('combined: ANDs with the other filters', async () => {
    await using engine = await failedRuns();

    expect(await idsOf(engine, { failedStep: 'charge-card', type: 'order-a' })).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(await idsOf(engine, { failedStep: 'charge-card', type: 'order-b' })).toEqual([]);
    expect(await idsOf(engine, { failedStep: 'charge-card', idPrefix: 'a-2' })).toEqual(['a-2']);
    expect(await idsOf(engine, { failedStep: 'charge-card', status: 'completed' })).toEqual([]);
    expect(
      await idsOf(engine, {
        failedStep: 'charge-card',
        status: 'failed',
        failureCategory: 'system',
      }),
    ).toEqual([]);
    expect(await idsOf(engine, { failedStep: 'charge-card', retrying: true })).toEqual([]);
    expect(await idsOf(engine, { failedStep: 'charge-card', retrying: false })).toEqual([
      'a-1',
      'a-2',
    ]);
    const secondPage = await engine.list({ failedStep: 'charge-card', limit: 1, offset: 1 });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.total).toBe(2);
  });

  it('aggregate: counts the same runs', async () => {
    await using engine = await failedRuns();

    expect(
      await engine.aggregate({ failedStep: 'charge-card' }, { groupBy: 'type' }),
    ).toMatchObject({
      total: 2,
      groups: [{ key: 'order-a', count: 2 }],
    });
    expect(await engine.aggregate({ retrying: true }, { groupBy: 'status' })).toMatchObject({
      total: 0,
    });
  });

  it('bulk: the bulk stream honors both filters', async () => {
    await using engine = await failedRuns();
    const internals = getInternals(engine);

    const byStep: string[] = [];
    for await (const state of streamMatchingWorkflowStates(internals, {
      status: 'failed',
      failedStep: 'ship-order',
    })) {
      byStep.push(state.id);
    }
    expect(byStep).toEqual(['b-1']);

    const retrying: string[] = [];
    for await (const state of streamMatchingWorkflowStates(internals, {
      status: ['failed', 'running'],
      retrying: true,
    })) {
      retrying.push(state.id);
    }
    expect(retrying).toEqual([]);
  });
});
