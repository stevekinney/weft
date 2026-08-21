/**
 * `ownership: 'workflow-lease'` engine-level bootstrap and claim-renewal
 * lifecycle (ADR 0002): pins the ordering guarantees `ownership-bootstrap.ts`
 * itself cannot see — Gate 1/Gate 2 and claim-registry/renewal-task
 * construction running before recovery and the scheduler start on BOTH
 * `Engine.create` and `new Engine(options)` + `recoverAll()`; the renewal
 * task's independence from `startScheduler`; `backgroundTasks: 'manual'`
 * starting no interval and renewing only via `runMaintenance()`; and dispose
 * releasing every held claim, best-effort.
 *
 * Adapter-level (`renew()` result → resolve/reject) and metrics-bridging
 * coverage lives in `ownership-bootstrap.test.ts`; `'lease'`/`'none'` are
 * pinned unmodified in `lease-ownership.test.ts` and elsewhere.
 */
import { describe, expect, it } from 'bun:test';

import type { Storage, StorageCapabilities } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  CURRENT_PERSISTED_DATA_SCHEMA_VERSION,
  PERSISTED_DATA_SCHEMA_VERSION_KEY,
} from '../persisted-data-incompatible-error.ts';
import { workflow } from '../types.ts';
import { Engine, EngineDisposedError } from './index.ts';
import { getInternals } from './internals.ts';
import { OwnershipModeMismatchError } from './lease-errors.ts';
import {
  decodeOwnershipModeMarker,
  decodeWorkflowClaimHolder,
  encodeOwnershipModeMarker,
} from './workflow-claim-codec.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

/**
 * Pre-stamp the persisted-data schema-version sentinel so
 * `assertCompatiblePersistedDataVersion` (which `Engine.create` always runs
 * first, before the ownership bootstrap) short-circuits without scanning any
 * of its seven user-data prefixes. Without this, those unrelated scans would
 * pollute a `scanCalls()` count meant to prove recovery specifically never ran.
 */
async function stampCurrentSchemaVersion(storage: Storage): Promise<void> {
  await storage.put(
    PERSISTED_DATA_SCHEMA_VERSION_KEY,
    new TextEncoder().encode(String(CURRENT_PERSISTED_DATA_SCHEMA_VERSION)),
  );
}

const pingWorkflow = workflow({ name: 'ping' }).execute(async function* () {
  return 'pong';
});

async function readHolderExpiresAt(storage: Storage, workflowId: string): Promise<number | null> {
  const raw = await storage.get(KEYS.workflowOwnerHolder(workflowId));
  if (raw === null) return null;
  return decodeWorkflowClaimHolder(raw)?.expiresAt ?? null;
}

async function readHolderExists(storage: Storage, workflowId: string): Promise<boolean> {
  return (await storage.get(KEYS.workflowOwnerHolder(workflowId))) !== null;
}

