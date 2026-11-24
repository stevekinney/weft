import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitUntil } from "../../test-support/embedded/testing/src/wait-until.ts";

import { KEYS } from '../storage/keys.ts';
import { deserializeCheckpoint } from './checkpoint/serialization.ts';
import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from './engine.ts';
import { activity } from './types/activity.ts';
import { workflow } from './types/workflow-function.ts';
import { createWorkflowLogStore } from './workflow-log-store.ts';

/**
 * COR-1924. A forked run in worker mode, driven through the engine host: fork a run that is parked,
 * let the fork take its first turn, and recover it again and again. The fork copies the replay
 * state of its source, including the signature of the step the source was parked on. That is
 * evidence about the source's execution, so the fork's own first lines are stored once, a result
 * the fork was delivered is never lost, and no step the fork completed runs again.
 */

const workerUrl = new URL('../workers/test-fork-log-worker.ts', import.meta.url);

const effectLog: string[] = [];
/** Holds the next dispatch of the effect open for good: the process that ran it crashed. */
let holdNextEffect = false;

const noop = activity({ name: 'noop', execute: async (input: string) => input });
const effect = activity({
  name: 'effect',
  execute: async (id: string) => {
    effectLog.push(id);
    if (holdNextEffect) {
      holdNextEffect = false;
      await new Promise<never>(() => undefined);
    }
    return `effect-of-${id}`;
  },
});

const engines: Engine[] = [];

function createWorkerEngine(storage: MemoryStorage): Engine {
  const logs = createWorkflowLogStore(storage);
  const engine = new Engine({
    storage,
    onLog: logs.sink,
    workflowLogs: logs,
    workflowExecutionMode: 'worker',
    workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
  });
  // The bodies run in the worker; the host only needs the names and activities.
  for (const name of ['three-waits', 'effect-after-wait', 'versioned']) {
    engine.register(
      workflow({ name })
        .activities({ noop, effect })
        .execute(async function* () {
          return undefined;
        }),
    );
  }
  engines.push(engine);
  return engine;
}

/** A process that died: its workers and timers are gone, its storage stays. */
function crash(engine: Engine): void {
  engine[Symbol.dispose]();
}

async function checkpointStep(storage: MemoryStorage, workflowId: string): Promise<number> {
  const bytes = await storage.get(KEYS.checkpoint(workflowId));
  return bytes ? deserializeCheckpoint(bytes).step : -1;
}

async function waitForCheckpointStep(
  storage: MemoryStorage,
  workflowId: string,
  step: number,
): Promise<void> {
  await waitUntil(async () => (await checkpointStep(storage, workflowId)) >= step, {
    message: `${workflowId} checkpoint reaches step ${String(step)}`,
  });
}

async function storedLines(engine: Engine, workflowId: string): Promise<string[]> {
  const result = await engine.getLogs(workflowId);
  return result.lines.map((line) => line.message);
}

async function parkAndFork(
  engine: Engine,
  storage: MemoryStorage,
  type: string,
  options?: { fromStep?: number },
): Promise<string> {
  await engine.start(type, null, { id: 'source' });
  await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('source');
  await waitForCheckpointStep(storage, 'source', 2);
  const fork = await engine.fork('source', options);
  await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](fork.id);
  return fork.id;
}

describe('a forked run in worker mode', () => {
  afterEach(async () => {
    await Promise.all(engines.splice(0).map(async (engine) => engine.shutdown()));
    holdNextEffect = false;
    effectLog.length = 0;
  });

  it('stores the lines its first turn logged once, however often it is recovered', async () => {
    const storage = new MemoryStorage();
    const first = createWorkerEngine(storage);
    const forkId = await parkAndFork(first, storage, 'versioned');
    const afterFirstTurn = await storedLines(first, forkId);
    // V0 sits in front of a completed step, which the fork replays from its result.
    expect(afterFirstTurn).toEqual(['V1-before-getVersion', 'V2-before-wait']);
    crash(first);

    for (let recovery = 0; recovery < 2; recovery++) {
      const recovered = createWorkerEngine(storage);
      await recovered.recoverAll();
      await recovered[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](forkId);
      expect(await storedLines(recovered, forkId)).toEqual(afterFirstTurn);
      crash(recovered);
    }
    expect(await storedLines(first, 'source')).toEqual([
      'V0',
      'V1-before-getVersion',
      'V2-before-wait',
    ]);
  });

  it('delivers a signal to the step the fork parked on, so the run finishes', async () => {
    const storage = new MemoryStorage();
    const first = createWorkerEngine(storage);
    const forkId = await parkAndFork(first, storage, 'three-waits');
    const baseStep = await checkpointStep(storage, forkId);
    crash(first);

    const second = createWorkerEngine(storage);
    await second.recoverAll();
    await second[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](forkId);
    await second.signal(forkId, 'go', 'go-1');
    await waitForCheckpointStep(storage, forkId, baseStep + 1);
    await second[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](forkId);
    crash(second);

    const third = createWorkerEngine(storage);
    await third.recoverAll();
    await third[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](forkId);
    await third.signal(forkId, 'next', 'next-1');
    await third.signal(forkId, 'last', 'last-1');
    await waitUntil(
      async () => {
        const state = await third.get(forkId);
        return state?.status === 'completed';
      },
      { message: 'the fork completes without a second delivery of its first signal' },
    );
    const finished = await third.get(forkId);
    expect(finished?.result).toEqual({
      a: 'a',
      go: 'go-1',
      next: 'next-1',
      last: 'last-1',
    });
  });

  it('does not run an activity again that completed before a later recovery', async () => {
    const storage = new MemoryStorage();
    const first = createWorkerEngine(storage);
    await first.start('effect-after-wait', null, { id: 'source' });
    await first[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('source');
    await first.signal('source', 'go', 'go');
    await first[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('source');
    await waitForCheckpointStep(storage, 'source', 3);
    effectLog.length = 0;

    // Fork from the step where the source was pending on the activity, and hold the activity open.
    holdNextEffect = true;
    const fork = await first.fork('source', { fromStep: 2 });
    await waitUntil(() => effectLog.length > 0, {
      message: 'the fork dispatches the activity',
    });
    crash(first);

    const second = createWorkerEngine(storage);
    await second.recoverAll();
    await second[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](fork.id);
    await second[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('source');
    const runsOnceCompleted = effectLog.length;
    crash(second);

    const third = createWorkerEngine(storage);
    await third.recoverAll();
    await third[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](fork.id);
    await third[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('source');
    expect(effectLog.length).toBe(runsOnceCompleted);
  });
});
