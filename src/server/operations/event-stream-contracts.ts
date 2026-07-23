import { z } from 'zod';

import type { FleetEventEnvelope } from '../fleet-event-feed.ts';
import type { ParameterizedAccessHint } from '../operation-catalog/types.ts';
import type { EventEnvelope } from '../workflow-event-feed.ts';

export const fleetEventEnvelopeSchema: z.ZodType<FleetEventEnvelope> = z.object({
  kind: z.string(),
  workflowId: z.string().optional(),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.unknown(),
});

export const workflowEventEnvelopeSchema: z.ZodType<EventEnvelope> = z.object({
  kind: z.string(),
  workflowId: z.string(),
  selector: z.enum(['events', 'tokens']),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.unknown(),
});

export const workflowEventParameterizedAccess: ParameterizedAccessHint = {
  discriminator: 'selector',
  defaultValue: 'events',
  variants: [
    {
      value: 'events',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
    },
    {
      value: 'tokens',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
    },
  ],
};

export type ClosableAsyncIterable<T> = AsyncIterable<T> & {
  close(): Promise<void>;
};

export type ReplayAwareClosableIterable<T> = ClosableAsyncIterable<T> & {
  readonly replayComplete: Promise<void>;
};

type ReplayAwareClosableIterableOptions = {
  readonly close: () => void | Promise<void>;
};

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

export function isClosableAsyncIterable<T>(value: unknown): value is ClosableAsyncIterable<T> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { close?: unknown };
  return typeof candidate.close === 'function';
}

export function isReplayAwareClosableIterable<T>(
  value: unknown,
): value is ReplayAwareClosableIterable<T> {
  return (
    isClosableAsyncIterable<T>(value) &&
    'replayComplete' in value &&
    value.replayComplete instanceof Promise
  );
}
