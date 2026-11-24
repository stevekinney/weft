import { describe, expect, test } from 'bun:test';

import { type StreamResponse, TaskState } from '@a2a-js/sdk';
import { UnsupportedOperationError } from '@a2a-js/sdk/errors';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { NAMESPACE, onCleanup } from './push-delivery.test-support.ts';
import { callerScope } from './store-support.ts';
import { createTaskEventLog } from './task-event-log.ts';
import {
  AGENT_URL,
  callContext,
  collect,
  createFixtureEngine,
  createWorkflowAgentFixture,
  echoWorkflow,
  loopingWorkflow,
  progressWorkflow,
  sendRequest,
  serveWorkflow,
  startTask,
  statusOf,
  userMessage,
  useWorkflowAgentFixtures,
  waitForState,
} from './workflow-agent.test-support.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });
/** The caller the HTTP handler serves without `authenticate`. */
const anonymous = () => callContext();

/** A summary of an event: its kind, and the state of a status update. */
function describeEvent(event: StreamResponse): string {
  const payload = event.payload;
  if (payload?.$case === 'statusUpdate')
    return `status:${TaskState[payload.value.status?.state ?? 0]}`;
  if (payload?.$case === 'task') return `task:${TaskState[payload.value.status?.state ?? 0]}`;
  return payload?.$case ?? 'none';
}

type ServerSentEvent = { readonly id: string | undefined; readonly data: Record<string, unknown> };

/** Read a `text/event-stream` body one event at a time. */
function serverSentEvents(response: Response): () => Promise<ServerSentEvent | undefined> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return async () => {
    while (true) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary !== -1) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const lines = block.split('\n');
        const data = lines.find((line) => line.startsWith('data:'));
        if (data === undefined) continue;
        const id = lines
          .find((line) => line.startsWith('id:'))
          ?.slice(3)
          .trim();
        return { id, data: JSON.parse(data.slice(5)) as Record<string, unknown> };
      }
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

