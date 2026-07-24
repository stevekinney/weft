import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine';
import { WorkflowResumedEvent } from '../core/events.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { principalFromApiKey } from '../server/principal.ts';
import type { EventEnvelope, WorkflowEventFeed } from '../server/workflow-event-feed.ts';
import { IndexedDBStorage } from '../storage/indexeddb';
import { MemoryStorage } from '../storage/memory';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { resetSetupServiceWorkerRegistry, setupServiceWorker } from './setup.ts';

interface FakeEvent {
  request?: Request;
  tag?: string;
  respondWith?: (response: Response | Promise<Response>) => void;
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface FakeServiceWorkerScope {
  addEventListener(type: string, listener: (event: FakeEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  listeners: Map<string, Array<(event: FakeEvent) => void>>;
  skipWaitingCalls: number;
  claimCalls: number;
}

function createFakeServiceWorkerScope(): FakeServiceWorkerScope {
  const listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  const scope: FakeServiceWorkerScope = {
    listeners,
    skipWaitingCalls: 0,
    claimCalls: 0,
    addEventListener(type, listener) {
      // Real Service Worker `addEventListener` is additive. Store listeners
      // in a list so tests can verify the helper registers each event type
      // exactly once even across concurrent setup calls.
      const existing = listeners.get(type);
      if (existing === undefined) listeners.set(type, [listener]);
      else existing.push(listener);
    },
    async skipWaiting() {
      this.skipWaitingCalls++;
    },
    clients: {
      claim: async () => {
        scope.claimCalls++;
      },
    },
  };
  return scope;
}

function listenerFor(scope: FakeServiceWorkerScope, type: string): (event: FakeEvent) => void {
  const list = scope.listeners.get(type);
  if (list === undefined || list.length === 0) {
    throw new Error(`no listener attached for ${type}`);
  }
  if (list.length > 1) {
    throw new Error(`expected exactly one ${type} listener, found ${list.length}`);
  }
  return list[0]!;
}

function withFakeSelf(scope: FakeServiceWorkerScope, fn: () => Promise<void>): Promise<void> {
  const previous = (globalThis as { self?: unknown }).self;
  (globalThis as { self?: unknown }).self = scope;
  return fn().finally(() => {
    if (previous === undefined) {
      delete (globalThis as { self?: unknown }).self;
    } else {
      (globalThis as { self?: unknown }).self = previous;
    }
    resetSetupServiceWorkerRegistry(scope);
  });
}

describe('setupServiceWorker', () => {
  beforeEach(() => {
    // Each test installs a fresh fake `self` and clears any prior registry
    // entries inside `withFakeSelf`'s teardown.
  });

  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
  });

  it('attaches all four listeners synchronously before register completes', async () => {
    const scope = createFakeServiceWorkerScope();
    let registerSettled = false;
    let listenerCountAtRegisterStart = -1;

    await withFakeSelf(scope, async () => {
      const setup = setupServiceWorker({
        storage: new MemoryStorage(),
        register: async () => {
          listenerCountAtRegisterStart = scope.listeners.size;
          await new Promise((resolve) => setTimeout(resolve, 5));
          registerSettled = true;
        },
      });
      // Listeners must be attached before the helper returns its promise.
      expect(scope.listeners.size).toBe(4);
      expect(scope.listeners.has('install')).toBe(true);
      expect(scope.listeners.has('activate')).toBe(true);
      expect(scope.listeners.has('fetch')).toBe(true);
      expect(scope.listeners.has('periodicsync')).toBe(true);
      const result = await setup;
      expect(registerSettled).toBe(true);
      expect(listenerCountAtRegisterStart).toBe(4);
      result.engine[Symbol.dispose]();
    });
  });

  it('returns the same result for concurrent calls during initialization', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const first = setupServiceWorker({ storage: new MemoryStorage() });
      const second = setupServiceWorker({ storage: new MemoryStorage() });
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      // Listeners attached only once.
      expect(scope.listeners.size).toBe(4);
      a.engine[Symbol.dispose]();
    });
  });

  it('throws when called again after attached', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const first = await setupServiceWorker({ storage: new MemoryStorage() });
      await expect(setupServiceWorker({ storage: new MemoryStorage() })).rejects.toThrow(
        /already initialized/,
      );
      first.engine[Symbol.dispose]();
    });
  });

  it('rethrows registration failures and rejects subsequent calls', async () => {
    const scope = createFakeServiceWorkerScope();
    const failure = new Error('register exploded');
    await withFakeSelf(scope, async () => {
      await expect(
        setupServiceWorker({
          storage: new MemoryStorage(),
          register: async () => {
            throw failure;
          },
        }),
      ).rejects.toThrow('register exploded');
      // Subsequent call must reject with the original cause attached.
      let caught: unknown;
      try {
        await setupServiceWorker({ storage: new MemoryStorage() });
        expect.unreachable('expected throw');
      } catch (error) {
        caught = error;
      }
      expect((caught as { cause?: unknown }).cause).toBe(failure);
    });
  });

  it('rejects when engine.storage and options.storage do not match', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storageA = new MemoryStorage();
      const storageB = new MemoryStorage();
      const engine = new Engine({ storage: storageA });
      try {
        await expect(setupServiceWorker({ engine, storage: storageB })).rejects.toThrow(
          /same instance/,
        );
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('reuses the provided engine and matching storage instance', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      try {
        const setup = await setupServiceWorker({ engine, storage });
        expect(setup.engine).toBe(engine);
        expect(setup.storage).toBe(storage);
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('rejects outside a service worker scope', async () => {
    const previous = (globalThis as { self?: unknown }).self;
    delete (globalThis as { self?: unknown }).self;

    try {
      await expect(setupServiceWorker({ storage: new MemoryStorage() })).rejects.toThrow(
        /not running inside a Service Worker scope/,
      );
    } finally {
      if (previous !== undefined) {
        (globalThis as { self?: unknown }).self = previous;
      }
    }
  });

  it('routes a matching fetch through the engine after registration completes', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const setup = await setupServiceWorker({
        storage: new MemoryStorage(),
        pathPrefix: '/weft/',
        register: (engine) => {
          const hello = workflow({ name: 'hello' }).execute(async function* hello() {
            yield;
            return 'world';
          });
          engine.register(hello);
        },
      });
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      const fakeRequest = new Request('https://example.com/weft/v1/health', { method: 'GET' });
      const fakeEvent: FakeEvent = {
        request: fakeRequest,
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      };
      fetchListener(fakeEvent);
      expect(respondedWith).toBeDefined();
      const response = await respondedWith!;
      expect(response).toBeInstanceOf(Response);
      setup.engine[Symbol.dispose]();
    });
  });

  it('passes supported handler options to authenticated event streams', async () => {
    const scope = createFakeServiceWorkerScope();
    let acquireCalls = 0;
    let releaseCalls = 0;
    const envelope: EventEnvelope = {
      kind: 'workflow:started',
      workflowId: 'wf-service-worker',
      selector: 'events',
      sequence: 0,
      cursor: '0',
      emittedAtMs: 0,
      payload: { workflowId: 'wf-service-worker' },
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

    await withFakeSelf(scope, async () => {
      const setup = await setupServiceWorker({
        storage: new MemoryStorage(),
        handlerOptions: {
          authContext: {
            method: 'api-key',
            principal: principalFromApiKey({
              subject: 'service-worker',
              scopes: ['events:read'],
            }),
          },
          workflowEventFeed,
          acquireWorkflowStreamConnection: () => {
            acquireCalls += 1;
            return {
              release() {
                releaseCalls += 1;
              },
            };
          },
        },
      });
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      fetchListener({
        request: new Request('https://example.com/weft/v1/workflows/wf-service-worker/events/sse', {
          headers: { Accept: 'text/event-stream' },
        }),
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      });

      const response = await respondedWith!;
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('workflow:started');
      expect(acquireCalls).toBe(1);
      expect(releaseCalls).toBe(1);
      setup.engine[Symbol.dispose]();
    });
  });

  it('responds with an explicit error when register rejected', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      try {
        await setupServiceWorker({
          storage: new MemoryStorage(),
          register: async () => {
            throw new Error('boom');
          },
        });
      } catch {
        /* ignored — we want to exercise the error-path fetch handler */
      }
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      const fakeEvent: FakeEvent = {
        request: new Request('https://example.com/weft/v1/health'),
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      };
      fetchListener(fakeEvent);
      const response = await respondedWith!;
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toMatch(/boom/);
    });
  });

  it('runs scheduler tick when periodicsync fires for the matching tag', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const setup = await setupServiceWorker({
        storage: new MemoryStorage(),
        periodicSyncTag: 'weft-test',
      });
      const periodicListener = listenerFor(scope, 'periodicsync');
      let captured: Promise<unknown> | undefined;
      // Matching tag — should call waitUntil with a real promise.
      periodicListener({
        tag: 'weft-test',
        waitUntil(promise) {
          captured = promise;
        },
      });
      expect(captured).toBeDefined();
      await captured;
      // Non-matching tag — must not call waitUntil.
      let nonMatching: Promise<unknown> | undefined;
      periodicListener({
        tag: 'unrelated',
        waitUntil(promise) {
          nonMatching = promise;
        },
      });
      expect(nonMatching).toBeUndefined();
      setup.engine[Symbol.dispose]();
    });
  });

  it('install/activate fire skipWaiting and clients.claim', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const setup = await setupServiceWorker({ storage: new MemoryStorage() });
      const installListener = listenerFor(scope, 'install');
      const activateListener = listenerFor(scope, 'activate');
      let installPromise: Promise<unknown> | undefined;
      installListener({
        waitUntil(promise) {
          installPromise = promise;
        },
      });
      await installPromise;
      let activatePromise: Promise<unknown> | undefined;
      activateListener({
        waitUntil(promise) {
          activatePromise = promise;
        },
      });
      await activatePromise;
      expect(scope.skipWaitingCalls).toBe(1);
      expect(scope.claimCalls).toBe(1);
      setup.engine[Symbol.dispose]();
    });
  });

  it('holds fetches dispatched mid-registration until ready resolves', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      let releaseRegister: () => void = () => {};
      const setupPromise = setupServiceWorker({
        storage: new MemoryStorage(),
        register: async (engine) => {
          await new Promise<void>((resolve) => {
            releaseRegister = resolve;
          });
          const hello = workflow({ name: 'hello' }).execute(async function* hello() {
            yield;
            return 'world';
          });
          engine.register(hello);
        },
      });
      // Immediately fire a fetch matching the prefix while register is still
      // pending. The handler must call respondWith synchronously, but the
      // returned promise must not resolve until register completes.
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      fetchListener({
        request: new Request('https://example.com/weft/v1/health'),
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      });
      expect(respondedWith).toBeDefined();
      // The response promise should still be pending. Race it against a
      // very short timer to confirm.
      const racedBefore = await Promise.race([
        respondedWith!.then(() => 'response'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timer'), 10)),
      ]);
      expect(racedBefore).toBe('timer');
      // Release register; respondedWith should now settle.
      releaseRegister();
      const setup = await setupPromise;
      const response = await respondedWith!;
      expect(response).toBeInstanceOf(Response);
      setup.engine[Symbol.dispose]();
    });
  });

  it('periodic-sync waitUntil rejects when register failed', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      try {
        await setupServiceWorker({
          storage: new MemoryStorage(),
          register: async () => {
            throw new Error('register-explodes');
          },
        });
      } catch {
        /* expected */
      }
      const periodicListener = listenerFor(scope, 'periodicsync');
      let captured: Promise<unknown> | undefined;
      periodicListener({
        tag: 'weft-timers',
        waitUntil(promise) {
          captured = promise;
        },
      });
      expect(captured).toBeDefined();
      let rejected: unknown;
      try {
        await captured;
      } catch (error) {
        rejected = error;
      }
      expect((rejected as Error | undefined)?.message).toMatch(/register-explodes/);
    });
  });

  it('clears the current scope when the registry reset runs without an explicit scope', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const first = await setupServiceWorker({ storage: new MemoryStorage() });
      resetSetupServiceWorkerRegistry();
      const second = await setupServiceWorker({ storage: new MemoryStorage() });

      expect(second).not.toBe(first);

      first.engine[Symbol.dispose]();
      second.engine[Symbol.dispose]();
    });
  });
});

