/**
 * What a scheduled occurrence holds in engine memory while its start is in flight (COR-1408).
 *
 * One launch installs a run's transient state: the launch that adopts the id. A scheduled
 * occurrence resolves its `ctx.services` and hands them, with its obligation to join terminal
 * cleanup, to `startWorkflow`, which installs both when its launch adopts the id, before its
 * create batch is awaited and so before the run can begin. Until a start adopts a checkpoint under
 * the id it holds nothing, so a start that rejects early has nothing to take back, and the id may
 * meanwhile belong to another launch: a start still in flight that reserved it first, a live run,
 * or a launch that began after this one's start rolled itself back. Nothing a rejected launch did
 * may reach that launch.
 *
 * Two launches of one workflow id reach the seam with a terminal handoff and a cadence tick
 * draining the same queued run, or a scheduled occurrence reaching for an id `engine.start`
 * already runs. Each case below crosses one interleaving of those launches with one way the
 * services resolver can answer. The winning launch keeps its services, by identity, and its
 * obligation to schedule the durable cleanup timer, a winner that asked for neither holds
 * neither, the loser leaves nothing behind, and nothing survives terminalization or purge. When
 * the engine is disposed, disposal releases the services; it never clears the cleanup membership
 * of a run the engine holds, as on main, and the set dies with the engine.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createDeferred, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec/api.ts';
import {
  workflow,
  type EngineOptions,
  type ScheduleState,
  type WorkflowContext,
} from '../types.ts';
import { createScheduleCallbacks } from './callback-creators-schedule.ts';
import { parkedOnSignal } from './checkpoint-conflict.test-support.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { startScheduledRun } from './schedule-run.ts';
import type { ScheduleCallbacks } from './schedules.ts';

/** How the services resolver answers the launches of one case, in the order it is consulted. */
type ResolutionKind = 'distinct' | 'same' | 'unavailable' | 'none';

const RESOLUTION_KINDS: readonly ResolutionKind[] = ['distinct', 'same', 'unavailable', 'none'];

const RESOLUTION_LABELS: Record<ResolutionKind, string> = {
  distinct: 'a distinct services value for each launch',
  same: 'the same services value for every launch',
  unavailable: 'unavailable services',
  none: 'no resolver',
};

function createResolutions(kind: ResolutionKind) {
  const shared = { owner: 'the one value every launch resolves' };
  const resolved: object[] = [];
  const resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | undefined =
    kind === 'none'
      ? undefined
      : () => {
          if (kind === 'unavailable') {
            return { status: 'unavailable', reason: 'no services for this launch' };
          }
          const services =
            kind === 'same' ? shared : { owner: `resolution ${resolved.length + 1}` };
          resolved.push(services);
          return { status: 'available', services };
        };
  return {
    resolveWorkflowServices,
    /** What launch `index` (the order the resolver was consulted in) holds when it wins. */
    servicesOfLaunch(index: number): unknown {
      if (kind === 'distinct') return resolved[index];
      return kind === 'same' ? shared : undefined;
    },
  };
}

type Holdings = {
  attempt: unknown;
  checkpoint: unknown;
  services: unknown;
  cleanupTracked: boolean;
  pendingStart: boolean;
};

const NOTHING_HELD: Holdings = {
  attempt: undefined,
  checkpoint: undefined,
  services: undefined,
  cleanupTracked: false,
  pendingStart: false,
};

/**
 * What the launch that holds the id is owed: a scheduled launch, or a live `engine.start` run.
 * A live run holds the services it was started with, and owes terminal cleanup only if it has
 * some.
 */
type Winner = { kind: 'launch'; index: number } | { kind: 'live'; services: object | undefined };

type LaunchHooks = {
  /**
   * Runs when the launch reaches `startWorkflow`. The launch has installed nothing in engine
   * memory by then, and a hook that returns a promise holds the start until it settles.
   */
  atStart?: () => void | Promise<void>;
  /** Runs once `startWorkflow` rejected, before the launch's own catch resumes. */
  afterRejection?: () => Promise<void>;
};

