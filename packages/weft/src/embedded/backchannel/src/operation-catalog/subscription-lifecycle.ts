import type { SubscriptionOperationInvocation } from './types.ts';

/** Whether the invoke result owns a subscription that must be closed after use. */
export function isSubscriptionInvocation(
  value: unknown,
): value is SubscriptionOperationInvocation<unknown, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'subscriptionId' in value &&
    typeof value.subscriptionId === 'string' &&
    'envelope' in value &&
    'iterable' in value &&
    isAsyncIterable(value.iterable) &&
    'close' in value &&
    typeof value.close === 'function'
  );
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

/** Release an invocation that never reached a transport. */
export async function closeAbandonedSubscription(
  invocation: SubscriptionOperationInvocation<unknown, unknown>,
): Promise<void> {
  try {
    await invocation.close();
  } catch {
    // Cleanup failure must not replace the original dispatch fault.
  }
}
