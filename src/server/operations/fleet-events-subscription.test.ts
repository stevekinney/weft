import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import type { FleetEventEnvelope } from '../fleet-event-feed.ts';
import { createFleetEventFeed } from '../fleet-event-feed.ts';
import { anonymousPrincipal } from '../principal.ts';
import {
  fleetEventsSubscriptionOperation,
  type FleetEventsSubscriptionInput,
} from './fleet-events-subscription.ts';

const MATCHING_FLEET_EVENT: FleetEventEnvelope = {
  kind: 'workflow:completed',
  workflowId: 'wf-match',
  sequence: 1005,
  cursor: '1005',
  emittedAtMs: 1,
  payload: { workflowId: 'wf-match', result: 'done' },
};

function fleetEvent(
  sequence: number,
  overrides: Partial<FleetEventEnvelope> = {},
): FleetEventEnvelope {
  return {
    kind: 'workflow:started',
    workflowId: 'wf-match',
    sequence,
    cursor: String(sequence),
    emittedAtMs: sequence,
    payload: { workflowId: 'wf-match' },
    ...overrides,
  };
}

async function invokeFleetSubscription(
  input: FleetEventsSubscriptionInput,
  replayEvents: readonly FleetEventEnvelope[],
  liveEvents: readonly FleetEventEnvelope[] = [],
) {
  const fleetFeed = {
    subscribe() {
      return (async function* subscriptionEvents() {
        const replayTail = replayEvents.reduce((tail, event) => Math.max(tail, event.sequence), -1);
        yield* replayEvents;
        for (const event of liveEvents) {
          if (event.sequence > replayTail) yield event;
        }
      })();
    },
  };

  return fleetEventsSubscriptionOperation.invoke({
    input,
    principal: anonymousPrincipal(),
    engine: { fleetFeed },
    transport: 'jsonRpcWebSocket',
  });
}

async function collectSequences(iterable: AsyncIterable<FleetEventEnvelope>): Promise<number[]> {
  const sequences: number[] = [];
  for await (const envelope of iterable) {
    sequences.push(envelope.sequence);
  }
  return sequences;
}

function hasFleetEventIterable(value: unknown): value is {
  readonly iterable: AsyncIterable<FleetEventEnvelope>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'iterable' in value &&
    typeof value.iterable === 'object' &&
    value.iterable !== null &&
    Symbol.asyncIterator in value.iterable
  );
}

