import { describe, expect, test } from 'bun:test';

import { type Message, Role, type Task, TaskState } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';

import { agentCardFixture, createEchoRequestHandler, PUBLIC_URL } from './a2a.test-support.ts';
import { createA2AHandler } from './handler.ts';

function userMessage(text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function asTask(result: Message | Task): Task {
  if (!('status' in result)) throw new Error('expected a task');
  return result;
}

/** An SDK client that reaches the kit through an in-process `fetch`. */
async function connectClient(tenant?: string) {
  const handler = createA2AHandler({
    requestHandler: createEchoRequestHandler(),
    agentCard: agentCardFixture(),
    publicUrl: PUBLIC_URL,
    ...(tenant === undefined ? {} : { tenant }),
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    }),
  );
  return factory.createFromUrl(PUBLIC_URL);
}

function sendRequest(text: string) {
  return { tenant: '', message: userMessage(text), configuration: undefined, metadata: undefined };
}

describe('A2A kit with the @a2a-js/sdk client', () => {
  test.each([undefined, 'acme'])(
    'completes SendMessage, GetTask, CancelTask and SendStreamingMessage (tenant %p)',
    async (tenant) => {
      const client = await connectClient(tenant);

      const completed = asTask(await client.sendMessage(sendRequest('hello')));
      expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

      const fetched = await client.getTask({ tenant: '', id: completed.id });
      expect(fetched.id).toBe(completed.id);
      expect(fetched.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

      const waiting = asTask(await client.sendMessage(sendRequest('wait')));
      expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      const canceled = await client.cancelTask({ tenant: '', id: waiting.id, metadata: undefined });
      expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);

      const streamed: string[] = [];
      for await (const event of client.sendMessageStream(sendRequest('stream'))) {
        streamed.push(event.payload?.$case ?? 'none');
      }
      expect(streamed).toEqual(['task', 'statusUpdate']);
    },
  );
});
