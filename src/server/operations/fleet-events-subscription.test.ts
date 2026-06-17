import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from '../../storage/memory.ts';
import type { FleetEventEnvelope } from '../fleet-event-feed.ts';
import { createFleetEventFeed } from '../fleet-event-feed.ts';
import { anonymousPrincipal } from '../principal.ts';
import {
  fleetEventsSubscriptionOperation,
  type FleetEventsSubscriptionInput,
} from './fleet-events-subscription.ts';

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

async function collectFirstSequences(
  iterable: AsyncIterable<FleetEventEnvelope>,
  count: number,
): Promise<number[]> {
  const sequences: number[] = [];
  for await (const envelope of iterable) {
    sequences.push(envelope.sequence);
    if (sequences.length >= count) break;
  }
  return sequences;
}

function eventSchemaJson(): Record<string, unknown> {
  const result: unknown = z.toJSONSchema(fleetEventsSubscriptionOperation.eventSchema!, {
    unrepresentable: 'any',
  });
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return {};
  const { $schema: _schema, ...rest } = result as Record<string, unknown>;
  return rest;
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

  it('applies filters before enforcing the replay cap against the real feed', async () => {
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    for (let sequence = 0; sequence <= 1000; sequence += 1) {
      await fleetFeed.append({
        kind: 'workflow:completed',
        workflowId: `wf-other-${sequence}`,
        emittedAtMs: sequence,
        payload: { workflowId: `wf-other-${sequence}` },
      });
    }
    await fleetFeed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-match',
      emittedAtMs: 1002,
      payload: { workflowId: 'wf-match', result: 'done' },
    });

    const subscription = await fleetEventsSubscriptionOperation.invoke({
      input: { workflowId: 'wf-match' },
      principal: anonymousPrincipal(),
      engine: { fleetFeed },
      transport: 'jsonRpcWebSocket',
    });

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    await expect(collectFirstSequences(subscription.iterable, 1)).resolves.toEqual([1001]);
    await subscription.close();
  });

  it('describes the fleet event envelope for generated discovery clients', () => {
    const schema = eventSchemaJson();
    const properties = schema['properties'];

    expect(schema['type']).toBe('object');
    expect(properties).toMatchObject({
      kind: expect.objectContaining({ type: 'string' }),
      sequence: expect.objectContaining({ type: 'number' }),
      cursor: expect.objectContaining({ type: 'string' }),
      emittedAtMs: expect.objectContaining({ type: 'number' }),
      payload: {},
      workflowId: expect.objectContaining({ type: 'string' }),
    });
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

  it('filters fleet events by workflow id and kind only', async () => {
    const subscription = await invokeFleetSubscription(
      { workflowId: 'wf-match', kind: 'workflow:completed' },
      [
        fleetEvent(20, { kind: 'workflow:started', workflowId: 'wf-match' }),
        fleetEvent(21, { kind: 'workflow:completed', workflowId: 'wf-other' }),
        fleetEvent(22, { kind: 'workflow:completed', workflowId: 'wf-match' }),
      ],
    );

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    await expect(collectSequences(subscription.iterable)).resolves.toEqual([22]);
  });
});
