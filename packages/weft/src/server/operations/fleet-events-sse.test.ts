import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createFleetEventFeed,
  type FleetEventEnvelope,
  type FleetEventFeed,
} from '../fleet-event-feed.ts';
import { handleRequest, type HandlerOptions } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createReplayLiveFeed, type ReplayLiveSubscribeOptions } from '../workflow-event-feed.ts';
import { fleetEventsSseOperation, fleetEventsSseRestBinding } from './fleet-events-sse.ts';

const registry = createOperationRegistry([fleetEventsSseOperation]);
const bindings = [fleetEventsSseRestBinding];

class RecordingFleetEventFeed implements Pick<FleetEventFeed, 'subscribe'> {
  readonly subscribeCalls: Array<{
    fromCursor: string | undefined;
    delivered: number[];
  }> = [];
  replayLimitFaultMessage: string | undefined;

  constructor(private readonly envelopes: readonly FleetEventEnvelope[]) {}

  subscribe(
    options?: ReplayLiveSubscribeOptions<FleetEventEnvelope>,
  ): AsyncIterable<FleetEventEnvelope> {
    const envelopes = this.envelopes;
    const delivered: number[] = [];
    const replayLimitFault = options?.createReplayLimitError?.(1_001, 1_000);
    this.replayLimitFaultMessage =
      typeof replayLimitFault === 'object' &&
      replayLimitFault !== null &&
      'message' in replayLimitFault &&
      typeof replayLimitFault.message === 'string'
        ? replayLimitFault.message
        : undefined;
    this.subscribeCalls.push({ fromCursor: options?.fromCursor, delivered });
    return (async function* replay() {
      for (const eventEnvelope of envelopes) {
        if (!(options?.filterEnvelope?.(eventEnvelope) ?? true)) continue;
        delivered.push(eventEnvelope.sequence);
        yield eventEnvelope;
      }
    })();
  }
}

class ThrowingFleetEventFeed implements Pick<FleetEventFeed, 'subscribe'> {
  subscribe(): AsyncIterable<FleetEventEnvelope> {
    throw new Error('fleet feed failed');
  }
}

