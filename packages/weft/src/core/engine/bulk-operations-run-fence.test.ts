/**
 * A confirmed bulk operation acts only on the run it scanned. A same-id `onTerminalConflict:
 * 'start-new'` replacement that lands between the commit's scan and the per-id action was never
 * previewed, so the action skips it, whatever status it has reached.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { mutateWorkflowTags } from './attributes-tags.ts';
import { ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING, Engine } from './index.ts';
import { getInternals } from './internals.ts';

const TAGS = ['run-fence'];

const parkingWorkflow = workflow({ name: 'run-fence-parking' }).execute(async function* (
  ctx: WorkflowContext,
  input: string,
) {
  yield* ctx.waitForSignal('go');
  return input;
});

const failingWorkflow = workflow({ name: 'run-fence-failing' }).execute(async function* (
  _ctx: WorkflowContext,
  _input: string,
) {
  yield* [];
  throw new Error('always fails');
});

let invocation = 0;

function createEngine(storage: MemoryStorage) {
  return Engine.create({
    storage,
    workflows: { 'run-fence-parking': parkingWorkflow, 'run-fence-failing': failingWorkflow },
    recover: false,
  });
}
type TestEngine = Awaited<ReturnType<typeof createEngine>>;

/**
 * The reads of a run's record a commit makes before it reaches the run's own action: the scan the
 * confirmation token is checked against reads it once. The next read is the action's (the fence's
 * own read, for delete, retry-failed, cancel and signal; the write's, for tags), so pausing it
 * holds the commit between the scan and the action.
 */
const READS_BEFORE_THE_ACTION = 1;

/** Pause the read of `key` that follows the commit's scan, until `release()`. */
function gateActionRead(storage: MemoryStorage, key: string) {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let seen = 0;
  let armed = false;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (!armed || property !== 'get' || args[0] !== key) return method.apply(target, args);
        seen += 1;
        if (seen !== READS_BEFORE_THE_ACTION + 1) return method.apply(target, args);
        reached.resolve();
        return released.promise.then(() => method.apply(target, args));
      };
    },
  });
  return {
    storage: proxy,
    arm: () => {
      armed = true;
    },
    reached: reached.promise,
    release: () => released.resolve(),
  };
}

async function finishParkedRun(engine: TestEngine, id: string): Promise<void> {
  await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
  await engine.signal(id, 'go');
}

async function completedRun(engine: TestEngine, id: string): Promise<void> {
  const handle = await engine.start('run-fence-parking', 'OLD', { id, tags: TAGS });
  await finishParkedRun(engine, id);
  expect(await handle.result()).toBe('OLD');
}

/** Replace the terminal run under `id` with a parking run, which ends `completed` when finished. */
function replaceWithParkingRun(engine: TestEngine, id: string) {
  return engine.start('run-fence-parking', 'NEW', {
    id,
    tags: TAGS,
    onTerminalConflict: 'start-new',
  });
}

async function statusOf(engine: TestEngine, id: string) {
  const state = await engine.get(id);
  return state?.status;
}

async function tagsOf(engine: TestEngine, id: string) {
  const state = await engine.get(id);
  return state?.tags;
}

async function tokenOf(engine: TestEngine, id: string) {
  const state = await engine.get(id);
  return state?.workflowExecutionToken;
}

