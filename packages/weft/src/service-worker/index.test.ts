import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { principalFromApiKey } from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import type { EventEnvelope, WorkflowEventFeed } from '../server/workflow-event-feed.ts';
import {
  buildDelegatedRequest,
  createFetchHandler,
  createLifecycleHandlers,
  createPeriodicSyncHandler,
  normalizePathPrefix,
  ServiceWorkerScheduler,
} from './index.ts';
import type { ServiceWorkerScheduler as ServiceWorkerSchedulerInstance } from './scheduler.ts';

// ---------------------------------------------------------------------------
// Minimal types mirroring the shapes in the implementation
// ---------------------------------------------------------------------------

interface MockFetchEvent {
  request: Request;
  respondWith: ReturnType<typeof mock>;
}

interface MockExtendableEvent {
  waitUntil: ReturnType<typeof mock>;
}

interface MockPeriodicSyncEvent extends MockExtendableEvent {
  tag: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetchEvent(url: string, method = 'GET'): MockFetchEvent {
  return {
    request: new Request(url, { method }),
    respondWith: mock(() => {}),
  };
}

function createMockExtendableEvent(): MockExtendableEvent {
  return {
    waitUntil: mock(() => {}),
  };
}

function createMockPeriodicSyncEvent(tag: string): MockPeriodicSyncEvent {
  return {
    tag,
    waitUntil: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// createFetchHandler
// ---------------------------------------------------------------------------

describe('createFetchHandler', () => {
  let mockEngine: { storage: unknown };

  beforeEach(() => {
    mockEngine = {
      storage: {},
    };
  });

  it('calls respondWith for requests matching the path prefix', () => {
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/weft/v1/health');

    handler(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });

  it('does NOT call respondWith for requests not matching the path prefix', () => {
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/api/data');

    handler(event);

    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('strips the path prefix before delegating to handleRequest', () => {
    // We verify by checking that respondWith is called (meaning the handler
    // processed the request). The stripped URL would be /v1/health which the
    // handleRequest function can route.
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/weft/v1/health');

    handler(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
    // The argument to respondWith should be a Promise<Response>
    const argument = event.respondWith.mock.calls[0]![0];
    expect(argument).toBeInstanceOf(Promise);
  });

  it('uses custom pathPrefix when provided', () => {
    const handler = createFetchHandler({
      engine: mockEngine as any,
      pathPrefix: '/custom/',
    });

    const matchingEvent = createMockFetchEvent('https://example.com/custom/v1/health');
    handler(matchingEvent);
    expect(matchingEvent.respondWith).toHaveBeenCalledTimes(1);

    const nonMatchingEvent = createMockFetchEvent('https://example.com/weft/v1/health');
    handler(nonMatchingEvent);
    expect(nonMatchingEvent.respondWith).not.toHaveBeenCalled();
  });

  it('correctly strips prefix and delegates /weft/v1/health to the handler', async () => {
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/weft/v1/health');

    handler(event);

    const responsePromise = event.respondWith.mock.calls[0]![0] as Promise<Response>;
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  // The service worker is intentionally decoupled from the network `/api`
  // prefix: it calls `handleRequest` directly (bypassing the front-door strip),
  // so it strips only its own `/weft/` prefix and delegates canonical
  // root-relative paths. Do NOT wire `/api` handling into the service worker.
  it('delegates the canonical /v1 path, never an /api-prefixed one', () => {
    const event = createMockFetchEvent('https://example.com/weft/v1/workflows/abc');
    const delegated = buildDelegatedRequest(event, normalizePathPrefix('/weft/'));

    expect(delegated).not.toBeNull();
    expect(new URL(delegated!.url).pathname).toBe('/v1/workflows/abc');
    expect(new URL(delegated!.url).pathname.startsWith('/api/')).toBe(false);
  });

  it('preserves POST request bodies when delegating through the path prefix', async () => {
    const event: MockFetchEvent = {
      request: new Request('https://example.com/weft/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'checkout', input: { cartId: 'cart-1' } }),
      }),
      respondWith: mock(() => {}),
    };

    const delegated = buildDelegatedRequest(event, normalizePathPrefix('/weft/'));

    expect(delegated).not.toBeNull();
    expect(new URL(delegated!.url).pathname).toBe('/v1/workflows');
    expect(delegated!.headers.get('Content-Type')).toBe('application/json');
    expect(await delegated!.json()).toEqual({
      type: 'checkout',
      input: { cartId: 'cart-1' },
    });
  });

  it('handles trailing slash in pathPrefix', () => {
    const handler = createFetchHandler({
      engine: mockEngine as any,
      pathPrefix: '/weft',
    });
    const event = createMockFetchEvent('https://example.com/weft/v1/health');

    handler(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for unrecognized routes within the prefix', async () => {
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/weft/nonexistent');

    handler(event);

    const responsePromise = event.respondWith.mock.calls[0]![0] as Promise<Response>;
    const response = await responsePromise;
    expect(response.status).toBe(404);
  });

  it('passes handler options through the lower-level fetch handler', async () => {
    const envelope: EventEnvelope = {
      kind: 'workflow:started',
      workflowId: 'wf-service-worker',
      selector: 'events',
      sequence: 0,
      cursor: '0',
      emittedAtMs: 0,
      payload: {},
    };
    const workflowEventFeed: WorkflowEventFeed = {
      async *replay() {
        yield envelope;
      },
      subscribe() {
        return (async function* events() {
          yield envelope;
        })();
      },
      dispose() {},
    };
    const handler = createFetchHandler({
      engine: mockEngine as any,
      handlerOptions: {
        authContext: {
          method: 'api-key',
          principal: principalFromApiKey({ subject: 'service-worker', scopes: ['events:read'] }),
        },
        workflowEventFeed,
      },
    });
    const event = createMockFetchEvent(
      'https://example.com/weft/v1/workflows/wf-service-worker/events/sse',
    );
    event.request = new Request(event.request, { headers: { Accept: 'text/event-stream' } });

    handler(event);
    const response = await (event.respondWith.mock.calls[0]![0] as Promise<Response>);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('workflow:started');
  });
});

// ---------------------------------------------------------------------------
// createPeriodicSyncHandler
// ---------------------------------------------------------------------------

describe('createPeriodicSyncHandler', () => {
  it('re-exports ServiceWorkerScheduler from the service-worker entrypoint', () => {
    using storage = new MemoryStorage();
    using scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: () => {},
    });

    expect(scheduler).toBeInstanceOf(ServiceWorkerScheduler);
  });

  it('calls waitUntil with scheduler.tick() for matching tag', () => {
    const tickMock = mock(() => Promise.resolve());
    const scheduler = { tick: tickMock } as unknown as ServiceWorkerSchedulerInstance;

    const handler = createPeriodicSyncHandler(scheduler);
    const event = createMockPeriodicSyncEvent('weft-timers');

    handler(event);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    expect(tickMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing for non-matching tag', () => {
    const tickMock = mock(() => Promise.resolve());
    const scheduler = { tick: tickMock } as unknown as ServiceWorkerSchedulerInstance;

    const handler = createPeriodicSyncHandler(scheduler);
    const event = createMockPeriodicSyncEvent('other-tag');

    handler(event);

    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('uses custom tag when provided', () => {
    const tickMock = mock(() => Promise.resolve());
    const scheduler = { tick: tickMock } as unknown as ServiceWorkerSchedulerInstance;

    const handler = createPeriodicSyncHandler(scheduler, 'custom-sync-tag');
    const event = createMockPeriodicSyncEvent('custom-sync-tag');

    handler(event);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    expect(tickMock).toHaveBeenCalledTimes(1);
  });

  it('does not match default tag when custom tag is provided', () => {
    const tickMock = mock(() => Promise.resolve());
    const scheduler = { tick: tickMock } as unknown as ServiceWorkerSchedulerInstance;

    const handler = createPeriodicSyncHandler(scheduler, 'custom-sync-tag');
    const event = createMockPeriodicSyncEvent('weft-timers');

    handler(event);

    expect(event.waitUntil).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createLifecycleHandlers
// ---------------------------------------------------------------------------

describe('createLifecycleHandlers', () => {
  it('returns install and activate handlers', () => {
    const handlers = createLifecycleHandlers();
    expect(typeof handlers.install).toBe('function');
    expect(typeof handlers.activate).toBe('function');
  });

  it('install calls waitUntil', () => {
    const handlers = createLifecycleHandlers();
    const event = createMockExtendableEvent();

    handlers.install(event);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('activate calls waitUntil', () => {
    const handlers = createLifecycleHandlers();
    const event = createMockExtendableEvent();

    handlers.activate(event);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('activate claims the open clients when the scope has them', async () => {
    const claim = mock(async () => {});
    const scope = globalThis as { clients?: unknown };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'clients');
    Object.defineProperty(globalThis, 'clients', { configurable: true, value: { claim } });
    try {
      const handlers = createLifecycleHandlers();
      const event = createMockExtendableEvent();

      handlers.activate(event);
      await event.waitUntil.mock.calls[0]![0];

      expect(claim).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete scope.clients;
      else Object.defineProperty(globalThis, 'clients', previous);
    }
  });

  it('install passes a promise to waitUntil', () => {
    const handlers = createLifecycleHandlers();
    const event = createMockExtendableEvent();

    handlers.install(event);

    const argument = event.waitUntil.mock.calls[0]![0];
    expect(argument).toBeInstanceOf(Promise);
  });

  it('activate passes a promise to waitUntil', () => {
    const handlers = createLifecycleHandlers();
    const event = createMockExtendableEvent();

    handlers.activate(event);

    const argument = event.waitUntil.mock.calls[0]![0];
    expect(argument).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// createFetchHandler: local trust by default (COR-1466)
// ---------------------------------------------------------------------------

describe('createFetchHandler authorization', () => {
  async function respond(
    handlerOptions: Parameters<typeof createFetchHandler>[0]['handlerOptions'],
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const { Engine } = await import('../core/engine.ts');
    const { workflow } = await import('../core/types/workflow-function.ts');
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'local-trust' }).execute(async function* () {
        return 'done';
      }),
    );
    const handler = createFetchHandler({
      engine,
      ...(handlerOptions === undefined ? {} : { handlerOptions }),
    });
    const respondWith = mock((_response: Response | Promise<Response>) => {});
    const event = {
      request: new Request(`https://example.com/weft${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
      respondWith,
    };
    handler(event);
    // Read the response before the engine is disposed at the end of this scope.
    const response = await respondWith.mock.calls[0]![0];
    return { status: response.status, body: await response.json() };
  }

  it('runs as the local user when no authContext is given: workflows list and start without a 401', async () => {
    const listed = await respond(undefined, 'GET', '/v1/workflows');
    expect(listed.status).toBe(200);
    const started = await respond(undefined, 'POST', '/v1/workflows', { type: 'local-trust' });
    expect(started).toMatchObject({ status: 201 });
    const principal = await respond(undefined, 'GET', '/v1/principal');
    expect(principal.body).toMatchObject({ method: 'unauthenticated-local' });
  });

  it('applies the default to handlerOptions that name no authContext', async () => {
    const listed = await respond({}, 'GET', '/v1/workflows');
    expect(listed.status).toBe(200);
  });

  it('lets an explicit authContext replace the default', async () => {
    const refused = await respond(
      {
        authContext: {
          method: 'api-key',
          principal: principalFromApiKey({ subject: 'narrow', scopes: ['system:read'] }),
        },
      },
      'GET',
      '/v1/workflows',
    );
    expect(refused.status).toBe(403);
  });

  it('opts out of local trust with a public authContext: the caller is anonymous', async () => {
    const refused = await respond({ authContext: { method: 'public' } }, 'GET', '/v1/workflows');
    expect(refused.status).toBe(401);
    const principal = await respond({ authContext: { method: 'public' } }, 'GET', '/v1/principal');
    expect(principal.body).toMatchObject({ method: 'unauthenticated' });
  });

  it('never answers a navigation, and does not throw for one', () => {
    const handler = createFetchHandler({ engine: { storage: new MemoryStorage() } as any });
    const respondWith = mock(() => {});
    const navigation = {
      mode: 'navigate',
      url: 'https://example.com/weft/v1/principal',
      clone() {
        throw new TypeError('a navigation request cannot be cloned into a new Request');
      },
    };

    expect(() => handler({ request: navigation as unknown as Request, respondWith })).not.toThrow();
    expect(respondWith).not.toHaveBeenCalled();
  });
});
