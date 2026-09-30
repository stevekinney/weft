/**
 * Eager-registered type recovery re-stamps (or refuses) `WorkflowState.revision`
 * (COR-13). Every case restarts a fresh `Engine` on the same `MemoryStorage`
 * with a redeployed eager definition and drives `resume()` / `recoverAll()`.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { z } from 'zod';
import { WORKFLOW_CATALOG_KEYS } from '../../storage/catalog-keys.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { OWNERSHIP_CLAIM_KEYS } from '../../storage/ownership-keys.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';

import { decode, encode } from '../codec.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { VersionMismatchError } from '../versioning.ts';
import { ensureWorkflowCatalogReady } from './catalog-readiness.ts';
import { getWorkflowRevisionDiagnostics } from './catalog-removal.ts';
import { ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING, Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { prepareResumeState } from './lifecycle/persist.ts';
import { restampWorkflowRevision } from './lifecycle/resume-revision-restamp.ts';
import { EagerRecoveryRevisionRefusedError } from './revision-errors.ts';

const TYPE = 'eager-restamp';

type Variant = 'a' | 'b' | 'incompatible' | 'version-bump';

function definitionFor(variant: Variant) {
  const body = async function* (ctx: WorkflowContext) {
    const value = yield* ctx.waitForSignal<string>('continue');
    yield* ctx.run(async function afterSignal() {
      return value;
    });
    return `done:${value}`;
  };
  switch (variant) {
    case 'a':
      return workflow({ name: TYPE, version: '1.0.0' }).execute(body);
    case 'b':
      return workflow({ name: TYPE, version: '1.0.0', description: 'revision-b' }).execute(body);
    case 'incompatible':
      return workflow({ name: TYPE, version: '1.0.0', outputSchema: z.string() }).execute(body);
    default:
      return workflow({ name: TYPE, version: '1.1.0' }).execute(body);
  }
}

/** Like {@link rejectionOf}, but asserts and narrows to the eager-recovery refusal. */
async function refusalOf(promise: Promise<unknown>): Promise<EagerRecoveryRevisionRefusedError> {
  const error = await rejectionOf(promise);
  if (!(error instanceof EagerRecoveryRevisionRefusedError)) {
    throw new Error(`Expected EagerRecoveryRevisionRefusedError, got ${String(error)}`, {
      cause: error,
    });
  }
  return error;
}

async function readState(storage: MemoryStorage, id: string): Promise<WorkflowState> {
  const bytes = await storage.get(KEYS.workflow(id));
  if (bytes === null) {
    throw new Error(`Expected stored workflow state for ${id}`);
  }
  return decode(bytes) as WorkflowState;
}

async function snapshot(storage: MemoryStorage, exclude: string[] = []) {
  const entries: [string, string][] = [];
  for await (const [key, value] of storage.scan('')) {
    if (!exclude.includes(key)) {
      entries.push([key, Buffer.from(value).toString('base64')]);
    }
  }
  return entries.toSorted(([left], [right]) => (left < right ? -1 : 1));
}

async function revisionOf(storage: MemoryStorage, id: string): Promise<string | undefined> {
  const state = await readState(storage, id);
  return state.revision;
}

async function statusOf(storage: MemoryStorage, id: string): Promise<string> {
  const state = await readState(storage, id);
  return state.status;
}

async function nonTerminalRuns(engine: Engine, revision: string): Promise<number> {
  const diagnostics = await getWorkflowRevisionDiagnostics(engine, TYPE, revision);
  return diagnostics.references.nonTerminalRuns;
}

/** Starts `ids` under revision A, parks them on a signal, and returns A. */
async function seedParkedRuns(storage: MemoryStorage, ids: string[]): Promise<string> {
  await using original = await Engine.create({
    storage,
    workflows: { [TYPE]: definitionFor('a') },
    recover: false,
  });
  for (const id of ids) {
    await original.start(TYPE, null, { id });
  }
  for (const id of ids) {
    await waitForCondition(async () => (await storage.get(KEYS.checkpoint(id))) !== null, {
      label: `checkpoint for ${id}`,
    });
  }
  const revision = await revisionOf(storage, ids[0]!);
  if (revision === undefined) {
    throw new Error('Expected the seeded run to carry a revision');
  }
  return revision;
}