function noConditionalBatchStorage(base: Storage): Storage {
  return {
    capabilities: (): StorageCapabilities => ({ ...base.capabilities(), conditionalBatch: false }),
    get: (key) => base.get(key),
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => base.scan(prefix, options),
    batch: (operations) => base.batch(operations),
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
}

/** Counts `scan()` calls — recovery's only way to enumerate running workflows. */
function withScanCounter(base: Storage): { storage: Storage; scanCalls: () => number } {
  let scanCalls = 0;
  const storage: Storage = {
    capabilities: () => base.capabilities(),
    get: (key) => base.get(key),
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => {
      scanCalls += 1;
      return base.scan(prefix, options);
    },
    batch: (operations) => base.batch(operations),
    // Spread rather than assign: under `exactOptionalPropertyTypes`, setting an
    // optional property to `undefined` is not the same as omitting the key.
    ...(base.conditionalBatch
      ? {
          conditionalBatch: (
            conditions: Parameters<NonNullable<Storage['conditionalBatch']>>[0],
            operations: Parameters<NonNullable<Storage['conditionalBatch']>>[1],
          ) => base.conditionalBatch!(conditions, operations),
        }
      : {}),
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
  return { storage, scanCalls: () => scanCalls };
}

/**
 * A storage wrapper whose FIRST `get()` of the ownership-mode-marker key —
 * Gate 2's read — parks on a caller-controlled gate before delegating to
 * `base`. Lets a test deterministically interleave a disposal or a second
 * concurrent bootstrap call at the exact point the gates are mid-flight,
 * without any wall-clock sleep. Also counts `conditionalBatch` calls whose
 * conditions name the marker key, to prove Gate 2's CAS only runs once even
 * when two callers race in.
 */
function createParkedMarkerBootstrapStorage(base: Storage): {
  storage: Storage;
  /** Resolves once the parked marker read has actually started. */
  markerReadStarted: Promise<void>;
  /** Lets the parked marker read (and everything gated behind it) proceed. */
  releaseMarkerRead: () => void;
  markerConditionalBatchCalls: () => number;
} {
  const markerKey = KEYS.ownershipModeMarker();
  let releaseMarkerRead: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseMarkerRead = resolve;
  });
  let markerReadStartedResolve: (() => void) | null = null;
  const markerReadStarted = new Promise<void>((resolve) => {
    markerReadStartedResolve = resolve;
  });
  let firstMarkerRead = true;
  let markerConditionalBatchCalls = 0;

  const storage: Storage = {
    capabilities: () => base.capabilities(),
    get: async (key) => {
      if (key === markerKey && firstMarkerRead) {
        firstMarkerRead = false;
        markerReadStartedResolve?.();
        await gate;
      }
      return base.get(key);
    },
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => base.scan(prefix, options),
    batch: (operations) => base.batch(operations),
    conditionalBatch: async (conditions, operations) => {
      if (conditions.some((condition) => condition.key === markerKey)) {
        markerConditionalBatchCalls += 1;
      }
      return base.conditionalBatch!(conditions, operations);
    },
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
  return {
    storage,
    markerReadStarted,
    releaseMarkerRead: () => releaseMarkerRead?.(),
    markerConditionalBatchCalls: () => markerConditionalBatchCalls,
  };
}

describe("Engine.create({ ownership: 'workflow-lease' })", () => {
  it('stamps the ownership-mode marker and constructs a live claim registry/renewal task before recovery', async () => {
    using storage = new MemoryStorage();

    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'workflow-lease',
    });

    const internals = getInternals(engine);
    expect(internals.workflowClaimRegistry).toBeInstanceOf(WorkflowClaimRegistry);
    expect(internals.workflowClaimRenewalTask).not.toBeNull();
    expect(internals.workflowClaimMetrics).not.toBeNull();

    const marker = await storage.get(KEYS.ownershipModeMarker());
    expect(marker).not.toBeNull();
    expect(decodeOwnershipModeMarker(marker as Uint8Array)?.mode).toBe('workflow-lease');

    await engine[Symbol.asyncDispose]();
  });

  it('a Gate 1 failure (no conditionalBatch) prevents recovery — recovery never scans storage — and rejects construction', async () => {
    const base = new MemoryStorage();
    await stampCurrentSchemaVersion(base);
    const { storage: scanCountedStorage, scanCalls } = withScanCounter(base);
    const noCasStorage = noConditionalBatchStorage(scanCountedStorage);

    await expect(
      Engine.create({
        storage: noCasStorage,
        workflows: { ping: pingWorkflow },
        ownership: 'workflow-lease',
      }),
    ).rejects.toThrow(/conditionalBatch/);

    // Recovery's only way to find running workflows is `storage.scan(...)`. A
    // Gate 1 failure that truly runs before recovery means recovery's scan
    // never happens at all.
    expect(scanCalls()).toBe(0);
    // Gate 1 fails before Gate 2 ever touches the marker key.
    expect(await base.get(KEYS.ownershipModeMarker())).toBeNull();
  });

  it('a Gate 2 mismatch prevents recovery and construction, leaving the store marker unchanged', async () => {
    using storage = new MemoryStorage();
    await stampCurrentSchemaVersion(storage);
    // A different engine already established 'lease' for this store (the
    // marker is store-wide and mode-agnostic at read time — `ownership:
    // 'lease'` does not itself write it in this stage, see this file's and
    // `ownership-bootstrap.ts`'s module docs, so this seeds it directly).
    const markerBefore = encodeOwnershipModeMarker({ mode: 'lease', establishedAt: 1_000 });
    await storage.put(KEYS.ownershipModeMarker(), markerBefore);

    const { storage: scanCountedStorage, scanCalls } = withScanCounter(storage);

    await expect(
      Engine.create({
        storage: scanCountedStorage,
        workflows: { ping: pingWorkflow },
        ownership: 'workflow-lease',
      }),
    ).rejects.toThrow(OwnershipModeMismatchError);

    expect(scanCalls()).toBe(0);
    expect(await storage.get(KEYS.ownershipModeMarker())).toEqual(markerBefore);
  });
});

