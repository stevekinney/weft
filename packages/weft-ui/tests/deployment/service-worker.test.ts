/**
 * Service Worker deployment-mode integration test (plan §3.3, T9.1).
 *
 * No real browser Service Worker is needed: `setupServiceWorker()`'s fetch
 * listener is a thin wrapper that strips the path prefix and calls
 * `handleRequest(request, engine)` (`@lostgradient/weft`'s
 * `src/service-worker/setup.ts`) — so a hand-built fake scope satisfying only
 * `{ addEventListener }` (the one method the setup helper calls) reaches the
 * exact same code a real Service Worker would run. Storage is
 * `IndexedDBStorage` backed by `fake-indexeddb` (via the constructor's
 * `runtime` param, not the `fake-indexeddb/auto` global side effect — keeps
 * this file self-contained without touching the shared `tests/setup.ts`
 * preload), matching what `setupServiceWorker()` itself defaults to in a
 * browser/Service Worker scope (plan §3.3).
 *
 * **The weft#845 adoption (0.16.0).** Earlier revisions of this file
 * documented a confirmed gap: `SetupServiceWorkerOptions` had no way to pass
 * `HandlerOptions` (`fleetEventFeed`, `workflowEventFeed`, `authContext`)
 * through to `handleRequest`, so every request through the real SW entry
 * point was unconditionally anonymous and fleet SSE threw
 * `UnsupportedTransport` before streaming was ever reached. Weft 0.16.0
 * closes it: `setupServiceWorker({ handlerOptions })` accepts the
 * `ServiceWorkerHandlerOptions` subset (`authContext`, `workflowEventFeed`,
 * `fleetEventFeed`, `acquireWorkflowStreamConnection`). The suite below
 * proves both sides through the REAL `setupServiceWorker` fetch listener:
 *   1. Omitting `handlerOptions` keeps the old default — anonymous
 *      principal, so a `scoped` operation (fleet SSE, `events:read`) 401s.
 *   2. Passing `handlerOptions: { authContext, fleetEventFeed }` makes the
 *      same fleet SSE request stream — genuinely incrementally (a
 *      live-appended event arrives over the open Response body without the
 *      stream ending), which also re-proves the plan §3.3 "handleRequest
 *      does not buffer" verification through the public SW entry point
 *      rather than a direct `handleRequest` call.
 */
import { workflow } from '@lostgradient/weft';
import { principalFromApiKey } from '@lostgradient/weft/mcp';
import { createFleetEventFeed, type FleetEventFeed } from '@lostgradient/weft/server/handler';
import { setupServiceWorker, type MinimalFetchEvent } from '@lostgradient/weft/service-worker';
import { IndexedDBStorage } from '@lostgradient/weft/storage/indexeddb';
import { describe, expect, it } from 'bun:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

const pingWorkflow = workflow({ name: 'deployment-sw-ping' }).execute(async function* (
  _ctx,
  input: { message: string },
) {
  yield;
  return { echoed: input.message };
});

function createIndexedDbStorage(): { storage: IndexedDBStorage; cleanup: () => void } {
  const databaseName = `weft-console-sw-test-${crypto.randomUUID()}`;
  const storage = new IndexedDBStorage(databaseName, { indexedDB, IDBKeyRange });
  return {
    storage,
    cleanup: () => {
      storage[Symbol.dispose]();
      try {
        indexedDB.deleteDatabase(databaseName);
      } catch {
        // Best-effort cleanup; ignore errors (mirrors weft's own
        // `storage-backends.test-support.ts` IndexedDBStorage fixture).
      }
    },
  };
}

interface FakeServiceWorkerScope {
  addEventListener(type: string, listener: (event: MinimalFetchEvent) => void): void;
}

/**
 * Minimal fake `self` scope + fetch-event dispatcher. Mirrors the technique
 * weft's own `src/service-worker/setup.test.ts` uses: install a fake `self`
 * global (the one thing `setupServiceWorker` reads to find the SW scope),
 * capture the listener it registers for `'fetch'`, and drive it by calling
 * that listener with an object satisfying `MinimalFetchEvent`
 * (`{ request, respondWith }`) — no real browser or `ServiceWorkerGlobalScope`
 * involved.
 */
function createFakeServiceWorkerScope(): {
  scope: FakeServiceWorkerScope;
  dispatchFetch: (request: Request) => Promise<Response>;
} {
  let fetchListener: ((event: MinimalFetchEvent) => void) | null = null;
  const scope: FakeServiceWorkerScope = {
    addEventListener(type, listener) {
      if (type === 'fetch') fetchListener = listener;
    },
  };
  return {
    scope,
    dispatchFetch(request) {
      if (fetchListener === null) {
        throw new Error('no fetch listener registered — setupServiceWorker did not attach one');
      }
      return new Promise<Response>((resolve, reject) => {
        fetchListener?.({
          request,
          respondWith: (response) => {
            return Promise.resolve(response).then(resolve, reject);
          },
        });
      });
    },
  };
}

/**
 * Installs a fake `self` global for the duration of `run()`, then restores
 * whatever was there before. No registry reset is needed afterward:
 * `setupServiceWorker`'s "already initialized" guard is a `WeakMap` keyed by
 * the scope object's own identity (`src/service-worker/setup.ts`'s
 * `setupRegistry`), and `resetSetupServiceWorkerRegistry` — the test-only
 * helper weft's own suite uses to clear it — is not re-exported from the
 * public `@lostgradient/weft/service-worker` barrel. Each test below creates
 * its own fresh scope object via `createFakeServiceWorkerScope()`, so there is
 * no shared identity to reset in the first place.
 */
