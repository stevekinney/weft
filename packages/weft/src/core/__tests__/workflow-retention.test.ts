import { describe, expect, it } from 'bun:test';
import {
  sleepForTesting,
  waitForCondition,
  waitForRealTimersForTesting,
} from '../../testing/fake-timers.test-support.ts';

import type { BatchOperation, ScanOptions } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { copyWorkflowDefinition } from '../engine/construction.ts';
import { buildRegistrationEntry } from '../engine/registration.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import {
  workflow,
  type AttributeFilter,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../types.ts';

/**
 * Move `type`'s catalog active pointer to `revision`, tolerating a
 * revision-only content difference and supplying the required
 * `expectedGeneration` once a prior active pointer exists — an omitted
 * `expectedGeneration` on a second activation silently refuses with
 * `expected-generation-required` rather than throwing, leaving the active
 * pointer on the FIRST revision with no visible error. Throws loudly
 * instead when activation is refused for any reason.
 */
async function activateDynamicSourceRevision(
  engine: Engine,
  type: string,
  revision: string,
): Promise<void> {
  const active = await engine.workflows.getActive(type);
  const result = await engine.workflows.activate(type, revision, {
    ...(active !== null && { expectedGeneration: active.generation }),
    policy: { requireExactRevision: false },
  });
  if (!result.applied) {
    throw new Error(
      `activateDynamicSourceRevision(${type}, ${revision}) was not applied: ${JSON.stringify(result)}`,
    );
  }
}

async function waitForWorkflowPresence(
  engine: Engine,
  workflowId: string,
  shouldExist: boolean,
): Promise<void> {
  await waitForCondition(
    async () => {
      const exists = (await engine.get(workflowId)) !== null;
      return exists === shouldExist;
    },
    {
      label: `workflow "${workflowId}" existence to become ${String(shouldExist)}`,
      timeoutMs: 400,
      intervalMs: 5,
    },
  );
}

class RecordingMemoryStorage extends MemoryStorage {
  readonly batchCalls: BatchOperation[][] = [];

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.batchCalls.push([...operations]);
    await super.batch(operations);
  }
}

class OverlapTrackingMemoryStorage extends MemoryStorage {
  readonly delayMs: number;

  shouldTrackPurgeBatches = false;
  activePurgeBatches = 0;
  maxConcurrentPurgeBatches = 0;

  constructor(delayMs: number) {
    super();
    this.delayMs = delayMs;
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    const isTrackedPurgeBatch =
      this.shouldTrackPurgeBatches &&
      operations.some(
        (operation) =>
          operation.type === 'delete' &&
          operation.key.startsWith('wf:') &&
          !operation.key.slice('wf:'.length).includes(':'),
      );

    if (!isTrackedPurgeBatch) {
      await super.batch(operations);
      return;
    }

    this.activePurgeBatches++;
    this.maxConcurrentPurgeBatches = Math.max(
      this.maxConcurrentPurgeBatches,
      this.activePurgeBatches,
    );

    try {
      await waitForRealTimersForTesting(this.delayMs);
      await super.batch(operations);
    } finally {
      this.activePurgeBatches--;
    }
  }
}

class CountingWorkflowStateScanStorage extends MemoryStorage {
  topLevelWorkflowStateEntriesSeen = 0;
  terminalWorkflowIndexEntriesSeen = 0;

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    for await (const entry of super.scan(prefix, options)) {
      const [key] = entry;
      if (prefix === 'wf:' && !key.slice(3).includes(':')) {
        this.topLevelWorkflowStateEntriesSeen += 1;
      }
      if (prefix === KEYS.terminalWorkflowPrefix()) {
        this.terminalWorkflowIndexEntriesSeen += 1;
      }
      yield entry;
    }
  }

  resetTopLevelWorkflowStateEntriesSeen(): void {
    this.topLevelWorkflowStateEntriesSeen = 0;
    this.terminalWorkflowIndexEntriesSeen = 0;
  }
}

async function collectKeys(storage: MemoryStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.keys ? storage.keys(prefix) : collectScanKeys(storage, prefix)) {
    keys.push(key);
  }
  return keys;
}

async function* collectScanKeys(storage: MemoryStorage, prefix: string): AsyncGenerator<string> {
  for await (const [key] of storage.scan(prefix)) {
    yield key;
  }
}

