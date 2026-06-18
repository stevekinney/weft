import { z } from 'zod';

import type { AuthorizationScope } from '../authorization-scope.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import { isAuthenticated } from '../principal.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import type { WorkflowStreamConnectionLease } from '../runtime/websocket-stream.ts';
import {
  decodeCursor,
  type Cursor,
  type EventEnvelope,
  type EventSelector,
  type ReplayLiveSubscribeOptions,
  type WorkflowEventFeed,
} from '../workflow-event-feed.ts';
import { invalidParamsFault, jsonErrorResponse } from './operation-helpers.ts';
import {
  createEventEnvelopeSSEStream,
  readServerSentEventsCursor,
  requireServerSentEventsAccept,
  shapeServerSentEventsFault,
  SSE_RESPONSE_HEADERS,
} from './sse-stream.ts';

export type WorkflowStreamConnectionAcquirer = (
  workflowId: string,
) => WorkflowStreamConnectionLease | null;

export type EventStreamOperationContext = {
  readonly workflowEventFeed?: WorkflowEventFeed;
  readonly acquireWorkflowStreamConnection?: WorkflowStreamConnectionAcquirer;
};

type WorkflowEventsSseOutput = AsyncIterable<EventEnvelope>;
type ClosableWorkflowEventsIterable = AsyncIterable<EventEnvelope> & {
  close(): Promise<void>;
};
type ReplayAwareWorkflowEventsIterable = ClosableWorkflowEventsIterable & {
  readonly replayComplete: Promise<void>;
};

const INITIAL_CURSOR: Cursor = '-1';
const MAX_WORKFLOW_SSE_REPLAY_EVENTS = 1_000;
const MAXIMUM_WORKFLOW_STREAMS_MESSAGE = 'maximum stream connections per workflow exceeded';

const cursorSchema = z.string().refine((cursor) => decodeCursor(cursor) !== null, {
  message: 'Invalid cursor',
});

const workflowEventsSseInputSchema = z.object({
  workflowId: z.string().min(1),
  selector: z.enum(['events', 'tokens']).default('events'),
  fromCursor: cursorSchema.optional(),
  lastEventId: cursorSchema.optional(),
});

type WorkflowEventsSseInput = z.infer<typeof workflowEventsSseInputSchema>;

const workflowEventsSseOutputSchema: z.ZodType<WorkflowEventsSseOutput> =
  z.custom<WorkflowEventsSseOutput>(
    isAsyncIterable,
    'Expected async iterable workflow event stream',
  );

const workflowEventEnvelopeSchema: z.ZodType<EventEnvelope> = z.object({
  kind: z.string(),
  workflowId: z.string(),
  selector: z.enum(['events', 'tokens']),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.unknown(),
});

export const workflowEventsSseOperation = defineOperation<
  WorkflowEventsSseInput,
  WorkflowEventsSseOutput,
  EventEnvelope
>({
  name: 'weft.workflows.events.sse',
  mcpExposable: false,
  kind: 'stream',
  summary: 'Stream workflow events as Server-Sent Events',
  description:
    '`selector: "events"` requires `events:read`; `selector: "tokens"` requires `streams:read`. The stream replays from `fromCursor` or `Last-Event-ID`, then remains open for live events and `ping` keepalives.',
  destructive: false,
  tags: ['Events'],
  inputSchema: workflowEventsSseInputSchema,
  outputSchema: workflowEventsSseOutputSchema,
  eventSchema: workflowEventEnvelopeSchema,
  parameterizedAccess: {
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
  },
  producibleFaults: ['InvalidParams', 'UnsupportedTransport'],
  access: { kind: 'authenticated' },
  authorize: async ({ input, principal }) => {
    const requiredScope = workflowSseScope(input.selector);
    if (!isAuthenticated(principal)) {
      return { allowed: false, classification: 'unauthorized', reason: 'authentication required' };
    }
    if (principal.hasScope(requiredScope)) return { allowed: true };
    return {
      allowed: false,
      classification: 'forbidden',
      reason: `requires scope: ${requiredScope}`,
    };
  },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => {
    return createWorkflowEventsIterable(input, eventStreamOperationContext(engine));
  },
});

function workflowSseScope(selector: EventSelector): AuthorizationScope {
  return selector === 'tokens' ? 'streams:read' : 'events:read';
}

function eventStreamOperationContext(engine: unknown): EventStreamOperationContext {
  if (typeof engine !== 'object' || engine === null) return {};
  const record = engine as EventStreamOperationContext;
  return record;
}

