import { z } from 'zod';

import {
  createReplayAwareClosableIterable,
  decodeCursor,
  defineOperation,
  type AuthorizationScope,
  type Cursor,
  type OperationFault,
  type ReplayAwareClosableIterable,
  type ReplayLiveSubscribeOptions,
} from "../../embedded/backchannel/src/index.ts";
import {
  createEventEnvelopeSSEStream,
  invalidParamsFault,
  isAuthenticated,
  isClosableAsyncIterable,
  isReplayAwareClosableIterable,
  readServerSentEventsCursor,
  requireServerSentEventsAccept,
  shapeServerSentEventsFault,
  SSE_RESPONSE_HEADERS,
  type ConnectionLease,
  type EventSelector,
  type UnknownRestBinding,
} from "../../embedded/backchannel/src/internals.ts";
import type { WorkflowStreamConnectionLease } from '../runtime/websocket-stream.ts';
import { weftFaultPolicy } from '../weft-fault-policy.ts';
import { type EventEnvelope, type WorkflowEventFeed } from '../workflow-event-feed.ts';
import {
  workflowEventEnvelopeSchema,
  workflowEventParameterizedAccess,
} from './event-stream-contracts.ts';
import { shapeRestFault } from './operation-helpers.ts';

export type WorkflowStreamConnectionAcquirer = (
  workflowId: string,
) => WorkflowStreamConnectionLease | null;

export type EventStreamOperationContext = {
  readonly workflowEventFeed?: WorkflowEventFeed;
  readonly acquireWorkflowStreamConnection?: WorkflowStreamConnectionAcquirer;
  readonly acquireWorkflowEventSubscriber?: () => ConnectionLease;
};

type WorkflowEventsSseOutput = AsyncIterable<EventEnvelope>;
type ReplayAwareWorkflowEventsOutput = ReplayAwareClosableIterable<EventEnvelope>;

const INITIAL_CURSOR: Cursor = '-1';
const MAX_WORKFLOW_SSE_REPLAY_EVENTS = 1_000;
const MAXIMUM_WORKFLOW_STREAMS_MESSAGE = 'maximum stream connections per workflow exceeded';

const cursorSchema = z.string().refine((cursor) => decodeCursor(cursor) !== null, {
  message: 'Invalid cursor',
});

const workflowEventsSseInputSchema = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose events are streamed.'),
  selector: z
    .enum(['events', 'tokens'])
    .default('events')
    .describe(
      'What to stream: "events" for workflow events (default) or "tokens" for the workflow\'s token stream.',
    ),
  fromCursor: cursorSchema
    .optional()
    .describe(
      'Resume after this cursor, as returned with an earlier event. Omit it to start from the beginning.',
    ),
  lastEventId: cursorSchema
    .optional()
    .describe(
      'Cursor of the last event the client received, as sent in the Last-Event-ID header on an SSE reconnect. It takes precedence over fromCursor when both are given.',
    ),
});

type WorkflowEventsSseInput = z.infer<typeof workflowEventsSseInputSchema>;

const workflowEventsSseOutputSchema: z.ZodType<WorkflowEventsSseOutput> =
  z.custom<WorkflowEventsSseOutput>(
    isAsyncIterable,
    'Expected async iterable workflow event stream',
  );

export const workflowEventsSseOperation = defineOperation({
  name: 'weft.workflows.events.sse',
  mcpExposable: false,
  kind: 'stream',
  summary: 'Stream workflow events as Server-Sent Events',
  description:
    '`selector: "events"` requires `events:read` and streams the lifecycle events the `/watch` WebSocket delivers, with the same order and cursors under `serve()`; `selector: "tokens"` requires `streams:read`. The stream replays from `fromCursor` or `Last-Event-ID`, then remains open for live events and `ping` keepalives.',
  destructive: false,
  tags: ['Events'],
  inputSchema: workflowEventsSseInputSchema,
  outputSchema: workflowEventsSseOutputSchema,
  eventSchema: workflowEventEnvelopeSchema,
  parameterizedAccess: workflowEventParameterizedAccess,
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
  invoke: async ({ input, host: engine }) => {
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

function createWorkflowEventsIterable(
  input: WorkflowEventsSseInput,
  context: EventStreamOperationContext,
): ReplayAwareWorkflowEventsOutput {
  const feed = context.workflowEventFeed;
  if (feed === undefined) {
    throw unsupportedEventStreamContextFault('workflow event SSE requires a workflow event feed');
  }

  const lease = context.acquireWorkflowStreamConnection?.(input.workflowId);
  if (lease === null) {
    throw maximumWorkflowStreamsFault();
  }

  const fromCursor = input.lastEventId ?? input.fromCursor ?? INITIAL_CURSOR;
  const controller = new AbortController();
  const subscriberLease = context.acquireWorkflowEventSubscriber?.();
  return createReplayAwareClosableIterable(
    (onReplayComplete) => {
      const subscribeOptions: {
        workflowId: string;
        selector: EventSelector;
      } & ReplayLiveSubscribeOptions<EventEnvelope> = {
        workflowId: input.workflowId,
        selector: input.selector,
        fromCursor,
        signal: controller.signal,
        replayLimit: MAX_WORKFLOW_SSE_REPLAY_EVENTS,
        onReplayComplete,
        createReplayLimitError: (count, limit) =>
          invalidParamsFault(
            `Workflow event replay window is ${count} events; maximum is ${limit}. Supply a more recent fromCursor.`,
          ),
      };
      return feed.subscribe(subscribeOptions);
    },
    {
      close: () => {
        controller.abort();
        subscriberLease?.release();
        lease?.release();
      },
    },
  );
}

function shapeWorkflowEventsSseSuccess(
  output: WorkflowEventsSseOutput,
  request: Request,
): Response {
  const close = isClosableAsyncIterable<EventEnvelope>(output)
    ? () => output.close()
    : async () => undefined;

  return new Response(
    createEventEnvelopeSSEStream({
      iterable: output,
      close,
      ...(isReplayAwareClosableIterable<EventEnvelope>(output)
        ? { ready: output.replayComplete }
        : {}),
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
    return shapeRestFault(fault, { status: 429 });
  }
  return shapeServerSentEventsFault(fault, weftFaultPolicy);
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
