import { describe, expect, it } from 'bun:test';

import {
  createReplayAwareClosableIterable,
  fleetEventEnvelopeSchema,
  isClosableAsyncIterable,
  isReplayAwareClosableIterable,
  workflowEventEnvelopeSchema,
  workflowEventParameterizedAccess,
} from './event-stream-contracts.ts';
import { fleetEventsSseOperation } from './fleet-events-sse.ts';
import { fleetEventsSubscriptionOperation } from './fleet-events-subscription.ts';
import { workflowEventsSseOperation } from './workflow-events-sse.ts';
import { workflowEventsSubscriptionOperation } from './workflow-events-subscription.ts';

describe('event-stream contracts', () => {
  it('shares fleet and workflow envelope schemas across transports', () => {
    expect(fleetEventsSseOperation.eventSchema).toBe(fleetEventEnvelopeSchema);
    expect(fleetEventsSubscriptionOperation.eventSchema).toBe(fleetEventEnvelopeSchema);
    expect(workflowEventsSseOperation.eventSchema).toBe(workflowEventEnvelopeSchema);
    expect(workflowEventsSubscriptionOperation.eventSchema).toBe(workflowEventEnvelopeSchema);

    expect(
      fleetEventEnvelopeSchema.safeParse({
        kind: 'workflow:started',
        workflowId: 'wf-1',
        sequence: 1,
        cursor: '1',
        emittedAtMs: 0,
        payload: {},
      }).success,
    ).toBe(true);
    expect(
      workflowEventEnvelopeSchema.safeParse({
        kind: 'workflow:started',
        workflowId: 'wf-1',
        selector: 'events',
        sequence: 1,
        cursor: '1',
        emittedAtMs: 0,
        payload: {},
      }).success,
    ).toBe(true);
  });

  it('shares selector access metadata across workflow transports', () => {
    expect(workflowEventsSseOperation.parameterizedAccess).toEqual(
      workflowEventParameterizedAccess,
    );
    expect(workflowEventsSubscriptionOperation.parameterizedAccess).toEqual(
      workflowEventParameterizedAccess,
    );
    expect(workflowEventParameterizedAccess).toEqual({
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
    });
  });

  it('resolves replay readiness and performs asynchronous cleanup exactly once', async () => {
    let completeReplay: (() => void) | undefined;
    let cleanupCount = 0;
    const iterable = createReplayAwareClosableIterable(
      (onReplayComplete) => {
        completeReplay = onReplayComplete;
        return (async function* () {
          yield 'first';
          yield 'second';
        })();
      },
      {
        close: async () => {
          cleanupCount += 1;
          await Promise.resolve();
        },
      },
    );

    expect(isClosableAsyncIterable(iterable)).toBe(true);
    expect(isReplayAwareClosableIterable(iterable)).toBe(true);
    completeReplay?.();
    await iterable.replayComplete;
    await expect(Array.fromAsync(iterable)).resolves.toEqual(['first', 'second']);
    await Promise.all([iterable.close(), iterable.close()]);
    expect(cleanupCount).toBe(1);
  });

  it('cleans up when iteration returns early or the source fails', async () => {
    let earlyCleanupCount = 0;
    const earlyIterable = createReplayAwareClosableIterable(
      () =>
        (async function* () {
          yield 'first';
          yield 'second';
        })(),
      { close: () => void (earlyCleanupCount += 1) },
    );
    const earlyIterator = earlyIterable[Symbol.asyncIterator]();
    await earlyIterator.next();
    await earlyIterator.return?.();
    expect(earlyCleanupCount).toBe(1);

    let failureCleanupCount = 0;
    const failingIterable = createReplayAwareClosableIterable(
      () =>
        (async function* () {
          throw new Error('source failed');
        })(),
      { close: () => void (failureCleanupCount += 1) },
    );
    await expect(Array.fromAsync(failingIterable)).rejects.toThrow('source failed');
    expect(failureCleanupCount).toBe(1);
  });
});
