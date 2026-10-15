/**
 * COR-1384: the durable identity a terminal teardown is fenced on is captured on the execution
 * attempt while the run is live, never read after the run ends. A start knows it from the create
 * batch it committed; a run the engine adopts (recovery or resume, a delayed-start fire, a fork)
 * reads it once at adoption; a relaunch of the same generation carries it forward; and a teardown
 * with no identity skips its fenced writes and warns.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { currentExecutionAttempt, type RunIdentity } from './execution-attempts.ts';
import { ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING, Engine } from './index.ts';
import { getInternals } from './internals.ts';

const TYPE = 'identity-capture';
const parked = workflow({ name: TYPE, concurrency: { max: 1 } }).execute(async function* (
  ctx: WorkflowContext,
  input: string,
) {
  yield* ctx.waitForSignal('go');
  return input;
});

let invocation = 0;
const nextId = (label: string): string => `identity-${label}-${String((invocation += 1))}`;

const createEngine = (storage: MemoryStorage) =>
  Engine.create({ storage, workflows: { [TYPE]: parked }, recover: false });

const storedIdentity = async (storage: MemoryStorage, id: string): Promise<RunIdentity> => ({
  generation: await storage.get(KEYS.workflowGeneration(id)),
  holderMarker: await storage.get(KEYS.workflowConcurrencyHolder(id)),
});

const attemptIdentity = (engine: Awaited<ReturnType<typeof createEngine>>, id: string) =>
  currentExecutionAttempt(getInternals(engine), id)?.identity;

const slotHolders = async (storage: MemoryStorage): Promise<string[]> => {
  const bytes = await storage.get(KEYS.workflowConcurrency(TYPE, TYPE));
  if (bytes === null) return [];
  return (decode(bytes) as { holders: { holderId: string }[] }).holders.map((h) => h.holderId);
};

/** Strand a run in storage the way a crashed process does: started, parked, its engine disposed. */
async function strandParkedRun(storage: MemoryStorage, id: string): Promise<void> {
  const first = await createEngine(storage);
  await first.start(TYPE, 'OLD', { id });
  await first[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
  await first[Symbol.asyncDispose]();
}

describe('COR-1384: run identity captured on the execution attempt', () => {
  it('start: the create batch is the identity, with no read', async () => {
    const id = nextId('start');
    const storage = new MemoryStorage();
    await using engine = await createEngine(storage);
    await engine.start(TYPE, 'P', { id });
    const identity = attemptIdentity(engine, id);
    expect(identity).toEqual(await storedIdentity(storage, id));
    expect(identity?.generation).not.toBeNull();
    expect(identity?.holderMarker).not.toBeNull();
  });

  it('recovery: an adopted run reads its identity once at adoption', async () => {
    const id = nextId('recover');
    const storage = new MemoryStorage();
    await strandParkedRun(storage, id);
    await using engine = await createEngine(storage);
    await engine.recoverAll();
    await waitForCondition(async () => attemptIdentity(engine, id) !== undefined, {
      label: 'adoption read settles',
    });
    expect(attemptIdentity(engine, id)).toEqual(await storedIdentity(storage, id));
  });

  it('delayed start: the fire reads the identity of the run it launches', async () => {
    const id = nextId('delayed');
    const storage = new MemoryStorage();
    await using engine = await createEngine(storage);
    await engine.start(TYPE, 'P', { id, startAfter: 30 });
    await getInternals(engine).scheduler.tick(Date.now() + 60_000);
    await waitForCondition(
      async () => {
        const state = await engine.get(id);
        return state?.status === 'running';
      },
      {
        label: 'delayed start fired',
      },
    );
    await waitForCondition(async () => attemptIdentity(engine, id) !== undefined, {
      label: 'identity known',
    });
    expect(attemptIdentity(engine, id)).toEqual(await storedIdentity(storage, id));
  });

  it('fork: a forked run reads its own identity at adoption', async () => {
    const source = nextId('fork-source');
    const storage = new MemoryStorage();
    await using engine = await createEngine(storage);
    const original = await engine.start(TYPE, 'P', { id: source });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](source);
    await engine.signal(source, 'go');
    await original.result();
    const forked = await engine.fork(source);
    await waitForCondition(async () => attemptIdentity(engine, forked.id) !== undefined, {
      label: 'fork identity known',
    });
    expect(attemptIdentity(engine, forked.id)).toEqual(await storedIdentity(storage, forked.id));
  });

  it('suspend then resume: the same generation carries its identity forward without a read', async () => {
    const id = nextId('carry');
    const storage = new MemoryStorage();
    let generationReads = 0;
    const counting = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            if (key === KEYS.workflowGeneration(id)) generationReads += 1;
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await using engine = await createEngine(counting);
    await engine.start(TYPE, 'P', { id });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    const before = attemptIdentity(engine, id);
    const readsBefore = generationReads;
    await engine.suspend(id);
    await engine.resume(id);
    expect(attemptIdentity(engine, id)).toBe(before);
    expect(generationReads).toBe(readsBefore);
  });

  it('a resumed run that finishes before its adoption read settles waits for it, then releases its slot', async () => {
    const id = nextId('pending');
    const storage = new MemoryStorage();
    await strandParkedRun(storage, id);
    expect(await slotHolders(storage)).toEqual([id]);

    const release = Promise.withResolvers<void>();
    let delaying = true;
    const delayed = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            if (delaying && key === KEYS.workflowGeneration(id)) {
              await release.promise;
            }
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await using engine = await createEngine(delayed);
    await engine.recoverAll();
    // The adoption read is still in flight when the run reaches its end.
    await engine.signal(id, 'go');
    await Bun.sleep(50);
    // The terminal commit does not proceed on an unsettled identity, so nothing is written yet.
    const midway = await engine.get(id);
    expect(midway?.status).toBe('running');
    expect(await slotHolders(storage)).toEqual([id]);

    delaying = false;
    release.resolve();
    await waitForCondition(
      async () => {
        const holders = await slotHolders(storage);
        return holders.length === 0;
      },
      {
        label: 'slot released once the pending identity settles',
      },
    );
    expect(await storage.get(KEYS.workflowConcurrencyHolder(id))).toBeNull();
  });

  it('a cancel from an engine that never held the run still releases its slot', async () => {
    const id = nextId('remote');
    const storage = new MemoryStorage();
    await using owner = await createEngine(storage);
    await owner.start(TYPE, 'P', { id });
    await owner[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    await using outsider = await createEngine(storage);
    const warnings: unknown[] = [];
    outsider.addEventListener('cleanup:warning', (event) => {
      warnings.push((event as Event & { source?: string }).source);
    });

    await outsider.cancel(id);

    expect(await slotHolders(storage)).toEqual([]);
    expect(await storage.get(KEYS.workflowConcurrencyHolder(id))).toBeNull();
    expect(warnings).not.toContain('terminal-teardown-fence');
    // The limit is 1, so a new run can start only because the slot really was freed.
    await outsider.start(TYPE, 'next', { id: nextId('after-remote') });
  });

  it('a run whose adoption read failed has no identity, so its fenced teardown is skipped and warned', async () => {
    const id = nextId('unreadable');
    const storage = new MemoryStorage();
    await strandParkedRun(storage, id);
    const failing = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            if (key === KEYS.workflowGeneration(id)) throw new Error('generation unreadable');
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await using engine = await createEngine(failing);
    const warnings: unknown[] = [];
    engine.addEventListener('cleanup:warning', (event) => {
      warnings.push((event as Event & { source?: string }).source);
    });
    await engine.recoverAll();
    await engine.signal(id, 'go');
    await waitForCondition(async () => warnings.includes('terminal-teardown-fence'), {
      label: 'fail-closed warning',
    });
    expect(attemptIdentity(engine, id)).toBeUndefined();
  });
});
