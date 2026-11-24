/**
 * Shared fixtures for the workflow agent suites: the workflows they serve, an agent
 * over an engine and a push fixture's storage, request builders, and helpers that
 * follow a task's durable events instead of polling.
 */

import {
  type Message,
  type Part,
  Role,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  TaskState,
} from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';

import type { Storage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { activity, workflow, type WorkflowContext } from '../core/types.ts';
import { callContext } from './a2a-store.test-support.ts';
import { type A2AHandler, createA2AHandler } from './handler.ts';
import {
  createPushFixture,
  NAMESPACE,
  onCleanup,
  type PushFixture,
} from './push-delivery.test-support.ts';
import {
  createWorkflowAgentExecutor,
  type WorkflowAgent,
  type WorkflowAgentExecutorOptions,
} from './workflow-agent-executor.ts';

export { usePushFixtures as useWorkflowAgentFixtures } from './push-delivery.test-support.ts';
export { callContext };

export const AGENT_URL = 'https://agents.example.com/workflow';

/** Waits for `input`, then completes with the request and the input. */
export const approvalWorkflow = workflow({
  name: 'agent-approval',
  description: 'Asks for input, then answers.',
  version: '3.1.0',
  tags: ['approvals', 'examples'],
}).execute(async function* (ctx: WorkflowContext, request: unknown) {
  const input = yield* ctx.waitForSignal('input');
  return { request, input };
});

/** Waits for either `approve` or `reject`. */
export const choiceWorkflow = workflow({
  name: 'agent-choice',
  description: 'Waits for one of two signals.',
}).execute(async function* (ctx: WorkflowContext, _request: unknown) {
  const winner = yield* ctx.raceKeyed({
    approve: ctx.waitForSignal('approve'),
    reject: ctx.waitForSignal('reject'),
  });
  return { choice: winner.key, value: winner.value };
});

/** Completes at once with its input. */
export const echoWorkflow = workflow({
  name: 'agent-echo',
  description: 'Returns its input.',
}).execute(async function* (_ctx: WorkflowContext, request: unknown) {
  return { echoed: request };
});

/** Fails at once. */
export const failingWorkflow = workflow({
  name: 'agent-failing',
  description: 'Always fails.',
}).execute(async function* (_ctx: WorkflowContext, _request: unknown) {
  throw new Error('The request could not be handled.');
});

/** Waits for `go`, then waits for `input` twice, then completes. */
export const loopingWorkflow = workflow({
  name: 'agent-looping',
  description: 'Asks for input twice.',
}).execute(async function* (ctx: WorkflowContext, _request: unknown) {
  const first = yield* ctx.waitForSignal('input');
  const second = yield* ctx.waitForSignal('input');
  return { first, second };
});

/** Waits for `input`, then for a different signal, `confirm`, then completes. */
export const followUpWorkflow = workflow({
  name: 'agent-follow-up',
  description: 'Asks for input, then for confirmation.',
}).execute(async function* (ctx: WorkflowContext, _request: unknown) {
  const input = yield* ctx.waitForSignal('input');
  const confirmed = yield* ctx.waitForSignal('confirm');
  return { input, confirmed };
});

/** A tool-style activity the progress workflow calls. */
export const lookUpActivity = activity({
  name: 'lookUp',
  execute: (request: unknown) => ({ request, tool: 'search' }),
});

/** Streams tokens and runs an activity before it waits, then streams again. */
export const progressWorkflow = workflow({
  name: 'agent-progress',
  description: 'Reports progress while it works.',
})
  .activities({ lookUp: lookUpActivity })
  .execute(async function* (ctx: WorkflowContext, request: unknown) {
    yield* ctx.stream('tokens', async function* () {
      yield 'step one';
      yield 'delta';
    });
    const looked = yield* ctx.run(lookUpActivity, request);
    const input = yield* ctx.waitForSignal('input');
    yield* ctx.stream('progress', async function* () {
      yield 'step two';
    });
    return { looked, input };
  });

export const FIXTURE_WORKFLOWS = [
  approvalWorkflow,
  choiceWorkflow,
  echoWorkflow,
  failingWorkflow,
  followUpWorkflow,
  loopingWorkflow,
  progressWorkflow,
];

export type WorkflowAgentFixture = {
  readonly push: PushFixture;
  readonly storage: Storage;
  readonly engine: Engine;
  readonly agent: WorkflowAgent;
  readonly handler: A2AHandler;
  readonly errors: unknown[];
};

/** An engine over `storage` with every fixture workflow registered. */
export function createFixtureEngine(storage: Storage): Engine {
  const engine = new Engine({ storage });
  for (const definition of FIXTURE_WORKFLOWS) engine.register(definition);
  return engine;
}

/** Serve `workflowType` from `engine` with `push`'s sender, released after the test. */
export function serveWorkflow(
  push: PushFixture,
  engine: Engine,
  options: Partial<WorkflowAgentExecutorOptions> & { readonly errors?: unknown[] } = {},
): { agent: WorkflowAgent; handler: A2AHandler } {
  const errors = options.errors ?? [];
  const agent = createWorkflowAgentExecutor({
    engine,
    workflowType: approvalWorkflow.name,
    inputMode: 'text',
    card: { name: 'Approval Agent' },
    namespace: NAMESPACE,
    pushNotificationSender: push.sender,
    onError: (error) => errors.push(error),
    ...options,
  });
  onCleanup(() => agent[Symbol.dispose]());
  const handler = createA2AHandler({
    requestHandler: agent.requestHandler,
    agentCard: agent.agentCard,
    publicUrl: AGENT_URL,
  });
  return { agent, handler };
}

/** A push fixture, an engine over its storage, and an agent serving `workflowType`. */
export async function createWorkflowAgentFixture(
  options: Partial<WorkflowAgentExecutorOptions> = {},
): Promise<WorkflowAgentFixture> {
  const push = await createPushFixture();
  const engine = createFixtureEngine(push.storage);
  onCleanup(() => engine[Symbol.asyncDispose]());
  const errors: unknown[] = [];
  const { agent, handler } = serveWorkflow(push, engine, { ...options, errors });
  return { push, storage: push.storage, engine, agent, handler, errors };
}

export function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: '',
  };
}

