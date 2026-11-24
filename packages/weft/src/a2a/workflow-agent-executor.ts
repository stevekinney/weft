/**
 * `createWorkflowAgentExecutor`: serve one registered Weft workflow as an A2A agent.
 *
 * Each A2A task is one workflow run, and its identifier is the workflow identifier.
 * A message without a `taskId` starts the workflow, unless the `respond` option
 * answers it with a bare agent `Message`; a message with one is delivered as the
 * payload of the signal the workflow waits for (`ctx.waitForSignal`), which the task
 * reports as `INPUT_REQUIRED`. `CancelTask` cancels the workflow, and the workflow's
 * result becomes the task's artifacts (by default one, holding the result).
 *
 * The request handler is the SDK's `DefaultRequestHandler`, over the durable task
 * store and the outbox push sender, which keeps serving the Agent Card and the push
 * configuration methods. It serves the message and task methods itself, from each
 * task's durable event log (`task-event-log.ts`), because the SDK's versions follow an
 * in-memory event bus: they cannot resume a stream after a restart, never read
 * `Last-Event-ID`, and end a subscription to a task waiting for input at once. Its
 * streams end where the SDK's do, at a terminal state or `INPUT_REQUIRED`.
 *
 * Under an ownership lease another process can advance a task's workflow and commit
 * its events, which only reach this process through storage. So when the engine runs
 * under `ownership: 'lease'` or `'workflow-lease'`, a stream or a blocking
 * `SendMessage` waiting on a task re-reads its record every `livePollIntervalMs`
 * (one second by default) and replays what another process appended.
 *
 * @module a2a/workflow-agent-executor
 */