// ---------------------------------------------------------------------------
// recover option tests
// ---------------------------------------------------------------------------

/** Drain the microtask queue so fire-and-forget engine work settles. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const parkingWorkflow = workflow({ name: 'parking-workflow' }).execute(async function* (ctx) {
  yield* ctx.waitForSignal<string>('finish');
  return 'done';
});

/**
 * Builds a `setupServiceWorker({ recover: true })` harness whose recovery scan
 * blocks until the returned `releaseScan` latch is called. Recovery-gate tests
 * use this to prove an event surface stays pending while recovery is blocked,
 * then release the latch to let setup settle. The event-specific listener
 * wiring and assertions stay at each call site.
 */
function startBlockedRecoverySetup(): {
  releaseScan: () => void;
  setupPromise: ReturnType<typeof setupServiceWorker>;
} {
  let releaseScan: () => void = () => {};
  const scanBarrier = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });

  // Subclass MemoryStorage so scan() blocks until the latch is released.
  class BlockingStorage extends MemoryStorage {
    override async *scan(prefix: string): AsyncIterable<[string, Uint8Array]> {
      await scanBarrier;
      yield* super.scan(prefix);
    }
  }

  const setupPromise = setupServiceWorker({
    storage: new BlockingStorage(),
    recover: true,
    register(engine) {
      engine.register(parkingWorkflow);
    },
  });

  return { releaseScan, setupPromise };
}

