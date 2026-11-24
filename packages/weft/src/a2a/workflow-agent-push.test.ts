import { describe, expect, test } from 'bun:test';

import { Role, StreamResponse, type TaskPushNotificationConfig, TaskState } from '@a2a-js/sdk';
import { ContentTypeNotSupportedError, RequestMalformedError } from '@a2a-js/sdk/errors';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { A2APushConfigurationConflictError } from './store-errors.ts';
import {
  callContext,
  createWorkflowAgentFixture,
  sendRequest,
  textPart,
  userMessage,
  useWorkflowAgentFixtures,
  waitForState,
} from './workflow-agent.test-support.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });

/** An inline push configuration for the fixture's receiver. */
function webhook(
  fixture: Awaited<ReturnType<typeof createWorkflowAgentFixture>>,
  id: string,
): TaskPushNotificationConfig {
  return {
    id,
    taskId: '',
    url: fixture.push.receiver.url(),
    token: '',
    authentication: { scheme: 'Bearer', credentials: 'secret' },
    tenant: '',
  };
}

/** Deliver every queued notification and return what each carried: a state or an event kind. */
async function deliveredStates(fixture: Awaited<ReturnType<typeof createWorkflowAgentFixture>>) {
  for (;;) {
    const delivered = await fixture.push.outbox.deliverNext();
    if (delivered.status === 'empty') break;
  }
  return fixture.push.receiver.requests.map((request) => {
    const payload = StreamResponse.fromJSON(JSON.parse(request.body)).payload;
    return payload?.$case === 'statusUpdate' ? payload.value.status?.state : payload?.$case;
  });
}

