import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { AtomicStateConflictError } from '../atomic-state.ts';
import { decode, encode } from '../codec.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { getInternals } from './internals.ts';
import {
  buildWorkflowConcurrencyStartOperations,
  releaseWorkflowConcurrencySlot,
  releaseWorkflowConcurrencySlotForRun,
} from './workflow-concurrency.ts';

async function* waitForRelease(
  ctx: WorkflowContext,
  input: { value: string },
): AsyncGenerator<unknown, string, unknown> {
  const releaseValue = yield* ctx.waitForSignal<string>('release');
  return `${input.value}:${releaseValue}`;
}

describe('workflow concurrency slot release', () => {
  it('releases a run slot only while its committed state still owns the id', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-release', concurrency: { max: 2 } }).execute(waitForRelease),
    );
    const first = await engine.start('limited-release', { value: 'first' });
    const second = await engine.start('limited-release', { value: 'second' });
    const internals = getInternals(engine);
    const slotKey = KEYS.workflowConcurrency('limited-release', 'limited-release');
    const holderIds = async (): Promise<string[]> => {
      const bytes = await internals.storage.get(slotKey);
      const record = decode(bytes!) as { holders: { holderId: string }[] };
      return record.holders.map((holder) => holder.holderId);
    };
    // Runs here use generated ids, so `wf-gen:<id>` is absent for the owning run; another
    // generation is any bytes, as a start-new restart would have written.
    const fenceFor = async (workflowId: string, generation: Uint8Array | null = null) => ({
      identity: {
        generation,
        holderMarker: await internals.storage.get(KEYS.workflowConcurrencyHolder(workflowId)),
      },
    });
    expect(await holderIds()).toEqual([first.id, second.id]);

    // Re-acquiring an id that already holds keeps every other holder intact.
    const reacquire = await buildWorkflowConcurrencyStartOperations(
      internals,
      'limited-release',
      second.id,
      { value: 'second' },
      { max: 2 },
    );
    expect(reacquire.operations.length).toBeGreaterThan(0);

    // A run whose committed state no longer owns the id leaves a shared-partition entry and its marker alone.
    await releaseWorkflowConcurrencySlotForRun(
      internals,
      second.id,
      await fenceFor(second.id, new Uint8Array([1])),
    );
    expect(await holderIds()).toEqual([first.id, second.id]);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(second.id))).not.toBeNull();

    // A run that never held a slot has nothing to release.
    await releaseWorkflowConcurrencySlotForRun(internals, second.id, {
      identity: { generation: null, holderMarker: null },
    });
    expect(await holderIds()).toEqual([first.id, second.id]);

    // A marker that does not decode is dropped only by the run that owns the id.
    await internals.storage.put(KEYS.workflowConcurrencyHolder(first.id), new Uint8Array([0xc0]));
    await releaseWorkflowConcurrencySlotForRun(
      internals,
      first.id,
      await fenceFor(first.id, new Uint8Array([1])),
    );
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(first.id))).not.toBeNull();
    await releaseWorkflowConcurrencySlotForRun(internals, first.id, await fenceFor(first.id));
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(first.id))).toBeNull();
    expect(await holderIds()).toEqual([first.id, second.id]);

    // The owning run frees its own entry and marker, and only those.
    await releaseWorkflowConcurrencySlotForRun(internals, second.id, await fenceFor(second.id));
    expect(await holderIds()).toEqual([first.id]);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(second.id))).toBeNull();
  });

  it('frees the old partition entry of a superseded run after retrying a raced slot write', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({
        name: 'limited-partitioned',
        concurrency: { max: 2, key: (input) => (input as { value: string }).value },
      }).execute(waitForRelease),
    );
    const run = await engine.start('limited-partitioned', { value: 'P1' });
    const internals = getInternals(engine);
    const holderKey = KEYS.workflowConcurrencyHolder(run.id);
    const oldMarker = (await internals.storage.get(holderKey))!;
    const holders = async (partition: string): Promise<string[]> => {
      const bytes = await internals.storage.get(
        KEYS.workflowConcurrency('limited-partitioned', partition),
      );
      if (bytes === null) return [];
      return (decode(bytes) as { holders: { holderId: string }[] }).holders.map((h) => h.holderId);
    };
    expect(await holders('P1')).toEqual([run.id]);

    // A replacement in another partition now owns the id: its marker names P2 and its state differs.
    await internals.storage.put(
      holderKey,
      encode({ version: 1, workflowType: 'limited-partitioned', partitionKey: 'P2' }),
    );
    let calls = 0;
    const racing = new Proxy(internals.storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          // Fail the old partition's guarded write once, as a concurrent slot update would.
          return async (...args: Parameters<NonNullable<typeof target.conditionalBatch>>) =>
            ++calls === 2 ? false : target.conditionalBatch!(...args);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await releaseWorkflowConcurrencySlotForRun({ ...internals, storage: racing }, run.id, {
      identity: { generation: new Uint8Array([1]), holderMarker: oldMarker },
    });

    expect(calls).toBe(4);
    expect(await holders('P1')).toEqual([]);
    expect(await internals.storage.get(holderKey)).not.toBeNull();
  });

  it('releases a live run slot from its current marker, and drops a corrupt marker', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-legacy', concurrency: { max: 2 } }).execute(waitForRelease),
    );
    const first = await engine.start('limited-legacy', { value: 'first' });
    const second = await engine.start('limited-legacy', { value: 'second' });
    const internals = getInternals(engine);
    const slotKey = KEYS.workflowConcurrency('limited-legacy', 'limited-legacy');
    const holderIds = async (): Promise<string[]> => {
      const record = decode((await internals.storage.get(slotKey))!) as {
        holders: { holderId: string }[];
      };
      return record.holders.map((holder) => holder.holderId);
    };

    await releaseWorkflowConcurrencySlot(internals, first.id);
    expect(await holderIds()).toEqual([second.id]);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(first.id))).toBeNull();

    await internals.storage.put(KEYS.workflowConcurrencyHolder(second.id), new Uint8Array([0xc0]));
    await releaseWorkflowConcurrencySlot(internals, second.id);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(second.id))).toBeNull();
    expect(await holderIds()).toEqual([second.id]);

    // No marker at all: nothing to release.
    await releaseWorkflowConcurrencySlot(internals, first.id);
  });

  it('gives up with a conflict error after a bounded number of raced attempts', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-bounded', concurrency: { max: 1 } }).execute(waitForRelease),
    );
    const run = await engine.start('limited-bounded', { value: 'first' });
    const internals = getInternals(engine);
    const marker = (await internals.storage.get(KEYS.workflowConcurrencyHolder(run.id)))!;
    let attempts = 0;
    const alwaysRaced = new Proxy(internals.storage, {
      get(target, property, receiver) {
        // Every guarded write loses to a concurrent slot update; the run's own commit is still current.
        if (property === 'conditionalBatch') return async () => (++attempts, false);
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const failure = await rejectionOf(
      releaseWorkflowConcurrencySlotForRun({ ...internals, storage: alwaysRaced }, run.id, {
        identity: { generation: null, holderMarker: marker },
      }),
    );

    expect(failure).toBeInstanceOf(AtomicStateConflictError);
    expect(attempts).toBe(10);
  });

  it('releases every contender of one partition, even with more than the retry budget', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-crowd', concurrency: { max: 40 } }).execute(waitForRelease),
    );
    // Start them one at a time: concurrent starts would contend on the same slot themselves.
    const runs = [];
    for (let index = 0; index < 24; index += 1) {
      runs.push(await engine.start('limited-crowd', { value: `run-${String(index)}` }));
    }
    const internals = getInternals(engine);
    const fences = await Promise.all(
      runs.map(async (run) => ({
        identity: {
          generation: null,
          holderMarker: await internals.storage.get(KEYS.workflowConcurrencyHolder(run.id)),
        },
      })),
    );

    // Lock-step contenders each lose the slot race to a peer; only jittered backoff spreads them out.
    await Promise.all(
      runs.map((run, index) =>
        releaseWorkflowConcurrencySlotForRun(internals, run.id, fences[index]!),
      ),
    );

    const slot = decode(
      (await internals.storage.get(KEYS.workflowConcurrency('limited-crowd', 'limited-crowd')))!,
    ) as {
      holders: unknown[];
    };
    expect(slot.holders).toEqual([]);
  });

  it('treats a release as done when a concurrent terminalizer of the same run already freed its slot', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-idempotent', concurrency: { max: 1 } }).execute(waitForRelease),
    );
    const run = await engine.start('limited-idempotent', { value: 'first' });
    const internals = getInternals(engine);
    const marker = (await internals.storage.get(KEYS.workflowConcurrencyHolder(run.id)))!;
    const fence = { identity: { generation: null, holderMarker: marker } };

    // The first terminalizer releases the slot and drops the marker in one batch.
    await releaseWorkflowConcurrencySlotForRun(internals, run.id, fence);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(run.id))).toBeNull();

    // The second one captured the same marker before that; it finds nothing left to release.
    await releaseWorkflowConcurrencySlotForRun(internals, run.id, fence);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(run.id))).toBeNull();
  });
});
