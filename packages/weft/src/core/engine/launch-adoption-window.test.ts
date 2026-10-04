/**
 * What a launch holds from the moment it adopts its workflow id until its start batch commits
 * (COR-1408).
 *
 * The launch that adopts an id is the only writer of the run's transient state: its services and
 * its membership in terminal cleanup. It installs both at adoption, in the same synchronous step
 * that installs the run's checkpoint, and not when its create batch has committed. The create
 * batch is awaited, and a terminal operation that lands while it commits reads that membership
 * synchronously to decide whether the run it terminalizes owes the durable cleanup timer that
 * sweeps the run's scratch markers. A run whose start batch wrote those markers must therefore
 * already be a member when the batch is in flight, or a cancel or timeout in that window writes
 * its terminal state with no token and no timer, and the markers are never swept.
 *
 * Each case holds the create batch of one launch, drives a terminal operation into that window,
 * and checks the durable rows the terminalization wrote. The same cases cover a scheduled
 * occurrence (across the ways its services resolve) and the plain `engine.start` and
 * `engine.prepare` entry points, whose runs hold services or a concurrency slot. A start that is
 * rejected after it adopted the id still leaves nothing behind, and one that outlives its engine
 * installs nothing.
 *
 * This file imports nothing that is not on main, so it also runs against 244ef383.
 */
import { describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createDeferred, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec/api.ts';
import {
  workflow,
  type EngineOptions,
  type ScheduleState,
  type WorkflowContext,
  type WorkflowState,
} from '../types.ts';
import { createScheduleCallbacks } from './callback-creators-schedule.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { startScheduledRun } from './schedule-run.ts';

const WORKFLOW_ID = 'window-run';
const PARKED_TYPE = 'window-parked';
const LIMITED_TYPE = 'window-limited';
const SERVICES = { owner: 'the launch' };

type Gate = {
  /** Settles once the gated call is held. */
  reached: Promise<void>;
  release(): void;
  fail(error: Error): void;
};

function createGate() {
  const reached = createDeferred();
  const outcome = createDeferred();
  const gate: Gate = {
    reached: reached.promise,
    release: () => outcome.resolve(),
    fail: (error) => outcome.reject(error),
  };
  return { gate, reached, outcome };
}

/** Reads of one key that the storage is holding, oldest first, until the test releases them. */
type HeldReads = {
  /** How many reads of the key are held right now. */
  readonly count: number;
  /** Let the oldest held read through. */
  releaseOldest(): void;
  /** Let every held read through, and stop holding the reads that follow. */
  releaseAll(): void;
};

/**
 * Memory storage that can hold the create batch of one workflow, which is the batch that writes
 * its record, and every read of one key, until the test releases or refuses them.
 */
class GatedStorage extends MemoryStorage {
  #createBatch: ReturnType<typeof createGate> | undefined;
  #createBatchKey = '';
  #heldReadKey: string | undefined;
  readonly #heldReads: (() => void)[] = [];

  holdCreateBatch(workflowId: string): Gate {
    this.#createBatch = createGate();
    this.#createBatchKey = KEYS.workflow(workflowId);
    return this.#createBatch.gate;
  }

  /** Hold every read of `key` from now on, until it is released one at a time or all at once. */
  holdReads(key: string): HeldReads {
    this.#heldReadKey = key;
    const held = this.#heldReads;
    return {
      get count() {
        return held.length;
      },
      releaseOldest: () => held.shift()?.(),
      releaseAll: () => {
        this.#heldReadKey = undefined;
        for (const release of held.splice(0)) release();
      },
    };
  }

  async #holdCreateBatch(operations: readonly BatchOperation[]): Promise<void> {
    const held = this.#createBatch;
    if (held === undefined) return;
    const createsTheRecord = operations.some(
      (operation) => operation.type === 'put' && operation.key === this.#createBatchKey,
    );
    if (!createsTheRecord) return;
    this.#createBatch = undefined;
    held.reached.resolve();
    await held.outcome.promise;
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === this.#heldReadKey) {
      const released = createDeferred();
      this.#heldReads.push(() => released.resolve());
      await released.promise;
    }
    return super.get(key);
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    await this.#holdCreateBatch(operations);
    return super.batch(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    await this.#holdCreateBatch(operations);
    return super.conditionalBatch(conditions, operations);
  }
}

