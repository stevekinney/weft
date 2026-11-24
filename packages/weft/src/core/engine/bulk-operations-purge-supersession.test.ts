/**
 * COR-1388: a bulk purge works from a scanned terminal snapshot. A same-id
 * `onTerminalConflict: 'start-new'` that commits after the scan must never be
 * deleted, durably or in memory; the purge skips that id without error.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage, type BatchOperation } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { BulkOperationConfirmationError } from './errors.ts';
import { ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING, Engine } from './index.ts';

const echoWorkflow = workflow({ name: 'purge-supersession-echo' }).execute(async function* (
  ctx: WorkflowContext,
  input: string,
) {
  yield* ctx.waitForSignal('go');
  return input;
});

let invocation = 0;

let shouldFail = true;
const flakyWorkflow = workflow({ name: 'purge-supersession-flaky' }).execute(async function* (
  ctx: WorkflowContext,
  _input: string,
) {
  if (shouldFail) throw new Error('first attempt fails');
  yield* ctx.waitForSignal('go');
  return 'ok';
});

function createEngine(storage: MemoryStorage) {
  return Engine.create({
    storage,
    workflows: {
      'purge-supersession-echo': echoWorkflow,
      'purge-supersession-flaky': flakyWorkflow,
    },
    recover: false,
  });
}
type TestEngine = Awaited<ReturnType<typeof createEngine>>;

/** Pause the first storage call matching `matches`, until `release` is called. */
function gateStorage(
  storage: MemoryStorage,
  matches: (method: string, args: unknown[]) => boolean,
) {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let gated = false;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (gated || typeof property !== 'string' || !matches(property, args)) {
          return method.apply(target, args);
        }
        gated = true;
        reached.resolve();
        return released.promise.then(() => method.apply(target, args));
      };
    },
  });
  return { storage: proxy, reached: reached.promise, release: () => released.resolve() };
}

async function completeFirstRun(engine: TestEngine, id: string): Promise<void> {
  const handle = await engine.start('purge-supersession-echo', 'OLD', { id });
  await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
  await engine.signal(id, 'go');
  expect(await handle.result()).toBe('OLD');
}

async function expectReplacementSurvives(
  engine: TestEngine,
  storage: MemoryStorage,
  id: string,
  replacement: { result(): Promise<unknown> },
  deleted: number,
): Promise<void> {
  expect(deleted).toBe(0);
  expect(await storage.get(KEYS.workflow(id))).not.toBeNull();
  expect(await storage.get(KEYS.checkpoint(id))).not.toBeNull();
  const summary = await engine.get(id);
  expect(summary?.status).toBe('running');
  await engine.signal(id, 'go');
  expect(await replacement.result()).toBe('NEW');
}

function isPurgeCommit(id: string) {
  return (method: string, args: unknown[]): boolean => {
    if (method !== 'conditionalBatch' && method !== 'batch') return false;
    const operations = (method === 'batch' ? args[0] : args[1]) as BatchOperation[];
    return (
      operations.some((op) => op.type === 'delete' && op.key === KEYS.workflow(id)) &&
      !operations.some((op) => op.type === 'put' && op.key === KEYS.workflow(id))
    );
  };
}

