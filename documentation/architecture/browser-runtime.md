# Browser Runtime

Weft runs in the browser. Not a stripped-down client library that talks to a server—the actual engine, executing workflows in Web Workers, persisting state to IndexedDB, all inside the browser.

The key enabler is the Service Worker. See the [Service Worker guide](../guides/service-worker.md) for the hands-on setup path.

## Service Worker as the browser server

A Service Worker is a special kind of Web Worker that acts as a proxy between your web app and the network. It intercepts `fetch` events, can cache responses, and can be woken by browser events even when no tab is actively running. It has access to IndexedDB for persistent storage and scheduling primitives for periodic wakeup.

For Weft, a Service Worker is the browser equivalent of the Bun server process.

```
┌──────────────────────────────────────────────────────┐
│ Browser Tab (your app)                               │
│                                                      │
│  import { HttpClient } from '@lostgradient/weft/client';           │
│  const client = new HttpClient({ baseUrl: '/' });    │
│  await client.start('order', { orderId: 'abc' });    │
│                                                      │
│  // This fetch() is intercepted by the Service Worker│
│  fetch("/weft/v1/workflows", { method: "POST", ... })│
└──────────────────┬───────────────────────────────────┘
                   │ fetch event
┌──────────────────▼───────────────────────────────────┐
│ Service Worker (weft-sw.ts)                          │
│                                                      │
│  self.addEventListener("fetch", handleWeftFetch);    │
│  self.addEventListener("periodicsync", tickTimers);  │
│                                                      │
│  Engine(IndexedDBStorage) ← same engine code!        │
│                                                      │
│  // Durable timers via IndexedDB + periodic check    │
│  // Workflow execution in spawned Web Workers         │
│  // Survives tab close (Service Worker lifecycle)     │
└──────────────────────────────────────────────────────┘
```

## Same handleRequest, different environment

The Weft HTTP handler is a pure `Request` to `Response` function. On the server, `Bun.serve()` calls it. In the browser, the Service Worker's `fetch` event calls it. Same function, same API surface.

```typescript partial
// weft-sw.ts — installed as a Service Worker
/// <reference lib="webworker" />

import { workflow } from '@lostgradient/weft';
import { setupServiceWorker } from '@lostgradient/weft/service-worker';

const { engine } = await setupServiceWorker({
  pathPrefix: '/weft/',
  register(engine) {
    engine.register(
      workflow({ name: 'checkout' }).execute(async function* () {
        yield;
        return 'done';
      }),
    );
  },
});

void engine;
```

`setupServiceWorker()` builds an IndexedDB-backed engine, wires a Service Worker scheduler against it, and attaches all four event listeners (`install`, `activate`, `fetch`, `periodicsync`) synchronously before any `await`. Listeners attach in lockstep — fetch handlers gate their work on the registration promise so a request that arrives mid-init is held until your `register` callback completes.

The client library doesn't know or care whether its `fetch` calls hit a remote server or a local Service Worker. The API contract is identical.

When the tab calls `fetch("/weft/v1/workflows", { method: "POST", ... })`, the Service Worker strips the `pathPrefix` before routing, so the underlying handler sees `/v1/workflows`.

If you've already registered workflows synchronously (e.g. on a separate boot path) and want explicit listener attachment, use the lower-level factories instead:

```typescript partial
import {
  createFetchHandler,
  createLifecycleHandlers,
  createPeriodicSyncHandler,
  ServiceWorkerScheduler,
} from '@lostgradient/weft/service-worker';
import { Engine } from '@lostgradient/weft';
import { IndexedDBStorage } from '@lostgradient/weft/storage/indexeddb';

const storage = new IndexedDBStorage('weft');
// `recover: false` — this snippet boots the service worker but does not show
// workflow/activity registration. Register your definitions before calling
// `await engine.recoverAll()` separately. Booting with `Engine.create({ storage })`
// alone would throw on any running workflow because the engine has no
// registrations yet.
const engine = await Engine.create({ storage, recover: false });
const scheduler = new ServiceWorkerScheduler({
  storage,
  onTimerFired: (entry) => engine.fireTimer(entry),
});

const { install, activate } = createLifecycleHandlers();
self.addEventListener('install', install);
self.addEventListener('activate', activate);
self.addEventListener('fetch', createFetchHandler({ engine, pathPrefix: '/weft/' }));
self.addEventListener('periodicsync', createPeriodicSyncHandler(scheduler));
```

`createFetchHandler()` takes an `engine` and an optional `pathPrefix` (default `'/weft/'`). It returns a `fetch` event listener that intercepts matching requests and delegates to `handleRequest()`. Non-matching requests pass through to the network. `createLifecycleHandlers()` returns `install` and `activate` handlers that call `skipWaiting()` and `clients.claim()` respectively, ensuring the Service Worker takes control immediately. `createPeriodicSyncHandler()` returns a `periodicsync` listener for timer wakeups and calls `scheduler.tick()` inside `event.waitUntil(...)`.

## Durable timers with Periodic Background Sync

Workflows need timers—`yield* ctx.sleep("1 hour")` has to actually wake up an hour later. In Bun, the scheduler polls the database. In the browser, the **Periodic Background Sync API** serves the same purpose.

The Service Worker scheduler manages timer wakeup. It checks IndexedDB for expired timers and advances waiting workflows. When Periodic Background Sync is available, the browser wakes the Service Worker at the registered interval. When it is not available, you need a page-controlled fallback that calls `scheduler.tick()` while a tab is open.

```typescript partial
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'weft-timers') return;
  event.waitUntil(scheduler.tick());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'weft:tick') return;
  event.waitUntil(scheduler.tick());
});
```

## What this enables

**Offline-first durable workflows.** An app starts a workflow (say, "sync these photos when online"). The Service Worker persists the workflow to IndexedDB. Even if the user closes the tab, the Service Worker resumes when the browser wakes it up.

**Same API surface.** The Weft client library calls `fetch("/weft/v1/workflows", ...)`. In server mode, this goes over the network to a Weft server. In browser mode, the Service Worker intercepts it. Your client code doesn't change.

**Hybrid mode.** The Service Worker can act as a local cache and queue that syncs with a remote Weft server. Start workflows locally for immediate responsiveness, sync state to the server when connectivity allows.

## Limitations

Service Workers don't have unlimited background execution time. Browsers limit how long a Service Worker can run after the page is closed. The Periodic Background Sync API's minimum interval varies by browser and depends on site engagement heuristics.

For truly long-running workflows—ones that need to execute for hours or days—you still need a server. The browser runtime is ideal for: queuing work, short workflows, offline caching, and syncing state with a remote Weft server.

The important thing is that these aren't two different engines with a compatibility layer between them. It's the same engine, the same workflow code, the same storage interface. The browser runtime is a deployment target, not a separate product.
