/**
 * A workflow agent stores the inline push configuration of a task's first message in
 * the conditional batch that creates the task and its owner record, so a create that
 * loses a race to another caller, or fails, leaves no configuration (and so no
 * credentials) in a scope with no task record for pruning to find. Runs on every
 * adapter the A2A stores support.
 */

import { describe, expect, test } from 'bun:test';

import { type StreamResponse, type TaskPushNotificationConfig, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type { ServerCallContext } from '@a2a-js/sdk/server';

import { MemoryStorage, type Storage } from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  a2aStoreBackends,
  callContext,
  type ConditionalBatchInterposer,
  interposedStorage,
  storedKeys,
  useBackendStorage,
} from './a2a-store.test-support.ts';
import type { OutboxPushNotificationSender } from './push-notification-sender.ts';
import {
  createWeftPushNotificationStore,
  type WeftPushNotificationStore,
} from './push-notification-store.ts';
import { callerScope, namespaceKeyPrefix, scopedKey } from './store-support.ts';
import { createWorkflowAgentExecutor, type WorkflowAgent } from './workflow-agent-executor.ts';
import {
  createFixtureEngine,
  echoWorkflow,
  sendRequest,
  statusOf,
  userMessage,
} from './workflow-agent.test-support.ts';

const NAMESPACE = 'atomic-push-agent';
const OWNER_PREFIX = namespaceKeyPrefix('workflow-task', NAMESPACE);

const east = () => callContext({ user: 'alice', tenant: 'east' });
const west = () => callContext({ user: 'alice', tenant: 'west' });

function webhook(token: string): TaskPushNotificationConfig {
  return {
    id: '',
    taskId: '',
    url: 'https://hooks.example.com/a2a',
    token,
    authentication: { scheme: 'Bearer', credentials: `${token}-credential` },
    tenant: '',
  };
}

/** What a sent event carried, and how many live configurations its task had then. */
type Sent = { readonly kind: TaskState | string | undefined; readonly configurations: number };

type Harness = {
  /** The storage beneath the interposer, for reading what was stored. */
  readonly storage: Storage;
  readonly agent: WorkflowAgent;
  readonly pushStore: WeftPushNotificationStore;
  readonly sent: Sent[];
};

/**
 * The clocks of the agent and of its push store, each `Date.now` when absent, and
 * whether the push store is a hand-written one that keeps its records apart from the
 * agent's storage rather than one `createWeftPushNotificationStore` made over it.
 */
type AgentOptions = {
  readonly agent?: () => number;
  readonly push?: () => number;
  readonly handWrittenStore?: boolean;
};

/**
 * Serve the echo workflow with its task and push records written through `interpose`,
 * and a sender that records, for every event, how many configurations its task had
 * when it was sent. The engine uses the storage directly.
 */
async function withAgent(
  open: () => Storage,
  interpose: ConditionalBatchInterposer,
  run: (harness: Harness) => Promise<void>,
  clocks: AgentOptions = {},
): Promise<void> {
  const raw = open();
  const { storage } = interposedStorage(raw, interpose);
  const engine = createFixtureEngine(raw);
  const builtIn = createWeftPushNotificationStore({
    storage,
    namespace: NAMESPACE,
    ...(clocks.push === undefined ? {} : { now: clocks.push }),
  });
  const ownStorage = new MemoryStorage();
  const pushStore: WeftPushNotificationStore =
    clocks.handWrittenStore === true
      ? { ...createWeftPushNotificationStore({ storage: ownStorage, namespace: NAMESPACE }) }
      : builtIn;
  const sent: Sent[] = [];
  const sender: OutboxPushNotificationSender = {
    pushStore,
    sendKeyed: async (event, context) => sender.send(event, context),
    async send(event: StreamResponse, context: ServerCallContext) {
      const payload = event.payload;
      const taskId =
        payload?.$case === 'statusUpdate' || payload?.$case === 'artifactUpdate'
          ? payload.value.taskId
          : '';
      const loaded = await pushStore.load(taskId, context);
      sent.push({ kind: statusOf(event) ?? payload?.$case, configurations: loaded.length });
    },
  };
  const errors: unknown[] = [];
  const agent = createWorkflowAgentExecutor({
    engine,
    workflowType: echoWorkflow.name,
    inputMode: 'text',
    card: { name: 'Echo Agent' },
    namespace: NAMESPACE,
    storage,
    pushNotificationSender: sender,
    onError: (error) => errors.push(error),
    ...(clocks.agent === undefined ? {} : { now: clocks.agent }),
  });
  try {
    await run({ storage: raw, agent, pushStore, sent });
    await agent.idle();
    expect(errors).toEqual([]);
  } finally {
    agent[Symbol.dispose]();
    await engine[Symbol.asyncDispose]();
    ownStorage[Symbol.dispose]();
  }
}