describe('weft.events.subscribe operation', () => {
  it('rejects an invalid cursor if invoke receives unvalidated input', async () => {
    const fleetFeed = {
      async snapshotTailSequence() {
        throw new Error('snapshotTailSequence should not run for an invalid cursor');
      },
      subscribe() {
        throw new Error('subscribe should not run for an invalid cursor');
      },
    };

    await expect(
      fleetEventsSubscriptionOperation.invoke({
        input: { fromCursor: 'not-a-cursor' },
        principal: anonymousPrincipal(),
        engine: { fleetFeed },
        transport: 'jsonRpcWebSocket',
      }),
    ).rejects.toMatchObject({
      code: 'InvalidParams',
      message: 'Invalid cursor',
    });
  });

  it('applies filters before enforcing the replay cap', async () => {
    const fleetFeed = {
      subscribe() {
        return (async function* subscriptionEvents() {
          yield MATCHING_FLEET_EVENT;
        })();
      },
    };

    const subscription = await fleetEventsSubscriptionOperation.invoke({
      input: { workflowId: 'wf-match' },
      principal: anonymousPrincipal(),
      engine: { fleetFeed },
      transport: 'jsonRpcWebSocket',
    });

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    await expect(collectSequences(subscription.iterable)).resolves.toEqual([1005]);
  });

  it('matches every workflow status fallback and rejects events without a status', async () => {
    const subscription = await invokeFleetSubscription(
      { status: ['running', 'completed', 'failed', 'cancelled', 'timed-out', 'suspended'] },
      [
        fleetEvent(0, { kind: 'workflow:started' }),
        fleetEvent(1, { kind: 'workflow:resumed' }),
        fleetEvent(2, { kind: 'workflow:completed' }),
        fleetEvent(3, { kind: 'workflow:failed' }),
        fleetEvent(4, { kind: 'workflow:cancelled' }),
        fleetEvent(5, { kind: 'workflow:timed-out' }),
        fleetEvent(6, { kind: 'workflow:suspended' }),
        fleetEvent(7, { kind: 'worker:connected', payload: {} }),
        fleetEvent(8, { kind: 'worker:connected', payload: { status: 'running' } }),
      ],
    );

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    await expect(collectSequences(subscription.iterable)).resolves.toEqual([
      0, 1, 2, 3, 4, 5, 6, 8,
    ]);
  });

  it('enforces the replay cap from the actual subscription iterable', async () => {
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    for (let sequence = 0; sequence <= 1000; sequence += 1) {
      await fleetFeed.append({
        kind: 'workflow:completed',
        workflowId: 'wf-match',
        emittedAtMs: sequence,
        payload: { workflowId: 'wf-match' },
      });
    }

    const subscription = await fleetEventsSubscriptionOperation.invoke({
      input: { workflowId: 'wf-match' },
      principal: anonymousPrincipal(),
      engine: { fleetFeed },
      transport: 'jsonRpcWebSocket',
    });

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    await expect(collectSequences(subscription.iterable)).rejects.toMatchObject({
      code: 'InvalidParams',
      message:
        'Fleet event replay window is 1001 matching events; maximum is 1000. Supply a more recent fromCursor.',
    });
    await subscription.close();
  });

  it('filters fleet events by type, failure category, tags, and attributes', async () => {
    const input: FleetEventsSubscriptionInput = {
      status: 'running',
      type: 'invoice',
      failureCategory: ['application', 'timeout'],
      tags: ['urgent', 'vip'],
      attributes: [
        { key: 'priority', value: ['high', 'critical'] },
        { key: 'choices', value: 'gold' },
        { key: 'score', gt: 10, gte: 15, lt: 20, lte: 15 },
        { key: 'stage', value: 'beta' },
      ],
    };
    const events = [
      fleetEvent(10, { kind: 'workflow:completed' }),
      fleetEvent(11, { payload: 'not-an-object' }),
      fleetEvent(12, { payload: { workflowType: 'other' } }),
      fleetEvent(13, { payload: { type: 'invoice', failureCategory: 'system' } }),
      fleetEvent(14, {
        payload: { type: 'invoice', failureCategory: 'application', tags: 'urgent' },
      }),
      fleetEvent(15, {
        payload: { type: 'invoice', failureCategory: 'application', tags: ['urgent'] },
      }),
      fleetEvent(16, {
        payload: { type: 'invoice', failureCategory: 'application', tags: ['urgent', 'vip'] },
      }),
      fleetEvent(17, {
        payload: {
          type: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip'],
          attributes: { priority: 'low', choices: ['gold'], score: 15, stage: 'beta' },
        },
      }),
      fleetEvent(18, {
        payload: {
          type: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip'],
          attributes: { priority: 'critical', choices: ['gold'], score: 5, stage: 'beta' },
        },
      }),
      fleetEvent(19, {
        payload: {
          type: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip'],
          attributes: { priority: 'critical', choices: ['gold'], score: 14, stage: 'beta' },
        },
      }),
      fleetEvent(20, {
        payload: {
          type: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip'],
          attributes: { priority: 'critical', choices: ['gold'], score: 20, stage: 'beta' },
        },
      }),
      fleetEvent(21, {
        payload: {
          type: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip'],
          attributes: { priority: 'critical', choices: ['gold'], score: 16, stage: 'beta' },
        },
      }),
      fleetEvent(22, {
        payload: {
          type: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip'],
          attributes: { priority: 'critical', choices: ['gold'], score: '15', stage: 'beta' },
        },
      }),
      fleetEvent(23, {
        payload: {
          type: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip'],
          attributes: { priority: 'critical', choices: ['gold'], score: true, stage: 'beta' },
        },
      }),
      fleetEvent(24, {
        payload: {
          workflowType: 'invoice',
          failureCategory: 'application',
          tags: ['urgent', 'vip', 42],
          attributes: {
            priority: 'critical',
            choices: ['gold', 'silver'],
            score: 15,
            stage: 'beta',
          },
        },
      }),
      fleetEvent(25, {
        payload: {
          type: 'invoice',
          failureCategory: 'timeout',
          tags: ['urgent', 'vip'],
          changes: {
            priority: 'high',
            choices: ['gold'],
            score: 15,
            stage: 'beta',
          },
        },
      }),
    ];

    const subscription = await invokeFleetSubscription(input, events, events);

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    await expect(collectSequences(subscription.iterable)).resolves.toEqual([24, 25]);
  });

  it('matches a scalar failure-category filter', async () => {
    const subscription = await invokeFleetSubscription(
      { failureCategory: 'application' },
      [
        fleetEvent(30, { payload: { failureCategory: 'timeout' } }),
        fleetEvent(31, { payload: { failureCategory: 'application' } }),
      ],
      [
        fleetEvent(30, { payload: { failureCategory: 'timeout' } }),
        fleetEvent(31, { payload: { failureCategory: 'application' } }),
      ],
    );

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    await expect(collectSequences(subscription.iterable)).resolves.toEqual([31]);
  });
});
