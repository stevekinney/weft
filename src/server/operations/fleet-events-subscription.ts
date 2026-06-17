import { z } from 'zod';

import type { FleetEventEnvelope, FleetEventFeed } from '../fleet-event-feed.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import type { TransportKind } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import { EVENTS_READ_EVENT_TYPES } from '../runtime/client-visible-events.ts';
import { decodeCursor, type Cursor } from '../workflow-event-feed.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const INITIAL_SUBSCRIPTION_CURSOR: Cursor = '-1';
const MAX_FLEET_SUBSCRIPTION_REPLAY_EVENTS = 1_000;

const fleetEventKindSet = new Set<string>(EVENTS_READ_EVENT_TYPES);
const fleetEventKindSchema = z
  .string()
  .min(1)
  .refine((kind) => fleetEventKindSet.has(kind), {
    message: 'Unsupported fleet event kind',
  });
const fleetCursorSchema = z.string().refine((cursor) => decodeCursor(cursor) !== null, {
  message: 'Invalid cursor',
});

const fleetEventsSubscriptionInput = z.object({
  workflowId: z.string().min(1).optional(),
  kind: fleetEventKindSchema.optional(),
  fromCursor: fleetCursorSchema.optional(),
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
    'Subscribes to the server-level event feed across workflows. Optional filters narrow delivery by workflow id or event kind after the single fleet cursor has been applied. Historical replay is capped at 1,000 retained events per subscription; use a recent fromCursor for older feeds.',
  destructive: false,
  tags: ['Events'],
  inputSchema: fleetEventsSubscriptionInput,
  outputSchema: fleetEventsSubscriptionEnvelope,
  producibleFaults: ['UnsupportedTransport'],
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
  invoke: async ({ input, engine, transport }) => {
    const fleetFeed = getFleetEventFeed(engine, transport);
    const controller = new AbortController();
    const startingCursor = input.fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;
    const afterSequence = decodeCursor(startingCursor);
    if (afterSequence === null) {
      raiseFault(fleetEventsSubscriptionOperation, invalidParamsFault('Invalid cursor'));
    }
    const tailSequence = await fleetFeed.snapshotTailSequence();
    const replayWindowSize = Math.max(0, tailSequence - afterSequence);
    if (replayWindowSize > MAX_FLEET_SUBSCRIPTION_REPLAY_EVENTS) {
      raiseFault(
        fleetEventsSubscriptionOperation,
        invalidParamsFault(
          `Fleet event replay window is ${replayWindowSize} events; maximum is ${MAX_FLEET_SUBSCRIPTION_REPLAY_EVENTS}. Supply a more recent fromCursor.`,
        ),
      );
    }
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
  for await (const envelope of iterable) {
    if (input.workflowId !== undefined && envelope.workflowId !== input.workflowId) continue;
    if (input.kind !== undefined && envelope.kind !== input.kind) continue;
    yield envelope;
  }
}

function getFleetEventFeed(
  engine: unknown,
  transport: TransportKind,
): Pick<FleetEventFeed, 'snapshotTailSequence' | 'subscribe'> {
  if (typeof engine === 'object' && engine !== null && 'fleetFeed' in engine) {
    const fleetFeed = engine.fleetFeed;
    if (isFleetEventSubscriber(fleetFeed)) return fleetFeed;
  }

  raiseFault(fleetEventsSubscriptionOperation, {
    code: 'UnsupportedTransport',
    message: 'Fleet event subscription requires a WebSocket fleet event feed',
    data: { transport, supported: ['jsonRpcWebSocket'] },
  });
}

function isFleetEventSubscriber(
  value: unknown,
): value is Pick<FleetEventFeed, 'snapshotTailSequence' | 'subscribe'> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['snapshotTailSequence'] === 'function' &&
    typeof record['subscribe'] === 'function'
  );
}