async function settle(promise: Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function rejectionReason(outcome: PromiseSettledResult<unknown>): unknown {
  if (outcome.status !== 'rejected') throw new Error('Expected the launch to reject');
  return outcome.reason;
}

/** `wf-cleanup:` is `KEYS.terminalCleanup`'s prefix; each entry's value is the workflow id. */
async function countCleanupTimers(storage: MemoryStorage, workflowId: string): Promise<number> {
  let count = 0;
  for await (const [, value] of storage.scan('wf-cleanup:')) {
    if (decode(value) === workflowId) count += 1;
  }
  return count;
}

async function readState(storage: MemoryStorage, workflowId: string): Promise<WorkflowState> {
  const bytes = await storage.get(KEYS.workflow(workflowId));
  if (bytes === null) throw new Error(`the storage holds no record for ${workflowId}`);
  return decode(bytes) as WorkflowState;
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

type ServicesResolution = 'available' | 'unavailable' | 'none';

/** One way of launching the workflow id, and what the launch that adopts the id owes. */
type Launcher = {
  label: string;
  /** The `ctx.services` the adopting launch holds, by identity; `undefined` when it holds none. */
  services: unknown;
  /** Whether the adopting launch is a member of terminal cleanup. */
  owesCleanup: boolean;
  /** The services resolution of a scheduled occurrence; absent for a plain launch. */
  resolution?: ServicesResolution;
  launch(harness: Harness): Promise<unknown>;
};

function createScheduleState(): ScheduleState {
  return {
    id: 'window-schedule',
    workflowType: PARKED_TYPE,
    input: null,
    intervalMs: 60_000,
    status: 'paused',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    createdAt: 0,
    updatedAt: 0,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: null,
    queuedRuns: [],
  };
}

function scheduledOccurrence(resolution: ServicesResolution, label: string): Launcher {
  return {
    label,
    resolution,
    services: resolution === 'available' ? SERVICES : undefined,
    // Every scheduled run writes `schedule-run` metadata that only the deferred cleanup sweeps.
    owesCleanup: true,
    launch: (harness) =>
      startScheduledRun(
        harness.internals,
        createScheduleState(),
        createScheduleCallbacks(harness.engine),
        { workflowId: WORKFLOW_ID },
      ),
  };
}

const LAUNCHERS: readonly Launcher[] = [
  scheduledOccurrence('available', 'a scheduled occurrence with available services'),
  scheduledOccurrence('unavailable', 'a scheduled occurrence with unavailable services'),
  scheduledOccurrence('none', 'a scheduled occurrence on an engine with no resolver'),
  {
    label: 'engine.start with services',
    services: SERVICES,
    owesCleanup: true,
    launch: (harness) =>
      harness.engine.start(PARKED_TYPE, null, { id: WORKFLOW_ID, services: SERVICES }),
  },
  {
    label: 'engine.prepare with services',
    services: SERVICES,
    owesCleanup: true,
    launch: (harness) =>
      harness.engine.prepare(PARKED_TYPE, null, { id: WORKFLOW_ID, services: SERVICES }),
  },
  {
    label: 'engine.start of a type that limits concurrency',
    services: undefined,
    owesCleanup: true,
    launch: (harness) => harness.engine.start(LIMITED_TYPE, null, { id: WORKFLOW_ID }),
  },
  {
    label: 'engine.start with neither services nor a concurrency limit',
    services: undefined,
    owesCleanup: false,
    launch: (harness) => harness.engine.start(PARKED_TYPE, null, { id: WORKFLOW_ID }),
  },
];

async function createHarness(resolution: ServicesResolution) {
  const storage = new GatedStorage();
  const resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | undefined =
    resolution === 'none'
      ? undefined
      : () =>
          resolution === 'available'
            ? { status: 'available', services: SERVICES }
            : { status: 'unavailable', reason: 'no services for this occurrence' };
  const engine = await Engine.create({
    storage,
    recover: false,
    ...(resolveWorkflowServices === undefined ? {} : { resolveWorkflowServices }),
  });
  const parked = (name: string, concurrency?: { max: number }) =>
    workflow({ name, ...(concurrency === undefined ? {} : { concurrency }) }).execute(
      async function* (context: WorkflowContext) {
        return yield* context.waitForSignal<string>('go');
      },
    );
  engine.register(parked(PARKED_TYPE));
  engine.register(parked(LIMITED_TYPE, { max: 1 }));
  const internals = getInternals(engine);
  let disposed = false;

  return {
    storage,
    engine,
    internals,
    holdings() {
      return {
        checkpoint: internals.checkpoints.get(WORKFLOW_ID),
        services: internals.workflowServices.get(WORKFLOW_ID),
        cleanupMember: internals.workflowsNeedingTerminalCleanup.has(WORKFLOW_ID),
        pendingStart: internals.pendingStarts.has(WORKFLOW_ID),
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await engine[Symbol.asyncDispose]();
    },
  };
}

/** Start the launch and wait until the id is adopted and its create batch is held. */
async function launchIntoTheBatchWindow(harness: Harness, launcher: Launcher) {
  const batch = harness.storage.holdCreateBatch(WORKFLOW_ID);
  const launching = settle(launcher.launch(harness));
  await batch.reached;
  return { batch, launching };
}

describe('what a launch holds while its create batch commits', () => {
  for (const launcher of LAUNCHERS) {
    it(`holds the services and the cleanup membership it adopted the id with, for ${launcher.label}`, async () => {
      const harness = await createHarness(launcher.resolution ?? 'none');
      try {
        const { batch, launching } = await launchIntoTheBatchWindow(harness, launcher);

        const held = harness.holdings();
        expect(held.checkpoint).toBeDefined();
        expect(held.pendingStart).toBe(true);
        expect(held.services).toBe(launcher.services);
        expect(held.cleanupMember).toBe(launcher.owesCleanup);

        batch.release();
        await launching;
      } finally {
        await harness.dispose();
      }
    });
  }

  for (const launcher of LAUNCHERS) {
    it(`leaves nothing behind when the create batch is refused after the id was adopted, for ${launcher.label}`, async () => {
      const harness = await createHarness(launcher.resolution ?? 'none');
      try {
        const { batch, launching } = await launchIntoTheBatchWindow(harness, launcher);
        const refusal = new Error('the create batch was refused');

        batch.fail(refusal);

        expect(rejectionReason(await launching)).toBe(refusal);
        expect(harness.holdings()).toEqual({
          checkpoint: undefined,
          services: undefined,
          cleanupMember: false,
          pendingStart: false,
        });
      } finally {
        await harness.dispose();
      }
    });
  }
});

describe('a terminal operation that lands while the create batch commits', () => {
  const terminations = [
    { name: 'cancel', status: 'cancelled', run: (engine: Engine) => engine.cancel(WORKFLOW_ID) },
    { name: 'timeout', status: 'timed-out', run: (engine: Engine) => engine.timeout(WORKFLOW_ID) },
  ] as const;

  for (const termination of terminations) {
    for (const launcher of LAUNCHERS) {
      it(`${launcher.owesCleanup ? 'mints' : 'does not mint'} the cleanup token and timer when ${termination.name} lands in the window, for ${launcher.label}`, async () => {
        const harness = await createHarness(launcher.resolution ?? 'none');
        const { storage, engine } = harness;
        try {
          const { batch, launching } = await launchIntoTheBatchWindow(harness, launcher);

          // The terminal operation decides whether the run owes the cleanup timer when it starts,
          // before its first read. Hold every attribute read from here on, which the terminal
          // operation makes first, and which a scheduled occurrence's own failure makes after it,
          // so the terminal operation reaches the record only once the create batch has committed
          // and lands before anything else does.
          const attributeReads = storage.holdReads(KEYS.attribute(WORKFLOW_ID));
          const terminating = settle(termination.run(engine));
          await waitForCondition(() => attributeReads.count === 1, {
            label: `${termination.name} reached its first read`,
          });

          batch.release();
          await waitForCondition(
            async () => (await storage.get(KEYS.workflow(WORKFLOW_ID))) !== null,
            {
              label: `${WORKFLOW_ID} committed`,
            },
          );
          attributeReads.releaseOldest();
          await terminating;
          // Whatever reads the attribute after the terminal operation is let through now.
          attributeReads.releaseAll();
          await launching;

          const state = await readState(storage, WORKFLOW_ID);
          expect(state.status).toBe(termination.status);
          expect(state.terminalCleanupToken !== undefined).toBe(launcher.owesCleanup);
          expect(await countCleanupTimers(storage, WORKFLOW_ID)).toBe(launcher.owesCleanup ? 1 : 0);
        } finally {
          await harness.dispose();
        }
      });
    }
  }
});

describe('a launch whose engine is disposed before it adopts the id', () => {
  for (const launcher of LAUNCHERS) {
    it(`installs nothing on the disposed engine, for ${launcher.label}`, async () => {
      const harness = await createHarness(launcher.resolution ?? 'none');
      try {
        // The terminal-conflict read is the last thing a start awaits before it adopts the id.
        const recordReads = harness.storage.holdReads(KEYS.workflow(WORKFLOW_ID));
        const launching = settle(launcher.launch(harness));
        await waitForCondition(() => recordReads.count === 1, {
          label: `${WORKFLOW_ID} reached its terminal-conflict read`,
        });

        await harness.dispose();
        recordReads.releaseAll();
        await launching;

        // Disposal released everything the engine held, so a launch that adopts the id afterwards
        // finds nothing to hold: no checkpoint, no services, and no cleanup membership.
        const held = harness.holdings();
        expect(held.checkpoint).toBeUndefined();
        expect(held.services).toBeUndefined();
        expect(held.cleanupMember).toBe(false);
        expect(harness.internals.workflowServices.size).toBe(0);
      } finally {
        await harness.dispose();
      }
    });
  }
});

describe('a launch whose engine is disposed while its create batch commits', () => {
  for (const launcher of LAUNCHERS) {
    it(`holds no services once the engine let go of them, for ${launcher.label}`, async () => {
      const harness = await createHarness(launcher.resolution ?? 'none');
      try {
        const { batch, launching } = await launchIntoTheBatchWindow(harness, launcher);

        await harness.dispose();
        batch.release();
        await launching;

        // Disposal released what the launch installed at adoption, services included, so a
        // credential-bearing closure is not stranded past the engine, and nothing installs it again.
        expect(harness.internals.workflowServices.size).toBe(0);
        expect(harness.holdings().checkpoint).toBeUndefined();
      } finally {
        await harness.dispose();
      }
    });
  }

  for (const resolution of ['unavailable'] as const) {
    it('still writes the failure of an unavailable occurrence with its cleanup token and timer', async () => {
      const harness = await createHarness(resolution);
      const { storage } = harness;
      try {
        const { batch, launching } = await launchIntoTheBatchWindow(
          harness,
          scheduledOccurrence(resolution, 'a scheduled occurrence with unavailable services'),
        );

        await harness.dispose();
        batch.release();
        await launching;

        // The occurrence fails itself once its start returns, after the engine was disposed, and
        // that terminal write is judged by the membership the launch held when it adopted the id.
        const state = await readState(storage, WORKFLOW_ID);
        expect(state.status).toBe('failed');
        expect(state.terminalCleanupToken).toBeDefined();
        expect(await countCleanupTimers(storage, WORKFLOW_ID)).toBe(1);
      } finally {
        await harness.dispose();
      }
    });
  }
});
