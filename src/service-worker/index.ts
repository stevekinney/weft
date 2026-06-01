/**
 * Service Worker bootstrap functions for Weft.
 *
 * Composable functions that users wire up in their own Service Worker file.
 * Does NOT auto-register event listeners.
 *
 * @module service-worker
 */

import type { Engine } from '../core/engine';
import { handleRequest } from '../server/handler';
import type { ServiceWorkerScheduler } from './scheduler';
import type {
  MinimalExtendableEvent,
  MinimalFetchEvent,
  MinimalPeriodicSyncEvent,
} from './shared.ts';
import { buildDelegatedRequest, DEFAULT_PERIODIC_SYNC_TAG, normalizePathPrefix } from './shared.ts';

export { buildDelegatedRequest, DEFAULT_PERIODIC_SYNC_TAG, normalizePathPrefix } from './shared.ts';
export type {
  MinimalExtendableEvent,
  MinimalFetchEvent,
  MinimalPeriodicSyncEvent,
} from './shared.ts';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for the Service Worker bootstrap functions
 * (`createFetchHandler`, `createPeriodicSyncHandler`, `createLifecycleHandlers`).
 *
 * Supply the {@link Engine} instance that the service worker should delegate
 * workflow requests to.  Use `pathPrefix` to scope which fetch requests the
 * handler intercepts (default: `'/weft/'`).
 *
 * @example
 * ```ts
 * import { createFetchHandler, type ServiceWorkerOptions } from '@lostgradient/weft/service-worker';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * const storage = new MemoryStorage();
 * const engine = new Engine({ storage });
 *
 * const options: ServiceWorkerOptions = { engine, pathPrefix: '/weft/' };
 * const handleFetch = createFetchHandler(options);
 * // In a Service Worker file: self.addEventListener('fetch', handleFetch);
 * void handleFetch;
 * ```
 */
export interface ServiceWorkerOptions {
  engine: Engine;
  pathPrefix?: string;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createFetchHandler
// ---------------------------------------------------------------------------

/**
 * Create a fetch event handler that intercepts requests matching the given
 * path prefix and delegates them to the Weft HTTP handler.
 *
 * The default `pathPrefix` is `'/weft/'`. A trailing slash is auto-appended
 * when missing, so `'/weft'` and `'/weft/'` behave identically. Requests
 * whose pathname does not start with the (normalized) prefix are passed
 * through — the handler simply returns without calling
 * `event.respondWith`, leaving the request to the next service-worker
 * listener or the network. Matching requests have the prefix stripped
 * before delegation: `/weft/v1/health` becomes `/v1/health` for
 * {@link Engine}.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import { createFetchHandler } from '@lostgradient/weft/service-worker';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const handler = createFetchHandler({ engine, pathPrefix: '/weft/' });
 *
 * // In your Service Worker:
 * // self.addEventListener('fetch', handler);
 * console.log(typeof handler); // 'function'
 * ```
 */
export function createFetchHandler(
  options: ServiceWorkerOptions,
): (event: MinimalFetchEvent) => void {
  const { engine } = options;
  const pathPrefix = normalizePathPrefix(options.pathPrefix);

  return (event: MinimalFetchEvent) => {
    const delegatedRequest = buildDelegatedRequest(event, pathPrefix);
    if (delegatedRequest === null) return;
    event.respondWith(handleRequest(delegatedRequest, engine));
  };
}

// ---------------------------------------------------------------------------
// createPeriodicSyncHandler
// ---------------------------------------------------------------------------

/**
 * Create a periodic sync event handler that ticks the scheduler
 * when the matching tag fires.
 *
 * The default `tag` is `'weft-timers'`. Events with non-matching tags are
 * silently ignored. The returned handler invokes `scheduler.tick()` inside
 * `event.waitUntil(...)` so the sync extends until the tick promise
 * resolves.
 *
 * Note: `ServiceWorkerScheduler` is the parameter type but is not currently
 * re-exported from `@lostgradient/weft/service-worker` — construct the scheduler in the
 * module that imports it directly (e.g. the dashboard runtime) and pass
 * the instance to this factory.
 *
 * @example
 * ```ts
 * import { createPeriodicSyncHandler } from '@lostgradient/weft/service-worker';
 *
 * // In your Service Worker (with a scheduler from the runtime that imports it):
 * declare const scheduler: { tick(): Promise<void> };
 * const handler = createPeriodicSyncHandler(
 *   scheduler as Parameters<typeof createPeriodicSyncHandler>[0],
 *   'weft-timers',
 * );
 * // self.addEventListener('periodicsync', handler);
 * console.log(typeof handler); // 'function'
 * ```
 */
export function createPeriodicSyncHandler(
  scheduler: ServiceWorkerScheduler,
  tag?: string,
): (event: MinimalPeriodicSyncEvent) => void {
  const syncTag = tag ?? DEFAULT_PERIODIC_SYNC_TAG;

  return (event: MinimalPeriodicSyncEvent) => {
    if (event.tag !== syncTag) return;

    event.waitUntil(scheduler.tick());
  };
}

// ---------------------------------------------------------------------------
// createLifecycleHandlers
// ---------------------------------------------------------------------------

/**
 * Create install and activate lifecycle event handlers.
 *
 * - `install`: Calls `skipWaiting()` so the new Service Worker activates immediately.
 * - `activate`: Calls `clients.claim()` so open tabs use the new Service Worker.
 *
 * Both handlers are defensive: when `skipWaiting` or `clients.claim` are
 * not present on `globalThis` (e.g. when the module is imported in a unit
 * test or an environment that is not a Service Worker scope), they silently
 * fall back to a resolved promise so the import remains safe.
 *
 * @example
 * ```ts
 * import { createLifecycleHandlers } from '@lostgradient/weft/service-worker';
 *
 * const { install, activate } = createLifecycleHandlers();
 *
 * // In your Service Worker file:
 * // self.addEventListener('install', install);
 * // self.addEventListener('activate', activate);
 * console.log(typeof install, typeof activate); // 'function function'
 * ```
 */
export function createLifecycleHandlers(): {
  install: (event: MinimalExtendableEvent) => void;
  activate: (event: MinimalExtendableEvent) => void;
} {
  // Access the global scope in a lint-safe way.
  const serviceWorkerScope = globalThis as Record<string, unknown>;

  return {
    install: (event: MinimalExtendableEvent) => {
      // In a real Service Worker, self.skipWaiting() is available globally.
      // We wrap it in a resolved promise for environments where it may not exist.
      const skipWaiting = serviceWorkerScope['skipWaiting'];
      const skipWaitingPromise =
        typeof skipWaiting === 'function' ? (skipWaiting() as Promise<void>) : Promise.resolve();
      event.waitUntil(skipWaitingPromise);
    },
    activate: (event: MinimalExtendableEvent) => {
      // In a real Service Worker, self.clients.claim() is available globally.
      const clients = serviceWorkerScope['clients'] as { claim?: () => Promise<void> } | undefined;
      const claimPromise =
        clients !== undefined && clients !== null && typeof clients.claim === 'function'
          ? clients.claim()
          : Promise.resolve();
      event.waitUntil(claimPromise);
    },
  };
}

export {
  setupServiceWorker,
  type SetupServiceWorkerOptions,
  type SetupServiceWorkerResult,
} from './setup.ts';
