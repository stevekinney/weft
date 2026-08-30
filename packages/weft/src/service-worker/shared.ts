/**
 * Internal shared helpers for the Service Worker bootstrap surface. Extracted
 * here so `index.ts` (low-level factories) and `setup.ts` (one-call helper)
 * can both depend on them without forming an import cycle.
 *
 * @module service-worker/shared
 */

const DEFAULT_PATH_PREFIX = '/weft/';

/**
 * Default periodic-sync tag used when callers don't pass one explicitly.
 * Shared by `createPeriodicSyncHandler` and `setupServiceWorker` so the
 * two entry points cannot drift to different tags.
 *
 * @example
 * ```ts
 * import { DEFAULT_PERIODIC_SYNC_TAG } from '@lostgradient/weft/service-worker';
 * const tag: 'weft-timers' = DEFAULT_PERIODIC_SYNC_TAG;
 * void tag;
 * ```
 */
export const DEFAULT_PERIODIC_SYNC_TAG = 'weft-timers';

/**
 * Minimal FetchEvent shape used by `createFetchHandler` and the internal
 * `buildDelegatedRequest` helper. Stays narrow on purpose so the module
 * doesn't pull in webworker types that conflict with Bun's lib.
 *
 * @example
 * ```ts
 * import { createFetchHandler, type MinimalFetchEvent } from '@lostgradient/weft/service-worker';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const handler = createFetchHandler({ engine });
 * declare const event: MinimalFetchEvent;
 * handler(event);
 * ```
 */
export interface MinimalFetchEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

/**
 * Minimal `ExtendableEvent` shape — accepted by `install`, `activate`, and
 * any handler that wants to extend the event lifetime via `waitUntil`.
 *
 * @example
 * ```ts
 * import type { MinimalExtendableEvent } from '@lostgradient/weft/service-worker';
 * declare const event: MinimalExtendableEvent;
 * event.waitUntil(Promise.resolve());
 * ```
 */
export interface MinimalExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Minimal `PeriodicSyncEvent` shape — accepted by `createPeriodicSyncHandler`.
 *
 * @example
 * ```ts
 * import type { MinimalPeriodicSyncEvent } from '@lostgradient/weft/service-worker';
 * declare const event: MinimalPeriodicSyncEvent;
 * if (event.tag === 'weft-timers') event.waitUntil(Promise.resolve());
 * ```
 */
export interface MinimalPeriodicSyncEvent extends MinimalExtendableEvent {
  tag: string;
}

/**
 * Normalize a service-worker path prefix: append a trailing slash if
 * missing. The default is `'/weft/'`.
 *
 * @example
 * ```ts
 * import { normalizePathPrefix } from '@lostgradient/weft/service-worker';
 * normalizePathPrefix('/weft'); // '/weft/'
 * normalizePathPrefix(undefined); // '/weft/'
 * ```
 */
export function normalizePathPrefix(pathPrefix: string | undefined): string {
  const value = pathPrefix ?? DEFAULT_PATH_PREFIX;
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Build a delegated request with the path prefix stripped. Returns `null`
 * if the request's pathname doesn't start with `pathPrefix` (caller should
 * pass-through, not call `respondWith`). Single source of truth for the
 * URL-stripping convention shared by `createFetchHandler` and
 * `setupServiceWorker`.
 *
 * @example
 * ```ts
 * import { buildDelegatedRequest, normalizePathPrefix } from '@lostgradient/weft/service-worker';
 * declare const event: { request: Request; respondWith(r: Response | Promise<Response>): void };
 * const delegated = buildDelegatedRequest(event, normalizePathPrefix('/weft/'));
 * void delegated;
 * ```
 */
export function buildDelegatedRequest(
  event: MinimalFetchEvent,
  pathPrefix: string,
): Request | null {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(pathPrefix)) return null;
  // Strip the prefix to produce the path that handleRequest expects.
  // e.g. /weft/v1/health -> /v1/health
  const strippedPathname = '/' + url.pathname.slice(pathPrefix.length);
  const strippedUrl = new URL(strippedPathname, url.origin);
  strippedUrl.search = url.search;
  const request = event.request.clone();
  // Preserve the original Request contract, including streamed bodies,
  // abort signals, credentials, redirect mode, and browser-required duplex.
  return new Request(strippedUrl.toString(), request);
}
