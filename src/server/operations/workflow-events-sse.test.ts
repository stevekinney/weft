import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest, type HandlerOptions } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import {
  createWorkflowEventFeed,
  type EventEnvelope,
  type EventSelector,
  type ReplayLiveSubscribeOptions,
  type WorkflowEventFeed,
} from '../workflow-event-feed.ts';
import { workflowEventsSseOperation, workflowEventsSseRestBinding } from './workflow-events-sse.ts';

const registry = createOperationRegistry([workflowEventsSseOperation]);
const bindings = [workflowEventsSseRestBinding];

const holdWorkflow = workflow({ name: 'hold-sse' }).execute(async function* (
  _ctx: WorkflowContext,
) {
  return null;
});

class RecordingWorkflowEventFeed implements WorkflowEventFeed {
  readonly subscribeCalls: Array<{
    workflowId: string;
    selector: EventSelector;
    fromCursor: string | undefined;
  }> = [];
  replayLimitFaultMessage: string | undefined;

  constructor(private readonly envelopes: readonly EventEnvelope[]) {}

  async *replay(): AsyncIterable<EventEnvelope> {
    for (const eventEnvelope of this.envelopes) yield eventEnvelope;
  }

  subscribe(
    options: {
      workflowId: string;
      selector: EventSelector;
    } & ReplayLiveSubscribeOptions<EventEnvelope>,
  ): AsyncIterable<EventEnvelope> {
    const envelopes = this.envelopes;
    const replayLimitFault = options.createReplayLimitError?.(1_001, 1_000);
    this.replayLimitFaultMessage =
      typeof replayLimitFault === 'object' &&
      replayLimitFault !== null &&
      'message' in replayLimitFault &&
      typeof replayLimitFault.message === 'string'
        ? replayLimitFault.message
        : undefined;
    this.subscribeCalls.push({
      workflowId: options.workflowId,
      selector: options.selector,
      fromCursor: options.fromCursor,
    });
    return (async function* replay() {
      for (const eventEnvelope of envelopes) yield eventEnvelope;
    })();
  }

  dispose(): void {
    /* no-op */
  }
}

class ThrowingWorkflowEventFeed implements WorkflowEventFeed {
  async *replay(): AsyncIterable<EventEnvelope> {
    return;
  }

  subscribe(): AsyncIterable<EventEnvelope> {
    throw new Error('workflow feed failed');
  }

  dispose(): void {
    /* no-op */
  }
}

function envelope(sequence: number, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    kind: 'workflow:started',
    workflowId: 'wf-sse',
    selector: 'events',
    sequence,
    cursor: String(sequence),
    emittedAtMs: sequence,
    payload: { workflowId: 'wf-sse' },
    ...overrides,
  };
}

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(holdWorkflow);
  return engine;
}

function request(path: string, headers?: Record<string, string>, signal?: AbortSignal): Request {
  return new Request(`http://localhost${path}`, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
    headers: {
      Accept: 'text/event-stream',
      ...headers,
    },
  });
}

function handlerOptions(
  feed: WorkflowEventFeed,
  scopes: readonly ('events:read' | 'streams:read')[] = ['events:read'],
  extra?: Partial<HandlerOptions>,
): HandlerOptions {
  return {
    authContext: {
      method: 'api-key',
      principal: principalFromApiKey({ subject: 'tester', scopes }),
    },
    operationRegistry: registry,
    restBindings: bindings,
    workflowEventFeed: feed,
    ...extra,
  };
}

function listenerCountingWorkflowEventFeed(): {
  readonly feed: WorkflowEventFeed;
  liveListeners(): number;
} {
  let liveListeners = 0;
  return {
    feed: createWorkflowEventFeed({
      async *replay() {
        return;
      },
      async snapshotTailSequence() {
        return -1;
      },
      subscribeLive() {
        liveListeners += 1;
        return () => {
          liveListeners -= 1;
        };
      },
    }),
    liveListeners() {
      return liveListeners;
    },
  };
}