import {
  type AgentCard,
  type CancelTaskRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type SubscribeToTaskRequest,
  type Task,
  TaskState,
} from '@a2a-js/sdk';
import {
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import {
  type AgentExecutor,
  DefaultRequestHandler,
  type ServerCallContext,
} from '@a2a-js/sdk/server';

import type { Storage } from "../embedded/storage/src/index.ts";
import type { Engine } from '../core/engine.ts';
import type { OutboxPushNotificationSender } from './push-notification-sender.ts';
import { type A2AStreamTimerScheduler, scheduleWithTimeout } from './sse-response.ts';
import {
  createTaskEventLog,
  type StoredWorkflowTask,
  type TaskEventRecheck,
} from './task-event-log.ts';
import { createWeftA2ATaskStore, type WeftA2ATaskStore } from './task-store.ts';
import { requireTimerDelayMs } from './timer-delay.ts';
import {
  createWorkflowAgentCard,
  type WorkflowAgentCardOptions,
  type WorkflowAgentInputMode,
} from './workflow-agent-card.ts';
import {
  createWorkflowAgentMessaging,
  payloadAsInput,
  withHistoryLength,
  type WorkflowAgentInput,
  type WorkflowAgentMessaging,
  type WorkflowAgentResponder,
} from './workflow-agent-messages.ts';
import {
  defaultResultArtifacts,
  isTerminalTaskState,
  type WorkflowResultArtifacts,
} from './workflow-task-projection.ts';
import { createWorkflowTaskRuntime, type WorkflowTaskRuntime } from './workflow-task-runtime.ts';

/** Options for {@link createWorkflowAgentExecutor}. */
export type WorkflowAgentExecutorOptions = {
  /** The engine the workflow is registered with. */
  readonly engine: Engine;
  /** The registered workflow type the agent serves. */
  readonly workflowType: string;
  /**
   * How a message becomes the workflow's input or a signal's payload: its first data
   * part (`'data'`) or its text parts concatenated (`'text'`).
   */
  readonly inputMode: WorkflowAgentInputMode;
  /**
   * Turns what `inputMode` reads into the workflow input or the signal payload, given
   * the whole message as well, so a workflow can act on its `messageId`, `metadata`,
   * or other parts. Defaults to what `inputMode` reads, unchanged.
   */
  readonly input?: WorkflowAgentInput;
  /**
   * Answers a message that names no task with a bare agent `Message` holding the parts
   * this returns, instead of starting the workflow: `SendMessage` returns that message
   * and `SendStreamingMessage` sends it as its one event. Returning `undefined` starts
   * the workflow. No task, workflow run, or push configuration comes of a reply.
   */
  readonly respond?: WorkflowAgentResponder;
  /**
   * The artifacts a completed workflow's result is published as, in order, each as its
   * own artifact update before the `COMPLETED` status. Defaults to one artifact
   * (`artifactId: 'result'`) holding the result as one data part.
   */
  readonly artifacts?: WorkflowResultArtifacts;
  /** The Agent Card fields the workflow's definition cannot supply. */
  readonly card: WorkflowAgentCardOptions;
  /**
   * Delivers push notifications, from `createOutboxPushNotificationSender`. Its push
   * store must use the same storage and namespace as the agent.
   */
  readonly pushNotificationSender: OutboxPushNotificationSender;
  /** Separates this agent's records in shared storage. Defaults to `workflowType`. */
  readonly namespace?: string;
  /** Where tasks and their events are kept. Defaults to `engine.storage`. */
  readonly storage?: Storage;
  /** How long a terminal task is kept; see `createWeftA2ATaskStore`. */
  readonly terminalRetentionMs?: number;
  /** The clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How often, in milliseconds, a stream or a blocking `SendMessage` waiting on a task
   * checks storage for events another process committed. Defaults to `1000` when the
   * engine runs under an ownership lease, where another process can advance the
   * workflow; otherwise every event is committed in this process and delivered at
   * once, and storage is not re-read unless this is set.
   */
  readonly livePollIntervalMs?: number;
  /**
   * Receives an error no request is waiting on: a failed push enqueue, or a failed
   * reconciliation after an engine event. Defaults to `console.error`.
   */
  readonly onError?: (error: unknown) => void;
};

/** A workflow served as an A2A agent. */
export type WorkflowAgent = {
  /** The Agent Card to pass to `createA2AHandler`. */
  readonly agentCard: AgentCard;
  /** The request handler to pass to `createA2AHandler`. */
  readonly requestHandler: DefaultRequestHandler;
  /** The task store, for `prune()` on a schedule of your choosing. */
  readonly taskStore: WeftA2ATaskStore;
  /** Resolves once every reconciliation an engine event started has settled. */
  idle(): Promise<void>;
  /** Stop following the engine's events. */
  [Symbol.dispose](): void;
};

/**
 * The SDK requires an executor, but the handler serves every method that would run
 * one, so these are reached only by calling the executor directly.
 */
export const workflowAgentUnusedExecutor: AgentExecutor = {
  async execute() {
    throw new UnsupportedOperationError('The workflow agent serves messages itself.');
  },
  async cancelTask() {
    throw new UnsupportedOperationError('The workflow agent cancels tasks itself.');
  },
};

function requireTaskId(taskId: string): void {
  if (taskId.trim() === '') throw new RequestMalformedError('Task ID is required');
}

function found(stored: StoredWorkflowTask | undefined, taskId: string): StoredWorkflowTask {
  if (stored === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`);
  return stored;
}

/** `DefaultRequestHandler` with the message and task methods served from the workflow. */
class WorkflowAgentRequestHandler extends DefaultRequestHandler {
  readonly #runtime: WorkflowTaskRuntime;
  readonly #messaging: WorkflowAgentMessaging;
  readonly #taskStore: WeftA2ATaskStore;
  readonly #engine: Engine;

  constructor(options: {
    readonly agentCard: AgentCard;
    readonly taskStore: WeftA2ATaskStore;
    readonly sender: OutboxPushNotificationSender;
    readonly runtime: WorkflowTaskRuntime;
    readonly messaging: WorkflowAgentMessaging;
    readonly engine: Engine;
  }) {
    super(
      options.agentCard,
      options.taskStore,
      workflowAgentUnusedExecutor,
      undefined,
      options.sender.pushStore,
      options.sender,
    );
    this.#runtime = options.runtime;
    this.#messaging = options.messaging;
    this.#taskStore = options.taskStore;
    this.#engine = options.engine;
  }

  override sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Message | Task> {
    return this.#messaging.sendMessage(params, context);
  }

  override sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    return this.#messaging.sendMessageStream(params, context);
  }

  override async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    requireTaskId(params.id);
    const { task } = found(await this.#runtime.reconcile(params.id, context), params.id);
    return withHistoryLength(task, params.historyLength);
  }

  /**
   * Reconcile every task matching the request's `contextId` from its workflow, then
   * list with the store, which applies the status filters, sorting, and paging to the
   * reconciled records. The cost is linear in the caller's tasks in that context.
   */
  override async listTasks(
    params: ListTasksRequest,
    context: ServerCallContext,
  ): Promise<ListTasksResponse> {
    const taskIds: string[] = [];
    let pageToken = '';
    do {
      const page = await this.#taskStore.list(
        {
          tenant: '',
          contextId: params.contextId,
          status: TaskState.TASK_STATE_UNSPECIFIED,
          pageSize: 100,
          pageToken,
          historyLength: 0,
          statusTimestampAfter: undefined,
          includeArtifacts: false,
        },
        context,
      );
      taskIds.push(...page.tasks.map((task) => task.id));
      pageToken = page.nextPageToken;
    } while (pageToken !== '');
    for (const taskId of taskIds) await this.#runtime.reconcile(taskId, context);
    return super.listTasks(params, context);
  }

  override async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    requireTaskId(params.id);
    const { task } = found(await this.#runtime.reconcile(params.id, context), params.id);
    const state = task.status?.state;
    if (state === TaskState.TASK_STATE_CANCELED) return task;
    if (isTerminalTaskState(state)) {
      throw new TaskNotCancelableError(`Task not cancelable: ${params.id}`);
    }
    await this.#engine.cancel(params.id);
    const { task: latest } = found(await this.#runtime.reconcile(params.id, context), params.id);
    if (latest.status?.state !== TaskState.TASK_STATE_CANCELED) {
      throw new TaskNotCancelableError(`Task not cancelable: ${params.id}`);
    }
    return latest;
  }

  /**
   * Send the current task, tagged with its cursor, then every durable event after that
   * cursor until the task ends. A `Last-Event-ID` the client resumes with needs no
   * handling of its own: the current task already holds every change up to its cursor,
   * so nothing older than it is ever sent.
   */
  override async *resubscribe(
    params: SubscribeToTaskRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    requireTaskId(params.id);
    const stored = found(await this.#runtime.reconcile(params.id, context), params.id);
    if (isTerminalTaskState(stored.task.status?.state)) {
      throw new UnsupportedOperationError(
        `Task ${params.id} is in a terminal state and cannot be subscribed to.`,
      );
    }
    yield* this.#messaging.follow(stored, context, undefined);
  }
}

/**
 * Serve one registered workflow as an A2A agent.
 *
 * @example
 * ```ts
 * import { Engine, Outbox, workflow } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 * import {
 *   createA2AHandler,
 *   createEgressPolicy,
 *   createHttpDeliveryAdapter,
 *   createOutboxPushNotificationSender,
 *   createWeftPushNotificationStore,
 *   createWorkflowAgentExecutor,
 *   pushNotificationResolvers,
 * } from '@lostgradient/weft/a2a';
 *
 * const storage = new MemoryStorage();
 * const engine = new Engine({ storage });
 * engine.register(
 *   workflow({ name: 'greet', description: 'Greets whoever it is given.' }).execute(
 *     async function* (_ctx, name: string) {
 *       return `Hello, ${name}`;
 *     },
 *   ),
 * );
 * const pushStore = createWeftPushNotificationStore({ storage, namespace: 'greet' });
 * const outbox = new Outbox({
 *   storage,
 *   namespace: 'greet',
 *   ownerId: 'push-notifications',
 *   adapter: createHttpDeliveryAdapter({
 *     ...pushNotificationResolvers(pushStore),
 *     egressPolicy: createEgressPolicy(),
 *   }),
 * });
 * const agent = createWorkflowAgentExecutor({
 *   engine,
 *   workflowType: 'greet',
 *   inputMode: 'text',
 *   card: { name: 'Greeter' },
 *   pushNotificationSender: createOutboxPushNotificationSender({ outbox, pushStore }),
 * });
 * const handler = createA2AHandler({
 *   requestHandler: agent.requestHandler,
 *   agentCard: agent.agentCard,
 *   publicUrl: 'https://agents.example.com/greet',
 * });
 * void handler;
 * ```
 *
 * @throws {Error} When `workflowType` is not registered, or has no description and
 *   `card.description` is unset.
 * @throws {RangeError} When `livePollIntervalMs` is not an integer from 1 to 2147483647.
 */
export function createWorkflowAgentExecutor(options: WorkflowAgentExecutorOptions): WorkflowAgent {
  return createWorkflowAgentExecutorWithScheduler(options, scheduleWithTimeout);
}

/** The live poll interval under an ownership lease, when the caller sets none. */
export const DEFAULT_LIVE_POLL_INTERVAL_MS = 1_000;

function livePollOf(
  options: WorkflowAgentExecutorOptions,
  schedule: A2AStreamTimerScheduler,
): TaskEventRecheck | undefined {
  const intervalMs =
    options.livePollIntervalMs ??
    (options.engine.getLeaseHealth().mode === 'none' ? undefined : DEFAULT_LIVE_POLL_INTERVAL_MS);
  if (intervalMs === undefined) return undefined;
  return { intervalMs: requireTimerDelayMs('livePollIntervalMs', intervalMs), schedule };
}

/**
 * {@link createWorkflowAgentExecutor} with the live poll's timer injected. Tests drive
 * it with a manual clock; the public entry point uses `setTimeout`.
 */
export function createWorkflowAgentExecutorWithScheduler(
  options: WorkflowAgentExecutorOptions,
  schedule: A2AStreamTimerScheduler,
): WorkflowAgent {
  const { engine, workflowType, inputMode, pushNotificationSender: sender } = options;
  const definition = engine.getWorkflowDefinition(workflowType);
  if (definition === undefined) {
    throw new Error(`Workflow type '${workflowType}' is not registered with this engine.`);
  }
  const agentCard = createWorkflowAgentCard({ definition, inputMode, card: options.card });
  const storage = options.storage ?? engine.storage;
  const namespace = options.namespace ?? workflowType;
  const now = options.now ?? Date.now;
  const taskStore = createWeftA2ATaskStore({
    storage,
    namespace,
    now,
    ...(options.terminalRetentionMs === undefined
      ? {}
      : { terminalRetentionMs: options.terminalRetentionMs }),
  });
  const recheck = livePollOf(options, schedule);
  const log = createTaskEventLog({
    storage,
    namespace,
    now,
    ...(recheck === undefined ? {} : { recheck }),
  });
  const runtime = createWorkflowTaskRuntime({
    engine,
    namespace,
    log,
    sender,
    now,
    onError: options.onError ?? console.error,
    artifactsOf: options.artifacts ?? defaultResultArtifacts,
  });
  const messaging = createWorkflowAgentMessaging({
    engine,
    workflowType,
    inputMode,
    inputModes: agentCard.defaultInputModes,
    log,
    runtime,
    pushStore: sender.pushStore,
    now,
    toInput: options.input ?? payloadAsInput,
    respond: options.respond,
  });
  const requestHandler = new WorkflowAgentRequestHandler({
    agentCard,
    taskStore,
    sender,
    runtime,
    messaging,
    engine,
  });
  return {
    agentCard,
    requestHandler,
    taskStore,
    idle: () => runtime.idle(),
    [Symbol.dispose]: () => runtime.dispose(),
  };
}
