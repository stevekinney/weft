/**
 * COR-1472: a workflow parked on `waitForSignal('approval')` reports
 * `waitingForSignals: ['approval']` from a fresh engine over the same storage,
 * before that engine recovers anything, on `MemoryStorage`, SQLite, and IndexedDB.
 * Covered for an inline-parked workflow, a workflow the engine cannot park (it
 * handles updates, so it waits through a live waiter, the same path a Worker
 * run takes), and a durable child workflow. The Worker-mode run itself is in
 * `signal-wait-worker-restart.slow.test.ts`, since it boots a real Worker.
 *
 * After recovery the wait is still listed exactly once, with no second
 * `signal:waiting`, and delivering the signal completes the run and clears it.
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

const parkedApproval = workflow({ name: 'restart-parked-approval' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('approval');
});

const handlerApproval = workflow({ name: 'restart-handler-approval' }).execute(async function* (
  ctx: WorkflowContext,
) {
  ctx.onUpdate('noop', () => 'ok');
  return yield* ctx.waitForSignal<string>('approval');
});

const childApproval = workflow({ name: 'restart-child-approval' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('approval');
});

const parentOfApproval = workflow({ name: 'restart-parent-of-approval' }).execute(async function* (
  ctx: WorkflowContext,
  input: { childId: string },
) {
  return yield* ctx.startChild<string>('restart-child-approval', null, { id: input.childId });
});

function createEngine(storage: Storage): Engine {
  const engine = new Engine({ storage });
  for (const definition of [parkedApproval, handlerApproval, childApproval, parentOfApproval]) {
    engine.register(definition);
  }
  return engine;
}

type Scenario = {
  name: string;
  /** Start the run; returns the id of the workflow that waits and the id whose result proves it. */
  start: (engine: Engine, suffix: string) => Promise<{ waiterId: string; rootId: string }>;
};

const scenarios: Scenario[] = [
  {
    name: 'an inline-parked workflow',
    async start(engine, suffix) {
      const id = `restart-parked-${suffix}`;
      await engine.start('restart-parked-approval', null, { id });
      return { waiterId: id, rootId: id };
    },
  },
  {
    name: 'a workflow waiting through a live waiter',
    async start(engine, suffix) {
      const id = `restart-handler-${suffix}`;
      await engine.start('restart-handler-approval', null, { id });
      return { waiterId: id, rootId: id };
    },
  },
  {
    name: 'a durable child workflow',
    async start(engine, suffix) {
      const rootId = `restart-parent-${suffix}`;
      const childId = `restart-child-${suffix}`;
      await engine.start('restart-parent-of-approval', { childId }, { id: rootId });
      return { waiterId: childId, rootId };
    },
  },
];

describe('waitingForSignals across an engine restart', () => {
  for (const backend of storageBackends) {
    for (const scenario of scenarios) {
      it(`survives for ${scenario.name} on ${backend.name}`, async () => {
        const { storage, cleanup } = backend.factory();
        try {
          const suffix = crypto.randomUUID();
          const first = createEngine(storage);
          const firstEvents = recordSignalWaitingEvents(first);
          const ids = await scenario.start(first, suffix);
          const waiting = await nextSignalWaiting(first, ids.waiterId, 'approval');
          expect(waiting.signalName).toBe('approval');
          first[Symbol.dispose]();

          await using second = createEngine(storage);
          const secondEvents = recordSignalWaitingEvents(second);
          expect(await waitingForSignalsOf(second, ids.waiterId)).toEqual(['approval']);
          if (ids.rootId !== ids.waiterId) {
            expect(await waitingForSignalsOf(second, ids.rootId)).toBeUndefined();
          }

          const recovered = await second.recoverAll();
          await second[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](ids.waiterId);
          expect(await waitingForSignalsOf(second, ids.waiterId)).toEqual(['approval']);

          await second.signal(ids.waiterId, 'approval', 'approved');
          const root = recovered.find((handle) => handle.id === ids.rootId);
          if (root === undefined) throw new Error(`expected ${ids.rootId} to be recovered`);
          expect(await root.result()).toBe('approved');
          expect(await waitingForSignalsOf(second, ids.waiterId)).toBeUndefined();
          expect(firstEvents.map((event) => event.workflowId)).toEqual([ids.waiterId]);
          expect(secondEvents).toEqual([]);
        } finally {
          await cleanup();
        }
      });
    }
  }
});
