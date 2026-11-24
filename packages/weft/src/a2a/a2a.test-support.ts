/**
 * Shared fixtures for the A2A kit's tests: an Agent Card, an agent executor the SDK's
 * `DefaultRequestHandler` can run, and JSON-RPC request builders.
 */

import { type AgentCard, Role, TaskState } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';

export const PUBLIC_URL = 'https://agents.example.com/a2a';
export const RPC_URL = 'https://agents.example.com/a2a/';
export const CARD_URL = 'https://agents.example.com/a2a/.well-known/agent-card.json';
export const JWKS_URL = 'https://agents.example.com/a2a/.well-known/jwks.json';

/** A complete Agent Card, as `DefaultRequestHandler` needs one. */
export function agentCardFixture(): AgentCard {
  return {
    name: 'Echo Agent',
    description: 'Replies to every message.',
    supportedInterfaces: [],
    provider: undefined,
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
    signatures: [],
  };
}

/**
 * Completes every task, except one whose message text is `wait`: that task stops in
 * `INPUT_REQUIRED`, which keeps its event bus alive so it can be canceled.
 */
export const echoExecutor: AgentExecutor = {
  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext;
    const content = requestContext.userMessage.parts[0]?.content;
    const waits = content?.$case === 'text' && content.value === 'wait';
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [],
        metadata: undefined,
      }),
    );
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: waits ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_COMPLETED,
          message: {
            messageId: `${taskId}-reply`,
            contextId,
            taskId,
            role: Role.ROLE_AGENT,
            parts: [
              {
                content: { $case: 'text', value: waits ? 'waiting' : 'echo' },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain',
              },
            ],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    // A task waiting for input keeps its bus open, so it can still be canceled.
    if (!waits) eventBus.finished();
  },
  async cancelTask(taskId, eventBus) {
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    eventBus.finished();
  },
};

/** A `DefaultRequestHandler` over an `InMemoryTaskStore` running {@link echoExecutor}. */
export function createEchoRequestHandler(): DefaultRequestHandler {
  return new DefaultRequestHandler(agentCardFixture(), new InMemoryTaskStore(), echoExecutor);
}

/** The JSON-RPC body of a `SendMessage` (or `SendStreamingMessage`) request. */
export function sendMessageBody(
  options: { method?: string; text?: string; id?: number | string; tenant?: unknown } = {},
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method: options.method ?? 'SendMessage',
    params: {
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: options.text ?? 'hello' }],
      },
    },
  };
}

/** A `POST` to the JSON-RPC route with `A2A-Version: 1.0` unless `headers` says otherwise. */
export function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