function subscribeRequest(taskId: string, headers: Record<string, string> = {}): Request {
  return new Request(`${AGENT_URL}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'SubscribeToTask',
      params: { id: taskId },
    }),
  });
}

describe('SendStreamingMessage', () => {
  // Owner ruling, 2026-10-19: a stream ends at INPUT_REQUIRED, as the SDK's
  // DefaultRequestHandler ends one, rather than staying open until a terminal state.
  test('ends at INPUT_REQUIRED, and each answer’s stream follows the task to its next wait or its end', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: loopingWorkflow.name });
    const started = await collect(
      agent.requestHandler.sendMessageStream(sendRequest(userMessage()), alice()),
    );
    const opening = started[0]?.payload;
    const taskId = opening?.$case === 'task' ? opening.value.id : '';
    const answer = (text: string) =>
      collect(
        agent.requestHandler.sendMessageStream(sendRequest(userMessage({ taskId, text })), alice()),
      );

    const first = await answer('answer 1');
    const second = await answer('answer 2');

    expect(describeEvent(started.at(-1) as StreamResponse)).toEndWith(':TASK_STATE_INPUT_REQUIRED');
    expect(describeEvent(first.at(-1) as StreamResponse)).toEndWith(':TASK_STATE_INPUT_REQUIRED');
    expect(first.slice(1).map(describeEvent)).not.toContain('status:TASK_STATE_COMPLETED');
    expect(describeEvent(second.at(-1) as StreamResponse)).toBe('status:TASK_STATE_COMPLETED');
  });

  test('ends with its first event when the task already waits for input', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const message = userMessage({ messageId: 'asked-once' });
    await startTask(agent, alice(), message);

    // A retried message finds its task waiting for input, which announces nothing more.
    const events = await collect(
      agent.requestHandler.sendMessageStream(sendRequest(message), alice()),
    );

    expect(events.map(describeEvent)).toEqual(['task:TASK_STATE_INPUT_REQUIRED']);
  });

  test('applies configuration.historyLength to the task it starts with', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: echoWorkflow.name });

    const events = await collect(
      agent.requestHandler.sendMessageStream(
        sendRequest(userMessage(), { historyLength: 0 }),
        alice(),
      ),
    );

    expect(events[0]?.payload).toMatchObject({ $case: 'task', value: { history: [] } });
    expect(describeEvent(events.at(-1) as StreamResponse)).toEndWith(':TASK_STATE_COMPLETED');
  });

  test('applies the continuation checks before delivering a signal', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: echoWorkflow.name });
    const task = await startTask(agent, alice());

    expect(
      await rejectionOf(
        collect(
          agent.requestHandler.sendMessageStream(
            sendRequest(userMessage({ taskId: task.id })),
            alice(),
          ),
        ),
      ),
    ).toBeInstanceOf(UnsupportedOperationError);
  });
});

describe('SubscribeToTask', () => {
  test('refuses a terminal task with UnsupportedOperationError before any snapshot', async () => {
    const { agent, handler } = await createWorkflowAgentFixture({
      workflowType: echoWorkflow.name,
    });
    const task = await startTask(agent, anonymous());
    const stream = agent.requestHandler.resubscribe({ tenant: '', id: task.id }, anonymous());

    expect(await rejectionOf(stream.next())).toBeInstanceOf(UnsupportedOperationError);
    const response = await handler(subscribeRequest(task.id));
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32004);
  });

  test('sends only durable status and artifact events, never the workflow’s step, delta, or tool progress', async () => {
    const { agent, storage } = await createWorkflowAgentFixture({
      workflowType: progressWorkflow.name,
    });
    const task = await startTask(agent, alice());
    const log = createTaskEventLog({ storage, namespace: NAMESPACE, now: Date.now });
    const scope = callerScope(NAMESPACE, alice());
    const snapshot = await log.read(scope, task.id);
    const snapshotSequence = snapshot?.sequence ?? -1;
    const subscription = agent.requestHandler.resubscribe({ tenant: '', id: task.id }, alice());
    const first = await subscription.next();

    await startTask(agent, alice(), userMessage({ taskId: task.id, text: 'go on' }));
    const streamed = await collect({ [Symbol.asyncIterator]: () => subscription });
    const durable: StreamResponse[] = [];
    for await (const entry of log.follow(scope, task.id, snapshotSequence)) {
      durable.push(entry.event);
      if (statusOf(entry.event) === TaskState.TASK_STATE_COMPLETED) break;
    }

    expect(describeEvent(first.value as StreamResponse)).toBe('task:TASK_STATE_INPUT_REQUIRED');
    // Every durable change reaches the stream, and nothing else does.
    expect(streamed).toEqual(durable);
    expect(new Set(streamed.map((event) => event.payload?.$case))).toEqual(
      new Set(['statusUpdate', 'artifactUpdate']),
    );
    expect(streamed.map(describeEvent).slice(-2)).toEqual([
      'artifactUpdate',
      'status:TASK_STATE_COMPLETED',
    ]);
    const completed = await agent.requestHandler.getTask({ tenant: '', id: task.id }, alice());
    expect(streamed.at(-2)?.payload).toMatchObject({ value: { artifact: completed.artifacts[0] } });
  });

  test('follows a task waiting for input past its snapshot, and ends at its next INPUT_REQUIRED', async () => {
    const { agent } = await createWorkflowAgentFixture({ workflowType: loopingWorkflow.name });
    const task = await startTask(agent, alice());
    const subscription = agent.requestHandler.resubscribe({ tenant: '', id: task.id }, alice());
    const snapshot = await subscription.next();

    await startTask(agent, alice(), userMessage({ taskId: task.id, text: 'first' }));
    const later = await collect({ [Symbol.asyncIterator]: () => subscription });

    expect(describeEvent(snapshot.value as StreamResponse)).toBe('task:TASK_STATE_INPUT_REQUIRED');
    expect(later.map(describeEvent)).toEqual([
      'status:TASK_STATE_WORKING',
      'status:TASK_STATE_INPUT_REQUIRED',
    ]);
  });

  test('resumes with Last-Event-ID from the current task, then only the events after its cursor', async () => {
    const { agent, handler } = await createWorkflowAgentFixture({
      workflowType: loopingWorkflow.name,
    });
    const task = await startTask(agent, anonymous());
    await startTask(agent, anonymous(), userMessage({ taskId: task.id, text: 'first' }));
    await waitForState(agent, task.id, anonymous(), TaskState.TASK_STATE_INPUT_REQUIRED);

    // Resume from the first event, well below the current task's cursor.
    const response = await handler(subscribeRequest(task.id, { 'last-event-id': '0' }));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const next = serverSentEvents(response);
    const snapshot = await next();
    const snapshotResult = snapshot?.data['result'] as { task?: { status: { state: string } } };
    expect(snapshotResult.task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const snapshotCursor = Number(snapshot?.id);
    expect(snapshotCursor).toBeGreaterThan(0);

    await startTask(agent, anonymous(), userMessage({ taskId: task.id, text: 'second' }));
    const later: ServerSentEvent[] = [];
    for (let event = await next(); event !== undefined; event = await next()) later.push(event);

    expect(later.length).toBeGreaterThan(0);
    const cursors = later.map((event) => Number(event.id));
    expect(cursors.every((cursor) => cursor > snapshotCursor)).toBe(true);
    expect(cursors).toEqual(cursors.toSorted((left, right) => left - right));
    expect(new Set(cursors).size).toBe(cursors.length);
    const final = later.at(-1)?.data['result'] as { statusUpdate?: { status: { state: string } } };
    expect(final.statusUpdate?.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('across a restart', () => {
  test('reads the same task, catches up on a workflow that completed while the handler was down, and resumes subscriptions', async () => {
    const first = await createWorkflowAgentFixture({ workflowType: loopingWorkflow.name });
    const waiting = await startTask(first.agent, alice());
    const finishing = await startTask(first.agent, alice());
    first.agent[Symbol.dispose]();
    first.engine[Symbol.dispose]();

    const engine = createFixtureEngine(first.storage);
    onCleanup(() => engine[Symbol.asyncDispose]());
    const recovered = await engine.recoverAll();
    // The second workflow finishes while no handler follows the engine.
    await engine.signal(finishing.id, 'input', 'one');
    await engine.signal(finishing.id, 'input', 'two');
    await recovered.find((handle) => handle.id === finishing.id)?.result();

    const { agent } = serveWorkflow(first.push, engine, { workflowType: loopingWorkflow.name });

    const same = await agent.requestHandler.getTask({ tenant: '', id: waiting.id }, alice());
    expect(same).toEqual(waiting);
    const caughtUp = await agent.requestHandler.getTask({ tenant: '', id: finishing.id }, alice());
    expect(caughtUp.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    const subscription = agent.requestHandler.resubscribe({ tenant: '', id: waiting.id }, alice());
    const snapshot = await subscription.next();
    expect(snapshot.value).toMatchObject({ payload: { $case: 'task', value: waiting } });
    await startTask(agent, alice(), userMessage({ taskId: waiting.id, text: 'after restart' }));
    const update = await subscription.next();
    expect(describeEvent(update.value as StreamResponse)).toBe('status:TASK_STATE_WORKING');
    await subscription.return();
  });
});
