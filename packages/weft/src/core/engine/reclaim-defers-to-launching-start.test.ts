/**
 * A delayed start's fire, and a prepared start's launch, hold the claim they folded or committed
 * under across the awaits between their `running` commit and their launch: a re-provision of the
 * run's services, the terminal-cleanup marker read, the start headers. In that window the run is
 * neither queued nor live, so a reclaim pass whose listing predates the fold redrove it: it found
 * nothing to defer to and nothing live, replayed from storage, and the fire then adopted over that
 * replay and enqueued under the same epoch, so two generators drove one generation (COR-1625).
 *
 * The launch now records a launching marker in the turn its commit lands, which a reclaim defers
 * to exactly as it defers to a queued inline start. `engine.get()` keeps reporting `running`. A
 * launch that stops short of its generator lets the run go, claim included, so the next reclaim
 * pass lists the run ownerless and drives it once.
 *
 * Scheduling is `'manual'`, so a queued launch stays queued until the test flushes it, and the
 * reclaim pass is driven by hand, so the listing can be held across the fire's commit.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage, type BatchOperation } from "../../embedded/storage/src/index.ts";
import { createDeferred, waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { workflow, type EngineOptions, type WorkflowServicesResolution } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  hasQueuedInlineWorkflowStart,
  hasQueuedOrLaunchingInlineWorkflowStart,
} from './local-execution.ts';
import { countingWorkflow, letOtherDrivesStart, probeFor } from './reclaim-race.test-support.ts';
import { decodeWorkflowState } from './validation.ts';
import type { WorkflowClaimRenewalPassResult } from './workflow-claim-renewal-task.ts';

const WORKFLOW_ID = 'launching-run';
const START_AT = 1_000_000;
const WORKER_URL = new URL('../../workers/test-browser-worker.ts', import.meta.url);

const RECLAIMED = {
  status: 'completed',
  outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
};

/** The attempts a refused terminal write makes, with the waits between them shortened to none. */
const FAILURE_WRITE_RETRY_DELAYS = [0, 0, 0, 0];
const FAILURE_WRITE_ATTEMPTS = FAILURE_WRITE_RETRY_DELAYS.length + 1;

class RacingStorage extends MemoryStorage {
  /** While set, the holder scan of a reclaim listing waits here. */
  holderScanGate: PromiseWithResolvers<void> | null = null;
  readonly reachedHolderScan = Promise.withResolvers<void>();
  /** While set, the next read of this key waits until `releaseHeldRead` is called. */
  holdReadOf: string | null = null;
  readonly reachedHeldRead = Promise.withResolvers<void>();
  readonly #heldRead = Promise.withResolvers<void>();
  /** When set, the next read of this key throws once. */
  failReadOf: string | null = null;
  readReadFailures = 0;
  /**
   * How many of the next conditional batches that write the run as `failed` throw. The engine
   * retries a refused terminal write (COR-1626), so a fault that outlasts every attempt is one per
   * attempt: `FAILURE_WRITE_ATTEMPTS`.
   */
  failedWritesToFault = 0;
  failedWriteFaults = 0;
  /** When set, the next conditional batch that writes the run as `running` is refused once. */
  refuseNextRunningWrite = false;
  refusedRunningWrites = 0;
  /**
   * When set, runs once storage has applied a conditional batch that writes the run as `running`,
   * before that batch call returns to the launch: a continuation it queues runs ahead of the launch's.
   */
  onRunningWriteApplied: (() => void) | null = null;

