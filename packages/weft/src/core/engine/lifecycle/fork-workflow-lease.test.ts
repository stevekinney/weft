/**
 * COR-2635: `engine.fork` under `ownership: 'workflow-lease'`, Bureau's default posture.
 *
 * A fork creates a new workflow id. Under `workflow-lease` every workflow-scoped write is fenced on
 * that workflow's own claim epoch, so the fork's create batch has to acquire the fork id's claim in
 * the same atomic batch (as `start()` does), never fence on a claim nothing has taken. These tests
 * pin that on real engines sharing one `MemoryStorage`: a fork of a settled run completes, a fork
 * onto another installed revision completes, a fork of a run another engine holds leaves that
 * engine's claim byte-for-byte alone, a fork whose new id is claimed by someone else between its
 * read and its commit writes nothing, a lost catalog race is still reported as the revision race,
 * and a fork whose launch fails after its commit gives its claim back.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import {
  MemoryStorage,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from "../../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../../storage/keys.ts';
import { ActivityRegistry } from '../../activity-registry.ts';
import { buildWorkflowManifestFromDefinition } from '../../registry-workflow-manifest.ts';
import { workflowSource } from '../../source/index.ts';
import { activity, workflow, type WorkflowContext, type WorkflowDefinition } from '../../types.ts';
import { copyWorkflowDefinition } from '../construction.ts';
import {
  ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING,
  Engine,
  WeftWorkflowClaimLostWarning,
  WorkflowClaimUnavailableError,
} from '../index.ts';
import { getInternals } from '../internals.ts';
import { EngineDeposedError } from '../lease-errors.ts';
import { buildRegistrationEntry } from '../registration.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { decodeWorkflowClaimHolder } from '../workflow-claim-codec.ts';
import { WorkflowClaimRegistry } from '../workflow-claim-registry.ts';

const step = activity({ name: 'step', execute: async () => 1 });

/** Two steps, then settles: the fork of a finished run the issue reproduces. */
const twoSteps = workflow({ name: 'fork-lease-two-steps' })
  .activities({ step })
  .execute(async function* (ctx) {
    const first = yield* ctx.run(step, {});
    const second = yield* ctx.run(step, {});
    return first + second;
  });

/** One step, then parks on a signal: a source another engine is still driving. */
const parked = workflow({ name: 'fork-lease-parked' })
  .activities({ step })
  .execute(async function* (ctx) {
    const first = yield* ctx.run(step, {});
    const go = yield* ctx.waitForSignal<string>('go');
    return `${String(first)}-${go}`;
  });

const workflows = { [twoSteps.name]: twoSteps, [parked.name]: parked };

const leaseOptions = {
  ownership: 'workflow-lease',
  workflowClaimTtl: '1m',
  workflowClaimRenewInterval: '5s',
  // No renewal tick, so the holder bytes a test compares change only through a write it makes.
  backgroundTasks: 'manual',
} as const;

function leaseEngine(storage: Storage) {
  return Engine.create({ storage, workflows, ...leaseOptions });
}

/** Collect every `WeftWorkflowClaimLostWarning` emitted while `body` runs. */
async function collectClaimLostWarnings(body: () => Promise<void>): Promise<string[]> {
  // Read at the emit call itself, which is synchronous, rather than from the `warning` event a
  // later turn delivers: nothing has to be waited for once `body` settles.
  const emitWarning = spyOn(process, 'emitWarning');
  try {
    await body();
  } finally {
    emitWarning.mockRestore();
  }
  return emitWarning.mock.calls
    .map(([warning]) => warning)
    .filter((warning) => warning instanceof WeftWorkflowClaimLostWarning)
    .map((warning) => warning.workflowId);
}

async function holderEngineId(storage: Storage, workflowId: string): Promise<string | null> {
  const raw = await storage.get(KEYS.workflowOwnerHolder(workflowId));
  return raw === null ? null : (decodeWorkflowClaimHolder(raw)?.engineId ?? null);
}

/** The id a fork's create batch writes: the one `wf:<id>` record whose state says it was forked. */
function forkIdOf(operations: BatchOperation[], sourceId: string): string | undefined {
  for (const operation of operations) {
    if (operation.type !== 'put') continue;
    if (operation.key === KEYS.workflow(sourceId)) continue;
    const candidate = operation.key.slice('wf:'.length);
    if (operation.key === KEYS.workflow(candidate) && !candidate.includes(':')) return candidate;
  }
  return undefined;
}

