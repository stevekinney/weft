import type { CatalogCallOptions } from './catalog-client.ts';

/**
 * One thing a subscription yields: an `event`, typed by the operation's `eventSchema`, with the
 * `id` to resume after it, or the single `replay-complete` marker that says every event recorded
 * before the subscription opened has been delivered and what follows is live.
 *
 * Narrow on `type`. Keep the `id` of the last event you handled and pass it back as
 * `lastEventId` to resume.
 *
 * @example
 * ```ts
 * import type { SubscriptionMessage } from '@lostgradient/backchannel/client';
 *
 * declare const message: SubscriptionMessage<{ kind: string }>;
 *
 * if (message.type === 'event') {
 *   console.log(message.id, message.data.kind);
 * } else {
 *   console.log('caught up');
 * }
 * ```
 */
export type SubscriptionMessage<Event> =
  | { readonly type: 'event'; readonly id: string; readonly data: Event }
  | { readonly type: 'replay-complete' };

/**
 * What one subscription call can carry beyond its input: the abort `signal` that ends it, the
 * `fetch` to open it with, and `lastEventId`, the `id` of the last event the caller handled, so
 * the stream resumes after it.
 *
 * Aborting the signal ends the iteration without an error. The stream is one connection: when it
 * drops, reconnecting with the last `id` is the caller's to do.
 *
 * @example
 * ```ts
 * import type { SubscriptionCallOptions } from '@lostgradient/backchannel/client';
 *
 * const controller = new AbortController();
 * const options: SubscriptionCallOptions = { signal: controller.signal, lastEventId: '41' };
 * console.log(options.lastEventId);
 * ```
 */
export type SubscriptionCallOptions = CatalogCallOptions & {
  /** The `id` of the last event handled; the stream resumes after it. */
  readonly lastEventId?: string | undefined;
};

/**
 * Transport seam for a subscription client: opens one stream for an operation and its input and
 * returns what the server sends, typed as {@link SubscriptionMessage}. {@link sseSubscriptionTransport}
 * reads it over Server-Sent Events; writing your own routes it to a fake or an in-process host.
 *
 * @example
 * ```ts
 * import type { SubscriptionTransport } from '@lostgradient/backchannel/client';
 *
 * const empty: SubscriptionTransport = async function* () {
 *   yield { type: 'replay-complete' };
 * };
 * console.log(typeof empty);
 * ```
 */
export type SubscriptionTransport = (
  operationName: string,
  input: unknown,
  options?: SubscriptionCallOptions,
) => AsyncIterable<SubscriptionMessage<unknown>>;

type SubscriptionOperationTypes = Record<
  string,
  {
    readonly input: unknown;
    readonly event: unknown;
  }
>;

/**
 * The shape a subscription client takes: one method per subscription name, each accepting that
 * operation's input and an optional {@link SubscriptionCallOptions}, and returning an
 * `AsyncIterable` of its events and the replay-complete marker.
 *
 * Nothing is requested until the iteration starts, and leaving the loop early closes the stream.
 *
 * @example
 * ```ts
 * import type { SubscriptionClient } from '@lostgradient/backchannel/client';
 *
 * type Operations = {
 *   'probe.jobs.watch': {
 *     readonly input: { topic?: string };
 *     readonly event: { kind: string; cursor: string };
 *   };
 * };
 *
 * declare const client: SubscriptionClient<Operations>;
 * const controller = new AbortController();
 *
 * for await (const message of client['probe.jobs.watch']({}, { signal: controller.signal })) {
 *   if (message.type === 'event') console.log(message.id, message.data.kind);
 * }
 * ```
 */
export type SubscriptionClient<Operations extends SubscriptionOperationTypes> = {
  readonly [Name in keyof Operations]: (
    input: Operations[Name]['input'],
    options?: SubscriptionCallOptions,
  ) => AsyncIterable<SubscriptionMessage<Operations[Name]['event']>>;
};

/**
 * Build a subscription client from a list of subscription names and a transport. Each name
 * becomes a method that forwards its input and options through the transport.
 *
 * A generated `create...Client` function pairs the generated names with
 * {@link sseSubscriptionTransport}. Call this directly when you supply the transport yourself.
 *
 * @example
 * ```ts
 * import {
 *   createSubscriptionClient,
 *   sseSubscriptionTransport,
 * } from '@lostgradient/backchannel/client';
 *
 * const client = createSubscriptionClient<{
 *   'probe.jobs.watch': { readonly input: { topic?: string }; readonly event: { kind: string } };
 * }>(['probe.jobs.watch'], sseSubscriptionTransport({ baseUrl: 'https://api.example.test' }));
 *
 * console.log(typeof client['probe.jobs.watch']);
 * ```
 */
export function createSubscriptionClient<Operations extends SubscriptionOperationTypes>(
  operationNames: readonly (keyof Operations & string)[],
  transport: SubscriptionTransport,
): SubscriptionClient<Operations> {
  const methods: Partial<
    Record<keyof Operations, (input: unknown, options?: SubscriptionCallOptions) => unknown>
  > = {};
  for (const operationName of operationNames) {
    methods[operationName] = (input: unknown, options?: SubscriptionCallOptions) =>
      transport(operationName, input, options);
  }
  return methods as SubscriptionClient<Operations>;
}
