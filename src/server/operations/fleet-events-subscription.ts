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

const workflowStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'suspended',
]);
const failureCategorySchema = z.enum([
  'application',
  'timeout',
  'cancellation',
  'resource',
  'system',
]);
const comparableAttributeValueSchema = z.union([z.string(), z.number()]);
const attributeFilterSchema = z.object({
  key: z.string().min(1),
  value: z.unknown().optional(),
  gt: comparableAttributeValueSchema.optional(),
  gte: comparableAttributeValueSchema.optional(),
  lt: comparableAttributeValueSchema.optional(),
  lte: comparableAttributeValueSchema.optional(),
});
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
  status: z.union([workflowStatusSchema, z.array(workflowStatusSchema).nonempty()]).optional(),
  type: z.string().min(1).optional(),
  failureCategory: z
    .union([failureCategorySchema, z.array(failureCategorySchema).nonempty()])
    .optional(),
  tags: z.array(z.string().min(1)).optional(),
  attributes: z.array(attributeFilterSchema).optional(),
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
    'Subscribes to the server-level event feed across workflows. Optional filters narrow delivery by workflow id, event kind, status, workflow type, failure category, tags, or attributes after the single fleet cursor has been applied. Historical replay is capped at 1,000 matching retained events per subscription; use a recent fromCursor for older feeds.',
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
    const startingCursor = input.fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;
    if (decodeCursor(startingCursor) === null) {
      raiseFault(fleetEventsSubscriptionOperation, invalidParamsFault('Invalid cursor'));
    }
    const fleetFeed = getFleetEventFeed(engine, transport);
    const controller = new AbortController();
    await assertFilteredReplayWithinLimit(fleetFeed, input, startingCursor);
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
    if (!matchesFleetEventFilter(envelope, input)) continue;
    yield envelope;
  }
}

async function assertFilteredReplayWithinLimit(
  fleetFeed: Pick<FleetEventFeed, 'replay'>,
  input: FleetEventsSubscriptionInput,
  fromCursor: Cursor,
): Promise<void> {
  let replayWindowSize = 0;
  for await (const envelope of fleetFeed.replay({ fromCursor })) {
    if (!matchesFleetEventFilter(envelope, input)) continue;
    replayWindowSize += 1;
    if (replayWindowSize > MAX_FLEET_SUBSCRIPTION_REPLAY_EVENTS) {
      raiseFault(
        fleetEventsSubscriptionOperation,
        invalidParamsFault(
          `Fleet event replay window is ${replayWindowSize} matching events; maximum is ${MAX_FLEET_SUBSCRIPTION_REPLAY_EVENTS}. Supply a more recent fromCursor.`,
        ),
      );
    }
  }
}