/** Every push configuration and push head key in the caller's scope. */
async function pushKeysOf(storage: Storage, context: ServerCallContext): Promise<string[]> {
  const scope = callerScope(NAMESPACE, context);
  return [
    ...(await storedKeys(storage, `${scopedKey('push', scope)}:`)),
    ...(await storedKeys(storage, `${scopedKey('push-head', scope)}:`)),
  ];
}

function writesOwnerRecord(operations: Parameters<ConditionalBatchInterposer>[1]): boolean {
  return operations.some((operation) => operation.key.startsWith(OWNER_PREFIX));
}

function taskIdOf(result: unknown): string {
  return typeof result === 'object' && result !== null && 'id' in result ? String(result.id) : '';
}

for (const backend of a2aStoreBackends) {
  describe(`inline push configuration of a first message [${backend.name}]`, () => {
    const open = useBackendStorage(backend);

    test('is stored before the first status is sent, so a fast COMPLETED reaches it', async () => {
      await withAgent(
        open,
        () => undefined,
        async ({ storage, agent, sent }) => {
          const result = await agent.requestHandler.sendMessage(
            sendRequest(userMessage({ messageId: 'first', text: 'x' }), {
              taskPushNotificationConfig: webhook('fast'),
            }),
            east(),
          );
          await agent.idle();

          expect('status' in result && result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
          const kinds = sent.map((entry) => entry.kind);
          expect(kinds).toContain(TaskState.TASK_STATE_SUBMITTED);
          expect(kinds).toContain(TaskState.TASK_STATE_COMPLETED);
          expect(sent.map((entry) => entry.configurations)).toEqual(sent.map(() => 1));
          // One configuration and its head.
          expect(await pushKeysOf(storage, east())).toHaveLength(2);
        },
      );
    });

    test("is stamped by the push store's clock, so it lists before a configuration added later", async () => {
      let pushTime = 2_000;
      // The agent's clock runs ahead of the push store's.
      const clocks: AgentOptions = { agent: () => 10_000, push: () => ++pushTime };
      await withAgent(
        open,
        () => undefined,
        async ({ agent, pushStore }) => {
          const result = await agent.requestHandler.sendMessage(
            sendRequest(userMessage({ messageId: 'first', text: 'x' }), {
              taskPushNotificationConfig: webhook('first'),
            }),
            east(),
          );
          const taskId = taskIdOf(result);
          await pushStore.create(taskId, east(), { ...webhook('later'), taskId });

          const listed = await pushStore.list({ taskId }, east());
          expect(listed.configs.map((config) => config.token)).toEqual(['first', 'later']);
        },
        clocks,
      );
    });

    test('is saved by a hand-written push store itself, before the first status is sent', async () => {
      await withAgent(
        open,
        () => undefined,
        async ({ storage, agent, pushStore, sent }) => {
          const result = await agent.requestHandler.sendMessage(
            sendRequest(userMessage({ messageId: 'first', text: 'x' }), {
              taskPushNotificationConfig: webhook('copied'),
            }),
            east(),
          );
          await agent.idle();

          const stored = await pushStore.load(taskIdOf(result), east());
          expect(stored.map((config) => config.token)).toEqual(['copied']);
          expect(sent.map((entry) => entry.configurations)).toEqual(sent.map(() => 1));
          // Nothing in the built-in format, which the hand-written store would never read.
          expect(await pushKeysOf(storage, east())).toEqual([]);
        },
        { handWrittenStore: true },
      );
    });

    test('leaves nothing in the scope of a caller that loses the race to create the task', async () => {
      const firstHeld = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let ownerBatches = 0;
      const interpose: ConditionalBatchInterposer = async (_conditions, operations) => {
        if (!writesOwnerRecord(operations)) return undefined;
        ownerBatches += 1;
        if (ownerBatches === 1) {
          // Hold the first caller's create until the second caller has created the task.
          firstHeld.resolve();
          await release.promise;
        }
        return undefined;
      };
      await withAgent(open, interpose, async ({ storage, agent }) => {
        const message = () => userMessage({ messageId: 'shared', text: 'x' });
        const losing = rejectionOf(
          agent.requestHandler.sendMessage(
            sendRequest(message(), { taskPushNotificationConfig: webhook('loser') }),
            east(),
          ),
        );
        await firstHeld.promise;

        const won = await agent.requestHandler.sendMessage(
          sendRequest(message(), { taskPushNotificationConfig: webhook('winner') }),
          west(),
        );
        release.resolve();
        const refusal = await losing;

        expect(refusal).toBeInstanceOf(RequestMalformedError);
        expect(await pushKeysOf(storage, east())).toEqual([]);
        const taskId = taskIdOf(won);
        expect(await agent.taskStore.load(taskId, east())).toBeUndefined();
        expect(await pushKeysOf(storage, west())).toHaveLength(2);
        const task = await agent.requestHandler.getTask({ tenant: '', id: taskId }, west());
        expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      });
    });

    test('stores the configuration of a concurrent retry that finds the task already created', async () => {
      const firstHeld = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let ownerBatches = 0;
      const interpose: ConditionalBatchInterposer = async (_conditions, operations) => {
        if (!writesOwnerRecord(operations)) return undefined;
        ownerBatches += 1;
        if (ownerBatches === 1) {
          firstHeld.resolve();
          await release.promise;
        }
        return undefined;
      };
      await withAgent(open, interpose, async ({ agent, pushStore }) => {
        const message = () => userMessage({ messageId: 'retried', text: 'x' });
        const held = agent.requestHandler.sendMessage(
          sendRequest(message(), { taskPushNotificationConfig: webhook('held') }),
          east(),
        );
        await firstHeld.promise;

        const created = await agent.requestHandler.sendMessage(
          sendRequest(message(), { taskPushNotificationConfig: webhook('created') }),
          east(),
        );
        release.resolve();
        const retried = await held;

        const taskId = taskIdOf(created);
        expect(taskIdOf(retried)).toBe(taskId);
        const stored = await pushStore.load(taskId, east());
        expect(stored.map((config) => config.token).toSorted()).toEqual(['created', 'held']);
      });
    });

    test('leaves nothing behind when the batch that creates the task fails', async () => {
      const failure = new Error('The storage failed while creating the task.');
      const interpose: ConditionalBatchInterposer = (_conditions, operations) => {
        if (writesOwnerRecord(operations)) throw failure;
        return undefined;
      };
      await withAgent(open, interpose, async ({ storage, agent, sent }) => {
        const refusal = await rejectionOf(
          agent.requestHandler.sendMessage(
            sendRequest(userMessage({ messageId: 'doomed', text: 'x' }), {
              taskPushNotificationConfig: webhook('doomed'),
            }),
            east(),
          ),
        );

        expect(refusal).toBe(failure);
        expect(await pushKeysOf(storage, east())).toEqual([]);
        expect(await storedKeys(storage, OWNER_PREFIX)).toEqual([]);
        expect(sent).toEqual([]);
      });
    });
  });
}
