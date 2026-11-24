/**
 * `SendMessage` and `SendStreamingMessage` for a workflow agent: a message without a
 * `taskId` starts the workflow (or, when the agent's `respond` answers it, gets a bare
 * agent `Message` instead), and a message with one is delivered to the signal the
 * workflow waits for.
 *
 * A stream ends once its task reaches a terminal state or `INPUT_REQUIRED`, as the
 * SDK's `DefaultRequestHandler` ends one: the task then waits on its caller, whose
 * next message opens a new stream.
 *
 * @module a2a/workflow-agent-messages
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
import {
  ContentTypeNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import type { PushNotificationStore, ServerCallContext } from '@a2a-js/sdk/server';

import { encodeStorageKeyComponent } from "../embedded/storage/src/index.ts";
import type { Engine } from '../core/engine.ts';
import { pushConfigurationCreatePlannerOf } from './push-notification-store.ts';
import { requestSignalOf } from './sse-response.ts';
import { withStreamEventCursor } from './stream-cursors.ts';
import { type StoredWorkflowTask, taskEventCursor, type TaskEventLog } from './task-event-log.ts';
import type { WorkflowAgentInputMode } from './workflow-agent-card.ts';
import {
  isSettledTaskState,
  isTerminalTaskState,
  statusUpdateEvent,
  withStatus,
} from './workflow-task-projection.ts';
import { taskOwnerOf, type WorkflowTaskRuntime } from './workflow-task-runtime.ts';

/** The metadata key on a continuation message that names the signal to deliver. */
export const SIGNAL_NAME_METADATA_KEY = 'signalName';

/**
 * Turns what `inputMode` reads from a message into the workflow input (for a message
 * that starts a task) or the signal payload (for a continuation), with the whole
 * message at hand: its `messageId`, `metadata`, and every part.
 */
export type WorkflowAgentInput = (payload: unknown, message: Message) => unknown;

/**
 * Answers a message that names no task with a bare agent `Message` holding the parts
 * it returns, instead of starting the workflow; `undefined` starts the workflow.
 */
export type WorkflowAgentResponder = (
  message: Message,
  context: ServerCallContext,
) => readonly Part[] | undefined | Promise<readonly Part[] | undefined>;

/** The default {@link WorkflowAgentInput}: what `inputMode` reads, unchanged. */
export const payloadAsInput: WorkflowAgentInput = (payload) => payload;

export type WorkflowAgentMessaging = {
  sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task>;
  sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined>;
  /** Follow a task from its stored snapshot: the snapshot, then each later event. */
  follow(
    stored: StoredWorkflowTask,
    context: ServerCallContext,
    historyLength: number | undefined,
  ): AsyncGenerator<StreamResponse, void, undefined>;
};

/** Apply `historyLength`: absent keeps every message, `0` or less keeps none. */
export function withHistoryLength(task: Task, historyLength: number | undefined): Task {
  if (historyLength === undefined) return task;
  return { ...task, history: historyLength <= 0 ? [] : task.history.slice(-historyLength) };
}

/**
 * The workflow input or signal payload a message carries: its first data part for
 * `'data'`, its text parts concatenated for `'text'`.
 *
 * @throws {RequestMalformedError} When the message has no part of that kind.
 */
export function payloadOf(message: Message, inputMode: WorkflowAgentInputMode): unknown {
  if (inputMode === 'data') {
    for (const part of message.parts) {
      if (part.content?.$case === 'data') return part.content.value ?? null;
    }
    throw new RequestMalformedError('This agent reads a data part, and the message has none.');
  }
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === 'text') texts.push(part.content.value);
  }
  if (texts.length === 0) {
    throw new RequestMalformedError('This agent reads text parts, and the message has none.');
  }
  return texts.join('');
}

function requireMessage(params: SendMessageRequest, inputModes: readonly string[]): Message {
  const message = params.message;
  if (message === undefined || message.messageId === '') {
    throw new RequestMalformedError('message.messageId is required.');
  }
  for (const part of message.parts) {
    if (part.mediaType !== '' && !inputModes.includes(part.mediaType)) {
      throw new ContentTypeNotSupportedError(
        `Media type '${part.mediaType}' is not supported; this agent accepts ${inputModes.join(', ')}.`,
      );
    }
  }
  return message;
}

