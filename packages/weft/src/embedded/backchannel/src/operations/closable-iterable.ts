/**
 * An async iterable a consumer can close, and one that also says when its replay is complete.
 * Imports nothing, so every host that serves a replay-and-live feed can build one.
 *
 * @module server/operations/closable-iterable
 */

export type ClosableAsyncIterable<T> = AsyncIterable<T> & {
  close(): Promise<void>;
};

/** A closable async iterable that also exposes `replayComplete`, which settles once the replay part of a replay-and-live feed has been delivered. */
export type ReplayAwareClosableIterable<T> = ClosableAsyncIterable<T> & {
  readonly replayComplete: Promise<void>;
};

type ReplayAwareClosableIterableOptions = {
  readonly close: () => void | Promise<void>;
};

/** Wraps an async iterable source so a consumer can close it and await `replayComplete`. */
export function createReplayAwareClosableIterable<T>(
  createSource: (onReplayComplete: () => void) => AsyncIterable<T>,
  options: ReplayAwareClosableIterableOptions,
): ReplayAwareClosableIterable<T> {
  const replayComplete = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = Promise.resolve().then(options.close);
    return closePromise;
  };

  let source: AsyncIterable<T>;
  try {
    source = createSource(() => replayComplete.resolve());
  } catch (error) {
    void close();
    throw error;
  }
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const value of source) yield value;
      } finally {
        await close();
      }
    },
    replayComplete: replayComplete.promise,
    close,
  };
}

/** Whether a value is an async iterable with a `close` method. */
export function isClosableAsyncIterable<T>(value: unknown): value is ClosableAsyncIterable<T> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { close?: unknown };
  return typeof candidate.close === 'function';
}

/** Whether a value is a closable async iterable that also exposes `replayComplete`. */
export function isReplayAwareClosableIterable<T>(
  value: unknown,
): value is ReplayAwareClosableIterable<T> {
  return (
    isClosableAsyncIterable<T>(value) &&
    'replayComplete' in value &&
    value.replayComplete instanceof Promise
  );
}
