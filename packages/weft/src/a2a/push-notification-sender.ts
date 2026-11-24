/**
 * `createOutboxPushNotificationSender`: the A2A SDK's `PushNotificationSender` that
 * enqueues one durable outbox delivery per push configuration instead of POSTing
 * inline, and a push store whose `delete` stops that configuration's deliveries
 * before it returns. `pushNotificationResolvers` gives `createHttpDeliveryAdapter`
 * the resolvers that read each delivery's URL, credentials, and token from the push
 * store on every attempt.
 *
 * A delivery stores only a locator for its configuration (tenant, owner, task, and
 * configuration identifier), never its URL, token, or credentials, so a deleted
 * configuration leaves no secret behind in the outbox either.
 *
 * @module a2a/push-notification-sender
 */

import { StreamResponse, type Task } from '@a2a-js/sdk';
import {
  STATE_HEADERS_KEY,
  ServerCallContext,
  type PushNotificationSender,
  type User,
} from '@a2a-js/sdk/server';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from "../embedded/backchannel/src/internals.ts";
import type { ApplicationDeliveryCausation } from '../core/outbox-types.ts';
import type { Outbox } from '../core/outbox.ts';
import {
  A2A_PUSH_CONTENT_TYPE,
  type HttpDeliveryAdapterOptions,
  type HttpDeliveryCredential,
} from './http-delivery-adapter.ts';
import { requirePushOutbox, stopPushDeliveries } from './push-delivery.ts';
import {
  delegatePushConfigurationCreates,
  type WeftPushNotificationStore,
} from './push-notification-store.ts';
import { callerScope } from './store-support.ts';

/** The outbox delivery `kind` of every push notification. */
export const A2A_PUSH_DELIVERY_KIND = 'a2a.push-notification';
/** Every push delivery may be claimed this many times before it is dead-lettered. */
export const A2A_PUSH_MAX_ATTEMPTS = 8;

const LOCATOR_PREFIX = 'a2a-push';
const TRACEPARENT_PATTERN = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;
const textEncoder = new TextEncoder();

type PushLocator = {
  readonly tenant: string;
  readonly owner: string;
  readonly taskId: string;
  readonly configId: string;
};

function encodeLocator(locator: PushLocator): string {
  return [LOCATOR_PREFIX, locator.tenant, locator.owner, locator.taskId, locator.configId]
    .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
    .join(':');
}

/**
 * The idempotency key of one event for one configuration:
 * `${tenant}:${owner}:${configId}:${taskId}:${digest}`, each identifier
 * percent-encoded so no value can reach into another's position. The caller's scope
 * leads because task and configuration identifiers are unique only within it.
 */
function idempotencyKeyOf(locator: PushLocator, digest: string): string {
  return [locator.tenant, locator.owner, locator.configId, locator.taskId]
    .map(encodeURIComponent)
    .concat(digest)
    .join(':');
}

/**
 * The `destinationRef` every outbox delivery to one push configuration carries, for the
 * caller scope `context` names. A host that serializes a configuration's deliveries finds
 * the open ones in the outbox by it.
 */
export function pushDestinationRef(
  context: ServerCallContext,
  taskId: string,
  configId: string,
): string {
  const scope = callerScope('', context);
  return encodeLocator({ tenant: scope.tenant, owner: scope.owner, taskId, configId });
}

function decodeLocator(reference: string): PushLocator | undefined {
  const parts = reference.split(':');
  if (parts.length !== 5 || parts[0] !== LOCATOR_PREFIX) return undefined;
  try {
    const [tenant, owner, taskId, configId] = parts.slice(1).map(decodeURIComponent) as [
      string,
      string,
      string,
      string,
    ];
    return { tenant, owner, taskId, configId };
  } catch {
    return undefined;
  }
}

class LocatedUser implements User {
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
  }

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.#name;
  }
}

/** A call context that reproduces the scope a locator was minted in. */
function contextFor(locator: PushLocator): ServerCallContext {
  const userName = locator.owner.startsWith('user:') ? locator.owner.slice(5) : undefined;
  return new ServerCallContext({
    ...(userName === undefined ? {} : { user: new LocatedUser(userName) }),
    ...(locator.tenant === '' ? {} : { tenant: locator.tenant }),
  });
}

/**
 * The `resolveDestination` and `resolveCredential` that read a push delivery's
 * configuration from `pushStore` on every attempt. A deleted configuration resolves to
 * nothing, so its pending deliveries are rejected without a request.
 */
