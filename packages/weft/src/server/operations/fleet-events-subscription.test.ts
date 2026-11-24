import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { anonymousPrincipal } from "../../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { createFleetEventFeed, type FleetEventEnvelope } from '../fleet-event-feed.ts';
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
    subscribe(options?: {
      filterEnvelope?: (envelope: FleetEventEnvelope) => boolean;
      fromCursor?: string;
    }) {
      return (async function* subscriptionEvents() {
        const shouldDeliver = (event: FleetEventEnvelope): boolean =>
          options?.filterEnvelope?.(event) ?? true;
        const replayTail = replayEvents.reduce((tail, event) => Math.max(tail, event.sequence), -1);
        const fromCursor = Number(options?.fromCursor ?? '-1');
        for (const event of replayEvents) {
          if (event.sequence <= fromCursor) continue;
          if (shouldDeliver(event)) yield event;
        }
        for (const event of liveEvents) {
          if (event.sequence > replayTail && shouldDeliver(event)) yield event;
        }
      })();
    },
  };

  return fleetEventsSubscriptionOperation.invoke({
    input,
    principal: anonymousPrincipal(),
    host: { fleetFeed },
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
  const result: unknown = z.toJSONSchema(fleetEventsSubscriptionOperation.eventSchema, {
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

    expect(
      await rejectionOf(
        fleetEventsSubscriptionOperation.invoke({
          input: { fromCursor: 'not-a-cursor' },
          principal: anonymousPrincipal(),
          host: { fleetFeed },
          transport: 'jsonRpcWebSocket',
        }),
      ),
    ).toMatchObject({
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
      host: { fleetFeed },
      transport: 'jsonRpcWebSocket',
    });

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    expect(await collectFirstSequences(subscription.iterable, 1)).toEqual([1001]);
    await subscription.close();
  });

  it('delivers every kind in a requested set', async () => {
    // A client wanting several kinds previously had to open one subscription
    // per kind and reconcile their cursors, or take the whole fleet feed and
    // discard most of it across a socket.
    const started = fleetEvent(1, { kind: 'workflow:started' });
    const completed = fleetEvent(2, { kind: 'workflow:completed' });
    const failed = fleetEvent(3, { kind: 'workflow:failed' });
    const subscription = await invokeFleetSubscription(
      { kind: ['workflow:started', 'workflow:failed'] },
      [started, completed, failed],
    );

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    expect(await collectSequences(subscription.iterable)).toEqual([1, 3]);
    await subscription.close();
  });

  it('delivers catalog and workflow-source events, then replays them after reconnecting from a cursor', async () => {
    const events = [
      fleetEvent(0, { kind: 'catalog:revision-installed', workflowId: undefined }),
      fleetEvent(1, { kind: 'workflow-source:load-ready', workflowId: undefined }),
    ];
    const first = await invokeFleetSubscription({ fromCursor: '-1' }, events);
    expect(hasFleetEventIterable(first)).toBe(true);
    if (!hasFleetEventIterable(first)) throw new Error('expected first subscription result');
    expect(await collectSequences(first.iterable)).toEqual([0, 1]);
    await first.close();

    const reconnect = await invokeFleetSubscription({ fromCursor: '0' }, events);
    expect(hasFleetEventIterable(reconnect)).toBe(true);
    if (!hasFleetEventIterable(reconnect))
      throw new Error('expected reconnect subscription result');
    expect(await collectSequences(reconnect.iterable)).toEqual([1]);
    await reconnect.close();
  });

  it('still accepts a bare kind, unchanged for existing callers', async () => {
    const started = fleetEvent(1, { kind: 'workflow:started' });
    const completed = fleetEvent(2, { kind: 'workflow:completed' });
    const subscription = await invokeFleetSubscription({ kind: 'workflow:completed' }, [
      started,
      completed,
    ]);

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    expect(await collectSequences(subscription.iterable)).toEqual([2]);
    await subscription.close();
  });

  it('delivers retention gaps before applying workflow and kind filters', async () => {
    const gap = fleetEvent(4, {
      kind: 'fleet:gap',
      workflowId: undefined,
      payload: { requestedCursor: '0', firstRetainedSequence: 5 },
    });
    const matching = fleetEvent(5, {
      workflowId: 'wf-match',
      kind: 'workflow:completed',
    });
    const subscription = await invokeFleetSubscription(
      { workflowId: 'wf-match', kind: 'workflow:completed' },
      [gap, matching],
    );

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    expect(await collectSequences(subscription.iterable)).toEqual([4, 5]);
    await subscription.close();
  });

  it('describes the fleet event envelope for generated discovery clients', () => {
    const schema = eventSchemaJson();
    expect(schema['anyOf']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            kind: expect.objectContaining({ type: 'string' }),
            sequence: expect.objectContaining({ type: 'number' }),
            cursor: expect.objectContaining({ type: 'string' }),
            emittedAtMs: expect.objectContaining({ type: 'number' }),
            payload: {},
            workflowId: expect.objectContaining({ type: 'string' }),
          }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            kind: expect.objectContaining({ const: 'fleet:gap' }),
            payload: expect.objectContaining({
              properties: expect.objectContaining({
                requestedCursor: expect.objectContaining({ type: 'string' }),
                firstRetainedSequence: expect.objectContaining({ type: 'number' }),
              }),
            }),
          }),
        }),
      ]),
    );
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
      host: { fleetFeed },
      transport: 'jsonRpcWebSocket',
    });

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');
    expect(await rejectionOf(collectSequences(subscription.iterable))).toMatchObject({
      code: 'InvalidParams',
      message:
        'Fleet event replay window is 1001 matching events; maximum is 1000. Supply a more recent fromCursor.',
    });
    await subscription.close();
  });

  it('filters live events read from durable storage', async () => {
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    const subscription = await fleetEventsSubscriptionOperation.invoke({
      input: { workflowId: 'wf-match' },
      principal: anonymousPrincipal(),
      host: { fleetFeed },
      transport: 'jsonRpcWebSocket',
    });

    expect(hasFleetEventIterable(subscription)).toBe(true);
    if (!hasFleetEventIterable(subscription)) throw new Error('expected subscription result');

    const iterator = subscription.iterable[Symbol.asyncIterator]();
    const nextEnvelope = iterator.next();
    // load-proof: the iterator is pending on in-memory storage before this yield returns, so the append is ordered after it by microtasks, not by timing
    await new Promise<void>((resolve) => setImmediate(resolve));

    await fleetFeed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-other-1',
      emittedAtMs: 1,
      payload: { workflowId: 'wf-other-1' },
    });
    await fleetFeed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-other-2',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-other-2' },
    });
    await fleetFeed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-match',
      emittedAtMs: 3,
      payload: { workflowId: 'wf-match' },
    });

    const delivered = await nextEnvelope;
    expect(delivered.done).toBe(false);
    expect(delivered.value).toMatchObject({
      sequence: 2,
      workflowId: 'wf-match',
    });

    await iterator.return?.();
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
    expect(await collectSequences(subscription.iterable)).toEqual([22]);
  });
});
