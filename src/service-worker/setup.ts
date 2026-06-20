/**
 * One-call Service Worker bootstrap for Weft.
 *
 * Wires up storage, engine, scheduler, and the four event listeners
 * (`install`, `activate`, `fetch`, `periodicsync`) in a single async call.
 * Use this when your Service Worker file calls `register` from inside the
 * helper. Use the lower-level `createFetchHandler` / `createPeriodicSyncHandler`
 * / `createLifecycleHandlers` factories when you've already registered
 * workflows synchronously and want explicit listener attachment.
 *
 * @module service-worker/setup
 */

import { Engine } from '../core/engine';
import { handleRequest } from '../server/handler';
import { IndexedDBStorage } from '../storage/indexeddb';
import type { Storage as WeftStorage } from '../storage/interface';
import { ServiceWorkerScheduler } from './scheduler';
import {
  buildDelegatedRequest,
  DEFAULT_PERIODIC_SYNC_TAG,
  normalizePathPrefix,
  type MinimalExtendableEvent,
  type MinimalFetchEvent,
  type MinimalPeriodicSyncEvent,
} from './shared.ts';

const DEFAULT_DATABASE_NAME = 'weft';

/**
 * Options for {@link setupServiceWorker}. All fields are optional; the
 * helper supplies sensible defaults (`/weft/` path prefix, `'weft'`
 * IndexedDB database name, `'weft-timers'` periodic-sync tag).
 *
 * @example
 * ```ts
 * import { workflow } from '@lostgradient/weft';
 * import { setupServiceWorker, type SetupServiceWorkerOptions } from '@lostgradient/weft/service-worker';
 *
 * const checkout = workflow({ name: 'checkout' }).execute(async function* () {
 *   yield;
 *   return 'done';
 * });
 *
 * const options: SetupServiceWorkerOptions = {
 *   pathPrefix: '/weft/',
 *   register(engine) {
 *     engine.register(checkout);
 *   },
 * };
 * void setupServiceWorker(options);
 * ```
 */
export interface SetupServiceWorkerOptions {
  /** Path prefix for engine HTTP routing. Default: `'/weft/'`. */
  pathPrefix?: string;
  /** IndexedDB database name. Default: `'weft'`. */
  databaseName?: string;
  /** Periodic-sync tag the scheduler ticks on. Default: `'weft-timers'`. */
  periodicSyncTag?: string;
  /**
   * Pre-built engine. If provided, must use the same storage instance as
   * `options.storage` (or its own storage if `storage` is omitted).
   */
  engine?: Engine;
  /**
   * Pre-built storage instance. Must be the same `===` reference as the
   * engine's storage when both are provided.
   */
  storage?: WeftStorage;
  /**
   * Register workflows on the engine before listeners do real work.
   * Resolves before the helper returns. Rejection causes subsequent
   * fetch/periodic-sync handlers to fail-fast with explicit errors.
   */
  register?: (engine: Engine) => void | Promise<void>;
  /**
   * When `true`, calls `engine.recoverAll()` after `options.register`
   * completes and before the `ready` promise settles. Fetch and
   * periodic-sync handlers therefore block on both workflow registration
   * AND recovery before serving any traffic.
   *
   * Equivalent to calling `await engine.recoverAll()` at the end of your
   * `register` callback. Use this for the common case where you do not need
   * to pass `RecoverAllOptions` (e.g., `acknowledgeUnknownWorkflowTypes`);
   * for fine-grained control, call `engine.recoverAll(opts)` yourself inside
   * `register`.
   *
   * Defaults to `false` — no behavior change for callers that omit this option.
   */
  recover?: boolean;
}

/**
 * Result returned by {@link setupServiceWorker} once registration completes.
 *
 * @example
 * ```ts
 * import { workflow } from '@lostgradient/weft';
 * import { setupServiceWorker, type SetupServiceWorkerResult } from '@lostgradient/weft/service-worker';
 *
 * const hello = workflow({ name: 'hello' }).execute(async function* () {
 *   yield;
 *   return 'world';
 * });
 *
 * const setup: SetupServiceWorkerResult = await setupServiceWorker();
 * await setup.ready;
 * setup.engine.register(hello);
 * ```
 */