describe('setupServiceWorker recover option', () => {
  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
  });

  it('recover:true calls recoverAll after register and before ready settles (call-order proof)', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      let registerSettled = false;
      let recoverCalledAfterRegister = false;

      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      // Spy: capture whether register had settled when recoverAll runs.
      const originalRecoverAll = engine.recoverAll.bind(engine);
      engine.recoverAll = async (...args: Parameters<typeof engine.recoverAll>) => {
        recoverCalledAfterRegister = registerSettled;
        return originalRecoverAll(...args);
      };

      try {
        const setup = await setupServiceWorker({
          engine,
          storage,
          recover: true,
          register: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            registerSettled = true;
          },
        });

        expect(recoverCalledAfterRegister).toBe(true);
        setup.engine[Symbol.dispose]();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('recover:true resumes a parked-on-signal workflow stored before this worker evaluated', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      // Phase 1: start a workflow on a first engine and let it park.
      const storage = new MemoryStorage();
      const firstEngine = new Engine({ storage });
      firstEngine.register(parkingWorkflow);
      await firstEngine.start('parking-workflow', null, { id: 'parked-1' });
      await flush();
      firstEngine[Symbol.dispose]();

      // Phase 2: a new worker evaluation (via setupServiceWorker) with recover:true.
      const setup = await setupServiceWorker({
        storage,
        recover: true,
        register(engine) {
          engine.register(parkingWorkflow);
        },
      });

      // The workflow is now live in the new engine. Signal it and confirm completion.
      await setup.engine.signal('parked-1', 'finish', 'hello');
      const handle = setup.engine.getHandle('parked-1');
      await expect(handle.result()).resolves.toBe('done');

      setup.engine[Symbol.dispose]();
    });
  });

  it('recover:false leaves a checkpointed workflow dormant', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();

      // Seed storage with a parked workflow.
      const firstEngine = new Engine({ storage });
      firstEngine.register(parkingWorkflow);
      await firstEngine.start('parking-workflow', null, { id: 'dormant-1' });
      await flush();
      firstEngine[Symbol.dispose]();

      const resumedEvents: WorkflowResumedEvent[] = [];
      const setup = await setupServiceWorker({
        storage,
        recover: false,
        register(engine) {
          engine.register(parkingWorkflow);
          engine.addEventListener(WorkflowResumedEvent.type, (event) => {
            resumedEvents.push(event);
          });
        },
      });

      await flush();

      // The workflow exists in storage but is NOT live in the new engine.
      // No WorkflowResumedEvent proves the engine did not call recoverAll().
      const storedState = await setup.engine.get('dormant-1');
      expect(storedState?.status).toBe('running');
      expect(resumedEvents).toHaveLength(0);

      setup.engine[Symbol.dispose]();
    });
  });

  it('recover omitted (default) behaves identically to recover:false', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();

      const firstEngine = new Engine({ storage });
      firstEngine.register(parkingWorkflow);
      await firstEngine.start('parking-workflow', null, { id: 'default-dormant-1' });
      await flush();
      firstEngine[Symbol.dispose]();

      const resumedEvents: WorkflowResumedEvent[] = [];
      // No recover field at all.
      const setup = await setupServiceWorker({
        storage,
        register(engine) {
          engine.register(parkingWorkflow);
          engine.addEventListener(WorkflowResumedEvent.type, (event) => {
            resumedEvents.push(event);
          });
        },
      });

      await flush();

      const storedState = await setup.engine.get('default-dormant-1');
      expect(storedState?.status).toBe('running');
      // No WorkflowResumedEvent: engine did not call recoverAll() by default.
      expect(resumedEvents).toHaveLength(0);

      setup.engine[Symbol.dispose]();
    });
  });

  it('recoverAll rejection rejects ready and makes subsequent fetch handlers return 503', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      // Make recoverAll throw.
      engine.recoverAll = async () => {
        throw new Error('storage-explodes');
      };

      let caught: unknown;
      try {
        await setupServiceWorker({ engine, storage, recover: true });
      } catch (error) {
        caught = error;
      }

      expect((caught as Error | undefined)?.message).toMatch(/storage-explodes/);

      // Fetch handler must now return 503 with the error message.
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      fetchListener({
        request: new Request('https://example.com/weft/v1/health'),
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      });
      const response = await respondedWith!;
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toMatch(/storage-explodes/);

      engine[Symbol.dispose]();
    });
  });

  it('recover:true with no register option still calls recoverAll', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      let recoverCalled = false;
      const originalRecoverAll = engine.recoverAll.bind(engine);
      engine.recoverAll = async (...args: Parameters<typeof engine.recoverAll>) => {
        recoverCalled = true;
        return originalRecoverAll(...args);
      };

      try {
        const setup = await setupServiceWorker({ engine, storage, recover: true });
        expect(recoverCalled).toBe(true);
        setup.engine[Symbol.dispose]();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('recover:true with empty storage resolves ready without error (recoverAll is a no-op)', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();
      // No prior workflows were ever started against this storage, so recoverAll
      // scans an empty keyspace and finds nothing to resume. Setup must still
      // resolve cleanly — an empty store is the steady state on first install.
      const setup = await setupServiceWorker({
        storage,
        recover: true,
        register() {
          // Intentionally register no workflows.
        },
      });
      await expect(setup.ready).resolves.toBeUndefined();
      setup.engine[Symbol.dispose]();
    });
  });

  it('recover:true with a pre-built engine calls recoverAll on that engine exactly once', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      let recoverCallCount = 0;
      const originalRecoverAll = engine.recoverAll.bind(engine);
      engine.recoverAll = async (...args: Parameters<typeof engine.recoverAll>) => {
        recoverCallCount++;
        return originalRecoverAll(...args);
      };

      try {
        const setup = await setupServiceWorker({ engine, storage, recover: true });
        expect(recoverCallCount).toBe(1);
        expect(setup.engine).toBe(engine);
        setup.engine[Symbol.dispose]();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('fetch gate waits on recoverAll when recover:true (response still pending while recovery is blocked)', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const { releaseScan, setupPromise } = startBlockedRecoverySetup();

      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      fetchListener({
        request: new Request('https://example.com/weft/v1/health'),
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      });

      // Response is still pending while scan (and thus recoverAll) is blocked.
      const racedBefore = await Promise.race([
        respondedWith!.then(() => 'response'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timer'), 10)),
      ]);
      expect(racedBefore).toBe('timer');

      // Release the scan latch; setup and response should now settle.
      releaseScan();
      const setup = await setupPromise;
      const response = await respondedWith!;
      expect(response).toBeInstanceOf(Response);
      setup.engine[Symbol.dispose]();
    });
  });

  it('periodicsync waitUntil also waits on recoverAll when recover:true', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const { releaseScan, setupPromise } = startBlockedRecoverySetup();

      const periodicListener = listenerFor(scope, 'periodicsync');
      let captured: Promise<unknown> | undefined;
      periodicListener({
        tag: 'weft-timers',
        waitUntil(promise) {
          captured = promise;
        },
      });

      // The waitUntil promise is still pending while scan is blocked.
      const racedBefore = await Promise.race([
        captured!.then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timer'), 10)),
      ]);
      expect(racedBefore).toBe('timer');

      // Release the latch.
      releaseScan();
      const setup = await setupPromise;
      await captured!;
      setup.engine[Symbol.dispose]();
    });
  });

  it('recover:true is equivalent to calling engine.recoverAll() manually inside register', async () => {
    const scope1 = createFakeServiceWorkerScope();
    const scope2 = createFakeServiceWorkerScope();

    // Both engines share the same initial checkpoint (identical storage state).
    const storageA = new MemoryStorage();
    const storageB = new MemoryStorage();

    // Seed both with the same parked workflow.
    async function seedStorage(storage: MemoryStorage, id: string): Promise<void> {
      const seedEngine = new Engine({ storage });
      seedEngine.register(parkingWorkflow);
      await seedEngine.start('parking-workflow', null, { id });
      await flush();
      seedEngine[Symbol.dispose]();
    }

    await Promise.all([seedStorage(storageA, 'equiv-a'), seedStorage(storageB, 'equiv-b')]);

    // Path A: recover:true via setupServiceWorker.
    let setupA!: Awaited<ReturnType<typeof setupServiceWorker>>;
    await withFakeSelf(scope1, async () => {
      setupA = await setupServiceWorker({
        storage: storageA,
        recover: true,
        register(engine) {
          engine.register(parkingWorkflow);
        },
      });
    });

    // Path B: manual recoverAll inside register.
    let setupB!: Awaited<ReturnType<typeof setupServiceWorker>>;
    await withFakeSelf(scope2, async () => {
      setupB = await setupServiceWorker({
        storage: storageB,
        register: async (engine) => {
          engine.register(parkingWorkflow);
          await engine.recoverAll();
        },
      });
    });

    // Both engines should have a live handle for their respective parked workflows.
    expect(setupA.engine.getHandle('equiv-a')).not.toBeNull();
    expect(setupB.engine.getHandle('equiv-b')).not.toBeNull();

    // Signal both and confirm both complete.
    await setupA.engine.signal('equiv-a', 'finish', 'hello');
    await setupB.engine.signal('equiv-b', 'finish', 'hello');

    await expect(setupA.engine.getHandle('equiv-a').result()).resolves.toBe('done');
    await expect(setupB.engine.getHandle('equiv-b').result()).resolves.toBe('done');

    setupA.engine[Symbol.dispose]();
    setupB.engine[Symbol.dispose]();
  });

  it('recover:true with an internally-created engine (no options.engine) calls recoverAll', async () => {
    // Covers the resolveStorageAndEngine path where the helper constructs the
    // engine itself. The spy must be installed after setup returns the engine
    // reference, so we verify via end-to-end revival instead of a call spy.
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storage = new MemoryStorage();

      // Seed storage with a parked workflow using a separate engine.
      const seedEngine = new Engine({ storage });
      seedEngine.register(parkingWorkflow);
      await seedEngine.start('parking-workflow', null, { id: 'internal-engine-1' });
      await flush();
      seedEngine[Symbol.dispose]();

      // Call setupServiceWorker with only storage (no engine option) and recover:true.
      // The helper will construct the engine internally and call recoverAll() on it.
      const setup = await setupServiceWorker({
        storage,
        recover: true,
        register(engine) {
          engine.register(parkingWorkflow);
        },
      });

      // The internally-created engine must have recovered the parked workflow.
      await setup.engine.signal('internal-engine-1', 'finish', 'hello');
      await expect(setup.engine.getHandle('internal-engine-1').result()).resolves.toBe('done');

      setup.engine[Symbol.dispose]();
    });
  });

  it('recover:true with IndexedDBStorage resumes a parked workflow (fake-indexeddb harness)', async () => {
    // Covers the IndexedDBStorage code path. The test preload (tests/test-preload.ts)
    // installs fake-indexeddb globally, making IndexedDBStorage usable without a
    // real browser. A unique database name prevents cross-test state.
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const databaseName = `weft-recover-test-${crypto.randomUUID()}`;
      const storage = new IndexedDBStorage(databaseName);

      // Seed: park a workflow on the first engine backed by the fake IndexedDB.
      const seedEngine = new Engine({ storage });
      seedEngine.register(parkingWorkflow);
      await seedEngine.start('parking-workflow', null, { id: 'idb-parked-1' });
      await flush();
      seedEngine[Symbol.dispose]();

      // Recovery: new setup on the same IndexedDB database with recover:true.
      const recoveryStorage = new IndexedDBStorage(databaseName);
      const setup = await setupServiceWorker({
        storage: recoveryStorage,
        recover: true,
        register(engine) {
          engine.register(parkingWorkflow);
        },
      });

      // The workflow must be live after recovery — signal drives it to completion.
      await setup.engine.signal('idb-parked-1', 'finish', 'hello');
      await expect(setup.engine.getHandle('idb-parked-1').result()).resolves.toBe('done');

      setup.engine[Symbol.dispose]();
    });
  });
});