describe("new Engine({ ownership: 'workflow-lease' }) + recoverAll()", () => {
  it('runs the bootstrap on the direct-construction path, before recovery proceeds', async () => {
    using storage = new MemoryStorage();
    await using engine = new Engine({
      storage,
      ownership: 'workflow-lease',
    });

    // Not yet bootstrapped at plain construction — only `recoverAll()` (or
    // `Engine.create`, or `runMaintenance()`) runs the gates.
    expect(getInternals(engine).workflowClaimRegistry).toBeNull();

    await engine.recoverAll();

    expect(getInternals(engine).workflowClaimRegistry).toBeInstanceOf(WorkflowClaimRegistry);
    expect(getInternals(engine).workflowClaimRenewalTask).not.toBeNull();
  });

  it('a gate failure on the direct-construction path rejects recoverAll() and leaves nothing assigned', async () => {
    using storage = new MemoryStorage();
    const noCasStorage = noConditionalBatchStorage(storage);
    await using engine = new Engine({
      storage: noCasStorage,
      ownership: 'workflow-lease',
    });
    engine.register(pingWorkflow);

    await expect(engine.recoverAll()).rejects.toThrow(/conditionalBatch/);

    expect(getInternals(engine).workflowClaimRegistry).toBeNull();
    expect(getInternals(engine).workflowClaimRenewalTask).toBeNull();
  });

  it('rejects with EngineDisposedError, discarding the freshly built registry, when disposal races the gates', async () => {
    const base = new MemoryStorage();
    await stampCurrentSchemaVersion(base);
    const { storage, markerReadStarted, releaseMarkerRead } =
      createParkedMarkerBootstrapStorage(base);

    const engine = new Engine({
      storage,
      ownership: 'workflow-lease',
    });

    const recoverAllPromise = engine.recoverAll();
    await markerReadStarted; // Gate 2 is mid-flight, parked on the marker read.
    engine[Symbol.dispose](); // Disposal wins the race.
    releaseMarkerRead(); // Only now do the gates (and the disposed-check after them) resolve.

    await expect(recoverAllPromise).rejects.toThrow(EngineDisposedError);
    // Nothing durable-and-per-engine was assigned: the freshly built registry
    // and renewal task were discarded rather than published on a disposed engine.
    expect(getInternals(engine).workflowClaimRegistry).toBeNull();
    expect(getInternals(engine).workflowClaimRenewalTask).toBeNull();
    base[Symbol.dispose]();
  });

  it('a concurrent recoverAll() call awaits the same in-flight bootstrap instead of racing Gate 2 twice', async () => {
    const base = new MemoryStorage();
    await stampCurrentSchemaVersion(base);
    const { storage, markerReadStarted, releaseMarkerRead, markerConditionalBatchCalls } =
      createParkedMarkerBootstrapStorage(base);

    const engine = new Engine({
      storage,
      ownership: 'workflow-lease',
    });

    const first = engine.recoverAll();
    await markerReadStarted; // the first caller is parked mid-Gate-2
    const second = engine.recoverAll(); // races in while the first is still in flight
    releaseMarkerRead();

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    // Gate 2's marker CAS ran exactly once — the second caller awaited the
    // first's in-flight bootstrap rather than attempting its own.
    expect(markerConditionalBatchCalls()).toBe(1);
    expect(getInternals(engine).workflowClaimRegistry).toBeInstanceOf(WorkflowClaimRegistry);

    await engine[Symbol.asyncDispose]();
  });

  it('rejects recoverAll() with EngineDisposedError when the engine is already disposed', async () => {
    using storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'workflow-lease',
    });
    await engine[Symbol.asyncDispose]();

    await expect(engine.recoverAll()).rejects.toThrow(EngineDisposedError);
  });
});

