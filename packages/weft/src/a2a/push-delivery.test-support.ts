/**
 * Shared fixtures for the push-delivery suites: a push store and outbox over one
 * memory storage, an HTTP delivery adapter aimed at a loopback receiver through the
 * push store's resolvers, a manually advanced outbox clock, a manual adapter timer,
 * and stream events.
 */

import { afterEach } from 'bun:test';

import { type StreamResponse, type TaskPushNotificationConfig, TaskState } from '@a2a-js/sdk';
import { ServerCallContext, STATE_HEADERS_KEY } from '@a2a-js/sdk/server';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { createMailboxClock, type MailboxClock } from '../core/mailbox.test-support.ts';
import type { OutboxOptions } from '../core/outbox-contract.ts';
import { Outbox } from '../core/outbox.ts';
import { createEgressPolicy } from '../runtime/egress-policy.ts';
import { TestReceiver } from '../testing/webhook-receiver.test-support.ts';
import { callContext, pushConfigFixture } from './a2a-store.test-support.ts';
import {
  createHttpDeliveryAdapterWithRuntime,
  type HttpDeliveryAdapter,
} from './http-delivery-adapter.ts';
import {
  createOutboxPushNotificationSender,
  type OutboxPushNotificationSender,
  pushNotificationResolvers,
} from './push-notification-sender.ts';
import {
  createWeftPushNotificationStore,
  type WeftPushNotificationStore,
} from './push-notification-store.ts';

export const SIGNING_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
export const NAMESPACE = 'support-agent';

type ManualTimer = { callback: () => void; delayMs: number; cancelled: boolean };

/** A scheduler whose timers fire only when the test says so. */
export function manualScheduler() {
  const timers: ManualTimer[] = [];
  const waiting: Array<(timer: ManualTimer) => void> = [];
  return {
    timers,
    schedule(callback: () => void, delayMs: number) {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      for (const resolve of waiting.splice(0)) resolve(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Resolves with the next timer armed after this call. */
    nextTimer(): Promise<ManualTimer> {
      return new Promise((resolve) => waiting.push(resolve));
    },
    /** Fire every timer still armed. */
    fire() {
      for (const timer of timers.filter((entry) => !entry.cancelled)) {
        timer.cancelled = true;
        timer.callback();
      }
    },
  };
}

export type PushFixture = {
  readonly storage: MemoryStorage;
  readonly pushStore: WeftPushNotificationStore;
  readonly receiver: TestReceiver;
  readonly clock: MailboxClock;
  readonly scheduler: ReturnType<typeof manualScheduler>;
  readonly adapter: HttpDeliveryAdapter;
  readonly outbox: Outbox;
  readonly sender: OutboxPushNotificationSender;
  /** A second outbox over the same storage, as a restarted process would build. */
  restart(): Outbox;
};

const cleanups: Array<() => void | Promise<void>> = [];

/**
 * Register, in the calling test file, the hook that releases everything a test
 * opened. A hook registered here would bind only to the first file that loads
 * this module.
 */
export function usePushFixtures(): void {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });
}

export function onCleanup(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup);
}

export async function startReceiver(): Promise<TestReceiver> {
  const receiver = new TestReceiver();
  onCleanup(() => receiver.close());
  return receiver;
}

function buildAdapter(
  pushStore: WeftPushNotificationStore,
  receiver: TestReceiver,
  scheduler: ReturnType<typeof manualScheduler>,
): HttpDeliveryAdapter {
  return createHttpDeliveryAdapterWithRuntime(
    {
      ...pushNotificationResolvers(pushStore),
      signingSecrets: [SIGNING_SECRET],
      egressPolicy: createEgressPolicy({
        allowInsecureHttp: true,
        allowlist: [receiver.host],
        resolveHost: null,
      }),
    },
    { schedule: scheduler.schedule, now: () => Date.now() },
  );
}

export async function createPushFixture(
  outboxOptions: Partial<OutboxOptions> = {},
): Promise<PushFixture> {
  const storage = new MemoryStorage();
  onCleanup(() => storage[Symbol.dispose]());
  const pushStore = createWeftPushNotificationStore({ storage, namespace: NAMESPACE });
  const receiver = await startReceiver();
  const clock = createMailboxClock();
  const scheduler = manualScheduler();
  const adapter = buildAdapter(pushStore, receiver, scheduler);
  const newOutbox = (): Outbox => {
    const outbox = new Outbox({
      storage,
      namespace: NAMESPACE,
      ownerId: 'push',
      adapter: buildAdapter(pushStore, receiver, scheduler),
      now: clock.now,
      ...outboxOptions,
    });
    onCleanup(() => outbox.dispose());
    return outbox;
  };
  const outbox = new Outbox({
    storage,
    namespace: NAMESPACE,
    ownerId: 'push',
    adapter,
    now: clock.now,
    ...outboxOptions,
  });
  onCleanup(() => outbox.dispose());
  const sender = createOutboxPushNotificationSender({ outbox, pushStore });
  return {
    storage,
    pushStore,
    receiver,
    clock,
    scheduler,
    adapter,
    outbox,
    sender,
    restart: newOutbox,
  };
}

/** Create a push configuration for `taskId` aimed at the fixture's receiver. */
export async function createConfiguration(
  fixture: PushFixture,
  options: {
    readonly id?: string;
    readonly taskId?: string;
    readonly token?: string;
    readonly context?: ServerCallContext;
  } = {},
): Promise<TaskPushNotificationConfig> {
  return fixture.pushStore.create(
    options.taskId ?? 'task-1',
    options.context ?? callContext({ user: 'alice' }),
    pushConfigFixture(options.taskId ?? 'task-1', {
      id: options.id ?? 'config-1',
      url: fixture.receiver.url(),
      token: options.token ?? 'token-secret',
      authentication: { scheme: 'Bearer', credentials: 'credential-secret' },
    }),
  );
}

/** A status update for `taskId`, distinct per `index`. */
export function statusEvent(index: number, taskId = 'task-1'): StreamResponse {
  return {
    payload: {
      $case: 'statusUpdate',
      value: {
        taskId,
        contextId: 'context-1',
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
        metadata: { index },
      },
    },
  };
}

/** Alice's call context, carrying `headers` as the A2A handler stores them. */
export function contextWithHeaders(headers: Record<string, string>): ServerCallContext {
  const context = callContext({ user: 'alice' });
  context.state.set(STATE_HEADERS_KEY, headers);
  return context;
}

export { callContext };
