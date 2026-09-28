import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { Engine } from '../engine.ts';
import { CleanupWarningEvent } from '../events.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';

type HeldCall = { kind: 'read' | 'delete' | 'commit'; key: string };

/**
 * A `MemoryStorage` that parks one armed call until the test releases it, so a
 * retention sweep can be held at an exact point while the test disposes the
 * engine underneath it. The armed call is a `get` of a key, a `delete` of a
 * key, or a purge commit (`batch` or `conditionalBatch`) deleting a key.
 * `release(error)` fails the held call instead of letting it proceed.
 */
class GatedStorage extends MemoryStorage {
  #held: HeldCall | null = null;
  #reached = Promise.withResolvers<void>();
  #release = Promise.withResolvers<void>();

  arm(held: HeldCall): void {
    this.#held = held;
  }

  get reached(): Promise<void> {
    return this.#reached.promise;
  }

  release(error?: Error): void {
    this.#held = null;
    if (error === undefined) this.#release.resolve();
    else this.#release.reject(error);
  }

  async #hold(kind: HeldCall['kind'], keys: readonly string[]): Promise<void> {
    const held = this.#held;
    if (held?.kind !== kind || !keys.includes(held.key)) return;
    this.#reached.resolve();
    await this.#release.promise;
  }

  override async get(key: string): Promise<Uint8Array | null> {
    await this.#hold('read', [key]);
    return super.get(key);
  }

  override async delete(key: string): Promise<void> {
    await this.#hold('delete', [key]);
    return super.delete(key);
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    await this.#hold('commit', deletedKeys(operations));
    return super.batch(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    await this.#hold('commit', deletedKeys(operations));
    return super.conditionalBatch(conditions, operations);
  }
}

function deletedKeys(operations: readonly BatchOperation[]): string[] {
  return operations.flatMap((operation) => (operation.type === 'delete' ? [operation.key] : []));
}

const TYPE = 'retention-sweep-disposal';
const WORKFLOW_ID = 'retention-sweep-disposal-run';

/**
 * An engine with a 1s completed-run retention and a live 10ms sweep, holding
 * one completed run that becomes purge-eligible once `clock.now` advances.
 */
async function createEngineWithCompletedRun(storage: GatedStorage) {
  const clock = { now: 5_000 };
  const engine = new Engine({
    storage,
    getNow: () => clock.now,
    retention: { completed: '1s' },
    retentionSweepInterval: '10ms',
  });
  engine.register(
    workflow({ name: TYPE }).execute(async function* () {
      return 'done';
    }),
  );
  const warnings: CleanupWarningEvent[] = [];
  engine.addEventListener(CleanupWarningEvent.type, (event) => {
    warnings.push(event);
  });
  const handle = await engine.start(TYPE, null, { id: WORKFLOW_ID });
  await handle.result();
  return { clock, engine, warnings };
}

async function holdSweepAt(storage: GatedStorage, clock: { now: number }, held: HeldCall) {
  storage.arm(held);
  clock.now += 1_500; // past the 1s retention window: the next sweep purges the run
  await storage.reached;
}