  releaseHeldRead(): void {
    this.#heldRead.resolve();
  }

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.holderScanGate !== null && prefix === KEYS.workflowOwnerHolder('')) {
      const gate = this.holderScanGate;
      this.holderScanGate = null;
      this.reachedHolderScan.resolve();
      await gate.promise;
    }
    yield* super.scan(prefix, options);
  }

  /**
   * The hold and the fault apply to a key however it is read: `get`, or `has` (`storageHas`). A held
   * read resumes as promptly as a backend can answer, in the turn after its release. `get` returns
   * the chained promise rather than being an `async` method on purpose: an `async` wrapper adds a
   * turn, and the race tests below would then decide which continuation runs first by enqueue order
   * rather than by the order the engine imposes.
   */
  #interceptRead(key: string): Promise<void> {
    if (key === this.holdReadOf) {
      this.holdReadOf = null;
      this.reachedHeldRead.resolve();
      return this.#heldRead.promise;
    }
    if (key === this.failReadOf) {
      this.failReadOf = null;
      this.readReadFailures++;
      return Promise.reject(new Error('transient storage error in the launch window'));
    }
    return Promise.resolve();
  }

  override get(key: string): Promise<Uint8Array | null> {
    return this.#interceptRead(key).then(() => super.get(key));
  }

  override async has(key: string): Promise<boolean> {
    await this.#interceptRead(key);
    return super.has(key);
  }

  override async conditionalBatch(
    ...args: Parameters<MemoryStorage['conditionalBatch']>
  ): ReturnType<MemoryStorage['conditionalBatch']> {
    const [, operations] = args;
    const written = operations.find(
      (operation): operation is BatchOperation & { type: 'put' } =>
        operation.type === 'put' && operation.key === KEYS.workflow(WORKFLOW_ID),
    );
    const status = written === undefined ? undefined : decodeWorkflowState(written.value).status;
    if (this.failedWritesToFault > 0 && status === 'failed') {
      this.failedWritesToFault--;
      this.failedWriteFaults++;
      throw new Error('transient storage error on the terminal write');
    }
    if (this.refuseNextRunningWrite && status === 'running') {
      this.refuseNextRunningWrite = false;
      this.refusedRunningWrites++;
      return false;
    }
    if (this.onRunningWriteApplied !== null && status === 'running') {
      const applied = this.onRunningWriteApplied;
      this.onRunningWriteApplied = null;
      const committed = await super.conditionalBatch(...args);
      applied();
      return committed;
    }
    return super.conditionalBatch(...args);
  }
}

type Clock = { now: number };

function createClock(): Clock {
  return { now: START_AT - 60_000 };
}

/** A resolver the test holds, or answers as it chooses. */
function createResolver(answer: () => WorkflowServicesResolution) {
  const reached = createDeferred();
  const release = createDeferred();
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    option: async (): Promise<WorkflowServicesResolution> => {
      reached.resolve();
      await release.promise;
      return answer();
    },
  };
}

function createInlineEngine(
  storage: RacingStorage,
  clock: Clock,
  options: Pick<EngineOptions, 'resolveWorkflowServices'> = {},
) {
  return Engine.create({
    storage,
    workflows: { counted: countingWorkflow(storage) },
    ownership: 'workflow-lease',
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    inlineLaunchScheduling: 'manual',
    getNow: () => clock.now,
    ...options,
  });
}

const simpleWorkflow = workflow({ name: 'simple' }).execute(async function* (_ctx, input) {
  return { input, computed: 42 };
});

function createWorkerEngine(storage: RacingStorage, clock: Clock) {
  return Engine.create({
    storage,
    workflows: { simple: simpleWorkflow },
    workflowExecutionMode: 'worker',
    workerExecution: { workerUrl: WORKER_URL, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
    ownership: 'workflow-lease',
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    getNow: () => clock.now,
  });
}

type AnyEngine =
  Awaited<ReturnType<typeof createInlineEngine>> | Awaited<ReturnType<typeof createWorkerEngine>>;

/** Starts a reclaim pass and holds its listing inside the holder scan. */
async function holdReclaimListing(
  engine: AnyEngine,
  storage: RacingStorage,
): Promise<{ pass: Promise<WorkflowClaimRenewalPassResult>; release: () => void }> {
  const gate = Promise.withResolvers<void>();
  storage.holderScanGate = gate;
  const pass = getInternals(engine).workflowClaimRenewalTask!.runOnce();
  await storage.reachedHolderScan.promise;
  return { pass, release: () => gate.resolve() };
}

function countEvents(engine: AnyEngine): { started: number; resumed: number } {
  const counts = { started: 0, resumed: 0 };
  engine.addEventListener('workflow:started', () => {
    counts.started++;
  });
  engine.addEventListener('workflow:resumed', () => {
    counts.resumed++;
  });
  return counts;
}

/** What the engine shows of the run while a launch is held in its window. */
async function observeWindow(engine: AnyEngine) {
  const internals = getInternals(engine);
  const state = await engine.get(WORKFLOW_ID);
  return {
    launching: hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID),
    queued: hasQueuedInlineWorkflowStart(internals, WORKFLOW_ID),
    status: state?.status,
  };
}

