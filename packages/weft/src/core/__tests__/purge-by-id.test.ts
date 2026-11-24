/**
 * `engine.purgeById` (COR-1934): the delete set of a purge, for one workflow named by its exact
 * id. `purge({ idPrefix })` reaches every workflow whose id begins with the prefix and refuses an
 * id outside its alphabet; a host that purges one run of its own must reach that run and no other.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { collectKeys } from '../../testing/storage-backends.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext } from '../types.ts';

/** Starts a workflow under `id` and waits for it to complete. */
async function complete(engine: Engine, id: string): Promise<void> {
  const handle = await engine.start('completed', null, { id });
  await handle.result();
}

function createEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage });
  engine.register(
    workflow({ name: 'completed' }).execute(async function* () {
      return 'done';
    }),
  );
  engine.register(
    workflow({ name: 'waiting' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('continue');
      return 'done';
    }),
  );
  return engine;
}

describe('engine.purgeById', () => {
  it('deletes the named terminal workflow and nothing whose id begins with it', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await complete(engine, 'run-1');
    await complete(engine, 'run-10');

    expect(await engine.purgeById('run-1')).toBe(true);

    expect(await engine.get('run-1')).toBeNull();
    expect(await collectKeys(storage, 'wf:run-1:')).toEqual([]);
    expect(await engine.get('run-10')).not.toBeNull();
    // Repeating finds nothing: a second call answers false and changes nothing.
    expect(await engine.purgeById('run-1')).toBe(false);
    expect(await engine.get('run-10')).not.toBeNull();
    engine[Symbol.dispose]();
  });

  it('reads an id outside the idPrefix alphabet as given', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await complete(engine, 'order:42');
    await complete(engine, 'job.1');

    expect(await engine.purgeById('order:42')).toBe(true);

    expect(await engine.get('order:42')).toBeNull();
    expect(await engine.get('job.1')).not.toBeNull();
    expect(await storage.get(KEYS.workflow('job.1'))).not.toBeNull();
    engine[Symbol.dispose]();
  });

  it('answers false for a workflow that is not terminal, and for one that does not exist', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const running = await engine.start('waiting', null, { id: 'still-running' });

    expect(await engine.purgeById('still-running')).toBe(false);
    expect(await engine.purgeById('never-started')).toBe(false);

    expect(await engine.get('still-running')).not.toBeNull();
    await engine.cancel(running.id);
    await running.result().catch(() => {});
    engine[Symbol.dispose]();
  });
});