export function pushNotificationResolvers(
  pushStore: WeftPushNotificationStore,
): Pick<HttpDeliveryAdapterOptions, 'resolveDestination' | 'resolveCredential'> {
  async function configurationOf(reference: string) {
    const locator = decodeLocator(reference);
    if (locator === undefined) return undefined;
    return pushStore.get(locator.taskId, locator.configId, contextFor(locator));
  }
  return {
    async resolveDestination(destinationRef) {
      const config = await configurationOf(destinationRef);
      return config?.url;
    },
    async resolveCredential(credentialRef): Promise<HttpDeliveryCredential | undefined> {
      const config = await configurationOf(credentialRef);
      if (config === undefined) return undefined;
      return {
        scheme: config.authentication?.scheme,
        credentials: config.authentication?.credentials,
        notificationToken: config.token || undefined,
      };
    },
  };
}

/** The task a stream event belongs to, or `''` for a message outside any task. */
function taskIdOf(streamResponse: StreamResponse): string {
  const payload = streamResponse.payload;
  if (payload === undefined) return '';
  return payload.$case === 'task' ? payload.value.id : payload.value.taskId;
}

/** A well-formed W3C `traceparent` from the enqueueing request's headers. */
function traceparentOf(context: ServerCallContext): string | undefined {
  const headers = context.state.get(STATE_HEADERS_KEY);
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = (headers as Record<string, unknown>)['traceparent'];
  return typeof value === 'string' && TRACEPARENT_PATTERN.test(value) ? value : undefined;
}

function sha256Hex(text: string): string {
  return bytesToHex(sha256(textEncoder.encode(text)));
}

/** Options for {@link createOutboxPushNotificationSender}. */
export type OutboxPushNotificationSenderOptions = {
  /** An outbox whose adapter is `createHttpDeliveryAdapter`, used only for push delivery. */
  readonly outbox: Outbox;
  /** The push store the configurations live in. */
  readonly pushStore: WeftPushNotificationStore;
};

/**
 * The SDK `PushNotificationSender`, plus `pushStore`: the configured store with a
 * `delete` that stops the configuration's deliveries. Pass `pushStore` to the
 * request handler in place of the store itself.
 */
export type OutboxPushNotificationSender = PushNotificationSender & {
  readonly pushStore: WeftPushNotificationStore;
  /**
   * Send `streamResponse` as the event named by `eventKey`. The key alone is the delivery's
   * identity, so two distinct events whose responses serialize identically are two deliveries, and
   * a replay of the same `eventKey` deduplicates even when the response it builds now differs from
   * the first (a payload that embeds the task's current view drifts between a crash and its
   * replay): the first delivery stands.
   */
  sendKeyed(
    streamResponse: StreamResponse,
    context: ServerCallContext,
    eventKey: string,
  ): Promise<void>;
};

/**
 * Create a `PushNotificationSender` that enqueues one outbox delivery per live push
 * configuration of the event's task. Each delivery is the A2A `StreamResponse` JSON,
 * with:
 *
 * - idempotency key `${tenant}:${owner}:${configId}:${taskId}:${digest}` (each
 *   identifier percent-encoded), where `digest` is the SHA-256 of the event's RFC 8785
 *   serialization (for `sendKeyed`, of the event key alone), so one event is one delivery per
 *   configuration however often it is sent, and two callers whose task and configuration identifiers coincide never
 *   share a key;
 * - `externalIdempotencyKey`, sent as `webhook-id`, derived from that key, so every
 *   attempt of one delivery carries the same `webhook-id`;
 * - `unknownOutcomePolicy: 'retry-with-idempotency'` and `maxAttempts: 8`, because
 *   A2A requires receivers to process notifications idempotently;
 * - the enqueueing request's `traceparent`, when it has a valid one.
 *
 * @throws {TypeError} When the outbox's adapter is not `createHttpDeliveryAdapter`.
 * @throws {RangeError} When the adapter's timeout is not below the outbox's
 *   `attemptTimeoutMs`.
 */
