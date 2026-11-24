/**
 * Two processes serving one workflow agent over shared storage (COR-1600).
 *
 * Under `ownership: 'workflow-lease'` the engine that started a workflow owns it, and
 * its agent commits the task's events. A stream another process opened on the task
 * learns of those events only from storage, so it re-reads on its live poll interval.
 * Every timer here is manual: the poll fires when the test says so.
 */

import { describe, expect, test } from 'bun:test';

import { type StreamResponse, TaskState } from '@a2a-js/sdk';

import type { Storage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { createA2AHandlerWithScheduler } from './handler.ts';
import {
  createPushFixture,
  manualScheduler,
  NAMESPACE,
  onCleanup,
  type PushFixture,
} from './push-delivery.test-support.ts';
import { callerScope } from './store-support.ts';
import { createTaskEventLog } from './task-event-log.ts';
import {
  createWorkflowAgentExecutorWithScheduler,
  DEFAULT_LIVE_POLL_INTERVAL_MS,
  type WorkflowAgent,
  type WorkflowAgentExecutorOptions,
} from './workflow-agent-executor.ts';
import {
  AGENT_URL,
  approvalWorkflow,
  callContext,
  collect,
  createFixtureEngine,
  sendRequest,
  startTask,
  statusOf,
  userMessage,
  useWorkflowAgentFixtures,
} from './workflow-agent.test-support.ts';

useWorkflowAgentFixtures();

/** The caller the HTTP handler serves without `authenticate`. */
const anonymous = () => callContext();

/** An engine standing for one process of a `workflow-lease` fleet over `storage`. */
async function createLeaseEngine(storage: Storage): Promise<Engine> {
  const engine = await Engine.create({
    storage,
    workflows: { [approvalWorkflow.name]: approvalWorkflow },
    ownership: 'workflow-lease',
    backgroundTasks: 'manual',
    startScheduler: false,
  });
  onCleanup(() => engine[Symbol.asyncDispose]());
  return engine as unknown as Engine;
}

/** The approval agent on `engine`, its live poll driven by `schedule`. */
function serveApproval(
  push: PushFixture,
  engine: Engine,
  schedule: ReturnType<typeof manualScheduler>['schedule'],
  options: Partial<WorkflowAgentExecutorOptions> = {},
): WorkflowAgent {
  const agent = createWorkflowAgentExecutorWithScheduler(
    {
      engine,
      workflowType: approvalWorkflow.name,
      inputMode: 'text',
      card: { name: 'Approval Agent' },
      namespace: NAMESPACE,
      pushNotificationSender: push.sender,
      ...options,
    },
    schedule,
  );
  onCleanup(() => agent[Symbol.dispose]());
  return agent;
}

function subscribeRequest(taskId: string, signal?: AbortSignal): Request {
  return new Request(`${AGENT_URL}/`, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SubscribeToTask',
      params: { id: taskId },
    }),
  });
}

type ServerSentEvent = { readonly id: number; readonly result: Record<string, unknown> };

/** The events of a finished `text/event-stream` body. */
function parseServerSentEvents(body: string): ServerSentEvent[] {
  const events: ServerSentEvent[] = [];
  for (const block of body.split('\n\n')) {
    const lines = block.split('\n');
    const data = lines.find((line) => line.startsWith('data:'));
    const id = lines.find((line) => line.startsWith('id:'));
    if (data === undefined || id === undefined) continue;
    const envelope = JSON.parse(data.slice(5)) as { result: Record<string, unknown> };
    events.push({ id: Number(id.slice(3)), result: envelope.result });
  }
  return events;
}

function stateOf(event: ServerSentEvent | undefined): string | undefined {
  const task = event?.result['task'] as { status: { state: string } } | undefined;
  const update = event?.result['statusUpdate'] as { status: { state: string } } | undefined;
  return (task ?? update)?.status.state;
}