function matchesFleetEventFilter(
  envelope: FleetEventEnvelope,
  input: FleetEventsSubscriptionInput,
): boolean {
  if (!matchesWorkflowIdFilter(envelope, input.workflowId)) return false;
  if (!matchesKindFilter(envelope, input.kind)) return false;

  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  if (!matchesStatusFilter(envelope, payload, input.status)) return false;
  if (!matchesTypeFilter(payload, input.type)) return false;
  if (!matchesFailureCategoryFilter(payload, input.failureCategory)) return false;
  if (!matchesTagsFilter(payload, input.tags)) return false;
  if (!matchesAttributesFilter(payload, input.attributes)) return false;

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

function matchesStatusFilter(
  envelope: FleetEventEnvelope,
  payload: Record<string, unknown>,
  status: FleetEventsSubscriptionInput['status'],
): boolean {
  if (status === undefined) return true;
  return matchesOneOf(status, statusForEvent(envelope, payload));
}

function matchesTypeFilter(
  payload: Record<string, unknown>,
  workflowType: string | undefined,
): boolean {
  if (workflowType === undefined) return true;
  return workflowTypeForPayload(payload) === workflowType;
}

function matchesFailureCategoryFilter(
  payload: Record<string, unknown>,
  failureCategory: FleetEventsSubscriptionInput['failureCategory'],
): boolean {
  if (failureCategory === undefined) return true;
  return matchesOneOf(failureCategory, stringField(payload, 'failureCategory'));
}

function matchesTagsFilter(
  payload: Record<string, unknown>,
  tags: readonly string[] | undefined,
): boolean {
  if (tags === undefined) return true;
  return matchesTags(payload, tags);
}

function matchesAttributesFilter(
  payload: Record<string, unknown>,
  filters: FleetEventsSubscriptionInput['attributes'],
): boolean {
  if (filters === undefined) return true;
  return matchesAttributes(payload, filters);
}

function statusForEvent(
  envelope: FleetEventEnvelope,
  payload: Record<string, unknown>,
): string | undefined {
  const explicitStatus = stringField(payload, 'status');
  if (explicitStatus !== undefined) return explicitStatus;

  switch (envelope.kind) {
    case 'workflow:started':
    case 'workflow:resumed':
      return 'running';
    case 'workflow:completed':
      return 'completed';
    case 'workflow:failed':
      return 'failed';
    case 'workflow:cancelled':
      return 'cancelled';
    case 'workflow:timed-out':
      return 'timed-out';
    case 'workflow:suspended':
      return 'suspended';
    default:
      return undefined;
  }
}

function workflowTypeForPayload(payload: Record<string, unknown>): string | undefined {
  return stringField(payload, 'workflowType') ?? stringField(payload, 'type');
}

function matchesOneOf<T extends string>(
  filter: T | readonly T[],
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  return Array.isArray(filter) ? filter.includes(value as T) : filter === value;
}

function matchesTags(payload: Record<string, unknown>, tags: readonly string[]): boolean {
  const payloadTags = payload['tags'];
  if (!Array.isArray(payloadTags)) return false;
  const tagSet = new Set(payloadTags.filter((tag): tag is string => typeof tag === 'string'));
  return tags.every((tag) => tagSet.has(tag));
}

function matchesAttributes(
  payload: Record<string, unknown>,
  filters: readonly z.infer<typeof attributeFilterSchema>[],
): boolean {
  const attributes = attributesForPayload(payload);
  if (attributes === null) return false;
  return filters.every((filter) => matchesAttributeFilter(attributes[filter.key], filter));
}

function attributesForPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const attributes = payload['attributes'];
  if (isRecord(attributes)) return attributes;
  const changes = payload['changes'];
  if (isRecord(changes)) return changes;
  return null;
}

function matchesAttributeFilter(
  value: unknown,
  filter: z.infer<typeof attributeFilterSchema>,
): boolean {
  if (!matchesExpectedAttributeValue(value, filter)) return false;
  if (!matchesAttributeBoundary(value, filter.gt, '>')) return false;
  if (!matchesAttributeBoundary(value, filter.gte, '>=')) return false;
  if (!matchesAttributeBoundary(value, filter.lt, '<')) return false;
  if (!matchesAttributeBoundary(value, filter.lte, '<=')) return false;
  return true;
}

function matchesExpectedAttributeValue(
  value: unknown,
  filter: z.infer<typeof attributeFilterSchema>,
): boolean {
  if (!Object.hasOwn(filter, 'value')) return true;
  return matchesAttributeValue(value, filter.value);
}

function matchesAttributeBoundary(
  value: unknown,
  boundary: string | number | undefined,
  operator: '>' | '>=' | '<' | '<=',
): boolean {
  if (boundary === undefined) return true;
  return compareAttributeValue(value, boundary, operator);
}

function matchesAttributeValue(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((candidate) => matchesAttributeValue(value, candidate));
  }
  if (Array.isArray(value)) {
    return value.some((candidate) => matchesAttributeValue(candidate, expected));
  }
  return Object.is(value, expected);
}

function compareAttributeValue(
  value: unknown,
  boundary: string | number,
  operator: '>' | '>=' | '<' | '<=',
): boolean {
  if (typeof value !== typeof boundary) return false;
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  switch (operator) {
    case '>':
      return value > boundary;
    case '>=':
      return value >= boundary;
    case '<':
      return value < boundary;
    case '<=':
      return value <= boundary;
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getFleetEventFeed(
  engine: unknown,
  transport: TransportKind,
): Pick<FleetEventFeed, 'replay' | 'subscribe'> {
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
): value is Pick<FleetEventFeed, 'replay' | 'subscribe'> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['replay'] === 'function' && typeof record['subscribe'] === 'function';
}