describe('weft.workflows.events.sse', () => {
  it('streams workflow event envelopes as cursor-keyed SSE frames', async () => {
    const feed = new RecordingWorkflowEventFeed([envelope(0)]);
    const engine = createEngine();
    await engine.start('hold-sse', null, { id: 'wf-sse' });

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse'),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const body = await response.text();
    expect(body).toContain('id: 0');
    expect(body).toContain('event: workflow:started');
    expect(body).toContain('"workflowId":"wf-sse"');
    expect(feed.replayLimitFaultMessage).toBe(
      'Workflow event replay window is 1001 events; maximum is 1000. Supply a more recent fromCursor.',
    );
  });

  it('streams non-closable workflow iterables through the REST binding shaper', async () => {
    const response = workflowEventsSseRestBinding.shapeSuccess?.(
      (async function* replay() {
        yield envelope(11);
      })(),
      request('/v1/workflows/wf-sse/events/sse'),
    );

    if (response === undefined) throw new Error('Expected workflow SSE response shaper');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('id: 11');
  });

  it('unsubscribes the workflow event feed when an SSE request is already aborted', async () => {
    const { feed, liveListeners } = listenerCountingWorkflowEventFeed();
    const engine = createEngine();
    const controller = new AbortController();
    controller.abort();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse', undefined, controller.signal),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(liveListeners()).toBe(0);
  });

  it('emits a replay-complete ping after workflow SSE replay drains', async () => {
    const { feed, liveListeners } = listenerCountingWorkflowEventFeed();
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse'),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Expected SSE response body');
    const firstFrame = await reader.read();
    await reader.cancel();
    const body = new TextDecoder().decode(firstFrame.value);

    expect(body).toContain('event: ping');
    expect(body).toContain('"replayComplete":true');
    expect(body).not.toContain('id:');
    expect(liveListeners()).toBe(0);
  });

  it('returns MethodNotFound when the SSE binding is registered without the operation', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(request('/v1/workflows/wf-sse/events/sse'), engine, {
      ...handlerOptions(feed),
      operationRegistry: createOperationRegistry([]),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'unknown operation: weft.workflows.events.sse',
      data: { method: 'weft.workflows.events.sse' },
    });
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('uses Last-Event-ID before fromCursor when both are supplied', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse?fromCursor=3', { 'Last-Event-ID': '8' }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    expect(feed.subscribeCalls[0]).toMatchObject({
      workflowId: 'wf-sse',
      selector: 'events',
      fromCursor: '8',
    });
  });

  it('rejects invalid cursors before opening the stream', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse?fromCursor=bad-cursor'),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid cursor' });
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('requires the Accept header to include text/event-stream', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse', { Accept: 'application/json' }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(406);
    expect(await response.json()).toEqual({
      error: 'Accept header must include text/event-stream',
    });
  });

  it('accepts case-insensitive event-stream media types with parameters', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse', {
        Accept: 'Text/Event-Stream; charset=utf-8',
      }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    expect(feed.subscribeCalls.length).toBe(1);
  });

  it('rejects event-stream substring lookalikes', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse', { Accept: 'text/event-streamx' }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(406);
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('requires an authenticated principal before opening the stream', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(request('/v1/workflows/wf-sse/events/sse'), engine, {
      operationRegistry: registry,
      restBindings: bindings,
      workflowEventFeed: feed,
      supportedAuthenticationSchemes: new Set(['apiKeyAuth'] as const),
    });

    expect(response.status).toBe(401);
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('allows anonymous SSE when the server explicitly has no authentication schemes', async () => {
    const feed = new RecordingWorkflowEventFeed([envelope(0)]);
    const engine = createEngine();

    const response = await handleRequest(request('/v1/workflows/wf-sse/events/sse'), engine, {
      operationRegistry: registry,
      restBindings: bindings,
      workflowEventFeed: feed,
      supportedAuthenticationSchemes: new Set(),
    });

    expect(response.status).toBe(200);
    expect(feed.subscribeCalls[0]).toMatchObject({
      workflowId: 'wf-sse',
      selector: 'events',
      fromCursor: '-1',
    });
    expect(await response.text()).toContain('event: workflow:started');
  });

  it('classifies unauthenticated authorize calls as unauthorized', async () => {
    const authorize = workflowEventsSseOperation.authorize;
    if (authorize === undefined) throw new Error('Expected workflow SSE authorizer');

    await expect(
      authorize({
        input: { workflowId: 'wf-sse', selector: 'events' },
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'http-rest',
      }),
    ).resolves.toEqual({
      allowed: false,
      classification: 'unauthorized',
      reason: 'authentication required',
    });
  });

  it('returns UnsupportedTransport when the live workflow event feed is unavailable', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();
    const options = handlerOptions(feed, ['events:read']);
    const { workflowEventFeed: omittedWorkflowEventFeed, ...optionsWithoutWorkflowEventFeed } =
      options;
    void omittedWorkflowEventFeed;

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse'),
      engine,
      optionsWithoutWorkflowEventFeed,
    );

    expect(response.status).toBe(501);
  });

  it('throws UnsupportedTransport when invoked without an object context', async () => {
    await expect(
      workflowEventsSseOperation.invoke({
        input: { workflowId: 'wf-sse', selector: 'events' },
        principal: principalFromApiKey({ subject: 'tester', scopes: ['events:read'] }),
        engine: null,
        transport: 'http-rest',
      }),
    ).rejects.toMatchObject({
      code: 'UnsupportedTransport',
      message: 'workflow event SSE requires a workflow event feed',
    });
  });

  it('rejects non-iterable workflow SSE operation outputs', () => {
    expect(workflowEventsSseOperation.outputSchema.safeParse(null).success).toBe(false);
    expect(workflowEventsSseOperation.outputSchema.safeParse({}).success).toBe(false);
  });

  it('requires events:read for events and streams:read for tokens', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const eventsResponse = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse'),
      engine,
      handlerOptions(feed, ['streams:read']),
    );
    const tokensResponse = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse?selector=tokens'),
      engine,
      handlerOptions(feed, ['streams:read']),
    );

    expect(eventsResponse.status).toBe(403);
    expect(tokensResponse.status).toBe(200);
    expect(feed.subscribeCalls[0]?.selector).toBe('tokens');
  });

  it('rejects excess workflow SSE streams through the shared stream cap', async () => {
    const feed = new RecordingWorkflowEventFeed([]);
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse'),
      engine,
      handlerOptions(feed, ['events:read'], {
        acquireWorkflowStreamConnection() {
          return null;
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'maximum stream connections per workflow exceeded',
    });
    expect(feed.subscribeCalls.length).toBe(0);
  });

  it('releases a workflow stream lease when subscribe throws before streaming starts', async () => {
    const feed = new ThrowingWorkflowEventFeed();
    const engine = createEngine();
    let releaseCount = 0;

    const response = await handleRequest(
      request('/v1/workflows/wf-sse/events/sse'),
      engine,
      handlerOptions(feed, ['events:read'], {
        acquireWorkflowStreamConnection() {
          return {
            release() {
              releaseCount += 1;
            },
          };
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(releaseCount).toBe(1);
  });
});