async function redeployedEngine(storage: MemoryStorage, variant: Variant) {
  const engine = new Engine({ storage, checkpointHistory: 20 });
  engine.register(definitionFor(variant));
  await ensureWorkflowCatalogReady(engine);
  return engine;
}

async function revisionOfRedeploy(variant: Variant): Promise<string> {
  const scratch = new MemoryStorage();
  await using engine = new Engine({ storage: scratch });
  engine.register(definitionFor(variant));
  await engine.start(TYPE, null, { id: 'probe' });
  await waitForCondition(async () => (await scratch.get(KEYS.checkpoint('probe'))) !== null, {
    label: 'probe checkpoint',
  });
  return (await revisionOf(scratch, 'probe'))!;
}

describe('eager-type recovery revision policy (COR-13)', () => {
  it('re-stamps a compatible redeploy and attributes post-recovery checkpoints to the new revision', async () => {
    const storage = new MemoryStorage();
    const revisionA = await seedParkedRuns(storage, ['restamp-run']);
    const revisionB = await revisionOfRedeploy('b');
    expect(revisionB).not.toBe(revisionA);

    await using engine = await redeployedEngine(storage, 'b');
    expect(await nonTerminalRuns(engine, revisionA)).toBe(1);

    const handles = await engine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['restamp-run']);
    expect(await revisionOf(storage, 'restamp-run')).toBe(revisionB);
    expect(await nonTerminalRuns(engine, revisionA)).toBe(0);
    expect(await nonTerminalRuns(engine, revisionB)).toBe(1);

    await handles[0]!.signal('continue', 'x');
    expect(await handles[0]!.result()).toBe('done:x');

    const checkpoints = await engine.listCheckpoints('restamp-run');
    const lastStep = Math.max(...checkpoints.map((checkpoint) => checkpoint.step));
    const replay = await engine.replayTo('restamp-run', lastStep);
    expect(replay?.revision).toBe(revisionB);
    // No later write reverts the re-stamp.
    expect(await revisionOf(storage, 'restamp-run')).toBe(revisionB);
  });

  it('re-stamps and reactivates a suspended run in one recovery', async () => {
    const storage = new MemoryStorage();
    await seedParkedRuns(storage, ['suspended-run']);
    const revisionB = await revisionOfRedeploy('b');
    const suspended = await readState(storage, 'suspended-run');
    suspended.status = 'suspended';
    await storage.put(KEYS.workflow('suspended-run'), encode(suspended));

    await using engine = await redeployedEngine(storage, 'b');
    await engine.resume('suspended-run');

    const persisted = await readState(storage, 'suspended-run');
    expect(persisted.status).toBe('running');
    expect(persisted.revision).toBe(revisionB);
  });

  describe('incompatible redeploy', () => {
    it('refuses resume() and rethrows from recoverAll() without writing state or invoking the hook', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['a-refused', 'b-sibling']);
      const revisionB = await revisionOfRedeploy('incompatible');

      await using engine = await redeployedEngine(storage, 'incompatible');
      const before = await snapshot(storage);

      const refusal = await refusalOf(engine.resume('a-refused'));
      expect(refusal.persistedRevision).toBe(revisionA);
      expect(refusal.registeredRevision).toBe(revisionB);
      expect(refusal.reason).toBe('incompatible');
      expect(refusal.compatibilityReasons).toContain('contract-hash-mismatch');
      expect(refusal.compatibilityReasons.length).toBeGreaterThan(0);

      const recovered: string[] = [];
      const batchRejection = await rejectionOf(
        engine.recoverAll({
          onRecoveredWorkflow: (info) => {
            recovered.push(info.workflowId);
          },
        }),
      );
      expect(batchRejection).toBeInstanceOf(EagerRecoveryRevisionRefusedError);
      expect(recovered).toEqual([]);
      expect(await snapshot(storage)).toEqual(before);
      expect(await statusOf(storage, 'b-sibling')).toBe('running');
      expect(await nonTerminalRuns(engine, revisionA)).toBe(2);
      expect(await nonTerminalRuns(engine, revisionB)).toBe(0);
    });

    it('writes nothing under workflow-lease ownership other than claim churn', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['leased']);
      await using engine = await Engine.create({
        storage,
        workflows: { [TYPE]: definitionFor('incompatible') },
        ownership: 'workflow-lease',
        recover: false,
      });
      await ensureWorkflowCatalogReady(engine as unknown as Engine);
      const exclude = [
        OWNERSHIP_CLAIM_KEYS.workflowOwnerEpoch('leased'),
        OWNERSHIP_CLAIM_KEYS.workflowOwnerHolder('leased'),
      ];
      const before = await snapshot(storage, exclude);
      expect(await rejectionOf(engine.resume('leased'))).toBeInstanceOf(
        EagerRecoveryRevisionRefusedError,
      );
      expect(await snapshot(storage, exclude)).toEqual(before);
    });

    it('does not refuse a default fork', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['fork-source-incompatible']);
      await using engine = await redeployedEngine(storage, 'incompatible');
      const fork = await engine.fork('fork-source-incompatible');
      expect(await revisionOf(storage, fork.id)).toBe(revisionA);
    });

    it('lets a default fork complete after a signal under an incompatible redeploy', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['fork-wake-incompatible']);
      await using engine = await redeployedEngine(storage, 'incompatible');
      const fork = await engine.fork('fork-wake-incompatible');
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](fork.id);
      await fork.signal('continue', 'x');
      expect(await fork.result()).toBe('done:x');
    });

    it('keeps a default fork on its original revision after a compatible redeploy', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['fork-wake-compatible']);
      await using engine = await redeployedEngine(storage, 'b');
      const fork = await engine.fork('fork-wake-compatible');
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](fork.id);
      await fork.signal('continue', 'x');
      expect(await fork.result()).toBe('done:x');
      expect(await revisionOf(storage, fork.id)).toBe(revisionA);
      expect(await revisionOf(storage, 'fork-wake-compatible')).toBe(revisionA);
    });
  });

  describe('unreadable persisted manifest', () => {
    it('refuses when the persisted catalog entry is absent', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['absent-entry']);
      await storage.delete(WORKFLOW_CATALOG_KEYS.catalogEntry(TYPE, revisionA));

      await using engine = await redeployedEngine(storage, 'b');
      const before = await snapshot(storage);
      const refusal = await refusalOf(engine.resume('absent-entry'));
      expect(refusal.reason).toBe('persisted-revision-not-installed');
      expect(await snapshot(storage)).toEqual(before);
    });

    it('propagates a corrupt catalog entry unwrapped and writes nothing', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['corrupt-entry']);

      await using engine = await redeployedEngine(storage, 'b');
      await storage.put(
        WORKFLOW_CATALOG_KEYS.catalogEntry(TYPE, revisionA),
        new Uint8Array([0xff, 0x00, 0x01]),
      );
      const before = await snapshot(storage);
      const rejection = await rejectionOf(engine.resume('corrupt-entry'));
      expect(rejection).not.toBeInstanceOf(EagerRecoveryRevisionRefusedError);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain(
        WORKFLOW_CATALOG_KEYS.catalogEntry(TYPE, revisionA),
      );
      expect((rejection as Error).message).toContain('fails closed');
      expect(await snapshot(storage)).toEqual(before);
    });
  });

  describe('no-op cases', () => {
    it('leaves a legacy run with no persisted revision untouched', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['legacy-run']);
      const legacy = (await readState(storage, 'legacy-run')) as unknown as Record<string, unknown>;
      delete legacy['revision'];
      await storage.put(KEYS.workflow('legacy-run'), encode(legacy));
      const before = await storage.get(KEYS.workflow('legacy-run'));

      await using engine = await redeployedEngine(storage, 'incompatible');
      await engine.recoverAll();

      expect(await storage.get(KEYS.workflow('legacy-run'))).toEqual(before);
    });

    it('does not write when the persisted revision equals the registered revision', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['same-revision']);
      const before = await storage.get(KEYS.workflow('same-revision'));

      await using engine = await redeployedEngine(storage, 'a');
      await engine.recoverAll();

      expect(await storage.get(KEYS.workflow('same-revision'))).toEqual(before);
    });
  });

  describe('version precedence', () => {
    it('still fails the run with VersionMismatchError by default', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['version-run']);
      await using engine = await redeployedEngine(storage, 'version-bump');

      await engine.recoverAll();

      const summary = await engine.get('version-run');
      expect(summary?.status).toBe('failed');
      expect(summary?.failureCategory).toBe('system');
      expect(summary?.error).toContain('Version mismatch');
    });

    it("rethrows VersionMismatchError under versionMismatchPolicy 'throw'", async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['version-throw']);
      await using engine = await redeployedEngine(storage, 'version-bump');

      expect(
        await rejectionOf(engine.recoverAll({ versionMismatchPolicy: 'throw' })),
      ).toBeInstanceOf(VersionMismatchError);
    });
  });

  describe('default fork', () => {
    it('pins A for a not-yet-recovered run and B for a run recovery re-stamped', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['fork-source']);
      const revisionB = await revisionOfRedeploy('b');
      await using engine = await redeployedEngine(storage, 'b');

      const beforeRecovery = await engine.fork('fork-source');
      expect(await revisionOf(storage, beforeRecovery.id)).toBe(revisionA);

      await engine.resume('fork-source');
      const afterRecovery = await engine.fork('fork-source');
      expect(await revisionOf(storage, afterRecovery.id)).toBe(revisionB);
    });
  });

  it('surfaces a lost CAS race from the dedicated re-stamp write', async () => {
    await using storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, ownership: 'lease', recover: false });
    spyOn(storage, 'conditionalBatch').mockResolvedValue(false);
    const state = { id: 'raced', type: TYPE, status: 'running', updatedAt: 0 } as WorkflowState;

    expect(
      await rejectionOf(restampWorkflowRevision(getInternals(engine), state, 'sha256:b')),
    ).toEqual(new Error('Revision re-stamp of workflow "raced" lost its CAS race.'));
  });

  describe('prepareResumeState() direct', () => {
    const checkpoint = {
      workflowId: 'unit',
      step: 0,
      version: '1',
      locals: {},
      accumulatedResults: [],
    } as never;
    const state = {
      id: 'unit',
      type: TYPE,
      revision: 'sha256:persisted',
      versionTuple: { workflowVersion: '1' },
    } as unknown as WorkflowState;
    const callbacks = {} as never;

    it("refuses with 'registered-revision-unknown' when the eager type has no registered revision", async () => {
      const internals = {
        options: { getNow: () => 0 },
        storage: new MemoryStorage(),
        registrations: new Map([[TYPE, {}]]),
        registeredCatalogRevisions: new Map<string, string>(),
        workflowCatalog: null,
      };
      const refusal = await refusalOf(
        prepareResumeState(
          internals as never,
          'unit',
          state,
          checkpoint,
          new Uint8Array(),
          { version: '1' } as never,
          callbacks,
        ),
      );
      expect(refusal.reason).toBe('registered-revision-unknown');
      expect(refusal.message).toContain('no registered revision is known');
    });

    it("refuses with 'registered-revision-unknown' when the registered revision has no catalog entry", async () => {
      const internals = {
        options: { getNow: () => 0 },
        storage: new MemoryStorage(),
        registrations: new Map([[TYPE, {}]]),
        registeredCatalogRevisions: new Map([[TYPE, 'sha256:registered']]),
        workflowCatalog: {
          resolveEntry: async (_type: string, revision: string) =>
            revision === 'sha256:persisted' ? { manifest: {}, installedAt: 0 } : undefined,
        },
      };
      const refusal = await refusalOf(
        prepareResumeState(
          internals as never,
          'unit',
          state,
          checkpoint,
          new Uint8Array(),
          { version: '1' } as never,
          callbacks,
        ),
      );
      expect(refusal.reason).toBe('registered-revision-unknown');
      expect(refusal.registeredRevision).toBe('sha256:registered');
      expect(refusal.message).toContain('"sha256:registered" could not be resolved');
      expect(refusal.message).not.toContain('no registered revision is known');
    });

    it('returns without reading registrations when the state has no revision', async () => {
      const internals = {
        options: { getNow: () => 0 },
        storage: new MemoryStorage(),
        get registrations(): never {
          throw new Error('registrations must not be read for a legacy record');
        },
      };
      const prepared = await prepareResumeState(
        internals as never,
        'unit',
        { ...state, revision: undefined } as unknown as WorkflowState,
        checkpoint,
        new Uint8Array(),
        { version: '1' } as never,
        callbacks,
      );
      expect(prepared.restampRevision).toBeUndefined();
    });
  });
});