export interface SetupServiceWorkerResult {
  engine: Engine;
  storage: WeftStorage;
  scheduler: ServiceWorkerScheduler;
  /** Resolves when registration (and recovery, if `recover: true`) completes. Rejects if either threw. */
  ready: Promise<void>;
}

type SetupState =
  | { status: 'initializing'; resultPromise: Promise<SetupServiceWorkerResult> }
  | { status: 'attached'; result: SetupServiceWorkerResult }
  | { status: 'failed'; error: Error };

const setupRegistry = new WeakMap<object, SetupState>();

interface ServiceWorkerScope {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  skipWaiting?: () => Promise<void>;
  clients?: { claim?: () => Promise<void> };
}

function isServiceWorkerScope(value: unknown): value is ServiceWorkerScope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { addEventListener?: unknown };
  return typeof candidate.addEventListener === 'function';
}

function getServiceWorkerScope(): ServiceWorkerScope | null {
  if (typeof self === 'undefined') return null;
  if (!isServiceWorkerScope(self)) return null;
  return self;
}

function buildErrorResponse(error: Error): Response {
  return new Response(`Weft service worker registration failed: ${error.message}`, {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

function checkExistingState(scope: ServiceWorkerScope): Promise<SetupServiceWorkerResult> | null {
  const existing = setupRegistry.get(scope);
  if (existing === undefined) return null;
  if (existing.status === 'initializing') return existing.resultPromise;
  if (existing.status === 'attached') {
    throw new Error('setupServiceWorker already initialized in this scope.');
  }
  throw new Error(
    'setupServiceWorker previously failed in this scope. Re-evaluate the worker script to retry.',
    { cause: existing.error },
  );
}

function resolveStorageAndEngine(options: SetupServiceWorkerOptions): {
  storage: WeftStorage;
  engine: Engine;
} {
  if (options.engine !== undefined && options.storage !== undefined) {
    if (options.engine.storage !== options.storage) {
      throw new TypeError(
        'setupServiceWorker: `options.engine.storage` must be the same instance as `options.storage`. ' +
          'Mismatched storage would persist timers and checkpoints to different databases.',
      );
    }
  }
  if (options.engine !== undefined) {
    return {
      engine: options.engine,
      storage: options.storage ?? options.engine.storage,
    };
  }
  const storage =
    options.storage ?? new IndexedDBStorage(options.databaseName ?? DEFAULT_DATABASE_NAME);
  return { storage, engine: new Engine({ storage }) };
}

function buildFetchListener(
  pathPrefix: string,
  engine: Engine,
  registrationReady: Promise<void>,
): (event: MinimalFetchEvent) => void {
  // Reuses the shared `buildDelegatedRequest` helper so the URL-stripping
  // convention can't drift between `setupServiceWorker` and the lower-level
  // `createFetchHandler`. The setup-helper-specific addition is gating on
  // `registrationReady` and converting registration failures to a 503.
  return (event) => {
    const delegatedRequest = buildDelegatedRequest(event, pathPrefix);
    if (delegatedRequest === null) return;
    event.respondWith(
      registrationReady
        .then(() => handleRequest(delegatedRequest, engine))
        .catch((error: unknown) =>
          buildErrorResponse(error instanceof Error ? error : new Error(String(error))),
        ),
    );
  };
}

function attachListeners(
  scope: ServiceWorkerScope,
  pathPrefix: string,
  periodicSyncTag: string,
  engine: Engine,
  scheduler: ServiceWorkerScheduler,
  registrationReady: Promise<void>,
): void {
  const fetchListener = buildFetchListener(pathPrefix, engine, registrationReady);
  const periodicSyncListener = (event: MinimalPeriodicSyncEvent) => {
    if (event.tag !== periodicSyncTag) return;
    event.waitUntil(registrationReady.then(() => scheduler.tick()));
  };
  const installListener = (event: MinimalExtendableEvent) => {
    const skipWaitingPromise =
      typeof scope.skipWaiting === 'function' ? scope.skipWaiting.call(scope) : Promise.resolve();
    event.waitUntil(skipWaitingPromise);
  };
  const activateListener = (event: MinimalExtendableEvent) => {
    const clients = scope.clients;
    const claimPromise =
      clients !== undefined && typeof clients.claim === 'function'
        ? clients.claim.call(clients)
        : Promise.resolve();
    event.waitUntil(claimPromise);
  };
  const addEventListener = scope.addEventListener.bind(scope);
  addEventListener('install', installListener as (event: unknown) => void);
  addEventListener('activate', activateListener as (event: unknown) => void);
  addEventListener('fetch', fetchListener as (event: unknown) => void);
  addEventListener('periodicsync', periodicSyncListener as (event: unknown) => void);
}

/**
 * Bootstrap a Weft engine inside a Service Worker scope. Attaches all four
 * event listeners synchronously, then awaits `register` before any handler
 * does real work. Safe to call once per worker evaluation; concurrent calls
 * during initialization converge to the same {@link SetupServiceWorkerResult}.
 *
 * @example
 * ```ts
 * /// <reference lib="webworker" />
 * import { workflow } from '@lostgradient/weft';
 * import { setupServiceWorker } from '@lostgradient/weft/service-worker';
 *
 * const checkout = workflow({ name: 'checkout' }).execute(async function* () {
 *   yield;
 *   return 'done';
 * });
 *
 * const setup = await setupServiceWorker({
 *   register(engine) {
 *     engine.register(checkout);
 *   },
 * });
 * void setup;
 * ```
 */
export function setupServiceWorker(
  options: SetupServiceWorkerOptions = {},
): Promise<SetupServiceWorkerResult> {
  const scope = getServiceWorkerScope();
  if (scope === null) {
    return Promise.reject(
      new Error(
        'setupServiceWorker: not running inside a Service Worker scope. ' +
          'Either `self` is undefined or `self.addEventListener` is missing.',
      ),
    );
  }

  let existingResult: Promise<SetupServiceWorkerResult> | null;
  try {
    existingResult = checkExistingState(scope);
  } catch (error) {
    return Promise.reject(error);
  }
  if (existingResult !== null) return existingResult;

  let resolved: { storage: WeftStorage; engine: Engine };
  try {
    resolved = resolveStorageAndEngine(options);
  } catch (error) {
    return Promise.reject(error);
  }
  const { storage, engine } = resolved;

  const periodicSyncTag = options.periodicSyncTag ?? DEFAULT_PERIODIC_SYNC_TAG;
  const pathPrefix = normalizePathPrefix(options.pathPrefix);

  const scheduler = new ServiceWorkerScheduler({
    storage,
    onTimerFired: (entry) => engine.fireTimer(entry),
    periodicSyncTag,
  });

  async function runRegistrationAndRecovery(): Promise<void> {
    if (options.register !== undefined) {
      await options.register(engine);
    }
    if (options.recover === true) {
      await engine.recoverAll();
    }
  }
  const registrationReady: Promise<void> = Promise.resolve().then(runRegistrationAndRecovery);

  attachListeners(scope, pathPrefix, periodicSyncTag, engine, scheduler, registrationReady);

  const result: SetupServiceWorkerResult = {
    engine,
    storage,
    scheduler,
    ready: registrationReady,
  };

  const resultPromise = registrationReady.then(
    () => {
      setupRegistry.set(scope, { status: 'attached', result });
      return result;
    },
    (error: unknown) => {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      setupRegistry.set(scope, { status: 'failed', error: wrapped });
      throw wrapped;
    },
  );

  setupRegistry.set(scope, { status: 'initializing', resultPromise });
  return resultPromise;
}

/**
 * Test helper: clear the per-scope setup registry. Production code does not
 * call this. Exposed so tests can simulate fresh worker evaluations without
 * tearing down the scope itself.
 *
 * @example
 * ```ts
 * import { resetSetupServiceWorkerRegistry } from '@lostgradient/weft/service-worker';
 * declare const fakeScope: object;
 * resetSetupServiceWorkerRegistry(fakeScope);
 * ```
 */
export function resetSetupServiceWorkerRegistry(scope?: object): void {
  if (scope !== undefined) {
    setupRegistry.delete(scope);
    return;
  }
  const sw = getServiceWorkerScope();
  if (sw !== null) setupRegistry.delete(sw);
}