describe('a workflow agent served by two processes over one store', () => {
  test('a stream opened on one process receives the events another process commits, and closes', async () => {
    const push = await createPushFixture();
    const errors: unknown[] = [];
    const owner = await createLeaseEngine(push.storage);
    const follower = await createLeaseEngine(push.storage);
    const ownerPoll = manualScheduler();
    const followerPoll = manualScheduler();
    const onError = (error: unknown) => errors.push(error);
    const ownerAgent = serveApproval(push, owner, ownerPoll.schedule, { onError });
    const followerAgent = serveApproval(push, follower, followerPoll.schedule, { onError });
    const streamClock = manualScheduler();
    const followerHandler = createA2AHandlerWithScheduler(
      {
        requestHandler: followerAgent.requestHandler,
        agentCard: followerAgent.agentCard,
        publicUrl: AGENT_URL,
      },
      streamClock.schedule,
    );

    // The owning process starts the workflow, which waits for input.
    const task = await startTask(ownerAgent, anonymous());
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

    // The other process opens a stream and goes idle, its live poll armed.
    const armed = followerPoll.nextTimer();
    const response = await followerHandler(subscribeRequest(task.id));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const pollTimer = await armed;
    expect(pollTimer.delayMs).toBe(DEFAULT_LIVE_POLL_INTERVAL_MS);

    // The owning process advances the workflow to completion and commits its events.
    const completed = await startTask(
      ownerAgent,
      anonymous(),
      userMessage({ taskId: task.id, text: 'approved' }),
    );
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    followerPoll.fire();
    const [snapshot, ...later] = parseServerSentEvents(await response.text());

    expect(stateOf(snapshot)).toBe('TASK_STATE_INPUT_REQUIRED');
    const snapshotCursor = snapshot?.id ?? Number.NaN;
    const log = createTaskEventLog({ storage: push.storage, namespace: NAMESPACE, now: Date.now });
    const durable: number[] = [];
    for await (const entry of log.follow(
      callerScope(NAMESPACE, anonymous()),
      task.id,
      snapshotCursor,
    )) {
      durable.push(entry.sequence);
      if (statusOf(entry.event) === TaskState.TASK_STATE_COMPLETED) break;
    }
    // Every event after the snapshot, in cursor order, once each; the last ends the stream.
    expect(durable.length).toBeGreaterThan(0);
    expect(later.map((event) => event.id)).toEqual(durable);
    expect(stateOf(later.at(-1))).toBe('TASK_STATE_COMPLETED');
    expect(streamClock.timers.map((timer) => timer.cancelled)).toEqual([true]);
    expect(followerPoll.timers.every((timer) => timer.cancelled)).toBe(true);
    expect(errors).toEqual([]);
  });

  // How a stream can end while the task it follows still waits on another process.
  const closings = {
    'its client cancels the body': async (response: Response) => {
      await response.body?.cancel();
    },
    'its client aborts the request': (_response: Response, client: AbortController) => {
      client.abort();
    },
    'it reaches its maximum duration': async (
      response: Response,
      _client: AbortController,
      streamClock: ReturnType<typeof manualScheduler>,
    ) => {
      streamClock.fire();
      expect(await response.text()).toContain('reconnect to continue');
    },
  } as const;

  for (const [closing, close] of Object.entries(closings)) {
    test(`stops the live poll of a stream once ${closing}`, async () => {
      const push = await createPushFixture();
      const owner = await createLeaseEngine(push.storage);
      const follower = await createLeaseEngine(push.storage);
      const ownerAgent = serveApproval(push, owner, manualScheduler().schedule);
      const followerPoll = manualScheduler();
      const followerAgent = serveApproval(push, follower, followerPoll.schedule);
      // Resolves once the follower's SubscribeToTask generator has finished.
      let ended: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        ended = resolve;
      });
      const handler = followerAgent.requestHandler;
      const tracked = new Proxy(handler, {
        get(target, property) {
          if (property === 'resubscribe') {
            return async function* (...args: Parameters<typeof target.resubscribe>) {
              try {
                yield* target.resubscribe(...args);
              } finally {
                ended();
              }
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const streamClock = manualScheduler();
      const followerHandler = createA2AHandlerWithScheduler(
        { requestHandler: tracked, agentCard: followerAgent.agentCard, publicUrl: AGENT_URL },
        streamClock.schedule,
      );
      const task = await startTask(ownerAgent, anonymous());
      const client = new AbortController();
      const armed = followerPoll.nextTimer();
      const response = await followerHandler(subscribeRequest(task.id, client.signal));
      const pollTimer = await armed;

      await close(response, client, streamClock);

      // The poll is cancelled when the stream closes, not at the task's next event.
      expect(pollTimer.cancelled).toBe(true);
      await finished;
      expect(followerPoll.timers).toEqual([pollTimer]);
    });
  }

  test('arms no live poll for an engine without an ownership lease', async () => {
    const push = await createPushFixture();
    const engine = createFixtureEngine(push.storage);
    onCleanup(() => engine[Symbol.asyncDispose]());
    const poll = manualScheduler();
    const agent = serveApproval(push, engine, poll.schedule);

    const task = await startTask(agent, anonymous());
    const subscription = agent.requestHandler.resubscribe({ tenant: '', id: task.id }, anonymous());
    await subscription.next();
    const answered = startTask(agent, anonymous(), userMessage({ taskId: task.id, text: 'ok' }));
    const streamed = await collect({ [Symbol.asyncIterator]: () => subscription });
    await answered;

    expect(statusOf(streamed.at(-1) as StreamResponse)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(poll.timers).toEqual([]);
  });

  test('re-reads storage on the interval it is given, under any ownership', async () => {
    const push = await createPushFixture();
    const engine = createFixtureEngine(push.storage);
    onCleanup(() => engine[Symbol.asyncDispose]());
    const explicit = manualScheduler();
    const polled = serveApproval(push, engine, explicit.schedule, { livePollIntervalMs: 25 });
    const armed = explicit.nextTimer();
    const pending = polled.requestHandler.sendMessage(sendRequest(userMessage()), anonymous());
    const pollTimer = await armed;
    expect(pollTimer.delayMs).toBe(25);
    expect(await pending).toMatchObject({ status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } });
  });

  test('refuses a live poll interval that is not an integer a timer honours', async () => {
    const push = await createPushFixture();
    const engine = createFixtureEngine(push.storage);
    onCleanup(() => engine[Symbol.asyncDispose]());

    // Above the timer maximum, setTimeout fires after about 1 ms: a busy poll.
    for (const livePollIntervalMs of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(() =>
        serveApproval(push, engine, manualScheduler().schedule, { livePollIntervalMs }),
      ).toThrow(RangeError);
    }
  });
});