/** The window of a held launch: the run is launching, not queued, and `engine.get()` says running. */
const LAUNCHING_WINDOW: Awaited<ReturnType<typeof observeWindow>> = {
  launching: true,
  queued: false,
  status: 'running',
};

async function statusOf(storage: RacingStorage): Promise<string | undefined> {
  const bytes = await storage.get(KEYS.workflow(WORKFLOW_ID));
  return bytes === null ? undefined : decodeWorkflowState(bytes).status;
}

describe('a reclaim that lists a delayed start between its fold and its launch', () => {
  it('defers to the fire, which drives the run once (inline)', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createInlineEngine(storage, clock);
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    // The activity is held, so a run still in flight when a second generator starts shows two runs.
    probe.hold = Promise.withResolvers<void>();
    await engine.start('counted', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    // The listing's exclude set predates the fire's fold, so the pass lists the fire's own claim.
    const listing = await holdReclaimListing(engine, storage);
    // The fire commits, folds its claim, and is held in the window, at the cleanup marker read.
    storage.holdReadOf = KEYS.terminalCleanupNeeded(WORKFLOW_ID);
    const fire = engine.scheduler.tick(clock.now);
    await storage.reachedHeldRead.promise;
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).not.toBeNull();
    const window = await observeWindow(engine);

    // The pass reaches the run while the fire is held, and leaves it to the fire.
    listing.release();
    const result = await listing.pass;
    await letOtherDrivesStart();
    const runsBeforeTheFireLaunched = probe.runs;

    storage.releaseHeldRead();
    await fire;
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the fire drives the run' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(runsBeforeTheFireLaunched).toBe(0);
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(window).toEqual(LAUNCHING_WINDOW);
  });

  it('defers to the fire, which drives the run once (worker)', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createWorkerEngine(storage, clock);
    const internals = getInternals(engine);
    const events = countEvents(engine);
    await engine.start('simple', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    const listing = await holdReclaimListing(engine, storage);
    storage.holdReadOf = KEYS.terminalCleanupNeeded(WORKFLOW_ID);
    const fire = engine.scheduler.tick(clock.now);
    await storage.reachedHeldRead.promise;
    const window = await observeWindow(engine);

    listing.release();
    const result = await listing.pass;

    storage.releaseHeldRead();
    await fire;
    // A worker never enqueues, so the launch settles the marker itself once the worker has the run.
    const launchingAfterTheFire = hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID);
    expect(await engine.getHandle(WORKFLOW_ID).result()).toEqual({ input: null, computed: 42 });
    // The fire started the run once; the reclaim replayed nothing.
    expect(events).toEqual({ started: 1, resumed: 0 });
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(window).toEqual(LAUNCHING_WINDOW);
    expect(launchingAfterTheFire).toBe(false);
  });
});

describe('a reclaim that lists a prepared start between its commit and its launch', () => {
  it('defers to the launch, which drives the run once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'available', services: { owner: 'again' } }));
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    probe.hold = Promise.withResolvers<void>();

    // The listing's exclude set predates the prepare's claim, so the pass lists it; the launch
    // then commits `running` and is held in its window, at the re-provision.
    const listing = await holdReclaimListing(engine, storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    // The services left memory with the process that prepared the run, so the launch re-provides.
    internals.workflowServices.delete(WORKFLOW_ID);
    const launching = prepared.launch();
    await resolver.reached;
    const window = await observeWindow(engine);

    // The pass reaches the run while the launch is held, and leaves it to the launch. It is not
    // awaited while the resolver is held: a replay of its own would wait on that resolver too.
    listing.release();
    await letOtherDrivesStart();
    const runsBeforeTheLaunch = probe.runs;

    resolver.release();
    const handle = await launching;
    const result = await listing.pass;
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the launch drives the run' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await handle.result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(runsBeforeTheLaunch).toBe(0);
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(window).toEqual(LAUNCHING_WINDOW);
  });
});

