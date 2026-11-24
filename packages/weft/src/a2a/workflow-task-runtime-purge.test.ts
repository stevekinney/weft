import { describe, expect, test } from 'bun:test';

import { type Message, type StreamResponse, type Task, TaskState } from '@a2a-js/sdk';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { NAMESPACE, onCleanup } from './push-delivery.test-support.ts';
import { callerScope } from './store-support.ts';
import { createTaskEventLog } from './task-event-log.ts';
import {
  approvalWorkflow,
  callContext,
  createFixtureEngine,
  createWorkflowAgentFixture,
  sendRequest,
  serveWorkflow,
  startTask,
  statusOf,
  userMessage,
  useWorkflowAgentFixtures,
  type WorkflowAgentFixture,
} from './workflow-agent.test-support.ts';
import { PURGED_WORKFLOW_MESSAGE } from './workflow-task-runtime.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });

/** The text of a message's first part. */
function textOf(message: Message | undefined): string | undefined {
  const content = message?.parts[0]?.content;
  return content?.$case === 'text' ? content.value : undefined;
}

/** Deliver every queued push notification and return the states they carried. */
async function deliveredStates(fixture: WorkflowAgentFixture): Promise<unknown[]> {
  for (;;) {
    const delivered = await fixture.push.outbox.deliverNext();
    if (delivered.status === 'empty') break;
  }
  return fixture.push.receiver.requests.map((request) => {
    const body = JSON.parse(request.body) as { statusUpdate?: { status?: { state?: string } } };
    return body.statusUpdate?.status?.state;
  });
}

/**
 * Bring a fresh engine up over `fixture`'s storage, answer the task's one wait, let the
 * workflow complete, and purge it, as a short retention does. No handler follows this
 * engine, so no task hears of the completion.
 */
async function completeAndPurgeUnobserved(fixture: WorkflowAgentFixture, taskId: string) {
  const engine = createFixtureEngine(fixture.storage);
  onCleanup(() => engine[Symbol.asyncDispose]());
  const recovered = await engine.recoverAll();
  await engine.signal(taskId, 'input', 'approved');
  await recovered.find((handle) => handle.id === taskId)?.result();
  expect(await engine.purge({ type: approvalWorkflow.name })).toEqual({ deleted: 1 });
  expect(await engine.get(taskId)).toBeNull();
  return engine;
}

