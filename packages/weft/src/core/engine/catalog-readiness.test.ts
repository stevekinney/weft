import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { RegistryManifestLimitError } from '../registry-workflow-manifest.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { ensureWorkflowCatalogReady } from './catalog-readiness.ts';
import { EngineDisposedError } from './errors.ts';
import { Engine } from './index.ts';
import { getInternals, getWorkflowCatalog } from './internals.ts';

function noopWorkflow(name: string, version = '1.0.0') {
  return workflow({ name, version }).execute(async function* (_ctx: WorkflowContext) {
    return 'done';
  });
}

describe('ensureWorkflowCatalogReady', () => {
  it('memoizes so two concurrent callers await one drain', async () => {
    await using storage = new MemoryStorage();
    const originalScan = storage.scan.bind(storage);
    let scanCalls = 0;
    storage.scan = (prefix, options) => {
      scanCalls += 1;
      return originalScan(prefix, options);
    };
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('alpha'));

    await Promise.all([ensureWorkflowCatalogReady(engine), ensureWorkflowCatalogReady(engine)]);

    // Restoring scans both `catalog-entry:` and `catalog-active:` once —
    // two scans total, not four, proving the concurrent callers shared one
    // drain rather than each restoring independently.
    expect(scanCalls).toBe(2);
    expect(getWorkflowCatalog(engine).resolveActive('alpha')?.generation).toBe(1);
  });

  it('re-arms and drains a workflow registered after the first drain completed', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('alpha'));
    await ensureWorkflowCatalogReady(engine);
    expect(getWorkflowCatalog(engine).resolveActive('beta')).toBeUndefined();

    engine.register(noopWorkflow('beta'));
    await ensureWorkflowCatalogReady(engine);

    expect(getWorkflowCatalog(engine).resolveActive('beta')?.generation).toBe(1);
  });

  it('does not re-scan storage on a re-arm: only the newly pending name is processed', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('alpha'));
    await ensureWorkflowCatalogReady(engine);

    const originalScan = storage.scan.bind(storage);
    let scanCalls = 0;
    storage.scan = (prefix, options) => {
      scanCalls += 1;
      return originalScan(prefix, options);
    };
    engine.register(noopWorkflow('beta'));
    await ensureWorkflowCatalogReady(engine);

    expect(scanCalls).toBe(0);
  });

  it('surfaces RegistryManifestLimitError from an oversized contract at the awaiting call site', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    // `workflowVersion` over MAX_CONTRACT_IDENTIFIER_BYTES (512 bytes).
    engine.register(noopWorkflow('oversized', 'v'.repeat(600)));

    await expect(ensureWorkflowCatalogReady(engine)).rejects.toThrow(RegistryManifestLimitError);
  });

  it('the fast path returns synchronously-resolved when nothing is pending and the catalog is restored', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('alpha'));
    await ensureWorkflowCatalogReady(engine);

    expect(getInternals(engine).catalogRestored).toBe(true);
    expect(getInternals(engine).pendingCatalogInstalls).toHaveLength(0);
    await expect(ensureWorkflowCatalogReady(engine)).resolves.toBeUndefined();
  });

  it('re-queues the failing name AND every name behind it in the drain order, rather than dropping them, when one manifest build fails mid-drain', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    // `oversized` is registered first so it is drained before `good` — a
    // manifest-build failure on `oversized` must not silently drop `good`,
    // which is still queued behind it, from `pendingCatalogInstalls`.
    engine.register(noopWorkflow('oversized', 'v'.repeat(600)));
    engine.register(noopWorkflow('good'));

    await expect(ensureWorkflowCatalogReady(engine)).rejects.toThrow(RegistryManifestLimitError);

    // Neither name was dropped: both are still queued for the next attempt,
    // and `isWorkflowCatalogReady` must not report a false "ready" with
    // `good` silently lost.
    expect(getInternals(engine).pendingCatalogInstalls).toEqual(['oversized', 'good']);
    expect(getWorkflowCatalog(engine).resolveActive('good')).toBeUndefined();

    // Simulate `oversized` being unregistered before the retry (the
    // documented "unregistered between being queued and this drain running"
    // path already handled inside the drain loop) so the next drain can
    // make it past `oversized` and reach `good`.
    getInternals(engine).registrations.delete('oversized');

    await ensureWorkflowCatalogReady(engine);

    expect(getWorkflowCatalog(engine).resolveActive('good')?.generation).toBe(1);
    expect(getInternals(engine).pendingCatalogInstalls).toHaveLength(0);
  });

  it('rejects with EngineDisposedError when the engine was disposed before a pending drain runs', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('alpha'));
    engine[Symbol.dispose]();

    await expect(ensureWorkflowCatalogReady(engine)).rejects.toBeInstanceOf(EngineDisposedError);
    storage[Symbol.dispose]();
  });

  it('a restart (fresh Engine instance registering against the same storage) reverts a prior manual activate() — activateRegistered is documented-intended unconditional, not a regression (WFT-11)', async () => {
    await using storage = new MemoryStorage();
    const firstProcessEngine = new Engine({ storage, backgroundTasks: 'manual' });
    firstProcessEngine.register(noopWorkflow('alpha'));
    await ensureWorkflowCatalogReady(firstProcessEngine);
    const catalog = getWorkflowCatalog(firstProcessEngine);
    const registeredPointer = catalog.resolveActive('alpha');
    expect(registeredPointer).toBeDefined();

    // A manual `engine.workflows.activate()`-style candidate activation
    // (exercised directly against the catalog here, same as
    // `engine-workflows-namespace.test.ts` exercises through the public
    // surface): a docs-only variant, same contractHash, different revision.
    const registeredRecord = await catalog.resolveEntry('alpha', registeredPointer!.revision);
    const manualCandidate = await catalog.install({
      manifestVersion: 1,
      name: 'alpha',
      workflowVersion: '1.0.0',
      revision: 'manually-activated-revision',
      contractHash: registeredRecord!.manifest.contractHash,
      contract: registeredRecord!.manifest.contract,
    });
    const manualResult = await catalog.activateCandidate('alpha', manualCandidate.manifest, {
      expectedGeneration: registeredPointer!.generation,
      policy: { requireExactRevision: false },
    });
    expect(manualResult.applied).toBe(true);
    expect(catalog.resolveActive('alpha')?.revision).toBe('manually-activated-revision');
    firstProcessEngine[Symbol.dispose]();

    // Simulate a restart: a FRESH `Engine` instance, sharing the same
    // durable storage, registering the same workflow. Its own
    // `workflowDefinitionsByName` starts empty, so `register()` is not the
    // idempotent no-op path — it commits and queues a fresh catalog
    // install, which drains through `activateRegistered`'s unconditional
    // path and reverts the manual activation back to the registered
    // definition's own revision. Documented intended behavior (see
    // `engine-workflows-namespace.ts`'s module doc), not a bug.
    const restartedEngine = new Engine({ storage, backgroundTasks: 'manual' });
    restartedEngine.register(noopWorkflow('alpha'));
    await ensureWorkflowCatalogReady(restartedEngine);

    expect(getWorkflowCatalog(restartedEngine).resolveActive('alpha')?.revision).toBe(
      registeredPointer!.revision,
    );
    restartedEngine[Symbol.dispose]();
  });
});
