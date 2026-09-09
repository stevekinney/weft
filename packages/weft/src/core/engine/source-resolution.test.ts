import { beforeAll, describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { Engine } from '../engine.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { WorkflowSourceValidationError } from '../source/errors.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import { ensureWorkflowCatalogReady } from './catalog-readiness.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { EngineDisposedError } from './errors.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

const checkoutDefinition = workflow({ name: 'checkout' }).execute(async function* (
  _ctx,
  input: { orderId: string },
) {
  return { shipped: true, orderId: input.orderId };
});

const otherDefinition = workflow({ name: 'other' }).execute(async function* () {
  return undefined;
});

// `resolveWorkflowSource` compares the descriptor's expected `revision`
// against the revision actually derived from the loaded contract
// (`checkWorkflowCompatibility`'s `artifact-revision-mismatch`, per WFT-13/14
// decision 3 — the descriptor's revision is never fed into
// `buildWorkflowRevisionManifest`'s own `options.revision`). Every test
// below that expects a SUCCESSFUL resolve must register the source under
// `checkoutDefinition`'s real derived revision, computed once here.
let checkoutRevision: string;

beforeAll(async () => {
  // `checkoutDefinition`'s statically-inferred generic parameters
  // ({ orderId: string } input, etc.) are narrower than `buildRegistrationEntry`'s
  // `WorkflowDefinition` parameter's own defaulted generics — the same
  // widening a real caller gets for free by routing through `unknown`
  // first (`engine.register(definition: unknown)`), applied explicitly here.
  const definition = checkoutDefinition as WorkflowDefinition;
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  checkoutRevision = manifest.revision;
});

/**
 * Drain microtasks until `predicate()` is true or the bound is exhausted —
 * not a timer-based sleep (flagged by `verify-no-test-sleeps`), just
 * yielding the already-queued microtask queue enough turns for a promise
 * chain that has no other observable "ready" signal to advance.
 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let iteration = 0; iteration < 50 && !predicate(); iteration += 1) {
    await Promise.resolve();
  }
}

function registerCheckoutSource(
  engine: Engine,
  loadResult: () => Promise<Record<string, unknown>>,
  revision = checkoutRevision,
) {
  const loader = mock(loadResult);
  const source = workflowSource(
    { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision },
    loader,
  );
  engine.registerSource(source);
  return loader;
}

describe('engine.resolveWorkflowSource()', () => {
  it('invokes the loader exactly once across a concurrent burst of callers', async () => {
    const engine = new Engine();
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const loader = registerCheckoutSource(engine, () => deferred.promise);

    const calls = Array.from({ length: 5 }, () =>
      engine.resolveWorkflowSource('checkout', checkoutRevision),
    );
    await waitUntil(() => loader.mock.calls.length > 0);
    deferred.resolve({ checkout: checkoutDefinition });

    const results = await Promise.all(calls);
    expect(loader).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.manifest.name).toBe('checkout');
      expect(result.manifest.revision).toBe(results[0]!.manifest.revision);
    }

    engine[Symbol.dispose]();
  });

  it('never invokes an unrelated lazy source loader while resolving another', async () => {
    const engine = new Engine();
    const checkoutLoader = registerCheckoutSource(engine, async () => ({
      checkout: checkoutDefinition,
    }));
    const otherLoader = mock(async () => ({ other: otherDefinition }));
    engine.registerSource(
      workflowSource(
        { name: 'other', location: './other.ts', exportName: 'other', revision: 'r1' },
        otherLoader,
      ),
    );

    await engine.resolveWorkflowSource('checkout', checkoutRevision);

    expect(checkoutLoader).toHaveBeenCalledTimes(1);
    expect(otherLoader).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('does not re-invoke the loader on a later independent resolve for an already-installed revision', async () => {
    const engine = new Engine();
    const loader = registerCheckoutSource(engine, async () => ({ checkout: checkoutDefinition }));

    const first = await engine.resolveWorkflowSource('checkout', checkoutRevision);
    const second = await engine.resolveWorkflowSource('checkout', checkoutRevision);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second.manifest).toEqual(first.manifest);

    engine[Symbol.dispose]();
  });

  it('rejects with a synthesized Error when the abort reason is not itself an Error', async () => {
    const engine = new Engine();
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const loader = registerCheckoutSource(engine, () => deferred.promise);

    const controller = new AbortController();
    const call = engine.resolveWorkflowSource('checkout', checkoutRevision, {
      signal: controller.signal,
    });
    await waitUntil(() => loader.mock.calls.length > 0);
    controller.abort('a plain string reason, not an Error');

    await expect(call).rejects.toThrow('resolveWorkflowSource() aborted');

    deferred.resolve({ checkout: checkoutDefinition });
  });

  it('never invokes the loader when the signal is already aborted on the very first caller', async () => {
    const engine = new Engine();
    const loader = registerCheckoutSource(engine, async () => ({ checkout: checkoutDefinition }));

    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.resolveWorkflowSource('checkout', checkoutRevision, { signal: controller.signal }),
    ).rejects.toBeTruthy();
    expect(loader).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('rejects only the aborting caller while a sibling caller still resolves, and the loader is invoked once', async () => {
    const engine = new Engine();
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const loader = registerCheckoutSource(engine, () => deferred.promise);

    const controller = new AbortController();
    const aborting = engine.resolveWorkflowSource('checkout', checkoutRevision, {
      signal: controller.signal,
    });
    const sibling = engine.resolveWorkflowSource('checkout', checkoutRevision);

    // Let the shared load actually start (the loader has been invoked)
    // before aborting one caller — this is what makes it a genuine
    // abort-DURING-load, not a race that happens to preempt the load.
    await waitUntil(() => loader.mock.calls.length > 0);
    controller.abort();

    await expect(aborting).rejects.toBeTruthy();

    deferred.resolve({ checkout: checkoutDefinition });
    const siblingResult = await sibling;
    expect(siblingResult.manifest.name).toBe('checkout');
    expect(loader).toHaveBeenCalledTimes(1);

    engine[Symbol.dispose]();
  });

  it('settles an outstanding waiter with a rejection when the engine is disposed mid-flight, and a call after disposal rejects immediately without touching the loader', async () => {
    const engine = new Engine();
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const loader = registerCheckoutSource(engine, () => deferred.promise);

    const inFlight = engine.resolveWorkflowSource('checkout', checkoutRevision);
    await waitUntil(() => loader.mock.calls.length > 0);

    engine[Symbol.dispose]();

    await expect(inFlight).rejects.toBeInstanceOf(EngineDisposedError);

    const afterDispose = engine.resolveWorkflowSource('checkout', checkoutRevision);
    await expect(afterDispose).rejects.toBeInstanceOf(EngineDisposedError);
    expect(loader).toHaveBeenCalledTimes(1);

    deferred.resolve({ checkout: checkoutDefinition });
  });

  it('rejects with WorkflowSourceValidationError on a bad module, and a subsequent retry after fixing the loader succeeds', async () => {
    const engine = new Engine();
    let attempt = 0;
    const loader = registerCheckoutSource(engine, async () => {
      attempt += 1;
      return attempt === 1 ? {} : { checkout: checkoutDefinition };
    });

    await expect(engine.resolveWorkflowSource('checkout', checkoutRevision)).rejects.toBeInstanceOf(
      WorkflowSourceValidationError,
    );

    const retried = await engine.resolveWorkflowSource('checkout', checkoutRevision);
    expect(retried.manifest.name).toBe('checkout');
    expect(loader).toHaveBeenCalledTimes(2);

    const internals = getInternals(engine);
    expect(
      internals.sources.resolutionsInFlight.get('checkout')?.get(checkoutRevision),
    ).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('rejects with unregistered-source-kind for a manually-constructed handle naming an unsupported kind', async () => {
    const engine = new Engine();
    // Bypasses `workflowSource()`'s typed surface — `WorkflowSourceKind` is
    // the single literal `'module'` today, so this is only reachable via a
    // hand-built handle, exactly like `manifest-version-unsupported` in
    // `core/contract/compatibility.ts`.
    engine.registerSource({
      descriptor: {
        kind: 'bogus-kind' as never,
        name: 'checkout',
        location: './checkout.ts',
        exportName: 'checkout',
        revision: checkoutRevision,
      },
      load: async () => ({ checkout: checkoutDefinition }),
    });

    const rejection = await engine
      .resolveWorkflowSource('checkout', checkoutRevision)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(WorkflowSourceValidationError);
    expect((rejection as WorkflowSourceValidationError).reasons).toEqual([
      'unregistered-source-kind',
    ]);

    engine[Symbol.dispose]();
  });

  it('rejects with unregistered-source-kind, not a raw TypeError, for a manually-constructed handle naming an inherited property like __proto__', async () => {
    const engine = new Engine();
    // `SOURCE_RESOLVERS` is a plain object literal — a bare bracket lookup
    // (`SOURCE_RESOLVERS[descriptor.kind]`) would return an inherited
    // `Object.prototype` member for `kind: '__proto__'` instead of
    // `undefined`, skip the `resolver === undefined` guard, and then throw a
    // raw `TypeError` from `resolver(handle)` rather than the documented
    // structured rejection.
    engine.registerSource({
      descriptor: {
        kind: '__proto__' as never,
        name: 'checkout',
        location: './checkout.ts',
        exportName: 'checkout',
        revision: checkoutRevision,
      },
      load: async () => ({ checkout: checkoutDefinition }),
    });

    const rejection = await engine
      .resolveWorkflowSource('checkout', checkoutRevision)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(WorkflowSourceValidationError);
    expect((rejection as WorkflowSourceValidationError).reasons).toEqual([
      'unregistered-source-kind',
    ]);

    engine[Symbol.dispose]();
  });

  it("rejects with this caller's own abort when the signal aborts while the not-yet-installed catalog check is still in flight, without starting the loader", async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const loader = registerCheckoutSource(engine, async () => ({ checkout: checkoutDefinition }));

    // Prime catalog readiness first (a separate storage.scan-driven restore
    // path) so the gate below only ever sees the ONE storage.get call
    // `resolveCachedOrHandle`'s `catalog.resolveEntry` cache-miss path makes
    // — the exact await this test targets — not an unrelated restore read.
    await ensureWorkflowCatalogReady(engine);

    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalGet = storage.get.bind(storage);
    storage.get = async (key: string) => {
      entered.resolve();
      await gate.promise;
      return originalGet(key);
    };

    const controller = new AbortController();
    const call = engine.resolveWorkflowSource('checkout', checkoutRevision, {
      signal: controller.signal,
    });
    await entered.promise;
    // The abort lands while `resolveCachedOrHandle`'s `await
    // catalog.resolveEntry(...)` is still parked on the gated storage read —
    // before this call has even decided there is a load to share, let alone
    // started one.
    controller.abort();
    gate.resolve();

    await expect(call).rejects.toBeTruthy();
    expect(loader).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('throws a plain Error when resolving a (name, revision) that was never registerSource()-d', async () => {
    const engine = new Engine();

    await expect(engine.resolveWorkflowSource('neverRegistered', 'r1')).rejects.toThrow(
      /registerSource/,
    );

    engine[Symbol.dispose]();
  });

  it('throws the programmer-error Error for a (name, revision) durably installed by a different process, when THIS engine never called registerSource() for it', async () => {
    const storage = new MemoryStorage();
    const installer = new Engine({ storage });
    installer.register(checkoutDefinition);
    await ensureWorkflowCatalogReady(installer);
    installer[Symbol.dispose]();

    // A fresh engine sharing the same durable storage: the catalog fast
    // path would otherwise find `(checkout, checkoutRevision)` already
    // installed and return it — but this engine never called
    // `registerSource()` for that key, so it must still reject with the
    // documented programmer-error contract instead of silently succeeding
    // off a different process's install.
    const resolver = new Engine({ storage });
    await expect(resolver.resolveWorkflowSource('checkout', checkoutRevision)).rejects.toThrow(
      /registerSource/,
    );

    resolver[Symbol.dispose]();
  });

  it('rejects with WorkflowSourceValidationError when a registered pin contradicts an already-cached manifest on the fast path', async () => {
    const storage = new MemoryStorage();
    const installer = new Engine({ storage });
    const installerLoader = registerCheckoutSource(installer, async () => ({
      checkout: checkoutDefinition,
    }));
    const installed = await installer.resolveWorkflowSource('checkout', checkoutRevision);
    expect(installerLoader).toHaveBeenCalledTimes(1);
    expect(installed.manifest.workflowVersion).toBe('0.0.0');
    installer[Symbol.dispose]();

    // A second engine, sharing storage, registers its OWN handle for the
    // identical (name, revision) key but pins a `workflowVersion` the
    // already-cached manifest does not carry. The fast path must validate
    // the pin against the cached manifest — never return mismatched cached
    // data just because it happened to already be installed.
    const resolver = new Engine({ storage });
    const resolverLoader = mock(async () => ({ checkout: checkoutDefinition }));
    resolver.registerSource(
      workflowSource(
        {
          name: 'checkout',
          location: './checkout.ts',
          exportName: 'checkout',
          revision: checkoutRevision,
          workflowVersion: '9.9.9',
        },
        resolverLoader,
      ),
    );

    const rejection = await resolver
      .resolveWorkflowSource('checkout', checkoutRevision)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(WorkflowSourceValidationError);
    expect((rejection as WorkflowSourceValidationError).reasons).toEqual([
      'workflow-version-incompatible',
    ]);
    // The fast path never invokes the loader even on a pin-mismatch reject —
    // it fails from the cached manifest alone.
    expect(resolverLoader).not.toHaveBeenCalled();

    resolver[Symbol.dispose]();
  });

  it("rejects with this caller's own abort instead of returning a cached revision, when the signal aborts while the fast-path catalog read is still in flight", async () => {
    const storage = new MemoryStorage();
    const installer = new Engine({ storage });
    const installerLoader = registerCheckoutSource(installer, async () => ({
      checkout: checkoutDefinition,
    }));
    await installer.resolveWorkflowSource('checkout', checkoutRevision);
    expect(installerLoader).toHaveBeenCalledTimes(1);
    installer[Symbol.dispose]();

    // A fresh engine, sharing storage but with no in-memory catalog cache
    // of its own — its FIRST `resolveWorkflowSource()` call must actually
    // restore-scan durable storage (`ensureWorkflowCatalogReady()`) before
    // it can see the installer's entry as cached, which is the await this
    // test gates.
    const engine = new Engine({ storage });
    const loader = registerCheckoutSource(engine, async () => ({ checkout: checkoutDefinition }));

    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalScan = storage.scan.bind(storage);
    storage.scan = async function* (prefix, options) {
      entered.resolve();
      await gate.promise;
      yield* originalScan(prefix, options);
    };

    const controller = new AbortController();
    const call = engine.resolveWorkflowSource('checkout', checkoutRevision, {
      signal: controller.signal,
    });
    await entered.promise;
    // The abort lands while this call's catalog-readiness restore scan
    // (which will discover the installer's cached entry) is parked
    // mid-flight — before `resolveWorkflowSource` has decided the entry is
    // cached, let alone returned it. A cached hit must not resolve
    // successfully out from under a caller who no longer wants it.
    controller.abort();
    gate.resolve();

    await expect(call).rejects.toBeTruthy();
    // The fast path never invokes this engine's own loader either way.
    expect(loader).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('leaves internals.sources.resolved empty when the engine is disposed while catalog.install() is still in flight', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const loader = registerCheckoutSource(engine, async () => ({ checkout: checkoutDefinition }));

    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      entered.resolve();
      await gate.promise;
      return originalConditionalBatch(conditions, operations);
    };

    const inFlight = engine.resolveWorkflowSource('checkout', checkoutRevision);
    await entered.promise;
    // Disposal lands while `runSharedSourceLoad`'s `await catalog.install()`
    // is parked on the gated durable write — after the loader and
    // validation already succeeded, but before the write settles.
    engine[Symbol.dispose]();
    gate.resolve();

    await expect(inFlight).rejects.toBeInstanceOf(EngineDisposedError);
    expect(loader).toHaveBeenCalledTimes(1);

    // `disposeSourceResolutionState()` already cleared this map; the
    // shared load resuming after disposal must not repopulate it.
    const internals = getInternals(engine);
    expect(internals.sources.resolved.size).toBe(0);

    // The durable install itself still completed (a disposed engine's
    // in-memory bookkeeping is skipped, not the already-in-flight write) —
    // a fresh engine sharing storage sees it as already installed.
    const verifier = new Engine({ storage });
    verifier.registerSource(
      workflowSource(
        {
          name: 'checkout',
          location: './checkout.ts',
          exportName: 'checkout',
          revision: checkoutRevision,
        },
        async () => ({ checkout: checkoutDefinition }),
      ),
    );
    const verified = await verifier.resolveWorkflowSource('checkout', checkoutRevision);
    expect(verified.manifest.name).toBe('checkout');
    verifier[Symbol.dispose]();
  });
});