async function settle(promise: Promise<string>): Promise<PromiseSettledResult<string>> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function rejectionReason(outcome: PromiseSettledResult<string>): unknown {
  if (outcome.status !== 'rejected') {
    throw new Error(`Expected the launch to reject, but it resolved with ${outcome.value}`);
  }
  return outcome.reason;
}

function expectLaunched(outcome: PromiseSettledResult<string>): void {
  if (outcome.status !== 'fulfilled') {
    throw new Error(
      `Expected the launch to succeed, but it rejected with ${Bun.inspect(outcome.reason)}`,
    );
  }
}

/** `wf-cleanup:` is `KEYS.terminalCleanup`'s prefix; each entry's value is the workflow id. */
async function countCleanupTimers(storage: MemoryStorage, workflowId: string): Promise<number> {
  let count = 0;
  for await (const [, value] of storage.scan('wf-cleanup:')) {
    if (decode(value) === workflowId) count += 1;
  }
  return count;
}

async function createHarness(id: string, kind: ResolutionKind) {
  const resolutions = createResolutions(kind);
  const storage = new MemoryStorage();
  const engine = await Engine.create({
    storage,
    recover: false,
    ...(resolutions.resolveWorkflowServices === undefined
      ? {}
      : { resolveWorkflowServices: resolutions.resolveWorkflowServices }),
  });
  engine.register(parkedOnSignal(id));
  // A run that finishes inline without a signal, and reports whether it was handed services.
  const reporterType = `${id}-reporter`;
  engine.register(
    workflow({ name: reporterType }).execute(async function* (context: WorkflowContext) {
      return context.services === undefined ? 'no services' : 'services';
    }),
  );
  const internals = getInternals(engine);
  const schedule = { id: `${id}-schedule`, workflowType: id, input: null } as ScheduleState;
  const baseCallbacks = createScheduleCallbacks(engine);
  let disposed = false;

  function holdings(): Holdings {
    return {
      attempt: currentExecutionAttempt(internals, id),
      checkpoint: internals.checkpoints.get(id),
      services: internals.workflowServices.get(id),
      cleanupTracked: internals.workflowsNeedingTerminalCleanup.has(id),
      pendingStart: internals.pendingStarts.has(id),
    };
  }

  /** Launch one scheduled occurrence of the id, and report how its start settled. */
  function launch(hooks: LaunchHooks = {}): Promise<PromiseSettledResult<string>> {
    const callbacks = {
      ...baseCallbacks,
      startWorkflow: async (...startArguments: Parameters<ScheduleCallbacks['startWorkflow']>) => {
        const held = hooks.atStart?.();
        if (held !== undefined) await held;
        try {
          await baseCallbacks.startWorkflow(...startArguments);
        } catch (error) {
          await hooks.afterRejection?.();
          throw error;
        }
      },
    };
    return settle(startScheduledRun(internals, schedule, callbacks, { workflowId: id }));
  }

  /** Refuse the next `count` calls of any of `methods` with one error. */
  function refuseStorage(methods: readonly string[], count: number): Error {
    const refusal = new Error(`the storage refused ${methods.join(' and ')}`);
    let remaining = count;
    internals.storage = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (remaining > 0 && methods.includes(String(property))) {
          return () => {
            remaining -= 1;
            return Promise.reject(refusal);
          };
        }
        return original.bind(target);
      },
    });
    return refusal;
  }

  /**
   * Hold the next batch that records a scheduled run of the id, which is the start batch of the
   * occurrence, until `release` is called. `reached` settles once a batch is held.
   */
  function holdNextStartBatch() {
    const reached = createDeferred();
    const released = createDeferred();
    let holding = true;
    const carriesTheStart = (operations: readonly BatchOperation[]) =>
      operations.some(
        (operation) => operation.type === 'put' && operation.key === KEYS.scheduleRun(id),
      );
    internals.storage = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property !== 'batch' && property !== 'conditionalBatch') return original.bind(target);
        return async (...batchArguments: unknown[]) => {
          const operations = (
            property === 'batch' ? batchArguments[0] : batchArguments[1]
          ) as BatchOperation[];
          if (holding && carriesTheStart(operations)) {
            holding = false;
            reached.resolve();
            await released.promise;
          }
          return original.apply(target, batchArguments);
        };
      },
    });
    return { reached: reached.promise, release: released.resolve };
  }

  /** Make the next create commit refuse, after the start adopted its launch checkpoint. */
  function refuseNextCreateCommit(): Error {
    return refuseStorage(['batch', 'conditionalBatch'], 1);
  }

  /** Make the next storage read refuse, before a start has adopted a checkpoint. */
  function refuseNextRead(): Error {
    return refuseStorage(['get'], 1);
  }

  /** Make every storage read refuse until the harness is disposed. */
  function refuseEveryRead(): Error {
    return refuseStorage(['get'], Number.POSITIVE_INFINITY);
  }

  /**
   * Run the id as a live run that asked for no services and finishes inline: report whether it
   * was handed any, and whether its terminalization scheduled a durable cleanup timer.
   */
  async function runReporter() {
    const handle = await engine.start(reporterType, null, { id });
    const outcome = await handle.result();
    const state = await engine.get(id);
    return {
      outcome,
      terminalCleanupToken: state?.terminalCleanupToken,
      cleanupTimers: await countCleanupTimers(storage, id),
    };
  }

  /** Run the id to completion as a live run that asked for no services, leaving a terminal record. */
  async function completeTerminalRun(): Promise<void> {
    await engine.start(id, null, { id });
    await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
      label: `${id} parked on its signal`,
    });
    await engine.signal(id, 'go', 'the earlier run');
    expect(await engine.getHandle(id).result()).toBe('the earlier run');
  }

  return {
    id,
    kind,
    storage,
    engine,
    internals,
    resolutions,
    holdings,
    launch,
    holdNextStartBatch,
    refuseNextCreateCommit,
    refuseNextRead,
    refuseEveryRead,
    completeTerminalRun,
    runReporter,
    async dispose() {
      if (disposed) return;
      disposed = true;
      internals.storage = storage;
      await engine[Symbol.asyncDispose]();
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function expectSameHoldings(actual: Holdings, expected: Holdings): void {
  expect(actual.attempt).toBe(expected.attempt);
  expect(actual.checkpoint).toBe(expected.checkpoint);
  expect(actual.services).toBe(expected.services);
  expect(actual.cleanupTracked).toBe(expected.cleanupTracked);
  expect(actual.pendingStart).toBe(expected.pendingStart);
}

function expectNothingHeld(harness: Harness): void {
  expectSameHoldings(harness.holdings(), NOTHING_HELD);
  expect(harness.internals.workflowServices.has(harness.id)).toBe(false);
  expect(harness.internals.workflowsNeedingTerminalCleanup.has(harness.id)).toBe(false);
}

/**
 * Launch A, and launch B from inside A's rejection: B reaches `startWorkflow` once A's
 * `startWorkflow` has settled and before A's own catch resumes. Reports what the id held at each
 * of those two moments.
 */
async function launchSecondInsideFirstRejection(harness: Harness) {
  const secondStarted = createDeferred();
  let atRejection: Holdings | undefined;
  let atSecondStart: Holdings | undefined;
  let second: Promise<PromiseSettledResult<string>> | undefined;

  const first = await harness.launch({
    afterRejection: async () => {
      atRejection = harness.holdings();
      second = harness.launch({
        atStart: () => {
          atSecondStart = harness.holdings();
          secondStarted.resolve();
        },
      });
      await secondStarted.promise;
    },
  });

  if (atRejection === undefined || atSecondStart === undefined || second === undefined) {
    throw new Error('launch A never reached its rejection');
  }
  return { first, second, atRejection, atSecondStart };
}

/**
 * The interleavings of two launches of one workflow id. Each drives the launches to the point
 * where one holds the id, checks what the loser left behind, and names the winner.
 */
const interleavings: readonly {
  label: string;
  run: (harness: Harness) => Promise<Winner>;
}[] = [
  {
    label: 'launch A is rejected before launch B starts',
    async run(harness) {
      const refusal = harness.refuseNextCreateCommit();

      const first = await harness.launch();

      expect(rejectionReason(first)).toBe(refusal);
      expectNothingHeld(harness);

      expectLaunched(await harness.launch());
      return { kind: 'launch', index: 1 };
    },
  },
  {
    label: 'launch A rolls back, then launch B starts inside its rejection',
    async run(harness) {
      const refusal = harness.refuseNextCreateCommit();

      const { first, second, atRejection, atSecondStart } =
        await launchSecondInsideFirstRejection(harness);

      expect(rejectionReason(first)).toBe(refusal);
      // The start adopted a checkpoint and rolled back everything it held for the id before it
      // rejected, and launch B had nothing of A's to find when it started.
      expectSameHoldings(atRejection, NOTHING_HELD);
      expectSameHoldings(atSecondStart, NOTHING_HELD);

      expectLaunched(await second);
      return { kind: 'launch', index: 1 };
    },
  },
  {
    label:
      'launch A is rejected before it adopts a checkpoint, then launch B starts inside its rejection',
    async run(harness) {
      const refusal = harness.refuseNextRead();

      const { first, second, atRejection, atSecondStart } =
        await launchSecondInsideFirstRejection(harness);

      expect(rejectionReason(first)).toBe(refusal);
      // The start adopted nothing, and it installed nothing before it did, so there was
      // nothing to roll back and nothing for launch B to find: no launch holds the id.
      expectSameHoldings(atRejection, NOTHING_HELD);
      expectSameHoldings(atSecondStart, NOTHING_HELD);

      expectLaunched(await second);
      return { kind: 'launch', index: 1 };
    },
  },
  {
    label: 'launch A rolls back, then a live engine.start run takes the id',
    async run(harness) {
      const refusal = harness.refuseNextCreateCommit();
      const services = { owner: 'the live run' };

      const first = await harness.launch({
        afterRejection: async () => {
          await harness.engine.start(harness.id, null, { id: harness.id, services });
        },
      });

      expect(rejectionReason(first)).toBe(refusal);
      expect(harness.holdings().services).toBe(services);
      expect(harness.holdings().cleanupTracked).toBe(true);
      return { kind: 'live', services };
    },
  },
  {
    label:
      'launch A is rejected before it adopts a checkpoint, then a live engine.start run takes the id',
    async run(harness) {
      const refusal = harness.refuseNextRead();
      const services = { owner: 'the live run' };

      const first = await harness.launch({
        afterRejection: async () => {
          await harness.engine.start(harness.id, null, { id: harness.id, services });
        },
      });

      expect(rejectionReason(first)).toBe(refusal);
      expect(harness.holdings().services).toBe(services);
      expect(harness.holdings().cleanupTracked).toBe(true);
      return { kind: 'live', services };
    },
  },
  {
    label: 'launch A rolls back, then a live engine.start run without services takes the id',
    async run(harness) {
      const refusal = harness.refuseNextCreateCommit();

      const first = await harness.launch({
        afterRejection: async () => {
          await harness.engine.start(harness.id, null, { id: harness.id });
        },
      });

      expect(rejectionReason(first)).toBe(refusal);
      expect(harness.holdings().services).toBeUndefined();
      expect(harness.holdings().cleanupTracked).toBe(false);
      return { kind: 'live', services: undefined };
    },
  },
  {
    // Codex, PRRT_kwDOUg4Lwc6o0rIj: a live start that asked for no services must not run with
    // the services of an occurrence whose start was rejected, nor owe it a cleanup timer.
    label:
      'launch A is rejected before it adopts a checkpoint, then a live engine.start run without services takes the id',
    async run(harness) {
      const refusal = harness.refuseNextRead();

      const first = await harness.launch({
        afterRejection: async () => {
          await harness.engine.start(harness.id, null, { id: harness.id });
        },
      });

      expect(rejectionReason(first)).toBe(refusal);
      expect(harness.holdings().services).toBeUndefined();
      expect(harness.holdings().cleanupTracked).toBe(false);
      return { kind: 'live', services: undefined };
    },
  },
  {
    // Codex, PRRT_kwDOUg4Lwc6o0rIm: the terminal run under the id is purged while the occurrence's
    // start is in flight, and the start is then rejected. Nothing may remain for a later run that
    // reuses the id, which has no services, no headers and no concurrency limit, to inherit.
    label:
      'the terminal run under the id is purged while launch A is in flight, then launch A is rejected before it adopts a checkpoint',
    async run(harness) {
      await harness.completeTerminalRun();
      let refusal: Error | undefined;

      const first = await harness.launch({
        atStart: async () => {
          const purged = await harness.engine.purge({ status: 'completed' });
          expect(purged.deleted).toBe(1);
          refusal = harness.refuseNextRead();
        },
      });

      expect(rejectionReason(first)).toBe(refusal);
      expectNothingHeld(harness);

      await harness.engine.start(harness.id, null, { id: harness.id });
      return { kind: 'live', services: undefined };
    },
  },
  {
    label: 'launch B is rejected as a duplicate while launch A is in flight',
    async run(harness) {
      // A terminal handoff and a cadence tick draining the same queued run: the first to
      // reach startWorkflow reserves the id, and the other rejects against that reservation.
      const first = harness.launch();
      const second = harness.launch();

      expectLaunched(await first);
      expect(rejectionReason(await second)).toBeInstanceOf(WorkflowAlreadyExistsError);
      return { kind: 'launch', index: 0 };
    },
  },
  {
    label: 'launch A succeeds and launch B is rejected',
    async run(harness) {
      expectLaunched(await harness.launch());
      const beforeSecond = harness.holdings();

      const second = await harness.launch();

      expect(rejectionReason(second)).toBeInstanceOf(WorkflowAlreadyExistsError);
      expectSameHoldings(harness.holdings(), beforeSecond);
      return { kind: 'launch', index: 0 };
    },
  },
  {
    label: 'a scheduled occurrence targets an id a live engine.start run holds',
    async run(harness) {
      const services = { owner: 'the live run' };
      await harness.engine.start(harness.id, null, { id: harness.id, services });
      await waitForCondition(() => harness.internals.parkedInlineWorkflows.has(harness.id), {
        label: `${harness.id} parked on its signal`,
      });
      const beforeOccurrence = harness.holdings();

      const occurrence = await harness.launch();

      expect(rejectionReason(occurrence)).toBeInstanceOf(WorkflowAlreadyExistsError);
      expectSameHoldings(harness.holdings(), beforeOccurrence);
      return { kind: 'live', services };
    },
  },
  {
    label: 'a scheduled occurrence targets an id a live engine.start run without services holds',
    async run(harness) {
      await harness.engine.start(harness.id, null, { id: harness.id });
      await waitForCondition(() => harness.internals.parkedInlineWorkflows.has(harness.id), {
        label: `${harness.id} parked on its signal`,
      });
      const beforeOccurrence = harness.holdings();

      const occurrence = await harness.launch();

      expect(rejectionReason(occurrence)).toBeInstanceOf(WorkflowAlreadyExistsError);
      expectSameHoldings(harness.holdings(), beforeOccurrence);
      expect(harness.holdings().services).toBeUndefined();
      expect(harness.holdings().cleanupTracked).toBe(false);
      return { kind: 'live', services: undefined };
    },
  },
];

describe('what a scheduled start holds in memory', () => {
  for (const interleaving of interleavings) {
    for (const kind of RESOLUTION_KINDS) {
      it(`${interleaving.label}, with ${RESOLUTION_LABELS[kind]}`, async () => {
        const id = 'transient-state-run';
        const harness = await createHarness(id, kind);
        const { engine, internals, storage } = harness;
        try {
          const winner = await interleaving.run(harness);

          // A scheduled launch fails at once when its services are unavailable; every other
          // winner is parked on its signal.
          const parked = winner.kind === 'live' || kind !== 'unavailable';
          const expectedServices =
            winner.kind === 'live'
              ? winner.services
              : harness.resolutions.servicesOfLaunch(winner.index);
          // A scheduled run always writes schedule-run metadata, so it owes the cleanup timer
          // that sweeps it. A live run owes one only when it holds services.
          const owesCleanup = winner.kind === 'launch' || winner.services !== undefined;

          if (parked) {
            await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
              label: `${id} parked on its signal`,
            });
            // The winner keeps its own services object, and the obligation to schedule the
            // durable terminal cleanup, or neither when it asked for neither.
            expect(internals.workflowServices.get(id)).toBe(expectedServices);
            expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(owesCleanup);
            expect(internals.pendingStarts.has(id)).toBe(false);

            await engine.signal(id, 'go', 'the winner');
            expect(await engine.getHandle(id).result()).toBe('the winner');
          }

          // Terminalization scheduled the durable cleanup timer exactly when the winner owed
          // one, which is what the obligation exists to guarantee.
          const state = await engine.get(id);
          expect(state?.status).toBe(parked ? 'completed' : 'failed');
          // A signal leaves durable scratch of its own, so every run this table signals owes the
          // timer by the end; what a winner that asked for nothing is owed before it is signalled
          // is checked above and in the cases that follow the table.
          if (owesCleanup) {
            expect(state?.terminalCleanupToken).toBeDefined();
            expect(await countCleanupTimers(storage, id)).toBe(1);
          }

          // Terminalization released everything the id held.
          expectNothingHeld(harness);

          // So does purging the terminal run.
          const purged = await engine.purge({ status: state?.status });
          expect(purged.deleted).toBe(1);
          expectNothingHeld(harness);
        } finally {
          await harness.dispose();
        }
      });
    }
  }

  for (const kind of RESOLUTION_KINDS) {
    it(`holds nothing when a scheduled launch reaches its start, with ${RESOLUTION_LABELS[kind]}`, async () => {
      const harness = await createHarness('transient-state-at-start', kind);
      try {
        let atStart: Holdings | undefined;

        expectLaunched(
          await harness.launch({
            atStart: () => {
              atStart = harness.holdings();
            },
          }),
        );

        // The launch resolved its services before it called `startWorkflow`, and installs them
        // only when it adopts the id inside that start. Until then the id holds nothing that a
        // rejected start could leave behind.
        if (atStart === undefined) throw new Error('the launch never reached startWorkflow');
        expectSameHoldings(atStart, NOTHING_HELD);

        if (kind === 'unavailable') return;
        await waitForCondition(() => harness.internals.parkedInlineWorkflows.has(harness.id), {
          label: `${harness.id} parked on its signal`,
        });
        expect(harness.internals.workflowServices.get(harness.id)).toBe(
          harness.resolutions.servicesOfLaunch(0),
        );
        expect(harness.internals.workflowsNeedingTerminalCleanup.has(harness.id)).toBe(true);
      } finally {
        await harness.dispose();
      }
    });
  }

  for (const kind of RESOLUTION_KINDS) {
    it(`gives a live run that asked for no services none of a rejected occurrence's, with ${RESOLUTION_LABELS[kind]}`, async () => {
      const harness = await createHarness('transient-state-reporter-after-rejection', kind);
      try {
        const refusal = harness.refuseNextRead();
        let reported: Awaited<ReturnType<typeof harness.runReporter>> | undefined;

        const first = await harness.launch({
          afterRejection: async () => {
            reported = await harness.runReporter();
          },
        });

        expect(rejectionReason(first)).toBe(refusal);
        // The live run read no services and owes no cleanup timer: its terminalization found no
        // obligation to sweep, because it had asked for none.
        expect(reported).toEqual({
          outcome: 'no services',
          terminalCleanupToken: undefined,
          cleanupTimers: 0,
        });
        expectNothingHeld(harness);
      } finally {
        await harness.dispose();
      }
    });

    it(`gives a later run that asked for no services no cleanup timer after a purge and a rejected occurrence, with ${RESOLUTION_LABELS[kind]}`, async () => {
      const harness = await createHarness('transient-state-reporter-after-purge', kind);
      try {
        await harness.completeTerminalRun();
        let refusal: Error | undefined;

        const first = await harness.launch({
          atStart: async () => {
            const purged = await harness.engine.purge({ status: 'completed' });
            expect(purged.deleted).toBe(1);
            refusal = harness.refuseNextRead();
          },
        });

        expect(rejectionReason(first)).toBe(refusal);
        expectNothingHeld(harness);
        expect(await harness.runReporter()).toEqual({
          outcome: 'no services',
          terminalCleanupToken: undefined,
          cleanupTimers: 0,
        });
        expectNothingHeld(harness);
      } finally {
        await harness.dispose();
      }
    });
  }

  for (const kind of RESOLUTION_KINDS) {
    it(`leaves nothing behind when two launches are both rejected before they adopt a checkpoint, with ${RESOLUTION_LABELS[kind]}`, async () => {
      const harness = await createHarness('transient-state-both-rejected', kind);
      try {
        const refusal = harness.refuseEveryRead();

        const { first, second } = await launchSecondInsideFirstRejection(harness);

        expect(rejectionReason(first)).toBe(refusal);
        expect(rejectionReason(await second)).toBe(refusal);
        expectNothingHeld(harness);
      } finally {
        await harness.dispose();
      }
    });
  }

  for (const kind of RESOLUTION_KINDS) {
    it(`holds no services for a disposed engine when it is disposed while the start batch commits, with ${RESOLUTION_LABELS[kind]}`, async () => {
      const harness = await createHarness('transient-state-dispose-in-batch', kind);
      try {
        const batch = harness.holdNextStartBatch();
        const launching = harness.launch();
        await batch.reached;

        // Disposal lands after the launch adopted the id, and installed the run's state, and before
        // its start commits.
        await harness.dispose();
        batch.release();
        await launching;

        // Disposal released the services the engine held so that a credential-bearing closure is
        // not stranded past it, the launch that outlived the engine installed nothing again, and
        // nothing of the launch's checkpoint is left. Disposal does not clear the cleanup
        // membership, so this case says nothing about it.
        const held = harness.holdings();
        expect(held.attempt).toBeUndefined();
        expect(held.checkpoint).toBeUndefined();
        expect(held.services).toBeUndefined();
        expect(held.pendingStart).toBe(false);
        expect(harness.internals.workflowServices.size).toBe(0);
      } finally {
        await harness.dispose();
      }
    });
  }

  for (const kind of RESOLUTION_KINDS.filter((candidate) => candidate !== 'unavailable')) {
    it(`releases the services when the engine is disposed with the winner running, with ${RESOLUTION_LABELS[kind]}`, async () => {
      const id = 'transient-state-disposal';
      const harness = await createHarness(id, kind);
      try {
        expectLaunched(await harness.launch());
        await waitForCondition(() => harness.internals.parkedInlineWorkflows.has(id), {
          label: `${id} parked on its signal`,
        });
        // The winner holds what it was launched with, and nothing else holds it for it.
        expect(harness.internals.workflowServices.has(id)).toBe(kind !== 'none');
        expect(harness.internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);

        await harness.dispose();

        expect(harness.internals.workflowServices.size).toBe(0);
      } finally {
        await harness.dispose();
      }
    });
  }
});
