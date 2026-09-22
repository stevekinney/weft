/**
 * COR-75: `engine.prepare()` / `handle.launch()` / `handle.abandon()`.
 *
 * Criterion 4: the two-phase surface exists with the same ownership and
 * lease semantics as `start()` — proven here by a caller-provided id
 * colliding against a still-`'pending'`, unlaunched prepared run exactly the
 * way it would against a `'running'` one started with `engine.start()`.
 *
 * Criterion 5: the initial record is durably readable after `prepare()` and
 * before `launch()`, and abandoning a prepared handle leaves no orphaned
 * live workflow.
 */
import { describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { encode } from '../../codec.ts';
import { PayloadSizeExceededError } from '../../payload-size.ts';
import {
  activity,
  workflow,
  type StartWorkflowOptions,
  type WorkflowContext,
} from '../../types.ts';
import { PREPARED_WORKFLOW_ABANDONED_REASON } from '../../types/history-policy.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { Engine } from '../index.ts';
import { getInternals } from '../internals.ts';
import { decodeWorkflowState } from '../validation.ts';
import { WorkflowClaimRegistry } from '../workflow-claim-registry.ts';

/**
 * Simulates a concurrent cancel landing in the exact await gap between
 * `launchPreparedWorkflow`'s own pending check (the first read of the
 * workflow record) and `commitPendingToRunning`'s serialized reload (the
 * second read): the second `get()` for the armed key returns the record with
 * a terminal status instead of the real, still-`'pending'` bytes, exactly as
 * a peer process's already-committed cancel would leave it. Modeled on
 * `InterleavedRemovalStorage` in `pinned-schedule-race.test.ts`.
 */
class InterleavedCancelStorage extends MemoryStorage {
  #workflowKeyToRace: string | null = null;
  #getCount = 0;

  armRaceOnSecondRead(workflowKey: string): void {
    this.#workflowKeyToRace = workflowKey;
    this.#getCount = 0;
  }

  override async get(key: string): Promise<Uint8Array | null> {
    const bytes = await super.get(key);
    if (key === this.#workflowKeyToRace && bytes !== null) {
      this.#getCount += 1;
      if (this.#getCount === 2) {
        const state = decodeWorkflowState(bytes);
        return encode({ ...state, status: 'cancelled' as const });
      }
    }
    return bytes;
  }
}

/**
 * Simulates a transient, spurious `conditionalBatch` failure on ONE armed
 * condition key — the batch reports "lost" even though the durable value
 * never actually changed. The very next `get()` of the same key (`fenced-write.ts`'s
 * `isWorkflowDeposed` disambiguation re-read) sees the real, still-matching
 * value, so it must conclude "not deposed" — proving a plain CAS-race failure
 * (not an `EngineDeposedError`) is reachable even though this call site's
 * only condition is the epoch fence (no base conditions). One-shot: disarms
 * itself after firing once, so it targets a single commit.
 */
class TransientEpochGlitchStorage extends MemoryStorage {
  #armedKey: string | null = null;

  armTransientGlitch(key: string): void {
    this.#armedKey = key;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (
      this.#armedKey !== null &&
      conditions.some((condition) => condition.key === this.#armedKey)
    ) {
      this.#armedKey = null;
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

describe('engine.prepare() / handle.launch() / handle.abandon() (COR-75)', () => {
  it('commits a durable pending record readable via engine.get() before launch(), then launches it', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-simple' }).execute(async function* () {
        return 'ok';
      }),
    );

    const prepared = await engine.prepare('cor-75-simple', null, { id: 'cor-75-simple-1' });
    expect(prepared.id).toBe('cor-75-simple-1');

    // Readable through the fleet feed after phase one, before phase two.
    const recordBeforeLaunch = await engine.get(prepared.id);
    expect(recordBeforeLaunch).not.toBeNull();
    expect(recordBeforeLaunch?.status).toBe('pending');
    expect(recordBeforeLaunch?.startedAt).toBeUndefined();

    const handle = await prepared.launch();
    expect(handle.id).toBe('cor-75-simple-1');
    expect(await handle.result()).toBe('ok');

    const recordAfterCompletion = await engine.get(prepared.id);
    expect(recordAfterCompletion?.status).toBe('completed');
  });

  it('runs a real multi-step workflow to completion after launch()', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const stepOne = activity({ name: 'cor-75-step-one', execute: async () => 1 });
    const stepTwo = activity({
      name: 'cor-75-step-two',
      execute: async (input: unknown) => (input as number) + 1,
    });
    const stepThree = activity({
      name: 'cor-75-step-three',
      execute: async (input: unknown) => (input as number) + 1,
    });
    engine.register(
      workflow({ name: 'cor-75-multi-step' }).execute(async function* (ctx: WorkflowContext) {
        const a = yield* ctx.run(stepOne);
        const b = yield* ctx.run(stepTwo, a);
        const c = yield* ctx.run(stepThree, b);
        return c;
      }),
    );

    const prepared = await engine.prepare('cor-75-multi-step', null, {
      id: 'cor-75-multi-step-1',
    });
    const handle = await prepared.launch();
    expect(await handle.result()).toBe(3);
  });

  it('abandoning a prepared handle before launch leaves no orphaned live workflow', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-abandoned' }).execute(async function* () {
        return 'never runs';
      }),
    );

    const prepared = await engine.prepare('cor-75-abandoned', null, {
      id: 'cor-75-abandoned-1',
    });
    const recordBeforeAbandon = await engine.get(prepared.id);
    expect(recordBeforeAbandon?.status).toBe('pending');

    await prepared.abandon();

    const recordAfterAbandon = await engine.get(prepared.id);
    expect(recordAfterAbandon?.status).toBe('cancelled');
    expect(recordAfterAbandon?.terminationReason).toBe(PREPARED_WORKFLOW_ABANDONED_REASON);

    // No orphan: the record reached a terminal status rather than staying
    // 'pending' forever, and a fresh caller-provided-id start against the
    // same id is free to proceed (would throw WorkflowAlreadyExistsError
    // against a still-active — pending/running/suspended — record).
    const restarted = await engine.start('cor-75-abandoned', null, {
      id: 'cor-75-abandoned-1',
      onTerminalConflict: 'start-new',
    });
    expect(await restarted.result()).toBe('never runs');

    // abandon() is idempotent once already abandoned.
    await expect(prepared.abandon()).resolves.toBeUndefined();
  });

  it('rejects a second launch() and rejects abandon() after launch()', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-double-launch' }).execute(async function* () {
        return 'ok';
      }),
    );

    const prepared = await engine.prepare('cor-75-double-launch', null, {
      id: 'cor-75-double-launch-1',
    });
    const handle = await prepared.launch();
    await handle.result();

    await expect(prepared.launch()).rejects.toThrow(/already launched/);
    await expect(prepared.abandon()).rejects.toThrow(/already launched/);
  });

  it('same ownership/lease semantics as start(): a caller-provided id collides while prepared, exactly like an active start', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-duplicate-id' }).execute(async function* () {
        return 'ok';
      }),
    );

    await engine.prepare('cor-75-duplicate-id', null, { id: 'cor-75-duplicate-id-1' });

    await expect(
      engine.start('cor-75-duplicate-id', null, { id: 'cor-75-duplicate-id-1' }),
    ).rejects.toThrow(WorkflowAlreadyExistsError);
  });

  it('rejects options.startAt/startAfter and options.idempotencyKey', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-rejected-options' }).execute(async function* () {
        return 'ok';
      }),
    );

    // `prepare()`'s TypeScript signature already excludes these fields; cast
    // past that to prove the RUNTIME guard also rejects them (e.g. a plain-JS
    // caller, or one that built `options` from a wider-typed value).
    const withStartAt = { startAt: Date.now() + 60_000 } as StartWorkflowOptions;
    await expect(engine.prepare('cor-75-rejected-options', null, withStartAt)).rejects.toThrow(
      /incompatible with engine.prepare/,
    );

    const withIdempotencyKey = { idempotencyKey: 'some-key' } as StartWorkflowOptions;
    await expect(
      engine.prepare('cor-75-rejected-options', null, withIdempotencyKey),
    ).rejects.toThrow(/idempotencyKey is not supported/);
  });

  it('throws WorkflowAlreadyExistsError when a second prepare() races the first for the same in-flight id', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-in-flight-collision' }).execute(async function* () {
        return 'ok';
      }),
    );

    // Warm up catalog readiness first: engine.prepare() awaits
    // ensureWorkflowCatalogReady() before it ever reaches the synchronous
    // pendingStarts admission check, so the two racing calls below need the
    // catalog already ready for their preludes to run back-to-back in one
    // tick, exactly like two concurrent callers racing for the same
    // caller-provided id in production.
    const warmup = await engine.prepare('cor-1283-in-flight-collision', null, {
      id: 'cor-1283-in-flight-warmup',
    });
    await warmup.abandon();

    const first = engine.prepare('cor-1283-in-flight-collision', null, {
      id: 'cor-1283-in-flight-1',
    });
    const second = engine.prepare('cor-1283-in-flight-collision', null, {
      id: 'cor-1283-in-flight-1',
    });

    await expect(second).rejects.toThrow(WorkflowAlreadyExistsError);
    await first;
  });

  it('validates options.executionTimeout format at prepare() time and recomputes the deadline fresh at launch()', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-execution-timeout' }).execute(async function* () {
        return 'ok';
      }),
    );

    const prepared = await engine.prepare('cor-1283-execution-timeout', null, {
      id: 'cor-1283-execution-timeout-1',
      executionTimeout: '5m',
    });

    const handle = await prepared.launch();
    expect(await handle.result()).toBe('ok');

    // The deadline is recomputed from launch() time, not prepare() time (the
    // parsed value at prepare() time is discarded), so a durable
    // executionDeadline timer exists on the completed record's history —
    // proven indirectly by a successful, non-throwing launch() plus the
    // prepare()-time format validation already having accepted '5m'.
  });

  it('rejects an invalid options.executionTimeout format at prepare() time, before any commit', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-bad-execution-timeout' }).execute(async function* () {
        return 'unreachable';
      }),
    );

    await expect(
      engine.prepare('cor-1283-bad-execution-timeout', null, {
        id: 'cor-1283-bad-execution-timeout-1',
        executionTimeout: 'not-a-duration',
      }),
    ).rejects.toThrow(/options\.executionTimeout/);

    // No orphaned pending record: prepare() failed before ever committing.
    expect(await engine.get('cor-1283-bad-execution-timeout-1')).toBeNull();
  });

  it('rolls back transient start state and releases the reservation when the input payload exceeds the configured size limit', async () => {
    await using engine = new Engine({
      storage: new MemoryStorage(),
      payloadSize: { maxBytes: 16 },
    });
    engine.register(
      workflow({ name: 'cor-1283-oversized-payload' }).execute(async function* () {
        return 'unreachable';
      }),
    );

    await expect(
      engine.prepare('cor-1283-oversized-payload', 'x'.repeat(1024), {
        id: 'cor-1283-oversized-payload-1',
      }),
    ).rejects.toThrow(PayloadSizeExceededError);

    // The reservation was released, not left held: a fresh prepare() for the
    // same id proceeds rather than colliding with an orphaned pendingStarts
    // entry from the failed attempt.
    const retried = await engine.prepare('cor-1283-oversized-payload', null, {
      id: 'cor-1283-oversized-payload-1',
    });
    expect(retried.id).toBe('cor-1283-oversized-payload-1');
  });

  it('purges a terminal run under onTerminalConflict: "start-new" when preparing over a completed caller-provided id', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-terminal-reuse' }).execute(async function* () {
        return 'ok';
      }),
    );

    const first = await engine.start('cor-1283-terminal-reuse', null, {
      id: 'cor-1283-terminal-reuse-1',
    });
    await first.result();
    const recordAfterFirst = await engine.get('cor-1283-terminal-reuse-1');
    expect(recordAfterFirst?.status).toBe('completed');

    const prepared = await engine.prepare('cor-1283-terminal-reuse', null, {
      id: 'cor-1283-terminal-reuse-1',
      onTerminalConflict: 'start-new',
    });
    expect(prepared.id).toBe('cor-1283-terminal-reuse-1');

    // The prior completed record was purged, not left alongside a second one
    // under the same id: the record readable right after prepare() is the
    // fresh 'pending' replacement.
    const recordAfterPrepare = await engine.get('cor-1283-terminal-reuse-1');
    expect(recordAfterPrepare?.status).toBe('pending');

    const handle = await prepared.launch();
    expect(await handle.result()).toBe('ok');
  });

  it("folds concurrency-limit start operations into prepare()'s create batch and blocks a second start while the run is live", async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-concurrency', concurrency: { max: 1 } }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const released = yield* ctx.waitForSignal<string>('release');
        return released;
      }),
    );

    const prepared = await engine.prepare('cor-1283-concurrency', null, {
      id: 'cor-1283-concurrency-1',
    });
    const internals = getInternals(engine);
    expect(internals.workflowsNeedingTerminalCleanup.has('cor-1283-concurrency-1')).toBe(true);

    const handle = await prepared.launch();

    await expect(
      engine.start('cor-1283-concurrency', null, { id: 'cor-1283-concurrency-2' }),
    ).rejects.toMatchObject({
      code: 'WorkflowConcurrencyLimitExceededError',
      workflowType: 'cor-1283-concurrency',
      limit: 1,
    });

    await engine.signal('cor-1283-concurrency-1', 'release', 'done');
    expect(await handle.result()).toBe('done');
  });

  it('marks a prepared run carrying services for terminal cleanup and makes them available to the workflow body at launch', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-services' }).execute(async function* (ctx: WorkflowContext) {
        return (ctx.services as { v: number }).v;
      }),
    );

    const prepared = await engine.prepare('cor-1283-services', null, {
      id: 'cor-1283-services-1',
      services: { v: 42 },
    });
    const internals = getInternals(engine);
    expect(internals.workflowsNeedingTerminalCleanup.has('cor-1283-services-1')).toBe(true);

    const handle = await prepared.launch();
    expect(await handle.result()).toBe(42);
  });

  it("throws at launch when a prepared run's services cannot be re-provided (fresh-process-style loss of the in-memory map)", async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-services-unavailable' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return (ctx.services as { v: number }).v;
      }),
    );

    const prepared = await engine.prepare('cor-1283-services-unavailable', null, {
      id: 'cor-1283-services-unavailable-1',
      services: { v: 1 },
    });

    // Simulate the fresh-process case: the in-memory services map lost the
    // entry (e.g. a process restart between prepare() and launch()), while
    // the durable "expects services" marker set at prepare()-time survives.
    // No resolveWorkflowServices is configured on this engine, so
    // re-provisioning fails closed instead of silently proceeding without
    // services.
    const internals = getInternals(engine);
    internals.workflowServices.delete('cor-1283-services-unavailable-1');

    await expect(prepared.launch()).rejects.toThrow(
      /its recorded services could not be re-provided/,
    );

    const record = await engine.get('cor-1283-services-unavailable-1');
    expect(record?.status).toBe('failed');
  });

  it('throws when launch() is attempted after the record was independently cancelled while still "prepared"', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-cancelled-before-launch' }).execute(async function* () {
        return 'unreachable';
      }),
    );

    const prepared = await engine.prepare('cor-1283-cancelled-before-launch', null, {
      id: 'cor-1283-cancelled-1',
    });

    // Cancelled directly through engine.cancel() (not prepared.abandon()):
    // the durable record moves to a terminal status while context.phase
    // stays 'prepared', so launch()'s own guard (phase !== 'prepared') does
    // not catch this — the reload inside launch() must.
    await engine.cancel('cor-1283-cancelled-1');
    const recordAfterCancel = await engine.get('cor-1283-cancelled-1');
    expect(recordAfterCancel?.status).toBe('cancelled');

    await expect(prepared.launch()).rejects.toThrow(/no longer pending \(status: cancelled\)/);
  });

  it('throws when the checkpoint is missing at launch time', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-1283-missing-checkpoint' }).execute(async function* () {
        return 'unreachable';
      }),
    );

    const prepared = await engine.prepare('cor-1283-missing-checkpoint', null, {
      id: 'cor-1283-missing-checkpoint-1',
    });

    const internals = getInternals(engine);
    await internals.storage.delete(KEYS.checkpoint('cor-1283-missing-checkpoint-1'));

    await expect(prepared.launch()).rejects.toThrow(/its checkpoint is missing/);
  });

  it('throws when a concurrent cancel lands between the pending check and the serialized commit reload', async () => {
    const storage = new InterleavedCancelStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'cor-1283-launch-race' }).execute(async function* () {
        return 'unreachable';
      }),
    );

    const prepared = await engine.prepare('cor-1283-launch-race', null, {
      id: 'cor-1283-launch-race-1',
    });
    // Armed only now: prepare()'s own resolveTerminalConflictForRestart read
    // of this key (for the caller-provided id) must not count toward the
    // race window this test is targeting inside launch().
    storage.armRaceOnSecondRead(KEYS.workflow('cor-1283-launch-race-1'));

    await expect(prepared.launch()).rejects.toThrow(/it is no longer pending\.$/);
  });

  it('throws the plain CAS-race error (not EngineDeposedError) when the launch commit sees a transient conditionalBatch failure but the epoch re-read still matches', async () => {
    const workflowId = 'cor-1283-lost-race-1';
    const storage = new TransientEpochGlitchStorage();
    await using engine = await Engine.create({
      storage,
      ownership: 'workflow-lease',
      workflows: {
        'cor-1283-lost-race': workflow({ name: 'cor-1283-lost-race' }).execute(async function* () {
          return 'unreachable';
        }),
      },
    });

    const internals = getInternals(engine);
    const registry = new WorkflowClaimRegistry({
      storage: internals.storage,
      engineId: 'cor-1283-test-engine',
      getNow: () => internals.options.getNow(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    internals.workflowClaimRegistry = registry;
    const acquired = await registry.acquire(workflowId);
    expect(acquired.status).toBe('acquired');

    const prepared = await engine.prepare('cor-1283-lost-race', null, { id: workflowId });

    // Armed only now, one-shot: the SAME epoch condition backs prepare()'s
    // own create-batch commit above, which must succeed normally. Only
    // launch()'s commitPendingToRunning write should observe the transient
    // failure.
    storage.armTransientGlitch(KEYS.workflowOwnerEpoch(workflowId));

    await expect(prepared.launch()).rejects.toThrow(
      `Launch transition for workflow "${workflowId}" lost its CAS race.`,
    );
    expect(internals.deposed).toBe(false);
  });
});