describe('a reclaim that resumes inside the commit that makes a launch visible as running', () => {
  // The listing's exclude set predates the start's claim, and the pass resumes once storage has
  // applied the launch's `running` batch and before that batch call returns to the launch, so the
  // pass's continuation runs ahead of the launch's own (Codex 4343853738). The pass must defer at
  // its first check. A pass that decided to replay would still be stopped later, by the replay's own
  // deferral on the marker, so the observation is whether the pass reached the replay at all, through
  // the engine's replay seam.
  it('defers to a prepared launch at its first check, and the launch drives the run once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createInlineEngine(storage, clock);
    const probe = probeFor(storage);
    probe.hold = Promise.withResolvers<void>();
    const counts = countEvents(engine);
    let replaysReached = 0;
    getInternals(engine).reclaimReplayGateForTesting = async () => {
      replaysReached++;
    };

    const listing = await holdReclaimListing(engine, storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    // The pass lists the prepared run's claim, which this engine holds, and reaches its last
    // storage read before the drive, the run's state; that read is held until the launch's
    // `running` batch has applied, so the pass resumes with the run running and no turn to spare.
    storage.holdReadOf = KEYS.workflow(WORKFLOW_ID);
    listing.release();
    await storage.reachedHeldRead.promise;
    storage.onRunningWriteApplied = () => storage.releaseHeldRead();
    const handle = await prepared.launch();
    const result = await listing.pass;
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the launch drives the run' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await handle.result()).toBe('ran');
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(replaysReached).toBe(0);
    expect(probe.runs).toBe(1);
    expect(counts).toEqual({ started: 1, resumed: 0 });
  });

  // The delayed fire records its marker in the same synchronous block that records the claim it
  // folded, so no reclaim can see that claim held without the marker: this test documents an
  // interleaving the code already excludes, and keeps the end-to-end outcome pinned if that changes.
  it('defers to a delayed fire at its first check, and the fire drives the run once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createInlineEngine(storage, clock);
    const probe = probeFor(storage);
    probe.hold = Promise.withResolvers<void>();
    const counts = countEvents(engine);
    let replaysReached = 0;
    getInternals(engine).reclaimReplayGateForTesting = async () => {
      replaysReached++;
    };
    await engine.start('counted', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    const listing = await holdReclaimListing(engine, storage);
    storage.onRunningWriteApplied = listing.release;
    await engine.scheduler.tick(clock.now);
    const result = await listing.pass;
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the fire drives the run' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(replaysReached).toBe(0);
    expect(probe.runs).toBe(1);
    expect(counts).toEqual({ started: 1, resumed: 0 });
  });
});

describe('a prepared launch whose commit loses its race', () => {
  it('settles the record it made before the commit, and keeps the claim and the pending run', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createInlineEngine(storage, clock);
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    const epochAfterPrepare = internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID);
    expect(epochAfterPrepare).not.toBeNull();

    storage.refuseNextRunningWrite = true;
    const rejection = await rejectionOf(prepared.launch());
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('lost its CAS race');

    expect(storage.refusedRunningWrites).toBe(1);
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).toBe(epochAfterPrepare);
    expect(await statusOf(storage)).toBe('pending');
    const reported = await engine.get(WORKFLOW_ID);
    expect(reported?.status).toBe('pending');
    await engine.flushInlineLaunches();
    expect(probe.runs).toBe(0);
  });
});

