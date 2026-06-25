import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import {
  buildDelegatedRequest,
  createFetchHandler,
  createLifecycleHandlers,
  createPeriodicSyncHandler,
  normalizePathPrefix,
  ServiceWorkerScheduler,
} from './index';
import type { ServiceWorkerScheduler as ServiceWorkerSchedulerInstance } from './scheduler';

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

    handler(event as any);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });

  it('does NOT call respondWith for requests not matching the path prefix', () => {
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/api/data');

    handler(event as any);

    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('strips the path prefix before delegating to handleRequest', () => {
    // We verify by checking that respondWith is called (meaning the handler
    // processed the request). The stripped URL would be /v1/health which the
    // handleRequest function can route.
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/weft/v1/health');

    handler(event as any);

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
    handler(matchingEvent as any);
    expect(matchingEvent.respondWith).toHaveBeenCalledTimes(1);

    const nonMatchingEvent = createMockFetchEvent('https://example.com/weft/v1/health');
    handler(nonMatchingEvent as any);
    expect(nonMatchingEvent.respondWith).not.toHaveBeenCalled();
  });

  it('correctly strips prefix and delegates /weft/v1/health to the handler', async () => {
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/weft/v1/health');

    handler(event as any);

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
    const delegated = buildDelegatedRequest(event as any, normalizePathPrefix('/weft/'));

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

    const delegated = buildDelegatedRequest(event as any, normalizePathPrefix('/weft/'));

    expect(delegated).not.toBeNull();
    expect(new URL(delegated!.url).pathname).toBe('/v1/workflows');
    expect(delegated!.headers.get('Content-Type')).toBe('application/json');
    await expect(delegated!.json()).resolves.toEqual({
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

    handler(event as any);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for unrecognized routes within the prefix', async () => {
    const handler = createFetchHandler({ engine: mockEngine as any });
    const event = createMockFetchEvent('https://example.com/weft/nonexistent');

    handler(event as any);

    const responsePromise = event.respondWith.mock.calls[0]![0] as Promise<Response>;
    const response = await responsePromise;
    expect(response.status).toBe(404);
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

    handler(event as any);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    expect(tickMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing for non-matching tag', () => {
    const tickMock = mock(() => Promise.resolve());
    const scheduler = { tick: tickMock } as unknown as ServiceWorkerSchedulerInstance;

    const handler = createPeriodicSyncHandler(scheduler);
    const event = createMockPeriodicSyncEvent('other-tag');

    handler(event as any);

    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('uses custom tag when provided', () => {
    const tickMock = mock(() => Promise.resolve());
    const scheduler = { tick: tickMock } as unknown as ServiceWorkerSchedulerInstance;

    const handler = createPeriodicSyncHandler(scheduler, 'custom-sync-tag');
    const event = createMockPeriodicSyncEvent('custom-sync-tag');

    handler(event as any);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    expect(tickMock).toHaveBeenCalledTimes(1);
  });

  it('does not match default tag when custom tag is provided', () => {
    const tickMock = mock(() => Promise.resolve());
    const scheduler = { tick: tickMock } as unknown as ServiceWorkerSchedulerInstance;

    const handler = createPeriodicSyncHandler(scheduler, 'custom-sync-tag');
    const event = createMockPeriodicSyncEvent('weft-timers');

    handler(event as any);

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

    handlers.install(event as any);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('activate calls waitUntil', () => {
    const handlers = createLifecycleHandlers();
    const event = createMockExtendableEvent();

    handlers.activate(event as any);

    expect(event.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('install passes a promise to waitUntil', () => {
    const handlers = createLifecycleHandlers();
    const event = createMockExtendableEvent();

    handlers.install(event as any);

    const argument = event.waitUntil.mock.calls[0]![0];
    expect(argument).toBeInstanceOf(Promise);
  });

  it('activate passes a promise to waitUntil', () => {
    const handlers = createLifecycleHandlers();
    const event = createMockExtendableEvent();

    handlers.activate(event as any);

    const argument = event.waitUntil.mock.calls[0]![0];
    expect(argument).toBeInstanceOf(Promise);
  });
});