/** The signal a continuation delivers to: the one wait, or the one `signalName` names. */
function signalFor(message: Message, waits: readonly string[]): string {
  if (waits.length === 0) {
    throw new RequestMalformedError(
      'The task is not waiting for input, so it accepts no message until it asks for one.',
    );
  }
  const named: unknown = message.metadata?.[SIGNAL_NAME_METADATA_KEY];
  if (waits.length === 1 && named === undefined) return waits[0] as string;
  if (typeof named !== 'string' || !waits.includes(named)) {
    throw new RequestMalformedError(
      `Name the signal to deliver in metadata.${SIGNAL_NAME_METADATA_KEY}: one of ${waits.map((w) => `'${w}'`).join(', ')}.`,
    );
  }
  return named;
}

/** The state a status-update event moves its task to; `undefined` for any other event. */
function statusStateOf(event: StreamResponse): TaskState | undefined {
  return event.payload?.$case === 'statusUpdate' ? event.payload.value.status?.state : undefined;
}

/**
 * Whether a stream ends once its task reaches `state`: a terminal state, or
 * `INPUT_REQUIRED`, where the SDK's `DefaultRequestHandler` ends its streams too.
 * `AUTH_REQUIRED` is not one, as it is not in the SDK either.
 */
export function endsStream(state: TaskState | undefined): boolean {
  return isTerminalTaskState(state) || state === TaskState.TASK_STATE_INPUT_REQUIRED;
}

function foreignMessage(message: Message): RequestMalformedError {
  return new RequestMalformedError(
    `messageId '${message.messageId}' already started another caller's task; send the message with a new messageId.`,
  );
}

function taskEvent(task: Task): StreamResponse {
  return { payload: { $case: 'task', value: task } };
}

/** The agent's reply to `message`, which named no task, holding `parts`. */
function replyTo(message: Message, parts: readonly Part[]): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: message.contextId === '' ? crypto.randomUUID() : message.contextId,
    taskId: '',
    role: Role.ROLE_AGENT,
    parts: [...parts],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** What a message gets: a bare reply, or the task it started or continued. */
type Accepted =
  | { readonly kind: 'reply'; readonly message: Message }
  | { readonly kind: 'task'; readonly stored: StoredWorkflowTask };

