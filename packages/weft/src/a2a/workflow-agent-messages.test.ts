import { describe, expect, spyOn, test } from 'bun:test';

import { type Message, Role, TaskState } from '@a2a-js/sdk';
import {
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';

import { JsonRpcTransportHandler } from '@a2a-js/sdk/server';

import { rejectionOf, throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { payloadOf } from './workflow-agent-messages.ts';
import {
  callContext,
  choiceWorkflow,
  collect,
  createWorkflowAgentFixture,
  dataPart,
  echoWorkflow,
  followUpWorkflow,
  sendRequest,
  serveWorkflow,
  startTask,
  statusOf,
  textPart,
  userMessage,
  useWorkflowAgentFixtures,
  waitForState,
} from './workflow-agent.test-support.ts';
import { SIGNAL_NAMES_METADATA_KEY } from './workflow-task-projection.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });

describe('starting a workflow with SendMessage', () => {
  test('starts the workflow with the concatenated text parts and names the task after it', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({ inputMode: 'text' });
    const message = userMessage({
      parts: [textPart('Hello, '), dataPart({ x: 1 }), textPart('agent')],
    });

    const task = await startTask(agent, alice(), message);

    const state = await engine.get(task.id);
    expect(state?.type).toBe('agent-approval');
    expect(state?.input).toBe('Hello, agent');
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  });

  test('starts the workflow with the first data part in data mode', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({ inputMode: 'data' });
    const message = userMessage({
      parts: [textPart('ignored'), dataPart({ order: 42 }), dataPart({ order: 7 })],
    });

    const task = await startTask(agent, alice(), message);

    const state = await engine.get(task.id);
    expect(state?.input).toEqual({ order: 42 });
  });

  test('rejects a message without a part the input mode reads', async () => {
    const text = await createWorkflowAgentFixture({ inputMode: 'text' });
    const data = await createWorkflowAgentFixture({ inputMode: 'data' });

    expect(
      await rejectionOf(
        startTask(text.agent, alice(), userMessage({ parts: [dataPart({ x: 1 })] })),
      ),
    ).toBeInstanceOf(RequestMalformedError);
    expect(
      await rejectionOf(startTask(data.agent, alice(), userMessage({ parts: [textPart('x')] }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('uses the client contextId when supplied and the task identifier otherwise', async () => {
    const { agent } = await createWorkflowAgentFixture();

    const supplied = await startTask(agent, alice(), userMessage({ contextId: 'conversation-1' }));
    const minted = await startTask(agent, alice());

    expect(supplied.contextId).toBe('conversation-1');
    expect(minted.contextId).toBe(minted.id);
    expect(minted.history[0]?.taskId).toBe(minted.id);
  });

  test('returns the same task for a retried message and starts the workflow with the user and message identifier as its idempotency key', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const keys: unknown[] = [];
    const start = engine.start.bind(engine);
    engine.start = async (type: string, input: unknown, options?: { idempotencyKey?: string }) => {
      keys.push(options?.idempotencyKey);
      return start(type, input, options);
    };
    const message = userMessage({ messageId: 'message-1' });

    const first = await startTask(agent, alice(), message);
    const retried = await startTask(agent, alice(), message);

    expect(retried.id).toBe(first.id);
    expect(retried.history.filter((entry) => entry.role === Role.ROLE_USER)).toHaveLength(1);
    expect(keys).toEqual(['alice:message-1', 'alice:message-1']);
  });

  test('refuses a message whose idempotency key already started another agent’s workflow', async () => {
    const fixture = await createWorkflowAgentFixture();
    const echo = serveWorkflow(fixture.push, fixture.engine, {
      workflowType: echoWorkflow.name,
      namespace: 'echo-agent',
    });
    await startTask(echo.agent, alice(), userMessage({ messageId: 'shared' }));

    expect(
      await rejectionOf(startTask(fixture.agent, alice(), userMessage({ messageId: 'shared' }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('refuses a message whose idempotency key already started a task in another tenant', async () => {
    const { agent } = await createWorkflowAgentFixture();
    await startTask(
      agent,
      callContext({ user: 'alice', tenant: 'east' }),
      userMessage({ messageId: 'shared' }),
    );

    expect(
      await rejectionOf(
        startTask(
          agent,
          callContext({ user: 'alice', tenant: 'west' }),
          userMessage({ messageId: 'shared' }),
        ),
      ),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('refuses another tenant’s message with the same key once the first task was pruned', async () => {
    let now = 0;
    const { agent } = await createWorkflowAgentFixture({
      workflowType: echoWorkflow.name,
      inputMode: 'text',
      terminalRetentionMs: 10,
      now: () => now,
    });
    const east = () => callContext({ user: 'alice', tenant: 'east' });
    const west = () => callContext({ user: 'alice', tenant: 'west' });
    const first = await startTask(agent, east(), userMessage({ messageId: 'shared', text: 'x' }));
    expect(first.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    now = 100;
    expect(await agent.taskStore.prune()).toBe(1);

    const refusal = await rejectionOf(
      startTask(agent, west(), userMessage({ messageId: 'shared', text: 'y' })),
    );
    const resent = await startTask(agent, east(), userMessage({ messageId: 'shared', text: 'x' }));

    expect(refusal).toBeInstanceOf(RequestMalformedError);
    expect(await agent.taskStore.load(first.id, west())).toBeUndefined();
    // The owner sending the same message again gets its workflow's task back.
    expect(resent.id).toBe(first.id);
    expect(resent.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(resent.artifacts).toEqual(first.artifacts);
  });

  test('rejects a message without a messageId', async () => {
    const { agent } = await createWorkflowAgentFixture();

    expect(
      await rejectionOf(startTask(agent, alice(), userMessage({ messageId: '' }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('returns at once with returnImmediately, before the workflow settles', async () => {
    const { agent } = await createWorkflowAgentFixture();

    const task = await agent.requestHandler.sendMessage(
      sendRequest(userMessage(), { returnImmediately: true }),
      alice(),
    );

    expect(task).toMatchObject({ status: { state: TaskState.TASK_STATE_SUBMITTED } });
  });

  test('applies configuration.historyLength to the returned task', async () => {
    const { agent } = await createWorkflowAgentFixture();

    const task = await agent.requestHandler.sendMessage(
      sendRequest(userMessage(), { historyLength: 1 }),
      alice(),
    );

    expect('history' in task && task.history.map((entry) => entry.role)).toEqual([Role.ROLE_AGENT]);
  });
});

describe('continuing a task with SendMessage', () => {
  test('delivers the message as the payload of the signal the workflow waits for', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'approved' }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(continued.artifacts).toHaveLength(1);
    expect(continued.artifacts[0]?.parts).toEqual([
      expect.objectContaining({
        content: { $case: 'data', value: { request: 'hello', input: 'approved' } },
      }),
    ]);
  });

  test('requires metadata.signalName to choose among several waits and delivers to the one it names', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({
      workflowType: choiceWorkflow.name,
    });
    const task = await startTask(agent, alice());
    expect(task.status?.message?.metadata).toEqual({ signalNames: ['approve', 'reject'] });

    expect(
      await rejectionOf(startTask(agent, alice(), userMessage({ taskId: task.id, text: 'yes' }))),
    ).toBeInstanceOf(RequestMalformedError);
    expect(
      await rejectionOf(
        startTask(
          agent,
          alice(),
          userMessage({ taskId: task.id, text: 'yes', metadata: { signalName: 'other' } }),
        ),
      ),
    ).toBeInstanceOf(RequestMalformedError);

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'nope', metadata: { signalName: 'reject' } }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const state = await engine.get(task.id);
    expect(state?.result).toEqual({ choice: 'reject', value: 'nope' });
  });

  test('rejects a continuation to a task that is not waiting for a signal', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    await engine.suspend(task.id);
    await waitForState(agent, task.id, alice(), TaskState.TASK_STATE_WORKING);

    expect(
      await rejectionOf(startTask(agent, alice(), userMessage({ taskId: task.id, text: 'late' }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('rejects a continuation whose contextId differs from the task’s with -32602', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice(), userMessage({ contextId: 'conversation-1' }));
    const signal = engine.signal.bind(engine);
    let signalled = false;
    engine.signal = (async (...args: Parameters<typeof signal>) => {
      signalled = true;
      return signal(...args);
    }) as typeof engine.signal;

    const rejected = startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, contextId: 'conversation-2', text: 'x' }),
    );

    const error = await rejected.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestMalformedError);
    expect(JsonRpcTransportHandler.mapToJSONRPCError(error).code).toBe(-32602);
    expect(signalled).toBe(false);
  });

  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    test(`rejects a continuation to a ${terminal} task with UnsupportedOperationError`, async () => {
      const { agent, engine } = await createWorkflowAgentFixture();
      const task = await startTask(agent, alice());
      if (terminal === 'completed')
        await startTask(agent, alice(), userMessage({ taskId: task.id }));
      if (terminal === 'cancelled') await engine.cancel(task.id);
      if (terminal === 'failed') await engine.timeout(task.id);
      const expected = {
        completed: TaskState.TASK_STATE_COMPLETED,
        failed: TaskState.TASK_STATE_FAILED,
        cancelled: TaskState.TASK_STATE_CANCELED,
      }[terminal];
      await waitForState(agent, task.id, alice(), expected);

      expect(
        await rejectionOf(
          startTask(agent, alice(), userMessage({ taskId: task.id, text: 'again' })),
        ),
      ).toBeInstanceOf(UnsupportedOperationError);
    });
  }

  test('reports a signal the engine refuses, and still delivers the next continuation', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    const signal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('signal refused');
    };

    expect(
      await throwingRejectionOf(
        startTask(agent, alice(), userMessage({ taskId: task.id, text: 'first' })),
      ),
    ).toThrow('signal refused');
    engine.signal = signal;
    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'second' }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(continued.history.filter((message) => message.role === Role.ROLE_USER)).toHaveLength(2);
  });

  test('records the message without a WORKING step when the workflow finishes before the delivery is recorded', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    const signal = engine.signal.bind(engine);
    engine.signal = (async (id: string, name: string, payload?: unknown) => {
      await signal(id, name, payload);
      await waitForState(agent, id, alice(), TaskState.TASK_STATE_COMPLETED);
    }) as typeof engine.signal;

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'fast' }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(continued.history.at(-1)?.parts[0]?.content).toEqual({ $case: 'text', value: 'fast' });
    expect(continued.history).toHaveLength(3);
  });

  test('keeps a new wait the workflow announced before the continuation recorded its message', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({
      workflowType: followUpWorkflow.name,
    });
    const task = await startTask(agent, alice());
    const signal = engine.signal.bind(engine);
    engine.signal = (async (id: string, name: string, payload?: unknown) => {
      await signal(id, name, payload);
      // Reconciliation announces the `confirm` wait before the continuation commits.
      for await (const event of agent.requestHandler.resubscribe({ tenant: '', id }, alice())) {
        if (statusOf(event) === TaskState.TASK_STATE_INPUT_REQUIRED) break;
      }
    }) as typeof engine.signal;

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'answer' }),
    );
    await agent.idle();
    const latest = await agent.requestHandler.getTask({ tenant: '', id: task.id }, alice());

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(latest.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(latest.status?.message?.metadata?.[SIGNAL_NAMES_METADATA_KEY]).toEqual(['confirm']);
    // One announcement per wait, and the answer once: no WORKING step re-announced `confirm`.
    expect(latest.history.map((message) => message.role)).toEqual([
      Role.ROLE_USER,
      Role.ROLE_AGENT,
      Role.ROLE_AGENT,
      Role.ROLE_USER,
    ]);
  });

  test('retrying the same continuation after it reaches the next question does not answer it', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({
      workflowType: followUpWorkflow.name,
    });
    const task = await startTask(agent, alice());
    const answer = userMessage({ messageId: 'same-answer', taskId: task.id, text: 'answer' });

    await startTask(agent, alice(), answer);
    await waitForState(agent, task.id, alice(), TaskState.TASK_STATE_INPUT_REQUIRED);
    const retry = await startTask(agent, alice(), answer);
    expect(retry.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(retry.status?.message?.metadata?.[SIGNAL_NAMES_METADATA_KEY]).toEqual(['confirm']);
    expect(retry.history.filter((message) => message.messageId === answer.messageId)).toHaveLength(
      1,
    );
    const state = await engine.get(task.id);
    expect(state?.status).toBe('running');
  });

  test('retries a continuation whose signal committed before its history was saved', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({
      workflowType: followUpWorkflow.name,
    });
    const task = await startTask(agent, alice());
    const answer = userMessage({ messageId: 'replay-answer', taskId: task.id, text: 'answer' });
    const originalSignal = engine.signal.bind(engine);
    const signal = spyOn(engine, 'signal').mockImplementationOnce(
      async (
        id: string,
        name: string | { readonly name: string },
        payload?: unknown,
        options?: Parameters<typeof engine.signal>[3],
      ) => {
        await originalSignal(id, typeof name === 'string' ? name : name.name, payload, options);
        throw new Error('response lost before history commit');
      },
    );
    expect(await throwingRejectionOf(startTask(agent, alice(), answer))).toThrow(
      'response lost before history commit',
    );
    signal.mockRestore();
    for await (const event of agent.requestHandler.resubscribe(
      { tenant: '', id: task.id },
      alice(),
    )) {
      const payload = event.payload;
      if (payload?.$case !== 'task' && payload?.$case !== 'statusUpdate') continue;
      const names = payload.value.status?.message?.metadata?.[SIGNAL_NAMES_METADATA_KEY];
      if (Array.isArray(names) && names.includes('confirm')) break;
    }

    const replay = await startTask(agent, alice(), answer);
    expect(replay.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(replay.status?.message?.metadata?.[SIGNAL_NAMES_METADATA_KEY]).toEqual(['confirm']);
    expect(replay.history.filter((message) => message.messageId === answer.messageId)).toHaveLength(
      1,
    );
    const state = await engine.get(task.id);
    expect(state?.status).toBe('running');
  });

  test('completes a workflow that waits for two answers once both have arrived', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({
      workflowType: followUpWorkflow.name,
    });
    const task = await startTask(agent, alice());

    const afterFirst = await startTask(
      agent,
      alice(),
      userMessage({ messageId: 'first-answer', taskId: task.id, text: 'answer' }),
    );
    expect(afterFirst.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

    const afterSecond = await startTask(
      agent,
      alice(),
      userMessage({ messageId: 'second-answer', taskId: task.id, text: 'confirmed' }),
    );
    await agent.idle();

    expect(afterSecond.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const state = await engine.get(task.id);
    expect(state?.status).toBe('completed');
    expect(state?.result).toEqual({ input: 'answer', confirmed: 'confirmed' });
  });

  test('rejects a continuation to a task the caller does not own as not found', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());

    expect(
      await rejectionOf(
        startTask(agent, callContext({ user: 'bob' }), userMessage({ taskId: task.id })),
      ),
    ).toBeInstanceOf(TaskNotFoundError);
  });
});

describe('the input option', () => {
  test('hands the workflow the whole message, at its start and on each continuation', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({
      input: (payload, message) => ({ payload, messageId: message.messageId }),
    });
    const task = await startTask(agent, alice(), userMessage({ messageId: 'first', text: 'hi' }));

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ messageId: 'second', taskId: task.id, text: 'yes' }),
    );

    const state = await engine.get(task.id);
    expect(state?.input).toEqual({ payload: 'hi', messageId: 'first' });
    expect(continued.artifacts[0]?.parts[0]?.content).toEqual({
      $case: 'data',
      value: {
        request: { payload: 'hi', messageId: 'first' },
        input: { payload: 'yes', messageId: 'second' },
      },
    });
  });
});

describe('the respond option', () => {
  const directReply = (message: Message) =>
    message.messageId.startsWith('direct') ? [textPart('Direct answer')] : undefined;

  test('answers SendMessage with a bare agent Message and starts no workflow', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({ respond: directReply });

    const reply = await agent.requestHandler.sendMessage(
      sendRequest(userMessage({ messageId: 'direct-1', contextId: 'conversation-7' })),
      alice(),
    );

    expect(reply).toMatchObject({
      role: Role.ROLE_AGENT,
      taskId: '',
      contextId: 'conversation-7',
      parts: [textPart('Direct answer')],
    });
    expect('messageId' in reply && reply.messageId).not.toBe('direct-1');
    const runs = await engine.list();
    expect(runs.total).toBe(0);
    const listed = await agent.requestHandler.listTasks(
      {
        tenant: '',
        contextId: '',
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: '',
        statusTimestampAfter: undefined,
      },
      alice(),
    );
    expect(listed.tasks).toEqual([]);
  });

  test('sends the reply as a stream’s one event, with a fresh contextId when the client sent none', async () => {
    const { agent } = await createWorkflowAgentFixture({ respond: directReply });

    const events = await collect(
      agent.requestHandler.sendMessageStream(
        sendRequest(userMessage({ messageId: 'direct-2' })),
        alice(),
      ),
    );

    const only = events[0]?.payload;
    expect(events).toHaveLength(1);
    expect(only?.$case).toBe('message');
    expect(only?.$case === 'message' && only.value.contextId).not.toBe('');
  });

  test('starts the workflow when it returns undefined, and is never asked about a continuation', async () => {
    const asked: string[] = [];
    const { agent } = await createWorkflowAgentFixture({
      respond: (message) => {
        asked.push(message.messageId);
        return undefined;
      },
    });

    const task = await startTask(agent, alice(), userMessage({ messageId: 'start' }));
    await startTask(agent, alice(), userMessage({ messageId: 'answer', taskId: task.id }));

    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(asked).toEqual(['start']);
  });
});

describe('payloadOf', () => {
  test('reads a data part’s null value as null', () => {
    expect(payloadOf(userMessage({ parts: [dataPart(undefined)] }), 'data')).toBeNull();
  });
});