export function dataPart(value: unknown): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: '' };
}

/** A user message. */
export function userMessage(
  options: {
    readonly parts?: Part[];
    readonly text?: string;
    readonly messageId?: string;
    readonly taskId?: string;
    readonly contextId?: string;
    readonly metadata?: Record<string, unknown>;
  } = {},
): Message {
  return {
    messageId: options.messageId ?? crypto.randomUUID(),
    contextId: options.contextId ?? '',
    taskId: options.taskId ?? '',
    role: Role.ROLE_USER,
    parts: options.parts ?? [textPart(options.text ?? 'hello')],
    metadata: options.metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** A `SendMessageRequest` carrying `message`. */
export function sendRequest(
  message: Message,
  configuration: Partial<NonNullable<SendMessageRequest['configuration']>> = {},
): SendMessageRequest {
  return {
    tenant: '',
    message,
    configuration: {
      acceptedOutputModes: [],
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
      ...configuration,
    },
    metadata: undefined,
  };
}

/** Start a task and resolve with it once it settles. */
export async function startTask(
  agent: WorkflowAgent,
  context: ServerCallContext,
  message: Message = userMessage(),
): Promise<Task> {
  return agent.requestHandler.sendMessage(sendRequest(message), context) as Promise<Task>;
}

/** The state of a status-update event, or `undefined` for any other event. */
export function statusOf(event: StreamResponse): TaskState | undefined {
  return event.payload?.$case === 'statusUpdate' ? event.payload.value.status?.state : undefined;
}

/**
 * Follow a task until it reaches `state`, and resolve with the task as it is then. A
 * subscription to a task that has already ended is refused, so a terminal `state` the
 * task reaches first is read back instead.
 */
export async function waitForState(
  agent: WorkflowAgent,
  taskId: string,
  context: ServerCallContext,
  state: TaskState,
): Promise<Task> {
  const request = { tenant: '', id: taskId };
  try {
    for await (const event of agent.requestHandler.resubscribe(request, context)) {
      const reached =
        event.payload?.$case === 'task'
          ? event.payload.value.status?.state === state
          : statusOf(event) === state;
      if (reached) break;
    }
  } catch (error) {
    const task = await agent.requestHandler.getTask(request, context);
    if (task.status?.state !== state) throw error;
  }
  return agent.requestHandler.getTask(request, context);
}

/** Collect a stream's events until it ends. */
export async function collect(stream: AsyncIterable<StreamResponse>): Promise<StreamResponse[]> {
  const events: StreamResponse[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export { TaskState };