describe('workflow agent push notifications', () => {
  test('notifies a configuration sent with the first message of every change, from the first', async () => {
    const fixture = await createWorkflowAgentFixture();
    const message = userMessage();
    const task = await fixture.agent.requestHandler.sendMessage(
      sendRequest(message, {
        taskPushNotificationConfig: {
          id: 'config-1',
          taskId: '',
          url: fixture.push.receiver.url(),
          token: 'token-1',
          authentication: { scheme: 'Bearer', credentials: 'secret' },
          tenant: '',
        },
      }),
      alice(),
    );

    // Each notification is its own outbox delivery, so they arrive in no fixed order.
    const states = await deliveredStates(fixture);

    expect(states).toContain(TaskState.TASK_STATE_SUBMITTED);
    expect(states).toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(fixture.push.receiver.requests[0]?.headers['authorization']).toBe('Bearer secret');
    const stored = await fixture.push.pushStore.load('id' in task ? task.id : '', alice());
    expect(stored.map((config) => config.id)).toEqual(['config-1']);
  });

  test('notifies the task’s owner of a change the engine reports while no request runs', async () => {
    const fixture = await createWorkflowAgentFixture();
    const task = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage(), {
        taskPushNotificationConfig: {
          id: 'config-1',
          taskId: '',
          url: fixture.push.receiver.url(),
          token: '',
          authentication: undefined,
          tenant: '',
        },
      }),
      alice(),
    );
    const taskId = 'id' in task ? task.id : '';

    await fixture.engine.signal(taskId, 'input', 'from elsewhere');
    await fixture.engine.getHandle(taskId).result();
    await fixture.agent.idle();

    const states = await deliveredStates(fixture);
    expect(states).toContain('artifactUpdate');
    expect(states).toContain(TaskState.TASK_STATE_COMPLETED);
    expect(fixture.errors).toEqual([]);
  });

  test('saves a configuration sent with a retried message for the task the retry returns', async () => {
    const fixture = await createWorkflowAgentFixture();
    const message = userMessage();
    const first = await fixture.agent.requestHandler.sendMessage(sendRequest(message), alice());
    const taskId = 'id' in first ? first.id : '';
    const retry = () =>
      fixture.agent.requestHandler.sendMessage(
        sendRequest(message, { taskPushNotificationConfig: webhook(fixture, 'config-1') }),
        alice(),
      );

    const retried = await retry();
    // A second identical retry repeats the stored configuration rather than adding one.
    await retry();

    expect('id' in retried && retried.id).toBe(taskId);
    const stored = await fixture.push.pushStore.load(taskId, alice());
    expect(stored.map((config) => config.id)).toEqual(['config-1']);
    expect(stored[0]?.taskId).toBe(taskId);
    await fixture.engine.signal(taskId, 'input', 'approved');
    await fixture.engine.getHandle(taskId).result();
    await fixture.agent.idle();
    expect(await deliveredStates(fixture)).toContain(TaskState.TASK_STATE_COMPLETED);
    expect(fixture.push.receiver.requests[0]?.headers['authorization']).toBe('Bearer secret');
  });

  test('saves a configuration sent with a continuation before delivering it', async () => {
    const fixture = await createWorkflowAgentFixture();
    const first = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage()),
      alice(),
    );
    const taskId = 'id' in first ? first.id : '';

    const continued = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage({ taskId, text: 'approved' }), {
        taskPushNotificationConfig: webhook(fixture, 'config-1'),
      }),
      alice(),
    );

    expect('status' in continued && continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const stored = await fixture.push.pushStore.load(taskId, alice());
    expect(stored.map((config) => config.id)).toEqual(['config-1']);
    const states = await deliveredStates(fixture);
    expect(states).toContain(TaskState.TASK_STATE_WORKING);
    expect(states).toContain(TaskState.TASK_STATE_COMPLETED);
  });

  test('saves no configuration from a continuation it refuses', async () => {
    const fixture = await createWorkflowAgentFixture();
    const first = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage({ contextId: 'conversation-1' })),
      alice(),
    );
    const taskId = 'id' in first ? first.id : '';

    const refusal = await rejectionOf(
      fixture.agent.requestHandler.sendMessage(
        sendRequest(userMessage({ taskId, contextId: 'conversation-2' }), {
          taskPushNotificationConfig: webhook(fixture, 'config-1'),
        }),
        alice(),
      ),
    );

    expect(refusal).toBeInstanceOf(RequestMalformedError);
    expect(await fixture.push.pushStore.load(taskId, alice())).toEqual([]);
  });

  test('refuses a continuation whose configuration names a deleted configuration, delivering nothing', async () => {
    const fixture = await createWorkflowAgentFixture();
    const first = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage(), { taskPushNotificationConfig: webhook(fixture, 'config-1') }),
      alice(),
    );
    const taskId = 'id' in first ? first.id : '';
    await fixture.push.pushStore.delete(taskId, alice(), 'config-1');
    let signals = 0;
    const signal = fixture.engine.signal.bind(fixture.engine);
    fixture.engine.signal = ((...args: Parameters<typeof signal>) => {
      signals += 1;
      return signal(...args);
    }) as typeof signal;

    const refusal = await rejectionOf(
      fixture.agent.requestHandler.sendMessage(
        sendRequest(userMessage({ taskId, text: 'approved' }), {
          taskPushNotificationConfig: webhook(fixture, 'config-1'),
        }),
        alice(),
      ),
    );

    expect(refusal).toBeInstanceOf(A2APushConfigurationConflictError);
    expect(signals).toBe(0);
    const workflowState = await fixture.engine.get(taskId);
    expect(workflowState?.status).toBe('running');
    expect(workflowState?.waitingForSignals).toEqual(['input']);
    const task = await fixture.agent.requestHandler.getTask({ tenant: '', id: taskId }, alice());
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(task.history.filter((message) => message.role === Role.ROLE_USER)).toHaveLength(1);
    expect(await fixture.push.pushStore.load(taskId, alice())).toEqual([]);
  });

  test('saves no configuration for a message refused as another caller’s', async () => {
    const fixture = await createWorkflowAgentFixture();
    const east = () => callContext({ user: 'alice', tenant: 'east' });
    const west = () => callContext({ user: 'alice', tenant: 'west' });
    const first = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage({ messageId: 'shared' })),
      east(),
    );
    const taskId = 'id' in first ? first.id : '';

    const refusal = await rejectionOf(
      fixture.agent.requestHandler.sendMessage(
        sendRequest(userMessage({ messageId: 'shared' }), {
          taskPushNotificationConfig: webhook(fixture, 'config-1'),
        }),
        west(),
      ),
    );

    expect(refusal).toBeInstanceOf(RequestMalformedError);
    expect(await fixture.push.pushStore.load(taskId, west())).toEqual([]);
    expect(await fixture.push.pushStore.load(taskId, east())).toEqual([]);
  });

  test('refuses a retried message whose configuration names a deleted configuration', async () => {
    const fixture = await createWorkflowAgentFixture();
    const message = userMessage();
    const first = await fixture.agent.requestHandler.sendMessage(
      sendRequest(message, { taskPushNotificationConfig: webhook(fixture, 'config-1') }),
      alice(),
    );
    const taskId = 'id' in first ? first.id : '';
    await fixture.push.pushStore.delete(taskId, alice(), 'config-1');

    const refusal = await rejectionOf(
      fixture.agent.requestHandler.sendMessage(
        sendRequest(message, { taskPushNotificationConfig: webhook(fixture, 'config-1') }),
        alice(),
      ),
    );

    expect(refusal).toBeInstanceOf(A2APushConfigurationConflictError);
    expect(await fixture.push.pushStore.load(taskId, alice())).toEqual([]);
  });

  test('reports a push enqueue that fails to onError and still serves the request', async () => {
    const fixture = await createWorkflowAgentFixture();
    fixture.push.sender.send = async () => {
      throw new Error('outbox full');
    };

    const task = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage()),
      alice(),
    );

    expect('status' in task && task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(fixture.errors.length).toBeGreaterThan(0);
    expect(fixture.errors[0]).toMatchObject({ message: 'outbox full' });
    await waitForState(
      fixture.agent,
      'id' in task ? task.id : '',
      alice(),
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
  });
});

describe('message media types', () => {
  test('refuses a part whose media type the card does not accept', async () => {
    const { agent } = await createWorkflowAgentFixture({ inputMode: 'text' });
    const part = { ...textPart('hello'), mediaType: 'application/x-unsupported' };

    expect(
      await rejectionOf(
        agent.requestHandler.sendMessage(sendRequest(userMessage({ parts: [part] })), alice()),
      ),
    ).toBeInstanceOf(ContentTypeNotSupportedError);
    const accepted = await agent.requestHandler.sendMessage(
      sendRequest(userMessage({ parts: [{ ...part, mediaType: 'text/plain' }] })),
      alice(),
    );
    expect('status' in accepted && accepted.status?.state).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
  });
});