describe('bulk purge supersession (COR-1388)', () => {
  it('does not count a scanned run removed by another purge', async () => {
    const id = `purge-supersede-removed-${(invocation += 1)}`;
    const base = new MemoryStorage();
    const gate = gateStorage(
      base,
      (method, args) => (method === 'has' || method === 'get') && args[0] === KEYS.teardownOwed(id),
    );
    await using firstEngine = await createEngine(gate.storage);
    await using secondEngine = await createEngine(base);
    await completeFirstRun(firstEngine, id);

    const firstPurge = firstEngine.purge({ status: 'completed' });
    await gate.reached;
    const secondResult = await secondEngine.purge({ status: 'completed' });
    expect(secondResult.deleted).toBe(1);
    gate.release();

    const firstResult = await firstPurge;
    expect(firstResult.deleted).toBe(0);
    expect(await base.get(KEYS.workflow(id))).toBeNull();
  });

  it('skips a same-id start-new replacement that commits between the scan and the purge', async () => {
    const id = `purge-supersede-scan-${(invocation += 1)}`;
    const base = new MemoryStorage();
    const gate = gateStorage(
      base,
      (method, args) => (method === 'has' || method === 'get') && args[0] === KEYS.teardownOwed(id),
    );
    await using engine = await createEngine(gate.storage);
    await completeFirstRun(engine, id);

    const purging = engine.purge({ status: 'completed' });
    await gate.reached;
    const replacement = await engine.start('purge-supersession-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    gate.release();

    const { deleted } = await purging;
    await expectReplacementSurvives(engine, base, id, replacement, deleted);
  });

  it('skips a same-id start-new replacement that commits between the purge read and its commit', async () => {
    const id = `purge-supersede-commit-${(invocation += 1)}`;
    const base = new MemoryStorage();
    const gate = gateStorage(base, isPurgeCommit(id));
    await using engine = await createEngine(gate.storage);
    await completeFirstRun(engine, id);

    const purging = engine.purge({ status: 'completed' });
    await gate.reached;
    const replacement = await engine.start('purge-supersession-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    gate.release();

    const { deleted } = await purging;
    await expectReplacementSurvives(engine, base, id, replacement, deleted);
  });

  it('skips a same-id start-new replacement that commits between the purge read and its generation read', async () => {
    const id = `purge-supersede-generation-${(invocation += 1)}`;
    const base = new MemoryStorage();
    let armed = false;
    const gate = gateStorage(
      base,
      (method, args) => armed && method === 'get' && args[0] === KEYS.workflowGeneration(id),
    );
    await using engine = await createEngine(gate.storage);
    await completeFirstRun(engine, id);

    armed = true;
    const purging = engine.purge({ status: 'completed' });
    await gate.reached;
    const replacement = await engine.start('purge-supersession-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    gate.release();

    const { deleted } = await purging;
    await expectReplacementSurvives(engine, base, id, replacement, deleted);
  });

  it('skips a failed run that retryFailedAll reactivates in place between the scan and the purge', async () => {
    const id = `purge-supersede-retry-${(invocation += 1)}`;
    const base = new MemoryStorage();
    let armed = false;
    const gate = gateStorage(
      base,
      (method, args) =>
        armed && (method === 'has' || method === 'get') && args[0] === KEYS.teardownOwed(id),
    );
    await using engine = await createEngine(gate.storage);
    shouldFail = true;
    const handle = await engine.start('purge-supersession-flaky', 'OLD', { id, tags: ['retry'] });
    await handle.result().catch(() => undefined);
    const failed = await engine.get(id);
    expect(failed?.status).toBe('failed');

    armed = true;
    const purging = engine.purge({ status: 'failed' });
    await gate.reached;
    shouldFail = false;
    await engine.retryFailedAll({ tags: ['retry'] });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    gate.release();

    const { deleted } = await purging;
    expect(deleted).toBe(0);
    expect(await base.get(KEYS.workflow(id))).not.toBeNull();
    const reactivated = await engine.get(id);
    expect(reactivated?.status).toBe('running');
    expect(await base.get(KEYS.checkpoint(id))).not.toBeNull();
  });
});

describe('a confirmed bulk purge names the run it previewed', () => {
  /** Replace the completed run under `id` with one that ends in the same status. */
  async function replaceWithCompletedRun(engine: TestEngine, id: string): Promise<void> {
    const replacement = await engine.start('purge-supersession-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    await engine.signal(id, 'go');
    expect(await replacement.result()).toBe('NEW');
  }

  it('refuses a token whose run was replaced and ended in the same status', async () => {
    const id = `purge-token-run-${(invocation += 1)}`;
    const storage = new MemoryStorage();
    await using engine = await createEngine(storage);
    await completeFirstRun(engine, id);
    const preview = await engine.purge(
      { status: 'completed' },
      { dryRun: true, requestId: 'preview' },
    );
    expect(preview.matched).toBe(1);

    await replaceWithCompletedRun(engine, id);

    const refusal = await rejectionOf(
      engine.purge(
        { status: 'completed' },
        { confirmationToken: preview.confirmationToken, requestId: 'commit' },
      ),
    );
    expect(refusal).toBeInstanceOf(BulkOperationConfirmationError);
    expect(await storage.get(KEYS.workflow(id))).not.toBeNull();
    const kept = await engine.get(id);
    expect(kept?.status).toBe('completed');
  });

  it('skips a replacement that ends in the same status between the commit scan and the delete', async () => {
    const id = `purge-token-fence-${(invocation += 1)}`;
    const base = new MemoryStorage();
    let armed = false;
    const gate = gateStorage(
      base,
      (method, args) =>
        armed && (method === 'has' || method === 'get') && args[0] === KEYS.teardownOwed(id),
    );
    await using engine = await createEngine(gate.storage);
    await completeFirstRun(engine, id);
    const preview = await engine.purge(
      { status: 'completed' },
      { dryRun: true, requestId: 'preview' },
    );

    armed = true;
    const purging = engine.purge(
      { status: 'completed' },
      { confirmationToken: preview.confirmationToken, requestId: 'commit' },
    );
    await gate.reached;
    // The scan above read the previewed run, so the token still matches; the replacement lands
    // after it and has ended by the time the delete reads the run.
    await replaceWithCompletedRun(engine, id);
    gate.release();

    const result = await purging;
    expect('deleted' in result ? result.deleted : -1).toBe(0);
    expect(await base.get(KEYS.workflow(id))).not.toBeNull();
    const kept = await engine.get(id);
    expect(kept?.status).toBe('completed');
  });
});