describe('a task whose workflow was purged before it was reconciled', () => {
  test('settles as FAILED after a restart, refuses subscriptions and continuations, and is pruned', async () => {
    const first = await createWorkflowAgentFixture();
    const waiting = (await first.agent.requestHandler.sendMessage(
      sendRequest(userMessage(), {
        taskPushNotificationConfig: {
          id: 'config-1',
          taskId: '',
          url: first.push.receiver.url(),
          token: '',
          authentication: { scheme: 'Bearer', credentials: 'secret' },
          tenant: '',
        },
      }),
      alice(),
    )) as Task;
    expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    first.agent[Symbol.dispose]();
    first.engine[Symbol.dispose]();

    // The handler is down while the workflow completes and is purged.
    const engine = await completeAndPurgeUnobserved(first, waiting.id);

    let now = 1_000;
    const { agent } = serveWorkflow(first.push, engine, {
      terminalRetentionMs: 10,
      now: () => now,
    });
    const request = { tenant: '', id: waiting.id };

    const settled = await agent.requestHandler.getTask(request, alice());
    expect(settled.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(textOf(settled.status?.message)).toBe(PURGED_WORKFLOW_MESSAGE);
    expect(settled.history.at(-1)).toEqual(settled.status?.message);

    const subscription = agent.requestHandler.resubscribe(request, alice());
    expect(await rejectionOf(subscription.next())).toBeInstanceOf(UnsupportedOperationError);
    const continuation = startTask(
      agent,
      alice(),
      userMessage({ taskId: waiting.id, text: 'too late' }),
    );
    expect(await rejectionOf(continuation)).toBeInstanceOf(UnsupportedOperationError);

    // The settlement is a durable status event, and its push notification is sent.
    const log = createTaskEventLog({ storage: first.storage, namespace: NAMESPACE, now: () => 0 });
    const events: StreamResponse[] = [];
    for await (const entry of log.follow(callerScope(NAMESPACE, alice()), waiting.id, -1)) {
      events.push(entry.event);
      if (statusOf(entry.event) === TaskState.TASK_STATE_FAILED) break;
    }
    expect(events.map(statusOf).slice(-2)).toEqual([
      TaskState.TASK_STATE_INPUT_REQUIRED,
      TaskState.TASK_STATE_FAILED,
    ]);
    expect(await deliveredStates(first)).toContain('TASK_STATE_FAILED');

    // Reading it again changes nothing.
    expect(await agent.requestHandler.getTask(request, alice())).toEqual(settled);

    now += 100;
    expect(await agent.taskStore.prune()).toBe(1);
    expect(await rejectionOf(agent.requestHandler.getTask(request, alice()))).toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  test('ends a subscription that was open when another process completed and purged the workflow', async () => {
    const first = await createWorkflowAgentFixture();
    const waiting = await startTask(first.agent, alice());
    first.agent[Symbol.dispose]();
    first.engine[Symbol.dispose]();

    // This process serves the agent and only reads workflows; another runs them.
    const reader = createFixtureEngine(first.storage);
    onCleanup(() => reader[Symbol.asyncDispose]());
    const { agent } = serveWorkflow(first.push, reader);
    const request = { tenant: '', id: waiting.id };
    const subscription = agent.requestHandler.resubscribe(request, alice());
    const snapshot = await subscription.next();
    expect(snapshot.value).toMatchObject({ payload: { $case: 'task', value: waiting } });

    await completeAndPurgeUnobserved(first, waiting.id);
    const settled = await agent.requestHandler.getTask(request, alice());

    expect(settled.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const update = await subscription.next();
    expect(statusOf(update.value as StreamResponse)).toBe(TaskState.TASK_STATE_FAILED);
    expect(await subscription.next()).toEqual({ done: true, value: undefined });
  });

  test('settles with the outcome its terminal event reported when a sweep purges the workflow mid-reconciliation', async () => {
    const { engine, agent } = await createWorkflowAgentFixture();
    const waiting = await startTask(agent, alice());

    // The runtime's listener has already heard the completion when this one runs, so
    // the purge lands after the event and before the runtime reads the workflow.
    let purgeBeforeNextRead = false;
    const completed = new Promise<void>((resolve) => {
      engine.addEventListener(
        'workflow:completed',
        () => {
          purgeBeforeNextRead = true;
          resolve();
        },
        { once: true },
      );
    });
    const get = engine.get.bind(engine);
    const purges: unknown[] = [];
    engine.get = async (...args: Parameters<typeof get>) => {
      if (purgeBeforeNextRead) {
        purgeBeforeNextRead = false;
        purges.push(await engine.purge({ type: approvalWorkflow.name }));
      }
      return get(...args);
    };

    await engine.signal(waiting.id, 'input', 'approved');
    await completed;
    await agent.idle();
    engine.get = get;

    expect(purges).toEqual([{ deleted: 1 }]);
    expect(await engine.get(waiting.id)).toBeNull();
    const settled = await agent.requestHandler.getTask({ tenant: '', id: waiting.id }, alice());
    expect(settled.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(settled.artifacts[0]?.parts[0]?.content).toEqual({
      $case: 'data',
      value: { request: expect.anything(), input: 'approved' },
    });
    expect(settled.history.map(textOf)).not.toContain(PURGED_WORKFLOW_MESSAGE);
  });

  test('a task read while its workflow is still being started is not taken for a purged one', async () => {
    const { engine, agent } = await createWorkflowAgentFixture();
    const start = engine.start.bind(engine);
    const readsDuringStart: unknown[] = [];
    engine.start = async (...args: Parameters<typeof start>) => {
      const handle = await start(...args);
      // The workflow exists, and the agent has not written its task yet.
      readsDuringStart.push(
        await rejectionOf(agent.requestHandler.getTask({ tenant: '', id: handle.id }, alice())),
      );
      await agent.idle();
      return handle;
    };

    const task = await startTask(agent, alice());
    engine.start = start;

    expect(readsDuringStart).toHaveLength(1);
    expect(readsDuringStart[0]).toBeInstanceOf(TaskNotFoundError);
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const latest = await agent.requestHandler.getTask({ tenant: '', id: task.id }, alice());
    expect(latest.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(latest.history.map(textOf)).not.toContain(PURGED_WORKFLOW_MESSAGE);
  });
});
