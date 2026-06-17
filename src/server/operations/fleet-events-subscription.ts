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

const fleetEventKindSchema = z.enum(EVENTS_READ_EVENT_TYPES);
const fleetCursorSchema = z
  .string()
  .regex(/^(?:-1|\d+)$/, 'Invalid cursor')
  .refine((cursor) => decodeCursor(cursor) !== null, {
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

const fleetEventEnvelopeSchema: z.ZodType<FleetEventEnvelope> = z.object({
  kind: z.string(),
  workflowId: z.string().optional(),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.unknown(),
});

export type FleetEventsSubscriptionInput = z.infer<typeof fleetEventsSubscriptionInput>;
export type FleetEventsSubscriptionEnvelope = z.infer<typeof fleetEventsSubscriptionEnvelope>;

export const fleetEventsSubscriptionOperation = defineOperation<
  FleetEventsSubscriptionInput,
  FleetEventsSubscriptionEnvelope,
  FleetEventEnvelope
>({
  name: 'weft.events.subscribe',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Subscribe to fleet-wide events with replay-from-cursor',
  description:
    'Subscribes to the server-level event feed across workflows. Optional filters narrow delivery by workflow id or event kind after the single fleet cursor has been applied. Historical replay is capped at 1,000 matching retained events per subscription; use a recent fromCursor for older feeds.',
  destructive: false,
  tags: ['Events'],
  inputSchema: fleetEventsSubscriptionInput,
  outputSchema: fleetEventsSubscriptionEnvelope,
  producibleFaults: ['UnsupportedTransport', 'InvalidParams'],
  eventSchema: fleetEventEnvelopeSchema,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['events:read'] },
  },
  discoverable: true,
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, transport }) => {
    const startingCursor = input.fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;
    if (decodeCursor(startingCursor) === null) {
      raiseFault(fleetEventsSubscriptionOperation, invalidParamsFault('Invalid cursor'));
    }
    const fleetFeed = getFleetEventFeed(engine, transport);
    const controller = new AbortController();
    const iterable = fleetFeed.subscribe({
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      signal: controller.signal,
      replayLimit: MAX_FLEET_SUBSCRIPTION_REPLAY_EVENTS,
      filterEnvelope: (envelope) => matchesFleetEventFilter(envelope, input),
      createReplayLimitError: (count, limit) => fleetReplayLimitFault(count, limit),
    });

    return {
      envelope: { subscriptionId: `sub_${crypto.randomUUID()}`, cursor: startingCursor },
      iterable,
      close: async () => {
        controller.abort();
      },
    };
  },
});

function fleetReplayLimitFault(
  count: number,
  limit: number,
): ReturnType<typeof invalidParamsFault> {
  return invalidParamsFault(
    `Fleet event replay window is ${count} matching events; maximum is ${limit}. Supply a more recent fromCursor.`,
  );
}

function matchesFleetEventFilter(
  envelope: FleetEventEnvelope,
  input: FleetEventsSubscriptionInput,
): boolean {
  if (!matchesWorkflowIdFilter(envelope, input.workflowId)) return false;
  if (!matchesKindFilter(envelope, input.kind)) return false;
  return true;
}

function matchesWorkflowIdFilter(
  envelope: FleetEventEnvelope,
  workflowId: string | undefined,
): boolean {
  if (workflowId === undefined) return true;
  return envelope.workflowId === workflowId;
}

function matchesKindFilter(
  envelope: FleetEventEnvelope,
  kind: FleetEventsSubscriptionInput['kind'],
): boolean {
  if (kind === undefined) return true;
  return envelope.kind === kind;
}

function getFleetEventFeed(
  engine: unknown,
  transport: TransportKind,
): Pick<FleetEventFeed, 'subscribe'> {
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

function isFleetEventSubscriber(value: unknown): value is Pick<FleetEventFeed, 'subscribe'> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['subscribe'] === 'function';
}