async function withFakeSelf<T>(scope: FakeServiceWorkerScope, run: () => Promise<T>): Promise<T> {
  const previous = (globalThis as { self?: unknown }).self;
  (globalThis as { self?: unknown }).self = scope;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete (globalThis as { self?: unknown }).self;
    else (globalThis as { self?: unknown }).self = previous;
  }
}

describe('Service Worker mode — REST via a real setupServiceWorker() fetch listener', () => {
  it('serves a workflow read through IndexedDBStorage, end to end, through the fake SW fetch boundary', async () => {
    const { scope, dispatchFetch } = createFakeServiceWorkerScope();
    const { storage, cleanup } = createIndexedDbStorage();

    try {
      await withFakeSelf(scope, async () => {
        const setup = await setupServiceWorker({
          storage,
          register: (engine) => {
            engine.register(pingWorkflow);
          },
        });

        const handle = await setup.engine.start('deployment-sw-ping', { message: 'hello' });

        // `pathPrefix` defaults to `/weft/`; the fetch listener strips it
        // before delegating, so `/weft/v1/workflows/:id` reaches
        // `handleRequest` as `/v1/workflows/:id` — `weft.workflows.get`'s
        // REST binding (`access: 'public'`, confirmed in
        // `src/server/operations/get-workflow.ts`).
        const response = await dispatchFetch(
          new Request(`https://sw-host.example/weft/v1/workflows/${handle.id}`),
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as { id: string; type: string; status: string };
        expect(body.id).toBe(handle.id);
        expect(body.type).toBe('deployment-sw-ping');
        expect(typeof body.status).toBe('string');
      });
    } finally {
      cleanup();
    }
  });

  it('stays anonymous without handlerOptions — a scoped operation (fleet SSE) 401s', async () => {
    const { scope, dispatchFetch } = createFakeServiceWorkerScope();
    const { storage, cleanup } = createIndexedDbStorage();

    try {
      await withFakeSelf(scope, async () => {
        await setupServiceWorker({ storage });

        const response = await dispatchFetch(
          new Request('https://sw-host.example/weft/v1/events/sse', {
            headers: { Accept: 'text/event-stream' },
          }),
        );

        // `weft.events.sse` declares `access: { kind: 'scoped', scopes: {
        // anyOf: ['events:read'] } }` (`src/server/operations/fleet-events-sse.ts`).
        // With no `handlerOptions`, `buildFetchListener` still delegates
        // with no `authContext`, so `authContextToPrincipal(undefined)`
        // resolves to `anonymousPrincipal()` — the pre-0.16 default is
        // unchanged for callers that omit the option.
        expect(response.status).toBe(401);
      });
    } finally {
      cleanup();
    }
  });
});

function operatorPrincipalAuthContext() {
  return {
    method: 'api-key' as const,
    principal: principalFromApiKey({ subject: 'sw-deployment-test', scopes: ['events:read'] }),
  };
}

describe('Service Worker mode — authenticated fleet SSE via handlerOptions (weft#845, 0.16.0)', () => {
  it('streams a live-appended fleet event incrementally through the real setupServiceWorker fetch listener', async () => {
    const { scope, dispatchFetch } = createFakeServiceWorkerScope();
    const { storage, cleanup } = createIndexedDbStorage();
    const fleetEventFeed: FleetEventFeed = createFleetEventFeed(storage);
    const abortController = new AbortController();

    try {
      const response = await withFakeSelf(scope, async () => {
        await setupServiceWorker({
          storage,
          handlerOptions: {
            authContext: operatorPrincipalAuthContext(),
            fleetEventFeed,
          },
        });

        // The fleet feed's `subscribe()` never completes on its own for a
        // live stream with no persisted backlog (only `close()`/abort ends
        // it) — if the SW path buffered the whole SSE body before
        // responding, this `await` could never resolve. It resolving at
        // all, well inside the test's timeout, is itself part of the
        // streaming proof; the incremental reads below are the rest of it.
        return dispatchFetch(
          new Request('https://sw-host.example/weft/v1/events/sse', {
            headers: { Accept: 'text/event-stream' },
            signal: abortController.signal,
          }),
        );
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      if (response.body === null) throw new Error('expected a streamed body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';

      async function readUntil(predicate: (text: string) => boolean): Promise<void> {
        while (!predicate(buffered)) {
          const { done, value } = await reader.read();
          if (done) throw new Error('stream closed before the expected frame arrived');
          buffered += decoder.decode(value, { stream: true });
        }
      }

      // Empty storage → replay is immediately complete; wait for that ready
      // ping so the append below is unambiguously a *live* delivery, not
      // something racing the replay-to-live handoff.
      await readUntil((text) => text.includes('"replayComplete":true'));

      const appended = await fleetEventFeed.append({
        kind: 'workflow:started',
        workflowId: 'sw-deployment-live-event',
        emittedAtMs: Date.now(),
        payload: { workflowId: 'sw-deployment-live-event' },
      });

      await readUntil((text) => text.includes(`id: ${appended.cursor}`));
      expect(buffered).toContain('event: workflow:started');
      expect(buffered).toContain('"workflowId":"sw-deployment-live-event"');

      await reader.cancel();
    } finally {
      abortController.abort();
      fleetEventFeed.dispose();
      cleanup();
    }
  });
});