describe('retention sweep disposal', () => {
  it('registering a workflow on a disposed engine does not restart the retention sweep', () => {
    // Disposal clears the sweep interval once; nothing clears one armed after it,
    // so it would keep sweeping a disposed engine and hold the process open.
    const engine = new Engine({
      storage: new MemoryStorage(),
      retention: { completed: '1s' },
      retentionSweepInterval: '10ms',
    });
    engine[Symbol.dispose]();

    engine.register(
      workflow({ name: 'retention-sweep-disposal-late', retention: { completed: '1m' } }).execute(
        async function* () {
          return 'done';
        },
      ),
    );

    expect(getInternals(engine).retentionSweepInterval).toBeNull();
  });

  it('a sweep still scanning when the engine is disposed purges nothing afterwards and reports no cleanup warning', async () => {
    const storage = new GatedStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    // The sweep's terminal-index scan reads each candidate's state record
    // before deciding whether to purge it.
    await holdSweepAt(storage, clock, { kind: 'read', key: KEYS.workflow(WORKFLOW_ID) });
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    storage.release();
    await sweep;

    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('a sweep already collecting a purge when the engine is disposed does not commit it', async () => {
    const storage = new GatedStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    // Reading the run's attribute record is the purge's own delete-set
    // collection, after eligibility is decided and before the commit.
    await holdSweepAt(storage, clock, { kind: 'read', key: KEYS.attribute(WORKFLOW_ID) });
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    storage.release();
    await sweep;

    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('async disposal does not wait on a sweep held at a storage read', async () => {
    // Storage calls cannot be cancelled, so a read that never returns would
    // otherwise hold disposal, and the lease release after it, forever. A read
    // is safe to abandon: the sweep checks for disposal before any write.
    const storage = new GatedStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, { kind: 'read', key: KEYS.workflow(WORKFLOW_ID) });
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    await engine[Symbol.asyncDispose]();

    storage.release();
    await sweep;
    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('async disposal after a synchronous disposal does not wait on a sweep held at a storage read', async () => {
    const storage = new GatedStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, { kind: 'read', key: KEYS.workflow(WORKFLOW_ID) });
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    await engine[Symbol.asyncDispose]();

    storage.release();
    await sweep;
    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('async disposal waits for a purge commit the sweep had already issued', async () => {
    const storage = new GatedStorage();
    const { clock, engine } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, { kind: 'commit', key: KEYS.workflow(WORKFLOW_ID) });

    let disposalSettled = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposalSettled = true;
    });
    // The held commit is the only thing disposal can be waiting on, so nothing
    // but the release below can let it finish.
    await Bun.sleep(0);
    expect(disposalSettled).toBe(false);

    storage.release();
    await disposal;
    // The commit was issued before disposal, so it lands rather than being
    // abandoned half-way.
    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).toBeNull();
  });

  it('a purge commit that fails while async disposal waits on it is still reported', async () => {
    // Disposal silences what it caused, not a write that genuinely failed.
    const storage = new GatedStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, { kind: 'commit', key: KEYS.workflow(WORKFLOW_ID) });
    const sweep = getInternals(engine).retentionSweepInFlight;

    const disposal = engine[Symbol.asyncDispose]();
    const commitFailure = new Error('storage write failed');
    storage.release(commitFailure);
    await disposal;
    await sweep;

    expect(warnings.map(({ source, error }) => [source, error])).toEqual([
      ['retentionSweep', commitFailure],
    ]);
  });

  it('async disposal after a synchronous disposal still waits for a purge commit already issued', async () => {
    const storage = new GatedStorage();
    const { clock, engine } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, { kind: 'commit', key: KEYS.workflow(WORKFLOW_ID) });

    engine[Symbol.dispose]();
    let disposalSettled = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposalSettled = true;
    });
    await Bun.sleep(0);
    expect(disposalSettled).toBe(false);

    storage.release();
    await disposal;
    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).toBeNull();
  });

  it('async disposal waits for an orphaned-index delete the sweep had already issued', async () => {
    const storage = new GatedStorage();
    const engine = new Engine({
      storage,
      getNow: () => 5_000,
      retention: { completed: '1s' },
      retentionSweepInterval: '10ms',
    });
    const orphanIndexKey = KEYS.terminalWorkflow(1_000, 'retention-sweep-disposal-orphan');
    storage.arm({ kind: 'delete', key: orphanIndexKey });
    await storage.put(orphanIndexKey, new Uint8Array());
    await storage.reached;

    let disposalSettled = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposalSettled = true;
    });
    await Bun.sleep(0);
    expect(disposalSettled).toBe(false);

    storage.release();
    await disposal;
    expect(await storage.get(orphanIndexKey)).toBeNull();
  });

  it('a sweep read that fails after async disposal reports no cleanup warning', async () => {
    // Once async disposal has returned, a host may close its storage, failing
    // the read the abandoned sweep was still waiting on. That failure belongs
    // to work disposal already gave up on, not to a live engine.
    const storage = new GatedStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, { kind: 'read', key: KEYS.workflow(WORKFLOW_ID) });
    const sweep = getInternals(engine).retentionSweepInFlight;

    await engine[Symbol.asyncDispose]();
    storage.release(new Error('storage closed'));
    await sweep;

    expect(warnings).toEqual([]);
  });

  it('a sweep checking an orphaned terminal-index entry when the engine is disposed leaves the entry in place', async () => {
    // The scan deletes a terminal-index entry whose state record is gone. That
    // self-heal is still a storage write, so it must not land after disposal.
    const storage = new GatedStorage();
    const now = 5_000;
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: { completed: '1s' },
      retentionSweepInterval: '10ms',
    });
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event);
    });
    const orphanId = 'retention-sweep-disposal-orphan';
    const orphanIndexKey = KEYS.terminalWorkflow(1_000, orphanId); // past the 1s window
    storage.arm({ kind: 'read', key: KEYS.workflow(orphanId) });
    await storage.put(orphanIndexKey, new Uint8Array());
    await storage.reached;
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    storage.release();
    await sweep;

    expect(await storage.get(orphanIndexKey)).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('a sweep resolving a dynamic source when the engine is disposed reports no cleanup warning', async () => {
    // Disposal aborts the sweep's in-flight source load with an
    // `EngineDisposedError`. That is the engine shutting down as asked, not a
    // cleanup failure, so it must not surface as a `retentionSweep` warning.
    const storage = new MemoryStorage();
    const type = 'retention-sweep-disposal-dynamic';
    const definition = workflow({ name: type }).execute(async function* () {
      return 'done';
    });
    const manifest = await buildWorkflowManifestFromDefinition(
      copyWorkflowDefinition(type, buildRegistrationEntry(type, definition)),
      new ActivityRegistry().listDefinitions(),
    );
    const descriptor = {
      name: type,
      location: './only.ts',
      exportName: 'only' as const,
      revision: manifest.revision,
    };
    const workflowId = 'retention-sweep-disposal-dynamic-run';
    let now = 5_000;

    {
      // Seed the run from a separate engine, so the sweeping engine below has
      // the revision registered but never resolved and must load it.
      await using seedingEngine = new Engine({ storage, getNow: () => now });
      seedingEngine.registerSource(workflowSource(descriptor, async () => ({ only: definition })));
      const handle = await seedingEngine.start(type, null, { id: workflowId });
      await handle.result();
    }

    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<{ only: typeof definition }>();
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: { completed: '1s' },
      retentionSweepInterval: '10ms',
    });
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event);
    });
    engine.registerSource(
      workflowSource(descriptor, () => {
        loadStarted.resolve();
        return releaseLoad.promise;
      }),
    );

    now += 1_500;
    await loadStarted.promise;
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    await sweep;
    releaseLoad.resolve({ only: definition });

    expect(warnings).toEqual([]);
    expect(await storage.get(KEYS.workflow(workflowId))).not.toBeNull();
  });
});
