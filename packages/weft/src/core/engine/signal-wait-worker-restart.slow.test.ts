/**
 * COR-1472: the Worker-mode leg of the `waitingForSignals` restart matrix (the
 * inline and durable-child legs are in `signal-wait-restart.test.ts`). A run
 * that a real Bun Worker drives parks on `waitForSignal('approval')`; a fresh
 * engine over the same storage reports `['approval']` before it recovers
 * anything, and after recovery a delivered signal completes the run and clears
 * the list. It boots a Worker per engine, which is seconds of real work under
 * load, so it runs in the serial slow lane.
 */
import { describe, expect, it } from 'bun:test';

import type { Storage } from "../../embedded/storage/src/index.ts";
import { storageBackends } from '../../testing/storage-backends.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from './index.ts';
import {
  nextSignalWaiting,
  recordSignalWaitingEvents,
  waitingForSignalsOf,
} from './signal-wait-tracking.test-support.ts';

const workerUrl = new URL('../../workers/test-browser-worker.ts', import.meta.url);

/** The host-side registration; the Worker runs its own `wait-signal-then-complete`. */
const waitSignalThenComplete = workflow({ name: 'wait-signal-then-complete' }).execute(
  async function* (_ctx: WorkflowContext) {
    return undefined;
  },
);

function createWorkerEngine(storage: Storage): Engine {
  const engine = new Engine({
    storage,
    workflowExecutionMode: 'worker',
    workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
  });
  engine.register(waitSignalThenComplete);
  return engine;
}

describe('waitingForSignals across a restart of a Worker-mode engine', () => {
  for (const backend of storageBackends) {
    it(`survives on ${backend.name}`, async () => {
      const { storage, cleanup } = backend.factory();
      const workflowId = `worker-restart-${crypto.randomUUID()}`;
      try {
        const first = createWorkerEngine(storage);
        const waiting = nextSignalWaiting(first, workflowId, 'approval');
        await first.start(
          'wait-signal-then-complete',
          { signalName: 'approval' },
          { id: workflowId },
        );
        await waiting;
        expect(await waitingForSignalsOf(first, workflowId)).toEqual(['approval']);
        first[Symbol.dispose]();

        await using second = createWorkerEngine(storage);
        const secondEvents = recordSignalWaitingEvents(second);
        expect(await waitingForSignalsOf(second, workflowId)).toEqual(['approval']);

        const [recovered] = await second.recoverAll();
        if (recovered === undefined) throw new Error('expected the parked run to be recovered');
        await second[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](workflowId);
        await second.signal(workflowId, 'approval', { status: 'approved' });

        expect(await recovered.result()).toEqual({
          input: { signalName: 'approval' },
          payload: { status: 'approved' },
          workflowId,
        });
        expect(await waitingForSignalsOf(second, workflowId)).toBeUndefined();
        expect(secondEvents).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  }
});