describe('claim renewal is independent of startScheduler', () => {
  it('constructs and can drive the renewal task even when startScheduler: false stops durable timers', async () => {
    using storage = new MemoryStorage();
    let now = 1_000_000;
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'workflow-lease',
      startScheduler: false,
      getNow: () => now,
      workflowClaimTtl: '3s',
      workflowClaimRenewInterval: '1s',
    });
    const internals = getInternals(engine);
    expect(internals.workflowClaimRenewalTask).not.toBeNull();

    const acquired = await internals.workflowClaimRegistry!.acquire('wf-1');
    expect(acquired.status).toBe('acquired');
    const expiresAtBefore = await readHolderExpiresAt(storage, 'wf-1');

    now += 1_000; // past the renew interval, still under the TTL
    const pass = await internals.workflowClaimRenewalTask!.runOnce();

    expect(pass.outcomes).toEqual([{ workflowId: 'wf-1', status: 'renewed' }]);
    const expiresAtAfter = await readHolderExpiresAt(storage, 'wf-1');
    expect(expiresAtAfter).not.toBeNull();
    expect(expiresAtAfter! > expiresAtBefore!).toBe(true);

    await engine[Symbol.asyncDispose]();
  });
});

describe("backgroundTasks: 'manual' claim renewal", () => {
  it('starts no interval and renews a held claim only via an awaited runMaintenance()', async () => {
    using storage = new MemoryStorage();
    let now = 1_000_000;

    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = (() => {
      throw new Error('manual background tasks must not create an interval');
    }) as typeof setInterval;

    try {
      await using engine = new Engine({
        storage,
        ownership: 'workflow-lease',
        backgroundTasks: 'manual',
        getNow: () => now,
        workflowClaimTtl: '3s',
        workflowClaimRenewInterval: '1s',
      });
      engine.register(pingWorkflow);

      await engine.recoverAll(); // runs the bootstrap; must not start an interval

      const internals = getInternals(engine);
      const acquired = await internals.workflowClaimRegistry!.acquire('wf-1');
      expect(acquired.status).toBe('acquired');
      const expiresAtBefore = await readHolderExpiresAt(storage, 'wf-1');

      now += 1_000; // past the renew interval; nothing renews it without a maintenance tick
      const expiresAtStillStale = await readHolderExpiresAt(storage, 'wf-1');
      expect(expiresAtStillStale).toBe(expiresAtBefore);

      await engine.runMaintenance(now); // the only thing driving renewal in manual mode

      const expiresAtAfter = await readHolderExpiresAt(storage, 'wf-1');
      expect(expiresAtAfter).not.toBeNull();
      expect(expiresAtAfter! > expiresAtBefore!).toBe(true);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});

describe('dispose releases held workflow-lease claims', () => {
  it('async dispose awaits releaseAll() and deletes the holder key', async () => {
    using storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'workflow-lease',
    });
    const internals = getInternals(engine);
    await internals.workflowClaimRegistry!.acquire('wf-1');
    await internals.workflowClaimRegistry!.acquire('wf-2');
    expect(await readHolderExists(storage, 'wf-1')).toBe(true);

    await engine[Symbol.asyncDispose]();

    expect(await readHolderExists(storage, 'wf-1')).toBe(false);
    expect(await readHolderExists(storage, 'wf-2')).toBe(false);
  });

  it('synchronous dispose fire-and-forgets releaseAll() without throwing', async () => {
    using storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'workflow-lease',
    });
    const internals = getInternals(engine);
    await internals.workflowClaimRegistry!.acquire('wf-1');

    expect(() => engine[Symbol.dispose]()).not.toThrow();

    // Fire-and-forget: give the best-effort release's microtasks a turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(await readHolderExists(storage, 'wf-1')).toBe(false);
  });

  it('a failed release during dispose does not block or reject shutdown', async () => {
    using storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'workflow-lease',
    });
    const internals = getInternals(engine);
    await internals.workflowClaimRegistry!.acquire('wf-1');

    const originalReleaseAll = WorkflowClaimRegistry.prototype.releaseAll;
    WorkflowClaimRegistry.prototype.releaseAll = async () => {
      throw new Error('storage unavailable during release');
    };
    try {
      await expect(engine[Symbol.asyncDispose]()).resolves.toBeUndefined();
    } finally {
      WorkflowClaimRegistry.prototype.releaseAll = originalReleaseAll;
    }
  });
});