/** A storage that runs `beforeForkCommit` once, right before the fork's create batch reaches the store. */
function interceptForkCommit(
  base: MemoryStorage,
  sourceId: string,
  beforeForkCommit: (forkId: string) => Promise<void>,
): Storage {
  let fired = false;
  return {
    capabilities: () => base.capabilities(),
    get: (key) => base.get(key),
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => base.scan(prefix, options),
    batch: (operations) => base.batch(operations),
    has: (key) => base.has(key),
    deletePrefix: (prefix) => base.deletePrefix(prefix),
    async conditionalBatch(
      conditions: ConditionalBatchCondition[],
      operations: BatchOperation[],
    ): Promise<boolean> {
      const forkId = forkIdOf(operations, sourceId);
      const isForkCreate =
        !fired &&
        forkId !== undefined &&
        operations.some((operation) => operation.key === KEYS.checkpoint(forkId));
      if (isForkCreate) {
        fired = true;
        await beforeForkCommit(forkId);
      }
      return base.conditionalBatch(conditions, operations);
    },
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
}

async function revisionFor(name: string, definition: WorkflowDefinition): Promise<string> {
  const registered = copyWorkflowDefinition(name, buildRegistrationEntry(name, definition));
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

describe('engine.fork under ownership: workflow-lease (COR-2635)', () => {
  it('forks a settled run, acquires the fork id in its create batch, and releases it at the end', async () => {
    const storage = new MemoryStorage();
    await using engine = await leaseEngine(storage);
    const source = await engine.start(twoSteps.name, {}, { id: 'settled-source' });
    expect(await source.result()).toBe(2);

    let forkId = '';
    const warnings = await collectClaimLostWarnings(async () => {
      const fork = await engine.fork('settled-source');
      forkId = fork.id;
      expect(await fork.result()).toBe(2);
    });

    expect(warnings).toEqual([]);
    expect(await engine.get(forkId)).toMatchObject({ status: 'completed' });
    // Acquired (the epoch exists) and released at the terminal write (the holder is gone).
    expect(await storage.get(KEYS.workflowOwnerEpoch(forkId))).not.toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(forkId))).toBeNull();
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(forkId)).toBeNull();
  });

  it('forks onto another installed revision and reads the result that revision returns', async () => {
    const storage = new MemoryStorage();
    const type = 'fork-lease-revision';
    const define = (label: string) =>
      workflow({ name: type, description: label }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.run(() => 1);
        return label;
      });
    const definitionV1 = define('v1');
    const definitionV2 = define('v2');
    const revisionV1 = await revisionFor(type, definitionV1);
    const revisionV2 = await revisionFor(type, definitionV2);

    // No code-registered workflows: the type is served by the two registered sources alone.
    await using engine = await Engine.create({ storage, ...leaseOptions });
    engine.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    const source = await engine.start(type, null, { id: 'revision-source' });
    expect(await source.result()).toBe('v1');
    engine.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => ({ v2: definitionV2 }),
      ),
    );
    await engine.resolveWorkflowSource(type, revisionV2);

    const fork = await engine.fork('revision-source', { revision: revisionV2 });
    expect(await fork.result()).toBe('v2');
    expect(await engine.get(fork.id)).toMatchObject({ revision: revisionV2 });
    expect(await storage.get(KEYS.workflowOwnerHolder(fork.id))).toBeNull();
  });

  it('forks a run another engine holds without touching that engine’s claim or deposing it', async () => {
    const storage = new MemoryStorage();
    await using holder = await leaseEngine(storage);
    await using forker = await leaseEngine(storage);
    const holderId = getInternals(holder).workflowClaimRegistry!.engineId;
    const forkerId = getInternals(forker).workflowClaimRegistry!.engineId;
    expect(holderId).not.toBe(forkerId);

    const source = await holder.start(parked.name, {}, { id: 'held-source' });
    await holder[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING]('held-source');
    const epochBefore = await storage.get(KEYS.workflowOwnerEpoch('held-source'));
    const holderBefore = await storage.get(KEYS.workflowOwnerHolder('held-source'));
    expect(await holderEngineId(storage, 'held-source')).toBe(holderId);

    let forkId = '';
    const warnings = await collectClaimLostWarnings(async () => {
      const fork = await forker.fork('held-source');
      forkId = fork.id;
      await forker[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](forkId);
      // The fork runs under the forking engine's own claim, at its own epoch.
      expect(await holderEngineId(storage, forkId)).toBe(forkerId);
      // The source's fence is byte-for-byte what it was: nothing wrote through it or bumped it.
      expect(await storage.get(KEYS.workflowOwnerEpoch('held-source'))).toEqual(epochBefore);
      expect(await storage.get(KEYS.workflowOwnerHolder('held-source'))).toEqual(holderBefore);

      await forker.signal(forkId, 'go', 'fork');
      expect(await fork.result()).toBe('1-fork');
      // The holder was not deposed: its next fenced writes on the source still commit.
      await holder.signal('held-source', 'go', 'source');
      expect(await source.result()).toBe('1-source');
    });

    expect(warnings).toEqual([]);
    expect(getInternals(holder).deposed).toBe(false);
    expect(getInternals(forker).deposed).toBe(false);
    expect(await loadWorkflowState(getInternals(holder), 'held-source')).toMatchObject({
      status: 'completed',
    });
  });

  it('writes nothing when another engine claims the fork id between the fork’s read and its commit', async () => {
    const base = new MemoryStorage();
    const foreign = new WorkflowClaimRegistry({
      storage: base,
      engineId: 'foreign-engine',
      getNow: () => Date.now(),
      claimTtlMs: 60_000,
      claimRenewIntervalMs: 5_000,
    });
    let claimedForkId = '';
    const storage = interceptForkCommit(base, 'claim-race-source', async (forkId) => {
      claimedForkId = forkId;
      expect(await foreign.acquire(forkId)).toMatchObject({ status: 'acquired' });
    });
    await using engine = await leaseEngine(storage);
    const source = await engine.start(twoSteps.name, {}, { id: 'claim-race-source' });
    await source.result();
    const foreignHolder = async () => base.get(KEYS.workflowOwnerHolder(claimedForkId));

    const error = await rejectionOf(engine.fork('claim-race-source'));

    expect(error).toBeInstanceOf(WorkflowClaimUnavailableError);
    expect(error).not.toBeInstanceOf(EngineDeposedError);
    expect(claimedForkId).not.toBe('');
    expect(await base.get(KEYS.workflow(claimedForkId))).toBeNull();
    expect(await base.get(KEYS.checkpoint(claimedForkId))).toBeNull();
    expect(decodeWorkflowClaimHolder((await foreignHolder())!)?.engineId).toBe('foreign-engine');
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(claimedForkId)).toBeNull();
  });

  it('still reports a catalog entry removed under the commit as the revision race, not a claim loss', async () => {
    const base = new MemoryStorage();
    let pinnedRevision: string | undefined;
    let claimedForkId = '';
    // A `removeWorkflowRevision()` landing under the commit: the entry the fork read is gone.
    const storage = interceptForkCommit(base, 'catalog-race-source', async (forkId) => {
      claimedForkId = forkId;
      await base.delete(KEYS.catalogEntry(twoSteps.name, pinnedRevision!));
    });
    await using engine = await leaseEngine(storage);
    const source = await engine.start(twoSteps.name, {}, { id: 'catalog-race-source' });
    await source.result();
    const sourceState = await engine.get('catalog-race-source');
    pinnedRevision = sourceState?.revision;
    expect(pinnedRevision).toBeDefined();

    const error = await rejectionOf(engine.fork('catalog-race-source'));

    expect(error).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect(await base.get(KEYS.workflow(claimedForkId))).toBeNull();
    expect(await base.get(KEYS.workflowOwnerHolder(claimedForkId))).toBeNull();
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(claimedForkId)).toBeNull();
  });

  it('gives the fork id’s claim back when the launch fails after the create batch committed', async () => {
    const storage = new MemoryStorage();
    await using engine = await leaseEngine(storage);
    const source = await engine.start(twoSteps.name, {}, { id: 'launch-failure-source' });
    await source.result();
    const internals = getInternals(engine);
    const strategy = internals.inlineStrategy!;
    const adoptWorkflow = strategy.adoptWorkflow.bind(strategy);
    let failedForkId = '';
    strategy.adoptWorkflow = (workflowId, ...rest) => {
      if (workflowId !== 'launch-failure-source') {
        failedForkId = workflowId;
        throw new Error('launch failed');
      }
      return adoptWorkflow(workflowId, ...rest);
    };

    const error = await rejectionOf(engine.fork('launch-failure-source'));
    strategy.adoptWorkflow = adoptWorkflow;

    expect((error as Error).message).toBe('launch failed');
    // The run is durable and ownerless, so the reclaim scan can hand it to an engine that drives it.
    expect(await engine.get(failedForkId)).toMatchObject({ status: 'running' });
    expect(await storage.get(KEYS.workflowOwnerEpoch(failedForkId))).not.toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(failedForkId))).toBeNull();
    expect(internals.workflowClaimRegistry?.currentEpoch(failedForkId)).toBeNull();

    // Nothing the failed launch left behind keeps the run from being driven: a resume takes the
    // claim afresh and replays the fork from its checkpoint to its result.
    const redriven = await engine.resume(failedForkId);
    expect(await redriven.result()).toBe(2);
    expect(await engine.get(failedForkId)).toMatchObject({ status: 'completed' });
    expect(await storage.get(KEYS.workflowOwnerHolder(failedForkId))).toBeNull();
  });
});