export function createOutboxPushNotificationSender(
  options: OutboxPushNotificationSenderOptions,
): OutboxPushNotificationSender {
  const { outbox, pushStore } = options;
  const adapter = requirePushOutbox(outbox);

  async function enqueueFor(
    configId: string,
    taskId: string,
    context: ServerCallContext,
    event: {
      readonly json: unknown;
      readonly digest: string;
      /** Whether the digest names a caller-keyed event, whose replay may carry another payload. */
      readonly keyed: boolean;
      readonly causation?: ApplicationDeliveryCausation;
    },
  ): Promise<string | null> {
    const scope = callerScope('', context);
    const located = { tenant: scope.tenant, owner: scope.owner, taskId, configId };
    const locator = encodeLocator(located);
    const idempotencyKey = idempotencyKeyOf(located, event.digest);
    const admission = await outbox.enqueue({
      destinationRef: locator,
      credentialRef: locator,
      kind: A2A_PUSH_DELIVERY_KIND,
      payload: { form: 'inline', value: event.json },
      payloadMediaType: A2A_PUSH_CONTENT_TYPE,
      idempotencyKey,
      externalIdempotencyKey: `msg_${sha256Hex(idempotencyKey)}`,
      unknownOutcomePolicy: 'retry-with-idempotency',
      maxAttempts: A2A_PUSH_MAX_ATTEMPTS,
      causation: event.causation,
    });
    if (admission.status === 'rejected') return `${configId}: the outbox backlog is full`;
    // A keyed event's identity is its key alone, so the same key bound to another payload is the
    // replay of an event already enqueued, not a second event.
    if (admission.status === 'conflict' && event.keyed) return null;
    if (admission.status === 'conflict')
      return `${configId}: idempotency key ${idempotencyKey} is bound to another delivery`;
    // A delete that ran between loading the configuration and this enqueue has
    // already swept its deliveries; cancel this one rather than send it.
    if (
      admission.status === 'enqueued' &&
      (await pushStore.get(taskId, configId, context)) === undefined
    ) {
      // The delete already purged this destination, so this late record is stopped and purged
      // here: left settled, it would carry the payload and a spent key for a gone configuration.
      await stopPushDeliveries(
        outbox,
        adapter,
        locator,
        'The push notification configuration was deleted.',
      );
      await outbox.purge({ destinationRef: locator });
    }
    return null;
  }

  const wrappedStore: WeftPushNotificationStore = {
    create: (taskId, context, config) => pushStore.create(taskId, context, config),
    check: (taskId, context, config) => pushStore.check(taskId, context, config),
    save: (taskId, context, config) => pushStore.save(taskId, context, config),
    get: (taskId, configId, context) => pushStore.get(taskId, configId, context),
    load: (taskId, context) => pushStore.load(taskId, context),
    loadWithMetadata: (taskId, context) => pushStore.loadWithMetadata(taskId, context),
    list: (params, context) => pushStore.list(params, context),
    async delete(taskId, context, configId = taskId) {
      await pushStore.delete(taskId, context, configId);
      const scope = callerScope('', context);
      const destinationRef = encodeLocator({
        tenant: scope.tenant,
        owner: scope.owner,
        taskId,
        configId,
      });
      await stopPushDeliveries(
        outbox,
        adapter,
        destinationRef,
        'The push notification configuration was deleted.',
      );
      // Settled records carry the task's payload and hold the idempotency keys of the events
      // already sent, so a later configuration that reuses this id would be handed a duplicate
      // of a delivery to the previous webhook instead of its own.
      await outbox.purge({ destinationRef });
    },
  };
  delegatePushConfigurationCreates(wrappedStore, pushStore);

  return {
    pushStore: wrappedStore,
    send: (streamResponse: StreamResponse, context: ServerCallContext, _task?: Task) =>
      deliver(streamResponse, context, undefined),
    sendKeyed: (streamResponse, context, eventKey) => deliver(streamResponse, context, eventKey),
  };

  async function deliver(
    streamResponse: StreamResponse,
    context: ServerCallContext,
    eventKey: string | undefined,
  ): Promise<void> {
    const taskId = taskIdOf(streamResponse);
    if (taskId === '') return;
    const configs = await pushStore.load(taskId, context);
    if (configs.length === 0) return;
    const json: unknown = StreamResponse.toJSON(streamResponse);
    const traceparent = traceparentOf(context);
    const event = {
      json,
      digest: sha256Hex(eventKey === undefined ? canonicalJson(json) : `keyed\0${eventKey}`),
      keyed: eventKey !== undefined,
      ...(traceparent === undefined ? {} : { causation: { traceparent } }),
    };
    const failures = await Promise.all(
      configs.map((config) => enqueueFor(config.id, taskId, context, event)),
    );
    const messages = failures.filter((failure) => failure !== null);
    if (messages.length > 0) {
      throw new Error(
        `Push notifications for task ${taskId} were not enqueued: ${messages.join('; ')}.`,
      );
    }
  }
}