async function createCompletedWorkflow(
  engine: Engine,
  workflowType: string,
  workflowId: string,
): Promise<void> {
  const handle = await engine.start(workflowType, null, { id: workflowId });
  await handle.result();
}

async function waitForRunningWorkflow(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === 'running';
    },
    { label: `workflow "${workflowId}" to reach running state`, timeoutMs: 400, intervalMs: 5 },
  );
}

describe('workflow retention', () => {
  it('Acceptance criteria: EngineOptions.retention cleans up completed, failed, cancelled, and timed-out workflows after updatedAt + TTL', async () => {
    let now = 1_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: '5s',
        failed: '5s',
        cancelled: '5s',
        timedOut: '5s',
      },
      retentionSweepInterval: '10ms',
    });

    engine.register(
      workflow({ name: 'retention-completed' }).execute(async function* () {
        return 'done';
      }),
    );
    engine.register(
      workflow({ name: 'retention-failed' }).execute(async function* () {
        throw new Error('boom');
      }),
    );
    engine.register(
      workflow({ name: 'retention-blocked' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    const completedHandle = await engine.start('retention-completed', null, {
      id: 'retention-completed',
    });
    await completedHandle.result();

    const failedHandle = await engine.start('retention-failed', null, {
      id: 'retention-failed',
    });
    await failedHandle.result().catch(() => {});

    const cancelledHandle = await engine.start('retention-blocked', null, {
      id: 'retention-cancelled',
    });
    await waitForRunningWorkflow(engine, cancelledHandle.id);
    await engine.cancel(cancelledHandle.id);
    await cancelledHandle.result().catch(() => {});

    const timedOutHandle = await engine.start('retention-blocked', null, {
      id: 'retention-timed-out',
    });
    await waitForRunningWorkflow(engine, timedOutHandle.id);
    await engine.timeout(timedOutHandle.id);
    await timedOutHandle.result().catch(() => {});

    expect(await engine.get(completedHandle.id)).not.toBeNull();
    expect(await engine.get(failedHandle.id)).not.toBeNull();
    expect(await engine.get(cancelledHandle.id)).not.toBeNull();
    expect(await engine.get(timedOutHandle.id)).not.toBeNull();

    now += 5_001;

    await Promise.all([
      waitForWorkflowPresence(engine, completedHandle.id, false),
      waitForWorkflowPresence(engine, failedHandle.id, false),
      waitForWorkflowPresence(engine, cancelledHandle.id, false),
      waitForWorkflowPresence(engine, timedOutHandle.id, false),
    ]);

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: the default retention policy keeps terminal workflows until cleanup is explicitly configured', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });

    engine.register(
      workflow({ name: 'retention-default' }).execute(async function* () {
        return 'done';
      }),
    );

    const handle = await engine.start('retention-default', null, {
      id: 'retention-default',
    });
    await handle.result();

    const overview = engine.getRetentionOverview();
    expect(overview.defaultRetention).toBeNull();
    expect(overview.nextSweepAt).toBeNull();

    await sleepForTesting(50);
    expect(await engine.get(handle.id)).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention sweep uses a configurable interval and processes a configurable batch size', async () => {
    let now = 10_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: 0,
      },
      retentionSweepInterval: '50ms',
      retentionSweepBatchSize: 1,
    });

    engine.register(
      workflow({ name: 'retention-batched' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      }),
    );

    const first = await engine.start('retention-batched', 'a', { id: 'batched-a' });
    const second = await engine.start('retention-batched', 'b', { id: 'batched-b' });
    await Promise.all([first.result(), second.result()]);

    await waitForCondition(
      async () => {
        const states = await Promise.all([engine.get(first.id), engine.get(second.id)]);
        return states.filter((state) => state !== null).length === 1;
      },
      {
        label: 'first retention sweep to delete exactly one workflow',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    await waitForCondition(
      async () => {
        const states = await Promise.all([engine.get(first.id), engine.get(second.id)]);
        return states.every((state) => state === null);
      },
      {
        label: 'second retention sweep to delete the remaining workflow',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    engine[Symbol.dispose]();
  });

  it('retention sweep skips overlapping ticks while a previous purge batch is still running', async () => {
    const storage = new OverlapTrackingMemoryStorage(30);
    const engine = new Engine({
      storage,
      retention: {
        completed: 0,
      },
      retentionSweepInterval: '20ms',
      retentionSweepBatchSize: 1,
    });

    engine.register(
      workflow({ name: 'retention-overlap' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      }),
    );

    const first = await engine.start('retention-overlap', 'a', { id: 'retention-overlap-a' });
    const second = await engine.start('retention-overlap', 'b', { id: 'retention-overlap-b' });
    await Promise.all([first.result(), second.result()]);

    storage.shouldTrackPurgeBatches = true;

    await waitForCondition(
      async () => {
        const remainingStates = await Promise.all([engine.get(first.id), engine.get(second.id)]);
        return remainingStates.filter((state) => state !== null).length === 1;
      },
      {
        label: 'exactly one workflow to be purged while the first retention sweep is in flight',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    expect(storage.maxConcurrentPurgeBatches).toBe(1);

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention sweep defaults to every 5 minutes when not configured', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
      retention: {
        completed: '1s',
      },
    });

    engine.register(
      workflow({ name: 'echo' }).execute(async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      }),
    );

    const overview = engine.getRetentionOverview();
    expect(overview.sweepIntervalMs).toBe(300_000);
    expect(overview.nextSweepAt).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: per-workflow-type retention overrides the engine default', async () => {
    let now = 5_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: '1s',
      },
      retentionSweepInterval: '10ms',
    });

    engine.register(
      workflow({ name: 'short-lived' }).execute(async function* () {
        return 'short';
      }),
    );
    engine.register(
      workflow({
        name: 'long-lived',
        retention: { completed: '10s' },
      }).execute(async function* () {
        return 'long';
      }),
    );

    const shortHandle = await engine.start('short-lived', null, { id: 'short-lived' });
    const longHandle = await engine.start('long-lived', null, { id: 'long-lived' });
    await Promise.all([shortHandle.result(), longHandle.result()]);

    now += 1_500;
    await waitForWorkflowPresence(engine, shortHandle.id, false);
    expect(await engine.get(longHandle.id)).not.toBeNull();

    now += 9_000;
    await waitForWorkflowPresence(engine, longHandle.id, false);

    engine[Symbol.dispose]();
  });

  it("a registerSource()-registered type's own retention policy overrides the engine default once resolved", async () => {
    // Regression: a dynamic definition's `retention` never lands in
    // `internals.registrations`, so both the purge sweep's minimum-retention scan
    // bound and its per-workflow deadline check silently ignored it — a dynamic
    // workflow with a SHORTER retention than the engine default never expired early.
    let now = 5_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: { completed: '10s' },
      retentionSweepInterval: '10ms',
    });
    const type = 'dynamic-short-lived';
    const definition = workflow({ name: type, retention: { completed: '1s' } }).execute(
      async function* () {
        return 'dynamic';
      },
    );
    const entry = buildRegistrationEntry(type, definition);
    const registered = copyWorkflowDefinition(type, entry);
    const manifest = await buildWorkflowManifestFromDefinition(
      registered,
      new ActivityRegistry().listDefinitions(),
    );
    engine.registerSource(
      workflowSource(
        {
          name: type,
          location: './dynamic-short-lived.ts',
          exportName: 'dyn',
          revision: manifest.revision,
        },
        async () => ({ dyn: definition }),
      ),
    );

    const handle = await engine.start(type, null, { id: 'dynamic-short-lived' });
    await handle.result();

    now += 1_500;
    await waitForWorkflowPresence(engine, handle.id, false);

    engine[Symbol.dispose]();
  });

  it("a run pinned to revision B's own (shorter) retention deadline expires at B's window, not a more-recently-resolved revision A's (longer, engine-default) one (WFT-19)", async () => {
    // Regression: `getWorkflowRetentionDeadline` used to resolve a dynamic
    // source's retention policy via the TYPE-only, last-resolved-wins
    // `getResolvedDynamicRegistration(internals, state.type)` — so a
    // terminal run's deadline could silently reflect a SIBLING run's more-
    // recently-resolved revision's policy instead of its own pinned one.
    let now = 5_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: { completed: '10s' },
      retentionSweepInterval: '10ms',
    });
    const type = 'multi-rev-retention';
    // A has no override — resolves to the engine-wide 10s default.
    const definitionA = workflow({
      name: type,
      description: 'A - engine default retention',
    }).execute(async function* () {
      return 'A-done';
    });
    const definitionB = workflow({
      name: type,
      description: 'B - short retention',
      retention: { completed: '1s' },
    }).execute(async function* () {
      return 'B-done';
    });
    async function manifestRevisionFor(definition: WorkflowDefinition): Promise<string> {
      const entry = buildRegistrationEntry(type, definition);
      const registered = copyWorkflowDefinition(type, entry);
      const manifest = await buildWorkflowManifestFromDefinition(
        registered,
        new ActivityRegistry().listDefinitions(),
      );
      return manifest.revision;
    }
    const revisionA = await manifestRevisionFor(definitionA);
    const revisionB = await manifestRevisionFor(definitionB);

    engine.registerSource(
      workflowSource(
        { name: type, location: './a.ts', exportName: 'a', revision: revisionA },
        async () => ({ a: definitionA }),
      ),
    );
    engine.registerSource(
      workflowSource(
        { name: type, location: './b.ts', exportName: 'b', revision: revisionB },
        async () => ({ b: definitionB }),
      ),
    );

    await engine.resolveWorkflowSource(type, revisionB);
    await activateDynamicSourceRevision(engine, type, revisionB);
    const handleB = await engine.start(type, null, { id: 'multi-rev-retention-b' });
    await handleB.result();

    // Resolve and activate A AFTER B completes — the pre-fix, last-resolved-
    // wins lookup would now apply A's (engine-default, 10s) policy to B's
    // already-terminal run.
    await engine.resolveWorkflowSource(type, revisionA);
    await activateDynamicSourceRevision(engine, type, revisionA);

    now += 1_500; // past B's own 1s deadline, well under the 10s engine default
    await waitForWorkflowPresence(engine, handleB.id, false);

    engine[Symbol.dispose]();
  });

  it('a terminal run pinned to a registered-but-unresolved revision resolves ITS OWN retention policy rather than falling back to the engine default (review round 1)', async () => {
    // Regression flagged in first-round review of the WFT-19 fix above:
    // the sync-only `getResolvedDynamicRegistration()` lookup returns
    // `undefined` for a pin this process has never locally resolved — even
    // when it IS a registered candidate — so the deadline calculation fell
    // back to the engine-wide default instead of resolving the run's own
    // declared (here, much shorter) window. `getWorkflowRetentionDeadline`
    // must instead await a full resolve (mirroring
    // `resolveFinalizerRegistration()`) before falling back to the default.
    //
    // Uses TWO engines sharing one store — a real "fresh process never
    // resolved this revision" scenario, not a hand-seeded index bypass: A's
    // completion in the first engine populates the visibility index the
    // retention sweep depends on to discover it at all; the second, fresh
    // engine's in-memory `internals.sources.resolved` starts empty
    // regardless of what the first engine resolved, matching a real
    // process restart.
    let now = 5_000;
    const storage = new MemoryStorage();
    const type = 'unresolved-pin-retention';
    const definitionA = workflow({
      name: type,
      description: 'A - short retention, never resolved by the sweeping engine',
      retention: { completed: '1s' },
    }).execute(async function* () {
      return 'A-done';
    });
    const definitionB = workflow({
      name: type,
      description: 'B - resolved sibling in the sweeping engine',
    }).execute(async function* () {
      return 'B-done';
    });
    async function manifestRevisionFor(definition: WorkflowDefinition): Promise<string> {
      const entry = buildRegistrationEntry(type, definition);
      const registered = copyWorkflowDefinition(type, entry);
      const manifest = await buildWorkflowManifestFromDefinition(
        registered,
        new ActivityRegistry().listDefinitions(),
      );
      return manifest.revision;
    }
    const revisionA = await manifestRevisionFor(definitionA);
    const revisionB = await manifestRevisionFor(definitionB);
    const workflowIdA = 'unresolved-pin-retention-a';

    {
      // First engine: only A registered (single-candidate fast path — no
      // activation needed), starts and completes the run for real, giving
      // it a properly-indexed terminal record.
      await using seedingEngine = new Engine({ storage, getNow: () => now });
      seedingEngine.registerSource(
        workflowSource(
          { name: type, location: './a.ts', exportName: 'a', revision: revisionA },
          async () => ({ a: definitionA }),
        ),
      );
      const handleA = await seedingEngine.start(type, null, { id: workflowIdA });
      await handleA.result();
    }

    // Second, fresh engine: both A and B registered, but only B resolved —
    // this process never calls `resolveWorkflowSource`/`start` for A.
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: { completed: '100s' }, // engine default: deliberately much longer than A's own window
      retentionSweepInterval: '10ms',
    });
    engine.registerSource(
      workflowSource(
        { name: type, location: './a.ts', exportName: 'a', revision: revisionA },
        async () => ({ a: definitionA }),
      ),
    );
    engine.registerSource(
      workflowSource(
        { name: type, location: './b.ts', exportName: 'b', revision: revisionB },
        async () => ({ b: definitionB }),
      ),
    );
    await engine.resolveWorkflowSource(type, revisionB);
    await activateDynamicSourceRevision(engine, type, revisionB);
    const handleB = await engine.start(type, null, { id: 'unresolved-pin-retention-b' });
    await handleB.result();

    now += 1_500; // past A's own 1s deadline, well under the 100s engine default
    await waitForWorkflowPresence(engine, workflowIdA, false);

    engine[Symbol.dispose]();
  });

  it('a terminal run pinned to a revision this process has never registered as a candidate is NOT purged under the engine default — it stays until its own pin becomes resolvable (review round 2)', async () => {
    // Exercises `getWorkflowRetentionDeadline()`'s `WorkflowRevisionUnavailableError`
    // catch branch directly: `type` IS a registered dynamic source (so
    // `resolveExecutableRegistrationForRevision()` is actually invoked, not
    // short-circuited by the earlier `!internals.sources.byName.has(...)`
    // guard), but the run's own pinned revision is not among the
    // registered candidates — the resolve throws.
    //
    // Review round 1 had this fall back to the engine default so the run
    // would not hang un-purgeable forever — but review round 2 (Codex,
    // fresh evidence after that fix) correctly flagged that as its own
    // regression: purge is irreversible, and the run's own (unresolvable)
    // policy might be LONGER than the engine default, so silently purging
    // under someone else's shorter policy risks an early, wrong purge. The
    // deadline calculation must instead treat "unresolvable" as "not
    // purge-eligible this sweep" (`getWorkflowRetentionDeadline` returns
    // `null`), re-examined on a later sweep once the pin becomes resolvable
    // — never hanging (the run is still discoverable and simply not purged
    // yet), and never purged under a policy that is not its own.
    let now = 5_000;
    const storage = new MemoryStorage();
    const type = 'never-registered-pin-retention';
    const definition = workflow({
      name: type,
      description: 'the only registered candidate',
    }).execute(async function* () {
      return 'done';
    });
    const registeredRevision = await (async () => {
      const entry = buildRegistrationEntry(type, definition);
      const registered = copyWorkflowDefinition(type, entry);
      const manifest = await buildWorkflowManifestFromDefinition(
        registered,
        new ActivityRegistry().listDefinitions(),
      );
      return manifest.revision;
    })();

    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: { completed: '1s' }, // short engine default — proves it is NOT applied to this pin
      retentionSweepInterval: '10ms',
    });
    engine.registerSource(
      workflowSource(
        { name: type, location: './only.ts', exportName: 'only', revision: registeredRevision },
        async () => ({ only: definition }),
      ),
    );

    // Start and complete a REAL run first — this indexes the terminal
    // record properly (the visibility index the sweep depends on to
    // discover a workflow at all is not populated by a raw `storage.put`
    // alone). Then overwrite the persisted `revision` to a value this
    // process never registered as a candidate, leaving the index (keyed
    // on status/updatedAt, unaffected by this field) intact.
    const workflowId = 'never-registered-pin-retention-run';
    const handle = await engine.start(type, null, { id: workflowId });
    await handle.result();
    const persisted = decode((await storage.get(KEYS.workflow(workflowId)))!) as Record<
      string,
      unknown
    >;
    persisted['revision'] = 'a-revision-never-registered';
    await storage.put(KEYS.workflow(workflowId), encode(persisted));

    now += 1_500; // past the 1s engine default — must NOT matter for this pin
    // Proving the sweep does NOT purge this workflow across several real
    // sweep intervals (`retentionSweepInterval: '10ms'`); there is no
    // observable "purge did not happen" event to await, so a fixed real-time
    // window is the only way to give the (would-be regression)
    // default-fallback purge a fair chance to have already run.
    // fixed delay: negative assertion
    await waitForRealTimersForTesting(80);
    expect(await engine.get(workflowId)).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('a legacy (revision-undefined) terminal run on a type with 2+ registered candidates is NOT purged under whichever sibling this process last resolved (review round 6)', async () => {
    // Codex P1 (round 6): `getResolvedDynamicRegistration()`'s sync-only
    // fallback used `lastResolvedRevisionByName` unconditionally whenever
    // `revision === undefined` — including for a per-INSTANCE caller like
    // this deadline calculation, where `undefined` means "this specific
    // run's own pin is unknown (legacy)," not "no instance to pin against
    // at all" (that's `retention.ts`'s type-level overview, the one caller
    // meant to get the permissive answer). With two or more candidates
    // registered, silently substituting whichever one this process
    // happened to resolve last is exactly as wrong as the round-1/round-2
    // findings this same file already covers for an unresolved/unregistered
    // pin — except here the sweep never even reaches the async resolver
    // that would classify it `legacy-ambiguous`, because the buggy sync
    // fallback already "succeeded." The fix gates the fallback on
    // `canResolveRevisionLocally()`: with 2+ candidates it now returns
    // `undefined`, forcing the async path, which correctly reports
    // unresolvable — proven here by giving the LAST-RESOLVED sibling a
    // short retention window and confirming the legacy record survives it.
    let now = 5_000;
    const storage = new MemoryStorage();
    const type = 'legacy-ambiguous-retention';
    const definitionA = workflow({
      name: type,
      description: "A - the type's sole candidate at seed time",
    }).execute(async function* () {
      return 'A-done';
    });
    const definitionB = workflow({
      name: type,
      description: 'B - registered and resolved AFTER the seed, short retention',
      retention: { completed: '1s' },
    }).execute(async function* () {
      return 'B-done';
    });
    async function manifestRevisionFor(definition: WorkflowDefinition): Promise<string> {
      const entry = buildRegistrationEntry(type, definition);
      const registered = copyWorkflowDefinition(type, entry);
      const manifest = await buildWorkflowManifestFromDefinition(
        registered,
        new ActivityRegistry().listDefinitions(),
      );
      return manifest.revision;
    }
    const revisionA = await manifestRevisionFor(definitionA);
    const revisionB = await manifestRevisionFor(definitionB);
    const workflowId = 'legacy-ambiguous-retention-run';

    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: { completed: '100s' }, // engine default: also must NOT apply — this pin stays unresolvable
      retentionSweepInterval: '10ms',
    });
    engine.registerSource(
      workflowSource(
        { name: type, location: './a.ts', exportName: 'a', revision: revisionA },
        async () => ({ a: definitionA }),
      ),
    );

    // Start and complete a REAL run under the sole candidate (A) — indexes
    // the terminal record properly. Then overwrite the persisted `revision`
    // to simulate a genuinely legacy (pre-revision-pinning) record: the
    // field is absent entirely, not merely a stale value.
    const handle = await engine.start(type, null, { id: workflowId });
    await handle.result();
    const persisted = decode((await storage.get(KEYS.workflow(workflowId)))!) as Record<
      string,
      unknown
    >;
    delete persisted['revision'];
    await storage.put(KEYS.workflow(workflowId), encode(persisted));

    // NOW register B and actually resolve it LOCALLY by starting and
    // completing a real (unrelated) run under it — `type` has 2 registered
    // candidates from this point on, and `internals.sources.resolved`/
    // `lastResolvedRevisionByName` now genuinely hold B, the exact value
    // the pre-fix sync fallback would have substituted for the legacy
    // record's unknown pin. (Merely calling `resolveWorkflowSource()` +
    // activating B, without starting a run under it, never populates
    // `internals.sources.resolved` — only an actual local load does, so a
    // real start is required to reproduce the bug this test guards.)
    engine.registerSource(
      workflowSource(
        { name: type, location: './b.ts', exportName: 'b', revision: revisionB },
        async () => ({ b: definitionB }),
      ),
    );
    await engine.resolveWorkflowSource(type, revisionB);
    await activateDynamicSourceRevision(engine, type, revisionB);
    const handleB = await engine.start(type, null, { id: 'legacy-ambiguous-retention-b' });
    await handleB.result();

    now += 1_500; // past B's 1s window (the pre-fix bug's purge trigger) and the 100s engine default is irrelevant either way
    // Proving the sweep does NOT purge this workflow across several real
    // sweep intervals; there is no observable "purge did not happen" event
    // to await, so a fixed real-time window is the only way to give the
    // (would-be regression) short-sibling-policy purge a fair chance to
    // have already run.
    // fixed delay: negative assertion
    await waitForRealTimersForTesting(80);
    expect(await engine.get(workflowId)).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention deletes workflow state, checkpoints, checkpoint history, events, search attribute indexes, offloaded data, archived data, and stream chunks in one batch() call per workflow', async () => {
    const storage = new RecordingMemoryStorage();
    const engine = new Engine({
      storage,
    });

    engine.register(
      workflow({ name: 'artifact-workflow' }).execute(async function* (ctx: WorkflowContext) {
        const concreteContext = ctx;
        yield* concreteContext.stream('chunks', async function* () {
          yield { index: 0 };
          yield { index: 1 };
        });
        yield* concreteContext.offload('export', async () => ({ rows: [1, 2, 3] }));
        yield* concreteContext.archive('snapshot', { ok: true });
        return 'done';
      }),
    );

    const handle = await engine.start('artifact-workflow', null, {
      id: 'purge-me',
    });
    await handle.result();
    await engine.setAttributes(handle.id, { priority: 'high' });
    await storage.put(KEYS.stateExecution(handle.id, 'counter'), new TextEncoder().encode('1'));
    await storage.put(KEYS.update(handle.id, 'update-1'), encode({ updateId: 'update-1' }));
    await storage.put(KEYS.updateResponse('update-1'), encode({ result: 'done' }));

    const batchCallsBeforePurge = storage.batchCalls.length;

    const result = await engine.purge({ status: 'completed', type: 'artifact-workflow' });

    expect(result.deleted).toBe(1);
    expect(storage.batchCalls.length - batchCallsBeforePurge).toBe(1);
    expect(await engine.get(handle.id)).toBeNull();
    expect(await storage.get(KEYS.checkpoint(handle.id))).toBeNull();
    expect(await storage.get(KEYS.attribute(handle.id))).toBeNull();
    expect(await collectKeys(storage, `wf:${handle.id}:ckpt:`)).toEqual([]);
    expect(await collectKeys(storage, `ev:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `offload:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `archive:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `blob:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `state:execution:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `idx:priority:`)).toEqual([]);
    expect(await collectKeys(storage, KEYS.terminalWorkflowPrefix())).toEqual([]);
    expect(await storage.get(KEYS.update(handle.id, 'update-1'))).toBeNull();
    expect(await storage.get(KEYS.updateResponse('update-1'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: engine.purge(filter) manually triggers cleanup only for the matching status, attribute, offset, and limit window', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });
    const targetFilter: AttributeFilter[] = [{ key: 'bucket', value: 'target' }];

    engine.register(
      workflow({ name: 'completed' }).execute(async function* () {
        return 'done';
      }),
    );
    engine.register(
      workflow({ name: 'waiting' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'completed', 'purge-match-1');
    await createCompletedWorkflow(engine, 'completed', 'purge-match-2');
    await createCompletedWorkflow(engine, 'completed', 'purge-other');
    await engine.setAttributes('purge-match-1', { bucket: 'target' });
    await engine.setAttributes('purge-match-2', { bucket: 'target' });
    await engine.setAttributes('purge-other', { bucket: 'other' });

    const runningHandle = await engine.start('waiting', null, { id: 'purge-running' });
    await waitForRunningWorkflow(engine, runningHandle.id);

    const purgeResult = await engine.purge({
      status: 'completed',
      attributes: targetFilter,
      offset: 1,
      limit: 1,
    });

    expect(purgeResult.deleted).toBe(1);
    expect(await engine.get('purge-match-1')).not.toBeNull();
    expect(await engine.get('purge-match-2')).toBeNull();
    expect(await engine.get('purge-other')).not.toBeNull();
    expect(await engine.get(runningHandle.id)).not.toBeNull();

    await engine.cancel(runningHandle.id);
    await runningHandle.result().catch(() => {});
    engine[Symbol.dispose]();
  });

  it('engine.purge(filter) treats limit 0 as a no-op', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });

    engine.register(
      workflow({ name: 'limit-zero' }).execute(async function* () {
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'limit-zero', 'purge-limit-zero');

    const result = await engine.purge({ status: 'completed', limit: 0 });

    expect(result).toEqual({ deleted: 0 });
    expect(await engine.get('purge-limit-zero')).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('engine.purge(filter) stops scanning workflow state entries once the limit is reached', async () => {
    const storage = new CountingWorkflowStateScanStorage();
    const engine = new Engine({ storage });

    engine.register(
      workflow({ name: 'limited-purge' }).execute(async function* () {
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'limited-purge', 'purge-limit-a');
    await createCompletedWorkflow(engine, 'limited-purge', 'purge-limit-b');
    await createCompletedWorkflow(engine, 'limited-purge', 'purge-limit-c');

    storage.resetTopLevelWorkflowStateEntriesSeen();

    const result = await engine.purge({ status: 'completed', limit: 1 });

    expect(result).toEqual({ deleted: 1 });
    expect(storage.topLevelWorkflowStateEntriesSeen).toBe(1);
    expect(await engine.get('purge-limit-a')).toBeNull();
    expect(await engine.get('purge-limit-b')).not.toBeNull();
    expect(await engine.get('purge-limit-c')).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('engine.purge(filter) deletes workflow tag index entries for purged workflows', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register(
      workflow({ name: 'tagged-purge' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      }),
    );

    const purgedHandle = await engine.start('tagged-purge', 'purge me', {
      id: 'purge-tagged-workflow',
      tags: ['nightly', 'v2'],
    });
    const retainedHandle = await engine.start('tagged-purge', 'keep me', {
      id: 'retain-tagged-workflow',
      tags: ['nightly'],
    });
    await Promise.all([purgedHandle.result(), retainedHandle.result()]);

    expect(await collectKeys(storage, 'tag:')).toEqual([
      KEYS.tagIndex('nightly', 'purge-tagged-workflow'),
      KEYS.tagIndex('nightly', 'retain-tagged-workflow'),
      KEYS.tagIndex('v2', 'purge-tagged-workflow'),
    ]);

    const result = await engine.purge({
      status: 'completed',
      tags: ['nightly', 'v2'],
    });

    expect(result.deleted).toBe(1);
    expect(await collectKeys(storage, 'tag:')).toEqual([
      KEYS.tagIndex('nightly', 'retain-tagged-workflow'),
    ]);

    engine[Symbol.dispose]();
  });

  it('retention sweep deletes orphaned terminal workflow index entries', async () => {
    const storage = new MemoryStorage();
    let now = 10_000;
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: {
        completed: 0,
      },
      retentionSweepInterval: '10ms',
    });

    await storage.put(
      KEYS.terminalWorkflow(now - 1, 'orphaned-terminal-workflow'),
      new Uint8Array(),
    );

    await waitForCondition(
      async () => {
        const keys = await collectKeys(storage, KEYS.terminalWorkflowPrefix());
        return keys.length === 0;
      },
      {
        label: 'retention sweep to delete orphaned terminal workflow index entries',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    now += 1;
    engine[Symbol.dispose]();
  });

  it('retention sweep scans the terminal-workflow index instead of top-level workflow state rows', async () => {
    let now = 10_000;
    const storage = new CountingWorkflowStateScanStorage();
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: {
        completed: '5s',
      },
      retentionSweepInterval: '10ms',
      retentionSweepBatchSize: 1,
    });

    engine.register(
      workflow({ name: 'retention-expired' }).execute(async function* () {
        return 'done';
      }),
    );
    engine.register(
      workflow({ name: 'retention-running' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'retention-expired', 'retention-expired-target');
    const runningHandle = await engine.start('retention-running', null, {
      id: 'retention-running-target',
    });
    await waitForRunningWorkflow(engine, runningHandle.id);

    storage.resetTopLevelWorkflowStateEntriesSeen();
    now += 6_000;

    await waitForWorkflowPresence(engine, 'retention-expired-target', false);

    expect(storage.topLevelWorkflowStateEntriesSeen).toBe(0);
    expect(storage.terminalWorkflowIndexEntriesSeen).toBeGreaterThan(0);

    await engine.cancel(runningHandle.id);
    await runningHandle.result().catch(() => {});
    engine[Symbol.dispose]();
  });
});
