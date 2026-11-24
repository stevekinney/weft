/**
 * COR-1472: the RemoteWorker leg of the `waitingForSignals` restart matrix (the
 * inline and durable-child legs are in `signal-wait-restart.test.ts`, the Bun
 * Worker leg in `signal-wait-worker-restart.slow.test.ts`). The engine runs its
 * activities remotely (`activityExecution: { mode: 'remote' }`): a real
 * `RemoteWorker`, connected through `serve()`, executes the run's one activity,
 * and the run then parks on `waitForSignal('approval')`. A fresh engine over the
 * same storage reports `['approval']` before it recovers anything, and after
 * recovery a delivered signal completes the run from its checkpoint without
 * running the activity again. It opens a real server socket per backend, so it
 * runs in the serial slow lane.
 */
import { describe, expect, it } from 'bun:test';

import type { Storage } from "../../embedded/storage/src/index.ts";
import { serve } from '../../server/index.ts';
import { storageBackends } from '../../testing/storage-backends.test-support.ts';
import { RemoteWorker } from '../../worker/index.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';
import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from './index.ts';
import {
  nextSignalWaiting,
  recordSignalWaitingEvents,
  waitingForSignalsOf,
} from './signal-wait-tracking.test-support.ts';

const WORKFLOW_NAME = 'remote-activity-then-approval';

/** The engine-side declaration. Remote mode never runs it locally. */
const prepareRequest = activity({
  name: 'prepareRequest',
  execute: async (_input: { requester: string }): Promise<string> => {
    throw new Error('local execution must never run in remote mode');
  },
});

const remoteActivityThenApproval = workflow({ name: WORKFLOW_NAME })
  .activities({ prepareRequest })
  .execute(async function* (context: WorkflowContext, input: { requester: string }) {
    const request = yield* context.run(prepareRequest, input);
    const decision = yield* context.waitForSignal<string>('approval');
    return `${request}: ${decision}`;
  });

function createRemoteEngine(storage: Storage): Engine {
  const engine = new Engine({ storage, activityExecution: { mode: 'remote' } });
  engine.register(remoteActivityThenApproval);
  return engine;
}

describe('waitingForSignals across a restart of an engine whose activities run on a RemoteWorker', () => {
  for (const backend of storageBackends) {
    it(`survives on ${backend.name}`, async () => {
      const { storage, cleanup } = backend.factory();
      const workflowId = `remote-worker-restart-${crypto.randomUUID()}`;
      const executedInputs: unknown[] = [];
      try {
        const first = createRemoteEngine(storage);
        const firstEvents = recordSignalWaitingEvents(first);
        // `trustedHosts` only keeps the MCP origin-posture warning out of the output.
        const server = serve({
          engine: first,
          port: 0,
          unauthenticatedAccess: 'allow',
          trustedHosts: ['localhost'],
        });
        const remoteWorker = new RemoteWorker({
          serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
          workerId: `approval-worker-${backend.name}`,
          deploymentName: 'test-deployment',
          buildId: 'test-build',
          workflows: {
            [WORKFLOW_NAME]: {
              name: WORKFLOW_NAME,
              activities: {
                prepareRequest: async (input: unknown) => {
                  executedInputs.push(input);
                  return `request from ${(input as { requester: string }).requester}`;
                },
              },
            },
          },
          concurrency: 1,
        });
        try {
          // A task enqueued before the worker registers stays durably queued
          // and is drained to it on registration, so no registration wait.
          await remoteWorker.connect();
          const waiting = nextSignalWaiting(first, workflowId, 'approval');
          await first.start(WORKFLOW_NAME, { requester: 'Ada' }, { id: workflowId });
          await waiting;
          expect(executedInputs).toEqual([{ requester: 'Ada' }]);
          expect(await waitingForSignalsOf(first, workflowId)).toEqual(['approval']);
        } finally {
          await remoteWorker.disconnect();
          await server.stop();
          first[Symbol.dispose]();
        }

        await using second = createRemoteEngine(storage);
        const secondEvents = recordSignalWaitingEvents(second);
        expect(await waitingForSignalsOf(second, workflowId)).toEqual(['approval']);

        const recovered = await second.recoverAll();
        const handle = recovered.find((candidate) => candidate.id === workflowId);
        if (handle === undefined) throw new Error(`expected ${workflowId} to be recovered`);
        await second[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](workflowId);
        expect(await waitingForSignalsOf(second, workflowId)).toEqual(['approval']);

        await second.signal(workflowId, 'approval', 'approved');
        expect(await handle.result()).toBe('request from Ada: approved');
        expect(await waitingForSignalsOf(second, workflowId)).toBeUndefined();
        expect(executedInputs).toEqual([{ requester: 'Ada' }]);
        expect(firstEvents.map((event) => event.workflowId)).toEqual([workflowId]);
        expect(secondEvents).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  }
});
