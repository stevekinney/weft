/**
 * Driving and stopping A2A push delivery through a Weft outbox: `startPushDelivery`
 * drains the outbox on an interval, and `stopPushDeliveries` cancels every open
 * delivery to one push configuration and waits until each has settled, which is what
 * deleting a configuration needs before it returns.
 *
 * Push delivery accepts only an outbox whose adapter is `createHttpDeliveryAdapter`,
 * with a request timeout below the outbox's `attemptTimeoutMs`. The adapter then
 * aborts its own request before the outbox would stop waiting for it, so every
 * attempt settles and no push delivery ends with `cleanupPending: true`.
 *
 * @module a2a/push-delivery
 */

import { delayUnlessAborted } from '../core/application-primitive-timing.ts';
import { decodeApplicationDeliveryRecord } from '../core/outbox-codec.ts';
import { createOutboxKeys } from '../core/outbox-storage.ts';
import { isApplicationDeliveryTerminalState } from '../core/outbox-types.ts';
import type { Outbox } from '../core/outbox.ts';
import { type HttpDeliveryAdapter, isHttpDeliveryAdapter } from './http-delivery-adapter.ts';
import { requireTimerDelayMs } from './timer-delay.ts';

/** How often {@link startPushDelivery} drains the outbox by default. */
export const DEFAULT_PUSH_DELIVERY_INTERVAL_MS = 1000;

/**
 * The adapter an outbox must carry for push delivery.
 *
 * @throws {TypeError} When the outbox's adapter is not `createHttpDeliveryAdapter`.
 * @throws {RangeError} When the adapter's `timeoutMs` is not below the outbox's
 *   `attemptTimeoutMs`.
 */
export function requirePushOutbox(outbox: Outbox): HttpDeliveryAdapter {
  const adapter = outbox.adapter;
  if (!isHttpDeliveryAdapter(adapter)) {
    throw new TypeError(
      'Push delivery requires an outbox constructed with an adapter from createHttpDeliveryAdapter.',
    );
  }
  if (adapter.timeoutMs >= outbox.attemptTimeoutMs) {
    throw new RangeError(
      `The HTTP delivery adapter's timeoutMs (${adapter.timeoutMs}) must be lower than the outbox's attemptTimeoutMs (${outbox.attemptTimeoutMs}).`,
    );
  }
  return adapter;
}

/** Options for {@link startPushDelivery}. */
export type StartPushDeliveryOptions = {
  /** An outbox whose adapter is `createHttpDeliveryAdapter`. */
  readonly outbox: Outbox;
  /** How long to wait between drains, in milliseconds. Default 1000. */
  readonly intervalMs?: number | undefined;
  /** Stops the loop; an attempt in flight when it aborts is aborted too. */
  readonly signal: AbortSignal;
  /** Where a failed drain is reported; the loop keeps running. Default `console.error`. */
  readonly onError?: ((error: unknown) => void) | undefined;
};

function defaultErrorSink(error: unknown): void {
  console.error('A2A push delivery drain failed:', error);
}

/**
 * Drive push delivery: drain everything due in the outbox, wait `intervalMs`, and
 * repeat until `signal` aborts. Each drain sends what is due and returns, so an
 * attempt is never cut short by a drain budget. Resolves once the loop has stopped.
 *
 * @throws {TypeError} When the outbox's adapter is not `createHttpDeliveryAdapter`.
 * @throws {RangeError} When `intervalMs` is not an integer from 1 to 2147483647, or the adapter's
 *   timeout is not below the outbox's `attemptTimeoutMs`.
 */
export async function startPushDelivery(options: StartPushDeliveryOptions): Promise<void> {
  const { outbox, signal } = options;
  requirePushOutbox(outbox);
  const intervalMs = requireTimerDelayMs(
    'intervalMs',
    options.intervalMs ?? DEFAULT_PUSH_DELIVERY_INTERVAL_MS,
  );
  const onError = options.onError ?? defaultErrorSink;
  const never = new AbortController().signal;
  while (!signal.aborted) {
    try {
      await outbox.drain({ timeoutMs: 0, signal });
    } catch (error) {
      if (signal.aborted) break;
      // A reporter that throws must not stop delivery; there is nowhere left to
      // report its own failure to.
      try {
        onError(error);
      } catch {
        // Deliberately swallowed.
      }
    }
    await delayUnlessAborted(intervalMs, never, signal);
  }
}

/**
 * Every delivery to `destinationRef` that is not yet terminal, as delivery identifiers.
 * The scan reads every delivery record the outbox retains, so unlike `Outbox.list` it
 * cannot miss one behind a page of other destinations' deliveries.
 */
export async function openDeliveries(outbox: Outbox, destinationRef: string): Promise<string[]> {
  const { deliveryPrefix } = createOutboxKeys(outbox.namespace, outbox.ownerId);
  const deliveryIds: string[] = [];
  for await (const [key, bytes] of outbox.storage.scan(deliveryPrefix)) {
    const record = decodeApplicationDeliveryRecord(bytes, key);
    if (
      record.destinationRef === destinationRef &&
      !isApplicationDeliveryTerminalState(record.state)
    ) {
      deliveryIds.push(record.deliveryId);
    }
  }
  return deliveryIds;
}

/**
 * Cancel every open delivery to `destinationRef` and return once each is terminal
 * with its attempt settled: a queued or retry-scheduled delivery is cancelled at once,
 * and an attempting one is aborted and waited through `cancellation-requested`.
 *
 * The scan reads every delivery record the outbox still retains, terminal ones
 * included, so its cost grows with the outbox's terminal retention.
 *
 * @throws {Error} When an aborted attempt has not settled within the adapter's
 *   timeout plus one drain interval, as when the process running it died.
 */
export async function stopPushDeliveries(
  outbox: Outbox,
  adapter: HttpDeliveryAdapter,
  destinationRef: string,
  reason: string,
): Promise<void> {
  const deliveryIds = await openDeliveries(outbox, destinationRef);
  const results = await Promise.all(
    deliveryIds.map((deliveryId) => outbox.requestCancellation({ deliveryId, reason })),
  );
  const unsettled = await Promise.all(
    results.map(async (result) => {
      if (result.status !== 'requested') return null;
      const cleanup = await outbox.awaitCleanup({
        deliveryId: result.receipt.deliveryId,
        timeoutMs: adapter.timeoutMs + DEFAULT_PUSH_DELIVERY_INTERVAL_MS,
      });
      return cleanup.status === 'pending' ? cleanup.receipt.deliveryId : null;
    }),
  );
  const pending = unsettled.filter((deliveryId) => deliveryId !== null);
  if (pending.length > 0) {
    throw new Error(
      `Push deliveries ${pending.join(', ')} did not settle after cancellation; their attempts may still be running elsewhere.`,
    );
  }
}
