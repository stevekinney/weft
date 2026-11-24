import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { isParkedOn, statusOf } from '../../../testing/run-observation.test-support.ts';
import { workflow, type WorkflowContext } from '../../types.ts';
import { Engine } from '../index.ts';

async function storeContents(storage: MemoryStorage): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for await (const [key, value] of storage.scan('')) {
    entries.push([key, Buffer.from(value).toString('base64')]);
  }
  return entries.toSorted(([left], [right]) => (left < right ? -1 : 1));
}

describe('engine.previewCancel', () => {
  it('reports a running workflow as cancellable and leaves the store as it was', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    let cancelHandlerRuns = 0;
    engine.register(
      workflow({ name: 'parked' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onCancel(() => {
          cancelHandlerRuns += 1;
        });
        return yield* ctx.waitForSignal('go');
      }),
    );
    await engine.start('parked', null, { id: 'wf-preview' });
    await waitForCondition(() => isParkedOn(engine, 'wf-preview', 'go'), {
      label: 'the workflow to park on the go signal',
    });
    const before = await storeContents(storage);

    const preview = await engine.previewCancel('wf-preview');

    expect(preview).toEqual({
      dryRun: true,
      workflowId: 'wf-preview',
      status: 'running',
      cancellable: true,
    });
    expect(await storeContents(storage)).toEqual(before);
    expect(await statusOf(engine, 'wf-preview')).toBe('running');
    expect(cancelHandlerRuns).toBe(0);
    // The workflow still takes its signal, so the preview did not disturb it.
    await engine.signal('wf-preview', 'go', 'done');
    await waitForCondition(async () => (await statusOf(engine, 'wf-preview')) === 'completed', {
      label: 'the previewed workflow to complete normally',
    });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'reports a %s workflow as not cancellable, with its status',
    async (status) => {
      const storage = new MemoryStorage();
      await using engine = new Engine({ storage });
      engine.register(
        workflow({ name: 'ends' }).execute(async function* (ctx: WorkflowContext) {
          if (status === 'failed') throw new Error('boom');
          if (status === 'cancelled') return yield* ctx.waitForSignal('never');
          return 'done';
        }),
      );
      const handle = await engine.start('ends', null, { id: `wf-${status}` });
      if (status === 'cancelled') {
        await waitForCondition(() => isParkedOn(engine, handle.id, 'never'), {
          label: 'the workflow to park',
        });
        const settled = handle.result().catch(() => undefined);
        await engine.cancel(handle.id);
        await settled;
      } else if (status === 'failed') {
        await throwingRejectionOf(handle.result());
      } else {
        await handle.result();
      }
      const before = await storeContents(storage);

      expect(await engine.previewCancel(handle.id)).toEqual({
        dryRun: true,
        workflowId: handle.id,
        status,
        cancellable: false,
      });
      expect(await storeContents(storage)).toEqual(before);
    },
  );

  it('throws the not-found error of a cancel for an unknown id, and writes nothing', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const before = await storeContents(storage);

    expect(await throwingRejectionOf(engine.previewCancel('never-started'))).toThrow('not found');
    expect(await storeContents(storage)).toEqual(before);
  });
});