function envelope(
  sequence: number,
  overrides: Partial<FleetEventEnvelope> = {},
): FleetEventEnvelope {
  return {
    kind: 'workflow:started',
    workflowId: 'wf-a',
    sequence,
    cursor: String(sequence),
    emittedAtMs: sequence,
    payload: { workflowId: 'wf-a' },
    ...overrides,
  };
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

function handlerOptions(feed: Pick<FleetEventFeed, 'subscribe'>): HandlerOptions {
  return {
    authContext: {
      method: 'api-key',
      principal: principalFromApiKey({ subject: 'tester', scopes: ['events:read'] }),
    },
    operationRegistry: registry,
    restBindings: bindings,
    fleetEventFeed: feed,
  };
}

function listenerCountingFleetEventFeed(): {
  readonly feed: Pick<FleetEventFeed, 'subscribe'>;
  liveListeners(): number;
} {
  let liveListeners = 0;
  const replayLiveFeed = createReplayLiveFeed<FleetEventEnvelope>({
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
  });
  return {
    feed: {
      subscribe: (options) => replayLiveFeed.subscribe(options),
    },
    liveListeners() {
      return liveListeners;
    },
  };
}

describe('weft.events.sse', () => {
  it('streams filtered fleet events as SSE frames', async () => {
    const feed = new RecordingFleetEventFeed([
      envelope(0, { workflowId: 'wf-a', kind: 'workflow:started' }),
      envelope(1, { workflowId: 'wf-b', kind: 'workflow:started' }),
      envelope(2, { workflowId: 'wf-a', kind: 'workflow:completed' }),
    ]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse?workflowId=wf-a&kind=workflow:completed'),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('id: 2');
    expect(body).toContain('event: workflow:completed');
    expect(body).toContain('"workflowId":"wf-a"');
    expect(body).not.toContain('id: 0');
    expect(body).not.toContain('id: 1');
    expect(feed.subscribeCalls[0]?.delivered).toEqual([2]);
    expect(feed.replayLimitFaultMessage).toBe(
      'Fleet event replay window is 1001 matching events; maximum is 1000. Supply a more recent fromCursor.',
    );
  });

  it('delivers retention gaps before applying workflow and kind filters', async () => {
    const feed = new RecordingFleetEventFeed([
      envelope(4, {
        kind: 'fleet:gap',
        workflowId: undefined,
        payload: { requestedCursor: '0', firstRetainedSequence: 5 },
      }),
      envelope(5, { workflowId: 'wf-a', kind: 'workflow:completed' }),
    ]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse?workflowId=wf-a&kind=workflow:completed'),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: fleet:gap');
    expect(body).toContain('event: workflow:completed');
    expect(feed.subscribeCalls[0]?.delivered).toEqual([4, 5]);
  });

  it('streams non-closable fleet iterables through the REST binding shaper', async () => {
    const response = fleetEventsSseRestBinding.shapeSuccess?.(
      (async function* replay() {
        yield envelope(9);
      })(),
      request('/v1/events/sse'),
    );

    if (response === undefined) throw new Error('Expected fleet SSE response shaper');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('id: 9');
  });

  it('unsubscribes the fleet event feed when an SSE request is already aborted', async () => {
    const { feed, liveListeners } = listenerCountingFleetEventFeed();
    const engine = new Engine({ storage: new MemoryStorage() });
    const controller = new AbortController();
    controller.abort();

    const response = await handleRequest(
      request('/v1/events/sse', undefined, controller.signal),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(liveListeners()).toBe(0);
  });

  it('emits a replay-complete ping after fleet SSE replay drains', async () => {
    const { feed, liveListeners } = listenerCountingFleetEventFeed();
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(request('/v1/events/sse'), engine, handlerOptions(feed));

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

  it('streams an explicit retention gap with its requested and first-retained cursors', async () => {
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    await fleetFeed.append({
      kind: 'workflow:started',
      workflowId: 'wf-gap',
      emittedAtMs: 0,
      payload: {},
    });
    await fleetFeed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-gap',
      emittedAtMs: 1,
      payload: {},
    });
    await fleetFeed.retain({ beforeSequence: 1 });

    const engine = new Engine({ storage: new MemoryStorage() });
    const response = await handleRequest(
      request('/v1/events/sse?fromCursor=-1'),
      engine,
      handlerOptions(fleetFeed),
    );

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Expected SSE response body');
    const decoder = new TextDecoder();
    let body = '';
    for (let reads = 0; reads < 5 && !body.includes('event: workflow:completed'); reads += 1) {
      const frame = await reader.read();
      if (frame.done) break;
      body += decoder.decode(frame.value, { stream: true });
    }
    await reader.cancel();
    expect(body).toContain('event: fleet:gap');
    expect(body).toContain('"requestedCursor":"-1"');
    expect(body).toContain('"firstRetainedSequence":1');
    expect(body).toContain('event: workflow:completed');
    expect(body).toContain('id: 1');
  });

  it('uses Last-Event-ID before fromCursor', async () => {
    const feed = new RecordingFleetEventFeed([]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse?fromCursor=1', { 'Last-Event-ID': '6' }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    expect(feed.subscribeCalls[0]?.fromCursor).toBe('6');
  });

  it('rejects invalid cursors before subscribing', async () => {
    const feed = new RecordingFleetEventFeed([]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse?fromCursor=invalid'),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid cursor' });
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('requires events:read access', async () => {
    const feed = new RecordingFleetEventFeed([]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(request('/v1/events/sse'), engine, {
      authContext: {
        method: 'api-key',
        principal: principalFromApiKey({ subject: 'tester', scopes: ['streams:read'] }),
      },
      operationRegistry: registry,
      restBindings: bindings,
      fleetEventFeed: feed,
    });

    expect(response.status).toBe(403);
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('allows anonymous SSE when the server explicitly has no authentication schemes', async () => {
    const feed = new RecordingFleetEventFeed([envelope(0)]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(request('/v1/events/sse'), engine, {
      operationRegistry: registry,
      restBindings: bindings,
      fleetEventFeed: feed,
      supportedAuthenticationSchemes: new Set(),
    });

    expect(response.status).toBe(200);
    expect(feed.subscribeCalls[0]?.fromCursor).toBe('-1');
    expect(await response.text()).toContain('event: workflow:started');
  });

  it('requires the Accept header to include text/event-stream', async () => {
    const feed = new RecordingFleetEventFeed([]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse', { Accept: 'application/json' }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(406);
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('accepts case-insensitive event-stream media types with parameters', async () => {
    const feed = new RecordingFleetEventFeed([]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse', { Accept: 'TEXT/EVENT-STREAM; charset=utf-8' }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(200);
    expect(feed.subscribeCalls.length).toBe(1);
  });

  it('rejects event-stream substring lookalikes', async () => {
    const feed = new RecordingFleetEventFeed([]);
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse', { Accept: 'text/event-streamx' }),
      engine,
      handlerOptions(feed),
    );

    expect(response.status).toBe(406);
    expect(feed.subscribeCalls).toEqual([]);
  });

  it('returns UnsupportedTransport when the live fleet event feed is unavailable', async () => {
    const feed = new RecordingFleetEventFeed([]);
    const engine = new Engine({ storage: new MemoryStorage() });
    const options = handlerOptions(feed);
    const { fleetEventFeed: omittedFleetEventFeed, ...optionsWithoutFleetEventFeed } = options;
    void omittedFleetEventFeed;

    const response = await handleRequest(
      request('/v1/events/sse'),
      engine,
      optionsWithoutFleetEventFeed,
    );

    expect(response.status).toBe(501);
  });

  it('throws UnsupportedTransport when invoked without an object context', async () => {
    await expect(
      fleetEventsSseOperation.invoke({
        input: {},
        principal: principalFromApiKey({ subject: 'tester', scopes: ['events:read'] }),
        engine: null,
        transport: 'http-rest',
      }),
    ).rejects.toMatchObject({
      code: 'UnsupportedTransport',
      message: 'fleet event SSE requires a fleet event feed',
    });
  });

  it('rejects non-iterable fleet SSE operation outputs', () => {
    expect(fleetEventsSseOperation.outputSchema.safeParse(null).success).toBe(false);
    expect(fleetEventsSseOperation.outputSchema.safeParse({}).success).toBe(false);
  });

  it('returns a sanitized error when subscribe throws before streaming starts', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/events/sse'),
      engine,
      handlerOptions(new ThrowingFleetEventFeed()),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