describe('a delayed start that stops short of its launch', () => {
  it('lets the run go when the window throws, and the next reclaim pass drives it once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createInlineEngine(storage, clock);
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    await engine.start('counted', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    storage.failReadOf = KEYS.terminalCleanupNeeded(WORKFLOW_ID);
    // The scheduler reports a timer callback that threw on the console. The injected fault is
    // expected, so it is captured and asserted rather than left in the test output, and the spy
    // stays until the fire has reported and let the run go.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    let reported: string | undefined;
    try {
      await engine.scheduler.tick(clock.now);
      await waitForCondition(() => consoleError.mock.calls.length === 1, {
        label: 'the scheduler reports the failed fire',
      });
      reported = String(consoleError.mock.calls[0]?.[0]);
      await waitForCondition(() => registry.currentEpoch(WORKFLOW_ID) === null, {
        label: 'the fire lets the run go',
      });
    } finally {
      consoleError.mockRestore();
    }
    expect(reported).toContain('Timer callback failed');
    expect(storage.readReadFailures).toBe(1);
    expect(probe.runs).toBe(0);
    // The marker is settled and the folded claim released: the run is running and ownerless.
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).toBeNull();
    expect(await statusOf(storage)).toBe('running');

    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(() => probe.runs === 1, { label: 'the next pass drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });

  it('fails the run and starts no generator when its services are unavailable', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    await engine.scheduler.tick(clock.now);
    await engine.flushInlineLaunches();
    expect(await statusOf(storage)).toBe('failed');
    expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(false);
    expect(probe.runs).toBe(0);
    // The failure released the claim with the run; the marker is settled with it.
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).toBeNull();
  });

  it('lets the run go when the failure commit faults, and the next reclaim pass fails it', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    internals.storageWriteRetryDelaysForTesting = FAILURE_WRITE_RETRY_DELAYS;
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    storage.failedWritesToFault = FAILURE_WRITE_ATTEMPTS;
    await engine.scheduler.tick(clock.now);
    expect(storage.failedWriteFaults).toBe(FAILURE_WRITE_ATTEMPTS);
    expect(await statusOf(storage)).toBe('running');
    // The marker is settled and the folded claim released, so the run is not hidden from the scan.
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();

    // The next pass acquires the ownerless run and reaches the replay, which fails it for its
    // services instead of deferring to a marker nothing drives.
    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(async () => (await statusOf(storage)) === 'failed', {
      label: 'the next pass fails the run',
    });
    expect(probe.runs).toBe(0);
    expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(false);
  });
});

describe('a delayed start that stops short while a same-id replacement lands', () => {
  it('lets go of only its own marker and claim, and the replacement drives once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    probe.hold = Promise.withResolvers<void>();
    const events = countEvents(engine);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    // The services-unavailable failure commits `failed` and releases the fold's claim, then awaits
    // its cleanup. A same-id `start-new` replacement lands in that window: it folds the next epoch
    // and queues its launch, so it holds the id's claim and marker when the old fire's `finally`
    // runs. Modelled by starting the replacement right after the first release of the id resolves.
    const originalRelease = registry.release.bind(registry);
    let replaced = false;
    registry.release = async (workflowId, expectedEpoch) => {
      const result = await originalRelease(workflowId, expectedEpoch);
      if (!replaced && workflowId === WORKFLOW_ID) {
        replaced = true;
        await engine.start('counted', null, { id: WORKFLOW_ID, onTerminalConflict: 'start-new' });
      }
      return result;
    };
    await engine.scheduler.tick(clock.now);
    const replacementEpoch = registry.currentEpoch(WORKFLOW_ID);
    expect(replacementEpoch).toBe(2);
    // The old fire let go of its own record only: the replacement's claim, marker and queued start
    // are intact.
    expect(await observeWindow(engine)).toEqual({
      launching: true,
      queued: true,
      status: 'pending',
    });
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).not.toBeNull();

    // This engine's next reclaim pass finds the id held and queued under its claim, and defers; the
    // flush then drives the replacement once.
    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject({ status: 'completed' });
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the replacement runs' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(events).toEqual({ started: 1, resumed: 0 });
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();
  });

  it('keeps a prepared replacement claim, which then launches and drives once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    // A prepared `start-new` replacement commits the next epoch in the same window and holds that
    // claim until its `launch()`, with no launching record yet. The old fire's let-go must release
    // only the epoch it recorded, or the replacement's own `launch()` finds itself deposed.
    let prepared: Awaited<ReturnType<typeof engine.prepare>> | undefined;
    const originalRelease = registry.release.bind(registry);
    registry.release = async (workflowId, expectedEpoch) => {
      const result = await originalRelease(workflowId, expectedEpoch);
      if (prepared === undefined && workflowId === WORKFLOW_ID) {
        prepared = await engine.prepare('counted', null, {
          id: WORKFLOW_ID,
          onTerminalConflict: 'start-new',
        });
      }
      return result;
    };
    await engine.scheduler.tick(clock.now);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBe(2);
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).not.toBeNull();

    await prepared!.launch();
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the replacement runs' });
    await letOtherDrivesStart();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });
});