export function createWorkflowAgentMessaging(options: {
  readonly engine: Engine;
  readonly workflowType: string;
  readonly inputMode: WorkflowAgentInputMode;
  /** The card's `defaultInputModes`: a part naming any other media type is refused. */
  readonly inputModes: readonly string[];
  readonly log: TaskEventLog;
  readonly runtime: WorkflowTaskRuntime;
  readonly pushStore: PushNotificationStore;
  readonly now: () => number;
  readonly toInput: WorkflowAgentInput;
  readonly respond: WorkflowAgentResponder | undefined;
}): WorkflowAgentMessaging {
  const { engine, workflowType, inputMode, inputModes, log, runtime, pushStore, now } = options;
  const { toInput, respond } = options;
  // The planner of a store `createWeftPushNotificationStore` made writes its records,
  // stamped with its clock, in the batch that creates a task. Any other store keeps its
  // own records, so only its own `save` can store a configuration in it.
  const planPushCreate = pushConfigurationCreatePlannerOf(pushStore);

  /**
   * Save the message's inline push configuration for its task, under the store's
   * create rules: a configuration it repeats is returned rather than stored again, and
   * one naming a deleted or different configuration's `id` is refused. Every message
   * that reaches a task does this, whether it created the task, retried the message
   * that did, or continued it, as the SDK's `DefaultRequestHandler` does; the message
   * that creates the task stores it in the batch that creates the task instead (see `createTask`).
   */
  async function installPushConfiguration(
    params: SendMessageRequest,
    taskId: string,
    context: ServerCallContext,
  ): Promise<void> {
    const config = params.configuration?.taskPushNotificationConfig;
    if (config === undefined) return;
    await pushStore.save(taskId, context, { ...config, taskId });
  }

  /**
   * Create the task a first message started, with its owner record and the message's
   * inline push configuration, in one conditional batch. The configuration is stored
   * before the task's first status is sent, so a status as fast as a workflow that
   * completes at once reaches it. A create that loses to another caller, fails, or
   * never commits because the process stops leaves no configuration in this caller's
   * scope, where no task record would lead pruning to it. A push store that did not
   * come from `createWeftPushNotificationStore` saves the configuration itself before
   * the task is created, so it too has it before the first status, without that
   * guarantee.
   */
  async function createTask(
    message: Message,
    params: SendMessageRequest,
    context: ServerCallContext,
    taskId: string,
  ): Promise<void> {
    const contextId = message.contextId === '' ? taskId : message.contextId;
    const submitted: Task = {
      id: taskId,
      contextId,
      status: undefined,
      artifacts: [],
      history: [{ ...message, taskId, contextId }],
      metadata: undefined,
    };
    const status = {
      state: TaskState.TASK_STATE_SUBMITTED,
      message: undefined,
      timestamp: new Date(now()).toISOString(),
    };
    const task = withStatus(submitted, status);
    const config = params.configuration?.taskPushNotificationConfig;
    if (planPushCreate === undefined) await installPushConfiguration(params, taskId, context);
    const created = await log.create(
      runtime.scopeOf(context),
      taskOwnerOf(context),
      { task, events: [statusUpdateEvent(task, status)] },
      config === undefined || planPushCreate === undefined
        ? undefined
        : () => planPushCreate(taskId, context, { ...config, taskId }),
    );
    if (created === 'foreign') throw foreignMessage(message);
    // Another request for the same message created the task first, so this one reached
    // an existing task, as a retry does.
    if (created === undefined && planPushCreate !== undefined) {
      await installPushConfiguration(params, taskId, context);
    }
    await runtime.publish(created, context);
  }

  /** Start (or, for a retried message, find) the workflow and its task. */
  async function start(
    message: Message,
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<StoredWorkflowTask> {
    const input = toInput(payloadOf(message, inputMode), message);
    const user = encodeStorageKeyComponent(context.user?.userName ?? '');
    const handle = await engine.start(workflowType, input, {
      idempotencyKey: `${user}:${message.messageId}`,
    });
    const taskId = handle.id;
    const workflowState = await engine.get(taskId);
    const scope = runtime.scopeOf(context);
    // The engine's idempotency keys span every workflow type and caller scope, so a key
    // another agent or tenant used first names a run that is not this caller's task.
    if (workflowState?.type !== workflowType) throw foreignMessage(message);
    const existing = await log.read(scope, taskId);
    if (existing === undefined) {
      await createTask(message, params, context, taskId);
    } else {
      // A retried message returns the caller's existing task, and its configuration
      // applies to that task like any other.
      await installPushConfiguration(params, taskId, context);
    }
    const stored = await runtime.reconcile(taskId, context);
    if (stored === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    return stored;
  }

  /** Check a continuation and deliver it to the signal the workflow waits for. */
  async function continueTask(
    message: Message,
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<StoredWorkflowTask> {
    const taskId = message.taskId;
    const current = await runtime.reconcile(taskId, context);
    if (current === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    const { task, sequence } = current;
    if (message.contextId !== '' && message.contextId !== task.contextId) {
      throw new RequestMalformedError(
        `contextId '${message.contextId}' does not match task '${taskId}' context '${task.contextId}'.`,
      );
    }
    if (isTerminalTaskState(task.status?.state)) {
      throw new UnsupportedOperationError(
        `Task ${taskId} is in a terminal state and accepts no more messages.`,
      );
    }
    const state = await engine.get(taskId);
    const signalName = signalFor(message, state === null ? [] : runtime.liveWaits(state));
    const payload = toInput(payloadOf(message, inputMode), message);
    // Saved once the continuation is accepted, and before its signal, so the status
    // changes the signal causes reach the configuration too.
    await installPushConfiguration(params, taskId, context);

    const generation = runtime.beginDelivery(taskId);
    try {
      await engine.signal(taskId, signalName, payload);
    } catch (error) {
      runtime.abandonDelivery(taskId);
      throw error;
    }
    runtime.recordDelivery(taskId, signalName, generation);
    const userMessage: Message = { ...message, taskId, contextId: task.contextId };
    const timestamp = new Date(now()).toISOString();
    const commit = await log.commit(runtime.scopeOf(context), taskId, (stored) => {
      const history = [...stored.task.history, userMessage];
      const withMessage = { ...stored.task, history };
      // Only the wait this message answered moves to WORKING. Once anything was
      // committed since it was read, reconciliation already owns the status, and it may
      // be a new wait the workflow announced after taking this answer.
      if (
        stored.sequence !== sequence ||
        stored.task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED
      ) {
        return { task: withMessage, events: [] };
      }
      const status = { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp };
      const next = withStatus(withMessage, status);
      return { task: next, events: [statusUpdateEvent(next, status)] };
    });
    await runtime.publish(commit, context);
    const stored = await runtime.reconcile(taskId, context);
    if (stored === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    return stored;
  }

  async function accept(params: SendMessageRequest, context: ServerCallContext): Promise<Accepted> {
    const message = requireMessage(params, inputModes);
    if (message.taskId !== '')
      return { kind: 'task', stored: await continueTask(message, params, context) };
    const parts = await respond?.(message, context);
    if (parts !== undefined) return { kind: 'reply', message: replyTo(message, parts) };
    return { kind: 'task', stored: await start(message, params, context) };
  }

  async function* follow(
    stored: StoredWorkflowTask,
    context: ServerCallContext,
    historyLength: number | undefined,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const { task, sequence } = stored;
    yield withStreamEventCursor(
      taskEvent(withHistoryLength(task, historyLength)),
      taskEventCursor(sequence),
    );
    if (isTerminalTaskState(task.status?.state)) return;
    const signal = requestSignalOf(context);
    for await (const entry of log.follow(runtime.scopeOf(context), task.id, sequence, signal)) {
      yield withStreamEventCursor(entry.event, entry.cursor);
      if (endsStream(statusStateOf(entry.event))) return;
    }
  }

  /** The task once it settles (terminal or waiting on the caller), or at once. */
  async function settled(
    stored: StoredWorkflowTask,
    context: ServerCallContext,
    returnImmediately: boolean,
  ): Promise<Task> {
    if (returnImmediately || isSettledTaskState(stored.task.status?.state)) return stored.task;
    const scope = runtime.scopeOf(context);
    const signal = requestSignalOf(context);
    for await (const entry of log.follow(scope, stored.task.id, stored.sequence, signal)) {
      if (isSettledTaskState(statusStateOf(entry.event))) break;
    }
    const latest = await log.read(scope, stored.task.id);
    return latest?.task ?? stored.task;
  }

  return {
    async sendMessage(params, context) {
      const accepted = await accept(params, context);
      if (accepted.kind === 'reply') return accepted.message;
      const returnImmediately = params.configuration?.returnImmediately === true;
      const task = await settled(accepted.stored, context, returnImmediately);
      return withHistoryLength(task, params.configuration?.historyLength);
    },
    async *sendMessageStream(params, context) {
      const accepted = await accept(params, context);
      if (accepted.kind === 'reply') {
        yield { payload: { $case: 'message', value: accepted.message } };
        return;
      }
      const { stored } = accepted;
      const historyLength = params.configuration?.historyLength;
      // A task already waiting on its caller announces no further status before the
      // caller answers, so the stream ends with its first event.
      if (stored.task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
        const snapshot = taskEvent(withHistoryLength(stored.task, historyLength));
        yield withStreamEventCursor(snapshot, taskEventCursor(stored.sequence));
        return;
      }
      yield* follow(stored, context, historyLength);
    },
    follow,
  };
}
