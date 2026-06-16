import { z } from 'zod';

import type { FleetEventEnvelope, FleetEventFeed } from '../fleet-event-feed.ts';
import { defineOperation } from '../operation-registry.ts';
import type { Cursor, FeedEventKind } from '../workflow-event-feed.ts';

const INITIAL_SUBSCRIPTION_CURSOR: Cursor = '-1';

const fleetEventsSubscriptionInput = z.object({
  workflowId: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  fromCursor: z.string().optional(),
});

const fleetEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

export type FleetEventsSubscriptionInput = z.infer<typeof fleetEventsSubscriptionInput>;
export type FleetEventsSubscriptionEnvelope = z.infer<typeof fleetEventsSubscriptionEnvelope>;

export const fleetEventsSubscriptionOperation = defineOperation<
  FleetEventsSubscriptionInput,
  FleetEventsSubscriptionEnvelope
>({
  name: 'weft.events.subscribe',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Subscribe to fleet-wide events with replay-from-cursor',
  description:
    'Subscribes to the server-level event feed across workflows. Optional filters narrow delivery by workflow id or event kind after the single fleet cursor has been applied.',
  destructive: false,
  tags: ['Events'],
  inputSchema: fleetEventsSubscriptionInput,
  outputSchema: fleetEventsSubscriptionEnvelope,
  eventSchema: z.object({
    kind: z.string(),
    workflowId: z.string().optional(),
    sequence: z.number(),
    cursor: z.string(),
    emittedAtMs: z.number(),
    payload: z.unknown(),
  }),
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['events:read'] },
  },
  discoverable: true,
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => {
    const fleetFeed = (engine as { fleetFeed: FleetEventFeed }).fleetFeed;
    const controller = new AbortController();
    const startingCursor = input.fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;
    const iterable = filterFleetEvents(
      fleetFeed.subscribe({
        ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
        signal: controller.signal,
      }),
      input,
    );

    return {
      envelope: { subscriptionId: `sub_${crypto.randomUUID()}`, cursor: startingCursor },
      iterable,
      close: async () => {
        controller.abort();
      },
    };
  },
});

async function* filterFleetEvents(
  iterable: AsyncIterable<FleetEventEnvelope>,
  input: FleetEventsSubscriptionInput,
): AsyncIterable<FleetEventEnvelope> {
  const kind = input.kind as FeedEventKind | undefined;
  for await (const envelope of iterable) {
    if (input.workflowId !== undefined && envelope.workflowId !== input.workflowId) continue;
    if (kind !== undefined && envelope.kind !== kind) continue;
    yield envelope;
  }
}