function unsupportedEventStreamContextFault(message: string): OperationFault {
  return {
    code: 'UnsupportedTransport',
    message,
    data: { transport: 'http-rest', supported: ['http-rest'] },
  };
}

function maximumWorkflowStreamsFault(): OperationFault {
  return invalidParamsFault(MAXIMUM_WORKFLOW_STREAMS_MESSAGE);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<EventEnvelope> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { [Symbol.asyncIterator]?: unknown };
  return typeof candidate[Symbol.asyncIterator] === 'function';
}

function isClosableWorkflowEventsIterable(
  value: AsyncIterable<EventEnvelope>,
): value is ClosableWorkflowEventsIterable {
  return 'close' in value && typeof value.close === 'function';
}

function isReplayAwareWorkflowEventsIterable(
  value: AsyncIterable<EventEnvelope>,
): value is ReplayAwareWorkflowEventsIterable {
  return (
    isClosableWorkflowEventsIterable(value) &&
    'replayComplete' in value &&
    value.replayComplete instanceof Promise
  );
}

function createWorkflowEventsIterable(
  input: WorkflowEventsSseInput,
  context: EventStreamOperationContext,
): ReplayAwareWorkflowEventsIterable {
  const feed = context.workflowEventFeed;
  if (feed === undefined) {
    throw unsupportedEventStreamContextFault('workflow event SSE requires a workflow event feed');
  }

  const lease = context.acquireWorkflowStreamConnection?.(input.workflowId);
  if (lease === null) {
    throw maximumWorkflowStreamsFault();
  }

  const controller = new AbortController();
  const replayComplete = Promise.withResolvers<void>();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    controller.abort();
    lease?.release();
  };

  const fromCursor = input.lastEventId ?? input.fromCursor ?? INITIAL_CURSOR;
  const subscribeOptions: {
    workflowId: string;
    selector: EventSelector;
  } & ReplayLiveSubscribeOptions<EventEnvelope> = {
    workflowId: input.workflowId,
    selector: input.selector,
    fromCursor,
    signal: controller.signal,
    replayLimit: MAX_WORKFLOW_SSE_REPLAY_EVENTS,
    onReplayComplete: () => replayComplete.resolve(),
    createReplayLimitError: (count, limit) =>
      invalidParamsFault(
        `Workflow event replay window is ${count} events; maximum is ${limit}. Supply a more recent fromCursor.`,
      ),
  };

  let source: AsyncIterable<EventEnvelope>;
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
    replayComplete: replayComplete.promise,
    close,
  };
}

function shapeWorkflowEventsSseSuccess(
  output: WorkflowEventsSseOutput,
  request: Request,
): Response {
  const close = isClosableWorkflowEventsIterable(output)
    ? () => output.close()
    : async () => undefined;

  return new Response(
    createEventEnvelopeSSEStream({
      iterable: output,
      close,
      ...(isReplayAwareWorkflowEventsIterable(output) ? { ready: output.replayComplete } : {}),
      signal: request.signal,
    }),
    {
      status: 200,
      headers: SSE_RESPONSE_HEADERS,
    },
  );
}

function shapeWorkflowEventsSseFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams' && fault.message === MAXIMUM_WORKFLOW_STREAMS_MESSAGE) {
    return jsonErrorResponse(fault.message, 429);
  }
  return shapeServerSentEventsFault(fault);
}

function readSelector(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get('selector');
  if (value === null) return undefined;
  return value;
}

export const workflowEventsSseRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/events/sse',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.events.sse',
  transportKind: 'sse',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    selector: { kind: 'query', queryParam: 'selector' },
    fromCursor: { kind: 'query', queryParam: 'fromCursor' },
    lastEventId: { kind: 'header', headerName: 'Last-Event-ID' },
  },
  extractInput: async (request, pathParams) => {
    requireServerSentEventsAccept(request);
    const url = new URL(request.url);
    const lastEventId = readServerSentEventsCursor(request.headers.get('Last-Event-ID'));
    const fromCursor =
      lastEventId === undefined
        ? readServerSentEventsCursor(url.searchParams.get('fromCursor'))
        : undefined;
    const selector = readSelector(request);
    return {
      workflowId: pathParams['id'] ?? '',
      ...(selector === undefined ? {} : { selector }),
      ...(fromCursor === undefined ? {} : { fromCursor }),
      ...(lastEventId === undefined ? {} : { lastEventId }),
    };
  },
  success: { kind: 'streaming', mediaType: 'text/event-stream' },
  shapeSuccess: shapeWorkflowEventsSseSuccess,
  shapeFault: shapeWorkflowEventsSseFault,
};
