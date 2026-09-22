/**
 * COR-1283: `pumpSubscriptionIterable`'s three `closeOnce().catch(() => {})`
 * sites (aborted-mid-loop, pre-aborted-before-the-loop-notices, and clean
 * completion) only actually run their catch body when `closeSubscription`
 * itself rejects — every existing indirect caller (`json-rpc-websocket.ts`,
 * exercised through its own integration tests) always supplies a
 * `closeSubscription` that resolves cleanly, so none of the three ever
 * fired. Contract under test: a failing close is swallowed, never
 * propagated to the caller, and `onComplete` still fires regardless.
 */
import { describe, expect, it } from 'bun:test';

import { JSON_RPC_VERSION } from './json-rpc-protocol.ts';
import { pumpSubscriptionIterable } from './json-rpc-websocket-subscription-pump.ts';
import { SESSION_METHODS } from './json-rpc-websocket-subscriptions.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let capturedResolve!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    capturedResolve = resolve;
  });
  return { promise, resolve: capturedResolve };
}

describe('pumpSubscriptionIterable — a rejecting closeSubscription is swallowed', () => {
  it('swallows a rejecting close reached via the pre-aborted-before-the-loop-notices path', async () => {
    // The AbortController is already aborted BEFORE pumpSubscriptionIterable
    // even registers its 'abort' listener, so abortSubscription itself never
    // fires (a listener added after abort() never receives the past event).
    // The iterable still yields one item so the for-await loop body runs and
    // its own `if (signal.aborted)` check is what calls closeOnce() first.
    const controller = new AbortController();
    controller.abort();

    async function* oneItem(): AsyncIterable<unknown> {
      yield { value: 1 };
    }

    const emitted: Record<string, unknown>[] = [];
    let completed = false;

    await expect(
      pumpSubscriptionIterable({
        subscriptionId: 'sub-pre-aborted',
        iterable: oneItem(),
        signal: controller.signal,
        closeSubscription: async () => {
          throw new Error('close failed');
        },
        shouldSuppressOutput: () => false,
        emit: (message) => emitted.push(message),
        onComplete: () => {
          completed = true;
        },
      }),
    ).resolves.toBeUndefined();

    // Aborted before anything could be delivered, and no error surfaced.
    expect(emitted).toEqual([]);
    expect(completed).toBe(true);
  });

  it('swallows a rejecting close reached via abort firing mid-iteration', async () => {
    const controller = new AbortController();
    const afterFirstItem = deferred<void>();
    const continueGenerator = deferred<void>();

    // Yields one item, then blocks (not indefinitely — the test resolves
    // this once it has aborted) so the loop's OWN `.next()` call cannot be
    // what notices the abort. abortSubscription's fire-and-forget
    // `void closeOnce().catch(() => {})` is called synchronously inside
    // `controller.abort()`, independent of the generator ever resuming —
    // that's the actual site under test, not the loop's per-iteration
    // `signal.aborted` check (covered by the pre-aborted test above).
    async function* items(): AsyncIterable<unknown> {
      yield { value: 1 };
      afterFirstItem.resolve();
      await continueGenerator.promise;
      // No second item — the generator just ends here.
    }

    const emitted: Record<string, unknown>[] = [];
    let completed = false;

    const pump = pumpSubscriptionIterable({
      subscriptionId: 'sub-mid-abort',
      iterable: items(),
      signal: controller.signal,
      closeSubscription: async () => {
        throw new Error('close failed');
      },
      shouldSuppressOutput: () => false,
      emit: (message) => emitted.push(message),
      onComplete: () => {
        completed = true;
      },
    });

    await afterFirstItem.promise;
    // abortSubscription runs synchronously inside abort(), calling
    // closeOnce() for the first time — its rejection must not propagate
    // out of abort() or out of the pump.
    controller.abort();
    continueGenerator.resolve();

    await expect(pump).resolves.toBeUndefined();
    expect(emitted).toEqual([
      {
        jsonrpc: JSON_RPC_VERSION,
        method: SESSION_METHODS.DELIVER,
        params: { subscriptionId: 'sub-mid-abort', envelope: { value: 1 } },
      },
    ]);
    expect(completed).toBe(true);
  });

  it('swallows a rejecting close reached via clean completion (no abort)', async () => {
    const controller = new AbortController();

    async function* noItems(): AsyncIterable<unknown> {
      // Ends immediately — the loop never runs, and no abort ever fires,
      // so the `finally` block's closeOnce() is the very first call.
    }

    let completed = false;

    await expect(
      pumpSubscriptionIterable({
        subscriptionId: 'sub-clean-completion',
        iterable: noItems(),
        signal: controller.signal,
        closeSubscription: async () => {
          throw new Error('close failed');
        },
        shouldSuppressOutput: () => false,
        emit: () => {},
        onComplete: () => {
          completed = true;
        },
      }),
    ).resolves.toBeUndefined();

    expect(completed).toBe(true);
  });
});