describe('a confirmed bulk operation acts only on the run it scanned', () => {
  it('delete skips a replacement that ended in the same status after the scan', async () => {
    const id = `fence-delete-${(invocation += 1)}`;
    const base = new MemoryStorage();
    const gate = gateActionRead(base, KEYS.workflow(id));
    await using engine = await createEngine(gate.storage);
    await completedRun(engine, id);
    const preview = await engine.deleteAll({ tags: TAGS }, { dryRun: true });

    gate.arm();
    const deleting = engine.deleteAll(
      { tags: TAGS },
      { confirmationToken: preview.confirmationToken },
    );
    await gate.reached;
    const replacement = await replaceWithParkingRun(engine, id);
    await finishParkedRun(engine, id);
    expect(await replacement.result()).toBe('NEW');
    gate.release();

    const deletion = await deleting;
    expect(deletion.deleted).toBe(0);
    expect(await base.get(KEYS.workflow(id))).not.toBeNull();
    expect(await statusOf(engine, id)).toBe('completed');
  });

  // The tag write reads the run inside the serialized state-write lock, which a replacement needs
  // too, so no replacement can land between that read and the write; the window is before the
  // lock is taken, which no storage read marks. This calls the write with the run the scan saw.
  it('a tag write leaves a replacement that ended in the same status after the scan untagged', async () => {
    const id = `fence-tags-${(invocation += 1)}`;
    await using engine = await createEngine(new MemoryStorage());
    await completedRun(engine, id);
    const scannedToken = await tokenOf(engine, id);
    expect(scannedToken).toBeString();
    const replacement = await replaceWithParkingRun(engine, id);
    await finishParkedRun(engine, id);
    expect(await replacement.result()).toBe('NEW');
    const internals = getInternals(engine);

    expect(
      await mutateWorkflowTags(internals, id, ['added'], 'add', {
        workflowExecutionToken: scannedToken,
      }),
    ).toBe(false);
    expect(await tagsOf(engine, id)).toEqual(TAGS);

    const replacementToken = await tokenOf(engine, id);
    expect(replacementToken).not.toBe(scannedToken);
    expect(
      await mutateWorkflowTags(internals, id, ['added'], 'add', {
        workflowExecutionToken: replacementToken,
      }),
    ).toBe(true);
    expect(await tagsOf(engine, id)).toEqual([...TAGS, 'added'].toSorted());
  });

  it('retry-failed reports a replacement that failed again after the scan, and does not retry it', async () => {
    const id = `fence-retry-${(invocation += 1)}`;
    const base = new MemoryStorage();
    const gate = gateActionRead(base, KEYS.workflow(id));
    await using engine = await createEngine(gate.storage);
    const first = await engine.start('run-fence-failing', 'OLD', { id, tags: TAGS });
    await first.result().catch(() => undefined);
    expect(await statusOf(engine, id)).toBe('failed');
    const preview = await engine.retryFailedAll({ tags: TAGS }, { dryRun: true });

    gate.arm();
    const retrying = engine.retryFailedAll(
      { tags: TAGS },
      { confirmationToken: preview.confirmationToken },
    );
    await gate.reached;
    const replacement = await engine.start('run-fence-failing', 'NEW', {
      id,
      tags: TAGS,
      onTerminalConflict: 'start-new',
    });
    await replacement.result().catch(() => undefined);
    gate.release();

    const result = await retrying;
    expect(result.retried).toBe(0);
    expect(result.errors).toEqual([{ id, error: 'Workflow was replaced after the preview' }]);
    expect(await statusOf(engine, id)).toBe('failed');
  });

  it('cancel reports a replacement that started after the scan, and leaves it running', async () => {
    const id = `fence-cancel-${(invocation += 1)}`;
    const base = new MemoryStorage();
    const gate = gateActionRead(base, KEYS.workflow(id));
    await using engine = await createEngine(gate.storage);
    const first = await engine.start('run-fence-parking', 'OLD', { id, tags: TAGS });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    const preview = await engine.cancelAll({ tags: TAGS }, { dryRun: true });

    gate.arm();
    const cancelling = engine.cancelAll(
      { tags: TAGS },
      { confirmationToken: preview.confirmationToken },
    );
    await gate.reached;
    await engine.signal(id, 'go');
    expect(await first.result()).toBe('OLD');
    const replacement = await replaceWithParkingRun(engine, id);
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    gate.release();

    const result = await cancelling;
    expect(result.cancelled).toBe(0);
    expect(result.errors).toEqual([{ id, error: 'Workflow was replaced after the preview' }]);
    expect(await statusOf(engine, id)).toBe('running');
    await engine.signal(id, 'go');
    expect(await replacement.result()).toBe('NEW');
  });

  it('signal reports a replacement that started after the scan, and does not signal it', async () => {
    const id = `fence-signal-${(invocation += 1)}`;
    const base = new MemoryStorage();
    const gate = gateActionRead(base, KEYS.workflow(id));
    await using engine = await createEngine(gate.storage);
    const first = await engine.start('run-fence-parking', 'OLD', { id, tags: TAGS });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    const preview = await engine.signalAll({ tags: TAGS }, 'go', undefined, { dryRun: true });

    gate.arm();
    const signalling = engine.signalAll({ tags: TAGS }, 'go', undefined, {
      confirmationToken: preview.confirmationToken,
    });
    await gate.reached;
    await engine.signal(id, 'go');
    expect(await first.result()).toBe('OLD');
    const replacement = await replaceWithParkingRun(engine, id);
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    gate.release();

    expect(await signalling).toMatchObject({ signalled: 0, failed: 1 });
    expect(await statusOf(engine, id)).toBe('running');
    await engine.signal(id, 'go');
    expect(await replacement.result()).toBe('NEW');
  });
});