describe('a prepared start that stops short of its launch', () => {
  it('fails the run, settles the marker, and releases the claim when the failure commits', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    const outcome = await prepared.launch().then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await engine.flushInlineLaunches();
    expect(outcome).toContain('could not be re-provided');
    expect(await statusOf(storage)).toBe('failed');
    expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(false);
    expect(probe.runs).toBe(0);
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).toBeNull();
  });

  it('lets the run go when the failure commit faults, and the next reclaim pass fails it', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    internals.storageWriteRetryDelaysForTesting = FAILURE_WRITE_RETRY_DELAYS;
    const probe = probeFor(storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    storage.failedWritesToFault = FAILURE_WRITE_ATTEMPTS;
    const outcome = await prepared.launch().then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    expect(outcome).not.toBe('resolved');
    expect(storage.failedWriteFaults).toBe(FAILURE_WRITE_ATTEMPTS);
    expect(await statusOf(storage)).toBe('running');
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).toBeNull();

    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(async () => (await statusOf(storage)) === 'failed', {
      label: 'the next pass fails the run',
    });
    expect(probe.runs).toBe(0);
  });

  it('settles its marker once a worker has the run', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createWorkerEngine(storage, clock);
    const internals = getInternals(engine);
    const events = countEvents(engine);
    const prepared = await engine.prepare('simple', null, { id: WORKFLOW_ID });
    const handle = await prepared.launch();
    const launchingAfterTheLaunch = hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID);
    expect(await handle.result()).toEqual({ input: null, computed: 42 });
    expect(events.started).toBe(1);
    expect(launchingAfterTheLaunch).toBe(false);
  });
});

describe('an old queued start whose flush is in flight when a same-id replacement launches', () => {
  it("leaves the replacement's record alone: it reads running, stays launching, and drives once", async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'available', services: { owner: 'again' } }));
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    probe.hold = Promise.withResolvers<void>();

    // The old run starts and its inline launch is queued; its flush is held at its first state
    // read, past the point where the queue drained it.
    await engine.start('counted', null, { id: WORKFLOW_ID });
    storage.holdReadOf = KEYS.workflow(WORKFLOW_ID);
    const flush = engine.flushInlineLaunches();
    await storage.reachedHeldRead.promise;

    // While that flush is held the old run is cancelled (the drop of a queued start finds nothing,
    // since the flush already drained it), and a same-id prepared replacement launches and is
    // held in its window at the re-provision. A reclaim listing predates the replacement.
    await engine.cancel(WORKFLOW_ID);
    const listing = await holdReclaimListing(engine, storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      onTerminalConflict: 'start-new',
      services: { owner: 'replacement' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    const launching = prepared.launch();
    await resolver.reached;
    const windowBeforeTheOldFlushSettled = await observeWindow(engine);

    // The old flush resumes, finds the run is not its generation, and settles only its own record.
    storage.releaseHeldRead();
    await flush;
    const windowAfterTheOldFlushSettled = await observeWindow(engine);

    // The reclaim reaches the replacement while it is held, and leaves it to its launch.
    listing.release();
    await letOtherDrivesStart();
    const runsBeforeTheLaunch = probe.runs;

    resolver.release();
    const handle = await launching;
    const result = await listing.pass;
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the replacement runs' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await handle.result()).toBe('ran');
    expect(windowBeforeTheOldFlushSettled).toEqual(LAUNCHING_WINDOW);
    expect(windowAfterTheOldFlushSettled).toEqual(LAUNCHING_WINDOW);
    expect(runsBeforeTheLaunch).toBe(0);
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(probe.runs).toBe(1);
  });
});

describe('an engine disposed while a delayed start is in its launching window', () => {
  it('leaves no launching record behind', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const engine = await createInlineEngine(storage, clock);
    const internals = getInternals(engine);
    await engine.start('counted', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    // The fire holds its launching record across the terminal-cleanup read. A synchronous disposal
    // in that window clears it with every other record, since no queue entry will ever settle it.
    storage.holdReadOf = KEYS.terminalCleanupNeeded(WORKFLOW_ID);
    const fire = engine.scheduler.tick(clock.now);
    await storage.reachedHeldRead.promise;
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(true);

    engine[Symbol.dispose]();
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    storage.releaseHeldRead();
    await fire.catch(() => undefined);
  });
});
