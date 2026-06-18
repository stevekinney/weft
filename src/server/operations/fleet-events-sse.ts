import { z } from 'zod';

import type { FleetEventEnvelope, FleetEventFeed } from '../fleet-event-feed.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { EVENTS_READ_EVENT_TYPES } from '../runtime/client-visible-events.ts';
import {
  decodeCursor,
  type Cursor,
  type ReplayLiveSubscribeOptions,
} from '../workflow-event-feed.ts';
import { invalidParamsFault } from './operation-helpers.ts';
import {
  createEventEnvelopeSSEStream,
  requireServerSentEventsAccept,
  shapeServerSentEventsFault,
  SSE_RESPONSE_HEADERS,
} from './sse-stream.ts';

type FleetEventsSseOutput = AsyncIterable<FleetEventEnvelope>;
type ClosableFleetEventsIterable = AsyncIterable<FleetEventEnvelope> & {
  close(): Promise<void>;
};

type FleetEventStreamOperationContext = {
  readonly fleetEventFeed?: Pick<FleetEventFeed, 'subscribe'>;
};

const INITIAL_CURSOR: Cursor = '-1';
const MAX_FLEET_SSE_REPLAY_EVENTS = 1_000;

const cursorSchema = z.string().refine((cursor) => decodeCursor(cursor) !== null, {
  message: 'Invalid cursor',
});
const fleetEventKindSchema = z.enum(EVENTS_READ_EVENT_TYPES);

const fleetEventsSseInputSchema = z.object({
  workflowId: z.string().min(1).optional(),
  kind: fleetEventKindSchema.optional(),
  fromCursor: cursorSchema.optional(),
  lastEventId: cursorSchema.optional(),
});

type FleetEventsSseInput = z.infer<typeof fleetEventsSseInputSchema>;

const fleetEventsSseOutputSchema: z.ZodType<FleetEventsSseOutput> = z.custom<FleetEventsSseOutput>(
  isAsyncIterable,
  'Expected async iterable fleet event stream',
);

const fleetEventEnvelopeSchema: z.ZodType<FleetEventEnvelope> = z.object({
  kind: z.string(),
  workflowId: z.string().optional(),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.unknown(),
});

export const fleetEventsSseOperation = defineOperation<
  FleetEventsSseInput,
  FleetEventsSseOutput,
  FleetEventEnvelope
>({
  name: 'weft.events.sse',
  mcpExposable: false,
  kind: 'stream',
  summary: 'Stream fleet events as Server-Sent Events',
  description:
    'Streams the server-level event feed across workflows. Optional filters narrow delivery by workflow id or event kind after the single fleet cursor has been applied. The stream emits `ping` keepalives while idle.',
  destructive: false,
  tags: ['Events'],
  inputSchema: fleetEventsSseInputSchema,
  outputSchema: fleetEventsSseOutputSchema,
  eventSchema: fleetEventEnvelopeSchema,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['events:read'] },
  },
  producibleFaults: ['InvalidParams', 'UnsupportedTransport'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => {
    return createFleetEventsIterable(input, fleetEventStreamOperationContext(engine));
  },
});

function fleetEventStreamOperationContext(engine: unknown): FleetEventStreamOperationContext {
  if (typeof engine !== 'object' || engine === null) return {};
  return engine as FleetEventStreamOperationContext;
}

function unsupportedEventStreamContextFault(message: string): OperationFault {
  return {
    code: 'UnsupportedTransport',
    message,
    data: { transport: 'http-rest', supported: ['http-rest'] },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<FleetEventEnvelope> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { [Symbol.asyncIterator]?: unknown };
  return typeof candidate[Symbol.asyncIterator] === 'function';
}

function isClosableFleetEventsIterable(
  value: AsyncIterable<FleetEventEnvelope>,
): value is ClosableFleetEventsIterable {
  return 'close' in value && typeof value.close === 'function';
}

function matchesFleetEventFilter(
  envelope: FleetEventEnvelope,
  input: FleetEventsSseInput,
): boolean {
  if (input.workflowId !== undefined && envelope.workflowId !== input.workflowId) return false;
  if (input.kind !== undefined && envelope.kind !== input.kind) return false;
  return true;
}

function createFleetEventsIterable(
  input: FleetEventsSseInput,
  context: FleetEventStreamOperationContext,
): ClosableFleetEventsIterable {
  const feed = context.fleetEventFeed;
  if (feed === undefined) {
    throw unsupportedEventStreamContextFault('fleet event SSE requires a fleet event feed');
  }

  const controller = new AbortController();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    controller.abort();
  };

  const fromCursor = input.lastEventId ?? input.fromCursor ?? INITIAL_CURSOR;
  const subscribeOptions: ReplayLiveSubscribeOptions<FleetEventEnvelope> = {
    fromCursor,
    signal: controller.signal,
    replayLimit: MAX_FLEET_SSE_REPLAY_EVENTS,
    filterEnvelope: (envelope) => matchesFleetEventFilter(envelope, input),
    createReplayLimitError: (count, limit) =>
      invalidParamsFault(
        `Fleet event replay window is ${count} matching events; maximum is ${limit}. Supply a more recent fromCursor.`,
      ),
  };

  let source: AsyncIterable<FleetEventEnvelope>;
  try {
    source = feed.subscribe(subscribeOptions);
  } catch (error) {
    void close();
    throw error;
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const envelope of source) yield envelope;
      } finally {
        await close();
      }
    },
    close,
  };
}

function shapeFleetEventsSseSuccess(output: FleetEventsSseOutput, request: Request): Response {
  const close = isClosableFleetEventsIterable(output)
    ? () => output.close()
    : async () => undefined;

  return new Response(
    createEventEnvelopeSSEStream({
      iterable: output,
      close,
      signal: request.signal,
    }),
    {
      status: 200,
      headers: SSE_RESPONSE_HEADERS,
    },
  );
}

function shapeFleetEventsSseFault(fault: OperationFault): Response {
  return shapeServerSentEventsFault(fault);
}

function readCursor(value: string | null): Cursor | undefined {
  if (value === null) return undefined;
  if (decodeCursor(value) === null) throw invalidParamsFault('Invalid cursor');
  return value;
}

export const fleetEventsSseRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/events/sse',
  pathParamNames: [],
  operationName: 'weft.events.sse',
  transportKind: 'sse',
  inputSources: {
    workflowId: { kind: 'query', queryParam: 'workflowId' },
    kind: { kind: 'query', queryParam: 'kind' },
    fromCursor: { kind: 'query', queryParam: 'fromCursor' },
    lastEventId: { kind: 'header', headerName: 'Last-Event-ID' },
  },
  extractInput: async (request) => {
    requireServerSentEventsAccept(request);
    const url = new URL(request.url);
    const workflowId = url.searchParams.get('workflowId') ?? undefined;
    const kind = url.searchParams.get('kind') ?? undefined;
    const lastEventId = readCursor(request.headers.get('Last-Event-ID'));
    const fromCursor =
      lastEventId === undefined ? readCursor(url.searchParams.get('fromCursor')) : undefined;
    return {
      ...(workflowId === undefined ? {} : { workflowId }),
      ...(kind === undefined ? {} : { kind }),
      ...(fromCursor === undefined ? {} : { fromCursor }),
      ...(lastEventId === undefined ? {} : { lastEventId }),
    };
  },
  success: { kind: 'streaming', mediaType: 'text/event-stream' },
  shapeSuccess: shapeFleetEventsSseSuccess,
  shapeFault: shapeFleetEventsSseFault,
};
